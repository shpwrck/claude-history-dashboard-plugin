import type { HistoryEntry } from '../types';
import {
  deriveEntriesFromTranscript,
  groupBySessions,
  realHumanTurns,
} from './parse-history';
import { parseRuntimeEvents, type RuntimeEvents } from './parse-runtime-events';
import { parseJsonl, parseMessage, type ContentBlock } from './parse-utils';

export type HumanTaskVerdict = 'accept' | 'correct' | 'neutral' | 'none';
export type AgentClosingClaim = 'completed' | 'blocked' | 'none';
export type TaskSuccessConfidence = 'high' | 'med' | 'low' | 'unknown';

export interface TaskSuccessRecurrenceProof {
  sessionId: string;
  timestamp: string;
  display: string;
  topic: string;
}

export interface TaskSuccessRecurrence {
  kind: 'demoted' | 'corroborated';
  topic: string;
  proof?: TaskSuccessRecurrenceProof;
  /**
   * ISO timestamp of the LAST human turn in the supplied history — the boundary
   * beyond which we observed nothing (#3155).
   *
   * A `corroborated` recurrence rests on the ABSENCE of a later matching topic,
   * and an absence is only meaningful up to the point we stopped looking. This
   * dates the claim: the user did not return about this topic *as of* here.
   * Present on corroborated records so the claim can never be read as
   * open-ended.
   */
  observedUntil?: string;
}

export interface TaskSuccessProxy {
  sessionId: string;
  project?: string;
  taskIndex: number;
  startTime: string;
  endTime: string;
  wallClockMs: number;
  verdict: HumanTaskVerdict;
  agentClaim: AgentClosingClaim;
  confidence: TaskSuccessConfidence;
  successScore: number;
  backedByMutation: boolean;
  mutatingToolCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  toolErrorRate: number;
  verdictScore?: number;
  claimScore?: number;
  errorPenalty: number;
  recurrenceTopics?: string[];
  recurrence?: TaskSuccessRecurrence;
}

export interface TaskSuccessTranscriptEvent {
  sessionId: string;
  timestamp: string;
  kind: 'assistant_text' | 'tool_use' | 'tool_result';
  text?: string;
  topicText?: string;
  toolName?: string;
  isError?: boolean;
  isMutating?: boolean;
}

export interface TaskSuccessInput {
  entries: HistoryEntry[];
  runtimeEvents?: RuntimeEvents[] | null;
  transcriptEvents?: TaskSuccessTranscriptEvent[] | null;
}

export interface ParseTaskSuccessOptions {
  topText?: string;
  fallbackProject?: string | null;
  title?: string | null;
}

interface StopBoundary {
  ms: number;
  timestamp: string;
}

interface SpanDraft {
  sessionId: string;
  project?: string;
  taskIndex: number;
  startMs: number | null;
  endMs: number;
  verdict: HumanTaskVerdict;
  agentClaim: AgentClosingClaim;
  mutatingToolCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  topics: Set<string>;
}

const SYNTHETIC_BLOCK_RE =
  /<\s*(task-notification|system-reminder)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SYNTHETIC_LINE_RE =
  /^\s*<\s*(task-notification|system-reminder)\b[^>]*>[\s\S]*$/i;

const ACCEPT_RE =
  /^(thanks?(?:[,!\s]|$)|thank you\b|looks good\b|lgtm\b|ship it\b|merge it\b|yes[,!\s]+(?:that|this|please|merge)|works\b|perfect\b|great\b|nice\b|approved\b|all good\b|done\b)/i;
const CORRECT_RE =
  /^(no[,!:.\s]+(?:that|this|revert|undo|wrong|broken|not)|actually\b|wait\b|hold on\b|stop\b(?!\s+(here|there)$)|revert\b|undo\b|don'?t\b|do not\b|not that\b|wrong\b|that'?s wrong\b|broken\b|failed\b|you misunderstood\b|instead\b)/i;
