import { describe, it, expect } from 'vitest';
import { detector } from './failed-workflow-runs';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { WorkflowRun, WorkflowAgent } from '../../parse-workflows';

const agent = (state: string | null): WorkflowAgent => ({
  index: 0, label: null, phaseIndex: null, phaseTitle: null, model: null,
  state, agentType: null, startedAt: null, durationMs: null, tokens: null,
  toolCalls: null, promptPreview: null, resultPreview: null, error: null,
});

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  runId: 'wf_x', workflowName: 'wf', status: 'completed', startTime: 1,
  durationMs: 1, agentCount: 1, totalTokens: 1000, totalToolCalls: 1,
  defaultModel: null, sessionId: 's', phases: [], agents: [], ...over,
});

const input = (workflows?: WorkflowRun[]): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [],
  permissionRows: [], apiErrors: [], workflows,
});

describe('workflow.failed-workflow-runs (#635)', () => {
  it('fires on a run with a failure status', () => {
    const rec = detector.rule(input([
      run({ runId: 'wf_ok', status: 'completed' }),
      run({ runId: 'wf_bad', status: 'aborted' }),
    ]), 0);
    expect(rec?.id).toBe('workflow.failed-workflow-runs');
    expect(rec?.affected).toBe(1);
  });

  it('fires on a completed run that left an agent in an error state', () => {
    const rec = detector.rule(input([
      run({ runId: 'wf_err', status: 'completed', agents: [agent('done'), agent('error')] }),
    ]), 0);
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence?.[0]).toContain('agent');
  });

  it('stays silent when every run completed cleanly', () => {
    expect(detector.rule(input([
      run({ status: 'completed', agents: [agent('done')] }),
      run({ status: 'completed' }),
    ]), 0)).toBeNull();
  });

  it('stays silent with no workflow data', () => {
    expect(detector.rule(input(undefined), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });
});

// ── Provenance (#3232) ──────────────────────────────────────────────────────

describe('workflow.failed-workflow-runs provenance (#3232)', () => {
  const NOW = Date.parse('2026-06-20T00:00:00.000Z');
  const DAY_1 = Date.parse('2026-06-01T09:00:00.000Z');
  const DAY_9 = Date.parse('2026-06-09T18:00:00.000Z');

  const mixed = (): WorkflowRun[] => [
    run({ runId: 'wf_ok', status: 'completed', startTime: DAY_9, agents: [agent('done')] }),
    run({ runId: 'wf_aborted', status: 'aborted', startTime: DAY_1 }),
    run({
      runId: 'wf_agent_err',
      status: 'completed',
      startTime: DAY_1,
      agents: [agent('done'), agent('error'), agent('failed')],
    }),
  ];

  it('passes the contract when it fires', () => {
    const rec = detector.rule(input(mixed()), NOW)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
  });

  it('reproduces the displayed failed/total figures from the cited fields', () => {
    const rec = detector.rule(input(mixed()), NOW)!;
    const obs = rec.provenance!.observations;
    const total = obs.find((o) => o.claim.includes('matched a failure signal'));
    expect(total!.value).toBe(rec.affected);
    expect(total!.value).toBe(2);
    expect(total!.claim).toContain('of 3 parsed');
  });

  it('separates the run-status signal from the agent-state signal', () => {
    // Blurring them hides that one run failed only because of its agents —
    // the citation has to say which field carried the evidence.
    const rec = detector.rule(input(mixed()), NOW)!;
    const byStatus = rec.provenance!.observations.find((o) => o.field === 'status');
    const byAgent = rec.provenance!.observations.find((o) => o.field === 'agents[].state');
    expect(byStatus!.value).toBe(1); // only wf_aborted
    expect(byAgent!.value).toBe(2); // 'error' + 'failed' inside wf_agent_err
  });

  it('anchors asOf to the newest FAILED run, not to now and not to a later clean run', () => {
    // `wf_ok` is the newest run in the corpus (DAY_9) but it did not fail: it
    // contributes to the denominator only. Dating the failure finding from it
    // would assert a freshness the failure signal does not have (Codex review,
    // PR #3472).
    const rec = detector.rule(input(mixed()), NOW)!;
    expect(rec.provenance!.asOf).toBe('2026-06-01'); // the failed runs' date
    expect(rec.provenance!.asOf).not.toBe('2026-06-09'); // the clean run's
    expect(rec.provenance!.asOf).not.toBe('2026-06-20'); // `now`
  });

  it('moves the date when a FAILED run is what is newest', () => {
    const rec = detector.rule(
      input([
        run({ runId: 'wf_ok', status: 'completed', startTime: DAY_1, agents: [agent('done')] }),
        run({ runId: 'wf_bad', status: 'aborted', startTime: DAY_9 }),
      ]),
      NOW
    )!;
    expect(rec.provenance!.asOf).toBe('2026-06-09');
  });

  it('omits asOf when no run records a start time', () => {
    const rec = detector.rule(
      input([run({ runId: 'wf_bad', status: 'error', startTime: null })]),
      NOW
    )!;
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
});
