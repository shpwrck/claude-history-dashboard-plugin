import { describe, expect, it } from 'vitest';
import { detector } from './autonomy-over-steered';
import type { RecommendationInput } from '../types';
import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';

function steering(overrides: Partial<TaskSteering> = {}): TaskSteering {
  return {
    sessionId: 'session-oversteer-1',
    project: '/repo/app',
    taskIndex: 0,
    startTime: '2026-06-12T10:00:00.000Z',
    endTime: '2026-06-12T10:20:00.000Z',
    wallClockMs: 20 * 60 * 1000,
    costUsd: 25,
    humanTurns: 4,
    corrective: 2,
    clarifyingAnswer: 1,
    approving: 1,
    other: 0,
    interruptions: 0,
    ...overrides,
  };
}

function success(overrides: Partial<TaskSuccessProxy> = {}): TaskSuccessProxy {
  return {
    sessionId: 'session-oversteer-1',
    project: '/repo/app',
    taskIndex: 0,
    startTime: '2026-06-12T10:00:00.000Z',
    endTime: '2026-06-12T10:20:00.000Z',
    wallClockMs: 20 * 60 * 1000,
    verdict: 'accept',
    agentClaim: 'completed',
    confidence: 'high',
    successScore: 0.95,
    backedByMutation: true,
    mutatingToolCount: 1,
    toolCallCount: 2,
    toolResultCount: 2,
    toolErrorCount: 0,
    toolErrorRate: 0,
    errorPenalty: 0,
    ...overrides,
  };
}

function input(
  taskSteering: TaskSteering[],
  taskSuccess: TaskSuccessProxy[]
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    taskSteering,
    taskSuccess,
  } as RecommendationInput;
}

describe('workflow.autonomy-over-steered', () => {
  it('fires on high-steering spans that clear the high-confidence success gate', () => {
    const rec = detector.rule(input([steering()], [success()]), 0);

    expect(rec?.id).toBe('workflow.autonomy-over-steered');
    expect(rec?.category).toBe('workflow');
    expect(rec?.estTimeReclaimedMin).toBe(4);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(rec?.evidence?.[0]).toContain('4 steering turn(s)');
  });

  it('stays silent when success is low because the steering may have been load-bearing', () => {
    const rec = detector.rule(
      input([steering()], [success({ successScore: 0, verdict: 'correct' })]),
      0
    );

    expect(rec).toBeNull();
  });

  it('stays silent when success is not high confidence', () => {
    const rec = detector.rule(
      input([steering()], [success({ confidence: 'med', successScore: 0.95 })]),
      0
    );

    expect(rec).toBeNull();
  });

  it('stays silent when normalized steering load is low', () => {
    const rec = detector.rule(
      input(
        [
          steering({
            humanTurns: 1,
            corrective: 0,
            clarifyingAnswer: 0,
            approving: 1,
          }),
        ],
        [success({ toolCallCount: 8 })]
      ),
      0
    );

    expect(rec).toBeNull();
  });

  it('does not use task cost as a quality gate', () => {
    const rec = detector.rule(
      input([steering({ costUsd: 250 })], [success({ successScore: 1 })]),
      0
    );

    expect(rec?.id).toBe('workflow.autonomy-over-steered');
  });
});
