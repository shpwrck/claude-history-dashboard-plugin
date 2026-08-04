import { describe, it, expect } from 'vitest';
import { detector } from './mcp-schema-tax';
import { duplicateMcpServers, type ToolInventory } from '../../parse-tool-inventory';
import { getModelPricing } from '../../pricing';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, LiveConfig, TokenEntry } from '../../../types';

// 30 shared tool basenames exposed by BOTH `github` and `githubmcp` — a
// duplicate-server pair (the live #1920 example).
const SHARED = Array.from({ length: 30 }, (_, i) => `tool_${i}`);

const inv = (sessionId: string, servers: string[]): ToolInventory => ({
  sessionId,
  toolsAvailable: servers.flatMap((s) => SHARED.map((t) => `mcp__${s}__${t}`)),
  toolsUsed: [],
  unusedTools: [],
  utilizationPct: 0,
});

const entry = (): TokenEntry =>
  ({
    timestamp: 't',
    model: 'claude-opus-4-7',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 100_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
  }) as TokenEntry;

const tokenData: SessionTokenData[] = [
  { sessionId: 's1', entries: Array.from({ length: 50 }, entry) } as unknown as SessionTokenData,
  { sessionId: 's2', entries: Array.from({ length: 50 }, entry) } as unknown as SessionTokenData,
];

const toolInventories: ToolInventory[] = [
  inv('s1', ['github', 'githubmcp']),
  inv('s2', ['github', 'githubmcp']),
];

const liveConfig = (servers: string[]): LiveConfig =>
  ({ mcpServers: servers.map((id) => ({ id, scope: 'global' })) }) as unknown as LiveConfig;

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData,
    toolData: [],
    toolInventories,
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: liveConfig(['github', 'githubmcp']),
    ...overrides,
  }) as RecommendationInput;

describe('duplicateMcpServers (#1920)', () => {
  it('flags a duplicate-server pair, keeping the lexically-first on a size tie', () => {
    const r = duplicateMcpServers(toolInventories);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].keep).toBe('github');
    expect(r.groups[0].redundant.map((x) => x.server)).toEqual(['githubmcp']);
    expect(r.groups[0].redundantToolCount).toBe(30);
    expect(r.groups[0].redundant[0].uniqueToKeep).toBe(0); // full overlap
    expect(r.totalMcpToolCount).toBe(60);
  });

  it('discloses unique tools a partial-overlap redundant server would lose', () => {
    // github: tool_0..tool_11 (12, larger → keep). gh: tool_0..tool_6 shared (7) + 3 unique → 70% overlap.
    const partial: ToolInventory[] = [
      {
        sessionId: 's1',
        toolsAvailable: [
          ...Array.from({ length: 12 }, (_, i) => `mcp__github__tool_${i}`),
          ...Array.from({ length: 7 }, (_, i) => `mcp__gh__tool_${i}`),
          ...Array.from({ length: 3 }, (_, i) => `mcp__gh__only_${i}`),
        ],
        toolsUsed: [],
        unusedTools: [],
        utilizationPct: 0,
      },
    ];
    const r = duplicateMcpServers(partial);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].keep).toBe('github');
    const red = r.groups[0].redundant[0];
    expect(red.server).toBe('gh');
    expect(red.sharedWithKeep).toBe(7);
    expect(red.uniqueToKeep).toBe(3); // would be lost on removal — must be disclosed
  });

  it('does not flag servers with disjoint tool sets', () => {
    const disjoint: ToolInventory[] = [
      {
        sessionId: 's1',
        toolsAvailable: [
          ...SHARED.map((t) => `mcp__github__${t}`),
          ...Array.from({ length: 6 }, (_, i) => `mcp__playwright__browser_${i}`),
        ],
        toolsUsed: [],
        unusedTools: [],
        utilizationPct: 0,
      },
    ];
    expect(duplicateMcpServers(disjoint).groups).toHaveLength(0);
  });
});

