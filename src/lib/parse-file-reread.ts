import type { ToolUsageData, ToolCall } from './parse-tools';
import type { SessionTokenData } from '../types';

/**
 * Re-read heuristic — load-once candidates.
 *
 * `parse-files.ts` already exposes {@link redundantReads}: a 1-row-per-pair
 * listing of (session, file) where the same file was Read ≥3× in one session.
 * That's enough to show a table, but it doesn't quantify the cost or the time
 * spread, so it can't answer "is this worth pinning?".
 *
 * This module returns the same pairs with two extra dimensions:
 *  - estimatedTokenWaste: (reads-1) × avgBytesPerRead / 4 — each repeat re-pays
 *    the file's content cost, so (reads-1) reads' worth of tokens is the
 *    headline savings if the file were pinned in CLAUDE.md or pasted once.
 *  - firstRead / lastRead: the timestamps bracketing the re-reads, so the UI
 *    can show "29× over 47 minutes" — long spreads strongly indicate the file
 *    is being re-loaded due to context eviction rather than tight-loop usage.
 *
 * Token estimate uses each Read's `resultBytes` (the size of its tool_result
 * content in characters, captured by parse-tools as a cheap per-call proxy
 * because the wire carries no per-tool-call token count). Bytes are converted
 * to tokens at 4 chars/token — the same coarse heuristic used elsewhere in
 * the dashboard for non-billed-side estimates. When `resultBytes` is zero for
 * every read of a path (e.g. the tool_result block was dropped or empty), we
 * fall back to the session-wide mean bytes-per-Read so the row still has a
 * comparable cost, with `tokenEstimateSource` recording the fallback.
 */
export interface FileReread {
  sessionId: string;
  path: string;
  readCount: number;
  firstRead: string;
  lastRead: string;
  /**
   * Sum of `resultBytes` across this file's reads in this session. Zero when
   * none of the reads carried a result payload (the estimate then falls back
   * to the session-wide mean — see `tokenEstimateSource`).
   */
  totalBytes: number;
  /** Avg bytes per Read for this (session, path), or the session-wide mean fallback. */
  avgBytesPerRead: number;
  /**
   * (readCount-1) × avgBytesPerRead / 4 — tokens that would NOT have been
   * spent if the file had been loaded once instead of re-Read.
   */
  estimatedTokenWaste: number;
  /** Tells the UI whether the estimate came from this file's own bytes or a fallback. */
  tokenEstimateSource: 'direct' | 'session-mean' | 'global-mean' | 'unknown';
  /** Compactions in the same session, when {@link SessionTokenData} is supplied. */
  compactions: number;
}

export interface FileRereadSummary {
  /** Per (session, file) repeats that met the threshold. */
  repeats: FileReread[];
  /** Sum of `estimatedTokenWaste` over `repeats`. */
  totalEstimatedTokenWaste: number;
  /** Distinct sessions that had at least one qualifying repeat. */
  sessionsAffected: number;
  /** Distinct file paths that qualified in any session. */
  filesAffected: number;
  /** Threshold used (min reads of one path in one session to count). */
  threshold: number;
  /** True if NO read carried a `resultBytes` value — estimates are zero. */
  noByteData: boolean;
}

const READ_TOOL = 'Read';
const CHARS_PER_TOKEN = 4;

function getFilePath(call: ToolCall): string | null {
  const fp = call.input.file_path;
  if (typeof fp !== 'string' || fp.length === 0) return null;
  return fp;
}

interface ReadAccumulator {
  count: number;
  bytes: number;
  /** Reads that came with a non-zero `resultBytes`. */
  bytesSamples: number;
  first: string;
  last: string;
}

function freshAccumulator(): ReadAccumulator {
  return { count: 0, bytes: 0, bytesSamples: 0, first: '', last: '' };
}

