import { describe, it, expect } from 'vitest';
import {
  ACT_NOW_MIN_WEIGHTED_SCORE,
  STALE_AFTER_DAYS,
  actNowRoutingGaps,
  detector,
  isActNowRoutingGap,
} from './model-eval-routing-gap';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type {
  ModelEvalModelRollup,
  ModelEvalSummary,
} from '../../model-eval-ingest';
import type { EvalRoutingRecommendation } from '../../model-eval-result';

const NOW = Date.parse('2026-06-11T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function rollup(over: Partial<ModelEvalModelRollup> = {}): ModelEvalModelRollup {
  return {
    modelId: 'claude-sonnet-4-5',
    runCount: 6,
    candidateRuns: 4,
    baselineRuns: 2,
    vetoedRuns: 0,
    meanWeightedScore: 0.7,
    bestWeightedScore: 0.85,
    vetoes: [],
    strongestEvidence: 'shadow-replay-verdict',
    evidenceCount: 9,
    ...over,
  };
}

function rec(
  over: Partial<EvalRoutingRecommendation> = {}
): EvalRoutingRecommendation {
  return {
    modelId: 'claude-sonnet-4-5',
    scope: 'gap:haiku-sonnet:failure:small',
    weightedScore: 0.82,
    strongestEvidence: 'shadow-replay-verdict',
    rationale: 'Candidate beat the baseline on the failure-dominant cluster.',
    ...over,
  };
}

function summary(over: Partial<ModelEvalSummary> = {}): ModelEvalSummary {
  return {
    schemaVersion: 1,
    kind: 'model-eval-summary',
    generatedAt: '2026-06-10T00:00:00.000Z',
    artifactCount: 2,
    runCount: 6,
    artifacts: [
      {
        batchPath: '/tmp/evals/batch-2.json',
        createdAt: '2026-06-09T00:00:00.000Z',
        runCount: 4,
        vetoedRuns: 0,
      },
      {
        batchPath: '/tmp/evals/batch-1.json',
        createdAt: '2026-06-08T00:00:00.000Z',
        runCount: 2,
        vetoedRuns: 1,
      },
    ],
    models: [rollup()],
    vetoTotals: {
      'failed-required-gate': 0,
      'materially-worse-correctness': 0,
      'unknown-pricing-or-api': 0,
      'insufficient-evidence': 0,
    },
    exclusions: { kept: 4, filtered: 2 },
    recommendations: [rec()],
    ...over,
  };
}

function input(
  modelEvalSummary: ModelEvalSummary | null | undefined,
  claudeMd?: string
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: claudeMd
      ? ({ claudeMd: { global: claudeMd } } as unknown as RecommendationInput['liveConfig'])
      : null,
    modelEvalSummary,
  };
}

describe('cost.model-eval-routing-gap (#1086)', () => {
  it('fires on a strong-evidence, non-vetoed routing recommendation', () => {
    const out = detector.rule(input(summary()), NOW);
    expect(out?.id).toBe('cost.model-eval-routing-gap');
    expect(out?.category).toBe('cost');
    expect(out?.view).toBe('model-evals');
    expect(out?.affected).toBe(1);
    expect(out?.title).toContain('act-now routing gap');
    expect(out?.detail).toContain('claude-sonnet-4-5');
    expect(out?.detail).toContain('gap:haiku-sonnet:failure:small');
    // Rule 6: promotion requires explicit user approval, stated in the action.
    expect(out?.action).toContain('explicit approval');
  });

  it('stays silent when the summary is null or absent (SPA / no artifacts)', () => {
    expect(detector.rule(input(null), NOW)).toBeNull();
    expect(detector.rule(input(undefined), NOW)).toBeNull();
  });

  it('stays silent on an empty summary (zero artifacts or zero runs)', () => {
    expect(
      detector.rule(input(summary({ artifactCount: 0, runCount: 0, recommendations: [] })), NOW)
    ).toBeNull();
    expect(detector.rule(input(summary({ runCount: 0 })), NOW)).toBeNull();
  });

  it('stays silent when evidence is discovery-only (rule 4: cost is never a quality label)', () => {
    const weak = summary({
      recommendations: [
        rec({ strongestEvidence: 'proxy-detector-signal' }),
        rec({ scope: 'other-scope', strongestEvidence: 'token-cost-discovery' }),
      ],
    });
    expect(detector.rule(input(weak), NOW)).toBeNull();
  });

  it('stays silent below the act-now weighted-score floor', () => {
    const low = summary({
      recommendations: [rec({ weightedScore: ACT_NOW_MIN_WEIGHTED_SCORE - 0.01 })],
    });
    expect(detector.rule(input(low), NOW)).toBeNull();
  });

  it('stays silent when the recommended model carries a hard veto', () => {
    const vetoed = summary({
      models: [rollup({ vetoes: ['failed-required-gate'], vetoedRuns: 2 })],
    });
    expect(detector.rule(input(vetoed), NOW)).toBeNull();
  });

  it('emits auditable provenance citing the artifact source', () => {
    const out = detector.rule(input(summary()), NOW);
    expect(out?.provenance).toBeTruthy();
    expect(validateRecommendationProvenance(out!)).toEqual([]);
    expect(out!.provenance!.asOf).toBe('2026-06-10');
    expect(out!.provenance!.stale).toBe(false);
    for (const obs of out!.provenance!.observations) {
      expect(obs.source).toContain('model-evals/results');
    }
    // Inference is kept separate from the observations (#1049).
    expect(out!.provenance!.inference).toContain('explicit user approval');
    expect(out?.evidence?.some((e) => e.includes('model-evals/results'))).toBe(true);
  });

  it('demotes wording and flags stale when the summary is old (#1102)', () => {
    const oldIso = new Date(NOW - (STALE_AFTER_DAYS + 10) * DAY_MS).toISOString();
    const out = detector.rule(input(summary({ generatedAt: oldIso })), NOW);
    expect(out?.provenance?.stale).toBe(true);
    expect(out?.title).toContain('as of');
    expect(out?.title).toContain('supported'); // past tense, not "supports"
    expect(out?.detail).toContain('may be stale');
  });

  it('declares the fix as manual — a routing change is never a validated copy-paste snippet (rule 6)', () => {
    const out = detector.rule(input(summary()), NOW);
    expect(out?.fix).toBeTruthy();
    expect(out!.fix!.fixKind).toBe('manual');
    expect(out!.fix!.target).toBe('CLAUDE.md');
    expect(out!.fix!.snippet).toContain('claude-sonnet-4-5');
  });

  it('self-suppresses once CLAUDE.md documents the scoped routing decision', () => {
    const md =
      '## Scoped model routing\n\n' +
      '<!-- scoped model-routing decision adopted from eval evidence (as of 2026-06-10) -->\n' +
      '- For `gap:haiku-sonnet:failure:small` tasks, prefer `claude-sonnet-4-5`.\n';
    expect(detector.rule(input(summary(), md), NOW)).toBeNull();
  });

  it('act-now gate helpers agree with the detector', () => {
    const s = summary();
    expect(actNowRoutingGaps(s)).toHaveLength(1);
    expect(actNowRoutingGaps(null)).toEqual([]);
    expect(isActNowRoutingGap(rec({ weightedScore: 0.95 }), s)).toBe(true);
    expect(
      isActNowRoutingGap(rec({ strongestEvidence: 'token-cost-discovery' }), s)
    ).toBe(false);
  });
});
