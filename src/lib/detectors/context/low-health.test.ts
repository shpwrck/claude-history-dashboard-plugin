/**
 * Behavioral + provenance tests for context.low-health (#3183).
 *
 * The detector had no test file of its own, and its provenance names "the
 * worst session" — a claim that is only true because `scoreSessionHealth`
 * returns its scores sorted ASCENDING. That ordering is an implicit contract
 * between two modules, so it is pinned here rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './low-health';
import { validateRecommendationProvenance } from '../provenance';
import { LOW_HEALTH_SCORE, scoreSessionHealth } from '../../context-health';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

/**
 * A session with tunable health penalties. `peak` drives the two context
 * penalties (-20 past 100K, another -20 past 200K); `compactions` costs -10
 * each; writing cache with no reads back costs another -20 for low reuse.
 */
const session = (
  sessionId: string,
  opts: { peak: number; compactions?: number; reads?: number; writes?: number }
): SessionTokenData =>
  ({
    sessionId,
    totalOutputTokens: 500,
    totalCacheCreationTokens: opts.writes ?? 1_000,
    totalCacheReadTokens: opts.reads ?? 0,
    entries: [
      {
        timestamp: '2026-06-09T12:00:00.000Z',
        model: 'claude-sonnet-4-6',
        inputTokens: opts.peak,
        outputTokens: 500,
        cacheCreationTokens: opts.writes ?? 1_000,
        cacheCreation1hTokens: 0,
        cacheReadTokens: opts.reads ?? 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: Array.from({ length: opts.compactions ?? 0 }, () => ({})),
  }) as unknown as SessionTokenData;

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

/** Score 20: low reuse, two compactions, and a peak past both context lines. */
const unhealthy = (id: string) => session(id, { peak: 210_000, compactions: 2 });
/** Score 100: small, cache-warm, no compactions. */
const healthy = (id: string) => session(id, { peak: 5_000, reads: 9_000, writes: 1_000 });

describe('context.low-health', () => {
  it('fires when a session scores below the flag line', () => {
    const rec = detector.rule(input([unhealthy('s1')]), 0);
    expect(rec?.id).toBe('context.low-health');
    expect(rec?.affected).toBe(1);
  });

  it('stays silent when every session is above the line, and when suppressed', () => {
    expect(detector.rule(input([healthy('s1')]), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(
      detector.rule(
        input(
          [unhealthy('s1')],
          '## Keep the session healthy\n\n- Avoid switching permission modes mid-session; it churns context.'
        ),
        0
      )
    ).toBeNull();
  });

  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input([unhealthy('s1')]), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('relies on scoreSessionHealth returning ASCENDING scores', () => {
      // The "lowest score / that session's leading penalty" claims read low[0].
      // Pin the upstream ordering they depend on.
      const scores = scoreSessionHealth([
        session('mild', { peak: 150_000 }),
        session('severe', { peak: 260_000, compactions: 3 }),
      ]);
      expect(scores.map((s) => s.score)).toEqual([...scores.map((s) => s.score)].sort((a, b) => a - b));
    });

    it('cites the worst session, not merely the first one below the line', () => {
      const rec = detector.rule(
        input([
          session('mild', { peak: 150_000, compactions: 1 }), // -20 -10 => 70? still above
          session('severe', { peak: 260_000, compactions: 3 }),
          unhealthy('middling'),
        ]),
        0
      );
      expect(rec).not.toBeNull();
      const lowest = rec!.provenance!.observations.find((o) => o.claim.includes('lowest score'));
      expect(lowest, 'expected an observation citing the lowest score').toBeDefined();
      const scores = scoreSessionHealth(
        input([
          session('mild', { peak: 150_000, compactions: 1 }),
          session('severe', { peak: 260_000, compactions: 3 }),
          unhealthy('middling'),
        ]).tokenData
      ).filter((s) => s.score < LOW_HEALTH_SCORE);
      const trueMin = Math.min(...scores.map((s) => s.score));
      expect(lowest!.value).toBe(trueMin);
      expect(lowest!.field).toBe('score');
    });

    it('reproduces the affected count from the cited field', () => {
      const cited = (td: SessionTokenData[]) =>
        detector.rule(input(td), 0)!.provenance!.observations[0].value;
      expect(cited([unhealthy('a'), healthy('b')])).toBe(1);
      expect(cited([unhealthy('a'), unhealthy('b')])).toBe(2);
    });

    it('says out loud that the score is a heuristic, not a measured waste figure', () => {
      const rec = detector.rule(input([unhealthy('s1')]), 0);
      expect(rec!.provenance!.inference).toMatch(/heuristic/i);
      expect(rec!.provenance!.inference).toMatch(/not a measured quantity/i);
    });
  });
});