/**
 * Memo of `parseFileReread` results, keyed by the identities of its two input
 * arrays (#718). The summary is a pure function of `(toolData, tokenData,
 * threshold)`, but the same parsed arrays flow through several call sites in one
 * engine run — ingest's `buildRepoMapDataset`, the `redundant-reads` and
 * `repo-map-context-waste` detectors, AND the suppression-transition diff, which
 * re-runs each detector on a CLAUDE.md-blanked input that shares `toolData`/
 * `tokenData` by reference but is a fresh object that bypasses the
 * `buildRecommendations` WeakMap. Without this memo the quadratic-ish scan runs
 * twice per detector across that diff; with it the first call wins for everyone.
 *
 * Nested WeakMap: `toolData` identity → `tokenData` identity → (threshold →
 * summary). Both keys are arrays, so the entry is dropped automatically when
 * either input is GC'd. The default `tokenData = []` produces a *fresh* array
 * per omitting call, so those calls intentionally miss the cache (correct: a new
 * empty array is a distinct, uncacheable key) — every in-scope hot path passes
 * the same `input.tokenData` reference.
 */
const rereadCache: WeakMap<
  ToolUsageData[],
  WeakMap<SessionTokenData[], Map<number, FileRereadSummary>>
> = new WeakMap();

/**
 * Build the per-(session, file) re-read summary.
 *
 * @param toolData      Per-session tool calls (see parse-tools).
 * @param tokenData     Optional — used only to surface compaction counts.
 * @param threshold     Minimum reads of one file in one session to qualify.
 *                      Defaults to 3 to match {@link redundantReads}.
 */
export function parseFileReread(
  toolData: ToolUsageData[],
  tokenData: SessionTokenData[] = [],
  threshold = 3
): FileRereadSummary {
  let byToken = rereadCache.get(toolData);
  if (!byToken) {
    byToken = new WeakMap();
    rereadCache.set(toolData, byToken);
  }
  let byThreshold = byToken.get(tokenData);
  if (!byThreshold) {
    byThreshold = new Map();
    byToken.set(tokenData, byThreshold);
  }
  const cached = byThreshold.get(threshold);
  if (cached) return cached;

  const summary = computeFileReread(toolData, tokenData, threshold);
  byThreshold.set(threshold, summary);
  return summary;
}

function computeFileReread(
  toolData: ToolUsageData[],
  tokenData: SessionTokenData[],
  threshold: number
): FileRereadSummary {
  const compactionsBySession = new Map<string, number>();
  for (const t of tokenData) {
    compactionsBySession.set(t.sessionId, t.compactionEvents.length);
  }

  // Global mean bytes-per-Read across all sessions, used as a last-resort
  // fallback when a single session also had no byte data.
  let globalReadBytes = 0;
  let globalReadCount = 0;
  for (const session of toolData) {
    for (const call of session.calls) {
      if (call.toolName !== READ_TOOL) continue;
      if (call.resultBytes > 0) {
        globalReadBytes += call.resultBytes;
        globalReadCount += 1;
      }
    }
  }
  const globalMeanBytes = globalReadCount === 0 ? 0 : globalReadBytes / globalReadCount;

  const repeats: FileReread[] = [];
  const sessionsHit = new Set<string>();
  const filesHit = new Set<string>();
  let totalWaste = 0;
  let anyBytes = globalReadCount > 0;

  for (const session of toolData) {
    const perFile = new Map<string, ReadAccumulator>();
    let sessionReadBytes = 0;
    let sessionReadCount = 0;

    for (const call of session.calls) {
      if (call.toolName !== READ_TOOL) continue;
      const path = getFilePath(call);
      if (!path) continue;

      const acc = perFile.get(path) ?? freshAccumulator();
      acc.count += 1;
      if (call.resultBytes > 0) {
        acc.bytes += call.resultBytes;
        acc.bytesSamples += 1;
        sessionReadBytes += call.resultBytes;
        sessionReadCount += 1;
        anyBytes = true;
      }
      const ts = call.timestamp ?? '';
      if (ts) {
        if (!acc.first || ts < acc.first) acc.first = ts;
        if (!acc.last || ts > acc.last) acc.last = ts;
      }
      perFile.set(path, acc);
    }

    const sessionMeanBytes =
      sessionReadCount === 0 ? 0 : sessionReadBytes / sessionReadCount;
    const compactions = compactionsBySession.get(session.sessionId) ?? 0;

    for (const [path, acc] of perFile) {
      if (acc.count < threshold) continue;

      let avg: number;
      let source: FileReread['tokenEstimateSource'];
      if (acc.bytesSamples > 0) {
        avg = acc.bytes / acc.bytesSamples;
        source = 'direct';
      } else if (sessionMeanBytes > 0) {
        avg = sessionMeanBytes;
        source = 'session-mean';
      } else if (globalMeanBytes > 0) {
        avg = globalMeanBytes;
        source = 'global-mean';
      } else {
        avg = 0;
        source = 'unknown';
      }

      const waste = Math.round(((acc.count - 1) * avg) / CHARS_PER_TOKEN);
      totalWaste += waste;
      sessionsHit.add(session.sessionId);
      filesHit.add(path);

      repeats.push({
        sessionId: session.sessionId,
        path,
        readCount: acc.count,
        firstRead: acc.first,
        lastRead: acc.last,
        totalBytes: acc.bytes,
        avgBytesPerRead: avg,
        estimatedTokenWaste: waste,
        tokenEstimateSource: source,
        compactions,
      });
    }
  }

  repeats.sort(
    (a, b) =>
      b.estimatedTokenWaste - a.estimatedTokenWaste ||
      b.readCount - a.readCount
  );

  return {
    repeats,
    totalEstimatedTokenWaste: totalWaste,
    sessionsAffected: sessionsHit.size,
    filesAffected: filesHit.size,
    threshold,
    noByteData: !anyBytes,
  };
}

