// Instant-load boot-first fetcher (#2443, epic #1852) — a LAZY, server-only chunk.
//
// App dynamic-imports this ONLY inside `if (SERVER_AVAILABLE)`, so:
//   - it is DCE'd out of the sample build (its `/api/` literals never reach the
//     public sample bundle — sample-boundary stays clean), and
//   - it stays OUT of the eager server shell (the frozen first-paint bundle cap,
//     ADR 0016); as a dynamic import it rides its own lazy-route budget.
//
// It makes raw network calls, so it is a registered NETWORK_OWNER
// (scripts/check-inbound-boundary.mjs) — the ONE exception to the api-client
// chokepoint, justified because the code must be a standalone lazy chunk and the
// chunk is physically absent from the sample bundle.

import {
  getEnterpriseAuthToken,
} from '@api-client';
import {
  fetchDatasetForIdentity,
  persistCachedDataset,
  readCachedDataset,
  resolveDatasetCacheKey,
} from './dataset-cache-client';
import { mergeDataset } from './dataset-boot';
import { isSliceKey } from './dataset-boot';
import type {
  DatasetBoot,
  DatasetShellCounts,
  DatasetSlicePatch,
  HeavySliceKey,
} from './dataset-boot';

/** One heavy per-view slice, keyed, with the dataset version that produced it. */
export interface DatasetSliceResult {
  key: string;
  value: unknown;
  version: string | null;
}

/** Optional knobs for {@link loadServerDataset}. */
export interface LoadServerDatasetOptions {
  /**
   * #2449: `true` when the app already shows a loaded dataset (e.g. a manual
   * Reload while data is on screen). When set, we keep that data visible instead
   * of flashing the empty boot shell, and — crucially — if the whole load path
   * fails (boot/slice AND the monolith fallback), the last-good data survives
   * rather than being replaced by an empty shell. The caller sources this from a
   * React ref, read at the call site (an effect/handler) — never during render.
   */
  hasExistingData?: boolean;
  /** Apply one validated client-owned slice without replaying the full App fan-out. */
  applySlice?: (patch: DatasetSlicePatch) => void;
}

// Same credentials + enterprise-auth header the api-client `serverFetch` applies.
function authHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function authFetch(url: string, token: string | null): Promise<Response> {
  return fetch(url, { credentials: 'same-origin', headers: authHeaders(token) });
}

const sliceUrl = (key: string) => `/api/dataset/slice/${encodeURIComponent(key)}`;

async function fetchBoot(token: string | null): Promise<DatasetBoot> {
  const res = await authFetch('/api/dataset/boot', token);
  if (!res.ok) throw new Error(`dataset boot failed: ${res.status}`);
  return (await res.json()) as DatasetBoot;
}

// Main-thread slice fetch+decode. Used as the fallback when no web Worker exists
// (unit tests run under node/jsdom; ancient browsers) or the worker errors — and
// it is the path the unit tests exercise, so the orchestration (skew, fallback,
// preserve-data) is covered without a real worker.
async function fetchSliceOnMainThread(
  key: string,
  token: string | null,
): Promise<DatasetSliceResult> {
  const res = await authFetch(sliceUrl(key), token);
  if (!res.ok) throw new Error(`dataset slice '${key}' failed: ${res.status}`);
  return {
    key,
    value: (await res.json()) as unknown,
    version: res.headers.get('X-Dataset-Version'),
  };
}

interface SliceWorkerMessage {
  type?: 'slice' | 'slice-error' | 'done';
  key?: string;
  value?: unknown;
  version?: string | null;
  error?: string;
}

interface DatasetSliceRequest {
  key: string;
  url: string;
}

// A worker INFRASTRUCTURE failure (couldn't construct the worker, or it crashed
// at runtime) — distinct from a genuine per-slice fetch/parse error. Only the
// former warrants a main-thread retry; a slice error would just re-fail there, so
// it propagates straight to the monolith fallback instead of re-downloading every
// slice on the main thread first (#2448 review).
class SliceWorkerCrashError extends Error {}

