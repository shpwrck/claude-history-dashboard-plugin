// Unit test for check-release-gate.mjs target classification (#652).
//
// This repo runs script-level checks as standalone node files (the Vitest suite
// covers src/ only). Run:
//   node scripts/check-release-gate.test.mjs   (npm run test:release-gate)
// Exits non-zero on the first failure. Covers the patch/hotfix exemption: only a
// minor cut (bare `x.y` or `x.y.0`) is gated; a patch (`x.y.z`, z>0) is exempt.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessReleaseState,
  classifyTarget,
  expectsSecurityGate,
  expectsDataIntegrityGate,
  expectedGateCount,
  candidateMilestones,
} from './check-release-gate.mjs';

const label = (name) => ({ name });
const gateDomains = ['performance', 'tech-debt', 'security', 'data-integrity'];
const closedGates = (count = 4) => Array.from({ length: count }, (_, index) => ({
  number: 1900 + index,
  title: `Gate ${index + 1}`,
  state: 'CLOSED',
  labels: [label('release-gate'), label(gateDomains[index])],
}));

const releaseGateWorkflow = readFileSync(
  new URL('../.github/workflows/release-gate.yml', import.meta.url),
  'utf8',
);
assert.match(
  releaseGateWorkflow,
  /^\s*pull-requests:\s*read\s*$/m,
  'release-gate workflow grants the gh pr list caller pull-request read access',
);

const cases = [
  ['v0.2', { milestone: 'v0.2', patch: null, isPatch: false }],
  ['0.2', { milestone: 'v0.2', patch: null, isPatch: false }],
  ['0.2.0', { milestone: 'v0.2', patch: 0, isPatch: false }],
  ['v0.2.1', { milestone: 'v0.2', patch: 1, isPatch: true }],
  ['v0.1.0', { milestone: 'v0.1', patch: 0, isPatch: false }],
  ['0.1.1', { milestone: 'v0.1', patch: 1, isPatch: true }],
  ['v0.1.1', { milestone: 'v0.1', patch: 1, isPatch: true }],
  ['v1.2.3', { milestone: 'v1.2', patch: 3, isPatch: true }],
];

let failures = 0;
for (const [input, expected] of cases) {
  try {
    assert.deepEqual(classifyTarget(input), expected);
    console.log(`  ok  ${input} -> ${expected.milestone} isPatch=${expected.isPatch}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${input}: ${err.message}`);
  }
}

// Unparseable input throws rather than silently passing the gate.
try {
  classifyTarget('nope');
  failures += 1;
  console.error('  FAIL "nope" should have thrown');
} catch {
  console.log('  ok  "nope" throws');
}

// #3074: the version parser is END-anchored, so a target with trailing garbage
// or a non-numeric suffix is REJECTED (throws) rather than prefix-matched and
// waved through the patch exemption. `v0.2.1junk` previously classified as
// patch 1 and exited 0 before any milestone-gate inspection.
const rejects = ['v0.2.1junk', 'v0.2.1.0', 'v0.2-beta', '0.1.2.3', 'v0.2rc1'];
for (const input of rejects) {
  try {
    classifyTarget(input);
    failures += 1;
    console.error(`  FAIL ${input} should be rejected by the anchored parser`);
  } catch {
    console.log(`  ok  ${input} rejected`);
  }
}

// The malformed target must exit non-zero AT classification — before the patch
// exemption that main() would otherwise reach. Parsing fails first, so this
// needs no gh boundary.
{
  const bad = spawnSync(
    process.execPath,
    [new URL('./check-release-gate.mjs', import.meta.url).pathname, 'v0.2.1junk'],
    { encoding: 'utf8', env: { ...process.env } },
  );
  try {
    assert.equal(bad.status, 1, 'malformed target exits non-zero');
    assert.match(bad.stderr, /Cannot parse a milestone/, 'fails at classification, not the gate');
    console.log('  ok  malformed version target exits non-zero before the patch exemption');
  } catch (err) {
    failures += 1;
    console.error(`  FAIL malformed-target CLI: ${err.message}`);
  }
}

// Security gate (third standing epic) is expected only from v0.3 onward (#698).
// v0.1/v0.2 keep the perf+architecture pair; v0.3+ and any v1+ expect security.
const securityCases = [
  ['v0.1', false],
  ['v0.2', false],
  ['v0.3', true],
  ['v0.10', true],
  ['v1.0', true],
  ['v2.4', true],
];
for (const [input, expected] of securityCases) {
  try {
    assert.equal(expectsSecurityGate(input), expected);
    console.log(`  ok  expectsSecurityGate(${input}) -> ${expected}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL expectsSecurityGate(${input}): ${err.message}`);
  }
}

