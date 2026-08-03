/**
 * Per-turn cheaper-model recommender.
 *
 * Given the dashboard's existing parses (token usage, tool calls, transcript
 * timelines, native agent/skill attribution), classify each conversational
 * turn by a handful of cheap signals and propose the *cheapest* current model
 * we'd expect to handle that turn without losing fidelity.
 *
 * A "turn" here is one user message and everything the assistant did before
 * the next user message — the natural unit of "could this have run on Haiku?".
 *
 * Buckets:
 *   - trivial:  short prompt, ≤2 tools, ≤1 file edit, no agents, modest output
 *               → claude-haiku-4-5-20251001
 *   - moderate: medium prompt, ≤5 tools, ≤3 file edits, no nested agent spawn
 *               → claude-sonnet-5
 *   - complex:  anything else → keep the current model (or Opus when unknown)
 *
 * The thresholds are deliberately conservative; the UI surfaces this as a
 * heuristic estimate, not a hard claim that Haiku would have succeeded.
 *
 * Savings are computed by recomputing the cost of every token the turn
 * actually consumed against the recommended model's pricing tier, then
 * subtracting from the actual cost. Negative deltas are clamped to zero —
 * we never claim "savings" by upgrading.
 */
import type { SessionTokenData, TokenEntry } from '../types';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import type { SessionAttribution } from './parse-agents';
import { resolveModelPricing, SERVER_TOOL_PRICING, type ModelPricing } from './pricing';
import {
  CURRENT_RECOMMENDATION_MODEL_IDS,
  resolveModelFamily,
} from './model-registry';

export type TurnBucket = 'trivial' | 'moderate' | 'complex';

/** Canonical current-tier model strings used as recommendation targets. */
export const REC_HAIKU = CURRENT_RECOMMENDATION_MODEL_IDS.haiku;
export const REC_SONNET = CURRENT_RECOMMENDATION_MODEL_IDS.sonnet;
export const REC_OPUS = CURRENT_RECOMMENDATION_MODEL_IDS.opus;

const FILE_EDIT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

const AGENT_SPAWN_TOOLS = new Set(['Task']);

export interface TurnFeatures {
  turnLengthChars: number;
  toolCount: number;
  toolDiversity: number;
  fileEdits: number;
  branchiness: number;
  outputTokens: number;
}

export interface TurnRec {
  sessionId: string;
  turnIndex: number;
  startTime: string;
  endTime: string;
  promptSummary: string;
  bucket: TurnBucket;
  currentModel: string;
  recommendedModel: string;
  features: TurnFeatures;
  actualCostUsd: number;
  recommendedCostUsd: number;
  savingsUsd: number;
}

export interface SessionRec {
  sessionId: string;
  turns: number;
  downgradableTurns: number;
  downgradablePct: number;
  estimatedSavingsUsd: number;
  trivialTurns: number;
  moderateTurns: number;
  complexTurns: number;
}

export interface ModelRecRow {
  session: SessionRec;
  turns: TurnRec[];
}

/** Optional operation-count sink used by the performance regression probe. */
export interface ModelRecommendationDiagnostics {
  tokenEntryExaminations: number;
}

export interface ModelRecSummary {
  totalTurns: number;
  trivialTurns: number;
  moderateTurns: number;
  complexTurns: number;
  downgradablePct: number;
  estimatedSavingsUsd: number;
  haikuTurns: number;
  sonnetTurns: number;
  /** Up to a few recent trivial turns to show as evidence in the UI. */
  recentTrivialExamples: TurnRec[];
}

// Bucket thresholds — kept conservative so we don't push complex work to Haiku.
const TRIVIAL_PROMPT_CHARS = 500;
const TRIVIAL_TOOL_COUNT = 2;
const TRIVIAL_FILE_EDITS = 1;
const TRIVIAL_OUTPUT_TOKENS = 1000;

const MODERATE_PROMPT_CHARS = 2000;
const MODERATE_TOOL_COUNT = 5;
const MODERATE_FILE_EDITS = 3;

function tsMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The cost of one TokenEntry priced against an arbitrary model's pricing tier.
 * Mirrors `estimateCost` from parse-sessions but lets us reprice a turn
 * against a *different* model than the one that actually ran.
 */
