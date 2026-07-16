# Codebase audit — June 2026

Full-repo audit run on 2026-06-12 (branch `claude/codebase-audit-g6fq9o`).
Method: parallel domain reviews (server, parsers, recommendation engine,
CI/automation, frontend) plus baseline checks, findings verified against the
working tree at master `173781b`.

Severity scale: **High** = can corrupt data, mislead a consumer of the
dashboard's claims, or weaken a load-bearing gate; **Medium** = correctness or
maintainability risk with a contained blast radius; **Low** = hygiene.

## Baseline health

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm run lint` (`eslint .`) | clean |
| `npm test` (vitest) | 2296/2301 pass; 5 failures, all environmental (see Tests section) |
| `npm audit` | 0 vulnerabilities |
| Dependency drift | minor; `web-tree-sitter` 0.20→0.26 and `jsdom` 26→29 majors behind |

Repo-level hygiene: `SPRINT_STATUS.md` is checked-in stale scratch (describes
the long-merged #539 sprint as "ready for PR"). AGENTS.md already tells agents
not to trust it; it should be deleted or replaced with a pointer to the issue
queue.

## 1. Data-parsing layer (`src/lib/parse-*.ts` vs `REFERENCES.md`)

Overall: moderately healthy — most parsers are defensive, pure, and tested.
The gaps cluster around inconsistent timestamp handling, one unguarded parse
path, and a stale external-data map.

### High

- **`REFERENCES.md` is stale: six parsers missing from the artifact map**
  (`REFERENCES.md:202-226`). `parse-memories.ts`, `parse-external-guidance.ts`,
  and `parse-repo-map-join.ts` are absent entirely; `parse-workflows.ts` is
  marked "not yet consumed" but is functional; `parse-config-sections.ts` and
  `parse-config-attribution.ts` carry correct "not yet wired" notes but are
  missing from the table rows. Per AGENTS.md this is a `documentation` +
  `backlog` issue, not an inline repair.
- **Unguarded `JSON.parse` in `parseHistoryJsonl`** (`src/lib/parse-history.ts:18`).
  One malformed line in `history.jsonl` aborts the whole history ingest; every
  other JSONL parser wraps lines in try/catch (cf. `parse-utils.ts:86-89`).
  The `as HistoryEntry` cast is also unvalidated.
- **`Date.parse()` NaN leaks into session grouping** (`src/lib/parse-history.ts:83`).
  A malformed ISO timestamp becomes `NaN`, which propagates into
  `groupBySessions()` start times. `parse-teams.ts:251,262` already uses the
  correct `Date.parse(...) || 0` guard — the pattern should be centralized
  (e.g. a `parseDateMs()` helper in `parse-utils.ts`).
- **Duplicated `service_tier` extraction** (`src/lib/parse-sessions.ts:148` and
  `src/lib/parse-timeline.ts:161`). Two independent code paths read the same
  wire field with slightly different logic; a format change breaks them
  independently. Extract a shared helper.
- **Compaction detection assumes chronological entries without sorting or
  asserting** (`src/lib/parse-sessions.ts:73-102`). It guards NaN timestamps
  but trusts array order — a negative time delta passes the `> MAX_GAP_MS` gap
  check, so adjacent-pair comparisons go wrong if entries arrive out of order.
  REFERENCES.md itself warns that on-disk transcript order is filename-driven
  after subagent merges. Sort by timestamp or assert monotonicity.

### Medium

- Silent data drops without telemetry: corrupt team-message payloads
  (`parse-teams.ts:98-105`) and malformed task files (`parse-tasks.ts:141-146`)
  are filtered out with no dropped-record count surfaced to callers.
- `parse-debug.ts:145` uses `NaN` as a sentinel that flows into comparisons —
  safe today, but an explicit `isNaN` skip would make it robust to refactors.
- Session dimensions (`version`, `entrypoint`, `gitBranch`) are frozen at first
  occurrence with no mid-session-change detection
  (`parse-sessions.ts:112-126`).
- `parse-memories.ts:81-89` silently treats a file with pathological
  frontmatter as all-body; behavior is reasonable but untested.

### Low

- Test gaps for malformed input: no tests for partial/absent `usage` objects in
  `parse-sessions.test.ts`, none for mixed-validity JSONL beyond
  `parse-utils.test.ts`, none for deeply nested `tool_result` content in
  `parse-tools.ts:88-103` (under-counts size, undocumented limitation).
- `parse-external-guidance.ts` / `parse-config-attribution.ts` are pure parsers
  not yet wired into ingest (tracked future work #894/#888) — fine, but easy to
  mistake for dead code.

## 2. Tests

`vitest run`: 2296/2301 pass. The 5 failures are all in
`src/lib/cloud-capture-hook.test.ts` and are **environmental, not code bugs**:
the test helper creates temp repos and runs real `git commit`, inheriting the
host's global git config. On a machine with enforced commit signing (as in
this remote container) every commit fails (`fatal: failed to write commit
object`, signing server 400).

- **Medium — test hermeticity**: `cloud-capture-hook.test.ts:29` sets
  `user.email`/`user.name` per temp repo but not `commit.gpgsign=false` (or
  `GIT_CONFIG_GLOBAL=/dev/null`), so the suite fails on any host with signing
  or unusual git config enforced globally. One-line fix in the test helper.

## 3. Server (`scripts/server.mjs` + helpers)

Overall: strong. Multi-stage path validation (normalize → `pathInside` →
realpath), comprehensive size/count bounds on reads, default bind to
`127.0.0.1` with documented CSRF/origin posture for LAN exposure, the LLM
egress chokepoint with a machine-checked CI gate, and ~1:1 test-to-code ratio
in `scripts/*.test.mjs`. Two candidate high-severity findings from the review
were checked against the code and **refuted** (recorded here so the next audit
doesn't re-raise them):

- "Failed background dataset refresh leaves `datasetRefresh` set forever" —
  false; `startDatasetRefresh` clears the flag in `.finally`
  (`server.mjs:1913-1926`).
- "JWT data-root template substitution allows path traversal via claims" —
  false; every substitution passes `safeJwtPathSegment()`
  (`server.mjs:4035-4048`), which strips separators and hashes `.`/`..`.

Verified findings:

### Medium

- **Enterprise JWT issuer check is skipped when `DASHBOARD_AUTH_JWT_ISSUER`
  is unset** — any validly signed token is accepted regardless of issuer. The
  posture docs (`server.mjs:5936`) say to set it for production, but the safer
  default is to refuse to enable enterprise auth without an issuer pin, or at
  minimum log a loud startup warning.
- **`recommendationsBuilds` in-flight map has no size bound**
  (`server.mjs:2027-2043`), unlike the pruned `recommendationsCache` beside
  it. Pathological distinct organization identities could accumulate entries.
  Low practical risk on a local single-user deployment; cheap to bound.

### Low

- `PORT` env is coerced with `Number()` and not range-validated
  (`server.mjs:270`) — a typo binds port 0 (ephemeral) silently.
- `saveDatasetCache` persists via SQLite insert with caught errors
  (`scripts/ingest.mjs:569-579`) — fine, but failures are console-only with no
  surfacing to `/api/health`-style state.
- Enterprise audit log appends don't fsync; document or accept the durability
  gap.

Not independently verified this pass (flagged by review, worth a follow-up
look): schema validation ahead of `appendAdoptionReceipt`
(`server.mjs:3411-3434`), sessionId format/length validation before ingest
lookups on `/api/session/*` routes, and rate limiting scope excluding static
assets under enterprise auth.

## 4. Recommendation engine (vs the auditable-claims contract)

This is the audit's most significant area: the engine's own contract
(AGENTS.md, `docs/adding-a-recommendation.md`,
`docs/recommendation-actionability-contract.md`) is well ahead of the
implementation's median detector. Counts verified directly: **71 registered
detectors, 49 with test files (~22 untested), and only 5 on the
`PROVENANCE_DETECTORS` allowlist**.

### High

- **66/71 detectors emit claims without structured provenance.** The
  migration roadmap exists (#1101–#1105) but the unmigrated majority means
  most of `/api/recommendations.json` is currently not auditable in the sense
  AGENTS.md promises. This is a known, tracked gap — the audit's contribution
  is sizing it: 5/71 compliant.
- **Staleness demotion is implemented in only ~4-5 detectors.** Examples
  asserting present tense from historical data: `activity.stale-projects`
  ("Projects have gone quiet" with no as-of), `context.over-window`,
  `cost.cache-1h-waste`. Per the contract these must demote to "as of <date>"
  or suppress.
- **~22 detectors have no test file at all** (contract requires four test
  categories per detector: evidence, stale handling, suppression, fix
  validity). Untested set includes safety/security detectors
  (`safety.dangerous-bypass`, `security.model-deceit`) where regressions are
  costliest.

### Medium

- **The provenance contract test only proves the exemplar.**
  `provenance-contract.test.ts:13-15` admits the "triggered ⇒ compliant"
  guarantee is proven for `activity.activity-trend` by name and carries a TODO
  to add a generic trigger-and-validate harness for the other allowlisted
  detectors. The harness was never added, so 4 of the 5 "compliant" detectors
  have unverified provenance shape.
- **`context.over-scoped-config-section` (#1398, newest) has provenance but
  no as-of/stale handling** — the repo-map join it reads may be days old and
  the detector still phrases its fix imperative as current state.
- **External-guidance plumbing (#1401) is wired but unconsumed**: the
  `externalGuidance` input field and `references` output field exist with
  zero detector consuming or populating them. Fine as staged infrastructure
  if the consuming detector lands soon; otherwise dead surface.
- **`fix-validity.ts` portability patterns are narrow** — the non-portable
  pattern list catches little beyond `claude-team`; absolute paths, skill
  invocations, and host-specific tool references in snippets would pass.
  Also, illustrative snippets embedding `npm run -s typecheck` are never
  validated against any real script inventory.

One review claim was checked and **refuted**: `safety.dangerous-bypass` does
emit its documented second id (`dangerous-bypass.ts:105`), so the dual-emit
allowlist is not stale.

## 5. CI / automation

Posture is generally good: minimal workflow permissions, major-version-pinned
actions, safe `pull_request_target` usage in milestone-guard (no head
checkout), env-var-mediated inputs in release-gate, correctly scoped
spa-boundary grep (dist-only, public/ excluded), and per-workflow concurrency
groups.

### High

- **Bundle budgets are now enforced nowhere, but the machinery still looks
  alive.** #1402 removed `check-bundle-size.mjs` from `ci.yml`;
  `bundle-budget.json` (with freshly dated ceiling notes) and the
  `enterprise-readiness-gate.mjs:62,106` call sites remain, and no workflow
  invokes `gate:enterprise-readiness`. Decide: re-enable in CI, or mark the
  budget file/gate as manual-only so the next agent doesn't treat ceilings as
  enforced. AGENTS.md's build section still implies budget discipline.

### Medium

- **AGENTS.md calls `PR has a diff` / `spa-boundary` / `test` "load-bearing"
  but GitHub does not require them** — `ci.yml:13` documents all checks as
  advisory until merge-gating is enabled (#241). The merge gate is agent
  policy, not platform enforcement; AGENTS.md should say so explicitly, since
  an agent reading "load-bearing" may assume a red check physically blocks
  merging.
- **`notify-ready.yml:74` interpolates the PR title unescaped into a bot
  comment.** Content injection only (markdown/social-engineering, no code
  execution), and PR authors are currently trusted — but it's a one-line
  escape.
- **`scripts/ci-docs-only.mjs:21-24` silently falls back through three git
  diff strategies**, ending at `HEAD^..HEAD` (last commit only). A multi-commit
  PR in a CI environment where the first two strategies fail could be
  misclassified docs-only. Log which strategy ran; fail loud if the intended
  one is unavailable.

## 6. Frontend (`src/App.tsx`, `src/components/`, SPA boundary)

Overall: strong discipline. SPA/server split is enforced by Vite alias + stub
+ CI grep; views are lazy-loaded through a registry; error boundaries exist at
app and per-view level; memoization and row windowing are in place on the hot
lists; no emoji-convention violations found; PatternFly 6 conversion is
consistent.

### Medium

- **Six substantial #539-era views have zero tests**: `TaskHealthPf` (~488
  LOC), `TeamCoordinationPf` (~544), `PlanShapesPf` (~570), `ReviewQueuePf`,
  `UsagePulsePf`, `DigestSpine`. These are the newest, least-proven surfaces;
  each needs at least empty-state + basic-shape behavioral tests.
- **`SessionTranscript.tsx` uses array-index keys in four block-render maps**
  (lines 161, 175, 255, 269 — verified). Safe while block lists are immutable
  per message, but brittle against future filtering; cheap to key by
  `(type, index)` or block id.

### Low

- `LiveSession.tsx` appears unreferenced from the app/view registry —
  confirm intent or remove (tree-shaken either way).
- The SPA-boundary grep doesn't cover Worker imports; the dataset worker is
  server-build-only today, but nothing asserts it stays out of the SPA dist.
- Upload parse failures clear the spinner without surfacing an error state to
  the user (`App.tsx` import pipeline).

## 7. Documentation & ADR drift

Checked claims in AGENTS.md/CLAUDE.md/README/CONTRIBUTING/docs/adr against the
code. Two review claims were verified and **refuted** before inclusion: ADR
0007's repo-map producer *is* implemented (`src/lib/repo-map/`,
`scripts/repo-map-generate.mjs`, `repoMap` dataset key in
`scripts/ingest.mjs:1566`), and CONTRIBUTING's per-job check names do match
what GitHub displays.

### Medium

- **CONTRIBUTING.md's merge policy under-counts the gates** ("Every PR runs
  four CI checks": lint, build, test, non-empty-diff). A PR today runs ~12
  check runs, including `spa-boundary` and `llm-egress` — the very checks
  AGENTS.md calls load-bearing — plus `ensure-milestone` and conditional
  perf jobs. An agent following CONTRIBUTING literally could merge with a red
  `spa-boundary`. Update the table to the current check inventory (or point
  it at AGENTS.md's PR scope gate as the single source).
- **Enterprise docs still present `check-bundle-size.mjs` as a pre-deploy
  gate** (`docs/enterprise-threat-model.md`,
  `docs/enterprise-deployment-guide.md`) with no note that CI enforcement was
  removed in #1402. Pairs with the section-5 bundle-budget finding: one
  decision should settle both.

### Low / context

- **The Probaitio rename is decided but not executed**
  (`docs/plans/probaitio-rearchitecture.md`, status "proposed", decisions
  locked 2026-06-11: rename Probaitio → Probaitio, new public org, monorepo
  split, fresh-repo publish). README/package identity are intentionally
  unchanged until that cutover; no doc fix needed now, but any new
  identity-bearing surfaces (image names, plugin ids) should anticipate it.
  The plan itself flags one must-fix before going public: the self-hosted
  `chd-browser` runner must not run forked-PR code.
- Stale planning docs in `docs/plans/` and `docs/perf-sprint/` read as live
  work without status/date anchors; cheap hygiene to stamp them
  (same class as the `SPRINT_STATUS.md` finding above).

## 8. Prioritized summary

What I'd act on, in order:

1. **Decide the bundle-budget story (#1402 follow-up)** — re-enable in CI or
   explicitly demote `bundle-budget.json` + the enterprise-readiness call
   sites + enterprise docs to manual-only. Today's state misleads both agents
   and deployers. (Sections 5, 7)
2. **Parser robustness pair in `parse-history.ts`** — guard the `JSON.parse`
   and the `Date.parse` NaN; both are live-data crash/corruption vectors with
   one-line fixes. Add the malformed-input tests alongside. (Section 1)
3. **Update `REFERENCES.md` parser map** — mandated `documentation` +
   `backlog` issue; six parsers missing/mislabeled. (Section 1)
4. **Recommendation-engine contract debt is the big structural item** — 5/71
   detectors with provenance, ~22 with no tests, staleness demotion in ~5,
   and the provenance contract test proves only the exemplar. The roadmap
   (#1101–#1105) exists; this audit sizes the gap and argues for adding the
   generic trigger-and-validate harness first so each migration is
   self-verifying. (Section 4)
5. **Make `cloud-capture-hook.test.ts` hermetic** (`commit.gpgsign=false` /
   isolated `GIT_CONFIG_GLOBAL` in the helper) — currently fails on any host
   with enforced signing. (Section 2)
6. **Tests for the six untested #539 views** + index-key cleanup in
   `SessionTranscript`. (Section 6)
7. **CI hygiene batch** — escape PR title in `notify-ready.yml`, log/fail-loud
   the diff-strategy fallback in `ci-docs-only.mjs`, align AGENTS.md
   ("load-bearing" = agent policy, not platform enforcement) and
   CONTRIBUTING's check table. (Sections 5, 7)
8. **Server hardening smalls** — startup warning (or hard fail) for
   enterprise auth without an issuer pin, bound `recommendationsBuilds`,
   range-validate `PORT`. (Section 3)

Refuted-findings ledger (so future audits skip them): dataset-refresh flag
leak, JWT data-root traversal, missing `msg.usage` guard in parse-sessions,
`dangerous-bypass` dual-emit staleness, ADR 0007 repo-map "not implemented",
CONTRIBUTING per-job check naming.

## Follow-ups filed

- #1413 — REFERENCES.md parser map update (`documentation`)
- #1414 — parse-history hardening + parser dedup/ordering
- #1415 — bundle-budget enforcement decision (#1402 follow-up)
- #1416 — cloud-capture-hook test hermeticity
- #1417 — tests for the six untested #539 views + SessionTranscript keys
- #1418 — recs engine: generic provenance harness + untested detectors
- #1419 — CI hygiene batch (notify-ready escaping, ci-docs-only logging, gate-doc alignment)
- #1420 — server hardening smalls
