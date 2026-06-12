import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_STRENGTH_LABELS,
  buildProposedBatchSpec,
  buildWorkbenchClusters,
} from './model-evals-workbench';
import { EVIDENCE_STRENGTHS } from './model-eval-result';
import { CURRENT_MODEL_IDS } from './model-registry';
import type { SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';

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
  });

  it('proposes nothing when there are no clusters', () => {
    expect(buildProposedBatchSpec([], '2026-06-10T00:00:00.000Z')).toBeNull();
  });
});
