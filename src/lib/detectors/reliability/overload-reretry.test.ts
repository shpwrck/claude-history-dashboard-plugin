import { describe, it, expect } from 'vitest';
import { detector } from './overload-reretry';
import { validateRecommendationProvenance } from '../provenance';
import { PREFIX_REWASTE_FRAC } from './reclaim-prefix';
import type { RecommendationInput } from '../types';
import type { ApiErrorEvent } from '../../parse-errors';
import type { SessionTokenData, TokenEntry } from '../../types';
import { runReclaimCascade, scopeKeyOf } from '../../reclaim';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const apiErr = (over: Partial<ApiErrorEvent>): ApiErrorEvent =>
  ({
    sessionId: 's1',
    timestamp: at(1),
    summary: 'overloaded',
    source: 'native',
    ...over,
  }) as ApiErrorEvent;

const entry = (over: Partial<TokenEntry> = {}): TokenEntry => ({
  timestamp: at(1),
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model: 'claude-opus-4-7',
  ...over,
});

const session = (
  sessionId: string,
  model: string,
  entries: TokenEntry[]
): SessionTokenData =>
  ({
    sessionId,
    model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

const input = (over: Partial<RecommendationInput> = {}): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...over,
});

describe('reliability.overload-reretry (#950)', () => {
  it('fires on a 529 with retryAttempt>1 and priced cache-read in window', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 2_000_000 })])];
    const errs = [apiErr({ status: 529, retryAttempt: 2 })];
    const rec = detector.rule(input({ tokenData: td, apiErrors: errs }), 0);
    expect(rec?.id).toBe('reliability.overload-reretry');
    expect(rec?.reclaim?.cause).toBe('failed-tool-retry');
    expect(rec?.reclaim?.ownedPools).toEqual(['cacheRead']);
    expect(rec?.reclaim?.scopeKeys).toEqual([scopeKeyOf('s1', 'claude-opus-4-7')]);
  });

  it('gates on retryAttempt>1 — a first attempt (retryAttempt 1) books nothing', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 5_000_000 })])];
    expect(detector.rule(input({ tokenData: td, apiErrors: [apiErr({ status: 529, retryAttempt: 1 })] }), 0)).toBeNull();
    // No retryAttempt at all (text-matched event) also books nothing.
    expect(detector.rule(input({ tokenData: td, apiErrors: [apiErr({ status: 429 })] }), 0)).toBeNull();
  });

  it('gates on status 429/529 — a non-rate-limit status books nothing', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 5_000_000 })])];
    expect(
      detector.rule(input({ tokenData: td, apiErrors: [apiErr({ status: 500, retryAttempt: 3 })] }), 0)
    ).toBeNull();
  });

  it('uses a conservative cacheRead-only fraction — never the whole turn', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]),
    ];
    const rec = detector.rule(
      input({ tokenData: td, apiErrors: [apiErr({ status: 429, retryAttempt: 3 })] }),
      0
    );
    const cf = rec?.reclaim?.counterfactual;
    expect(cf?.kind).toBe('scaleTokens');
    if (cf?.kind !== 'scaleTokens') throw new Error('expected scaleTokens');
    expect(cf.poolDeltaFrac.cacheRead).toBe(PREFIX_REWASTE_FRAC);
    expect(cf.poolDeltaFrac.output).toBeUndefined();

    const result = runReclaimCascade([rec!.reclaim!], td, () => {});
    // cacheRead cell $0.50 → only fraction booked; output ($25) untouched.
    expect(result.total).toBeCloseTo(0.5 * PREFIX_REWASTE_FRAC, 9);
    expect(result.total).toBeLessThan(0.5);
  });

  it('preserves the cascade identity', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 4_000_000, outputTokens: 200_000 })])];
    const rec = detector.rule(input({ tokenData: td, apiErrors: [apiErr({ status: 529, retryAttempt: 4 })] }), 0);
    const result = runReclaimCascade([rec!.reclaim!], td, () => {});
    const summed = result.booked.reduce((s, b) => s + b.marginalUsd, 0);
    expect(summed).toBeCloseTo(result.billOriginal - result.billFinal, 9);
    expect(result.billFinal).toBeGreaterThanOrEqual(0);
  });

  it('emits structured provenance and softens the claim to an approximate estimate (#3214)', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 2_000_000 })]),
    ];
    const rec = detector.rule(
      input({ tokenData: td, apiErrors: [apiErr({ status: 529, retryAttempt: 2 })] }),
      0
    );
    expect(rec).not.toBeNull();
    // Passes the #3205 provenance contract.
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    // Observations cite BOTH artifact field sets and the +/-90s window.
    const obs = rec!.provenance!.observations;
    expect(
      obs.some((o) => /ApiErrorEvent\.status.*retryAttempt.*timestamp.*sessionId/.test(o.field))
    ).toBe(true);
    expect(obs.some((o) => /cacheReadTokens/.test(o.field))).toBe(true);
    expect(
      obs.some((o) => /90s window/.test(o.claim)) ||
        /90s timestamp join/.test(rec!.provenance!.inference ?? '')
    ).toBe(true);
    // Inference labels the join approximate; wording no longer claims exact repayment.
    expect(rec!.provenance!.inference).toMatch(/approximate/i);
    expect(rec!.detail).toMatch(/estimated associated cache-read waste/i);
    expect(rec!.detail).not.toMatch(/is re-paid waste/i);
  });

  it('stays silent with no events, no token scope, or no cache-read', () => {
    expect(detector.rule(input({ apiErrors: [apiErr({ status: 529, retryAttempt: 2 })] }), 0)).toBeNull();
    const td = [session('s1', 'claude-opus-4-7', [entry({ outputTokens: 1_000_000 })])];
    expect(detector.rule(input({ tokenData: td, apiErrors: [apiErr({ status: 529, retryAttempt: 2 })] }), 0)).toBeNull();
  });
});
