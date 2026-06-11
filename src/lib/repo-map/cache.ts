/**
 * Repo Map cache + persistence hardening (#893, epic #871). See ADR 0007.
 *
 * The host producer (`scripts/repo-map-generate.mjs`) writes one JSON artifact
 * per project root that the read-only runtime consumes. Regenerating it on every
 * ingest is wasteful (a full filesystem walk + WASM parse), and an unbounded
 * artifact can balloon the dataset payload — the two failure modes #893 hardens:
 *
 *  - **Cache by project root + git sha / mtime.** A persisted map is reusable
 *    when the source signature it was generated against is unchanged. The
 *    signature is the git sha when the root is a clean repo, otherwise the
 *    max mtime of the walked source set — so a dirty/non-repo root still
 *    invalidates correctly. {@link isCacheValid} answers "can I skip the walk?".
 *  - **Enforced size limit on the persisted map.** {@link enforceSizeLimit}
 *    bounds the serialized artifact: it never lets one giant root blow the
 *    payload, trimming the lowest-ranked files (least referenced — see
 *    `rankByInDegree`) until the JSON fits, and flagging that it did.
 *
 * This module is HOST-ONLY (it stats source files and reads/writes the artifact
 * dir). The runtime only reads the JSON it produces — see ADR 0007.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoMap } from './types';

/**
 * Hard ceiling on the persisted artifact's serialized size. The dataset the
 * runtime ships is the sum of every per-root map plus the rest of the corpus;
 * 1 MiB per root is generous for a structural index (paths + signatures +
 * imports, no bodies) yet small enough that a pathological monorepo cannot
 * dominate the payload. Override with REPO_MAP_MAX_BYTES on the producer.
 */
export const DEFAULT_MAX_PERSISTED_BYTES = 1024 * 1024;

/**
 * The cache signature a persisted map was generated against. Stamped into the
 * artifact so a later run can decide whether the on-disk map is still fresh
 * without re-walking the tree.
 */
export interface RepoMapCacheKey {
  /** Absolute project root the map covers. */
  root: string;
  /** Git sha the root was at, or null when the root is not a clean repo. */
  gitSha: string | null;
  /**
   * Max source-file mtime (ms) at generation time. The fallback staleness
   * signal when `gitSha` is null (no repo) or the tree is dirty — a content
   * change bumps an mtime even when HEAD does not move.
   */
  maxMtimeMs: number;
}

/** The persisted artifact: the structural map plus its cache key and the
 *  size-enforcement outcome. The runtime reads `map`; the producer reads
 *  `cacheKey` to decide whether to regenerate. */
export interface PersistedRepoMap {
  /** Schema/format version so a producer change can invalidate old artifacts. */
  version: number;
  cacheKey: RepoMapCacheKey;
  /** True when {@link enforceSizeLimit} trimmed files to fit the byte ceiling. */
  sizeBounded: boolean;
  /** Files dropped to fit the ceiling (0 unless `sizeBounded`). */
  droppedFiles: number;
  map: RepoMap;
}

/** Bump when the persisted shape changes so stale artifacts are not reused. */
export const PERSISTED_REPO_MAP_VERSION = 1;

/**
 * Compute the cache key for a generated map. `gitSha` is the caller-resolved
 * HEAD sha (null when the root is not a clean repo). `maxMtimeMs` is the max
 * mtime over the files actually in the map — the producer passes the absolute
 * paths it walked so we stat them once here.
 */
export function computeCacheKey(
  root: string,
  gitSha: string | null,
  absFiles: string[]
): RepoMapCacheKey {
  let maxMtimeMs = 0;
  for (const abs of absFiles) {
    try {
      const m = statSync(abs).mtimeMs;
      if (m > maxMtimeMs) maxMtimeMs = m;
    } catch {
      // A file that vanished between walk and stat just doesn't count toward
      // the signature — the next run will stat the surviving set.
    }
  }
  return { root, gitSha, maxMtimeMs };
}

/**
 * Decide whether a persisted map can be reused instead of regenerating. Valid
 * when the format version matches, the root matches, AND the staleness signal
 * is unchanged:
 *  - clean repo (`gitSha` non-null on both sides): the sha must match — a
 *    moved HEAD invalidates regardless of mtimes.
 *  - no sha on either side (non-repo / dirty tree): the max source mtime must
 *    not have advanced past what was cached.
 * A null-vs-nonnull sha mismatch (repo state changed) always invalidates.
 */
