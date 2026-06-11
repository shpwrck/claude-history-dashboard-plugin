import { describe, it, expect } from 'vitest';
import { detector } from './runaway-workflow-cost';
import type { RecommendationInput } from '../types';
import type { WorkflowRun } from '../../parse-workflows';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade } from '../../reclaim';

const run = (
  runId: string,
  totalTokens: number | null,
  over?: Partial<WorkflowRun>
): WorkflowRun => ({
  runId, workflowName: 'wf', status: 'completed', startTime: 1, durationMs: 1,
  agentCount: 4, totalTokens, totalToolCalls: 1, defaultModel: null,
  sessionId: 's', phases: [], agents: [], ...over,
});

const input = (
  workflows?: WorkflowRun[],
  tokenData: SessionTokenData[] = []
): RecommendationInput => ({
  tokenData, toolData: [], sessions: [], projects: [],
  permissionRows: [], apiErrors: [], workflows,
});

describe('workflow.runaway-workflow-cost (#635)', () => {
  it('fires on a run that dwarfs the median and clears the floor', () => {
    const rec = detector.rule(input([
      run('a', 50_000), run('b', 50_000), run('c', 60_000), run('d', 500_000),
    ]), 0);
    expect(rec?.id).toBe('workflow.runaway-workflow-cost');
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence?.[0]).toContain('(d)'); // the outlier run
    expect(rec?.evidence?.[0]).toContain('500,000');
  });

  it('stays silent when runs are uniform (no outlier)', () => {
    expect(detector.rule(input([
      run('a', 50_000), run('b', 50_000), run('c', 50_000), run('d', 55_000),
    ]), 0)).toBeNull();
  });

  it('stays silent when the outlier is below the absolute floor', () => {
    // 40k is 4x the 10k median but well under the 200k floor → not runaway.
    expect(detector.rule(input([
      run('a', 10_000), run('b', 10_000), run('c', 10_000), run('d', 40_000),
    ]), 0)).toBeNull();
  });

  it('stays silent below the minimum baseline of runs', () => {
    expect(detector.rule(input([
      run('a', 50_000), run('b', 500_000),
    ]), 0)).toBeNull();
  });

  it('stays silent with no workflow data', () => {
    expect(detector.rule(input(undefined), 0)).toBeNull();
  });

  // ── #951: fan-out timing tax as a convertRate (cacheWrite5m → cacheRead) ──

  const tokenScope = (sessionId: string, model: string): SessionTokenData =>
    ({
      sessionId,
      entries: [
        {
          timestamp: 't',
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 1_000_000,
          cacheCreation1hTokens: 0, // all 5-minute writes
          cacheReadTokens: 0,
          webSearchRequests: 0,
          webFetchRequests: 0,
        },
      ],
      compactionEvents: [],
    } as unknown as SessionTokenData);

  it('emits a convertRate claim repricing fan-out cacheWrite5m → cacheRead', () => {
    const runs = [
      run('a', 50_000), run('b', 50_000), run('c', 60_000),
      run('d', 500_000, { sessionId: 'wf-sess', defaultModel: 'claude-opus-4-7', agentCount: 8 }),
    ];
    const rec = detector.rule(
      input(runs, [tokenScope('wf-sess', 'claude-opus-4-7')]),
      0
    );
    expect(rec?.reclaim).toBeDefined();
    expect(rec?.reclaim?.category).toBe('workflow');
    expect(rec?.reclaim?.cause).toBe('workflow-rework');
    const cf = rec!.reclaim!.counterfactual;
    expect(cf.kind).toBe('convertRate');
    if (cf.kind === 'convertRate') {
      expect(cf.rateFrom).toBe('cacheWrite5m');
      expect(cf.rateTo).toBe('cacheRead');
    }
    // Books a positive marginal and preserves the cascade identity.
    const result = runReclaimCascade([rec!.reclaim!], [tokenScope('wf-sess', 'claude-opus-4-7')]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.workflow).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('omits the fan-out claim when the outlier run is single-agent (no fan-out)', () => {
    const runs = [
      run('a', 50_000), run('b', 50_000), run('c', 60_000),
      run('d', 500_000, { sessionId: 'wf-sess', defaultModel: 'claude-opus-4-7', agentCount: 1 }),
    ];
    const rec = detector.rule(input(runs, [tokenScope('wf-sess', 'claude-opus-4-7')]), 0);
    expect(rec?.id).toBe('workflow.runaway-workflow-cost'); // still fires the rec
    expect(rec?.reclaim).toBeUndefined();
  });

  it('omits the fan-out claim when the parent session has no priced token data', () => {
    const runs = [
      run('a', 50_000), run('b', 50_000), run('c', 60_000),
      run('d', 500_000, { sessionId: 'wf-sess', defaultModel: 'claude-opus-4-7', agentCount: 8 }),
    ];
    // reclaim is emitted (concurrency present) but resolves to no priced cell.
    const rec = detector.rule(input(runs, []), 0);
    expect(rec?.reclaim).toBeDefined();
    const result = runReclaimCascade([rec!.reclaim!], []);
    expect(result.total).toBe(0); // precondition rejects → books $0
    expect(result.booked[0].rejected).toBe(true);
  });
});
