import { describe, it, expect } from 'vitest';
import { detector } from './low-cache-hit';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade, scopeKeyOf } from '../../reclaim';
import { reclaimableCacheWriteFrac, LOW_HIT_RATE } from '../../context-health';

// A session with the given cache-write / cache-read totals. `computeCacheEfficiency`
// reads the session-level totals; the detector's reclaim claim scopes against the
// per-entry cache-write tokens, so both are set to `writes`.
const session = (id: string, model: string, writes: number, reads: number): SessionTokenData =>
  ({
    sessionId: id,
    totalCacheCreationTokens: writes,
    totalCacheReadTokens: reads,
    entries: [
      {
        timestamp: 't',
        model,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: writes,
        cacheCreation1hTokens: 0,
        cacheReadTokens: reads,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  } as unknown as SessionTokenData);

const input = (tokenData: SessionTokenData[], claudeMd?: string): RecommendationInput => ({
  tokenData,
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: claudeMd
    ? ({ claudeMd: { global: claudeMd } } as unknown as RecommendationInput['liveConfig'])
    : null,
});

describe('context.low-cache-hit (#949)', () => {
  it('fires on low-hit-rate sessions', () => {
    // hitRate = 100K/(100K+1M) ≈ 0.09 < LOW_HIT_RATE
    const rec = detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 100_000)]), 0);
    expect(rec?.id).toBe('context.low-cache-hit');
  });

  it('stays silent when every session reuses its cache above the floor', () => {
    // hitRate = 2M/(2M+1M) ≈ 0.67 > LOW_HIT_RATE
    expect(
      detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 2_000_000)]), 0)
    ).toBeNull();
  });

  it('self-suppresses on the cache-warm CLAUDE.md note', () => {
    const md =
      '## Keep the prompt cache warm\n\nCache hits require a stable context prefix, so avoid churning it mid-session.';
    expect(
      detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 100_000)], md), 0)
    ).toBeNull();
  });

  describe('reclaim claim', () => {
    it('emits a context scaleTokens claim on the cache-write pools the cascade books', () => {
      const td = [session('s1', 'claude-opus-4-8', 1_000_000, 0)]; // hitRate 0 → frac 1.0
      const rec = detector.rule(input(td), 0);
      expect(rec?.reclaim).toBeDefined();
      expect(rec!.reclaim!.leverId).toBe('context.low-cache-hit');
      expect(rec!.reclaim!.category).toBe('context');
      expect(rec!.reclaim!.cause).toBe('structural-prefix');
      expect(rec!.reclaim!.orderKey).toBeGreaterThanOrEqual(40);
      expect(rec!.reclaim!.orderKey).toBeLessThan(90);
      expect(rec!.reclaim!.counterfactual.kind).toBe('scaleTokens');
      expect(rec!.reclaim!.ownedPools).toEqual(['cacheWrite5m', 'cacheWrite1h']);
      expect(rec!.reclaim!.scopeKeys).toEqual([scopeKeyOf('s1', 'claude-opus-4-8')]);

      const result = runReclaimCascade([rec!.reclaim!], td);
      const booked = result.booked[0];
      expect(booked.rejected).toBe(false);
      expect(booked.marginalUsd).toBeGreaterThan(0);
      // Identity: sum(marginal) ≡ billOriginal − billFinal, residual ≥ 0.
      expect(result.total).toBeCloseTo(result.billOriginal - result.billFinal, 9);
      expect(booked.marginalUsd).toBeCloseTo(result.total, 9);
      expect(result.billFinal).toBeGreaterThanOrEqual(0);
    });

    it('grounds poolDeltaFrac in computeCacheEfficiency — NOT a hardcoded constant', () => {
      const fracOf = (rec: ReturnType<typeof detector.rule>): number =>
        (rec!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> }).poolDeltaFrac
          .cacheWrite5m;
      // Single low session: frac is EXACTLY the grounded helper of its hit-rate.
      const recA = detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 100_000)]), 0);
      expect(fracOf(recA)).toBeCloseTo(reclaimableCacheWriteFrac(100_000 / 1_100_000), 9);
      // No constant: assert it is not any round "magic" fraction.
      expect([0, 0.1, 0.25, 0.5, 0.75, 1]).not.toContain(fracOf(recA));
    });

    it('higher measured hit-rate yields a SMALLER claimed delta (monotonic)', () => {
      const fracOf = (rec: ReturnType<typeof detector.rule>): number =>
        (rec!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> }).poolDeltaFrac
          .cacheWrite5m;
      const lower = detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 50_000)]), 0); // hitRate ≈ 0.048
      const higher = detector.rule(input([session('s2', 'claude-opus-4-8', 1_000_000, 400_000)]), 0); // hitRate ≈ 0.286
      expect(fracOf(lower)).toBeGreaterThan(fracOf(higher));
    });

    it('books the same marginal whether claimed via the detector or computed directly', () => {
      const td = [session('s1', 'claude-opus-4-8', 1_000_000, 100_000)];
      const rec = detector.rule(input(td), 0);
      const result = runReclaimCascade([rec!.reclaim!], td);
      // Cache-write at the original rate × the grounded frac.
      const frac = reclaimableCacheWriteFrac(100_000 / 1_100_000);
      expect(frac).toBeGreaterThan(0);
      expect(frac).toBeLessThan(1);
      // The detector's frac equals the grounded helper — the SHORTFALL below the floor.
      expect(frac).toBeCloseTo((LOW_HIT_RATE - 100_000 / 1_100_000) / LOW_HIT_RATE, 9);
      expect(result.booked[0].marginalUsd).toBeCloseTo(result.total, 9);
    });
  });
});
