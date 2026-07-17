#!/usr/bin/env node
/**
 * Repo Map host-side producer (#887 / ADR 0007).
 *
 * Generates the structural Repo Map for a project root and writes it to
 * `~/.claude/usage-data/repo-map/<encoded-root>.json` — the artifact the
 * read-only container consumes. This runs HOST-SIDE (where node_modules + the
 * WASM Tree-sitter grammars exist); the runtime never parses source. See ADR
 * 0007 for why generation is a host producer rather than an in-runtime parse.
 *
 * Usage:
 *   node --import ./scripts/register-ts.mjs scripts/repo-map-generate.mjs [root]
 * `root` defaults to the current working directory.
 *
 * The `.ts` generator is dynamic-imported so it resolves under the register-ts
 * loader, exactly like ingest.mjs loads the `parse-*.ts` modules.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  generateRepoMap,
  renderRepoMap,
  computeCacheKey,
  isCacheValid,
  enforceSizeLimit,
  artifactPathFor,
  DEFAULT_MAX_PERSISTED_BYTES,
  createRepoMapFileCache,
  createTsParseFile,
  repoMapParserCacheSalt,
  DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES,
} = await import(join(PROJECT_DIR, 'src', 'lib', 'repo-map', 'index.ts'));
const { normalizeGitRemoteUrl } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-docs-map.ts')
);

/** Best-effort git sha of the root for the staleness stamp; null if not a repo.
 *  A DIRTY tree returns null too, so the mtime watermark (not a stale sha)
 *  drives cache invalidation when there are uncommitted changes. */
function gitShaOf(root) {
  try {
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (dirty) return null; // uncommitted changes — fall back to mtime watermark
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Normalized `owner/repo` slug of the root's Git remote (#2709), or null when
 *  the root is not a repo / has no `origin` / the URL has no two-segment slug.
 *  Derived deterministically beside `gitShaOf` so the artifact's identity and
 *  staleness stamp always describe the same checkout; the shared pure
 *  normalizer keeps this identity byte-identical to the ingest-side docs-map
 *  wrapper derivation. */
function repositoryOf(root) {
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Match ingest's docsMapGitOutput probe environment: both sides derive
      // "the SAME identity", so the probes must not diverge (a lazy-fetch
      // side effect here could stall or alter the derivation). Full probe
      // consolidation is tracked separately (#2745).
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    }).trim();
    return normalizeGitRemoteUrl(remote);
  } catch {
    return null;
  }
}

/** Read an existing persisted artifact, or null if absent/unparseable. */
function readPersisted(outFile) {
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return null;
  }
}

