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
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared host-producer seam (#2077, ADR 0007): the SAME capped, entry-bounded
// root discovery ingest uses. This replaces the driver's previous UNCAPPED
// `JSON.parse(readFileSync(...))` reads of `~/.claude.json` and each repo-map
// artifact (a real robustness gap — a runaway artifact could OOM the deploy) and
// drops the inline root-unwrap that duplicated ingest's. Imported as `.mjs` so it
// loads under the deploy path's bare `node` (no register-ts), preserving ADR
// 0007's zero-node_modules boot constraint.
import {
  claudeJsonProjectRoots,
  repoMapArtifactRoots,
} from './lib/host-producer.mjs';

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

/** Dedup discovery (`~/.claude.json` project roots + roots that already have a
 *  persisted artifact), keep only roots that are real directories on disk, sort
 *  for determinism, and bound the count. Discovery comes from the shared
 *  host-producer seam, so it is capped + entry-bounded identically to ingest
 *  (#2077). Returns { roots, discovered, capped }. */
function discoverRoots() {
  const all = [
    ...new Set([
      ...claudeJsonProjectRoots(CLAUDE_JSON),
      ...repoMapArtifactRoots(REPO_MAP_DIR),
    ]),
  ];
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

/** Pick the most informative line from a crashed child's stderr/message.
 *
 *  Node prints a `Node.js vX.Y.Z` banner as the FINAL line of every uncaught
 *  exception, so naively taking the last line reported "FAILED <root> — Node.js
 *  v24.15.0" for a plain missing-dependency crash — a version-looking red
 *  herring that hid the real cause. Prefer the first line that names an error,
 *  skipping stack frames (`at …`) and the trailing banner; fall back to the
 *  last non-noise line, then to the raw last line. Pure string logic — no heavy
 *  imports (keeps the ADR 0007 boundary: the driver never pulls in the parser). */
export function meaningfulStderrLine(raw) {
  const lines = (raw ?? '')
    .toString()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const informative = lines.filter(
    (l) => !/^Node\.js v\d/.test(l) && !/^at\s/.test(l)
  );
  const errLine = informative.find((l) => /(^|[\s[])[A-Za-z]*Error\b/.test(l));
  return errLine || informative[informative.length - 1] || lines[lines.length - 1];
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
    const detail = meaningfulStderrLine(err.stderr || err.message || '');
    // The host-side producer needs devDeps (the WASM grammar packages — ADR
    // 0007); a stale/prod-only `node_modules` in the deploy checkout surfaces
    // here as a module-not-found. Point at the one-line fix, not a cryptic crash.
    const hint = /Cannot find package|ERR_MODULE_NOT_FOUND/.test(detail)
      ? ' (host-side devDeps missing — run `npm ci` in this checkout; see ADR 0007)'
      : '';
    console.error(`repo-map-refresh: FAILED ${root} — ${detail}${hint}`);
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

// Run main() only when invoked as a script, so the module can be imported for
// unit testing (`meaningfulStderrLine`) without executing the driver / exiting.
const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
