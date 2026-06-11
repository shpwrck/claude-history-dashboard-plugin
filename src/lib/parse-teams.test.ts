/**
 * parse-teams.test.ts — vitest tests for the teams inbox parser.
 *
 * Uses inline fixtures shaped exactly like the artifact on disk:
 *   ~/.claude/teams/<teamId>/inboxes/<agent>.json
 *
 * Fixtures mirror the prototype mock data from proto/539-teams.
 * Issue: #560
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { analyzeTeams, GRACE_MINUTES, parseTeamsDir } from './parse-teams';
import type { TeamAssignment, TeamSummary } from './parse-teams';

// ─── Fixture helpers ────────────────────────────────────────────────────────

/**
 * Build an absolute timestamp string at `minutesBefore` minutes before `now`.
 */
function msBefore(now: number, minutesBefore: number): string {
  return new Date(now - minutesBefore * 60_000).toISOString();
}

function makeAssignment(
  agent: string,
  taskId: string,
  subject: string,
  timestamp: string,
  read: boolean
): TeamAssignment {
  return {
    agent,
    from: 'team-lead',
    timestamp,
    read,
    payload: {
      type: 'task_assignment',
      taskId,
      subject,
      assignedBy: 'team-lead',
    },
  };
}

// ─── Anchor "now" deterministically (matches proto mock anchor) ──────────────
// Prototype output anchors to the latest message timestamp seen across all data.
// Tests anchor to a fixed epoch for reproducibility.
const NOW = new Date('2026-06-03T18:25:00.000Z').getTime();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('parseTeamsDir', () => {
  it('skips inbox files above the configured byte cap', () => {
    const dir = join(tmpdir(), `parse-teams-test-${Date.now()}`);
    const inbox = join(dir, 'team-a', 'inboxes');
    mkdirSync(inbox, { recursive: true });
    try {
      const smallMessage = {
        from: 'team-lead',
        text: JSON.stringify({
          type: 'task_assignment',
          taskId: 'ok',
          subject: 'Small task',
        }),
        timestamp: new Date(NOW).toISOString(),
        type: 'message',
        read: false,
      };
      writeFileSync(join(inbox, 'agent-ok.json'), JSON.stringify([smallMessage]));
      writeFileSync(
        join(inbox, 'agent-large.json'),
        JSON.stringify([{ ...smallMessage, text: 'x'.repeat(2_048) }])
      );

      const parsed = parseTeamsDir(dir, { maxFileBytes: 512 });

      expect(parsed.get('team-a')?.map((item) => item.agent)).toEqual(['agent-ok']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('analyzeTeams — empty / no-op', () => {
  it('returns empty array for an empty map', () => {
    expect(analyzeTeams(new Map(), NOW)).toEqual([]);
  });

  it('skips teams with no assignments', () => {
    const map = new Map<string, TeamAssignment[]>([['team-empty', []]]);
    expect(analyzeTeams(map, NOW)).toEqual([]);
  });
});

describe('analyzeTeams — grace window discrimination', () => {
  it('does NOT count unread assignments younger than GRACE_MINUTES as dropped', () => {
    // Message arrived exactly at the grace boundary minus 1ms — should not drop.
    const freshTs = msBefore(NOW, GRACE_MINUTES - 0.5);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-fresh',
        [makeAssignment('wave1-agent', 'f1', 'Fresh task', freshTs, false)],
      ],
    ]);
    const summaries = analyzeTeams(map, NOW);
    // All assignments are fresh — summary has 0 dropped and team should still appear
    // because totalAssignments > 0. droppedCount = 0.
    expect(summaries).toHaveLength(1);
    expect(summaries[0].droppedCount).toBe(0);
    expect(summaries[0].stalledAgents).toHaveLength(0);
  });

  it('counts unread assignments at or beyond GRACE_MINUTES as dropped', () => {
    const staleTs = msBefore(NOW, GRACE_MINUTES);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-stale',
        [makeAssignment('wave1-agent', 's1', 'Stale task', staleTs, false)],
      ],
    ]);
    const summaries = analyzeTeams(map, NOW);
    expect(summaries[0].droppedCount).toBe(1);
    expect(summaries[0].droppedPct).toBe(100);
  });

  it('does not count read assignments as dropped, regardless of age', () => {
    const oldTs = msBefore(NOW, 1000);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-read',
        [makeAssignment('wave1-agent', 'r1', 'Read old task', oldTs, true)],
      ],
    ]);
    const summaries = analyzeTeams(map, NOW);
    expect(summaries[0].droppedCount).toBe(0);
  });
});

