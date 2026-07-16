# 0016 — Structural bundle-budget classes: kill the single rising ceiling

- **Status:** Accepted (2026-06-17)
- **Date:** 2026-06-17
- **Deciders:** repo owner
- **Related:** epic [#1852](https://github.com/shpwrck/claude-history-dashboard/issues/1852) Phase C
  (#1859 structural gates, #1861 gate rewrite, #1858 freeze shell, #1857 PF imports); ADR
  [0014](./0014-tiered-delivery-model.md) (tiered delivery — the Sample/Upload split that the
  eviction half of #1852 serves). Plan: [`docs/plans/bundle-rearchitecture.md`](../plans/bundle-rearchitecture.md).
  Contract: [`docs/bundle-budget-contract.md`](../bundle-budget-contract.md).

## Context

The JS bundle gate (`scripts/check-bundle-size.mjs` + `bundle-budget.json`) was a single
`totalJsMaxBytes` per flavor plus a couple of named per-chunk ceilings. Every `dist/assets/*.js` —
the eager entry chunk, shared vendor splits, and every lazy per-route chunk — summed into that one
number.

The consequence shaped how features got built. Adding a feature the *right* way (a new `React.lazy`
route chunk, off the first-paint critical path) inflated the global total exactly as much as eager
bloat did. So every feature PR faced the same ritual: fit under an arbitrary shared ceiling, or
justify-and-raise it. `bundle-budget.json` accumulated **44 dated "Raised…" bump notes in June
alone** — that changelog *was* the warp. The total carried no signal: it could not distinguish
first-paint cost (what actually matters) from intentional lazy growth (which is free at first paint).

## Decision

Replace the single gated total with **three independent budget classes**, each enforced separately,
**never summed into one another**:

- **shell** — the FROZEN eager first-paint set (`shell.chunks`, e.g. `["index"]`), gated as a sum
  against `shell.maxBytes`. Raised only by an ADR, never a per-PR bump.
- **vendor** — FROZEN shared third-party chunks (`vendor.chunks`, `{name: maxBytes}`), each gated on
  its own ceiling. A bump here is a dependency-weight change, recorded as such — never a feature.
- **route** — every other (lazy) chunk, each gated against its own `routes[name]` cap or
  `defaults.routeMaxBytes` when unbudgeted (auto-pass-and-flag while under the default; a single
  route only fails when it alone exceeds, at which point you add one explicit, local cap).

`defaults.totalAdvisoryMaxBytes` is computed and reported for visibility but **never** fails CI.

The CLI interface (`node scripts/check-bundle-size.mjs --flavor server|spa`), the exact-logical-name
chunk matcher (`chunkBaseName`), the rename guard (absent budgeted chunk = failure, now across all
three classes), and the #1702 SPA/server boundary-marker guard are all preserved. The pure
`evaluateStructuredBudget` keeps the gate unit-testable without a real build, exactly as the prior
`evaluateBudget` was.

## Consequences

- **The warp is structurally impossible.** A new feature = a new route chunk under its own cap (or
  the shared default). Route caps are never summed, so a new route cannot inflate any shared number —
  there is none. The bump ritual has nothing to grow.
- **Failures now point at the real problem.** A `shell` failure means first-paint code grew (a missed
  `lazy()`, a barrel import, an eager detector) — fix the import, do not raise the cap. A `vendor`
  failure is a dependency change. A `route` failure is local to that one view.
- **`totalJsMaxBytes` is gone, not relocated.** Its only structurally meaningful residue — "don't let
  first-paint creep" — is carried by the frozen `shell.maxBytes`, which covers shell chunks *only*.
- **Migration is no-flag-day.** The v2 caps were seeded from the measured `origin/master` (@`e321189`)
  build so the cutover is green on current master; the structural *tightening* (a small frozen shell)
  is deferred to #1858, after #1856 evicts non-first-paint code from `index`.
- **The shell cap is intentionally generous at cutover** (~1.5% over measured `index`). It is a
  freeze, not yet a *tight* freeze; #1858 lowers it once the eviction work has moved the number. This
  ADR is the gate that any later shell-cap raise must pass through.

## Amendments

Each entry records a frozen-shell raise passing through this gate (per the Decision: "Raised only by
an ADR"). A raise is justified only when the added first-paint bytes are irreducible — the code
genuinely runs at first paint and cannot be lazy-split or tree-shaken away.

- **2026-07-10 — #2446 (epic #1852, Tier-3 instant load).** `server.shell` 482,000 → 482,176 (CI
  measured 482,124); `spa.shell` 472,000 → 472,032 (CI measured 472,003). The instant-load client
  consumption (#2443) paints the landing shell from the boot payload and backfills slices. Its
  ORCHESTRATION is already lazy-split into the `@instant-load` chunk (off the first-paint graph), and
  its worker + boot-count stand-in are tree-shaken out of the SPA build entirely (gated behind the
  `SERVER_AVAILABLE` build-const / aliased away). What remains on the **server** first-paint graph is
  the irreducible eager UI wiring that must run there: the masthead's boot-count stand-in (#2450, so
  the header shows real counts instead of `0` during the shell window) and the reload/preserve-last-
  good wiring (#2449) — ~124 B. The **SPA** carries only a 3-byte residue (the reload's
  `hasExistingData` argument). Both were minimized before raising: #2450's state reuses the existing
  `ImportState` rather than a new eager hook so it DCEs from the SPA, and the count reads are all
  behind `SERVER_AVAILABLE &&`.
