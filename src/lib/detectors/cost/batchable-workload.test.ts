import { describe, it, expect } from 'vitest';
import { detector } from './batchable-workload';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade } from '../../reclaim';

const session = (
  sessionId: string,
  entrypoint: string | undefined,
  inputTokens: number,
  outputTokens: number
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-opus-4-7',
    messageCount: 10,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens,
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

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

describe('cost.batchable-workload (#1755)', () => {
  it('fires on token-heavy unattended sessions with a marginal input/output reclaim', () => {
    const rec = detector.rule(
      input({ tokenData: [session('s1', 'sdk-cli', 1_000_000, 200_000)] }),
      0
    );
    expect(rec?.id).toBe('cost.batchable-workload');
    expect(rec?.category).toBe('cost');
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.affected).toBe(1);
    expect(rec?.reclaim?.ownedPools).toEqual(['input', 'output']);
    // Stable late cost-lever order; automation-share's ceiling is not booked.
    expect(rec?.reclaim?.orderKey).toBeGreaterThan(80);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
    if (rec?.reclaim?.counterfactual.kind === 'scaleTokens') {
      expect(rec.reclaim.counterfactual.poolDeltaFrac.input).toBe(0.5);
      expect(rec.reclaim.counterfactual.poolDeltaFrac.output).toBe(0.5);
    }
  });

  it('books a positive marginal through the cascade and preserves the identity', () => {
    const td = [session('s1', 'sdk-cli', 1_000_000, 200_000)];
    const rec = detector.rule(input({ tokenData: td }), 0);
    const result = runReclaimCascade([rec!.reclaim!], td);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.cost).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('ignores interactive (cli) sessions — only unattended workloads are batchable', () => {
    const rec = detector.rule(
      input({ tokenData: [session('s1', 'cli', 1_000_000, 200_000)] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('ignores unattended sessions below the token-heavy floor', () => {
    const rec = detector.rule(
      input({ tokenData: [session('s1', 'sdk-cli', 1_000, 500)] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('marks scheduled (cron) sessions as higher-confidence in the evidence', () => {
    const td = [session('s1', 'sdk-cli', 1_000_000, 200_000)];
    const runtimeEvents = [
      { sessionId: 's1', turns: [], stopHooks: [], awaySummaries: [], scheduledFires: [{ sessionId: 's1', timestamp: 't', content: 'fired' }] },
    ] as unknown as RecommendationInput['runtimeEvents'];
    const rec = detector.rule(input({ tokenData: td, runtimeEvents }), 0);
    expect(rec?.detail).toMatch(/schedule/);
    expect(rec?.evidence?.some((e) => e.includes('(scheduled)'))).toBe(true);
  });
});
