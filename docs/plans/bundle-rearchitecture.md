# Bundle rearchitecture — stop the budget from warping feature work

**Status:** epic [#1852](https://github.com/shpwrck/claude-history-dashboard/issues/1852)
(2026-06-17). Supersedes the "just widen the budget" approach in #1574. Banks into the dormant
perf epic [#1474](https://github.com/shpwrck/claude-history-dashboard/issues/1474).

> **CORRECTION (2026-06-17):** The first draft diagnosed victory as a ~340KB anchor and made it
> Phase A. That was read off a **stale local checkout**. On the real `origin/master`, **PR #1400
> (`perf: replace heavy chart stack`, merged 2026-06-13) already removed victory +
> @patternfly/react-charts** in favor of the in-house `src/components/charts/LightweightCharts.tsx`
> SVG seam (~7KB built). Phase A is done; sub-issues #1853/#1854/#1855 are closed as moot. The
> live problem is Phases B + C below.

## Problem (re-baselined against origin/master)

The JS bundle keeps hitting its ceiling, and the way we react to that is shaping how features get
built. Per-view code-splitting (`src/lib/view-registry.tsx`) is healthy. The structural pain:

1. **The eager `index`/entry chunk grows monotonically.** Every feature adds eager shell / nav /
   registry / detector wiring; the entry chunk crept ~438KB (2026-06-10) to ~475KB (now), and
   total JS ~1.62MB to ~1.675MB. Anything added to the shared/eager graph permanently inflates
   first paint.
2. **The budget is one rising total, and that is the actual warp mechanism.** `totalJsMaxBytes`
   (plus the `index` ceiling) has been bumped on nearly every PR — `bundle-budget.json` carries
   **44 dated bump notes in June alone**. Every feature PR faces the same ritual: fit under an
   arbitrary global ceiling or justify-and-raise it. The gate punishes shipping but does not
   reward the actual fix (a new lazy chunk). That changelog *is* the warp.

## Plan

### Phase A — Evict the chart engine — DONE (#1400)

Already shipped: victory + @patternfly/react-charts removed, replaced by the ~7KB
`LightweightCharts` SVG seam. Sub-issues #1853/#1854/#1855 closed as moot.

### Phase B — Freeze a small eager shell

- **B1 (#1856) — Audit and evict the eager `index` graph.** Use the B-enabling composition
  report (C2) to find what lands in `index` that is not first-paint-critical (shared `src/lib`
  detectors/parsers, masthead wiring), and push it behind dynamic import or into the per-view
  chunks that use it.
- **B2 (#1857) — Verify PatternFly imports are path-specific** and tree-shaking is effective; no
  barrel imports dragging whole packages.
- **B3 (#1858) — Set a fixed small shell budget** that does not rise with features. *(blocked by
  C1.)*

### Phase C — Structural per-chunk gates (the warp-killer)

- **C1 (#1859) — Replace `totalJsMaxBytes` with structural gates.** A frozen shell-chunk budget,
  a frozen shared-vendor budget, and per-route caps that do *not* count against a shared ceiling.
  A new feature adds a new lazy chunk under its own cap instead of inflating a global total.
- **C2 (#1860) — Add a bundle-composition report to CI** (rollup/rolldown visualizer) attributing
  bytes to chunks/owners. Foundational for B1/B2.
- **C3 (#1861) — Rewrite `check-bundle-size.mjs` + budget + document the contract.** *(blocked by
  C1.)*

## Sequencing

C2 first (the report makes the rest measurable and is purely additive). Then C1+C3 (the gate
restructure that removes the bump ritual). Then B1/B2 using the report, with B3 freezing the
shell once B has moved the number.

## Notes

- Local builds need `npm ci` (a fresh worktree off `origin/master` has no `node_modules`).
- Per the two-phase release model, #1474 is dormant until v0.5.0's review phase; this epic can run
  ahead of that if the budget churn is actively blocking feature work.
