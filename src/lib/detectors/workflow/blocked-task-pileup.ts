/**
 * blocked-task-pileup — flags sessions where >= PILEUP_MIN (2) tasks are stalled
 * behind a single blockedBy root that never completed. Tells the tech lead to
 * unblock the DAG root first rather than spending effort on downstream tasks.
 *
 * Persona P2 (Priya) / issue #559.
 *
 * dataDeps: reads a new optional `tasks` field on RecommendationInput (injected
 * by the main session's wiring). If absent or empty the detector is silent.
 */
import type { Detector } from '../types';
import type { RecommendationInput } from '../types';
import { short } from '../shared';
import type { TaskRecord } from '../../parse-tasks';
import { PILEUP_MIN } from '../../parse-tasks';

export const detector: Detector = {
  id: 'workflow.blocked-task-pileup',
  category: 'workflow',
  dataDeps: ['tasks' as keyof RecommendationInput],

  rule(input: RecommendationInput) {
    const data = (input as RecommendationInput & { tasks?: TaskRecord[] }).tasks ?? [];
    if (!data.length) return null;

    interface Pileup {
      sessionId: string;
      rootId: string;
      rootSubject: string;
      blockedCount: number;
      blockedSubjects: string[];
    }
    const pileups: Pileup[] = [];

    // Group tasks by session so we only match blockedBy roots within the same session.
    const bySession = new Map<string, TaskRecord[]>();
    for (const t of data) {
      const group = bySession.get(t.sessionId) ?? [];
      group.push(t);
      bySession.set(t.sessionId, group);
    }

    for (const [sessionId, tasks] of bySession) {
      const byId = new Map(tasks.map((t) => [t.id, t]));

      // For every open task with blockedBy entries, check whether any referenced
      // root task is itself unfinished. Group open tasks by their unfinished root.
      const groups = new Map<string, TaskRecord[]>();
      for (const t of tasks) {
        if (t.status === 'completed') continue; // only stalled tasks count
        for (const rootId of t.blockedBy) {
          const root = byId.get(rootId);
          if (!root || root.status === 'completed') continue; // root is done or unknown
          const group = groups.get(rootId) ?? [];
          group.push(t);
          groups.set(rootId, group);
        }
      }

      for (const [rootId, blocked] of groups) {
        if (blocked.length < PILEUP_MIN) continue;
        const root = byId.get(rootId)!;
        pileups.push({
          sessionId,
          rootId,
          rootSubject: root.subject,
          blockedCount: blocked.length,
          blockedSubjects: blocked.map((t) => t.subject),
        });
      }
    }

    if (!pileups.length) return null;

    // Biggest pileup first
    pileups.sort((a, b) => b.blockedCount - a.blockedCount);

    const top = pileups[0];
    const totalStalled = pileups.reduce((s, p) => s + p.blockedCount, 0);

    const evidenceLines = pileups.slice(0, 5).map(
      (p) =>
        `${short(p.sessionId)}: ${p.blockedCount} task(s) blocked behind "${p.rootSubject}"`
    );

    const fixSnippet = pileups
      .slice(0, 3)
      .map(
        (p) =>
          `# Unblock: "${p.rootSubject}" (session ${short(p.sessionId)})\n` +
          `# Assign an owner or split the root; ${p.blockedCount} downstream task(s) then unblock:\n` +
          p.blockedSubjects.map((s) => `#   - ${s}`).join('\n')
      )
      .join('\n\n');

    return {
      id: 'workflow.blocked-task-pileup',
      category: 'workflow',
      severity: 'warning',
      title: 'Blocked task pileup — unfinished DAG root holding up downstream work',
      detail:
        `${totalStalled} open task(s) across ${pileups.length} pileup(s) are stalled ` +
        `behind an unfinished root. Worst: ${top.blockedCount} task(s) waiting on ` +
        `"${top.rootSubject}" in session ${short(top.sessionId)}.`,
      action:
        `Assign an owner to the root task first, or split it into smaller steps. ` +
        `Until the root is resolved, the blocked tasks are dead weight.`,
      affected: totalStalled,
      evidence: evidenceLines,
      fix: {
        target: 'command',
        label: 'Identify and unblock root tasks',
        note:
          'Review each root task. Assign an owner or split it; downstream tasks unblock automatically.',
        snippet: fixSnippet,
      },
    };
  },
};
