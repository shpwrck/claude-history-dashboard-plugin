// Unit test for check-release-gate.mjs target classification (#652).
//
// This repo runs script-level checks as standalone node files (the Vitest suite
// covers src/ only). Run:
//   node scripts/check-release-gate.test.mjs   (npm run test:release-gate)
// Exits non-zero on the first failure. Covers the patch/hotfix exemption: only a
// minor cut (bare `x.y` or `x.y.0`) is gated; a patch (`x.y.z`, z>0) is exempt.

import assert from 'node:assert/strict';
import { classifyTarget, expectsSecurityGate, candidateMilestones } from './check-release-gate.mjs';

const cases = [
  ['v0.2', { milestone: 'v0.2', patch: null, isPatch: false }],
  ['0.2', { milestone: 'v0.2', patch: null, isPatch: false }],
  ['0.2.0', { milestone: 'v0.2', patch: 0, isPatch: false }],
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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll release-gate classification checks passed.');
