# Recs Adoption Receipts

The adoption receipt store is an append-only dashboard-owned JSONL file. It is
not stored in `~/.claude/shadow-calls/ledger.jsonl`, and it persists only the two
allowlisted record kinds below.

`SURFACED`:

```json
{"schemaVersion":"1","kind":"SURFACED","ts":"2026-06-09T12:00:00.000Z","sessionHash":"...","findingIds":["reliability.rate-limits"]}
```

`SUPPRESSED`:

```json
{"schemaVersion":"1","kind":"SUPPRESSED","ts":"2026-06-09T12:00:00.000Z","findingId":"reliability.rate-limits","markerHeading":"Rate-limit hygiene","contentFingerprint":"sha256:..."}
```

Unknown fields are dropped before append. Repo paths, cwd, diff hunks, prompt
text, and raw `CLAUDE.md` bodies are not valid receipt fields. Writes are skipped
when `SHADOW_CALLS_OFF=1` is set or the shared `~/.claude/shadow-calls/OFF`
sentinel exists.

## Spool drain commit protocol (#3106)

This log has several independent appenders — the POST route, the reject mirror,
`ingest.mjs`, `proof-batch.mjs`, and the offline spool drain. Every one of them,
including the drain, writes **one `appendFile` call per unit of whole JSONL
lines**; nothing streams bytes into the log. That is what keeps a concurrent
append from landing inside another writer's record.

The drain (`src/lib/adoption-spool.ts`) rotates the live spool to a private
snapshot and then appends it in **batches** capped at 64 KiB. Each batch is one
`appendFile` call carrying its sanitized receipts plus a trailing private
`_CHD_SPOOL_DRAIN_COMMIT` frame, so the frame can never be separated from the
records it commits:

```json
{"schemaVersion":"1","kind":"_CHD_SPOOL_DRAIN_COMMIT","transactionId":"<uuid>","offset":65412}
```

`offset` is the snapshot byte offset the batch covers, which makes recovery
**resumable** rather than all-or-nothing: a retry reads the highest committed
offset for the transaction and restarts the snapshot there, so a drain
interrupted after some batches appends only the remainder — no replay of what
already landed, no loss of what did not. Canonical readers ignore the frame
rather than treating it as a receipt or as corrupt input, and the receipt writer
rejects it, so it cannot be forged through the API.

**Known residual.** Rotation is a consumer-side move and cannot quiesce the
producer: a hook that opened the live spool for append *before* the rename holds
a descriptor on the rotated inode and may write to it later. The drain chases
such a tail (it re-reads a snapshot that grew and refuses to unlink one whose
bytes it has not all consumed), which narrows the loss window to a write landing
between the final size check and the unlink — but cannot close it. Closing it
requires the producer to cooperate (a lock the drain honours, or a spool
*directory* into which each receipt is renamed atomically), and the producer
lives in `~/.claude`, outside this repo. Cross-process drains are likewise not
serialized; `serializeDrain` is an in-process mutex.

## Read path & the Adoption Scorecard (#577)

`GET /api/adoption/receipts` replays the log read-only as
`{ ok, receipts: [...] }`. Each line must carry a valid, bounded timestamp and is
re-sanitized through the **same** allowlist-drop writer used on write, so a
hand-edited or legacy line can never surface a field outside the allowlist. The
route is server-only; the SPA's `@api-client` stub returns `[]`.

The **Adoption Scorecard** view (`src/components/AdoptionScorecard.tsx`, joined
by `src/lib/adoption-scorecard.ts`) joins `SURFACED` + `SUPPRESSED` on finding
id and renders one card per finding:

- **SURFACED** — `<id> injected <date>, session <hash>`.
- **ADOPTED** — the matching `CLAUDE.md` hunk, extracted **live from
  `liveConfig` at render time by the receipt's `markerHeading`, never stored**.
  Treatment-scoped findings with several fixes under one finding id withhold the
  hunk because finding-level receipts cannot attribute it to one treatment.
- **SUPPRESSED** — `engine went silent <date>, markers now match`, with a
  **non-causal** "no recurrence" sub-line (a deleted `CLAUDE.md` section also
  reads as quiet).

The index header reads `N surfaced / M adopted (marker-confirmed) / median
days-to-adopt`, and `M/N` carries a **lower-bound** badge (strict-AND markers
undercount prose adoptions). A `SUPPRESSED` record with no prior `SURFACED`
renders **"attribution pending"** and is excluded from `M` until the hook-side
surfaced write (#581) lands. See ADR 0005 "Demo artifact".

## Agent-executed mid-session CLAUDE.md append (opt-in, #584) — deferred

This flow is **not implemented**. The intent: when the user opts in mid-session to
"apply this fix to my project CLAUDE.md", the agent-facing `recs` skill would
perform an **append-only** write of the recommendation's CLAUDE.md fix snippet to
the **current project's** `CLAUDE.md`. The dashboard once carried a deterministic
text-transformation helper (`appendClaudeMdFix`, `src/lib/claude-md-append.ts`) as
the dashboard-owned contract, but its executable wiring (meta, `shpwrck/claude#12`)
never landed, so the helper was dead code with no consumer and was removed (#2962).
Git history preserves it; the contract below is re-extractable when the wiring is
actually built.

Intended guarantees (per ADR 0005 item #10, "Auto-apply is OUT of v0 — propose-only"):

- **Opt-in only; never global.** The append targets the per-project `CLAUDE.md`
  the user is working in. Global `~/.claude/CLAUDE.md` is never written — that is
  a cross-repo blast-radius violation, and the global `SessionStart` hook fires
  before the repo/cwd is known, so it cannot execute this. The transformation
  only rewrites the project body text handed to it and rejects any fix whose
  `target` is not `CLAUDE.md`.
- **Append-only.** Existing content is preserved byte-for-byte; the snippet is
  concatenated at the end. Existing sections are never rewritten, and a fix whose
  markers already match (or whose literal snippet is already present) is a no-op.
- **Adoption registers via the normal marker transition.** The appended snippet
  carries the fix's `appliedMarkers`, so the next engine build suppresses the
  finding through the ordinary `claudeMdMarksApplied` check and the Adoption Card
  needs no special-casing — the same path as a manual application.
