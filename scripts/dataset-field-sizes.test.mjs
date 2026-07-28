// Unit tests for the pure aggregation in dataset-field-sizes.mjs (#2072, epic
// #1474). The fetch path needs a live server and runs on demand; these cover the
// network-free core: valueBytes, fieldCardinality, fieldSizes (sort, totals,
// percentages, edge shapes). Run:
//   node --test scripts/dataset-field-sizes.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  valueBytes,
  fieldCardinality,
  fieldSizes,
  memberBytes,
} from './dataset-field-sizes.mjs';

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
  const { totalBytes, framingBytes, rows } = fieldSizes(dataset);
  assert.equal(rows[0].key, 'big'); // largest first
  assert.equal(rows.length, 3);
  // percentages sum to ~100 and every attributed byte (members + framing) sums
  // to the total.
  const sumBytes = rows.reduce((s, r) => s + r.bytes, 0);
  assert.equal(sumBytes + framingBytes, totalBytes);
  const sumPct = rows.reduce((s, r) => s + r.pct, 0);
  assert.ok(Math.abs(sumPct + (framingBytes / totalBytes) * 100 - 100) < 1e-6);
  assert.equal(rows.find((r) => r.key === 'small').count, 2);
});

test('fieldSizes: tolerates a non-object input (no throw)', () => {
  assert.deepEqual(fieldSizes(null), { totalBytes: 0, framingBytes: 0, rows: [] });
  assert.deepEqual(fieldSizes('nope'), { totalBytes: 0, framingBytes: 0, rows: [] });
});

// #3078: the report presents `totalBytes` as the size of the dataset.json body,
// so it must equal that body's real UTF-8 byte length — key strings, colons,
// commas and braces included. Isolated value serialization silently omitted all
// of them (`{a:1}` was reported as 1 byte for a 7-byte artifact).
test('fieldSizes: totalBytes equals the serialized dataset byte length, and everything reported sums to it', () => {
  const fixtures = {
    'one field': { a: 1 },
    'multi field': { a: 1, b: [1, 2, 3], c: { d: 'e' } },
    'multibyte key and value': { 'ключ✓': 'значение — ✓', ascii: 'x' },
    'undefined property': { a: 1, gone: undefined, b: 2 },
    'only undefined properties': { gone: undefined },
    empty: {},
  };
  for (const [label, dataset] of Object.entries(fixtures)) {
    const { totalBytes, framingBytes, rows } = fieldSizes(dataset);
    const wire = Buffer.byteLength(JSON.stringify(dataset), 'utf8');
    assert.equal(totalBytes, wire, `${label}: totalBytes must be the wire byte length`);
    const attributed = rows.reduce((s, r) => s + r.bytes, 0) + framingBytes;
    assert.equal(
      attributed,
      wire,
      `${label}: member bytes + framing must sum to the wire byte length`
    );
  }
});

test('fieldSizes: a single-field dataset attributes key + colon + value, not the value alone', () => {
  const { totalBytes, framingBytes, rows } = fieldSizes({ a: 1 });
  assert.equal(totalBytes, 7); // {"a":1}
  assert.equal(framingBytes, 2); // { and }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytes, 5); // "a" + : + 1
  assert.equal(rows[0].valueBytes, 1); // the value in isolation, kept for reference
});

test('memberBytes: a member that never reaches the wire costs zero', () => {
  assert.equal(memberBytes('a', undefined), 0);
  assert.equal(
    memberBytes('a', () => {}),
    0
  );
  assert.equal(memberBytes('a', null), 8); // "a" + : + null
});
