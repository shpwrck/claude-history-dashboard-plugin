import { describe, expect, it } from 'vitest';
import {
  EVAL_SCORING_WEIGHTS,
  EVAL_VETOES,
  EVIDENCE_STRENGTHS,
  EVIDENCE_STRENGTH_RANK,
  computeWeightedScore,
  sanitizeModelEvalResult,
  type ModelEvalResult,
} from './model-eval-result';

const fixedNow = () => new Date('2026-06-10T12:00:00.000Z');

function validResult(): unknown {
  return {
    schemaVersion: 1,
    kind: 'model-eval-result',
    createdAt: '2026-06-10T09:30:00.000Z',
    batchPath: '/tmp/evals/model-eval-2026-06-10.json',
    scoring: EVAL_SCORING_WEIGHTS,
    runs: [
      {
        runId: 'run-1',
        modelId: 'claude-fable-1-20260609',
        role: 'candidate',
        clusterId: 'cluster-refactor',
        scores: { quality: 1, cost: 1, latency: 1, reliability: 1 },
        weightedScore: 999,
        evidence: [
          {
            strength: 'shadow-replay-verdict',
            detail: 'candidate matched baseline at 1/8 cost',
            delta: 0.4,
          },
          {
            strength: 'token-cost-discovery',
            detail: 'cheaper per token',
            delta: 0.1,
          },
        ],
        vetoes: [],
      },
      {
        runId: 'run-2',
        modelId: 'claude-opus-4-8',
        role: 'baseline',
        clusterId: 'cluster-refactor',
        scores: { quality: 0.8, cost: 0.2, latency: 0.5, reliability: 0.9 },
        weightedScore: 0,
        evidence: [],
        vetoes: [],
      },
    ],
    exclusions: [
      { runId: 'run-3', disposition: 'filtered', reason: 'timed out' },
      { runId: 'run-4', disposition: 'kept', reason: 'flaky but representative' },
    ],
    recommendations: [
      {
        modelId: 'claude-fable-1-20260609',
        scope: 'cluster-refactor',
        weightedScore: 0.92,
        strongestEvidence: 'shadow-replay-verdict',
        rationale: 'matched on quality at materially lower cost',
      },
    ],
  };
}

