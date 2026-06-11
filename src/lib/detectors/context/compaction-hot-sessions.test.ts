import { describe, it, expect } from 'vitest';
import { detector } from './compaction-hot-sessions';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade, scopeKeyOf } from '../../reclaim';
import { reclaimableCacheWriteFrac } from '../../context-health';

// A session whose single turn already sits near the 200K window and that has
// compacted twice → high compaction-risk band. `writes`/`reads` set the
// session-level cache totals `computeCacheEfficiency` reads, so the reclaim claim
// can ground its deletable fraction in the measured hit-rate.
const hot = (id: string, writes = 0, reads = 0): SessionTokenData =>
  ({
    sessionId: id,
    totalOutputTokens: 5000,
    totalCacheCreationTokens: writes,
    totalCacheReadTokens: reads,
    entries: [
      {
        timestamp: 't', model: 'claude-sonnet-4-6',
        inputTokens: 180_000, outputTokens: 5_000,
        cacheCreationTokens: writes, cacheCreation1hTokens: 0, cacheReadTokens: reads,
        webSearchRequests: 0, webFetchRequests: 0,
      },
    ],
    compactionEvents: [{}, {}],
  } as unknown as SessionTokenData);

const input = (tokenData: SessionTokenData[], claudeMd?: string): RecommendationInput => ({
  tokenData, toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  timelines: [],
  liveConfig: claudeMd ? ({ claudeMd: { global: claudeMd } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('context.compaction-hot-sessions (#415)', () => {
  it('fires when 2+ sessions are in the hot band', () => {
    const rec = detector.rule(input([hot('s1'), hot('s2')]), 0);
    expect(rec?.id).toBe('context.compaction-hot-sessions');
    expect(rec?.fix?.target).toBe('CLAUDE.md');
  });
  it('self-suppresses on the context-discipline CLAUDE.md note', () => {
    const md =
      '## Context discipline\n- Run `/compact` at sub-task boundaries rather than letting context grow until it auto-compacts.';
    expect(detector.rule(input([hot('s1'), hot('s2')], md), 0)).toBeNull();
  });
  it('stays silent with no token data', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  // ── Reclaim claim (epic #944, PR3 / #949) ────────────────────────────────
  describe('reclaim claim (#949)', () => {
    it('emits a context scaleTokens claim on the cache-write pools the cascade books', () => {
      // Both hot sessions write 1M cache and read back nothing → hitRate 0 →
      // frac = 1.0 (the whole shortfall below the reuse floor).
      const td = [hot('s1', 1_000_000, 0), hot('s2', 1_000_000, 0)];
      const rec = detector.rule(input(td), 0);
      expect(rec?.reclaim).toBeDefined();
      expect(rec!.reclaim!.category).toBe('context');
      expect(rec!.reclaim!.cause).toBe('structural-prefix');
      // Structural band [40,90).
      expect(rec!.reclaim!.orderKey).toBeGreaterThanOrEqual(40);
      expect(rec!.reclaim!.orderKey).toBeLessThan(90);
      expect(rec!.reclaim!.counterfactual.kind).toBe('scaleTokens');
      expect(rec!.reclaim!.ownedPools).toEqual(['cacheWrite5m', 'cacheWrite1h']);
      expect(rec!.reclaim!.scopeKeys).toContain(scopeKeyOf('s1', 'claude-sonnet-4-6'));

      const result = runReclaimCascade([rec!.reclaim!], td);
      const booked = result.booked[0];
      expect(booked.rejected).toBe(false);
      // hitRate 0 ⇒ frac 1.0 ⇒ deletes the whole cache-write cost of both sessions.
      expect(booked.marginalUsd).toBeGreaterThan(0);
      // Identity holds.
      expect(result.total).toBeCloseTo(result.billOriginal - result.billFinal, 9);
      expect(booked.marginalUsd).toBeCloseTo(result.total, 9);
    });

    it('derives poolDeltaFrac from computeCacheEfficiency, not a constant: higher hit-rate ⇒ smaller delta', () => {
      const lowHit = detector.rule(input([hot('a1', 1_000_000, 200_000), hot('a2', 1_000_000, 200_000)]), 0);
      const higherHit = detector.rule(input([hot('b1', 1_000_000, 700_000), hot('b2', 1_000_000, 700_000)]), 0);
      const fLow = (lowHit!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> }).poolDeltaFrac
        .cacheWrite5m;
      const fHigh = (higherHit!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> })
        .poolDeltaFrac.cacheWrite5m;
      expect(fLow).toBeGreaterThan(fHigh);
      // The frac is exactly the grounded helper of the measured hit-rate.
      expect(fLow).toBeCloseTo(reclaimableCacheWriteFrac(200_000 / 1_200_000), 9);
      expect(fHigh).toBeCloseTo(reclaimableCacheWriteFrac(700_000 / 1_700_000), 9);
    });

    it('omits the claim when a hot cohort already reuses its cache (hitRate at/above the floor)', () => {
      // hitRate = 900K/(900K+1M) = 0.47... still below floor → still has a claim;
      // push reads up so hitRate clears the 0.5 floor → frac 0 → no token claim.
      const td = [hot('s1', 1_000_000, 1_200_000), hot('s2', 1_000_000, 1_200_000)];
      const rec = detector.rule(input(td), 0);
      expect(rec?.id).toBe('context.compaction-hot-sessions');
      expect(rec?.reclaim).toBeUndefined();
    });
  });
});
