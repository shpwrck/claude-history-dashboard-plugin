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
 *         same path shortly after, or a Bash `git checkout/restore/revert`).
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

const UNDO_BASH_RE = /^(git\s+(checkout|restore|revert|reset)\b)/;

function targetKey(call: ToolCall): string {
  if (call.toolName === 'Bash') {
    const cmd = typeof call.input?.command === 'string' ? call.input.command : '';
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

function isUndoBash(call: ToolCall): boolean {
  if (call.toolName !== 'Bash') return false;
  const cmd = typeof call.input?.command === 'string' ? call.input.command : '';
  return UNDO_BASH_RE.test(cmd.trim());
}

interface SortedCall {
  call: ToolCall;
  t: number;
}

function sessionApiErrorTimes(
  sessionId: string,
  apiErrors: ApiErrorEvent[]
): number[] {
  const out: number[] = [];
  for (const e of apiErrors) {
    if (e.sessionId !== sessionId) continue;
    const t = Date.parse(e.timestamp);
    if (!isNaN(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

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
  return entry.summary.length > 0;
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

  for (const session of toolData) {
    const sorted: SortedCall[] = session.calls
      .map((call) => ({ call, t: Date.parse(call.timestamp) }))
      .filter((row) => !isNaN(row.t))
      .sort((a, b) => a.t - b.t);

    const apiErrTimes = sessionApiErrorTimes(session.sessionId, apiErrors);
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
        // Undo: only fire on a bash `git checkout/restore/revert/reset` shortly
        // after a file-mutating tool. A later Edit on the same file is too
        // ambiguous (it's just as likely a follow-up tweak).
        if (
          !sawUndo &&
          isFileEditTool(cur.toolName) &&
          curFile !== null &&
          isUndoBash(next)
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
