import { describe, it, expect } from 'vitest';
import { detector } from './disproportionate-thinking';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, TokenEntry } from '../../../types';

const MODEL = 'claude-opus-4-8';

function entry(outputTokens: number, thinkingTokens: number): TokenEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    inputTokens: 0,
    outputTokens,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    thinkingTokens,
    model: MODEL,
  };
}

function session(
  id: string,
  outputTokens: number,
  thinkingTokens: number
): SessionTokenData {
  return {
    sessionId: id,
    model: MODEL,
    totalOutputTokens: outputTokens,
    totalThinkingTokens: thinkingTokens,
    entries: [entry(outputTokens, thinkingTokens)],
  } as unknown as SessionTokenData;
}

function input(tokenData: SessionTokenData[]): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  } as unknown as RecommendationInput;
}

describe('cost.disproportionate-thinking (#1927)', () => {
  it('fires and dollarizes when thinking dwarfs visible output', () => {
    // output 100k, thinking 80k -> visible 20k, ratio 4.0 (>=2.0), well over floors.
    const rec = detector.rule(input([session('s1', 100_000, 80_000)]), 0);
    expect(rec?.id).toBe('cost.disproportionate-thinking');
    expect(rec?.category).toBe('cost');
    // recoverable = 80k * 0.5 = 40k tokens @ $25/MTok output = $1.00
    expect(rec?.estSavingsUsd).toBeCloseTo(1.0, 5);
    expect(rec?.affected).toBe(1);
    // Books against the output pool, scoped to (session|model).
    expect(rec?.reclaim?.ownedPools).toEqual(['output']);
    expect(rec?.reclaim?.scopeKeys).toContain(`s1|${MODEL}`);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
  });

  it('stays silent below the absolute thinking-token floor', () => {
    // Only 5k thinking — below MIN_THINKING_TOKENS even though the ratio is high.
    expect(detector.rule(input([session('s1', 6_000, 5_000)]), 0)).toBeNull();
  });

  it('stays silent when thinking share is proportionate to the work', () => {
    // 100k thinking but 400k visible output -> ratio 0.25, well under 2.0.
    expect(detector.rule(input([session('s1', 500_000, 100_000)]), 0)).toBeNull();
  });

  it('stays silent in the moderate band below the hardened 2x ratio (#2006)', () => {
    // out 100k, thinking 66k -> visible 34k, ratio ~1.94 < 2.0. Would have fired
    // under the old 1.5x bar; the hardened threshold suppresses the noisy middle.
    expect(detector.rule(input([session('s1', 100_000, 66_000)]), 0)).toBeNull();
  });

  it('stays silent when visible output is trivial, even at an extreme ratio (#2006)', () => {
    // out 25k, thinking 24k -> visible 1k < MIN_VISIBLE_TOKENS. Ratio is huge but
    // there is almost no real work, where the per-message estimate is least
    // reliable — do not flag.
    expect(detector.rule(input([session('s1', 25_000, 24_000)]), 0)).toBeNull();
  });

  it('ignores sessions with no reconstructed thinking', () => {
    expect(detector.rule(input([session('s1', 100_000, 0)]), 0)).toBeNull();
  });
});
