import { describe, expect, it } from 'vitest';
import { serverCapabilityAllowed } from './server-capabilities';
import type { ServerSession } from '@api-client';

function localSession(
  overrides: Partial<ServerSession> = {}
): ServerSession {
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

function serverSession(
  overrides: Partial<ServerSession> = {}
): ServerSession {
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

describe('serverCapabilityAllowed', () => {
  it('fails closed until the auth-session probe resolves', () => {
    expect(serverCapabilityAllowed(null, 'canImportLocalData')).toBe(
      false
    );
  });

  it('allows a positively resolved single-user session without an explicit capability', () => {
    expect(
      serverCapabilityAllowed(localSession(), 'canImportLocalData')
    ).toBe(true);
  });

  it('fails closed when the auth-session probe returned an error', () => {
    expect(
      serverCapabilityAllowed(
        localSession({
          error: 'Could not reach the dashboard server',
        }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        serverSession({
          capabilities: { canWritePolicy: true },
          error: 'Auth check failed (HTTP 500)',
        }),
        'canWritePolicy'
      )
    ).toBe(false);
  });

  it('rejects incomplete or internally inconsistent local session shapes', () => {
    expect(
      serverCapabilityAllowed(
        {
          authRequired: false,
          authenticated: true,
        } as unknown as ServerSession,
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        localSession({ mode: 'enterprise' }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        localSession({ authenticated: false }),
        'canWritePolicy'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        localSession({ configured: false }),
        'canWritePolicy'
      )
    ).toBe(false);
  });

  it('requires an explicit enterprise capability', () => {
    expect(
      serverCapabilityAllowed(
        serverSession(),
        'canImportLocalData'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        serverSession({
          capabilities: { canImportLocalData: true },
        }),
        'canImportLocalData'
      )
    ).toBe(true);
    expect(
      serverCapabilityAllowed(
        serverSession({
          authenticated: false,
          capabilities: { canImportLocalData: true },
        }),
        'canImportLocalData'
      )
    ).toBe(false);
    expect(
      serverCapabilityAllowed(
        serverSession({
          configured: false,
          capabilities: { canImportLocalData: true },
        }),
        'canImportLocalData'
      )
    ).toBe(false);
  });
});
