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

// LEGACY v1 evaluator — a single gated total + named per-chunk ceilings. Kept
// only so the function (and any straggling caller/test) still resolves during
// the v1→v2 migration; the budget file and CLI now use evaluateStructuredBudget
// below. Do NOT reintroduce a v1 budget block — the single rising total is the
// exact warp #1852 Phase C exists to retire. Remove once nothing imports it.
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

// v2 STRUCTURAL evaluator (#1852 Phase C, ADR 0016). Partitions every emitted
// `.js` chunk into exactly ONE of three independent budget classes and enforces
// each separately — there is no gated global total, so a new lazy route chunk
// (the correct way to add a feature) can never inflate a shared number the way
// the old `totalJsMaxBytes` did. The classes:
//
//   shell  — the FROZEN eager first-paint set (`flavorBudget.shell.chunks`,
//            e.g. ["index"]); their summed size is gated by `shell.maxBytes`.
//            Rename-guarded: every shell name must match >=1 emitted file.
//   vendor — FROZEN shared third-party chunks (`flavorBudget.vendor.chunks`,
//            a {name: maxBytes} map); each is gated and rename-guarded on its
//            own ceiling. A bump here is a dependency change, never a feature.
//   route  — everything else. Each route file is gated against its explicit
//            `flavorBudget.routes[name]` cap, or `defaults.routeMaxBytes` when
//            unbudgeted (auto-pass while under it, flagged NEW so the author
//            sees it; it only FAILS when a single route exceeds the default,
//            whose fix is to add an explicit key — a deliberate, local act).
//
// `defaults.totalAdvisoryMaxBytes`, if present, is computed and REPORTED but
// never added to `failures` (pure observability — keeps the historical total
// visible without letting it warp anything). A chunk that appears in two classes
// is a budget-config error and fails loudly (deterministic membership), as does
// a missing required cap (shell.maxBytes / defaults.routeMaxBytes — fail loud,
// not fail open). A missing SHELL chunk is fatal (its sum would be 0), but a
// missing VENDOR/ROUTE key is a non-blocking WARNING (an auto-named split can be
// renamed by a dep/bundler bump; a heavy renamed chunk is still caught by the
// route size cap). Returns { rows, failures, warnings, ok }.
export function evaluateStructuredBudget(files, sizeOf, flavorBudget) {
  const failures = [];
  const warnings = [];
  const rows = [];

  // Strip `//`-prefixed documentation keys: the budget file annotates blocks
  // with inline `"//": "..."` notes, which are not chunk names.
  const withoutComments = (obj) =>
    Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !k.startsWith('//')));

  // Fail LOUD on a malformed budget rather than fail-open (#3478). An absent
  // or renamed `shell` block used to default to `{ chunks: [], maxBytes:
  // Infinity }`, which silently DISABLED the frozen shell cap — the
  // shell.maxBytes guard below never fired because the placeholder carried a
  // maxBytes. A budget whose shell block is missing is a config failure, same
  // as a missing cap inside it.
  const shellConfigured =
    flavorBudget.shell != null && typeof flavorBudget.shell === 'object';
  if (!shellConfigured) {
    failures.push('budget config error: the shell block is required (an absent/renamed shell block would disable the frozen shell gate entirely)');
  }
  const shell = shellConfigured ? flavorBudget.shell : { chunks: [] };
  const vendorChunks = withoutComments(flavorBudget.vendor && flavorBudget.vendor.chunks);
  const routes = withoutComments(flavorBudget.routes);
  const defaults = flavorBudget.defaults || {};
  // Not a fail-open hole: when defaults.routeMaxBytes is absent the guard
  // below records a hard failure, so this Infinity only shapes the report rows
  // of an already-failed run (same for the shell.maxBytes ?? Infinity below).
  const routeDefault = defaults.routeMaxBytes ?? Infinity;

  const shellNames = new Set(shell.chunks || []);
  const vendorNames = new Set(Object.keys(vendorChunks));

  if (shellConfigured && shell.maxBytes == null) {
    failures.push('budget config error: shell.maxBytes is required (a missing cap would disable the shell gate)');
  }
  if (defaults.routeMaxBytes == null) {
    failures.push('budget config error: defaults.routeMaxBytes is required (a missing default would let any unbudgeted route pass)');
  }

  // Deterministic membership: a chunk must live in exactly one class.
  for (const name of shellNames) {
    if (vendorNames.has(name)) {
      failures.push(`budget config error: chunk "${name}" is in BOTH shell and vendor classes — pick one`);
    }
    if (Object.prototype.hasOwnProperty.call(routes, name)) {
      failures.push(`budget config error: chunk "${name}" is in BOTH shell and routes classes — pick one`);
    }
  }
  for (const name of vendorNames) {
    if (Object.prototype.hasOwnProperty.call(routes, name)) {
      failures.push(`budget config error: chunk "${name}" is in BOTH vendor and routes classes — pick one`);
    }
  }

  // ── shell (FROZEN) ──────────────────────────────────────────────────────
  const shellFiles = files.filter((f) => shellNames.has(chunkBaseName(f)));
  for (const name of shellNames) {
    if (!files.some((f) => chunkBaseName(f) === name)) {
      failures.push(`shell chunk "${name}" not found (renamed or removed? update bundle-budget.json)`);
    }
  }
  const shellActual = shellFiles.reduce((s, f) => s + sizeOf(f), 0);
  const shellMax = shell.maxBytes ?? Infinity;
  const shellOk = shellActual <= shellMax;
  if (!shellOk) {
    failures.push(`shell ${fmtBytes(shellActual)} exceeds FROZEN budget ${fmtBytes(shellMax)} — new code landed in the eager first-paint graph; lazy-load it or evict it (do NOT raise the shell cap without an ADR)`);
  }
  rows.push({ cls: 'shell', name: (shell.chunks || []).join('+') || 'shell', actual: shellActual, max: shellMax, ok: shellOk });

  // ── vendor (FROZEN, per-chunk) ──────────────────────────────────────────
  // A missing vendor chunk is a WARNING, not a failure: several vendor chunks
  // (the auto-named PatternFly splits Td/FlexItem/MenuList, until #1904 gives
  // them a stable `vendor-pf` name) can be renamed by a dependency or bundler
  // bump. A hard failure there would turn a benign rename into a red CI run.
  // Protection is not lost — a renamed HEAVY chunk falls through to the route
  // class and trips its size cap (default or explicit) anyway; only the stale
  // budget key needs cleaning up, which the warning flags.
  for (const [name, max] of Object.entries(vendorChunks)) {
    const matches = files.filter((f) => chunkBaseName(f) === name);
    if (matches.length === 0) {
      warnings.push(`vendor chunk "${name}" not found — auto-named split renamed? it now rides the route class; drop or rename this key in bundle-budget.json`);
      rows.push({ cls: 'vendor', name, actual: null, max, ok: true, missing: true });
      continue;
    }
    const actual = matches.reduce((s, f) => s + sizeOf(f), 0);
    const ok = actual <= max;
    if (!ok) failures.push(`vendor chunk "${name}" ${fmtBytes(actual)} exceeds FROZEN budget ${fmtBytes(max)} — this is a dependency-weight change, not a feature`);
    rows.push({ cls: 'vendor', name, actual, max, ok });
  }

  // ── routes (each stands ALONE; never summed) ────────────────────────────
  // Group remaining files by logical chunk name (one logical chunk can, in
  // principle, split across files — sum those).
  const routeSizes = new Map();
  for (const f of files) {
    const name = chunkBaseName(f);
    if (shellNames.has(name) || vendorNames.has(name)) continue;
    routeSizes.set(name, (routeSizes.get(name) || 0) + sizeOf(f));
  }
  // Rename guard for explicit route keys: WARNING, not failure (same rationale
  // as vendor — a renamed heavy chunk still trips its size cap via the route
  // default; only the stale key needs cleaning up).
  for (const name of Object.keys(routes)) {
    if (!routeSizes.has(name)) {
      warnings.push(`route chunk "${name}" not found — renamed or removed? drop or rename this key in bundle-budget.json`);
      rows.push({ cls: 'route', name, actual: null, max: routes[name], ok: true, missing: true });
    }
  }
  for (const [name, actual] of [...routeSizes.entries()].sort((a, b) => b[1] - a[1])) {
    const explicit = Object.prototype.hasOwnProperty.call(routes, name);
    const max = explicit ? routes[name] : routeDefault;
    const ok = actual <= max;
    if (!ok) {
      failures.push(
        explicit
          ? `route "${name}" ${fmtBytes(actual)} exceeds its cap ${fmtBytes(max)} — trim it or raise this ONE route's cap (it does not affect any other budget)`
          : `route "${name}" ${fmtBytes(actual)} exceeds the default route cap ${fmtBytes(max)} — add an explicit routes["${name}"] entry sized to it`,
      );
    }
    rows.push({ cls: 'route', name, actual, max, ok, isNew: !explicit });
  }

  // ── advisory total (REPORTED ONLY — never gates) ────────────────────────
  if (defaults.totalAdvisoryMaxBytes != null) {
    const totalJs = files.reduce((s, f) => s + sizeOf(f), 0);
    rows.push({ cls: 'advisory', name: 'total JS', actual: totalJs, max: defaults.totalAdvisoryMaxBytes, ok: true, advisory: true });
  }

  return { rows, failures, warnings, ok: failures.length === 0 };
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
  // budget key into a pattern. The structural evaluation lives in
  // evaluateStructuredBudget so it can be unit-tested without a real build.
  const { rows, failures, warnings } = evaluateStructuredBudget(files, sizeOf, flavorBudget);

  // Report, grouped by class. shell + vendor are FROZEN; routes each stand
  // alone (no shared total); the advisory total is informational only.
  console.log(`\nBundle-size budget — ${args.flavor} flavor (${assetsDir})`);
  const CLS_LABEL = { shell: 'SHELL ', vendor: 'VENDOR', route: 'ROUTE ', advisory: 'ADVIS.' };
  for (const r of rows) {
    const mark = r.advisory ? '·' : r.ok ? '✓' : '✗';
    const actual = r.actual == null ? 'MISSING' : fmtBytes(r.actual);
    const tag = r.advisory ? ' (advisory — not gated)' : r.missing ? '  (stale key — not in build)' : r.isNew ? '  NEW (default cap)' : r.cls === 'shell' || r.cls === 'vendor' ? '  (frozen)' : '';
    console.log(`  ${mark} ${(CLS_LABEL[r.cls] || '').padEnd(6)} ${r.name.padEnd(24)} ${actual.padStart(20)}  / ${fmtBytes(r.max)}${tag}`);
  }

  if (warnings && warnings.length > 0) {
    console.warn(`\n! Bundle-size gate WARNINGS (${args.flavor}) — non-blocking, clean these up:`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  if (failures.length > 0) {
    console.error(`\n✗ Bundle-size gate BLOCKED (${args.flavor}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nThe gate is STRUCTURAL (ADR 0016): there is no global total to raise. ' +
        'A shell/vendor failure means first-paint or dependency weight grew — fix ' +
        'the eager import or the dep, do NOT raise a frozen cap without an ADR. A ' +
        'route failure affects only that one route; add/raise its own routes{} cap ' +
        'in bundle-budget.json. See docs/bundle-budget-contract.md.\n',
    );
    process.exit(1);
  }

  console.log(`\n✓ Bundle-size gate PASSED (${args.flavor}): all chunks within their class budgets.\n`);
}

// Only run the filesystem CLI when invoked directly (e.g. `node
// scripts/check-bundle-size.mjs --flavor server`). When imported by the unit
// test it must NOT execute main() — the test exercises the pure evaluateBudget
// against synthetic sizes instead (#1002).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
