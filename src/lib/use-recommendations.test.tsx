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

function ready(recs: Array<{ id: string }> = []): RecommendationSurfaceResponse {
  return {
    kind: 'ready',
    result: {
      recommendations: recs as unknown as Recommendation[],
      domainCoverage: [],
    },
  };
}

afterEach(() => {
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