// #2448: decode the heavy slices OFF the UI thread. The worker fetches+parses
// each slice and posts it back as it lands; `onResult` publishes each validated
// message immediately, while the batch promise resolves only once `done`
// arrives. Reject with the first slice error, or with SliceWorkerCrashError if
// the worker itself couldn't run.
function decodeSlicesViaWorker(
  requests: DatasetSliceRequest[],
  headers: Record<string, string>,
  onResult: (result: DatasetSliceResult) => void,
): Promise<DatasetSliceResult[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./dataset-slice-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (err) {
      reject(new SliceWorkerCrashError(err instanceof Error ? err.message : 'slice worker unavailable'));
      return;
    }
    const results: DatasetSliceResult[] = [];
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(error);
    };
    worker.onmessage = (e: MessageEvent<SliceWorkerMessage>) => {
      if (settled) return;
      const msg = e.data;
      if (msg.type === 'slice') {
        const result = {
          key: msg.key ?? '',
          value: msg.value,
          version: msg.version ?? null,
        };
        results.push(result);
        try {
          onResult(result);
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (msg.type === 'slice-error') {
        // The worker starts all slice requests concurrently. Stop it on the
        // first genuine slice failure so the monolith fallback does not wait for
        // unrelated heavy downloads/parses to finish.
        rejectOnce(new Error(msg.error ?? `slice '${msg.key}' failed`));
      } else if (msg.type === 'done') {
        // Every slice has been fetched+parsed (or errored). Ignore any other
        // message type rather than treating it as done (defensive — no premature
        // resolve with a partial result set on a future protocol drift).
        settled = true;
        worker.terminate();
        resolve(results);
      }
    };
    worker.onerror = (e) => {
      rejectOnce(new SliceWorkerCrashError(e.message || 'slice worker crashed'));
    };
    worker.postMessage({ slices: requests, headers });
  });
}

// Fetch+decode every heavy slice. Prefers the off-thread worker (#2448); only a
// worker-INFRA crash (couldn't construct / runtime crash) retries on the main
// thread. A genuine slice error propagates so loadServerDataset falls straight to
// the monolith, rather than re-downloading every slice here first (#2448 review).
async function fetchSlices(
  sliceKeys: string[],
  token: string | null,
  onResult: (result: DatasetSliceResult) => void,
): Promise<DatasetSliceResult[]> {
  if (sliceKeys.length === 0) return [];
  const requests: DatasetSliceRequest[] = sliceKeys.map((key) => ({
    key,
    url: sliceUrl(key),
  }));
  if (typeof Worker !== 'undefined') {
    try {
      return await decodeSlicesViaWorker(requests, authHeaders(token), onResult);
    } catch (err) {
      if (!(err instanceof SliceWorkerCrashError)) throw err;
      // Worker infra failed — fall through to the main thread.
    }
  }
  let acceptingResults = true;
  try {
    return await Promise.all(
      requests.map(async (request) => {
        const result = await fetchSliceOnMainThread(request.key, token);
        if (acceptingResults) onResult(result);
        return result;
      })
    );
  } finally {
    // Promise.all rejects on the first failed slice, but sibling fetches keep
    // running. Their late completions must not publish over monolith fallback.
    acceptingResults = false;
  }
}

/** The masthead's headline counts, straight from the boot payload (#2450). */
function shellCountsFromBoot(boot: DatasetBoot): DatasetShellCounts {
  return {
    sessions: boot.aggregates?.sessions ?? 0,
    entries: boot.aggregates?.events ?? 0,
    tokenData: boot.counts?.tokenData ?? 0,
  };
}

/**
 * Instant-load progressive fetch. Paints the landing shell from the tiny boot
 * payload FIRST (via `onPartial`, which also receives the real headline counts
 * so the masthead never shows a transient `0` — #2450), then backfills every
 * heavy slice (off the UI thread — #2448), publishes each client-owned slice
 * through its one-key state seam as it arrives, and resolves with the full
 * dataset — so first paint waits on ~59 KB (boot), not the ~15 MB monolith.
 * Returns `null` if the corpus changed mid-load (boot and a slice carry different
 * `X-Dataset-Version`), signalling the caller to take the atomic
 * `/api/dataset.json` instead so a render never mixes snapshots.
 */
