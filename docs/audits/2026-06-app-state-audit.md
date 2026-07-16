# App state audit - 2026-06-12

Audited against `origin/master` at `86558f0bcef4d8ece497cec0c85ecac3634dc176`.
This report is intentionally issue-free: it identifies loose ends and scoped
candidate issues, but does not file them.

> **Correction (2026-07-08):** #2346 / PR #2353 subsequently added Timeline's
> selected-session open/copy affordance. #1623 wired ProjectActivity's aggregate
> filtered navigation, and #2346 / PR #2353 removed its unused per-session prop.
> Timeline and Activity statements and recommendations below remain point-in-time
> findings from 2026-06-12; read their section corrections before treating those
> findings as current.

## Scope and method

This was a source-and-docs audit, not a browser visual regression pass. The goal
was to answer: for every current page and major global feature, is the page
direction clear, is the data populated from a defensible source, and is the
implementation complete enough to guide a user to the next useful action?

Inputs used:

- Navigation and registry inventory: `src/lib/nav-prefs.ts`,
  `src/lib/view-registry.tsx`.
- Intent docs: `docs/recommendation-actionability-contract.md`,
  `docs/reviews/actionability-review.md`,
  `docs/reviews/per-view-synthesis.md`,
  `docs/reviews/nav-redesign-outcome-first.md`,
  `docs/v0.4-proof-engine.md`, `docs/adr/*`, `REFERENCES.md`,
  `docs/user-stories.md`.
- Page implementations and parsers under `src/components`, `src/lib`, and
  `scripts/server.mjs`.
- Five parallel read-only subagent audits:
  - Recommendations, Adoption, Digest/Today, Ask Claude, proof feedback.
  - Sessions, Session Detail, Timeline/evidence overlay, Review Queue, Diary,
    Conversation and Session Patterns.
  - Summary, Tokens, Cost/Reclaim, File Impact, Project Activity, Usage Stats,
    metrics charts.
  - Tool Usage, Error/Retry, Automation, Agents/Skills, Model Evals, Prompt
    Analyzer, Task Health, Team Coordination, Workflows, Report Card, Plans,
    Pulse.
  - Config Hygiene, Policy Builder, Live Session, Enterprise Admin, SPA/server
    boundary, Reload, Shell.

## Executive read

The app is not generally missing screens. It has the opposite problem: many
screens exist and parse real artifacts, but their product contract is uneven.
Some pages are proper action surfaces, some are honest raw/reference surfaces,
and some sit in the middle: they show useful numbers but do not let the user
reach the supporting session, file, policy diff, receipt, or next command.

The main loose ends fall into five groups:

1. **Input parity gaps across action surfaces.** Recommendations is the
   canonical action layer, but Home Digest and Ask Claude do not pass the same
   richer recommendation inputs. This can make Home and Ask Claude miss findings
   that the Recommendations page/API can see.
2. **Artifact-reader pages need explicit contracts.** Adoption, Model Evals,
   Shadow Calls, Task Health, Team Coordination, Workflows, Report Card, Pulse,
   Diary, and Memories all depend on sidecar artifacts. Several are good readers
   but do not clearly say whether they are action surfaces, evidence ledgers, or
   raw/reference views.
3. **Drilldown/actionability is inconsistent.** The same data often appears as
   a linked session row on one page and as hover-only chart, plain text ID, or
   aggregate card on another page. The old actionability reviews are still
   directionally accurate.
4. **Some data gaps are implementation joins, not "need more data".** The Agent
   Report Card nulls are likely caused by reliability signals being joined only
   through the live session registry, not just by lack of telemetry. More data
   may help later, but the join should be checked first.
5. **The outcome-first IA decision is not fully paid off.** Docs say top-level
   navigation should be outcome/action driven, with detailed views preserved as
   drilldowns. The current app still exposes many detailed/raw surfaces as peer
   destinations, so users can land on pages that are implemented but
   underscoped.

## Highest priority gaps

These are the gaps most likely to create incorrect product behavior, misleading
claims, or user confusion.

