#!/usr/bin/env node
// Repo Map measurement gates (#893, epic #871). See ADR 0007 and
// docs/perf-sprint/repo-map.md.
//
// The epic's measurement plan and privacy non-goals call out four failure modes
// for the repo-map artifact: it can balloon cold-ingest cost, grow the dataset
// payload, lose localization quality (the map must surface the files a task
// actually needs), or stop reducing the reread/search waste it exists to cut.
// This gate quantifies each against a budget so a regression fails CI rather than
// shipping silently — the sibling of check-bundle-size.mjs / cold-load-measure.mjs.
//
// It runs HOST-SIDE (it generates the repo-map, which needs the WASM grammars):
//   node --import ./scripts/register-ts.mjs scripts/repo-map-gate.mjs
//   node --import ./scripts/register-ts.mjs scripts/repo-map-gate.mjs --root <dir>
//   ... --json out.json        also write the structured metrics
//   ... --measure-only         print numbers, do not gate (exit 0)
//   ... --budget <file>        override the budget JSON
//   ... --max-persisted-bytes  override the producer's size ceiling (tests)
//
// Metrics (each checked against repo-map-budget.json):
//   - unboundedPayloadBytes      what the artifact serializes to with NO size
//                                ceiling — the real growth signal, and the one
//                                that gates. The persisted size is CLAMPED to
//                                the ceiling by enforceSizeLimit, so gating it
//                                against an equal budget was a tautology that
//                                could never fail (#3452); it is now reported
//                                but not gated.
//   - retainedFilesPct           share of ranked files surviving the clamp, so
//                                an artifact silently shedding files fails here
//                                instead of only showing up as worse recall
//   - coldIngestMs               wall-clock to walk + parse + render cold
//   - localizationRecallPct      map's top-ranked files vs the files a task
//                                touches, on a sampled "session" set — the
//                                map must rank load-bearing files highly
//   - rereadWasteTokensSaved     reread/search tokens the map saves a session
//                                vs. the no-map baseline (token/reread reduction)
// Raise a ceiling deliberately, with a note, when a change is a real win.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const {
  generateRepoMap,
  renderRepoMap,
  computeCacheKey,
  enforceSizeLimit,
  serializedBytes,
  assertNoBodyLeakage,
  DEFAULT_MAX_PERSISTED_BYTES,
} = await import(join(REPO_ROOT, 'src', 'lib', 'repo-map', 'index.ts'));

