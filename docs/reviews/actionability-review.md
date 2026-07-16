# Final Review: "Every Bit of Data Should Be Actionable"

> Three-persona debate (proponent / detractor / neutral) over all app data
> surfaces. Discovery mapped 22 views / 277 data points; two debate rounds +
> neutral synthesis. Run 2026-06-02.
>
> **Correction (2026-07-08):** #2346 / PR #2353 superseded the Timeline wiring
> claims below: Timeline now exposes an **Open in Sessions →** control for the
> selected session, with a copy fallback when navigation is unavailable. #1623
> wired ProjectActivity's aggregate day/project drilldowns; #2346 / PR #2353
> removed its unused `onOpenSession` prop. The original review remains below as
> a 2026-06-02 point-in-time record.

## 1. Verdict

The app **partially satisfies** the criterion, with a sharp structural split that all three personas converged on by Round 2. Where the app is built around its recommendation engine and the session drill-down pattern — Recommendations, Permissions (Policy Builder), Budget Gauge, Search, Errors, Context, Tokens, Patterns — data points carry real affordances: copy-fix buttons, write-to-settings.json, session-ID links, and A/B comparison. These views genuinely turn data into action. But roughly a quarter of the views (Stats, Activity, Evaluator, Cost, Timeline, Config-Hygiene) are *inert*: code-verified to contain zero wired affordances (no `onClick`, `Button`, `href`, `CopyButton`, `onOpenSession`) — they compute a metric, render it in a StatCard or chart, and stop. The dominant failure mode is not malicious vanity but *abandoned wiring*: even flagship views drop the drill-in pattern the moment data leaves their headline table (e.g. Tokens links session IDs in two tables but renders them as plain text in a third). Counting hard dead-ends (`actionability: none`) at ~49% of all data points, the app fails the criterion *at the data-point level* even where it passes at the view level. The honest grade is **MIXED — a strong actionable spine surrounded by a large, fixable layer of read-only decoration.**

## 2. Per-View Scorecard

| View | Verdict | One-line why |
|------|---------|-------------|
| recommendations | **PASS** | Every rec card has CopyButton + "View →"; Policy Builder writes settings.json; weekly-delta tiles drill to session links. The app's action hub. |
| budget-gauge | **PASS** | Every datum self-directs a pacing decision; overage notice = "stop"; auth-failed state gives the exact `claude auth` command. |
| search | **PASS** | Search + project filter + "Open in Sessions →" form a complete wired path. (Flaw: result card styled `isClickable` with no `onClick` — false affordance.) |
| patterns | **PASS** | Habit-impact HELPS/HURTS verdicts with clickable session examples; pin-to-compare A/B panel guides behavior change. |
| permissions | **MIXED** | Policy Builder is the app's most complete affordance; but KPI tiles (Bypass-mode Sessions count) are red, inert, and don't link to the offending sessions. |
| errors | **MIXED** | Three tables wire session-ID links; but six KPI tiles are dead, the error-rate chart has no `onClick`, and 429/529 codes don't link to docs. |
| context | **MIXED** | Worst-cache-rate chart bars + three tables drill to sessions; but eight KPI tiles inert and the risk distribution bar is `role="img"`. |
| tokens | **MIXED** | Tokens-by-Session bar + Top-20 cost table wire `onOpenSession`; but Compaction Events session IDs are plain text, donut has no `onClick`, 7 KPIs inert. |
| tools | **MIXED** | Tables name the exact tool/command/skill to fix and per-session table links sessions; but no in-app fix button and Tool Frequency chart is dead. |
| files | **MIXED** | Re-read drilldown links sessions and load-once caption names the `@path` fix; but Read-only and Directory charts are dead, KPIs inert. |
| sessions | **MIXED** | Click-to-expand + g/b/0 labeling are real; but expanded panel's red error/compaction/peak-context tiles link nowhere; session ID not copyable. |
| projects | **MIXED** | Expanded session list links to sessions; but usage bars, counts, full filesystem path (not copyable), and heatmap dots all dead-end. |
| automation | **MIXED** | Run-timeline bars + session list drill in; but cost-share band leads nowhere and expanded-panel warning tiles don't link to remediation. |
| conversation | **MIXED** | Sortable per-session table + session-ID column drill in; but four KPI tiles and the latency histogram are dead-ends. |
| agents | **FAIL** | Only 2 of ~14 data points wired (AFK + settings-events session links); MCP names styled blue but aren't links; runtime telemetry links nowhere. |
| insights | **FAIL** | Regenerate/horizon-copy/session-link spine works, but nine bar charts + multi-clauding tiles + prose cards (~15 of 24) are all read-only. |
| cost | **FAIL** | Only Top Expensive Sessions table is wired (1 of 7); "Most Expensive Tool/Project" KPIs and both charts/table link nowhere. |
| evaluator | **FAIL** | All 8 data points are StatCard tiles; no link from a high p95-cost or reread-waste figure to the sessions causing it. |
| timeline | **FAIL** | As of 2026-06-02, `onOpenSession` was `@deprecated`/unused and only the in-place picker was wired. #2346 / PR #2353 superseded that claim by adding **Open in Sessions →** with a copy fallback; the row-level findings remain part of the dated review. |
| stats | **FAIL** | Code-verified zero wired affordances; pure orientation wallpaper. |
| activity | **FAIL** | As of 2026-06-02, the view had zero wired affordances. #1623 later added aggregate date/project drilldowns, and #2346 / PR #2353 removed the inappropriate per-session `onOpenSession` prop. |

