# ADR 0022: Assemble server datasets lazily by key

- Status: Accepted
- Date: 2026-08-11
- Decision issue: #3674
- Parent epic: #2999
- Prerequisite: #3000's instantiable-ingest track (landed in #3677-#3679)

## Context

The server already exposes a small `/api/dataset/boot` response and one
`/api/dataset/slice/<key>` response per heavy key. That split improves the wire
path, but not the server's work. Both `buildBootPayload()` and
`buildSlicePayload()` call `memoizedAssembleDataset()`, which materializes every
top-level dataset key before discarding all but the requested projection. A
request for one slice therefore retains the cost and coupling of the old
`/api/dataset.json` monolith.

The client also currently passes every advertised slice to `fetchSlices()`
immediately after boot. #3122 bounded the worker path to three concurrent
fetch-and-parse operations, which limits browser peak memory, but it still asks
the server to build every key during one cold load. Per-key server functions
without demand-driven client requests could therefore replace one full build
with a burst of 20 projection builds and fail to realize the intended saving.

The question is whether to keep that full assembly and enforce ceilings, or make
the server assemble only the boot projection or slice that was requested. This
ADR chooses the target architecture. It does not change product code.

## Measurements

All measurements below were taken on commit
`029562301927299056491be7eddb62870da30fbe` on 2026-08-11. They describe three
different scopes and must not be combined into one benchmark.

### Live local corpus: serialized field concentration

`node scripts/dataset-field-sizes.mjs --base http://127.0.0.1:5173 --json`
measured the deployed server's real local `/api/dataset.json` body:

| Field | Serialized bytes | Share |
| --- | ---: | ---: |
| `timelines` | 21,501,433 | 32.48% |
| `toolData` | 15,360,096 | 23.20% |
| `tokenData` | 8,915,797 | 13.47% |
| `repoMap` | 6,830,332 | 10.32% |
| `toolInventories` | 4,404,222 | 6.65% |
| Top five | 57,011,880 | 86.12% |
| All 20 declared `HEAVY_SLICE_KEYS` | 66,032,877 | 99.75% |
| Entire body | 66,198,585 | 100% |

The older comments describing roughly 98 MB parsed / 132 MB serialized are
historical observations, not today's corpus size. The absolute size has fallen,
but the architectural signal has not: almost all bytes are concentrated in
independently addressable keys, and a request for one key need not construct the
other 19.

### Deterministic 1,200-session server fixture: full-assembly cost

`npm run gate:server-scale` uses a generated corpus, not the maintainer's live
history. It exercises the real server and ingest implementation with 1,200
sessions and reported:

| Metric | Result |
| --- | ---: |
| Cold `/api/dataset.json` load | 6,285.8 ms |
| Cold ingest | 3,676.7 ms |
| `assembleDataset()` best of three | 1,302.4 ms |
| JSON serialization | 246.4 ms |
| Dataset JSON | 17,279,870 bytes |
| Maximum retained heap growth | 85,176,904 bytes |
| Maximum retained RSS growth | 244,506,624 bytes |

Every metric passed its existing budget. That proves the current implementation
is capped at the committed fixture; it does not make constructing unused keys
free, and it does not prevent every boot or slice from scaling with the whole
corpus.

### Published-build cold load: client baseline and scope limit

`npm run measure:cold-load -- --measure-only` builds both published SPA flavors
and serves bundled sample data with no real `~/.claude` mount. Median results
were:

| Flavor | FCP | TTI proxy | Content-Painted | CLS |
| --- | ---: | ---: | ---: | ---: |
| Server SPA | 116 ms | 16.1 ms | 100.4 ms | 0.0000 |
| Upload SPA | 204 ms | 15.6 ms | 188.8 ms | 0.0009 |

This harness cannot measure the server-side assembly change: Vite preview has
no live ingest server. It is a baseline the migration must preserve, not evidence
for either assembly option. The separate historical real-server measurement in
`docs/perf-sprint/cold-load.md` records the instant shell improving
Content-Painted from about 343 ms to about 146 ms; that result is why this ADR
keeps the shell even though boot assembly will become cheaper.

## Decision

Adopt **per-key lazy server assembly** on the instantiable-ingest seam delivered
for #3000 by #3677-#3679. This decision does not wait for the unrelated server
and App decomposition tracks under the still-open parent epic.

An ingest instance will expose snapshot-bound projection operations rather than
one operation that returns the complete dataset. At minimum it must support:

1. a boot projection containing only metadata, counts, and headline aggregates;
2. one projection for each key in `HEAVY_SLICE_KEYS`; and
3. the existing recommendation projection, whose `assembleRecommendationDataset()`
   implementation is the byte-identical projection/parity precedent from #2182.
   It is not itself proof of laziness: it still calls `assembleDatasetCore()`, so
   the new key projections must prove that they skip unrelated builders.

