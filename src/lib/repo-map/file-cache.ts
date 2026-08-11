/**
 * Host-only, disposable per-file parse cache for Repo Map generation (#2327).
 *
 * This cache is deliberately separate from the runtime-consumed Repo Map
 * artifact. It stores a complete bounded path/hash cohort plus validated
 * structural parser output for entries that fit, guarded by a cohort-wide
 * parser salt. Raw source, mtimes, and full RepoFile records are never
 * persisted here.
 *
 * The file is a single cohort: schema or parser-salt mismatches discard every
 * entry together. Corrupt, oversize, or unwritable cache state is a cold-cache
 * performance event, never a Repo Map generation failure.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { RepoMapParserInitializationError } from './types';
import type { FileStructure, ParseFile } from './types';
import {
  classifyParserResult,
  normalizeFileStructure,
} from './parser-output';

// Canonical REPO_MAP_OUTPUT rollovers are embedded in the parser salt, so old
// cohorts retire without a redundant sidecar-schema version change. Output
// contract fencing and exact projection do not change this sidecar envelope.
export const REPO_MAP_FILE_CACHE_VERSION = 2;
export const DEFAULT_REPO_MAP_FILE_CACHE_MAX_ENTRIES = 4000;
export const DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;

interface PersistedRepoMapFileCache {
  version: number;
  salt: string;
  /** Complete path/hash cohort, including files whose structures did not fit. */
  cohort: Record<string, string>;
  entries: Record<string, CachedFileStructure>;
}

interface CachedFileStructure {
  contentHash: string;
  structure: FileStructure;
}

interface LoadedFileCache {
  valid: boolean;
  cohort: Map<string, string>;
  entries: Map<string, CachedFileStructure>;
}

function emptyLoadedFileCache(): LoadedFileCache {
  return { valid: false, cohort: new Map(), entries: new Map() };
}

export interface RepoMapFileCacheOptions {
  /** Sidecar location. Keep this outside the runtime artifact directory. */
  cacheFile: string;
  /** Grammar + extraction-semantics identity. A change invalidates the cohort. */
  salt: string;
  /** Real parser called on cache misses. */
  parseFile?: ParseFile;
  /** Lazy parser construction: an all-hit run never initializes WASM. */
  parseFileFactory?: () => ParseFile | Promise<ParseFile>;
  /** False for `--force`: ignore old entries but still populate a fresh cohort. */
  reuse?: boolean;
  maxEntries?: number;
  maxBytes?: number;
}

export interface RepoMapFileCacheCommit {
  written: boolean;
  entryCount: number;
  bytes: number;
  /** True when the current path/hash cohort differs from reusable cache state. */
  changed: boolean;
}

export interface RepoMapFileCache {
  parseFile: ParseFile;
  stats: { hits: number; misses: number };
  /**
   * Deterministic identity of the parser salt plus the complete active
   * path/content-hash cohort. Persist this in the canonical artifact cache key
   * so a sidecar from one concurrent producer cannot validate another
   * producer's artifact.
   */
  structureSignature: () => string;
  cohortChanged: () => boolean;
  commit: () => RepoMapFileCacheCommit;
}

function boundedPositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readCache(
  cacheFile: string,
  salt: string,
  maxEntries: number,
  maxBytes: number
): LoadedFileCache {
  try {
    const stat = statSync(cacheFile);
    if (!stat.isFile() || stat.size > maxBytes) {
      return emptyLoadedFileCache();
    }
    const serialized = readFileSync(cacheFile, 'utf8');
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      return emptyLoadedFileCache();
    }
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyLoadedFileCache();
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== REPO_MAP_FILE_CACHE_VERSION ||
      candidate.salt !== salt ||
      !candidate.cohort ||
      typeof candidate.cohort !== 'object' ||
      Array.isArray(candidate.cohort) ||
      !candidate.entries ||
      typeof candidate.entries !== 'object' ||
      Array.isArray(candidate.entries)
    ) {
      return emptyLoadedFileCache();
    }
    const rawCohort = Object.entries(candidate.cohort as Record<string, unknown>);
    const rawEntries = Object.entries(candidate.entries as Record<string, unknown>);
    if (rawCohort.length > maxEntries || rawEntries.length > maxEntries) {
      return emptyLoadedFileCache();
    }
    const cohort = new Map<string, string>();
    for (const [path, hash] of rawCohort) {
      if (path.length === 0 || typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
        return emptyLoadedFileCache();
      }
      cohort.set(path, hash);
    }
    const entries = new Map<string, CachedFileStructure>();
    for (const [path, value] of rawEntries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return emptyLoadedFileCache();
      }
      const cached = value as Record<string, unknown>;
      const structure = normalizeFileStructure(cached.structure);
      // One malformed row rejects the whole salt/schema cohort. Mixing trusted
      // and untrusted structures would make cache correctness non-auditable.
      if (
        path.length === 0 ||
        typeof cached.contentHash !== 'string' ||
        !SHA256_HEX.test(cached.contentHash) ||
        cohort.get(path) !== cached.contentHash ||
        !structure
      ) {
        return emptyLoadedFileCache();
      }
      entries.set(path, { contentHash: cached.contentHash, structure });
    }
    return { valid: true, cohort, entries };
  } catch {
    return emptyLoadedFileCache();
  }
}

function contentHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function structureSignature(
  salt: string,
  activeEntries: Map<string, CachedFileStructure>
): string {
  const digest = createHash('sha256').update(salt).update('\0');
  // Do not rely on traversal/Map insertion order for a persisted validity key.
  // Filesystem paths cannot contain NUL, so the separators are unambiguous.
  for (const [path, cached] of [...activeEntries].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    digest.update(path).update('\0').update(cached.contentHash).update('\0');
  }
  return digest.digest('hex');
}

function compactBoundedCache(
  salt: string,
  activeEntries: Map<string, CachedFileStructure>,
  maxEntries: number,
  maxBytes: number
): { serialized: string; entryCount: number } | null {
  if (activeEntries.size > maxEntries) return null;
  const cohort: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, cached] of activeEntries) {
    cohort[path] = cached.contentHash;
  }
  const base: PersistedRepoMapFileCache = {
    version: REPO_MAP_FILE_CACHE_VERSION,
    salt,
    cohort,
    entries: {},
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
  if (baseBytes > maxBytes) return null;

  const entries: Record<string, CachedFileStructure> = Object.create(null) as Record<
    string,
    CachedFileStructure
  >;
  let bytes = baseBytes;
  let entryCount = 0;
  for (const [path, cached] of activeEntries) {
    if (entryCount >= maxEntries) break;
    const pairBytes = Buffer.byteLength(
      `${JSON.stringify(path)}:${JSON.stringify(cached)}`,
      'utf8'
    );
    const separatorBytes = entryCount === 0 ? 0 : 1;
    if (bytes + pairBytes + separatorBytes > maxBytes) continue;
    entries[path] = cached;
    bytes += pairBytes + separatorBytes;
    entryCount += 1;
  }

  const serialized = JSON.stringify({
    version: REPO_MAP_FILE_CACHE_VERSION,
    salt,
    cohort,
    entries,
  });
  // Keep the byte accounting honest if the envelope changes later.
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) return null;
  return { serialized, entryCount };
}

function sameCohort(
  reusable: Map<string, string>,
  active: Map<string, CachedFileStructure>
): boolean {
  if (reusable.size !== active.size) return false;
  for (const [path, current] of active) {
    if (reusable.get(path) !== current.contentHash) return false;
  }
  return true;
}

/**
 * Wrap a parser with content-addressed reuse and an explicit commit boundary.
 * Call `commit()` only after `generateRepoMap()` completes successfully; only
 * keys used by that run are written, which prunes changed/deleted files.
 */
