import type { ToolUsageData } from './parse-tools';
import { parseJsonl, parseMessage, summarize, type RawSessionEntry } from './parse-utils';

export interface ToolErrorStat {
  toolName: string;
  totalCalls: number;
  errorCalls: number;
  errorRate: number; // 0..1
}

export interface RetryGroup {
  sessionId: string;
  toolName: string;
  count: number; // total back-to-back calls (including the original)
  startTimestamp: string;
  endTimestamp: string;
  hasErrors: boolean; // any call in the group had isError === true
}

export interface ApiErrorEvent {
  sessionId: string;
  timestamp: string;
  summary: string; // short error message, capped at 200 chars
  /**
   * Source of the event: `native` = a first-class `system`/`api_error`
   * transcript line, `text` = inferred from text-matching the fallback paths.
   */
  source?: 'native' | 'text';
  /** HTTP status code from `error.status` (e.g. 529, 429), when present. */
  status?: number;
  /**
   * Low-level cause code from `cause.code` / `error.cause.code`
   * (e.g. "ConnectionRefused"), when present.
   */
  causeCode?: string;
  /** Event `level`, e.g. "error" / "warning", when present. */
  level?: string;
  /**
   * Retry/backoff telemetry carried on every native `api_error` line:
   * `retryInMs` is the planned backoff before the next attempt, `retryAttempt`
   * is the current (1-based) attempt number, `maxRetries` the configured cap.
   */
  retryInMs?: number;
  retryAttempt?: number;
  maxRetries?: number;
}

/** One row of the status-code breakdown surfaced in the UI. */
export interface ApiErrorStatusStat {
  /** Status code (as string) or cause code; "unknown" when neither present. */
  code: string;
  /** Whether `code` is an HTTP status (vs. a cause code / unknown). */
  isHttpStatus: boolean;
  count: number;
  sessionCount: number;
}

// Shape of the native `system`/`api_error` event's nested error payload.
// The human-readable type/message live one level deeper than the field name
// suggests: the SDK wraps the API response body so the real payload is at
// `error.error.error.{type,message}` (e.g. "Overloaded" for a 529), not
// `error.error.{type,message}` (which is null). See #73.
interface NativeApiError {
  status?: unknown;
  cause?: { code?: unknown };
  type?: unknown;
  error?: { type?: unknown; error?: { type?: unknown; message?: unknown } };
}

// Adds the API-error-specific fields on top of the shared wire shape.
type ErrorSessionEntry = RawSessionEntry & {
  subtype?: string;
  level?: unknown;
  cause?: { code?: unknown };
  isApiErrorMessage?: boolean;
  error?: unknown;
  retryInMs?: unknown;
  retryAttempt?: unknown;
  maxRetries?: unknown;
};

function stringifyForSummary(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return summarize(value);
  try {
    return summarize(JSON.stringify(value));
  } catch {
    return '';
  }
}

export function aggregateToolErrors(data: ToolUsageData[]): ToolErrorStat[] {
  const map = new Map<string, { total: number; errors: number }>();

  for (const session of data) {
    for (const call of session.calls) {
      const entry = map.get(call.toolName) ?? { total: 0, errors: 0 };
      entry.total += 1;
      if (call.isError === true) entry.errors += 1;
      map.set(call.toolName, entry);
    }
  }

  return Array.from(map.entries())
    .filter(([, { total }]) => total > 0)
    .map(([toolName, { total, errors }]) => ({
      toolName,
      totalCalls: total,
      errorCalls: errors,
      errorRate: total === 0 ? 0 : errors / total,
    }))
    .sort((a, b) => {
      if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate;
      return b.errorCalls - a.errorCalls;
    });
}

export function detectRetryGroups(
  data: ToolUsageData[],
  gapSec = 60
): RetryGroup[] {
  const gapMs = gapSec * 1000;
  const groups: RetryGroup[] = [];

  for (const session of data) {
    // Pre-parse each call's timestamp once and drop unparseable rows. Sorting
    // and the gap comparison then run on numeric `t` instead of re-parsing
    // 3-4× per adjacent pair.
    const sorted = session.calls
      .map((call) => ({ call, t: Date.parse(call.timestamp) }))
      .filter((row) => !isNaN(row.t))
      .sort((a, b) => a.t - b.t);

    // A "retry group" is a run of consecutive same-tool calls whose adjacent
    // timestamp gap is at most `gapSec` seconds. We flush a run (emitting a
    // RetryGroup when length >= 2) on tool change, on a gap break, or at the
    // end of the list.
    let runStartIdx = 0;
    let runHasErrors = false;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].call.isError === true) runHasErrors = true;
      const isLast = i === sorted.length - 1;
      const nextCallExtendsRun =
        !isLast &&
        sorted[i + 1].call.toolName === sorted[i].call.toolName &&
        sorted[i + 1].t - sorted[i].t <= gapMs;

      if (nextCallExtendsRun) continue;

      const runLength = i - runStartIdx + 1;
      if (runLength >= 2) {
        groups.push({
          sessionId: session.sessionId,
          toolName: sorted[runStartIdx].call.toolName,
          count: runLength,
          startTimestamp: sorted[runStartIdx].call.timestamp,
          endTimestamp: sorted[i].call.timestamp,
          hasErrors: runHasErrors,
        });
      }
      runStartIdx = i + 1;
      runHasErrors = false;
    }
  }

  return groups.sort((a, b) => b.count - a.count);
}

