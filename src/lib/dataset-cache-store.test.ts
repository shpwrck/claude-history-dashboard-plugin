import { describe, expect, it } from 'vitest';
import {
  readCachedDatasetStore,
  writeCachedDatasetStore,
} from './dataset-cache-store';

function fakeIndexedDb(autoCommit = true) {
  const values = new Map<IDBValidKey, unknown>();
  let commit: (() => void) | undefined;
  const db = {
    close() {},
    transaction() {
      const tx: Record<string, unknown> = {
        error: null,
        objectStore: () => ({
          get(key: IDBValidKey) {
            const request: Record<string, unknown> = { result: values.get(key) };
            queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
            return request;
          },
          put(value: unknown, key: IDBValidKey) {
            values.set(key, value);
            commit = () => (tx.oncomplete as (() => void) | undefined)?.();
            if (autoCommit) queueMicrotask(() => commit?.());
            return {};
          },
        }),
      };
      return tx;
    },
  };
  const factory = {
    open() {
      const request: Record<string, unknown> = { result: db };
      queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, values, commit: () => commit?.() };
}

describe('dataset cache store', () => {
  it('round-trips a progressive snapshot and remains compatible with ETag entries', async () => {
    const fake = fakeIndexedDb();
    const progressive = { entries: [{ sessionId: 'fresh' }] };
    await writeCachedDatasetStore('live', { data: progressive }, fake.factory);
    await expect(readCachedDatasetStore('live', fake.factory)).resolves.toEqual({
      data: progressive,
    });

    await writeCachedDatasetStore('live', { etag: '"legacy"', data: { entries: [] } }, fake.factory);
    await expect(readCachedDatasetStore('live', fake.factory)).resolves.toEqual({
      etag: '"legacy"',
      data: { entries: [] },
    });
  });

  it('does not acknowledge a write before the transaction commits', async () => {
    const fake = fakeIndexedDb(false);
    let resolved = false;
    const writing = writeCachedDatasetStore('live', { data: { entries: [] } }, fake.factory)
      .then(() => { resolved = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    fake.commit();
    await writing;
    expect(resolved).toBe(true);
  });
});
