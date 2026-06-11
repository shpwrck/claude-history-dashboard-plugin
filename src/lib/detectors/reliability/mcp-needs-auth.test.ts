import { describe, it, expect } from 'vitest';
import { detector } from './mcp-needs-auth';
import type { RecommendationInput } from '../types';
import type { McpAuthState } from '../../parse-mcp-auth';
import type { Session } from '../../../types';
import type { SessionAttribution } from '../../parse-agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InputWithMcpAuth = RecommendationInput & { mcpAuth?: McpAuthState | null };

/** Minimal valid RecommendationInput baseline */
function baseInput(overrides: Partial<InputWithMcpAuth> = {}): InputWithMcpAuth {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function sdkSession(id: string): Session {
  return {
    sessionId: id,
    entrypoint: 'sdk-cli',
    startTime: '2026-06-04T00:00:00Z',
    endTime: '2026-06-04T01:00:00Z',
    messageCount: 10,
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Session;
}

function cliSession(id: string): Session {
  return {
    sessionId: id,
    entrypoint: 'cli',
    startTime: '2026-06-04T00:00:00Z',
    endTime: '2026-06-04T01:00:00Z',
    messageCount: 5,
    tokens: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 },
  } as unknown as Session;
}

function attribution(sessionId: string, mcpServers: Record<string, number>): SessionAttribution {
  return {
    sessionId,
    agents: {},
    skills: {},
    mcpServers: Object.fromEntries(
      Object.entries(mcpServers).map(([k, v]) => [k, { invocations: v, outputTokens: 0 }])
    ),
    mcpTools: {},
  };
}

// Prototype scenario: github + cloudflare-api are blocking (unattended calls);
// notion is advisory (no unattended call history).
const PROTOTYPE_AUTH_STATE: McpAuthState = {
  serversNeedingAuth: ['github', 'cloudflare-api', 'notion'],
  entries: {
    github: { needsAuth: true, reason: 'oauth_token_expired' },
    'cloudflare-api': { needsAuth: true, reason: 'refresh_token_revoked' },
    notion: { needsAuth: true, reason: '401_unauthorized' },
  },
};

// ---------------------------------------------------------------------------
// Detector: basic gating
// ---------------------------------------------------------------------------

describe('reliability.mcp-needs-auth', () => {
  it('returns null when mcpAuth is absent', () => {
    expect(detector.rule(baseInput(), 0)).toBeNull();
  });

  it('returns null when mcpAuth is null', () => {
    expect(detector.rule(baseInput({ mcpAuth: null }), 0)).toBeNull();
  });

  it('returns null when no servers need auth (empty state)', () => {
    const st: McpAuthState = { serversNeedingAuth: [], entries: {} };
    expect(detector.rule(baseInput({ mcpAuth: st }), 0)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Advisory-only (no unattended call data)
  // ---------------------------------------------------------------------------

  it('fires as WARNING when servers need auth but no unattended calls data', () => {
    const st: McpAuthState = {
      serversNeedingAuth: ['notion'],
      entries: { notion: { needsAuth: true, reason: '401_unauthorized' } },
    };
    const result = detector.rule(baseInput({ mcpAuth: st }), 0);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('reliability.mcp-needs-auth');
    expect(result?.severity).toBe('warning');
    expect(result?.unattended).toBeFalsy();
    expect(result?.fix).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Blocking scenario (prototype mock)
  // ---------------------------------------------------------------------------

  it('fires as CRITICAL when a blocking server (unattended calls > 0) needs auth', () => {
    const s1 = sdkSession('sess-sdk-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1, cliSession('sess-cli-1')],
      attribution: [
        attribution('sess-sdk-1', { github: 1442, 'cloudflare-api': 318 }),
        attribution('sess-cli-1', { notion: 12 }), // cli session — should NOT count
      ],
    });

    const result = detector.rule(input, 0);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('critical');
    expect(result?.unattended).toBe(true);
    expect(result?.affected).toBe(3); // 2 blocking + 1 advisory
  });

  it('includes blocking server names in title', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 1442, 'cloudflare-api': 318 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.title).toMatch(/blocking/);
    expect(result?.title).toMatch(/2/);
  });

  it('emits a gate snippet fix when blocking servers exist', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 500 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.fix).toBeDefined();
    expect(result?.fix?.snippet).toContain('claude mcp auth');
    expect(result?.fix?.snippet).toContain('github');
    expect(result?.fix?.snippet).toContain('exit 1');
  });

  it('evidence includes claude mcp auth commands', () => {
    const s1 = sdkSession('sess-1');
    const input = baseInput({
      mcpAuth: PROTOTYPE_AUTH_STATE,
      sessions: [s1],
      attribution: [attribution('sess-1', { github: 1442 })],
    });
    const result = detector.rule(input, 0);
    expect(result?.evidence?.some((e) => e.includes('claude mcp auth'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Attribution scoping: CLI sessions must NOT bump blocking count
  // ---------------------------------------------------------------------------

  it('treats servers only called in cli sessions as advisory', () => {
    const st: McpAuthState = {
      serversNeedingAuth: ['notion'],
      entries: { notion: { needsAuth: true, reason: '401_unauthorized' } },
    };
    const input = baseInput({
      mcpAuth: st,
      sessions: [cliSession('cli-sess')],
      attribution: [attribution('cli-sess', { notion: 500 })],
    });
    const result = detector.rule(input, 0);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('warning'); // advisory only
    expect(result?.unattended).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  it('has the correct id, category, and dataDeps declared', () => {
    expect(detector.id).toBe('reliability.mcp-needs-auth');
    expect(detector.category).toBe('reliability');
    expect(detector.dataDeps).toContain('attribution');
    expect(detector.dataDeps).toContain('sessions');
  });
});
