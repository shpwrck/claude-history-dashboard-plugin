import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_STRENGTH_LABELS,
  buildProposedBatchSpec,
  buildProposedReplayBatchSpecs,
  buildWorkbenchClusters,
  buildWorkbenchGapAnalysis,
  joinWorkbenchCandidateExclusions,
  serializeProposedBatchSpec,
  serializeProposedBatchSpecs,
} from './model-evals-workbench';
import {
  EVIDENCE_STRENGTHS,
  type EvalExclusion,
} from './model-eval-result';
import { CURRENT_MODEL_IDS } from './model-registry';
import type { ModelGapCandidate } from './model-gap-mining';
import type { SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';

function haikuSession(id: string): SessionTokenData {
  return {
    sessionId: id,
    entries: [
      {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 50_000,
        outputTokens: 5_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ],
  } as unknown as SessionTokenData;
}

function toolErrors(sessionId: string, errors: number): ToolUsageData {
  return {
    sessionId,
    calls: Array.from({ length: errors }, () => ({ isError: true })),
  } as unknown as ToolUsageData;
}

function humanWaitingTimeline(sessionId: string): SessionTimeline {
  return {
    sessionId,
    startTime: '2026-06-01T00:00:00.000Z',
    endTime: '2026-06-01T01:00:00.000Z',
    entries: [
      {
        timestamp: '2026-06-01T00:00:00.000Z',
        kind: 'user',
        summary: 'Investigate the failure',
      },
      {
        timestamp: '2026-06-01T00:45:00.000Z',
        kind: 'assistant',
        summary: 'Resuming after the wait',
      },
    ],
  } as unknown as SessionTimeline;
}

function candidate(runId: string): ModelGapCandidate {
  return {
    runId,
    modelId: 'claude-haiku-4-5-20251001',
    direction: 'haiku->sonnet',
    discoveryScore: 0.5,
    evidence: [],
  };
}

describe('model-evals workbench data prep (#1086)', () => {
  it('labels every committed evidence strength', () => {
    for (const strength of EVIDENCE_STRENGTHS) {
      expect(EVIDENCE_STRENGTH_LABELS[strength]).toBeTruthy();
    }
    // Rule 4: the cost label says discovery-only out loud.
    expect(EVIDENCE_STRENGTH_LABELS['token-cost-discovery']).toContain('discovery');
  });

  it('mines and clusters routing-gap candidates from the parsed dataset', () => {
    const clusters = buildWorkbenchClusters({
      tokenData: [haikuSession('s1'), haikuSession('s2')],
      toolData: [toolErrors('s1', 3)],
    });
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) {
      expect(cluster.direction).toBe('haiku->sonnet');
      expect(cluster.clusterId.startsWith('gap:haiku-sonnet:')).toBe(true);
      expect(cluster.runCount).toBeGreaterThan(0);
    }
    const runIds = clusters.flatMap((c) => c.runIds);
    expect(runIds).toContain('s1');
  });

  it('returns no clusters for an empty dataset', () => {
    expect(buildWorkbenchClusters({ tokenData: [] })).toEqual([]);
  });

  it('audits every candidate and clusters only kept survivors', () => {
    const analysis = buildWorkbenchGapAnalysis({
      tokenData: [
        haikuSession('human-waiting-run'),
        haikuSession('kept-run'),
      ],
      timelines: [humanWaitingTimeline('human-waiting-run')],
    });

    expect(analysis.exclusionCounts).toEqual({ kept: 1, filtered: 1 });
    expect(analysis.candidates).toHaveLength(2);
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'human-waiting-run')
    ).toMatchObject({
      disposition: 'filtered',
      clusterId: null,
    });
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'human-waiting-run')
        ?.reason
    ).toContain('human-waiting');
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'kept-run')
    ).toMatchObject({
      disposition: 'kept',
    });
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'kept-run')
        ?.reason
    ).toContain('evaluated 1/6 classes (harness-overhead)');
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'kept-run')
        ?.reason
    ).toContain('not evaluated: human-waiting');
    expect(
      analysis.candidates.find((candidate) => candidate.runId === 'kept-run')
        ?.reason
    ).toContain('baseline-build-test-failure');
    expect(analysis.clusters.flatMap((cluster) => cluster.runIds)).toEqual([
      'kept-run',
    ]);
  });

  it('counts duplicate run ids from fail-closed audited rows and withholds them from replay specs', () => {
    const analysis = buildWorkbenchGapAnalysis({
      tokenData: [
        haikuSession('ambiguous-run'),
        haikuSession('ambiguous-run'),
      ],
    });

    expect(analysis.candidates).toHaveLength(2);
    expect(
      analysis.candidates.every(
        (item) =>
          item.disposition === 'filtered' &&
          item.clusterId === null &&
          item.reason.includes('ambiguous')
      )
    ).toBe(true);
    expect(analysis.exclusionCounts).toEqual({ kept: 0, filtered: 2 });
    expect(
      analysis.exclusionCounts.kept + analysis.exclusionCounts.filtered
    ).toBe(analysis.candidates.length);
    expect(analysis.clusters).toEqual([]);
    expect(
      buildProposedReplayBatchSpecs(
        analysis.clusters,
        '2026-06-10T00:00:00.000Z'
      )
    ).toEqual([]);
  });

  it('joins dispositions by run id regardless of exclusion order and fails closed on ambiguity', () => {
    const candidates = [candidate('filtered-run'), candidate('kept-run')];
    const exclusions: EvalExclusion[] = [
      { runId: 'kept-run', disposition: 'kept', reason: 'kept reason' },
      {
        runId: 'filtered-run',
        disposition: 'filtered',
        reason: 'filtered reason',
      },
    ];

    const joined = joinWorkbenchCandidateExclusions(candidates, exclusions);
    expect(joined.candidates.map(({ runId, disposition }) => ({ runId, disposition }))).toEqual([
      { runId: 'filtered-run', disposition: 'filtered' },
      { runId: 'kept-run', disposition: 'kept' },
    ]);
    expect(joined.kept.map((item) => item.runId)).toEqual(['kept-run']);

    const ambiguous = joinWorkbenchCandidateExclusions(
      [candidate('duplicate')],
      [
        { runId: 'duplicate', disposition: 'kept', reason: 'first' },
        { runId: 'duplicate', disposition: 'kept', reason: 'second' },
      ]
    );
    expect(ambiguous.kept).toEqual([]);
    expect(ambiguous.candidates[0]).toMatchObject({
      disposition: 'filtered',
    });
    expect(ambiguous.candidates[0].reason).toContain('ambiguous');

    const missing = joinWorkbenchCandidateExclusions(
      [candidate('missing')],
      []
    );
    expect(missing.kept).toEqual([]);
    expect(missing.candidates[0]).toMatchObject({
      disposition: 'filtered',
    });
    expect(missing.candidates[0].reason).toContain('0 record(s)');
  });

  it('proposes a deterministic batch spec covering the mined directions', () => {
    const clusters = buildWorkbenchClusters({
      tokenData: [haikuSession('s1')],
      toolData: [toolErrors('s1', 2)],
    });
    const createdAt = '2026-06-10T00:00:00.000Z';
    const spec = buildProposedBatchSpec(clusters, createdAt);
    expect(spec).toBeTruthy();
    expect(spec!.kind).toBe('model-eval-batch');
    expect(spec!.createdAt).toBe(createdAt);
    expect(spec!.corpus.source).toBe('replay-history');
    const candidates = spec!.models.filter((m) => m.role === 'candidate').map((m) => m.id);
    const baselines = spec!.models.filter((m) => m.role === 'baseline').map((m) => m.id);
    expect(candidates).toEqual([CURRENT_MODEL_IDS.sonnet]);
    expect(baselines).toEqual([CURRENT_MODEL_IDS.haiku]);
    // Deterministic: same clusters + same createdAt -> identical spec.
    expect(buildProposedBatchSpec(clusters, createdAt)).toEqual(spec);
    const serialized = serializeProposedBatchSpec(spec!);
    expect(serialized).toBe(serializeProposedBatchSpec(spec!));
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized)).toEqual(spec);
  });

  it('proposes nothing when there are no clusters', () => {
    expect(buildProposedBatchSpec([], '2026-06-10T00:00:00.000Z')).toBeNull();
  });

  it('exports deterministic replay specs whose task ids exclude filtered runs', () => {
    const analysis = buildWorkbenchGapAnalysis({
      tokenData: [
        haikuSession('human-waiting-run'),
        haikuSession('kept-run'),
      ],
      timelines: [humanWaitingTimeline('human-waiting-run')],
    });
    const createdAt = '2026-06-10T00:00:00.000Z';
    const specs = buildProposedReplayBatchSpecs(analysis.clusters, createdAt);

    expect(specs).toHaveLength(1);
    expect(specs[0].cluster?.runCount).toBe(1);
    expect(specs[0].tasks?.map((task) => task.taskId)).toEqual(['kept-run']);
    const serialized = serializeProposedBatchSpecs(specs);
    expect(serialized).toBe(serializeProposedBatchSpecs(specs));
    expect(serialized).toContain('kept-run');
    expect(serialized).not.toContain('human-waiting-run');
    expect(JSON.parse(serialized)).toEqual(specs);
  });
});
