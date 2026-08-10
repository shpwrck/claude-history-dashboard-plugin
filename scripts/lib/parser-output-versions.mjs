// The single parser-output -> cache-invalidation SEAM (#2075).
//
// "A parser's output changed -> invalidate the right cache" used to be a
// scattered manual concern in two divergent encodings: a string baked into the
// session-blob cache key (`SESSION_BLOB_PARSER_VERSION` in session-blob-row.mjs)
// and a numeric envelope field for the repo-map artifact
// (`PERSISTED_REPO_MAP_VERSION` in src/lib/repo-map/cache.ts). Nothing said in
// one place "bump THIS when THAT parser's persisted output changes", so the wrong
// knob got bumped and a parser-output change shipped INERT (a documented
// multi-cycle failure, e.g. #2036 -> #2040, #2129).
//
// This registry is that single place. Each entry owns ONE parser-output
// contract and the version that gates the cache keyed on it. The two caches keep
// consuming their own entry — they are NOT collapsed into one key, because they
// gate genuinely different artifacts (see "What this is NOT" below).
//
// HOW TO USE THIS (the recipe the seam exists to make obvious):
//   When you change the output shape OR generation semantics of a parser that
//   feeds one of these caches, bump that entry's `version` here. On a shape
//   change, also update its `contract` fingerprint. The forward-fence test
//   (`parser-output-versions.fence.test.mjs`) recomputes each contract from the
//   live code and FAILS if a parser's output shape drifted without the contract
//   (and therefore the human-reviewed version bump) moving with it. So a forgot-
//   to-bump regression is caught at test time instead of shipping inert.
//
// WHAT THIS IS *NOT* (do not conflate semantically-distinct caches):
//   There are other invalidation knobs in scripts/ingest.mjs that gate DIFFERENT
//   artifacts and intentionally stay separate:
//     - PARSER_SIG_VERSION          -> the per-session TRANSCRIPT cache
//                                      (sigOf/getTranscript) + folded into the
//                                      dataset schema key.
//     - DATASET_ASSEMBLY_SCHEMA_VERSION -> the SERIALIZED DATASET contract
//                                      produced by assembleDataset(). It remains a
//                                      separate cache key, but must also move when
//                                      changed parser semantics alter that body.
//   Those are listed in `RELATED_INVALIDATION_KNOBS` below for discoverability,
//   but they are NOT folded into the entries here: this seam unifies the two
//   "a parser's output shape changed" knobs, not every cache in the pipeline.

/**
 * @typedef {Object} ParserOutputContract
 * @property {string|number} version  The value baked into the cache key for the
 *   artifact this contract gates. Bump deliberately on an output-shape or
 *   generation-semantics change.
 * @property {string[]} contract  A stable, order-independent fingerprint of the
 *   parser's OUTPUT SHAPE: the field/column names the cache consumer depends on.
 *   The forward-fence test recomputes this from the live code and asserts a
 *   match, so a drift here without a version bump fails CI.
 * @property {string} consumedBy  Where the cache key that uses `version` lives.
 * @property {string} bumpWhen  Plain-English trigger for bumping `version`.
 */

/**
 * The session_blob row cache (per-session parsed signal blobs that feed the
 * dataset + recommendations). The cache key is `sessionFileSignature()` in
 * scripts/session-blob-row.mjs, which bakes in `version` as the `parser:<v>`
 * prefix ahead of the per-file mtime/size parts. The `contract` is the ordered
 * set of signal columns emitted by `makeSessionSignals()` in
 * src/lib/signals/index.ts — that column set IS the persisted output shape.
 *
 * @type {ParserOutputContract}
 */
export const SESSION_BLOB_OUTPUT = {
  // History of prior values is documented in scripts/session-blob-row.mjs next
  // to where this is consumed; keep new rationale there AND bump here.
  version: 'undo-file-paths-v22',
  contract: [
    'token_json',
    'tool_json',
    'timeline_json',
    'apierrors_json',
    'perm_json',
    'agents_json',
    'entries_json',
    'attribution_json',
    'runtime_json',
    'inventory_json',
    'assistant_features_json',
    'deceit_signals_json',
    'churn_geometry_json',
    'task_success_json',
    'value_flow_json',
    'secrets_at_rest_json',
  ],
  consumedBy:
    'scripts/session-blob-row.mjs sessionFileSignature() (parser:<version> prefix)',
  bumpWhen:
    'parse-sessions / any signal parser changes its OUTPUT shape, or a signal column is added/removed/renamed in src/lib/signals/index.ts',
};

