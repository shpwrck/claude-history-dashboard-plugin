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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
} = await import(join(PROJECT_DIR, 'src', 'lib', 'repo-map', 'index.ts'));

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

/** Read an existing persisted artifact, or null if absent/unparseable. */
function readPersisted(outFile) {
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    return null;
  }
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

const outDir = join(homedir(), '.claude', 'usage-data', 'repo-map');
mkdirSync(outDir, { recursive: true });
const outFile = artifactPathFor(outDir, root);

const map = await generateRepoMap(root, {
  gitSha,
  tokenBudget,
  maxFiles,
  maxDirEntries,
});

// Cache by project root + git sha / mtime watermark (#893): if a persisted map
// generated against the same signature already exists, the walk we just did is
// confirmed unchanged, so skip the rewrite unless --force.
const absFiles = map.files.map((f) => join(root, f.path));
const cacheKey = computeCacheKey(root, gitSha, absFiles);
const existing = readPersisted(outFile);
if (!force && isCacheValid(existing, cacheKey)) {
  console.log(
    `repo-map: cache hit (sha ${gitSha ?? 'none'}, ${map.fileCount} files) — ` +
      `artifact up to date, skipping write\n${outFile}`
  );
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

  console.log(
    `repo-map: ${persisted.map.fileCount} files indexed` +
      `${persisted.map.truncated ? `, text fragment token-budget-capped at ${tokenBudget}` : ''}` +
      `${persisted.sizeBounded ? `, size-bounded (dropped ${persisted.droppedFiles} low-rank files to fit ${maxBytes} B)` : ''}` +
      `, sha ${gitSha ?? 'none'}\nwrote ${outFile}`
  );
}