function entryCostAt(entry: TokenEntry, pricing: ModelPricing): number {
  const cache1h = Math.min(entry.cacheCreation1hTokens, entry.cacheCreationTokens);
  const cache5m = entry.cacheCreationTokens - cache1h;
  return (
    (entry.inputTokens / 1_000_000) * pricing.input +
    (entry.outputTokens / 1_000_000) * pricing.output +
    (cache5m / 1_000_000) * pricing.cacheWrite5m +
    (cache1h / 1_000_000) * pricing.cacheWrite1h +
    (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    entry.webSearchRequests * SERVER_TOOL_PRICING.webSearchRequest +
    entry.webFetchRequests * SERVER_TOOL_PRICING.webFetchRequest
  );
}

function classifyTurn(f: TurnFeatures, hasAgents: boolean): TurnBucket {
  if (
    f.turnLengthChars < TRIVIAL_PROMPT_CHARS &&
    f.toolCount <= TRIVIAL_TOOL_COUNT &&
    f.fileEdits <= TRIVIAL_FILE_EDITS &&
    f.branchiness === 0 &&
    !hasAgents &&
    f.outputTokens < TRIVIAL_OUTPUT_TOKENS
  ) {
    return 'trivial';
  }
  if (
    f.turnLengthChars < MODERATE_PROMPT_CHARS &&
    f.toolCount <= MODERATE_TOOL_COUNT &&
    f.fileEdits <= MODERATE_FILE_EDITS &&
    f.branchiness <= 1
  ) {
    return 'moderate';
  }
  return 'complex';
}

function recommendedFor(
  bucket: TurnBucket,
  currentModel: string
): string {
  if (bucket === 'trivial') return REC_HAIKU;
  if (bucket === 'moderate') return REC_SONNET;
  const family = resolveModelFamily(currentModel ?? '');
  if (family === 'opus') return currentModel;
  if (family === 'sonnet') return REC_SONNET;
  if (family === 'haiku') return REC_HAIKU;
  return REC_OPUS;
}

interface TurnSlice {
  index: number;
  startMs: number;
  endMs: number;
  startTime: string;
  endTime: string;
  promptChars: number;
  promptSummary: string;
  toolCalls: ToolCall[];
  timelineToolCount: number;
  timelineFileEdits: number;
  timelineAgents: number;
  toolNames: Set<string>;
}

interface TimedTokenEntry {
  entry: TokenEntry;
  ms: number;
  originalIndex: number;
}

interface TimedTokenEntries {
  entries: TimedTokenEntry[];
  sortedByTimestamp: boolean;
  byTimestamp: TimedTokenEntry[];
}

/**
 * Walk a session's timeline and emit one slice per user turn. The slice
 * window runs from this user message up to (but not including) the next
 * user message; token entries that fall inside that window are attributed
 * to the turn.
 */
function sliceTimeline(timeline: SessionTimeline): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let current: TurnSlice | null = null;
  let lastTs = '';

  const closeCurrent = (endTime: string) => {
    if (!current) return;
    current.endTime = endTime;
    current.endMs = tsMs(endTime);
    slices.push(current);
    current = null;
  };

  for (const entry of timeline.entries) {
    lastTs = entry.timestamp || lastTs;

    if (entry.kind === 'user') {
      // Prefer the TRUE pre-clip length (#3511): `summaryLen` saturates at
      // MAX_SUMMARY (200) because it measures the already-clipped summary, so
      // without `summaryRawLen` a long complex prompt would look 200 chars and
      // slip under TRIVIAL_PROMPT_CHARS. Fall back to `summaryLen` (present when
      // no truncation happened) then the raw summary length.
      const promptChars =
        entry.summaryRawLen ?? entry.summaryLen ?? entry.summary?.length ?? 0;
      const promptSummary =
        entry.summary ?? (slices.length === 0 ? timeline.firstPromptPreview ?? '' : '');
      // Multi-block user messages can produce several adjacent `user` entries;
      // only the first one of a contiguous run opens a new turn — tool_results
      // arrive under kind 'tool_result', not 'user', so a real prompt is what
      // we key on.
      if (current && current.toolCalls.length === 0 && current.promptChars === 0) {
        current.promptChars += promptChars;
        if (!current.promptSummary) current.promptSummary = promptSummary;
        continue;
      }
      closeCurrent(entry.timestamp || lastTs);
      current = {
        index: slices.length,
        startMs: tsMs(entry.timestamp),
        endMs: tsMs(entry.timestamp),
        startTime: entry.timestamp,
        endTime: entry.timestamp,
        promptChars,
        promptSummary,
        toolCalls: [],
        timelineToolCount: 0,
        timelineFileEdits: 0,
        timelineAgents: 0,
        toolNames: new Set<string>(),
      };
      continue;
    }

    if (!current) continue;

    if (entry.kind === 'tool_use') {
      const name = entry.toolName ?? 'unknown';
      current.timelineToolCount += 1;
      current.toolNames.add(name);
      if (FILE_EDIT_TOOLS.has(name)) current.timelineFileEdits += 1;
      if (AGENT_SPAWN_TOOLS.has(name)) current.timelineAgents += 1;
    }
  }
  closeCurrent(lastTs);
  return slices;
}

