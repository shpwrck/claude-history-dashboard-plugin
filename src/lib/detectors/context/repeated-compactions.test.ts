import { describe, it, expect } from 'vitest';
import { detector } from './repeated-compactions';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const sess = (id: string, compactions: number): SessionTokenData =>
  ({
    sessionId: id, totalOutputTokens: 1000,
    entries: [{ timestamp: 't', model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0, webSearchRequests: 0, webFetchRequests: 0 }],
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
});
