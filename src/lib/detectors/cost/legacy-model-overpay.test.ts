import { describe, it, expect } from 'vitest';
import { detector } from './legacy-model-overpay';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade } from '../../reclaim';
import { CURRENT_MODEL_IDS } from '../../model-registry';

function session(id: string, model: string, inputTokens: number): SessionTokenData {
  return {
    sessionId: id,
    entries: [
      {
        model,
        inputTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      } as never,
    ],
  } as unknown as SessionTokenData;
}

function input(
  tokenData: SessionTokenData[],
  model?: string
): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: model
      ? ({ settings: { model } } as unknown as RecommendationInput['liveConfig'])
      : null,
  };
}

describe('cost.legacy-model-overpay (#413)', () => {
  it('fires on legacy Opus spend above the floor and re-prices input tokens', () => {
    // 1M input tokens at $10/MTok delta = $10 of overpay.
    const rec = detector.rule(
      input([session('s1', 'claude-opus-4-1-20250414', 1_000_000)]),
      0
    );
    expect(rec?.id).toBe('cost.legacy-model-overpay');
    expect(rec?.severity).toBe('warning');
    expect(rec?.estSavingsUsd).toBeCloseTo(10, 5);
    expect(rec?.fix?.snippet).toContain(CURRENT_MODEL_IDS.opus);
  });

  it('ignores current-tier Opus and stays below the floor for tiny spend', () => {
    expect(detector.rule(input([session('s1', 'claude-opus-4-7', 5_000_000)]), 0)).toBeNull();
    expect(detector.rule(input([session('s1', 'claude-opus-4-1-20250414', 1000)]), 0)).toBeNull();
  });

  it('emits a reclaim claim the cascade books at the same marginal (#947)', () => {
    // Real detector output → cascade. The booked marginal must equal the
    // detector's own estSavingsUsd ($10 of legacy-Opus input overpay).
    const td = [session('s1', 'claude-opus-4-1-20250414', 1_000_000)];
    const rec = detector.rule(input(td), 0);
    expect(rec?.reclaim).toBeDefined();
    expect(rec!.reclaim!.counterfactual.kind).toBe('reprice');
    expect(rec!.reclaim!.ownedPools).toEqual(['input']);

    const result = runReclaimCascade([rec!.reclaim!], td);
    const booked = result.booked[0];
    expect(booked.rejected).toBe(false);
    expect(booked.marginalUsd).toBeCloseTo(rec!.estSavingsUsd ?? 0, 5);
    expect(booked.marginalUsd).toBeCloseTo(10, 5);
  });

  it('self-suppresses once a non-legacy model is pinned', () => {
    const big = [session('s1', 'claude-opus-4-1-20250414', 1_000_000)];
    expect(detector.rule(input(big, 'claude-opus-4-7'), 0)).toBeNull();
    // …but a legacy pin does not suppress.
    expect(detector.rule(input(big, 'claude-opus-4-1-20250414'), 0)?.id).toBe(
      'cost.legacy-model-overpay'
    );
  });
});
