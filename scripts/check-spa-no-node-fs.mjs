#!/usr/bin/env node
// SPA node:fs-leak gate (#3628, follow-up to #3613).
//
// In the SPA build `node:fs` has no implementation: Vite resolves it to an
// empty browser-external stub, so the emitted `bounded-fs` module evaluates
// `constants.O_RDONLY` against `undefined` and throws
// `Cannot read properties of undefined (reading 'O_RDONLY')` the moment the
// chunk is EVALUATED. That is a module-scope throw, not a lazy runtime branch:
// any chunk that statically imports it is dead on arrival, and the view that
// lazy-loads that chunk white-screens.
//
// #3613 was exactly this — a new `upload-artifacts.ts -> parse-telemetry.ts`
// import edge dragged parse-telemetry's `node:fs` graph into browser chunks and
// the Recommendations view crashed at render. Every fast local gate passed:
// `check-bundle-size` only weighs bytes and `spa-boundary` only greps for
// server-touching strings. The single catcher was the `browser-compat`
// render-smoke e2e — slow, and flaky enough under runner load that it reddened
// intermittently before the real defect surfaced. A deterministic bundling
// defect deserves a deterministic gate, so this one runs on the dist the
// spa-boundary job already built and finishes in milliseconds.
//
// Run it right after the SPA build, against that build's dist/:
//   npm run build:spa && node scripts/check-spa-no-node-fs.mjs
//
// Flags:
//   --dist <dir>   dist root to scan (default: dist)
//
// ── What it asserts, and why in this shape ──────────────────────────────────
//
// A bare `grep -c O_RDONLY dist/assets/*.js` count (the shape #3628 sketched)
// is NOT sufficient, and this was measured rather than assumed: rebuilding the
// #3613 leak locally kept a single shared `bounded-fs` chunk while ALSO
// inlining the fs graph into a second chunk, so the count moved 1 -> 2 — but a
// leak that instead adds an import EDGE to the existing shared chunk moves no
// count at all. So the gate works on the emitted chunk graph, in two parts:
//
//   1. CONTAINMENT — no chunk outside ALLOWED_FS_GRAPH_CHUNKS may CONTAIN the
//      fs graph. This catches the graph being duplicated/inlined somewhere new
//      (the count-moving half of #3613).
//   2. REACHABILITY — no chunk outside that allowlist plus KNOWN_FS_REACHERS
//      may statically REACH a chunk that contains it. This catches a new
//      `import` edge into the existing shared chunk, which no count would see.
//
// Static import edges are the ones that matter: ESM evaluates a module's static
// dependencies before its own body, so a static edge into the fs graph makes
// the throw unavoidable. Dynamic `import()` is how lazy routes are loaded and
// is deliberately NOT followed — it defers evaluation rather than forcing it.
//
// ── Marker choice (a false positive that looks obvious is not) ──────────────
//
// The markers are the fs CONSTANT names, not the fs function names. Scanning
// for `readFileSync` or `node:fs` would fail on a clean build today: the
// Recommendations chunk legitimately ships those literals as recommendation
// COPY — it emits a `node <<'NODE' ... require('node:fs') ... fs.readFileSync`
// snippet as fix text for the user to paste. `O_RDONLY`/`O_NOFOLLOW` appear
// only where the real graph was bundled.
//
// Known limit, stated honestly: this keys on `bounded-fs`, which is the shared
// hardened-read chokepoint every `~/.claude` artifact parser routes through, so
// it covers the parser fan-in that caused #3613. A hypothetical leak of a
// constants-free fs consumer (e.g. one using only `openSync`/`readSync`) would
// carry no marker here; that fails at CALL time rather than at module scope, so
// it is a strictly less severe class than the import-time white-screen this
// gate exists to make impossible.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkBaseName } from './check-bundle-size.mjs';

// Emitted evidence that a chunk carries the node:fs constants graph. See the
// marker-choice note above for why these and not `readFileSync`/`node:fs`.
export const FS_GRAPH_MARKERS = ['O_RDONLY', 'O_NOFOLLOW'];

// Logical chunk names allowed to CONTAIN the fs graph. `bounded-fs` is the
// shared module every artifact parser reads through; in the SPA build it is
// inert weight that must never be evaluated, which part 2 enforces.
//
// An entry that matches no emitted chunk is NOT a failure: a build in which the
// fs graph is absent entirely is the ideal end state, not a broken gate. What
// must never silently pass is scanning nothing at all, which the empty-dist
// guard in main() rejects.
export const ALLOWED_FS_GRAPH_CHUNKS = ['bounded-fs'];

