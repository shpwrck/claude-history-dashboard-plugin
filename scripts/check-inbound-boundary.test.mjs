// Regression coverage for the inbound api-client boundary gate (#2081, #2963).
//
// Proves the gate flags a raw network call outside the owner allowlist while
// ignoring an allowlisted owner, a comment-only mention, and a test file —
// the exact false-positive classes the design has to avoid (the parsers name
// `/api/` routes in doc comments pervasively). The #2963 cases pin the
// alias-hardening: every value-position route to the global `fetch` fails in
// a non-owner file, while `typeof fetch`, members named fetch on non-global
// receivers, and string prose stay free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFetchReferences, findInboundViolations } from './check-inbound-boundary.mjs';

test('flags raw network calls outside the allowlist; ignores owners, comments, tests (#2081)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbound-boundary-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'lib'), { recursive: true });
  mkdirSync(join(src, 'components'), { recursive: true });

  // Allowlisted owner: a raw fetch here is permitted.
  writeFileSync(join(src, 'lib', 'api-client.ts'), 'export const x = () => fetch("/api/x");\n');

  // Comment-only mentions (line, JSDoc): must be ignored — these are the prose
  // patterns the real codebase uses ("over-fetch (…)", "the fetch (fetchUsage)").
  writeFileSync(
    join(src, 'lib', 'parse-foo.ts'),
    '// Flags a first-call over-fetch (whole-file Read).\n' +
      '/**\n * The browser-side fetch (`fetchUsage`) lives in api-client.\n */\nexport const y = 1;\n'
  );

  // A test file: excluded from the scan.
  writeFileSync(join(src, 'components', 'Foo.test.tsx'), 'fetch("/api/y");\n');

  // Real violations: a stray fetch in a component and an EventSource in a lib.
  writeFileSync(join(src, 'components', 'Bad.tsx'), 'export const z = () => fetch("/api/bad");\n');
  writeFileSync(join(src, 'lib', 'live.ts'), 'export const s = new EventSource("/api/live");\n');

  try {
    const violations = findInboundViolations(src, ['lib/api-client.ts']);
    const files = violations.map((v) => v.file).sort();
    assert.deepEqual(
      files,
      ['components/Bad.tsx', 'lib/live.ts'],
      `unexpected violations: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean tree (only owners + comments) yields no violations (#2081)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbound-boundary-clean-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'lib'), { recursive: true });
  writeFileSync(join(src, 'lib', 'api-client.ts'), 'fetch("/api/x");\n');
  writeFileSync(join(src, 'lib', 'usage.ts'), '// the fetch (fetchUsage) lives in api-client\nexport const u = 2;\n');
  try {
    assert.deepEqual(findInboundViolations(src, ['lib/api-client.ts']), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// —— #2963: alias-hardening — every value-position route to the global fails ——

const flagged = (code) => findFetchReferences('x.ts', code).length > 0;

test('flags every alias/evasion route to the global fetch (#2963)', () => {
  // The exact pattern that evaded the call-syntax regex in the wild.
  assert.ok(flagged('const fetcher = req.fetchImpl ?? fetch;'), '?? fetch fallback');
  assert.ok(flagged('const f = fetch;'), 'bare alias assignment');
  assert.ok(flagged('call(fetch);'), 'passed as an argument');
  assert.ok(flagged('const impl = globalThis.fetch;'), 'globalThis.fetch');
  assert.ok(flagged('const impl = window.fetch;'), 'window.fetch');
  assert.ok(flagged('const impl = self.fetch;'), 'self.fetch');
  assert.ok(flagged("const impl = globalThis['fetch'];"), "['fetch'] indexing");
  assert.ok(flagged('(globalThis).fetch("/api/x");'), 'parenthesized global receiver');
  assert.ok(flagged('const impl = ((window)).fetch;'), 'doubly-parenthesized receiver');
  assert.ok(flagged("(globalThis)['fetch']('/api/x');"), 'parenthesized bracket indexing');
  assert.ok(flagged('const o = { fetch };'), 'shorthand property');
  assert.ok(flagged('const { fetch: f } = globalThis;'), 'destructured off a global');
  assert.ok(flagged("import { fetch } from 'undici';"), 'imported binding named fetch');
  assert.ok(flagged('const fetch = makeFetch();'), 'local binding named fetch (shadow)');
  assert.ok(flagged('fetch("/api/x");'), 'direct call (regression: regex era)');
});

test('allows non-primitive uses: typeof, non-global members, names, prose (#2963)', () => {
  assert.ok(!flagged('type F = typeof fetch;'), 'typeof fetch in type position');
  assert.ok(!flagged('interface R { fetchImpl?: typeof fetch }'), 'DI type annotation');
  assert.ok(!flagged("if (typeof fetch === 'function') { init(); }"), 'runtime feature detection');
  assert.ok(!flagged('client.fetch("/thing");'), 'member named fetch on a non-global');
  assert.ok(!flagged('const op = { fetch: impl };'), 'property NAME position');
  assert.ok(!flagged('interface C { fetch(url: string): Promise<void> }'), 'method signature name');
  assert.ok(!flagged('const s = "run git fetch before reading";'), 'string prose');
  assert.ok(!flagged('const t = `no prior fetch in ${w} minutes`;'), 'template prose');
  assert.ok(!flagged('// const f = fetch; (historical note)\nexport const a = 1;'), 'comment');
});

test('violations from the AST pass surface with file/line through the tree scan (#2963)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbound-boundary-alias-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'lib'), { recursive: true });
  // Non-owner using the exact in-the-wild evasion; an owner using the same
  // pattern legitimately; prose-heavy non-owner that must stay clean.
  writeFileSync(
    join(src, 'lib', 'sneaky.ts'),
    'export async function go(req: { fetchImpl?: typeof fetch }) {\n' +
      '  const fetcher = req.fetchImpl ?? fetch;\n' +
      '  return fetcher("http://127.0.0.1:1234");\n' +
      '}\n'
  );
  writeFileSync(join(src, 'lib', 'owner.ts'), 'export const f = globalThis.fetch;\n');
  writeFileSync(
    join(src, 'lib', 'detector-copy.ts'),
    "export const detail = 'ran with no git fetch/pull in the prior 30 minutes';\n"
  );
  try {
    const violations = findInboundViolations(src, ['lib/owner.ts']);
    assert.deepEqual(
      violations.map((v) => `${v.file}:${v.line}`),
      ['lib/sneaky.ts:2'],
      `unexpected violations: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
