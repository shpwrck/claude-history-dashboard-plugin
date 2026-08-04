import { describe, it, expect } from 'vitest';
import { detector } from './compaction-hot-sessions';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

// A session whose single turn already sits near the 200K window and that has
// compacted twice → high compaction-risk band. `writes`/`reads` set the
// session-level cache totals; the detector makes NO reclaimable %/$ claim from
// them (#3121), so they only exercise that no such claim leaks out.
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

  // ── Provenance (#3180) ───────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input([hot('s1'), hot('s2')]), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('reproduces the hot count and its denominator from the cited fields', () => {
      const rec = detector.rule(input([hot('s1'), hot('s2'), hot('s3')]), 0);
      const head = rec!.provenance!.observations[0];
      expect(head.value).toBe(rec!.affected);
      expect(head.value).toBe(3);
      expect(head.claim).toContain('of 3 scored session(s)');
      expect(head.field).toBe('riskClass');
    });

    it('cites the percent arm as a percentage, not a fraction', () => {
      const rec = detector.rule(input([hot('s1'), hot('s2')]), 0);
      const pct = rec!.provenance!.observations.find((o) => o.field === 'hotPercent');
      expect(pct).toBeDefined();
      expect(Number(pct!.value)).toBeGreaterThan(1);
      expect(Number(pct!.value)).toBeLessThanOrEqual(100);
    });

    it('attributes the 10-40K-per-event figure to documentation, not measurement', () => {
      // `detail` asserts "re-sends 10-40K tokens per event"; nothing here
      // measures the tokens any individual compaction re-sent.
      const rec = detector.rule(input([hot('s1'), hot('s2')]), 0);
      expect(rec!.detail).toContain('10–40K');
      expect(rec!.provenance!.inference).toMatch(/documented range/i);
      expect(rec!.provenance!.inference).toMatch(/does not measure/i);
    });

    it('says the risk band is forward-looking, not a record of compactions that happened', () => {
      const rec = detector.rule(input([hot('s1'), hot('s2')]), 0);
      expect(rec!.provenance!.inference).toMatch(/has not necessarily compacted yet/i);
    });
  });

  // ── No reclaimable %/$ claim (#3121) ─────────────────────────────────────
  describe('no reclaimable %/$ claim (#3121)', () => {
    it('emits no reclaim claim regardless of read totals — aggregate hit-rate cannot substantiate one', () => {
      // Whatever the cohort's aggregate reads/writes, they cannot identify WHICH
      // written prefixes were later read, so no reclaimable cache-write fraction
      // or dollar amount is derivable. The prior scaleTokens claim (#949) is gone;
      // the detector stays advisory across the whole hit-rate range.
      for (const reads of [0, 200_000, 700_000, 1_200_000]) {
        const rec = detector.rule(
          input([hot('s1', 1_000_000, reads), hot('s2', 1_000_000, reads)]),
          0
        );
        expect(rec?.id).toBe('context.compaction-hot-sessions');
        expect(rec?.reclaim).toBeUndefined();
      }
    });

    it('asserts no reclaimable %/$ anywhere in its provenance', () => {
      const rec = detector.rule(
        input([hot('s1', 1_000_000, 0), hot('s2', 1_000_000, 0)]),
        0
      );
      const claims = rec!.provenance!.observations.map((o) => o.claim).join(' ');
      expect(claims).not.toMatch(/reclaim/i);
      expect(claims).not.toMatch(/shortfall/i);
      expect(rec!.provenance!.inference).toMatch(/no reclaimable/i);
    });
  });
});