// SHRINK-ONLY debt list: logical chunk names that already reach the fs graph on
// master and are therefore not treated as new regressions. Each is a live
// crash of the #3613 class, tracked in #3639 — these three view chunks throw
// `O_RDONLY` on import today, verified by evaluating the emitted chunks under
// jsdom. They are recorded rather than fixed here so this gate can land green
// and stop the NEXT leak; the fix is a separate change.
//
// The list is a ratchet: an entry that no longer reaches the fs graph FAILS the
// gate asking to be removed, so fixing the debt cannot leave a stale exemption
// behind that would quietly re-open the hole.
export const KNOWN_FS_REACHERS = [
  // src/lib/parse-telemetry.ts -> bounded-fs (shared lib chunk; pulls in the
  // ReviewQueuePf view below).
  'parse-telemetry',
  // src/lib/parse-session-registry.ts + src/lib/report-card.ts -> bounded-fs.
  'AgentReportCardPf',
  // src/lib/parse-plans.ts (clusterPlans is a value import) -> bounded-fs.
  'PlanShapesPf',
  // reaches it transitively through the parse-telemetry chunk.
  'ReviewQueuePf',
];

// A STATIC edge to another emitted chunk. Every form below forces the target to
// be evaluated before the importing module's own body runs:
//
//   import './chunk.js'                     bare side-effect
//   import d from './chunk.js'              default
//   import { x } from './chunk.js'          named
//   import * as ns from './chunk.js'        namespace
//   import d, { x } from './chunk.js'       default + named
//   export { x } from './chunk.js'          named re-export
//   export * as ns from './chunk.js'        namespaced re-export
//
// Dynamic `import('./chunk.js')` is excluded ON PURPOSE, and that exclusion is
// load-bearing: the `(` matches neither the optional clause nor the opening
// quote, so lazy route loading — which DEFERS evaluation rather than forcing it
// — stays out of the graph.
//
// Bare `export * from './chunk.js'` (star with no `as`) is NOT matched. That is
// a genuine gap, not a design choice: the clause alternatives all require
// braces, an identifier, or `* as`, so a lone `*` falls through. The current SPA
// build emits zero of them, so today's graph is complete — widening the pattern
// is tracked in #3649 rather than folded into this gate.
const STATIC_EDGE_RE =
  /\b(?:import|export)\s*(?:(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*)?from\s*)?(["'])\.\/([^"']+)\1/g;

/** Emitted chunk filenames this chunk's source statically imports (or re-exports from). */
export function parseStaticEdges(source) {
  // perf-index-contract: spa-fs-static-edges always-consumed: the only caller iterates every returned specifier to fill the importer index, so each call is drained immediately
  const out = new Set();
  for (const m of source.matchAll(STATIC_EDGE_RE)) out.add(m[2]);
  return out;
}

/** Chunk filenames whose own emitted bytes carry the node:fs constants graph. */
export function findFsGraphChunks(files, contentOf) {
  return files.filter((f) => {
    const text = contentOf(f);
    return FS_GRAPH_MARKERS.some((marker) => text.includes(marker));
  });
}

/**
 * Chunks that statically reach one of `fsGraphChunks` without containing it.
 *
 * Only called when at least one chunk actually carries the graph — with nothing
 * to walk back from, every chunk's import statements would be parsed to produce
 * an empty answer.
 */
function findFsGraphReachers(files, contentOf, fsGraphChunks) {
  // Walk the edges backwards from every fs-graph chunk: anything that lands in
  // `reached` evaluates the fs graph before its own body runs.
  // perf-index-contract: spa-fs-reachability always-consumed: the caller only invokes this walk when a chunk carries the graph, so the traversal below always reads this importer index
  const importers = new Map(files.map((f) => [f, []]));
  for (const file of files) {
    for (const dep of parseStaticEdges(contentOf(file))) {
      if (importers.has(dep)) importers.get(dep).push(file);
    }
  }

  // perf-index-contract: spa-fs-reachability always-consumed: seeded from the non-empty fs-graph chunk list every call, then drained into the returned reacher list
  const reached = new Set(fsGraphChunks);
  const queue = [...fsGraphChunks];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.shift()) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }

  // perf-index-contract: spa-fs-reachability always-consumed: the sorted list is the function's only return value, reported and re-scanned by every gate run
  return [...reached].filter((f) => !fsGraphChunks.includes(f)).sort();
}

/**
 * Pure evaluation, factored out so the discriminating suite
 * (scripts/check-spa-no-node-fs.test.mjs) can drive both a leaked and a clean
 * fixture without a real build. `files` are emitted `.js` filenames, `contentOf`
 * returns one file's text.
 *
 * Returns { fsGraphChunks, reachers, failures, ok }, where `reachers` are the
 * chunks that statically reach the fs graph without containing it.
 */