1. **Home Digest and Ask Claude recommendation context are under-plumbed.**
   `Recommendations` passes richer inputs including model-eval and repo-map
   data, while `DigestSpine` and `buildRecommendationsContext()` pass a narrower
   set. Result: three surfaces that imply the same recommendation truth can
   disagree.
2. **Session Timeline is materially below original scope.** Lazy hydration
   exists, but the page still lacks filters, zoom/pan, row detail, open-session
   wiring, and a load-more/export path beyond the 2,000-row cap.
3. **Activity is visually rich but operationally dead.** It accepts navigation
   concepts in the product intent, but calendar/hour/project cells are mostly
   title-only and do not drill into sessions or Projects.

> **Correction (2026-07-08):** In item 2, #2346 / PR #2353 superseded the
> open-session clause. In item 3, #1623 wired Activity's aggregate date/project
> drilldowns, and #2346 / PR #2353 removed its unused per-session prop. The
> other clauses remain findings from the 2026-06-12 snapshot.

4. **Timeline evidence truthfulness needs follow-through.** The reviewed graph
   direction should stay folded into Timeline, use full timeline/value-flow
   data where available, and keep dense-session strategy plus keyboard
   selection explicit.
5. **Model Evals has an explicit incomplete pass.** The UI says the mined-gap
   exclusion pass is not wired. That can overrepresent false-positive candidate
   gaps.
6. **Adoption/Proof is half integrated.** `PROOF` receipts exist in the schema,
   but Adoption docs/routes still mostly describe `SURFACED`/`SUPPRESSED`, the
   scorecard ignores proof in its index path, and the pre-suppression `ADOPTED`
   state appears unreachable.
7. **Enterprise readiness gate is documented stronger than CI enforces.** Docs
   position `npm run gate:enterprise-readiness` as the CTO receipt, but CI runs
   only selected readiness/posture tests, not the full gate.
8. **Policy write capability is not reflected in the frontend.** The server
   gates policy writes by enterprise capability, but the Policy Builder only
   gates the write button on server availability.
9. **Global reload can fail silently.** `App.tsx` swallows reload failures, so a
   refresh affordance can appear to do nothing.
10. **Global filters and empty states are uneven for newer artifact surfaces.**
    Several server-only/artifact views are not included in filtered-empty logic
    and may ignore project/time filters or fail to explain that they are
    intentionally unfiltered.

## Already tracked issues confirmed by this audit

The following existing issues still look valid and should remain in the epic
unless they are intentionally superseded:

- `#1437` - Judge/audit check should show run state and skip reasons.
- `#1439` - Token/cost spend needs real model identity and honest unknown-model
  handling.
- `#1441` - Cost/Reclaim dedupe and legend/KPI redundancy.
- `#1444` - Validation seed data for empty/sparse/rich states.
- `#1447` - Per-session conversation sorting.
- `#1453` - Team Coordination should distinguish actionable runs from stale UUID
  artifacts.
- `#1454` - Timeline evidence UX review (formerly Forensic Graph).
- `#1460` - Agent Report Card should join reliability signals beyond the live
  session registry.
- `#1461` - Review Queue should start with 20 rows plus Load more.
- `#1462` - Prompt Analyzer Trait Distribution spacing.
- `#1463` - Task Plans scatter should be full width with A/B/C cards below.
- `#1465` - Standardize sortable table columns.
- `#1466` - Diary projects should be full width and collapsed by default.
- `#1467` - Recommendations usage warning should use `claude auth login`, copy
  text, and make refresh visibly work.
- `#1468` - ErrorRetry top-tools chart should be full width and avoid legend/X
  axis overlap.

## New candidate issues

These are not filed yet. They are phrased to be independently grabbable.

1. **Normalize recommendation inputs across Recommendations, Home Digest, Ask
   Claude, and `/api/recommendations.json`.**
   Make all action surfaces use the same canonical input envelope or explicitly
   label omitted detector families.
