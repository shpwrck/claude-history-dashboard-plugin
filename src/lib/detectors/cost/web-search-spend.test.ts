import { describe, it, expect } from 'vitest';
import { detector, AVOIDABLE_SEARCH_FRACTION } from './web-search-spend';
import { validateRecommendationProvenance } from '../provenance';
import { runReclaimCascade } from '../../reclaim';
import { SERVER_TOOL_PRICING } from '../../pricing';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

function session(
  id: string,
  webSearchRequests: number,
  timestamp = '2026-06-09T12:00:00.000Z'
): SessionTokenData {
  return {
    sessionId: id,
    model: 'claude-haiku-4-5-20251001',
    entries: [
      {
        timestamp,
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests,
        webFetchRequests: 0,
      } as never,
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

// ---------------------------------------------------------------------------
// #3508 — the booked figure must not be the full observed search spend.
//
// `searchCost` is what was SPENT on search, not what was avoidable. Booking
// 100% of it as savings asserted that web-search discipline eliminates all
// search — the same full-observed-cost shape already removed from
// batchable-workload/cache-1h-waste/cache-economics/expensive-sessions
// (#3191–#3193/#3196). Only the named conservative fraction is booked.
// ---------------------------------------------------------------------------

describe('cost.web-search-spend savings claim (#3508)', () => {
  const OBSERVED_SEARCH_COST = 60 * SERVER_TOOL_PRICING.webSearchRequest; // $0.60

  it('books strictly less than the observed search spend', () => {
    const rec = detector.rule(input([session('s1', 60)]), 0);
    expect(rec?.estSavingsUsd).toBeDefined();
    expect(rec!.estSavingsUsd!).toBeLessThan(OBSERVED_SEARCH_COST);
    expect(rec!.estSavingsUsd!).toBeCloseTo(
      OBSERVED_SEARCH_COST * AVOIDABLE_SEARCH_FRACTION,
      5
    );
    // The reclaim books the same avoidable figure, not the observed spend.
    expect(rec?.reclaim?.counterfactual.kind).toBe('directUsd');
    expect(
      (rec!.reclaim!.counterfactual as { kind: 'directUsd'; usd: number }).usd
    ).toBeCloseTo(OBSERVED_SEARCH_COST * AVOIDABLE_SEARCH_FRACTION, 5);
  });

  it('names the fraction as a constant and surfaces it in the copy', () => {
    // The constant itself is the conservative-fraction contract.
    expect(AVOIDABLE_SEARCH_FRACTION).toBeLessThan(1);
    expect(AVOIDABLE_SEARCH_FRACTION).toBeGreaterThan(0);
    const rec = detector.rule(input([session('s1', 60)]), 0);
    expect(rec?.detail).toContain(`${Math.round(AVOIDABLE_SEARCH_FRACTION * 100)}%`);
    expect(rec?.detail).toMatch(/avoidable/i);
    // …and a provenance derivation cites it, so the booked figure reproduces.
    const derivation = rec?.provenance?.derivations?.find(
      (d) => d.id === 'avoidable-search-usd'
    );
    expect(derivation?.operands.avoidableSearchFraction).toBe(AVOIDABLE_SEARCH_FRACTION);
    expect(derivation?.value).toBeCloseTo(rec!.estSavingsUsd!, 10);
  });

  it('moves the reclaim cascade total to the avoidable figure', () => {
    const td = [session('s1', 60)];
    const rec = detector.rule(input(td), 0);
    const result = runReclaimCascade([rec!.reclaim!], td);
    const booked = result.booked[0];
    expect(booked.rejected).toBe(false);
    expect(booked.marginalUsd).toBeCloseTo(
      OBSERVED_SEARCH_COST * AVOIDABLE_SEARCH_FRACTION,
      5
    );
    expect(booked.marginalUsd).toBeLessThan(OBSERVED_SEARCH_COST);
  });
});

// ---------------------------------------------------------------------------
// #3201 — structured provenance: observations reproduce every numeric claim.
// ---------------------------------------------------------------------------

describe('cost.web-search-spend provenance (#3201)', () => {
  const rec = detector.rule(input([session('s1', 60)]), 0)!;

  it('passes the repository provenance validator', () => {
    expect(rec.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('cites the exact tokenData and pricing-registry fields', () => {
    const byField = new Map(rec.provenance!.observations.map((o) => [o.field, o]));
    const requests = byField.get('tokenData[].entries[].webSearchRequests');
    expect(requests?.source).toBe('parse-sessions');
    expect(requests?.value).toBe(60);
    const fee = byField.get('SERVER_TOOL_PRICING.webSearchRequest');
    expect(fee?.source).toBe('pricing.ts');
    expect(fee?.value).toBe(SERVER_TOOL_PRICING.webSearchRequest);
  });

  it('reproduces the observed search cost and share as derivations', () => {
    const byId = new Map(rec.provenance!.derivations!.map((d) => [d.id, d]));
    const cost = byId.get('search-cost-usd')!;
    expect(cost.value).toBeCloseTo(0.6, 5);
    expect(
      (cost.operands.searches as number) * (cost.operands.webSearchRequestUsd as number)
    ).toBeCloseTo(cost.value as number, 10);
    const share = byId.get('search-share-of-spend')!;
    expect(
      (share.operands.searchCostUsd as number) / (share.operands.pricedTotalCostUsd as number)
    ).toBeCloseTo(share.value as number, 10);
  });

  it('separates the avoidability assumption into the inference', () => {
    expect(rec.provenance!.inference).toMatch(/assumption/i);
    expect(rec.provenance!.inference).toMatch(/not observable/i);
  });

  it('dates the claim from the newest observed entry', () => {
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    // Run far past the freshness window → demoted, not asserted as current.
    const staleRec = detector.rule(
      input([session('s1', 60)]),
      Date.parse('2026-12-01T00:00:00.000Z')
    )!;
    expect(staleRec.provenance!.stale).toBe(true);
    expect(staleRec.detail).toMatch(/^As of 2026-06-09/);
    expect(validateRecommendationProvenance(staleRec)).toEqual([]);
  });
});
