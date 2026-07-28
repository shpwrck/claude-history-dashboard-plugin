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
 * The PURE half (record/summary types, the COLD_DAYS/PILEUP_MIN thresholds,
 * and `summarizeTasks`) lives in the node-free leaf `./parse-tasks-summary`,
 * which browser-reachable code imports directly. This module re-exports that
 * surface so server-side importers keep their combined API, and adds only the
 * fs-reading `parseTasksDir` on top. Keeping the pure half in a node-free leaf
 * makes the SPA/server boundary structural rather than dependent on Vite's
 * `node:fs` stub (#2960).
 *
 * Issue #559 / persona P2 (Priya, tech lead).
 */
import { join } from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
  readFileInDirBoundedSync,
  readSubdirectoryNamesBoundedSync,
  remainingEntryCapacity,
  resolveCap,
} from './bounded-fs';
import type { TaskRecord, TaskStatus } from './parse-tasks-summary';

// Re-export the node-free public surface so existing server-side importers of
// `./parse-tasks` (ingest, detectors, tests) keep their combined API.
export {
  COLD_DAYS,
  PILEUP_MIN,
  summarizeTasks,
} from './parse-tasks-summary';
export type {
  TaskStatus,
  TaskRecord,
  TaskSessionSummary,
} from './parse-tasks-summary';

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
  const maxFileBytes = resolveCap(opts.maxFileBytes, DEFAULT_ARTIFACT_MAX_FILE_BYTES);
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  // Symlinked session directories are refused: following one would walk an
  // arbitrary foreign tree as though it belonged to ~/.claude/tasks/ (#3378).
  const entries = readSubdirectoryNamesBoundedSync(dir, maxEntries);
  let taskEntriesRead = 0;

  for (const sessionId of entries) {
    if (taskEntriesRead >= maxEntries) break;
    const sessionDir = join(dir, sessionId);

    const taskFiles = readDirentsBoundedSync(
      sessionDir,
      remainingEntryCapacity(maxEntries, taskEntriesRead)
    )
      .map((entry) => entry.name)
      .filter((f) => f.endsWith('.json') && f !== '_session.json');

    for (const filename of taskFiles) {
      if (taskEntriesRead >= maxEntries) break;
      taskEntriesRead += 1;
      let raw: Record<string, unknown>;
      let mtimeMs: number;
      try {
        const read = readFileInDirBoundedSync(sessionDir, filename, maxFileBytes);
        if (!read) continue;
        raw = JSON.parse(read.text) as Record<string, unknown>;
        // mtime from the descriptor actually read, not a second stat that could
        // resolve somewhere else.
        mtimeMs = read.stat.mtimeMs;
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
