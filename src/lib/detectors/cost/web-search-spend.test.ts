import { describe, it, expect } from 'vitest';
import { detector } from './web-search-spend';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

function session(id: string, webSearchRequests: number): SessionTokenData {
  return {
    sessionId: id,
    model: 'claude-haiku-4-5-20251001',
    entries: [
      { model: 'claude-haiku-4-5-20251001', inputTokens: 1000, webSearchRequests } as never,
    ],
  } as unknown as SessionTokenData;
}

function input(
  tokenData: SessionTokenData[],
  claudeMd?: string
): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: claudeMd
      ? ({ claudeMd: { global: claudeMd } } as unknown as RecommendationInput['liveConfig'])
      : null,
  };
}

describe('cost.web-search-spend (#414)', () => {
  it('fires when search spend is material and a meaningful share of total', () => {
    // 60 searches × $0.01 = $0.60 over a near-zero token cost → high share.
    const rec = detector.rule(input([session('s1', 60)]), 0);
    expect(rec?.id).toBe('cost.web-search-spend');
    expect(rec?.estSavingsUsd).toBeCloseTo(0.6, 5);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
  });

  it('stays silent below the $0.50 search-cost floor', () => {
    expect(detector.rule(input([session('s1', 10)]), 0)).toBeNull();
  });

  it('self-suppresses once CLAUDE.md documents web-search discipline', () => {
    const md = '## Web-search discipline\n- prefer web_fetch for stable URLs';
    expect(detector.rule(input([session('s1', 60)], md), 0)).toBeNull();
  });
});