async function fetchDatasetProgressive(
  onPartial: (data: unknown, counts: DatasetShellCounts) => void,
  onSlice: (patch: DatasetSlicePatch) => void,
  token: string | null,
): Promise<unknown | null> {
  const boot = await fetchBoot(token);
  const meta = boot.meta ?? {};
  // Instant shell: the full Dataset shape with heavy slices still empty, plus the
  // real session/entry/token counts so the masthead shows true numbers now.
  onPartial(mergeDataset(meta, {}), shellCountsFromBoot(boot));
  const requestedKeys = boot.sliceKeys ?? [];
  const requested = new Set<HeavySliceKey>();
  for (const key of requestedKeys) {
    if (!isSliceKey(key) || requested.has(key)) {
      throw new Error(`invalid or duplicate dataset slice key '${key}'`);
    }
    requested.add(key);
  }

  const slices: Record<string, unknown> = {};
  const delivered = new Set<HeavySliceKey>();
  let acceptingSlices = true;
  let skew = false;
  try {
    await fetchSlices(requestedKeys, token, (result) => {
      if (!acceptingSlices) return;
      if (!isSliceKey(result.key) || !requested.has(result.key)) {
        throw new Error(`unexpected dataset slice key '${result.key}'`);
      }
      // Worker-infrastructure fallback can refetch an already-delivered key.
      // Retain the first validated result and never double-apply it.
      if (delivered.has(result.key)) return;
      if (boot.version && result.version && result.version !== boot.version) {
        skew = true;
        acceptingSlices = false;
        return;
      }
      delivered.add(result.key);
      slices[result.key] = result.value;
      if (result.key !== 'workflows') {
        onSlice({ key: result.key, value: result.value });
      }
    });
  } finally {
    acceptingSlices = false;
  }
  if (skew) return null;
  if (delivered.size !== requested.size) {
    throw new Error('dataset slice batch completed without every requested slice');
  }
  return mergeDataset(meta, slices);
}

// Explicit version skew proves the cached atomic snapshot stale. Clear it before
// falling back to the monolith; successful boot/slice hydration instead persists
// its assembled full dataset through dataset-cache-client, while transient slice
// failures retain the last-good snapshot. A no-op only where IndexedDB is absent.
const DATASET_CACHE_DB = 'claude-history-dashboard-dataset';
const DATASET_CACHE_STORE = 'dataset';
// MUST match dataset-worker.ts's `indexedDB.open(DB_NAME, 1)` + store name: opening
// at the SAME version with the SAME store creation means an open that had to create
// the db leaves it in the shape the worker expects — never a versionless empty db
// that would block the worker's own `createObjectStore` (the race the old open
// avoided by refusing to open at all).
const DATASET_CACHE_VERSION = 1;
async function invalidateMonolithCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  // Fast path where supported (Chromium): skip entirely if the db was never
  // created. Where `databases()` is unavailable (Firefox, older Safari) we fall
  // through and open directly — the worker can still have written the cache there,
  // so gating the WHOLE thing on `databases()` (as the first cut did) wrongly
  // no-op'd it and left a stale snapshot to paint on a later fallback (#2450 review).
  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === DATASET_CACHE_DB)) return; // never created — nothing to clear
    } catch {
      // fall through and open directly
    }
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.open(DATASET_CACHE_DB, DATASET_CACHE_VERSION);
    req.onupgradeneeded = () => {
      // Fires only when the db was absent (we're creating it). Create the store
      // exactly as the worker does so we never leave a shape the worker can't use.
      const db = req.result;
      if (!db.objectStoreNames.contains(DATASET_CACHE_STORE)) {
        db.createObjectStore(DATASET_CACHE_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DATASET_CACHE_STORE)) {
        db.close();
        resolve();
        return;
      }
      try {
        const tx = db.transaction(DATASET_CACHE_STORE, 'readwrite');
        tx.objectStore(DATASET_CACHE_STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      } catch {
        db.close();
        resolve();
      }
    };
    req.onerror = () => resolve();
  });
}

/**
 * Drive the whole live-server dataset load: flip the busy flag, paint the shell
 * from boot, backfill slices, and on any boot/slice failure OR a mid-load corpus
 * change fall back to the atomic `/api/dataset.json`. Kept HERE (a lazy chunk),
 * not in App, so the eager server shell doesn't carry it (ADR 0016 bundle cap).
 *
 * `apply` is the app's idempotent applyDataset. `setShellCounts` sets/clears the
 * boot headline counts the masthead shows while the shell is up (#2450) — set on
 * the shell paint, ALWAYS cleared in `finally` so a shell we painted never leaves
 * stale counts over empty views when both fetch paths fail. `setBusy` toggles the
 * load spinner. `opts.hasExistingData` (#2449) keeps already-loaded data on screen
 * through a reload — the empty shell is skipped and the last-good data survives a
 * total failure.
 */
