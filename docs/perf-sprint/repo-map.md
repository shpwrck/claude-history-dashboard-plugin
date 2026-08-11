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
| `localizationRecallPct` | share of the import graph's resolved edges whose target file falls in the ranked head (top-K, K = `localizationTopKPct` of the ranked count) | `localizationRecallMinPct` (min) + `localizationBaseline` (two-sided) |
| `rereadWasteTokensSaved` | reread/search tokens the bounded map saves vs. scanning the whole tree (reread-token waste over time) | `rereadTokensSavedMin` (min) |

The reread-waste model is a coarse ~4-chars/token estimate but monotonic — a
denser, better-ranked map saves more, a bloated/redundant one saves less.

### The localization probe (#3471 rebuild)

The probe was rebuilt after #3471 established that the original could not
report the negative result its label promised — the same cannot-fail defect
class as #3076 (a `NaN` threshold) and #3452 (the clamped-payload tautology):

1. **Its seeds were the head of the ranking under test** (`files.slice(0, 40)`),
   so the ground truth moved with the thing being measured; a genuine ranking
   regression could reshuffle the seed set and *raise* the score.
2. **Each seed counted itself as a touched file**, and seeds were top-ranked by
   construction, so a large share of "hits" were tautological. Measured on this
   repo: a fully **reversed** ranking still scored **34.8%**.
3. **An empty probe returned 100** — a perfect score for having measured
   nothing, which clears any floor by construction.
4. **It gated an absolute top-K**, and recall@K is monotonically non-decreasing
   in K, so "widen K by the minimum measured step" was guaranteed to be
   available on every future failure, without bound and without any change to
   ranking quality.

The relaxation ladder that resulted — recorded here as the motivation, moved
from the budget file's inline comments where it accumulated:

