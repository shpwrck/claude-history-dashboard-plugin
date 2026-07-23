/**
 * reliability.dropped-assignments — flags teams where task assignments were
 * silently never picked up by a worker agent.
 *
 * Data dependency: `teams` — an optional field on RecommendationInput
 * populated by the server ingest from ~/.claude/teams/<id>/inboxes/*.json
 * (see src/lib/parse-teams.ts).
 *
 * Severity: HIGH when any agent stalled (all assignments unread) OR >= 50% of
 * assignments across the team are dropped. INFO otherwise.
 *
 * Fix: manual redispatch through the team's real workflow.
 *
 * Issue: #560 / prototype: proto/539-teams
 */

import type { Detector } from '../types';

/** HIGH when an agent stalled or >= 50% of assignments dropped. */
const HIGH_DROPPED_PCT = 50;

export const detector: Detector = {
  id: 'reliability.dropped-assignments',
  category: 'reliability',
  dataDeps: ['teams'],

  rule(input) {
    const data = input.teams ?? [];
    if (!data.length) return null;

    const withDropped = data.filter((t) => t.droppedCount > 0);
    if (withDropped.length === 0) return null;

    const stalledTeams = withDropped.filter((t) => t.stalledAgents.length > 0);
    const highPctTeams = withDropped.filter(
      (t) => t.droppedPct >= HIGH_DROPPED_PCT
    );

    const isHigh = stalledTeams.length > 0 || highPctTeams.length > 0;
    const severity = isHigh ? 'warning' : 'info';

    const totalDropped = withDropped.reduce(
      (sum, t) => sum + t.droppedCount,
      0
    );
    const totalAssign = withDropped.reduce(
      (sum, t) => sum + t.totalAssignments,
      0
    );

    // Collect unique stalled agent names for the detail line.
    const stalledNames = withDropped
      .flatMap((t) => t.stalledAgents.map((a) => `${t.teamId}/${a.agent}`))
      .slice(0, 5);

    const detail = stalledNames.length > 0
      ? `${totalDropped}/${totalAssign} task assignment(s) dropped across ${withDropped.length} team(s); stalled agents (never started): ${stalledNames.join(', ')}.`
      : `${totalDropped}/${totalAssign} task assignment(s) dropped across ${withDropped.length} team(s) — workers never acknowledged the work.`;

    // Evidence: up to 5 dropped entries with team + task info.
    const evidence = withDropped
      .flatMap((t) =>
        t.droppedAssignments.map(
          (d) => `${t.teamId}/${d.agent} [${d.taskId}] "${d.subject}" (unread ${d.ageMinutes}m)`
        )
      )
      .slice(0, 5);

    return {
      id: 'reliability.dropped-assignments',
      category: 'reliability',
      severity,
      title: 'Task assignments silently dropped by worker agents',
      detail,
      action:
        'Re-dispatch the unread tasks or split a stalled agent\'s queue across fresh workers.',
      affected: totalDropped,
      evidence,
    };
  },
};
