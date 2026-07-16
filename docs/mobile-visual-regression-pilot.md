# Mobile Visual Regression Pilot

Issue #1112 evaluated whether Playwright screenshot snapshots should be added
on top of the existing mobile parity checks.

## Scope

The pilot is intentionally small and opt-in:

- Views: Overview, Sessions, Tokens.
- Viewports: 390 x 844 mobile Chromium and 1440 x 900 desktop Chromium.
- Target: the upload SPA bundle with generated sample data.
- Assertion: first-viewport `toHaveScreenshot()` snapshots.

The committed harness lives outside the blocking browser-compat path:

- `playwright.visual-pilot.config.ts`
- `e2e/visual-pilot/mobile-visual-pilot.pilot.ts`
- `e2e/visual-pilot/mobile-visual-pilot.pilot.ts-snapshots/`

The `.pilot.ts` suffix is deliberate. The default `playwright.config.ts`
discovers `*.spec.ts` tests only, and `.github/workflows/browser-compat.yml`
does not reference the visual-pilot config.

## How To Run

Build the SPA sample-data target, then run the opt-in pilot:

```sh
npm run build:spa -- --outDir dist-spa
npm run test:e2e:visual-pilot
```

Refresh baselines after an intentional visual change:

```sh
npm run build:spa -- --outDir dist-spa
npm run test:e2e:visual-pilot:update
```

To prove the guard catches drift, run the canary. It injects a 12px magenta
border at the top of `main`, so failure is expected:

```sh
CHD_VISUAL_PILOT_DRIFT=1 npm run test:e2e:visual-pilot
```

## Pilot Results

Baseline capture:

- `npm run test:e2e:visual-pilot:update`
- Result: 6 snapshots written and 6 tests passed.

Baseline verification:

- `npm run test:e2e:visual-pilot`
- Result: 6 tests passed.

Drift canary:

- `CHD_VISUAL_PILOT_DRIFT=1 npm run test:e2e:visual-pilot`
- Result: expected failure, 6 / 6 snapshots failed.
- Observed deltas: roughly 3% to 8% of pixels, depending on view and viewport.

This proves the snapshot layer catches spacing-level drift that the functional
mobile smoke checks do not measure.

## Maintenance Assessment

The pilot creates six Linux Chromium PNG baselines. That is manageable for a
manual pilot, but it introduces a review obligation every time the dashboard
shell, sample data, fonts, or PatternFly rendering changes.

Cross-runner stability is not proven. The snapshots were generated and
verified on one local Linux environment. Promoting this to CI would require
stable runner pinning, a clear baseline-refresh workflow, and agreement that
pixel diffs are worth the extra PR review surface.

## Recommendation

Do not make visual snapshots a blocking CI gate yet.

Keep the opt-in pilot for high-risk layout changes and re-run it manually when
mobile spacing, masthead/sidebar chrome, dense tables, or dashboard typography
changes. Reconsider a blocking gate only after the same baselines have stayed
stable across several intentional local reruns and at least one dedicated
self-hosted browser runner.