The projection API must bind every result to the same source snapshot/content
hash that caused its ingest. A server memo may cache projections by
`(contentHash, projectionKey)`, but requesting one key must not construct or
retain unrelated heavy keys. Boot aggregates may read the minimum source columns
they require; they may not regain the monolith through an intermediate object.

Snapshot identity has two inputs: source content and one shared projection-set
epoch. The epoch advances whenever any boot or slice generation semantics
change, so a boot emitted by one deploy cannot accept a slice produced by another
deploy merely because their source files match. Per-projection cache versions
may additionally avoid invalidating unrelated stored projections, but they do
not replace the shared cross-projection epoch carried by the dataset version.

The browser must request slices on demand for the active view (or for an
explicitly documented multi-key view dependency), not enqueue every advertised
key after boot. Background warming, if retained at all, must be bounded and
cancelable and must not make a cold page load construct all projections. The
non-worker fallback must obey the same bound; its current `Promise.all` fan-out
is not an acceptable alternate path.

Before a projection replaces the old path, parity tests must compare its exact
value with the same key from `assembleDataset()` over representative fixtures.
The old full assembler remains only as a temporary migration oracle and rollback
path. It is removed after the route and cache cutovers below.

## Disposition of the four compensating systems

### 1. SQLite `dataset_cache` and full-dataset schema knobs: retire

The `dataset_cache` table stores precompressed complete `/api/dataset.json`
bodies. Once no served path constructs that body, the table and its
`DATASET_ASSEMBLY_SCHEMA_VERSION` / `FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION`
constants have no artifact to guard and must be removed.

If server-side boot or slice compression remains worth persisting, it gets a
projection cache with an explicit projection key and projection-contract
version; it must not preserve a hidden full-body row or reuse the full-dataset
version name. A shared projection-set epoch still participates in snapshot
identity, separately from those storage-cache versions.

Follow-up child: **Retire the full-body SQLite dataset cache and replace only
measured projection caches**.

### 2. `/api/dataset.json` and the client monolith fallback: retire after parity

`/api/dataset.json` remains during migration as the failure fallback and as the
parity oracle. It is not the steady-state escape hatch. After demand-driven
hydration and boot/slice recovery can retry a failed or version-skewed projection
without mixing snapshots, remove the route, `fetchDatasetForIdentity()`, and the
client branches that download the monolith.

Removal is gated by route-inventory/OpenAPI updates, fault-injection coverage for
boot failure, slice failure, worker failure, and mid-load version skew, plus an
explicit search for non-browser consumers. Snapshot mismatch must resolve by a
bounded restart from a new boot version, not by reconstructing the old monolith.

Follow-up children:

- **Make slice hydration demand-driven with bounded worker and non-worker paths**.
- **Replace monolith fallback with bounded atomic recovery, then remove
  `/api/dataset.json`**.

### 3. Browser IndexedDB dataset cache: replace the monolith store

Keep the user benefit of an instant repeat paint, but retire the current v1 store
whose deletion and replacement unit is one fully assembled dataset object.
Migrate it to versioned boot and per-slice records keyed by auth identity,
dataset version, and projection key. A cached boot may paint immediately; cached
slices are publishable only when their dataset version equals that boot's
version. Migration deletes the v1 monolith store rather than carrying both cache
models indefinitely.

Follow-up child: **Migrate IndexedDB from a monolith object to atomic versioned
boot/slice records**.

### 4. Instant shell: keep and rebase on the boot projection

Keep the instant shell. It paints useful server-derived KPIs before JavaScript
runs, and its HTML-path work is a constant-time read of the last accepted boot
projection. Cheaper boot assembly does not replace that pre-JavaScript benefit.

The shell may be updated only after the surrounding snapshot-bound cache accepts
the boot projection. With enterprise auth enabled, an unauthenticated request
must continue receiving the skeleton; scoped or principal-specific counts must
never enter the global shell.

Follow-up child: **Rebase the instant shell on lazy boot assembly and preserve
the pre-auth disclosure guard**.

## Contracts that do not change

The implementation may replace mechanisms, but these observable contracts are
frozen:

- **Recommendation API shape.** Plain `/api/recommendations.json` remains a raw
  JSON array. The `/recs` skill, `scripts/mcp-shim.mjs`, and
  `scripts/recommendations-statusline.mjs` depend on that shape. Typed
  `?surface=` responses remain envelopes. The route contract is exercised by
  `scripts/recommendations-surface-route.test.mjs`.
