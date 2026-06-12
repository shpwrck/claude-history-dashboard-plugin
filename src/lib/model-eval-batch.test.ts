import { describe, expect, it } from 'vitest';
import {
  CORPUS_ADDRESS_ORDER,
  buildModelEvalBatchSpec,
  generateEvalBatchesFromClusters,
  modelPairForDirection,
  validateModelEvalBatchSpec,
} from './model-eval-batch';
import { CURATED_CORPUS } from './model-eval-corpus';
import { CURRENT_MODEL_IDS } from './model-registry';
import type { TaskShapeCluster } from './model-gap-clustering';

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
        inferredFamily: 'fable',
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

function cluster(over: Partial<TaskShapeCluster>): TaskShapeCluster {
  return {
    clusterId: 'gap:haiku-sonnet:failure:small',
    direction: 'haiku->sonnet',
    dominantSignal: 'failure',
    sizeBand: 'small',
    runIds: ['r1', 'r2', 'r3'],
    runCount: 3,
    ...over,
  };
}

const CREATED_AT = '2026-06-11T09:00:00.000Z';

describe('modelPairForDirection', () => {
  it('derives both sides of the pair from the model registry', () => {
    expect(modelPairForDirection('haiku->sonnet')).toEqual({
      candidate: CURRENT_MODEL_IDS.sonnet,
      baseline: CURRENT_MODEL_IDS.haiku,
    });
    expect(modelPairForDirection('sonnet->opus')).toEqual({
      candidate: CURRENT_MODEL_IDS.opus,
      baseline: CURRENT_MODEL_IDS.sonnet,
    });
  });
});

