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

// Resolve one request through the stat-gated cache.
//
//   sourceSignature()  — cheap stat signature of the source; when it matches a
//                        cached entry's signature, the cached payload is served
//                        with no ingest/assemble/score work.
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
// stale cached entry is rebuilt rather than served (invalidation). Returns the
// payload plus a `cache` tag ('hit' | 'miss' | 'refresh') for X-*-Cache headers.
export async function resolveStatGatedCache({
  sourceSignature,
  cacheMap,
  buildsMap,
  key,
  max,
  build,
  buildArgs = [],
}) {
  const sourceSig = sourceSignature();
  const cached = cacheMap.get(key);
  if (cached && cached.sourceSig === sourceSig) {
    cached.lastAccess = Date.now();
    return { value: cached.value, cache: 'hit' };
  }
  let inflight = buildsMap.get(key);
  if (!inflight || inflight.sourceSig !== sourceSig) {
    const promise = (async () => {
      const value = await build(...buildArgs);
      const entry = { value, sourceSig, lastAccess: Date.now() };
      cacheMap.set(key, entry);
      pruneLruMap(cacheMap, max);
      return value;
    })().finally(() => {
      const current = buildsMap.get(key);
      if (current?.promise === promise) buildsMap.delete(key);
    });
    inflight = { sourceSig, promise, lastAccess: Date.now() };
    buildsMap.set(key, inflight);
    pruneLruMap(buildsMap, max);
  } else {
    inflight.lastAccess = Date.now();
  }
  const value = await inflight.promise;
  return { value, cache: cached ? 'refresh' : 'miss' };
}
