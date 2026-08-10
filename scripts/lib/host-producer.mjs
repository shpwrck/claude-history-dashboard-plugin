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
// ZERO node_modules (ADR 0007): this module's import graph contains only `node:`
// builtins and dependency-free local `.mjs` helpers, so it is safe in the server
// boot graph (ingest.mjs imports it through the register-ts loader) AND in the
// plain-`node` deploy path (`repo-map-refresh.mjs` runs under bare `node`, NOT
// register-ts, so it can only import `.mjs` — never a `.ts`).
// That constraint is WHY this is `.mjs` and not `.ts`: it must load both ways.
// The symmetric TS-typed CONSUMER contract (`HostProducedArtifact<T>`) lives in
// `src/lib/artifact-source.ts`; this file is its runtime producer half and the
// JSDoc `@typedef` below mirrors that type for the `.mjs` callers.

import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, opendirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isFullGitHead } from './git-identity.mjs';
export {
  FULL_GIT_HEAD_RE,
  GIT_COMMIT_PREFIX_RE,
  isFullGitHead,
  isGitCommitPrefix,
} from './git-identity.mjs';
export {
  atomicWriteFileExclusiveSync as atomicWrite,
  ensureContainedDirSync,
} from './safe-write.mjs';

/** Reader chunk size, matching ingest's streaming cap reader. */
const READ_CHUNK_BYTES = 65_536;
/** Shared ceiling for Git output retained in memory by host producers. */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function commandText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

/**
 * Run one required, local-only Git command and return its RAW stdout.
 *
 * Raw output is load-bearing: callers consume NUL-delimited path streams, so
 * trimming here would corrupt legal leading/trailing-whitespace filenames.
 * Scalar callers trim at their own boundary. The injectable `spawn` keeps the
 * doc-hygiene producer dependency-free and unit-testable.
 */
export function requiredGit(
  root,
  args,
  {
    label = 'run git',
    prefix = 'host-producer',
    spawn = spawnSync,
    env = process.env,
    timeout,
    maxBuffer = GIT_MAX_BUFFER_BYTES,
  } = {}
) {
  const result = spawn('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    timeout,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    const detail =
      commandText(result.stderr).trim() ||
      result.error?.message ||
      'unknown error';
    throw new Error(`${prefix}: cannot ${label}: ${detail}`);
  }
  return commandText(result.stdout);
}

/**
 * Resolve a canonical full HEAD object id. Optional callers receive `null` for
 * a missing/invalid repository; required callers receive the contextual Git
 * error. `requireClean` preserves repo-map's distinct dirty-tree contract: a
 * dirty checkout has no commit identity and must use its mtime watermark.
 */
export function headSha(
  root,
  {
    spawn = spawnSync,
    env = process.env,
    requireClean = false,
    required = false,
    prefix = 'host-producer',
    timeout,
    maxBuffer = GIT_MAX_BUFFER_BYTES,
  } = {}
) {
  const gitOptions = { spawn, env, prefix, timeout, maxBuffer };
  try {
    if (
      requireClean &&
      requiredGit(root, ['status', '--porcelain'], {
        ...gitOptions,
        label: 'inspect working-tree state',
      }).trim()
    ) {
      return null;
    }
    const sha = requiredGit(
      root,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { ...gitOptions, label: 'resolve HEAD' }
    ).trim();
    if (!isFullGitHead(sha)) {
      throw new Error(`${prefix}: unexpected HEAD commit: ${sha || '<empty>'}`);
    }
    return sha.toLowerCase();
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

/**
 * Resolve the expected host-produced artifact commit from one feature-specific
 * env seam followed by named fallbacks. Empty exported compose stamps count as
 * unset; a non-empty candidate is returned verbatim for the consumer's own
 * full-hash or prefix-binding validator to judge.
 */
export function resolveExpectedCommit(
  primaryEnvName,
  {
    env = process.env,
    fallbackEnvNames = ['GIT_SHA'],
    fallback = null,
  } = {}
) {
  for (const name of [primaryEnvName, ...fallbackEnvNames]) {
    const value = env?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
}

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
 * Bounded read of an append-only JSONL ledger that DEGRADES instead of refusing
 * (#2152, epic #2147). {@link readArtifactTextCappedSync} throws on an oversized
 * file — the right call for one JSON artifact, but for a growing ledger the
 * caller would swallow the throw and serve NOTHING, silently zeroing a view that
 * had months of evidence a byte earlier. Here an oversized ledger instead yields
 * its newest `maxBytes` tail: seek to `size - maxBytes`, drop the first
 * (possibly partial) line, and flag `truncated: true` so every consumer surfaces
 * the cut instead of hiding it. The tail keeps the NEWEST records — the right
 * degradation for an append-only experiment stream.
 *
 * Returns `{ text, truncated, totalBytes }`.
 */
export function readJsonlTailCappedSync(filePath, maxBytes = ARTIFACT_FILE_MAX_BYTES) {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      return { text: readFileSync(fd, 'utf8'), truncated: false, totalBytes: size };
    }
    // Read ONE extra byte before the window: if it is '\n', the window starts
    // exactly on a record boundary and its first line is a complete record —
    // dropping it would silently lose one intact newest-window row.
    const start = size - maxBytes - 1;
    const tail = Buffer.allocUnsafe(maxBytes + 1);
    let done = 0;
    while (done < tail.length) {
      const n = readSync(fd, tail, done, tail.length - done, start + done);
      if (n === 0) break;
      done += n;
    }
    let text = tail.subarray(0, done).toString('utf8');
    if (text.startsWith('\n')) {
      text = text.slice(1); // boundary-aligned: keep the whole window
    } else {
      // Drop the first (mid-record) partial line.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return { text, truncated: true, totalBytes: size };
  } finally {
    closeSync(fd);
  }
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