describe('generateEvalBatchesFromClusters', () => {
  it('generates one spec per cluster x corpus with material, in the settled order', () => {
    const specs = generateEvalBatchesFromClusters(
      [cluster({})],
      {
        fixtures: CURATED_CORPUS,
        replayRunIds: ['r2', 'unrelated'],
        shadowRunIds: ['r3'],
      },
      { createdAt: CREATED_AT }
    );
    expect(specs.map((s) => s.corpus.source)).toEqual([
      'curated-fixtures',
      'replay-history',
      'shadow-calls',
    ]);
    expect(CORPUS_ADDRESS_ORDER).toEqual([
      'curated-fixtures',
      'replay-history',
      'shadow-calls',
    ]);
    for (const spec of specs) {
      expect(spec.cluster).toEqual({
        clusterId: 'gap:haiku-sonnet:failure:small',
        direction: 'haiku->sonnet',
        dominantSignal: 'failure',
        sizeBand: 'small',
        runCount: 3,
      });
      expect(spec.models).toEqual([
        {
          id: CURRENT_MODEL_IDS.sonnet,
          role: 'candidate',
          registered: true,
          inferredFamily: 'sonnet',
        },
        {
          id: CURRENT_MODEL_IDS.haiku,
          role: 'baseline',
          registered: true,
          inferredFamily: 'haiku',
        },
      ]);
    }
  });

  it('addresses all three corpora through the one task-ref schema', () => {
    const [fixtures, replay, shadow] = generateEvalBatchesFromClusters(
      [cluster({})],
      { fixtures: CURATED_CORPUS, replayRunIds: ['r2', 'r1'], shadowRunIds: ['r3'] },
      { createdAt: CREATED_AT }
    );
    expect(fixtures.tasks).toEqual(
      CURATED_CORPUS.map((task) => ({
        source: 'curated-fixtures',
        taskId: task.id,
        gateKind: task.gate.kind,
      }))
    );
    // The #1080 fixtures runner contract stays mirrored in corpusTasks.
    expect(fixtures.corpusTasks).toEqual(
      CURATED_CORPUS.map((task) => ({ taskId: task.id, gateKind: task.gate.kind }))
    );
    // History refs keep the cluster's discovery order, not the corpus list order.
    expect(replay.tasks).toEqual([
      { source: 'replay-history', taskId: 'r1', gateKind: null },
      { source: 'replay-history', taskId: 'r2', gateKind: null },
    ]);
    expect(replay.corpusTasks).toBeUndefined();
    expect(shadow.tasks).toEqual([
      { source: 'shadow-calls', taskId: 'r3', gateKind: null },
    ]);
  });

  it('skips corpora without matching material and clusters with none anywhere', () => {
    const specs = generateEvalBatchesFromClusters(
      [
        cluster({}),
        cluster({
          clusterId: 'gap:sonnet-opus:unprofiled',
          direction: 'sonnet->opus',
          dominantSignal: null,
          sizeBand: null,
          runIds: ['ghost'],
          runCount: 1,
        }),
      ],
      { replayRunIds: ['r1'] },
      { createdAt: CREATED_AT }
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].corpus.source).toBe('replay-history');
    expect(specs[0].cluster?.clusterId).toBe('gap:haiku-sonnet:failure:small');
    expect(
      generateEvalBatchesFromClusters([cluster({})], {}, { createdAt: CREATED_AT })
    ).toEqual([]);
  });

  it('caps tasks at the limit and threads outDir into unique per-spec paths', () => {
    const specs = generateEvalBatchesFromClusters(
      [
        cluster({}),
        cluster({
          clusterId: 'gap:sonnet-opus:cost:large',
          direction: 'sonnet->opus',
          dominantSignal: 'cost',
          sizeBand: 'large',
          runIds: ['r1', 'r2', 'r3'],
          runCount: 3,
        }),
      ],
      { fixtures: CURATED_CORPUS, replayRunIds: ['r1', 'r2', 'r3'] },
      { createdAt: CREATED_AT, limit: 2, outDir: '/tmp/evals/' }
    );
    for (const spec of specs) {
      expect(spec.tasks!.length).toBeLessThanOrEqual(2);
      expect(spec.corpus.limit).toBe(2);
    }
    const paths = specs.map((s) => s.output.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe(
      '/tmp/evals/model-eval-gap-haiku-sonnet-failure-small-curated-fixtures-2026-06-11T09-00-00-000Z.json'
    );
  });

  it('is deterministic for a fixed createdAt and dedupes duplicate cluster ids', () => {
    const corpora = { fixtures: CURATED_CORPUS, replayRunIds: ['r1'] };
    const once = generateEvalBatchesFromClusters([cluster({}), cluster({})], corpora, {
      createdAt: CREATED_AT,
    });
    const twice = generateEvalBatchesFromClusters([cluster({})], corpora, {
      createdAt: CREATED_AT,
    });
    expect(once).toEqual(twice);
  });

  it('produces specs that validate against the batch schema', () => {
    const specs = generateEvalBatchesFromClusters(
      [
        cluster({}),
        cluster({
          clusterId: 'gap:sonnet-opus:unprofiled',
          direction: 'sonnet->opus',
          dominantSignal: null,
          sizeBand: null,
          runIds: ['r9'],
          runCount: 1,
        }),
      ],
      { fixtures: CURATED_CORPUS, replayRunIds: ['r1', 'r9'], shadowRunIds: ['r2'] },
      { createdAt: CREATED_AT }
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(validateModelEvalBatchSpec(spec)).toEqual({ ok: true, errors: [] });
    }
  });
});

