# Actionability Synthesis: Action-Domain Map & Navigation Redesign Seeds

Source: per-view analysis of 22 views / 555 data points. The current flat nav (from `src/types.ts:179`) is: `evaluator · insights · recommendations · sessions · projects · search · stats · tokens · tools · files · cost · timeline · activity · automation · errors · permissions · agents · context · conversation · patterns` (plus `BudgetGauge`/Plan Usage card, which is not a routed `View` but a Recommendations-embedded widget).

---

## A. Action-domain map

Each domain below lists the views that feed it, the load-bearing data points, and a wired-vs-dead health read. "Wired" = has a real onClick/onChange/copy affordance that closes a loop; "dead" = informational dead-end or false affordance.

### cost — spend, token volume, dollar attribution, expensive sessions/tools/projects
**Views:** Cost Attribution, tokens (TokenUsage), BudgetGauge, Recommendations (cheaper-model routing, recoverable spend, weekly delta cost tile), AutomationView (cost share), patterns (avg cost), Context Health (context-read cost), Evaluator (per-task cost), Session/Automation overview cost tiles, AgentSkill (mean $/run, output-token cost).
**Core data points:** Top 20 Sessions cost column (wired, sort + drill-in); Cost-by-Project rows (dead); Cost-by-Tool bars (dead); Opus→Sonnet / Opus→Haiku swap-ceiling rows (dead — savings computed, no apply path); cheaper-model footer snippet (dead, no CopyButton); Most Expensive Tool/Project KPI tiles (dead); Weekly delta cost tile (wired); BudgetGauge overage/pace projection (dead); Recoverable Spend KPI (dead); AgentSkill Mean $/run column (wired, sortable).
**Health: MODERATE-LOW.** The one strong cost workflow (Top-20 Sessions cost sort → onOpenSession) is wired everywhere it appears. But the highest-intent cost moments — the swap-ceiling "you could save $X" rows, the cheaper-model snippet, per-project/per-tool cost cells, and every overage/projection warning — are dead-ends. Cost is the domain with the widest gap between "we computed the saving" and "here's how to act on it."

### speed — latency, throughput, time-to-complete, slow hooks
**Views:** Evaluator (p50/p95 tool-call latency), AgentSkill (Runtime Telemetry: median/p95/max turn latency, hook overhead, idle turns; Effectiveness median-time), ConversationPatterns (latency histogram, velocity), ErrorRetry (retry pressure / backoff), insights (response-time distribution), Session Timeline (row time-deltas).
**Core data points:** Evaluator p50/p95 latency (dead — no nav, no onOpenSession); AgentSkill hook-overhead tiles (dead, no threshold/link); ConversationPatterns velocity cell (FALSE AFFORDANCE — brand-blue, no onClick); latency histogram bars (dead); Retry Pressure KPI (dead, "most actionable KPI" in errors view); Timeline time-delta (dead).
**Health: POOR.** Almost entirely dead. Speed has no first-class home — it is scattered across Evaluator (which lacks `onNavigate`/`onOpenSession` entirely), AgentSkill telemetry tiles, and a misleading false-affordance velocity cell. No speed datum reliably drills to the slow session.

### success-rate — errors, retries, API failures, task completion, reliability
**Views:** errors (ErrorRetry), tools (Tool Effectiveness/Breakdown), AgentSkill (Failures column, Continuations blocked), patterns (tool error rate, error-spike badge), insights (friction categories, tool-errors chart), Session/Automation overview Errors tile, Recommendations (API errors / retry-storm weekly tiles).
**Core data points:** ErrorRetry session-link columns (wired, drill-in); Tool Effectiveness Score/Error/Retry/Undo columns (wired, sortable + color); "review" badge (dead, no action); API Error Status Codes Code column (dead — no per-code guidance, "leaves user to Google each one"); Summary/Command truncated cells (FALSE AFFORDANCE — ellipsis, no expand); AgentSkill Failures column (wired sort, no row drill-in); Errors metric tile in session overview (dead despite warn-color); friction categories in insights (dead — "highest-value dead-end").
**Health: MODERATE.** The errors view's session links and the tool-effectiveness sort/color are genuinely wired — this is the best-instrumented reliability surface. But the diagnostic *text* (truncated summaries, status-code meaning, error tiles in session overviews) consistently dead-ends, and the cross-view friction→recommendation handoff is missing.

