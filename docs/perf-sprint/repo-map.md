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
npm run gate:repo-map -- --max-persisted-bytes 20000   # override the size ceiling
```

| Metric | What it captures | Bound (budget key) |
|---|---|---|
| `unboundedPayloadBytes` | what the artifact serializes to with **no** size ceiling — the real growth signal | `unboundedPayloadMaxBytes` (max) |
| `retainedFiles` | ranked files surviving the persisted-size clamp | `retainedFilesMin` (min, absolute count) |
| `datasetPayloadBytes` | persisted-artifact size — **reported, never gated** (see below) | — |
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

#2472 widens the same bounded probe slice from 64 to 67 after its
declared-category parser and detector add legitimate dependencies to the
integrated working set. Against current master plus that slice, top-64 measures
129/168 (76.8%); top-65 and top-66 measure 130/168 (77.4%), only barely above
the unchanged 77% floor; and top-67 measures 131/168 (78.0%), restoring normal
gate headroom. This is a gate-only rebaseline for a larger working set: it does
not affect runtime output or claim that ranking quality improved.

### Why the persisted size is reported but not gated (#3452)

`enforceSizeLimit` binary-searches the largest prefix of the ranked file list that
fits `DEFAULT_MAX_PERSISTED_BYTES` and **drops the rest**, so the persisted size is
clamped to that ceiling by construction. The gate used to compare that clamped
value against `datasetPayloadMaxBytes` — the same 1,048,576 — which made the check
a tautology that could never fail, whatever the repo grew to. Growth was absorbed
by silently shedding ranked files rather than failing CI. `datasetPayloadMaxBytes`
is therefore **removed**; the clamped figure is still printed because it is what
ships, but a clamped value cannot carry a budget.

`retainedFilesMin` is an absolute **count**, not a percentage, on purpose:
retained-*share* falls with repo growth **by construction** (the byte ceiling is
fixed, so a constant-size artifact covers a shrinking fraction of a growing tree),
which would make a percentage floor a self-lowering ratchet needing renegotiation
with no regression having occurred — the pathology #3471 documents for
`localizationRecallMinPct`.

The count is **more robust, not immune**. It is bounded by `maxPersistedBytes` ÷ the
average retained entry size, so it holds while that average holds; a batch of
high-ranking files with large entries can displace several smaller ones and lower it
with no per-file bloat. What it does *not* do is drift down merely because the tree
got bigger.

The **500 floor** is a round number ~5 % below the measured 527, chosen to match the
~5 % headroom on `unboundedPayloadMaxBytes` rather than derived from a separate
measurement. It trips when the average retained entry size grows by roughly 5 %. If
ordinary churn starts tripping it, re-baseline deliberately with a note.

The gate honors the producer's `REPO_MAP_MAX_BYTES` (CLI `--max-persisted-bytes`
takes precedence), so it measures the ceiling that actually ships rather than the
built-in default — otherwise a 512 KiB deployment would be gated on a 1 MiB artifact
nobody has.

Note that `localizationRecallPct` and `rereadWasteTokensSaved` are computed on the
**unbounded** map, not the persisted one. That is conservative for recall rather
than inflationary (top-K sits far below the retained count, so every hit is present
in the shipped artifact), but it does mean the value metrics describe a larger
artifact than the one that ships — see #3471 and #3475.

`scripts/repo-map-gate.test.mjs` pins that the gate can fail: it asserts a non-zero
exit for an over-budget natural serialization, for shedding past the retained floor,
and for a missing budget key.

### Baseline (2026-06-09, this repo, 426 source files)

| Metric | Measured | Budget |
|---|---|---|
| dataset payload | 470,031 B | <= 1,048,576 B |
| cold ingest | ~2.5 s | <= 30,000 ms |
| localization recall (top-60) | 92 % | >= 80 % |
| reread tokens saved | 15,032 tok | >= 1,000 tok |

### Baseline (2026-07-29, this repo, 1,192 source files)

Re-measured while repairing the gate (#3452). Recorded because the 2026-06-09 row's
"dataset payload 470,031 B" no longer describes the artifact — the map has since
grown past its ceiling and is being trimmed to fit.

| Metric | Measured | Budget |
|---|---|---|
| payload (unbounded) | 1,759,234 B | <= 1,850,000 B |
| files retained | 527 of 1,192 (44.2 %) | >= 500 files |
| persisted payload | 1,047,416 B | not gated (clamped) |
| cold ingest | ~6.9 s | <= 30,000 ms |
| localization recall (top-78) | 77.6 % | >= 77 % |
| reread tokens saved | 84,564 tok | >= 1,000 tok |

The artifact currently sheds **664 of 1,192 ranked files (55.8 %)** to fit the 1 MiB
persisted ceiling. These baselines are **measured status quo, not targets** — the
shedding is a known-bad state tracked in #3475.

Raise a ceiling/floor in `repo-map-budget.json` deliberately, with a note on
why, when a change is a real win (a denser map, a legitimately larger root).
Otherwise, trim the regression.
