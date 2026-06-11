import { describe, it, expect } from 'vitest';
import {
  detector,
  MIN_OPEN_OWNED_TASKS,
  MIN_TOP_OWNER_SHARE,
  WARNING_TOP_OWNER_TASKS,
} from './owner-concentration';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { TaskRecord } from '../../parse-tasks';
import type { OrganizationIdentityDataset } from '../../organization-identity';

const NOW = 1_780_000_000_000;

function makeTask(overrides: Partial<TaskRecord> & { id: string; owner: string }): TaskRecord {
  return {
    subject: `Task ${overrides.id}`,
    description: '',
    activeForm: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    sessionId: 'session-main',
    mtimeMs: NOW,
    ...overrides,
  };
}

function makeInput(
  tasks: TaskRecord[],
  sessions: RecommendationInput['sessions'] = [],
  organizationIdentity?: OrganizationIdentityDataset
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions,
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks,
    organizationIdentity,
  };
}

describe('workflow.owner-concentration (#942)', () => {
  it('returns null when tasks are absent', () => {
    const input = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    } as RecommendationInput;
    expect(detector.rule(input, NOW)).toBeNull();
  });

  it('returns null when there is only one owner', () => {
    const tasks = Array.from({ length: MIN_OPEN_OWNED_TASKS }, (_, i) =>
      makeTask({ id: `a${i}`, owner: 'alice' })
    );
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('returns null below the minimum open owned task count', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice' }),
      makeTask({ id: 'a2', owner: 'alice' }),
      makeTask({ id: 'a3', owner: 'alice' }),
      makeTask({ id: 'b1', owner: 'bob' }),
      makeTask({ id: 'done', owner: 'alice', status: 'completed' }),
    ];
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('returns null when the top owner share is below the threshold', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice' }),
      makeTask({ id: 'a2', owner: 'alice' }),
      makeTask({ id: 'a3', owner: 'alice' }),
      makeTask({ id: 'b1', owner: 'bob' }),
      makeTask({ id: 'b2', owner: 'bob' }),
      makeTask({ id: 'c1', owner: 'carol' }),
    ];
    expect(3 / tasks.length).toBeLessThan(MIN_TOP_OWNER_SHARE);
    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();
  });

  it('fires for a multi-owner queue concentrated on one owner', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice', sessionId: 'session-a', subject: 'Review billing API' }),
      makeTask({ id: 'a2', owner: 'alice', sessionId: 'session-a', subject: 'Ship admin export' }),
      makeTask({ id: 'a3', owner: 'alice', sessionId: 'session-b', subject: 'Fix org switcher' }),
      makeTask({ id: 'a4', owner: 'alice', sessionId: 'session-b', subject: 'Harden invite flow' }),
      makeTask({ id: 'b1', owner: 'bob', sessionId: 'session-c', subject: 'Write rollout note' }),
      makeTask({ id: 'c1', owner: 'carol', sessionId: 'session-c', subject: 'Verify smoke tests' }),
    ];
    const sessions = [
      { sessionId: 'session-a', projectShort: 'billing', project: '/repo/billing' },
      { sessionId: 'session-b', projectShort: 'admin', project: '/repo/admin' },
      { sessionId: 'session-c', projectShort: 'ops', project: '/repo/ops' },
    ] as RecommendationInput['sessions'];

    const rec = detector.rule(makeInput(tasks, sessions), NOW);

    expect(rec?.id).toBe('workflow.owner-concentration');
    expect(rec?.category).toBe('workflow');
    expect(rec?.severity).toBe('info');
    expect(rec?.affected).toBe(4);
    expect(rec?.view).toBe('tasks');
    expect(rec?.detail).toContain('alice owns 4 of 6');
    expect(rec?.detail).toContain('billing');
    expect(rec?.evidence?.join('\n')).toContain('Review billing API');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('escalates to warning for a very concentrated owner', () => {
    const tasks = [
      ...Array.from({ length: WARNING_TOP_OWNER_TASKS }, (_, i) =>
        makeTask({ id: `a${i}`, owner: 'alice' })
      ),
      makeTask({ id: 'b1', owner: 'bob' }),
      makeTask({ id: 'c1', owner: 'carol' }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.severity).toBe('warning');
  });

  it('ignores blank owners and completed tasks', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice' }),
      makeTask({ id: 'a2', owner: 'alice' }),
      makeTask({ id: 'a3', owner: 'alice' }),
      makeTask({ id: 'a4', owner: 'alice' }),
      makeTask({ id: 'b1', owner: 'bob' }),
      makeTask({ id: 'c1', owner: 'carol' }),
      makeTask({ id: 'blank', owner: '   ' }),
      makeTask({ id: 'done', owner: 'alice', status: 'completed' }),
    ];
    const rec = detector.rule(makeInput(tasks), NOW);
    expect(rec?.affected).toBe(4);
    expect(rec?.detail).toContain('4 of 6');
  });

  it('groups explicit task-owner aliases into one durable contributor', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice', subject: 'Review billing API' }),
      makeTask({ id: 'a2', owner: 'alice', subject: 'Ship admin export' }),
      makeTask({ id: 'a3', owner: 'alice', subject: 'Fix org switcher' }),
      makeTask({ id: 'a4', owner: 'asmith', subject: 'Harden invite flow' }),
      makeTask({ id: 'b1', owner: 'bob', subject: 'Write rollout note' }),
      makeTask({ id: 'c1', owner: 'carol', subject: 'Verify smoke tests' }),
    ];
    const identity: OrganizationIdentityDataset = {
      contributors: [
        {
          id: 'u-alice',
          displayName: 'Alice Smith',
          aliases: [
            { kind: 'task-owner', value: 'alice' },
            { kind: 'task-owner', value: 'asmith' },
          ],
        },
        { id: 'u-bob', displayName: 'Bob Lee', aliases: [{ kind: 'task-owner', value: 'bob' }] },
        { id: 'u-carol', displayName: 'Carol Ng', aliases: [{ kind: 'task-owner', value: 'carol' }] },
      ],
    };

    expect(detector.rule(makeInput(tasks), NOW)).toBeNull();

    const rec = detector.rule(makeInput(tasks, [], identity), NOW);
    expect(rec?.id).toBe('workflow.owner-concentration');
    expect(rec?.detail).toContain('Alice Smith owns 4 of 6');
    expect(rec?.evidence?.[0]).toContain('via aliases alice, asmith');
    expect(rec?.provenance?.observations.some((obs) => obs.value === 'u-alice')).toBe(true);
  });

  it('does not group ambiguous identity aliases', () => {
    const tasks = [
      makeTask({ id: 'a1', owner: 'alice' }),
      makeTask({ id: 'a2', owner: 'alice' }),
      makeTask({ id: 'a3', owner: 'alice' }),
      makeTask({ id: 'a4', owner: 'asmith' }),
      makeTask({ id: 'b1', owner: 'bob' }),
      makeTask({ id: 'c1', owner: 'carol' }),
    ];
    const identity: OrganizationIdentityDataset = {
      contributors: [
        { id: 'u-alice', displayName: 'Alice Smith', aliases: [{ kind: 'task-owner', value: 'alice' }] },
        { id: 'u-alicia', displayName: 'Alicia Stone', aliases: [{ kind: 'task-owner', value: 'alice' }] },
        { id: 'u-bob', displayName: 'Bob Lee', aliases: [{ kind: 'task-owner', value: 'bob' }] },
        { id: 'u-carol', displayName: 'Carol Ng', aliases: [{ kind: 'task-owner', value: 'carol' }] },
      ],
    };

    expect(detector.rule(makeInput(tasks, [], identity), NOW)).toBeNull();
  });

  it('documents its data dependencies', () => {
    expect(detector.dataDeps).toContain('tasks');
    expect(detector.dataDeps).toContain('sessions');
    expect(detector.dataDeps).toContain('organizationIdentity');
  });
});
