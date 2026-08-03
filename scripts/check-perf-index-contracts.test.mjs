// Discriminating tests for the eager-index recurrence gate (#3481).
// Run: node --test scripts/check-perf-index-contracts.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePerfIndexContracts } from './check-perf-index-contracts.mjs';

const diff = (...lines) => lines.join('\n');

test('rejects a new Map or Set precomputation with no declared consumption contract', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,2 @@',
    '+export function example(rows) {',
    '+  const byId = new Map(rows.map((row) => [row.id, row]));',
  ));

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing a perf-index-contract/i);
});

test('rejects a newly sorted index with no declared consumption contract', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,2 @@',
    '+const byTimestamp = [...rows]',
    '+  .sort((a, b) => a.timestamp - b.timestamp);',
  ));

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing a perf-index-contract/i);
});

test('does not accept a contract from a different diff hunk', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,1 @@',
    '+// perf-index-contract: unrelated always-consumed: every call queries this first index',
    '@@ -20,0 +21,1 @@',
    '+const byId = new Map(rows.map((row) => [row.id, row]));',
  ));

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /missing a perf-index-contract/i);
});

test('rejects a non-querying contract without a matching zero-work regression test', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,3 @@',
    '+// perf-index-contract: example-by-id non-querying',
    '+export function example(rows) {',
    '+  const byId = new Map(rows.map((row) => [row.id, row]));',
  ));

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /zero-work regression test/i);
});

test('accepts a non-querying contract only with the matching test marker and a zero assertion', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,3 @@',
    '+// perf-index-contract: example-by-id non-querying',
    '+export function example(rows) {',
    '+  const byId = new Map(rows.map((row) => [row.id, row]));',
    'diff --git a/src/lib/example.test.ts b/src/lib/example.test.ts',
    '+++ b/src/lib/example.test.ts',
    '@@ -1,0 +1,3 @@',
    '+// perf-index-contract: example-by-id non-querying',
    "+it('does no work when unused', () => {",
    '+  expect(indexReads).toBe(0);',
  ));

  assert.deepEqual(result, { ok: true, errors: [], contracts: ['example-by-id'] });
});

test('accepts an always-consumed contract only when it carries a concrete rationale', () => {
  const accepted = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,3 @@',
    '+// perf-index-contract: example-by-id always-consumed: every call resolves at least one requested id',
    '+export function example(rows) {',
    '+  const byId = new Map(rows.map((row) => [row.id, row]));',
  ));
  assert.equal(accepted.ok, true);

  const rejected = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,3 @@',
    '+// perf-index-contract: example-by-id always-consumed: needed',
    '+export function example(rows) {',
    '+  const byId = new Set(rows);',
  ));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /concrete .*rationale/i);
});

test('ignores test fixtures and lines that do not construct a Map, Set, or sorted index', () => {
  const result = evaluatePerfIndexContracts(diff(
    'diff --git a/src/lib/example.test.ts b/src/lib/example.test.ts',
    '+++ b/src/lib/example.test.ts',
    '@@ -1,0 +1,2 @@',
    '+const fixture = new Map([["a", 1]]);',
    '+expect(fixture.size).toBe(1);',
    'diff --git a/src/lib/example.ts b/src/lib/example.ts',
    '+++ b/src/lib/example.ts',
    '@@ -1,0 +1,1 @@',
    '+const existingIndex = getIndex();',
  ));

  assert.deepEqual(result, { ok: true, errors: [], contracts: [] });
});
