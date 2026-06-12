import { describe, it, expect } from 'vitest';
import {
  clusterKeptRuns,
  assignClusterIds,
  clusterIdFor,
  unprofiledClusterIdFor,
  parseTaskShapeCluster,
  parseTaskShapeClusters,
  SIZE_BAND_MEDIUM_MIN_TOKENS,
  SIZE_BAND_LARGE_MIN_TOKENS,
} from './model-gap-clustering';
import { sanitizeModelEvalResult } from './model-eval-result';
import type { GapMiningRun, ModelGapCandidate } from './model-gap-mining';

function run(over: Partial<GapMiningRun>): GapMiningRun {
  return {
    runId: 'r',
    modelId: 'claude-sonnet-4-6',
    family: 'sonnet',
    costProxyUsd: 0,
    totalTokens: 0,
    durationMs: 0,
    turns: 1,
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    ...over,
  };
}

function candidate(over: Partial<ModelGapCandidate>): ModelGapCandidate {
  return {
    runId: 'r',
    modelId: 'claude-sonnet-4-6',
    direction: 'sonnet->opus',
    discoveryScore: 0.5,
    evidence: [],
    ...over,
  };
}

describe('clusterKeptRuns', () => {
  it('returns [] for no kept candidates', () => {
    expect(clusterKeptRuns([], [run({})])).toEqual([]);
  });

  it('buckets by direction, dominant signal, and size band with stable IDs', () => {
    const runs = [
      // failure-dominated small haiku run
      run({ runId: 'h-fail', toolErrors: 9, totalTokens: 10_000 }),
      // cost-dominated large sonnet run (many turns keep tokens/turn below
      // h-fail's, so inefficiency does not tie with cost)
      run({ runId: 's-cost', costProxyUsd: 80, totalTokens: 3_000_000, turns: 1_000 }),
    ];
    const kept = [
      candidate({ runId: 'h-fail', direction: 'haiku->sonnet' }),
      candidate({ runId: 's-cost', direction: 'sonnet->opus' }),
    ];
    const clusters = clusterKeptRuns(kept, runs);
    expect(clusters.map((c) => c.clusterId)).toEqual([
      'gap:haiku-sonnet:failure:small',
      'gap:sonnet-opus:cost:large',
    ]);
    expect(clusters[0].dominantSignal).toBe('failure');
    expect(clusters[0].sizeBand).toBe('small');
    expect(clusters[1].runIds).toEqual(['s-cost']);
  });

  it('is order-independent: shuffled input yields identical clusters', () => {
    const runs = [
      run({ runId: 'a', toolErrors: 5, totalTokens: 1_000 }),
      run({ runId: 'b', costProxyUsd: 40, totalTokens: 500_000 }),
      run({ runId: 'c', toolErrors: 4, totalTokens: 2_000 }),
    ];
    const kept = [
      candidate({ runId: 'a', discoveryScore: 0.2 }),
      candidate({ runId: 'b', discoveryScore: 0.9 }),
      candidate({ runId: 'c', discoveryScore: 0.7 }),
    ];
    const forward = clusterKeptRuns(kept, runs);
    const reversed = clusterKeptRuns([...kept].reverse(), [...runs].reverse());
    expect(reversed).toEqual(forward);
  });

  it('orders members by discovery score desc, then runId', () => {
    const runs = [
      run({ runId: 'x', toolErrors: 3, totalTokens: 100 }),
      run({ runId: 'y', toolErrors: 3, totalTokens: 100 }),
      run({ runId: 'z', toolErrors: 3, totalTokens: 100 }),
    ];
    const kept = [
      candidate({ runId: 'z', discoveryScore: 0.4 }),
      candidate({ runId: 'y', discoveryScore: 0.9 }),
      candidate({ runId: 'x', discoveryScore: 0.4 }),
    ];
    const [cluster] = clusterKeptRuns(kept, runs);
    expect(cluster.runIds).toEqual(['y', 'x', 'z']);
    expect(cluster.runCount).toBe(3);
  });

  it('applies the fixed size-band thresholds exactly at the boundaries', () => {
    const runs = [
      run({ runId: 'small', costProxyUsd: 1, totalTokens: SIZE_BAND_MEDIUM_MIN_TOKENS - 1 }),
      run({ runId: 'medium', costProxyUsd: 1, totalTokens: SIZE_BAND_MEDIUM_MIN_TOKENS }),
      run({ runId: 'large', costProxyUsd: 1, totalTokens: SIZE_BAND_LARGE_MIN_TOKENS }),
    ];
    const kept = runs.map((r) => candidate({ runId: r.runId }));
    const clusters = clusterKeptRuns(kept, runs);
    const bandOf = (id: string) =>
      clusters.find((c) => c.runIds.includes(id))?.sizeBand;
    expect(bandOf('small')).toBe('small');
    expect(bandOf('medium')).toBe('medium');
    expect(bandOf('large')).toBe('large');
  });

  it('breaks dominant-signal ties in failure > inefficiency > duration > cost order', () => {
    // A single run is its own maximum on every non-zero signal (share 1 each):
    // the tie must resolve to the strongest-precedence signal present.
    const tied = run({
      runId: 't',
      toolErrors: 2,
      costProxyUsd: 10,
      durationMs: 5_000,
      totalTokens: 1_000,
      turns: 1,
    });
    const [cluster] = clusterKeptRuns([candidate({ runId: 't' })], [tied]);
    expect(cluster.dominantSignal).toBe('failure');

    // Without any failure, inefficiency (tokens/turn) outranks duration/cost.
    const noFail = run({
      runId: 'n',
      costProxyUsd: 10,
      durationMs: 5_000,
      totalTokens: 1_000,
      turns: 1,
    });
    const [c2] = clusterKeptRuns([candidate({ runId: 'n' })], [noFail]);
    expect(c2.dominantSignal).toBe('inefficiency');
  });

  it('normalises dominance over the KEPT profiled set, not all mined runs', () => {
    const runs = [
      // Kept: modest failure, modest cost.
      run({ runId: 'kept-1', toolErrors: 2, costProxyUsd: 1, totalTokens: 1_000, turns: 10 }),
      // NOT kept, but present in runs with a huge failure count. If maxima
      // were taken over all runs, kept-1's failure share would shrink and
      // cost would dominate instead.
      run({ runId: 'filtered-out', toolErrors: 100, costProxyUsd: 1, totalTokens: 1_000, turns: 10 }),
    ];
    const [cluster] = clusterKeptRuns([candidate({ runId: 'kept-1' })], runs);
    expect(cluster.dominantSignal).toBe('failure');
  });

  it('routes candidates without a run profile to the per-direction unprofiled bucket', () => {
    const kept = [
      candidate({ runId: 'ghost-h', direction: 'haiku->sonnet' }),
      candidate({ runId: 'ghost-s', direction: 'sonnet->opus' }),
    ];
    const clusters = clusterKeptRuns(kept, []);
    expect(clusters.map((c) => c.clusterId)).toEqual([
      'gap:haiku-sonnet:unprofiled',
      'gap:sonnet-opus:unprofiled',
    ]);
    expect(clusters[0].dominantSignal).toBeNull();
    expect(clusters[0].sizeBand).toBeNull();
  });

  it('routes an all-zero-signal profiled run to unprofiled instead of mislabeling it failure', () => {
    const zero = run({ runId: 'z', totalTokens: 0, turns: 3 });
    const clusters = clusterKeptRuns([candidate({ runId: 'z' })], [zero]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterId).toBe('gap:sonnet-opus:unprofiled');
    expect(clusters[0].dominantSignal).toBeNull();
  });

  it('groups same-shape runs into one bucket', () => {
    const runs = [
      run({ runId: 'a', toolErrors: 5, totalTokens: 1_000 }),
      run({ runId: 'b', toolErrors: 6, totalTokens: 2_000 }),
    ];
    const kept = [
      candidate({ runId: 'a' }),
      candidate({ runId: 'b' }),
    ];
    const clusters = clusterKeptRuns(kept, runs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].runCount).toBe(2);
  });
});

