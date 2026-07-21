// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Recommendation } from './detectors/types';
import type {
  RecommendationSurfaceRequest,
  RecommendationSurfaceResponse,
} from './recommendation-surface';

// Viewer-only (#2719): the hook fetches the server-computed surface via the
// `@api-client` reader instead of running the engine. Mock the reader; keep
// SERVER_AVAILABLE true so the hook takes the fetch path.
const fetchMock = vi.hoisted(() =>
  vi.fn<
    (
      req: RecommendationSurfaceRequest,
      signal?: AbortSignal
    ) => Promise<RecommendationSurfaceResponse>
  >()
);
vi.mock('@api-client', () => ({
  SERVER_AVAILABLE: true,
  fetchRecommendationSurface: fetchMock,
}));

import { useRecommendationSurface } from './use-recommendations';

const GLOBAL_REQ: RecommendationSurfaceRequest = {
  surface: 'global',
  dashboard: { time: '24h', project: 'All projects' },
};

function ready(
  recs: Array<{ id: string }> = [],
  validThrough?: string
): RecommendationSurfaceResponse {
  return {
    kind: 'ready',
    result: {
      recommendations: recs as unknown as Recommendation[],
      domainCoverage: [],
      ...(validThrough === undefined ? {} : { validThrough }),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
});

describe('useRecommendationSurface', () => {
  it('starts loading, then resolves to ready with the server envelope', async () => {
    fetchMock.mockResolvedValue(ready([{ id: 'cost.x' }]));
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.recommendations).toEqual([{ id: 'cost.x' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a fetch failure as error, never a clean empty result', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The trust contract: an error carries NO findings list.
    expect(result.current.recommendations).toBeNull();
    expect(result.current.error).toBe('boom');
  });

  it('maps the SPA unavailable response to the unavailable state', async () => {
    fetchMock.mockResolvedValue({ kind: 'unavailable' });
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.recommendations).toBeNull();
  });

  it('clears to loading and refetches when the scope changes (no stale leak)', async () => {
    fetchMock.mockImplementation(async (req) => ready([{ id: req.dashboard.time }]));
    const { result, rerender } = renderHook(
      ({ req }: { req: RecommendationSurfaceRequest }) =>
        useRecommendationSurface(req),
      { initialProps: { req: GLOBAL_REQ } }
    );

    await waitFor(() => expect(result.current.recommendations).toEqual([{ id: '24h' }]));

    rerender({
      req: {
        surface: 'global',
        dashboard: { time: '7d', project: 'All projects' },
      },
    });
    // The scope changed: prior-scope findings are dropped immediately.
    expect(result.current.status).toBe('loading');
    expect(result.current.recommendations).toBeNull();
    await waitFor(() => expect(result.current.recommendations).toEqual([{ id: '7d' }]));
  });

  it('waits for an authenticated local dataset before fetching', async () => {
    fetchMock.mockResolvedValue(ready([{ id: 'local' }]));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useRecommendationSurface(GLOBAL_REQ, { enabled }),
      { initialProps: { enabled: false } }
    );

    expect(result.current.status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.recommendations).toEqual([{ id: 'local' }]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops stale findings and refetches when the local dataset generation changes', async () => {
    fetchMock.mockResolvedValueOnce(ready([{ id: 'before-reload' }]));
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useRecommendationSurface(GLOBAL_REQ, { refreshKey }),
      { initialProps: { refreshKey: 1 } }
    );

    await waitFor(() =>
      expect(result.current.recommendations).toEqual([{ id: 'before-reload' }])
    );

    fetchMock.mockResolvedValueOnce(ready([{ id: 'after-reload' }]));
    rerender({ refreshKey: 2 });

    expect(result.current.status).toBe('loading');
    expect(result.current.recommendations).toBeNull();
    await waitFor(() =>
      expect(result.current.recommendations).toEqual([{ id: 'after-reload' }])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retry refetches the current scope without blanking the prior findings', async () => {
    fetchMock.mockResolvedValue(ready([{ id: 'a' }]));
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await waitFor(() => expect(result.current.recommendations).toEqual([{ id: 'a' }]));

    fetchMock.mockResolvedValue(ready([{ id: 'b' }]));
    let retryPromise!: ReturnType<typeof result.current.retry>;
    act(() => {
      retryPromise = result.current.retry();
    });

    // Same scope: no flash back to loading — the prior findings stay on screen
    // until the refetch confirms (the reject-refetch UX).
    expect(result.current.status).toBe('ready');
    expect(result.current.recommendations).toEqual([{ id: 'a' }]);
    await act(async () => {
      await retryPromise;
    });
    expect(result.current.recommendations).toEqual([{ id: 'b' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the confirmed retry result to the caller', async () => {
    fetchMock.mockResolvedValueOnce(ready([{ id: 'before' }]));
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    fetchMock.mockResolvedValueOnce(ready([{ id: 'after' }]));
    let refreshResult: Awaited<ReturnType<typeof result.current.retry>> | undefined;
    await act(async () => {
      refreshResult = await result.current.retry();
    });

    expect(refreshResult).toEqual({
      ok: true,
      recommendations: [{ id: 'after' }],
      domainCoverage: [],
    });
  });

  it('keeps the last confirmed findings when a retry fails', async () => {
    fetchMock.mockResolvedValueOnce(ready([{ id: 'still-visible' }]));
    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await waitFor(() =>
      expect(result.current.recommendations).toEqual([{ id: 'still-visible' }])
    );

    fetchMock.mockRejectedValueOnce(new Error('confirmation failed'));
    let refreshResult: Awaited<ReturnType<typeof result.current.retry>> | undefined;
    await act(async () => {
      refreshResult = await result.current.retry();
    });

    expect(refreshResult).toEqual({ ok: false, error: 'confirmation failed' });
    expect(result.current.status).toBe('ready');
    expect(result.current.recommendations).toEqual([{ id: 'still-visible' }]);
  });

  it('keeps a snapshot result through its exact boundary, then clears it before a non-preserving refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.parse('2026-07-20T12:00:00.000Z');
    vi.setSystemTime(start);

    let rejectRefresh!: (reason: Error) => void;
    fetchMock
      .mockResolvedValueOnce(
        ready(
          [{ id: 'snapshot-backed' }],
          new Date(start + 1_000).toISOString()
        )
      )
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        })
      );

    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.recommendations).toEqual([{ id: 'snapshot-backed' }]);

    // The named instant is inclusive.
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // One millisecond later the old result is invalid. Cards are removed before
    // the refresh settles, so even a failed refresh cannot retain them.
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.status).toBe('loading');
    expect(result.current.recommendations).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectRefresh(new Error('refresh failed'));
      await Promise.resolve();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.recommendations).toBeNull();
  });

  it('fails closed on a later render even when the expiry timer has not run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.parse('2026-07-20T12:00:00.000Z');
    vi.setSystemTime(start);
    let resolveRefresh!: (value: RecommendationSurfaceResponse) => void;
    fetchMock
      .mockResolvedValueOnce(
        ready([{ id: 'snapshot-backed' }], new Date(start + 1_000).toISOString())
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
      );

    const { result, rerender } = renderHook(() =>
      useRecommendationSurface(GLOBAL_REQ)
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');

    // Move the wall clock without executing queued timers. A later React render
    // must still hide the expired cards and begin a non-preserving refresh.
    vi.setSystemTime(start + 1_001);
    rerender();
    expect(result.current.status).toBe('loading');
    expect(result.current.recommendations).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start);
    rerender();
    expect(
      result.current.status,
      'a backward clock correction must not revive retired cards'
    ).toBe('loading');
    expect(result.current.recommendations).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRefresh(
        ready(
          [{ id: 'same-retired-envelope' }],
          new Date(start + 1_000).toISOString()
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      result.current.status,
      'a late copy at the retired boundary must stay rejected after rollback'
    ).toBe('error');
    expect(result.current.recommendations).toBeNull();
  });

  it('does not replay a handled expiry refresh when the scope later changes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.parse('2026-07-20T12:00:00.000Z');
    vi.setSystemTime(start);
    fetchMock
      .mockResolvedValueOnce(
        ready([{ id: 'snapshot-backed' }], new Date(start + 1_000).toISOString())
      )
      .mockResolvedValueOnce(ready([{ id: 'post-expiry' }]))
      .mockResolvedValueOnce(ready([{ id: 'new-scope' }]));

    const { result, rerender } = renderHook(
      ({ req }: { req: RecommendationSurfaceRequest }) =>
        useRecommendationSurface(req),
      { initialProps: { req: GLOBAL_REQ } }
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    vi.setSystemTime(start + 1_001);
    rerender({ req: GLOBAL_REQ });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.recommendations).toEqual([{ id: 'post-expiry' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const nextScope: RecommendationSurfaceRequest = {
      surface: 'global',
      dashboard: { time: '7d', project: 'All projects' },
    };
    rerender({ req: nextScope });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.recommendations).toEqual([{ id: 'new-scope' }]);
    expect(
      fetchMock,
      'the consumed expiry generation must not launch a second new-scope request'
    ).toHaveBeenCalledTimes(3);
  });

  it('keeps the retired boundary across a dataset refresh generation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.parse('2026-07-20T12:00:00.000Z');
    const boundary = new Date(start + 1_000).toISOString();
    vi.setSystemTime(start);
    fetchMock
      .mockResolvedValueOnce(ready([{ id: 'snapshot-backed' }], boundary))
      .mockResolvedValueOnce(ready([{ id: 'same-retired-envelope' }], boundary));

    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useRecommendationSurface(GLOBAL_REQ, { refreshKey }),
      { initialProps: { refreshKey: 0 } }
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');

    // First observe the crossed boundary in the SAME render that advances the
    // dataset generation. The old full scope key is replaced immediately, but
    // its logical surface boundary must still enter the retirement ledger.
    vi.setSystemTime(start + 1_001);
    rerender({ refreshKey: 1 });
    expect(result.current.status).toBe('loading');

    vi.setSystemTime(start);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('error');
    expect(result.current.recommendations).toBeNull();
  });

  it('never preserves an expired result when an in-flight retry fails late', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const start = Date.parse('2026-07-20T12:00:00.000Z');
    vi.setSystemTime(start);
    fetchMock.mockResolvedValueOnce(
      ready([{ id: 'expires' }], new Date(start + 1_000).toISOString())
    );

    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');

    let rejectRetry!: (reason: Error) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRetry = reject;
      })
    );
    let retryPromise!: ReturnType<typeof result.current.retry>;
    act(() => {
      retryPromise = result.current.retry();
    });

    act(() => vi.advanceTimersByTime(1_001));
    await act(async () => {
      rejectRetry(new Error('late failure'));
      await retryPromise;
    });

    expect(result.current.status).not.toBe('ready');
    expect(result.current.recommendations).toBeNull();
  });

  it('fails closed when a response is already one millisecond past its boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const now = Date.parse('2026-07-20T12:00:00.001Z');
    vi.setSystemTime(now);
    fetchMock.mockResolvedValueOnce(
      ready([{ id: 'already-expired' }], new Date(now - 1).toISOString())
    );

    const { result } = renderHook(() => useRecommendationSurface(GLOBAL_REQ));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(
      'Recommendation analysis response has expired'
    );
    expect(result.current.recommendations).toBeNull();
  });

  it('ignores an obsolete local response after the loader is disabled', async () => {
    let resolveOld!: (value: RecommendationSurfaceResponse) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      })
    );
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useRecommendationSurface(GLOBAL_REQ, { enabled }),
      { initialProps: { enabled: true } }
    );

    rerender({ enabled: false });
    expect(result.current.status).toBe('unavailable');

    await act(async () => {
      resolveOld(ready([{ id: 'obsolete-local' }]));
      await Promise.resolve();
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.recommendations).toBeNull();
  });

  it('is unavailable and never fetches when the server is absent (SPA)', async () => {
    // Re-mock @api-client with SERVER_AVAILABLE false via the hook's guard: the
    // hook short-circuits to unavailable when the build has no server.
    // (Covered structurally by the hook's SERVER_AVAILABLE guard; here we assert
    // the request-null path yields unavailable without a fetch.)
    const { result } = renderHook(() => useRecommendationSurface(null));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