2. **Define a page contract matrix for every route.**
   For each view: purpose, data source, owner parser, server/SPA availability,
   global-filter behavior, empty/sparse/rich state, primary action, and whether
   it is action/evidence/raw.
3. **Make Activity drill into sessions/projects or demote it as raw context.**
   Calendar cells, hour buckets, weekdays, and active projects need navigation
   to filtered sessions/projects if the page remains top-level.
4. **Complete Session Detail evidence loops.**
   Make warning tiles drill to scoped evidence, expose copyable session IDs, and
   offer a single chronological transcript/full-message path.
5. **Bring Timeline to a defensible large-session product surface.**
   Add row detail, open-session/evidence wiring, filtering, and load-more/export
   beyond the 2,000-row cap.

> **Correction (2026-07-08):** #1623 shipped the aggregate date/project Activity
> drilldowns requested by item 3, and #2346 / PR #2353 shipped Timeline's
> selected-session open/copy affordance from item 5. These snapshot priorities
> are preserved for their other, separately scoped gaps.

6. **Follow the Timeline evidence UX review with implementation.**
   Hydrate full timeline evidence, add dense-session strategy, and make SVG node
   selection keyboard accessible.
7. **Wire Model Evals exclusion/provenance/run handoff.**
   Implement the exclusion pass, add provenance for mined clusters, and provide
   a copy/export handoff for the proposed batch spec.
8. **Reconcile Adoption and Proof receipt models.**
   Fix or remove the unreachable `ADOPTED` state, update stale `#581` copy, and
   add a proof-specific read model or UI if `PROOF` receipts are first-class.
9. **Gate Policy Builder write affordance on enterprise capability.**
   If `canWritePolicy` is false, show copy-only with an explicit explanation
   instead of surfacing a write button that the server will reject.
10. **Make Reload visibly report freshness and failures.**
    Show last successful refresh, stale/fresh state, and surfaced errors.
11. **Audit global project/time filter behavior for artifact views.**
    Cover tasks, teams, report card, stats cache, plans, model evals, diary,
    workflows, memories, and shadow calls.
12. **Add chart/KPI drilldown and export consistency.**
    Standardize which charts expose `data-signal-id`, click-through, copy/export
    data, and filtered session evidence.
13. **Clarify heuristic labels.**
    Error retry groups, retry storms, session patterns, prompt traits, and
    pulse trends should not read stronger than their deterministic heuristics.
14. **Repair stale docs/copy around Insights, Workflows, and readiness gates.**
    README still references actionable `/insights`; `REFERENCES.md` says
    workflow manifests are not consumed; readiness docs imply a stronger CI gate
    than currently exists.

## Page-by-page audit

Severity key:

- **High** - likely misleading, broken for large corpora, or materially below
  stated intent.
- **Medium** - useful page exists, but actionability/data contract is incomplete.
- **Low** - mostly polish, stale copy, or optional drilldown.

### Home / Overview

Current state: `home` renders `DigestSpine`, with safety-first domain ranking
and top recommendations. This matches the ranked digest direction better than
the older co-equal card model.

Gaps:

- `DigestSpine` does not pass the same recommendation inputs as the
  Recommendations page/API, so Home can miss repo-map, model-eval, proof, or
  other newer detector families.
- The registry passes `onOpenSession`, and props mention session navigation, but
  Home mostly sends users to broad views rather than scoped evidence.

Severity: **High** for input parity, **Medium** for evidence polish.

### Recommendations

Current state: `buildRecommendations()` is the canonical convergence path and
the page passes a broad input set. It also includes judge/audit UI and usage
limit/auth warning surfaces.

Gaps:

- Page copy says findings are derived from every signal in the dashboard, but
  some visible panels remain auxiliary or only partially projected through
  recommendation detectors.
- Provenance exists structurally but is optional and user-visible provenance is
  not consistently surfaced in cards.
- The logged-out warning/refresh command issue is already tracked in `#1467`.
- Judge/audit run state and skip reasons are already tracked in `#1437`.

Severity: **Medium**.

