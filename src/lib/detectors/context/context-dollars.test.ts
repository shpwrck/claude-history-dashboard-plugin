/**
 * Context dollarization integration (epic #944, PR3 / #949).
 *
 * The two context detectors (`low-cache-hit`, `compaction-hot-sessions`) now emit
 * `scaleTokens` `ReclaimClaim`s grounded in `computeCacheEfficiency`. This proves
 * that, run together through the guarded-marginal cascade:
 *  - the dollar identity `sum(marginal) ≡ billOriginal − billFinal` holds,
 *  - the `residual ≥ 0` invariant holds (no over-draw, no rejection), and
 *  - the per-category **context** coverage rises off 0 — the census moves off 0/7.
 */
import { describe, it, expect } from 'vitest';
import { detector as lowCacheHit } from './low-cache-hit';
import { detector as compactionHot } from './compaction-hot-sessions';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade, type ReclaimClaim } from '../../reclaim';

// A near-window, twice-compacted session with poor cache reuse (low hit-rate)
// and substantial cache-write — trips BOTH detectors.
const wasteful = (id: string, writes: number, reads: number): SessionTokenData =>
  ({
    sessionId: id,
    totalOutputTokens: 5000,
    totalCacheCreationTokens: writes,
    totalCacheReadTokens: reads,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-8',
        inputTokens: 180_000,
        outputTokens: 5_000,
        cacheCreationTokens: writes,
        cacheCreation1hTokens: 0,
        cacheReadTokens: reads,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [{}, {}],
  } as unknown as SessionTokenData);

const input = (tokenData: SessionTokenData[]): RecommendationInput => ({
  tokenData,
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  timelines: [],
  liveConfig: null,
});

describe('context dollars — both detectors through the cascade (#949)', () => {
  const td = [wasteful('s1', 1_000_000, 150_000), wasteful('s2', 1_000_000, 150_000)];

  const claims = (): ReclaimClaim[] => {
    const recs = [lowCacheHit.rule(input(td), 0), compactionHot.rule(input(td), 0)];
    return recs.flatMap((r) => (r?.reclaim ? [r.reclaim] : []));
  };

  it('both detectors emit a context claim', () => {
    const c = claims();
    expect(c.length).toBe(2);
    expect(c.every((x) => x.category === 'context')).toBe(true);
  });

  it('preserves the dollar identity and residual ≥ 0 with the new claims', () => {
    const rejects: string[] = [];
    const result = runReclaimCascade(claims(), td, (m) => rejects.push(m));
    // No over-draw / no rejection — every cell stayed ≥ 0.
    expect(rejects).toEqual([]);
    expect(result.booked.every((b) => !b.rejected)).toBe(true);
    // Identity holds exactly.
    const summed = result.booked.reduce((s, b) => s + b.marginalUsd, 0);
    expect(summed).toBeCloseTo(result.total, 9);
    expect(result.total).toBeCloseTo(result.billOriginal - result.billFinal, 9);
    expect(result.billFinal).toBeGreaterThanOrEqual(0);
  });

  it('lifts context coverage off zero (census moves off 0/7)', () => {
    const result = runReclaimCascade(claims(), td);
    const ctx = result.coverageByCategory.context;
    expect(ctx).toBeDefined();
    expect(ctx!.claimedUsd).toBeGreaterThan(0);
    expect(ctx!.coverage).toBeGreaterThan(0);
  });

  it('two overlapping context claims carve disjoint slices (no double-book)', () => {
    // Both claims own the same cache-write cells; the cascade must not book more
    // than the cells are worth.
    const result = runReclaimCascade(claims(), td);
    expect(result.total).toBeLessThanOrEqual(result.billOriginal + 1e-9);
  });
});
