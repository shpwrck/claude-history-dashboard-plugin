import assert from 'node:assert/strict';
import test from 'node:test';

import { timingStats } from './lib/cold-load-statistics.mjs';

test('captured contended FCP series gate on their least-contended sample', () => {
  for (const runs of [
    [1040, 796, 1208, 1520, 552],
    [360, 656, 976, 1992, 3580],
  ]) {
    const stats = timingStats(runs);
    assert.ok(stats.median > 700, 'the old median gate must reproduce the CI failure');
    assert.ok(stats.best <= 700, 'one uncontended sample must preserve the valid measurement');
  }
});

test('a consistently slow series still fails the timing ceiling', () => {
  const stats = timingStats([810, 920, 1030, 1140, 1250]);
  assert.ok(stats.best > 700);
});

test('gate precision is not weakened by report rounding', () => {
  const stats = timingStats([700.4, 710.2, 720.1]);
  assert.ok(stats.best > 700);
  assert.deepEqual(stats.runs, [700, 710, 720]);
});

test('timing statistics reject empty or non-finite samples', () => {
  assert.throws(() => timingStats([]), /non-empty/);
  assert.throws(() => timingStats([100, Number.NaN]), /finite/);
});
