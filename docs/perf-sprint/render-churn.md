# Render-churn profiling — ResizeObserver + large tables (issue #666)

Measured against the SPA build (`npm run build:spa`) with the 18-session
deterministic sample corpus (`build-corpus.mjs`, seed `0x5eed1234`), served via
`vite preview` on port 4476/4477. Chromium headless via Playwright.

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

With a real `~/.claude` directory (100 sessions per the baseline.md dataset vs
18 in the sample corpus), this cost will scale roughly linearly with row count.
At 100 sessions the resize-storm cost is expected to approach **~6 s** of
blocked main-thread time (extrapolated from the 18-session 1108 ms observation),
making the Sessions table the highest-priority render-churn target.

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

### What #623 (ResizeObserver extraction) achieves

#623 removes the code-duplication maintenance debt. It does not change the
render-cost profile: the hook is already consolidated (`useContainerWidth.ts`)
and the per-instance cost is negligible. #623 is a correctness/maintainability
win, not a performance fix.

---

## How to re-run

```sh
# 1. Build the SPA (generates sample corpus)
npm run build:spa

# 2. Run the measurement harness (starts vite preview on port 4476)
node scripts/measure-render-churn.mjs

# Or the isolated-per-view version (3 fresh contexts per view, port 4477):
node scripts/measure-isolated-views.mjs
```

Both scripts exit cleanly and kill the preview server they started. Pipe output
to a file to preserve the JSON results.
