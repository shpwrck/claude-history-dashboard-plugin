import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAuthSession,
  fetchEnterpriseAuditExport,
  fetchEnterpriseOrganization,
  fetchEnterpriseReadinessReceipt,
} from './api-client';

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
