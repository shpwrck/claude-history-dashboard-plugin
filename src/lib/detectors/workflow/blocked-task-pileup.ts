/**
 * blocked-task-pileup — flags sessions where >= PILEUP_MIN (2) tasks are stalled
 * behind a single blockedBy root that never completed. Tells the tech lead to
 * unblock the DAG root first rather than spending effort on downstream tasks.
 *
 * Persona P2 (Priya) / issue #559.
 *
 * dataDeps: reads the optional `tasks` field on RecommendationInput (injected
 * by the main session's wiring). If absent or empty the detector is silent.
 */
import type { Detector } from '../types';
import type { RecommendationInput } from '../types';
import { short } from '../shared';
import type { TaskRecord } from '../../parse-tasks';
import { PILEUP_MIN } from '../../parse-tasks';

/**
 * Flatten arbitrary parsed text to a single display line.
 *
 * Task subjects are free-form strings read from `~/.claude/tasks/*.json`, so a
 * subject may contain newlines (or a carriage return, a U+2028/U+2029 line or
 * paragraph separator, or any other control character). The fix snippet below
 * is a comment-only shell block; a subject carrying a newline followed by
 * `printf owned` used to end the `#` comment and leave `printf owned` as an
 * executable line the moment the user pasted it (#3231). Every line/paragraph
 * separator and control character collapses to a space here, and runs of
 * whitespace collapse after it so the result stays readable.
 */
export function toSingleLine(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Belt-and-braces: guarantee EVERY physical line of a comment-only snippet
 * starts with `#`, whatever slipped through the per-field flattening above.
 * The snippet is `target: 'command'`, so this is the property that makes it
 * inert when pasted into a shell.
 */
export function commentOnly(snippet: string): string {
  return snippet
    .split('\n')
    .map((line) => (line.startsWith('#') ? line : `# ${line}`.trimEnd()))
    .join('\n');
}

export const detector: Detector = {
  id: 'workflow.blocked-task-pileup',
  category: 'workflow',
  dataDeps: ['tasks'],

  rule(input: RecommendationInput) {
    const data = input.tasks ?? [];
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

    // Comment-only snippet: every interpolated subject is flattened to one line
    // first, the blank separator between pileups is itself a `#` line, and
    // commentOnly() re-asserts the invariant over the finished text (#3231).
    const fixSnippet = commentOnly(
      pileups
        .slice(0, 3)
        .map(
          (p) =>
            `# Unblock: "${toSingleLine(p.rootSubject)}" (session ${toSingleLine(short(p.sessionId))})\n` +
            `# Assign an owner or split the root; ${p.blockedCount} downstream task(s) then unblock:\n` +
            p.blockedSubjects
              .map((s) => `#   - ${toSingleLine(s)}`)
              .join('\n')
        )
        .join('\n#\n')
    );

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
        // Declared, never inherited — an absent fixKind silently defaults to
        // 'validated', leaving the one-click classification unclaimed. Safe-to-
        // paste is judged against the DECLARED TARGET: this snippet is
        // comment-only, and in a shell every `#` line is an inert no-op, so
        // pasting it verbatim cannot do anything — matching the established
        // comment-only `target: 'command'` fix in cost.idle-mcp-tools. (Against a
        // settings.json target the same block would be 'manual', since `#` lines
        // are not valid JSON and would break the file.) The real remedy is the
        // human action in `note`; the snippet only names the roots to act on.
        fixKind: 'validated',
        note:
          'Review each root task. Assign an owner or split it; downstream tasks unblock automatically.',
        snippet: fixSnippet,
      },
    };
  },
};
