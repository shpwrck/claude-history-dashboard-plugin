// Unit tests for the pure aggregation in dataset-field-sizes.mjs (#2072, epic
// #1474). The fetch path needs a live server and runs on demand; these cover the
// network-free core: valueBytes, fieldCardinality, fieldSizes (sort, totals,
// percentages, edge shapes). Run:
//   node --test scripts/dataset-field-sizes.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { valueBytes, fieldCardinality, fieldSizes } from './dataset-field-sizes.mjs';

test('valueBytes: serialized byte size, undefined contributes 0', () => {
  assert.equal(valueBytes(undefined), 0);
  assert.equal(valueBytes([]), 2); // "[]"
  assert.equal(valueBytes('ab'), 4); // '"ab"'
  assert.equal(valueBytes(null), 4); // "null"
});

test('fieldCardinality: array length, object key count, else null', () => {
  assert.equal(fieldCardinality([1, 2, 3]), 3);
  assert.equal(fieldCardinality({ a: 1, b: 2 }), 2);
  assert.equal(fieldCardinality('scalar'), null);
  assert.equal(fieldCardinality(42), null);
});

test('fieldSizes: sorts largest-first with totals and percentages', () => {
  const dataset = {
    big: 'x'.repeat(1000),
    small: [1, 2],
    generatedAt: 123,
  };
  const { totalBytes, rows } = fieldSizes(dataset);
  assert.equal(rows[0].key, 'big'); // largest first
  assert.equal(rows.length, 3);
  // percentages sum to ~100 and bytes sum to total
  const sumBytes = rows.reduce((s, r) => s + r.bytes, 0);
  assert.equal(sumBytes, totalBytes);
  const sumPct = rows.reduce((s, r) => s + r.pct, 0);
  assert.ok(Math.abs(sumPct - 100) < 1e-6);
  assert.equal(rows.find((r) => r.key === 'small').count, 2);
});

test('fieldSizes: tolerates a non-object input (no throw)', () => {
  assert.deepEqual(fieldSizes(null), { totalBytes: 0, rows: [] });
  assert.deepEqual(fieldSizes('nope'), { totalBytes: 0, rows: [] });
});