### safety — permissions, bypass mode, dangerous operations, policy
**Views:** Permissions (+ PolicyBuilder), AgentSkill (Continuations blocked), Recommendations (Unattended badge), Session Timeline (entrypoint/service-tier badges).
**Core data points:** PolicyBuilder radios / Copy diff / Write-to-settings / confirm dialog (ALL wired — the strongest action loop in the app); Dangerous Commands session link (wired); Pattern badge + Entrypoint badge (FALSE AFFORDANCE — styled, no onClick); Command cell (dead — double-truncated, unreadable); Bypass-mode / Distinct-Modes KPI tiles (dead); To-column bypassPermissions highlight (dead); AgentSkill "Continuations blocked" tile (dead, "highest-signal tile in section"); Top Action Hero Unattended badge (dead).
**Health: MIXED-GOOD at the core, POOR at the edges.** PolicyBuilder is the model action loop the whole dashboard should emulate (read → choose → preview → write → verify). But everything *leading into* it dead-ends: the dangerous-command evidence is literally unreadable (double truncation), the pattern/entrypoint badges look clickable but aren't, and the safety KPI tiles are pure counts.

### context-health — compaction, cache hit rate, context-window pressure
**Views:** Context Health, tokens (cache tiles, compaction events), files (FileImpact — re-read waste), patterns (compacted %, compaction habit-factor), Evaluator (reread-loop), Session/Automation overview (Compactions, Peak context tiles), Recommendations (Compaction Risk Card), ConversationPatterns (avg len).
**Core data points:** Context Health session-ID cells + Worst Cache-Hit chart bars (wired, onOpenSession); Reason badges in Health Scores table (dead — "densest actionable signal, pure dead-ends"); Top Suggestion cell with ready-to-paste `/compact`,`/clear` (dead — "highest-value data point in the view, not copyable"); false-affordance accented cells (Reduction %, Score, Risk badge — styled important, no onClick); Compaction Events session column in tokens (dead despite being "highest-signal prompt-hygiene finding"); FileImpact Compactions cell + @path file paths (dead, no copy); Cache Hit Rate KPI (dead, "most actionable KPI on tokens view"); session-overview Compactions/Peak tiles (dead despite warn-color).
**Health: MODERATE.** The session-ID drill-ins are wired, but the *prescriptive* content — copyable slash-command suggestions, `@path` CLAUDE.md pins, reason badges — is almost universally dead. This domain has the most "we told you exactly what to paste but gave you no copy button" instances.

### workflow-hygiene — unused/ineffective skills/agents/MCP/plugins, tool effectiveness, config validity, CLAUDE.md bloat
**Views:** config-hygiene (ConfigHygiene), tools (catalog utilization, native-tool bypass, repeated commands, discovery failures), agents (AgentSkill effectiveness, no-op rate, MCP usage), Recommendations (fix snippets, CLAUDE.md additions, insights features), insights (At-a-Glance, quick wins), files (churn, edits/session), patterns (habit factors, tool reuse).
**Core data points:** Recommendations Copy-fix / CLAUDE.md CopyButtons (wired — the gold standard); PolicyBuilder (wired); config-hygiene `python3 -m json.tool` hint + filePath + line/col (dead, no CopyButton — "highest-value single-click fix"); unused-resource resourceId / lifetime count (dead, no copy/prune command); native-tool bypass Native-tool column (FALSE AFFORDANCE — brand-blue, no handler) + Hint column (dead, no copy); repeated/discovery-failure command cells (dead, no copy despite "wrap in a skill" prompt); AgentSkill MCP server name (FALSE AFFORDANCE brand-blue); No-op rate column (wired sort); habit-factor HURTS verdict (dead — no link to matching detector).
**Health: BIMODAL.** Where CopyButton/snippet infrastructure already exists (Recommendations, Insights horizon prompts), it's excellent. Everywhere the same "copy this command/path/snippet" action is implied but the button is absent (config-hygiene, tools command tables, native-bypass hints), it dead-ends. This is the domain where a single reusable CopyButton sweep would convert the most dead-ends.

### discovery — finding a session/project/transcript
**Views:** search (SearchView), sessions (SessionList), projects (ProjectBreakdown), Session Timeline picker, plus the **SessionIdLink/onOpenSession primitive** that threads through nearly every view (errors, tokens, patterns, context, files, cost, automation, conversation, agents).
**Core data points:** Search input + project filter + "Open in Sessions" button (wired); Search result Card (FALSE AFFORDANCE — `isClickable`+cursor:pointer, only inner button wired); entry.title never rendered; SessionList search/sort/expand (wired); every SessionIdLink (wired); ProjectBreakdown session rows + activity heatmap dots (dots dead); Session Timeline picker (dead — `onOpenSession` deprecated/unused); session-ID footers (dead, no copy).
**Health: GOOD where SessionIdLink reaches, PATCHY at entry points.** The drill-in primitive is the most reliably wired thing in the app. The failures are at the *search/scan* layer: the false-affordance result card, the unused `entry.title`, dead heatmap dots, and the orphaned Timeline picker.

