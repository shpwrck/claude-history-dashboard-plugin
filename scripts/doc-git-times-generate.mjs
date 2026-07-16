#!/usr/bin/env node
/**
 * doc-git-times-generate.mjs — bounded host/CI producer for the per-document
 * Git last-commit-time manifest (#2707, epic #2256).
 *
 * The runtime image carries no `.git`, so without this artifact every doc's
 * "as-of" clock degrades to the Docker COPY mtime. This producer runs where
 * FULL history exists (local deploy checkout, publish workflow with
 * `fetch-depth: 0`), resolves the last commit touching each tracked Markdown
 * doc with ONE batched `git log`, and writes a deterministic manifest to
 * `data/doc-git-times.json` (git-ignored, packaged into the image via the
 * existing `data/` COPY). Consumer contract: src/lib/doc-git-times.ts.
 *
 * FAIL CLOSED, never partial: a shallow repository, a failed git command,
 * truncated output, an exhausted commit cap with uncovered paths, an
 * over-cap doc set, or a `--root` below the repository toplevel exits
 * non-zero WITHOUT touching the output file — a stale manifest is harmless
 * (its sourceCommit no longer matches the runtime), a fabricated one is not.
 * (`--root` must be a repo TOPLEVEL: `git status --porcelain` emits
 * root-relative paths while `ls-files` emits cwd-relative ones, so below the
 * toplevel the dirty-doc exclusion would silently no-op.) Dirty/untracked
 * docs are simply omitted: their working-tree content is not HEAD's, so no
 * commit time can be asserted for them (they fall to `filesystem` provenance
 * at runtime).
 *
 * This is an ADR-0007 host producer: zero npm dependencies, never runs in the
 * runtime container.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOC_GIT_TIMES_SCHEMA_VERSION = 1;
export const DOC_GIT_TIMES_RELPATH = 'data/doc-git-times.json';
/** Mirrors the doc-graph walk cap (parse-docs DEFAULT_MAX_FILES). */
export const DOC_GIT_TIMES_MAX_FILES = 5000;
/** History-walk bound. Generous (full-history host), but still finite. */
export const DOC_GIT_TIMES_MAX_COMMITS = 65536;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/** Same doc surface as parse-docs' DOC_GRAPH_GIT_PATHS: root *.md + docs/**. */
export const DOC_GIT_PATHSPECS = [':(glob)*.md', ':(glob)docs/**/*.md'];

class ProducerError extends Error {}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    // Commit reads must never hydrate a partial clone over the network.
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
}

function requiredGit(root, args, label) {
  try {
    return git(root, args);
  } catch (error) {
    const detail =
      (typeof error?.stderr === 'string' && error.stderr.trim()) ||
      error?.message ||
      'unknown error';
    throw new ProducerError(`doc-git-times: cannot ${label}: ${detail}`);
  }
}

/** Fail closed unless `root` is a real repository with FULL (non-shallow) history. */
export function assertFullHistory(root) {
  const shallow = requiredGit(
    root,
    ['rev-parse', '--is-shallow-repository'],
    'verify repository depth'
  ).trim();
  if (shallow !== 'false') {
    throw new ProducerError(
      'doc-git-times: repository is shallow (or depth is unverifiable) — ' +
        'a shallow checkout grafts old files onto the boundary commit, so ' +
        'per-path last-commit times would be fabricated. Fetch full history ' +
        '(fetch-depth: 0) and re-run.'
    );
  }
}

/**
 * The two porcelain surfaces joined below use DIFFERENT path bases when the
 * process runs under a subdirectory of the repository (`status --porcelain`
 * is root-relative, `ls-files` is cwd-relative), which would silently disable
 * the dirty-doc exclusion. Fail closed instead of mis-joining.
 */
export function assertRepoToplevel(root) {
  const prefix = requiredGit(
    root,
    ['rev-parse', '--show-prefix'],
    'verify repository toplevel'
  ).trim();
  if (prefix !== '') {
    throw new ProducerError(
      `doc-git-times: --root must be a repository toplevel (got subdirectory prefix "${prefix}"); ` +
        'status/ls-files path bases diverge below the toplevel, so dirty-doc ' +
        'exclusion would silently no-op. Point --root at the repository root.'
    );
  }
}

/** Tracked Markdown doc paths (repo-relative POSIX) under the doc pathspecs. */
export function trackedDocPaths(root) {
  const out = requiredGit(
    root,
    ['ls-files', '-z', '--', ...DOC_GIT_PATHSPECS],
    'enumerate tracked docs'
  );
  return out.split('\0').filter(Boolean).sort();
}

/**
 * Doc paths whose working tree differs from HEAD (modified, deleted, renamed,
 * or untracked). No commit time can be asserted for these — they are omitted
 * from the manifest and carry `filesystem` provenance at runtime.
 */
