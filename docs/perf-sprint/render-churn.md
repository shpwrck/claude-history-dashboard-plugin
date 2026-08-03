# Render-churn profiling — ResizeObserver + large tables (issue #666)

Measured against the sample build (`npm run build:sample`) with the 18-session
deterministic sample corpus (`build-corpus.mjs`, seed `0x5eed1234`), served via
`vite preview` on port 4476/4477. Chromium headless via Playwright.

> **`build:sample`, not `build:spa`.** This doc previously said `build:spa`,
> which cannot be right: `vite.config.ts` applies `sampleDataPlugin()` only
> under `--mode sample`, so the spa/edge build emits no `sample-data.zip` and its
> preview renders the empty upload-first UI (ADR 0014 / epic #1852).
> `scripts/measure-isolated-views.mjs` now verifies the served corpus and
> **aborts** rather than measuring an empty UI, so the old instruction would
> fail immediately.

Script: `scripts/measure-render-churn.mjs` / `scripts/measure-isolated-views.mjs`
Methodology: each view is loaded in a **fresh browser context** (no
PerformanceObserver carry-over from prior views). Three runs per view; medians
reported. Two measurement windows per run:

1. **Initial load**: longtask entries (`>50 ms`) collected from navigation until
   the view settles (1.5 s settle window).
2. **Resize storm**: viewport cycled narrow→wide (400→1280 px) 5 times, with
   80 ms dwell at each width; longtasks collected during + 300 ms after.

All numbers are CPU-longtask wall-clock durations as reported by the browser's
`PerformanceObserver('longtask')`. CLS (layout-shift) was also tracked; all views
reported 0.0000 per-view CLS — no measurable cumulative layout shift.

---

## Measurements (medians over 3 runs)

| View                              | useContainerWidth calls | nav (ms) | initial load LT (ms) | initial load LT count | resize-storm LT (ms) | resize-storm LT count |
|-----------------------------------|-------------------------|----------|----------------------|-----------------------|----------------------|-----------------------|
| Tokens                            | 3                       | 1447     | 367                  | 3                     | 223                  | 4                     |
| Tool Usage                        | 2                       | 1122     | 190                  | 2                     | 0                    | 0                     |
| Context Health                    | 2                       | 996      | 149                  | 2                     | 0                    | 0                     |
| Sessions (large table, 0 charts)  | 0                       | 2023     | 624                  | 6                     | **1108**             | **10**                |
| Conversation / Patterns           | 1                       | 1010     | 214                  | 2                     | 0                    | 0                     |
| Agents                            | 1                       | 1081     | 152                  | 2                     | 0                    | 0                     |
| Errors                            | 1                       | 1101     | 156                  | 2                     | 0                    | 0                     |
| File Impact                       | 2                       | 1008     | 160                  | 2                     | 0                    | 0                     |

Full per-run data (3 runs):

```
Tokens:         load=367ms(2lt) / 326ms(3lt) / 378ms(3lt)  resize=223ms(4lt) / 211ms(4lt) / 323ms(6lt)
Tool Usage:     load=271ms(2lt) / 163ms(2lt) / 190ms(2lt)  resize=0ms / 53ms(1lt) / 0ms
Context Health: load=179ms(2lt) / 144ms(2lt) / 149ms(2lt)  resize=0ms / 0ms / 0ms
Sessions:       load=237ms(2lt) / 889ms(8lt) / 624ms(6lt)  resize=1108ms(10lt) / 1254ms(10lt) / 212ms(4lt)
Patterns:       load=233ms(2lt) / 214ms(3lt) / 169ms(2lt)  resize=61ms(1lt) / 0ms / 0ms
Agents:         load=251ms(2lt) / 148ms(2lt) / 152ms(2lt)  resize=0ms / 55ms(1lt) / 0ms
Errors:         load=255ms(3lt) / 156ms(2lt) / 154ms(2lt)  resize=0ms / 0ms / 0ms
File Impact:    load=247ms(2lt) / 160ms(2lt) / 155ms(2lt)  resize=0ms / 0ms / 0ms
```

---

## Findings

### 1. ResizeObserver consolidation (done) — does NOT cause layout thrash

The 14 hand-rolled `ResizeObserver` blocks were already consolidated into
`src/components/hooks/useContainerWidth.ts` by a prior task. The hook fires one
`setWidth` per resize event per instance; it does not force a synchronous reflow.

Measurement confirms: the **resize-storm longtask cost for all chart views is
zero or negligible** (0–53 ms). Views with 2 `useContainerWidth` instances
(Tool Usage, Context Health, File Impact) are indistinguishable from views with
1 instance. The observer callback + `setState` pattern does not amplify into a
measurable DOM layout cascade.

**Verdict for ResizeObserver: not worth prioritizing. The consolidation in #623
removes the maintenance debt; there is no performance emergency.**

### 2. Tokens view — chart-layout longtasks (initial render, not resize)

The Tokens view has the highest **initial-render** longtask cost (median 367 ms,
3 tasks). These tasks are incurred at page load (Victory/Recharts chart layout),
not by resize events: the resize-storm adds only 223 ms of additional longtask
time and the chart-render longtasks are the same size whether a resize is
triggered or not.

The cost is attributable to the Victory/Recharts charting library laying out 3
simultaneous chart instances (BarChart, PieChart/Donut, and AreaChart), each
getting its own `ResizeObserver`-derived container width and triggering an
internal layout pass. This is a chart-library render cost, not a React
re-render or forced-reflow problem.

**Verdict for Tokens: moderate initial-render cost, not caused by
layout thrash. The 364 ms figure is within the chart library's expected budget
for 3 simultaneous charts. No emergency.**

### 3. Sessions view — large-table DOM layout thrash (resize) — the actionable finding

The Sessions view is the **clear outlier**: it has no charts and no
`useContainerWidth` calls, yet it produces the highest resize-storm longtask
cost by far (median 1108 ms, 10 tasks; peak run 1254 ms).

The root cause is the PF `<Table>` with day-grouped, expandable rows. Across
18 sessions the Sessions view renders ~18 `<Tr>` rows plus their expandable
detail rows, nested inside multiple `<Table>` instances (one per date group).
Each viewport resize forces the browser to re-compute column widths, flex
container sizes, and the sticky header positions for every nested `<Table>` —
this is a DOM-layout recalculation, not a React re-render. No virtualization is
applied to any of the tables in this view.

The initial-render longtask cost (median 624 ms) shows the same table-layout
problem at first paint: the browser pays a large upfront layout cost to size all
the nested `<Table>` instances and their expandable rows simultaneously.

At the time, this was treated as a likely row-count scaling problem. The old
100-session / ~6 s estimate was an unverified extrapolation, not a measurement,
and is now retired: the host baseline has drifted substantially, and the later
#714/#3287 windowing work below disproved linear DOM growth by bounding rendered
rows at 300- and 1,000-session scale.

---

## Verdict

Layout thrash **is measurable** on the Sessions view. It is caused by large PF
`<Table>` DOM layout recalculations on resize, not by `ResizeObserver` callbacks
or React re-renders. The ResizeObserver/chart views are not a layout-thrash
problem.

### Render-cost budget

| Surface                              | Current (18 sessions) | Budget target | Path to budget |
|--------------------------------------|-----------------------|---------------|----------------|
| Sessions resize-storm LT total       | 1108 ms (median)      | <= 100 ms     | Virtualize the session rows (react-window or PF `<VirtualizedTable>`); avoid per-date-group nested `<Table>` instances |
| Tokens initial-render LT total       | 367 ms (median)       | <= 200 ms     | Lazy-mount charts (render on first scroll-into-view / intersection); already off the cold critical path |
| All other chart views (resize storm) | 0–53 ms               | OK — no budget needed | -- |

These budgets apply at the 18-session sample corpus scale. Re-measure after
#623's ResizeObserver extraction to confirm no regression; re-measure the
Sessions view after any virtualization work is landed.

> **Historical note (2026-07-30):** the "Current" column above is the
> 2026-06-05 pre-fix record. See the re-measurement addendum below for the
> post-#714/#3287/#3288 numbers; the budget targets are unchanged.

---

## Re-measurement addendum — 2026-07-30 (#3287, #3288, #3278; round-10 of #1930)

Measured on the `perf/1930-r10-render` worktree at `37f61e75` + this branch's
fixes, same harnesses (`scripts/measure-isolated-views.mjs`, 3 fresh contexts
per view, medians) plus the new large-history benchmark
(`scripts/measure-sessions-scale.mjs`, described below).

### Sessions

The #714 windowing had already replaced the per-date-group nested tables with
ONE flat windowed `<Table>` (~90x win vs this document's original record —
the 2026-07-26 audit filing restated the stale record; see #3287's re-scope
comment). The residual found there: one spacer `<tr>` PER windowed-out row
still gave the browser a box to lay out per historical row — 311 ms
resize-storm longtask at 300 rendered rows, 670 ms at 1000, vs the <=100 ms
budget.

#3287 coalesces each contiguous run of off-window rows into ONE spacer `<tr>`
(height = 44 px x run length) and maps intersections on the tall spacer back
to row indices from the observer entry's geometry (`useRowWindow.observeSpacer`).
#3278 fixes the observer rebuild (rowCount/rootMargin change) losing every
mounted sentinel: the element registry now survives rebuilds and the
replacement observer re-observes it — without this, every `Load more` click
(a rowCount change) froze the window.

`scripts/measure-sessions-scale.mjs` results (scaled clone corpora served via
route interception over the verified sample preview; full pagination through
`Load more`; row-composition asserted; quiescence-gated resize storm):

| sessions | rendered `<tr>` (median)   | resize LT median (pre-fix, 37f61e75) | resize LT median (post-fix) | <=100 ms budget |
|----------|----------------------------|--------------------------------------|-----------------------------|-----------------|
| 18       | 13 full + 1 spacer         | 0 ms                                 | 0 ms                        | MET             |
| 300      | 27 full + 2 spacers        | 311 ms                               | 104 ms                      | 4 ms over — see note |
| 1000     | 26 full + 2 spacers        | 670 ms                               | 104 ms                      | 4 ms over — see note |

The acceptance's growth clause is now demonstrably met: 3.3x the rows costs
1.0x the time (flat), where the pre-fix curve grew 311 -> 670 ms. The DOM is
bounded: ~27 `<tr>` at every scale (was 305 and 1005).

**On the ~104 ms residual (as measured in the recorded run):** in that run it
was scale-independent (the same at 300 and 1000) and scroll-position-
independent (a control run with the storm at scroll-top measured 102 ms), and
attributable to two ~52 ms tasks — barely over the 50 ms longtask floor —
from the app shell's 400 px<->1280 px breakpoint re-renders, which at the
18-session state sit just under the floor and count as 0. Longtask medians
this close to the 50 ms quantization floor are noisy across machines and
runs (repeat runs on the same host have ranged roughly 0-216 ms at the same
scale, flipping the <=100 ms verdict either way), so treat the table above as
one recorded run's evidence for the load-bearing claims — the DOM bound and
the flat growth curve, both of which reproduce — not as exact per-run
milliseconds. Further reduction of the residual is app-shell work outside
the Sessions table's scope.

### Tokens

The chart stack had already moved to the in-repo SVG `LightweightCharts`
(the "3 simultaneous Victory/Recharts instances" this document measured are
gone), which alone brought initial load under budget. #3288 additionally
defers the two below-fold chart surfaces ("Tokens by Session (Top 20)" and
the "Model Distribution" donut) behind an intersection-triggered
`<LazyMount>` (`src/components/hooks/LazyMount.tsx`): they render a
height-reserving placeholder until first scrolled near the viewport, then
stay mounted.

| Metric                        | 2026-06-05 record | 37f61e75 baseline (today) | post-fix | budget    |
|-------------------------------|-------------------|---------------------------|----------|-----------|
| Tokens initial-load LT median | 367 ms            | 156 ms                    | 177 ms   | <= 200 ms — MET |
| Tokens resize-storm LT median | 223 ms            | 377 ms                    | 382 ms   | unchanged (within run noise) |

Initial-load runs post-fix: 309 / 172 / 177 ms (the first run of every view
carries ~2x cold-start warmup; the median absorbs it). Resize-storm cost is
unchanged: the storm never scrolls, so the deferred surfaces are not mounted
during it either way — the remaining resize cost is the visible spend chart
plus app shell. Browser-verified behavior: both surfaces are
`data-lazy-mount="pending"` at first paint and mount permanently on first
scroll-into-view.

### Sessions (default view, isolated harness)

Unchanged and at floor post-fix: 180 ms initial load, 0 ms resize. Note the
isolated harness measures the DEFAULT view state, which the global 24h time
filter restricts to the most recent sample sessions; the scale benchmark
above widens to All and paginates fully.

### What #623 (ResizeObserver extraction) achieves

#623 removes the code-duplication maintenance debt. It does not change the
render-cost profile: the hook is already consolidated (`useContainerWidth.ts`)
and the per-instance cost is negligible. #623 is a correctness/maintainability
win, not a performance fix.

---

### Context Health and sample-window integrity — 2026-08-02 (#3512, #3505)

Measured on the branch based on `ca9659dc` with the corrected isolated harness
and verified corpus `sample-data.zip 28467 bytes sha256:19f28d16990626ed`.
The harness now fails closed unless the route renders the expected `h1`; the
Context Health and Sessions workloads additionally assert the all-time sample
count of 18 sessions. This replaces the invalid historical
`#/context-health` route with `#/context?time=all`.

A targeted pre-fix A/B isolated the Context resize cost before changing the
component:

| Context Health variant | resize-storm runs |
|------------------------|-------------------|
| Full detail subtree mounted while collapsed | 716 / 702 ms |
| KPI strip hidden only | 664 / 712 ms |
| Collapsed `Session detail` subtree not mounted | 0 / 0 ms |

The collapsed subtree contained 1,265 descendants, four tables, and five
cards. `ContextHealthPf` now mounts that investigative detail only on first
expansion. The final three-run measurement was:

| Metric | runs | median | budget |
|--------|------|--------|--------|
| Initial-load longtasks (informational) | 296 / 125 / 121 ms | 125 ms | -- |
| Collapsed resize-storm longtasks | 0 / 0 / 0 ms | 0 ms | <=100 ms — MET |
| First expansion to visible detail | 244 / 232 / 286 ms | 244 ms | recorded separately |
| First-expansion longtasks | 115 / 115 / 139 ms | 115 ms (one task) | recorded separately |

All three expansion runs mounted 1,265 detail descendants. This is a deliberate
transfer of work from every collapsed resize to the user's first disclosure;
it does not claim that rendering the detail is free.

The sample-window contract was corrected at the same time. The generated sample
timestamps remain fixed and byte-stable. In sample mode, a bare Sessions route
now means all time and reports 18 sessions / 33 entries / 18 token sessions;
an explicit `?time=24h` still wins and reports 5 / 10 / 5. Server and upload
builds retain the 24-hour implicit default, and every explicit URL time filter
wins in every build mode.

---

## How to re-run

```sh
# 1. Build with the sample corpus. ONLY `--mode sample` emits sample-data.zip
#    (vite.config.ts); `npm run build:spa` is the upload-first build and ships
#    no mock data, so its preview renders an EMPTY UI.
npm run build:sample

# 2. Run the measurement harness (starts vite preview on port 4476)
node scripts/measure-render-churn.mjs

# Or the isolated-per-view version (3 fresh contexts per view, port 4477):
node scripts/measure-isolated-views.mjs

# Sessions at large-history scale (#3287): scaled clone corpora, full
# pagination, resize storm per scale (port 4489):
node scripts/measure-sessions-scale.mjs --scales 18,300,1000
```

Both scripts exit cleanly and kill the preview server they started. Pipe output
to a file to preserve the JSON results.

`measure-isolated-views.mjs` verifies what it is about to measure and **exits
nonzero** rather than publishing numbers it cannot attribute: the responder
must serve this dashboard's shell (matching `index.html`'s `<title>`, not merely
some built Vite app) and a real `sample-data.zip`. Each route must render its
expected `h1`; Context Health and Sessions must report the expected 18-session
all-time sample workload. The Context collapsed resize median must remain at or
below 100 ms or the harness exits nonzero. If you see `refusing to measure port
…`, the message names the build to run.
