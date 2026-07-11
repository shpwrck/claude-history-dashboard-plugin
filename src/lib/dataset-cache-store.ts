export interface CachedDataset {
  etag?: string;
  data: unknown;
}

const DB_NAME = 'claude-history-dashboard-dataset';
const STORE_NAME = 'dataset';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openCacheDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

export async function readCachedDatasetStore(
  cacheKey: string | null,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<CachedDataset | null> {
  if (!cacheKey || !factory) return null;
  let db: IDBDatabase | null = null;
  try {
    db = await openCacheDb(factory);
    const tx = db.transaction(STORE_NAME, 'readonly');
    const cached = await requestToPromise<CachedDataset | undefined>(
      tx.objectStore(STORE_NAME).get(cacheKey),
    );
    return cached && 'data' in cached ? cached : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function writeCachedDatasetStore(
  cacheKey: string | null,
  cached: CachedDataset,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!cacheKey || !factory) return;
  let db: IDBDatabase | null = null;
  try {
    db = await openCacheDb(factory);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(cached, cacheKey);
    // A successful put request is not a committed transaction. Wait for the
    // commit before the worker acknowledges and may be terminated by its client.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } catch {
    // Quota/private-mode failures disable the fast path but never live loading.
  } finally {
    db?.close();
  }
}