export function dirtyDocPaths(root) {
  const out = requiredGit(
    root,
    ['status', '--porcelain', '-z', '--', ...DOC_GIT_PATHSPECS],
    'inspect working-tree state'
  );
  const dirty = new Set();
  // -z format: `XY <path>\0` with a SECOND `\0`-terminated field (the origin
  // path) after any rename/copy record. Both sides are dirty.
  const fields = out.split('\0').filter(Boolean);
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    dirty.add(field.slice(3));
    if (status[0] === 'R' || status[0] === 'C') {
      i += 1;
      if (fields[i]) dirty.add(fields[i]);
    }
  }
  return dirty;
}

/**
 * Resolve the last commit time for every path in `wanted` with one batched
 * newest-first `git log`. Throws unless EVERY wanted path is covered before
 * the commit cap runs out — partial coverage is a fail, not a manifest.
 */
export function lastCommitTimes(root, wanted) {
  const times = new Map();
  if (wanted.size === 0) return times;
  const output = requiredGit(
    root,
    [
      'log',
      `--max-count=${DOC_GIT_TIMES_MAX_COMMITS}`,
      '--format=CHD-DATE:%cI%x00',
      '--name-only',
      '-z',
      '--relative',
      '--',
      ...DOC_GIT_PATHSPECS,
    ],
    'walk doc history'
  );
  let commitTime = null;
  let commits = 0;
  for (const raw of output.split('\0')) {
    if (raw.startsWith('CHD-DATE:')) {
      commitTime = raw.slice('CHD-DATE:'.length).trim();
      commits += 1;
      continue;
    }
    const path = raw.replace(/^\n+/, '');
    if (commitTime && wanted.has(path) && !times.has(path)) {
      times.set(path, commitTime);
    }
  }
  if (times.size !== wanted.size) {
    const missing = [...wanted].filter((p) => !times.has(p));
    throw new ProducerError(
      `doc-git-times: history walk left ${missing.length} tracked doc(s) ` +
        `uncovered (first: ${missing[0]})` +
        (commits >= DOC_GIT_TIMES_MAX_COMMITS
          ? ` — commit cap of ${DOC_GIT_TIMES_MAX_COMMITS} exhausted`
          : ' — history appears incomplete') +
        '; refusing to write a partial manifest.'
    );
  }
  return times;
}

/**
 * Build the manifest object for `root`, or throw a ProducerError. Deterministic
 * for a given repository state: sorted keys, no wall-clock fields.
 */
export function buildManifest(root, { maxFiles = DOC_GIT_TIMES_MAX_FILES } = {}) {
  assertFullHistory(root);
  assertRepoToplevel(root);
  const sourceCommit = requiredGit(root, ['rev-parse', 'HEAD'], 'resolve HEAD').trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    throw new ProducerError(`doc-git-times: unexpected HEAD commit: ${sourceCommit}`);
  }
  const tracked = trackedDocPaths(root);
  if (tracked.length > maxFiles) {
    throw new ProducerError(
      `doc-git-times: ${tracked.length} tracked docs exceed the ${maxFiles}-entry cap; ` +
        'refusing to write an over-cap manifest.'
    );
  }
  const dirty = dirtyDocPaths(root);
  const clean = tracked.filter((path) => !dirty.has(path));
  const times = lastCommitTimes(root, new Set(clean));
  const files = {};
  for (const path of clean) files[path] = times.get(path);
  return {
    schemaVersion: DOC_GIT_TIMES_SCHEMA_VERSION,
    sourceCommit,
    complete: true,
    files,
  };
}

/** Atomic write: the output path never holds a torn/partial manifest, and a
 *  failed write never strands the temp file. */
export function writeManifest(outFile, manifest) {
  mkdirSync(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(tmp, outFile);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup — the original error is what matters */
    }
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  let root = process.cwd();
  let out = null;
  let maxFiles = DOC_GIT_TIMES_MAX_FILES;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--out' || arg === '--max-files') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`doc-git-times: ${arg} requires a value`);
        return 2;
      }
      i += 1;
      if (arg === '--root') root = value;
      else if (arg === '--out') out = value;
      else maxFiles = Number(value);
    } else {
      console.error(`doc-git-times: unknown argument: ${arg}`);
      return 2;
    }
  }
  if (!root || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    console.error('doc-git-times: invalid --root/--max-files');
    return 2;
  }
  root = resolve(root);
  const outFile = out ? resolve(out) : join(root, DOC_GIT_TIMES_RELPATH);
  try {
    const manifest = buildManifest(root, { maxFiles });
    writeManifest(outFile, manifest);
    console.log(
      `doc-git-times: wrote ${Object.keys(manifest.files).length} doc time(s) ` +
        `at ${manifest.sourceCommit.slice(0, 12)} -> ${outFile}`
    );
    return 0;
  } catch (error) {
    if (error instanceof ProducerError) {
      console.error(error.message);
      return 1;
    }
    console.error(`doc-git-times: unexpected failure: ${error?.message || error}`);
    return 1;
  }
}

// Node realpaths the ESM main-module URL while argv[1] stays lexical, so under
// any symlinked path segment a lexical comparison FAILS OPEN: the guard misses,
// main() never runs, and the process exits 0 having written NOTHING. Canonicalize
// both sides (falling back to the lexical form when realpath itself fails).
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (
  process.argv[1] &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))
) {
  process.exit(main());
}
