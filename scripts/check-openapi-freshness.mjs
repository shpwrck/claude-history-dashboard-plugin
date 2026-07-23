#!/usr/bin/env node
// OpenAPI freshness gate (#2952).
//
// docs/openapi/openapi.yaml is described as "the machine-readable API
// contract", but nothing kept it aligned with the routes scripts/server.mjs
// actually serves — the same drift class docs/llm-usage-registry.md had before
// its generator gate. A route added or removed without a matching spec edit
// would ship a stale contract silently. This gate diffs the served route table
// against the spec's declared paths and fails on drift, so the spec can only
// go stale on purpose (a conscious edit to the allowlist below).
//
// It is a CHECKER, not a generator: openapi.yaml stays hand-authored prose
// (request/response schemas, auth, examples), and this only asserts the SET of
// documented path templates matches the SET of served route templates. Modeled
// on scripts/check-enterprise-route-inventory.mjs (declared inventory vs live
// surface), reusing the same server.mjs route-extraction shapes.
//
// Run: node scripts/check-openapi-freshness.mjs

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SPEC_PATH = 'docs/openapi/openapi.yaml';

// Served routes that are deliberately OUTSIDE the OpenAPI contract, each with a
// reason. The spec's own preamble scopes it to the `/api/*` data surface plus
// the few top-level data files; raw static serving is not an API contract.
export const UNSPECCED_ROUTES = {
  '/': 'SPA index.html shell — static asset serving, not an API route',
  '/assets': 'built JS/CSS asset serving (Vite output) — static, not an API route',
};

// Served prefix DISPATCH guards that are routing scaffolding, not addressable
// endpoints in their own right: a `pathname.startsWith('/x/')` branch either
// serves static files (`/assets/`) or gates a more specific handler under it
// (`/projects/` fronts the `/projects/{}/{}` regex). Skipped from the
// route-template comparison entirely.
const IGNORED_PREFIXES = new Set(['/assets/', '/api/']);

// Served `/api/*` routes that are genuinely undocumented in the spec today
// (flagged by the v0.6.0 architecture survey as "genuine gaps no reader
// covered"). Listed here so the gate lands green and future ADD/REMOVE drift
// still fails; each should graduate into a real spec path. Removing an entry
// here without adding the spec path (or vice versa) fails the gate.
export const KNOWN_UNSPECCED_API_ROUTES = {
  '/api/analyze/local':
    'Tier A local-analyze surface (#2319, ADR 0018) — POST-only, loopback local-model egress; not yet in openapi.yaml',
  '/api/checkpoint/answers':
    'checkpoint answers GET/POST (enterprise org data) — data model not yet documented in openapi.yaml',
};

// Trailing data-format suffixes the server treats as optional (`timeline`
// vs `timeline.json`) or that a spec path spells out; stripped on both sides so
// the two spellings canonicalize to the same template.
const OPTIONAL_SUFFIX_RE = /\.(json|ndjson|jsonl)$/;

/** Canonicalize a path template: params → `{}`, strip a trailing data suffix. */
export function canonicalizePath(path) {
  const params = path
    .replace(/\{[^}]+\}/g, '{}') // spec `{sessionId}` → `{}`
    .replace(/\([^)]*\)/g, '{}'); // regex `([^/]+)` → `{}`
  return params.replace(OPTIONAL_SUFFIX_RE, '');
}

/**
 * Served route templates from scripts/server.mjs, canonicalized. Covers the
 * addressable dispatch shapes: `pathname === '…'`, `pathname.match(/^…$/)`, and
 * route-TABLE entries — `X_ROUTES = new Map([['/path', handler], …])` reached
 * via `MAP.get(pathname)` (the growing `DATASET_ROUTES` family). The table form
 * is discovered directly, not by coincidental overlap with authz-predicate
 * literals. `pathname.startsWith('…')` prefixes are routing guards, not
 * endpoints, and are validated separately (see findOpenApiDrift): each ignored
 * prefix is dropped, every other prefix must front at least one documented path.
 */
export function collectServedRoutes(serverSrc) {
  const routes = new Set();

  for (const m of serverSrc.matchAll(/pathname\s*===\s*'([^']+)'/g)) {
    routes.add(canonicalizePath(m[1]));
  }
  for (const m of serverSrc.matchAll(/pathname\.match\(\s*\/\^(.+?)\$\/\s*[).]/gs)) {
    // Regex body: unescape `\/` and `\.`, turn capture groups into `{}`.
    const body = m[1]
      .replace(/\(\?:\\\.(?:json|ndjson|jsonl)\)\?/g, '') // drop optional (?:\.json)?
      .replace(/\([^)]*\)/g, '{}')
      .replace(/\\\//g, '/')
      .replace(/\\\./g, '.');
    routes.add(canonicalizePath(body));
  }
  // Route-table entries: `['/path', handlerIdent]` array-literal pairs whose
  // key is a slash-leading path string. Anchoring on the leading `/` keeps this
  // from matching unrelated `[a, b]` literals; the `handler` identifier arm
  // keeps it from matching non-route string tuples.
  for (const m of serverSrc.matchAll(/\[\s*'(\/[^']*)'\s*,\s*[A-Za-z_$][\w$]*\s*\]/g)) {
    routes.add(canonicalizePath(m[1]));
  }
  return routes;
}

