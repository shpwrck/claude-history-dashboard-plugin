import { describe, it, expect } from 'vitest';
import { detector } from './low-cache-hit';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { LOW_HIT_RATE } from '../../context-health';

// A session with the given cache-write / cache-read totals. `computeCacheEfficiency`
// reads the session-level totals; the per-entry cache-write tokens are set to the
// same `writes` so the session's aggregate reuse ratio is well-defined.
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

  // ── Provenance (#3183) ───────────────────────────────────────────────────
  describe('provenance', () => {
    const lowSession = (id: string) => session(id, 'claude-opus-4-8', 1_000_000, 100_000);
    const warmSession = (id: string) => session(id, 'claude-opus-4-8', 1_000_000, 2_000_000);

    it('passes the contract when it fires', () => {
      const rec = detector.rule(input([lowSession('s1')]), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('counts against sessions with cache traffic, not the whole fleet', () => {
      // A warm session belongs in the denominator (it HAS a hit rate); it must
      // not be counted as affected.
      const rec = detector.rule(input([lowSession('s1'), warmSession('s2')]), 0);
      const head = rec!.provenance!.observations[0];
      expect(head.value).toBe(1);
      expect(head.claim).toContain('of 2 session(s) with any cache traffic');
      expect(head.field).toBe('hitRate');
    });

    it('cites the floor and the measured mean against their own fields', () => {
      const rec = detector.rule(input([lowSession('s1')]), 0);
      const obs = rec!.provenance!.observations;
      const floor = obs.find((o) => o.field === 'LOW_HIT_RATE');
      expect(floor?.value).toBe(LOW_HIT_RATE);
      const mean = obs.find((o) => o.claim.includes('mean hit rate'));
      expect(mean).toBeDefined();
      expect(Number(mean!.value)).toBeCloseTo(100_000 / 1_100_000, 4);
    });

    it('reproduces the cited rate from the cited field — more reads, higher rate', () => {
      const meanOf = (reads: number) => {
        const rec = detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, reads)]), 0);
        return Number(rec!.provenance!.observations.find((o) => o.claim.includes('mean hit rate'))!.value);
      };
      expect(meanOf(400_000)).toBeGreaterThan(meanOf(100_000));
    });

    it('makes no reclaimable %/$ claim — only the measured reuse ratio (#3121)', () => {
      const rec = detector.rule(input([lowSession('s1')]), 0);
      // No reclaim claim: aggregate hit-rate cannot substantiate a reclaimable
      // cache-write fraction or dollar amount (there is no per-prefix lineage).
      expect(rec!.reclaim).toBeUndefined();
      // The inference disclaims any reclaimable amount and labels hitRate a heuristic.
      expect(rec!.provenance!.inference).toMatch(/no reclaimable/i);
      expect(rec!.provenance!.inference).toMatch(/heuristic signal/i);
      // No observation asserts a reclaimable fraction / dollar saving.
      const claims = rec!.provenance!.observations.map((o) => o.claim).join(' ');
      expect(claims).not.toMatch(/reclaim/i);
      expect(claims).not.toMatch(/\$/);
    });
  });

  it('self-suppresses on the cache-warm CLAUDE.md note', () => {
    const md =
      '## Keep the prompt cache warm\n\nCache hits require a stable context prefix, so avoid churning it mid-session.';
    expect(
      detector.rule(input([session('s1', 'claude-opus-4-8', 1_000_000, 100_000)], md), 0)
    ).toBeNull();
  });

  // ── No reclaimable %/$ from aggregate hit-rate (#3121) ─────────────────────
  describe('no reclaimable %/$ claim (#3121)', () => {
    it('emits no reclaim claim regardless of the read total — aggregate totals cannot substantiate one', () => {
      // The counter-example the finding calls out: aggregate reads/writes cannot
      // tell WHICH written prefixes were read, so a repeated read of one prefix
      // must not certify the other written units as (non-)reclaimable. Whatever
      // the totals, the detector emits NO reclaim claim.
      for (const reads of [0, 100_000, 900_000]) {
        const rec = detector.rule(
          input([session('s1', 'claude-opus-4-8', 1_000_000, reads)]),
          0
        );
        if (!rec) continue; // above the reuse floor it simply stays silent
        expect(rec.reclaim).toBeUndefined();
      }
    });

    it('still surfaces the measured reuse ratio as a labeled heuristic signal', () => {
      const rec = detector.rule(
        input([session('s1', 'claude-opus-4-8', 1_000_000, 100_000)]),
        0
      );
      const hitRateObs = rec!.provenance!.observations.filter(
        (o) => o.field === 'hitRate'
      );
      expect(hitRateObs.length).toBeGreaterThan(0);
      // The reuse ratio still moves with the reads (heuristic, not a savings %):
      // more reads ⇒ a higher measured mean hit rate.
      const meanOf = (reads: number) =>
        Number(
          detector
            .rule(input([session('s1', 'claude-opus-4-8', 1_000_000, reads)]), 0)!
            .provenance!.observations.find((o) => o.claim.includes('mean hit rate'))!.value
        );
      expect(meanOf(400_000)).toBeGreaterThan(meanOf(100_000));
    });
  });
});
