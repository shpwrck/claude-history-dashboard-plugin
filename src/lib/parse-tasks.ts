/**
 * parse-tasks.ts — Parses ~/.claude/tasks/<sessionId>/<n>.json into typed records.
 *
 * The tasks directory holds one sub-directory per session. Each sub-directory
 * contains numbered JSON files (1.json, 2.json, …) shaped like:
 *   { id, subject, description, activeForm, owner?, status, blocks[], blockedBy[], metadata?: { pr } }
 *
 * The parser derives `mtimeMs` from the file's mtime (newest file in a session
 * directory = that session's last-active timestamp, analogous to the prototype's
 * _session.json `daysSinceActive`). No sidecar is required.
 *
 * SERVER-ONLY: uses node:fs/node:path/node:os — never import this in browser code.
 * Called from scripts/ingest.mjs via `assembleDataset`.
 *
 * Issue #559 / persona P2 (Priya, tech lead).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeMaxEntries,
  readDirentsBoundedSync,
  remainingEntryCapacity,
} from './bounded-fs';

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

export interface ParseTasksOptions {
  maxFileBytes?: number;
  maxEntries?: number;
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Walk `~/.claude/tasks/` and return a flat array of normalised TaskRecords.
 *
 * @param dir  Absolute path to the tasks root (e.g. `~/.claude/tasks/`).
 *             Each immediate child directory is treated as a session.
 *             Files that are not directories, or JSON files that are malformed,
 *             are silently skipped.
 */
export function parseTasksDir(dir: string, opts: ParseTasksOptions = {}): TaskRecord[] {
  const records: TaskRecord[] = [];
  const maxFileBytes =
    typeof opts.maxFileBytes === 'number' &&
    Number.isFinite(opts.maxFileBytes) &&
    opts.maxFileBytes >= 0
      ? Math.floor(opts.maxFileBytes)
      : -1;
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const entries = readDirentsBoundedSync(dir, maxEntries).map((entry) => entry.name);
  let taskEntriesRead = 0;

  for (const sessionId of entries) {
    if (taskEntriesRead >= maxEntries) break;
    const sessionDir = join(dir, sessionId);
    let stat;
    try {
      stat = statSync(sessionDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const taskFiles = readDirentsBoundedSync(
      sessionDir,
      remainingEntryCapacity(maxEntries, taskEntriesRead)
    )
      .map((entry) => entry.name)
      .filter((f) => f.endsWith('.json') && f !== '_session.json');

    for (const filename of taskFiles) {
      if (taskEntriesRead >= maxEntries) break;
      taskEntriesRead += 1;
      const filePath = join(sessionDir, filename);
      let raw: Record<string, unknown>;
      let mtimeMs: number;
      try {
        const fileStat = statSync(filePath);
        if (
          !fileStat.isFile() ||
          (maxFileBytes >= 0 && fileStat.size > maxFileBytes)
        ) {
          continue;
        }
        const text = readFileSync(filePath, 'utf8');
        raw = JSON.parse(text) as Record<string, unknown>;
        mtimeMs = fileStat.mtimeMs;
      } catch {
        // malformed or unreadable — skip silently
        continue;
      }

      const status = normaliseStatus(raw.status);
      if (!status) continue; // must have a recognisable status field

      const metadata = raw.metadata as Record<string, unknown> | undefined;
      const pr =
        metadata && typeof metadata.pr === 'string' && metadata.pr
          ? metadata.pr
          : undefined;

      records.push({
        id: typeof raw.id === 'string' ? raw.id : filename.replace('.json', ''),
        subject: typeof raw.subject === 'string' ? raw.subject : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : '',
        owner: typeof raw.owner === 'string' ? raw.owner : '',
        status,
        blocks: normaliseStringArray(raw.blocks),
        blockedBy: normaliseStringArray(raw.blockedBy),
        pr,
        sessionId,
        mtimeMs,
      });
    }
  }

  return records;
}

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

// ── Internal helpers ──────────────────────────────────────────────────────────

function normaliseStatus(raw: unknown): TaskStatus | null {
  if (raw === 'pending' || raw === 'in_progress' || raw === 'completed') {
    return raw;
  }
  return null;
}

function normaliseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}
