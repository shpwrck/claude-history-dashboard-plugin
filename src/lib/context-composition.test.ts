import { describe, it, expect } from 'vitest';
import type { LiveConfig, SessionTokenData, TokenEntry } from '../types';
import {
  tokenizeConfigPrefix,
  composeSession,
  composeAggregate,
  totalTokens,
  type ComposableSession,
} from './context-composition';

function tokenEntry(over: Partial<TokenEntry>): TokenEntry {
  return {
    timestamp: '2026-06-24T00:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-sonnet-4-6',
    ...over,
  };
}

/** Build a ComposableSession; entries default to one carrying the billed totals. */
function session(over: Partial<ComposableSession>): ComposableSession {
  const base: ComposableSession = {
    entries: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalThinkingTokens: 0,
    messageCount: 1,
    contextHistoryTokensSum: 0,
    contextToolResultTokensSum: 0,
  };
  return { ...base, ...over };
}

describe('context-composition (#1926)', () => {
  describe('tokenizeConfigPrefix', () => {
    it('returns a zeroed, caveated estimate for null config', () => {
      const est = tokenizeConfigPrefix(null);
      expect(est.totalTokens).toBe(0);
      expect(est.caveat).toMatch(/lower bound/i);
      expect(est.caveat).toMatch(/drift/i);
    });

    it('counts CLAUDE.md, resource descriptions, and settings; flags unsizable MCP', () => {
      const liveConfig = {
        claudeMd: { global: 'x'.repeat(260), perProject: { '/p': 'y'.repeat(26) } },
        skills: [{ id: 's', scope: 'user', path: '/s', description: 'z'.repeat(52) }],
        subagents: [],
        commands: [],
        mcpServers: [
          { id: 'github', scope: 'global' },
          { id: 'playwright', scope: 'global' },
        ],
        settings: { model: 'opus' },
      } as unknown as LiveConfig;

      const est = tokenizeConfigPrefix(liveConfig);
      expect(est.breakdown.instructions).toBe(110); // ceil(260/2.6)+ceil(26/2.6)=100+10
      expect(est.breakdown.resourceDescriptions).toBe(20); // ceil(52/2.6)
      expect(est.breakdown.settings).toBeGreaterThan(0);
      expect(est.totalTokens).toBe(
        est.breakdown.instructions + est.breakdown.resourceDescriptions + est.breakdown.settings
      );
      expect(est.unsizableMcpServers).toBe(2);
      expect(est.caveat).toMatch(/2 MCP server/);
    });
  });

  describe('composeSession reconciliation (additive model)', () => {
    it('buckets always sum exactly to the billed total', () => {
      const s = session({
        entries: [tokenEntry({ inputTokens: 100, cacheReadTokens: 5000, outputTokens: 800 })],
        totalInputTokens: 100,
        totalCacheReadTokens: 5000,
        totalOutputTokens: 800,
        totalThinkingTokens: 300,
        messageCount: 1,
        contextHistoryTokensSum: 1200,
        contextToolResultTokensSum: 3000,
      });
      const c = composeSession(s, /* per-turn prefix */ 500);
      const billed = 100 + 5000 + 800;
      expect(totalTokens(c.tokens)).toBeCloseTo(billed, 6);
      expect(c.billedInputTokens).toBe(5100);
      expect(c.billedOutputTokens).toBe(800);
    });

    it('multiplies the per-turn prefix by messageCount (re-sent every turn)', () => {
      const s = session({
        totalCacheReadTokens: 100_000,
        messageCount: 4,
        contextHistoryTokensSum: 1000,
        contextToolResultTokensSum: 2000,
      });
      const c = composeSession(s, 500);
      expect(c.tokens.systemPrefix).toBe(2000); // 500 * 4
      expect(c.tokens.conversationHistory).toBe(1000);
      expect(c.tokens.toolPayloads).toBe(2000);
      // residual absorbs the rest of the big billed input
      expect(c.tokens.unattributedResidual).toBe(100_000 - 2000 - 1000 - 2000);
    });

    it('scales input buckets down and zeroes residual on overshoot', () => {
      const s = session({
        totalCacheReadTokens: 1000, // small billed input
        messageCount: 1,
        contextHistoryTokensSum: 1500,
        contextToolResultTokensSum: 1500,
      });
      const c = composeSession(s, 1000); // raw 4000 > 1000
      expect(c.tokens.unattributedResidual).toBe(0);
      const inputSum =
        c.tokens.systemPrefix + c.tokens.conversationHistory + c.tokens.toolPayloads;
      expect(inputSum).toBeCloseTo(1000, 6);
      expect(c.tokens.systemPrefix).toBeCloseTo(250, 6); // 1000/4000 * 1000
    });

    it('reconciles thinking + visible output to billed output, clamped', () => {
      const s = session({ totalOutputTokens: 500, totalThinkingTokens: 900 });
      const c = composeSession(s, 0);
      expect(c.tokens.thinking).toBe(500);
      expect(c.tokens.visibleOutput).toBe(0);
    });

    it('apportions exact entry cost across buckets, output cost on output side only', () => {
      const s = session({
        entries: [
          tokenEntry({ inputTokens: 100, cacheReadTokens: 5000, outputTokens: 800 }),
        ],
        totalInputTokens: 100,
        totalCacheReadTokens: 5000,
        totalOutputTokens: 800,
        totalThinkingTokens: 300,
        contextHistoryTokensSum: 1200,
        contextToolResultTokensSum: 3000,
      });
      const c = composeSession(s, 500);
      for (const v of Object.values(c.cost)) expect(v).toBeGreaterThanOrEqual(0);
      expect(c.cost.thinking + c.cost.visibleOutput).toBeGreaterThan(0);
      expect(c.cost.systemPrefix).toBeGreaterThan(0);
    });
  });

  describe('composeAggregate', () => {
    it('sums sessions and stays anchored to the billed total', () => {
      const s = session({
        totalCacheReadTokens: 4000,
        totalOutputTokens: 500,
        messageCount: 2,
        contextHistoryTokensSum: 300,
        contextToolResultTokensSum: 2000,
      });
      const billed = 4000 + 500;
      expect(totalTokens(composeSession(s, 100).tokens)).toBeCloseTo(billed, 6);
      const agg = composeAggregate([s, s], 100);
      expect(totalTokens(agg.tokens)).toBeCloseTo(billed * 2, 6);
    });

    it('handles an empty session list without NaN', () => {
      const agg = composeAggregate([], 1000);
      expect(totalTokens(agg.tokens)).toBe(0);
      expect(Object.values(agg.cost).every((v) => v === 0)).toBe(true);
    });
  });
});

// Compile-time guard: SessionTokenData satisfies ComposableSession.
export const _typecheck = (s: SessionTokenData): ComposableSession => s;
