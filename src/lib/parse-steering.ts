import type { HistoryEntry, SessionTokenData } from '../types';
import { deriveEntriesFromTranscript, groupBySessions } from './parse-history';
import type { RuntimeEvents } from './parse-runtime-events';
import { entryCostAtModel } from './pricing';

export type SteeringTurnKind =
  | 'corrective'
  | 'clarifying-answer'
  | 'approving'
  | 'other';

export interface TaskSteering {
  sessionId: string;
  project?: string;
  taskIndex: number;
  startTime: string;
  endTime: string;
  wallClockMs: number;
  costUsd: number;
  humanTurns: number;
  corrective: number;
  clarifyingAnswer: number;
  approving: number;
  other: number;
  interruptions: number;
}

export interface TaskSteeringInput {
  entries: HistoryEntry[];
  runtimeEvents?: RuntimeEvents[] | null;
  tokenData?: SessionTokenData[] | null;
}

export interface TranscriptTaskSteeringOptions {
  fallbackProject?: string;
  title?: string | null;
  runtimeEvents?: RuntimeEvents | null;
  tokenData?: SessionTokenData | null;
}

interface StopBoundary {
  ms: number;
  timestamp: string;
  preventedContinuation: boolean;
}

interface SpanDraft {
  sessionId: string;
  project?: string;
  taskIndex: number;
  startMs: number | null;
  endMs: number | null;
  costUsd: number;
  humanTurns: number;
  corrective: number;
  clarifyingAnswer: number;
  approving: number;
  other: number;
  interruptions: number;
}

const SYNTHETIC_BLOCK_RE =
  /<\s*(task-notification|system-reminder)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SYNTHETIC_LINE_RE =
  /^\s*<\s*(task-notification|system-reminder)\b[^>]*>[\s\S]*$/i;

const SATISFIED_STOP_RE =
  /^(no\s+thanks|happy\s+to\s+stop|stop\s+here|we\s+can\s+stop\s+here)\b/i;
