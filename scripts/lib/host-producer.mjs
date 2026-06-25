// The host-producer seam (#2077, ADR 0007).
//
// ADR 0007 documents the host-producer pattern: a HOST process (which has
// devDeps + the WASM Tree-sitter grammars) writes an artifact under
// `~/.claude/usage-data/...`, and the read-only zero-node_modules runtime
// container CONSUMES it. Three producers live on the host side of that seam:
//
//   - `scripts/ingest.mjs`         (reads the artifacts into the dataset)
//   - `scripts/repo-map-refresh.mjs` (discovers roots, spawns the generator)
//   - `scripts/repo-map-generate.mjs`/the #280 `/insights` bridge (writes them)
//
// Before this module they each RE-IMPLEMENTED root discovery
// (`claudeJsonProjectRoots` / `repoMapArtifactRoots`) and capped artifact reads,
// with DIVERGENT SAFETY: ingest capped both the file size and the entry count and
// shared the cache unwrap, while `repo-map-refresh.mjs` did an UNCAPPED
// `JSON.parse(readFileSync(...))` and unwrapped the root inline. A third producer
// (the #280 bridge) would have invented a fourth pattern. This is the one place
// the discovery + capped-read + cap-constant seam lives, so every producer reads
// `~/.claude` the same bounded, robust way.
//
// ZERO node_modules (ADR 0007): this module imports only `node:` builtins, so it
// is safe in the server boot graph (ingest.mjs imports it through the register-ts
// loader) AND in the plain-`node` deploy path (`repo-map-refresh.mjs` runs under
// bare `node`, NOT register-ts, so it can only import `.mjs` — never a `.ts`).
// That constraint is WHY this is `.mjs` and not `.ts`: it must load both ways.
// The symmetric TS-typed CONSUMER contract (`HostProducedArtifact<T>`) lives in
// `src/lib/artifact-source.ts`; this file is its runtime producer half and the
// JSDoc `@typedef` below mirrors that type for the `.mjs` callers.

