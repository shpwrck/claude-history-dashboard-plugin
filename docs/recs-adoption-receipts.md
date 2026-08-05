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

## Spool rotation lock — cross-process protocol v1 (#3402, #3369, #3550)

Rotation is a consumer-side move and cannot by itself quiesce the producer: a
hook that opened the live spool for append *before* the rename holds a
descriptor on the rotated inode, so its later write lands in the retired
snapshot — possibly after the drain's EOF scan, where it would be deleted.
Protocol v1 closes that window with a cooperative lock both sides honour. The
drain half lives in `src/lib/adoption-spool-lock.ts` (this repo, #3402); the
producer half is the recs SessionStart hook in `shpwrck/agent-skills`
(shpwrck/agent-skills#22, tracked here as #3369). **This section is the
cross-repo contract** — both implementations copy these constants exactly.

- **Lock path.** `<resolved spool path> + '.rotation-lock'` — a sibling file.
  Spool path resolution is unchanged: `ADOPTION_SPOOL_PATH` env if set, else
  `join(CHD_CACHE_DIR default ~/.claude/.cache/chd, 'adoption-spool.jsonl')`.
- **Generation-claim path.** A remover serializes against the observed lock
  inode with `<lock path> + '.reclaim-' + dev + '-' + ino`. The claim is an
  `O_EXCL` hard link to that exact lock generation, not a copy. This constant
  and behavior are part of the cross-repo contract; producer synchronization is
  tracked by #3556.
- **Claim lease (protocol v2, #3557).** **After** its claim `link` succeeds, a
  remover records `<claim path> + '.lease-' + <ownerId>` as a **hard link to the
  claim**, and removes it **before** releasing the claim. `<ownerId>` is
  `<pid>_<bootTag>_<nsTag>_<startTag>_<nonce>`: the kernel boot id (16 hex), the
  `/proc/self/ns/pid` inode, `/proc/<pid>/stat` field 22 (starttime), and a
  12-hex per-attempt nonce; any component that cannot be read is the literal
  `x`. The lease has no body of its own — it is the claim — and **the name is
  normative**, created atomically, so a crash can never leave an unclassifiable
  lease. The ordering is the contract: a contender that loses the `link` race
  creates **nothing**, and a lease never outlives its claim, so **a lease on
  disk is positive proof of which live owner holds that claim**. A remover that
  cannot record its lease still proceeds — its claim is then merely
  unrecoverable, exactly like a v1 peer's.
- **Acquire.** Open with flag `'wx'`, mode `0o600`; write one single-line JSON
  payload:

  ```json
  {"schemaVersion":"1","kind":"ChdAdoptionSpoolRotationLock","role":"drain","pid":12345,"token":"<randomUUID>","createdAt":"<ISO8601>"}
  ```

  The producer writes `"role":"producer"`.
- **On EEXIST.** `lstat` the lock path: missing → retry; a symlink or anything
  that is not a regular file → acquisition **fails permanently** (hostile
  squatting — never follow it, never unlink it). Otherwise stale check: an
  `mtimeMs` older than **10000 ms** is removed only after the contender creates
  the generation-claim hard link with exclusive destination semantics and
  revalidates that both the lock and claim still have the observed `dev` +
  `ino`. A rival that observed the same stale file loses on `EEXIST`; a delayed
  observer that links a fresh replacement fails generation validation and
  removes only its claim. A contender that did not remove the observed
  generation backs off before inspecting again, including when an orphan claim
  keeps the generation fail-closed. The winner unlinks the old lock path, cleans
  its claim in `finally`, then retries normal `'wx'` acquisition immediately.
  This replaces the
  path-only rename-first rule, whose observation→rename gap allowed two winners
  under scheduler pressure (#3550).
- **Backoff / budgets.** ~5 ms between attempts. Drain-side total acquisition
  budget: **2000 ms**. Producer-side budget: **250 ms**.
- **Release.** Observe the lock generation, take the same exclusive hard-link
  claim used by stale reclaim, revalidate the generation, then read and parse
  the lock file; unlink **only** if its `token` matches the one this holder
  wrote. Always clean an owned claim in `finally`; ENOENT is tolerated. Using
  the same generation claim for every protocol remover prevents release from
  replacing or deleting a rival holder's lock.
- **Hold windows.** The drain holds the lock across rotation ONLY — the rename +
  recreate inside `rotateLiveSpool`, never snapshot draining or receipt
  processing — so producer waits stay in the milliseconds. The producer holds it
  across its open+append, so a post-rotation append by a protocol-abiding
  producer can only reach the recreated live spool.
- **Drain fail-safe.** If the lock cannot be acquired within budget, the drain
  SKIPS rotation for that cycle (existing snapshots are still recovered and
  drained). Deferred drain is safe; an unlocked rotation is not. Lock failures
  never throw out of the drain; `drainAdoptionSpoolQuiet` semantics are kept.
- **Producer fallback (degraded mode).** When the producer's 250 ms budget
  expires it MAY fall back to a bare append rather than dropping the receipt.
  Such writes have the pre-lock exposure below.
- **Killswitch.** The `SHADOW_CALLS_OFF` / `OFF`-sentinel early-return runs
  before any lock activity on both sides.

- **Orphan recovery (protocol v2, #3557).** When a remover's claim `link` hits
  `EEXIST` it reads that claim's lease candidates. It may act only on **exactly
  one** candidate that is a hard link to the claimed generation; zero, several,
  or an unbound file all stand down. That one lease names the claim's owner, and
  the claim is recovered only when that owner is *provably* dead: in **this pid
  namespace**, a different boot id, or a pid that is `ESRCH` or alive under a
  different start token. The **namespace is compared first** — a runtime that
  virtualizes `boot_id` per container (lxcfs, nspawn) would otherwise make a live
  peer look like an earlier boot. `alive` and `unknown` both stand down, so an
  owner in another pid namespace (a containerized peer) is never guessed at; its
  claim is recovered by the next process in its own namespace or after the next
  reboot. `EPERM` from `kill(pid, 0)` **proves existence**, so a hidden
  `/proc/<pid>/stat` (`hidepid=2`) then reads as unverifiable, never as death.
  The recoverer takes the right to remove the orphan by **renaming** that lease
  to `<lease path> + '.stolen-' + <recovererId>`: both names are unique per
  attempt, so the rename cannot collide with a fresh claimant, and concurrent
  recoverers contend on one source path with exactly one winner while losers see
  `ENOENT` and stand down. A steal record is **not** ownership evidence (it can
  outlive its claim); it is garbage-collected once its recoverer is provably
  dead. Recovery removes the orphaned **claim only**, never the lock; the caller
  then re-contends normally.
- **v1/v2 interoperability.** The lock payload and the generation-claim name are
  unchanged, so a not-yet-upgraded peer still mutually excludes correctly on the
  same `O_EXCL` claim name. The lease is purely additive. A v1 peer's claim
  carries no lease, and a lease-less claim can never be attributed to a dead
  owner, so it is never recovered — the pre-#3557 fail-closed behavior,
  unchanged.

**Remaining residuals.** A claim whose owner cannot be classified — a v1 peer's
lease-less claim, or an owner in another pid namespace — still holds its
generation fail-closed until a process in the owner's own namespace or a later
boot recovers it. The same applies to an unclassifiable **steal record**, and
there it is stickier: one blocks all recovery of its generation until a process
in the *recoverer's* own namespace collects it, so in the container-drain /
host-producer topology the drain can stay blocked until the next host-side
SessionStart. Two single-syscall windows are likewise unrecoverable by design,
since a claim is only attributable while its lease is on disk: a kill between
taking the claim and recording the lease, and one between removing the lease and
removing the claim. A third, wider window **wedges its generation** (tracked by
[#3659](https://github.com/shpwrck/claude-history-dashboard/issues/3659)): a
recoverer killed after winning the steal rename but before unlinking the claim
leaves the claim, no lease, and a steal record; the next pass must collect that
record (or the finding-1 hole reopens) and every later pass then stands down
permanently. All of these cost availability only; none can produce dual
ownership. Note the case that is **not** a residual: a recoverer killed *after*
unlinking the claim leaves only a stale steal record — a fresh claimant takes the
free claim path normally and the record is collected by the first later pass that
contends. A non-protocol producer — a
legacy hook, or a protocol
producer in degraded mode — can still write through a pre-rotation descriptor;
the drain's bounded snapshot tail passes (it re-reads a snapshot that grew and
refuses to unlink one whose bytes it has not all consumed) remain as the belt
for that case, narrowing but not closing its loss window. Cross-process drains
are likewise not serialized end-to-end: `serializeDrain` is an in-process mutex
and the rotation lock covers only the rotation window, so two server processes
sharing one cache dir can still drain the same snapshot concurrently.

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
- **MARKER-CONFIRMED** — the matching `CLAUDE.md` hunk, extracted **live from
  `liveConfig` at render time by the receipt's `markerHeading`, never stored**.
  Per the amended ADR 0005 this is evidence *consistent with* adoption (the fix's
  markers now appear in merged `CLAUDE.md`), never proof the snippet was applied
  or that the recommendation caused the change. Treatment-scoped findings with
  several fixes under one finding id withhold the hunk because finding-level
  receipts cannot attribute it to one treatment.
- **SUPPRESSED** — `engine went silent <date>, markers now match`, with a
  **non-causal** "no recurrence" sub-line (a deleted `CLAUDE.md` section also
  reads as quiet).

The index header reads `N surfaced / M marker-confirmed / median
days-to-marker-match`, and `M/N` carries a **lower-bound** badge (strict-AND markers
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
