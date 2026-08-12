import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseBrowserSession,
  fetchAuditRun,
  fetchAuthSession,
  fetchEnterpriseAuditExport,
  fetchEnterpriseOrganization,
  fetchEnterpriseReadinessReceipt,
  fetchWorkflows,
  postCheckpointAnswer,
} from './api-client';
import {
  fetchAuditRun as fetchSpaAuditRun,
  fetchWorkflows as fetchSpaWorkflows,
  postCheckpointAnswer as postSpaCheckpointAnswer,
} from './api-client.spa';
import { buildCheckpointAnswerRecord } from './checkpoint-instrumentation';
import { enterpriseCapabilityAllowed } from './enterprise-capabilities';

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

  it('treats non-session 403 responses as enterprise auth failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 }))
    );

    const session = await fetchAuthSession(null);

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

    const session = await fetchAuthSession(null);

    expect(session.mode).toBe('enterprise');
    expect(session.authRequired).toBe(true);
    expect(session.authenticated).toBe(false);
    expect(session.configured).toBe(true);
    expect(session.capabilities).toEqual({});
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
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

    await expect(fetchAuthSession(null)).resolves.toEqual(body);
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

    const session = await fetchAuthSession(null);

    expect(session.authRequired).toBe(false);
    expect(session.authenticated).toBe(false);
    expect(session.capabilities).toEqual({});
    expect(session.error).toBe('server exploded');
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
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

    const session = await fetchAuthSession(null);

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

    const session = await fetchAuthSession(null);

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

    const session = await fetchAuthSession(null);

    expect(session.capabilities).toEqual({});
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
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

    const session = await fetchAuthSession(null);

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

    const session = await fetchAuthSession(null);

    expect(session.authRequired).toBe(false);
    expect(session.capabilities).toEqual({});
    expect(session.error).toBe('Could not reach the dashboard server');
  });
});

describe('createEnterpriseBrowserSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a complete writable enterprise session body returned with HTTP 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              mode: 'enterprise',
              authRequired: true,
              authenticated: true,
              configured: true,
              principal: null,
              organization: { id: 'acme', name: 'Acme' },
              capabilities: { canWritePolicy: true },
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await createEnterpriseBrowserSession('saved-token');

    expect(session.capabilities).toEqual({});
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
    expect(session.error).toBe('Auth check failed (HTTP 500)');
  });

  it('preserves a structured org-mismatch reason while rejecting every other 403 field', async () => {
    const error =
      'Forbidden: this principal is outside the configured organization';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              mode: 'single-user',
              authRequired: false,
              authenticated: true,
              configured: false,
              principal: { userId: 'outside-org' },
              organization: { id: 'other-org', name: 'Other org' },
              capabilities: { canWritePolicy: true },
              error,
            }),
            {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await createEnterpriseBrowserSession('outside-org-token');

    expect(session).toEqual({
      mode: 'enterprise',
      authRequired: true,
      authenticated: false,
      configured: true,
      principal: null,
      organization: null,
      capabilities: {},
      error,
    });
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
  });

  it('preserves a structured configuration error while keeping a rejected session closed', async () => {
    const configError =
      'DASHBOARD_AUTH_CONFIG contains a principal outside DASHBOARD_ORG_ID';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              mode: 'enterprise',
              authRequired: true,
              authenticated: true,
              configured: true,
              principal: { userId: 'admin' },
              organization: { id: 'acme', name: 'Acme' },
              capabilities: { canWritePolicy: true },
              configError,
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    const session = await createEnterpriseBrowserSession('admin-token');

    expect(session).toEqual({
      mode: 'enterprise',
      authRequired: true,
      authenticated: false,
      configured: false,
      configError,
      principal: null,
      organization: null,
      capabilities: {},
    });
    expect(
      enterpriseCapabilityAllowed(session, 'canWritePolicy')
    ).toBe(false);
  });
});

describe('fetchEnterpriseOrganization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes bounded principal pagination parameters to the organization API', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            organization: { id: 'acme', name: 'Acme' },
            principals: [],
            principalPage: { total: 200, limit: 50, offset: 100, returned: 0 },
            teams: [],
            auditEvents: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchEnterpriseOrganization({
      principalLimit: 50,
      principalOffset: 100,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/organization?principalLimit=50&principalOffset=100',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
  });
});

describe('fetchEnterpriseReadinessReceipt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the redacted enterprise readiness receipt through the server chokepoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1',
            generatedAt: '2026-06-10T00:00:00.000Z',
            status: 'ready',
            mode: 'enterprise',
            organization: { id: 'acme', name: 'Acme' },
            reviewer: null,
            summary: {
              actionRequiredControls: 0,
              enabledControls: 1,
              disabledControls: 0,
              configuredPrincipals: 1,
              teams: 1,
              scopedDataRoots: 1,
              sessions: 0,
              projects: 0,
              auditEvents: 0,
              deniedAuditEvents: 0,
              rateLimitedAuditEvents: 0,
              serverErrorAuditEvents: 0,
            },
            evidence: {
              posture: {
                generatedAt: '2026-06-10T00:00:00.000Z',
                controls: {
                  total: 1,
                  enabled: 1,
                  disabled: 0,
                  actionRequired: 0,
                  other: 0,
                  actionRequiredIds: [],
                  states: [{ id: 'auth', label: 'Auth', state: 'enabled' }],
                },
              },
              rollup: null,
              routeAccess: {
                inventoryGate: 'npm run gate:enterprise-routes',
                unclassifiedApiRoutesFailClosed: true,
                adminGlobalViews: true,
                scopedUserViewsRequireDataRoot: true,
                rawTranscriptRoutesHighestSensitivity: true,
                writesRequireAdminAndCsrf: true,
              },
              bounds: {},
            },
            privacy: {
              redacted: true,
              derivedFrom: [],
              excludes: ['raw bearer tokens'],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await fetchEnterpriseReadinessReceipt();

    expect(receipt.privacy.redacted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/readiness-receipt',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
  });
});

describe('fetchEnterpriseAuditExport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches bounded sanitized audit NDJSON through the server chokepoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"type":"enterprise.route.allowed"}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = await fetchEnterpriseAuditExport({ limit: 3 });

    expect(body).toContain('enterprise.route.allowed');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/enterprise/audit-export.ndjson?limit=3',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
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
      expect.objectContaining({ headers: expect.any(Headers) })
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
