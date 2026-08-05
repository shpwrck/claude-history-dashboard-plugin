import { describe, it, expect } from 'vitest';
import { detector, SHADOW_STALE_DAYS } from './shadow-axis-wins';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';

/**
 * Build a shadow-calls aggregate with ONE non-recs, non-prompt axis ('reasoning')
 * that clears the win bar (6 samples, 5/1 decided → 83%). `latestTs` is the
 * axis's newest dated record (the freshness anchor, #3246); omit it for the
 * undated case.
 */
function shadowCalls(
  opts: { latestTs?: string; regimeUncertain?: number } = {}
): RecommendationInput['shadowCalls'] {
  return {
    total: 6,
    counted: 6,
    synthetic: 0,
    skipped: 0,
    live: 4,
    replay: 2,
    byAxis: [
      {
        axis: 'reasoning',
        samples: 6,
        live: 4,
        replay: 2,
        shadowWins: 5,
        mainWins: 1,
        ties: 0,
        liveShadowWins: 4,
        tokenDeltaSum: -120,
        tokenDeltaCount: 6,
        costDeltaSum: -0.6,
        costDeltaCount: 6,
        adherenceRegressionSum: 0,
        adherenceRegressionCount: 0,
        latestTs: opts.latestTs ?? null,
        ...(opts.regimeUncertain !== undefined
          ? { regimeUncertain: opts.regimeUncertain }
          : {}),
      },
    ],
    bySourceAxis: [],
    byVariation: [],
    variationSkipped: 0,
  } as unknown as RecommendationInput['shadowCalls'];
}

function input(sc: RecommendationInput['shadowCalls']): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    shadowCalls: sc,
  } as unknown as RecommendationInput;
}

const DAY = 24 * 60 * 60 * 1000;
const OBSERVED = '2026-06-09T00:00:00.000Z';

describe('workflow.shadow-axis-wins adopt-axis provenance (#3246)', () => {
  it('emits provenance that passes the contract when the adopt-axis lead fires', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY; // fresh
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(rec.id).toBe('workflow.shadow-axis-wins');
    expect(rec.provenance).toBeDefined();
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.claimClass).toBe('causal');
    expect(rec.proofTier).toBe('observational');
  });

  it('cites the exact byAxis operands behind the win rate and the paired average', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    const obs = rec.provenance!.observations;
    expect(obs.find((o) => o.field === 'samples')!.value).toBe(6);
    expect(obs.find((o) => o.field === 'shadowWins')!.value).toBe(5);
    expect(obs.find((o) => o.field === 'mainWins')!.value).toBe(1);
    expect(obs.find((o) => o.field === 'shadowWins + mainWins')!.value).toBe(6);
    expect(obs.find((o) => o.field === 'live')!.value).toBe(4);
    expect(obs.find((o) => o.field === 'replay')!.value).toBe(2);
    // The average cost delta is reproducible from the cited sum ÷ count.
    expect(obs.find((o) => o.field === 'costDeltaSum')!.value).toBeCloseTo(-0.6, 9);
    expect(obs.find((o) => o.field === 'costDeltaCount')!.value).toBe(6);
  });

  it('FRESH dated evidence reads as a standing default', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.stale).toBe(false);
    expect(rec.title).toContain('Adopt');
    expect(rec.fix!.snippet).toContain('Default approach');
  });

  it('STALE evidence cannot read as a current standing default', () => {
    const now = Date.parse(OBSERVED) + (SHADOW_STALE_DAYS + 10) * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.stale).toBe(true);
    expect(rec.severity).toBe('info'); // never warning on stale evidence
    expect(rec.title).not.toContain('Adopt');
    expect(rec.fix!.snippet).not.toContain('Default approach');
    expect(rec.fix!.snippet.toLowerCase()).not.toContain('becomes the default');
  });

  it('UNDATED evidence (no dated receipt) cannot read as a current standing default', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({})), now)!; // no byVariation
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.provenance!.stale).toBeUndefined();
    expect(rec.severity).toBe('info');
    expect(rec.title).not.toContain('Adopt');
    expect(rec.fix!.snippet).not.toContain('Default approach');
  });
});

describe('workflow.shadow-axis-wins — possibly-straddling pairs are flagged (#3656)', () => {
  it('surfaces the regime-uncertain count in evidence and provenance', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(
      input(shadowCalls({ latestTs: OBSERVED, regimeUncertain: 2 })),
      now
    )!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(
      rec.evidence!.some((e) =>
        e.includes('2 of the 6 pair(s) may straddle a Claude Code prompt-regime change')
      )
    ).toBe(true);
    const obs = rec.provenance!.observations.find(
      (o) => o.field === 'regimeUncertain'
    )!;
    expect(obs.value).toBe(2);
  });

  it('adds nothing when every pair is regime-clean or version-less', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(rec.evidence!.some((e) => e.includes('straddle'))).toBe(false);
    expect(
      rec.provenance!.observations.some((o) => o.field === 'regimeUncertain')
    ).toBe(false);
  });
});
