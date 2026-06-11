import { describe, it, expect } from 'vitest';
import { detector } from './priority-tier-spend';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const session = (id: string, serviceTier?: string): SessionTokenData =>
  ({ sessionId: id, serviceTier, entries: [] } as unknown as SessionTokenData);

function input(tokenData: SessionTokenData[]): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  };
}

describe('cost.priority-tier-spend (#426)', () => {
  it('fires (no fix, count-only) once enough sessions used the priority tier', () => {
    const rec = detector.rule(
      input([
        session('s1', 'priority'),
        session('s2', 'priority'),
        session('s3', 'priority'),
        session('s4', 'standard'),
      ]),
      0
    );
    expect(rec?.id).toBe('cost.priority-tier-spend');
    expect(rec?.affected).toBe(3);
    expect(rec?.fix).toBeUndefined();
    expect(rec?.estSavingsUsd).toBeUndefined();
  });

  it('stays silent below the session floor', () => {
    expect(detector.rule(input([session('s1', 'priority'), session('s2', 'priority')]), 0)).toBeNull();
  });
});