export function isCacheValid(
  persisted: Pick<PersistedRepoMap, 'version' | 'cacheKey'> | null | undefined,
  current: RepoMapCacheKey
): boolean {
  if (!persisted) return false;
  if (persisted.version !== PERSISTED_REPO_MAP_VERSION) return false;
  const cached = persisted.cacheKey;
  if (cached.root !== current.root) return false;
  if (cached.gitSha !== null && current.gitSha !== null) {
    return cached.gitSha === current.gitSha;
  }
  // No usable sha on at least one side: a sha appearing/disappearing means the
  // repo state changed — regenerate. Otherwise compare the mtime watermark.
  if (cached.gitSha !== current.gitSha) return false;
  return current.maxMtimeMs <= cached.maxMtimeMs;
}

/** Serialized byte length of a value as it will be persisted (UTF-8 JSON). */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Bound a map's persisted size to `maxBytes`. The structured `files` are ranked
 * most-referenced-first (see `rankByInDegree`), so trimming from the TAIL drops
 * the least load-bearing files. We trim until the whole {@link PersistedRepoMap}
 * envelope serializes within the ceiling, then re-render `text` so the rendered
 * fragment never references a file the structure no longer carries.
 *
 * Returns the (possibly trimmed) map plus how many files were dropped.
 */
export function enforceSizeLimit(
  map: RepoMap,
  cacheKey: RepoMapCacheKey,
  renderText: (files: RepoMap['files']) => { text: string; truncated: boolean },
  maxBytes: number = DEFAULT_MAX_PERSISTED_BYTES
): PersistedRepoMap {
  const build = (files: RepoMap['files']): PersistedRepoMap => {
    const rendered = renderText(files);
    return {
      version: PERSISTED_REPO_MAP_VERSION,
      cacheKey,
      sizeBounded: false,
      droppedFiles: map.files.length - files.length,
      map: {
        ...map,
        files,
        fileCount: map.fileCount,
        text: rendered.text,
        truncated: rendered.truncated,
      },
    };
  };

  let files = map.files;
  let candidate = build(files);
  if (serializedBytes(candidate) <= maxBytes) return candidate;

  // Binary-search the largest prefix of the ranked file list that fits, so a
  // huge root costs O(log n) renders rather than one render per dropped file.
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    candidate = build(files.slice(0, mid));
    if (serializedBytes(candidate) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  files = map.files.slice(0, lo);
  const bounded = build(files);
  bounded.sizeBounded = true;
  bounded.droppedFiles = map.files.length - files.length;
  return bounded;
}

/**
 * The whitelist of fields a privacy-safe persisted map may carry per file. The
 * artifact is STRUCTURAL only — paths, symbol names + one-line signatures,
 * import specifiers, ranks/counts, hashes/mtimes — never a source body or a
 * literal config/secret value. {@link assertNoBodyLeakage} enforces it by
 * scanning the serialized artifact for caller-supplied body sentinels.
 */
export interface BodyLeakageReport {
  ok: boolean;
  /** Sentinels that leaked into the serialized artifact (empty when ok). */
  leaked: string[];
}

/**
 * Assert the persisted artifact carries no source/config bodies. Given the
 * sentinel strings that appear ONLY inside file bodies / full config values in
 * the scanned corpus, this fails if any of them survived into the serialized
 * map — the regression guard for the privacy invariant (paths, signatures,
 * headings, references, hashes/mtimes, bounded excerpts only).
 */
export function assertNoBodyLeakage(
  persisted: PersistedRepoMap,
  bodySentinels: string[]
): BodyLeakageReport {
  const serialized = JSON.stringify(persisted);
  const leaked = bodySentinels.filter((s) => s.length > 0 && serialized.includes(s));
  return { ok: leaked.length === 0, leaked };
}

/** Path of the persisted artifact for `root` under the artifact dir. Mirrors
 *  the `~/.claude/projects/<slug>/` encoding the producer uses. */
export function artifactPathFor(artifactDir: string, root: string): string {
  const encoded = root.replace(/[^a-zA-Z0-9]/g, '-');
  return join(artifactDir, `${encoded}.json`);
}