export function evaluateFsLeak(files, contentOf, options = {}) {
  // Plain arrays, not Sets: both policy lists are fixed and tiny (one and four
  // entries), so an index would cost more to build than the scans it replaces.
  const allowedContainers = options.allowedContainers ?? ALLOWED_FS_GRAPH_CHUNKS;
  const knownReachers = options.knownReachers ?? KNOWN_FS_REACHERS;
  const failures = [];

  const fsGraphChunks = findFsGraphChunks(files, contentOf);

  // ── 1. containment ────────────────────────────────────────────────────────
  for (const file of fsGraphChunks) {
    const name = chunkBaseName(file);
    if (allowedContainers.includes(name)) continue;
    failures.push(
      `chunk "${file}" CONTAINS the node:fs graph (matched ${FS_GRAPH_MARKERS.join('/')}) — ` +
        `node:fs is an empty stub in the SPA build, so evaluating this chunk throws ` +
        `"Cannot read properties of undefined (reading 'O_RDONLY')". Import the fs-free leaf ` +
        `module instead of the parser that pulls in bounded-fs (see src/lib/telemetry-event-kind.ts ` +
        `for the extraction #3613 used).`,
    );
  }

  // ── 2. reachability over static edges ─────────────────────────────────────
  const reachers =
    fsGraphChunks.length === 0 ? [] : findFsGraphReachers(files, contentOf, fsGraphChunks);

  for (const file of reachers) {
    const name = chunkBaseName(file);
    if (allowedContainers.includes(name) || knownReachers.includes(name)) continue;
    failures.push(
      `chunk "${file}" statically imports the node:fs graph — it will throw on load, ` +
        `white-screening whatever view lazy-loads it (the #3613 failure mode). Break the ` +
        `import edge: take the shared value from an fs-free leaf module rather than from a ` +
        `parser that imports bounded-fs.`,
    );
  }

  // ── ratchet: a fixed debt entry must be removed, not left behind ──────────
  for (const name of knownReachers) {
    if (reachers.some((f) => chunkBaseName(f) === name)) continue;
    failures.push(
      `KNOWN_FS_REACHERS lists "${name}", but no such chunk reaches the node:fs graph anymore. ` +
        `If you fixed it, delete the entry (the list only shrinks); if the chunk was renamed, ` +
        `rename the entry so the exemption keeps naming a real chunk instead of silently ` +
        `exempting nothing.`,
    );
  }

  return { fsGraphChunks, reachers, failures, ok: failures.length === 0 };
}

// Exit 1 means ONE thing: a leak was found. Every usage error therefore routes
// through die() to exit 2 — `--dist` with no value used to leave `out.dist`
// undefined, so join() threw an uncaught TypeError and node exited 1, reporting
// a mistyped flag as a node:fs leak.
function parseArgs(argv) {
  const out = { dist: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--dist') die(`unknown argument "${argv[i]}".`);
    const value = argv[++i];
    if (value === undefined) die('--dist requires a directory path.');
    out.dist = value;
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ SPA node:fs gate ERROR — ${msg}\n`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetsDir = join(args.dist, 'assets');

  // Fail closed on an absent/empty dist: a gate that scans zero bytes and
  // prints a success line is the #3478 class this repo keeps re-shipping.
  let files;
  try {
    files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    die(`could not read ${assetsDir} — did \`npm run build:spa\` run first? (${err.message})`);
  }
  if (files.length === 0) {
    die(`no .js files under ${assetsDir} — nothing was scanned, so this gate verified NOTHING.`);
  }

  const contentOf = (f) => readFileSync(join(assetsDir, f), 'utf8');
  const { fsGraphChunks, reachers, failures } = evaluateFsLeak(files, contentOf);

  console.log(`\nSPA node:fs gate — ${assetsDir} (${files.length} chunks scanned)`);
  if (fsGraphChunks.length === 0) {
    console.log('  · no chunk carries the node:fs graph');
  }
  for (const f of fsGraphChunks) {
    const ok = ALLOWED_FS_GRAPH_CHUNKS.includes(chunkBaseName(f));
    console.log(`  ${ok ? '✓' : '✗'} CONTAINS  ${f}${ok ? '  (allowlisted)' : ''}`);
  }
  for (const f of reachers) {
    const known = KNOWN_FS_REACHERS.includes(chunkBaseName(f));
    console.log(`  ${known ? '!' : '✗'} REACHES   ${f}${known ? '  (known debt — #3639)' : ''}`);
  }

  if (failures.length > 0) {
    console.error('\n✗ SPA node:fs gate BLOCKED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nnode:fs resolves to an empty stub in the SPA build, so any browser chunk that ' +
        'evaluates the bounded-fs graph throws at module scope and white-screens its view. ' +
        'The fix is never to allowlist the new chunk — it is to cut the import edge, the way ' +
        '#3613 extracted src/lib/telemetry-event-kind.ts as an fs-free leaf.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ SPA node:fs gate PASSED: no new browser chunk evaluates the node:fs graph.\n');
}

// Only run the CLI when invoked directly, so the discriminating suite can
// import the pure evaluator without executing main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Same reservation as parseArgs: an unexpected throw (a chunk deleted
  // mid-scan, an unreadable file) must not exit 1 and be read as a leak.
  try {
    main();
  } catch (err) {
    die(`unexpected failure while scanning (${err && err.message}).`);
  }
}
