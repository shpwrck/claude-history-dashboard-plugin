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
    divergenceRate: 0.5,
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

  it('surfaces divergenceRate in detail, evidence, and provenance', () => {
    const rec = detector.rule(
      input([steering({ divergenceRate: 0.5 })], [success()]),
      0
    );

    expect(rec?.detail).toContain('steering-divergence rate 50%');
    expect(rec?.evidence?.[0]).toContain('divergence 50%');
    expect(
      rec?.provenance?.observations.some((o) =>
        o.field.includes('divergenceRate')
      )
    ).toBe(true);
  });

  // ── Monotone-inverse suppression gate (#1751, log-don't-surface) ────────────
  // Build a corpus large enough to falsify the trend. Only the FIRST task of
  // each session passes the over-steered candidate filter (steering-load gate),
  // but the concordance check runs over ALL steering rows that have a success
  // match, so additional rows shape the direction.
  function corpus(
    pairs: { divergenceRate: number; successScore: number; load?: boolean }[]
  ): RecommendationInput {
    const steeringRows: TaskSteering[] = [];
    const successRows: TaskSuccessProxy[] = [];
    pairs.forEach((p, idx) => {
      const sessionId = `cohort-${idx}`;
      steeringRows.push(
        steering({
          sessionId,
          taskIndex: 0,
          divergenceRate: p.divergenceRate,
          // A non-candidate row still feeds the concordance check but should not
          // be the over-steered candidate.
          ...(p.load === false
            ? { corrective: 0, clarifyingAnswer: 0, approving: 0, humanTurns: 0 }
            : {}),
        })
      );
      successRows.push(
        success({
          sessionId,
          taskIndex: 0,
          successScore: p.successScore,
          // keep high confidence so candidate gate can pass for load:true rows
          confidence: 'high',
        })
      );
    });
    return input(steeringRows, successRows);
  }

  it('suppresses (log-don\'t-surface) when divergenceRate is NOT inverse with success', () => {
    // Same-direction: higher divergence pairs with higher success — the wrong
    // direction for the autonomy thesis, so the signal must be suppressed.
    const rec = detector.rule(
      corpus([
        { divergenceRate: 0.1, successScore: 0.9 },
        { divergenceRate: 0.5, successScore: 0.95 },
        { divergenceRate: 0.9, successScore: 1 },
      ]),
      0
    );
    expect(rec).toBeNull();
  });

  it('surfaces when divergenceRate IS monotone-inverse with success across the corpus', () => {
    // The candidate row (high divergence) has the lowest success among the
    // high-confidence set, and the corpus trend is inverse — surface.
    const rec = detector.rule(
      corpus([
        { divergenceRate: 0.9, successScore: 0.9 },
        { divergenceRate: 0.5, successScore: 0.95, load: false },
        { divergenceRate: 0.1, successScore: 1, load: false },
      ]),
      0
    );
    expect(rec?.id).toBe('workflow.autonomy-over-steered');
  });
});
