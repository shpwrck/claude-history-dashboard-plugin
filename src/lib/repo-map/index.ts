/**
 * Repo Map substrate (#887, keystone of epic #871). See ADR 0007 and
 * `docs/adr/0007-repo-map-host-producer-wasm.md`.
 *
 * Server/host-only. The WASM Tree-sitter parser (`./parser`) must never be
 * imported by `scripts/server.mjs` or the SPA — generation is host-side and the
 * runtime container reads the JSON artifact this produces.
 */
export type {
  RepoMap,
  RepoFile,
  RepoSymbol,
  RepoSymbolKind,
  FileStructure,
  ParseFile,
  GenerateRepoMapOptions,
} from './types';
export { RepoMapParserInitializationError } from './types';
export { generateRepoMap, renderRepoMap } from './generate';
export {
  createTsParseFile,
  extractStructure,
  loadTsParser,
  repoMapParserCacheSalt,
} from './parser';
export type {
  RepoMapFileCache,
  RepoMapFileCacheCommit,
  RepoMapFileCacheOptions,
} from './file-cache';
export {
  createRepoMapFileCache,
  DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES,
  DEFAULT_REPO_MAP_FILE_CACHE_MAX_ENTRIES,
  REPO_MAP_FILE_CACHE_VERSION,
} from './file-cache';
export type {
  RepoMapCacheKey,
  PersistedRepoMap,
  BodyLeakageReport,
} from './cache';
export {
  DEFAULT_MAX_PERSISTED_BYTES,
  PERSISTED_REPO_MAP_VERSION,
  computeCacheKey,
  isCacheValid,
  serializedBytes,
  enforceSizeLimit,
  assertNoBodyLeakage,
  artifactPathFor,
} from './cache';
