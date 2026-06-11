import { describe, expect, it } from 'vitest';
import { buildModelEvalBatchSpec } from './model-eval-batch';

describe('model eval batch spec', () => {
  it('builds a repeatable on-demand comparison spec with registry status', () => {
    const spec = buildModelEvalBatchSpec({
      candidates: ['claude-fable-1-20260609'],
      baselines: ['claude-opus-4-8', 'claude-sonnet-4-6'],
      corpus: 'shadow-calls',
      limit: 12,
      createdAt: '2026-06-09T17:00:00.000Z',
      outDir: '/tmp/evals',
    });

    expect(spec).toMatchObject({
      schemaVersion: 1,
      kind: 'model-eval-batch',
      createdAt: '2026-06-09T17:00:00.000Z',
      corpus: { source: 'shadow-calls', limit: 12 },
      output: { path: '/tmp/evals/model-eval-2026-06-09T17-00-00-000Z.json' },
      scoring: {
        quality: 0.5,
        cost: 0.25,
        latency: 0.15,
        reliability: 0.1,
      },
    });
    expect(spec.models).toEqual([
      {
        id: 'claude-fable-1-20260609',
        role: 'candidate',
        registered: false,
        inferredFamily: null,
      },
      {
        id: 'claude-opus-4-8',
        role: 'baseline',
        registered: true,
        inferredFamily: 'opus',
      },
      {
        id: 'claude-sonnet-4-6',
        role: 'baseline',
        registered: true,
        inferredFamily: 'sonnet',
      },
    ]);
  });

  it('rejects empty candidate or baseline sets', () => {
    expect(() =>
      buildModelEvalBatchSpec({ candidates: [], baselines: ['claude-sonnet-4-6'] })
    ).toThrow(/candidate/i);
    expect(() =>
      buildModelEvalBatchSpec({ candidates: ['claude-fable-1'], baselines: [] })
    ).toThrow(/baseline/i);
  });
});
