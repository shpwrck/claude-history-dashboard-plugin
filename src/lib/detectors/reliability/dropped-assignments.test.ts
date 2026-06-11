/**
 * dropped-assignments.test.ts — vitest tests for the dropped-assignments detector.
 *
 * Tests use inline TeamSummary fixtures (no fs I/O). Covers:
 *  - null when no teams data provided
 *  - null when all assignments acknowledged
 *  - HIGH severity when stalled agent present
 *  - HIGH severity when >= 50% dropped
 *  - INFO severity when < 50% dropped and no stalled agents
 *  - evidence and fix snippet populated correctly
 *
 * Issue: #560
 */

import { describe, it, expect } from 'vitest';
import { detector } from './dropped-assignments';
import type { RecommendationInput } from '../types';
import type { TeamSummary } from '../../parse-teams';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeTeamSummary(
  teamId: string,
  totalAssignments: number,
  droppedAssignments: Array<{ agent: string; taskId: string; subject: string; ageMinutes: number }>,
  stalledAgents: Array<{ agent: string; unreadCount: number }> = []
): TeamSummary {
  return {
    teamId,
    totalAssignments,
    droppedCount: droppedAssignments.length,
    droppedPct: Math.round((droppedAssignments.length / totalAssignments) * 100),
    droppedAssignments,
    stalledAgents,
  };
}

function input(teams?: TeamSummary[]): RecommendationInput & { teams?: TeamSummary[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    teams,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reliability.dropped-assignments — guard clauses', () => {
  it('returns null when teams field is absent', () => {
    expect(detector.rule(input(), 0)).toBeNull();
  });

  it('returns null when teams array is empty', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('returns null when all assignments are acknowledged (droppedCount = 0)', () => {
    const teams: TeamSummary[] = [
      {
        teamId: 'team-clean',
        totalAssignments: 5,
        droppedCount: 0,
        droppedPct: 0,
        droppedAssignments: [],
        stalledAgents: [],
      },
    ];
    expect(detector.rule(input(teams), 0)).toBeNull();
  });
});

describe('reliability.dropped-assignments — HIGH severity (stalled agents)', () => {
  it('fires HIGH when at least one stalled agent is present', () => {
    const teams = [
      makeTeamSummary(
        'team-billing-pipeline',
        4,
        [
          { agent: 'wave1-refund-engine', taskId: 'b2', subject: 'Refund eligibility engine', ageMinutes: 6325 },
          { agent: 'wave1-refund-engine', taskId: 'b2b', subject: 'Refund engine: add audit log', ageMinutes: 6310 },
        ],
        [{ agent: 'wave1-refund-engine', unreadCount: 2 }]
      ),
    ];

    const rec = detector.rule(input(teams), 0);
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('reliability.dropped-assignments');
    expect(rec?.category).toBe('reliability');
    expect(rec?.severity).toBe('warning');
    expect(rec?.affected).toBe(2);
    expect(rec?.detail).toContain('stalled agents');
    expect(rec?.detail).toContain('wave1-refund-engine');
  });
});

describe('reliability.dropped-assignments — HIGH severity (>= 50% dropped)', () => {
  it('fires HIGH when droppedPct >= 50 even without stalled agents', () => {
    const teams = [
      makeTeamSummary(
        'team-half-dropped',
        2,
        [{ agent: 'agent-a', taskId: 't1', subject: 'Task one', ageMinutes: 100 }],
        [] // not stalled (only half unread)
      ),
    ];
    // Override: manually set pct=50 to confirm without stalled agents
    teams[0].droppedPct = 50;

    const rec = detector.rule(input(teams), 0);
    expect(rec?.severity).toBe('warning');
  });

  it('fires INFO when droppedPct < 50 and no stalled agents', () => {
    const teams = [
      {
        teamId: 'team-low-drop',
        totalAssignments: 10,
        droppedCount: 3,
        droppedPct: 30,
        droppedAssignments: [
          { agent: 'agent-b', taskId: 't2', subject: 'Task two', ageMinutes: 60 },
          { agent: 'agent-b', taskId: 't3', subject: 'Task three', ageMinutes: 90 },
          { agent: 'agent-b', taskId: 't4', subject: 'Task four', ageMinutes: 120 },
        ],
        stalledAgents: [], // agent-b has some read → not stalled (represented externally)
      },
    ];
    const rec = detector.rule(input(teams), 0);
    expect(rec).not.toBeNull();
    expect(rec?.severity).toBe('info');
  });
});

describe('reliability.dropped-assignments — evidence and fix', () => {
  it('populates evidence rows with team/agent/taskId info', () => {
    const teams = [
      makeTeamSummary(
        'team-onboarding-revamp',
        3,
        [{ agent: 'wave2-email-verify', taskId: 'o2', subject: 'Email verification gate', ageMinutes: 3325 }],
        [{ agent: 'wave2-email-verify', unreadCount: 1 }]
      ),
    ];
    const rec = detector.rule(input(teams), 0);
    expect(rec?.evidence).toHaveLength(1);
    expect(rec?.evidence?.[0]).toContain('o2');
    expect(rec?.evidence?.[0]).toContain('wave2-email-verify');
    expect(rec?.evidence?.[0]).toContain('3325m');
  });

  it('includes a redispatch fix snippet with the team id', () => {
    const teams = [
      makeTeamSummary(
        'team-billing-pipeline',
        2,
        [{ agent: 'agent-z', taskId: 'z1', subject: 'Lost task', ageMinutes: 500 }],
        [{ agent: 'agent-z', unreadCount: 1 }]
      ),
    ];
    const rec = detector.rule(input(teams), 0);
    expect(rec?.fix).toBeDefined();
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toContain('team-billing-pipeline');
    expect(rec?.fix?.snippet).toContain('--only-unread');
  });

  it('aggregates counts across multiple affected teams', () => {
    const teams = [
      makeTeamSummary('team-a', 4, [
        { agent: 'a1', taskId: 'a1', subject: 'A task', ageMinutes: 100 },
        { agent: 'a1', taskId: 'a2', subject: 'B task', ageMinutes: 200 },
      ]),
      makeTeamSummary('team-b', 2, [
        { agent: 'b1', taskId: 'b1', subject: 'C task', ageMinutes: 300 },
      ]),
    ];
    const rec = detector.rule(input(teams), 0);
    expect(rec?.affected).toBe(3); // 2 + 1 total dropped
    expect(rec?.evidence).toHaveLength(3);
  });

  it('caps evidence at 5 rows for large drop counts', () => {
    const dropped = Array.from({ length: 10 }, (_, i) => ({
      agent: 'agent-flood',
      taskId: `t${i}`,
      subject: `Task ${i}`,
      ageMinutes: 100,
    }));
    const teams = [makeTeamSummary('team-flood', 12, dropped)];
    const rec = detector.rule(input(teams), 0);
    expect(rec?.evidence?.length).toBeLessThanOrEqual(5);
  });
});

describe('reliability.dropped-assignments — detector metadata', () => {
  it('has correct id and category', () => {
    expect(detector.id).toBe('reliability.dropped-assignments');
    expect(detector.category).toBe('reliability');
  });

  it('lists teams as a dataDep', () => {
    expect(detector.dataDeps).toContain('teams');
  });
});
