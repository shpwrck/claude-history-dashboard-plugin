// Unit + live tests for the test-suite CI-coverage gate (#2954).
//
// Run: node --test scripts/check-test-suite-coverage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractSuiteRefs,
  extractRunCommands,
  resolveScriptFiles,
  collectWiredSuites,
  findUnwiredSuites,
} from './check-test-suite-coverage.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function workflowJobBlock(yamlText, jobName) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `workflow job ${jobName} must exist`);
  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line)
  );
  return ['jobs:', ...lines.slice(start, end === -1 ? undefined : end)].join('\n');
}

function testScriptsInJob(yamlText, jobName) {
  const commands = extractRunCommands(workflowJobBlock(yamlText, jobName));
  return commands.flatMap((command) =>
    [...command.matchAll(/\bnpm\s+run\s+(test:[^\s&|;()]+)/g)].map(
      (match) => match[1]
    )
  );
}

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

// #3075: only an executable `jobs.*.steps[*].run` command proves a suite runs
// in CI. Suite text sitting in an inert field (`env:`, `name:`, `with:`) is not
// an invocation, and treating it as one lets a suite report "covered" while no
// workflow ever runs it. These build REAL workflow files and call
// collectWiredSuites — the placeholder below never did.
const UNIVERSE = ['scripts/foo.test.mjs', 'scripts/bar.test.mjs'];
const PKG_SCRIPTS = { 'test:foo': 'node --test scripts/foo.test.mjs' };

/** Write one workflow into a throwaway repo root and collect its wired suites. */
function wiredFor(workflowYaml) {
  const root = mkdtempSync(join(tmpdir(), 'suite-coverage-'));
  try {
    const dir = join(root, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ci.yml'), workflowYaml, 'utf8');
    return [...collectWiredSuites(root, UNIVERSE, PKG_SCRIPTS)].sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('collectWiredSuites: a suite named only in an inert env value is NOT wired', () => {
  const wf = `
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      NOTE: "node --test scripts/foo.test.mjs"
    steps:
      - uses: actions/checkout@v4
`;
  assert.deepEqual(wiredFor(wf), []);
});

test('collectWiredSuites: the same command in a step run IS wired', () => {
  const wf = `
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: "node --test scripts/foo.test.mjs"
`;
  assert.deepEqual(wiredFor(wf), ['scripts/foo.test.mjs']);
});

test('collectWiredSuites: an inert `npm run test:foo` string is NOT wired; a run step is', () => {
  const inert = `
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: npm run test:foo
        uses: actions/checkout@v4
        with:
          note: npm run test:foo
`;
  assert.deepEqual(wiredFor(inert), [], 'step name/with inputs do not execute');

  const executable = `
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: run the suite
        run: npm run test:foo
`;
  assert.deepEqual(wiredFor(executable), ['scripts/foo.test.mjs']);
});

test('collectWiredSuites: block-scalar run bodies are executable text', () => {
  const wf = `
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
    steps:
      - name: several commands
        run: |
          echo "starting scripts/bar.test.mjs"
          node --test scripts/foo.test.mjs
`;
  // `defaults.run` is a mapping, not a command, and must not be scanned; both
  // suite names appear inside the real run block, so both count.
  assert.deepEqual(wiredFor(wf), ['scripts/bar.test.mjs', 'scripts/foo.test.mjs']);
});

test('extractRunCommands: returns only step commands, in order', () => {
  const wf = `
name: ci
on: [push]
env:
  TOP: node --test scripts/foo.test.mjs
jobs:
  a:
    steps:
      - run: first
      - name: second step
        run: |
          second
          lines
  b:
    steps:
      - run: third
`;
  assert.deepEqual(extractRunCommands(wf), [
    'first',
    '          second\n          lines',
    'third',
  ]);
});

test('collectWiredSuites resolves npm-run steps in a synthetic workflow', () => {
  const universe = ['scripts/foo.test.mjs', 'scripts/bar.test.mjs'];
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

// #3739: the production build used to serialize 61 distinct test:* roots after
// emitting dist, making test process startup + execution 73% of the build job.
// Keep the one package-surface test that consumes dist beside the build, and
// run the remaining roots in a sibling job. #3675 adds the snapshot-version
// response contract as the 62nd root. The exact count turns a dropped or
// duplicated invocation into a reviewable failure; the zero-unwired assertion
// above independently proves that the underlying scripts/*.test.mjs files stay
// reachable from some workflow.
test('the build test tail runs in the parallel gates job without losing a root', () => {
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const buildScripts = testScriptsInJob(ci, 'build');
  const gateScripts = testScriptsInJob(ci, 'gates');

  assert.deepEqual(buildScripts, ['test:package-surface']);
  assert.equal(gateScripts.length, 61, gateScripts.join('\n'));
  assert.equal(new Set(gateScripts).size, 61, 'gates must not duplicate a test:* root');
  assert.equal(new Set([...buildScripts, ...gateScripts]).size, 62);

  const gatesJob = workflowJobBlock(ci, 'gates');
  assert.match(gatesJob, /\n    needs: \[resolve-merge, changes\]\n/);
  assert.doesNotMatch(gatesJob, /\bneeds:[^\n]*\bbuild\b/);
});
