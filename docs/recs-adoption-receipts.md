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

## Read path & the Adoption Scorecard (#577)

`GET /api/adoption/receipts` replays the log read-only as
`{ ok, receipts: [...] }`. Each line is re-sanitized through the **same**
allowlist-drop writer used on write, so a hand-edited or legacy line can never
surface a field outside the allowlist. The route is server-only; the SPA's
`@api-client` stub returns `[]`.

The **Adoption Scorecard** view (`src/components/AdoptionScorecard.tsx`, joined
by `src/lib/adoption-scorecard.ts`) joins `SURFACED` + `SUPPRESSED` on finding
id and renders one card per finding:

- **SURFACED** — `<id> injected <date>, session <hash>`.
- **ADOPTED** — the matching `CLAUDE.md` hunk, extracted **live from
  `liveConfig` at render time by the receipt's `markerHeading`, never stored**.
- **SUPPRESSED** — `engine went silent <date>, markers now match`, with a
  **non-causal** "no recurrence" sub-line (a deleted `CLAUDE.md` section also
  reads as quiet).

The index header reads `N surfaced / M adopted (marker-confirmed) / median
days-to-adopt`, and `M/N` carries a **lower-bound** badge (strict-AND markers
undercount prose adoptions). A `SUPPRESSED` record with no prior `SURFACED`
renders **"attribution pending"** and is excluded from `M` until the hook-side
surfaced write (#581) lands. See ADR 0005 "Demo artifact".

## Agent-executed mid-session CLAUDE.md append (opt-in, #584)

When the user opts in mid-session to "apply this fix to my project CLAUDE.md", the
agent-facing `recs` skill performs an **append-only** write of the
recommendation's CLAUDE.md fix snippet to the **current project's** `CLAUDE.md`.
The deterministic text transformation is the dashboard-owned helper
`appendClaudeMdFix` in [`src/lib/claude-md-append.ts`](../src/lib/claude-md-append.ts);
the executable wiring of the opt-in prompt and the file write lives meta-side
(tracked at `shpwrck/claude#12`).

Guarantees (per ADR 0005 item #10, "Auto-apply is OUT of v0 — propose-only"):

- **Opt-in only; never global.** The append targets the per-project `CLAUDE.md`
  the user is working in. Global `~/.claude/CLAUDE.md` is never written — that is
  a cross-repo blast-radius violation, and the global `SessionStart` hook fires
  before the repo/cwd is known, so it cannot execute this. `appendClaudeMdFix`
  only transforms the project body text handed to it and rejects any fix whose
  `target` is not `CLAUDE.md`.
- **Append-only.** Existing content is preserved byte-for-byte; the snippet is
  concatenated at the end. Existing sections are never rewritten, and a fix whose
  markers already match (or whose literal snippet is already present) is a no-op.
- **Adoption registers via the normal marker transition.** The appended snippet
  carries the fix's `appliedMarkers`, so the next engine build suppresses the
  finding through the ordinary `claudeMdMarksApplied` check and the Adoption Card
  needs no special-casing — the same path as a manual application.
