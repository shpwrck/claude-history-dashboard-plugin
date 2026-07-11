import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const readCachedDatasetMock = vi.hoisted(() => vi.fn());
const persistCachedDatasetMock = vi.hoisted(() => vi.fn());
const resolveDatasetCacheKeyMock = vi.hoisted(() => vi.fn());
const cacheReadCancelMock = vi.hoisted(() => vi.fn());
const authTokenMock = vi.hoisted(() => vi.fn());
vi.mock('@api-client', () => ({
  getEnterpriseAuthToken: () => authTokenMock(),
}));
vi.mock('./dataset-cache-client', () => ({
  resolveDatasetCacheKey: (token: string | null) => resolveDatasetCacheKeyMock(token),
  readCachedDataset: (cacheKey: string | null) => ({
    promise: readCachedDatasetMock(cacheKey),
    cancel: cacheReadCancelMock,
  }),
  persistCachedDataset: (cacheKey: string | null, data: unknown) =>
    persistCachedDatasetMock(cacheKey, data),
  fetchDatasetForIdentity: (
    token: string | null,
    cacheKey: string | null,
    onFresh?: (data: unknown) => void,
  ) => fetchDatasetMock(token, cacheKey, onFresh),
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
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
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

beforeEach(() => {
  authTokenMock.mockReturnValue(null);
  resolveDatasetCacheKeyMock.mockResolvedValue('cache-a');
  readCachedDatasetMock.mockResolvedValue(null);
  persistCachedDatasetMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchDatasetMock.mockReset();
  readCachedDatasetMock.mockReset();
  persistCachedDatasetMock.mockReset();
  resolveDatasetCacheKeyMock.mockReset();
  cacheReadCancelMock.mockReset();
  authTokenMock.mockReset();
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
    expect(persistCachedDatasetMock).toHaveBeenCalledWith('cache-a', full);
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

  it('paints a cached repeat dataset before a delayed boot response', async () => {
    let resolveBoot: ((response: Response) => void) | undefined;
    const bootResponse = new Promise<Response>((resolve) => { resolveBoot = resolve; });
    installFetch({
      ...okRoutes(),
      '/api/dataset/boot': () => bootResponse,
    });
    const cached = { entries: [{ sessionId: 'cached' }], tokenData: [] };
    readCachedDatasetMock.mockResolvedValue(cached);
    const apply = vi.fn();

    const loading = loadServerDataset(apply, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(cached));
    expect(resolveBoot).toBeDefined();
    resolveBoot?.(jsonRes(BOOT, { version: 'v1' }));
    await loading;

    expect((apply.mock.calls.at(-1)?.[0] as Record<string, unknown>).entries).toEqual([
      { sessionId: 'a' },
    ]);
  });

  it('retains a cached last-good dataset when a slice and monolith both fail', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 500 });
    installFetch(routes);
    const cached = { entries: [{ sessionId: 'cached' }], tokenData: [] };
    readCachedDatasetMock.mockResolvedValue(cached);
    fetchDatasetMock.mockRejectedValue(new Error('monolith unavailable'));
    const apply = vi.fn();

    await loadServerDataset(apply, vi.fn(), vi.fn());

    expect(apply).toHaveBeenCalledWith(cached);
    expect(persistCachedDatasetMock).not.toHaveBeenCalled();
  });

  it('applies a delayed cached dataset after fast slice and monolith failures', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 500 });
    installFetch(routes);
    let resolveCache: ((data: unknown) => void) | undefined;
    readCachedDatasetMock.mockImplementation(() => new Promise((resolve) => {
      resolveCache = resolve;
    }));
    fetchDatasetMock.mockRejectedValue(new Error('monolith unavailable'));
    const cached = { entries: [{ sessionId: 'delayed-cache' }], tokenData: [] };
    const apply = vi.fn();

    const loading = loadServerDataset(apply, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(resolveCache).toBeDefined());
    await vi.waitFor(() => expect(fetchDatasetMock).toHaveBeenCalledTimes(1));
    resolveCache?.(cached);
    await loading;

    expect(apply).toHaveBeenLastCalledWith(cached);
    expect(persistCachedDatasetMock).not.toHaveBeenCalled();
  });

  it('does not let a hung cache read stall successful progressive loading', async () => {
    installFetch(okRoutes());
    readCachedDatasetMock.mockReturnValue(new Promise(() => {}));
    const apply = vi.fn();

    const outcome = await Promise.race([
      loadServerDataset(apply, vi.fn(), vi.fn()).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);

    expect(outcome).toBe('completed');
    expect((apply.mock.calls.at(-1)?.[0] as Record<string, unknown>).entries).toEqual([
      { sessionId: 'a' },
    ]);
    expect(cacheReadCancelMock).toHaveBeenCalledTimes(1);
  });

  it('binds boot, slices, cache read, and persistence to one auth identity', async () => {
    authTokenMock.mockReturnValue('token-a');
    resolveDatasetCacheKeyMock.mockResolvedValue('principal-a');
    let resolveBoot: ((response: Response) => void) | undefined;
    const bootResponse = new Promise<Response>((resolve) => { resolveBoot = resolve; });
    const fetchMock = installFetch({
      ...okRoutes(),
      '/api/dataset/boot': () => bootResponse,
    });

    const loading = loadServerDataset(vi.fn(), vi.fn(), vi.fn());
    await vi.waitFor(() => expect(resolveBoot).toBeDefined());
    authTokenMock.mockReturnValue('token-b');
    resolveBoot?.(jsonRes(BOOT, { version: 'v1' }));
    await loading;

    expect(resolveDatasetCacheKeyMock).toHaveBeenCalledTimes(1);
    expect(resolveDatasetCacheKeyMock).toHaveBeenCalledWith('token-a');
    expect(readCachedDatasetMock).toHaveBeenCalledWith('principal-a');
    expect(persistCachedDatasetMock).toHaveBeenCalledWith(
      'principal-a',
      expect.any(Object),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-a' });
    }
  });

  it('binds monolith fallback to the auth identity captured before loading', async () => {
    authTokenMock.mockReturnValue('token-a');
    resolveDatasetCacheKeyMock.mockResolvedValue('principal-a');
    const routes = okRoutes();
    routes['/api/dataset/boot'] = () => {
      authTokenMock.mockReturnValue('token-b');
      return jsonRes(BOOT, { version: 'v1' });
    };
    routes['/api/dataset/slice/entries'] = () => jsonRes({}, { status: 500 });
    const fetchMock = installFetch(routes);
    fetchDatasetMock.mockResolvedValue({ entries: [], tokenData: [] });

    await loadServerDataset(vi.fn(), vi.fn(), vi.fn());

    expect(fetchDatasetMock).toHaveBeenCalledWith(
      'token-a',
      'principal-a',
      expect.any(Function),
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-a' });
    }
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

  it('suppresses an in-flight stale cache read after version skew', async () => {
    const routes = okRoutes();
    routes['/api/dataset/slice/entries'] = () =>
      jsonRes([{ sessionId: 'slice' }], { version: 'v2' });
    installFetch(routes);
    let resolveCache: ((data: unknown) => void) | undefined;
    readCachedDatasetMock.mockImplementation(() => new Promise((resolve) => {
      resolveCache = resolve;
    }));
    const monolith = { entries: [{ sessionId: 'atomic' }], tokenData: [] };
    fetchDatasetMock.mockResolvedValue(monolith);
    installIndexedDb([]);
    const apply = vi.fn();

    const loading = loadServerDataset(apply, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(fetchDatasetMock).toHaveBeenCalledTimes(1));
    resolveCache?.({ entries: [{ sessionId: 'stale-cache' }], tokenData: [] });
    await loading;

    expect(apply).toHaveBeenLastCalledWith(monolith);
    expect(apply).not.toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ sessionId: 'stale-cache' }] }),
    );
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

  it('preserves the last-good monolith cache before slice-failure fallback', async () => {
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

    expect(events).toEqual(['fetch-monolith']);
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