### Adoption

Current state: The page reads deterministic adoption receipts and presents
lower-bound, non-causal adoption status. This aligns with ADR 0005.

Gaps:

- The pre-suppression `ADOPTED` state appears unreachable because `liveHunk` is
  computed only inside the `suppressed` branch, while the `ADOPTED` branch
  requires no suppression plus `liveHunk !== null`.
- Docs and code comments still say attribution is pending until `#581`, but
  that issue is closed.
- `PROOF` receipts exist in the broader receipt schema but are not integrated
  into the Adoption scorecard model.

Severity: **Medium**.

### Diary

Current state: The server builds deterministic daily digest data and the page
fetches `/api/digest` by selected date.

Gaps:

- Project cards are side-by-side and expanded by default; `#1466` tracks making
  each project full width and initially collapsed.
- Session titles are plain text, not session links, even though digest rows carry
  session IDs.
- File impact shows a truncated first-four list plus `+N more` without expansion
  or file/session drilldown.
- The UI uses browser-local "today" while the server digest is server-local,
  which can request the wrong day across timezones.

Severity: **Medium-High**.

### Permissions / Policy Builder

Current state: The page computes allowlist diffs, supports copy, and can write
confirmed diffs through validated server endpoints with CSRF and backups.

Gaps:

- Frontend write affordance is gated only by server availability, not by the
  enterprise `canWritePolicy` capability. Unauthorized users can see an action
  that the server will reject.
- SPA/copy-only mode could explain write-back unavailability more clearly.

Severity: **Medium**.

### Enterprise Admin

Current state: Auth/capability enforcement exists for scoped reads, admin-only
policy writes, receipt export, audit export, and refresh.

Gaps:

- Docs describe the full `npm run gate:enterprise-readiness` as a CTO receipt,
  but CI runs only selected readiness/posture tests, not the full gate. That is a
  governance/evidence gap rather than a runtime failure.

Severity: **High** for enterprise readiness claims.

### Summary

Current state: Summary renders project/day/model/token/session-type slices using
shared aggregators.

Gaps:

- It is mostly static: rows and inline charts do not hand off to filtered
  Sessions/Projects/Tokens.
- The product decision is unclear: keep as raw overview, or make it a drilldown
  index.

Severity: **Medium**.

### Token Usage

Current state: KPI totals, cache-hit action, spend trend, token-session bars,
compaction rows, model mix, Opus-swap tables, and session table exist. Several
session paths are linked.

Gaps:

- `Top 20 Sessions by Cost` sorts within a pre-sliced top-20-by-token set, so a
  lower-token but expensive session can be omitted.
- Model Distribution counts calls, not token/cost share; the donut/legend can
  imply a complete part-to-whole cost distribution.
- Opus-swap remains a theoretical ceiling without evidence/action loop.
- Unknown/real model identity is already tracked by `#1439`.

Severity: **High** for model/cost truthfulness, **Medium** for table semantics.

### Cost Attribution

Current state: Cost flow graph and collapsed session breakdown are implemented.
The Sankey construction conserves Project to Session to Tool and related flows.

Gaps:

- Cost and Reclaim still overlap heavily; `#1441` tracks the dedupe.
- Sankey nodes/links are hover/focus only, not drilldowns.
- Cost flow does not consistently link to recommendation evidence or fix paths.

Severity: **Medium-High**.

### Reclaim Compass

Current state: Gauge, category coverage, trendline, rejections, and levers are
implemented and aligned with v0.3 "efficiency compass" intent.

Gaps:

- Reclaim lever rows show dollars and IDs but do not link to recommendation
  evidence or apply/copy paths.
- Proof-loop integration is incomplete; v0.4 wants receipts or honest null
  verdicts, not only estimated levers.

Severity: **Medium-High**.

### File Impact

Current state: KPIs, sortable active-file table, directory hotspots,
load-once candidates with `@path` copy, session re-read drilldown, and read-only
file chart exist.

Gaps:

