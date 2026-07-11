import { afterEach, describe, expect, it, vi } from 'vitest';

// Unit-tests the boot-first orchestration in loadServerDataset: the #2450 shell
// counts (set on the shell paint, always cleared on exit), #2449 preserve-on-
// failure, and the pre-existing skew/failure→monolith fallbacks. The heavy-slice
// decode is transparently the same whether it runs on the off-thread worker
// (#2448) or the main-thread fallback; under vitest's node env there is no web
// `Worker`, so `fetchSlices` takes the main-thread path and the stubbed global
// `fetch` drives boot + slices. `@api-client.fetchDataset` (the monolith fallback,
// itself worker-backed and untestable here) is mocked so the fallback branches
// are observable.

const fetchDatasetMock = vi.hoisted(() => vi.fn());
vi.mock('@api-client', () => ({
  fetchDataset: (onFresh?: (d: unknown) => void) => fetchDatasetMock(onFresh),
  getEnterpriseAuthToken: () => null,
}));

import { loadServerDataset } from './instant-load';

interface ResOpts {
  status?: number;
  version?: string;
}
function jsonRes(body: unknown, { status = 200, version }: ResOpts = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k === 'X-Dataset-Version' ? version ?? null : null) },
    json: async () => body,
  } as unknown as Response;
}

type Routes = Record<string, () => Response | Promise<Response>>;
function installFetch(routes: Routes) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new TypeError(`unexpected fetch: ${url}`);
    return route();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const BOOT = {
  version: 'v1',
  meta: { liveConfig: null, sources: [] },
  aggregates: {
    sessions: 42,
    events: 100,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    messages: 7,
    models: 2,
  },
  counts: { entries: 100, tokenData: 5 },
  sliceKeys: ['entries', 'tokenData'],
};
const BOOT_COUNTS = { sessions: 42, entries: 100, tokenData: 5 };

const okRoutes = (): Routes => ({
  '/api/dataset/boot': () => jsonRes(BOOT, { version: 'v1' }),
  '/api/dataset/slice/entries': () => jsonRes([{ sessionId: 'a' }], { version: 'v1' }),
  '/api/dataset/slice/tokenData': () => jsonRes([{ model: 'm' }], { version: 'v1' }),
});

/** True if no call to setShellCounts ever carried real (non-null) counts. */
function neverSetRealCounts(setShellCounts: ReturnType<typeof vi.fn>): boolean {
  return setShellCounts.mock.calls.every(([c]) => c === null);
}

function installIndexedDb(events: string[]) {
  const clear = vi.fn(() => events.push('clear-cache'));
  const transaction = {
    objectStore: () => ({ clear }),
    set oncomplete(handler: () => void) { queueMicrotask(handler); },
    set onerror(_handler: () => void) {},
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => transaction,
    close: vi.fn(),
  };
  const indexedDb = {
    databases: vi.fn(async () => [{ name: 'claude-history-dashboard-dataset' }]),
    open: vi.fn(() => {
      const request: { result: typeof db; onsuccess?: () => void } = { result: db };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }),
  };
  vi.stubGlobal('indexedDB', indexedDb);
  return { clear, indexedDb };
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchDatasetMock.mockReset();
});

