import { describe, it, expect } from 'vitest';
import { detector, routingInference } from './model-routing-rollup';
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

function trivialFixture(sessionId: string, turns: number, version?: string): {
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
    version,
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

  // ── #3199: no "without quality loss" guarantee on footprint-only evidence ──
  it('describes routing as a low-confidence candidate requiring validation, with NO quality guarantee (#3199)', () => {
    const { tokenData, timeline } = trivialFixture('s1', 24);
    const rec = detector.rule(input({ tokenData: [tokenData], timelines: [timeline] }), 0)!;
    const inference = rec.provenance!.inference!;
    // The removed guarantee must be gone…
    expect(inference).not.toMatch(/without quality loss/i);
    // …and the dollar figure explicitly hedged as a ceiling, not a guarantee.
    expect(inference).toMatch(/not a guaranteed saving/i);
    // …and replaced with an explicit low-confidence + quality-validation caveat.
    expect(inference).toMatch(/candidate/i);
    expect(inference).toMatch(/replay|evaluat/i);
    expect(inference).toMatch(/quality/i);
    expect(inference).toMatch(/ceiling/i);
  });

  // ── #3405: no silent aggregation across the prompt-regime boundary ──
  it('demotes and annotates when contributing sessions span the prompt-regime boundary (#3405)', () => {
    const before = trivialFixture('s-before', 12, '2.1.217');
    const after = trivialFixture('s-after', 12, '2.1.220');
    const rec = detector.rule(
      input({
        tokenData: [before.tokenData, after.tokenData],
        timelines: [before.timeline, after.timeline],
      }),
      0
    )!;
    expect(rec).not.toBeNull();
    // Demoted: never a warning when the extrapolation mixes harness regimes.
    expect(rec.severity).toBe('info');
    // Annotated, not silent: the reader is told the projection crosses the cut.
    expect(rec.detail).toMatch(/spans a Claude Code prompt-regime change/);
    expect(rec.provenance!.inference).toMatch(/did not all run under the same Claude Code system prompt/);
    const regimeObs = rec.provenance!.observations.find(
      (o) => o.field === 'version (SessionTokenData) -> promptRegimeForVersion'
    );
    expect(regimeObs).toBeDefined();
    expect(regimeObs!.value).toBe('pre-claude-5,claude-5-short');
  });

  it('flags a possible crossing when a bracket-interior version contributes (#3405)', () => {
    const inside = trivialFixture('s-inside', 12, '2.1.218');
    const after = trivialFixture('s-after', 12, '2.1.220');
    const rec = detector.rule(
      input({
        tokenData: [inside.tokenData, after.tokenData],
        timelines: [inside.timeline, after.timeline],
      }),
      0
    )!;
    expect(rec.severity).toBe('info');
    expect(rec.detail).toMatch(/too close to a prompt-regime change to place/);
    const regimeObs = rec.provenance!.observations.find(
      (o) => o.field === 'version (SessionTokenData) -> promptRegimeForVersion'
    );
    expect(regimeObs!.value).toBe('claude-5-short,indeterminate');
  });

  it('leaves a single-regime window unannotated (#3405)', () => {
    const a = trivialFixture('s-a', 12, '2.1.220');
    const b = trivialFixture('s-b', 12, '2.1.221');
    const rec = detector.rule(
      input({
        tokenData: [a.tokenData, b.tokenData],
        timelines: [a.timeline, b.timeline],
      }),
      0
    )!;
    expect(rec).not.toBeNull();
    expect(rec.detail).not.toMatch(/regime/i);
    expect(
      rec.provenance!.observations.some(
        (o) => o.field === 'version (SessionTokenData) -> promptRegimeForVersion'
      )
    ).toBe(false);
  });

  it('permits stronger wording ONLY when structured quality-result provenance is present (#3199)', () => {
    const footprintOnly = routingInference(false);
    const withQuality = routingInference(true);
    // Footprint-only: hedged, requires a quality check, no guarantee.
    expect(footprintOnly).toMatch(/not proven safe|requires a replay\/evaluation/i);
    expect(footprintOnly).not.toMatch(/without quality loss/i);
    // With structured quality provenance: the stronger form is allowed and drops
    // the "not proven safe … requires a replay/evaluation" hedge.
    expect(withQuality).not.toMatch(/not proven safe/i);
    expect(withQuality).toMatch(/structured quality-result evidence/i);
    // The two forms are genuinely different wording, not the same string.
    expect(withQuality).not.toBe(footprintOnly);
    // The footprint detector itself never carries quality provenance, so its
    // emitted inference is exactly the footprint-only form.
    const { tokenData, timeline } = trivialFixture('s1', 24);
    const rec = detector.rule(input({ tokenData: [tokenData], timelines: [timeline] }), 0)!;
    expect(rec.provenance!.inference).toBe(footprintOnly);
  });
});
