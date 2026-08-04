# 0005 — Measurable, showable impact for the recs auto-injection

Status: Accepted (2026-07-22 — #573 closed; the AdoptionScorecard shipped against this design's original wording; originally design-first from the #573 debate)
Amended: 2026-08-03 (#3280, v0.6.0 data-integrity audit) — the marker-transition language
below is corrected from causal claims ("the finding caused a change", "byte-level evidence
the snippet was applied", ADOPTED) to non-causal **marker-confirmed** terminology. The
matcher only establishes that a matching heading and case-insensitive body-phrase fragments
exist somewhere in the merged CLAUDE.md after surfacing; that is evidence *consistent with*
adoption, never proof of it. This amendment **prescribes** the corrected terminology as the
design's semantics; the shipped scorecard and receipts copy
(`src/lib/adoption-scorecard.ts`, `src/components/AdoptionScorecard.tsx`,
`docs/recs-adoption-receipts.md`) now render that marker-confirmed terminology, aligned via
#3620.
Date: 2026-06-04
Supersedes: none
Related: #573, ADR [0002](0002-dynamic-recommendation-rule-engine.md) (rule engine),
ADR [0004](0004-shadow-calls-experiment-engine.md) (shadow-calls), epic #513,
epic #467 (public multi-tenant Coach), #545 (minimum-DECIDED discipline), #556 (replay sandbox)

## Context

The global `SessionStart` recs hook (`~/.claude/skills/recs/scripts/session-start-hook.mjs`)
injects a ~5-line digest of the dashboard's top agent-behaviour findings into context at the
start of every session. Today that injection has **near-zero demonstrable impact**: it primes
context with text that largely duplicates standing CLAUDE.md rules, nothing executable happens,
and — critically — there is **no measurement** of whether an injected finding changed anything.
That blocks the product's core dogfooding thesis: *Claude Coach measurably improves agent
behaviour.* Issue #573 asked for a design that produces a meaningful, measurable, **showable**
impact artifact.

The hard question the design had to settle: **what counts as "the agent acted on a finding,"
and how do we measure the delta credibly?** Naive signals (session compacted, tool-error rate
dropped) are confounded by task mix, session length, and survivorship (a competent agent often
does the right thing regardless).

This ADR records the decision reached by a six-seat adversarial design debate (Measurement
Skeptic, Experiment-Design, Actionability, Demo/Product, Privacy/Scope, Shipping Pragmatist)
plus a synthesis pass. Full debate transcript: workflow run `wf_2d9abc24-bcc` (13 agents).

## Decision

Separate two claims the issue conflated, and never let them mix:

1. **MARKER-CONFIRMED ALIGNMENT — "does merged CLAUDE.md now match the fix's markers?"**
   Deterministic to check, **non-causal to interpret**; ships in v0.
2. **EFFICACY — "did the fix change an outcome that would not have changed anyway?"**
   A bounded, replay-only fast-follow that we explicitly **do not claim in v0**.

### Tier 1 — Marker-confirmed alignment (the load-bearing, showable signal)

Make the **`claudeMdMarksApplied()` FIRING→SUPPRESSED transition** the primary impact signal.

12 detectors already call `claudeMdMarksApplied(liveConfig, markers)` (`src/lib/detectors/shared.ts`)
and `return null` once a fix snippet's declared headings + body phrases appear in the merged
CLAUDE.md (e.g. `reliability.rate-limits` dies once `## Rate-limit hygiene` +
`"serialize heavy automated batches"` are present). That boolean is computed every pass and
**thrown away**. The transition itself is a deterministic config-state delta, not a behavioural
inference — but what it establishes is bounded: the matcher checks only that a matching heading
and case-insensitive body-phrase fragments exist *somewhere* in the merged (global + project)
CLAUDE.md after the finding was surfaced. That is **marker-confirmed configuration alignment —
evidence consistent with adoption, not proof that the recommendation caused the change or that
the fix snippet was applied verbatim**: the fragments can be written independently, pre-exist in
a different merged scope, or arrive for an unrelated reason, and temporal ordering alone does not
establish causation. Task-mix / session-length / "agent would have done it anyway" confounds do
not touch the marker check, but those false-positive attribution paths do.

**Attribution, honestly bounded.** The marker-confirmed claim requires **both** a prior
hook-stamped *surfaced* entry for finding F **and** the later *suppressed* transition. A
suppression with no prior surface is labeled "organic / not attributed" and excluded from the
surfaced-then-marker-confirmed count. We claim only that the loop closed (surfaced → markers now
match → engine went quiet). We do **not** claim the recommendation caused the config change, that
the snippet was applied, or that downstream behaviour measurably improved. **ADOPTED / "coached"
attribution is reserved** for evidence the marker check does not provide: an explicit user action
receipt (the user applying the fix through a recorded action) or a verified before/after
CLAUDE.md hunk tied to the surfaced finding. The "stayed quiet for N sessions" number is labeled
**"no recurrence," not "impact,"** with the explicit caveat that a *deleted* CLAUDE.md section
also reads as quiet. `M/N` is reported as a **lower bound on marker matches** — prose adoptions
that miss the strict-AND markers are undercounted — while, independently and in the other
direction, a marker match can be a false-positive attribution (independently written,
pre-existing in another merged scope, or unrelated); the two caveats do not cancel.

### Tier 2 — Efficacy (reuse shadow-calls; deferred; never a v0 gate)

Answer the controlled behavioural question **only** in the shadow-calls replay path, reusing
`budget.mjs` / `judge.mjs` / `ledger.mjs` / `replay-runner.mjs` / `sandbox.mjs` verbatim — no
parallel measurement stack. Add a binary `recs` axis to `axes.mjs`: Main = finding F injected,
Shadow = F **withheld** from `additionalContext`, on a **replayed** past task (never a live
session — live withholding degrades real work and cannot reach N at one user). Outcome =
`judge.mjs`'s existing task-agnostic 6-dim rubric, **not** a per-finding task-entangled signal
(a 429-count reintroduces the task-mix confound the matched-pair design exists to cancel).
Eligibility excludes already-suppressed findings and screens for paraphrase overlap with standing
CLAUDE.md so a "redundant" finding's near-zero delta is not misread as "useless." Spend routes
through `budget.decide('replay')` / `recordSpend` (no double-spend). Results surface through the
existing `shadow-axis-wins.ts` pathway under the #545 minimum-DECIDED gate: below threshold the
dashboard shows "adoption: injected N times" only and withholds any causal verdict.

### The demo artifact — the Adoption Card

One per-finding card, three timestamped rows a viewer reads in 10 seconds. (The card keeps
its shipped name; the 2026-08-03 amendment prescribes non-causal marker-confirmed wording
for its states and aggregates. The shipped copy renders that marker-confirmed wording as of
#3620.)

- **SURFACED** — `reliability.rate-limits injected 2026-05-28, session <hash>`
- **MARKER-CONFIRMED** — the matching
  CLAUDE.md hunk (`## Rate-limit hygiene` + body phrase), rendered from `liveConfig`
  **at render time, never stored** — presented as evidence consistent with adoption, not
  proof the snippet was applied
- **SUPPRESSED** — `engine went silent 2026-05-29, markers now match`, with a non-causal
  "no recurrence for N sessions" sub-line and an `M/N` "lower bound" badge

Prescribed status pill: `SURFACED | MARKER-CONFIRMED | SUPPRESSED`. Prescribed index
header: `N surfaced / M marker-confirmed / median days-to-marker-match`. The shipped
scorecard now renders this prescribed wording (aligned via #3620). An `ADOPTED` state may
only be reintroduced as a distinct, stronger claim if the design later adds the required
evidence: an explicit user action receipt or a before/after hunk tied to the surfaced
finding.

### Storage & privacy (made structural)

The adoption receipt log lives in the **dashboard's own data directory**, **not** in
`~/.claude/shadow-calls/ledger.jsonl`. `ledger.jsonl` has a closed `VALID_MODES` set
(`live`/`replay`/`replay-skip`) — adding an `adoption` mode is a meta edit — and it sits inside
`~/.claude` where tdrop bundles and the engine's corpus live, which would bake behaviour receipts
into the tdrop bundle and the future hosted-Coach (#467) telemetry path. Two append-only record
kinds, both written through an **allowlist-drop writer that fails closed**:

- `SURFACED { schemaVersion, ts, sessionHash, findingIds[] }` — written by the hook at injection
- `SUPPRESSED { schemaVersion, ts, findingId, markerHeading, contentFingerprint }`

The writer drops any field not on the allowlist — no repo path, cwd, diff hunk, prompt text, or
raw CLAUDE.md body is ever persisted. The card reads the diff hunk live at render time. Both
kinds respect `killswitch.mjs OFF` / `SHADOW_CALLS_OFF=1` — one switch for "stop watching me."

### Two corrections the debate forced

- **Emit once in the engine run loop, not in 12 detectors.** `claudeMdMarksApplied` is a pure
  boolean with no chokepoint; computing the transition once in `src/lib/detectors/index.ts`
  (diffing previously-surfaced-with-markers against now-suppressed) is a single localized change,
  not a 12-file sweep.
- **Auto-apply is OUT of v0 — propose-only.** The global SessionStart hook fires *before* the
  repo/cwd is established, so it cannot safely write the current repo's CLAUDE.md, and writing
  global `~/.claude/CLAUDE.md` is a cross-repo blast-radius violation. "The user chose to apply
  this" is also what makes the card credible — auto-apply would make it self-fulfilling.
  Agent-executed mid-session append (never hook-executed) is a later opt-in issue.

## Consequences

### Positive
- v0 ships a showable, auditable artifact with **zero behavioural inference** — a skeptic's
  "compared to what?" is answered by a deterministic marker-state diff, explicitly labeled
  as non-causal marker confirmation rather than proof of adoption.
- Reuses shadow-calls for efficacy; no second measurement stack, no budget double-spend.
- Privacy is structural (allowlist-drop, fail-closed, killswitch-aware, dashboard-owned store),
  so the global hook never persists project content.

### Negative / accepted limits
- Marker confirmation bounds real uptake loosely in **both** directions: prose fixes that
  miss strict-AND markers undercount it, while independently written, pre-existing, or
  unrelated matching fragments can confirm without the finding causing anything — which is
  why the state is never labeled proof of adoption.
- "No recurrence" can be caused by a user *deleting* the CLAUDE.md section — labeled, not hidden.
- Efficacy accrues slowly at N=1; a causal verdict is withheld below the #545 threshold.
- The adoption schema must be client-side-encrypted-or-omitted from day one (#467) or the local
  design silently becomes the SaaS telemetry schema.

## Rejected alternatives

1. Single-timeline before/after behavioural deltas as proof — no control arm, fully confounded;
   allowed only as "not attributable" descriptive context.
2. "Agent mentioned the topic / ran the command" transcript heuristics — survivorship trap.
3. Live-session finding-withholding for a control arm — degrades real work; replay-only instead.
4. A new parallel per-session telemetry pipeline — reinvents shadow-calls, double-spends the
   budget, stands up cross-repo behaviour surveillance.
5. Auto-applying fixes from the global hook — fires before cwd is known; blast-radius violation.
6. Storing adoption receipts in `ledger.jsonl` — closed `VALID_MODES`, tdrop/corpus/#467 scope.
7. Persisting the literal CLAUDE.md diff hunk — carries project content; read live instead.
8. Per-finding task-entangled efficacy signal (429-count) — reintroduces the task-mix confound.
9. Routing all 12 detectors' `return null` through a shared emitter — emit once in the run loop.
10. An aggregate "improved my agent by N%" tile — built on uncontrolled deltas; debunked in 30s.

## Implementation decomposition

Repo-code (burn-backlog-pickable):
1. Adoption receipt store + allowlist-drop writer (two record kinds, fail-closed, killswitch-aware)
2. Engine-loop suppression-transition emit (`detectors/index.ts`; join key = finding id)
3. Adoption Card + Scorecard view (live-rendered diff hunk, lower-bound + no-recurrence labels)
4. SPA sample-data lifecycle seed (one watermarked card in `build-corpus.mjs`; drift-guarded)
8. Surface efficacy via `shadow-axis-wins.ts` under the #545 minimum-DECIDED gate
9. Marker-coverage authoring rule (bodyPhrases >= 4 words, no bare common words) — also docs

Meta (`~/.claude`, handled manually, not burn-backlog):
5. Hook surfaced-id write to the dashboard store (never `~/.claude`)
6. `recs` axis in `axes.mjs` (replay-only, judge-scored, budget-gated)
7. Replay-eligibility + paraphrase-overlap screen
10. Agent-executed mid-session CLAUDE.md auto-append (opt-in; deferred)

### v0 first PR (ships this week)
Adoption receipt store + suppression emit + minimal Adoption Card, on `feature/573-adoption-card`
off master. Defer the hook-side surfaced write to the immediately following (meta) PR; until then
the card renders suppression transitions labeled "attribution pending" so the repo-code lands and
is showable without the meta change blocking it. `npx vite build` + `npm run lint` +
`npx vitest run` green; plain `✓`, no emoji; no api.anthropic.com; no auto-apply.