### orientation — pure "how much have I used" with no specific action (vanity bucket)
**Views:** stats (UsageStats — entire view), activity (ProjectActivity — entire view, verdict FAIL), and a KPI-tile layer in nearly every other view.
**Core data points:** stats: Total Sessions, User Messages, Avg Msgs/Session, Avg Duration tiles + Activity-over-time + Project-distribution + heatmap (all dead, view verdict FAIL). activity: Active days, Sessions-in-window, Peak hour, calendar heatmap, hour×weekday heatmap (all dead, FAIL — component has no callback props at all). Plus orphan tiles in every mixed view: "Sessions Analyzed," "Distinct Modes Seen," "Distinct Shapes," "Sessions Loaded," "Binding limit right now," date ranges, rank columns.
**Health: DEAD BY DESIGN.** Two entire views (`stats`, `activity`) are orientation-only and currently drive zero actions. Across all views the KPI-tile row is the single largest concentration of dead data points — most are bare counts the analysis repeatedly recommends cutting or wiring to a destination.

---

## B. Cross-view duplication & orphans

### Duplicated data (same datum, many homes)
- **Session cost / token totals** appear in: tokens (Top-20, Est. Cost KPI), Cost Attribution (Top Expensive Sessions), Context Health (Cost + Cache-Read $ columns), patterns (avg cost, ComparePanel), AutomationView (cost share + per-session tiles), SessionList overview (Total tokens, Est. cost tiles), AgentSkill (mean $/run), Evaluator (per-task cost). The *number* is everywhere; the *drill-in* is inconsistent (wired in tokens/cost, dead in context/session-overview/automation/evaluator).
- **Compaction count / risk** appears in: Context Health (3 tables), tokens (Compaction Events), patterns (compacted %, habit factor), files (Compactions column), SessionList + AutomationView overview tiles, Recommendations (Compaction Risk Card), Evaluator (reread proxy). Same signal, 7+ surfaces, drill-in only wired in Context Health and the rec card.
- **Cache hit rate** appears in: tokens (KPI), Context Health (Avg Cache Hit Rate KPI + Worst-cache chart + ratio table). Tokens calls it "most actionable KPI" but it's dead there; Context Health wires the chart but not the ratio cells.
- **Tool error rate** appears in: tools (Breakdown + Effectiveness), errors (Top Tools by Error Rate), patterns (tool error %), insights (Tool Errors chart), session overview Errors tile. Five homes; consistent action (drill to errored sessions/tool) only in errors + tool-effectiveness.
- **SessionIdLink → onOpenSession** is the one *intentionally* duplicated primitive and it's the healthiest thing in the app — duplication here is a feature, not waste.
- **Per-session metric tiles** (Errors/Compactions/Peak-context) are byte-identical between `sessions` and `automation` (both render `SessionList.tsx:305-363`) — and dead in both despite warn-coloring.

### Pure orientation / vanity views (no home in any action domain)
- **`stats` (UsageStats)** — verdict FAIL. Every data point maps to `orientation`. No action originates here.
- **`activity` (ProjectActivity)** — verdict FAIL. Component literally has no callback props; nothing can drill anywhere.
- **`timeline` (SessionTimeline)** — verdict FAIL. Replay-only; the one wired prop (`onOpenSession`) is marked deprecated and never called.
- Within mixed views, an entire **orientation tile-layer** is vanity: "Sessions Analyzed" (appears in patterns, context, tools, conversation, cost, agents — 6×), "Binding limit right now," "Distinct Modes Seen," "Sessions Loaded," "Distinct Shapes," date-range headers, rank columns.

