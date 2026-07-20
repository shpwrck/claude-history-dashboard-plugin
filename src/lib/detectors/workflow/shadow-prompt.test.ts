import { describe, it, expect } from 'vitest';
import { detector } from './shadow-prompt';
import { detector as shadowAxisWins } from './shadow-axis-wins';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet, effectiveFixKind } from '../fix-validity';
import { claudeMdMarksApplied } from '../shared';
import type { RecommendationInput } from '../types';
import type {
  AxisAggregate,
  ShadowCallAggregate,
  VariationAggregate,
} from '../../parse-shadow-calls';

const NOW = 1_780_100_000_000;
const DAY = 24 * 60 * 60 * 1000;
const freshTs = new Date(NOW - DAY).toISOString();

function variation(over: Partial<VariationAggregate> = {}): VariationAggregate {
  return {
    axis: 'prompt',
    variation: 'structured',
    samples: 6,
    live: 4,
    trustedLive: 4,
    replay: 2,
    shadowWins: 5,
    mainWins: 1,
    ties: 0,
    decided: 6,
    costDeltaSum: -0.6,
    costDeltaCount: 6,
    latestTs: freshTs,
    untimed: 0,
    proofStatusCounts: { unknown: 6, current: 0, stale: 0, revoked: 0 },
    ...over,
  };
}

function promptAxis(over: Partial<AxisAggregate> = {}): AxisAggregate {
  return {
    axis: 'prompt',
    samples: 6,
    live: 5,
    replay: 1,
    shadowWins: 5,
    mainWins: 1,
    ties: 0,
    liveShadowWins: 5,
    tokenDeltaSum: -1200,
    tokenDeltaCount: 6,
    costDeltaSum: 0,
    costDeltaCount: 0,
    adherenceRegressionSum: 0,
    adherenceRegressionCount: 0,
    ...over,
  };
}

function agg(
  variations: VariationAggregate[],
  over: Partial<ShadowCallAggregate> = {}
): ShadowCallAggregate {
  const counted = variations.reduce((n, v) => n + v.samples, 0);
  return {
    total: counted,
    counted,
    synthetic: 0,
    skipped: 0,
    live: variations.reduce((n, v) => n + v.live, 0),
    replay: variations.reduce((n, v) => n + v.replay, 0),
    byAxis: [],
    bySourceAxis: [],
    byVariation: variations,
    variationSkipped: 0,
    ...over,
  };
}

function claudeMd(text: string): RecommendationInput['liveConfig'] {
  return { claudeMd: { global: text, perProject: {} } } as unknown as RecommendationInput['liveConfig'];
}

function input(
  shadowCalls: ShadowCallAggregate | null,
  liveConfig: RecommendationInput['liveConfig'] = null
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig,
    shadowCalls,
  };
}

