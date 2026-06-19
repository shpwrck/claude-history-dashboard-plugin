#!/usr/bin/env node
/**
 * Repo Map host-side REFRESH driver (#1650, epic #1264; producer #887 / ADR 0007).
 *
 * The repo-map substrate shipped a complete producer -> consumer -> UI chain
 * (epic #871), but NOTHING ever ran the producer: no artifact was ever written,
 * so `readRepoMapArtifact` returned null, `dataset.repoMap` stayed empty, and the
 * `context.repo-map-context-waste` card never appeared on real data. This driver
 * is the missing trigger's reusable core: it discovers the project roots the
 * dashboard already ingests and runs the host-side producer
 * (`repo-map-generate.mjs`) for each one, so the artifacts the runtime consumes
 * actually exist.
 *
 * It is HOST-SIDE by construction (ADR 0007): generation needs devDeps + the WASM
 * Tree-sitter grammars, which the zero-node_modules runtime container does not
 * have (#1013/#1195). So this is wired into the deploy/refresh path
 * (`npm run deploy` / `scripts/deploy.sh`), NEVER into the server boot graph — it
 * spawns the producer as a child process and is unreachable from `server.mjs`.
 *
 * Root discovery mirrors ingest's own live-config root set: the `projects` keys of
 * `~/.claude.json` (the absolute cwds the user has worked in), plus any roots that
 * already have an artifact (so an existing map is refreshed even if the project
 * dropped out of `~/.claude.json`). Roots that no longer exist on disk are
 * skipped. The producer's own cache/staleness/size guards (#893) make each run
 * incremental — unchanged roots are a cheap cache hit, not a rewrite.
 *
 * Best-effort: a single root failing to parse does not abort the rest (or the
 * deploy). Usage:
 *   node scripts/repo-map-refresh.mjs            # refresh all discovered roots
 *   REPO_MAP_REFRESH_FORCE=1 node scripts/...    # ignore the cache, rewrite all
 *   REPO_MAP_REFRESH_MAX_ROOTS=10 node ...       # bound how many roots are walked
 */
import { execFileSync } from 'node:child_process';
import { opendirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const REPO_MAP_DIR = join(HOME, '.claude', 'usage-data', 'repo-map');
const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');
const GENERATOR = join(PROJECT_DIR, 'scripts', 'repo-map-generate.mjs');

/** Hard cap on roots walked per run — a runaway guard for a machine with a huge
 *  `~/.claude.json`. Override with REPO_MAP_REFRESH_MAX_ROOTS. */
const MAX_ROOTS = Number(process.env.REPO_MAP_REFRESH_MAX_ROOTS) || 50;
/** Per-root wall-clock budget so one pathological tree can't stall the deploy. */
const PER_ROOT_TIMEOUT_MS = Number(process.env.REPO_MAP_REFRESH_TIMEOUT_MS) || 120_000;
const FORCE = process.env.REPO_MAP_REFRESH_FORCE === '1';

/** Absolute project roots from `~/.claude.json`'s `projects` map (the same set
 *  ingest's `claudeJsonProjectRoots()` uses), or [] if the file is absent. */
function claudeJsonProjectRoots() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
  } catch {
    return [];
  }
  const projects =
    raw?.projects && typeof raw.projects === 'object' ? raw.projects : {};
  return Object.keys(projects).filter((r) => typeof r === 'string' && r.startsWith('/'));
}

/** Roots that already have a persisted artifact, decoded from each artifact's
 *  own `root` field (mirrors ingest's `repoMapArtifactRoots()`), so an existing
 *  map is refreshed even if the project left `~/.claude.json`. */
function existingArtifactRoots() {
  let dir;
  try {
    dir = opendirSync(REPO_MAP_DIR);
  } catch {
    return [];
  }
  const roots = [];
  try {
    for (let ent = dir.readSync(); ent; ent = dir.readSync()) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(REPO_MAP_DIR, ent.name), 'utf8'));
        // Producer persists the PersistedRepoMap envelope `{ ..., map: RepoMap }`
        // (#893); the root lives at `raw.map.root`. Unwrap it (tolerate a flat
        // artifact too) — reading `raw.root` directly always missed (#1650).
        const map = raw && typeof raw.map === 'object' ? raw.map : raw;
        if (typeof map?.root === 'string' && map.root.startsWith('/')) roots.push(map.root);
      } catch {
        /* skip unreadable/!JSON artifact */
      }
    }
  } finally {
    dir.closeSync();
  }
  return roots;
}

/** Dedup discovery, keep only roots that are real directories on disk, sort for
 *  determinism, and bound the count. Returns { roots, discovered, capped }. */
function discoverRoots() {
  const all = [...new Set([...claudeJsonProjectRoots(), ...existingArtifactRoots()])];
  const onDisk = all
    .filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  return { roots: onDisk.slice(0, MAX_ROOTS), discovered: onDisk.length, capped: onDisk.length > MAX_ROOTS };
}

/** Run the host-side producer for one root. Returns 'written' | 'cache-hit' |
 *  'error'. Never throws — a failing root is logged and the rest continue. */
function generate(root) {
  const args = ['--import', REGISTER_TS, GENERATOR, root];
  if (FORCE) args.push('--force');
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: PER_ROOT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The producer prints "cache hit ... skipping write" when the artifact is
    // already current (#893), else "wrote <path>".
    const hit = /cache hit/.test(out);
    console.log(`repo-map-refresh: ${hit ? 'up to date' : 'regenerated'} ${root}`);
    return hit ? 'cache-hit' : 'written';
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim().split('\n').slice(-1)[0];
    console.error(`repo-map-refresh: FAILED ${root} — ${detail}`);
    return 'error';
  }
}

function main() {
  const { roots, discovered, capped } = discoverRoots();
  if (discovered === 0) {
    console.log(
      'repo-map-refresh: no project roots discovered ' +
        `(no readable ${CLAUDE_JSON} projects and no existing artifacts) — nothing to do`
    );
    return 0;
  }
  if (capped) {
    console.log(
      `repo-map-refresh: ${discovered} roots discovered, capping at ${MAX_ROOTS} ` +
        `(raise REPO_MAP_REFRESH_MAX_ROOTS to cover the rest)`
    );
  }
  const tally = { written: 0, 'cache-hit': 0, error: 0 };
  for (const root of roots) tally[generate(root)] += 1;
  console.log(
    `repo-map-refresh: done — ${roots.length} roots: ` +
      `${tally.written} regenerated, ${tally['cache-hit']} up to date, ${tally.error} failed`
  );
  // Best-effort for the deploy hook: per-root failures are logged but do not
  // fail the run, so a single bad tree never blocks a deploy.
  return 0;
}

process.exit(main());
