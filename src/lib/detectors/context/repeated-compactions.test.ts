import { describe, it, expect } from 'vitest';
import { detector } from './repeated-compactions';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const sess = (id: string, compactions: number, inputTokens = 1000): SessionTokenData =>
  ({
    sessionId: id, totalOutputTokens: 1000,
    entries: [{ timestamp: '2026-06-09T12:00:00.000Z', model: 'claude-sonnet-4-6', inputTokens, outputTokens: 100, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0, webSearchRequests: 0, webFetchRequests: 0 }],
    compactionEvents: Array.from({ length: compactions }, () => ({})),
  } as unknown as SessionTokenData);

const input = (tokenData: SessionTokenData[], md?: string): RecommendationInput => ({
  tokenData, toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [], timelines: [],
  liveConfig: md ? ({ claudeMd: { global: md } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('context.repeated-compactions (#424)', () => {
  it('fires when 2+ sessions compacted twice', () => {
    expect(detector.rule(input([sess('s1', 2), sess('s2', 3)]), 0)?.id).toBe('context.repeated-compactions');
  });
  it('stays silent below threshold and when suppressed', () => {
    expect(detector.rule(input([sess('s1', 2), sess('s2', 1)]), 0)).toBeNull();
    expect(
      detector.rule(
        input(
          [sess('s1', 2), sess('s2', 2)],
          '## Session resets\n- split the remaining work into a new session'
        ),
        0
      )
    ).toBeNull();
  });

  // ── Provenance (#3188) ───────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input([sess('s1', 2), sess('s2', 3)]), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
      expect(rec!.provenance!.observations.length).toBeGreaterThan(0);
    });

    it('cites the true maximum compaction count, not the head of the risk-sorted list', () => {
      // `computeCompactionRisk` sorts by riskScore, NOT by compaction count. A
      // near-window session that compacted twice outranks a small session that
      // compacted five times, so reading "the most compacted" off rows[0] would
      // report 2 here. The cited value must be 5.
      const rec = detector.rule(
        input([
          sess('low-risk-many-compactions', 5, 2_000),
          sess('high-risk-few-compactions', 2, 190_000),
        ]),
        0
      );
      expect(rec).not.toBeNull();
      const maxObs = rec!.provenance!.observations.find((o) =>
        o.claim.includes('highest compaction count')
      );
      expect(maxObs, 'expected an observation citing the highest compaction count').toBeDefined();
      expect(maxObs!.value).toBe(5);
      expect(maxObs!.claim).toContain('low-risk');
      expect(maxObs!.field).toBe('compactionsObserved');
    });

    it('reproduces its cohort count from the cited field — mutating it moves the number', () => {
      const cited = (td: SessionTokenData[]) => {
        const rec = detector.rule(input(td), 0);
        return rec!.provenance!.observations[0].value;
      };
      expect(cited([sess('a', 2), sess('b', 2)])).toBe(2);
      // A third qualifying session moves the cited value with it.
      expect(cited([sess('a', 2), sess('b', 2), sess('c', 4)])).toBe(3);
      // A session below MIN_COMPACTIONS does not.
      expect(cited([sess('a', 2), sess('b', 2), sess('c', 1)])).toBe(2);
    });
  });
});
