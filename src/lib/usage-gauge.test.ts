import { describe, expect, it } from 'vitest';
import { findAccessToken, parseUsageWindow, buildUsagePayload } from './usage-gauge';

describe('findAccessToken', () => {
  it('finds a top-level accessToken', () => {
    expect(findAccessToken({ accessToken: 'abc' })).toBe('abc');
  });

  it('finds a token nested under the real claudeAiOauth shape', () => {
    expect(findAccessToken({ claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'r' } })).toBe('tok-123');
  });

  it('matches case- and separator-insensitively (access_token, AccessToken)', () => {
    expect(findAccessToken({ access_token: 'snake' })).toBe('snake');
    expect(findAccessToken({ deep: { AccessToken: 'pascal' } })).toBe('pascal');
  });

  it('ignores a non-string token value and keeps searching', () => {
    expect(findAccessToken({ accessToken: 123, nested: { accessToken: 'real' } })).toBe('real');
  });

  it('returns null when there is no token / bad input', () => {
    expect(findAccessToken({ foo: { bar: 'baz' } })).toBeNull();
    expect(findAccessToken(null)).toBeNull();
    expect(findAccessToken('nope')).toBeNull();
  });

  it('#1712: prefers the Claude sk-ant-oat token over an earlier mcpOAuth token', () => {
    // Real-world shape: mcpOAuth sorts before claudeAiOauth, and its nested
    // accessToken would win a naive first-found DFS — but it 401s against the API.
    const creds = {
      mcpOAuth: { 'some-server': { accessToken: 'edfdcb-mcp-token' } },
      claudeAiOauth: { accessToken: 'sk-ant-oat01-real', refreshToken: 'r' },
    };
    expect(findAccessToken(creds)).toBe('sk-ant-oat01-real');
  });

  it('#1712: falls back to a claude-named block when no sk-ant-oat prefix is present', () => {
    const creds = {
      mcpOAuth: { srv: { accessToken: 'mcp-tok' } },
      claudeAiOauth: { accessToken: 'legacy-claude-tok' },
    };
    expect(findAccessToken(creds)).toBe('legacy-claude-tok');
  });

  it('#1712: legacy single-block files still resolve (first-found fallback)', () => {
    expect(findAccessToken({ mcpOAuth: { srv: { accessToken: 'only-tok' } } })).toBe('only-tok');
  });
});

describe('parseUsageWindow', () => {
  it('returns null when the utilization header is absent', () => {
    expect(parseUsageWindow({}, '5h')).toBeNull();
    expect(parseUsageWindow({ '7d-utilization': '0.5' }, '5h')).toBeNull();
  });

  it('returns null when utilization is not a finite number', () => {
    expect(parseUsageWindow({ '5h-utilization': 'abc' }, '5h')).toBeNull();
  });

  it('parses utilization, reset, and status', () => {
    expect(
      parseUsageWindow({ '5h-utilization': '0.42', '5h-reset': '1780630800', '5h-status': 'allowed' }, '5h'),
    ).toEqual({ utilization: 0.42, reset: 1780630800, status: 'allowed' });
  });

  it('nulls a missing/non-finite reset and a missing status', () => {
    expect(parseUsageWindow({ '5h-utilization': '0.1' }, '5h')).toEqual({
      utilization: 0.1,
      reset: null,
      status: null,
    });
    expect(parseUsageWindow({ '7d-utilization': '0.9', '7d-reset': 'soon' }, '7d')).toEqual({
      utilization: 0.9,
      reset: null,
      status: null,
    });
  });
});

describe('buildUsagePayload', () => {
  it('reports auth-failed when no windows came back on a 401/403', () => {
    expect(buildUsagePayload({}, 401)).toEqual({ available: false, reason: 'auth-failed' });
    expect(buildUsagePayload({}, 403)).toEqual({ available: false, reason: 'auth-failed' });
  });

  it('reports no-headers when no windows came back on a non-auth status', () => {
    expect(buildUsagePayload({}, 200)).toEqual({ available: false, reason: 'no-headers' });
    expect(buildUsagePayload({}, 500)).toEqual({ available: false, reason: 'no-headers' });
  });

  it('builds an available payload from present windows', () => {
    const p = buildUsagePayload(
      { '5h-utilization': '0.3', '5h-status': 'allowed', '7d-utilization': '0.8', 'representative-claim': 'seven_day' },
      200,
    );
    expect(p.available).toBe(true);
    if (!p.available) return;
    expect(p.fiveHour).toEqual({ utilization: 0.3, reset: null, status: 'allowed' });
    expect(p.sevenDay).toEqual({ utilization: 0.8, reset: null, status: null });
    expect(p.overage).toBeNull();
    expect(p.representativeClaim).toBe('seven_day');
  });

  it('surfaces an active overage with a parsed utilization', () => {
    const p = buildUsagePayload(
      { '5h-utilization': '0.1', 'overage-in-use': 'true', 'overage-utilization': '0.25' },
      200,
    );
    if (!p.available) throw new Error('expected available');
    expect(p.overage).toEqual({ inUse: true, utilization: 0.25 });
  });

  it('nulls overage utilization when the header is non-numeric', () => {
    const p = buildUsagePayload({ '7d-utilization': '0.1', 'overage-in-use': 'true' }, 200);
    if (!p.available) throw new Error('expected available');
    expect(p.overage).toEqual({ inUse: true, utilization: null });
  });
});
