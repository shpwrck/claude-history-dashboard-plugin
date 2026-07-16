# Page contracts

Per-route contract matrix for every view in the sidebar catalog
(`NAV_ITEMS` in `src/lib/nav-prefs.ts`). Part of epic #2345; this document is
issue #2350. The affordance rule the epic enforces: **every route declares one
contract class, and its affordances must match that class** — an action page
must actually carry its primary action, an evidence page must be verifiable
(drillable to receipts) and must honor the global filters or explicitly say it
does not, and a raw page is demoted orientation that owes no action.

## Contract classes

- **action** — the page's primary job is fixing or deciding. Copy / write /
  drill affordances are the point of the page, not decoration.
- **evidence** — a ledger / receipts / detail surface the user consults to
  verify a claim (typically a recommendation or digest finding). The #1615
  canonical-evidence matrix in `src/lib/nav-prefs.ts` routes duplicated
  signals to these pages.
- **raw** — orientation, replay, or reference; off the primary coaching path
  (the demoted `raw` sidebar drawer and browse-style utilities).

## Reading the matrix

- **Tier** (from `requires` in `NAV_ITEMS` + ADR 0014,
  `docs/adr/0014-tiered-delivery-model.md`): `all` = works on the
  always-available dataset in every build; `serverData` = needs a rich dataset
  (the sample corpus, a covering upload, or a server); `liveServer` = needs the
  live backend control plane and is excluded from public SPA builds entirely.
- **Filters** (from `renderView` in `src/lib/view-registry.tsx`): every view's
  `ViewData` is centrally narrowed by `filterViewDataByTime` then
  `filterViewDataByProject` before render, but only transcript-derived keys are
  actually filtered. Values used below:
  - `central` — the view's inputs are all centrally filtered keys.
  - `central+FES` — additionally listed in `VIEW_FILTERABLE_DATA`, so an
    active filter that empties the view renders `FilteredEmptyState` instead
    of a zeroed page.
  - `partial` — the view's *primary* artifact key bypasses one or both central
    filters (named per view). `workflows` is project-filtered but not
    time-filtered; `tasks`, `teams`, `memories`, `plans`, `statsCache`,
    `shadowCalls`, `modelEvalSummary`, `liveConfig`, `configBackups` are
    filtered by neither.
  - `unfiltered` — the view ignores the global filters entirely (self-fetching
    or no filterable inputs).
- **Data sources** cite the `ViewData` fields the registry renderer passes and
  the owner parser per `REFERENCES.md`.

---

## Overview (home)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `home` (Overview) | action | all | partial (server artifacts in the engine envelope unfiltered) | drill from digest card to domain landing / evidence |
| `recommendations` (Recommendations) | action | all | partial+FES (server artifacts in the engine envelope unfiltered) | copy fix snippet / drill to evidence view |
| `local-analyze` (Analyze locally) | action | liveServer | project only (sent explicitly; time ignored) | run local-model analysis |
| `adoption` (Adoption) | evidence | serverData | unfiltered | none |
| `provisioning` (Provision) | action | liveServer | unfiltered | provision a remote session (write) |
| `diary` (Diary) | raw | liveServer | unfiltered | none |