## 3. The Non-Actionable Hit List (worst first)

1. **Config-Hygiene — every FindingCard (unused skills/subagents/MCP/plugins).** Names the resource, scope, last-seen, and invocation count, then stops. This is the **sharpest purpose-vs-capability mismatch in the app**: the view exists to drive cleanup and ships zero cleanup affordance. *Fix:* add a "Copy removal snippet" / "Open config file" button per finding, mirroring the Policy Builder's write-to-settings.json pattern — the app already knows the exact key.

2. **Config-Hygiene — settings.json syntax-error hint (`python3 -m json.tool …`).** The one near-fix in the view is a bare `<code>` with no copy button (verified line 170), forcing manual retyping. *Fix:* wrap in `ClipboardCopy`. One-line change.

3. **Stats — Project Distribution bar chart.** The obvious affordance ("show me this project's sessions") is absent; no `onClick` on bars. *Fix:* on bar click, navigate to Sessions filtered by project (the Projects view already does this).

4. **Stats / Activity — calendar heatmap & Activity-Over-Time chart.** At the 2026-06-02 snapshot, every cell/point knew its date + session count but clicking did nothing. #1623 later wired ProjectActivity's calendar cells to filtered Sessions; the Stats and Activity-Over-Time portions remain dated findings. *Fix at review time:* `onClick` → open Sessions filtered to that day.

5. **Activity — Active Projects table.** The rows were static at the 2026-06-02 snapshot. #1623 later wired them through aggregate filtered navigation; #2346 / PR #2353 removed the inappropriate per-session `onOpenSession` prop, so the dated suggestion to reuse that pattern must not be reimplemented.

6. **Cost — "Most Expensive Tool" & "Most Expensive Project" KPIs + Cost-by-Tool/Project charts.** Names the costliest tool/project (the whole point of the view) but links nowhere; 5 of 7 data points dead. *Fix:* link the tool KPI to a filtered Tools view, the project to filtered Sessions; add `onClick` to chart bars/rows.

7. **Tokens — Compaction Events table session IDs (line 754).** Rendered plain monospace while the *same component* links session IDs at lines 589 & 1022. Indefensible self-inconsistency. *Fix:* swap the text for the existing `PfSessionIdLink` — copy-paste from elsewhere in the file.

8. **Timeline — all entry rows incl. red error rows + entrypoint badge.** `onOpenSession` was `@deprecated` at the 2026-06-02 snapshot; #2346 / PR #2353 later activated it through **Open in Sessions →** with a copy fallback. The snapshot also found that error-highlighted rows did not link to the Errors view and summary text was not copyable. *Fix at review time:* link error rows to Errors view; link the unattended-entrypoint badge to the Automation view.

9. **Sessions / Automation — expanded-panel warning tiles (Errors, Compactions, Peak Context).** Red-accented to scream "problem" but link nowhere. *Fix:* make the red tiles navigate to the Errors / Context Health view scoped to that session.

10. **Agents — Runtime Telemetry (hook overhead, blocked continuations) + MCP server names.** Flags slow hooks numerically with no path to the hook config; MCP names styled blue (link-like) but aren't links — a false affordance. *Fix:* link MCP names to config; add a recommendation/link for high hook overhead.