/** Resolve existing symlink ancestors while tolerating a not-yet-created leaf. */
function canonicalDirectory(path) {
  const suffix = [];
  let cursor = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

const root = resolve(process.argv[2] ?? process.cwd());
const force = process.argv.includes('--force');
const gitSha = gitShaOf(root);

// A generous budget for the persisted text fragment; the full structured index
// (`map.files`) is unbudgeted, and prompt consumers (#891) re-render at their own
// budget. Override with REPO_MAP_TOKEN_BUDGET.
const tokenBudget = Number(process.env.REPO_MAP_TOKEN_BUDGET) || 8000;
// Discovery caps. REPO_MAP_MAX_FILES bounds retained source files;
// REPO_MAP_MAX_DIR_ENTRIES bounds directory entries inspected before parsing.
const maxFiles = Number(process.env.REPO_MAP_MAX_FILES) || undefined;
const maxDirEntries = Number(process.env.REPO_MAP_MAX_DIR_ENTRIES) || undefined;
// Hard ceiling on the persisted artifact's serialized size, override with
// REPO_MAP_MAX_BYTES; bounds the dataset payload one root contributes (#893).
const maxBytes = Number(process.env.REPO_MAP_MAX_BYTES) || DEFAULT_MAX_PERSISTED_BYTES;
// Disposable, host-only parse cache. Keep it OUTSIDE the runtime artifact tree:
// repo-map artifact discovery treats every top-level JSON file there as a
// consumer artifact. XDG/REPO_MAP_FILE_CACHE_DIR also make the cache location
// explicit and independently erasable.
const cacheBase = process.env.REPO_MAP_FILE_CACHE_DIR
  ? resolve(process.env.REPO_MAP_FILE_CACHE_DIR)
  : join(
      process.env.XDG_CACHE_HOME
        ? resolve(process.env.XDG_CACHE_HOME)
        : join(homedir(), '.cache'),
      'claude-history-dashboard',
      'repo-map'
    );
const fileCacheMaxBytes =
  Number(process.env.REPO_MAP_FILE_CACHE_MAX_BYTES) ||
  DEFAULT_REPO_MAP_FILE_CACHE_MAX_BYTES;

const outDir = join(homedir(), '.claude', 'usage-data', 'repo-map');
mkdirSync(outDir, { recursive: true });
const canonicalOutDir = canonicalDirectory(outDir);
const canonicalCacheBase = canonicalDirectory(cacheBase);
if (isWithin(canonicalOutDir, canonicalCacheBase)) {
  throw new Error(
    'REPO_MAP_FILE_CACHE_DIR must resolve outside the runtime repo-map artifact directory'
  );
}
const outFile = artifactPathFor(outDir, root);
const fileCacheFile = artifactPathFor(cacheBase, root);

const fileCache = createRepoMapFileCache({
  cacheFile: fileCacheFile,
  salt: repoMapParserCacheSalt(),
  // Do not initialize Tree-sitter/WASM unless at least one file misses. Warm
  // multi-root refreshes stay at walk/read/hash cost only.
  parseFileFactory: createTsParseFile,
  reuse: !force,
  maxEntries: maxFiles,
  maxBytes: fileCacheMaxBytes,
});

const map = await generateRepoMap(root, {
  gitSha,
  repository: repositoryOf(root),
  tokenBudget,
  maxFiles,
  maxDirEntries,
  parseFile: fileCache.parseFile,
});
// Cache by project root + git sha / mtime watermark (#893): if a persisted map
// generated against the same signature already exists, the walk we just did is
// confirmed unchanged, so skip the rewrite unless --force.
const absFiles = map.files.map((f) => join(root, f.path));
const cacheKey = computeCacheKey(
  root,
  gitSha,
  absFiles,
  fileCache.structureSignature()
);
const existing = readPersisted(outFile);
// A grammar/content/path cohort change MUST refresh the canonical artifact even
// when the old git-sha/mtime watermark compares equal. Otherwise a salt swap,
// a preserved-mtime rewrite, or a deletion could leave stale structures served.
const artifactCacheHit =
  !force && !fileCache.cohortChanged() && isCacheValid(existing, cacheKey);
let artifactSummary;
if (artifactCacheHit) {
  artifactSummary =
    `repo-map: cache hit (sha ${gitSha ?? 'none'}, ${map.fileCount} files) — ` +
    `artifact up to date, skipping write\n${outFile}`;
} else {
  // Enforce the persisted size limit: trim the lowest-ranked files until the
  // serialized envelope fits, re-rendering the text fragment to match.
  const persisted = enforceSizeLimit(
    map,
    cacheKey,
    (files) => renderRepoMap(files, tokenBudget),
    maxBytes
  );
  // Persist COMPACT JSON: the artifact is machine-read by the runtime, and the
  // size limit (#893) is enforced against this compact serialization — a
  // pretty-printed write would exceed the byte ceiling enforceSizeLimit() just
  // guaranteed.
  writeFileSync(outFile, JSON.stringify(persisted));

  artifactSummary =
    `repo-map: ${persisted.map.fileCount} files indexed` +
    `${persisted.map.truncated ? `, text fragment token-budget-capped at ${tokenBudget}` : ''}` +
    `${persisted.sizeBounded ? `, size-bounded (dropped ${persisted.droppedFiles} low-rank files to fit ${maxBytes} B)` : ''}` +
    `, sha ${gitSha ?? 'none'}\nwrote ${outFile}`;
}

// Commit disposable performance state only AFTER the canonical artifact write
// succeeds. If that write fails, the old cohort remains and the next run must
// miss/retry instead of accepting a stale artifact as warm.
const fileCacheCommit = fileCache.commit();
const fileCacheSummary =
  `parse cache ${fileCache.stats.hits} hits, ${fileCache.stats.misses} misses, ` +
  `${fileCacheCommit.entryCount} retained`;
console.log(`${artifactSummary}\nrepo-map: ${fileCacheSummary}`);
