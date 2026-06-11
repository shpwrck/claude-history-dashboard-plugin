import { describe, expect, it } from 'vitest';
import { ingestModelEvalResults } from './model-eval-ingest';
import { EVAL_VETOES } from './model-eval-result';

const fixedNow = () => new Date('2026-06-11T00:00:00.000Z');

/** A minimal valid run; override fields per case. */
function run(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: 'run-1',
    modelId: 'claude-candidate',
    role: 'candidate',
    clusterId: 'cluster-a',
    scores: { quality: 1, cost: 1, latency: 1, reliability: 1 },
    weightedScore: 999, // ignored; sanitizer recomputes from scores
    evidence: [],
    vetoes: [],
    ...overrides,
  };
}

/** A minimal valid artifact; override fields per case. */
function artifact(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    kind: 'model-eval-result',
    createdAt: '2026-06-10T09:30:00.000Z',
    batchPath: '/tmp/evals/batch.json',
    runs: [run()],
    exclusions: [],
    recommendations: [],
    ...overrides,
  };
}

describe('ingestModelEvalResults', () => {
  it('summarizes an empty input into a stable zeroed shape', () => {
    const s = ingestModelEvalResults([], fixedNow);
    expect(s).toEqual({
      schemaVersion: 1,
      kind: 'model-eval-summary',
      generatedAt: '2026-06-11T00:00:00.000Z',
      artifactCount: 0,
      runCount: 0,
      models: [],
      vetoTotals: Object.fromEntries(EVAL_VETOES.map((v) => [v, 0])),
      exclusions: { kept: 0, filtered: 0 },
      recommendations: [],
    });
  });

  it('drops artifacts the committed schema rejects', () => {
    const s = ingestModelEvalResults(
      [artifact(), { kind: 'not-an-eval' }, null, 42, { kind: 'model-eval-result' }],
      fixedNow
    );
    // Only the one well-formed artifact survives (the last lacks batchPath).
    expect(s.artifactCount).toBe(1);
    expect(s.runCount).toBe(1);
  });

  it('preserves weighted scores recomputed from the canonical weights', () => {
    // quality .5 cost .5 latency .5 reliability .5 -> 0.5 weighted.
    const s = ingestModelEvalResults(
      [
        artifact({
          runs: [
            run({
              scores: { quality: 0.5, cost: 0.5, latency: 0.5, reliability: 0.5 },
            }),
          ],
        }),
      ],
      fixedNow
    );
    expect(s.models).toHaveLength(1);
    expect(s.models[0].bestWeightedScore).toBeCloseTo(0.5, 10);
    expect(s.models[0].meanWeightedScore).toBeCloseTo(0.5, 10);
  });

  it('preserves vetoes: zeroes the score, counts vetoed runs, totals occurrences', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          runs: [
            run({
              runId: 'r1',
              vetoes: ['failed-required-gate', 'unknown-pricing-or-api'],
            }),
            run({ runId: 'r2', vetoes: [] }),
          ],
        }),
      ],
      fixedNow
    );
    const m = s.models[0];
    expect(m.vetoedRuns).toBe(1);
    // canonical enum order, not input order
    expect(m.vetoes).toEqual(['failed-required-gate', 'unknown-pricing-or-api']);
    // vetoed run scores 0; the clean run scores 1 -> mean 0.5, best 1
    expect(m.bestWeightedScore).toBeCloseTo(1, 10);
    expect(m.meanWeightedScore).toBeCloseTo(0.5, 10);
    expect(s.vetoTotals['failed-required-gate']).toBe(1);
    expect(s.vetoTotals['unknown-pricing-or-api']).toBe(1);
    expect(s.vetoTotals['materially-worse-correctness']).toBe(0);
  });

  it('preserves the strongest evidence strength across a model runs', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          runs: [
            run({
              runId: 'r1',
              evidence: [
                { strength: 'token-cost-discovery', detail: 'cheaper', delta: 0.1 },
                { strength: 'proxy-detector-signal', detail: 'fewer retries', delta: 0.2 },
              ],
            }),
            run({
              runId: 'r2',
              evidence: [
                { strength: 'shadow-replay-verdict', detail: 'matched at 1/8 cost', delta: 0.5 },
              ],
            }),
          ],
        }),
      ],
      fixedNow
    );
    const m = s.models[0];
    expect(m.strongestEvidence).toBe('shadow-replay-verdict');
    expect(m.evidenceCount).toBe(3);
  });

  it('rolls up runs across artifacts and sorts models by best score desc then id asc', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          batchPath: '/tmp/a.json',
          runs: [
            run({ modelId: 'b-model', scores: { quality: 0.2, cost: 0.2, latency: 0.2, reliability: 0.2 } }),
          ],
        }),
        artifact({
          batchPath: '/tmp/b.json',
          runs: [
            run({ modelId: 'a-model', scores: { quality: 0.9, cost: 0.9, latency: 0.9, reliability: 0.9 } }),
            run({ modelId: 'a-model', role: 'baseline', scores: { quality: 0.9, cost: 0.9, latency: 0.9, reliability: 0.9 } }),
          ],
        }),
      ],
      fixedNow
    );
    expect(s.runCount).toBe(3);
    expect(s.models.map((m) => m.modelId)).toEqual(['a-model', 'b-model']);
    expect(s.models[0].runCount).toBe(2);
    expect(s.models[0].candidateRuns).toBe(1);
    expect(s.models[0].baselineRuns).toBe(1);
  });

  it('dedupes recommendations by (modelId, scope) keeping the strongest', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          recommendations: [
            {
              modelId: 'claude-candidate',
              scope: 'cluster-a',
              weightedScore: 0.4,
              strongestEvidence: 'proxy-detector-signal',
              rationale: 'weaker earlier read',
            },
          ],
        }),
        artifact({
          recommendations: [
            {
              modelId: 'claude-candidate',
              scope: 'cluster-a',
              weightedScore: 0.8,
              strongestEvidence: 'shadow-replay-verdict',
              rationale: 'stronger later read',
            },
            {
              modelId: 'claude-candidate',
              scope: 'cluster-b',
              weightedScore: 0.6,
              strongestEvidence: 'objective-task-history',
              rationale: 'other scope',
            },
          ],
        }),
      ],
      fixedNow
    );
    expect(s.recommendations).toHaveLength(2);
    // sorted by weightedScore desc: cluster-a (0.8) then cluster-b (0.6)
    expect(s.recommendations[0]).toMatchObject({
      scope: 'cluster-a',
      weightedScore: 0.8,
      rationale: 'stronger later read',
    });
    expect(s.recommendations[1].scope).toBe('cluster-b');
  });

  it('counts kept and filtered exclusions across artifacts', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          exclusions: [
            { runId: 'x1', disposition: 'filtered', reason: 'human waiting time' },
            { runId: 'x2', disposition: 'kept', reason: 'genuine model gap' },
          ],
        }),
        artifact({
          exclusions: [
            { runId: 'x3', disposition: 'filtered', reason: 'known baseline failure' },
          ],
        }),
      ],
      fixedNow
    );
    expect(s.exclusions).toEqual({ kept: 1, filtered: 2 });
  });

  it('is deterministic: identical input and clock yield byte-identical output', () => {
    const input = [
      artifact({
        runs: [
          run({ modelId: 'm2' }),
          run({ modelId: 'm1', scores: { quality: 0.3, cost: 0.3, latency: 0.3, reliability: 0.3 } }),
        ],
        recommendations: [
          { modelId: 'm1', scope: 's1', weightedScore: 0.5, strongestEvidence: 'objective-task-history', rationale: 'r' },
        ],
      }),
    ];
    const a = JSON.stringify(ingestModelEvalResults(input, fixedNow));
    const b = JSON.stringify(ingestModelEvalResults(input, fixedNow));
    expect(a).toBe(b);
  });
});
