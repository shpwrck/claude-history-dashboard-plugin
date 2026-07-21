// Stat-gated, single-flight response cache (#1573).
//
// The dataset and recommendations routes already gate ingest+assemble work on a
// cheap source signature, single-flight concurrent identical builds, and cache
// the computed payload. /api/digest and /api/search previously had none of that:
// each request ran a full ingest()+assembleDataset() (search also scored+embedded
// every entry) on the event loop, so concurrent traffic head-of-line blocked.
//
// This module is the route-agnostic core of that pattern, factored out so it can
// be unit-tested directly (server.mjs boots on import and exports nothing). It is
// pure JS with no third-party imports, so it stays inside the zero-node_modules
// runtime boot graph (ADR 0007).

// LRU eviction for the bounded response-cache and in-flight-build maps. The
// least-recently-touched entries are dropped first so a varied key stream (e.g.
// distinct search queries) cannot grow a map without bound.
export function pruneLruMap(map, max) {
  if (map.size <= max) return;
  const entries = [...map.entries()].sort(
    (a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0)
  );
  for (const [key] of entries) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

/**
 * Resolve one synchronous assembled-value memo without letting its coarse key
 * hide a trust-state mismatch. The memo records the state the VALUE actually
 * observed, not the state sampled before assembly. If a bounded outer retry
 * returns to an earlier key/state after a transient A -> B -> A race, the B
 * value is therefore rebuilt instead of replayed forever under A's key.
 */
export function resolveStateBoundMemo({
  memo,
  key,
  sourceState,
  build,
  builtSourceState,
  sourceStatesEqual = Object.is,
}) {
  if (
    memo &&
    memo.key === key &&
    Object.prototype.hasOwnProperty.call(memo, 'sourceState') &&
    sourceStatesEqual(memo.sourceState, sourceState)
  ) {
    return { value: memo.value, memo, reused: true };
  }

  const value = build();
  const nextMemo = {
    key,
    value,
    sourceState: builtSourceState(value),
  };
  return { value, memo: nextMemo, reused: false };
}

// Resolve one request through the stat-gated cache.
//
//   sourceSignature()  — cheap stat signature of the source; when it matches a
//                        cached entry's signature, the cached payload is served
//                        with no ingest/assemble/score work.
//   sourceState()      — optional exact trust-bearing state sampled alongside
//                        the coarse signature (for example, a bounded external
//                        snapshot identity). When supplied, `builtSourceState`
//                        must project the state the returned payload ACTUALLY
//                        observed; start, built, and completion states must all
//                        match before the value can be cached.
//   cacheMap / buildsMap — per-state Maps holding cached entries and in-flight
//                        builds, keyed by `key`.
//   key                — identifies the request's result-affecting inputs (date
//                        for digest; query+project+limit for search).
//   max                — LRU bound for both maps.
//   build(...args)     — runs the expensive work and returns the payload to cache.
//   buildArgs          — extra args forwarded to build() after no implicit args.
//
// Concurrency contract: N concurrent requests with the SAME key and an unchanged
// sourceSignature share ONE build (single-flight) — the first installs the
// in-flight promise; the rest await it. A source change moves the signature, so a
// stale cached entry is rebuilt rather than served (invalidation). The signature
// is sampled again AFTER the build: a mid-build change discards that value and
// retries once from the new signature; if it STILL has not settled, the freshest
// build is served WITHOUT being cached (never thrown), so a source that never
// settles — e.g. a busy multi-agent host whose concurrent writers keep bumping
// the scanned-dir mtimes — degrades to always-fresh-but-uncached instead of
// freezing on a stale entry (#2874). Skipping the cache write preserves the
// invariant that a cached entry's signature/state matches what its value
// observed, so a later same-signature request can never replay an unstable value.
// Returns the payload plus a `cache` tag ('hit' | 'miss' | 'refresh') for
// X-*-Cache headers.
export async function resolveStatGatedCache({
  sourceSignature,
  cacheMap,
  buildsMap,
  key,
  max,
  build,
  buildArgs = [],
  sourceState,
  builtSourceState,
  sourceStatesEqual = Object.is,
}) {
  const sourceSig = sourceSignature();
  const stateGateEnabled = typeof sourceState === 'function';
  if (stateGateEnabled !== (typeof builtSourceState === 'function')) {
    throw new TypeError(
      'sourceState and builtSourceState must be provided together'
    );
  }
  const initialSourceState = stateGateEnabled ? sourceState() : undefined;
  const entryMatchesSourceState = (entry, currentState) =>
    !stateGateEnabled ||
    (Object.prototype.hasOwnProperty.call(entry, 'sourceState') &&
      sourceStatesEqual(entry.sourceState, currentState));
  const cached = cacheMap.get(key);
  if (
    cached &&
    cached.sourceSig === sourceSig &&
    entryMatchesSourceState(cached, initialSourceState)
  ) {
    cached.lastAccess = Date.now();
    return { value: cached.value, cache: 'hit' };
  }
  let inflight = buildsMap.get(key);
  if (
    !inflight ||
    inflight.sourceSig !== sourceSig ||
    !entryMatchesSourceState(inflight, initialSourceState)
  ) {
    const buildOwner = {
      sourceSig,
      ...(stateGateEnabled ? { sourceState: initialSourceState } : {}),
      promise: null,
      lastAccess: Date.now(),
    };
    const promise = (async () => {
      let expectedSourceSig = sourceSig;
      let expectedSourceState = initialSourceState;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const value = await build(...buildArgs);
        const completedSourceSig = sourceSignature();
        const completedSourceState = stateGateEnabled
          ? sourceState()
          : undefined;
        const valueSourceState = stateGateEnabled
          ? builtSourceState(value)
          : undefined;
        const stableState =
          !stateGateEnabled ||
          (sourceStatesEqual(expectedSourceState, valueSourceState) &&
            sourceStatesEqual(expectedSourceState, completedSourceState) &&
            sourceStatesEqual(valueSourceState, completedSourceState));
        if (completedSourceSig === expectedSourceSig && stableState) {
          const entry = {
            value,
            sourceSig: completedSourceSig,
            ...(stateGateEnabled
              ? { sourceState: completedSourceState }
              : {}),
            lastAccess: Date.now(),
          };
          cacheMap.set(key, entry);
          pruneLruMap(cacheMap, max);
          return value;
        }

        if (attempt === 1) {
          // Bounded retries exhausted: the source kept moving across every
          // build. On a busy multi-agent host, unrelated file creates/renames in
          // the scanned dirs bump the coarse dir-mtime signature every few
          // seconds, so no build ever observes a stable pre/post signature.
          // Throwing here froze the dataset on a days-old last-good blob (#2874)
          // and surfaced as a bare 500 on the digest/search/boot/slice routes
          // (#2867) — the opposite of what a freshness cache should do. Serve the
          // freshest build instead, but do NOT cache it: a value is always safe
          // to serve, while caching an unstable value under a coarse key that a
          // later same-signature request could replay is not. Once the source
          // settles, the stable branch above commits and fast hits resume.
          return value;
        }

        // Publish the retry signature on this owner so a request arriving
        // during the retry can join it instead of starting duplicate work.
        expectedSourceSig = completedSourceSig;
        expectedSourceState = completedSourceState;
        buildOwner.sourceSig = completedSourceSig;
        if (stateGateEnabled) {
          buildOwner.sourceState = completedSourceState;
        }
      }
      throw new Error('Unreachable stat-gated cache build state');
    })().finally(() => {
      const current = buildsMap.get(key);
      if (current === buildOwner) buildsMap.delete(key);
    });
    buildOwner.promise = promise;
    inflight = buildOwner;
    buildsMap.set(key, inflight);
    pruneLruMap(buildsMap, max);
  } else {
    inflight.lastAccess = Date.now();
  }
  const value = await inflight.promise;
  return { value, cache: cached ? 'refresh' : 'miss' };
}