import { closeSync, opendirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** Reader chunk size, matching ingest's streaming cap reader. */
const READ_CHUNK_BYTES = 65_536;

/**
 * Parse a non-negative integer env override, falling back to `fallback` when the
 * var is unset or not a finite non-negative integer. Shared so every cap
 * constant clamps env input the same way (mirrors ingest's own helper).
 */
export function parseNonNegativeIntEnv(name, fallback, env = process.env) {
  const raw = env?.[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Resolve the max bytes a single auxiliary `~/.claude` artifact may be before a
 * capped read refuses it, from `DASHBOARD_ARTIFACT_FILE_MAX_BYTES`, clamped to
 * [64 KiB, 512 MiB]. A FUNCTION (not just a frozen const) so a consumer that
 * re-evaluates per-import (ingest does, for env-override tests) picks up a fresh
 * env value rather than the value frozen when this module first loaded.
 */
export function resolveArtifactFileMaxBytes(env = process.env) {
  return Math.max(
    65_536,
    Math.min(
      536_870_912,
      parseNonNegativeIntEnv('DASHBOARD_ARTIFACT_FILE_MAX_BYTES', 67_108_864, env)
    )
  );
}

/**
 * Resolve the max repo-map artifact directory entries scanned before discovery
 * stops — a runaway guard for a pathological `usage-data/repo-map/` dir — from
 * `DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES`, clamped to [1, 1,000,000]. A
 * function for the same env-freshness reason as {@link resolveArtifactFileMaxBytes}.
 */
export function resolveRepoMapArtifactMaxEntries(env = process.env) {
  return Math.max(
    1,
    Math.min(
      1_000_000,
      parseNonNegativeIntEnv('DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES', 50_000, env)
    )
  );
}

/**
 * The single source of truth for the per-artifact byte cap, evaluated at module
 * load. ingest re-exports it as `ARTIFACT_FILE_MAX_BYTES` (server.mjs imports
 * that) and the server surfaces it in its limits banner. Module-load-frozen
 * value; tests that need a fresh env override call the resolver above.
 */
export const ARTIFACT_FILE_MAX_BYTES = resolveArtifactFileMaxBytes();

/** Module-load value of the repo-map discovery entry cap (see resolver above). */
export const REPO_MAP_ARTIFACT_MAX_ENTRIES = resolveRepoMapArtifactMaxEntries();

/** A too-large artifact rejection carrying a stable, recognizable error code. */
export function artifactFileTooLargeError(maxBytes) {
  const err = new Error(`Auxiliary artifact exceeds ${maxBytes} byte limit`);
  err.code = 'ERR_DASHBOARD_ARTIFACT_FILE_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

/** True for the error {@link artifactFileTooLargeError} raises. */
export function isArtifactFileTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_ARTIFACT_FILE_TOO_LARGE';
}

/**
 * Read a file as UTF-8 text, throwing {@link artifactFileTooLargeError} once
 * more than `maxBytes` have been read so a runaway/poisoned artifact can never
 * balloon memory. Streams in `READ_CHUNK_BYTES` chunks — identical to the
 * capped reader ingest used inline before this seam.
 */
export function readArtifactTextCappedSync(filePath, maxBytes = ARTIFACT_FILE_MAX_BYTES) {
  const fd = openSync(filePath, 'r');
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw artifactFileTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** {@link readArtifactTextCappedSync} + `JSON.parse`. The bounded JSON read every
 *  producer uses for `~/.claude.json` and per-root repo-map artifacts. */
export function readArtifactJsonCappedSync(filePath, maxBytes = ARTIFACT_FILE_MAX_BYTES) {
  return JSON.parse(readArtifactTextCappedSync(filePath, maxBytes));
}

/**
 * @template T
 * @typedef {Object} HostProducedArtifact The producer half of the host-producer
 *   seam (ADR 0007): the on-disk envelope a host process writes under
 *   `~/.claude/usage-data/...` for the read-only runtime to consume. The
 *   persisted repo-map artifact (`PersistedRepoMap`) and the #280 `/insights`
 *   bridge output are both instances of this shape. Mirrors the TS
 *   `HostProducedArtifact<T>` in `src/lib/artifact-source.ts`.
 * @property {number} version Producer output-shape version (bumped via the
 *   parser-output seam #2075) so a stale envelope is not consumed.
 * @property {T} payload The structural payload the runtime reads. (The repo-map
 *   artifact names this field `map` for historical reasons — see
 *   {@link unwrapHostArtifactRoot}, which tolerates both.)
 */

/**
 * Extract the producer-stamped project root from a persisted host artifact,
 * tolerating both the `{ ..., map: {...} }` envelope (the repo-map producer
 * writes `map`) and a flat artifact. Returns the absolute root string, or null
 * when the value is not a usable map (no string `root` starting with `/`, or no
 * `files` array). This is the root-only unwrap discovery needs — the full
 * `RepoMap`-validating unwrap (`unwrapPersistedRepoMap` in repo-map/cache.ts)
 * stays the consumer's, but both agree on the root field so discovery is
 * identical across producers.
 */
export function unwrapHostArtifactRoot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw.map && typeof raw.map === 'object' ? raw.map : raw;
  if (
    typeof candidate.root !== 'string' ||
    !candidate.root.startsWith('/') ||
    !Array.isArray(candidate.files)
  ) {
    return null;
  }
  return candidate.root;
}

/**
 * Absolute project roots from a `~/.claude.json` `projects` map — the cwds the
 * user has worked in. Read through the CAPPED JSON reader so a huge `.claude.json`
 * cannot balloon memory (this closes the divergence where `repo-map-refresh.mjs`
 * read it uncapped). Returns [] when the file is absent/unreadable/not JSON.
 * Sorted for deterministic discovery.
 */
export function claudeJsonProjectRoots(claudeJsonPath, maxBytes = ARTIFACT_FILE_MAX_BYTES) {
  let raw;
  try {
    raw = readArtifactJsonCappedSync(claudeJsonPath, maxBytes);
  } catch {
    return [];
  }
  const projects =
    raw?.projects && typeof raw.projects === 'object' ? raw.projects : {};
  return Object.keys(projects)
    .filter((root) => typeof root === 'string' && root.startsWith('/'))
    .sort();
}

/**
 * Roots that already have a persisted repo-map artifact, decoded from each
 * artifact's own stamped `root` (so an existing map is rediscovered even if the
 * project dropped out of `~/.claude.json`). Bounded two ways: each artifact is
 * read through the CAPPED JSON reader, and at most `maxEntries` directory
 * entries are scanned (the runaway guard ingest enforced and refresh did not).
 * Deduped + sorted. Returns [] for a missing/unreadable artifact dir.
 */
export function repoMapArtifactRoots(
  repoMapDir,
  { maxEntries = REPO_MAP_ARTIFACT_MAX_ENTRIES, maxBytes = ARTIFACT_FILE_MAX_BYTES } = {}
) {
  let dir;
  try {
    dir = opendirSync(repoMapDir);
  } catch {
    return [];
  }
  const roots = [];
  let checked = 0;
  try {
    for (;;) {
      const ent = dir.readSync();
      if (!ent) break;
      if (checked >= maxEntries) break;
      checked += 1;
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        const root = unwrapHostArtifactRoot(
          readArtifactJsonCappedSync(join(repoMapDir, ent.name), maxBytes)
        );
        if (root) roots.push(root);
      } catch {
        /* skip unreadable / non-JSON / too-large artifact */
      }
    }
  } finally {
    dir.closeSync();
  }
  return [...new Set(roots)].sort();
}

// Re-export under the legacy name the old refresh inline reader used, so a
// `readFileSync`-based grep over scripts/ no longer finds an uncapped artifact
// read. (Documentation aid — the canonical names above are preferred.)
export { READ_CHUNK_BYTES };
