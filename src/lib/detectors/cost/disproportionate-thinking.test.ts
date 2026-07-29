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

// ---------------------------------------------------------------------------
// #3198 — flagged-session aggregation was quadratic in session count.
//
// The total-output pass called `flagged.some(f => f.sessionId === d.sessionId)`
// for every tokenData row. `flagged` grows WITH tokenData (every session can be
// flagged), so membership work was O(rows x flagged) on exactly the histories
// worth analysing.
//
// The probe counts reads of `d.sessionId` rather than timing anything, so it is
// deterministic. In the old code that property is read INSIDE the `.some`
// callback — once per flagged entry per row, i.e. quadratically. A Set reads it
// once per row.
// ---------------------------------------------------------------------------
describe('cost.disproportionate-thinking — membership is linear (#3198)', () => {
  /** Session whose `sessionId` getter counts every read. */
  function countingSession(
    id: string,
    outputTokens: number,
    thinkingTokens: number,
    counter: { reads: number }
  ): SessionTokenData {
    const base = session(id, outputTokens, thinkingTokens) as Record<string, unknown>;
    delete base.sessionId;
    Object.defineProperty(base, 'sessionId', {
      get() {
        counter.reads += 1;
        return id;
      },
      enumerable: true,
    });
    return base as unknown as SessionTokenData;
  }

  function readsFor(n: number): { reads: number; affected: number | undefined } {
    const counter = { reads: 0 };
    // Every session is flagged, which is the worst case for the old scan.
    const rows = Array.from({ length: n }, (_, i) =>
      countingSession(`s${i}`, 100_000, 80_000, counter)
    );
    const rec = detector.rule(input(rows), 0);
    return { reads: counter.reads, affected: rec?.affected };
  }

  it('does not grow session-id reads quadratically as sessions double', () => {
    const small = readsFor(50);
    const large = readsFor(100);

    expect(small.affected).toBe(50);
    expect(large.affected).toBe(100);

    // Old behaviour: reads scale with n^2, so doubling n roughly quadruples
    // them (50 -> ~2,500+, 100 -> ~10,000+). Linear membership keeps the ratio
    // at ~2. Bound well below the quadratic ratio but above linear noise.
    const ratio = large.reads / small.reads;
    expect(ratio).toBeLessThan(3);

    // And in absolute terms: a small constant number of reads per session,
    // nowhere near the `n` reads per session the old scan performed.
    expect(large.reads).toBeLessThan(100 * 10);
  });

  it('reports the same totals it did before the index', () => {
    // Two flagged sessions with different output pools; the reclaim fraction
    // is derived from the flagged sessions' summed output, so an incorrect
    // membership test would move it.
    const rec = detector.rule(
      input([session('s1', 100_000, 80_000), session('s2', 200_000, 160_000)]),
      0
    );
    expect(rec?.affected).toBe(2);
    // recoverable = (80k + 160k) * 0.5 = 120k tokens @ $25/MTok = $3.00
    expect(rec?.estSavingsUsd).toBeCloseTo(3.0, 5);
    // totalThink 240k * 0.5 = 120k over totalOutput 300k = 0.4
    expect(rec?.reclaim?.counterfactual.poolDeltaFrac?.output).toBeCloseTo(0.4, 5);
  });
});
