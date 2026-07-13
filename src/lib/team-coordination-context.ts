import type { TaskRecord } from './parse-tasks';

export interface DroppedAssignmentContext {
  agent: string;
  taskId: string;
  subject: string;
}

export type DroppedAssignmentTaskResolution =
  | {
      kind: 'resolved';
      task: TaskRecord;
      matchDetail: string;
    }
  | {
      kind: 'unresolved';
      reason: string;
    };

function hasUsableToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Join a sparse inbox assignment to its canonical task without crossing session
 * boundaries by task ID alone. ID + subject must both match exactly; agent/owner
 * is used only to break an otherwise ambiguous exact-match tie.
 */
export function resolveDroppedAssignmentTask(
  assignment: DroppedAssignmentContext,
  tasks: TaskRecord[]
): DroppedAssignmentTaskResolution {
  if (!hasUsableToken(assignment.taskId) || !hasUsableToken(assignment.subject)) {
    return {
      kind: 'unresolved',
      reason:
        'No unique task/session match: assignment is missing a usable task ID or subject.',
    };
  }

  const exactMatches = tasks.filter(
    (task) =>
      task.id === assignment.taskId && task.subject === assignment.subject
  );

  if (exactMatches.length === 0) {
    return {
      kind: 'unresolved',
      reason:
        'No unique task/session match: no task has this exact task ID and subject.',
    };
  }

  if (exactMatches.length === 1) {
    const task = exactMatches[0];
    if (!hasUsableToken(task.sessionId)) {
      return {
        kind: 'unresolved',
        reason:
          'No unique task/session match: the exact task match has no usable session ID.',
      };
    }
    return {
      kind: 'resolved',
      task,
      matchDetail: 'Matched exact task ID and subject.',
    };
  }

  if (!hasUsableToken(assignment.agent)) {
    return {
      kind: 'unresolved',
      reason: `No unique task/session match: ${exactMatches.length} tasks share this exact task ID and subject, and the assignment has no usable agent for an owner tie-break.`,
    };
  }

  const ownerMatches = exactMatches.filter(
    (task) => task.owner === assignment.agent
  );
  if (ownerMatches.length === 1 && hasUsableToken(ownerMatches[0].sessionId)) {
    return {
      kind: 'resolved',
      task: ownerMatches[0],
      matchDetail:
        'Matched exact task ID and subject; assignment agent matched task owner.',
    };
  }

  if (ownerMatches.length === 1) {
    return {
      kind: 'unresolved',
      reason:
        'No unique task/session match: the owner tie-break match has no usable session ID.',
    };
  }

  const tieBreakDetail =
    ownerMatches.length === 0
      ? 'none has the assignment agent as owner'
      : `${ownerMatches.length} also have the assignment agent as owner`;
  return {
    kind: 'unresolved',
    reason: `No unique task/session match: ${exactMatches.length} tasks share this exact task ID and subject; ${tieBreakDetail}.`,
  };
}

/** Build an auditable clipboard payload from real artifact tokens only. */
export function buildAssignmentIdentifierPayload(
  teamId: string,
  assignment: DroppedAssignmentContext,
  resolution: DroppedAssignmentTaskResolution
): string {
  const identifiers: Array<[string, unknown]> = [
    ['Team', teamId],
    ['Agent', assignment.agent],
    ['Task', assignment.taskId],
  ];

  if (resolution.kind === 'resolved') {
    identifiers.push(['Session', resolution.task.sessionId]);
    identifiers.push(['PR', resolution.task.pr]);
  }

  return identifiers
    .filter((entry): entry is [string, string] => hasUsableToken(entry[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}