- Many file/directory/read-only rows are not drilldowns.
- Path affordances are inconsistent: load-once candidates get copy, other path
  lists are mostly plain text or tooltip-only.
- Broader original ambitions around file detail/collaboration graph are not
  present; decide whether that is out of scope.

Severity: **Medium**.

### Model Evals

Current state: Server-only workbench reads external eval result artifacts, ranks
runs, displays routing recommendations, mined clusters, and a proposed batch
spec preview.

Gaps:

- The page explicitly says the exclusion pass is not wired, so every mined
  candidate is shown as kept.
- Proposed batch spec is preview-only; there is no copy/export/run handoff.
- Empty state is honest: no results appear until an external meta-runner drops
  artifacts.

Severity: **Medium**.

### Error and Retry

Current state: KPIs, split error/non-error bars, retry groups, status codes, and
API event details are implemented.

Gaps:

- "Retry Groups" can imply the same failed operation, but the implementation is
  same-tool adjacency within 60 seconds.
- "Errors Retried After Failure" lacks scoped session/time links.
- The top-tools chart layout issue is tracked by `#1468`.

Severity: **Medium**.

### Agent Report Card

Current state: Server-only report card joins session registry, telemetry, and
debug logs into KEEP/FLAG/MOVE guidance.

Gaps:

- Null-heavy cards are likely caused by joins relying on session registry IDs
  rather than all available telemetry/debug session identifiers. This is tracked
  by `#1460`.
- Rows do not expose the exact supporting sessions directly.

Severity: **High** for null data truthfulness until `#1460` is fixed.

### Review Queue

Current state: Deterministic queue ranks sessions from cost, tools, API errors,
debug, telemetry, context, and outcomes. It links sessions and evidence views.

Gaps:

- It renders the full queue; `#1461` tracks initial 20 rows plus Load more.
- Evidence links navigate to aggregate views, not exact evidence instances.
- There are no category/severity filters.

Severity: **High** for large corpora, otherwise **Medium**.

### Speed Check / Evaluator

Current state: Aggregates per-task cost, tool-call latency, retry-storm rate,
and reread-loop fraction, then links to Cost, Timeline, Errors, and File Impact.

Gaps:

- The page is honest about signal provenance, but still mostly routes to broad
  pages. It does not identify the slowest sessions or exact offending evidence.
- Speed remains the poorest-instrumented top-level domain by prior ADR. Sparse
  data is expected until native runtime events are available.

Severity: **Medium**.

### Context Health

Current state: Stronger than many pages. It computes cache efficiency, context
growth, compactions, session costs, health scores, and compaction risk, with many
`SessionIdLink` handoffs and sortable detail panels.

Gaps:

- Some charts still behave as visual summaries rather than filtered drilldowns.
- Global chart/export metadata is not as consistent as Cost/Tokens/File Impact.

Severity: **Low-Medium**.

### Conversation Patterns

Current state: Search, sorting, denominators, session links, and Load more are
implemented. This is one of the more complete table surfaces.

Gaps:

- Histogram/bucket summaries do not drill down to the contributing
  sessions/turns.
- Remaining sort consistency is covered by the broader table issue `#1465` and
  earlier `#1447`.

Severity: **Low**.

### Session Patterns

Current state: Computes timeline clusters and habit impact with explicit
association-not-causation parser intent.

Gaps:

- Ranking copy is stale: UI describes a lower-is-better normalized ranking, but
  current logic uses radar/composite scores.
- "Successful patterns" and "Anti-patterns" can sound stronger than proxy data
  supports.
- Singleton/member clusters are not inspectable enough.

Severity: **Medium-High** for data truthfulness.

### Tool Usage

Current state: Aggregates calls, catalog use, repeated commands, discovery
failures, and effectiveness. Recommendation detectors use some of the same
signals.

Gaps:

- README promises trends, but the page is mostly aggregate, not temporal.
- Bypass/repeated/discovery rows often do not link to exact session/command
  evidence.
- Command tables need consistency with the all-columns-sortable decision in
  `#1465`.

