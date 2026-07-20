import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRecommendationSurface } from './api-client';

const request = {
  surface: 'global' as const,
  dashboard: { time: '24h' as const, project: 'All projects' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRecommendationSurface', () => {
  it('sends the exact scoped query and forwards cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ recommendations: [], domainCoverage: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      fetchRecommendationSurface(request, controller.signal)
    ).resolves.toEqual({
      kind: 'ready',
      result: { recommendations: [], domainCoverage: [] },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/recommendations.json?surface=global&dashboardTime=24h&dashboardProject=All+projects',
      expect.objectContaining({
        signal: controller.signal,
        credentials: 'same-origin',
      })
    );
  });

  it('rejects a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(fetchRecommendationSurface(request)).rejects.toThrow('HTTP 503');
  });

  it.each([
    {},
    [],
    { recommendations: null, domainCoverage: [] },
    { recommendations: [], domainCoverage: null },
  ])('rejects malformed HTTP-200 JSON instead of returning ready', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    await expect(fetchRecommendationSurface(request)).rejects.toThrow(
      'Invalid recommendation analysis response'
    );
  });
});
