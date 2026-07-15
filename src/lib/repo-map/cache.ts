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
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
// The persisted-repo-map version is owned by the single parser-output ->
// cache-invalidation seam (#2075), shared with the session-blob cache key.
// @ts-expect-error - plain ESM constant registry, no .d.ts (matches the
// sample-artifacts.ts -> build-corpus.mjs precedent).
import { REPO_MAP_OUTPUT } from '../../../scripts/lib/parser-output-versions.mjs';
import type { HostProducedArtifact } from '../artifact-source';
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
  /**
   * SHA-256 over the parser/grammar salt and the complete sorted
   * path/content-hash cohort. This binds the canonical artifact to the
   * disposable file-cache generation that justified it, so concurrent
   * producers or preserved-mtime rewrites cannot validate stale structure.
   * Null is reserved for callers that do not use the per-file cache.
   */
  structureSignature: string | null;
}

/**
 * The persisted artifact: the structural map plus its cache key and the
 * size-enforcement outcome. The runtime reads `map`; the producer reads
 * `cacheKey` to decide whether to regenerate. This is the repo-map instance of
 * the host-producer seam's {@link HostProducedArtifact} contract (#2077, ADR
 * 0007): it carries the contract's `version` field, and its `map` IS the
 * contract's `payload` (the field is named `map` for historical reasons — the
 * shared `.mjs` discovery tolerates both `map` and a flat artifact).
 */
export interface PersistedRepoMap
  extends Pick<HostProducedArtifact<RepoMap>, 'version'> {
  cacheKey: RepoMapCacheKey;
  /** True when {@link enforceSizeLimit} trimmed files to fit the byte ceiling. */
  sizeBounded: boolean;
  /** Files dropped to fit the ceiling (0 unless `sizeBounded`). */
  droppedFiles: number;
  map: RepoMap;
}

/**
 * Bump when the persisted repo-map output shape or generation semantics change
 * so stale artifacts are not reused. The value is owned by the single parser-output ->
 * cache-invalidation SEAM (#2075) in `scripts/lib/parser-output-versions.mjs`;
 * bump it THERE (and update its contract fingerprint) so the forward-fence test
 * catches an un-bumped shape change. Re-exported here under the original name so
 * existing consumers (`isCacheValid`, `enforceSizeLimit`, tests) are unchanged.
 */
export const PERSISTED_REPO_MAP_VERSION: number = REPO_MAP_OUTPUT.version;

/**
 * Compute the cache key for a generated map. `gitSha` is the caller-resolved
 * HEAD sha (null when the root is not a clean repo). `maxMtimeMs` is the max
 * mtime over the files actually in the map — the producer passes the absolute
 * paths it walked so we stat them once here.
 */
export function computeCacheKey(
  root: string,
  gitSha: string | null,
  absFiles: string[],
  structureSignature: string | null = null
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
  return { root, gitSha, maxMtimeMs, structureSignature };
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
  if (cached.structureSignature !== current.structureSignature) return false;
  if (cached.gitSha !== null && current.gitSha !== null) {
    return cached.gitSha === current.gitSha;
  }
  // No usable sha on at least one side: a sha appearing/disappearing means the
  // repo state changed — regenerate. Otherwise compare the mtime watermark.
  if (cached.gitSha !== current.gitSha) return false;
  return current.maxMtimeMs <= cached.maxMtimeMs;
}

/**
 * Extract the inner {@link RepoMap} from a persisted artifact, the producer/
 * consumer seam (ADR 0007). The host producer writes the {@link PersistedRepoMap}
 * ENVELOPE `{ version, cacheKey, sizeBounded, droppedFiles, map }` — the envelope
 * carries the cache/staleness metadata the producer reads back via
 * {@link isCacheValid}, while the consumer (`ingest.mjs`) wants the bare `RepoMap`
 * the dataset join expects. Returns `raw.map` when the envelope is present, a flat
 * `RepoMap` if an artifact was written without the envelope, or `null` when the
 * value isn't a usable map (no string `root` / no `files` array).
 *
 * Without this unwrap the consumer read `raw.root`/`raw.files` at the top level of
 * the envelope — both undefined — so every produced artifact resolved to null and
 * `dataset.repoMap` stayed empty even once the producer actually ran (#1650).
 */
export function unwrapPersistedRepoMap(raw: unknown): RepoMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const candidate = (
    obj.map && typeof obj.map === 'object' ? obj.map : obj
  ) as Partial<RepoMap>;
  if (typeof candidate.root !== 'string' || !Array.isArray(candidate.files)) {
    return null;
  }
  return candidate as RepoMap;
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
  // Injective (#1935): the old encoding mapped EVERY non-alphanumeric char to
  // `-`, so roots differing only in punctuation (proj-a / proj.a / proj_a /
  // proj/a) collided to one filename and the multi-root refresh driver (#1650)
  // silently overwrote one root's artifact with another's — data loss behind a
  // falsely-reassuring "written" count. The sha256 suffix over the FULL root
  // makes the filename collision-free; the dash-sanitized prefix is a debugging
  // aid only — a root's identity is recovered from the artifact's stored `root`
  // (ingest.mjs repoMapArtifactRoots reads that field), never decoded from the
  // filename, so the hash needs no reverse mapping.
  const prefix = root.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 80);
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(artifactDir, `${prefix}-${digest}.json`);
}