Severity: **Medium**.

### Agents / Skills

Current state: Combines native attribution, fallback aggregation, MCP, runtime
telemetry, AFK/scheduled activity, and effectiveness.

Gaps:

- The page is carrying several different concepts under one label: agents,
  skills, MCP, runtime telemetry, and AFK activity.
- Session totals can mix native attribution with parent-tool fallback.
- MCP/skill token output has limited USD estimate/drilldown.
- Stop-hook duration copy is based on sparse timing data.

Severity: **Medium**.

### Automation

Current state: Classifies `sdk-*` entrypoints, cost share, search/sort,
expandable sessions, and timeline.

Gaps:

- Copy says "cron", but classifier only sees `sdk-*` entrypoints.
- `toolData` and `apiErrors` are accepted but unused, so reliability/error
  diagnosis is thin.
- Cost-share card does not drill in.

Severity: **Medium**.

### Workflows

Current state: Completed-run ledger, phase tree, Gantt, and session link exist.
Nested workflow transcripts are parsed.

Gaps:

- `REFERENCES.md` is stale and says workflow manifests are not yet consumed.
- Table lacks search/sort/status focus.
- Logs/scripts/results are dropped, limiting failed-run explanation.

Severity: **Medium**.

### Prompt Analyzer

Current state: Local-only numeric prompt traits, aggregate distribution, and
coaching correlation are implemented. It intentionally avoids retaining prompt
prose.

Gaps:

- Product direction is sparse outside code comments.
- Aggregate-only rows do not let the user inspect which sessions drove
  low-specificity or follow-up signals.
- Regex-derived traits may read stronger than their evidence supports.
- Trait Distribution spacing is tracked by `#1462`.

Severity: **Medium**.

### Shadow Calls

Current state: Server-only artifact reader for shadow-call outcomes and axis
results. It can support the broader proof/recommendation feedback loop.

Gaps:

- It is mostly a reader, not a proof-control surface.
- No run controls or clear provenance path from an axis result to the
  recommendation/eval/proof receipt it should affect.
- Shadow-axis win detectors can use wording like "measurably helped" with a
  small decided sample, which is stronger than the v0.4 proof standard.

Severity: **Medium**.

### Memories

Current state: Reads per-project memory files, groups by project, shows type,
description, expandable body, and file path. It is intentionally available in
SPA if uploaded/sample memory data exists.

Gaps:

- Memory rows are raw/reference only. There is no path copy, open-project, or
  stale/duplicate memory action.
- Tables are not sortable.
- The top comment still says server-only, while implementation and nav comments
  allow SPA with uploaded/sample data.

Severity: **Low-Medium**.

### Task Health

Current state: Server-only task completion, abandoned sessions, blocked pileups,
and worst-first summaries exist. Main table links sessions.

Gaps:

- Abandoned/pileup detail panels show session text without session links.
- Owner/PR data is parsed but not very actionable.
- Recommendation fix snippets are not surfaced here.

Severity: **Medium**.

### Team Coordination

Current state: Team health cards, dropped assignment rows, grace logic, and
weekly digest exist.

Gaps:

- Rows do not join to canonical task/session/PR context.
- "Dropped" uses a fixed 10-minute grace without visible control or enough
  context.
- Next step is prose, not a redispatch/copy action.
- Stale UUID/actionable-run distinction is tracked by `#1453`.

Severity: **Medium**.

### Task Plans

Current state: Structural clustering of plans without prose retention, with
verdict banner, scatter, shape cards, and table.

Gaps:

- Layout issue is tracked by `#1463`.
- With fewer than three plans, all plans are assigned shape A, which can overstate
  cluster meaning.
- `fileRefs` can read like actual file references but appears to include
  numbered references/list items.

Severity: **Medium**.

### Search

Current state: Search filters prompt/history entries, supports project filter,
limits to 100 results, and cards open Sessions. Earlier false clickable-card
affordance appears fixed.

Gaps:

- Results are prompt/search snippets only; pasted content matches are searched
  but the matching pasted content is not separately exposed.
