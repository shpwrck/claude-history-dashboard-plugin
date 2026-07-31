/**
 * Client-side Task Health detectors shared with TaskHealthPf.tsx (mirroring
 * proto/539-tasks/detect.mjs).
 *
 * Extracted from the component file (#3273) so the abandoned-task detector can
 * be exercised at detector level in tests — component modules may only export
 * components (react-refresh lint rule). Imports only the node-free
 * parse-tasks-summary leaf, so this module stays SPA-safe (#2960).
 */
import {
  COLD_DAYS,
  type TaskRecord,
  type TaskSessionSummary,
} from './parse-tasks-summary';

const COLD_MS = COLD_DAYS * 24 * 60 * 60 * 1000;

/** True when the latest task activity is more than COLD_DAYS days old. */
export function isCold(latestMtimeMs: number): boolean {
  return Date.now() - latestMtimeMs > COLD_MS;
}

/** True while a task is still open (pending or in progress). */
export function isOpen(t: TaskRecord): boolean {
  return t.status === 'pending' || t.status === 'in_progress';
}

export interface AbandonedSession {
  sessionId: string;
  openCount: number;
  subjects: string[];
  daysSinceActive: number;
}

export function detectAbandoned(
  tasks: TaskRecord[],
  summaries: TaskSessionSummary[],
): AbandonedSession[] {
  // #3273: group open tasks by session in ONE pass over `tasks`, instead of
  // re-filtering the whole array per cold session (O(cold sessions × tasks)).
  // Per-session push order preserves the original array order, so openCount,
  // subjects, and ordering are identical to the per-session filter. With no
  // cold sessions the map is never built — the pre-#3273 code did zero task
  // work on that path, and this must too.
  const coldSummaries = summaries.filter((s) => isCold(s.latestMtimeMs));
  if (coldSummaries.length === 0) return [];
  const openBySession = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const list = openBySession.get(t.sessionId);
    if (list) list.push(t);
    else openBySession.set(t.sessionId, [t]);
  }
  const abandoned: AbandonedSession[] = [];
  for (const s of coldSummaries) {
    const sessionTasks = openBySession.get(s.sessionId) ?? [];
    if (sessionTasks.length === 0) continue;
    const daysSinceActive = Math.floor(
      (Date.now() - s.latestMtimeMs) / (24 * 60 * 60 * 1000),
    );
    abandoned.push({
      sessionId: s.sessionId,
      openCount: sessionTasks.length,
      subjects: sessionTasks.map((t) => t.subject),
      daysSinceActive,
    });
  }
  return abandoned.sort((a, b) => b.openCount - a.openCount);
}