export async function loadServerDataset(
  apply: (data: unknown) => void,
  setBusy: (busy: boolean) => void,
  setShellCounts: (counts: DatasetShellCounts | null) => void,
  opts: LoadServerDatasetOptions = {}
): Promise<void> {
  let visibleData = opts.hasExistingData ?? false;
  let suppressCachePaint = false;
  let coldShell: unknown | null = null;
  let progressivePatchApplied = false;
  setBusy(true);
  const token = getEnterpriseAuthToken();
  const cacheKey = await resolveDatasetCacheKey(token);
  // Restore the pre-split instant repeat paint without starting the monolith
  // network request: a cache-only worker read races boot/slices. A late cache
  // result never overwrites a completed progressive load.
  const cacheRead = visibleData ? null : readCachedDataset(cacheKey);
  const cachePaint = cacheRead?.promise
    .then((cached) => {
      if (cached === null || suppressCachePaint) return;
      visibleData = true;
      apply(cached);
      setShellCounts(null);
    })
    .catch(() => {});
  try {
    const full = await fetchDatasetProgressive(
      (partial, counts) => {
        // #2449: on a reload with data already loaded, don't wipe the screen to the
        // empty boot shell — keep the existing data visible and just swap in the
        // full dataset when it lands (and keep the old data if everything fails).
        if (visibleData) return;
        coldShell = partial;
        apply(partial);
        setShellCounts(counts); // #2450: real counts stand in for the empty arrays
        // The interaction lock (busy) is deliberately NOT cleared here — it stays up
        // through slice backfill so Upload/Reload remain disabled until the full
        // dataset lands. Clearing it on the shell paint let a concurrent upload/reload
        // start mid-backfill and then be overwritten when this load's apply(full)
        // resolved (#2446 review). The shell is already painted (content + real
        // counts visible), so holding the lock only keeps the spinner spinning.
      },
      (patch) => {
        // A reload or a last-good cache paint stays atomic: never mix a fresh
        // partial slice into data from a different completed snapshot.
        if (!visibleData && opts.applySlice) {
          opts.applySlice(patch);
          progressivePatchApplied = true;
        }
      },
      token
    );
    if (full) {
      suppressCachePaint = true;
      cacheRead?.cancel();
      apply(full);
      // Keep the fallback snapshot coherent with the fresh slices. This cache
      // entry deliberately has no monolith ETag, so fetchDataset paints it then
      // performs a full revalidation the next time fallback is needed.
      try {
        await persistCachedDataset(cacheKey, full);
      } catch {
        // Cache/quota/private-mode failures do not invalidate the live dataset.
      }
      return;
    }
    // Version skew proves the cache stale. Suppress the already-started
    // cache-only read before invalidation so its structured-clone reply cannot
    // race back in and overwrite the atomic fallback.
    suppressCachePaint = true;
    cacheRead?.cancel();
    // Version skew — the corpus changed mid-load, so the cached monolith is stale.
    // Invalidate it BEFORE the fetch (awaited) so the SWR fallback paints fresh,
    // not the old snapshot on the exact path where the snapshot changed (#2448 review).
    await invalidateMonolithCache();
    apply(await fetchDatasetForIdentity(token, cacheKey, (fresh) => apply(fresh)));
  } catch {
    // A delayed cache-only read remains valid on failure and continues in the
    // background, but never blocks the monolith fallback.
    // Boot/slice path threw — fall back to the monolith before giving up.
    try {
      // A transient slice failure does not prove the cached atomic snapshot is
      // stale. Let fetchDataset paint/revalidate that last-good fallback; only
      // the explicit version-skew branch above invalidates it.
      const fallback = await fetchDatasetForIdentity(
        token,
        cacheKey,
        (fresh) => apply(fresh),
      );
      suppressCachePaint = true;
      cacheRead?.cancel();
      apply(fallback);
    } catch {
      // Backend unreachable and no monolith: leave whatever is on screen — the
      // last-good data when hasExistingData (#2449), the manual-upload path
      // otherwise.
      if (cachePaint) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          cachePaint,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
      }
      cacheRead?.cancel();
      // A cold load may already have published fast slices before a slow sibling
      // and the monolith both failed. With no cache/last-good dataset to replace
      // them, restore the captured boot shell so the unlocked UI never presents
      // a subset as a completed load. A cache paint flips visibleData and wins.
      if (!visibleData && progressivePatchApplied && coldShell !== null) {
        apply(coldShell);
      }
    }
  } finally {
    // Drop the boot stand-in on every exit: a successful full/monolith apply has
    // put the real arrays in place, and on total failure this clears counts that
    // would otherwise sit stale over empty views (#2450 review). Batched with the
    // preceding applies (React auto-batches post-await), so no intermediate render.
    setShellCounts(null);
    setBusy(false);
  }
}
