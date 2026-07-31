import { describe, it, expect } from 'vitest';
import { detector } from './legacy-model-overpay';
import { validateRecommendationProvenance } from '../provenance';
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

// ---------------------------------------------------------------------------
// #3194 — structured provenance: the rate-delta claim is reproducible.
// ---------------------------------------------------------------------------

describe('cost.legacy-model-overpay provenance (#3194)', () => {
  const LEGACY = 'claude-opus-4-1-20250414';

  it('passes the repository provenance validator', () => {
    const rec = detector.rule(input([session('s1', LEGACY, 1_000_000)]), 0)!;
    expect(rec.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('cites the token volume and both registry rates, and reproduces the delta', () => {
    const rec = detector.rule(input([session('s1', LEGACY, 1_000_000)]), 0)!;
    const tokens = rec.provenance!.observations.find((o) => o.source === 'parse-sessions');
    expect(tokens?.value).toBe(1_000_000);
    const rates = rec.provenance!.observations.filter((o) => o.source === 'pricing.ts');
    expect(rates.length).toBe(2);
    const overpay = rec.provenance!.derivations!.find((d) => d.id === 'input-overpay-usd')!;
    expect(
      ((overpay.operands.legacyInputTokens as number) / 1e6) *
        ((overpay.operands.legacyInputUsdPerMTok as number) -
          (overpay.operands.currentInputUsdPerMTok as number))
    ).toBeCloseTo(rec.estSavingsUsd!, 10);
    expect(overpay.value).toBeCloseTo(rec.estSavingsUsd!, 10);
    // The registry-rate observations are the derivation's own operands.
    expect(rates.map((o) => o.value)).toContain(overpay.operands.legacyInputUsdPerMTok);
    expect(rates.map((o) => o.value)).toContain(overpay.operands.currentInputUsdPerMTok);
  });

  it('keeps the same-capability-tier reasoning in the inference', () => {
    const rec = detector.rule(input([session('s1', LEGACY, 1_000_000)]), 0)!;
    expect(rec.provenance!.inference).toMatch(/same capability tier/i);
    expect(rec.provenance!.inference).toMatch(/pricing-object identity/i);
  });

  it('omits asOf for undated entries, dates and demotes for dated ones', () => {
    const undated = detector.rule(input([session('s1', LEGACY, 1_000_000)]), 0)!;
    expect(undated.provenance!.asOf).toBeUndefined();
    expect(undated.provenance!.stale).toBeUndefined();

    const dated = session('s1', LEGACY, 1_000_000);
    (dated.entries[0] as { timestamp?: string }).timestamp = '2026-06-09T12:00:00.000Z';
    const fresh = detector.rule(input([dated]), Date.parse('2026-06-10T00:00:00.000Z'))!;
    expect(fresh.provenance!.asOf).toBe('2026-06-09');
    expect(fresh.provenance!.stale).toBe(false);

    const stale = detector.rule(input([dated]), Date.parse('2026-12-01T00:00:00.000Z'))!;
    expect(stale.provenance!.stale).toBe(true);
    expect(stale.detail).toMatch(/^As of 2026-06-09/);
    expect(validateRecommendationProvenance(stale)).toEqual([]);
  });
});