// Data-integrity gate (fourth standing epic) is expected only from v0.6 onward
// (#2130). v0.3–v0.5 keep the perf+architecture+security trio; v0.6+ and any
// v1+ also expect data-integrity.
const dataIntegrityCases = [
  ['v0.2', false],
  ['v0.3', false],
  ['v0.5', false],
  ['v0.6', true],
  ['v0.10', true],
  ['v1.0', true],
  ['v2.4', true],
];
for (const [input, expected] of dataIntegrityCases) {
  try {
    assert.equal(expectsDataIntegrityGate(input), expected);
    console.log(`  ok  expectsDataIntegrityGate(${input}) -> ${expected}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL expectsDataIntegrityGate(${input}): ${err.message}`);
  }
}

// The expected standing-set size rolls up the rollouts: 2 (perf+arch) below
// v0.3, 3 once security lands at v0.3, 4 once data-integrity lands at v0.6.
const gateCountCases = [
  ['v0.2', 2],
  ['v0.3', 3],
  ['v0.5', 3],
  ['v0.6', 4],
  ['v1.0', 4],
];
for (const [input, expected] of gateCountCases) {
  try {
    assert.equal(expectedGateCount(input), expected);
    console.log(`  ok  expectedGateCount(${input}) -> ${expected}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL expectedGateCount(${input}): ${err.message}`);
  }
}

// Milestone resolution must try the three-part `vX.Y.Z` form (current
// convention, #1045) before the two-part `vX.Y` (#722), so the gate matches
// whichever the repo actually created. This is the bug that blocked v0.4.0:
// classifyTarget normalizes to `v0.4` but the milestone is named `v0.4.0`.
const milestoneCases = [
  ['v0.4.0', ['v0.4.0', 'v0.4']],
  ['v0.4', ['v0.4.0', 'v0.4']],
  ['0.4', ['v0.4.0', 'v0.4']],
  ['v0.2', ['v0.2.0', 'v0.2']],
  ['v1.2', ['v1.2.0', 'v1.2']],
];
for (const [input, expected] of milestoneCases) {
  try {
    assert.deepEqual(candidateMilestones(classifyTarget(input)), expected);
    console.log(`  ok  candidateMilestones(${input}) -> ${expected.join(', ')}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL candidateMilestones(${input}): ${err.message}`);
  }
}

// Release-state policy: the required standing set and every non-deferred,
// non-gate milestone issue must be drained before a minor cut.
{
  const missing = assessReleaseState('v0.6.0', closedGates(3), []);
  assert.equal(missing.missingGateCount, 1);
  assert.deepEqual(missing.missingGateLabels, ['data-integrity']);
  assert.equal(missing.ok, false);

  const duplicateDomains = closedGates().map((gate) => ({
    ...gate,
    labels: [label('release-gate'), label('performance')],
  }));
  const duplicates = assessReleaseState('v0.6.0', duplicateDomains, []);
  assert.deepEqual(duplicates.missingGateLabels, ['tech-debt', 'security', 'data-integrity']);
  assert.equal(duplicates.ok, false);

  const multiLabelGate = [{
    ...closedGates(1)[0],
    labels: [label('release-gate'), ...gateDomains.map(label)],
  }];
  const tooFewEpics = assessReleaseState('v0.6.0', multiLabelGate, []);
  assert.equal(tooFewEpics.missingGateEpicCount, 3);
  assert.equal(tooFewEpics.missingGateLabels.length, 3);
  assert.equal(tooFewEpics.ok, false);

  const stackedDomains = closedGates().map((gate, index) => ({
    ...gate,
    labels: index === 0
      ? [label('release-gate'), ...gateDomains.map(label)]
      : [label('release-gate'), label('performance')],
  }));
  const stacked = assessReleaseState('v0.6.0', stackedDomains, []);
  assert.equal(stacked.missingGateLabels.length, 2);
  assert.equal(stacked.ok, false);

  const unfinished = assessReleaseState('v0.6.0', closedGates(), [
    { number: 2455, title: 'Unfinished release work', state: 'OPEN', labels: [label('backlog')] },
  ]);
  assert.deepEqual(unfinished.openWork.map((issue) => issue.number), [2455]);
  assert.equal(unfinished.ok, false);

  const deferred = assessReleaseState('v0.6.0', closedGates(), [
    {
      number: 2456,
      title: 'Explicitly deferred',
      state: 'OPEN',
      labels: [label('release-deferred')],
      body: 'Destination: v0.7.0\nRationale: moved after scope review',
    },
  ]);
  assert.deepEqual(deferred.deferred.map((issue) => issue.number), [2456]);
  assert.equal(deferred.ok, true);

  const unaudited = assessReleaseState('v0.6.0', closedGates(), [
    {
      number: 2457,
      title: 'Unaudited deferral',
      state: 'OPEN',
      labels: [label('release-deferred')],
      body: 'Discussed during v0.7.0 planning.\nRationale: later scope',
    },
  ]);
  assert.deepEqual(unaudited.invalidDeferred.map((issue) => issue.number), [2457]);
  assert.equal(unaudited.ok, false);

  const notActuallyDeferred = assessReleaseState('v0.6.0', closedGates(), [{
    number: 2458,
    title: 'Same-release destination',
    state: 'OPEN',
    labels: [label('release-deferred')],
    body: 'Destination: v0.6.0\nRationale: not moved',
  }]);
  assert.equal(notActuallyDeferred.ok, false);
  const backwardsDeferral = assessReleaseState('v0.6.0', closedGates(), [{
    number: 2459,
    title: 'Older-release destination',
    state: 'OPEN',
    labels: [label('release-deferred')],
    body: 'Destination: v0.5.9\nRationale: invalid rollback',
  }]);
  assert.equal(backwardsDeferral.ok, false);

  const openPr = assessReleaseState('v0.6.0', closedGates(), [], [
    { number: 99, title: 'Unmerged release PR', state: 'OPEN', labels: [] },
  ]);
  assert.deepEqual(openPr.openPullRequests.map((pull) => pull.number), [99]);
  assert.equal(openPr.ok, false);

  assert.equal(assessReleaseState('v0.6.0', closedGates(), []).ok, true);
  console.log('  ok  release-state assessment fails closed and honors explicit deferral');
}