### True orphans (don't fit cost/speed/success-rate/safety/context-health/workflow-hygiene cleanly)
- **Discovery itself** — the user named cost/speed/success-rate as domains but `discovery` (search, project/session finding, the SessionIdLink fabric) is not an *outcome* you improve; it's the connective tissue *between* outcomes. It's tagged as a domain in the analysis but behaves like a global utility. (See Open Question 1.)
- **Time-of-day / day-of-week patterns** (activity hour×weekday heatmap, insights time-of-day histogram, ProjectActivity peak hour) — genuinely actionless. "When do I work" maps to no config, file, budget, or behavior change. Closest stretch is "schedule focused blocks," which is outside the app.
- **Multi-clauding overlap** (insights: Overlap Events, Sessions Involved, Message Share) — describes concurrent sessions; no clear action domain. Could be nudged toward context-health (fragmentation) but currently orphaned.
- **Conversation-shape vanity** (ConversationPatterns: Questions, Code Blocks, Entries denominator, Duration denominator) — counts with "no actionable target in the current app" per the analysis.
- **Attribution-mode badges** (AgentSkill native-vs-heuristic) and **Claude Code version badge** (Timeline) — meta/data-quality, not user-actionable.
- **"Fun ending," big-wins, usage-narrative prose** (insights) — explicitly decorative.

---

## C. Three candidate nav structures

All three assume the same precondition surfaced repeatedly in the analysis: **`onNavigate` + `onOpenSession` must be threaded into every component** (Evaluator and ProjectActivity currently lack them entirely; Timeline has a deprecated one). Without that wiring, no regroup matters.

### Candidate 1 — Conservative regroup (keep all 22 views, add 6 domain sections to the sidebar)
Pure reorganization of the existing flat list into labeled nav groups; no views merged or deleted.

| Group | Folds in current views |
|---|---|
| **Spend** | cost, tokens, BudgetGauge (promote to its own routed view) |
| **Reliability** | errors, (tool-effectiveness slice of tools) |
| **Speed** | evaluator, (runtime-telemetry slice of agents) |
| **Context** | context, files |
| **Workflow** | config-hygiene, tools, agents, patterns |
| **Safety** | permissions, automation |
| **Find & Review** | search, sessions, projects, timeline |
| **Overview** | recommendations (landing), insights, stats, activity, conversation |

- **Landing dashboard:** `recommendations` stays the home — it already aggregates cross-signal findings and has the most wired affordances (Copy-fix, View→, weekly delta).
- **Drill-downs:** everything else.
- **Trade-off:** Lowest risk, lowest reward. The vanity views (stats/activity/conversation) survive in an "Overview" ghetto, and views that straddle domains (`agents` spans speed+cost+success-rate+workflow; `tokens` spans cost+context-health) have to be filed under one heading, which mis-cues the user. Solves *navigation* labeling but not the dead-end problem.

### Candidate 2 — Aggressive merge (collapse 22 views into ~7 domain views)
Each domain becomes one composite view; today's views become tabs/sections within it. Vanity views are absorbed or cut.

| Domain view | Absorbs |
|---|---|
| **Cost** | cost + tokens + swap-ceiling + automation cost-share + per-session cost. One view: KPIs → Cost-by-project/tool/model → swap-ceiling with *Apply* CTA → expensive-session table. |
| **Reliability** | errors + tool-effectiveness + agent failures + friction-from-insights. Status-code guidance inline. |
| **Speed** | evaluator + runtime telemetry + latency histogram + retry-pressure. New first-class home for a homeless domain. |
| **Context** | context + files + compaction-events + cache. Reason-badges and `@path`/slash-command copy live here. |
| **Workflow** | config-hygiene + tools + agents (skills/MCP) + patterns habit-factors. All the CopyButton-needs. |
| **Safety** | permissions + PolicyBuilder + automation (unattended) + continuations-blocked. |
| **Sessions** (global utility, not a domain) | search + sessions + projects + timeline, reachable from every domain via SessionIdLink. |