describe('cluster IDs and the eval-result schema', () => {
  it('clusterIdFor / unprofiledClusterIdFor are pure and slug the direction', () => {
    expect(clusterIdFor('haiku->sonnet', 'failure', 'small')).toBe(
      'gap:haiku-sonnet:failure:small'
    );
    expect(unprofiledClusterIdFor('sonnet->opus')).toBe('gap:sonnet-opus:unprofiled');
  });

  it('assignClusterIds flattens clusters into per-run stamps', () => {
    const runs = [
      run({ runId: 'a', toolErrors: 5, totalTokens: 1_000 }),
      run({ runId: 'b', costProxyUsd: 30, totalTokens: 3_000_000, turns: 10_000 }),
    ];
    const kept = [candidate({ runId: 'a' }), candidate({ runId: 'b' })];
    const assignments = assignClusterIds(clusterKeptRuns(kept, runs));
    expect(assignments).toEqual([
      { runId: 'b', clusterId: 'gap:sonnet-opus:cost:large' },
      { runId: 'a', clusterId: 'gap:sonnet-opus:failure:small' },
    ]);
  });

  it('cluster IDs survive the committed eval-result sanitizer on a run record', () => {
    const clusterId = clusterIdFor('haiku->sonnet', 'inefficiency', 'medium');
    const result = sanitizeModelEvalResult({
      kind: 'model-eval-result',
      batchPath: 'batches/test.json',
      runs: [
        {
          runId: 'r1',
          modelId: 'claude-sonnet-4-6',
          role: 'candidate',
          clusterId,
          scores: { quality: 0.5, cost: 0.5, latency: 0.5, reliability: 0.5 },
          evidence: [],
          vetoes: [],
        },
      ],
      exclusions: [],
      recommendations: [],
    });
    expect(result).not.toBeNull();
    expect(result!.runs).toHaveLength(1);
    expect(result!.runs[0].clusterId).toBe(clusterId);
  });
});

