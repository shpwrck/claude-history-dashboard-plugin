import { describe, it, expect } from 'vitest';
import { detector } from './uncovered-shadow-axis';
import { SHADOW_STALE_DAYS } from './shadow-axis-wins';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';

/**
 * Build a shadow-calls aggregate with ONE UNCOVERED axis ('skills' → no covering
 * detector in AXIS_COVERAGE) clearing the win bar (6 samples, 5/1 decided).
 * `latestTs` is the axis's newest dated record (the freshness anchor, #3248);
 * omit it for the undated case.
 */
function shadowCalls(opts: { latestTs?: string } = {}): RecommendationInput['shadowCalls'] {
  return {
    total: 6,
    counted: 6,
    synthetic: 0,
    skipped: 0,
    live: 4,
    replay: 2,
    byAxis: [
      {
        axis: 'skills',
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

describe('workflow.uncovered-shadow-axis provenance + freshness (#3248)', () => {
  it('emits provenance that passes the contract when it fires', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY; // fresh
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(rec.id).toBe('workflow.uncovered-shadow-axis');
    expect(rec.provenance).toBeDefined();
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.claimClass).toBe('causal');
    expect(rec.proofTier).toBe('observational');
  });

  it('cites the win operands and records the AXIS_COVERAGE lookup (value 0)', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    const obs = rec.provenance!.observations;
    expect(obs.find((o) => o.field === 'samples')!.value).toBe(6);
    expect(obs.find((o) => o.field === 'shadowWins')!.value).toBe(5);
    expect(obs.find((o) => o.field === 'mainWins')!.value).toBe(1);
    expect(obs.find((o) => o.field === 'shadowWins + mainWins')!.value).toBe(6);
    expect(obs.find((o) => o.field === 'live')!.value).toBe(4);
    expect(obs.find((o) => o.field === 'replay')!.value).toBe(2);
    const coverage = obs.find((o) => o.field === 'AXIS_COVERAGE["skills"]');
    expect(coverage).toBeDefined();
    expect(coverage!.value).toBe(0);
  });

  it('FRESH dated evidence offers an illustrative filing command', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.stale).toBe(false);
    expect(rec.fix).toBeDefined();
    expect(rec.fix!.fixKind).toBe('illustrative');
    expect(rec.fix!.snippet).toContain('gh issue create');
  });

  it('STALE evidence emits a dated lead WITHOUT a filing command', () => {
    const now = Date.parse(OBSERVED) + (SHADOW_STALE_DAYS + 10) * DAY;
    const rec = detector.rule(input(shadowCalls({ latestTs: OBSERVED })), now)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.stale).toBe(true);
    expect(rec.fix).toBeUndefined(); // no copy-paste `gh issue create`
    // The rec still fires as a lead that states its (stale) date.
    expect(rec.detail).toContain('2026-06-09');
  });

  it('UNDATED evidence emits a lead WITHOUT a filing command', () => {
    const now = Date.parse(OBSERVED) + 5 * DAY;
    const rec = detector.rule(input(shadowCalls({})), now)!; // no dated receipt
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.provenance!.stale).toBeUndefined();
    expect(rec.fix).toBeUndefined();
  });
});
