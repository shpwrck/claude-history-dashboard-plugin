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

// #3073: the tuple SHAPE alone is not evidence of dispatch. A slash-leading
// string/identifier pair that is not inside a Map the dispatcher queries with
// `.get(pathname)` is unrelated data, and reporting it as a served endpoint
// makes the freshness verdict unreproducible from the real route table.
test('collectServedRoutes: a slash-keyed tuple outside a dispatched route Map is NOT a route', () => {
  const src = `
    const metadata = [['/api/example', handler], ['/api/other', describe]];
    const docs = { rows: [['/api/doc-only', renderer]] };
  `;
  assert.deepEqual(
    [...collectServedRoutes(src)],
    [],
    'unrelated slash-keyed tuples must not be classified as served endpoints'
  );
});

test('collectServedRoutes: a Map of slash keys that is never queried with pathname is NOT a route source', () => {
  // Same literal shape as a real table, but nothing dispatches on it — e.g. a
  // documentation/label lookup keyed by path string.
  const src = `
    const PATH_LABELS = new Map([
      ['/api/labelled', renderLabel],
    ]);
    const label = PATH_LABELS.get(someOtherKey);
  `;
  assert.deepEqual([...collectServedRoutes(src)], []);
});

test('collectServedRoutes: a real table survives alongside an unrelated tuple, and drift still flags it', () => {
  const server = `
    const metadata = [['/api/not-a-route', handler]];
    const DATASET_ROUTES = new Map([
      ['/api/real-table-route', handleReal],
    ]);
    const r = DATASET_ROUTES.get(pathname);
  `;
  const served = collectServedRoutes(server);
  assert.ok(served.has('/api/real-table-route'), `real table route missing: ${[...served]}`);
  assert.ok(!served.has('/api/not-a-route'), `unrelated tuple leaked: ${[...served]}`);
  const d = findOpenApiDrift(server, SPEC_OK, { knownUnspeccedApiRoutes: {} });
  assert.deepEqual(d.servedNotSpecced, ['/api/real-table-route']);
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

// —— #3284: the machine-readable security contract for the push-ingest write ——
//
// POST /api/ingest/{sourceId}/artifacts enforces a dedicated ingest Bearer token
// at runtime (`passesIngestAuth`), but the spec had no operation `security` and
// no ingest scheme, so with the empty top-level `security` OpenAPI tooling read
// this write endpoint as UNAUTHENTICATED and could not discover/supply the
// credential. This asserts the operation now declares a nonempty security
// requirement referencing a DEFINED ingest Bearer scheme and documents a 401.

/** Indentation of a line (spaces before first non-space); Infinity for blank. */
function indentOf(line) {
  if (!line.trim()) return Infinity;
  return line.length - line.trimStart().length;
}

/**
 * Body lines of the block introduced by the first line at `indent` whose trimmed
 * text matches `keyRe`: every following line more-indented than that key (blank
 * lines retained, verbatim indentation preserved). `null` when no such key.
 */
function blockUnder(lines, keyRe, indent) {
  const start = lines.findIndex(
    (l) => indentOf(l) === indent && keyRe.test(l.trim())
  );
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const ind = indentOf(lines[i]);
    if (ind === Infinity) {
      body.push(lines[i]);
      continue;
    }
    if (ind <= indent) break;
    body.push(lines[i]);
  }
  return body;
}

test('POST /api/ingest/{sourceId}/artifacts declares a defined ingest Bearer scheme + 401 (#3284)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lines = readFileSync(join(root, 'docs/openapi/openapi.yaml'), 'utf8').split('\n');

  const pathBlock = blockUnder(lines, /^\/api\/ingest\/\{sourceId\}\/artifacts:$/, 2);
  assert.ok(pathBlock, 'ingest path is present in the spec');
  const opBlock = blockUnder(pathBlock, /^post:$/, 4);
  assert.ok(opBlock, 'ingest POST operation is present');

  // A NONEMPTY operation-level security requirement, and the scheme names it cites.
  const securityBlock = blockUnder(opBlock, /^security:$/, 6);
  assert.ok(securityBlock && securityBlock.length, 'ingest POST has a security requirement');
  const schemeNames = securityBlock
    .map((l) => l.trim().match(/^-\s*([A-Za-z0-9_]+)\s*:/)?.[1])
    .filter(Boolean);
  assert.ok(
    schemeNames.length,
    `security requirement references at least one scheme: ${JSON.stringify(securityBlock)}`
  );

  // A documented 401 authentication-failure response.
  const responsesBlock = blockUnder(opBlock, /^responses:$/, 6);
  assert.ok(responsesBlock, 'ingest POST has a responses block');
  assert.ok(
    responsesBlock.some((l) => /^'401':/.test(l.trim())),
    'ingest POST documents a 401 authentication-failure response'
  );

  // Every cited scheme is DEFINED under components.securitySchemes, is an HTTP
  // Bearer scheme, and is NOT the CSRF token (cross-origin shippers use a
  // dedicated ingest credential).
  const schemesBlock = blockUnder(lines, /^securitySchemes:$/, 2);
  assert.ok(schemesBlock, 'components.securitySchemes is present');
  for (const name of schemeNames) {
    assert.notEqual(name, 'csrfToken', 'ingest auth is a dedicated credential, not the CSRF token');
    const def = blockUnder(schemesBlock, new RegExp(`^${name}:$`), 4);
    assert.ok(def, `security scheme "${name}" is defined in components.securitySchemes`);
    const isBearer =
      def.some((l) => /^type:\s*http$/.test(l.trim())) &&
      def.some((l) => /^scheme:\s*bearer$/.test(l.trim()));
    assert.ok(isBearer, `ingest scheme "${name}" is an HTTP Bearer scheme`);
  }
});