/**
 * Bind per-session tool calls to whichever turn slice contains the call's
 * timestamp. Tool calls give us the canonical `toolName` set; the timeline
 * counts are kept as a fallback for sessions without tool data.
 */
function attachToolCalls(
  slices: TurnSlice[],
  tools: ToolUsageData | undefined,
  sortedByStart: boolean
): void {
  if (!tools || slices.length === 0) return;
  for (const call of tools.calls) {
    const ms = tsMs(call.timestamp);
    if (!ms) continue;
    const slice = findSliceForMs(slices, ms, sortedByStart);
    if (!slice) continue;
    slice.toolCalls.push(call);
    slice.toolNames.add(call.toolName);
  }
}

function slicesSortedByStart(slices: TurnSlice[]): boolean {
  for (let i = 1; i < slices.length; i++) {
    if (slices[i].startMs < slices[i - 1].startMs) return false;
  }
  return true;
}

function findSliceForMs(
  slices: TurnSlice[],
  ms: number,
  sortedByStart: boolean
): TurnSlice | null {
  if (sortedByStart) {
    let lo = 0;
    let hi = slices.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ms >= slices[mid].startMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return slices[best] ?? null;
  }

  // Fallback preserves behavior for malformed timelines with non-monotonic
  // timestamps: choose the last slice in timeline order whose start is <= ms.
  for (let i = slices.length - 1; i >= 0; i--) {
    const s = slices[i];
    if (ms >= s.startMs) return s;
  }
  return slices[0] ?? null;
}

function recordTokenExaminations(
  diagnostics: ModelRecommendationDiagnostics | undefined,
  count = 1
): void {
  if (diagnostics) diagnostics.tokenEntryExaminations += count;
}

function prepareTimedTokenEntries(
  entries: TokenEntry[],
  diagnostics: ModelRecommendationDiagnostics | undefined
): TimedTokenEntries {
  const timed: TimedTokenEntry[] = [];
  let sortedByTimestamp = true;
  let previous = Number.NEGATIVE_INFINITY;
  for (let originalIndex = 0; originalIndex < entries.length; originalIndex++) {
    const entry = entries[originalIndex];
    const ms = tsMs(entry.timestamp);
    if (ms < previous) sortedByTimestamp = false;
    previous = ms;
    timed.push({ entry, ms, originalIndex });
  }
  recordTokenExaminations(diagnostics, entries.length);
  // perf-index-contract: token-window-timestamp-index always-consumed: every unsorted token stream immediately queries indexed ranges for its turns
  const byTimestamp = sortedByTimestamp
    ? timed
    : [...timed].sort(
        (a, b) => a.ms - b.ms || a.originalIndex - b.originalIndex
      );
  return { entries: timed, sortedByTimestamp, byTimestamp };
}

function collectTokenEntriesForWindow(
  timed: TimedTokenEntry[],
  startMs: number,
  endMs: number,
  cursor: number
): { entries: TokenEntry[]; nextCursor: number } {
  while (cursor < timed.length) {
    if (timed[cursor].ms >= startMs) break;
    cursor++;
  }

  const entries: TokenEntry[] = [];
  let i = cursor;
  for (; i < timed.length; i++) {
    if (timed[i].ms >= endMs) break;
    entries.push(timed[i].entry);
  }

  return { entries, nextCursor: i };
}

function lowerBoundTimedEntries(
  timed: TimedTokenEntry[],
  targetMs: number,
  diagnostics: ModelRecommendationDiagnostics | undefined
): number {
  let lo = 0;
  let hi = timed.length;
  let examinations = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    examinations += 1;
    if (timed[mid].ms < targetMs) lo = mid + 1;
    else hi = mid;
  }
  recordTokenExaminations(diagnostics, examinations);
  return lo;
}

/**
 * Query a timestamp-sorted per-session index, then restore the selected
 * entries to their original array order. The latter preserves the historical
 * first-model choice for malformed inverted input (#3147).
 */