describe('context.mcp-schema-tax (#1920)', () => {
  it('emits a dollarized context recommendation when duplicate servers are present', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('context.mcp-schema-tax');
    expect(rec?.category).toBe('context');
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.affected).toBe(1); // one redundant server
    expect(rec?.savingsAttribution?.tier).toBe('tier-0-estimate');
  });

  it('surfaces the MCP-schema token share in the breakdown (auditable)', () => {
    const rec = detector.rule(input(), 0);
    // 30 redundant of 60 total schemas → 50% share, both token counts present.
    expect(rec?.detail).toMatch(/50% of the/);
    expect(rec?.detail).toMatch(/tokens\/tool/);
    expect(rec?.evidence?.some((e) => e.includes('githubmcp'))).toBe(true);
  });

  it('bills each session for its OWN tool count, not the cross-session union (#3184)', () => {
    // github + githubmcp are a duplicate pair. githubmcp exposes 30 tools in s1
    // but only 10 in s2 — the old code charged the union (30) to BOTH sessions,
    // over-billing s2. Each session must be billed for the schemas IT loaded.
    const TOKENS_PER_TOOL_SCHEMA = 120; // mirrors the detector proxy
    const shared = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    const s1Inv: ToolInventory = {
      sessionId: 's1',
      toolsAvailable: [
        ...shared.map((t) => `mcp__github__${t}`),
        ...shared.map((t) => `mcp__githubmcp__${t}`), // 30 in s1
      ],
      toolsUsed: [],
      unusedTools: [],
      utilizationPct: 0,
    };
    const s2Inv: ToolInventory = {
      sessionId: 's2',
      toolsAvailable: [
        ...shared.map((t) => `mcp__github__${t}`),
        ...shared.slice(0, 10).map((t) => `mcp__githubmcp__${t}`), // only 10 in s2
      ],
      toolsUsed: [],
      unusedTools: [],
      utilizationPct: 0,
    };
    const td: SessionTokenData[] = [
      { sessionId: 's1', entries: Array.from({ length: 50 }, entry) } as unknown as SessionTokenData,
      { sessionId: 's2', entries: Array.from({ length: 50 }, entry) } as unknown as SessionTokenData,
    ];
    const rec = detector.rule(
      input({
        toolInventories: [s1Inv, s2Inv],
        tokenData: td,
        liveConfig: liveConfig(['github', 'githubmcp']),
      }),
      0
    );
    expect(rec).not.toBeNull();

    // Expected = each session's OWN githubmcp schema count x write/read-turn
    // pricing (write once + read on turns 2..N), summed. s1 own=30, s2 own=10.
    const rates = getModelPricing('claude-opus-4-7');
    const perSession = (tools: number, turns: number) =>
      ((tools * TOKENS_PER_TOOL_SCHEMA) / 1_000_000) *
      (rates.cacheWrite5m + rates.cacheRead * (turns - 1));
    const expected = perSession(30, 50) + perSession(10, 50);
    expect(rec!.estSavingsUsd).toBeCloseTo(expected, 9);
    // …strictly less than the old union-count bill (30 charged to BOTH sessions).
    const unionBill = perSession(30, 50) + perSession(30, 50);
    expect(rec!.estSavingsUsd!).toBeLessThan(unionBill);

    // Copy no longer claims a cache read on the first turn.
    expect(rec!.detail).toMatch(/written once and cache-read on later turns/i);
    expect(rec!.detail).not.toMatch(/cache-read every turn/i);
  });

  it('discloses the unique-tool loss caveat when overlap is partial', () => {
    // github: 45 tools (larger → keep); gh: 30 shared + 10 unique = 40 → 75% overlap.
    const partialInv: ToolInventory[] = [
      {
        sessionId: 's1',
        toolsAvailable: [
          ...Array.from({ length: 45 }, (_, i) => `mcp__github__tool_${i}`),
          ...Array.from({ length: 30 }, (_, i) => `mcp__gh__tool_${i}`),
          ...Array.from({ length: 10 }, (_, i) => `mcp__gh__only_${i}`),
        ],
        toolsUsed: [],
        unusedTools: [],
        utilizationPct: 0,
      },
    ];
    const rec = detector.rule(
      input({
        toolInventories: partialInv,
        tokenData: [
          { sessionId: 's1', entries: Array.from({ length: 50 }, entry) } as unknown as SessionTokenData,
        ],
        liveConfig: liveConfig(['github', 'gh']),
      }),
      0
    );
    expect(rec?.detail).toMatch(/unique to the redundant server/);
    expect(rec?.detail).toMatch(/verify before removing/);
    expect(rec?.action).toMatch(/no tool the kept server lacks/);
  });

  it('suppresses a redundant server already removed from the live config (stale-input)', () => {
    // githubmcp gone from ~/.claude.json → nothing actionable left.
    const rec = detector.rule(input({ liveConfig: liveConfig(['github']) }), 0);
    expect(rec).toBeNull();
  });

  it('stays silent when there are no duplicate servers', () => {
    const rec = detector.rule(
      input({ toolInventories: [inv('s1', ['github'])] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('stays silent with no tool inventories', () => {
    expect(detector.rule(input({ toolInventories: [] }), 0)).toBeNull();
  });
});
