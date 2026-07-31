import type { Detector, RecommendationInput } from '../types';
import {
  IDLE_TURN_THRESHOLD_MS,
  type RuntimeEvents,
} from '../../parse-runtime-events';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import { short } from '../shared';

/**
 * speed.time-motion (#596, epic #606) attributes measured wall-clock into the
 * three buckets the transcript can support today:
 *
 *   - model-working turns: `turn_duration` under the 15 minute idle cutoff
 *   - idle/AFK: `turn_duration` at/above the cutoff plus `away_summary` markers
 *   - serial tool latency: adjacent timestamped Read/Grep/Glob/LS use->result
 *     pairs that look like independent file-discovery work issued one at a time
 *
 * It intentionally does NOT infer TTFT or split read runtime from AFK time. TTFT
 * is only available in sparse server debug logs, and transcript timestamps do
 * not prove whether a long read gap was tool runtime or the human stepped away.
 */

const MINUTE = 60 * 1000;
const MIN_MEANINGFUL_BUCKET_MS = 5 * MINUTE;
const MIN_SERIAL_PAIRS = 2;
const HEAVY_BUCKET_MS = 30 * MINUTE;
const HEAVY_SERIAL_MEDIAN_MS = 5 * MINUTE;

const INDEPENDENT_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

type BucketKey = 'model-working' | 'idle/AFK' | 'serial tools';

interface SessionBuckets {
  sessionId: string;
  activeTurnMs: number;
  modelWorkingMs: number;
  idleMs: number;
  idleTurns: number;
  awaySummaries: number;
  serialToolMs: number;
  serialPairs: number;
  serialDurations: number[];
  toolCounts: Map<string, number>;
}

interface WallClockAttribution {
  sessions: SessionBuckets[];
  modelWorkingMs: number;
  idleMs: number;
  idleTurns: number;
  awaySummaries: number;
  serialToolMs: number;
  /**
   * Serial-gap time that could NOT be attributed inside measured active runtime
   * (#3229) — gaps whose summed duration overran their session's active turns.
   * Kept as separate diagnostic evidence rather than folded into the attributed
   * `serialToolMs` bucket, so the three buckets always partition (never exceed)
   * the runtime the transcript actually measured.
   */
  unattributedSerialMs: number;
  serialPairs: number;
  serialMedianMs: number;
  serialTopTool: string | null;
  dominant: BucketKey;
}

function emptySession(sessionId: string): SessionBuckets {
  return {
    sessionId,
    activeTurnMs: 0,
    modelWorkingMs: 0,
    idleMs: 0,
    idleTurns: 0,
    awaySummaries: 0,
    serialToolMs: 0,
    serialPairs: 0,
    serialDurations: [],
    toolCounts: new Map(),
  };
}

function sessionFor(
  sessions: Map<string, SessionBuckets>,
  sessionId: string
): SessionBuckets {
  let s = sessions.get(sessionId);
  if (!s) {
    s = emptySession(sessionId);
    sessions.set(sessionId, s);
  }
  return s;
}

function timestampMs(entry: TimelineEntry): number | null {
  const t = Date.parse(entry.timestamp);
  return isFinite(t) ? t : null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / MINUTE;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = Math.floor(minutes / 60);
  const rem = Math.round(minutes % 60);
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function collectRuntimeBuckets(
  runtimeEvents: RuntimeEvents[] | undefined,
  sessions: Map<string, SessionBuckets>
): void {
  for (const runtime of runtimeEvents ?? []) {
    const bucket = sessionFor(sessions, runtime.sessionId);
    for (const turn of runtime.turns) {
      if (turn.durationMs <= 0) continue;
      if (turn.durationMs >= IDLE_TURN_THRESHOLD_MS) {
        bucket.idleMs += turn.durationMs;
        bucket.idleTurns += 1;
      } else {
        bucket.activeTurnMs += turn.durationMs;
      }
    }
    bucket.awaySummaries += runtime.awaySummaries.length;
  }
}

function collectTimelineBuckets(
  timelines: SessionTimeline[] | undefined,
  sessions: Map<string, SessionBuckets>
): void {
  for (const timeline of timelines ?? []) {
    const bucket = sessionFor(sessions, timeline.sessionId);
    const entries = timeline.entries;
    for (let i = 0; i < entries.length - 1; i += 1) {
      const use = entries[i];
      const result = entries[i + 1];
      if (use.kind !== 'tool_use' || result.kind !== 'tool_result') continue;
      const tool = use.toolName ?? 'unknown';
      if (!INDEPENDENT_READ_TOOLS.has(tool)) continue;

      const start = timestampMs(use);
      const end = timestampMs(result);
      if (start === null || end === null) continue;
      const duration = end - start;
      if (duration <= 0 || duration >= IDLE_TURN_THRESHOLD_MS) continue;

      bucket.serialToolMs += duration;
      bucket.serialPairs += 1;
      bucket.serialDurations.push(duration);
      bucket.toolCounts.set(tool, (bucket.toolCounts.get(tool) ?? 0) + 1);
    }
  }
}

function topTool(sessions: SessionBuckets[]): string | null {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    for (const [tool, count] of s.toolCounts) {
      counts.set(tool, (counts.get(tool) ?? 0) + count);
    }
  }
  let top: string | null = null;
  let topCount = 0;
  for (const [tool, count] of counts) {
    if (count > topCount) {
      top = tool;
      topCount = count;
    }
  }
  return top;
}

