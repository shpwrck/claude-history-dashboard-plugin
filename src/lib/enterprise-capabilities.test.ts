import { describe, expect, it } from 'vitest';
import { enterpriseCapabilityAllowed } from './enterprise-capabilities';
import type { EnterpriseSession } from '@api-client';

function localSession(
  overrides: Partial<EnterpriseSession> = {}
): EnterpriseSession {
  return {
    mode: 'single-user',
    authRequired: false,
    authenticated: true,
    configured: true,
    principal: null,
    organization: null,
    capabilities: {},
    ...overrides,
  };
}

function enterpriseSession(
  overrides: Partial<EnterpriseSession> = {}
): EnterpriseSession {
  return {
    mode: 'enterprise',
    authRequired: true,
    authenticated: true,
    configured: true,
    principal: null,
    organization: null,
    capabilities: {},
    ...overrides,
  };
}

describe('enterpriseCapabilityAllowed', () => {
  it('fails closed until the auth-session probe resolves', () => {
    expect(enterpriseCapabilityAllowed(null, 'canUseBrowserLlmEgress')).toBe(
      false
    );
  });

  it('allows a positively resolved single-user session without an explicit capability', () => {
    expect(
      enterpriseCapabilityAllowed(localSession(), 'canUseBrowserLlmEgress')
    ).toBe(true);
  });

  it('fails closed when the auth-session probe returned an error', () => {
    expect(
      enterpriseCapabilityAllowed(
        localSession({
          error: 'Could not reach the dashboard server',
        }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        enterpriseSession({
          capabilities: { canWritePolicy: true },
          error: 'Auth check failed (HTTP 500)',
        }),
        'canWritePolicy'
      )
    ).toBe(false);
  });

  it('rejects incomplete or internally inconsistent local session shapes', () => {
    expect(
      enterpriseCapabilityAllowed(
        {
          authRequired: false,
          authenticated: true,
        } as unknown as EnterpriseSession,
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        localSession({ mode: 'enterprise' }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        localSession({ authenticated: false }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        localSession({ configured: false }),
        'canWritePolicy'
      )
    ).toBe(false);
  });

  it('requires an explicit enterprise capability', () => {
    expect(
      enterpriseCapabilityAllowed(
        enterpriseSession(),
        'canUseBrowserLlmEgress'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        enterpriseSession({
          capabilities: { canUseBrowserLlmEgress: true },
        }),
        'canUseBrowserLlmEgress'
      )
    ).toBe(true);
    expect(
      enterpriseCapabilityAllowed(
        enterpriseSession({
          authenticated: false,
          capabilities: { canUseBrowserLlmEgress: true },
        }),
        'canUseBrowserLlmEgress'
      )
    ).toBe(false);
    expect(
      enterpriseCapabilityAllowed(
        enterpriseSession({
          configured: false,
          capabilities: { canUseBrowserLlmEgress: true },
        }),
        'canUseBrowserLlmEgress'
      )
    ).toBe(false);
  });
});
