# Bundle-budget contract (structural gate)

**Status:** active since #1852 Phase C (#1859 + #1861). Decision: [ADR 0016](./adr/0016-bundle-budget-classes.md).
Enforced by [`scripts/check-bundle-size.mjs`](../scripts/check-bundle-size.mjs) (`evaluateStructuredBudget`),
configured by [`bundle-budget.json`](../bundle-budget.json), and wired into the
`.github/workflows/ci.yml` `build` job for the server flavor. The former
upload-only budget was retired by #3735; the public sample retains isolation and
cold-load gates without a second frozen byte budget.

## Why this exists

The old gate was a single rising `totalJsMaxBytes`. Every `dist/assets/*.js` — the eager entry,
shared vendor splits, and every lazy route chunk — summed into one number. A **new lazy route**
(the *correct* way to add a feature) inflated that total exactly as much as eager bloat did, so it
triggered the same "justify-and-raise the ceiling" ritual. That ritual produced **44 dated bump
notes in `bundle-budget.json` in June alone** — that changelog *was* the warp. The total carried no
signal: it could not tell first-paint cost from intentional, off-the-critical-path lazy growth.

## The model: three independent classes, never summed

Every emitted chunk falls into exactly one class, and each class is gated on its own.

| Class | What | Gate | Changes when |
|-------|------|------|--------------|
| **shell** | the FROZEN eager first-paint set (`shell.chunks`, e.g. `["index"]`) | summed size vs `shell.maxBytes` | only via an **ADR** — never a per-PR bump |
| **vendor** | FROZEN shared third-party chunks (`vendor.chunks`, a `{name: maxBytes}` map) | each chunk vs its own ceiling | a **dependency** change, never a feature |
| **route** | every other (lazy) chunk | each vs `routes[name]`, or `defaults.routeMaxBytes` when unbudgeted | adding/raising **one** route's own cap |

There is **no gated global total.** `defaults.totalAdvisoryMaxBytes` is computed and printed for
visibility but never fails CI.

**The invariant that kills the warp:** a new feature ships as a new lazy route chunk under its own
cap (or the shared default). Because route caps are never summed into anything, a new route
*physically cannot* inflate a shared number — there is no shared number to inflate. The bump ritual
has nothing to grow.

## How to … (the only edits you should ever make)

- **Add a feature/view.** Do nothing to the budget if its lazy chunk is under `defaults.routeMaxBytes`
  (currently 40 KB) — the gate auto-passes it and prints `NEW (default cap)`. If it is genuinely
  heavier, add one explicit `routes["YourChunk"]` entry sized to it. That edit affects *only* that
  route.
- **A route legitimately grew.** Raise *that one* `routes[name]` cap. Not a global anything.
- **A dependency got heavier.** Raise the relevant `vendor.chunks[name]` ceiling — and say so in the
  commit. This is the one place a third-party bump is recorded.
- **First paint got heavier (`shell` failed).** Do **not** raise `shell.maxBytes`. A shell failure
  means new code landed in the eager graph — find the missing `lazy()` / barrel import / eagerly-imported
  detector and defer it. The shell cap is frozen on purpose; raising it requires an ADR.

## Chunk-name matching

Budgets key on a chunk's **logical name** = filename minus the trailing `-<8-char hash>.js`
(`chunkBaseName`). Matching is **exact** (so `index-worker` never folds into `index`). A budgeted
chunk in any class that is absent from the build is a **failure** (rename guard) — so a renamed heavy
chunk self-reports instead of silently going unguarded.

## Seeding / re-baselining numbers

All caps are seeded from a measured build (and the #1860 composition report), never invented. The
current values came from `origin/master` @ `e321189`. When re-baselining, build the server flavor, measure,
and set caps to measured + the established small headroom. The shell cap is deliberately **not**
re-baselined upward casually — #1858 *tightens* it after #1856 evicts non-first-paint code from `index`.

## History

The pre-v2 single-total gate and its 44-entry bump-note changelog live in the git history of
`bundle-budget.json`. The terminal bump note already declared itself the last instance of the ritual.