export function attributeWallClock(
  input: Pick<RecommendationInput, 'runtimeEvents' | 'timelines'>
): WallClockAttribution {
  const sessions = new Map<string, SessionBuckets>();
  collectRuntimeBuckets(input.runtimeEvents, sessions);
  collectTimelineBuckets(input.timelines, sessions);

  // Serial tool gaps are timestamped WITHIN a session's active turns, so they
  // are a SUBSET of active runtime, never additive to it. Summing independent
  // gaps once let `serialToolMs` exceed active runtime, so the three buckets
  // reported MORE wall-clock than the session actually ran (#3229). Cap the
  // attributed serial bucket at active runtime and carve model-working from the
  // remainder, so `modelWorkingMs + serialToolMs === activeTurnMs` (a
  // non-overlapping partition). Any overrun is retained only as diagnostic
  // `unattributedSerialMs`, never attributed — we do not claim those excess gaps
  // are independent serial waits without an independence signal.
  const rows = [...sessions.values()].map((s) => {
    const attributedSerialMs = Math.min(s.serialToolMs, s.activeTurnMs);
    return {
      ...s,
      serialToolMs: attributedSerialMs,
      unattributedSerialMs: s.serialToolMs - attributedSerialMs,
      modelWorkingMs: s.activeTurnMs - attributedSerialMs,
    };
  });

  const allSerialDurations = rows.flatMap((s) => s.serialDurations);
  const modelWorkingMs = rows.reduce((sum, s) => sum + s.modelWorkingMs, 0);
  const idleMs = rows.reduce((sum, s) => sum + s.idleMs, 0);
  const serialToolMs = rows.reduce((sum, s) => sum + s.serialToolMs, 0);
  const unattributedSerialMs = rows.reduce((sum, s) => sum + s.unattributedSerialMs, 0);

  const buckets: Array<{ key: BucketKey; ms: number }> = [
    { key: 'model-working', ms: modelWorkingMs },
    { key: 'idle/AFK', ms: idleMs },
    { key: 'serial tools', ms: serialToolMs },
  ];
  buckets.sort((a, b) => b.ms - a.ms);

  return {
    sessions: rows,
    modelWorkingMs,
    idleMs,
    idleTurns: rows.reduce((sum, s) => sum + s.idleTurns, 0),
    awaySummaries: rows.reduce((sum, s) => sum + s.awaySummaries, 0),
    serialToolMs,
    unattributedSerialMs,
    serialPairs: rows.reduce((sum, s) => sum + s.serialPairs, 0),
    serialMedianMs: median(allSerialDurations),
    serialTopTool: topTool(rows),
    dominant: buckets[0]?.key ?? 'model-working',
  };
}

function hasMeaningfulSignal(a: WallClockAttribution): boolean {
  if (a.idleMs >= IDLE_TURN_THRESHOLD_MS) return true;
  if (a.serialPairs >= MIN_SERIAL_PAIRS && a.serialToolMs >= MIN_MEANINGFUL_BUCKET_MS) {
    return true;
  }
  return a.modelWorkingMs >= HEAVY_BUCKET_MS;
}

