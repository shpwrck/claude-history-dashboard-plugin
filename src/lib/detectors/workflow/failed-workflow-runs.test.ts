import { describe, it, expect } from 'vitest';
import { detector } from './failed-workflow-runs';
import type { RecommendationInput } from '../types';
import type { WorkflowRun, WorkflowAgent } from '../../parse-workflows';

const agent = (state: string | null): WorkflowAgent => ({
  index: 0, label: null, phaseIndex: null, phaseTitle: null, model: null,
  state, agentType: null, startedAt: null, durationMs: null, tokens: null,
  toolCalls: null, promptPreview: null, resultPreview: null,
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