/**
 * The persisted repo-map artifact (host-side Tree-sitter structural map; ADR
 * 0007). The cache key is the `version` field of the `PersistedRepoMap`
 * envelope, checked in `isCacheValid()` in src/lib/repo-map/cache.ts. The
 * `contract` is one qualified fingerprint of the envelope, `RepoMapCacheKey`,
 * inner `RepoMap`, per-file `RepoFile`, and per-symbol `RepoSymbol` key sets —
 * the persisted output shape a stale-artifact reader depends on. The fence reads
 * nested keys from their owning TypeScript interfaces rather than trusting a
 * possibly-incomplete JavaScript sample.
 *
 * @type {ParserOutputContract}
 */
export const REPO_MAP_OUTPUT = {
  // v10 (#3744): fingerprint the direct RepoSymbol key set from its owning
  // TypeScript interface. This turns over v9 so a future per-symbol output field
  // cannot remain invisible to either canonical or per-file cache invalidation.
  //
  // v9 (#3745): fingerprint the direct RepoMapCacheKey key set from its owning
  // TypeScript interface. This turns over v8 so a future cache-identity field
  // cannot remain invisible to the cache-invalidation seam.
  //
  // v8 (#2740): the forward fence now includes the RepoMap and RepoFile key
  // sets, not only the five-field persisted envelope. This deliberately turns
  // over v7 so a future direct RepoMap or RepoFile key change cannot stay
  // invisible to the cache-invalidation seam.
  //
  // v7 (#2741): the canonical artifact cache key now includes the normalized
  // `owner/repo` remote identity. A remote-only change at a stable HEAD must
  // regenerate instead of reusing a map attributed to the previous origin.
  // v6 artifacts lack that key field and therefore regenerate once.
  //
  // v6 (#3168): signature generation semantics changed — literal nodes (string,
  // template, number, regex) and comments are now masked structurally out of a
  // declaration head, so default parameter values and literal type-alias RHSs
  // no longer ride into the map as "structure". v5 and older artifacts — and
  // the per-file cache entries keyed off this version through
  // repoMapParserCacheSalt() — may hold signatures carrying literal secrets and
  // MUST regenerate.
  //
  // v5 (#2709): the structural map records the root's normalized `owner/repo`
  // remote identity (`map.repository`) beside `generatedAtGitSha`; pre-field
  // v4 artifacts must regenerate so identity-bound consumers never read a
  // missing field as "no remote" on a root that has one.
  version: 10,
  contract: [
    'envelope.version',
    'envelope.cacheKey',
    'envelope.cacheKey.root',
    'envelope.cacheKey.gitSha',
    'envelope.cacheKey.repository',
    'envelope.cacheKey.maxMtimeMs',
    'envelope.cacheKey.structureSignature',
    'envelope.sizeBounded',
    'envelope.droppedFiles',
    'envelope.map',
    'map.root',
    'map.generatedAtGitSha',
    'map.repository',
    'map.fileCount',
    'map.files',
    'map.text',
    'map.truncated',
    'map.files[].path',
    'map.files[].mtimeMs',
    'map.files[].symbols',
    'map.files[].symbols[].name',
    'map.files[].symbols[].kind',
    'map.files[].symbols[].exported',
    'map.files[].symbols[].signature',
    'map.files[].symbols[].line',
    'map.files[].imports',
  ],
  consumedBy:
    'src/lib/repo-map/cache.ts isCacheValid() (PersistedRepoMap.version) and src/lib/repo-map/parser.ts repoMapParserCacheSalt() (per-file cache salt)',
  bumpWhen:
    'the persisted repo-map envelope/structural-map shape changes, or generation semantics change persisted structure, ranking, or rendered text',
};

/**
 * Invalidation knobs that gate DIFFERENT artifacts and are deliberately kept
 * out of this seam. Listed here only so a reader who lands on this file can see
 * the full picture and not mistakenly fold them in. See the header comment.
 */
export const RELATED_INVALIDATION_KNOBS = Object.freeze({
  PARSER_SIG_VERSION:
    'scripts/ingest.mjs — gates the per-session TRANSCRIPT cache (transcriptSigOf/getTranscript); also folded into the dataset schema key. NOT a parser-output-shape knob for the session_blob signal columns.',
  DATASET_ASSEMBLY_SCHEMA_VERSION:
    'scripts/ingest.mjs — gates the SERIALIZED DATASET contract from assembleDataset(); also bump it when a changed parser output alters the persisted body without changing source artifacts.',
});
