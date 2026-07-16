# Mobile testing rigor — spike and recommendation (#929)

Status: spike result. Decision: **expand the existing Playwright harness;
do NOT adopt Maestro/Appium.** Cross-references #257 and
[`mobile-parity-audit.md`](./mobile-parity-audit.md) — this builds on that
decision rather than relitigating it.

## What changed since #929 was filed

Two of the gaps the issue listed are **already closed** and the doc must not
relitigate them:

- **"Not in CI."** `.github/workflows/browser-compat.yml` now runs the Playwright
  suite on **every PR** (the `changes`/docs-only gate skips it only for docs-only
  PRs), serving the `build:spa` bundle. Mobile regressions now gate PRs.
- **"iOS Safari not exercised."** The suite runs a **`mobile-webkit`** project
  (the real WebKit/Safari engine, iPhone 12 profile at 390×844) alongside
  `mobile-chromium` and `desktop-chromium`. A Safari-only break fails CI.

So the live question is no longer "is there mobile coverage in CI" — it is
"**how much more rigor is worth adding, and with which tool.**"

## Current state (2026-06)

Projects (`playwright.config.ts`): `mobile-chromium` (Pixel 7, 390×844),
`mobile-webkit` (iPhone 12, 390×844), `desktop-chromium` (1280×800).

Specs (`e2e/`):

| Spec | Asserts | Projects |
|---|---|---|
| `mobile-smoke` | no horizontal overflow at 390px + `<main>` not blank, per view | mobile-chromium, mobile-webkit |
| `render-smoke` | every reachable view mounts, no console/page error, no error-boundary fallback | all three |
| `sample-data-smoke` (#533) | curated data views render a real table/chart surface, not an empty-state | desktop-chromium |
| `desktop-scroll` (#767) | no desktop horizontal scrollbar | desktop-chromium |
| `metric-overflow` (#793) | metric-card values never overflow/clip | mobile + desktop |

CI runs on a dedicated self-hosted 8-core runner (#1089), so the suite is fast
(workers:8), which materially lowers the cost objection to adding more cases.

## Remaining gaps (what's genuinely still weak)

1. **Single viewport family.** Only 390×844 portrait. No landscape, no small
   (`360`/`320`), no large (`414`/`430`), no tablet breakpoint — so a layout that
   breaks only at a narrower width or in landscape ships undetected.
2. **No touch-target / tap-ergonomics assertions.** Nothing checks interactive
   controls meet a minimum hit size (~44px) at mobile width.
3. **No interaction flows on mobile.** Coverage is render + overflow only; no
   "open the nav drawer, navigate, open a session, interact with a filter/chart"
   flow under a mobile profile.
4. **No visual-regression layer.** Pixel-level drift (spacing, truncation,
   wrapping) isn't caught.
5. **Emulation, not a real device.** Playwright device profiles are a desktop
   engine + forced viewport/DPR/UA — close to, but not identical to, a physical
   phone (no real font-scaling/safe-area/gesture quirks).

## Options evaluated

### 1. Expand the existing Playwright harness — RECOMMENDED

Add device/viewport projects (small/large/landscape/tablet) and richer
assertions (tap-target size, no vertical content cutoff, a mobile interaction
flow) to the harness that already exists and already gates CI.

- **Pros:** zero new infra; reuses the self-hosted runner, the `build:spa`
  serving glue, `REACHABLE_VIEWS`, and the existing assertion helpers; real
  WebKit engine already in place; incremental and low-flakiness.
- **Cons:** still emulation, not a physical device; more projects = more wall
  time (mitigated by the 8-core runner + concurrency cancel).

### 2. Maestro / Appium — NOT RECOMMENDED for this product

Both are primarily **native-app** drivers. This dashboard is a **web SPA**, so
their only relevant mode is driving a real mobile *browser*:

- **Maestro** is native/Flutter-first; mobile-web support is not its strength.
- **Appium** can drive Safari/Chrome on real or emulated devices, but that means
  standing up a device farm or emulators, CI runners that can host them, and the
  attendant flakiness and maintenance — for marginal fidelity over Playwright's
  WebKit engine, on a product with no native app.

The real-device fidelity gain does not justify the infra cost here. Revisit only
if/when a native wrapper (e.g. a packaged mobile app) ships.

### 3. Visual-regression layer — ORTHOGONAL, defer

Playwright screenshot snapshots (or a hosted service) would catch pixel drift.
Worth doing eventually, but it is an orthogonal concern to engine/viewport
rigor and brings snapshot-maintenance overhead; keep it as a separate later
initiative, not part of the mobile-rigor pass.

## Recommendation

1. **Expand Playwright** (option 1). Keep it wired into `browser-compat.yml` (CI
   gate already exists; the self-hosted runner absorbs the extra cases).
2. **Do not** adopt Maestro/Appium for this web SPA.
3. **Defer** visual-regression to a separate initiative.

## Proposed follow-up work (filed as issues)

- **#1109** — add mobile viewport/device-matrix projects (small/large/landscape/
  tablet) to `playwright.config.ts`.
- **#1110** — add a mobile tap-target / no-vertical-cutoff assertion pass to
  `mobile-smoke`.
- **#1111** — add one mobile interaction-flow spec (drawer → navigate → open
  session → interact) under a mobile project.
- **#1112** (deferred) — evaluate a Playwright visual-regression snapshot layer.

These extend, and do not relitigate, the #257 mobile-parity decision.