describe('analyzeTeams — dropped percentage', () => {
  it('computes correct drop % for a mix of read and unread-stale assignments', () => {
    // Mirrors proto mock: team-billing-pipeline — 2/4 dropped (50%)
    const oldTs = msBefore(NOW, 6325);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-billing-pipeline',
        [
          // wave1-invoice-parser: 1 read  → not dropped
          makeAssignment('wave1-invoice-parser', 'b1', 'Invoice line-item parser', msBefore(NOW, 6330), true),
          // wave1-refund-engine: 2 unread, stale → dropped (stalled agent)
          makeAssignment('wave1-refund-engine', 'b2', 'Refund eligibility engine', oldTs, false),
          makeAssignment('wave1-refund-engine', 'b2b', 'Refund engine: add audit log', msBefore(NOW, 6310), false),
          // wave2-tax-reconcile: 1 read → not dropped
          makeAssignment('wave2-tax-reconcile', 'b3', 'Tax reconciliation report', msBefore(NOW, 6328), true),
        ],
      ],
    ]);

    const summaries = analyzeTeams(map, NOW);
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.teamId).toBe('team-billing-pipeline');
    expect(s.totalAssignments).toBe(4);
    expect(s.droppedCount).toBe(2);
    expect(s.droppedPct).toBe(50);
  });
});

describe('analyzeTeams — stalled agent detection', () => {
  it('flags an agent as stalled when ALL its assignments are unread and stale', () => {
    const oldTs = msBefore(NOW, 6325);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-billing-pipeline',
        [
          makeAssignment('wave1-invoice-parser', 'b1', 'Invoice task', msBefore(NOW, 6330), true),
          makeAssignment('wave1-refund-engine', 'b2', 'Refund eligibility engine', oldTs, false),
          makeAssignment('wave1-refund-engine', 'b2b', 'Refund audit log', msBefore(NOW, 6310), false),
          makeAssignment('wave2-tax-reconcile', 'b3', 'Tax report', msBefore(NOW, 6328), true),
        ],
      ],
    ]);

    const [s] = analyzeTeams(map, NOW);
    expect(s.stalledAgents).toHaveLength(1);
    expect(s.stalledAgents[0].agent).toBe('wave1-refund-engine');
    expect(s.stalledAgents[0].unreadCount).toBe(2);
  });

  it('does NOT flag a mixed agent (some read, some unread) as stalled', () => {
    const oldTs = msBefore(NOW, 100);
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-mixed',
        [
          makeAssignment('agent-a', 't1', 'Task one', msBefore(NOW, 200), true),
          makeAssignment('agent-a', 't2', 'Task two', oldTs, false),
        ],
      ],
    ]);
    const [s] = analyzeTeams(map, NOW);
    // agent-a has one read assignment → not ALL unread → not stalled
    expect(s.stalledAgents).toHaveLength(0);
    // but task two IS dropped
    expect(s.droppedCount).toBe(1);
  });
});

describe('analyzeTeams — onboarding revamp prototype scenario', () => {
  // Mirrors proto mock: team-onboarding-revamp — 1/3 dropped (33%), 1 stalled agent
  // wave1-welcome-flow: read
  // wave2-email-verify: unread, stale (dispatched ~3325m ago)
  // wave3-analytics-hook: unread but FRESH (grace window ⇒ NOT dropped)
  it('reproduces the prototype grace + stalled result', () => {
    const map = new Map<string, TeamAssignment[]>([
      [
        'team-onboarding-revamp',
        [
          makeAssignment('wave1-welcome-flow', 'o1', 'Welcome flow redesign', msBefore(NOW, 3330), true),
          makeAssignment('wave2-email-verify', 'o2', 'Email verification gate', msBefore(NOW, 3325), false),
          // o3 was dispatched at exactly NOW (inside grace window)
          makeAssignment('wave3-analytics-hook', 'o3', 'Onboarding analytics hook', new Date(NOW).toISOString(), false),
        ],
      ],
    ]);

    const summaries = analyzeTeams(map, NOW);
    const s = summaries.find((x: TeamSummary) => x.teamId === 'team-onboarding-revamp');
    expect(s).toBeDefined();
    expect(s!.totalAssignments).toBe(3);
    expect(s!.droppedCount).toBe(1);
    expect(s!.droppedPct).toBe(33);
    expect(s!.stalledAgents).toHaveLength(1);
    expect(s!.stalledAgents[0].agent).toBe('wave2-email-verify');
    // The fresh o3 is NOT dropped
    const droppedIds = s!.droppedAssignments.map((d) => d.taskId);
    expect(droppedIds).toContain('o2');
    expect(droppedIds).not.toContain('o3');
  });
});

describe('analyzeTeams — severity threshold boundary', () => {
  it('reports 49% drop correctly (below HIGH threshold)', () => {
    const staleTs = msBefore(NOW, 100);
    const assignments: TeamAssignment[] = [
      // 49 dropped, 51 read — 49%
      ...Array.from({ length: 49 }, (_, i) =>
        makeAssignment('agent-x', `drop-${i}`, `Task ${i}`, staleTs, false)
      ),
      ...Array.from({ length: 51 }, (_, i) =>
        makeAssignment('agent-y', `read-${i}`, `Done ${i}`, staleTs, true)
      ),
    ];
    const map = new Map([['team-threshold', assignments]]);
    const [s] = analyzeTeams(map, NOW);
    expect(s.droppedPct).toBe(49);
    // No stalled agents (agent-y is all read; agent-x has all dropped → stalled)
    expect(s.stalledAgents[0].agent).toBe('agent-x');
  });
});