- No sorting/date filter beyond project.
- Showing first 100 has no Load more/export path.

Severity: **Low-Medium**.

### Sessions

Current state: Core session list has search, sort, date headers, globally sorted
then windowed rows, expandable details, and Load more.

Gaps:

- Date headers group but do not collapse.
- Project sublabels and tag badges are plain text even though they look like
  natural filters/drilldowns.
- Detail Good/Bad/Clear tagging is local to detail; tag summaries are not a
  navigable filter.

Severity: **Medium**.

### Session Detail / Transcript

Current state: Detail panel shows metric tiles, tools/files, local summary,
scorecard, evidence, user messages, transcript, and session reference.
Transcript content is lazy-fetched.

Gaps:

- Only the Errors metric tile is clickable; compactions and peak-context tiles
  are dead status.
- Errors navigates to aggregate ErrorRetry, not scoped evidence.
- User messages and assistant transcript are separated rather than a single
  chronological transcript.
- Session reference does not clearly expose/copy the session ID.

Severity: **Medium-High**.

### Projects

Current state: Expandable project rows and clickable sessions exist.

Gaps:

- Mini-heatmaps and activity context are mostly orientation, not drilldown.
- Some project-level summaries duplicate Summary/Activity without a clear
  distinct job.

Severity: **Medium**.

### Timeline

Current state: Lazy full timeline hydration exists, with session picker and row
rendering. Visible entries are capped at 2,000 with a truncation notice.

> **Correction (2026-07-08):** #2346 / PR #2353 added an **Open in Sessions →**
> control for the selected Timeline session, with a copy fallback when
> navigation is unavailable. Open-session absence/unused-prop claims in this
> dated audit are superseded. This correction does not reassess the audit's
> other point-in-time Timeline findings.

Gaps:

- No filters, zoom/pan, phase view, row detail, or open-session action.
- `onOpenSession` is documented in props but not used by the component
  signature.
- Hard truncation has no Load more/export path.

Severity: **High**.

### Timeline Evidence Overlay

Current state: The former standalone graph direction has been reviewed for a
Timeline overlay: row highlights, selected causal chains, and selected evidence
detail should live in Timeline rather than as a duplicate graph-first route.

Gaps:

- Implementation must reuse the parsed Timeline, token, and value-flow models
  rather than synthetic prototype data.
- Dense sessions need selected-chain or summary behavior, not an always-on
  graph hairball.
- Sparse and zero-flow sessions should remain valid Timeline states with quiet
  or empty evidence overlay behavior.

Severity: **High**.

### Activity

Current state: Calendar, clock, weekday heatmap, active projects, and embedded
Usage Stats exist.

> **Correction (2026-07-08):** #1623 wired ProjectActivity's aggregate
> day/project drilldowns. #2346 / PR #2353 then removed the unused
> `onOpenSession` prop; claims below that the view accepts that prop, or that
> calendar/project drilldowns are absent, are superseded.

Gaps:

- `onOpenSession` exists in the conceptual props but is not used.
- Calendar/hour/project cells are title-only and do not open filtered
  sessions/projects.
- This matches prior docs calling Activity an orientation/vanity risk unless
  demoted or wired.

Severity: **High** if kept as a top-level action page.

### Usage Stats

Current state: Embedded under Activity, not exposed as its own top-level view.
It renders stat cards, activity-over-time, project distribution, and hour
heatmap.

Gaps:

- Duplicates Activity/Projects/Summary concepts.
- Hover-only charts are acceptable only if treated as raw context.

Severity: **Low-Medium**.

### Usage Pulse

Current state: Server-only daily activity sparkline and week-over-week verdict
from stats cache/local rollup. It explicitly avoids pretending to be CLI
`/insights`.

Gaps:

- "Today" marker is based on the latest row and can be stale.
- Hotter/cooler colors can imply good/bad without an objective target.
- Notable sessions are text, not drill-ins.

Severity: **Low-Medium**.

## Global features

