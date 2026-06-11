/// <reference lib="webworker" />
//
// Dataset decode worker (#162). Moves the ~8 MB `/api/dataset.json` fetch +
// `JSON.parse` (~128 ms) off the main thread so the load spinner keeps animating
// and the React commit doesn't compete with parse work.
//
// The browser transparently brotli/gzip-decodes the response (the server sets
// Content-Encoding), so `resp.json()` here only does the text-decode + parse —
// both off the UI thread. The parsed object is structured-cloned back to the
// caller (no transferable needed). The worker keeps a parsed IndexedDB cache by
// dataset ETag: unchanged reloads do a tiny `If-None-Match` revalidation and
// skip both the 8 MB compressed transfer and the 65 MB JSON parse. A changed
// ETag downloads, parses, and replaces the cached object. Replies `{ data }` on
// success or `{ error }` on any failure, so the caller can fall back to its
// manual-upload path.

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DB_NAME = 'claude-history-dashboard-dataset';
const STORE_NAME = 'dataset';
const CACHE_KEY = 'live';

interface CachedDataset {
  etag: string;
  data: unknown;
}

interface DatasetRequest {
  url: string;
  headers?: Record<string, string>;
  cacheKey?: string | null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function readCachedDataset(cacheKey: string | null): Promise<CachedDataset | null> {
  if (!cacheKey || !('indexedDB' in ctx)) return null;
  let db: IDBDatabase | null = null;
  try {
    db = await openCacheDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const cached = await requestToPromise<CachedDataset | undefined>(
      tx.objectStore(STORE_NAME).get(cacheKey)
    );
    return cached?.etag ? cached : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function writeCachedDataset(
  cacheKey: string | null,
  cached: CachedDataset
): Promise<void> {
  if (!cacheKey || !('indexedDB' in ctx)) return;
  let db: IDBDatabase | null = null;
  try {
    db = await openCacheDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await requestToPromise(tx.objectStore(STORE_NAME).put(cached, cacheKey));
  } catch {
    // Quota/private-mode failures should not break live loading; they only
    // disable the fast reload path.
  } finally {
    db?.close();
  }
}

// Stale-while-revalidate protocol (#1015). When a cached dataset exists, post
// it immediately as `{ type: 'cached' }` so the caller paints instantly (no
// network wait on a repeat load), THEN revalidate: `{ type: 'unchanged' }` on a
// 304 (the cached paint was current) or `{ type: 'fresh' }` with the new data on
// a changed ETag. With no cache, a single `{ type: 'fresh' }` carries the first
// load. `{ type: 'error' }` on any failure. The caller resolves on the first
// data message and swaps in fresh data via its onFresh callback.
ctx.onmessage = async (e: MessageEvent<string | DatasetRequest>) => {
  const request =
    typeof e.data === 'string' ? { url: e.data, cacheKey: CACHE_KEY } : e.data;
  const url = request.url;
  try {
    const cacheKey = request.cacheKey ?? null;
    const cached = await readCachedDataset(cacheKey);
    if (cached) {
      ctx.postMessage({ type: 'cached', data: cached.data });
    }
    const headers = new Headers(request.headers ?? {});
    if (cached?.etag) headers.set('If-None-Match', cached.etag);
    const resp = await fetch(url, { credentials: 'same-origin', headers });
    if (resp.status === 304 && cached) {
      ctx.postMessage({ type: 'unchanged' });
      return;
    }
    if (!resp.ok) {
      ctx.postMessage({ type: 'error', error: `dataset fetch failed: ${resp.status}` });
      return;
    }
    const data = await resp.json();
    const etag = resp.headers.get('etag');
    if (etag) {
      await writeCachedDataset(cacheKey, { etag, data });
    }
    ctx.postMessage({ type: 'fresh', data });
  } catch (err) {
    ctx.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
