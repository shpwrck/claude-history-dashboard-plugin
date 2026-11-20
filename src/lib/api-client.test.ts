import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAuditRun,
  fetchAuthSession,
  fetchWorkflows,
  postCheckpointAnswer,
} from './api-client';
import type { ServerSession } from './api-client';
import {
  fetchAuthSession as fetchSpaAuthSession,
  fetchAuditRun as fetchSpaAuditRun,
  fetchWorkflows as fetchSpaWorkflows,
  postCheckpointAnswer as postSpaCheckpointAnswer,
} from './api-client.spa';
import { buildCheckpointAnswerRecord } from './checkpoint-instrumentation';
import { serverCapabilityAllowed } from './server-capabilities';

describe('fetchWorkflows cancellation boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the caller AbortSignal to the server request', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(fetchWorkflows(controller.signal)).resolves.toEqual({ runs: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('keeps the SPA adapter network-free when passed an AbortSignal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSpaWorkflows(new AbortController().signal)
    ).resolves.toEqual({ runs: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('distinguishes server failure from a successful empty ledger', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    await expect(fetchWorkflows()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network unavailable');
    }));
    await expect(fetchWorkflows()).resolves.toBeNull();
  });

  it('rejects a successful response that omits the runs ledger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ truncated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(fetchWorkflows()).resolves.toBeNull();
  });

  it('rejects a successful response whose runs member is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ runs: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(fetchWorkflows()).resolves.toBeNull();
  });
});

