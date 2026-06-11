/**
 * blocked-task-pileup.test.ts
 *
 * Tests for the workflow.blocked-task-pileup detector.
 * Constructs minimal RecommendationInput with the `tasks` field.
 *
 * Issue #559.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './blocked-task-pileup';
import type { RecommendationInput } from '../types';
import type { TaskRecord } from '../../parse-tasks';
import { PILEUP_MIN } from '../../parse-tasks';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<TaskRecord> & {
    id: string;
    sessionId: string;
    status: TaskRecord['status'];
  }
): TaskRecord {
  return {
    subject: 'Task ' + overrides.id,
    description: '',
    activeForm: '',
    owner: '',
    blocks: [],
    blockedBy: [],
    mtimeMs: Date.now(),
    ...overrides,
  };
}

function makeInput(tasks: TaskRecord[]): RecommendationInput & { tasks: TaskRecord[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks,
  } as unknown as RecommendationInput & { tasks: TaskRecord[] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.blocked-task-pileup (#559)', () => {
  it('returns null when tasks array is empty', () => {
    expect(detector.rule(makeInput([]), 0)).toBeNull();
  });

  it('returns null when tasks field is absent', () => {
    const input = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    } as unknown as RecommendationInput;
    expect(detector.rule(input, 0)).toBeNull();
  });

  it('returns null when no tasks have blockedBy entries', () => {
    const tasks = [
      makeTask({ id: '1', sessionId: 's1', status: 'pending' }),
      makeTask({ id: '2', sessionId: 's1', status: 'in_progress' }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it('returns null when root task is completed (no actual pileup)', () => {
    // root is done => its dependents are NOT a pileup
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'completed', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it(`returns null when fewer than ${PILEUP_MIN} tasks are blocked behind an unfinished root`, () => {
    // Only 1 blocked task — below the threshold
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it(`fires when >= ${PILEUP_MIN} tasks are blocked behind an unfinished root`, () => {
    // Mirror the fraud-ml scenario from gen-mock.mjs
    const tasks = [
      makeTask({
        id: 'r7',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Retrain fraud model v7',
      }),
      makeTask({
        id: 'c1',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Shadow-deploy v7 scorer',
        blockedBy: ['r7'],
      }),
      makeTask({
        id: 'c2',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'A/B harness for v7',
        blockedBy: ['r7'],
      }),
      makeTask({
        id: 'c3',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Cutover docs for v7',
        blockedBy: ['r7'],
      }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.id).toBe('workflow.blocked-task-pileup');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(3);
  });

  it('includes root subject in the detail', () => {
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Migrate DB schema' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.detail).toContain('Migrate DB schema');
  });

  it('includes a copy-pasteable fix snippet mentioning the root task', () => {
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root Task Alpha' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'in_progress', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.fix?.snippet).toContain('Root Task Alpha');
  });

  it('sorts pileups largest-first in evidence', () => {
    // s1: 3 blocked; s2: 2 blocked — s1 should appear first
    const tasks: TaskRecord[] = [
      makeTask({ id: 'root1', sessionId: 's1', status: 'pending', subject: 'Root 1' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),
      makeTask({ id: 'c3', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),

      makeTask({ id: 'root2', sessionId: 's2', status: 'pending', subject: 'Root 2' }),
      makeTask({ id: 'c4', sessionId: 's2', status: 'pending', blockedBy: ['root2'] }),
      makeTask({ id: 'c5', sessionId: 's2', status: 'pending', blockedBy: ['root2'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.evidence?.[0]).toContain('3 task(s)');
    expect(rec?.affected).toBe(5); // 3 + 2
  });

  it('only matches blockedBy roots within the SAME session', () => {
    // Root is in session A, the blocked tasks are in session B — not a pileup
    const tasks: TaskRecord[] = [
      makeTask({ id: 'shared-root', sessionId: 'session-A', status: 'pending', subject: 'Shared Root' }),
      // These tasks reference the root id but live in a different session — no match
      makeTask({ id: 'c1', sessionId: 'session-B', status: 'pending', blockedBy: ['shared-root'] }),
      makeTask({ id: 'c2', sessionId: 'session-B', status: 'pending', blockedBy: ['shared-root'] }),
    ];
    // session-B doesn't contain 'shared-root', so no pileup
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it('correctly counts only non-completed blocked tasks', () => {
    // Root not done; 2 children are pending, 1 child is completed — only 2 should count
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'completed', blockedBy: ['root'] }), // done — not stalled
      makeTask({ id: 'c3', sessionId: 's1', status: 'in_progress', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    // c2 is completed so it's excluded from blocked count; c1 + c3 = 2 >= PILEUP_MIN
    expect(rec?.id).toBe('workflow.blocked-task-pileup');
    expect(rec?.affected).toBe(2);
  });
});
