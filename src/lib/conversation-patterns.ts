import type { SessionTimeline } from './parse-timeline';

export interface ConversationStat {
  sessionId: string;
  userTurns: number;
  avgUserLen: number;
  codeBlockMessages: number;
  questionMessages: number;
  thinkingRatio: number; // 0..1
  entryCount: number; // total entries (denominator for thinkingRatio)
  velocity: number; // entries / hour, 0 if duration < 1 minute
  durationMs: number; // session duration in ms (denominator for velocity)
}

export interface LatencyBucket {
  label: string;
  count: number;
}

// Bucket boundaries (in seconds) for assistant-response latency. The bands
// reflect typical user expectations: sub-second feels instant, single-digit
// seconds is normal tool-free chat, 10s-30s is light tool use, 30s-2m is
// heavier tool/thinking work, 2m+ is long-running thinking or stuck calls.
const BUCKET_DEFS: { label: string; max: number }[] = [
  { label: '0-1s', max: 1 },
  { label: '1-3s', max: 3 },
  { label: '3-10s', max: 10 },
  { label: '10-30s', max: 30 },
  { label: '30s-2m', max: 120 },
  { label: '2m+', max: Infinity },
];

function parseMs(iso: string): number | null {
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Pair pending user turns with the next assistant entry and return each
 * non-negative response latency in milliseconds. Histogram sources and
 * latency-band destinations share this helper so a routed bucket reproduces
 * the same evidence instead of approximating it with total session duration.
 */
export function responseLatenciesMs(timeline: SessionTimeline): number[] {
  if (timeline.entries.length < 2) return [];
  const latencies: number[] = [];
  let pendingUserMs: number[] = [];
  for (const entry of timeline.entries) {
    if (entry.kind === 'user') {
      const ms = parseMs(entry.timestamp);
      if (ms != null) pendingUserMs.push(ms);
    } else if (entry.kind === 'assistant' && pendingUserMs.length > 0) {
      const ms = parseMs(entry.timestamp);
      if (ms != null) {
        for (const userMs of pendingUserMs) {
          const deltaMs = ms - userMs;
          if (deltaMs >= 0) latencies.push(deltaMs);
        }
      }
      pendingUserMs = [];
    }
  }
  return latencies;
}

function isQuestion(s: string): boolean {
  return s.trimEnd().endsWith('?');
}

function containsCodeBlock(s: string): boolean {
  return s.includes('```');
}

function computeSessionStat(timeline: SessionTimeline): ConversationStat | null {
  const { sessionId, entries, startTime, endTime } = timeline;
  if (entries.length === 0) return null;

  let userTurns = 0;
  let userLenSum = 0;
  let codeBlockMessages = 0;
  let questionMessages = 0;
  let thinkingCount = 0;

  for (const e of entries) {
    if (e.kind === 'user') {
      userTurns++;
      const s = e.summary ?? '';
      userLenSum += e.summaryLen ?? s.length;
      if (e.hasCode ?? containsCodeBlock(s)) codeBlockMessages++;
      if (e.isQuestion ?? isQuestion(s)) questionMessages++;
    } else if (e.kind === 'thinking') {
      thinkingCount++;
    }
  }

  const avgUserLen = userTurns > 0 ? userLenSum / userTurns : 0;
  const thinkingRatio = entries.length > 0 ? thinkingCount / entries.length : 0;

  const startMs = parseMs(startTime);
  const endMs = parseMs(endTime);
  let velocity = 0;
  let durationMs = 0;
  if (startMs != null && endMs != null) {
    durationMs = endMs - startMs;
    if (durationMs >= 60_000) {
      velocity = entries.length / (durationMs / 3_600_000);
    }
  }

  return {
    sessionId,
    userTurns,
    avgUserLen,
    codeBlockMessages,
    questionMessages,
    thinkingRatio,
    entryCount: entries.length,
    velocity,
    durationMs,
  };
}

export function aggregateConversations(
  timelines: SessionTimeline[]
): ConversationStat[] {
  const stats: ConversationStat[] = [];
  for (const t of timelines) {
    const s = computeSessionStat(t);
    if (s) stats.push(s);
  }
  stats.sort((a, b) => b.userTurns - a.userTurns);
  return stats;
}

function bucketIndexFor(seconds: number): number {
  for (let i = 0; i < BUCKET_DEFS.length; i++) {
    if (seconds <= BUCKET_DEFS[i].max) return i;
  }
  return BUCKET_DEFS.length - 1;
}

export function latencyHistogram(
  timelines: SessionTimeline[]
): LatencyBucket[] {
  const counts = BUCKET_DEFS.map(() => 0);

  for (const t of timelines) {
    for (const latencyMs of responseLatenciesMs(t)) {
      counts[bucketIndexFor(latencyMs / 1000)]++;
    }
  }

  return BUCKET_DEFS.map((b, i) => ({ label: b.label, count: counts[i] }));
}
