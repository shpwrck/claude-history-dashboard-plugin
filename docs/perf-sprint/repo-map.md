# Repo Map measurement gates + persistence hardening (#893)

The Repo Map (epic #871, ADR 0007) is a host-generated structural artifact the
read-only runtime consumes. Without explicit gates it can balloon cold-ingest
cost, grow the dataset payload, leak source bodies, or quietly stop earning the
reread/search reduction it exists for. #893 hardens the artifact along all four
axes and adds a runnable gate so a regression fails CI instead of shipping.

## Persistence hardening (`src/lib/repo-map/cache.ts`)

- **Cache by project root + git sha / mtime.** The producer
  (`scripts/repo-map-generate.mjs`) stamps each artifact with a
  `RepoMapCacheKey { root, gitSha, maxMtimeMs }`. On the next run
  `isCacheValid()` reuses the persisted map when the signature is unchanged:
  a clean repo compares the git sha (a moved HEAD invalidates regardless of
  mtimes); a dirty/non-repo root (`gitSha: null`) falls back to the max
  source-file mtime watermark, so an uncommitted edit still invalidates. Pass
  `--force` to regenerate unconditionally.
- **Enforced size limit on the persisted map.** `enforceSizeLimit()` bounds the
  serialized artifact to `REPO_MAP_MAX_BYTES` (default 1 MiB,
  `DEFAULT_MAX_PERSISTED_BYTES`). The structured `files` are ranked
  most-referenced-first, so it binary-searches the largest ranked prefix that
  fits and drops the lowest-rank tail, re-rendering the text fragment so it never
  references a dropped file. The outcome is recorded (`sizeBounded`,
  `droppedFiles`) on the persisted envelope.
- **Bounded source discovery.** `generateRepoMap()` caps retained source files at
  `REPO_MAP_MAX_FILES` (default 4000) and directory entries inspected during the
  walk at `REPO_MAP_MAX_DIR_ENTRIES` (default 100000), so a huge repo directory
  cannot be read completely before the file cap applies.
- **No-body-leakage guard.** `assertNoBodyLeakage()` scans the serialized
  artifact for caller-supplied body/config sentinels — the regression guard for
  the privacy invariant: the artifact carries paths, signatures, headings,
  references, hashes/mtimes, and bounded excerpts only, never a source body or a
  literal config/secret value. Covered by `src/lib/repo-map/cache.test.ts`
  (real WASM-parsed map + a simulated leak).

## Measurement gates (`scripts/repo-map-gate.mjs`, `repo-map-budget.json`)

Run the gate host-side (it generates the map, which needs the WASM grammars):

```
npm run gate:repo-map                 # gate this repo against repo-map-budget.json
npm run gate:repo-map -- --measure-only   # print numbers, do not gate
npm run gate:repo-map -- --root <dir> --json out.json
```

| Metric | What it captures | Bound (budget key) |
|---|---|---|
| `datasetPayloadBytes` | persisted-artifact size (dataset payload delta) | `datasetPayloadMaxBytes` (max) |
| `coldIngestMs` | walk + parse + render from cold (cold ingest/build cost) | `coldIngestMaxMs` (max) |
| `localizationRecallPct` | share of a task's touched files that fall in the map's top-K ranked slice — the map's top-ranked files vs the files a session actually touches | `localizationRecallMinPct` (min) |
| `rereadWasteTokensSaved` | reread/search tokens the bounded map saves vs. scanning the whole tree (reread-token waste over time) | `rereadTokensSavedMin` (min) |

Localization quality samples task working-sets deterministically from the map's
own import graph (a hub file plus everything it imports = one "session's" touched
set), so the gate is reproducible without reaching into live history; the
#889 join can later substitute real sampled-history touched sets. The
reread-waste model is a coarse ~4-chars/token estimate but monotonic — a denser,
better-ranked map saves more, a bloated/redundant one saves less.

`localizationTopK` is the synthetic probe's bounded ranked-slice width, separate
from the recall floor and the token-bounded runtime fragment. #2716 widens it
from 63 to 64 after the canonical leave-behind validator and dependency-light
permission upload parser added two legitimate direct dependencies to the
integrated working set: `recommendations.ts` -> `project-identity.ts` and
`parse-permissions.ts` -> `leave-behind.ts`. On master, top-63 measures 127/160
(79.4%); the integrated set measures 127/162 (78.4%) at top-63 and 128/162
(79.0%) at top-64, preserving the existing 79% floor. This gate-only
recalibration does not change runtime output or claim an improvement in ranking
quality.

### Baseline (2026-06-09, this repo, 426 source files)

| Metric | Measured | Budget |
|---|---|---|
| dataset payload | 470,031 B | <= 1,048,576 B |
| cold ingest | ~2.5 s | <= 30,000 ms |
| localization recall (top-60) | 92 % | >= 80 % |
| reread tokens saved | 15,032 tok | >= 1,000 tok |

Raise a ceiling/floor in `repo-map-budget.json` deliberately, with a note on
why, when a change is a real win (a denser map, a legitimately larger root).
Otherwise, trim the regression.
