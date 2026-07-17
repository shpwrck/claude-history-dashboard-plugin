# Perf sprint — cold-load budget (#663, epic #638)

Sibling of the bundle-size budget (#664): bundle-size caps how many bytes ship,
this caps how long a **cold first load** takes to *paint* and become
*interactive* — the user-felt number a render-blocking import, an eager chunk
pulled onto the boot path, or a change to `index.html` / `src/main.tsx` can blow
without tripping the byte budget.

## What's measured

Per SPA flavor, against the **published build** served by `vite preview` (not
dev — dev's unbundled module graph is not representative):

- **First Contentful Paint (FCP)** — the first paint of real content. Captured
  via a buffered `PerformanceObserver` for `type: 'paint'` armed *before*
  navigation. (Reading `performance.getEntriesByType('paint')` after `load`
  fires is unreliable in headless Chromium — the entry is intermittently not yet
  flushed, yielding a spurious `null` that would make a CI gate flaky.)
- **Time-to-Interactive (TTI) proxy** — `domInteractive` from the Navigation
  Timing API: the moment the parser finished and the document is interactive. A
  true longtask-based TTI needs sustained network- and CPU-idle heuristics that
  are noisy in a no-server sample-data SPA; `domInteractive` is the stable,
  repeatable proxy.
- **Content-Painted (CP)** — the time until `#root` first has a *rendered child
  element*, captured by a `MutationObserver` armed before the app bundle runs.
  This is the real "user sees content" signal. **Why it was added (#1867):** the
  app ships `<body>` as an empty `<div id="root">`, so FCP fires on a *blank*
  page — the first paint is of nothing. FCP is therefore structurally blind to
  the moment content actually appears, which only arrives after ~430 KB of JS
  plus a fetch/unzip/parse pipeline has run. A regression that doubled the boot
  pipeline could sail under the 700 ms FCP ceiling untouched. CP closes that gap:
  it tracks the JS+parse cost FCP cannot see. FCP and TTI are kept alongside it
  so a blank-paint regression (e.g. a render-blocking import that delays even the
  first frame) stays visible too.
- **Cumulative Layout Shift (CLS, #1575)** — the sum of *unexpected* (no
  recent-input) `layout-shift` values on the default home view (DigestSpine),
  accumulated from first paint through a 3 s settle window. CLS is a unitless
  ratio, not a millisecond count; the Core Web Vitals "good" threshold is < 0.10.
  **Why it was added:** the home digest mounts *before* the async sample-data
  parse completes, then injects its verdict `pf-m-inline` Alert and the
  ranked-finding sections — a late settle that shifts everything below it unless
  the boxes reserve their space. The fix reserves a min-height for the verdict
  Alert so its empty-state→findings title swap (one line → two) repaints in place.
  Gated per flavor via `clsMaxBudget` in `cold-load-budget.json` (0.10).
  **Honest scope caveat:** the original ~0.28 finding (adversarial review
  `perf-render-cls-1`) was on the *real-server-data* slow-fetch path. CI/preview
  has **no `~/.claude` mount**, so the gate can only exercise the bundled-sample
  path, where post-fix CLS measures ~0.0000 (both flavors) — and ~0.0009 even
  under `--cpu-throttle 6`. The same reservation fix hardens both paths; the gate
  locks the measurable (sample) path at "good" and catches any regression that
  reintroduces shift there, rather than reproducing the un-mountable real-data
  number.
- **Largest Contentful Paint (LCP)** — captured opportunistically from the
  `largest-contentful-paint` observer and *reported as a cross-check, not gated*.
  It can be `null` for tiny content and is noisier than CP, so it informs but
  does not block.

> **Note on local vs. deployed numbers.** Against `vite preview` the bundle and
> its sample data are served from local disk with no network, so locally CP and
> FCP land close together (both sub-200 ms). On the *deployed, networked* site
> the same fetch/unzip/parse pipeline is seconds-scale — that is the cold
> experience CP is structurally able to represent and FCP is not. The gate runs
> against `vite preview` (no network) for repeatability; CP's value is that the
> metric tracks DOM content rather than blank paint, so a boot-path regression
> shows up in it even on the local harness.

**Optional CPU throttling.** `--cpu-throttle N` applies a CDP
`Emulation.setCPUThrottlingRate` slowdown so the JS-bound boot path (the real
cold cost FCP can't see) resembles a mid-tier client. It is **off by default**
(rate 1) to keep the CI baseline stable and repeatable; it is a local
investigation aid. Under `--cpu-throttle 6` the upload-SPA CP rose from ~169 ms
to ~896 ms locally, confirming CP responds to a slower CPU where blank-root FCP's
signal is muddied.

Each flavor is loaded several times in a **fresh browser context per run** (no
warm HTTP/disk/module cache carried over), with **one discarded warmup load**
first — the very first navigation after a browser launch pays a one-time
JIT/first-compositor-frame cost that is not representative of a steady cold load.
The **median** of the remaining runs is the reported number.

The two flavors build into separate outDirs (`dist-server`, `dist-spa`) so the
builds don't clobber each other, and preview on fixed, distinct ports (server →
4473, upload SPA → 4474) so both can be measured in one run.

## Baseline (FCP/TTI measured 2026-06-05; CP measured 2026-06-17, local dev box)

Five cold loads per flavor after a discarded warmup; medians:

| Flavor       | FCP (median)      | TTI / `domInteractive` (median) | CP / content-painted (median) |
|--------------|-------------------|---------------------------------|-------------------------------|
| server SPA   | ~110 ms           | ~15 ms                          | ~104 ms                       |
| upload SPA   | ~180 ms           | ~14 ms                          | ~169 ms                       |

(The original FCP/TTI baselines were ~200 ms / ~185 ms; the CP-run remeasure on
the same harness landed FCP a touch lower — local hardware/version drift, well
within the gate's headroom.) These are local numbers; the GitHub Actions
`ubuntu-latest` runner is a slower, noisier machine, so absolute values there
will be higher and more variable.

## Budget (`cold-load-budget.json`)

| Flavor       | `fcpMaxMs` | `ttiMaxMs` | `cpMaxMs` |
|--------------|-----------:|-----------:|----------:|
| server SPA   | 700        | 300        | 1500      |
| upload SPA   | 700        | 300        | 1500      |

**Why not a tight `baseline × 1.4`?** The natural formula would put the server
FCP ceiling at ~285 ms and the TTI ceiling at ~18 ms. That's a footgun for a CI
gate: the runner is different (and slower) hardware than the box the baseline was
taken on, and an 18 ms TTI ceiling is below the jitter of a single scheduler
blip. The ceilings here keep real headroom over both the local baseline and
expected CI hardware variance, while still catching a *regression* — a
render-blocking import or an eager boot-path chunk would roughly double or worse
these numbers and trip the gate well under 700 ms / 300 ms. Tighten the ceilings
once a CI baseline is observed if you want a snugger gate; raise them
**deliberately, with a note on why**, when growth is genuinely justified.

**Why `cpMaxMs` is set extra-generously (1500 ms over a ~169 ms baseline).**
Content-Painted waits on the entire JS+parse boot pipeline — exactly the
seconds-scale cost blank-root FCP could not see — so it is both the most
*meaningful* of the three metrics and the *noisiest* on slow CI hardware (it
compounds JS download, parse, hydrate, and first mount). A ~9× headroom keeps it
from flaking on a busy runner while still tripping the moment a regression pushes
real content past ~1.5 s, which would be a serious cold-load degradation. As with
the others, tighten once a CI baseline is observed.

## #2444 instant-load shell — why the budgets did NOT change

#2444 (epic #1852, Layer B) injects the above-the-fold shell into the
**server-flavor** `index.html`: the vite build bakes a skeleton shell into `#root`
(so the harness path paints at parse), and `scripts/server.mjs` upgrades it to real
KPIs at runtime (a plain module-var read + string splice — it never triggers a
dataset assemble, so the HTML serve stays ~2–4 ms). React then hydrates the shell
(`dangerouslySetInnerHTML`, so no mismatch) and flips to the real app.

**The harness under-measures this win, by construction.** The `server` flavor is
`vite build --outDir dist-server` served by `vite preview` — a *static* build with
**no `~/.claude` mount**, so `serveStatic`'s runtime upgrade never runs and the
empty app already mounted fast. Measured locally: server CP `107 → 95 ms`, FCP
`116 → 112 ms`, CLS stays `0.0000`. That ~12 ms CP delta is within CI noise, and no
sane `cpMaxMs` distinguishes shell-from-no-shell on the data-less harness path
(both land ~100 ms). So the cold-load budgets are **left unchanged** — tightening
them here would be false precision, not a real gate.

**The real win is on the deployed server path** (real data), which this harness
cannot exercise. Measured directly against `scripts/server.mjs` over real
`~/.claude` data: cold-load CP `~343 → ~146 ms`, with the real KPIs
(e.g. `874 sessions`) present in `#root` **before any JS runs**. The meaningful
regression guards for the shell are therefore `src/lib/instant-shell.test.ts` (the
render/inject/rewrite contract) and the vite-plugin wiring test
(`src/vite-plugin-instant-shell.test.ts`), not a cold-load ceiling.

## Running it

```sh
# Both flavors: build, measure, gate (exits non-zero if over budget)
node scripts/cold-load-measure.mjs
# or via the npm script:
npm run measure:cold-load

# One flavor only
node scripts/cold-load-measure.mjs --flavor spa

# Reuse existing dist-server/ + dist-spa/ (skip the build)
node scripts/cold-load-measure.mjs --no-build

# Just print the numbers, no gate (use this to re-baseline)
node scripts/cold-load-measure.mjs --measure-only --json cold-load-results.json

# Local investigation: throttle the CPU ×N (CDP) to surface JS-bound boot cost
node scripts/cold-load-measure.mjs --flavor spa --measure-only --cpu-throttle 6
```

## CI

`.github/workflows/cold-load.yml` runs the gate on every PR push and on `master`.
It mirrors `ci.yml`/`test.yml` (checkout, `setup-node@v4` node 22 + npm cache,
`npm ci`) plus one step to install the Chromium browser
(`npx playwright install --with-deps chromium`). A median over a flavor's ceiling
— FCP, TTI, or CP — fails the job and names which flavor/metric regressed. Like the lint/build/test
checks it is advisory until merge-gating is enabled on the repo (see the note in
`ci.yml`).