/** Served `startsWith('…')` prefix guards, minus the ignored scaffolding. */
export function collectServedPrefixes(serverSrc) {
  const prefixes = new Set();
  for (const m of serverSrc.matchAll(/pathname\.startsWith\('([^']+)'\)/g)) {
    if (!IGNORED_PREFIXES.has(m[1])) prefixes.add(m[1]);
  }
  return [...prefixes];
}

/**
 * Declared path templates from openapi.yaml (top-level `  /path:` keys).
 * Canonicalized by default; `{ raw: true }` keeps the literal spec path (for
 * prefix-coverage matching, which needs the real leading segments).
 */
export function collectSpecPaths(specSrc, { raw = false } = {}) {
  const paths = new Set();
  let inPaths = false;
  for (const line of specSrc.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/.test(line)) break; // dedented out of the paths block
    const m = /^ {2}(\/\S*):\s*$/.exec(line);
    if (m) paths.add(raw ? m[1] : canonicalizePath(m[1]));
  }
  return paths;
}

export function findOpenApiDrift(
  serverSrc,
  specSrc,
  {
    unspeccedRoutes = UNSPECCED_ROUTES,
    knownUnspeccedApiRoutes = KNOWN_UNSPECCED_API_ROUTES,
  } = {}
) {
  const served = collectServedRoutes(serverSrc);
  const prefixes = collectServedPrefixes(serverSrc);
  const spec = collectSpecPaths(specSrc);
  const specRaw = collectSpecPaths(specSrc, { raw: true });
  const unspecced = new Set(Object.keys(unspeccedRoutes).map(canonicalizePath));
  const knownGaps = new Set(
    Object.keys(knownUnspeccedApiRoutes).map(canonicalizePath)
  );

  const servedNotSpecced = [...served].filter(
    (r) => !spec.has(r) && !unspecced.has(r) && !knownGaps.has(r)
  );
  // A spec path is served if its canonical form is a served template, or it
  // falls under a served prefix guard (raw-path startsWith) — e.g.
  // `/api/dataset/slice/{key}` is fronted by the `/api/dataset/slice/` prefix.
  const speccedNotServed = [...specRaw].filter((s) => {
    const c = canonicalizePath(s);
    return !served.has(c) && !prefixes.some((p) => s.startsWith(p));
  });
  // A known-gap entry that is now ALSO in the spec (documented) or no longer
  // served (removed) is stale allowlist bookkeeping — force it cleaned up.
  const staleKnownGaps = [...knownGaps].filter(
    (r) => spec.has(r) || !served.has(r)
  );
  // Every non-ignored prefix guard must front at least one documented path.
  const uncoveredPrefixes = prefixes.filter(
    (p) => ![...specRaw].some((s) => s.startsWith(p))
  );
  return {
    servedNotSpecced: servedNotSpecced.sort(),
    speccedNotServed: speccedNotServed.sort(),
    staleKnownGaps: staleKnownGaps.sort(),
    uncoveredPrefixes: uncoveredPrefixes.sort(),
  };
}

function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const serverSrc = readFileSync(join(repoRoot, 'scripts/server.mjs'), 'utf8');
  const specSrc = readFileSync(join(repoRoot, SPEC_PATH), 'utf8');
  const { servedNotSpecced, speccedNotServed, staleKnownGaps, uncoveredPrefixes } =
    findOpenApiDrift(serverSrc, specSrc);

  const problems = [];
  if (servedNotSpecced.length) {
    problems.push(
      `Served by scripts/server.mjs but ABSENT from ${SPEC_PATH}:\n` +
        servedNotSpecced.map((r) => `    ${r}`).join('\n') +
        `\n  Add a path entry to the spec, or (if intentionally undocumented) add it to\n` +
        `  UNSPECCED_ROUTES / KNOWN_UNSPECCED_API_ROUTES in scripts/check-openapi-freshness.mjs with a reason.`
    );
  }
  if (speccedNotServed.length) {
    problems.push(
      `Documented in ${SPEC_PATH} but NOT served by scripts/server.mjs:\n` +
        speccedNotServed.map((r) => `    ${r}`).join('\n') +
        `\n  Remove the stale path from the spec, or restore the route.`
    );
  }
  if (staleKnownGaps.length) {
    problems.push(
      `KNOWN_UNSPECCED_API_ROUTES entries that are now documented or no longer served:\n` +
        staleKnownGaps.map((r) => `    ${r}`).join('\n') +
        `\n  Remove them from KNOWN_UNSPECCED_API_ROUTES — the allowlist must stay minimal.`
    );
  }
  if (uncoveredPrefixes.length) {
    problems.push(
      `Served prefix guard(s) fronting no documented path in ${SPEC_PATH}:\n` +
        uncoveredPrefixes.map((r) => `    ${r}`).join('\n') +
        `\n  Document a path under the prefix, or add it to IGNORED_PREFIXES if it is static scaffolding.`
    );
  }

  if (problems.length) {
    console.error(`OpenAPI freshness gate FAILED (#2952):\n\n${problems.join('\n\n')}\n`);
    process.exit(1);
  }
  console.log(
    `OpenAPI freshness gate passed: every served route is documented in ${SPEC_PATH} ` +
      `(or a reviewed exception), and every spec path is served.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
