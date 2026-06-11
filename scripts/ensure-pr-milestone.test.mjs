// Unit test for ensure-pr-milestone.mjs release-milestone selection (#722).
//
// Like check-release-gate.test.mjs, this is a standalone node script (the Vitest
// suite covers src/ only). Run:
//   node scripts/ensure-pr-milestone.test.mjs   (npm run test:milestone-guard)
// Exits non-zero on the first failure. Covers the pure selection logic; the
// gh-backed assignment path is exercised by the workflow, not here.

import assert from 'node:assert/strict';
import { isReleaseMilestone, pickOpenReleaseMilestone } from './ensure-pr-milestone.mjs';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${label}: ${err.message}`);
  }
}

// `vX.Y` and `vX.Y.Z` titles are release milestones; "Future" and prose buckets
// are not. The optional patch segment was added in #1045 — the cut convention
// drifted to a three-part name (v0.4.0) from v0.4 onward.
check('isReleaseMilestone matches vX.Y and vX.Y.Z, rejects buckets', () => {
  assert.equal(isReleaseMilestone('v0.3'), true);
  assert.equal(isReleaseMilestone('v1.10'), true);
  assert.equal(isReleaseMilestone('v0.3 '), true); // trimmed
  assert.equal(isReleaseMilestone('v0.4.0'), true); // three-part cut name (#1045)
  assert.equal(isReleaseMilestone('v1.2.10'), true);
  assert.equal(isReleaseMilestone('Future'), false);
  assert.equal(isReleaseMilestone('v0'), false);
  assert.equal(isReleaseMilestone('v0.3.0.1'), false); // four segments is not a cut name
  assert.equal(isReleaseMilestone(''), false);
  assert.equal(isReleaseMilestone(undefined), false);
});

// Exactly one open release milestone -> pick it (the common case: one cut open).
check('one open release milestone is picked', () => {
  const r = pickOpenReleaseMilestone([
    { title: 'v0.3', number: 3 },
    { title: 'Future', number: 4 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.milestone.title, 'v0.3');
  assert.equal(r.milestone.number, 3);
});

// No open release milestone -> ambiguous 'none' (caller fails, asks for one).
check('no open release milestone -> reason none', () => {
  const r = pickOpenReleaseMilestone([{ title: 'Future', number: 4 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'none');
});

check('empty / nullish input -> reason none', () => {
  assert.equal(pickOpenReleaseMilestone([]).reason, 'none');
  assert.equal(pickOpenReleaseMilestone(undefined).reason, 'none');
});

// More than one open release milestone -> ambiguous (caller fails, human picks).
check('multiple open release milestones -> reason ambiguous', () => {
  const r = pickOpenReleaseMilestone([
    { title: 'v0.3', number: 3 },
    { title: 'v0.4', number: 5 },
    { title: 'Future', number: 4 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidates.map((m) => m.title), ['v0.3', 'v0.4']);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll milestone-guard selection checks passed.');
