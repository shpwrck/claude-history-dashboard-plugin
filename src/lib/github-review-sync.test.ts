import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchGitHubReviewEvents,
  gitHubReviewEventsCacheSignature,
  parseGitHubReviewSyncConfig,
  readGitHubReviewEventsCache,
  refreshGitHubReviewEvents,
} from './github-review-sync';

const NOW = Date.parse('2026-06-10T12:00:00Z');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function config(cachePath = '/tmp/review-events-cache.json') {
  return parseGitHubReviewSyncConfig(
    {
      DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
      DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
      DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
      DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
      DASHBOARD_GITHUB_REVIEW_CACHE_TTL_MS: '300000',
    },
    { cachePath }
  );
}

describe('github review sync (#1127)', () => {
  it('defaults and clamps review-sync concurrency and deadline budgets', () => {
    expect(config()).toMatchObject({
      timelineConcurrency: 4,
      syncDeadlineMs: 15_000,
    });

    const minimums = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY: '0',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '0',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    expect(minimums).toMatchObject({
      timelineConcurrency: 1,
      syncDeadlineMs: 100,
    });

    const maximums = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY: '999',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '999999',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    expect(maximums).toMatchObject({
      timelineConcurrency: 16,
      syncDeadlineMs: 300_000,
    });
  });

  it('stays disabled without an explicit github source, token, and repo list', () => {
    expect(
      parseGitHubReviewSyncConfig({}, { cachePath: '/tmp/cache.json' })
    ).toMatchObject({ enabled: false, disabledReason: 'source_not_github' });
    expect(
      parseGitHubReviewSyncConfig(
        { DASHBOARD_REVIEW_EVENTS_SOURCE: 'github' },
        { cachePath: '/tmp/cache.json' }
      )
    ).toMatchObject({ enabled: false, disabledReason: 'missing_token' });
    expect(
      parseGitHubReviewSyncConfig(
        {
          DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
          DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        },
        { cachePath: '/tmp/cache.json' }
      )
    ).toMatchObject({ enabled: false, disabledReason: 'missing_repos' });
    expect(
      parseGitHubReviewSyncConfig(
        {
          DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
          DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
          DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
          DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://user:secret@github.example.test/api/v3',
        },
        { cachePath: '/tmp/cache.json' }
      )
    ).toMatchObject({ enabled: false, disabledReason: 'invalid_api_base' });
  });

  it('projects open GitHub PR review requests into the transcript-free contract', async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, authorization: init.headers?.authorization });
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 42,
            title: 'Add organization export',
            html_url: 'https://github.example.test/acme/app/pull/42',
            user: { login: 'octo-author' },
            requested_reviewers: [{ login: 'Alice' }, { login: 'bob' }],
          },
        ]);
      }
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-07T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
        {
          event: 'review_requested',
          created_at: '2026-06-08T12:00:00Z',
          requested_reviewer: { login: 'bob' },
        },
        {
          event: 'review_requested',
          created_at: '2026-06-08T12:00:00Z',
          requested_reviewer: { login: 'charlie' },
        },
      ]);
    };

    const dataset = await fetchGitHubReviewEvents(config(), {
      fetchImpl,
      nowMs: NOW,
    });

    expect(dataset?.source).toBe('github-review-sync');
    expect(dataset?.generatedAt).toBe('2026-06-10T12:00:00.000Z');
    expect(dataset?.reviewRequests).toEqual([
      expect.objectContaining({
        repository: 'acme/app',
        pullRequestNumber: 42,
        pullRequestTitle: 'Add organization export',
        pullRequestUrl: 'https://github.example.test/acme/app/pull/42',
        pullRequestState: 'open',
        authorId: 'octo-author',
        reviewerId: 'Alice',
        requestedAt: '2026-06-07T12:00:00.000Z',
        state: 'pending',
      }),
      expect.objectContaining({
        reviewerId: 'bob',
        requestedAt: '2026-06-08T12:00:00.000Z',
        state: 'pending',
      }),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.authorization === 'Bearer ghp_test_secret')).toBe(true);
    expect(JSON.stringify(dataset)).not.toContain('ghp_test_secret');
  });

  it('skips pending reviewers when GitHub timeline lacks a review_requested timestamp', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 7,
            title: 'No timestamp',
            html_url: 'https://github.example.test/acme/app/pull/7',
            requested_reviewers: [{ login: 'alice' }],
          },
        ]);
      }
      return jsonResponse([
        {
          event: 'commented',
          created_at: '2026-06-07T12:00:00Z',
          actor: { login: 'alice' },
        },
      ]);
    };

    const dataset = await fetchGitHubReviewEvents(config(), {
      fetchImpl,
      nowMs: NOW,
    });

    expect(dataset?.reviewRequests).toEqual([]);
  });

  it('bounds total timeline requests across repositories and pull requests', async () => {
    const syncConfig = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
        DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
        DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS: '1',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 1,
            title: 'First',
            html_url: 'https://github.example.test/acme/app/pull/1',
            requested_reviewers: [{ login: 'alice' }],
          },
          {
            number: 2,
            title: 'Second',
            html_url: 'https://github.example.test/acme/app/pull/2',
            requested_reviewers: [{ login: 'bob' }],
          },
        ]);
      }
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-01T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
      ]);
    };

    const dataset = await fetchGitHubReviewEvents(syncConfig, {
      fetchImpl,
      nowMs: NOW,
    });

    expect(calls).toHaveLength(2);
    expect(calls.filter((url) => url.includes('/timeline?'))).toHaveLength(1);
    expect(dataset?.reviewRequests.map((request) => request.pullRequestNumber)).toEqual([1]);
  });

  it('overlaps delayed timelines only within its concurrency limit (#3127)', async () => {
    const pullCount = 12;
    const timelineDelayMs = 40;
    const syncConfig = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
        DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
        DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS: String(pullCount),
        DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY: '3',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '1000',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    let activeTimelines = 0;
    let maxActiveTimelines = 0;
    let timelineCalls = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes('/pulls?')) {
        return jsonResponse(
          Array.from({ length: pullCount }, (_, index) => ({
            number: index + 1,
            title: `PR ${index + 1}`,
            requested_reviewers: [{ login: 'alice' }],
          }))
        );
      }
      timelineCalls += 1;
      activeTimelines += 1;
      maxActiveTimelines = Math.max(maxActiveTimelines, activeTimelines);
      await new Promise((resolve) => setTimeout(resolve, timelineDelayMs));
      activeTimelines -= 1;
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-01T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
      ]);
    };

    const dataset = await fetchGitHubReviewEvents(syncConfig, { fetchImpl, nowMs: NOW });

    expect(timelineCalls).toBe(pullCount);
    expect(dataset?.reviewRequests).toHaveLength(pullCount);
    expect(maxActiveTimelines).toBe(3);
  }, 5_000);

  it('starts queued timeline work as soon as any pool slot frees (#3127)', async () => {
    const pullCount = 6;
    const syncConfig = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
        DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
        DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS: String(pullCount),
        DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY: '2',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '1000',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    let activeTimelines = 0;
    let maxActiveTimelines = 0;
    let firstSlowTimelineSettled = false;
    let laterFastTimelineStartedBeforeSlowSettled = false;
    const fetchImpl = async (url: string) => {
      if (url.includes('/pulls?')) {
        return jsonResponse(
          Array.from({ length: pullCount }, (_, index) => ({
            number: index + 1,
            title: `PR ${index + 1}`,
            requested_reviewers: [{ login: 'alice' }],
          }))
        );
      }
      const pullNumber = Number(/\/issues\/(\d+)\/timeline/.exec(url)?.[1]);
      if (pullNumber >= 3 && !firstSlowTimelineSettled) {
        laterFastTimelineStartedBeforeSlowSettled = true;
      }
      activeTimelines += 1;
      maxActiveTimelines = Math.max(maxActiveTimelines, activeTimelines);
      await new Promise((resolve) =>
        setTimeout(resolve, pullNumber === 1 ? 120 : 10)
      );
      activeTimelines -= 1;
      if (pullNumber === 1) firstSlowTimelineSettled = true;
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-01T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
      ]);
    };

    const dataset = await fetchGitHubReviewEvents(syncConfig, {
      fetchImpl,
      nowMs: NOW,
    });

    expect(maxActiveTimelines).toBe(2);
    expect(laterFastTimelineStartedBeforeSlowSettled).toBe(true);
    expect(
      dataset?.reviewRequests.map((request) => request.pullRequestNumber)
    ).toEqual([1, 2, 3, 4, 5, 6]);
  }, 3_000);

  it('aborts the whole synchronization within one total deadline (#3127)', async () => {
    const syncConfig = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
        DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
        DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS: '8',
        DASHBOARD_GITHUB_REVIEW_TIMELINE_CONCURRENCY: '3',
        DASHBOARD_GITHUB_REVIEW_FETCH_TIMEOUT_MS: '1000',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '120',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    let activeTimelines = 0;
    let maxActiveTimelines = 0;
    let abortedTimelines = 0;
    const fetchImpl = async (
      url: string,
      init: { signal?: AbortSignal }
    ): Promise<Response> => {
      if (url.includes('/pulls?')) {
        return jsonResponse(
          Array.from({ length: 8 }, (_, index) => ({
            number: index + 1,
            title: `Stalled PR ${index + 1}`,
            requested_reviewers: [{ login: 'alice' }],
          }))
        );
      }
      activeTimelines += 1;
      maxActiveTimelines = Math.max(maxActiveTimelines, activeTimelines);
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          activeTimelines -= 1;
          abortedTimelines += 1;
          reject(init.signal?.reason ?? new Error('aborted'));
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
      });
    };

    await expect(
      fetchGitHubReviewEvents(syncConfig, { fetchImpl, nowMs: NOW })
    ).rejects.toThrow(/deadline/);

    expect(maxActiveTimelines).toBe(3);
    expect(abortedTimelines).toBe(3);
  }, 3_000);

  it('keeps the total deadline active while a response body is stalled (#3127)', async () => {
    const syncConfig = parseGitHubReviewSyncConfig(
      {
        DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
        DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
        DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
        DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        DASHBOARD_GITHUB_REVIEW_FETCH_TIMEOUT_MS: '1000',
        DASHBOARD_GITHUB_REVIEW_SYNC_DEADLINE_MS: '120',
      },
      { cachePath: '/tmp/review-events-cache.json' }
    );
    let timelineHeaders = 0;
    let abortedBodies = 0;
    const fetchImpl = async (
      url: string,
      init: { signal?: AbortSignal }
    ): Promise<Response> => {
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 1,
            title: 'Stalled response body',
            requested_reviewers: [{ login: 'alice' }],
          },
        ]);
      }
      timelineHeaders += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const abort = () => {
              abortedBodies += 1;
              controller.error(init.signal?.reason ?? new Error('aborted'));
            };
            if (init.signal?.aborted) abort();
            else init.signal?.addEventListener('abort', abort, { once: true });
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    await expect(
      fetchGitHubReviewEvents(syncConfig, { fetchImpl, nowMs: NOW })
    ).rejects.toThrow(/deadline/);

    expect(timelineHeaders).toBe(1);
    expect(abortedBodies).toBe(1);
  }, 1_000);

  it('writes a private cache and falls back to it after a later fetch failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'github-review-sync-'));
    const cachePath = join(dir, 'review-events.json');
    const syncConfig = config(cachePath);
    let shouldFail = false;
    const fetchImpl = async (url: string) => {
      if (shouldFail) throw new Error('network down');
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 1,
            title: 'Stale review',
            html_url: 'https://github.example.test/acme/app/pull/1',
            requested_reviewers: [{ login: 'alice' }],
          },
        ]);
      }
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-01T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
      ]);
    };

    try {
      const fresh = await refreshGitHubReviewEvents(syncConfig, {
        fetchImpl,
        nowMs: NOW,
      });
      expect(fresh?.reviewRequests).toHaveLength(1);
      const cached = readGitHubReviewEventsCache(syncConfig);
      expect(cached?.dataset.reviewRequests).toHaveLength(1);
      shouldFail = true;
      const fallback = await refreshGitHubReviewEvents(syncConfig, {
        fetchImpl,
        nowMs: NOW + 600_000,
      });
      expect(fallback?.reviewRequests).toEqual(fresh?.reviewRequests);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not read a stale cache when the source is disabled or reconfigured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'github-review-sync-'));
    const cachePath = join(dir, 'review-events.json');
    const syncConfig = config(cachePath);
    const fetchImpl = async (url: string) => {
      if (url.includes('/pulls?')) {
        return jsonResponse([
          {
            number: 1,
            title: 'Org only',
            html_url: 'https://github.example.test/acme/app/pull/1',
            requested_reviewers: [{ login: 'alice' }],
          },
        ]);
      }
      return jsonResponse([
        {
          event: 'review_requested',
          created_at: '2026-06-01T12:00:00Z',
          requested_reviewer: { login: 'alice' },
        },
      ]);
    };

    try {
      await refreshGitHubReviewEvents(syncConfig, { fetchImpl, nowMs: NOW });
      const disabled = parseGitHubReviewSyncConfig(
        {
          DASHBOARD_REVIEW_EVENTS_SOURCE: '',
          DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
          DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
          DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        },
        { cachePath }
      );
      const differentRepo = parseGitHubReviewSyncConfig(
        {
          DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
          DASHBOARD_GITHUB_REVIEW_TOKEN: 'ghp_test_secret',
          DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/other',
          DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
        },
        { cachePath }
      );

      expect(readGitHubReviewEventsCache(disabled)).toBeNull();
      expect(readGitHubReviewEventsCache(differentRepo)).toBeNull();
      expect(gitHubReviewEventsCacheSignature(disabled)).toContain('disabled:');
      expect(gitHubReviewEventsCacheSignature(syncConfig)).not.toEqual(
        gitHubReviewEventsCacheSignature(differentRepo)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
