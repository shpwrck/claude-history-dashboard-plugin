import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';
import type { Detector, RecommendationInput } from '../types';
import { short } from '../shared';

const MIN_STEERING_LOAD = 1;
const PASSING_SUCCESS_SCORE = 0.9;

const WEIGHTS = {
  corrective: 2,
  clarifyingAnswer: 1.25,
  approving: 1,
  interruptions: 2,
} as const;

interface Candidate {
  steering: TaskSteering;
  success: TaskSuccessProxy;
  steeringLoad: number;
  effectiveAutonomy: number;
  reclaimableTurns: number;
}

function keyOf(row: { sessionId: string; taskIndex: number }): string {
  return `${row.sessionId}\0${row.taskIndex}`;
}

function weightedSteering(row: TaskSteering): number {
  return (
    row.corrective * WEIGHTS.corrective +
    row.clarifyingAnswer * WEIGHTS.clarifyingAnswer +
    row.approving * WEIGHTS.approving +
    row.interruptions * WEIGHTS.interruptions
  );
}

function agentTurnDenominator(success: TaskSuccessProxy): number {
  return Math.max(1, success.toolCallCount);
}

function steeringLoad(
  steering: TaskSteering,
  success: TaskSuccessProxy
): number {
  return weightedSteering(steering) / agentTurnDenominator(success);
}

function reclaimableTurns(row: TaskSteering): number {
  return row.corrective + row.clarifyingAnswer + row.approving;
}

function passesQualityGate(success: TaskSuccessProxy): boolean {
  return (
    success.confidence === 'high' &&
    success.successScore >= PASSING_SUCCESS_SCORE
  );
}

function findCandidates(input: RecommendationInput): Candidate[] {
  const steeringRows = input.taskSteering ?? [];
  const successByTask = new Map(
    (input.taskSuccess ?? []).map((row) => [keyOf(row), row])
  );
  const candidates: Candidate[] = [];

  for (const steering of steeringRows) {
    const success = successByTask.get(keyOf(steering));
    if (!success || !passesQualityGate(success)) continue;
    const turns = reclaimableTurns(steering);
    if (turns <= 0) continue;
    const load = steeringLoad(steering, success);
    if (load < MIN_STEERING_LOAD) continue;
    candidates.push({
      steering,
      success,
      steeringLoad: load,
      effectiveAutonomy: 1 / (1 + load),
      reclaimableTurns: turns,
    });
  }

  return candidates.sort((a, b) => {
    if (b.reclaimableTurns !== a.reclaimableTurns) {
      return b.reclaimableTurns - a.reclaimableTurns;
    }
    if (b.steeringLoad !== a.steeringLoad) {
      return b.steeringLoad - a.steeringLoad;
    }
    if (a.steering.sessionId !== b.steering.sessionId) {
      return a.steering.sessionId.localeCompare(b.steering.sessionId);
    }
    return a.steering.taskIndex - b.steering.taskIndex;
  });
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const detector: Detector = {
  id: 'workflow.autonomy-over-steered',
  category: 'workflow',
  dataDeps: ['taskSteering', 'taskSuccess'],
  rule(input) {
    const candidates = findCandidates(input);
    if (candidates.length === 0) return null;

    const totalTurns = candidates.reduce(
      (sum, candidate) => sum + candidate.reclaimableTurns,
      0
    );
    const avgAutonomy =
      candidates.reduce(
        (sum, candidate) => sum + candidate.effectiveAutonomy,
        0
      ) / candidates.length;
    const avgLoad =
      candidates.reduce((sum, candidate) => sum + candidate.steeringLoad, 0) /
      candidates.length;

    return {
      id: 'workflow.autonomy-over-steered',
      category: 'workflow',
      severity: candidates.length >= 3 || totalTurns >= 6 ? 'warning' : 'info',
      title: 'Over-steered successful tasks - reclaim human time',
      detail:
        `${candidates.length} high-confidence successful task span(s) still needed ` +
        `${totalTurns} corrective, clarifying, or approval turn(s). Average ` +
        `effective autonomy was ${fmtPct(avgAutonomy)} with normalized steering ` +
        `load ${avgLoad.toFixed(2)}, so the human steering was likely babysitting ` +
        `rather than load-bearing.`,
      action:
        'For recurring tasks like these, let the agent complete a full pass before ' +
        'steering it. Pre-answer repeated clarifications in CLAUDE.md, pre-grant ' +
        'safe approvals, or use acceptEdits/scoped allow rules where the task class ' +
        'already has high-confidence success evidence.',
      affected: candidates.length,
      estTimeReclaimedMin: totalTurns,
      view: 'recommendations',
      evidence: candidates.slice(0, 5).map((candidate) => {
        const { steering, success } = candidate;
        return (
          `${short(steering.sessionId)} task ${steering.taskIndex}: ` +
          `${candidate.reclaimableTurns} steering turn(s), load ` +
          `${candidate.steeringLoad.toFixed(2)}, success ` +
          `${success.successScore.toFixed(2)}`
        );
      }),
      provenance: {
        observations: [
          {
            claim:
              `${candidates.length} task span(s) passed the high-confidence ` +
              `success gate and had normalized steering load >= ${MIN_STEERING_LOAD}`,
            source: 'taskSteering + taskSuccess',
            field: 'taskSteering/taskSuccess',
            value: candidates.length,
          },
          {
            claim:
              `${totalTurns} corrective, clarifying-answer, or approval turn(s) ` +
              'were observed on those successful spans',
            source: 'parse-steering',
            field: 'TaskSteering.corrective/clarifyingAnswer/approving',
            value: totalTurns,
          },
        ],
        inference:
          'The quality gate is high-confidence task success and does not use cost. ' +
          'Because those spans passed while steering load stayed high, the steering ' +
          'is treated as reclaimable human time rather than necessary supervision.',
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Document autonomy defaults',
        note:
          'Add standing guidance for task classes that already clear the quality gate. ' +
          'Use scoped settings/permissions separately when a safe approval is the repeat bottleneck.',
        snippet:
          '## Autonomy defaults for proven tasks\n\n' +
          '- When a recurring task class already has high-confidence success evidence, let the agent complete a full pass before correcting course.\n' +
          '- Pre-answer recurring clarifications in the task prompt or project guidance before the run starts.\n' +
          '- For safe repeat edits, prefer acceptEdits or a scoped allow rule over repeated interactive approvals.',
      },
    };
  },
};
