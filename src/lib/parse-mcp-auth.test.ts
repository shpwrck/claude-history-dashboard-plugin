import { describe, it, expect } from 'vitest';
import {
  parseMcpAuthCache,
  classifyAuthServers,
  type McpAuthState,
} from './parse-mcp-auth';

// ---------------------------------------------------------------------------
// parseMcpAuthCache
// ---------------------------------------------------------------------------

describe('parseMcpAuthCache', () => {
  it('returns empty state for {} (all clear)', () => {
    const result = parseMcpAuthCache('{}');
    expect(result.serversNeedingAuth).toEqual([]);
    expect(result.entries).toEqual({});
  });

  it('returns empty state for empty string', () => {
    const result = parseMcpAuthCache('');
    expect(result.serversNeedingAuth).toEqual([]);
  });

  it('returns empty state for malformed JSON', () => {
    const result = parseMcpAuthCache('{not valid json}');
    expect(result.serversNeedingAuth).toEqual([]);
  });

  it('returns empty state for JSON array (wrong shape)', () => {
    const result = parseMcpAuthCache('["github"]');
    expect(result.serversNeedingAuth).toEqual([]);
  });

  it('filters out entries where needsAuth is false', () => {
    const json = JSON.stringify({
      github: { needsAuth: false, reason: 'token_ok' },
      notion: { needsAuth: false },
    });
    const result = parseMcpAuthCache(json);
    expect(result.serversNeedingAuth).toEqual([]);
  });

  it('parses a single server needing auth', () => {
    const json = JSON.stringify({
      github: {
        needsAuth: true,
        reason: 'oauth_token_expired',
        lastCheckedAt: '2026-06-04T02:14:07.512Z',
        serverType: 'http',
        transport: 'sse',
      },
    });
    const result = parseMcpAuthCache(json);
    expect(result.serversNeedingAuth).toEqual(['github']);
    expect(result.entries.github).toMatchObject({
      needsAuth: true,
      reason: 'oauth_token_expired',
      lastCheckedAt: '2026-06-04T02:14:07.512Z',
      serverType: 'http',
      transport: 'sse',
    });
  });

  it('parses multiple servers needing auth, filters clear ones', () => {
    const json = JSON.stringify({
      github: { needsAuth: true, reason: 'oauth_token_expired' },
      'cloudflare-api': { needsAuth: true, reason: 'refresh_token_revoked' },
      playwright: { needsAuth: false },
      notion: { needsAuth: true, reason: '401_unauthorized' },
    });
    const result = parseMcpAuthCache(json);
    expect(result.serversNeedingAuth).toHaveLength(3);
    expect(result.serversNeedingAuth).toContain('github');
    expect(result.serversNeedingAuth).toContain('cloudflare-api');
    expect(result.serversNeedingAuth).toContain('notion');
    expect(result.serversNeedingAuth).not.toContain('playwright');
  });

  it('handles entries with non-object values gracefully', () => {
    const json = JSON.stringify({
      github: 'needs_auth', // string, not object
      notion: null,
      'cloudflare-api': { needsAuth: true, reason: 'revoked' },
    });
    const result = parseMcpAuthCache(json);
    expect(result.serversNeedingAuth).toEqual(['cloudflare-api']);
  });

  it('defaults reason to "unknown" when missing', () => {
    const json = JSON.stringify({ github: { needsAuth: true } });
    const result = parseMcpAuthCache(json);
    expect(result.entries.github.reason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// classifyAuthServers
// ---------------------------------------------------------------------------

// Prototype mock fixture scenario: github(1442) + cloudflare-api(318) are blocking;
// notion is advisory (0 unattended calls).
const PROTOTYPE_STATE: McpAuthState = {
  serversNeedingAuth: ['github', 'cloudflare-api', 'notion'],
  entries: {
    github: { needsAuth: true, reason: 'oauth_token_expired' },
    'cloudflare-api': { needsAuth: true, reason: 'refresh_token_revoked' },
    notion: { needsAuth: true, reason: '401_unauthorized' },
  },
};

const PROTOTYPE_CALLS: Record<string, number> = {
  github: 1442,
  'cloudflare-api': 318,
  playwright: 96,
  // notion intentionally absent (0 unattended calls)
};

describe('classifyAuthServers', () => {
  it('classifies high-call servers as blocking, zero-call as advisory', () => {
    const { blocking, advisory } = classifyAuthServers(PROTOTYPE_STATE, PROTOTYPE_CALLS);
    expect(blocking).toHaveLength(2);
    expect(advisory).toHaveLength(1);

    const blockerNames = blocking.map((b) => b.name);
    expect(blockerNames).toContain('github');
    expect(blockerNames).toContain('cloudflare-api');
    expect(advisory[0].name).toBe('notion');
  });

  it('sorts blocking servers by calls30d descending', () => {
    const { blocking } = classifyAuthServers(PROTOTYPE_STATE, PROTOTYPE_CALLS);
    expect(blocking[0].name).toBe('github'); // 1442 > 318
    expect(blocking[0].calls30d).toBe(1442);
    expect(blocking[1].name).toBe('cloudflare-api');
    expect(blocking[1].calls30d).toBe(318);
  });

  it('marks advisory servers as non-blocking with 0 calls', () => {
    const { advisory } = classifyAuthServers(PROTOTYPE_STATE, PROTOTYPE_CALLS);
    expect(advisory[0].blocking).toBe(false);
    expect(advisory[0].calls30d).toBe(0);
  });

  it('returns all as advisory when callMap is omitted', () => {
    const { blocking, advisory } = classifyAuthServers(PROTOTYPE_STATE);
    expect(blocking).toHaveLength(0);
    expect(advisory).toHaveLength(3);
    for (const s of advisory) {
      expect(s.blocking).toBe(false);
    }
  });

  it('returns empty results for clear state', () => {
    const clearState: McpAuthState = { serversNeedingAuth: [], entries: {} };
    const { blocking, advisory } = classifyAuthServers(clearState, PROTOTYPE_CALLS);
    expect(blocking).toHaveLength(0);
    expect(advisory).toHaveLength(0);
  });
});
