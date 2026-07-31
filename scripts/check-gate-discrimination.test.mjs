// The gate-discrimination ratchet must itself be able to fail (#3478).
//
// Run: node --test scripts/check-gate-discrimination.test.mjs
//   (npm run test:gate-discrimination)
//
// Must-reject cases drive the pure audit with synthetic inputs; the live case
// spawns the real CLI against this repo (via the shared gate harness) so the
// committed registry is proven sound on every CI run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  auditGateDiscrimination,
  collectGateSurfaces,
} from './check-gate-discrimination.mjs';
import { GATE_REGISTRY, LEGACY_NULL_GATES } from './lib/gate-registry.mjs';
import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';

const CHECK = join(PROJECT_DIR, 'scripts', 'check-gate-discrimination.mjs');

const REGISTERED = [
  { name: 'good-gate', script: 'scripts/good-gate.mjs', discriminatingTest: 'scripts/good-gate.test.mjs' },
];
const surfacesOf = (entries) => new Map(entries.map((e) => [e.script, new Set(['fixture'])]));
const allTestsExist = () => true;

test('an UNREGISTERED gate surface fails the check', () => {
  const failures = auditGateDiscrimination({
    surfaces: new Map([
      ...surfacesOf(REGISTERED),
      ['scripts/check-brand-new.mjs', new Set(['scripts/check-brand-new.mjs'])],
    ]),
    registry: REGISTERED,
    legacyNulls: [],
    testExists: allTestsExist,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unregistered gate surface: scripts\/check-brand-new\.mjs/);
});

test('a NEW null entry (name not in the seeded legacy list) fails the check', () => {
  const failures = auditGateDiscrimination({
    surfaces: new Map(),
    registry: [
      ...REGISTERED,
      { name: 'sneaky-new-gate', script: 'scripts/sneaky.mjs', discriminatingTest: null },
    ],
    legacyNulls: [],
    testExists: allTestsExist,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /new null registry entry "sneaky-new-gate"/);
  assert.match(failures[0], /only shrink/);
});

test('a DANGLING discriminating test path fails the check', () => {
  const failures = auditGateDiscrimination({
    surfaces: new Map(),
    registry: [
      { name: 'gone', script: 'scripts/gone.mjs', discriminatingTest: 'scripts/gone.test.mjs' },
    ],
    legacyNulls: [],
    testExists: () => false,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /dangling discriminating test for "gone"/);
});

test('a STALE legacy exception (no matching entry, or entry now tested) fails the check', () => {
  const noEntry = auditGateDiscrimination({
    surfaces: new Map(),
    registry: REGISTERED,
    legacyNulls: ['vanished-gate'],
    testExists: allTestsExist,
  });
  assert.equal(noEntry.length, 1);
  assert.match(noEntry[0], /stale legacy exception "vanished-gate"/);

  const nowTested = auditGateDiscrimination({
    surfaces: new Map(),
    registry: REGISTERED,
    legacyNulls: ['good-gate'],
    testExists: allTestsExist,
  });
  assert.equal(nowTested.length, 1);
  assert.match(nowTested[0], /remove the name from LEGACY_NULL_GATES/);
});

test('a sound synthetic registry (nulls only from the seeded list) passes', () => {
  const registry = [
    ...REGISTERED,
    { name: 'legacy-gate', script: 'scripts/legacy.mjs', discriminatingTest: null },
  ];
  const failures = auditGateDiscrimination({
    surfaces: surfacesOf(REGISTERED),
    registry,
    legacyNulls: ['legacy-gate'],
    testExists: allTestsExist,
  });
  assert.deepEqual(failures, []);
});

test('the COMMITTED registry is sound for this repo (live audit + CLI exit 0)', () => {
  // Unit-level: the real derived surfaces against the real registry.
  const failures = auditGateDiscrimination({ surfaces: collectGateSurfaces() });
  assert.deepEqual(failures, []);

  // Every seeded exception is a null entry (the list mirrors reality).
  const nullNames = GATE_REGISTRY.filter((e) => e.discriminatingTest === null).map((e) => e.name);
  assert.deepEqual([...nullNames].sort(), [...LEGACY_NULL_GATES].sort());

  // Spawn-level: the wired CLI agrees.
  const r = runGate(CHECK);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Gate discrimination check passed/);
  assert.match(r.out, /shrink-only/);
});