### Shell / navigation

Current state: PatternFly shell, curated default nav, advanced toggle, server-only
filtering in upload mode, Enterprise hidden for non-admin, and upload/reload
controls exist.

Gaps:

- The shell is mostly sound. The bigger nav problem is product-level: many raw or
  evidence pages remain peers to action pages.
- Several pages still need an explicit action/evidence/raw label and matching
  empty state.

Severity: **Medium** as IA debt, **Low** as shell implementation.

### SPA / server boundary

Current state: Server calls are centralized, SPA stubs reject/no-op server paths,
server-only nav is filtered, and CI greps the SPA bundle for forbidden server
strings.

Gaps:

- No material boundary gap found.
- Optional polish: explain copy-only behavior more clearly on write-capable
  surfaces in SPA.

Severity: **Low**.

### Reload / ingestion freshness

Current state: Reload calls the dataset endpoint through stale-while-revalidate.
Server dataset source signatures include live config files. Live Session handles
in-flight transcript freshness.

Gaps:

- Reload failures are swallowed, so the button can appear broken.
- No visible "last refreshed" or "fresh/stale" state.

Severity: **Medium-Low**.

### Global filters

Current state: Some views are wired into filtered-empty behavior and project/time
filtering.

Gaps:

- Artifact-heavy views such as tasks, teams, report-card inputs, stats cache,
  plans, model evals, diary, workflows, memories, and shadow calls are unevenly
  included.
- Pages should either honor filters or explicitly label themselves unfiltered.

Severity: **Medium**.

### Tables

Current state: Some mature pages have sortable columns; newer/reader pages vary.

Gaps:

- The global consistency issue is already tracked by `#1465`: choose a single
  table-sort pattern and apply it to all columns where sorting is meaningful.

Severity: **Medium**.

### Charts and data export

Current state: Several chart-heavy pages expose `data-signal-id` metadata,
especially Cost/Reclaim, File Impact, Tokens, and Usage Stats.

Gaps:

- Metadata is uneven. Summary inline SVGs and Activity calendar/clock/hour charts
  lack stable signal IDs/units.
- Many charts expose only hover/title values with no chart-level export or
  drilldown.

Severity: **Medium**.

## Data readiness notes

Where more local data would help:

- Runtime/native timing data for Speed Check latency and p90/p95 signals.
- External model-eval result artifacts for Model Evals.
- Shadow-call ledgers for Shadow Calls.
- Adoption/proof receipts for Adoption and future proof views.
- Task/team/workflow artifacts for Task Health, Team Coordination, and
  Workflows.
- Rich diary days with many projects/files to validate collapsed/full-width
  behavior.

Where more data is not the first fix:

- Agent Report Card nulls should first be checked as a join problem (`#1460`).
- Home/Recommendations/Ask Claude disagreement is an input parity problem.
- Activity, Summary, Timeline evidence overlay, and many chart issues are
  navigation/actionability problems.
- Policy Builder write visibility is a capability propagation problem.
- Enterprise readiness is a CI/docs governance problem.

## Recommended sequencing

1. Finish the already-filed visual and consistency issues under the current epic
   (`#1460` through `#1468`, plus `#1437`, `#1439`, `#1441`, `#1444`, `#1453`,
   `#1454`). These are concrete and unblock trust in current pages.
2. File one cross-cutting contract issue: every route must declare whether it is
   action, evidence, or raw/reference, plus data source, filter behavior, and
   empty/sparse/rich states.
3. File one high-priority action parity issue for Recommendations/Home/Ask
   Claude/API input alignment.
4. Then choose between two product directions for orientation pages:
   - wire Activity, Summary, Usage Stats, Project heatmaps, and chart buckets
     into filtered sessions/projects, or
   - demote them explicitly to raw/reference context and keep the main IA
     outcome-first.
5. After the contract exists, file focused implementation issues for Timeline,
   Timeline evidence overlay, Model Evals, Adoption/Proof, Policy Builder capability,
   Reload feedback, and global filters.
