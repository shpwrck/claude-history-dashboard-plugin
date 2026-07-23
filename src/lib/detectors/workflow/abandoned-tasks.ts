/**
 * abandoned-tasks — flags pending/in_progress tasks in a session that has been
 * idle for >= COLD_DAYS (7) days. The cold gate is what prevents a healthy,
 * today-open session from false-positiving.
 *
 * Persona P2 (Priya) / issue #559.
 *
 * dataDeps: reads the optional `tasks` field on RecommendationInput (injected
 * by the main session's wiring in scripts/ingest.mjs + scripts/server.mjs).
 * If the field is absent or empty the detector is silent.
 */
import type { Detector } from '../types';
import type { RecommendationInput } from '../types';
import { short } from '../shared';
import type { TaskRecord } from '../../parse-tasks';
import { COLD_DAYS } from '../../parse-tasks';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const detector: Detector = {
  id: 'workflow.abandoned-tasks',
  category: 'workflow',
  dataDeps: ['tasks'],

  rule(input: RecommendationInput, now: number) {
    const data = input.tasks ?? [];
    if (!data.length) return null;

    const MS_COLD = COLD_DAYS * MS_PER_DAY;
    const isOpen = (t: TaskRecord) =>
      t.status === 'pending' || t.status === 'in_progress';

    // Group by session; keep only sessions that are cold AND have open tasks.
    const bySession = new Map<string, TaskRecord[]>();
    for (const t of data) {
      const group = bySession.get(t.sessionId) ?? [];
      group.push(t);
      bySession.set(t.sessionId, group);
    }

    interface AbandonedSession {
      sessionId: string;
      daysSinceActive: number;
      count: number;
      subjects: string[];
    }
    const abandoned: AbandonedSession[] = [];

    for (const [sessionId, tasks] of bySession) {
      const openTasks = tasks.filter(isOpen);
      if (!openTasks.length) continue;

      // The session's last-active timestamp = the newest mtime across all its tasks.
      const latestMtime = Math.max(...tasks.map((t) => t.mtimeMs));
      const msIdle = now - latestMtime;
      if (msIdle < MS_COLD) continue; // still warm — not abandoned

      const daysSinceActive = Math.round(msIdle / MS_PER_DAY);
      abandoned.push({
        sessionId,
        daysSinceActive,
        count: openTasks.length,
        subjects: openTasks.map((t) => t.subject),
      });
    }

    if (!abandoned.length) return null;

    // Worst first (most abandoned tasks)
    abandoned.sort((a, b) => b.count - a.count);

    const totalAbandoned = abandoned.reduce((s, a) => s + a.count, 0);
    const top = abandoned[0];

    const evidenceLines = abandoned.slice(0, 5).map(
      (a) =>
        `${short(a.sessionId)}: ${a.count} open task(s), ${a.daysSinceActive}d idle`
    );

    const fixSnippet = abandoned
      .slice(0, 3)
      .map(
        (a) =>
          `cat ~/.claude/tasks/${a.sessionId}/*.json | jq 'select(.status!="completed") | .subject'`
      )
      .join('\n');

    return {
      id: 'workflow.abandoned-tasks',
      category: 'workflow',
      severity: 'warning',
      title: 'Abandoned open tasks in cold sessions',
      detail:
        `${totalAbandoned} open task(s) across ${abandoned.length} session(s) ` +
        `idle >= ${COLD_DAYS} days — work that was never PR'd or formally dropped. ` +
        `Worst: ${short(top.sessionId)} with ${top.count} task(s) idle ${top.daysSinceActive}d.`,
      action:
        'Re-open, reassign, or formally close these tasks. ' +
        'Use the fix snippet to inspect what is still open per session.',
      affected: totalAbandoned,
      evidence: evidenceLines,
      fix: {
        target: 'command',
        label: 'Inspect abandoned tasks',
        note:
          'Run per-session to list tasks never completed. Close or reassign each one.',
        snippet: fixSnippet,
      },
    };
  },
};
