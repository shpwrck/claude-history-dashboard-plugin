/**
 * parse-tasks-summary.ts — Node-free leaf of the task-parsing module.
 *
 * Holds the PURE half of task parsing: the record/summary types, the detector
 * thresholds, and `summarizeTasks` (a fold over already-parsed records). It
 * imports NO node built-ins, so browser-reachable code (e.g.
 * `src/components/TaskHealthPf.tsx`) can value-import it without dragging
 * `node:fs`/`node:path` into the SPA bundle.
 *
 * The fs-reading half — `parseTasksDir` and its options — lives in the
 * server-only `parse-tasks.ts`, which re-exports everything here so existing
 * server-side importers keep their combined surface. This split makes the
 * SPA/server boundary structural instead of stub-dependent (#2960); the old
 * arrangement only survived because Vite stubs `node:fs`.
 *
 * Issue #559 / persona P2 (Priya, tech lead).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One task record, normalised from the raw JSON stored on disk. Fields map
 * 1-to-1 to the artifact shape; `mtimeMs` is derived from the file's mtime and
 * is the primary clock used by detectors (no separate sidecar needed).
 */
export interface TaskRecord {
  /** Stable task id within its session (e.g. "1", "2", custom string). */
  id: string;
  /** Short imperative subject line. */
  subject: string;
  /** Longer prose description. May be empty. */
  description: string;
  /** Progressive-participle form of the subject ("Burning #182"). May be empty. */
  activeForm: string;
  /** Owner string (agent wave, user name, etc.). May be empty. */
  owner: string;
  /** Task lifecycle status. */
  status: TaskStatus;
  /** IDs of tasks this task unblocks (inverse of blockedBy). */
  blocks: string[];
  /** IDs of tasks that must complete before this one can start. */
  blockedBy: string[];
  /** PR URL from metadata.pr, if the task was linked to a pull request. */
  pr?: string;
  /** The session this task belongs to (= the sub-directory name). */
  sessionId: string;
  /** Last-modified time of the task file in milliseconds since epoch. */
  mtimeMs: number;
}

// ── Per-session completion summary ───────────────────────────────────────────

export interface TaskSessionSummary {
  sessionId: string;
  total: number;
  completed: number;
  /** Completion rate in [0, 1]. 1.0 when total === 0. */
  rate: number;
  open: number;
  /** Milliseconds since epoch of the newest task file in this session. */
  latestMtimeMs: number;
  /** Milliseconds since epoch of the oldest task file in this session. */
  earliestMtimeMs: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** A session untouched this many days = its open tasks are considered abandoned. */
export const COLD_DAYS = 7;
/** Minimum number of tasks stalled behind one unfinished root to be a pileup. */
export const PILEUP_MIN = 2;

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Aggregate a flat list of TaskRecords into per-session completion summaries,
 * sorted worst-completion-rate first (matching the prototype's digest order).
 */
export function summarizeTasks(tasks: TaskRecord[]): TaskSessionSummary[] {
  const bySession = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const group = bySession.get(t.sessionId) ?? [];
    group.push(t);
    bySession.set(t.sessionId, group);
  }

  const summaries: TaskSessionSummary[] = [];
  for (const [sessionId, group] of bySession) {
    const completed = group.filter((t) => t.status === 'completed').length;
    const open = group.filter(
      (t) => t.status === 'pending' || t.status === 'in_progress'
    ).length;
    const mtimes = group.map((t) => t.mtimeMs);
    summaries.push({
      sessionId,
      total: group.length,
      completed,
      rate: group.length > 0 ? completed / group.length : 1,
      open,
      latestMtimeMs: Math.max(...mtimes),
      earliestMtimeMs: Math.min(...mtimes),
    });
  }

  // Worst first (mirrors the prototype's per-session digest order)
  summaries.sort((a, b) => a.rate - b.rate);
  return summaries;
}
