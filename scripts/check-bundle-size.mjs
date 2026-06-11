#!/usr/bin/env node
// Per-flavor JS bundle-size budget gate (#664, epic #638).
//
// PF6 + the victory/react-charts stack make it easy to bloat the bundle with no
// guardrail. This script reads the emitted `dist/assets/*.js` for ONE build
// flavor and fails (non-zero exit) when the total — or a budgeted heavy chunk —
// exceeds the ceiling committed in bundle-budget.json. It reuses the vite build
// output; no new bundler, no manifest plugin.
//
// Run it right after a flavor's build, against that flavor's dist/:
//   npx vite build      && node scripts/check-bundle-size.mjs --flavor server
//   npm run build:spa   && node scripts/check-bundle-size.mjs --flavor spa
//
// Wired into .github/workflows/ci.yml (the `build` job covers server, the
// `spa-boundary` job covers spa) so a PR that regresses past the budget fails
// CI. Raise the budget deliberately — with justification — when growth is real;
// the baselines carry ~5% headroom so normal churn does not trip it.
//
// Flags:
//   --flavor server|spa   (required) which budget block to enforce
//   --dist <dir>          dist root to measure (default: dist)
//   --budget <file>       budget JSON (default: bundle-budget.json at repo root)

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

function parseArgs(argv) {
  const out = { dist: 'dist', budget: join(REPO_ROOT, 'bundle-budget.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--flavor') out.flavor = argv[++i];
    else if (a === '--dist') out.dist = argv[++i];
    else if (a === '--budget') out.budget = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ Bundle-size gate ERROR — ${msg}\n`);
  process.exit(2);
}

function fmtBytes(n) {
  return `${n.toLocaleString('en-US')} B (${(n / 1024).toFixed(1)} kB)`;
}

// Recover a Vite chunk's logical name from its emitted filename. Vite names
// chunks `<name>-<hash>.js` where <hash> is an 8-char base64url string — which
// ITSELF can contain '-' (e.g. `index-lRh-i5lm.js`), so splitting on the last
// dash is wrong. Strip exactly the trailing `-<8 hash chars>` instead. Matching
// budgeted chunks by EXACT logical name (not a `<name>-` prefix) is deliberate:
// it keeps a sibling like `index-worker-<hash>.js` from folding into the `index`
// entry-chunk row, and the pattern is fixed (the budget key is never
// interpolated into a regex, so a key with metachars can't widen the match).
export function chunkBaseName(filename) {
  const stem = filename.replace(/\.js$/, '');
  const m = stem.match(/^(.*)-[A-Za-z0-9_-]{8}$/);
  return m ? m[1] : stem;
}

// Pure budget evaluation, factored out so it is unit-testable without a real
// build (#1002, epic #718). Given the emitted asset filenames, a size lookup,
// and one flavor's budget block, it returns the per-line rows, the failure
// messages, and an overall ok flag. `main()` wires this to the filesystem; the
// vitest suite (src/lib/check-bundle-size.test.ts) feeds it synthetic sizes to
// prove a budgeted chunk actually trips when it grows past its ceiling.
export function evaluateBudget(files, sizeOf, flavorBudget) {
  const failures = [];
  const rows = [];

  const totalJs = files.reduce((s, f) => s + sizeOf(f), 0);
  const totalMax = flavorBudget.totalJsMaxBytes;
  const totalOk = totalJs <= totalMax;
  if (!totalOk) failures.push(`total JS ${fmtBytes(totalJs)} exceeds budget ${fmtBytes(totalMax)}`);
  rows.push({ name: 'total JS', actual: totalJs, max: totalMax, ok: totalOk });

  for (const [name, max] of Object.entries(flavorBudget.chunks || {})) {
    const matches = files.filter((f) => chunkBaseName(f) === name);
    if (matches.length === 0) {
      failures.push(`budgeted chunk "${name}" not found (renamed or removed? update bundle-budget.json)`);
      rows.push({ name, actual: null, max, ok: false });
      continue;
    }
    // If chunking ever splits one logical chunk across files, sum them.
    const actual = matches.reduce((s, f) => s + sizeOf(f), 0);
    const ok = actual <= max;
    if (!ok) failures.push(`chunk "${name}" ${fmtBytes(actual)} exceeds budget ${fmtBytes(max)}`);
    rows.push({ name, actual, max, ok });
  }

  return { rows, failures, ok: failures.length === 0 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flavor !== 'server' && args.flavor !== 'spa') {
    die('--flavor must be "server" or "spa".');
  }

  let budget;
  try {
    budget = JSON.parse(readFileSync(args.budget, 'utf8'));
  } catch (err) {
    die(`could not read budget file ${args.budget} (${err.message}).`);
  }
  const flavorBudget = budget[args.flavor];
  if (!flavorBudget) die(`budget file has no "${args.flavor}" block.`);

  const assetsDir = join(args.dist, 'assets');
  let files;
  try {
    files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    die(`could not read ${assetsDir} — did the ${args.flavor} build run first? (${err.message})`);
  }
  if (files.length === 0) die(`no .js files under ${assetsDir}.`);

  const sizeOf = (f) => statSync(join(assetsDir, f)).size;

  // Per-chunk budgets match a hashed file by its EXACT logical chunk name
  // (filename minus the trailing `-<hash>.js`). Exact-name matching avoids both
  // a prefix over-match (a sibling like `index-worker-*.js` must not fold into
  // the `index` row) and any regex-metachar pitfalls from interpolating the
  // budget key into a pattern. The evaluation itself is in evaluateBudget so it
  // can be unit-tested without a real build.
  const { rows, failures } = evaluateBudget(files, sizeOf, flavorBudget);

  // Report.
  console.log(`\nBundle-size budget — ${args.flavor} flavor (${assetsDir})`);
  for (const r of rows) {
    const mark = r.ok ? '✓' : '✗';
    const actual = r.actual == null ? 'MISSING' : fmtBytes(r.actual);
    console.log(`  ${mark} ${r.name.padEnd(10)} ${actual.padStart(24)}  / budget ${fmtBytes(r.max)}`);
  }

  if (failures.length > 0) {
    console.error(`\n✗ Bundle-size gate BLOCKED (${args.flavor}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nIf the growth is intentional, raise the ceilings in bundle-budget.json ' +
        'with a note on why. Otherwise, trim the regression (check for an eager ' +
        'import that should be lazy, or a newly-bundled dependency).\n',
    );
    process.exit(1);
  }

  console.log(`\n✓ Bundle-size gate PASSED (${args.flavor}): all chunks within budget.\n`);
}

// Only run the filesystem CLI when invoked directly (e.g. `node
// scripts/check-bundle-size.mjs --flavor server`). When imported by the unit
// test it must NOT execute main() — the test exercises the pure evaluateBudget
// against synthetic sizes instead (#1002).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