- **`stats`, `activity`, `conversation`, `insights` narrative, time-of-day, multi-clauding** → cut or demoted to a single collapsible "Trends" footer; the actionable slices (project-distribution → Cost, friction → Reliability) are redistributed.
- **Landing:** `recommendations` becomes the cross-domain triage strip *above* the 7 domain views (or a 7-tile "outcome dashboard" where each tile = one domain's top finding + savings/severity).
- **Trade-off:** Highest reward — kills duplication, gives speed a home, forces every orphan to either earn a domain or get cut. But it's a large refactor (composite views with internal tabs), risks giant scroll-heavy pages, and the merge decisions are contentious (does `automation` belong in Safety or Cost? does `patterns` belong in Workflow or Context?). Highest churn against the recently-merged PF6 migration.

### Candidate 3 — Outcome-first (thin domain dashboards on top, current 22 views demoted to drill-downs)
Keep all 22 views *intact as drill-down targets*, but the **primary nav is 6 outcome dashboards** that surface only the top wired action per domain and link down.

- **Top-level nav = 6 outcome cards** (Cut Cost, Go Faster, Fail Less, Stay Safe, Tame Context, Clean Workflow) + a global **Find** search affordance pinned in the chrome.
- Each outcome card is a *thin* dashboard: 2–4 KPIs **each wired to a destination**, the single highest-value finding for that domain (pulled from the rec engine), a Copy-fix where one exists, and a "Open full view →" link to the existing detailed view.
  - *Cut Cost* → top swap-ceiling saving + Apply CTA + most-expensive-session link; "Open Cost / Tokens →".
  - *Tame Context* → top compaction-risk session's copyable `/compact` suggestion + worst `@path` pin; "Open Context Health / Files →".
  - *Stay Safe* → PolicyBuilder diff preview inline (it's already self-contained) + unattended/bypass count; "Open Permissions →".
- The existing detailed views (`tokens`, `context`, `errors`, …) live one level down, reachable from their outcome card. `stats`/`activity`/`timeline` are demoted to "Raw data" — present but off the primary path.
- **Landing:** the 6-card outcome dashboard *is* the home; `recommendations` is folded into it (each rec routes to its domain card) rather than being a separate destination.
- **Trade-off:** Best matches the stated criterion ("every bit of data should be actionable") because the top level shows *only* wired data and pushes vanity down. Preserves all engineering investment in the 22 views (they become drill-downs, low churn). Risk: two-layer navigation (dashboard → full view) adds a click and can feel like indirection; and it leans hard on the recommendation engine being comprehensive enough to populate 6 cards — domains the engine doesn't yet detect (speed has thin detector coverage) would show empty cards.

---

## D. Open questions for the brainstorm

1. **Is `discovery`/search an action domain or a global utility?** The analysis tags it as a domain, but search/sessions/projects/timeline and the SessionIdLink fabric behave like connective tissue *between* outcomes, not an outcome you improve. If it's a utility, it leaves the domain grid (pin a global search in the chrome) — which is what Candidates 2 and 3 assume. If it's a domain, it earns a top-level slot. This single decision reshapes all three candidates.

2. **Should `orientation` survive at all — i.e., do `stats`, `activity`, the time-of-day/heatmap surfaces, and the per-view KPI-count rows get cut, or kept as a deliberate "vanity/at-a-glance" zone?** Two entire views (FAIL verdicts) and the largest concentration of dead data points live here. Cutting them is the cleanest way to honor "every bit of data should be actionable," but users may expect a usage overview. Is there a defensible *non-vanity* reframing (e.g. activity → "stale projects to archive," stats → cut)?

3. **Where do the genuinely cross-domain views (`agents`, `tokens`, `automation`) get filed when a view spans 3–4 domains?** `agents` carries cost (mean $/run), speed (latency/hooks), success-rate (failures), and workflow (no-op rate); `tokens` carries cost + context-health; `automation` carries safety + cost + reliability. Do we (a) split each view's sections across domains (Candidate 2), (b) file the whole view under its dominant domain and accept mis-cueing (Candidate 1), or (c) keep them whole as drill-downs reachable from multiple domain dashboards (Candidate 3)?

4. **Does `speed` have enough wired signal to be a top-level domain, or is it a sub-section of Reliability/Workflow until detectors catch up?** Speed is currently the poorest-instrumented domain — Evaluator latency, AgentSkill hook-overhead, and the velocity cell are all dead or false-affordance, and the rec engine has thin latency detection. Promoting it to a top-level outcome card (Candidate 2/3) risks an empty card. Does it warrant the same status as cost, or get nested for now?

5. **Should the `recommendations` view remain a standalone destination, or dissolve into the per-domain dashboards** (each rec routing to its domain card, as in Candidate 3)? It is the most-wired view and the natural landing page — but if every domain dashboard surfaces its own top finding, a separate global rec list may become redundant (or conversely, the only place that ranks findings *across* domains, which the per-domain cards can't).

6. **What is the canonical "act here" affordance the redesign standardizes on — CopyButton, in-view write (PolicyBuilder model), or navigate-to-detail — and which actions deserve in-app *write* vs. copy-to-clipboard?** PolicyBuilder writes directly to `settings.json`; the cheaper-model/CLAUDE.md/json-repair fixes only ever copy. Deciding the bar for "the dashboard mutates your config vs. hands you a snippet" (and whether SPA-mode, which can't write, forces copy-only everywhere) sets the ceiling on how actionable any domain dashboard can be.

---
Source file confirming the current flat view union: `/home/jskrzypek/project/claude-history-dashboard/src/types.ts:179`. The per-session metric-tile duplication between `sessions` and `automation` both originate at `/home/jskrzypek/project/claude-history-dashboard/src/components/SessionList.tsx:305-363`.