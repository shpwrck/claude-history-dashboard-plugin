// Unit tests for the stat-gated single-flight response cache (#1573) that backs
// /api/digest and /api/search. server.mjs boots on import and exports nothing, so
// the route-agnostic core lives in ./lib/stat-gated-cache.mjs and is tested here
// directly. These tests are the deterministic proof of the single-flight and
// invalidation contract the issue requires (the HTTP route test asserts wiring).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStatGatedCache,
  resolveStateBoundMemo,
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

test('#2746 forwards the exact build signature to the build and completion gate', async () => {
  const { cacheMap, buildsMap } = newState();
  const signatureArgs = [];
  const buildArgs = [];

  const result = await resolveStatGatedCache({
    sourceSignature: (expectedSourceSig) => {
      signatureArgs.push(expectedSourceSig);
      return 'sig-A';
    },
    cacheMap,
    buildsMap,
    key: 'doc-snapshot',
    max: 1,
    build: async (sourceSig) => {
      buildArgs.push(sourceSig);
      return 'payload';
    },
  });

  assert.equal(result.value, 'payload');
  assert.deepEqual(buildArgs, ['sig-A']);
  assert.deepEqual(signatureArgs, [undefined, 'sig-A']);
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

test('a source change during the build discards the stale value and retries once', async () => {
  const { cacheMap, buildsMap } = newState();
  let sig = 'sig-A';
  let builds = 0;

  const result = await resolveStatGatedCache({
    sourceSignature: () => sig,
    cacheMap,
    buildsMap,
    key: 'q:racy',
    max: 16,
    build: async () => {
      builds += 1;
      const builtFrom = sig;
      if (builds === 1) sig = 'sig-B';
      return `payload-${builtFrom}`;
    },
  });

  assert.equal(builds, 2, 'the changed source gets exactly one bounded retry');
  assert.equal(result.value, 'payload-sig-B', 'the pre-change value is never returned');
  assert.equal(result.cache, 'miss');
  assert.deepEqual(
    cacheMap.get('q:racy'),
    {
      value: 'payload-sig-B',
      sourceSig: 'sig-B',
      lastAccess: cacheMap.get('q:racy').lastAccess,
    },
    'only the value built from the stable post-change signature is committed'
  );
});

test('a source that never settles serves the freshest build uncached instead of throwing', async () => {
  const { cacheMap, buildsMap } = newState();
  cacheMap.set('q:racy', {
    value: 'last-known-good',
    sourceSig: 'sig-old',
    lastAccess: 1,
  });
  let sig = 'sig-A';
  let builds = 0;

  // The source moves during BOTH builds (a busy multi-agent host bumping the
  // scanned-dir mtime every few seconds), so neither build observes a stable
  // pre/post signature. Rather than throw and freeze on the stale entry (#2874),
  // the freshest build is served without being cached.
  const result = await resolveStatGatedCache({
    sourceSignature: () => sig,
    cacheMap,
    buildsMap,
    key: 'q:racy',
    max: 16,
    build: async () => {
      builds += 1;
      const builtFrom = sig;
      sig = builds === 1 ? 'sig-B' : 'sig-C';
      return `payload-${builtFrom}`;
    },
  });

  assert.equal(builds, 2, 'only the initial build and one retry run');
  assert.equal(
    result.value,
    'payload-sig-B',
    'the freshest (last) build is served, never the days-old cached blob'
  );
  assert.equal(result.cache, 'refresh', 'a pre-existing stale entry marks the serve a refresh');
  assert.equal(
    cacheMap.get('q:racy').value,
    'last-known-good',
    'the unstable value is served but NOT cached — the cache invariant is preserved',
  );
  assert.equal(buildsMap.has('q:racy'), false, 'the in-flight owner is cleared');
});

test('a candidate-bound transient failure retries and is never cached', async () => {
  const { cacheMap, buildsMap } = newState();
  let builds = 0;
  const run = () =>
    resolveStatGatedCache({
      sourceSignature: () => 'unchanged-source',
      cacheMap,
      buildsMap,
      key: 'slice:docGraph',
      max: 1,
      build: async () => ({
        body: `fallback-${++builds}`,
        retryRequired: true,
      }),
      cacheable: (value) => value.retryRequired !== true,
    });

  const first = await run();
  assert.equal(builds, 2, 'the transient candidate receives one bounded retry');
  assert.equal(first.value.body, 'fallback-2');
  assert.equal(cacheMap.size, 0, 'the second fallback is served but never cached');

  const recovered = await resolveStatGatedCache({
    sourceSignature: () => 'unchanged-source',
    cacheMap,
    buildsMap,
    key: 'slice:docGraph',
    max: 1,
    build: async () => ({ body: `healthy-${++builds}`, retryRequired: false }),
    cacheable: (value) => value.retryRequired !== true,
  });
  assert.equal(recovered.value.body, 'healthy-3');
  assert.equal(cacheMap.get('slice:docGraph').value.body, 'healthy-3');
});

test('retry exhaustion never serves a value built under a different trust state', async () => {
  const { cacheMap, buildsMap } = newState();
  cacheMap.set('q:trust-race', {
    value: { body: 'last-known-good', observedState: 'state-A' },
    sourceSig: 'sig-old',
    sourceState: 'state-A',
    lastAccess: 1,
  });
  let sig = 'sig-A';
  let builds = 0;

  await assert.rejects(
    resolveStatGatedCache({
      sourceSignature: () => sig,
      sourceState: () => 'state-A',
      builtSourceState: (value) => value.observedState,
      sourceStatesEqual: (left, right) => left === right,
      cacheMap,
      buildsMap,
      key: 'q:trust-race',
      max: 16,
      build: async () => {
        builds += 1;
        sig = builds === 1 ? 'sig-B' : 'sig-C';
        return { body: `untrusted-${builds}`, observedState: 'state-B' };
      },
    }),
    (error) => {
      assert.equal(error.code, 'SOURCE_CHANGED_DURING_BUILD');
      assert.match(error.message, /trust state changed across the bounded rebuild retry/i);
      return true;
    }
  );

  assert.equal(builds, 2, 'the trust mismatch receives only the bounded retry');
  assert.equal(
    cacheMap.get('q:trust-race').value.body,
    'last-known-good',
    'neither trust-mismatched value is served into or committed over last-good'
  );
  assert.equal(buildsMap.has('q:trust-race'), false, 'the rejected owner is cleared');
});

test('an A -> B -> A build retries when the payload observed a different source state', async () => {
  const { cacheMap, buildsMap } = newState();
  let builds = 0;

  const result = await resolveStatGatedCache({
    sourceSignature: () => 'sig-A',
    sourceState: () => 'state-A',
    builtSourceState: (value) => value.observedState,
    sourceStatesEqual: (left, right) => left === right,
    cacheMap,
    buildsMap,
    key: 'boot',
    max: 16,
    build: async () => {
      builds += 1;
      return builds === 1
        ? { body: 'payload-from-B', observedState: 'state-B' }
        : { body: 'payload-from-A', observedState: 'state-A' };
    },
  });

  assert.equal(builds, 2, 'the payload assembled from the transient state is retried');
  assert.equal(result.value.body, 'payload-from-A');
  assert.equal(cacheMap.get('boot').value.body, 'payload-from-A');
  assert.equal(cacheMap.get('boot').sourceState, 'state-A');
});

test('a warm entry whose built state differs from current state is never a hit', async () => {
  const { cacheMap, buildsMap } = newState();
  let sourceState = 'state-A';
  let builds = 0;
  const run = () =>
    resolveStatGatedCache({
      // Deliberately stable: the independent state gate must protect callers
      // even when a coarse/ABA signature aliases two source states.
      sourceSignature: () => 'same-signature',
      sourceState: () => sourceState,
      builtSourceState: (value) => value.observedState,
      sourceStatesEqual: (left, right) => left === right,
      cacheMap,
      buildsMap,
      key: 'slice:repoMap',
      max: 16,
      build: async () => {
        builds += 1;
        return {
          body: `payload-from-${sourceState}`,
          observedState: sourceState,
        };
      },
    });

  assert.equal((await run()).value.body, 'payload-from-state-A');
  sourceState = 'state-B';
  const refreshed = await run();

  assert.equal(refreshed.cache, 'refresh');
  assert.equal(refreshed.value.body, 'payload-from-state-B');
  assert.equal(builds, 2, 'the state mismatch forces a rebuild despite the aliased signature');
});

test('a transient boot snapshot cannot poison a memo under the surrounding content hash', () => {
  let memo = null;
  let builds = 0;
  const build = (snapshot, recommendationIds) => {
    builds += 1;
    return {
      boot: {
        meta: snapshot ? { docIssueSnapshot: snapshot } : {},
      },
      repoMap: {
        projects: [
          {
            files: [{ recommendations: recommendationIds }],
          },
        ],
      },
    };
  };

  // The first assemble observed transient B even though the caller's current
  // trust state is A. Store what the value actually observed in the memo.
  let resolved = resolveStateBoundMemo({
    memo,
    key: 'content-hash-A',
    sourceState: 'state-A',
    builtSourceState: () => 'state-B',
    sourceStatesEqual: (left, right) => left === right,
    build: () => build({ asOf: 'snapshot-B' }, ['doc-issue-B']),
  });
  memo = resolved.memo;
  assert.equal(resolved.value.boot.meta.docIssueSnapshot.asOf, 'snapshot-B');

  // A bounded retry under A must rebuild rather than replay B merely because
  // the coarse/content hash returned to A.
  resolved = resolveStateBoundMemo({
    memo,
    key: 'content-hash-A',
    sourceState: 'state-A',
    builtSourceState: () => 'state-A',
    sourceStatesEqual: (left, right) => left === right,
    build: () => build(null, []),
  });

  assert.equal(builds, 2);
  assert.equal(
    Object.hasOwn(resolved.value.boot.meta, 'docIssueSnapshot'),
    false,
    'the retried boot omits the transient raw snapshot'
  );
  assert.deepEqual(
    resolved.value.repoMap.projects[0].files[0].recommendations,
    [],
    'the retried repo-map slice omits transient snapshot-derived links'
  );
  assert.equal(resolved.memo.sourceState, 'state-A');
});

test('a recommendations-only memo recovers after assembling a transient snapshot', () => {
  let memo = null;
  let builds = 0;
  const key = JSON.stringify(['content-hash-A', 'configured']);

  // Model the first light recommendation assemble observing transient B while
  // the request's start/completion gates both observe A.
  let resolved = resolveStateBoundMemo({
    memo,
    key,
    sourceState: 'state-A',
    builtSourceState: (dataset) => dataset.observedState,
    sourceStatesEqual: (left, right) => left === right,
    build: () => {
      builds += 1;
      return {
        observedState: 'state-B',
        recommendations: ['stale-doc-issue-finding'],
      };
    },
  });
  memo = resolved.memo;

  // The bounded retry returns to the same content/hook key and state A. It
  // must be able to recover by assembling A, rather than replaying the poisoned
  // light dataset and failing every retry until some unrelated source changes.
  resolved = resolveStateBoundMemo({
    memo,
    key,
    sourceState: 'state-A',
    builtSourceState: (dataset) => dataset.observedState,
    sourceStatesEqual: (left, right) => left === right,
    build: () => {
      builds += 1;
      return { observedState: 'state-A', recommendations: [] };
    },
  });

  assert.equal(resolved.reused, false);
  assert.equal(builds, 2);
  assert.deepEqual(resolved.value.recommendations, []);
  assert.equal(resolved.memo.sourceState, 'state-A');
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