function extractContentString(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (typeof b.text === 'string') return b.text;
      } else if (typeof block === 'string') {
        return block;
      }
    }
  }
  return null;
}

export function parseApiErrors(
  text: string,
  fileName: string
): ApiErrorEvent[] {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const events: ApiErrorEvent[] = [];

  for (const entry of parseJsonl(text) as ErrorSessionEntry[]) {
    const timestamp = entry.timestamp ?? '';
    if (!timestamp) continue;

    // (0) Native first-class event: type === 'system' && subtype === 'api_error'.
    // Preferred over the text-matching heuristics below. Extracts the HTTP
    // status (error.status), the low-level cause code (cause.code or
    // error.cause.code), and the event level.
    if (entry.type === 'system' && entry.subtype === 'api_error') {
      const nativeErr =
        entry.error && typeof entry.error === 'object'
          ? (entry.error as NativeApiError)
          : undefined;

      const status =
        nativeErr && typeof nativeErr.status === 'number'
          ? nativeErr.status
          : undefined;

      const causeRaw =
        (entry.cause && typeof entry.cause.code === 'string'
          ? entry.cause.code
          : undefined) ??
        (nativeErr &&
        nativeErr.cause &&
        typeof nativeErr.cause.code === 'string'
          ? nativeErr.cause.code
          : undefined);

      const level = typeof entry.level === 'string' ? entry.level : undefined;

      // (#76) Retry/backoff telemetry carried on the same line.
      const retryInMs =
        typeof entry.retryInMs === 'number' ? entry.retryInMs : undefined;
      const retryAttempt =
        typeof entry.retryAttempt === 'number' ? entry.retryAttempt : undefined;
      const maxRetries =
        typeof entry.maxRetries === 'number' ? entry.maxRetries : undefined;

      // Build a concise human summary preferring the API error type/message.
      let summary: string;
      const innerType = nativeErr?.error?.error?.type;
      const innerMsg = nativeErr?.error?.error?.message;
      if (typeof innerMsg === 'string' && innerMsg.length > 0) {
        summary = summarize(
          status ? `${status} ${innerMsg}` : innerMsg
        );
      } else if (typeof innerType === 'string' && innerType.length > 0) {
        summary = summarize(
          status ? `${status} ${innerType}` : innerType
        );
      } else if (causeRaw) {
        summary = summarize(
          status ? `${status} ${causeRaw}` : causeRaw
        );
      } else if (status) {
        summary = `HTTP ${status}`;
      } else {
        summary = 'API Error';
      }

      events.push({
        sessionId,
        timestamp,
        summary,
        source: 'native',
        status,
        causeCode: causeRaw,
        level,
        retryInMs,
        retryAttempt,
        maxRetries,
      });
      continue;
    }

    // (a) isApiErrorMessage flag
    if (entry.isApiErrorMessage === true) {
      const msg = parseMessage(entry.message);
      const contentStr = msg ? extractContentString(msg.content) : null;
      events.push({
        sessionId,
        timestamp,
        summary: contentStr ? summarize(contentStr) : 'API Error',
        source: 'text',
      });
      continue;
    }

    // (c) top-level `error` field present
    if (entry.error !== undefined && entry.error !== null) {
      events.push({
        sessionId,
        timestamp,
        summary: stringifyForSummary(entry.error) || 'Error',
        source: 'text',
      });
      continue;
    }

    // (b) type === 'user' with content string starting "API Error" or "Error:"
    if (entry.type === 'user') {
      const msg = parseMessage(entry.message);
      if (!msg) continue;
      const contentStr = extractContentString(msg.content);
      if (!contentStr) continue;
      const trimmed = contentStr.trimStart();
      if (
        trimmed.startsWith('API Error') ||
        trimmed.startsWith('Error:')
      ) {
        events.push({
          sessionId,
          timestamp,
          summary: summarize(contentStr),
          source: 'text',
        });
      }
    }
  }

  return events;
}

/**
 * Group native API-error events by status code (falling back to cause code,
 * then "unknown"), counting occurrences and distinct sessions. Only events
 * that carry a status or cause code (i.e. native `system`/`api_error` lines)
 * contribute; text-matched fallback events have no structured code and are
 * skipped here so the breakdown reflects real API status codes.
 */