function titleFor(dominant: BucketKey): string {
  if (dominant === 'serial tools') return 'Batch serial file reads that dominate wait time';
  if (dominant === 'idle/AFK') return 'Separate idle time from agent runtime';
  return 'Long model-working turns dominate wait time';
}

function actionFor(dominant: BucketKey): string {
  if (dominant === 'serial tools') {
    return 'Batch independent Read/Grep/Glob/LS discovery in one turn and ask for all likely files up front, so the agent does not wait on one file result before requesting the next.';
  }
  if (dominant === 'idle/AFK') {
    return 'Treat long idle turns as human-wait pauses: schedule explicit checkpoints or let unattended work run to completion, then review the output when you return.';
  }
  return 'Break long model-working turns into smaller scoped steps and trim context before the next run; this bucket excludes conservative serial read latency but still reflects work inside active turns.';
}

function evidenceRows(a: WallClockAttribution): string[] {
  return a.sessions
    .filter((s) => s.modelWorkingMs > 0 || s.idleMs > 0 || s.serialToolMs > 0)
    .sort((x, y) => {
      const tx = x.modelWorkingMs + x.idleMs + x.serialToolMs;
      const ty = y.modelWorkingMs + y.idleMs + y.serialToolMs;
      return ty - tx;
    })
    .slice(0, 5)
    .map((s) => {
      const parts = [
        `${fmtDuration(s.modelWorkingMs)} model-working`,
        `${fmtDuration(s.idleMs)} idle/AFK`,
        `${fmtDuration(s.serialToolMs)} serial tools`,
      ];
      return `${short(s.sessionId)}: ${parts.join(', ')}`;
    });
}

export const detector: Detector = {
  id: 'speed.time-motion',
  category: 'speed',
  dataDeps: ['runtimeEvents', 'timelines'],
  rule(input) {
    const attribution = attributeWallClock(input);
    if (!hasMeaningfulSignal(attribution)) return null;

    const severity =
      attribution.idleMs >= HEAVY_BUCKET_MS ||
      attribution.serialToolMs >= HEAVY_BUCKET_MS ||
      attribution.serialMedianMs >= HEAVY_SERIAL_MEDIAN_MS
        ? 'warning'
        : 'info';

    const serialTool =
      attribution.serialTopTool === null ? 'read-like tool' : attribution.serialTopTool;
    const totalMs =
      attribution.modelWorkingMs + attribution.idleMs + attribution.serialToolMs;
    // #3229: serial gap time that overran active runtime is diagnostic only —
    // called out separately so the attributed total never claims more
    // wall-clock than the transcript measured.
    const overrunNote =
      attribution.unattributedSerialMs > 0
        ? `A further ${fmtDuration(attribution.unattributedSerialMs)} of serial gap time overran the measured active runtime and is held as diagnostic evidence only, not attributed — those gaps overlap active turns, so they are not proven independent waits. `
        : '';

    return {
      id: 'speed.time-motion',
      category: 'speed',
      severity,
      title: titleFor(attribution.dominant),
      detail:
        `Attributed ${fmtDuration(totalMs)} of measured wall-clock: ` +
        `${fmtDuration(attribution.modelWorkingMs)} model-working turns, ` +
        `${fmtDuration(attribution.idleMs)} idle/AFK (` +
        `${attribution.idleTurns} idle turn(s), ${attribution.awaySummaries} away_summary marker(s)), and ` +
        `${fmtDuration(attribution.serialToolMs)} serial ${serialTool} latency (` +
        `${attribution.serialPairs} adjacent use->result gap(s), median ${fmtDuration(attribution.serialMedianMs)}). ` +
        overrunNote +
        `Dominant stall: ${attribution.dominant}. TTFT and read-time-vs-AFK are out of scope: ` +
        `transcripts do not expose TTFT, sparse server debug logs are the only TTFT source, ` +
        `and the ${fmtDuration(IDLE_TURN_THRESHOLD_MS)} idle split is a heuristic boundary.`,
      action: actionFor(attribution.dominant),
      affected: attribution.sessions.filter(
        (s) => s.modelWorkingMs > 0 || s.idleMs > 0 || s.serialToolMs > 0
      ).length,
      view: 'timeline',
      evidence: evidenceRows(attribution),
    };
  },
};