const FOLLOWUP_CORRECT_RE =
  /\b(?:still\s+(?:broken|failing|fails?|wrong|not working)|not\s+(?:fixed|working)|doesn'?t\s+work|failed again)\b/i;
const BLOCKED_CLAIM_RE =
  /\b(?:blocked|stuck|cannot proceed|can(?:'|\u2019)?t proceed|unable to proceed|need (?:your|a|the) .{0,40}(?:input|answer|permission|approval)|waiting for)\b/i;
const COMPLETED_CLAIM_RE =
  /\b(?:done|completed|complete|finished|implemented|fixed|added|updated|created|wired|refactored|tests? pass(?:ed)?|all checks (?:green|pass)|build pass(?:es|ed)?|ready)\b/i;
const NEGATED_COMPLETION_RE =
  /\b(?:not|isn(?:'|\u2019)?t|is not|aren(?:'|\u2019)?t|are not|haven(?:'|\u2019)?t|have not|couldn(?:'|\u2019)?t|could not|didn(?:'|\u2019)?t|did not)\b.{0,32}\b(?:done|complete|finished|implemented|fixed|pass(?:ed|es)?)\b/i;

const RECURRENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ISSUE_REF_RE = /#\d+\b/g;
const FILE_TOPIC_RE =
  /(?:^|[\s"'`([<{])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|py|go|rs|rb|java|ya?ml|toml|sh|sql))/gi;
const COMMON_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'types.ts',
  'types.tsx',
  'types.js',
  'types.jsx',
]);

const MUTATING_TOOL_NAMES = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

function stripSyntheticTurn(text: string): string {
  return text
    .replace(SYNTHETIC_BLOCK_RE, ' ')
    .split('\n')
    .filter((line) => !SYNTHETIC_LINE_RE.test(line))
    .join('\n')
    .trim();
}

export function classifyHumanTaskVerdict(text: string): HumanTaskVerdict {
  const cleaned = stripSyntheticTurn(text);
  if (!cleaned) return 'none';
  const normalized = cleaned.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return 'none';
  if (CORRECT_RE.test(normalized) || FOLLOWUP_CORRECT_RE.test(normalized)) {
    return 'correct';
  }
  if (ACCEPT_RE.test(normalized)) return 'accept';
  return 'neutral';
}

export function classifyAgentClosingClaim(text: string): AgentClosingClaim {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'none';
  if (BLOCKED_CLAIM_RE.test(normalized)) return 'blocked';
  if (COMPLETED_CLAIM_RE.test(normalized) && !NEGATED_COMPLETION_RE.test(normalized)) {
    return 'completed';
  }
  return 'none';
}

export function extractRecurrenceTopics(text: string): string[] {
  const topics = new Set<string>();
  for (const match of text.matchAll(ISSUE_REF_RE)) {
    topics.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(FILE_TOPIC_RE)) {
    const path = match[1].replace(/\\/g, '/');
    const basename = path.split('/').pop()?.toLowerCase() ?? '';
    if (!basename || COMMON_BASENAMES.has(basename)) continue;
    topics.add(basename);
  }
  return [...topics].sort();
}

function addTopics(target: Set<string>, text: string | undefined): void {
  if (!text) return;
  for (const topic of extractRecurrenceTopics(text)) target.add(topic);
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
      return ms == null ? null : { ms, timestamp: stop.timestamp };
    })
    .filter((stop): stop is StopBoundary => stop != null)
    .sort((a, b) => a.ms - b.ms);
}

function bucketIndex(ms: number, stops: StopBoundary[]): number {
  const idx = stops.findIndex((stop) => stop.ms >= ms);
  return idx === -1 ? stops.length : idx;
}

function inputText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function isMutatingTool(block: ContentBlock): boolean {
  const name = block.name ?? '';
  if (MUTATING_TOOL_NAMES.has(name)) return true;
  if (name !== 'Bash') return false;
  const command = inputText(block.input);
  return /\b(?:apply_patch|git\s+(?:commit|push|merge|rebase)|npm\s+(?:run|version)|npx\s+(?:tsx|vite|vitest|tsc)|pnpm\s+|yarn\s+|mkdir|rm|mv|cp|chmod|touch|tee\s|sed\s+-i|python\b[\s\S]{0,120}\bwrite|podman\s+(?:compose\s+)?up|docker\s+(?:compose\s+)?up|kubectl\s+(?:apply|delete|patch|rollout)|terraform\s+apply)\b/i.test(
    command
  );
}

function collectTranscriptEvents(
  text: string,
  fileName: string
): TaskSuccessTranscriptEvent[] {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const events: TaskSuccessTranscriptEvent[] = [];
  for (const raw of parseJsonl(text)) {
    const timestamp = raw.timestamp;
    if (!timestamp) continue;
    const msg = parseMessage(raw.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    if (raw.type === 'assistant') {
      const textBlocks: string[] = [];
      for (const block of msg.content as ContentBlock[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          const topicText = inputText(block.input);
          events.push({
            sessionId,
            timestamp,
            kind: 'tool_use',
            toolName: block.name ?? 'unknown',
            ...(topicText ? { topicText } : {}),
            isMutating: isMutatingTool(block),
          });
        }
      }
      const turnText = textBlocks.join('\n').trim();
      if (turnText) {
        events.push({
          sessionId,
          timestamp,
          kind: 'assistant_text',
          text: turnText,
          topicText: turnText,
        });
      }
    } else if (raw.type === 'user') {
      for (const block of msg.content as ContentBlock[]) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') {
          continue;
        }
        events.push({
          sessionId,
          timestamp,
          kind: 'tool_result',
          isError: block.is_error === true,
        });
      }
    }
  }
  return events.sort((a, b) => {
    const ams = finiteMs(a.timestamp) ?? 0;
    const bms = finiteMs(b.timestamp) ?? 0;
    return ams - bms;
  });
}

function scoreSpan(span: SpanDraft): {
  confidence: TaskSuccessConfidence;
  successScore: number;
  verdictScore?: number;
  claimScore?: number;
  errorPenalty: number;
} {
  const toolErrorRate =
    span.toolResultCount === 0 ? 0 : span.toolErrorCount / span.toolResultCount;
  const errorPenalty = Math.min(0.35, toolErrorRate * 0.35);

  if (span.verdict === 'accept') {
    return {
      confidence: 'high',
      successScore: 1,
      verdictScore: 1,
      errorPenalty: 0,
    };
  }
  if (span.verdict === 'correct') {
    return {
      confidence: 'high',
      successScore: 0,
      verdictScore: 0,
      errorPenalty: 0,
    };
  }

  const backedByMutation =
    span.agentClaim === 'completed' && span.mutatingToolCount > 0;
  if (span.verdict === 'neutral') {
    if (span.agentClaim === 'completed') {
      const base = backedByMutation ? 0.72 : 0.62;
      return {
        confidence: 'med',
        successScore: Math.max(0, base - errorPenalty),
        verdictScore: 0.5,
        claimScore: backedByMutation ? 0.72 : 0.62,
        errorPenalty,
      };
    }
    if (span.agentClaim === 'blocked') {
      return {
        confidence: 'med',
        successScore: Math.max(0, 0.25 - errorPenalty),
        verdictScore: 0.5,
        claimScore: 0.25,
        errorPenalty,
      };
    }
  }

  if (span.agentClaim === 'completed') {
    const base = backedByMutation ? 0.6 : 0.52;
    return {
      confidence: 'low',
      successScore: Math.max(0, base - errorPenalty),
      claimScore: base,
      errorPenalty,
    };
  }
  if (span.agentClaim === 'blocked') {
    return {
      confidence: 'low',
      successScore: Math.max(0, 0.2 - errorPenalty),
      claimScore: 0.2,
      errorPenalty,
    };
  }
  if (span.toolErrorCount > 0) {
    return {
      confidence: 'low',
      successScore: Math.max(0, 0.45 - errorPenalty),
      errorPenalty,
    };
  }
  return {
    confidence: 'unknown',
    successScore: 0.5,
    errorPenalty: 0,
  };
}

function finalize(span: SpanDraft): TaskSuccessProxy {
  const score = scoreSpan(span);
  const toolErrorRate =
    span.toolResultCount === 0 ? 0 : span.toolErrorCount / span.toolResultCount;
  return {
    sessionId: span.sessionId,
    ...(span.project ? { project: span.project } : {}),
    taskIndex: span.taskIndex,
    startTime: iso(span.startMs),
    endTime: iso(span.endMs),
    wallClockMs:
      span.startMs != null && span.endMs >= span.startMs
        ? span.endMs - span.startMs
        : 0,
    verdict: span.verdict,
    agentClaim: span.agentClaim,
    confidence: score.confidence,
    successScore: Number(score.successScore.toFixed(3)),
    backedByMutation:
      span.agentClaim === 'completed' && span.mutatingToolCount > 0,
    mutatingToolCount: span.mutatingToolCount,
    toolCallCount: span.toolCallCount,
    toolResultCount: span.toolResultCount,
    toolErrorCount: span.toolErrorCount,
    toolErrorRate: Number(toolErrorRate.toFixed(3)),
    ...(score.verdictScore == null ? {} : { verdictScore: score.verdictScore }),
    ...(score.claimScore == null
      ? {}
      : { claimScore: Number(score.claimScore.toFixed(3)) }),
    errorPenalty: Number(score.errorPenalty.toFixed(3)),
    ...(span.topics.size > 0
      ? { recurrenceTopics: [...span.topics].sort() }
      : {}),
  };
}

interface CorrectiveTurn {
  sessionId: string;
  timestamp: number;
  timestampIso: string;
  display: string;
  topics: Set<string>;
}

function hasSharedTopic(
  span: TaskSuccessProxy,
  turn: CorrectiveTurn
): string | null {
  for (const topic of span.recurrenceTopics ?? []) {
    if (turn.topics.has(topic)) return topic;
  }
  return null;
}

function completedLooking(span: TaskSuccessProxy): boolean {
  return (
    span.agentClaim === 'completed' &&
    span.backedByMutation &&
    span.successScore >= 0.5 &&
    (span.recurrenceTopics?.length ?? 0) > 0
  );
}

function explicitFailure(span: TaskSuccessProxy): boolean {
  return span.verdict === 'correct' || span.recurrence?.kind === 'demoted';
}

function demoteSpan(
  span: TaskSuccessProxy,
  topic: string,
  proof: TaskSuccessRecurrenceProof
): TaskSuccessProxy {
  return {
    ...span,
    verdict: 'correct',
    confidence: 'high',
    successScore: 0,
    verdictScore: 0,
    recurrence: {
      kind: 'demoted',
      topic,
      proof,
    },
  };
}

/**
 * Promote a span on the strength of "the user never came back about this".
 *
 * Only reachable once the full recurrence window has elapsed INSIDE observed
 * history (#3155) — see the guard at the call site. `observedUntil` dates the
 * claim so the absence is bounded by when we stopped looking rather than
 * asserted open-endedly.
 */
function corroborateSpan(
  span: TaskSuccessProxy,
  topic: string,
  observedUntilMs: number
): TaskSuccessProxy {
  return {
    ...span,
    confidence: 'high',
    successScore: Math.max(span.successScore, 0.9),
    recurrence: {
      kind: 'corroborated',
      topic,
      observedUntil: new Date(observedUntilMs).toISOString(),
    },
  };
}

/** A completed span with its finite endMs, kept in `sorted` order for indexing (#3156). */
interface CompletedSpan {
  endMs: number;
  sortIndex: number;
  span: TaskSuccessProxy;
}

/** First index `i` with `list[i].endMs >= value` (lower bound). */
function lowerBoundByEnd(list: readonly CompletedSpan[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].endMs < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * From one topic's completed spans (sorted by endMs asc, then sessionId,
 * taskIndex) pick the span the old linear scan would (#3156): the one with the
 * LATEST endMs that is strictly before `ts` and within RECURRENCE_WINDOW_MS of
 * it, breaking ties toward the smallest (sessionId, taskIndex).
 */
function latestEligibleInTopic(
  list: readonly CompletedSpan[],
  ts: number
): CompletedSpan | null {
  const hi = lowerBoundByEnd(list, ts) - 1; // last index with endMs < ts
  if (hi < 0) return null;
  const maxEnd = list[hi].endMs;
  if (ts - maxEnd > RECURRENCE_WINDOW_MS) return null;
  // First index of the endMs === maxEnd block = smallest (sessionId, taskIndex)
  // at that endMs, matching the old stable desc-endMs sort's tie-break.
  return list[lowerBoundByEnd(list, maxEnd)];
}

/** First index `i` with `sortedAsc[i] > value` (upper bound). */
function upperBoundNumber(sortedAsc: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function applyRecurrence(
  spans: TaskSuccessProxy[],
  humanTurns: readonly HistoryEntry[] = []
): TaskSuccessProxy[] {
  const sorted = spans.slice().sort((a, b) => {
    const ams = finiteMs(a.endTime) ?? 0;
    const bms = finiteMs(b.endTime) ?? 0;
    if (ams !== bms) return ams - bms;
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return a.taskIndex - b.taskIndex;
  });
  const byKey = new Map(
    sorted.map((span) => [`${span.sessionId}\0${span.taskIndex}`, span])
  );
  const realTurns = realHumanTurns(humanTurns);
  const allTopicTurns = realTurns
    .map((entry): CorrectiveTurn | null => {
      const topics = new Set(extractRecurrenceTopics(entry.display));
      if (topics.size === 0 || !Number.isFinite(entry.timestamp)) return null;
      return {
        sessionId: entry.sessionId,
        timestamp: entry.timestamp,
        timestampIso: new Date(entry.timestamp).toISOString(),
        display: entry.display,
        topics,
      };
    })
    .filter((turn): turn is CorrectiveTurn => turn != null)
    .sort((a, b) => a.timestamp - b.timestamp);
  // The observation boundary: the last human turn we can see. Everything after
  // it is unobserved, so no absence-based claim may extend past it (#3155).
  //
  // Derived from ALL real human turns, not just the topic-bearing ones: a turn
  // we could not extract a topic from is still proof we were watching at that
  // moment. Taking it from `allTopicTurns` would shorten the observed window
  // whenever the most recent activity happened not to name a file or symbol.
  const observedUntilMs = realTurns.reduce(
    (latest, entry) =>
      Number.isFinite(entry.timestamp) && entry.timestamp > latest
        ? entry.timestamp
        : latest,
    Number.NEGATIVE_INFINITY
  );
  const correctiveTurns = allTopicTurns.filter(
    (turn) => classifyHumanTaskVerdict(turn.display) === 'correct'
  );
  const demotedKeys = new Set<string>();

  // Index completed spans by recurrence topic once (#3156). Each per-topic list
  // preserves `sorted` order (endMs asc, then sessionId, taskIndex), so a
  // corrective turn selects its target by binary search per shared topic
  // instead of filtering and sorting the whole span array every time — turning
  // the old O(C·S·logS) demotion scan into O(S + C·logS).
  const completedByTopic = new Map<string, CompletedSpan[]>();
  for (const [sortIndex, span] of sorted.entries()) {
    if (!completedLooking(span)) continue;
    const endMs = finiteMs(span.endTime);
    if (endMs == null) continue;
    const entry: CompletedSpan = { endMs, sortIndex, span };
    for (const topic of new Set(span.recurrenceTopics ?? [])) {
      const list = completedByTopic.get(topic) ?? [];
      list.push(entry);
      completedByTopic.set(topic, list);
    }
  }

  for (const turn of correctiveTurns) {
    // The same candidate the old `filter(...).sort(desc endMs)[0]` produced:
    // across the turn's shared topics, the latest-ending completed span in
    // window, ties broken toward the smallest (sessionId, taskIndex).
    let target: CompletedSpan | null = null;
    for (const topic of turn.topics) {
      const list = completedByTopic.get(topic);
      if (!list) continue;
      const cand = latestEligibleInTopic(list, turn.timestamp);
      if (!cand) continue;
      if (
        target == null ||
        cand.endMs > target.endMs ||
        (cand.endMs === target.endMs && cand.sortIndex < target.sortIndex)
      ) {
        target = cand;
      }
    }
    if (!target) continue;
    if (target.span.verdict === 'accept') continue;
    const topic = hasSharedTopic(target.span, turn);
    if (!topic) continue;
    const key = `${target.span.sessionId}\0${target.span.taskIndex}`;
    byKey.set(
      key,
      demoteSpan(target.span, topic, {
        sessionId: turn.sessionId,
        timestamp: turn.timestampIso,
        display: turn.display,
        topic,
      })
    );
    demotedKeys.add(key);
  }

  // Index topic-bearing turn timestamps by topic once (#3156). A span is
  // corroborated only when NO later matching turn returned inside the window;
  // the old code scanned every topic turn per span (O(S·T)), this
  // binary-searches per topic (O(S·logT)). Only EXISTENCE matters — the old
  // `.find` used its result solely as a boolean — so the check is exact.
  const turnTimestampsByTopic = new Map<string, number[]>();
  for (const turn of allTopicTurns) {
    for (const topic of turn.topics) {
      const arr = turnTimestampsByTopic.get(topic) ?? [];
      arr.push(turn.timestamp);
      turnTimestampsByTopic.set(topic, arr);
    }
  }
  const hasReturningTurn = (
    current: TaskSuccessProxy,
    endMs: number
  ): boolean => {
    for (const topic of current.recurrenceTopics ?? []) {
      const arr = turnTimestampsByTopic.get(topic);
      if (!arr) continue;
      const idx = upperBoundNumber(arr, endMs); // first timestamp strictly after endMs
      if (idx < arr.length && arr[idx] - endMs <= RECURRENCE_WINDOW_MS) {
        return true;
      }
    }
    return false;
  };

  for (const span of sorted) {
    const key = `${span.sessionId}\0${span.taskIndex}`;
    const current = byKey.get(key) ?? span;
    if (
      demotedKeys.has(key) ||
      current.confidence === 'high' ||
      current.verdict === 'accept' ||
      explicitFailure(current) ||
      !completedLooking(current)
    ) {
      continue;
    }
    const endMs = finiteMs(current.endTime);
    if (endMs == null) continue;
    if (hasReturningTurn(current, endMs)) continue;
    // Absence of a returning turn is only evidence once we have actually
    // WATCHED for the full recurrence window (#3155). `observedUntilMs` is the
    // last moment the supplied history covers; if the window has not closed
    // inside it, "they never came back" is a statement about how long we looked,
    // not about the task. With no history at all this is -Infinity, so an empty
    // or partial corpus can no longer promote every span to high confidence.
    if (observedUntilMs - endMs < RECURRENCE_WINDOW_MS) continue;
    const topic = current.recurrenceTopics?.[0];
    if (!topic) continue;
    byKey.set(key, corroborateSpan(current, topic, observedUntilMs));
  }

  return sorted.map((span) => byKey.get(`${span.sessionId}\0${span.taskIndex}`) ?? span);
}

export function computeTaskSuccess(input: TaskSuccessInput): TaskSuccessProxy[] {
  const sessions = groupBySessions(input.entries);
  const entriesBySession = new Map(sessions.map((session) => [session.sessionId, session]));
  const runtimeBySession = new Map(
    (input.runtimeEvents ?? []).map((runtime) => [runtime.sessionId, runtime])
  );
  const eventsBySession = new Map<string, TaskSuccessTranscriptEvent[]>();
  for (const event of input.transcriptEvents ?? []) {
    const list = eventsBySession.get(event.sessionId) ?? [];
    list.push(event);
    eventsBySession.set(event.sessionId, list);
  }

  const sessionIds = new Set<string>([
    ...entriesBySession.keys(),
    ...runtimeBySession.keys(),
    ...eventsBySession.keys(),
  ]);
  const out: TaskSuccessProxy[] = [];

  for (const sessionId of sessionIds) {
    const session = entriesBySession.get(sessionId);
    const runtime = runtimeBySession.get(sessionId);
    const events = eventsBySession.get(sessionId) ?? [];
    const stops = stopBoundaries(runtime);
    if (stops.length === 0) continue;

    const humanTurns = realHumanTurns(session?.entries ?? [])
      .filter((entry) => Number.isFinite(entry.timestamp))
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);
    const project = session?.project;
    const spans = stops.map((stop, idx): SpanDraft => ({
      sessionId,
      ...(project ? { project } : {}),
      taskIndex: idx,
      startMs: idx === 0 ? null : stops[idx - 1].ms,
      endMs: stop.ms,
      verdict: 'none',
      agentClaim: 'none',
      mutatingToolCount: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      toolErrorCount: 0,
      topics: new Set<string>(),
    }));

    for (const human of humanTurns) {
      const idx = bucketIndex(human.timestamp, stops);
      if (idx < spans.length) {
        const span = spans[idx];
        span.startMs =
          span.startMs == null ? human.timestamp : Math.min(span.startMs, human.timestamp);
        addTopics(span.topics, human.display);
      }
    }

    for (const event of events) {
      const ms = finiteMs(event.timestamp);
      if (ms == null) continue;
      const idx = bucketIndex(ms, stops);
      if (idx >= spans.length) continue;
      const span = spans[idx];
      span.startMs = span.startMs == null ? ms : Math.min(span.startMs, ms);
      addTopics(span.topics, event.topicText);
      if (event.kind === 'tool_use') {
        span.toolCallCount += 1;
        if (event.isMutating) span.mutatingToolCount += 1;
      } else if (event.kind === 'tool_result') {
        span.toolResultCount += 1;
        if (event.isError) span.toolErrorCount += 1;
      } else if (event.kind === 'assistant_text' && event.text) {
        const claim = classifyAgentClosingClaim(event.text);
        if (claim !== 'none') span.agentClaim = claim;
      }
    }

    for (let idx = 0; idx < spans.length; idx += 1) {
      const stop = stops[idx];
      const nextStop = stops[idx + 1];
      const nextHuman = humanTurns.find(
        (entry) =>
          entry.timestamp > stop.ms &&
          (nextStop == null || entry.timestamp < nextStop.ms)
      );
      if (nextHuman) {
        spans[idx].verdict = classifyHumanTaskVerdict(nextHuman.display);
      }
      if (spans[idx].startMs == null) spans[idx].startMs = stop.ms;
    }

    out.push(...spans.map(finalize));
  }

  return applyRecurrence(out, input.entries).sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
    return a.taskIndex - b.taskIndex;
  });
}

export function parseTaskSuccess(
  mergedText: string,
  fileName: string,
  options: ParseTaskSuccessOptions = {}
): TaskSuccessProxy[] {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const topText = options.topText ?? mergedText;
  const entries = deriveEntriesFromTranscript(
    topText,
    sessionId,
    options.fallbackProject ?? undefined,
    options.title
  );
  const runtime = parseRuntimeEvents(mergedText, fileName);
  return computeTaskSuccess({
    entries,
    runtimeEvents: runtime ? [runtime] : [],
    transcriptEvents: collectTranscriptEvents(mergedText, fileName),
  });
}
