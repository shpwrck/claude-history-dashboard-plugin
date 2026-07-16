# UI-data → Recommendation actionability contract

Keystone slice of epic [#866](https://github.com/shpwrck/claude-history-dashboard/issues/866)
(issue [#851](https://github.com/shpwrck/claude-history-dashboard/issues/851)).
This note defines the contract that keeps the dashboard's *actionable* layer
converged, and records the audit that classifies every UI data family against it.

The wrapper implementations the audit points to are **separate sub-issues**; this
slice defines the contract, produces the audit, and files any genuine gap children.
It does not implement wrappers.

## Why the contract exists

The product model is that the dashboard drives **action**, not just observation.
The agent-facing `/recs` skill, the digest / Ask-Claude context, and
`/api/recommendations.json` all read the **same** layer: the `Recommendation[]`
emitted by `buildRecommendations()` in `src/lib/recommendations.ts`.

A UI view can render a useful, actionable signal (e.g. "this file was re-read 40
times") without any guarantee that the same signal is emitted as a
`Recommendation`. When that happens the signal is **invisible** to every consumer
of the engine — the recs skill, the digest, the API — even though a human looking
at the view can see it. That breaks the product model: the actionable layer must
be a superset of "what a view implies you should do", not an accident of which
detectors happen to exist.

Recommendations are also **auditable product claims** (see the "Recommendations
are auditable claims" section of `AGENTS.md` and audit
[#1049](https://github.com/shpwrck/claude-history-dashboard/issues/1049)). A claim
must be evidence-backed, reproducible, and dated. This contract is the
completeness half of that discipline: auditability says *each claim must be true*;
actionability says *each true actionable signal must become a claim*.

## The contract

> **Any visible UI signal that answers "what should I do next?" — or that implies
> an action the user or agent should take — MUST be projected into
> `buildRecommendations()` output.** A thresholded summary or per-category rollup
> is fine; a one-card-per-row mirror is not. Every exposed UI data family is
> therefore either (a) **backed** by >= 1 `Recommendation` detector/rollup, or
> (b) explicitly **orientation-only**: descriptive context that answers "what is
> happening?" and carries no action, documented as such here.

Lower-level analysis helpers (the `parse-*.ts` signals, drill-down tables) stay
intact — they feed both the views and the detectors. The contract governs the
*actionable projection*, not the existence of detail views.

### The convergence point

`buildRecommendations(input)` (`src/lib/recommendations.ts`) runs a static catalog
of 58 detectors under `src/lib/detectors/{cost,context,workflow,safety,security,
reliability,speed,activity}/`. Each detector is a pure
`rule(input, now) => Recommendation | null`; a `null` means "nothing worth
saying". Both engine callers — the server route
(`scripts/ingest.mjs` → `/api/recommendations.json`) and the client view
(`src/components/Recommendations.tsx`) — assemble their input through the single
`assembleRecommendationInput()` seam, so adding a new engine-consumed signal is a
one-place change.

`RecCategory` is the closed union `cost | context | workflow | safety | security |
reliability | speed | activity`. A new actionable family slots into one of these.

### The detector → view back-link

A `Recommendation` may carry an optional `view: '<navId>'` field naming the UI
surface that shows the underlying signal. This is the formal, machine-checkable
side of the contract: it lets a reader confirm that a given view's actionable
signal has a detector, and lets the UI deep-link a card to its source view. As of
this audit, detectors carry `view:` back-links to 14 of the nav views (e.g.
`errors` ×8, `context` ×7, `tools`/`permissions`/`cost` ×5, `files` ×3).

### How to satisfy the contract for a new actionable family

1. Add the signal field to `RecommendationInput` (in `src/lib/detectors/types.ts`)
   and map it in `assembleRecommendationInput()`.
2. Write a one-per-file detector under the right `src/lib/detectors/<category>/`
   that thresholds/rolls up the signal and returns a `Recommendation | null`.
3. Set `view:` to the nav surface that displays the signal.
4. Follow the auditability recipe in
   [`docs/adding-a-recommendation.md`](./adding-a-recommendation.md): structured
   `provenance`, a `fixKind`-tagged fix snippet, stale-data demotion, and tests
   for evidence / stale-data / suppression / fix-validity.

## Audit: UI data families classified

Every nav view (`src/lib/nav-prefs.ts`) and its primary data family, classified
**Backed** / **Orientation-only** / **Gap**. Verified against the detector catalog
(`src/lib/detectors/index.ts`) and each component in `src/components/`. Server-only
views (`serverOnly: true`) are marked (S).

| View | Domain | Primary actionable data family | Class | Detector(s) / note |
|------|--------|--------------------------------|-------|--------------------|
| Overview (Summary) | home | Token spend distribution by project/day/model/type | Orientation | Descriptive spend; the actionable slices are the `cost.*` detectors |
| Recommendations | home | The ranked finding list itself | Backed | Direct output of `buildRecommendations()` |
| Insights | home | LLM narrative: wins / frictions / ambitions | Orientation | Generated narrative, not a thresholded actionable claim |
| Adoption (S) | home | Finding surfaced → adopted → suppressed status | Orientation | Tracks adoption of existing findings; not a new signal |
| Permissions | safety | Dangerous commands, deny-rule gaps, allow/deny overlap | Backed | `safety.dangerous-bypass`, `safety.prompt-friction`, `safety.deny-rule-never-triggered`, `safety.allow-rule-overlaps-deny` |
| Enterprise (S) | safety | Org posture / policy gaps | Orientation | Posture surface; actionable gaps route through the `safety.*` detectors above |
| Summary | cost | Token spend by project/session type | Orientation | Shared aggregator with Overview |
| Cost | cost | Cache waste, expensive sessions, legacy-model overpay, web-search/priority spend, idle MCP, expensive agent type | Backed | `cost.cache-1h-waste`, `cost.expensive-sessions`, `cost.automation-share`, `cost.legacy-model-overpay`, `cost.web-search-spend`, `cost.priority-tier-spend`, `cost.idle-mcp-tools`, `cost.expensive-agent-type`, `cost.unknown-model` |
| Tokens | cost | Cache hit rate; input/output/cache token mix | Backed | `context.low-cache-hit` (cache hit rate is the actionable lever); raw token mix is orientation |
| File Impact | cost | File-reread density, high-churn files, read-only impact | Backed | `workflow.redundant-reads` (consumes `parseFileReread`), `workflow.file-churn` (`view: 'files'`) |
| Errors | success-rate | Tool errors, API errors, retry storms, prefix re-waste, overload re-retry | Backed | `reliability.tool-errors`, `reliability.api-errors`, `reliability.retry-storms`, `reliability.retry-prefix-rewaste`, `reliability.overload-reretry` |
| Report Card (S) | success-rate | Per-project KEEP/FLAG/MOVE verdicts | Backed | `reliability.agent-report-card` |
| Speed Check (Evaluator) | speed | Hook wall-clock overhead; turn latency / cost per task | Backed | `speed.hook-overhead`; per-model latency lever tracked under #1166 → #915 |
| Context Health | context-health | Context growth, cache efficiency, compaction risk, bloated CLAUDE.md, repo-map waste | Backed | `context.over-window`, `context.low-health`, `context.low-cache-hit`, `context.bloated-claude-md`, `context.compaction-hot-sessions`, `context.repeated-compactions`, `context.compaction-large-tool-outputs`, `context.repo-map-context-waste` |
| Turn Patterns (Conversation) | context-health | Turn-latency histogram, thinking ratio, turn shape | Orientation | Descriptive conversation shape; per-model latency lever is the only actionable slice, tracked under #1166 → #915 |
| Tool Usage | workflow-hygiene | Native-tool bypass, repeated commands, low tool effectiveness, undo rate | Backed | `workflow.native-bypass`, `workflow.repeated-commands`, `workflow.low-tool-effectiveness`, `workflow.tool-undo-rate` |
| Agents | workflow-hygiene | Unused installed skills / subagents / commands | Backed | `workflow.unused-installed-skills`, `workflow.unused-installed-subagents`, `workflow.unused-installed-commands` |
| Automation | workflow-hygiene | Unattended (sdk-*) session cost share | Backed | `cost.automation-share` |
| Workflows | workflow-hygiene | Failed workflow runs, runaway workflow cost | Backed | `workflow.failed-workflow-runs`, `workflow.runaway-workflow-cost` |
| Session Patterns | workflow-hygiene | Rework signatures, plan-missing-verification, harmful habits | Backed | `workflow.rework-signature`, `workflow.plan-missing-verification`, `workflow.harmful-habit`, `workflow.correction-mining` |
| Memories | workflow-hygiene | Stored project/user/feedback memories | Orientation | Knowledge base; not a signal-discovery surface |
| Task Health (S) | workflow-hygiene | Abandoned tasks, blocked-task pileup | Backed | `workflow.abandoned-tasks`, `workflow.blocked-task-pileup` |
| Team Coordination (S) | workflow-hygiene | Dropped assignments, stalled agents | Backed | `reliability.dropped-assignments` |
| Task Plans (S) | workflow-hygiene | Plan shape, verification coverage | Backed | `workflow.plan-missing-verification` |
| Search | discovery | Full-text prompt/content search | Orientation | Navigation affordance, no implied action |
| Sessions | discovery | Session list, effectiveness/quality scorecard | Orientation | Browsing context; project-level quality verdicts route through `reliability.agent-report-card` |
| Projects | discovery | Activity heatmap, momentum | Orientation | Time-series visualization |
| Timeline | discovery | Session transcript playback | Orientation | Transcript replay |
| Activity / Stats | raw | Activity-by-day, project distribution, stale projects, trend | Backed | `activity.stale-projects`, `activity.activity-trend` |
| Pulse (S) | raw | Weekly activity trend, WoW verdict | Backed | `activity.activity-trend` |

### Roll-up

- **Backed:** 18 view families — every actionable signal projects through a detector.
- **Orientation-only (documented):** 12 view families — descriptive context with no
  implied action (Overview/Summary spend, Insights narrative, Adoption status,
  Enterprise posture, Memories, Search, Sessions, Projects, Timeline, Turn
  Patterns shape).
- **Gap (actionable, unbacked):** none beyond the gaps **already filed** as open
  sibling sub-issues of #866 (below).

## Known actionable gaps — already tracked

The audit found **no new actionable gap** that is not already a filed, open sibling
sub-issue of #866. The three known wrapper gaps are:

- [#1164](https://github.com/shpwrck/claude-history-dashboard/issues/1164) —
  Config-hygiene findings → Recommendation rollup detector (ConfigHygiene surface).
- [#1165](https://github.com/shpwrck/claude-history-dashboard/issues/1165) —
  Model-routing savings → summary cost Recommendation.
- [#1166](https://github.com/shpwrck/claude-history-dashboard/issues/1166) →
  [#915](https://github.com/shpwrck/claude-history-dashboard/issues/915) —
  Per-model latency signal capture, which unblocks the `speed.model-latency`
  detector behind the Speed Check / Turn Patterns latency families.

Two candidate gaps surfaced during the audit and were **dismissed on verification**,
recorded here so the next pass does not re-file them:

- *File-reread context waste (File Impact view)* — **not a gap.** Already backed by
  `workflow.redundant-reads` (which consumes `parseFileReread`) and
  `workflow.file-churn` (`view: 'files'`).
- *Turn-latency spike (Turn Patterns view)* — **not a new gap.** The actionable
  slice is per-model latency, already tracked by #1166 → #915; the rest of the
  histogram is orientation.

## Acceptance trace (issue #851)

- [x] A written UI-data → Recommendation contract committed under `docs/` — this file.
- [x] An audit checklist classifying every UI data family as backed / orientation-only / gap — the table above.
- [x] Every actionable gap the audit finds is filed as a child sub-issue under #866 — the audit finds none beyond the already-open #1164 / #1165 / #1166 (→ #915); two candidate gaps were verified false and recorded so they are not re-filed.
- [x] No implementation of the config-hygiene or model-routing wrappers here — those remain #1164 / #1165.
