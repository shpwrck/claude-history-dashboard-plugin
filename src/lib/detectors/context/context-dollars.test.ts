/**
 * Context detectors emit no reclaimable %/$ (#3121; reverts epic #944 PR3 / #949).
 *
 * The two context detectors (`low-cache-hit`, `compaction-hot-sessions`) used to
 * emit `scaleTokens` `ReclaimClaim`s whose deletable fraction came from the
 * aggregate cache hit-rate (`reclaimableCacheWriteFrac`). Aggregate token totals
 * cannot identify WHICH written prefixes were later read, so that fraction was
 * not evidence-backed or reproducible. Those claims are removed; this integration
 * proves neither detector puts a reclaimable fraction/dollar into the cascade —
 * both stay advisory and context reclaim coverage stays at 0.
 */
import { describe, it, expect } from 'vitest';
import { detector as lowCacheHit } from './low-cache-hit';
import { detector as compactionHot } from './compaction-hot-sessions';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade } from '../../reclaim';

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

describe('context detectors emit no reclaimable %/$ (#3121)', () => {
  const td = [wasteful('s1', 1_000_000, 150_000), wasteful('s2', 1_000_000, 150_000)];

  const recs = () => [lowCacheHit.rule(input(td), 0), compactionHot.rule(input(td), 0)];

  it('both detectors still fire as advisory findings', () => {
    expect(recs().every((r) => r != null)).toBe(true);
  });

  it('neither detector emits a reclaim claim', () => {
    // With the OLD code this collected 2 context scaleTokens claims; the
    // aggregate-hit-rate fraction is not evidence-backed, so it is now empty.
    const claims = recs().flatMap((r) => (r?.reclaim ? [r.reclaim] : []));
    expect(claims).toEqual([]);
  });

  it('books nothing for context — reclaim coverage stays at 0', () => {
    const claims = recs().flatMap((r) => (r?.reclaim ? [r.reclaim] : []));
    const result = runReclaimCascade(claims, td);
    expect(result.total).toBe(0);
    expect(result.coverageByCategory.context?.claimedUsd ?? 0).toBe(0);
  });
});