**home** — Ranked, safety-first digest of the highest-priority findings across
all six action domains. Data: the full recommendation-engine envelope via
`recommendationViewsFromViewData` (`src/lib/recommendation-view-data.ts`),
i.e. every ingest-time dataset key in `REFERENCES.md`; #2352 pins this to the
same envelope as Recommendations so the two cannot drift. Filter caveat: the
central pipeline narrows session-keyed keys only — envelope artifacts such as
`tasks`, `teams`, `plans`, `shadowCalls`, `modelEvalSummary`, `statsCache`,
and `configBackups` reach the detectors unfiltered, so findings can cite
out-of-filter evidence while a time/project filter is active. Empty state:
`DigestSpine.tsx` renders coverage-aware per-domain empty cards and a "No
findings right now — your history looks clean" verdict. Scope declaration: the
page explainer says server-side engine artifacts are computed over all data
while the global time/project filters scope the rest of the page (#2492).
Resolved in #2366: action-class digest cards preserve canonical evidence
filters when opening a target view, so e.g. safety findings land on the
matching Permissions evidence table instead of the broad landing page. Domain
empty cards remain broad by design because they carry no finding-specific
evidence.

**recommendations** — Prioritized fixes and habits from all detector
categories. Data: same canonical engine envelope as `home`, plus
`liveConfig` (assembled by `scripts/ingest.mjs`); the same envelope-artifact
filter caveat as `home` applies. Empty state: inline
`EmptyState` cards in `Recommendations.tsx`; filtered-empty aware. Primary
action is real: copy-paste fix snippets (`validated` per
`src/lib/detectors/fix-validity.ts`) and drill-through to evidence views. Scope
declaration: the page explainer says server-side engine artifacts are computed
over all data while the global time/project filters scope the rest of the page
(#2492).

**local-analyze** — User-initiated, seconds-latency analysis of the current
recommendation set by a model running on the same machine. Data: none from
`ViewData`; the registry passes the selected global project (or `null` for All
projects) to `LocalAnalyzePf`, which posts through `src/lib/api-client.ts` to
`/api/analyze/local`. The global time filter does not apply. The server route is
loopback-only and falls back to the deterministic engine result when no local
model endpoint is configured or reachable (ADR 0018). The primary action is the
explicit Analyze button; the page never runs automatically.

**adoption** — Tracks surfaced recommendations through marker-confirmed
config adoption (ADR 0005 receipts). Data: `liveConfig`,
`sampleAdoptionReceipts` (`src/lib/adoption-receipts.ts`); on the live server
it self-fetches the dashboard-owned receipt store, so global filters do not
apply. Empty state: inline `EmptyState` distinguishing "no receipts yet" from
"needs the live server build" (`AdoptionScorecard.tsx`). Primary action: none
— it is a read-only scorecard, consistent with evidence class. Scope
declaration: the page explainer says it ignores global time/project filters
(#2367).

**provisioning** — Launch and manage remote agent sessions on a cluster.
Data: none from `ViewData`; talks to server APIs only. Empty states:
"Session provisioning needs the live server" and "No sessions yet"
(`SessionProvisioning.tsx`). Scope declaration: the page explainer says it
ignores global time/project filters (#2367).

**diary** — Daily digest replay of what happened on a chosen day. Data: none
from `ViewData`; fetches `/api/digest` per date with no client-side fallback
(hence `liveServer`, see the nav comment in `nav-prefs.ts`). Empty states:
needs-server card, per-day `EmptyDay` card, and error card (`DiaryView.tsx`).
Primary action: none (date picker only) — acceptable for raw, though digest
rows carry session IDs that are not linked (audit note, #1466 adjacent). Scope
declaration: the page explainer says to use the date picker because global
time/project filters do not narrow this view (#2367).

## Stay safe (safety)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `permissions` (Permissions) | action | all | partial (`liveConfig`, `configBackups` unfiltered) | copy diff / capability-gated write-back |
| `enterprise` (Enterprise) | evidence | liveServer | unfiltered | receipt / audit export (read-only; no write UI today) |

**permissions** — Track permission modes, dangerous commands, prompt-prone
tools, and policy candidates; the Policy Builder computes allowlist diffs and
can write them through validated server endpoints. Data: `toolData`
(`src/lib/parse-tools.ts`), `permissionRows` + `permissionChanges`
(`src/lib/parse-permissions.ts`), `tokenData` (`src/lib/parse-sessions.ts`),
`sessions` (`src/lib/parse-history.ts`), `liveConfig` (`scripts/ingest.mjs`),
`configBackups` (`src/lib/parse-backups.ts`). Filter caveat: the Policy
Builder reads the current global `liveConfig` policy and the drift card sorts
`configBackups`, neither narrowed by time/project. Empty state:
full-page inline card "No session data loaded yet" (`Permissions.tsx`). Scope
declaration: a note beside the Policy Builder / Policy Drift pair says the
builder reads the current live config and the drift table reads config backups,
neither narrowed by the global time/project filters (#2492).
RESOLVED #2476: the write affordance now requires the enterprise
`canWritePolicy` capability. Roles without it retain the copy action and see an
explicit explanation; auth-session probe errors fail closed, while a positively
resolved local/no-auth server session keeps the write path unchanged.

**enterprise** — Review enterprise access and export readiness receipts /
audit logs in shared multi-user mode. Classed evidence: the page's
affordances are downloads, refresh, and pagination — it has no write path
today, so an action class would enforce an affordance that does not exist
(re-class when a write UI ships). Data: `enterpriseSession` (`@api-client`);
the component is replaced by a null stub in `spa`/`sample` builds
(`view-registry.tsx`). Empty state: "Server build required."
(`EnterpriseAdmin.tsx`).

## Cut cost (cost)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `summary` (Summary) | evidence | all | central+FES | none |
| `cost` (Cost) | action | all | central+FES | open expensive session / drill to tokens |
| `reclaim-compass` (Reclaim Compass) | action | all | central+FES | none (levers lack apply/copy) |
| `tokens` (Tokens) | evidence | all | partial+FES (`liveConfig` unfiltered) | open session from cost/compaction tables |
| `files` (File Impact) | evidence | all | central | copy `@path` for load-once candidates |
| `model-evals` (Model Evals) | evidence | serverData | partial (`modelEvalSummary` unfiltered) | copy validated per-cluster replay specs |

**summary** — Token-spend slices by project / day / model / session type.
Data: `tokenData`, `sessions`. Empty state: inline `EmptyState`
(`SummaryView.tsx`); filtered-empty aware.
Project rows open scoped Sessions (pre-existing, #1624). Re-classed in #2366:
day bars open Tokens filtered to that date, and model-family rows open Tokens
filtered to that model family (via the entry-level `family` route key, #2418, so
Summary's per-entry bucketing and the tokens-side filter reconcile). Token-type
and inferred session-type distributions remain aggregate evidence because no
destination view currently consumes those route filters with matching semantics.

**cost** — Cost attribution with proportional per-tool split and cost-flow
Sankey. Data: `tokenData`, `toolData`, `sessions` (renderer
`renderCostAttributionView`). Empty state: inline `EmptyState` cards
(`CostAttribution.tsx`); filtered-empty aware. Borderline call: classed
action (it is the "Cut cost" domain landing with session drill-ins), but the
Sankey nodes are hover-only, not drilldowns (audit; #1441 tracks Cost/Reclaim
dedupe).

**reclaim-compass** — Reclaim trend gauge and levers; renders the same
`CostAttribution` component anchored to the `reclaim-compass` signal
(`VIEW_ANCHORS` in `view-registry.tsx`). Data/empty as `cost`.
Resolved in #2366: lever rows now expose a copy action for the stable lever id
and a handoff to the Recommendations evidence surface. There is still no direct
apply action because the reclaim levers are detector claims, not writeable
configuration patches.

**tokens** — Token volume, cache behavior, model mix, estimated spend.
Canonical evidence destination for `token-usage` signals (#1615 matrix).
Data: `tokenData`, `sessions`, `liveConfig`. Filter caveat: the Context
Composition card tokenizes the CURRENT `liveConfig` (global + every
per-project CLAUDE.md/resource/settings entry), which the central filters
never narrow — under a project or historical time filter its prefix estimate
can include out-of-scope config. Empty state: inline
`EmptyState` (`TokenUsage.tsx`); filtered-empty aware. Scope declaration: the
reconstructed-prefix note in `ContextComposition.tsx` says the prefix is
tokenized from the current live config, not narrowed by the global time/project
filters (#2492). Known truthfulness
gaps tracked in the audit (top-20 pre-slice, call-count model donut, #1439).

**files** — Which files/directories dominate reads, edits, writes, re-reads.
Canonical evidence destination for `file-impact`. Data: `toolData`,
`tokenData`, `sessions` (derived client-side via `src/lib/parse-files.ts` /
`parse-file-reread.ts`). Empty state: inline card "No file operations found"
(`FileImpact.tsx`).

**model-evals** — Routing-eval evidence workbench: ranked runs, mined
clusters, scoped routing recommendations. Data: `modelEvalSummary`
(`src/lib/model-eval-ingest.ts`, reading `~/.claude/model-evals/results/`;
null on SPA data and not touched by global filters), plus filtered
`tokenData`, `timelines`, `toolData`, `apiErrors` for the mined face. Empty
state: honest inline `EmptyState`s — no results until an external meta-runner
drops artifacts (`ModelEvalsPf.tsx`). Scope declaration: the page explainer
says model-eval files ignore global time/project filters (#2367).
RESOLVED #2478: mined candidates now pass through the deterministic exclusion
classifiers and render their kept/filtered disposition, reason, and available
source coverage; only kept candidates enter clusters and the validated
per-cluster replay specs. Current-pass counts and persisted result-artifact
counts are shown as independent populations rather than falsely joined by run
id. The specs remain preview-only, but their exact deterministic JSON array can
be copied for the external eval meta-runner.

## Fail less (success-rate)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `errors` (Errors) | evidence | all | central | open offending session |
| `report-card` (Report Card) | action | serverData | central | open contributing session from a verdict |
| `review-queue` (Review Queue) | action | serverData | central | open queued session for review |

**errors** — Which tools, commands, and sessions generate the most errors and
retries. Canonical evidence destination for `error-retry`. Data: `toolData`,
`apiErrors` (`src/lib/parse-errors.ts`), `sessions`. Empty state: full-page
inline `EmptyState` with upload instructions (`ErrorRetry.tsx`). Semantics
caveat from the audit: "Retry Groups" is same-tool adjacency within 60s, not
proven same-operation retries.

**report-card** — Grades unattended-run reliability into KEEP/FLAG/MOVE
guidance (#572). Data: `sessions`, `tokenData`, `sessionRegistry`
(`src/lib/parse-session-registry.ts`), `telemetry`
(`src/lib/parse-telemetry.ts`), `debugLogs` (`src/lib/parse-debug.ts`) — all
centrally filtered keys. Empty state: inline `EmptyState`
(`AgentReportCardPf.tsx`). Borderline call: classed action because its output
is a decision (keep/flag/move), not a ledger.
RESOLVED (#2477): each per-project verdict now expands to its contributing
sessions, each drilling to the Sessions view via the canonical `openSession`
handoff (contributing rows come from `report-card.ts`'s existing sessionId join,
consumed via `ReportCardProject.contributingSessions`, not a re-implemented
join). Sessions outside the loaded/filtered dataset degrade to a plain,
non-clickable id (no dead link). The prior null-heavy registry-ID join half was
addressed in #1460 (transcript-context recovery + "not measured" rendering), so
the action-class decision surface is now verifiable end to end.

**review-queue** — Deterministic triage queue ranking the sessions most worth
review. Data: `sessions`, `tokenData`, `toolData`, `timelines`, `apiErrors`,
`debugLogs`, `telemetry`. Empty states: `EmptyDataView` "Session Review
Queue" when the server artifacts are unavailable in this build, inline
`EmptyState` "No sessions currently cross the review thresholds" otherwise
(`ReviewQueuePf.tsx`). Renders the full queue (no windowing, #1461); evidence
links land on aggregate views rather than exact instances.

## Go faster (speed)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `evaluator` (Speed Check) | evidence | all | central | drill to Cost / Timeline / Errors / File Impact |

**evaluator** — Per-task cost, tool-call latency, retry-storm rate,
reread-loop fraction. Data: `runtimeEvents`
(`src/lib/parse-runtime-events.ts`), `tokenData`, `toolData`, `apiErrors`.
Empty state: inline `EmptyState` plus `CoverageState` sparse-signal banners
(`EvaluatorLanding.tsx`). Honest about provenance; speed is the sparsest
domain by design (ADR 0006). Routes to broad pages rather than slowest
sessions — noted, not flagged, given the data-readiness caveat.

## Tame context (context-health)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `context` (Context Health) | evidence | all | central | open session from health/risk tables |
| `conversation` (Turn Patterns) | evidence | all | central | open session from pattern tables |

**context** — Context-window consumption, cache efficiency, growth pressure,
compaction risk, per-session health scores. Data: `tokenData`, `toolData`,
`sessions` (scored client-side by `src/lib/context-health.ts` /
`parse-compaction-risk.ts`). Empty state: `EmptyDataView`
(`ContextHealth.tsx`). Borderline call: could be action (it coaches fixes),
but its panels are consult-and-verify ledgers with `SessionIdLink` handoffs,
so evidence.

**conversation** — Turn-by-turn flow: message lengths, back-and-forth rhythm,
tool cadence. Data: `timelines` (`src/lib/parse-timeline.ts`), `sessions`
(aggregated by `src/lib/conversation-patterns.ts`). Empty state: inline small
`EmptyState` (`ConversationPatterns.tsx`). One of the most complete table
surfaces per the audit.

## Clean workflow (workflow-hygiene)

Consolidated from 11 flat peers to 4 destinations (#2351): two composite tab
views (`capabilities`, `automation`, rendered through
`CompositeTabsView.tsx`) plus two standalone views. The absorbed ids
(`tools`, `agents`, `prompts`, `memories`, `tasks`, `teams`, `plans`,
`workflows`) stay valid routes — `REDIRECTED_VIEWS` +
`REDIRECTED_VIEW_TAB` (`src/lib/nav-prefs.ts`) resolve an old hash or
programmatic navigation to the composite with the right `tab` route-filter.
Each tab's content is the former standalone view unchanged (its own
PageHeader stands as the page title; the composite renders only the tab
strip), so each tab's class/data/mismatch notes below carry over verbatim.
Per-tab gating mirrors the absorbed views' former `requires`: `tasks`,
`teams`, and `plans` are serverData tabs (hidden on the upload tier unless
the upload covers their artifact).

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `capabilities` (Capabilities) | evidence | all (per-tab gating: none) | per tab (see tab notes) | per tab |
| `automation` (Automation) | evidence | all (tasks/teams/plans tabs: serverData) | per tab (see tab notes) | per tab |
| `shadow-calls` (Shadow Calls) | evidence | serverData | partial (`shadowCalls` unfiltered) | none |
| `patterns` (Session Patterns) | evidence | all | central+FES | open session from cluster tables |

**capabilities** — Composite: what the agent works with. Tabs: Tools
(`tools`), Agents & Skills (`agents`), Prompts (`prompts`), Memories
(`memories`). All four tabs are available on every tier. The active tab is
addressable as `#/capabilities?tab=<id>`; the absorbed deep links
(`#/tools`, …) redirect there.

**automation** — Composite: unattended and orchestrated work. Tabs: Runs
(the former standalone `automation` content), Tasks (`tasks`), Teams
(`teams`), Plans (`plans`), Workflows (`workflows`). Tasks/Teams/Plans are
serverData-gated tabs; Runs and Workflows show everywhere. Addressable as
`#/automation?tab=<id>`; the absorbed deep links (`#/tasks`, …) redirect
there.

**tools (Capabilities tab)** — Call volumes, catalog use, repeated commands, discovery failures,
effectiveness. Canonical evidence destination for `tool-usage`. Data:
`toolData`, `apiErrors`, `timelines`, `toolInventories`
(`src/lib/parse-tool-inventory.ts`), `sessions`, `liveConfig`. Filter caveat:
the discovery-failure panel checks filtered command rows against the CURRENT
installed-skill catalog (`liveConfig.skills`), so under a historical filter
old commands are judged against skills that may not have existed then. Empty
state: `EmptyDataView` (`ToolUsage.tsx`). Scope declaration: the Discovery
Failures panel note says the installed-skill catalog is the current config, not
narrowed by the global time/project filters (#2492). Bypass/repeated/discovery
rows often lack exact session/command evidence links (audit; #1465 table
consistency).

**agents (Capabilities tab)** — Subagent, skill, and MCP invocation volume and effectiveness.
Canonical evidence destination for `agent-usage`. Data: `toolData`,
`agentSettings` + `attribution` (`src/lib/parse-agents.ts`), `runtimeEvents`,
`tokenData`, `sessions`. Empty state: per-card inline `EmptyState`s plus
`CoverageState` (`AgentSkill.tsx`). Audit notes it carries several concepts
under one label and can mix native attribution with fallback totals.

**runs (Automation tab; the former standalone `automation` page)** — Unattended `sdk-*` runs: cost share, search/sort, expandable
sessions. Canonical evidence destination for `automation-runs`. Data:
`sessions`, `tokenData`, `toolData`, `timelines`, `apiErrors` (classification
via `isUnattendedEntrypoint` in `src/lib/parse-sessions.ts`). Empty state:
inline `EmptyState`s (`AutomationView.tsx`); filtered-empty aware.
RESOLVED #2367: page copy now says SDK/CLI-launched runs, matching the
`sdk-*` classifier. The accepted-but-unused `toolData`/`apiErrors` props are
left as implementation cleanup, not duplicated into this copy fix.

**workflows (Automation tab)** — Completed Workflow-tool runs: phase tree, Gantt, parent
session link. Data: `workflows` (`src/lib/parse-workflows.ts`, from
`workflows/wf_*.json` manifests). Tier note: `NAV_ITEMS` sets no `requires`
because the SPA/upload build can construct the same shape client-side, but in
practice the data is server-fed; the component itself shows a needs-server
empty state when `!serverAvailable` and no data (`WorkflowList.tsx`), plus
"No workflow runs found" otherwise. Filters: target state is fully filtered —
`#2261`/`#2426` add `workflows` to `VIEW_DATA_FILTER_POLICIES` so both the
global time window and the project filter narrow this view, and the nav
description states that target ("the global time and project filters apply").
Transitional caveat: until #2426 merges, `workflows` is still project-filtered
only and NOT time-filtered (`filterViewDataByTime` skips the `workflows`
key) — the data-filter leak tracked by #2261. If this doc/nav copy merges
ahead of #2426, read the time-filter claim as the committed target, not
present behavior.

**prompts (Capabilities tab)** — Local-only numeric prompt traits and coaching correlation (no
prose retained). Data: `promptAnalysis` (`src/lib/parse-prompt-analysis.ts`),
`timelines`, `apiErrors`. Empty state: large inline `EmptyState`
(`PromptAnalyzer.tsx`); filtered-empty aware.
MISMATCH: evidence-class aggregates with no drill to the contributing
sessions, so the low-specificity / follow-up claims cannot be verified from
the page (audit, "Prompt Analyzer").

**shadow-calls** — Shadow A/B experiment ledger (epic #513). Data:
`shadowCalls` (`src/lib/parse-shadow-calls.ts`, from
`~/.claude/shadow-calls/ledger.jsonl`; unfiltered key). Empty state: inline
`EmptyState` distinguishing "no ledger data" from "server-only"
(`ShadowCallsPf.tsx`). Reader-only; no run controls (audit) — acceptable for
evidence. Scope declaration: the page explainer says it ignores global
time/project filters (#2367).

**patterns** — Timeline-shape clusters and habit impact
(association-not-causation). Data: `timelines`, `tokenData`, `toolData`,
`runtimeEvents`, `apiErrors`, `sessions` (clustered by
`src/lib/parse-timeline-success.ts`). Empty state: large inline `EmptyState`
(`SessionPatterns.tsx`); filtered-empty aware.
RESOLVED #2367: the page now describes ranking as a radar/composite proxy, and
the cluster sections are labelled top-ranked and bottom-ranked shape proxies
instead of "Successful patterns" / "Anti-patterns".

**memories (Capabilities tab)** — Browse the memory files Claude has saved per project. Data:
`memories` (`src/lib/parse-memories.ts`, from `GET /api/memories` or uploaded
`memory/*.md`; unfiltered key). Empty state: inline `EmptyState`s including a
data-aware needs-server placeholder (`Memories.tsx`).
RESOLVED #2367: the nav description now calls the browser read-only, and the
component header no longer says it is server-only. Scope declaration: the nav
description says the project filter applies but the global time window does
not. Target state per `#2261`/`#2426`: `VIEW_DATA_FILTER_POLICIES` scopes
`memories` to the project filter while leaving the time window global.
Transitional caveat: until #2426 (and its memories-filter follow-up) merges,
`memories` still bypasses both central filters, so read the project-filter
claim as the committed target, not present behavior.

**tasks (Automation tab)** — Task completion rates, abandoned sessions, blocked pileups.
Data: `tasks` (`src/lib/parse-tasks.ts`, from `~/.claude/tasks/`; unfiltered
key), `sessions` (filtered). Empty state: inline `EmptyState`s
(`TaskHealthPf.tsx`). Main table links sessions; detail panels do not
(audit). Scope declaration: the page explainer says task artifacts ignore
global time/project filters (#2367).

**teams (Automation tab)** — Multi-agent handoffs, dropped assignments, stalled members.
Data: `teams` (`src/lib/parse-teams.ts`, from `~/.claude/teams/*/inboxes/`;
unfiltered key). Empty state: inline `EmptyState`s (`TeamCoordinationPf.tsx`).
RESOLVED (#2479): dropped-assignment rows conservatively join to canonical
task/session/PR context only on exact task ID + subject, using assignment
agent/task owner solely to break a tie. Ambiguous, missing, and malformed
matches remain plain with an explicit reason. A matched session drills through
only when it is in the currently loaded/filtered `sessions`; otherwise its real
ID remains plain with a filter explanation. Each row can copy only its exact
real team/agent/task/session/PR identifiers, and the Weekly Digest next step
offers the same exact-only payload aggregated across affected rows—never a
generated redispatch command. Historical all-unread UUID runs remain
review-before-redispatch items.
Scope declaration: the page explainer says team artifacts ignore global
time/project filters (#2367).

**plans (Automation tab)** — Structural plan-shape clustering (no prose retained), verdict
banner, scatter, shape cards. Data: `plans` (`src/lib/parse-plans.ts`, from
`~/.claude/plans/*.md`; unfiltered key). Empty state: large inline
`EmptyState` "No saved plans found" / needs-server (`PlanShapesPf.tsx`).
Under three plans everything is shape A — can overstate cluster meaning
(audit). Scope declaration: the page explainer says plan artifacts ignore
global time/project filters (#2367).

## Find (discovery)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `search` (Search) | evidence | all | central | open matching session |
| `sessions` (Sessions) | evidence | all | central | open session detail / transcript |
| `projects` (Projects) | raw | all | central | open session from project row |

**search** — Keyword search across loaded prompt/history entries. Data:
`entries` (`src/lib/parse-history.ts`). Empty state: no dedicated empty
component — the result count line reads "0 results" (`SearchView.tsx`).
Borderline call: classed evidence (it is how a user verifies "did I say/do
X"), though it behaves like a reference utility; capped at first 100 results
with no load-more/export.

**sessions** — Browse loaded sessions with projects, timestamps, message
counts, token totals; the canonical `openSession` drill destination for
every other view. Data: `sessions`, `tokenData`, `toolData`, `timelines`,
`runtimeEvents`, `apiErrors`, `permissionRows`, `sources`. Empty state:
inline "No sessions match" text on search; no full-page empty guard
(`SessionList.tsx`). Detail-panel gaps (only the Errors tile clickable,
session ID not copyable) are audit notes, not class mismatches.

**projects** — Activity broken down by project. Data: `projects` (derived by
`groupByProjects` in `src/lib/parse-history.ts`). Empty state: none — an
empty dataset renders an empty list (`ProjectBreakdown.tsx`). Borderline
call: classed raw because the audit finds it mostly orientation duplicating
Summary/Activity; its clickable sessions keep it useful as a browse index.

## Raw data (raw)

| View | Class | Tier | Filters | Primary action |
| --- | --- | --- | --- | --- |
| `timeline` (Timeline) | raw | all | central | exact-row Sessions drill |
| `activity` (Activity) | raw | all | central+FES | none |
| `pulse` (Pulse) | raw | serverData | partial (`statsCache` unfiltered) | none |

**timeline** — Replay sessions on a time axis; since #1509 also hosts the
evidence overlay that replaced the standalone forensics graph (`#/forensics`
redirects here via `REDIRECTED_VIEWS`). Data: `timelines`, `sessions`,
`tokenData`, `valueFlow` (`src/lib/parse-value-flow.ts`). Empty state: inline
`EmptyState` (`SessionTimeline.tsx`). Visible entries hard-capped at 2,000
with no load-more.
RESOLVED (#2480): Timeline remains raw because its primary job is replay and
orientation, while its secondary evidence-overlay role is now verifiable. Each
entry exposes an exact-row "Entry N in Sessions" drill through `openEvidence`;
when only `openSession` is available it honestly falls back to the selected
session, and with neither callback the row action is omitted. The header-level
"Open in Sessions" control remains the session-wide handoff (#2346).

**activity** — When and where you work: calendar, clock, weekday heatmap,
plus the merged Usage Stats panels (#14; `#/stats` redirects here). Data:
`sessions`, `projects`, `entries`. Empty state: inline card "No session data
loaded yet" (`ProjectActivity.tsx`); filtered-empty aware. Cells are
title-only with no drill — consistent with raw, per the audit's "demote or
wire" decision this catalog resolves by demotion.

**pulse** — Week-over-week activity trend straight from `stats-cache.json`,
no re-aggregation. Data: `statsCache` (`src/lib/parse-stats-cache.ts`;
unfiltered key), plus filtered `sessions`/`tokenData`/`toolData` for the
local rollup. Empty state: inline `EmptyState` with a reason string under
the rollup card (`UsagePulsePf.tsx`). "Today" marker can be stale; notable
sessions are text, not drill-ins (audit) — acceptable for raw. Scope
declaration: the page explainer says stats-cache panels ignore global
time/project filters (#2367).

---

## Mismatches to file

Each line is a follow-up-issue candidate (epic #2345). File paths above give
the receipts.

1. `home` — resolved in #2366; finding cards now preserve canonical scoped
   evidence filters.
2. `permissions` — resolved in #2476; enterprise policy writes require
   `canWritePolicy`, denied or indeterminate sessions retain a copy-only path
   with an explanation, and valid local/no-auth mode remains permissive.
3. `reclaim-compass` — resolved in #2366; lever rows copy their id and hand off
   to recommendation evidence, with no direct apply action because reclaim
   claims are not writeable patches.
4. `summary` — resolved/re-classed in #2366; the project drill is pre-existing
   (#1624), while date/model surfaces drill to supported scoped evidence (the
   model drill via the entry-level `family` key, #2418). Token-type/session-type
   aggregates remain read-only until destinations own matching filters.
5. `report-card` — resolved in #2477: each KEEP/FLAG/MOVE verdict expands to
   its contributing sessions with the canonical `openSession` drill (consuming
   the existing `report-card.ts` sessionId join via
   `ReportCardProject.contributingSessions`), degrading to a plain id with no
   dead link for sessions outside the loaded/filtered dataset. The earlier
   null-heavy registry-ID join half was addressed in #1460.
6. `model-evals` — resolved in #2478; every mined candidate renders its real
   kept/filtered exclusion disposition and classifier coverage, only survivors
   enter clusters and validated per-cluster replay specs, and the deterministic
   JSON array has a copy handoff (execution remains external). Persisted and
   current-pass counts are explicitly separate populations.
7. `prompts` — resolved in #2366: adds a contributing-sessions table with
   session drill-ins. Trait rows stay aggregate-only until the Sessions route
   owns prompt-trait filters.
8. `teams` — evidence-class rows do not join to canonical task/session/PR
    context; "next step" is prose, not a redispatch/copy action.
9. `timeline` — resolved in #2480: the raw-class replay page keeps its secondary
   evidence-overlay role, and every visible row now drills to its exact Sessions
   evidence reference (with an honest session-only fallback when exact evidence
   navigation is unavailable).
10. `partial`-labelled on-page-declaration follow-up — resolved in #2492. The
    five `partial`-labelled rows now carry an on-page scope declaration naming
    exactly the slice that bypasses the global filters: `home` /
    `recommendations` add a header sentence via the nav-prefs `description`
    ("server-side engine artifacts are computed over all data; the global
    time/project filters scope the rest of the page"); `permissions` (Policy
    Builder live config + Policy Drift config backups), `tokens` (Context
    Composition's current `liveConfig`), and `tools` (Discovery Failures'
    `liveConfig.skills`) each carry a note adjacent to the affected panel rather
    than a header sentence that would overclaim on an otherwise-filtered page.