export function aggregateApiErrorStatuses(
  events: ApiErrorEvent[]
): ApiErrorStatusStat[] {
  const map = new Map<
    string,
    { isHttpStatus: boolean; count: number; sessions: Set<string> }
  >();

  for (const e of events) {
    let code: string | null = null;
    let isHttpStatus = false;
    if (typeof e.status === 'number') {
      code = String(e.status);
      isHttpStatus = true;
    } else if (e.causeCode) {
      code = e.causeCode;
    } else if (e.source === 'native') {
      code = 'unknown';
    }
    if (code == null) continue; // text-matched fallback w/o structured code

    const existing =
      map.get(code) ?? { isHttpStatus, count: 0, sessions: new Set<string>() };
    existing.count += 1;
    existing.sessions.add(e.sessionId);
    // Prefer the HTTP-status flag if any contributing event was a status.
    existing.isHttpStatus = existing.isHttpStatus || isHttpStatus;
    map.set(code, existing);
  }

  return Array.from(map.entries())
    .map(([code, { isHttpStatus, count, sessions }]) => ({
      code,
      isHttpStatus,
      count,
      sessionCount: sessions.size,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * (#76) Aggregate retry/backoff telemetry across native `api_error` events.
 * Each native line carries the planned backoff (`retryInMs`) before its next
 * attempt and the (1-based) `retryAttempt`. We surface how much retry pressure
 * the run was under: how many attempts were observed, the total time spent
 * waiting on backoff, the worst single attempt number reached, and the
 * configured cap. Events without retry telemetry (e.g. text-matched fallbacks)
 * are ignored.
 */
export interface RetryPressureStat {
  /** Number of native api_error events that carried retry telemetry. */
  retryEvents: number;
  /** Sum of `retryInMs` across those events, in milliseconds. */
  totalBackoffMs: number;
  /** Highest `retryAttempt` seen (how deep into the backoff ladder we got). */
  maxAttempt: number;
  /** Configured `maxRetries` cap (max seen), or undefined if never present. */
  maxRetries?: number;
}

export function aggregateRetryPressure(
  events: ApiErrorEvent[]
): RetryPressureStat {
  let retryEvents = 0;
  let totalBackoffMs = 0;
  let maxAttempt = 0;
  let maxRetries: number | undefined;

  for (const e of events) {
    const hasAttempt = typeof e.retryAttempt === 'number';
    const hasBackoff = typeof e.retryInMs === 'number';
    if (!hasAttempt && !hasBackoff) continue;
    retryEvents += 1;
    if (hasBackoff) totalBackoffMs += e.retryInMs as number;
    if (hasAttempt) maxAttempt = Math.max(maxAttempt, e.retryAttempt as number);
    if (typeof e.maxRetries === 'number') {
      maxRetries = Math.max(maxRetries ?? 0, e.maxRetries);
    }
  }

  return { retryEvents, totalBackoffMs, maxAttempt, maxRetries };
}

/**
 * (#84) One command/tool that was retried immediately after erroring.
 */
export interface ErrorRetrySequenceStat {
  /** The retried command (Bash) or tool name (everything else). */
  label: string;
  toolName: string;
  /** How many times an error of this label was immediately retried same-tool. */
  count: number;
}

/**
 * (#84) Detect error→retry-after-failure sequences: a tool call with
 * `isError === true` directly followed (in timestamp order, within the same
 * session) by another call of the SAME tool. This is the "I got an error, let
 * me just run it again" reflex. For Bash we key on the (first line of the)
 * command so repeated identical commands roll up; for other tools we key on the
 * tool name. Distinct from `detectRetryGroups`, which counts runs of any
 * consecutive same-tool calls regardless of error status — here the trigger is
 * specifically an errored call followed by a same-tool retry.
 */
export function detectErrorRetrySequences(
  data: ToolUsageData[]
): ErrorRetrySequenceStat[] {
  const map = new Map<string, { toolName: string; count: number }>();

  for (const session of data) {
    const sorted = session.calls
      .map((call) => ({ call, t: Date.parse(call.timestamp) }))
      .filter((row) => !isNaN(row.t))
      .sort((a, b) => a.t - b.t);

    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i].call;
      const next = sorted[i + 1].call;
      if (cur.isError !== true) continue;
      if (next.toolName !== cur.toolName) continue;

      let label = cur.toolName;
      if (cur.toolName === 'Bash') {
        const cmd =
          typeof cur.input?.command === 'string' ? cur.input.command : '';
        const firstLine = cmd.trim().split('\n')[0].trim();
        if (firstLine.length > 0) label = firstLine;
      }

      const key = `${cur.toolName}\u0000${label}`;
      const entry = map.get(key) ?? { toolName: cur.toolName, count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
  }

  return Array.from(map.entries())
    .map(([key, { toolName, count }]) => ({
      label: key.slice(key.indexOf('\u0000') + 1),
      toolName,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}
