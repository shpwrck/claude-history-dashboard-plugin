/**
 * parse-file-history.ts — ingest for ~/.claude/file-history/<sessionId>/<hash>@v2.
 *
 * Each @v2 file IS one pre-edit checkpoint produced by Claude Code's file-snapshot
 * subsystem (issue #564). Counting snapshots per session directory gives a direct
 * churn signal; file mtimes give the burst window. File BODIES are NEVER read —
 * only structural counts and stat metadata, so there is no secret-exfil surface.
 *
 * Persona P5 (Riley, prompt-pattern researcher). Signals per session:
 *   churn       = count of @v2 snapshot files in the session dir
 *   spanMin     = (lastMtime - firstMtime) / 60 000  (ms to minutes)
 *   burstRate   = churn / max(1, spanMin)             (edits/min — retry-storm proxy)
 *   reworkScore = churn * (1 + burstRate)             (tight+churny ranks highest)
 *
 * Rolled up per project by the aggregate helper when the caller provides a
 * sessionId-to-project mapping (e.g. from existing Session data).
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  normalizeMaxEntries,
  readDirentsBoundedSync,
  remainingEntryCapacity,
} from './bounded-fs';

// ── Output types ──────────────────────────────────────────────────────────────

export interface FileHistorySession {
  /** Raw session directory name under ~/.claude/file-history/. */
  sessionId: string;
  /** Number of @v2 snapshot files (one per pre-edit checkpoint). */
  churn: number;
  /** Time span covered by the snapshots, in minutes (mtime-based). */
  spanMin: number;
  /** Edits per minute; retry-storm proxy. */
  burstRate: number;
  /** Composite rework score: churn * (1 + burstRate). */
  reworkScore: number;
  /** Epoch ms of the earliest snapshot mtime. */
  firstMs: number;
  /** Epoch ms of the latest snapshot mtime. */
  lastMs: number;
}

export interface FileHistoryProject {
  project: string;
  sessions: number;
  totalChurn: number;
  avgChurn: number;
  /** Mean reworkScore across sessions attributed to this project. */
  reworkSignature: number;
}

export interface ParseFileHistoryOptions {
  maxEntries?: number;
}

// ── Pure scoring helper (exported for testing) ────────────────────────────────

/**
 * Compute derived scoring fields from raw snapshot counts and timestamps.
 * Pure function — no I/O, safe to unit-test without touching the filesystem.
 *
 * @param churn   Number of @v2 snapshot files found.
 * @param firstMs Epoch ms of the earliest snapshot mtime.
 * @param lastMs  Epoch ms of the latest snapshot mtime.
 */
export function scoreSession(params: {
  churn: number;
  firstMs: number;
  lastMs: number;
}): Pick<FileHistorySession, 'spanMin' | 'burstRate' | 'reworkScore'> {
  const { churn, firstMs, lastMs } = params;
  const spanMin = Math.max(0, (lastMs - firstMs) / 60_000);
  const burstRate = churn / Math.max(1, spanMin);
  const reworkScore = churn * (1 + burstRate);
  return {
    spanMin: +spanMin.toFixed(1),
    burstRate: +burstRate.toFixed(2),
    reworkScore: +reworkScore.toFixed(1),
  };
}

// ── Directory walker ──────────────────────────────────────────────────────────

/**
 * Walk ~/.claude/file-history/ and return one FileHistorySession per
 * non-empty session directory. Skips directories that contain no @v2 files.
 *
 * File BODIES are never read — only readdirSync (names) and statSync (mtime).
 *
 * @param dir  Absolute path to the file-history root (e.g. ~/.claude/file-history).
 */
export function parseFileHistoryDir(
  dir: string,
  opts: ParseFileHistoryOptions = {}
): FileHistorySession[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries, DEFAULT_ARTIFACT_MAX_ENTRIES);
  const entries = readDirentsBoundedSync(dir, maxEntries);
  const results: FileHistorySession[] = [];
  let snapshotEntriesRead = 0;

  for (const entry of entries) {
    if (snapshotEntriesRead >= maxEntries) break;
    if (!entry.isDirectory()) continue;
    const sessionDir = join(dir, entry.name);

    const sessionEntries = readDirentsBoundedSync(
      sessionDir,
      remainingEntryCapacity(maxEntries, snapshotEntriesRead)
    );
    snapshotEntriesRead += sessionEntries.length;
    const snapNames = sessionEntries.map((ent) => ent.name).filter((f) => f.endsWith('@v2'));

    const churn = snapNames.length;
    if (churn === 0) continue;

    // Derive span from file mtimes — NEVER read file bodies.
    const mtimesMs = snapNames.map((f) => {
      try {
        return statSync(join(sessionDir, f)).mtimeMs;
      } catch {
        return 0;
      }
    }).filter((ms) => ms > 0);

    if (mtimesMs.length === 0) continue;

    const firstMs = Math.min(...mtimesMs);
    const lastMs = Math.max(...mtimesMs);
    const { spanMin, burstRate, reworkScore } = scoreSession({ churn, firstMs, lastMs });

    results.push({
      sessionId: entry.name,
      churn,
      spanMin,
      burstRate,
      reworkScore,
      firstMs,
      lastMs,
    });
  }

  return results;
}

// ── Project rollup ────────────────────────────────────────────────────────────

/**
 * Aggregate per-session FileHistory data into per-project summaries.
 *
 * @param sessions  Output of parseFileHistoryDir.
 * @param projectOf Map from sessionId -> project name (caller supplies from
 *                  existing Session data). Sessions not in the map are grouped
 *                  under "(unknown)".
 */
export function aggregateByProject(
  sessions: FileHistorySession[],
  projectOf: Map<string, string>
): FileHistoryProject[] {
  const byProject = new Map<
    string,
    { sessions: number; totalChurn: number; scoreSum: number }
  >();

  for (const s of sessions) {
    const project = projectOf.get(s.sessionId) ?? '(unknown)';
    const acc = byProject.get(project) ?? { sessions: 0, totalChurn: 0, scoreSum: 0 };
    acc.sessions++;
    acc.totalChurn += s.churn;
    acc.scoreSum += s.reworkScore;
    byProject.set(project, acc);
  }

  return [...byProject.entries()]
    .map(([project, acc]) => ({
      project,
      sessions: acc.sessions,
      totalChurn: acc.totalChurn,
      avgChurn: +(acc.totalChurn / acc.sessions).toFixed(1),
      reworkSignature: +(acc.scoreSum / acc.sessions).toFixed(1),
    }))
    .sort((a, b) => b.reworkSignature - a.reworkSignature);
}
