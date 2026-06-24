// Unit tests for the pure budget logic in perf-probe.mjs (#2069, epic #1474).
// The measurement path needs a live server + real corpus and is run on demand
// (see the script header); these tests cover only the network-free core:
// percentile() and evaluateBudget() (the over/under-budget branch). Run:
//   node --test scripts/perf-probe.test.mjs   (npm run test:perf-probe)
//
// Also asserts the shipped perf-probe-budget.json parses and has the shape the
// evaluator reads, so a malformed edit fails here instead of silently at runtime.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { percentile, round1, evaluateBudget } from './perf-probe.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

test('percentile: empty and single-element', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([42], 95), 42);
});

test('percentile: interpolates between samples', () => {
  const s = [10, 20, 30, 40, 50];
  assert.equal(percentile(s, 50), 30); // exact middle
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile(s, 100), 50);
  // p95 of 5 samples => rank 3.8 => 40 + 0.8*(50-40) = 48
  assert.equal(round1(percentile(s, 95)), 48);
});

test('evaluateBudget: passes when every metric is under budget', () => {
  const measurements = {
    endpoints: {
      '/api/dataset.json': { p50: 100, p95: 200 },
      '/api/recommendations.json': { p50: 150, p95: 250 },
    },
    dataset: { uncompressedBytes: 1000, compressedBytes: 100, firstHitMs: 500 },
  };
  const budget = {
    endpoints: {
      '/api/dataset.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
      '/api/recommendations.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
    },
    dataset: { uncompressedMaxBytes: 10000, compressedMaxBytes: 1000, coldBuildMaxMs: 5000 },
  };
  const { ok, breaches } = evaluateBudget(measurements, budget);
  assert.equal(ok, true);
  assert.deepEqual(breaches, []);
});

test('evaluateBudget: reports each breach (latency + bytes + cold build)', () => {
  const measurements = {
    endpoints: {
      '/api/recommendations.json': { p50: 9000, p95: 23000 },
    },
    dataset: { uncompressedBytes: 200000000, compressedBytes: 20000000, firstHitMs: 200000 },
  };
  const budget = {
    endpoints: {
      '/api/recommendations.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
    },
    dataset: { uncompressedMaxBytes: 160000000, compressedMaxBytes: 18000000, coldBuildMaxMs: 180000 },
  };
  const { ok, breaches } = evaluateBudget(measurements, budget);
  assert.equal(ok, false);
  const metrics = breaches.map((b) => b.metric).sort();
  assert.deepEqual(metrics, [
    '/api/recommendations.json p50',
    '/api/recommendations.json p95',
    'dataset cold-build ms',
    'dataset compressed bytes',
    'dataset uncompressed bytes',
  ]);
  // Each breach carries the offending value and the limit it exceeded.
  const p95 = breaches.find((b) => b.metric === '/api/recommendations.json p95');
  assert.equal(p95.value, 23000);
  assert.equal(p95.limit, 2000);
});

test('evaluateBudget: only checks metrics present on BOTH sides (no throw on partial)', () => {
  // Measurement missing an endpoint the budget names, and a budget missing keys
  // the measurement has — neither should throw nor produce a phantom breach.
  const measurements = { endpoints: { '/api/digest': { p50: 100 } }, dataset: {} };
  const budget = {
    endpoints: {
      '/api/digest': { warmP95MaxMs: 50 }, // p95 absent from measurement -> skipped
      '/api/sessions': { warmP50MaxMs: 1 }, // endpoint absent from measurement -> skipped
    },
    dataset: { uncompressedMaxBytes: 1 }, // bytes absent from measurement -> skipped
  };
  const { ok, breaches } = evaluateBudget(measurements, budget);
  assert.equal(ok, true);
  assert.deepEqual(breaches, []);
});

test('shipped perf-probe-budget.json parses and matches the evaluator shape', () => {
  const budget = JSON.parse(readFileSync(join(PROJECT_DIR, 'perf-probe-budget.json'), 'utf8'));
  assert.ok(budget.endpoints && typeof budget.endpoints === 'object');
  assert.ok(budget.dataset && typeof budget.dataset === 'object');
  for (const limits of Object.values(budget.endpoints)) {
    assert.ok(Number.isFinite(limits.warmP50MaxMs));
    assert.ok(Number.isFinite(limits.warmP95MaxMs));
  }
  assert.ok(Number.isFinite(budget.dataset.uncompressedMaxBytes));
  assert.ok(Number.isFinite(budget.dataset.compressedMaxBytes));
  // A real measurement under these generous pre-fix ceilings must pass.
  const underBudget = {
    endpoints: { '/api/dataset.json': { p50: 100, p95: 200 } },
    dataset: { uncompressedBytes: 1000, compressedBytes: 100, firstHitMs: 500 },
  };
  assert.equal(evaluateBudget(underBudget, budget).ok, true);
});
