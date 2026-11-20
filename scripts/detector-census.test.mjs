// #2998: the detector census is reproducible, separates measured-false from
// unmeasured, discloses its population and window, and refuses to carry
// transcript text, per-session rows, or event counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CENSUS_POPULATION,
  assertSanitizedCensus,
  buildDetectorCensus,
  observationWindow,
  serializeCensus,
  _test,
} from './detector-census.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

const finding = (id) => ({ id, category: 'cost', severity: 'info', title: 't', detail: 'd', action: 'a' });

const DETECTORS = [
  // Fires when it sees sessions.
  {
    id: 'cost.fires',
    category: 'cost',
    dataDeps: ['sessions'],
    rule: (input) => (input.sessions.length > 0 ? finding('cost.fires') : null),
  },
  // Sees its data, stays quiet: measured-false.
  {
    id: 'workflow.quiet',
    category: 'workflow',
    dataDeps: ['sessions', 'apiErrors'],
    rule: () => null,
  },
  // Its only input is absent: unmeasured, not "never fires".
  {
    id: 'reliability.no-input',
    category: 'reliability',
    dataDeps: ['debugLogs'],
    rule: () => null,
  },
  // Declares no inputs and stays quiet: unmeasured.
  { id: 'activity.undeclared', category: 'activity', rule: () => null },
  // Multi-emit path is attributed to its own detector.
  {
    id: 'context.multi',
    category: 'context',
    dataDeps: ['debugLogs'],
    rule: () => null,
    emitAll: () => [finding('context.multi'), finding('context.multi')],
  },
];

function input(overrides = {}) {
  return {
    sessions: [
      { id: 'secret-session-a', startTime: T0, endTime: T0 + 3600_000 },
      { id: 'secret-session-b', startTime: T0 + 5 * DAY, endTime: T0 + 5 * DAY + 60_000 },
    ],
    apiErrors: [],
    debugLogs: null,
    ...overrides,
  };
}

test('classifies fired, measured-not-fired, and unmeasured detectors', () => {
  const census = buildDetectorCensus({ detectors: DETECTORS, input: input() });
  const byId = Object.fromEntries(census.detectors.map((row) => [row.id, row]));
  assert.deepEqual(byId['cost.fires'], { id: 'cost.fires', measured: true, firedEver: true });
  assert.deepEqual(byId['workflow.quiet'], { id: 'workflow.quiet', measured: true, firedEver: false });
  assert.deepEqual(byId['reliability.no-input'], {
    id: 'reliability.no-input',
    measured: false,
    firedEver: null,
  });
  assert.deepEqual(byId['activity.undeclared'], {
    id: 'activity.undeclared',
    measured: false,
    firedEver: null,
  });
  // A detector that fires is measured even when its declared input looks empty.
  assert.deepEqual(byId['context.multi'], { id: 'context.multi', measured: true, firedEver: true });
  assert.deepEqual(
    census.detectors.map((row) => row.id),
    [...census.detectors.map((row) => row.id)].sort()
  );
  assert.equal(census.coverage.detectors, 5);
  assert.equal(census.coverage.firedEver, 2);
  assert.equal(census.coverage.measuredNotFired, 1);
  assert.equal(census.coverage.unmeasured, 2);
});

