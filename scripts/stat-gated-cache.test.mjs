// Unit tests for the stat-gated single-flight response cache (#1573) that backs
// /api/digest and /api/search. server.mjs boots on import and exports nothing, so
// the route-agnostic core lives in ./lib/stat-gated-cache.mjs and is tested here
// directly. These tests are the deterministic proof of the single-flight and
// invalidation contract the issue requires (the HTTP route test asserts wiring).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStatGatedCache,
  pruneLruMap,
} from './lib/stat-gated-cache.mjs';

function newState() {
  return { cacheMap: new Map(), buildsMap: new Map() };
}

// A build that is slow enough to keep concurrent callers overlapping in the
// in-flight window, counts how many times it actually ran, and returns a value
// derived from the call index so a shared build is observable in the payload.
function countingBuild(counterRef, value = 'payload') {
  return async () => {
    counterRef.count += 1;
    await new Promise((r) => setTimeout(r, 25));
    return value;
  };
}

test('N concurrent identical requests trigger exactly ONE build (single-flight)', async () => {
  const { cacheMap, buildsMap } = newState();
  const counter = { count: 0 };
  let sig = 'sig-A';
  const call = () =>
    resolveStatGatedCache({
      sourceSignature: () => sig,
      cacheMap,
      buildsMap,
      key: 'q:hello',
      max: 16,
      build: countingBuild(counter, 'results-A'),
    });

  const N = 8;
  const settled = await Promise.all(Array.from({ length: N }, () => call()));

  // Single-flight: one build despite N concurrent identical requests.
  assert.equal(counter.count, 1, 'exactly one build ran for N concurrent identical requests');
  // All callers got the same payload, and the in-flight map is drained.
  for (const r of settled) assert.equal(r.value, 'results-A');
  assert.equal(buildsMap.has('q:hello'), false, 'in-flight build entry is cleared after settle');
  assert.equal(cacheMap.get('q:hello').value, 'results-A', 'payload is cached');
});

test('a warm cache hit serves without rebuilding (no ingest/score work)', async () => {
  const { cacheMap, buildsMap } = newState();
  const counter = { count: 0 };
  const opts = (build) => ({
    sourceSignature: () => 'sig-A',
    cacheMap,
    buildsMap,
    key: 'date:2026-01-01',
    max: 16,
    build,
  });

  const first = await resolveStatGatedCache(opts(countingBuild(counter, 'd1')));
  assert.equal(first.cache, 'miss');
  const second = await resolveStatGatedCache(opts(countingBuild(counter, 'd1')));
  assert.equal(second.cache, 'hit');
  assert.equal(counter.count, 1, 'the warm hit did not run the build again');
  assert.equal(second.value, 'd1');
});

test('a source-signature change invalidates the cache (rebuild)', async () => {
  const { cacheMap, buildsMap } = newState();
  const counter = { count: 0 };
  let sig = 'sig-A';
  const run = (value) =>
    resolveStatGatedCache({
      sourceSignature: () => sig,
      cacheMap,
      buildsMap,
      key: 'q:hello',
      max: 16,
      build: countingBuild(counter, value),
    });

  const cold = await run('results-A');
  assert.equal(cold.cache, 'miss');
  assert.equal(cold.value, 'results-A');

  // Source changed -> signature moves -> the stale entry is rebuilt, not served.
  sig = 'sig-B';
  const afterChange = await run('results-B');
  assert.equal(afterChange.cache, 'refresh', 'a signature change rebuilds');
  assert.equal(afterChange.value, 'results-B', 'the rebuilt payload reflects the new source');
  assert.equal(counter.count, 2, 'the build ran again after the source changed');

  // Same signature again -> hit.
  const warm = await run('results-B');
  assert.equal(warm.cache, 'hit');
  assert.equal(counter.count, 2, 'no extra build for the unchanged source');
});

test('distinct keys (different query/date) are cached independently', async () => {
  const { cacheMap, buildsMap } = newState();
  const counter = { count: 0 };
  const run = (key, value) =>
    resolveStatGatedCache({
      sourceSignature: () => 'sig-A',
      cacheMap,
      buildsMap,
      key,
      max: 16,
      build: countingBuild(counter, value),
    });

  const a = await run('q:alpha', 'A');
  const b = await run('q:beta', 'B');
  assert.equal(a.value, 'A');
  assert.equal(b.value, 'B');
  assert.equal(counter.count, 2, 'each distinct key built once');
  assert.equal((await run('q:alpha', 'A')).cache, 'hit');
  assert.equal((await run('q:beta', 'B')).cache, 'hit');
});

test('pruneLruMap evicts the least-recently-touched entries past the bound', () => {
  const map = new Map();
  map.set('k1', { lastAccess: 1 });
  map.set('k2', { lastAccess: 2 });
  map.set('k3', { lastAccess: 3 });
  pruneLruMap(map, 2);
  assert.equal(map.size, 2);
  assert.equal(map.has('k1'), false, 'oldest entry evicted');
  assert.equal(map.has('k2'), true);
  assert.equal(map.has('k3'), true);
});

test('the response cache is LRU-bounded under a varied key stream', async () => {
  const { cacheMap, buildsMap } = newState();
  const counter = { count: 0 };
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await resolveStatGatedCache({
      sourceSignature: () => 'sig-A',
      cacheMap,
      buildsMap,
      key: `q:${i}`,
      max: 4,
      build: countingBuild(counter, `r${i}`),
    });
  }
  assert.ok(cacheMap.size <= 4, `cache stays bounded (size=${cacheMap.size})`);
});
