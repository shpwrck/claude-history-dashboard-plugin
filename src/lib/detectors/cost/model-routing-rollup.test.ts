import { describe, it, expect } from 'vitest';
import { detector } from './model-routing-rollup';
import { buildRecommendations, totalEstimatedSavings } from '../../recommendations';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, TokenEntry } from '../../../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';

// ── Fixtures: a session of N trivial Opus turns that each route to Haiku ──────
// A trivial turn = short prompt, no tools, output < 1000 tokens. Large INPUT on
// Opus vs Haiku makes each turn's routing savings material, so the rolled-up
// monthly figure clears the detector's $1/mo floor.

function tokenEntry(timestamp: string, inputTokens: number, outputTokens: number): TokenEntry {
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-opus-4-8',
    timestamp,
  } as unknown as TokenEntry;
}

function ts(i: number): string {
  // ~1s apart so the span stays < 1 day (estimateMonthlySavings → total*30).
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

function trivialFixture(sessionId: string, turns: number): {
  tokenData: SessionTokenData;
  timeline: SessionTimeline;
} {
  const entries: TokenEntry[] = [];
  const tlEntries: TimelineEntry[] = [];
  for (let i = 0; i < turns; i++) {
    const t = ts(i);
    tlEntries.push({ timestamp: t, kind: 'user', summary: 'fix a typo' } as TimelineEntry);
    entries.push(tokenEntry(t, 200_000, 900));
  }
  const tokenData = {
    sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-opus-4-8',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
  const timeline: SessionTimeline = {
    sessionId,
    startTime: tlEntries[0]?.timestamp ?? '',
    endTime: tlEntries[tlEntries.length - 1]?.timestamp ?? '',
    entries: tlEntries,
  };
  return { tokenData, timeline };
}

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    timelines: [],
    attribution: [],
    ...over,
  };
}

describe('cost.model-routing-rollup (#1165)', () => {
  it('emits a single summary cost recommendation that flows through buildRecommendations()', () => {
    const { tokenData, timeline } = trivialFixture('s1', 24);
    const recs = buildRecommendations(input({ tokenData: [tokenData], timelines: [timeline] }), 0);
    const routing = recs.filter((r) => r.id === 'cost.model-routing-rollup');
    expect(routing).toHaveLength(1); // ONE summary card, not one-per-turn
    expect(routing[0].category).toBe('cost');
    expect(routing[0].title).toMatch(/cheaper model/i);
    expect(routing[0].affected).toBeGreaterThanOrEqual(20);
    expect(routing[0].evidence?.length).toBeGreaterThan(0);
  });

  it('does NOT double-count: carries no estSavingsUsd and stays out of the reclaim total', () => {
    const { tokenData, timeline } = trivialFixture('s1', 24);
    const rec = detector.rule(input({ tokenData: [tokenData], timelines: [timeline] }), 0)!;
    expect(rec).not.toBeNull();
    expect(rec.estSavingsUsd).toBeUndefined();
    expect(rec.reclaim).toBeUndefined();
    // The deduped reclaim rollup ignores a routing rec entirely.
    expect(totalEstimatedSavings([rec])).toBe(0);
  });

  it('carries auditable provenance citing parse-model-recommendation', () => {
    const { tokenData, timeline } = trivialFixture('s1', 24);
    const rec = detector.rule(input({ tokenData: [tokenData], timelines: [timeline] }), 0)!;
    expect(rec.provenance?.observations[0].source).toBe('parse-model-recommendation');
    expect(rec.provenance?.observations.some((o) => o.field?.includes('estimateMonthlySavings'))).toBe(true);
  });

  it('stays dark on a transcript-free dataset (no timelines)', () => {
    expect(detector.rule(input({ tokenData: [trivialFixture('s1', 24).tokenData] }), 0)).toBeNull();
  });

  it('stays quiet on a sparse downgradable set (below the floor)', () => {
    const { tokenData, timeline } = trivialFixture('s1', 3);
    expect(detector.rule(input({ tokenData: [tokenData], timelines: [timeline] }), 0)).toBeNull();
  });
});
