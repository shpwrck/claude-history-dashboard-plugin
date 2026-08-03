import type { ToolCall, ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import type { SessionTimeline, TimelineEntry } from './parse-timeline';

/**
 * Per-tool "usefulness vs noise" proxy.
 *
 * Heuristic by design — there is no ground truth for whether a single tool call
 * "succeeded at its job," only signals around it:
 *
 *  bad  : the call was followed by an error (tool_result.isError, or a native
 *         api_error event within a short window), or by an immediate same-tool
 *         retry on the same target (Bash with the same command, file tools on
 *         the same file_path), or by an undo gesture (Edit/Write touching the
 *         same path shortly after, or a Bash git undo whose parser-owned exact
 *         path evidence matches the edited file).
 *  good : the call was followed by forward motion — a user message, or a
 *         *different* tool call on a *different* target.
 *
 * Score is Laplace-smoothed so a low-volume tool with one bad signal doesn't
 * collapse to 0:  score = (good + alpha) / (good + bad + 2*alpha), alpha = 1.
 *
 * Consumers should display this as a directional hint, not a verdict.
 */
export interface ToolEffectivenessRow {
  tool: string;
  invocations: number;
  immediatelyFollowedByError: number;
  immediatelyFollowedByRetry: number;
  immediatelyFollowedByUndo: number;
  /** Forward-motion signal — used as the denominator's good half. */
  immediatelyFollowedByProgress: number;
  /** 0..1, Laplace-smoothed (alpha = 1). */
  effectivenessScore: number;
}

const LOOKAHEAD_TOOL_CALLS = 3;
const API_ERROR_WINDOW_MS = 30_000;
const SMOOTHING_ALPHA = 1;

function targetKey(call: ToolCall): string {
  if (call.toolName === 'Bash') {
    const cmd =
      typeof call.input?.command === 'string'
        ? call.input.command
        : call.commandFingerprint ?? call.commandPreview ?? '';
    return `Bash::${cmd.trim()}`;
  }
  const path = typeof call.input?.file_path === 'string' ? call.input.file_path : '';
  return `${call.toolName}::${path}`;
}

function filePath(call: ToolCall): string | null {
  const fp = typeof call.input?.file_path === 'string' ? call.input.file_path : '';
  return fp.length > 0 ? fp : null;
}

function isFileEditTool(name: string): boolean {
  return name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit';
}

function normalizeFilePathForComparison(filePath: string): string {
  const slashed = filePath.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:\//.exec(slashed)?.[0] ?? '';
  const absolute = drive.length > 0 || slashed.startsWith('/');
  const rest = drive.length > 0 ? slashed.slice(drive.length) : slashed;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const prefix = drive || (absolute ? '/' : '');
  return `${prefix}${parts.join('/')}`;
}

function undoTargetsFile(call: ToolCall, filePath: string): boolean {
  if (call.toolName !== 'Bash' || !Array.isArray(call.commandUndoFilePaths)) {
    return false;
  }
  const target = normalizeFilePathForComparison(filePath);
  return call.commandUndoFilePaths.some(
    (candidate) =>
      typeof candidate === 'string' &&
      normalizeFilePathForComparison(candidate) === target
  );
}

interface SortedCall {
  call: ToolCall;
  t: number;
}

/**
 * Bucket every API error by session once, sorting each bucket once (#3161).
 *
 * This was a per-session helper that walked the WHOLE `apiErrors` array and
 * sorted the matching subset, called once per tool-data session — O(S x E)
 * scans plus S sorts during ingest, to compute a partition that does not
 * depend on which session is asking. One pass builds every bucket instead, and
 * the total sort work is bounded by sorting the input once.
 *
 * Per-bucket results are byte-identical to the old filter: insertion order is
 * preserved before sorting, the comparator is the same, and unparseable
 * timestamps are dropped at the same point. A session with no errors gets no
 * bucket, and the caller substitutes the empty array the old helper returned.
 *
 * SCOPED TO `wanted`, which is not an optimization detail but a parity
 * requirement. Callers routinely pass a route-filtered `toolData` alongside the
 * COMPLETE `apiErrors` collection (`ToolUsage.tsx` does exactly this), and the
 * old per-session helper only ever parsed and sorted errors belonging to a
 * session it was asked about. An unscoped eager index would parse, bucket and
 * sort the entire error history to render a filtered view — including the
 * empty-`toolData` case, which used to do no API-error work at all. That would
 * relocate the cost rather than remove it.
 */
function apiErrorTimesBySession(
  apiErrors: ApiErrorEvent[],
  wanted: Set<string>
): Map<string, number[]> {
  const bySession = new Map<string, number[]>();
  // No sessions asked about -> no error work, exactly as before the index.
  if (wanted.size === 0) return bySession;
  for (const e of apiErrors) {
    if (!wanted.has(e.sessionId)) continue;
    const t = Date.parse(e.timestamp);
    if (isNaN(t)) continue;
    const bucket = bySession.get(e.sessionId);
    if (bucket) bucket.push(t);
    else bySession.set(e.sessionId, [t]);
  }
  for (const bucket of bySession.values()) bucket.sort((a, b) => a - b);
  return bySession;
}

/** Shared empty bucket for sessions with no API errors; never mutated. */
const NO_API_ERROR_TIMES: number[] = [];

function hasApiErrorWithin(
  errorTimes: number[],
  fromMs: number,
  windowMs: number
): boolean {
  for (const t of errorTimes) {
    if (t < fromMs) continue;
    if (t - fromMs <= windowMs) return true;
    return false;
  }
  return false;
}

function sessionUserMessageTimes(timeline: SessionTimeline | undefined): number[] {
  if (!timeline) return [];
  const out: number[] = [];
  for (const entry of timeline.entries) {
    if (!isUserPrompt(entry)) continue;
    const t = Date.parse(entry.timestamp);
    if (!isNaN(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function isUserPrompt(entry: TimelineEntry): boolean {
  // tool_result entries arrive as type === 'user' on the wire but we want
  // genuine human messages — parse-timeline gives them kind === 'user', and
  // tool_results get kind === 'tool_result'. Skip empty summaries (often
  // synthetic / continuation entries).
  if (entry.kind !== 'user') return false;
  return (entry.summaryLen ?? entry.summary?.length ?? 0) > 0;
}

function hasUserMessageBetween(
  userTimes: number[],
  afterMs: number,
  beforeMs: number
): boolean {
  for (const t of userTimes) {
    if (t <= afterMs) continue;
    if (t < beforeMs) return true;
    if (t >= beforeMs) return false;
  }
  return false;
}

export function computeToolEffectiveness(
  toolData: ToolUsageData[],
  apiErrors: ApiErrorEvent[],
  timelines: SessionTimeline[]
): ToolEffectivenessRow[] {
  const timelineBySession = new Map<string, SessionTimeline>();
  for (const t of timelines) timelineBySession.set(t.sessionId, t);

  const agg = new Map<
    string,
    {
      invocations: number;
      err: number;
      retry: number;
      undo: number;
      progress: number;
    }
  >();

  const bump = (
    tool: string,
    field: 'err' | 'retry' | 'undo' | 'progress'
  ) => {
    const row =
      agg.get(tool) ?? { invocations: 0, err: 0, retry: 0, undo: 0, progress: 0 };
    row[field] += 1;
    agg.set(tool, row);
  };

  const apiErrTimesBySession = apiErrorTimesBySession(
    apiErrors,
    new Set(toolData.map((s) => s.sessionId))
  );

  for (const session of toolData) {
    const sorted: SortedCall[] = session.calls
      .map((call) => ({ call, t: Date.parse(call.timestamp) }))
      .filter((row) => !isNaN(row.t))
      .sort((a, b) => a.t - b.t);

    const apiErrTimes =
      apiErrTimesBySession.get(session.sessionId) ?? NO_API_ERROR_TIMES;
    const userTimes = sessionUserMessageTimes(
      timelineBySession.get(session.sessionId)
    );

    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i].call;
      const curT = sorted[i].t;
      const row =
        agg.get(cur.toolName) ?? {
          invocations: 0,
          err: 0,
          retry: 0,
          undo: 0,
          progress: 0,
        };
      row.invocations += 1;
      agg.set(cur.toolName, row);

      let sawError = false;
      let sawRetry = false;
      let sawUndo = false;
      let sawProgress = false;

      // (a) error signal: the call's own tool_result was an error, or a native
      // api_error landed within API_ERROR_WINDOW_MS after the call.
      if (cur.isError === true) {
        sawError = true;
      } else if (hasApiErrorWithin(apiErrTimes, curT, API_ERROR_WINDOW_MS)) {
        sawError = true;
      }

      const curKey = targetKey(cur);
      const curFile = filePath(cur);

      // (b) retry / undo / progress: scan the next LOOKAHEAD_TOOL_CALLS calls.
      const end = Math.min(sorted.length, i + 1 + LOOKAHEAD_TOOL_CALLS);
      let firstNextT: number | undefined;
      for (let j = i + 1; j < end; j++) {
        const next = sorted[j].call;
        const nextT = sorted[j].t;
        if (firstNextT === undefined) firstNextT = nextT;

        if (!sawRetry && targetKey(next) === curKey) {
          sawRetry = true;
        }
        // Undo: only fire when the parser proved that a git undo gesture named
        // this exact edited path before the raw Bash command was stripped. A
        // command with absent/ambiguous path provenance fails closed.
        if (
          !sawUndo &&
          isFileEditTool(cur.toolName) &&
          curFile !== null &&
          undoTargetsFile(next, curFile)
        ) {
          sawUndo = true;
        }
        // Forward motion: any later call on a different target — whether a
        // different tool, or the same tool aimed elsewhere.
        if (!sawProgress && targetKey(next) !== curKey) {
          sawProgress = true;
        }
      }

      // (c) progress can also be a fresh user message before the next tool call.
      if (!sawProgress) {
        const beforeT = firstNextT ?? curT + API_ERROR_WINDOW_MS;
        if (hasUserMessageBetween(userTimes, curT, beforeT)) {
          sawProgress = true;
        }
      }

      if (sawError) bump(cur.toolName, 'err');
      if (sawRetry) bump(cur.toolName, 'retry');
      if (sawUndo) bump(cur.toolName, 'undo');
      if (sawProgress) bump(cur.toolName, 'progress');
    }
  }

  const rows: ToolEffectivenessRow[] = [];
  for (const [tool, v] of agg) {
    const bad = v.err + v.retry + v.undo;
    const good = v.progress;
    const score =
      (good + SMOOTHING_ALPHA) /
      (good + bad + 2 * SMOOTHING_ALPHA);
    rows.push({
      tool,
      invocations: v.invocations,
      immediatelyFollowedByError: v.err,
      immediatelyFollowedByRetry: v.retry,
      immediatelyFollowedByUndo: v.undo,
      immediatelyFollowedByProgress: v.progress,
      effectivenessScore: score,
    });
  }

  return rows.sort((a, b) => {
    if (b.effectivenessScore !== a.effectivenessScore) {
      return b.effectivenessScore - a.effectivenessScore;
    }
    return b.invocations - a.invocations;
  });
}