describe('workflow.shadow-prompt (#2555)', () => {
  it('fires on a qualifying prompt variation and names the exact treatment', () => {
    const rec = detector.rule(input(agg([variation()])), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('workflow.shadow-prompt');
    expect(rec!.title).toContain('structured');
    expect(rec!.affected).toBe(6);
    expect(rec!.detail).toContain('5/6 decided comparisons (83%)');
  });

  it('stays silent below the sample / decided / win-rate thresholds', () => {
    expect(
      detector.rule(input(agg([variation({ samples: 4, decided: 4, shadowWins: 4, mainWins: 0 })])), NOW)
    ).toBeNull();
    expect(
      detector.rule(input(agg([variation({ samples: 6, decided: 2, shadowWins: 2, mainWins: 0, ties: 4 })])), NOW)
    ).toBeNull();
    expect(
      detector.rule(input(agg([variation({ samples: 6, decided: 6, shadowWins: 3, mainWins: 3 })])), NOW)
    ).toBeNull();
  });

  it('only fires on the prompt axis — a winning non-prompt variation is ignored', () => {
    expect(detector.rule(input(agg([variation({ axis: 'model', variation: 'haiku' })])), NOW)).toBeNull();
  });

  it('picks the strongest qualifying prompt variation (most decided, then win rate)', () => {
    const weak = variation({ variation: 'concise', samples: 5, decided: 5, shadowWins: 3, mainWins: 2 });
    const strong = variation({ variation: 'structured', samples: 8, decided: 8, shadowWins: 7, mainWins: 1 });
    expect(detector.rule(input(agg([weak, strong])), NOW)!.title).toContain('structured');
  });

  it('emits well-formed provenance citing variation, mix, cost, timestamp, and proof status', () => {
    const rec = detector.rule(input(agg([variation()])), NOW)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    const claims = rec.provenance!.observations.map((o) => o.claim).join(' | ');
    expect(claims).toContain('decided shadow comparisons');
    expect(claims).toContain('trusted in-the-loop');
    expect(claims).toContain('cost delta');
    expect(claims).toContain('source proof status');
    expect(rec.provenance!.asOf).toBe(freshTs.slice(0, 10));
  });

  it('preserves the EXACT recorded variation label in provenance (not the truncated display)', () => {
    const exact = 'structured-v2 (steps + acceptance, ticket-scoped)';
    const rec = detector.rule(input(agg([variation({ variation: exact })])), NOW)!;
    const labelObs = rec.provenance!.observations.find((o) => o.field === 'byVariation[].variation');
    expect(labelObs?.value).toBe(exact);
  });

  it('declares an observational causal posture — proof status never lifts the tier', () => {
    const rec = detector.rule(input(agg([variation()])), NOW)!;
    expect(rec.claimClass).toBe('causal');
    expect(rec.proofTier).toBe('observational');
    expect(rec.severity).toBe('info');
  });

  it('cites but does NOT promote on a current proof (counts are not linked to a winning comparison)', () => {
    const proven = variation({ proofStatusCounts: { unknown: 2, current: 4, stale: 0, revoked: 0 } });
    const rec = detector.rule(input(agg([proven])), NOW)!;
    expect(rec.proofTier).toBe('observational');
    expect(rec.severity).toBe('info');
    expect(rec.evidence!.join(' ')).toContain('current 4');
    expect(rec.detail.toLowerCase()).not.toContain('proof-backed');
  });

  it('does not prescribe a specific framing technique for an arbitrary variation label', () => {
    const rec = detector.rule(input(agg([variation({ variation: 'concise' })])), NOW)!;
    expect(rec.action.toLowerCase()).not.toContain('explicit steps');
    expect(rec.fix!.snippet.toLowerCase()).not.toContain('acceptance criteria');
    expect(rec.action).toContain('concise');
  });

  it('ties the scope to what the experiments sampled, not an undefined task class', () => {
    const rec = detector.rule(input(agg([variation()])), NOW)!;
    expect(rec.action.toLowerCase()).toContain('these prompt shadow experiments sampled');
    expect(rec.fix!.snippet.toLowerCase()).toContain('these prompt shadow experiments sampled');
  });

  it('discloses paired-cost coverage instead of claiming broad savings', () => {
    // only 1 of 6 experiments had paired cost data
    const rec = detector.rule(input(agg([variation({ costDeltaSum: -0.4, costDeltaCount: 1 })])), NOW)!;
    expect(rec.detail).toContain('paired cost data on 1/6');
    // the standing-note snippet must not make a bare cost claim
    expect(rec.fix!.snippet.toLowerCase()).not.toContain('lower cost');
  });

  it('adds a cold-start caveat for replay-only evidence', () => {
    const rec = detector.rule(input(agg([variation({ live: 0, replay: 6, trustedLive: 0 })])), NOW)!;
    expect(rec.detail.toLowerCase()).toContain('replay-only');
    expect(rec.detail.toLowerCase()).toContain('cold-start');
  });

  it('adds the cold-start caveat when live rows are untrusted batch sources (no trusted live)', () => {
    // 6 live-MODE rows, but none from a trusted (organic/race) source.
    const batchLive = variation({ live: 6, replay: 0, trustedLive: 0 });
    const rec = detector.rule(input(agg([batchLive])), NOW)!;
    expect(rec.detail.toLowerCase()).toContain('cold-start');
    expect(rec.detail).toContain('(0 trusted in-the-loop)');
  });

  it('discloses a tail-truncated shadow ledger', () => {
    const rec = detector.rule(input(agg([variation()], { truncated: true })), NOW)!;
    expect(rec.detail.toLowerCase()).toContain('tail-truncated');
    expect(rec.provenance!.observations.map((o) => o.claim).join(' ').toLowerCase()).toContain('truncated');
  });

  it('never hardens a STALE lead into a standing default (no fix, re-run action)', () => {
    const oldTs = new Date(NOW - 60 * DAY).toISOString();
    const rec = detector.rule(input(agg([variation({ latestTs: oldTs })])), NOW)!;
    expect(rec.severity).toBe('info');
    expect(rec.provenance!.stale).toBe(true);
    expect(rec.provenance!.asOf).toBe(oldTs.slice(0, 10));
    expect(rec.detail).toContain(`as of ${oldTs.slice(0, 10)}`);
    expect(rec.action.toLowerCase()).toContain('re-run');
    expect(rec.action.toLowerCase()).not.toContain('standing default');
    expect(rec.fix).toBeUndefined(); // stale evidence emits no CLAUDE.md standing rule
  });

  it('never hardens a fully-undated lead into a standing default', () => {
    const rec = detector.rule(input(agg([variation({ latestTs: null, untimed: 6 })])), NOW)!;
    expect(rec.detail.toLowerCase()).toContain('undated');
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.provenance!.stale).toBeUndefined();
    expect(rec.fix).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('handles an extended-year (unrepresentable) timestamp without emitting invalid provenance', () => {
    // A huge numeric epoch can normalize to e.g. "+275760-09-13T00:00:00.000Z".
    const rec = detector.rule(input(agg([variation({ latestTs: '+275760-09-13T00:00:00.000Z' })])), NOW)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]); // no malformed asOf
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.detail.toLowerCase()).toContain('unrepresentable');
    expect(rec.fix).toBeUndefined();
  });

  it('single-lines and backtick-strips the label for prose/snippet, keeping the raw label in provenance', () => {
    const nasty = 'evil`code`\n## Injected heading';
    const rec = detector.rule(input(agg([variation({ variation: nasty })])), NOW)!;
    expect(rec.title).not.toContain('\n');
    expect(rec.title).not.toContain('`');
    expect(rec.fix!.snippet).not.toContain('`');
    // a collapsed newline cannot start a Markdown heading inside the snippet body
    expect(rec.fix!.snippet).not.toMatch(/\n## Injected heading/);
    const labelObs = rec.provenance!.observations.find((o) => o.field === 'byVariation[].variation');
    expect(labelObs?.value).toBe(nasty); // exact raw label preserved
  });

  it('self-suppresses ONLY the adopted variation — a different later winner still fires', () => {
    const rec = detector.rule(input(agg([variation({ variation: 'structured' })])), NOW)!;
    const adopted = claudeMd(rec.fix!.snippet);
    expect(claudeMdMarksApplied(adopted, rec.fix!.appliedMarkers)).toBe(true);
    // the adopted "structured" treatment is suppressed
    expect(detector.rule(input(agg([variation({ variation: 'structured' })]), adopted), NOW)).toBeNull();
    // ...but a later, different winning treatment ("concise") is NOT hidden
    const later = detector.rule(input(agg([variation({ variation: 'concise' })]), adopted), NOW);
    expect(later).not.toBeNull();
    expect(later!.title).toContain('concise');
  });

  it('self-suppression matches the RENDERED (sanitized) label, not the raw ledger string', () => {
    // A label with a backtick/newline renders sanitized in the snippet; suppression
    // must match that rendered form or the same rec re-fires forever (#2555 P2:105).
    const nasty = 'evil`code`\n## heading';
    const rec = detector.rule(input(agg([variation({ variation: nasty })])), NOW)!;
    const adopted = claudeMd(rec.fix!.snippet);
    expect(detector.rule(input(agg([variation({ variation: nasty })]), adopted), NOW)).toBeNull();
  });

  it('surfaces the strongest UNADOPTED treatment when a stronger one is already adopted', () => {
    const structured = variation({ variation: 'structured', samples: 8, decided: 8, shadowWins: 7, mainWins: 1 });
    const concise = variation({ variation: 'concise', samples: 6, decided: 6, shadowWins: 5, mainWins: 1 });
    const structuredRec = detector.rule(input(agg([structured])), NOW)!;
    const adoptedStructured = claudeMd(structuredRec.fix!.snippet);
    // structured (strongest) is adopted, but concise still qualifies → surface concise
    const rec = detector.rule(input(agg([structured, concise]), adoptedStructured), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.title).toContain('concise');
    // once BOTH treatments are adopted there is nothing new to surface
    const both = claudeMd(`${structuredRec.fix!.snippet}\n\n${rec!.fix!.snippet}`);
    expect(detector.rule(input(agg([structured, concise]), both), NOW)).toBeNull();
  });

  it('treats a future-dated (clock-skewed) receipt as undatable — no standing default', () => {
    const futureTs = new Date(NOW + 5 * DAY).toISOString();
    const rec = detector.rule(input(agg([variation({ latestTs: futureTs })])), NOW)!;
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.provenance!.stale).toBeUndefined();
    expect(rec.detail.toLowerCase()).toContain('future-dated');
    expect(rec.fix).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('does not treat a label quoted OUTSIDE the marker section as adoption', () => {
    const structuredRec = detector.rule(input(agg([variation({ variation: 'structured' })])), NOW)!;
    // adopt "structured", but ALSO quote "concise" in an unrelated section
    const doc = `${structuredRec.fix!.snippet}\n\n## Style guide\n\nUse the "concise" style for summaries.\n`;
    const cfg = claudeMd(doc);
    // "structured" IS in our section → suppressed
    expect(detector.rule(input(agg([variation({ variation: 'structured' })]), cfg), NOW)).toBeNull();
    // "concise" is only mentioned in the unrelated section → NOT adopted → fires
    const rec = detector.rule(input(agg([variation({ variation: 'concise' })]), cfg), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.title).toContain('concise');
  });

  it('demotes a cardinality-truncated variation set to a soft lead (no standing default)', () => {
    const rec = detector.rule(input(agg([variation()], { variationCellsTruncated: true })), NOW)!;
    expect(rec.fix).toBeUndefined();
    expect(rec.detail.toLowerCase()).toContain('may not be the strongest');
    expect(rec.action.toLowerCase()).toContain('re-run');
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('ships an illustrative, portability-clean, marker-specific CLAUDE.md fix for a fresh lead', () => {
    const rec = detector.rule(input(agg([variation()])), NOW)!;
    expect(rec.fix!.target).toBe('CLAUDE.md');
    expect(effectiveFixKind(rec.fix!)).toBe('illustrative');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    expect(rec.fix!.appliedMarkers?.headings?.length).toBeGreaterThan(0);
  });

  it('emits nothing without a shadow ledger', () => {
    expect(detector.rule(input(null), NOW)).toBeNull();
    expect(detector.rule(input(agg([])), NOW)).toBeNull();
  });
});

describe('workflow.shadow-axis-wins prompt hand-off (#2555)', () => {
  it('yields the prompt axis to shadow-prompt when a variation qualifies', () => {
    const a = agg([variation()], { byAxis: [promptAxis()] });
    expect(detector.rule(input(a), NOW)!.id).toBe('workflow.shadow-prompt');
    expect(shadowAxisWins.rule(input(a), NOW)).toBeNull();
  });

  it('keeps the generic prompt card when wins split across labels that each fall short', () => {
    // aggregate prompt axis wins, but each variation cell is < MIN_SAMPLES.
    const split = agg(
      [
        variation({ variation: 'a', samples: 4, decided: 4, shadowWins: 3, mainWins: 1 }),
        variation({ variation: 'b', samples: 4, decided: 4, shadowWins: 3, mainWins: 1 }),
      ],
      { byAxis: [promptAxis()] }
    );
    expect(detector.rule(input(split), NOW)).toBeNull(); // no variation qualifies
    const generic = shadowAxisWins.rule(input(split), NOW);
    expect(generic).not.toBeNull();
    expect(generic!.id).toBe('workflow.shadow-axis-wins');
  });

  it('keeps the generic prompt card for a legacy receipt-less aggregate', () => {
    const legacy: ShadowCallAggregate = {
      total: 6,
      counted: 6,
      synthetic: 0,
      skipped: 0,
      live: 5,
      replay: 1,
      byAxis: [promptAxis()],
      bySourceAxis: [],
      byVariation: [],
      variationSkipped: 0,
    };
    expect(detector.rule(input(legacy), NOW)).toBeNull();
    expect(shadowAxisWins.rule(input(legacy), NOW)!.id).toBe('workflow.shadow-axis-wins');
  });
});
