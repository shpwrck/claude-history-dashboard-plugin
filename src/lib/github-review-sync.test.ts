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
