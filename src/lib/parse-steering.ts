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
  /**
   * Steering-divergence rate for the span: corrective human turns over total
   * real human turns (#1751). 0 when there were no human turns. This is the
   * per-task corrective-rate signal the autonomy axis (#1266) was missing — the
   * structural-anchor corrective classifier (see {@link isStructuralCorrective})
   * drives the numerator, so the rate measures how often the human had to point
   * back at the agent's last action and redirect it.
   */
  divergenceRate: number;
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

// ── Structural anchor (#1751) ────────────────────────────────────────────────
// A corrective user turn references the *immediately-prior assistant action* and
// redirects it, rather than introducing fresh, additive scope. Detectors only
// ever see the ~200-char timeline summary plus turn position, so the anchor is
// computed purely from the turn text + its position in the span. The anchor is
// the PRIMARY feature; the existing lexicon (CORRECTIVE_START_RE) is SECONDARY,
// used to confirm negative/redirection valence.

// Back-reference to what the agent just did: deictic / second-person markers
// ("that", "it", "your change", "you just …", "the X you …"). These only make
// sense as a reaction to a preceding assistant action.
const BACKREF_RE =
  /\b(that|this|it|those|these|you|your|you'?re|you'?ve|the (?:one|change|edit|code|file|version|approach|fix|part|line|function|test) (?:you|that)|what you (?:did|wrote|changed|added))\b/i;

// Turn-initial reaction tokens — the user is reacting to the last action, not
// opening a fresh task. A turn that *starts* this way is anchored to the prior
// step even before we look at valence.
const REACTION_OPENER_RE =
  /^(no\b|nope\b|not\b|wait\b|hold on\b|actually\b|stop\b|revert\b|undo\b|wrong\b|that'?s\b|that\b|this\b|it\b|you\b|why\b|instead\b|don'?t\b|do not\b|change\b|remove\b|delete\b|put\b back|undo)/i;

// Fresh-task markers — an additive instruction that introduces new scope rather
// than reacting. Presence (turn-initial) means the turn is NOT a back-reference.
const ADDITIVE_OPENER_RE =
  /^(now\b|next\b|also\b|then\b|after that\b|let'?s\b|please (?:add|create|write|implement|build|make|set up|add)|add\b|create\b|write\b|implement\b|build\b|make\b|set up\b|can you (?:also )?(?:add|create|write|implement|build|make)|could you (?:also )?(?:add|create|write|implement))/i;

// A short reactive turn is far more likely a correction than a long fresh spec.
const SHORT_TURN_CHARS = 200;

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

/**
 * 2-way structural-anchor corrective classifier (#1751).
 *
 * PRIMARY feature — the structural anchor: a user turn is corrective when it
 * *references the immediately-prior assistant action* and redirects it, instead
 * of introducing fresh, additive scope. We approximate "references the prior
 * action" from the summary + turn position, since detectors never see raw JSONL:
 *
 *  - `isFirstInSpan` — the very first turn of a span has no prior assistant
 *    action to reference, so it can never be a *back*-reference correction; it is
 *    the task kickoff. This makes turn position load-bearing, as the spec
 *    requires.
 *  - A turn-initial reaction opener OR a deictic/second-person back-reference
 *    ("no, …", "that's wrong", "you changed the wrong file", "revert it") anchors
 *    the turn to the last step.
 *  - A turn-initial additive opener ("now add …", "next, create …", "also write
 *    …") is a fresh instruction, not a correction — it disqualifies the turn even
 *    if a stray lexicon word appears later.
 *  - Long turns are treated as fresh specs, not reactions, unless they carry an
 *    explicit corrective opener.
 *
 * SECONDARY feature — the existing lexicon (`CORRECTIVE_START_RE`) confirms the
 * negative / redirection valence so a neutral back-reference ("yes, that one")
 * does not count as corrective.
 */
export function isStructuralCorrective(
  text: string,
  isFirstInSpan: boolean
): boolean {
  // No prior assistant action to point back at.
  if (isFirstInSpan) return false;

  const cleaned = stripSyntheticTurn(text);
  if (!cleaned) return false;
  const normalized = cleaned.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // An additive kickoff for new scope is never a correction, regardless of any
  // incidental lexicon hit further in.
  if (ADDITIVE_OPENER_RE.test(normalized) && !CORRECTIVE_START_RE.test(normalized)) {
    return false;
  }

  // PRIMARY: does the turn structurally anchor to the prior action?
  const reactionOpener = REACTION_OPENER_RE.test(normalized);
  const backRef = BACKREF_RE.test(normalized);
  const isShort = normalized.length <= SHORT_TURN_CHARS;
  // A short turn that opens as a reaction, or any turn that explicitly points
  // back at the agent's work, is anchored.
  const anchored = (reactionOpener && isShort) || (backRef && reactionOpener);

  // SECONDARY: redirection valence from the existing lexicon.
  const correctiveValence = CORRECTIVE_START_RE.test(normalized);

  // An explicit corrective opener is anchored + valenced on its own (matches the
  // existing lexicon contract). Otherwise require the structural anchor AND a
  // back-reference target so a polite redirect ("actually, let's keep it") still
  // counts while a fresh additive turn does not.
  if (correctiveValence) return true;
  return anchored && backRef;
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
    divergenceRate:
      span.humanTurns > 0
        ? Number((span.corrective / span.humanTurns).toFixed(3))
        : 0,
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

    const orderedTurns = (session?.entries ?? [])
      .filter((entry) => Number.isFinite(entry.timestamp))
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);
    let seenHumanTurns = 0;
    for (const entry of orderedTurns) {
      const kind = classifySteeringTurn(entry.display);
      if (!kind) continue;
      const ms = entry.timestamp;
      const taskIndex = bucketIndex(ms, stops);
      const span = getSpan(taskIndex);
      touch(span, ms);
      span.humanTurns += 1;
      // Turn position is session-global: only the very first real human turn of
      // the session is the genuine kickoff with no prior assistant action to
      // reference. A turn that opens a *later* span still follows the agent's
      // work in the previous span(s), so it can be a back-reference correction.
      const isFirstInSpan = seenHumanTurns === 0;
      seenHumanTurns += 1;
      // Structural-anchor corrective decision (#1751) is PRIMARY: it overrides
      // the lexicon-only `classifySteeringTurn` verdict for the `corrective`
      // count. Non-corrective kinds keep their lexicon bucket so
      // clarifying/approving/other totals are unchanged.
      if (isStructuralCorrective(entry.display, isFirstInSpan)) {
        span.corrective += 1;
      } else if (kind !== 'corrective') {
        span[kind === 'clarifying-answer' ? 'clarifyingAnswer' : kind] += 1;
      } else {
        // Lexicon flagged corrective but the structural anchor rejected it
        // (e.g. a fresh additive turn that happens to contain "wrong"); fold it
        // into `other` so it does not inflate the corrective rate.
        span.other += 1;
      }
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