describe('loadServerDataset', () => {
  it('paints the shell (with real boot counts), then the full dataset (cold load)', async () => {
    installFetch(okRoutes());
    const apply = vi.fn();
    const setBusy = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, setBusy, setShellCounts);

    // #2450: real counts stand in during the shell window, then are cleared.
    expect(setShellCounts).toHaveBeenNthCalledWith(1, BOOT_COUNTS);
    expect(setShellCounts).toHaveBeenLastCalledWith(null);

    // apply: first the shell (empty heavy arrays), then the full dataset.
    const shell = apply.mock.calls[0][0] as Record<string, unknown>;
    expect(shell.entries).toEqual([]);
    const full = apply.mock.calls[apply.mock.calls.length - 1][0] as Record<string, unknown>;
    expect(full.entries).toEqual([{ sessionId: 'a' }]);
    expect(full.tokenData).toEqual([{ model: 'm' }]);

    expect(fetchDatasetMock).not.toHaveBeenCalled();
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenLastCalledWith(false);
  });

  it('handles an empty corpus (no slices): shell counts, then an empty full dataset', async () => {
    installFetch({
      '/api/dataset/boot': () =>
        jsonRes(
          {
            ...BOOT,
            sliceKeys: [],
            counts: {},
            aggregates: { ...BOOT.aggregates, sessions: 0, events: 0 },
          },
          { version: 'v1' }
        ),
    });
    const apply = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, vi.fn(), setShellCounts);

    expect(setShellCounts).toHaveBeenNthCalledWith(1, { sessions: 0, entries: 0, tokenData: 0 });
    expect(fetchDatasetMock).not.toHaveBeenCalled();
  });

  it('keeps the last-good monolith cache after a successful slice load', async () => {
    const events: string[] = [];
    installFetch(okRoutes());
    installIndexedDb(events);

    await loadServerDataset(vi.fn(), vi.fn(), vi.fn());

    // A later boot outage can still paint this snapshot while fetchDataset
    // revalidates it. Skew/slice-failure paths independently clear stale data.
    expect(events).toEqual([]);
  });

  it('falls back to the monolith on a mid-load version skew', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () =>
      jsonRes([{ sessionId: 'a' }], { version: 'v2' }); // corpus changed mid-load
    installFetch(routes);
    const monolith = { entries: [{ sessionId: 'x' }], tokenData: [] };
    fetchDatasetMock.mockResolvedValue(monolith);
    const apply = vi.fn();

    await loadServerDataset(apply, vi.fn(), vi.fn());

    expect(fetchDatasetMock).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(monolith);
  });

  it('falls back to the monolith when boot fails (no shell paint)', async () => {
    const events: string[] = [];
    installFetch({ '/api/dataset/boot': () => jsonRes({}, { status: 500 }) });
    const monolith = { entries: [{ sessionId: 'x' }] };
    fetchDatasetMock.mockImplementation(async () => {
      events.push('fetch-monolith');
      return monolith;
    });
    installIndexedDb(events);
    const apply = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, vi.fn(), setShellCounts);

    expect(fetchDatasetMock).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(monolith);
    expect(events).toEqual(['fetch-monolith']);
    // Boot never resolved → the shell was never painted → no real counts set.
    expect(neverSetRealCounts(setShellCounts)).toBe(true);
  });

  it('falls back to the monolith when a slice fails', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 404 });
    installFetch(routes);
    const monolith = { entries: [{ sessionId: 'x' }] };
    fetchDatasetMock.mockResolvedValue(monolith);
    const apply = vi.fn();

    await loadServerDataset(apply, vi.fn(), vi.fn());

    expect(fetchDatasetMock).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(monolith);
  });

  it('clears a stale monolith cache before slice-failure fallback', async () => {
    const events: string[] = [];
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 404 });
    installFetch(routes);
    fetchDatasetMock.mockImplementation(async () => {
      events.push('fetch-monolith');
      return { entries: [{ sessionId: 'fresh' }] };
    });

    installIndexedDb(events);

    await loadServerDataset(vi.fn(), vi.fn(), vi.fn());

    expect(events).toEqual(['clear-cache', 'fetch-monolith']);
  });

  it('falls back immediately on the first worker slice error', async () => {
    const workers: Array<{ terminate: ReturnType<typeof vi.fn> }> = [];
    class SliceErrorWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: (event: ErrorEvent) => void;
      terminate = vi.fn();
      constructor() { workers.push(this); }
      postMessage() {
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'slice-error', key: 'entries', error: 'slice failed' },
        } as MessageEvent));
      }
    }
    vi.stubGlobal('Worker', SliceErrorWorker);
    installFetch({ '/api/dataset/boot': () => jsonRes(BOOT, { version: 'v1' }) });
    const monolith = { entries: [{ sessionId: 'fallback' }] };
    fetchDatasetMock.mockResolvedValue(monolith);
    const apply = vi.fn();

    const outcome = await Promise.race([
      loadServerDataset(apply, vi.fn(), vi.fn()).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 25)),
    ]);

    expect(outcome).toBe('completed');
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(monolith);
  });

  it('clears the shell counts when a COLD load fails both boot-first AND monolith (#2450 review)', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 500 });
    installFetch(routes);
    fetchDatasetMock.mockRejectedValue(new Error('monolith unreachable'));
    const apply = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, vi.fn(), setShellCounts); // cold (hasExistingData default false)

    // The shell was painted (counts set), but both fetch paths failed — the
    // finally clear drops the stand-in so it never sits stale over empty views.
    expect(setShellCounts).toHaveBeenNthCalledWith(1, BOOT_COUNTS);
    expect(setShellCounts).toHaveBeenLastCalledWith(null);
  });

  it('preserves last-good data when a reload hits boot-first AND monolith failure (#2449)', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 500 });
    installFetch(routes);
    fetchDatasetMock.mockRejectedValue(new Error('monolith unreachable'));
    const apply = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, vi.fn(), setShellCounts, { hasExistingData: true });

    // Shell paint skipped (data already on screen) and both fetch paths failed,
    // so nothing is applied — the on-screen data survives, and no counts stand in.
    expect(apply).not.toHaveBeenCalled();
    expect(neverSetRealCounts(setShellCounts)).toBe(true);
  });

  it('skips the empty shell on a reload that already has data (#2449)', async () => {
    installFetch(okRoutes());
    const apply = vi.fn();
    const setShellCounts = vi.fn();

    await loadServerDataset(apply, vi.fn(), setShellCounts, { hasExistingData: true });

    // Only the full dataset is applied — no empty-shell paint, no stand-in counts.
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0][0] as Record<string, unknown>).entries).toEqual([
      { sessionId: 'a' },
    ]);
    expect(neverSetRealCounts(setShellCounts)).toBe(true);
  });
});