- **Snapshot atomicity.** A render never combines boot or slice values from two
  corpus snapshots. Today `X-Dataset-Version` carries the content hash and
  `src/lib/instant-load.test.ts` exercises client skew handling; #3675 adds the
  missing server emission tripwire. The header is replaceable only by a mechanism
  that proves the same invariant end to end.
- **Flag-off byte identity.** Optional/non-local inputs remain off by default and
  may not alter default bytes or perform external calls. The paired enabled and
  flag-off schema identities remain necessary during migration; examples are
  pinned in `scripts/dataset-cache-schema-version.test.mjs`. Retiring the
  full-body cache removes those two dataset-schema constants only after their
  persisted artifact disappears; it does not weaken feature-off parity. The new
  snapshot identity must include the observed feature-mode state (or use distinct
  enabled/flag-off epochs), so two modes can never alias the same version.
- **Pre-auth disclosure.** A global instant shell is never served with real
  counts before enterprise authentication. The spawned-server regression is
  `scripts/instant-shell-server.test.mjs`.

## Cache-invalidation lattice

The migration must preserve the deliberate separation among four kinds of
artifact identity:

1. `SESSION_BLOB_OUTPUT` versions parsed signal rows in `session_blob`.
2. `REPO_MAP_OUTPUT` versions persisted repository-map output and its per-file
   parser cache salt.
3. `PARSER_SIG_VERSION` versions the per-session transcript extraction cache.
4. `DATASET_ASSEMBLY_SCHEMA_VERSION` (with its flag-off counterpart) versions
   the serialized full-dataset contract.

The first three survive because their artifacts survive. The fourth is retired
with the full-dataset artifact and replaced by a shared
`DATASET_PROJECTION_SET_VERSION` (name illustrative) that participates in every
boot/slice snapshot version. Persisted projection caches may also carry
projection-specific contract versions. These identities must not be collapsed:
the first three invalidate different upstream artifacts, the shared projection
epoch prevents cross-deploy mixing, and per-key cache versions control storage
reuse. The registry and its forward fence live in
`scripts/lib/parser-output-versions.mjs` and
`scripts/parser-output-versions.fence.test.mjs`; dataset/transcript coupling is
exercised by `scripts/dataset-cache-schema-version.test.mjs` and
`scripts/transcript-warm-cache-sig.test.mjs`.

## Delivery sequence

1. Land #3675's server-side `X-Dataset-Version` tripwire.
2. Preserve the instantiable-ingest seam already landed in #3677-#3679; do not
   wait for #3000's unrelated server/App tracks.
3. Add snapshot-bound boot/key projection APIs and byte-parity tests while the
   full assembler remains the oracle.
4. Change client hydration to request only active-view dependencies; preserve a
   bounded, cancelable worker and non-worker path.
5. Cut boot and slice handlers to projection assembly; rebaseline server-scale
   assembly, memory, and response metrics.
6. Migrate the browser cache and replace monolith fallback with bounded atomic
   retry.
7. Remove `/api/dataset.json`, the full assembler, full-body SQLite cache, and
   full-dataset schema knobs together; install the shared projection-set epoch
   and update route/OpenAPI inventories.
8. Re-run live field attribution, server-scale, and published-build cold load.

Execution children are groomed on #2999 after this ADR lands. The titles above
are the required child boundaries; combining them into one migration PR would
make rollback and parity review unsafe.

## Consequences

- Boot and one-slice work scale with the requested projection instead of all
  heavy keys.
- A cold load no longer schedules every heavy projection; opening a view pays
  for its declared dependencies.
- A single large field can still be expensive, but its cost no longer drags
  unrelated fields into memory.
- The migration temporarily carries old and new assembly paths for parity, so
  it needs an explicit removal phase rather than permanent dual maintenance.
- Per-projection caching and snapshot identity are more explicit than one object
  cache; tests must cover version-set membership, stale-record cleanup, and
  bounded recovery.
- The instant shell and recommendation wire contract survive unchanged.

## Alternatives rejected

### Keep and cap the monolith

The current implementation passes its budgets, so this is a viable rollback
posture. It is rejected as the target because budgets only bound today's full
assembly; they do not remove the architectural fact that every projection scales
with every key. The live corpus's 99.75% heavy-key concentration makes that work
unnecessary and separately addressable.

### Precompute every slice eagerly

Serializing the monolith into several named buffers would improve cache lookup
granularity but would still construct and retain every field before the first
requested slice. It changes storage layout without removing the root cost.

### Remove the instant shell when boot becomes cheap

Boot cannot paint before HTML and JavaScript execute. The shell has a distinct
pre-JavaScript benefit and a measured real-server win, so it remains as the
constant-time presentation of the last accepted global boot projection.
