import { describe, expect, it } from 'vitest';
import { ARTIFACT_LEDGER_CAP, ingestModelEvalResults } from './model-eval-ingest';
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
      artifacts: [],
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

  /**
   * CHANGED in #3134. The old fixture asserted weightedScore 0.4 / 0.8 / 0.6 and
   * evidence strengths that NO run in either artifact produced -- the
   * cluster-a runs carried `evidence: []` and no cluster-b run existed at all.
   * It therefore exercised dedupe over recommendations the artifacts did not
   * support, which is the defect. Each recommendation now has a real supporting
   * run, and the scores/evidence are DERIVED from those runs rather than
   * asserted by the fixture, so the dedupe property is tested on claims that
   * could actually exist.
   */
  it('dedupes recommendations by (modelId, scope) keeping the strongest', () => {
    // Weaker supporting run: mid scores, proxy-signal evidence only.
    const weakRun = run({
      runId: 'run-weak',
      clusterId: 'cluster-a',
      scores: { quality: 0.4, cost: 0.4, latency: 0.4, reliability: 0.4 },
      evidence: [{ strength: 'proxy-detector-signal', detail: 'weak', delta: 0.1 }],
    });
    // Stronger supporting run for the SAME (model, scope): top scores, replay verdict.
    const strongRun = run({
      runId: 'run-strong',
      clusterId: 'cluster-a',
      scores: { quality: 1, cost: 1, latency: 1, reliability: 1 },
      evidence: [{ strength: 'shadow-replay-verdict', detail: 'strong', delta: 0.4 }],
    });
    const otherScopeRun = run({
      runId: 'run-other',
      clusterId: 'cluster-b',
      scores: { quality: 0.6, cost: 0.6, latency: 0.6, reliability: 0.6 },
      evidence: [{ strength: 'objective-task-history', detail: 'other', delta: 0.2 }],
    });

    const s = ingestModelEvalResults(
      [
        artifact({
          runs: [weakRun],
          recommendations: [
            {
              modelId: 'claude-candidate',
              scope: 'cluster-a',
              rationale: 'weaker earlier read',
            },
          ],
        }),
        artifact({
          runs: [strongRun, otherScopeRun],
          recommendations: [
            {
              modelId: 'claude-candidate',
              scope: 'cluster-a',
              rationale: 'stronger later read',
            },
            {
              modelId: 'claude-candidate',
              scope: 'cluster-b',
              rationale: 'other scope',
            },
          ],
        }),
      ],
      fixedNow
    );

    expect(s.recommendations).toHaveLength(2);
    // The stronger supporting run wins the (modelId, scope) key...
    expect(s.recommendations[0]).toMatchObject({
      scope: 'cluster-a',
      rationale: 'stronger later read',
      strongestEvidence: 'shadow-replay-verdict',
      supportingRunIds: ['run-strong'],
    });
    // ...and its score is the one its run produces, not one the artifact claimed.
    expect(s.recommendations[0].weightedScore).toBeCloseTo(1, 9);
    expect(s.recommendations[0].weightedScore).toBeGreaterThan(
      s.recommendations[1].weightedScore
    );
    expect(s.recommendations[1]).toMatchObject({
      scope: 'cluster-b',
      supportingRunIds: ['run-other'],
    });
    // Both carry the artifact they came from, and when it was measured.
    for (const rec of s.recommendations) {
      expect(rec.batchPath).toBe('/tmp/evals/batch.json');
      expect(rec.asOf).toBe('2026-06-10T09:30:00.000Z');
    }
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

  it('records one result-history ledger entry per ingested artifact (#1387)', () => {
    const s = ingestModelEvalResults(
      [
        artifact({
          batchPath: '/tmp/evals/older.json',
          createdAt: '2026-06-08T10:00:00.000Z',
          runs: [
            run({ runId: 'r1', vetoes: ['failed-required-gate'] }),
            run({ runId: 'r2' }),
            run({ runId: 'r3' }),
          ],
        }),
        artifact({
          batchPath: '/tmp/evals/newer.json',
          createdAt: '2026-06-10T10:00:00.000Z',
          runs: [run({ runId: 'r4' })],
        }),
        { kind: 'not-an-eval' }, // dropped by the sanitizer: no ledger entry
      ],
      fixedNow
    );
    // Newest first, regardless of input order.
    expect(s.artifacts).toEqual([
      {
        batchPath: '/tmp/evals/newer.json',
        createdAt: '2026-06-10T10:00:00.000Z',
        runCount: 1,
        vetoedRuns: 0,
      },
      {
        batchPath: '/tmp/evals/older.json',
        createdAt: '2026-06-08T10:00:00.000Z',
        runCount: 3,
        vetoedRuns: 1,
      },
    ]);
    expect(s.artifacts).toHaveLength(s.artifactCount);
  });

  it('orders ledger ties on createdAt by batchPath asc (#1387)', () => {
    const s = ingestModelEvalResults(
      [
        artifact({ batchPath: '/tmp/evals/b.json' }),
        artifact({ batchPath: '/tmp/evals/a.json' }),
      ],
      fixedNow
    );
    expect(s.artifacts.map((a) => a.batchPath)).toEqual([
      '/tmp/evals/a.json',
      '/tmp/evals/b.json',
    ]);
  });

  it('bounds the ledger to the most-recent ARTIFACT_LEDGER_CAP artifacts (#1387)', () => {
    const total = ARTIFACT_LEDGER_CAP + 5;
    const dayMs = 24 * 60 * 60 * 1000;
    const base = Date.UTC(2026, 0, 1); // one artifact per day from 2026-01-01
    const inputs = [];
    for (let i = 0; i < total; i++) {
      const tag = String(i).padStart(2, '0');
      inputs.push(
        artifact({
          batchPath: `/tmp/evals/batch-${tag}.json`,
          createdAt: new Date(base + i * dayMs).toISOString(),
        })
      );
    }
    const s = ingestModelEvalResults(inputs, fixedNow);
    // The uncapped total survives on artifactCount; the ledger is bounded...
    expect(s.artifactCount).toBe(total);
    expect(s.artifacts).toHaveLength(ARTIFACT_LEDGER_CAP);
    // ...and deterministically keeps the newest entries (the 5 oldest drop).
    expect(s.artifacts[0].batchPath).toBe(`/tmp/evals/batch-${total - 1}.json`);
    expect(s.artifacts[ARTIFACT_LEDGER_CAP - 1].batchPath).toBe(
      '/tmp/evals/batch-05.json'
    );
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