- **Floor lowered 3x:** 80 -> 79 (#2663), 79 -> 78 (#2707), 78 -> 77 (#2574).
- **Top-K widened 10x:** 63 -> 64 (#2716), 64 -> 67 (#2472), 67 -> 74 (#2710),
  74 -> 75 (#2318), 75 -> 76 (#2960), 76 -> 77 (#2951), 77 -> 78 (#3423),
  78 -> 83 (#3232), 83 -> 85 (#3086), 85 -> 86 (#3242/#3246/#3248).

Ten relaxations, and not one was accompanied by a ranking change — every entry
states it "touches no repo-map ranking, scoring, or extraction code". By the
end the gate sat exactly on its floor and failed on essentially any PR that
added a file to the ground-truth set: it measured repo growth, not
localization quality.

The rebuilt probe removes all four defects:

- **Every ranked file is a seed.** The seed set is the file list itself, so it
  is invariant under any permutation of the ranking, there is no sample knob to
  widen (`localizationSampleSize` is gone; its presence in a budget is a hard
  error), and a single added file cannot churn the seed set.
- **Ground truth is the resolved intra-repo import edges**, with each seed
  excluded from its own touched set. Recall is the share of edges whose target
  ranks inside the head. A reversed ranking now measures **0.0%**.
- **No evidence is `evaluable: false`** — an exit-2 error in gating mode, a
  reported non-result under `--measure-only`. Never a score.
- **K is a fraction** (`localizationTopKPct`, of the ranked file count), so
  repo growth widens the slice proportionally instead of mechanically
  depressing recall. The obsolete absolute `localizationTopK` key is a hard
  error. 7% preserves the slice width the old absolute knob had arrived at
  (K=86 on the 1,225-file tree where it was chosen; the fraction then scales
  with the tree).

These invariants are pinned directly: `scripts/lib/repo-map-probe.mjs` holds
the probe (it is part of the hashed ranking surface — editing it re-defines the
metric and forces a re-baseline), and `scripts/repo-map-gate.test.mjs` asserts
against hand-computed graphs that a reversed ranking scores 0, that a seed
never counts itself, that the denominator is invariant under ranking
permutations, and that the canonical synthetic corpus measures its
hand-computed edge count — so a reintroduced probe defect cannot silently
inflate the suite's self-measured baseline.

Stated honestly: this measures whether the imported files of the repo's import
graph sit in the ranked head — a structural self-consistency tripwire for the
ranking/extraction pipeline (broken import extraction, misordered hubs, and
resolution regressions all crater it), not real-session recall. The #889 join
can later substitute real sampled-history touched sets. The rebuilt recall
series is **not comparable** to pre-#3471 numbers: 77.x under the tautological
probe corresponds to ~67 honest.

### The relaxation control (#3510)

The ladder above is why the localization numbers are no longer plain JSON the
next failing stream can edit. `localizationBaseline` records the last
measurement — `recallPct`, `topKPct`, `rankingCodeSha256`, `date`, plus
informational provenance (`denominator`, `rankedFiles`, `measuredAtCommit` —
recorded, not validated). The hash covers the gate's `RANKING_SURFACE`: the
ranking/extraction sources (`src/lib/repo-map/generate.ts`, `parser.ts`,
`parser-output.ts`, `types.ts`), their local behavior-bearing dependencies
(`src/lib/bounded-fs.ts` — the walk determines the ranked file *set* and
therefore every in-degree — and `src/lib/secret-redaction.ts`), and the probe
definition itself (`scripts/lib/repo-map-probe.mjs`). Not covered: the
web-tree-sitter WASM grammar — a grammar swap surfaces only through the
measured value, not the sha.

**In-file checks** (stateless within one commit), in gating mode:

- **Two-sided reality anchor.** Measured recall must stay within
  `[recallPct - 1, recallPct + 3]` of the record. A drop past the down
  tolerance is a failure (exit 1): the hashed ranking surface is unchanged, so
  it is either a ranking-adjacent regression (fix it) or honest composition
  drift — see the sanctioned path below. A rise past the up tolerance means
  the record is stale or was sandbagged low: ratchet
  `localizationBaseline.recallPct` **up** to the measured value. The baseline
  cannot quietly detach from reality in either direction.
- **Ranking changes must re-measure.** If the ranking-surface sha differs from
  the record, the gate refuses to run (exit 2) until `localizationBaseline` is
  re-recorded — so a ranking/extraction change carries its measured
  before/after pair in the same commit. Run
  `npm run gate:repo-map -- --measure-only`; it prints a ready-to-paste
  baseline candidate.
- **`localizationTopKPct` must equal the baseline's**, and the floor may sit
  at most 5 points below the recorded `recallPct` (exit 2 otherwise).

**Cross-commit checks** — the part that actually stops the ladder. The in-file
checks alone accept a *paired* JSON edit (baseline lowered together with the
floor, or the fraction widened in both places with a stale recorded value) —
both were demonstrated in review. So the gate also reads the budget's committed
prior copy at the **trust anchor — `origin/master`** (CI fetches that ref fresh
before running the gate, so local history amending cannot alter it;
`REPO_MAP_PRIOR_BUDGET_REF` overrides for odd topologies, `HEAD` is the local
fallback, and an unresolvable prior is skipped with a printed note, never
silently). Relative to that prior:

- **Lowering `localizationBaseline.recallPct` fails** unless the new value
  matches the freshly measured probe within the down tolerance — "fresh
  measurement in the same commit" made machine-checkable, because measured
  reality is the one thing a JSON edit cannot move.
- **Moving `localizationTopKPct` fails** under the same fresh-match rule: a
  widened slice must *record* the (monotonically higher) fresh number, so
  widening raises the future regression bar instead of buying slack — the
  inversion of the old ladder's escape hatch.
- **Lowering `localizationRecallMinPct` fails** unless the recorded baseline
  legitimately moved down in the same commit, and by at least as much. The
  floor follows a fresh re-baseline; it never moves on its own.

**The sanctioned response to composition drift** (a measured drop caused purely
by many added/removed leaf files, no ranking change): re-record
`localizationBaseline.recallPct` at the fresh `--measure-only` value in the
same commit, let the floor follow by at most the same distance, and say so in
the PR. The gate verifies the fresh match against the prior — so when this
happens it is a documented, machine-checked decision instead of a norm
violation (the failure mode that normalized the original ladder).

**Honest bound on the residual — this is a bounded control, not an absolute
one.** Because "fresh" is a ±1-point tolerance, a re-baseline can still be
recorded up to 1 point below measured reality, buying at most 1 point of
regression slack. That residual is (a) bounded by the down tolerance, (b)
always visible as a `repo-map-budget.json` diff against `origin/master`, and
(c) non-compounding: the next downward move is checked against then-current
measured reality, which JSON edits cannot change. The tolerances themselves
live as named constants in the reviewed gate script, not in the budget JSON —
the JSON is the surface all ten historical relaxations edited.

`scripts/repo-map-gate.test.mjs` proves both directions of the #3510
acceptance: the demonstrated paired bypasses (baseline+floor lowered together;
topKPct widened in both places with a stale record) fail against a committed
prior; unpaired relaxations (stale-high baseline, sandbagged-low baseline,
changed ranking surface without re-record, widened fraction without re-record,
detached floor, obsolete knobs, non-evaluable probe) fail with the right exit
code; and the legitimate paths (a widening that records its fresh measurement,
a fresh downward composition re-baseline with the floor following by no more
than the same distance) pass.

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
**unbounded** map, not the persisted one. Per ADR 0020 that is deliberate and
conservative rather than inflationary: `enforceSizeLimit` keeps a *prefix* of the
ranking, so the top-K head the probe scores against is byte-identical in the
persisted and unbounded maps, while unbounded seeding also scores edges out of the
shed tail that the shipped artifact never claims to answer.

### The shedding is a decision, not a defect (ADR 0020 / #3475)

#3452 made visible that the artifact sheds the low-rank tail of the ranking —
527 of 1,191 ranked files retained at measurement — to fit its 1 MiB per-root
ceiling. ADR 0020 resolves the #3475 product call: the persisted artifact **is a
head-of-ranking structural index**, deliberately. The ceiling stays (it bounds
the payload each ingested root contributes, and the trim drops the *least
referenced* tail first, which is the intended ordering); the `retainedFilesMin`
count floor guards against collapse; and if that floor ever trips — or a
localization regression is traced to shedding — the escalation is
**densification** (fewer bytes per retained entry), not a ceiling raise. Do not
raise the ceiling to chase retention.

### Producer/gate env parsing is fail-closed (#3477)

`scripts/repo-map-generate.mjs` used to read every `REPO_MAP_*` size override as
`Number(env) || DEFAULT`, so `REPO_MAP_MAX_BYTES=12g` (`Number('12g')` is `NaN`)
silently shipped a default-sized 1 MiB artifact, and `0`/negatives were swallowed
the same way — the fourth instance of the fail-open-parse class #3076 removed
from the cold-ingest bench, and a divergence from the gate, which PR #3476 made
fail-closed. Producer and gate now share the #3076 `envNumber` parser for
`REPO_MAP_MAX_BYTES`, `REPO_MAP_MAX_FILES`, `REPO_MAP_MAX_DIR_ENTRIES`,
`REPO_MAP_TOKEN_BUDGET`, and (producer-side) `REPO_MAP_FILE_CACHE_MAX_BYTES`: a
set-but-unusable value exits non-zero with the offending name, never a silent
default. `scripts/repo-map-generate.test.mjs` pins it.

`scripts/repo-map-gate.test.mjs` pins that the gate can fail: it asserts a non-zero
exit for an over-budget natural serialization, for shedding past the retained floor,
for a missing budget key, for a probe with no evidence, and for every unjustified
localization relaxation shape (#3510).

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

The artifact sheds the ranked tail to fit the 1 MiB persisted ceiling — at this
measurement, 664 of 1,192 ranked files (55.8 %). Per ADR 0020 (above) that is
the accepted head-of-ranking-index steady state, with densification as the
escalation path.

### Baseline (2026-07-31, this repo, 1,234 source files)

Re-measured for the #3471 probe rebuild (on the tree rebased past the #3478
gate-harness batch — whose nine added script files moved honest recall by just
0.1 points, the composition stability the rebuild was designed for). The
localization row is the first honest measurement — **not comparable** to the
77.x series above, which the tautological probe produced (its reversed-ranking
score was 34.8%; the rebuilt probe's is 0.0%).

| Metric | Measured | Budget |
|---|---|---|
| payload (unbounded) | 1,826,507 B | <= 1,850,000 B |
| files retained | 538 of 1,234 (43.6 %) | >= 500 files |
| persisted payload | 1,048,394 B | not gated (clamped) |
| cold ingest | ~8-10 s | <= 30,000 ms |
| localization recall (top 7 % = 87) | 66.7 % (2,251/3,373 edges) | >= 65 %, baseline-anchored (#3510) |
| reread tokens saved | 88,082 tok | >= 1,000 tok |

Note the unbounded payload has ~2 % headroom left against its 1,850,000 B
ceiling; when ordinary growth trips it, raise it deliberately with a note — that
ceiling is a growth alarm, not part of the ADR 0020 shipped-size decision.

### Baseline (2026-08-03, this repo, 1,239 source files)

Round 14 re-measured current `origin/master` plus this batch before changing the
budget: `1,834,729 B` left only `15,271 B` (0.83%) under the `1,850,000 B`
growth-alarm ceiling. The tree's ranking surface hash and honest 66.7%
localization score were unchanged; this was ordinary repository composition
growth, not a ranking or extraction
regression. The ceiling is deliberately re-baselined to `1,925,000 B`, 4.9%
above the measured natural serialization. The shipped 1 MiB persisted ceiling
is unchanged.

| Metric | Measured | Budget |
|---|---|---|
| payload (unbounded) | 1,834,729 B | <= 1,925,000 B |
| files retained | 537 of 1,239 (43.3%) | >= 500 files |
| persisted payload | 1,045,857 B | not gated (clamped) |
| cold ingest | 7,204.7 ms | <= 30,000 ms |
| localization recall (top 7% = 87) | 66.7% (2,262/3,390 edges) | >= 65%, baseline-anchored (#3510) |
| reread tokens saved | 88,517 tok | >= 1,000 tok |

### Baseline (2026-08-09, current open-PR batch, 1,284 source files)

Ordinary repository growth consumed the Round 14 headroom: PR #3710 measured
`1,924,988 B`, only 12 B below the `1,925,000 B` growth alarm, and the
largest current stacked branch measured `1,928,379 B`. The ranking surface
hash was unchanged and every retention, localization, and reread-value bound
still passed. The ceiling is deliberately re-baselined to `2,025,000 B`, 5.0%
above the largest measured natural serialization. The shipped 1 MiB persisted
ceiling is unchanged.

| Metric | Measured | Budget |
|---|---|---|
| payload (unbounded) | 1,928,379 B | <= 2,025,000 B |
| files retained | 540 of 1,284 (42.1%) | >= 500 files |
| persisted payload | 1,029,013 B | not gated (clamped) |
| cold ingest | 7,769.9 ms | <= 30,000 ms |
| localization recall (top 7% = 90) | 66.5% (2,313/3,480 edges) | >= 65%, baseline-anchored (#3510) |
| reread tokens saved | 93,276 tok | >= 1,000 tok |

Raise a ceiling/floor in `repo-map-budget.json` deliberately, with a note on
why, when a change is a real win (a denser map, a legitimately larger root).
Otherwise, trim the regression. The localization floor and slice are the
exception: they move only under the #3510 baseline contract above.
