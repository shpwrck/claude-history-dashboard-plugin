# Perf sprint - server-scale budget (#1099, epic #1157)

Server mode is the primary path for large live histories. This gate measures the
path a real server-mode page load depends on: a fresh Node server process reads a
large synthetic `~/.claude` tree and serves the first `/api/dataset.json`
response.

## What's Measured

`scripts/server-scale-budget.mjs` builds a temporary synthetic Claude home,
starts `scripts/server.mjs` against it, waits for `/healthz`, and then loads the
dataset route over HTTP with identity encoding. That captures server import and
boot cost, cold ingest, dataset assembly, JSON serialization, compression cache
construction, and the full response body transfer.

After the HTTP route check, the same script exercises `scripts/ingest.mjs`
directly with a separate SQLite cache path. That keeps the lower-level
diagnostics visible: cold ingest time, `assembleDataset()`, `safeJsonStringify`,
unchanged re-ingest, dataset bytes, and retained heap/RSS growth.

## Target Scale

The committed target is in `server-scale-budget.json`:

| Dimension | Target |
|-----------|-------:|
| Sessions | 1200 |
| Extra scale turns per session | 3 |
| Project ids | 120 |
| Users | 60 |
| Teams | 12 |
| Transcript bytes | about 19.6 MB locally |

The fixture is deterministic. It starts from `buildSampleCorpus()` in
`scripts/sample-data/build-corpus.mjs`, clones those parser-coverage sessions
across the configured organization shape, and adds scale-specific request,
assistant, and tool-result turns. It never reads the maintainer's live
`~/.claude`.

## Budget

`server-scale-budget.json` is the source of truth. The initial ceilings are
deliberately above the 2026-06-11 local baseline to absorb GitHub runner
variance while still catching large regressions:

| Metric | Ceiling |
|--------|--------:|
| Server boot | 6000 ms |
| Cold `/api/dataset.json` load | 12000 ms |
| Direct cold ingest | 8000 ms |
| `assembleDataset()` | 3000 ms |
| Dataset serialization | 2000 ms |
| Unchanged re-ingest | 1200 ms |
| Dataset JSON bytes | 18000000 B |
| Retained heap growth | 100000000 B |
| Retained RSS growth | 220000000 B |

Raise a ceiling only deliberately, with a dated `//...` note in the budget file
explaining the accepted scale increase or unavoidable eager server-path growth.

## Baseline

Measured locally on 2026-06-11:

| Metric | Result |
|--------|-------:|
| Transcript bytes | 19610362 B |
| Server boot | 717.1 ms |
| Cold `/api/dataset.json` load | 2312.3 ms |
| Direct cold ingest | 1054.1 ms |
| `assembleDataset()` | 583.6 ms |
| Dataset serialization | 157.9 ms |
| Unchanged re-ingest | 64.1 ms |
| Dataset JSON bytes | 13188963 B |
| Retained heap growth | 48405744 B |
| Retained RSS growth | 85778432 B |

## Running It

```sh
# Build the server-flavor bundle, then run the guard.
npx vite build
npm run gate:server-scale

# Try a different committed or experimental budget.
node --expose-gc --import ./scripts/register-ts.mjs scripts/server-scale-budget.mjs --budget ./server-scale-budget.json

# Re-baseline dimensions temporarily.
DASHBOARD_SCALE_SESSIONS=2000 npm run gate:server-scale
```

## CI

`.github/workflows/server-scale.yml` runs on every PR push, skips docs-only
changes, builds the server bundle with `npx vite build`, and runs
`npm run gate:server-scale`. It is the server-mode sibling of
`.github/workflows/cold-load.yml`: cold-load guards first paint of the published
SPA, while server-scale guards the live server dataset path at a large history
size.