function collectTokenEntriesForWindowIndexed(
  timed: TimedTokenEntry[],
  startMs: number,
  endMs: number,
  diagnostics: ModelRecommendationDiagnostics | undefined
): TokenEntry[] {
  if (endMs <= startMs) return [];
  const start = lowerBoundTimedEntries(timed, startMs, diagnostics);
  const end = lowerBoundTimedEntries(timed, endMs, diagnostics);
  const selected = timed.slice(start, end);
  recordTokenExaminations(diagnostics, selected.length);
  if (selected.length > 1) {
    // perf-index-contract: token-window-original-order always-consumed: the selected entries are returned immediately in original array order
    selected.sort((a, b) => a.originalIndex - b.originalIndex);
  }
  return selected.map((item) => item.entry);
}

function pickModelForEntry(entries: TokenEntry[]): string {
  for (const e of entries) {
    if (e.model && e.model !== '<synthetic>') return e.model;
  }
  return entries[0]?.model ?? 'unknown';
}

/**
 * Compute per-session, per-turn recommendations across all sessions that
 * have transcript data. Sessions without timeline data are skipped — we
 * can't classify a turn we never saw.
 */
export function computeModelRecommendations(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  timelines: SessionTimeline[],
  attribution: SessionAttribution[],
  diagnostics?: ModelRecommendationDiagnostics
): ModelRecRow[] {
  const tokenBySession = new Map<string, SessionTokenData>();
  for (const t of tokenData) tokenBySession.set(t.sessionId, t);

  const toolsBySession = new Map<string, ToolUsageData>();
  for (const t of toolData) toolsBySession.set(t.sessionId, t);

  const attrBySession = new Map<string, SessionAttribution>();
  for (const a of attribution) attrBySession.set(a.sessionId, a);

  const rows: ModelRecRow[] = [];

  for (const timeline of timelines) {
    const slices = sliceTimeline(timeline);
    if (slices.length === 0) continue;

    // Computed once per session and shared by the tool-call binder and the
    // token-window walk — attachToolCalls only pushes into slices, it never
    // reorders them, so the sortedness verdict stays valid.
    const slicesSorted = slicesSortedByStart(slices);
    attachToolCalls(slices, toolsBySession.get(timeline.sessionId), slicesSorted);

    const tokens = tokenBySession.get(timeline.sessionId);
    const timedTokens = tokens
      ? prepareTimedTokenEntries(tokens.entries, diagnostics)
      : null;
    let tokenCursor = 0;
    const sessionAttribution = attrBySession.get(timeline.sessionId);
    const sessionHasAgents =
      !!sessionAttribution && Object.keys(sessionAttribution.agents).length > 0;

    const turnRecs: TurnRec[] = [];
    let trivial = 0;
    let moderate = 0;
    let complex = 0;
    let downgradable = 0;
    let estimatedSavings = 0;
    const pricingCache = new Map<string, ModelPricing>();
    const pricingFor = (model: string): ModelPricing => {
      const cached = pricingCache.get(model);
      if (cached) return cached;
      const pricing = resolveModelPricing(model).pricing;
      pricingCache.set(model, pricing);
      return pricing;
    };

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      const next = slices[i + 1];
      const windowEndMs = next ? next.startMs : Number.POSITIVE_INFINITY;

      let turnEntries: TokenEntry[] = [];
      if (timedTokens) {
        if (timedTokens.sortedByTimestamp && slicesSorted) {
          const collected = collectTokenEntriesForWindow(
            timedTokens.entries,
            slice.startMs,
            windowEndMs,
            tokenCursor
          );
          turnEntries = collected.entries;
          tokenCursor = collected.nextCursor;
        } else {
          turnEntries = collectTokenEntriesForWindowIndexed(
            timedTokens.byTimestamp,
            slice.startMs,
            windowEndMs,
            diagnostics
          );
        }
      }

      const outputTokens = turnEntries.reduce((s, e) => s + e.outputTokens, 0);

      const toolCount =
        slice.toolCalls.length > 0
          ? slice.toolCalls.length
          : slice.timelineToolCount;
      const fileEdits =
        slice.toolCalls.length > 0
          ? slice.toolCalls.filter((c) => FILE_EDIT_TOOLS.has(c.toolName)).length
          : slice.timelineFileEdits;
      const branchiness =
        slice.toolCalls.length > 0
          ? slice.toolCalls.filter((c) => AGENT_SPAWN_TOOLS.has(c.toolName)).length
          : slice.timelineAgents;
      const diversityDenom = toolCount === 0 ? 1 : toolCount;
      const toolDiversity = slice.toolNames.size / diversityDenom;

      const features: TurnFeatures = {
        turnLengthChars: slice.promptChars,
        toolCount,
        toolDiversity,
        fileEdits,
        branchiness,
        outputTokens,
      };

      // Only attribute "session has agents" to a turn when that turn itself
      // also spawned one — otherwise an agent-using session would lock every
      // turn out of the trivial bucket.
      const turnHasAgents = sessionHasAgents && branchiness > 0;
      const bucket = classifyTurn(features, turnHasAgents);
      if (bucket === 'trivial') trivial += 1;
      else if (bucket === 'moderate') moderate += 1;
      else complex += 1;

      const currentModel = pickModelForEntry(turnEntries) || tokens?.model || 'unknown';
      const recommendedModel = recommendedFor(bucket, currentModel);
      if (currentModel !== recommendedModel) downgradable += 1;

      let actualCost = 0;
      let recommendedCost = 0;
      if (currentModel !== recommendedModel) {
        const currentPricing = pricingFor(currentModel);
        const recPricing = pricingFor(recommendedModel);
        for (const e of turnEntries) {
          actualCost += entryCostAt(e, currentPricing);
          recommendedCost += entryCostAt(e, recPricing);
        }
      } else {
        const pricing = pricingFor(currentModel);
        for (const e of turnEntries) {
          actualCost += entryCostAt(e, pricing);
        }
        recommendedCost = actualCost;
      }
      const savings = Math.max(0, actualCost - recommendedCost);
      estimatedSavings += savings;

      turnRecs.push({
        sessionId: timeline.sessionId,
        turnIndex: i,
        startTime: slice.startTime,
        endTime: slice.endTime,
        promptSummary: slice.promptSummary,
        bucket,
        currentModel,
        recommendedModel,
        features,
        actualCostUsd: actualCost,
        recommendedCostUsd: recommendedCost,
        savingsUsd: savings,
      });
    }

    rows.push({
      session: {
        sessionId: timeline.sessionId,
        turns: turnRecs.length,
        downgradableTurns: downgradable,
        downgradablePct:
          turnRecs.length === 0 ? 0 : (downgradable / turnRecs.length) * 100,
        estimatedSavingsUsd: estimatedSavings,
        trivialTurns: trivial,
        moderateTurns: moderate,
        complexTurns: complex,
      },
      turns: turnRecs,
    });
  }

  return rows;
}

