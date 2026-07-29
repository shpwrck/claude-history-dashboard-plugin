/**
 * Native runtime-event parsing.
 *
 * Claude Code emits several first-class `type: "system"` telemetry lines into
 * the transcript that the rest of the dashboard ignores. This parser extracts
 * the four most useful subtypes so activity views can show *real* measured
 * per-turn latency, stop-hook overhead, and AFK / scheduled-wakeup activity
 * instead of inferring them:
 *
 *   - `turn_duration`      → { durationMs, messageCount }   (per-turn latency)
 *   - `stop_hook_summary`  → { hookCount, hookInfos[], hookErrors,
 *                              preventedContinuation }       (hook overhead)
 *   - `away_summary`       → { content }                     (AFK recap)
 *   - `scheduled_task_fire`→ { content }                     (scheduled wakeups)
 *
 * Confirmed against real transcripts under ~/.claude/projects (CC 2.1.x).
 *
 * Caveat on `stop_hook_summary.hookInfos[]` (measured over 279 live events):
 * each element carries a `command` string (always) and sometimes `promptText`,
 * but **no hook `name`/`id`** — the `command` is the only per-hook identity. Its
 * `durationMs` is best-effort: present on only ~7% of hookInfos (19/280), so
 * per-hook timing is sparse, not dense. `hookErrors` / `preventedContinuation`
 * are per-*event*, not attributable to an individual hook within a multi-hook
 * summary. See issue #261 / #134 before building per-hook latency on this.
 */

import { parseJsonl, summarize, type RawSessionEntry } from './parse-utils';
import type { SessionTokenData } from '../types';
import { entryCostAtModel } from './pricing';

export interface TurnDurationEvent {
  sessionId: string;
  timestamp: string;
  durationMs: number;
  messageCount: number;
}

export interface StopHookEvent {
  sessionId: string;
  timestamp: string;
  hookCount: number;
  /**
   * Sum of the per-hook `hookInfos[].durationMs` on this stop event. Note that
   * `durationMs` is present on only ~7% of hookInfos in practice, so this is a
   * best-effort lower bound — most stop events contribute 0 here even though
   * hooks ran. See the file header caveat and issue #261.
   */
  totalDurationMs: number;
  hadErrors: boolean;
  preventedContinuation: boolean;
}

export interface NarrativeEvent {
  sessionId: string;
  timestamp: string;
  content: string; // summarized recap / wakeup text
}

export interface RuntimeEvents {
  sessionId: string;
  turns: TurnDurationEvent[];
  stopHooks: StopHookEvent[];
  awaySummaries: NarrativeEvent[];
  scheduledFires: NarrativeEvent[];
}

type RuntimeSessionEntry = RawSessionEntry & {
  subtype?: string;
  durationMs?: unknown;
  messageCount?: unknown;
  content?: unknown;
  hookCount?: unknown;
  hookInfos?: unknown;
  hookErrors?: unknown;
  preventedContinuation?: unknown;
};

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function contentString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
            ? (b as { text: string }).text
            : ''
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/**
 * Parse the native runtime events from one session's (possibly subagent-merged)
 * transcript text. Returns `null` when the session has no such events, so the
 * ingest layer can skip empty payloads.
 */
export function parseRuntimeEvents(
  text: string,
  fileName: string
): RuntimeEvents | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  const out: RuntimeEvents = {
    sessionId,
    turns: [],
    stopHooks: [],
    awaySummaries: [],
    scheduledFires: [],
  };

  for (const entry of parseJsonl(text) as RuntimeSessionEntry[]) {
    if (entry.type !== 'system') continue;
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';

    switch (entry.subtype) {
      case 'turn_duration':
        out.turns.push({
          sessionId,
          timestamp,
          durationMs: num(entry.durationMs),
          messageCount: num(entry.messageCount),
        });
        break;
      case 'stop_hook_summary': {
        const infos = Array.isArray(entry.hookInfos) ? entry.hookInfos : [];
        let totalDurationMs = 0;
        for (const info of infos) {
          if (info && typeof info === 'object') {
            totalDurationMs += num((info as { durationMs?: unknown }).durationMs);
          }
        }
        const errs = Array.isArray(entry.hookErrors) ? entry.hookErrors : [];
        out.stopHooks.push({
          sessionId,
          timestamp,
          hookCount: num(entry.hookCount),
          totalDurationMs,
          hadErrors: errs.length > 0,
          preventedContinuation: entry.preventedContinuation === true,
        });
        break;
      }
      case 'away_summary': {
        const c = summarize(contentString(entry.content), 500);
        if (c) out.awaySummaries.push({ sessionId, timestamp, content: c });
        break;
      }
      case 'scheduled_task_fire': {
        const c = summarize(contentString(entry.content), 500);
        if (c) out.scheduledFires.push({ sessionId, timestamp, content: c });
        break;
      }
      default:
        break;
    }
  }

  if (
    out.turns.length === 0 &&
    out.stopHooks.length === 0 &&
    out.awaySummaries.length === 0 &&
    out.scheduledFires.length === 0
  ) {
    return null;
  }
  return out;
}