// Exercise the real CLI exit contract with a fake gh boundary. Missing gates
// and unfinished work must exit non-zero; drained/deferred scenarios pass.
const fakeBin = mkdtempSync(join(tmpdir(), 'release-gate-gh-'));
try {
  const fakeGh = join(fakeBin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const payload = args[0] === 'pr'
  ? process.env.FAKE_PRS
  : (args.includes('--label') ? process.env.FAKE_GATES : process.env.FAKE_OPEN);
process.stdout.write(payload || '[]');
`, { mode: 0o755 });

  const runCli = (gates, open, prs = []) => spawnSync(
    process.execPath,
    [new URL('./check-release-gate.mjs', import.meta.url).pathname, 'v0.6.0'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        FAKE_GATES: JSON.stringify(gates),
        FAKE_OPEN: JSON.stringify(open),
        FAKE_PRS: JSON.stringify(prs),
      },
    },
  );

  assert.equal(runCli(closedGates(3), []).status, 1, 'CLI blocks a missing required gate');
  assert.equal(runCli([{
    ...closedGates(1)[0],
    labels: [label('release-gate'), ...gateDomains.map(label)],
  }], []).status, 1, 'CLI blocks too few multi-labelled gate epics');
  assert.equal(runCli(closedGates().map((gate, index) => ({
    ...gate,
    labels: index === 0
      ? [label('release-gate'), ...gateDomains.map(label)]
      : [label('release-gate'), label('performance')],
  })), []).status, 1, 'CLI requires one distinct gate epic per domain');
  assert.equal(runCli(closedGates(), [
    { number: 2455, title: 'Open work', state: 'OPEN', labels: [label('backlog')] },
  ]).status, 1, 'CLI blocks open non-gate work');
  assert.equal(runCli(closedGates(), []).status, 0, 'CLI passes a drained milestone');
  assert.equal(runCli(closedGates(), [
    {
      number: 2456,
      title: 'Deferred',
      state: 'OPEN',
      labels: [label('release-deferred')],
      body: 'Destination: v0.7.0\nRationale: explicitly moved',
    },
  ]).status, 0, 'CLI permits explicit release deferral');
  assert.equal(runCli(closedGates(), [
    { number: 2457, title: 'Unaudited', state: 'OPEN', labels: [label('release-deferred')], body: '' },
  ]).status, 1, 'CLI blocks an unaudited release deferral');
  assert.equal(runCli(closedGates(), [], [
    { number: 2462, title: 'Open release PR', state: 'OPEN', labels: [] },
  ]).status, 1, 'CLI blocks an open milestone pull request');
  console.log('  ok  CLI exit status covers blocked, drained, and deferred milestones');
} finally {
  rmSync(fakeBin, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll release-gate classification checks passed.');
