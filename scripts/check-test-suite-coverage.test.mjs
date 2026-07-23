// Unit + live tests for the test-suite CI-coverage gate (#2954).
//
// Run: node --test scripts/check-test-suite-coverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  extractSuiteRefs,
  resolveScriptFiles,
  collectWiredSuites,
  findUnwiredSuites,
} from './check-test-suite-coverage.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('extractSuiteRefs picks literal paths, globs, and multi-file commands', () => {
  assert.deepEqual(
    extractSuiteRefs('node --test scripts/a.test.mjs scripts/b.test.mjs'),
    ['scripts/a.test.mjs', 'scripts/b.test.mjs']
  );
  assert.deepEqual(
    extractSuiteRefs('vitest run && node --test scripts/gate-2702/*.test.mjs'),
    ['scripts/gate-2702/*.test.mjs']
  );
  // register-ts.mjs is NOT a .test.mjs and must never be captured.
  assert.deepEqual(
    extractSuiteRefs(
      'node --import ./scripts/register-ts.mjs --test scripts/c.test.mjs'
    ),
    ['scripts/c.test.mjs']
  );
});

test('resolveScriptFiles expands globs and follows nested npm run / npm test', () => {
  const universe = [
    'scripts/gate-2702/x.test.mjs',
    'scripts/foo.test.mjs',
    'scripts/bar.test.mjs',
  ];
  const scripts = {
    test: 'vitest run && node --test scripts/gate-2702/*.test.mjs',
    'test:foo': 'node scripts/foo.test.mjs',
    validate: 'npm run lint && npm test && npm run test:foo',
    lint: 'eslint .',
  };
  const map = resolveScriptFiles(scripts, universe);
  assert.deepEqual([...map.get('test')].sort(), ['scripts/gate-2702/x.test.mjs']);
  assert.deepEqual([...map.get('test:foo')], ['scripts/foo.test.mjs']);
  // `validate` transitively covers both `test` (the glob) and `test:foo`.
  assert.deepEqual(
    [...map.get('validate')].sort(),
    ['scripts/foo.test.mjs', 'scripts/gate-2702/x.test.mjs']
  );
  // `bar` is referenced by no script.
  assert.equal(
    [...map.values()].some((s) => s.has('scripts/bar.test.mjs')),
    false
  );
});

test('collectWiredSuites resolves npm-run steps in a synthetic workflow', () => {
  const universe = ['scripts/foo.test.mjs', 'scripts/bar.test.mjs'];
  // A minimal package.json + workflow map is not exposed by the API; instead
  // prove the wiring transitively via findUnwiredSuites against the real repo
  // below. Here we assert the pure resolver used by collectWiredSuites.
  assert.equal(typeof collectWiredSuites, 'function');
  const map = resolveScriptFiles(
    { 'test:foo': 'node scripts/foo.test.mjs' },
    universe
  );
  assert.ok(map.get('test:foo').has('scripts/foo.test.mjs'));
});

// The enforcing assertion: after #2954 wired the 17 dark suites, the live repo
// must have ZERO scripts/**/*.test.mjs that run in no workflow. A new unwired
// suite (or one whose wiring was deleted) fails HERE instead of shipping dark.
test('the live repo has zero unwired scripts/**/*.test.mjs suites', () => {
  const unwired = findUnwiredSuites(REPO_ROOT);
  assert.deepEqual(
    unwired,
    [],
    `these suites run in no workflow — wire them or add to EXCLUDED_SUITES:\n${unwired.join(
      '\n'
    )}`
  );
});