export function createRepoMapFileCache(
  options: RepoMapFileCacheOptions
): RepoMapFileCache {
  const maxEntries = boundedPositiveInt(
    options.maxEntries,
    DEFAULT_REPO_MAP_FILE_CACHE_MAX_ENTRIES
  );
  const maxBytes = boundedPositiveInt(
    options.maxBytes,
    DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES
  );
  const loaded = options.reuse === false
    ? emptyLoadedFileCache()
    : readCache(options.cacheFile, options.salt, maxEntries, maxBytes);
  const reusable = loaded.entries;
  const reusableCohort = loaded.cohort;
  const activeEntries = new Map<string, CachedFileStructure>();
  const stats = { hits: 0, misses: 0 };
  let baseParseFile = options.parseFile;
  let baseParseFilePromise: Promise<ParseFile> | null = null;

  const parserForMiss = async (): Promise<ParseFile> => {
    if (baseParseFile) return baseParseFile;
    if (!options.parseFileFactory) {
      throw new Error('repo-map file cache requires parseFile or parseFileFactory on a miss');
    }
    try {
      // `.then` converts a synchronous factory throw into the same rejection
      // path as an async WASM/grammar load failure.
      baseParseFilePromise ??= Promise.resolve().then(options.parseFileFactory);
      baseParseFile = await baseParseFilePromise;
    } catch (error) {
      throw new RepoMapParserInitializationError(error);
    }
    return baseParseFile;
  };

  const parseFile: ParseFile = async (source, path) => {
    const hash = contentHash(source);
    const cached = reusable.get(path);
    if (cached?.contentHash === hash) {
      stats.hits += 1;
      activeEntries.set(path, cached);
      return cached.structure;
    }

    stats.misses += 1;
    const parser = await parserForMiss();
    const parserResult = parser(source, path);
    const classified = classifyParserResult(parserResult);
    if (classified.kind === 'invalid-promise') {
      throw new RepoMapParserInitializationError(classified.cause);
    }
    let parsed: unknown;
    if (classified.kind === 'promise') {
      const settlement = await classified.promise;
      if (!settlement.fulfilled) throw settlement.cause;
      parsed = settlement.value;
    } else {
      parsed = classified.value;
    }
    const normalized = normalizeFileStructure(parsed);
    if (!normalized) {
      // generateRepoMap treats a parser throw as one unparseable file and keeps
      // building the rest of the map. Throwing here gives cached misses that
      // same behavior without returning an invalid value from a ParseFile.
      throw new TypeError('repo-map parser returned malformed FileStructure');
    }
    activeEntries.set(path, { contentHash: hash, structure: normalized });
    return normalized;
  };

  const commit = (): RepoMapFileCacheCommit => {
    const changed = cohortChanged();
    let compact: ReturnType<typeof compactBoundedCache> | undefined;
    // An unchanged cohort normally leaves the sidecar untouched. When files
    // missed only because their structures were compacted out, probe once to
    // see whether a raised byte cap can retain more; rewrite only on growth.
    if (!changed) {
      if (stats.misses > 0) {
        compact = compactBoundedCache(options.salt, activeEntries, maxEntries, maxBytes);
      }
      if (!compact || compact.entryCount <= reusable.size) {
        let bytes = 0;
        try {
          bytes = statSync(options.cacheFile).size;
        } catch {
          // `loaded.valid` means it existed earlier; a concurrent deletion only
          // loses warming and must not affect the canonical Repo Map.
        }
        return {
          written: false,
          entryCount: reusable.size,
          bytes,
          changed: false,
        };
      }
      // Otherwise fall through to the atomic writer with the richer cohort.
    }
    compact ??= compactBoundedCache(options.salt, activeEntries, maxEntries, maxBytes);
    if (!compact) {
      return { written: false, entryCount: 0, bytes: 0, changed };
    }

    const dir = dirname(options.cacheFile);
    const temporary = `${options.cacheFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, compact.serialized, { mode: 0o600 });
      renameSync(temporary, options.cacheFile);
      chmodSync(options.cacheFile, 0o600);
      return {
        written: true,
        entryCount: compact.entryCount,
        bytes: Buffer.byteLength(compact.serialized, 'utf8'),
        changed,
      };
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Cleanup is best-effort too. Permission drift in disposable cache
        // state must never turn a successful canonical artifact into a failed
        // producer run.
      }
      return { written: false, entryCount: 0, bytes: 0, changed };
    }
  };

  const currentStructureSignature = (): string =>
    structureSignature(options.salt, activeEntries);

  const cohortChanged = (): boolean =>
    !loaded.valid || !sameCohort(reusableCohort, activeEntries);

  return {
    parseFile,
    stats,
    structureSignature: currentStructureSignature,
    cohortChanged,
    commit,
  };
}
