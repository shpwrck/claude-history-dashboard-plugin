import { datasetCacheKey } from '@api-client';

export interface CacheOperation<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function runDatasetCacheOperation(
  operation: 'read' | 'write',
  cacheKey: string | null,
  data?: unknown,
): CacheOperation<unknown | null> {
  let worker: Worker | null = null;
  const promise = new Promise<unknown | null>((resolve, reject) => {
    worker = new Worker(new URL('./dataset-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ type?: string; data?: unknown; error?: string }>) => {
      worker?.terminate();
      worker = null;
      if (event.data.type === 'cached') resolve(event.data.data);
      else if (event.data.type === 'empty' || event.data.type === 'written') resolve(null);
      else reject(new Error(event.data.error ?? 'dataset cache worker failed'));
    };
    worker.onerror = (event) => {
      worker?.terminate();
      worker = null;
      reject(event.error instanceof Error ? event.error : new Error('dataset cache worker failed'));
    };
    worker.postMessage({ operation, cacheKey, data });
  });
  return {
    promise,
    cancel: () => {
      worker?.terminate();
      worker = null;
    },
  };
}

/** Capture once per load so auth changes cannot redirect the eventual write. */
export function resolveDatasetCacheKey(token: string | null): Promise<string | null> {
  return datasetCacheKey(token);
}

/** Read the parsed last-good dataset without starting a network revalidation. */
export function readCachedDataset(cacheKey: string | null): CacheOperation<unknown | null> {
  return runDatasetCacheOperation('read', cacheKey);
}

/** Replace the parsed fallback snapshot after successful boot/slice hydration. */
export async function persistCachedDataset(cacheKey: string | null, data: unknown): Promise<void> {
  await runDatasetCacheOperation('write', cacheKey, data).promise;
}

/** Monolith SWR fallback bound to the same immutable auth/cache identity. */
export function fetchDatasetForIdentity(
  token: string | null,
  cacheKey: string | null,
  onFresh?: (data: unknown) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dataset-worker.ts', import.meta.url), { type: 'module' });
    let resolved = false;
    worker.onmessage = (event: MessageEvent<{ type?: string; data?: unknown; error?: string }>) => {
      const message = event.data;
      if (message.type === 'cached') {
        if (!resolved) { resolved = true; resolve(message.data); }
      } else if (message.type === 'fresh') {
        if (!resolved) { resolved = true; resolve(message.data); }
        else onFresh?.(message.data);
        worker.terminate();
      } else if (message.type === 'unchanged') {
        worker.terminate();
      } else {
        worker.terminate();
        if (!resolved) reject(new Error(message.error ?? 'dataset worker failed'));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      if (!resolved) reject(event.error instanceof Error ? event.error : new Error('dataset worker failed'));
    };
    worker.postMessage({
      operation: 'fetch',
      url: ['', 'api', 'dataset.json'].join('/'),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cacheKey,
    });
  });
}