describe('fetchAuthSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the neutral single-user session from a local server (#3832)', async () => {
    const local: ServerSession = {
      mode: 'single-user',
      authRequired: false,
      authenticated: true,
      configured: true,
      principal: null,
      organization: null,
      capabilities: { canImportLocalData: true, canWritePolicy: true },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(local), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    await expect(fetchAuthSession()).resolves.toEqual(local);
  });

  it('matches the sample stub to the neutral single-user contract (#3832)', async () => {
    const sample: ServerSession = await fetchSpaAuthSession();
    expect(sample).toEqual({
      mode: 'single-user',
      authRequired: false,
      authenticated: true,
      configured: true,
      principal: null,
      organization: null,
      capabilities: {},
    });
  });

  it('treats non-session 403 responses as enterprise auth failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 }))
    );

    const session = await fetchAuthSession();

    expect(session.mode).toBe('enterprise');
    expect(session.authRequired).toBe(true);
    expect(session.authenticated).toBe(false);
    expect(session.configured).toBe(true);
    expect(session.error).toBe('Auth check failed (HTTP 403)');
  });

  it('preserves enterprise auth while denying policy writes for a rate-limited session probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              authRequired: true,
              authenticated: false,
              configured: true,
              error:
                'Too many enterprise requests; retry after the rate limit resets',
              retryAfterSeconds: 30,
            }),
            {
              status: 429,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await fetchAuthSession();

    expect(session.mode).toBe('enterprise');
    expect(session.authRequired).toBe(true);
    expect(session.authenticated).toBe(false);
    expect(session.configured).toBe(true);
    expect(session.capabilities).toEqual({});
    expect(
      serverCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
    expect(session.error).toBe(
      'Too many enterprise requests; retry after the rate limit resets'
    );
  });

  it('accepts a complete local/no-auth session response', async () => {
    const body = {
      mode: 'single-user',
      authRequired: false,
      authenticated: true,
      configured: true,
      principal: null,
      organization: null,
      capabilities: { canWritePolicy: true },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    await expect(fetchAuthSession()).resolves.toEqual(body);
  });

  it('preserves a structured GET failure while keeping the session indeterminate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'server exploded' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    const session = await fetchAuthSession();

    expect(session.authRequired).toBe(false);
    expect(session.authenticated).toBe(false);
    expect(session.capabilities).toEqual({});
    expect(session.error).toBe('server exploded');
    expect(
      serverCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
  });

  it('falls back to HTTP status text for blank structured failure fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: '   ', configError: '\n\t' }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await fetchAuthSession();

    expect(session.error).toBe('Auth check failed (HTTP 500)');
    expect(session.configError).toBeUndefined();
    expect(session.authenticated).toBe(false);
    expect(session.capabilities).toEqual({});
  });

  it('bounds structured failure messages before exposing them to the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: `  ${'x'.repeat(2_100)}  ` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    const session = await fetchAuthSession();

    expect(session.error).toBe('x'.repeat(2_000));
  });

  it.each([
    {
      name: 'complete local',
      body: {
        mode: 'single-user',
        authRequired: false,
        authenticated: true,
        configured: true,
        principal: null,
        organization: null,
        capabilities: { canWritePolicy: true },
      },
    },
    {
      name: 'complete enterprise capability',
      body: {
        mode: 'enterprise',
        authRequired: true,
        authenticated: true,
        configured: true,
        principal: null,
        organization: { id: 'acme', name: 'Acme' },
        capabilities: { canWritePolicy: true },
      },
    },
  ])('rejects an HTTP 500 $name session body', async ({ body }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    const session = await fetchAuthSession();

    expect(session.capabilities).toEqual({});
    expect(
      serverCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
    expect(session.error).toBe('Auth check failed (HTTP 500)');
  });

  it('rejects a partial local-looking HTTP 200 session body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              authRequired: false,
              authenticated: true,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await fetchAuthSession();

    expect(session.authRequired).toBe(false);
    expect(session.capabilities).toEqual({});
    expect(session.error).toBe('Auth check failed (HTTP 200)');
  });

  it('marks an unreachable auth endpoint as an indeterminate session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unavailable');
      })
    );

    const session = await fetchAuthSession();

    expect(session.authRequired).toBe(false);
    expect(session.capabilities).toEqual({});
    expect(session.error).toBe('Could not reach the dashboard server');
  });
});

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('postCheckpointAnswer', () => {
  const record = buildCheckpointAnswerRecord({
    checkpointId: 'cp-client',
    shownAt: 1_000,
    answeredAt: 2_000,
    answer: 'worktrees',
    neighborhood: {
      anchor: { kind: 'doc', slug: 'AGENTS' },
      seeds: [],
      nodes: [],
      ambiguityTrigger: false,
      ambiguitySources: [],
    },
  })!;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('obtains CSRF and posts the record through the server chokepoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ token: 'csrf' }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postCheckpointAnswer(record)).resolves.toEqual({
      ok: true,
      written: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/csrf-token',
      expect.objectContaining({ credentials: 'same-origin' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/checkpoint/answers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(record),
      })
    );
  });

  it('is a network-free no-op in the sample stub', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(postSpaCheckpointAnswer(record)).resolves.toEqual({
      ok: true,
      written: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchAuditRun', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses explicit ran audit responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          status: 'ran',
          findings: [
            {
              id: 'a1',
              domain: 'security',
              summary: 'Finding',
              judgeRationale: 'Rationale',
              confidence: 'high',
              evidenceRefs: ['session:s1'],
            },
          ],
        })
      )
    );

    await expect(fetchAuditRun()).resolves.toMatchObject({
      status: 'ran',
      findings: [{ id: 'a1' }],
    });
  });

  it('maps legacy disabled responses to skipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          disabled: true,
          reason: 'missing_anthropic_api_key',
          findings: [],
        })
      )
    );

    await expect(fetchAuditRun()).resolves.toEqual({
      status: 'skipped',
      reason: 'missing_anthropic_api_key',
      findings: [],
    });
  });

  it('keeps legacy findings-only responses as ran', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse({ findings: [] }))
    );

    await expect(fetchAuditRun()).resolves.toEqual({
      status: 'ran',
      findings: [],
    });
  });

  it('rejects non-ok audit responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({}, 413)));

    await expect(fetchAuditRun()).rejects.toThrow(
      'Audit request failed (HTTP 413)'
    );
  });
});

describe('fetchSpaAuditRun', () => {
  it('returns an explicit skipped response for public-sample mode', async () => {
    await expect(fetchSpaAuditRun()).resolves.toEqual({
      status: 'skipped',
      reason: 'spa_unsupported',
      findings: [],
    });
  });
});