describe('validateModelEvalBatchSpec', () => {
  const base = () =>
    generateEvalBatchesFromClusters(
      [cluster({})],
      { fixtures: CURATED_CORPUS, replayRunIds: ['r1'] },
      { createdAt: CREATED_AT }
    );

  it('accepts plain (non-cluster) specs from the existing builder', () => {
    const spec = buildModelEvalBatchSpec({
      candidates: ['claude-fable-1-20260609'],
      baselines: ['claude-opus-4-8'],
      createdAt: CREATED_AT,
    });
    expect(validateModelEvalBatchSpec(spec)).toEqual({ ok: true, errors: [] });
  });

  it('flags missing roles, bad enums, and drifted scoring', () => {
    const [spec] = base();
    const broken = {
      ...spec,
      models: spec.models.filter((m) => m.role !== 'baseline'),
      corpus: { source: 'vibes' as never, limit: 0 },
      scoring: { ...spec.scoring, quality: 0.9 },
      output: { path: ' ' },
    };
    const result = validateModelEvalBatchSpec(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'no baseline model',
        'unknown corpus source "vibes"',
        'corpus limit must be a positive integer',
        'scoring.quality drifted from the canonical weights',
        'output path is empty',
      ])
    );
  });

  it('enforces task-ref consistency with the corpus source and gate kinds', () => {
    const [fixtureSpec, replaySpec] = base();
    expect(
      validateModelEvalBatchSpec({
        ...replaySpec,
        tasks: [{ source: 'curated-fixtures', taskId: 'r1', gateKind: 'test' }],
      }).errors
    ).toContain('task ref source "curated-fixtures" does not match corpus source');
    expect(
      validateModelEvalBatchSpec({
        ...replaySpec,
        tasks: [{ source: 'replay-history', taskId: 'r1', gateKind: 'test' }],
      }).errors
    ).toContain('history task ref "r1" must have a null gateKind');
    expect(
      validateModelEvalBatchSpec({
        ...fixtureSpec,
        tasks: fixtureSpec.tasks!.map((t) => ({ ...t, gateKind: null })),
      }).ok
    ).toBe(false);
    expect(
      validateModelEvalBatchSpec({
        ...replaySpec,
        tasks: [
          { source: 'replay-history', taskId: 'r1', gateKind: null },
          { source: 'replay-history', taskId: 'r1', gateKind: null },
        ],
      }).errors
    ).toContain('duplicate task ref "r1"');
    expect(
      validateModelEvalBatchSpec({
        ...replaySpec,
        corpusTasks: [{ taskId: 'x', gateKind: 'test' }],
      }).errors
    ).toContain('corpusTasks present for a non-fixtures corpus');
    expect(
      validateModelEvalBatchSpec({
        ...replaySpec,
        cluster: { ...replaySpec.cluster!, direction: 'haiku->opus' as never },
      }).errors
    ).toContain('cluster with unknown direction "haiku->opus"');
  });

  it('requires cluster and tasks to be co-present or co-absent', () => {
    const [spec] = base();
    const coPresence = 'cluster and tasks must be co-present or co-absent';
    expect(validateModelEvalBatchSpec({ ...spec, tasks: undefined }).errors).toContain(
      coPresence
    );
    expect(validateModelEvalBatchSpec({ ...spec, cluster: undefined }).errors).toContain(
      coPresence
    );
    // Both present (cluster-driven) and both absent (plain builder) are fine.
    expect(validateModelEvalBatchSpec(spec).errors).not.toContain(coPresence);
    expect(
      validateModelEvalBatchSpec({ ...spec, cluster: undefined, tasks: undefined }).errors
    ).not.toContain(coPresence);
  });

  it('rejects a non-positive or non-integer cluster runCount', () => {
    const [spec] = base();
    for (const runCount of [0, -1, 1.5]) {
      expect(
        validateModelEvalBatchSpec({
          ...spec,
          cluster: { ...spec.cluster!, runCount },
        }).errors
      ).toContain('cluster runCount must be a positive integer');
    }
  });

  it('rejects tasks exceeding the corpus limit', () => {
    const [spec] = base();
    expect(
      validateModelEvalBatchSpec({
        ...spec,
        corpus: { ...spec.corpus, limit: 2 },
        tasks: [
          { source: 'curated-fixtures', taskId: 'a', gateKind: 'test' },
          { source: 'curated-fixtures', taskId: 'b', gateKind: 'test' },
          { source: 'curated-fixtures', taskId: 'c', gateKind: 'test' },
        ],
      }).errors
    ).toContain('tasks exceed the corpus limit');
  });
});
