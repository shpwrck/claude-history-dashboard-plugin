// Coverage for the OpenAPI freshness gate (#2952).
//
// Proves the gate matches the three server dispatch shapes against the spec's
// path templates, canonicalizes param + optional-suffix spellings so the two
// notations converge, and — crucially — FAILS on each drift direction (a new
// served route with no spec path; a spec path for a removed route; a stale
// allowlist entry; an uncovered prefix guard). A gate that can't fail is worse
// than none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizePath,
  collectServedRoutes,
  collectServedPrefixes,
  collectSpecPaths,
  findOpenApiDrift,
} from './check-openapi-freshness.mjs';

test('canonicalizePath: params → {} and optional data suffix stripped', () => {
  assert.equal(canonicalizePath('/api/session/{sessionId}/timeline.json'), '/api/session/{}/timeline');
  assert.equal(canonicalizePath('/api/transcript/([^/]+)'), '/api/transcript/{}');
  assert.equal(canonicalizePath('/api/audit.json'), '/api/audit');
  assert.equal(canonicalizePath('/api/sources/{sourceId}/history.jsonl'), '/api/sources/{}/history');
});

test('collectServedRoutes: exact + regex dispatch shapes, optional .json folded', () => {
  const src = `
    if (pathname === '/api/usage') return handleUsage(req, res);
    const m = pathname.match(/^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$/);
    if (pathname.match(/^\\/api\\/transcript\\/([^/]+)\\/thinking$/)) {}
  `;
  const served = collectServedRoutes(src);
  assert.ok(served.has('/api/usage'));
  assert.ok(served.has('/api/session/{}/timeline'), `has timeline: ${[...served]}`);
  assert.ok(served.has('/api/transcript/{}/thinking'));
});

test('collectServedRoutes: discovers route-TABLE entries (DATASET_ROUTES Map)', () => {
  // A route reachable ONLY via a `new Map([...])` table + `.get(pathname)` —
  // no `pathname === '...'` literal anywhere — must still be found, so the gate
  // scores against the real dispatcher, not coincidental authz-predicate copies.
  const src = `
    const DATASET_ROUTES = new Map([
      ['/api/dataset.json', handleDatasetJson],
      ['/api/search', handleSearch],
    ]);
    const r = DATASET_ROUTES.get(pathname);
  `;
  const served = collectServedRoutes(src);
  assert.ok(served.has('/api/dataset'), `dataset.json: ${[...served]}`);
  assert.ok(served.has('/api/search'));
});

test('collectServedRoutes: table extractor ignores non-route array literals', () => {
  // Not a route table: string-pair tuples and identifier-keyed pairs must not
  // be mistaken for routes (only `['/path', handlerIdent]` counts).
  const src = `
    const pairs = [['left', 'right'], [alpha, beta]];
    const nums = [[1, 2]];
  `;
  assert.deepEqual([...collectServedRoutes(src)], []);
});

test('a route served ONLY via the table, undocumented, is flagged', () => {
  const server = `
    const DATASET_ROUTES = new Map([['/api/only-in-table', handleThing]]);
    const r = DATASET_ROUTES.get(pathname);
  `;
  const d = findOpenApiDrift(server, SPEC_OK, { knownUnspeccedApiRoutes: {} });
  assert.ok(
    d.servedNotSpecced.includes('/api/only-in-table'),
    `expected table route flagged: ${JSON.stringify(d.servedNotSpecced)}`
  );
});

test('collectServedPrefixes: keeps real guards, drops static/fallback scaffolding', () => {
  const src = `
    if (pathname.startsWith('/api/dataset/slice/')) {}
    if (pathname.startsWith('/assets/')) {}
    if (pathname.startsWith('/api/')) {}
  `;
  const prefixes = collectServedPrefixes(src);
  assert.deepEqual(prefixes, ['/api/dataset/slice/']);
});

test('collectSpecPaths: only top-level path keys, canonical or raw', () => {
  const spec = `
paths:
  /api/usage:
    get: {}
  /api/session/{sessionId}/timeline.json:
    get: {}
components:
  schemas:
    /not/a/path: {}
`;
  assert.deepEqual([...collectSpecPaths(spec)].sort(), ['/api/session/{}/timeline', '/api/usage']);
  assert.deepEqual(
    [...collectSpecPaths(spec, { raw: true })].sort(),
    ['/api/session/{sessionId}/timeline.json', '/api/usage']
  );
});

const SERVER_OK = `
  if (pathname === '/api/usage') {}
  if (pathname.startsWith('/api/dataset/slice/')) {}
  const m = pathname.match(/^\\/api\\/session\\/([^/]+)\\/timeline(?:\\.json)?$/);
`;
const SPEC_OK = `
paths:
  /api/usage:
    get: {}
  /api/dataset/slice/{key}:
    get: {}
  /api/session/{sessionId}/timeline.json:
    get: {}
`;

test('a matching server + spec has no drift', () => {
  const d = findOpenApiDrift(SERVER_OK, SPEC_OK, { knownUnspeccedApiRoutes: {} });
  assert.deepEqual(d.servedNotSpecced, []);
  assert.deepEqual(d.speccedNotServed, []);
  assert.deepEqual(d.staleKnownGaps, []);
  assert.deepEqual(d.uncoveredPrefixes, []);
});

test('a new served route with no spec path is flagged', () => {
  const server = SERVER_OK + `\n  if (pathname === '/api/brand-new') {}`;
  const d = findOpenApiDrift(server, SPEC_OK, { knownUnspeccedApiRoutes: {} });
  assert.deepEqual(d.servedNotSpecced, ['/api/brand-new']);
});

test('a spec path for a removed route is flagged', () => {
  const spec = SPEC_OK + `  /api/ghost:\n    get: {}\n`;
  const d = findOpenApiDrift(SERVER_OK, spec, { knownUnspeccedApiRoutes: {} });
  assert.deepEqual(d.speccedNotServed, ['/api/ghost']);
});

test('a served prefix guard fronting no documented path is flagged', () => {
  const server = SERVER_OK + `\n  if (pathname.startsWith('/api/orphan/')) {}`;
  const d = findOpenApiDrift(server, SPEC_OK, { knownUnspeccedApiRoutes: {} });
  assert.deepEqual(d.uncoveredPrefixes, ['/api/orphan/']);
});

test('the live repo tree passes the gate (no drift on master)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const d = findOpenApiDrift(
    readFileSync(join(root, 'scripts/server.mjs'), 'utf8'),
    readFileSync(join(root, 'docs/openapi/openapi.yaml'), 'utf8')
  );
  assert.deepEqual(d.servedNotSpecced, [], `undocumented served routes: ${d.servedNotSpecced}`);
  assert.deepEqual(d.speccedNotServed, [], `spec paths not served: ${d.speccedNotServed}`);
  assert.deepEqual(d.staleKnownGaps, [], `stale known-gap entries: ${d.staleKnownGaps}`);
  assert.deepEqual(d.uncoveredPrefixes, [], `uncovered prefix guards: ${d.uncoveredPrefixes}`);
});