/**
 * Global top offenders rolled up across sessions, so the UI can show "files
 * you re-read across many sessions" alongside the per-session repeats. Sum
 * waste and read counts; preserve the earliest first / latest last.
 */
export interface FileRereadGlobal {
  path: string;
  /** Distinct sessions in which the file qualified as a re-read offender. */
  sessions: number;
  /** Total qualifying re-reads across those sessions. */
  totalReads: number;
  /** Sum of `estimatedTokenWaste` across those sessions. */
  totalEstimatedTokenWaste: number;
  /** Highest per-session read count seen. */
  maxPerSession: number;
  /**
   * Confidence in the token-waste estimate across contributing repeats.
   * - 'all-direct': every contributing repeat had its own byte data.
   * - 'mixed': some repeats used direct bytes, others used a fallback.
   * - 'fallback-only': no contributing repeat had direct byte data.
   */
  estimateQuality: 'all-direct' | 'mixed' | 'fallback-only';
}

export function aggregateRereadByPath(
  summary: FileRereadSummary
): FileRereadGlobal[] {
  const map = new Map<
    string,
    FileRereadGlobal & { _directCount: number; _fallbackCount: number }
  >();
  for (const r of summary.repeats) {
    const entry = map.get(r.path) ?? {
      path: r.path,
      sessions: 0,
      totalReads: 0,
      totalEstimatedTokenWaste: 0,
      maxPerSession: 0,
      estimateQuality: 'all-direct' as const,
      _directCount: 0,
      _fallbackCount: 0,
    };
    entry.sessions += 1;
    entry.totalReads += r.readCount;
    entry.totalEstimatedTokenWaste += r.estimatedTokenWaste;
    entry.maxPerSession = Math.max(entry.maxPerSession, r.readCount);
    if (r.tokenEstimateSource === 'direct') {
      entry._directCount += 1;
    } else {
      entry._fallbackCount += 1;
    }
    map.set(r.path, entry);
  }
  return Array.from(map.values())
    .map(({ _directCount, _fallbackCount, ...entry }) => {
      let estimateQuality: FileRereadGlobal['estimateQuality'];
      if (_directCount > 0 && _fallbackCount === 0) {
        estimateQuality = 'all-direct';
      } else if (_directCount > 0 && _fallbackCount > 0) {
        estimateQuality = 'mixed';
      } else {
        estimateQuality = 'fallback-only';
      }
      return { ...entry, estimateQuality };
    })
    .sort(
      (a, b) =>
        b.totalEstimatedTokenWaste - a.totalEstimatedTokenWaste ||
        b.totalReads - a.totalReads
    );
}