11. **Permissions / Errors — KPI count tiles ("Bypass-mode Sessions: N", six error KPIs).** Name a problem count with no click to reach the underlying sessions; some duplicate a table rendered right below. *Fix:* make each count tile a filter/scroll-to-table action; or cut the ones that purely duplicate the adjacent table.

12. **Insights — nine bar charts + Multi-Clauding tiles.** "Top Tools Used" doesn't link to Tools; "Tool Errors" doesn't link to Errors; multi-clauding overlap tiles don't link to the overlapping sessions. *Fix:* link each chart to its corresponding functional view.

13. **Search — result card body.** Styled `isClickable` + `cursor:pointer` (lines 137-138) with no `onClick`; only the inner button works. A control that lies about being a control. *Fix:* wire the card body to the same `onOpenSession` the button uses, or remove the clickable styling.

14. **Projects — full filesystem path (expanded panel).** The single most-useful thing to copy from the view, rendered as un-copyable monospace text. *Fix:* add a copy button.

15. **Files — Read-only Files chart.** Labels files "likely reference material" but offers no action. *Fix:* add a "pin in CLAUDE.md" copy snippet, mirroring the load-once-candidates caption that already names its fix.

16. **Evaluator — all 8 StatCard tiles.** Benchmark figures (p95 cost/task, retry storms, reread waste) with no bridge to the sessions/tools causing them. *Fix:* link each metric to the relevant view (cost→Tokens, retry→Errors, reread→Files), or fold these into Recommendations as ranked findings.

## 4. Cross-Cutting Patterns

1. **Charts almost never link to their underlying sessions.** Nearly every bar chart, donut, heatmap, and histogram (Stats, Activity, Cost, Insights, Tools Frequency, Conversation latency, Token donut) has the session/project/tool identity *in the tooltip* but no `onClick`. The data to wire the drill-in is already computed; the handler is simply not attached. This is the cheapest, highest-leverage class of fix.

2. **Raw counts are shown without a target or threshold to act against.** KPI tiles report "Total Compactions: N", "Bypass-mode Sessions: N", "Overall Error Rate: X%" with no benchmark, no "good/bad" line, and no link to the rows behind them. A number without a target and without a path is, by the criterion, decoration with a digit on it.

3. **The app knows how to write fixes but withholds the affordance.** The Policy Builder proves the app can compute the exact settings.json patch and POST it server-side. Yet Config-Hygiene (remove unused resources), Recommendations' model-routing band (settings.json model key), and Tools (MCP pruning) all *name* the precise fix and make the user hand-edit it in a terminal. Generalizing the write-through pattern would convert a dozen "low" data points to "high."

4. **Drill-in wiring is abandoned mid-view.** The failure isn't that aggregate views are dead by design — it's that *action-capable* views stop wiring once data leaves the flagship table (Tokens compaction IDs, Sessions expanded tiles, Automation cost band). The pattern exists in scope and is simply not reused.

5. **A handful of false affordances are worse than honest dead-ends.** The Search result card (`isClickable`, no handler) and Agents' blue-styled-but-unlinked MCP names *promise* interactivity and silently do nothing — actively misleading under a criterion about actionability.

## 5. Where the Debate Genuinely Disagreed

The only unresolved clash was **Insights: Detractor said FAIL, Proponent and Neutral said MIXED**, and it never reconciled. The Detractor's case is arithmetic — ~78% of data points are dead-ends (nine read-only charts + prose). The Neutral's case is methodological — the criterion grades on whether *a concrete action path exists*, and Insights has three live, distinct ones (Regenerate fires a real backend job, horizon cards have CopyButton, session summaries have SessionIdLink), which is categorically different from Stats/Config-Hygiene where code verification found *zero* wired affordances.

**Tiebreak: MIXED.** Bucketing "working action spine plus many dead charts" together with "literally nothing wired" erases a distinction the criterion cares about — a user *can* act on Insights (regenerate, copy a prompt, open a session). It fails at the data-point level for the charts but passes at the view level for its spine. That is the definition of MIXED, not FAIL. The Detractor's percentage is real and the chart gap is the view's biggest weakness, but a view you can act on is not a vanity screen.

Two near-clashes that *did* reconcile, for the record: the Detractor walked back Search from "decoration masquerading as affordance" to MIXED/PASS (the action path is wired), and all three personas converged on FAIL for Stats, Activity, Timeline, Config-Hygiene, and Agents once the source was code-verified.