/**
 * Roll-up across all sessions for the recommendations card.
 *
 * The `recentTrivialExamples` list is sorted by `startTime` descending so the
 * UI can show "what trivial work looked like recently" without re-sorting.
 */
export function summarizeModelRecommendations(
  rows: ModelRecRow[],
  exampleLimit = 4
): ModelRecSummary {
  let totalTurns = 0;
  let trivial = 0;
  let moderate = 0;
  let complex = 0;
  let downgradable = 0;
  let savings = 0;
  let haikuTurns = 0;
  let sonnetTurns = 0;
  const trivialTurns: TurnRec[] = [];

  for (const row of rows) {
    totalTurns += row.session.turns;
    trivial += row.session.trivialTurns;
    moderate += row.session.moderateTurns;
    complex += row.session.complexTurns;
    downgradable += row.session.downgradableTurns;
    savings += row.session.estimatedSavingsUsd;
    for (const turn of row.turns) {
      if (turn.recommendedModel === REC_HAIKU) haikuTurns += 1;
      if (turn.recommendedModel === REC_SONNET) sonnetTurns += 1;
      if (turn.bucket === 'trivial') trivialTurns.push(turn);
    }
  }

  trivialTurns.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));

  return {
    totalTurns,
    trivialTurns: trivial,
    moderateTurns: moderate,
    complexTurns: complex,
    downgradablePct: totalTurns === 0 ? 0 : (downgradable / totalTurns) * 100,
    estimatedSavingsUsd: savings,
    haikuTurns,
    sonnetTurns,
    recentTrivialExamples: trivialTurns.slice(0, exampleLimit),
  };
}

/**
 * Extrapolate the observed savings to a monthly figure based on the time span
 * the supplied rows cover. Returns 0 when the span is too short to be useful.
 */
export function estimateMonthlySavings(rows: ModelRecRow[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  let total = 0;
  for (const row of rows) {
    total += row.session.estimatedSavingsUsd;
    for (const turn of row.turns) {
      const start = tsMs(turn.startTime);
      if (start && start < earliest) earliest = start;
      const end = tsMs(turn.endTime);
      if (end && end > latest) latest = end;
    }
  }
  if (!Number.isFinite(earliest) || latest <= earliest) return 0;
  const spanDays = (latest - earliest) / (24 * 60 * 60 * 1000);
  if (spanDays < 1) return total * 30;
  return (total / spanDays) * 30;
}
