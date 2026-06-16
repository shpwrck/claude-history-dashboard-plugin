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
// `--flavor spa` also refuses to run against a stale/wrong SERVER dist (#1702):
// the spa ceilings are tighter, so measuring a leftover `npx vite build` output
// as if it were a SPA build trips the gate on a bundle that was never built as a
// SPA. Since a real SPA build can't carry the server-only boundary markers, one
// turning up means you forgot `npm run build:spa` — the gate says so instead of
// reporting a phantom regression.
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
// Server-only markers the spa/server boundary (#324) forbids in a SPA build —
// kept in sync with the FORBIDDEN list in .github/workflows/ci.yml's
// spa-boundary job. A genuine upload-only SPA build aliases its api-client to
// no-op stubs, so these literals can NEVER appear in it.
export const SERVER_ONLY_MARKERS = ['/api/', 'csrf-token', 'policy/write', 'EventSource'];

// Guard against measuring the WRONG dist against the spa budget (#1702). The
// spa total/index ceilings are tighter than the server ones, so pointing the
// `--flavor spa` check at a stale SERVER dist (e.g. a leftover `npx vite build`
// output, or forgetting to re-run `npm run build:spa`) trips the spa gate on a
// bundle that was never built as a SPA — exactly the stale-dist mismatch that
// got mis-filed as a real ~38 KB SPA regression in #1702. Since a real SPA
// build cannot contain SERVER_ONLY_MARKERS, finding one here means the dist is a
// server build. Returns the first {file, marker} hit, or null when clean.
export function findServerMarkers(files, contentOf) {
  for (const f of files) {
    const text = contentOf(f);
    const marker = SERVER_ONLY_MARKERS.find((m) => text.includes(m));
    if (marker) return { file: f, marker };
  }
  return null;
}

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

  // Refuse to measure a server dist against the tighter spa ceilings (#1702).
  // A real upload-only SPA build never carries the server-only boundary markers,
  // so finding one means the dist on disk is a server build (stale, or the wrong
  // flavor was rebuilt) — fail loudly with the fix instead of a false RED.
  if (args.flavor === 'spa') {
    const contentOf = (f) => readFileSync(join(assetsDir, f), 'utf8');
    const hit = findServerMarkers(files, contentOf);
    if (hit) {
      die(
        `this looks like a SERVER dist, not a SPA build: chunk "${hit.file}" ` +
          `contains the server-only marker "${hit.marker}", which the spa/server ` +
          `boundary (#324) forbids in an upload-only SPA bundle. You are measuring ` +
          `the wrong dist against the spa budget — rebuild with \`npm run build:spa\` ` +
          `before \`--flavor spa\`.`,
      );
    }
  }

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