test('discloses the population and the observation window', () => {
  const census = buildDetectorCensus({ detectors: DETECTORS, input: input() });
  assert.equal(census.coverage.population, CENSUS_POPULATION);
  assert.match(census.coverage.population, /this machine's retained local/i);
  assert.match(census.coverage.unmeasuredMeans, /not evidence that it never fires/);
  assert.deepEqual(census.window, { from: '2026-03-01', to: '2026-03-06', asOf: '2026-03-06' });
});

test('is reproducible: the same inputs serialize to the same bytes', () => {
  const a = serializeCensus(buildDetectorCensus({ detectors: DETECTORS, input: input() }));
  const b = serializeCensus(
    buildDetectorCensus({ detectors: [...DETECTORS].reverse(), input: input() })
  );
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'));
});

test('evaluates detectors as of the window end, not the wall clock', () => {
  const seen = [];
  const clock = { id: 'speed.clock', category: 'speed', dataDeps: ['sessions'], rule: (_i, now) => (seen.push(now), null) };
  buildDetectorCensus({ detectors: [clock], input: input() });
  assert.deepEqual(seen, [T0 + 5 * DAY + 60_000]);
});

test('needs an explicit as-of date when no session dates the window', () => {
  assert.throws(
    () => buildDetectorCensus({ detectors: DETECTORS, input: input({ sessions: [] }) }),
    /--as-of/
  );
  const asOfMs = _test.parseArgs(['--as-of', '2026-04-02']).asOf;
  const census = buildDetectorCensus({ detectors: DETECTORS, input: input({ sessions: [] }), asOfMs });
  assert.deepEqual(census.window, { from: null, to: null, asOf: '2026-04-02' });
  assert.equal(observationWindow([]), null);
});

test('rejects a duplicate detector id', () => {
  assert.throws(
    () => buildDetectorCensus({ detectors: [DETECTORS[0], DETECTORS[0]], input: input() }),
    /duplicate detector id/
  );
});

test('the output carries no session ids or other input values', () => {
  const text = serializeCensus(buildDetectorCensus({ detectors: DETECTORS, input: input() }));
  assert.doesNotMatch(text, /secret-session/);
});

function clean() {
  return buildDetectorCensus({ detectors: DETECTORS, input: input() });
}

test('rejects transcript text in a detector row', () => {
  const census = clean();
  census.detectors[0].evidence = 'user: please refactor the billing module';
  assert.throws(() => assertSanitizedCensus(census), /keys must be exactly/);
  const asId = clean();
  asId.detectors[0].id = 'please refactor the billing module';
  assert.throws(() => assertSanitizedCensus(asId), /is not a detector id/);
  const asDisclosure = clean();
  asDisclosure.coverage.population = 'session secret-session-a said ...';
  assert.throws(() => assertSanitizedCensus(asDisclosure), /fixed disclosure/);
});

test('rejects per-session rows', () => {
  const census = clean();
  census.sessions = [{ id: 'secret-session-a', fired: ['cost.fires'] }];
  assert.throws(() => assertSanitizedCensus(census), /census keys must be exactly/);
  const nested = clean();
  nested.window.sessions = ['secret-session-a'];
  assert.throws(() => assertSanitizedCensus(nested), /window keys must be exactly/);
});

test('rejects event counts', () => {
  const asRowField = clean();
  asRowField.detectors[0].fires = 12;
  assert.throws(() => assertSanitizedCensus(asRowField), /keys must be exactly/);
  const asFiredEver = clean();
  asFiredEver.detectors[0].firedEver = 12;
  assert.throws(() => assertSanitizedCensus(asFiredEver), /firedEver must be boolean/);
  const asTally = clean();
  asTally.coverage.firedEver = 4812;
  assert.throws(() => assertSanitizedCensus(asTally), /tallies must count the detector rows/);
  const asWindowTime = clean();
  asWindowTime.window.to = '2026-03-06T10:01:00.000Z';
  assert.throws(() => assertSanitizedCensus(asWindowTime), /YYYY-MM-DD/);
});

test('an unmeasured row cannot claim a fired-ever value', () => {
  const census = clean();
  const row = census.detectors.find((r) => !r.measured);
  row.firedEver = false;
  assert.throws(() => assertSanitizedCensus(census), /null when unmeasured/);
});

function writeFixtureHome(home) {
  const project = join(home, '.claude', 'projects', '-repo-census');
  mkdirSync(project, { recursive: true });
  const lines = [
    {
      type: 'user',
      sessionId: 'census-fixture-session',
      timestamp: '2026-02-10T09:00:00.000Z',
      cwd: '/repo/census',
      message: { role: 'user', content: 'CENSUS-FIXTURE-PROMPT-TEXT' },
    },
    {
      type: 'assistant',
      sessionId: 'census-fixture-session',
      timestamp: '2026-02-10T09:01:00.000Z',
      message: {
        id: 'census-assistant',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'CENSUS-FIXTURE-REPLY-TEXT' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  writeFileSync(
    join(project, 'census-fixture-session.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
}

function runCli(home, out) {
  const env = { ...process.env, HOME: home, CHD_SCOPED_INGEST: '1' };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_|DASHBOARD_|CHD_)/.test(key) && key !== 'CHD_SCOPED_INGEST') delete env[key];
  }
  return spawnSync(
    process.execPath,
    ['--import', './scripts/register-ts.mjs', 'scripts/detector-census.mjs', '--out', out],
    { cwd: REPO_ROOT, env, encoding: 'utf8' }
  );
}

test('the CLI over a real ingest is reproducible and sanitized', () => {
  const root = mkdtempSync(join(tmpdir(), 'chd-2998-census-'));
  try {
    const home = join(root, 'home');
    writeFixtureHome(home);
    const first = join(root, 'first.json');
    const second = join(root, 'second.json');
    const runA = runCli(home, first);
    assert.equal(runA.status, 0, runA.stderr);
    const runB = runCli(home, second);
    assert.equal(runB.status, 0, runB.stderr);

    const a = readText(first);
    assert.equal(a, readText(second));
    const census = assertSanitizedCensus(JSON.parse(a));
    assert.deepEqual(census.window, { from: '2026-02-10', to: '2026-02-10', asOf: '2026-02-10' });
    assert.ok(census.coverage.detectors > 50, 'runs the real detector catalog');
    assert.doesNotMatch(a, /CENSUS-FIXTURE|census-fixture-session|\/repo\/census/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readText(path) {
  return readFileSync(path, 'utf8');
}