function parseArgs(argv) {
  const out = { root: REPO_ROOT, budget: join(REPO_ROOT, 'repo-map-budget.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = resolve(argv[++i]);
    else if (a === '--budget') out.budget = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--measure-only') out.measureOnly = true;
    else if (a === '--max-persisted-bytes') {
      // The producer's real ceiling, overridable so a test can exercise the
      // size-bounding path without building a 1 MiB corpus. Parsed FAIL-CLOSED
      // (#3076): bad input exits non-zero rather than silently falling back to
      // a default and measuring something other than what was asked for.
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--max-persisted-bytes must be a positive integer, got: ${raw}`);
        process.exit(2);
      }
      out.maxPersistedBytes = n;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ Repo-map gate ERROR — ${msg}\n`);
  process.exit(2);
}

function hrMs() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

function gitShaOf(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Localization-quality probe.
//
// Ground-truth touched-file sets are derived deterministically from the map's
// OWN import graph: a file plus everything it imports is one "task's" working
// set — exactly the relationship a localizer must recover. For each high-fan-in
// file we ask: of the files this task touches, how many fall in the map's
// top-K ranked slice? That recall is the localization quality the epic measures
// (map's top-ranked files vs the files a successful session actually touched);
// here the sampled "sessions" are reproducible so the gate is deterministic.
// ---------------------------------------------------------------------------
function localizationRecallPct(map, topK, sampleSize) {
  const rankIndex = new Map(map.files.map((f, i) => [f.path, i]));
  const stemOf = (p) => p.replace(/\.[^./]+$/, '');
  const byStem = new Map(map.files.map((f) => [stemOf(f.path), f.path]));

  const resolveImport = (fromPath, spec) => {
    if (!spec.startsWith('.')) return null;
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const parts = (dir ? dir.split('/') : []).concat(stemOf(spec).split('/'));
    const stack = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    const joined = stack.join('/');
    return byStem.get(joined) ?? byStem.get(`${joined}/index`) ?? null;
  };

  // Sample the most-referenced files as task "seeds" (a real session most often
  // works near a hub file). The map is already ranked, so take the head.
  const seeds = map.files.slice(0, Math.min(sampleSize, map.files.length));
  let totalTouched = 0;
  let hits = 0;
  for (const seed of seeds) {
    const touched = new Set([seed.path]);
    for (const spec of seed.imports) {
      const target = resolveImport(seed.path, spec);
      if (target) touched.add(target);
    }
    for (const path of touched) {
      totalTouched++;
      const rank = rankIndex.get(path);
      if (rank != null && rank < topK) hits++;
    }
  }
  if (totalTouched === 0) return 100; // degenerate tiny root — nothing to miss
  return (hits / totalTouched) * 100;
}

// ---------------------------------------------------------------------------
// Reread/search-waste model.
//
// Without a map, an agent orienting in an unfamiliar root must scan (open + read
// + often re-read) source to find the handful of files it needs — it pays a cost
// proportional to the WHOLE tree's surface, because it does not yet know which
// files matter. With the map it reads one bounded, ranked fragment ONCE and is
// pointed straight at them. We model the SAVED tokens as the no-map scan surface
// minus the map fragment — the epic's "reread-token waste over time" lens.
//
// No-map surface is approximated as the full signature surface of every file
// (path + each symbol name/signature + imports), which the agent would touch
// piecemeal while searching; the conservative 0.5 factor assumes it scans about
// half the tree before locating its targets. Coarse (~4 chars/token, the
// dashboard's standard estimate) but monotonic: a denser, better-ranked map
// saves more, a bloated/redundant one saves less — what the gate keeps honest.
// ---------------------------------------------------------------------------
function rereadWasteTokensSaved(map) {
  // Full structural surface the agent would otherwise sift through, in chars.
  let surfaceChars = 0;
  for (const f of map.files) {
    surfaceChars += f.path.length;
    for (const s of f.symbols) surfaceChars += s.name.length + s.signature.length;
    for (const spec of f.imports) surfaceChars += spec.length;
  }
  const noMapScanChars = surfaceChars * 0.5; // scans ~half the tree to localize
  const mapChars = map.text.length; // reads the bounded fragment once
  const savedChars = Math.max(0, noMapScanChars - mapChars);
  return Math.round(savedChars / 4); // ~4 chars/token
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let budget;
  try {
    budget = JSON.parse(readFileSync(args.budget, 'utf8'));
  } catch (err) {
    die(`could not read budget file ${args.budget} (${err.message}).`);
  }

  const gitSha = gitShaOf(args.root);
  const tokenBudget = Number(process.env.REPO_MAP_TOKEN_BUDGET) || 8000;
  const maxFiles = Number(process.env.REPO_MAP_MAX_FILES) || undefined;
  const maxDirEntries = Number(process.env.REPO_MAP_MAX_DIR_ENTRIES) || undefined;

  // Cold ingest cost = generate from scratch (walk + parse + render).
  const t0 = hrMs();
  const map = await generateRepoMap(args.root, {
    gitSha,
    tokenBudget,
    maxFiles,
    maxDirEntries,
  });
  const coldIngestMs = hrMs() - t0;

  // Dataset payload (#3452). TWO figures, and only one of them can gate.
  //
  // `enforceSizeLimit` binary-searches the largest prefix of the ranked file
  // list that fits `maxPersistedBytes` and drops the rest, so the PERSISTED
  // size is clamped to that ceiling by construction. Comparing it against a
  // budget equal to the same ceiling — which is what this gate used to do —
  // is a tautology: `datasetPayloadBytes <= datasetPayloadMaxBytes` could
  // never be false, whatever the repo grew to. Growth was absorbed silently by
  // shedding ranked files instead of failing CI, which is the opposite of what
  // the gate exists for.
  //
  // So we gate the UNBOUNDED serialization — what the artifact would be if
  // nothing were dropped — which is the real growth signal and can actually
  // fail. The persisted figure is still reported (it is what ships) but is
  // deliberately NOT gated, because a clamped value cannot carry a budget.
  // We also gate how much of the map survives the clamp, so an artifact
  // quietly shedding ranked files is itself a failure rather than a silent
  // degradation that only ever surfaced on localization recall.
  // Measure the ceiling the PRODUCER will actually apply, or the retention check
  // guards an artifact nobody ships: scripts/repo-map-generate.mjs honors
  // REPO_MAP_MAX_BYTES, so a deployment setting it to 512 KiB ships far fewer
  // files than a gate hard-coded to the 1 MiB default would ever notice.
  // Precedence: explicit CLI flag > REPO_MAP_MAX_BYTES > built-in default.
  // Parsed fail-closed (#3076) — an unusable override is an error, not a silent
  // fallback that measures a different artifact than the one being shipped.
  const envMaxBytes = process.env.REPO_MAP_MAX_BYTES;
  let maxPersistedBytes = args.maxPersistedBytes ?? DEFAULT_MAX_PERSISTED_BYTES;
  if (args.maxPersistedBytes == null && envMaxBytes != null && envMaxBytes !== '') {
    const n = Number(envMaxBytes);
    if (!Number.isInteger(n) || n <= 0) {
      die(`REPO_MAP_MAX_BYTES must be a positive integer, got: ${envMaxBytes}`);
    }
    maxPersistedBytes = n;
  }
  const absFiles = map.files.map((f) => join(args.root, f.path));
  const cacheKey = computeCacheKey(args.root, gitSha, absFiles);
  const render = (files) => renderRepoMap(files, tokenBudget);
  const persisted = enforceSizeLimit(map, cacheKey, render, maxPersistedBytes);
  const datasetPayloadBytes = serializedBytes(persisted);
  // Same envelope, no ceiling — the size the artifact naturally wants to be.
  const unbounded = enforceSizeLimit(map, cacheKey, render, Number.MAX_SAFE_INTEGER);
  const unboundedPayloadBytes = serializedBytes(unbounded);
  const retainedFilesPct =
    map.files.length === 0
      ? 100
      : (persisted.map.files.length / map.files.length) * 100;

  // Privacy: even a measurement run asserts no bodies leaked. We can't know the
  // corpus's real secrets, but a non-empty structural map must still scan clean
  // against any sentinels the budget lists (defense in depth for CI).
  const sentinels = budget.bodySentinels || [];
  const leak = assertNoBodyLeakage(persisted, sentinels);
  if (!leak.ok) die(`body leakage: persisted artifact contains ${leak.leaked.join(', ')}`);

  const topK = budget.localizationTopK || 25;
  const sampleSize = budget.localizationSampleSize || 40;

  const metrics = {
    datasetPayloadBytes,
    unboundedPayloadBytes,
    retainedFiles: persisted.map.files.length,
    retainedFilesPct: +retainedFilesPct.toFixed(1),
    maxPersistedBytes,
    coldIngestMs: +coldIngestMs.toFixed(1),
    localizationRecallPct: +localizationRecallPct(map, topK, sampleSize).toFixed(1),
    rereadWasteTokensSaved: rereadWasteTokensSaved(map),
    fileCount: map.fileCount,
    sizeBounded: persisted.sizeBounded,
    droppedFiles: persisted.droppedFiles,
  };

  // Gate checks: max-ceilings for cost/payload, min-floors for the value metrics.
  // `required` is load-bearing (#3452): a missing or misspelled budget key used
  // to make its check silently pass and print "(no budget)" — the same
  // cannot-fail failure mode this file is being repaired for. All four are
  // mandatory, so an absent bound is an ERROR, not a free pass.
  const checks = [
    { name: 'payload (unbounded)', actual: metrics.unboundedPayloadBytes, bound: budget.unboundedPayloadMaxBytes, dir: 'max', unit: 'B', required: true },
    // Absolute COUNT, deliberately not a percentage. Retained-SHARE falls with
    // repo growth BY CONSTRUCTION — the byte ceiling is fixed, so the same
    // artifact covers a smaller fraction of a bigger tree — which would make a
    // percentage floor a self-lowering ratchet needing periodic renegotiation
    // with no regression having occurred (the #3471 pathology).
    //
    // The count is MORE ROBUST, not immune. It is bounded by
    // maxPersistedBytes / average retained entry size, so it holds steady while
    // that average holds; a batch of high-ranking files with large entries can
    // displace several smaller ones and lower it without any per-file bloat.
    // What it does not do is drift downward merely because the tree got bigger.
    // The share is still reported for humans.
    { name: 'files retained', actual: metrics.retainedFiles, bound: budget.retainedFilesMin, dir: 'min', unit: 'files', required: true },
    { name: 'cold ingest', actual: metrics.coldIngestMs, bound: budget.coldIngestMaxMs, dir: 'max', unit: 'ms', required: true },
    { name: 'localization recall', actual: metrics.localizationRecallPct, bound: budget.localizationRecallMinPct, dir: 'min', unit: '%', required: true },
    { name: 'reread tokens saved', actual: metrics.rereadWasteTokensSaved, bound: budget.rereadTokensSavedMin, dir: 'min', unit: 'tok', required: true },
  ];

  // In GATING mode a missing bound is fatal. `--measure-only` is exempt so a
  // new budget file can be bootstrapped from a measurement run — it cannot
  // silently pass a gate because it does not gate at all.
  const missing = checks
    .filter((c) => c.required && !Number.isFinite(c.bound))
    .map((c) => c.name);
  if (missing.length > 0 && !args.measureOnly) {
    die(
      `budget ${args.budget} is missing a numeric bound for: ${missing.join(', ')}. ` +
        'Every check here is mandatory — a missing key must not silently pass.',
    );
  }

  console.log(`\nRepo-map measurement gates — root ${args.root}`);
  console.log(`  (${metrics.fileCount} files, sha ${gitSha ?? 'none'}${metrics.sizeBounded ? `, size-bounded: dropped ${metrics.droppedFiles}` : ''})\n`);
  // Reported, never gated: this value is clamped to `maxPersistedBytes` by
  // construction, so any budget on it would be a tautology (#3452).
  console.log(
    `  · REPORT persisted payload      ${String(metrics.datasetPayloadBytes).padStart(12)} B   ` +
      `/ clamped to ${maxPersistedBytes} B (not gated — clamped value)`,
  );
  console.log(
    `  · REPORT files retained         ${String(metrics.retainedFiles).padStart(12)}     ` +
      `/ of ${map.files.length} ranked (${metrics.retainedFilesPct}% — see #3475)`,
  );
  const failures = [];
  for (const c of checks) {
    // A null bound only ever reaches here under --measure-only (gating mode
    // died above), so it can never silently pass a real gate.
    const unbudgeted = !Number.isFinite(c.bound);
    const ok = unbudgeted || (c.dir === 'max' ? c.actual <= c.bound : c.actual >= c.bound);
    const mark = unbudgeted ? '·' : ok ? '✓' : '✗';
    const boundStr = unbudgeted
      ? '(no budget — measure-only)'
      : `${c.dir === 'max' ? '<=' : '>='} ${c.bound} ${c.unit}`;
    console.log(`  ${mark} ${c.name.padEnd(22)} ${String(c.actual).padStart(12)} ${c.unit.padEnd(3)} / budget ${boundStr}`);
    if (!ok) failures.push(`${c.name} ${c.actual} ${c.unit} fails budget ${boundStr}`);
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(metrics, null, 2));
    console.log(`\nwrote metrics -> ${args.json}`);
  }

  if (args.measureOnly) {
    console.log('\n(measure-only: not gating)\n');
    return;
  }

  if (failures.length > 0) {
    console.error('\n✗ Repo-map gate BLOCKED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nIf the change is a real win (a denser map, a legitimately larger root), ' +
        'raise the relevant ceiling/floor in repo-map-budget.json with a note on ' +
        'why. Otherwise, trim the regression.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ Repo-map gate PASSED: all metrics within budget.\n');
}

main().catch((err) => die(err?.stack || String(err)));
