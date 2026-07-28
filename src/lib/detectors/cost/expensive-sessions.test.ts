/**
 * cost.expensive-sessions — concentration is the claim; recoverability is not
 * (#3196).
 *
 * This detector had no test file of its own. It previously assigned the FULL
 * observed cost of the top three sessions to `estSavingsUsd`, which asserts
 * that session-scoping guidance eliminates 100% of their spend. It measures
 * concentration, not waste, and most of that spend is work the user wanted.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './expensive-sessions';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData } from '../../parse-tools';

const session = (sessionId: string, outputTokens: number): SessionTokenData =>
  ({
    sessionId,
    totalOutputTokens: outputTokens,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens: 0,
        outputTokens,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  }) as unknown as SessionTokenData;

const toolData: ToolUsageData[] = [];
const input = (tokenData: SessionTokenData[]): RecommendationInput => ({
  tokenData, toolData, sessions: [], projects: [], permissionRows: [],
  apiErrors: [], liveConfig: null,
});

// Three dominant sessions plus a tail of cheap ones: concentrated spend.
const concentrated = [
  session('big-1', 400_000),
  session('big-2', 300_000),
  session('big-3', 300_000),
  session('small-1', 1_000),
  session('small-2', 1_000),
  session('small-3', 1_000),
];

describe('cost.expensive-sessions (#3196)', () => {
  it('reports the concentration it actually measures', () => {
    const rec = detector.rule(input(concentrated), 0);
    expect(rec?.id).toBe('cost.expensive-sessions');
    expect(rec?.detail).toMatch(/top 3 sessions account for \d+% of total estimated spend/);
    expect(rec?.affected).toBe(3);
    expect(rec?.evidence?.length).toBe(3);
  });

  it('books no saving from observed spend', () => {
    const rec = detector.rule(input(concentrated), 0);
    // The regression this pins: estSavingsUsd used to be the entire observed
    // cost of those three sessions, i.e. a claim that scoping guidance recovers
    // all of it. No waste classifier, baseline, or counterfactual exists here.
    expect(rec?.estSavingsUsd).toBeUndefined();
  });

  it('stays dark when spend is evenly spread', () => {
    // 16 equal sessions puts the top three at 18.75%, under the 25% floor.
    // (8 would be 37.5% and still concentrated — the detector is right there.)
    const even = Array.from({ length: 16 }, (_, i) => session(`s${i}`, 100_000));
    expect(detector.rule(input(even), 0)).toBeNull();
  });
});
