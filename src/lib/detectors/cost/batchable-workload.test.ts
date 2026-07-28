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
  /**
   * CHANGED in #3191. These two asserted a booked `scaleTokens` counterfactual
   * cutting 50% off the input/output pools of every large sdk-* session, and a
   * positive cascade marginal from it. That pinned the defect: the only
   * eligibility evidence is the unattended entrypoint (plus optional schedule
   * events), and neither shows the workload tolerates the Batch API's
   * up-to-24h turnaround. The detector's own action tells the user to confirm
   * that — the booking was made before the condition it rests on was checked.
   * The firing behaviour they also covered is preserved below.
   */
  it('fires on token-heavy unattended sessions, without booking a saving', () => {
    const rec = detector.rule(
      input({ tokenData: [session('s1', 'sdk-cli', 1_000_000, 200_000)] }),
      0
    );
    expect(rec?.id).toBe('cost.batchable-workload');
    expect(rec?.category).toBe('cost');
    expect(rec?.affected).toBe(1);
    // The opportunity is still surfaced, explicitly conditional...
    expect(rec?.detail).toContain('IF every one of these workloads tolerates async');
    // ...and nothing is booked.
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim?.counterfactual.kind).toBe('flag-only');
    expect(rec?.reclaim?.ownedPools).toEqual([]);
    expect(rec?.reclaim?.orderKey).toBeGreaterThan(80);
  });

  it('books nothing through the cascade while eligibility is unverified (#3191)', () => {
    const td = [session('s1', 'sdk-cli', 1_000_000, 200_000)];
    const rec = detector.rule(input({ tokenData: td }), 0);
    const result = runReclaimCascade([rec!.reclaim!], td);
    // A flag-only lever must move no money and leave the bill identity intact.
    expect(result.total).toBe(0);
    expect(result.billFinal).toBeCloseTo(result.billOriginal, 9);
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