const CORRECTIVE_START_RE =
  /^(no[,!:.\s]+(revert|undo|change|not|that'?s wrong|you)|actually\b|wait\b|hold on\b|stop\b(?!\s+(here|there)$)|revert\b|undo\b|don'?t\b|do not\b|not that\b|wrong\b|that'?s wrong\b|you misunderstood\b|instead\b)/i;
const CLARIFYING_START_RE =
  /^(yes\b|yeah\b|yep\b|nope\b|it is\b|it'?s\b|that is\b|the answer\b|use\b|choose\b|option\b|because\b|for\b|in\b|under\b)/i;
const APPROVING_START_RE =
  /^(ok\b|okay\b|looks good\b|lgtm\b|thanks\b|thank you\b|ship it\b|go ahead\b|continue\b|proceed\b|approved\b|yes[,.\s]+(that|looks|works|please))/i;

function stripSyntheticTurn(text: string): string {
  return text
    .replace(SYNTHETIC_BLOCK_RE, ' ')
    .split('\n')
    .filter((line) => !SYNTHETIC_LINE_RE.test(line))
    .join('\n')
    .trim();
}

export function classifySteeringTurn(text: string): SteeringTurnKind | null {
  const cleaned = stripSyntheticTurn(text);
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (SATISFIED_STOP_RE.test(normalized)) return 'approving';
  if (CORRECTIVE_START_RE.test(normalized)) return 'corrective';
  if (APPROVING_START_RE.test(normalized)) return 'approving';
  if (CLARIFYING_START_RE.test(normalized)) return 'clarifying-answer';
  return 'other';
}

function finiteMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number | null): string {
  return ms == null || !Number.isFinite(ms) ? '' : new Date(ms).toISOString();
}

function stopBoundaries(runtime: RuntimeEvents | undefined): StopBoundary[] {
  return (runtime?.stopHooks ?? [])
    .map((stop) => {
      const ms = finiteMs(stop.timestamp);
      return ms == null
        ? null
        : {
            ms,
            timestamp: stop.timestamp,
            preventedContinuation: stop.preventedContinuation,
          };
    })
    .filter((stop): stop is StopBoundary => stop != null)
    .sort((a, b) => a.ms - b.ms);
}

function bucketIndex(ms: number, stops: StopBoundary[]): number {
  const idx = stops.findIndex((stop) => stop.ms >= ms);
  return idx === -1 ? stops.length : idx;
}

function touch(span: SpanDraft, ms: number): void {
  if (!Number.isFinite(ms)) return;
  span.startMs = span.startMs == null ? ms : Math.min(span.startMs, ms);
  span.endMs = span.endMs == null ? ms : Math.max(span.endMs, ms);
}

function finalize(span: SpanDraft): TaskSteering {
  const startMs = span.startMs;
  const endMs = span.endMs;
  return {
    sessionId: span.sessionId,
    ...(span.project ? { project: span.project } : {}),
    taskIndex: span.taskIndex,
    startTime: iso(startMs),
    endTime: iso(endMs),
    wallClockMs:
      startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : 0,
    costUsd: span.costUsd,
    humanTurns: span.humanTurns,
    corrective: span.corrective,
    clarifyingAnswer: span.clarifyingAnswer,
    approving: span.approving,
    other: span.other,
    interruptions: span.interruptions,
  };
}

export function computeTaskSteering(input: TaskSteeringInput): TaskSteering[] {
  const sessions = groupBySessions(input.entries);
  const entriesBySession = new Map(sessions.map((session) => [session.sessionId, session]));
  const runtimeBySession = new Map(
    (input.runtimeEvents ?? []).map((runtime) => [runtime.sessionId, runtime])
  );
  const tokenBySession = new Map(
    (input.tokenData ?? []).map((token) => [token.sessionId, token])
  );
  const sessionIds = new Set<string>([
    ...entriesBySession.keys(),
    ...runtimeBySession.keys(),
    ...tokenBySession.keys(),
  ]);
  const out: TaskSteering[] = [];

  for (const sessionId of sessionIds) {
    const session = entriesBySession.get(sessionId);
    const runtime = runtimeBySession.get(sessionId);
    const token = tokenBySession.get(sessionId);
    const stops = stopBoundaries(runtime);
    const project = session?.project || token?.project;
    const spans = new Map<number, SpanDraft>();
    const getSpan = (taskIndex: number): SpanDraft => {
      const existing = spans.get(taskIndex);
      if (existing) return existing;
      const created: SpanDraft = {
        sessionId,
        ...(project ? { project } : {}),
        taskIndex,
        startMs: null,
        endMs: null,
        costUsd: 0,
        humanTurns: 0,
        corrective: 0,
        clarifyingAnswer: 0,
        approving: 0,
        other: 0,
        interruptions: 0,
      };
      spans.set(taskIndex, created);
      return created;
    };

    for (const entry of session?.entries ?? []) {
      const kind = classifySteeringTurn(entry.display);
      if (!kind) continue;
      const ms = entry.timestamp;
      if (!Number.isFinite(ms)) continue;
      const span = getSpan(bucketIndex(ms, stops));
      touch(span, ms);
      span.humanTurns += 1;
      span[kind === 'clarifying-answer' ? 'clarifyingAnswer' : kind] += 1;
    }

    for (const entry of token?.entries ?? []) {
      const ms = finiteMs(entry.timestamp);
      if (ms == null) continue;
      const span = getSpan(bucketIndex(ms, stops));
      touch(span, ms);
      span.costUsd += entryCostAtModel(entry, entry.model);
    }

    stops.forEach((stop, idx) => {
      const span = getSpan(idx);
      touch(span, stop.ms);
      if (stop.preventedContinuation) span.interruptions += 1;
    });

    out.push(
      ...[...spans.values()]
        .filter(
          (span) =>
            span.humanTurns > 0 || span.costUsd > 0 || span.interruptions > 0
        )
        .map(finalize)
    );
  }

  return out.sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return a.taskIndex - b.taskIndex;
  });
}

export function extractTaskSteeringFromTranscript(
  text: string,
  fileName: string,
  options: TranscriptTaskSteeringOptions = {}
): TaskSteering[] {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const entries = deriveEntriesFromTranscript(
    text,
    sessionId,
    options.fallbackProject,
    options.title
  );
  return computeTaskSteering({
    entries,
    runtimeEvents: options.runtimeEvents ? [options.runtimeEvents] : [],
    tokenData: options.tokenData ? [options.tokenData] : [],
  });
}