export interface TurnLatencyStats {
  count: number;
  totalDurationMs: number;
  meanDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
}

/**
 * A `turn_duration` is wall-clock from the user's message to the assistant's
 * reply, so a turn spent waiting on a human (AFK between messages, a scheduled
 * wakeup, a pause mid-session) folds idle time into "latency" and badly skews
 * p95/max — e.g. a single 248-minute idle turn dominates an otherwise
 * sub-minute distribution (#74). We partition turns at this cutoff: turns at or
 * above it are treated as idle/AFK and reported separately, so the headline
 * latency reflects turns where Claude was actually working. A contiguous active
 * model turn essentially never runs this long, so the cutoff cleanly isolates
 * human-wait turns without clipping genuinely long working turns.
 */
export const IDLE_TURN_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export interface TurnLatencyReport {
  /** Latency over active (non-idle) turns — the headline numbers. */
  active: TurnLatencyStats;
  /** Turns flagged as idle/AFK (duration ≥ {@link IDLE_TURN_THRESHOLD_MS}). */
  idle: TurnLatencyStats;
  /** Cutoff used to split active vs idle, exposed for the UI caption. */
  idleThresholdMs: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function statsFor(durations: number[]): TurnLatencyStats {
  const sorted = durations.slice().sort((a, b) => a - b);
  const count = sorted.length;
  let total = 0;
  for (const d of sorted) total += d;
  return {
    count,
    totalDurationMs: total,
    meanDurationMs: count === 0 ? 0 : total / count,
    p50DurationMs: quantile(sorted, 0.5),
    p95DurationMs: quantile(sorted, 0.95),
    maxDurationMs: count === 0 ? 0 : sorted[count - 1],
  };
}

/**
 * Aggregate per-turn latency across all sessions' turn_duration events,
 * partitioned into active vs idle/AFK turns at {@link IDLE_TURN_THRESHOLD_MS}
 * so idle wall-clock time does not pollute the latency percentiles (#74).
 */
export function aggregateTurnLatency(
  data: RuntimeEvents[],
  idleThresholdMs: number = IDLE_TURN_THRESHOLD_MS
): TurnLatencyReport {
  const activeDurations: number[] = [];
  const idleDurations: number[] = [];
  for (const s of data) {
    for (const t of s.turns) {
      if (t.durationMs >= idleThresholdMs) idleDurations.push(t.durationMs);
      else activeDurations.push(t.durationMs);
    }
  }
  return {
    active: statsFor(activeDurations),
    idle: statsFor(idleDurations),
    idleThresholdMs,
  };
}

export function sessionWithActiveTurn(
  data: RuntimeEvents[],
  idleThresholdMs: number = IDLE_TURN_THRESHOLD_MS
): string | undefined {
  for (const s of data) {
    for (const t of s.turns) {
      if (t.durationMs < idleThresholdMs) {
        return t.sessionId || s.sessionId;
      }
    }
  }
  return undefined;
}

export function sessionWithStopHook(
  data: RuntimeEvents[],
  timedOnly = false
): string | undefined {
  for (const s of data) {
    for (const h of s.stopHooks) {
      if (!timedOnly || h.totalDurationMs > 0) {
        return h.sessionId || s.sessionId;
      }
    }
  }
  return undefined;
}

export interface StopHookStats {
  events: number;
  /** Sum of every stop event's `hookCount` — total stop-hook fires across the dataset. */
  hookCount: number;
  totalDurationMs: number;
  meanDurationMs: number;
  maxDurationMs: number;
  /**
   * Stop events that carry a measured overhead (`totalDurationMs > 0`). Because
   * per-hook `durationMs` is present on only ~7% of hookInfos, most events
   * contribute 0 even though hooks ran, so `meanDurationMs` (over ALL events) is
   * diluted. This is the denominator for the honest "when timed, how long?" mean.
   */
  timedEvents: number;
  /**
   * Mean overhead over the {@link timedEvents} subset only —
   * `totalDurationMs / timedEvents`. This is the per-turn wall-clock hooks add
   * *when their duration was actually measured*, not diluted by the ~93% of
   * events with no `durationMs`. `0` when no event carried a measured duration.
   */
  meanTimedDurationMs: number;
  errorEvents: number;
  preventedContinuations: number;
}

/**
 * Aggregate stop-hook overhead across all sessions' stop_hook_summary events.
 *
 * `totalDurationMs`/`meanDurationMs`/`maxDurationMs` are computed from
 * `hookInfos[].durationMs`, which is present on only a minority (~7%) of hook
 * fires — so they describe the timed subset, not every fire. There is no hook
 * `name` in the raw data (identity would be the `command` string), so this
 * returns a single rolled-up block rather than a per-hook breakdown; see #261.
 *
 * `meanTimedDurationMs` divides only by {@link StopHookStats.timedEvents} (the
 * events that actually carried a measured `durationMs`), giving the honest
 * per-turn overhead that the `speed.hook-overhead` detector (#710) thresholds
 * on — `meanDurationMs` is diluted toward 0 by the untimed majority.
 */
export function aggregateStopHooks(data: RuntimeEvents[]): StopHookStats {
  let events = 0;
  let hookCount = 0;
  let total = 0;
  let max = 0;
  let timedEvents = 0;
  let errorEvents = 0;
  let prevented = 0;
  for (const s of data) {
    for (const h of s.stopHooks) {
      events += 1;
      hookCount += h.hookCount;
      total += h.totalDurationMs;
      if (h.totalDurationMs > 0) timedEvents += 1;
      if (h.totalDurationMs > max) max = h.totalDurationMs;
      if (h.hadErrors) errorEvents += 1;
      if (h.preventedContinuation) prevented += 1;
    }
  }
  return {
    events,
    hookCount,
    totalDurationMs: total,
    meanDurationMs: events === 0 ? 0 : total / events,
    maxDurationMs: max,
    timedEvents,
    meanTimedDurationMs: timedEvents === 0 ? 0 : total / timedEvents,
    errorEvents,
    preventedContinuations: prevented,
  };
}

export interface PerTaskCostStats {
  /**
   * Number of task spans across the dataset — one per StopHook boundary plus
   * one trailing (in-progress) span per session with entries after its last
   * stop. The denominator for the cost percentiles.
   */
  taskCount: number;
  totalCost: number;
  meanCost: number;
  medianCost: number;
  p95Cost: number;
  /** Sessions that contributed at least one task span. */
  sessions: number;
}

/**
 * Optional deterministic operation counter for the per-task attribution path.
 * Production callers omit it; performance-contract tests use it to distinguish
 * logarithmic stop lookup from a restarted linear scan without timing noise.
 */
export interface PerTaskCostProbe {
  stopComparisons: number;
}

function firstStopAtOrAfter(
  stops: readonly number[],
  timestamp: number,
  probe?: PerTaskCostProbe
): number {
  let low = 0;
  let high = stops.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (probe) probe.stopComparisons += 1;
    if (stops[middle] < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Per-task cost, where a "task" is the work between two consecutive
 * {@link StopHookEvent}s in a session. The Stop hook fires when the assistant
 * finishes responding, so it cleanly bounds one unit of agent work. Each
 * session's token entries are partitioned into task spans by stop-event
 * timestamp (an entry belongs to the first task whose stop is at or after the
 * entry's timestamp); entries after the last stop form a trailing in-progress
 * span. Each span's cost is summed via {@link entryCostAtModel} at the entry's
 * own model — the same pricing table `estimateCost` uses, minus server-tool
 * (web search/fetch) charges, which don't attribute to a stop boundary.
 *
 * Median/p95 are taken across every task span so a single runaway turn doesn't
 * dominate the headline the way a mean would. Sessions with no stop hooks are
 * skipped — there's no task boundary to attribute against.
 */
export function aggregatePerTaskCost(
  runtime: RuntimeEvents[],
  tokenData: SessionTokenData[],
  probe?: PerTaskCostProbe
): PerTaskCostStats {
  const stopsBySession = new Map<string, number[]>();
  for (const s of runtime) {
    if (s.stopHooks.length === 0) continue;
    const ts = s.stopHooks
      .map((h) => Date.parse(h.timestamp))
      .filter((n) => isFinite(n))
      .sort((a, b) => a - b);
    if (ts.length > 0) stopsBySession.set(s.sessionId, ts);
  }

  const taskCosts: number[] = [];
  let sessions = 0;
  for (const td of tokenData) {
    const stops = stopsBySession.get(td.sessionId);
    if (!stops || td.entries.length === 0) continue;
    // Task-span index per entry: 0..stops.length, where stops.length is the
    // trailing span for entries after the final stop.
    const buckets = new Map<number, number>();
    for (const entry of td.entries) {
      const t = Date.parse(entry.timestamp);
      if (!isFinite(t)) continue; // undatable entry can't be placed in a span
      const cost = entryCostAtModel(entry, entry.model);
      const idx = firstStopAtOrAfter(stops, t, probe);
      buckets.set(idx, (buckets.get(idx) ?? 0) + cost);
    }
    if (buckets.size === 0) continue;
    sessions += 1;
    for (const c of buckets.values()) taskCosts.push(c);
  }

  const sorted = taskCosts.slice().sort((a, b) => a - b);
  const count = sorted.length;
  let total = 0;
  for (const c of sorted) total += c;
  return {
    taskCount: count,
    totalCost: total,
    meanCost: count === 0 ? 0 : total / count,
    medianCost: quantile(sorted, 0.5),
    p95Cost: quantile(sorted, 0.95),
    sessions,
  };
}

/** Flatten away-summaries and scheduled-fires into one time-sorted feed. */
export interface AutomationEvent extends NarrativeEvent {
  kind: 'away' | 'scheduled';
}

export function collectAutomationFeed(
  data: RuntimeEvents[]
): AutomationEvent[] {
  const feed: AutomationEvent[] = [];
  for (const s of data) {
    for (const a of s.awaySummaries) feed.push({ ...a, kind: 'away' });
    for (const f of s.scheduledFires) feed.push({ ...f, kind: 'scheduled' });
  }
  return feed.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    return a.timestamp < b.timestamp ? 1 : -1;
  });
}