describe('parseTaskShapeClusters', () => {
  const valid = {
    clusterId: 'gap:haiku-sonnet:failure:small',
    direction: 'haiku->sonnet',
    dominantSignal: 'failure',
    sizeBand: 'small',
    runIds: ['r1', 'r2'],
    runCount: 2,
  };

  it('round-trips the clusterKeptRuns output unchanged', () => {
    const runs = [run({ runId: 'a', toolErrors: 5, totalTokens: 1_000 })];
    const clusters = clusterKeptRuns([candidate({ runId: 'a' })], runs);
    expect(parseTaskShapeClusters(clusters)).toEqual(clusters);
  });

  it('parses a valid raw cluster and accepts the unprofiled shape', () => {
    expect(parseTaskShapeCluster(valid)).toEqual(valid);
    const unprofiled = {
      clusterId: 'gap:sonnet-opus:unprofiled',
      direction: 'sonnet->opus',
      dominantSignal: null,
      sizeBand: null,
      runIds: ['x'],
      runCount: 1,
    };
    expect(parseTaskShapeCluster(unprofiled)).toEqual(unprofiled);
  });

  it('fails closed on malformed input', () => {
    expect(parseTaskShapeCluster(null)).toBeNull();
    expect(parseTaskShapeCluster([])).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, clusterId: '  ' })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, direction: 'haiku->opus' })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, dominantSignal: 'vibes' })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, sizeBand: 'huge' })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, runIds: [] })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, runIds: 'r1' })).toBeNull();
    // Profile halves must be consistent: both set or both null.
    expect(parseTaskShapeCluster({ ...valid, dominantSignal: null })).toBeNull();
    expect(parseTaskShapeCluster({ ...valid, sizeBand: null })).toBeNull();
  });

  it('dedupes run ids and recomputes runCount instead of trusting it', () => {
    const parsed = parseTaskShapeCluster({
      ...valid,
      runIds: ['r1', 'r1', ' r2 ', ''],
      runCount: 99,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.runIds).toEqual(['r1', 'r2']);
    expect(parsed!.runCount).toBe(2);
  });

  it('drops malformed entries and dedupes by clusterId (first wins)', () => {
    const second = { ...valid, runIds: ['other'] };
    const clusters = parseTaskShapeClusters([
      valid,
      'junk',
      { ...valid, direction: 'nope' },
      second,
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].runIds).toEqual(['r1', 'r2']);
    expect(parseTaskShapeClusters('not-an-array')).toEqual([]);
  });
});
