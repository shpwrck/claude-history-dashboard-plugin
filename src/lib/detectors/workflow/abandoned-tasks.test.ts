/**
 * abandoned-tasks.test.ts
 *
 * Tests for the workflow.abandoned-tasks detector.
 * Constructs minimal RecommendationInput with the `tasks` field.
 *
 * Issue #559.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './abandoned-tasks';
import type { RecommendationInput } from '../types';
import type { TaskRecord } from '../../parse-tasks';
import { COLD_DAYS } from '../../parse-tasks';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<TaskRecord> & { sessionId: string; status: TaskRecord['status'] }
): TaskRecord {
  return {
    id: '1',
    subject: 'Some task',
    description: '',
    activeForm: '',
    owner: 'agent',
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

// ── now fixture ───────────────────────────────────────────────────────────────
// Use a fixed 'now' so tests are deterministic regardless of wall clock.
const NOW = 1_780_000_000_000; // arbitrary fixed timestamp

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.abandoned-tasks (#559)', () => {
  it('returns null when tasks array is empty', () => {
    expect(detector.rule(makeInput([]), NOW)).toBeNull();
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
    expect(detector.rule(input, NOW)).toBeNull();
  });

  it('returns null when all sessions are warm (< 7d idle)', () => {
    // Session idle 6d — below the cold gate
    const recentMtime = NOW - 6 * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-warm', status: 'in_progress', mtimeMs: recentMtime }),
      makeTask({ id: '2', sessionId: 's-warm', status: 'pending', mtimeMs: recentMtime }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('returns null when open tasks exist but the session was active today', () => {
    const tasks = [
      makeTask({ sessionId: 's-today', status: 'pending', mtimeMs: NOW - 1000 }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('fires when a cold session (>= 7d) has open tasks', () => {
    const coldMtime = NOW - (COLD_DAYS + 1) * MS_PER_DAY;
    const tasks = [
      makeTask({ id: '1', sessionId: 's-cold', status: 'in_progress', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '3', sessionId: 's-cold', status: 'completed', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.id).toBe('workflow.abandoned-tasks');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(2); // only the open tasks count
  });

  it('fires at exactly the cold boundary (7d idle)', () => {
    // mtime exactly COLD_DAYS days before now
    const boundaryMtime = NOW - COLD_DAYS * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-boundary', status: 'pending', mtimeMs: boundaryMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.id).toBe('workflow.abandoned-tasks');
  });

  it('ignores completed-only sessions even when cold', () => {
    const coldMtime = NOW - 10 * MS_PER_DAY;
    const tasks = [
      makeTask({ sessionId: 's-done', status: 'completed', mtimeMs: coldMtime }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('does not fire on today-open session even if other cold sessions exist and pass', () => {
    const coldMtime = NOW - 9 * MS_PER_DAY;
    const warmMtime = NOW - 1000;
    const tasks = [
      makeTask({ id: '1', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-cold', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '1', sessionId: 's-warm', status: 'pending', mtimeMs: warmMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    // Only s-cold should appear; s-warm must NOT be in evidence
    expect(rec?.id).toBe('workflow.abandoned-tasks');
    const evidenceStr = rec?.evidence?.join(' ') ?? '';
    expect(evidenceStr).toContain('s-cold'.slice(0, 8));
    // The warm session's short id should not appear in evidence
    expect(evidenceStr).not.toContain('s-warm'.slice(0, 8));
  });

  it('sorts evidence worst-first (most abandoned tasks first)', () => {
    const coldMtime = NOW - 10 * MS_PER_DAY;
    const tasks: TaskRecord[] = [
      // s-few: 1 open
      makeTask({ id: '1', sessionId: 's-few', status: 'pending', mtimeMs: coldMtime }),
      // s-many: 3 open
      makeTask({ id: '1', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
      makeTask({ id: '2', sessionId: 's-many', status: 'in_progress', mtimeMs: coldMtime }),
      makeTask({ id: '3', sessionId: 's-many', status: 'pending', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.evidence?.[0]).toContain('3 open task(s)'); // worst first
  });

  it('includes a copy-pasteable fix snippet with the session id', () => {
    const coldMtime = NOW - 8 * MS_PER_DAY;
    const sid = 'aabbccdd-1234-5678-abcd-000000000001';
    const tasks = [
      makeTask({ id: '1', sessionId: sid, status: 'pending', mtimeMs: coldMtime }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.fix?.snippet).toContain(`~/.claude/tasks/${sid}`);
  });
});