describe('model eval result schema', () => {
  it('round-trips a valid result through the sanitizer', () => {
    const sanitized = sanitizeModelEvalResult(validResult(), fixedNow);
    expect(sanitized).not.toBeNull();
    const result = sanitized as ModelEvalResult;

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 'model-eval-result',
      createdAt: '2026-06-10T09:30:00.000Z',
      batchPath: '/tmp/evals/model-eval-2026-06-10.json',
      scoring: { quality: 0.5, cost: 0.25, latency: 0.15, reliability: 0.1 },
    });
    expect(result.runs).toHaveLength(2);
    expect(result.exclusions).toHaveLength(2);
    expect(result.recommendations).toHaveLength(1);

    // Sanitizing the sanitized output is stable (idempotent round-trip).
    const again = sanitizeModelEvalResult(result, fixedNow);
    expect(again).toEqual(result);
  });

  it('recomputes the weighted score per the 50/25/15/10 weighting', () => {
    expect(EVAL_SCORING_WEIGHTS).toEqual({
      quality: 0.5,
      cost: 0.25,
      latency: 0.15,
      reliability: 0.1,
    });
    // All-ones dimensions sum to the full weight (1.0); the stored 999 is dropped.
    const result = sanitizeModelEvalResult(validResult(), fixedNow) as ModelEvalResult;
    expect(result.runs[0].weightedScore).toBeCloseTo(1, 10);

    // Mixed dimensions: 0.8*0.5 + 0.2*0.25 + 0.5*0.15 + 0.9*0.1 = 0.615
    expect(result.runs[1].weightedScore).toBeCloseTo(0.615, 10);

    expect(
      computeWeightedScore({
        quality: 0.8,
        cost: 0.2,
        latency: 0.5,
        reliability: 0.9,
      })
    ).toBeCloseTo(0.615, 10);
  });

  it('zeroes the weighted score when any hard veto fires', () => {
    const input = validResult() as { runs: Array<Record<string, unknown>> };
    input.runs[0].vetoes = ['unknown-pricing-or-api'];
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    expect(result.runs[0].vetoes).toEqual(['unknown-pricing-or-api']);
    expect(result.runs[0].weightedScore).toBe(0);
  });

  it('enforces the evidence-strength enum, dropping unknown strengths', () => {
    const input = validResult() as {
      runs: Array<{ evidence: Array<Record<string, unknown>> }>;
    };
    input.runs[0].evidence = [
      { strength: 'not-a-real-strength', detail: 'bogus', delta: 0.5 },
      { strength: 'objective-task-history', detail: 'real', delta: 0.2 },
    ];
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    expect(result.runs[0].evidence).toEqual([
      { strength: 'objective-task-history', detail: 'real', delta: 0.2 },
    ]);
  });

  it('enforces the veto enum, dropping unknown vetoes', () => {
    const input = validResult() as { runs: Array<Record<string, unknown>> };
    input.runs[0].vetoes = ['made-up-veto', 'failed-required-gate'];
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    expect(result.runs[0].vetoes).toEqual(['failed-required-gate']);
  });

  it('enforces the exclusion kept/filtered disposition', () => {
    const input = validResult() as { exclusions: Array<Record<string, unknown>> };
    input.exclusions = [
      { runId: 'run-x', disposition: 'banana', reason: 'invalid' },
      { runId: 'run-y', disposition: 'kept', reason: 'valid' },
    ];
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    expect(result.exclusions).toEqual([
      { runId: 'run-y', disposition: 'kept', reason: 'valid' },
    ]);
  });

  it('orders evidence strengths strongest-first, with token/cost weakest', () => {
    expect(EVIDENCE_STRENGTHS[0]).toBe('shadow-replay-verdict');
    expect(EVIDENCE_STRENGTHS[EVIDENCE_STRENGTHS.length - 1]).toBe(
      'token-cost-discovery'
    );
    expect(EVIDENCE_STRENGTH_RANK['shadow-replay-verdict']).toBeLessThan(
      EVIDENCE_STRENGTH_RANK['objective-task-history']
    );
    expect(EVIDENCE_STRENGTH_RANK['proxy-detector-signal']).toBeLessThan(
      EVIDENCE_STRENGTH_RANK['token-cost-discovery']
    );
  });

  it('clamps out-of-range dimension scores into [0,1]', () => {
    const input = validResult() as { runs: Array<Record<string, unknown>> };
    input.runs[0].scores = { quality: 5, cost: -2, latency: 0.5, reliability: 1 };
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    expect(result.runs[0].scores).toEqual({
      quality: 1,
      cost: 0,
      latency: 0.5,
      reliability: 1,
    });
  });

  it('rejects non-result inputs and drops malformed runs', () => {
    expect(sanitizeModelEvalResult(null)).toBeNull();
    expect(sanitizeModelEvalResult('nope')).toBeNull();
    expect(sanitizeModelEvalResult([])).toBeNull();
    expect(sanitizeModelEvalResult({ kind: 'something-else', batchPath: '/x' })).toBeNull();
    // Missing batchPath -> not a recognizable result.
    expect(sanitizeModelEvalResult({ kind: 'model-eval-result' })).toBeNull();

    const input = validResult() as { runs: unknown[] };
    input.runs = [{ runId: 'bad' }, ...(validResult() as { runs: unknown[] }).runs];
    const result = sanitizeModelEvalResult(input, fixedNow) as ModelEvalResult;
    // The malformed first run is dropped; the two valid ones survive.
    expect(result.runs).toHaveLength(2);
  });

  it('exposes the full veto enum', () => {
    expect(EVAL_VETOES).toEqual([
      'failed-required-gate',
      'materially-worse-correctness',
      'unknown-pricing-or-api',
      'insufficient-evidence',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A recommendation must be derivable from the artifact's own runs (#3134)
// ---------------------------------------------------------------------------

describe('routing recommendations are derived, not asserted (#3134)', () => {
  const withRecommendation = (rec: Record<string, unknown>) => {
    const base = validResult() as Record<string, unknown>;
    return { ...base, recommendations: [rec] };
  };

  it('rejects a recommendation with no matching run', () => {
    // Forged: a model/scope pair that appears nowhere in `runs`.
    const out = sanitizeModelEvalResult(
      withRecommendation({
        modelId: 'attacker-model',
        scope: 'cluster-refactor',
        weightedScore: 0.99,
        strongestEvidence: 'shadow-replay-verdict',
        rationale: 'route everything here',
      }),
      fixedNow
    );
    expect(out?.recommendations).toEqual([]);
  });

  it('rejects a recommendation whose scope matches no run cluster', () => {
    const out = sanitizeModelEvalResult(
      withRecommendation({
        modelId: 'claude-fable-1-20260609',
        scope: 'cluster-that-never-ran',
        weightedScore: 0.99,
        strongestEvidence: 'shadow-replay-verdict',
        rationale: 'unsupported scope',
      }),
      fixedNow
    );
    expect(out?.recommendations).toEqual([]);
  });

  it('ignores an inflated score and derives it from the supporting run', () => {
    const out = sanitizeModelEvalResult(
      withRecommendation({
        modelId: 'claude-fable-1-20260609',
        scope: 'cluster-refactor',
        // The artifact claims a score; the run's dimensions are all 1.
        weightedScore: 0.01,
        // ...and understates its own evidence.
        strongestEvidence: 'token-cost-discovery',
        rationale: 'matched on quality at materially lower cost',
      }),
      fixedNow
    );
    const rec = out!.recommendations[0];
    expect(rec).toBeDefined();
    // Derived from run-1 (all dimensions 1 → weighted 1), not the stated 0.01.
    expect(rec.weightedScore).toBeCloseTo(1, 9);
    // Derived from the run's strongest evidence, not the stated weaker label.
    expect(rec.strongestEvidence).toBe('shadow-replay-verdict');
    expect(rec.supportingRunIds).toEqual(['run-1']);
  });

  it('rejects a recommendation whose only supporting run is vetoed', () => {
    const base = validResult() as Record<string, unknown>;
    const runs = (base.runs as Record<string, unknown>[]).map((r) =>
      r.runId === 'run-1' ? { ...r, vetoes: ['insufficient-evidence'] } : r
    );
    const out = sanitizeModelEvalResult(
      { ...base, runs },
      fixedNow
    );
    // The artifact's own evidence disqualified the model it recommends.
    expect(out?.recommendations).toEqual([]);
  });

  it('rejects a recommendation whose supporting run carries no evidence', () => {
    const base = validResult() as Record<string, unknown>;
    const runs = (base.runs as Record<string, unknown>[]).map((r) =>
      r.runId === 'run-1' ? { ...r, evidence: [] } : r
    );
    const out = sanitizeModelEvalResult({ ...base, runs }, fixedNow);
    expect(out?.recommendations).toEqual([]);
  });

  it('round-trips a supported recommendation with its run references', () => {
    const out = sanitizeModelEvalResult(validResult(), fixedNow);
    const rec = out!.recommendations[0];
    expect(rec.modelId).toBe('claude-fable-1-20260609');
    expect(rec.scope).toBe('cluster-refactor');
    expect(rec.supportingRunIds).toEqual(['run-1']);
    // batchPath/createdAt live on the artifact and are attached at ingest.
    expect(out!.batchPath).toBe('/tmp/evals/model-eval-2026-06-10.json');
    expect(out!.createdAt).toBe('2026-06-10T09:30:00.000Z');
  });
});
