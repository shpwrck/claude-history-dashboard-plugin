import { parseIsoInstantMs } from './iso-instant';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { SessionTokenData } from '../types';

export interface FileStat {
  filePath: string;
  reads: number;
  edits: number;
  writes: number;
  total: number;
  lastTouched: string;
}

export interface DirStat {
  dir: string;
  fileCount: number;
  totalOps: number;
}

const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Write']);

function getFilePath(call: ToolCall): string | null {
  const input = call.input;
  if (!input || typeof input !== 'object') return null;
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  return filePath;
}

export function aggregateFiles(data: ToolUsageData[]): FileStat[] {
  const map = new Map<string, FileStat>();

  for (const session of data) {
    for (const call of session.calls) {
      const isRead = READ_TOOLS.has(call.toolName);
      const isEdit = EDIT_TOOLS.has(call.toolName);
      const isWrite = WRITE_TOOLS.has(call.toolName);
      if (!isRead && !isEdit && !isWrite) continue;

      const filePath = getFilePath(call);
      if (!filePath) continue;

      const entry =
        map.get(filePath) ??
        {
          filePath,
          reads: 0,
          edits: 0,
          writes: 0,
          total: 0,
          lastTouched: '',
        };

      if (isRead) entry.reads += 1;
      else if (isEdit) entry.edits += 1;
      else if (isWrite) entry.writes += 1;
      entry.total += 1;

      if (call.timestamp && call.timestamp > entry.lastTouched) {
        entry.lastTouched = call.timestamp;
      }

      map.set(filePath, entry);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

export function aggregateDirs(files: FileStat[]): DirStat[] {
  const map = new Map<string, { fileCount: number; totalOps: number }>();

  for (const file of files) {
    const lastSlash = file.filePath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '.' : file.filePath.slice(0, lastSlash) || '/';
    const entry = map.get(dir) ?? { fileCount: 0, totalOps: 0 };
    entry.fileCount += 1;
    entry.totalOps += file.total;
    map.set(dir, entry);
  }

  return Array.from(map.entries())
    .map(([dir, { fileCount, totalOps }]) => ({ dir, fileCount, totalOps }))
    .sort((a, b) => b.totalOps - a.totalOps);
}

export function readOnlyFiles(files: FileStat[]): FileStat[] {
  return files.filter(
    (f) => f.reads > 0 && f.edits === 0 && f.writes === 0
  );
}

// ---------------------------------------------------------------------------
// File-churn ranking
// ---------------------------------------------------------------------------

export interface ChurnStat {
  filePath: string;
  /** Mutating operations: edits + writes (reads excluded). */
  churn: number;
  edits: number;
  writes: number;
  /** Distinct sessions in which the file was edited or written. */
  sessions: number;
  /** churn / sessions — average mutating ops per session that touched it. */
  editsPerSession: number;
  /**
   * ISO timestamp of the newest MUTATING call counted into `churn`, or
   * `undefined` when none of them carried a readable one.
   *
   * Carried here rather than re-derived by callers because the honest `asOf`
   * for a churn claim is the newest call that CONTRIBUTED to it — a later Read
   * or Bash on the same session says nothing about when the file was last
   * churned, and dating the claim from one would assert a freshness the churn
   * evidence does not have.
   */
  latestTimestamp?: string;
}

/**
 * Rank files by churn (edits + writes), the mutating operations that signal
 * a file is being reworked over and over. `aggregateFiles` already counts
 * per-file totals but only ever sorts by `total` (which includes reads); this
 * isolates the mutating signal and exposes an edits/session ratio so a file
 * hammered 60× in one session ranks above one edited once across 60 sessions.
 *
 * Sessions are counted from the raw tool data (not the pre-aggregated
 * `FileStat[]`, which has lost session boundaries).
 */
export function topChurnFiles(
  data: ToolUsageData[],
  limit = 20
): ChurnStat[] {
  const agg = new Map<
    string,
    {
      edits: number;
      writes: number;
      sessions: Set<string>;
      latestMs: number;
      latestTimestamp?: string;
    }
  >();

  for (const session of data) {
    for (const call of session.calls) {
      const isEdit = EDIT_TOOLS.has(call.toolName);
      const isWrite = WRITE_TOOLS.has(call.toolName);
      if (!isEdit && !isWrite) continue;

      const filePath = getFilePath(call);
      if (!filePath) continue;

      const entry =
        agg.get(filePath) ??
        { edits: 0, writes: 0, sessions: new Set<string>(), latestMs: 0 };
      if (isEdit) entry.edits += 1;
      else entry.writes += 1;
      entry.sessions.add(session.sessionId);
      // Track the newest MUTATING call, so a churn claim can be dated from the
      // calls it actually counted rather than from unrelated later activity.
      // STRICT parse: a raw `Date.parse` here would let a malformed-but-
      // coercible value ('2026-02-30', '9999') win the preselection and evict a
      // genuinely valid timestamp, which the downstream validator would then
      // reject — losing the date entirely rather than falling back to the good
      // one.
      const ms = parseIsoInstantMs(call.timestamp);
      if (ms !== undefined && ms > entry.latestMs) {
        entry.latestMs = ms;
        entry.latestTimestamp = call.timestamp;
      }
      agg.set(filePath, entry);
    }
  }

  return Array.from(agg.entries())
    .map(([filePath, { edits, writes, sessions, latestTimestamp }]) => {
      const churn = edits + writes;
      const sessionCount = sessions.size;
      return {
        filePath,
        churn,
        edits,
        writes,
        sessions: sessionCount,
        editsPerSession: sessionCount === 0 ? 0 : churn / sessionCount,
        ...(latestTimestamp !== undefined ? { latestTimestamp } : {}),
      };
    })
    .sort((a, b) => b.churn - a.churn || b.editsPerSession - a.editsPerSession)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Redundant re-reads / context-thrash
// ---------------------------------------------------------------------------

export interface RedundantRead {
  sessionId: string;
  filePath: string;
  /** Times this file was Read within this single session. */
  reads: number;
  /** Compaction events recorded in the same session (0 if unknown). */
  compactions: number;
  /** One-line actionable remediation hint. */
  hint: string;
}

/**
 * Flag (session, file) pairs where the same file was Read ≥ `minReads` times
 * within one session. Repeatedly re-reading the same file burns tokens and
 * often coincides with context thrash — when the file keeps getting evicted by
 * compaction it has to be re-read. Where `tokenData` is supplied, the matching
 * session's `compactionEvents` count is cross-linked so the panel can show
 * "README.md read 29× in a session with 17 compactions".
 *
 * Complements ContextHealth (which scores sessions) by pointing at the
 * specific files driving the re-reads; it does not re-score sessions.
 */
export function redundantReads(
  data: ToolUsageData[],
  tokenData: SessionTokenData[] = [],
  minReads = 3,
  limit = 20
): RedundantRead[] {
  const compactionsBySession = new Map<string, number>();
  for (const t of tokenData) {
    compactionsBySession.set(t.sessionId, t.compactionEvents.length);
  }

  const results: RedundantRead[] = [];

  for (const session of data) {
    const perFile = new Map<string, number>();
    for (const call of session.calls) {
      if (!READ_TOOLS.has(call.toolName)) continue;
      const filePath = getFilePath(call);
      if (!filePath) continue;
      perFile.set(filePath, (perFile.get(filePath) ?? 0) + 1);
    }

    const compactions = compactionsBySession.get(session.sessionId) ?? 0;

    for (const [filePath, reads] of perFile) {
      if (reads < minReads) continue;
      results.push({
        sessionId: session.sessionId,
        filePath,
        reads,
        compactions,
        hint: redundantReadHint(compactions),
      });
    }
  }

  return results
    .sort((a, b) => b.reads - a.reads || b.compactions - a.compactions)
    .slice(0, limit);
}

/**
 * Actionable one-liner for a redundant-read row. When the session also
 * compacted, the re-reads are likely eviction-driven, so the advice differs.
 */
function redundantReadHint(compactions: number): string {
  if (compactions > 0) {
    return 'Compaction is evicting this file — pin it in CLAUDE.md or split the task.';
  }
  return 'Re-read repeatedly — pin in CLAUDE.md or pass its contents once.';
}
