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
import { newestIsoDate } from '../shared';

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

    // Evidence: up to 5 dropped entries with team + task info.
    const evidence = withDropped
      .flatMap((t) =>
        t.droppedAssignments.map(
          (d) => `${t.teamId}/${d.agent} [${d.taskId}] "${d.subject}" (unread ${d.ageMinutes}m)`
        )
      )
      .slice(0, 5);

    const detail = stalledNames.length > 0
      ? `${totalDropped}/${totalAssign} task assignment(s) were recorded unread past the grace window across ${withDropped.length} team(s); all-unread agent queues: ${stalledNames.join(', ')}.`
      : `${totalDropped}/${totalAssign} task assignment(s) were recorded unread past the grace window across ${withDropped.length} team(s).`;
    const asOf = newestIsoDate(withDropped.map((t) => t.latestAssignmentAt));

    return {
      id: 'reliability.dropped-assignments',
      category: 'reliability',
      severity,
      title: 'Task assignments recorded unread past the grace window',
      detail,
      action:
        'Confirm whether the unread tasks were picked up elsewhere; if not, re-dispatch them or split an all-unread queue across fresh workers.',
      affected: totalDropped,
      evidence,
      provenance: {
        observations: [
          {
            claim: `${totalDropped} assignment(s) were recorded unread past the grace window`,
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].droppedCount',
            value: totalDropped,
          },
          {
            claim: `${totalAssign} total assignment(s) were recorded in the affected teams`,
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].totalAssignments',
            value: totalAssign,
          },
          {
            claim: `${withDropped.length} team(s) had at least one past-grace unread assignment`,
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].droppedCount',
            value: withDropped.length,
          },
          {
            claim: `${stalledTeams.length} affected team(s) contained an all-unread agent queue`,
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].stalledAgents',
            value: stalledTeams.length,
          },
          {
            claim: `${highPctTeams.length} affected team(s) met the warning percentage threshold`,
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].droppedPct',
            value: highPctTeams.length,
          },
          {
            claim: `the warning percentage threshold is ${HIGH_DROPPED_PCT}%`,
            source: 'detectors/reliability/dropped-assignments',
            field: 'HIGH_DROPPED_PCT',
            value: HIGH_DROPPED_PCT,
          },
          {
            claim: 'displayed evidence rows come from past-grace unread assignment records',
            source: 'parse-teams (~/.claude/teams/*/inboxes/*.json)',
            field: 'teams[].droppedAssignments',
          },
        ],
        inference:
          'An unread marker past the grace window means inbox acceptance was not recorded. ' +
          'It cannot prove that a worker never began or acknowledged the task through another path.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
