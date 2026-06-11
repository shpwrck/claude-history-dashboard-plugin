import type { SessionTokenData, TokenEntry } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import { resolveModelPricing, SERVER_TOOL_PRICING } from './pricing';

/**
 * Timeline-shape → outcome correlation.
 *
 * Sessions are bucketed by a small set of categorical features that together
 * describe the *shape* of a session's timeline (rhythm of turns, density of
 * tools, error spikes, whether the context was compacted, total wall-clock
 * duration). Each unique combination of buckets is a "cluster". For every
 * cluster we then compute a few outcome proxies (mean cost, mean error rate,
 * mean compaction-hit rate, mean tool-reuse rate) and a composite "good
 * outcome" score so we can rank clusters from most-successful-looking to
 * least-successful-looking.
 *
 * EVERY correlation here is association, not causation. The signatures group
 * sessions by behavioural shape; the outcome columns describe what those
 * sessions cost / how often they errored / whether they compacted. Two
 * sessions with the same signature may have wildly different real outcomes —
 * we only have shape and cost data, not goal-completion data.
 */

export type RhythmBucket = 'rapid' | 'sustained' | 'sparse';
export type ToolDensityBucket = 'light' | 'medium' | 'heavy';
export type ErrorSpikeBucket = 'none' | 'sporadic' | 'repeated';
export type DurationBucket = '<15m' | '15-60m' | '60-180m' | '>180m';

export interface TimelineShapeSignature {
  rhythm: RhythmBucket;
  toolDensity: ToolDensityBucket;
  errorSpike: ErrorSpikeBucket;
  hasCompaction: boolean;
  duration: DurationBucket;
}

export interface TimelineShapeExample {
  sessionId: string;
  cost: number;
  errorRate: number;
  durationMin: number;
  toolCalls: number;
}

export interface TimelineCluster {
  signature: TimelineShapeSignature;
  /** Stable string id, "<rhythm>|<toolDensity>|<errorSpike>|<compaction>|<duration>". */
  key: string;
  sessionCount: number;
  meanCost: number;
  meanErrorRate: number;
  meanCompactionRate: number;
  meanToolReuseRate: number;
  /** 0..1; higher = better outcome shape (low cost, low errors, no compaction, low reuse). */
  goodOutcomeScore: number;
  /** Up to a handful of representative sessions, sorted by cost ascending. */
  examples: TimelineShapeExample[];
  /** All member session ids (the full cluster, not just `examples`) — used to
   *  aggregate per-session radar scorecards over the whole shape (#12). */
  sessionIds: string[];
}

interface SessionShapeMetrics {
  sessionId: string;
  signature: TimelineShapeSignature;
  cost: number;
  errorRate: number;
  hasCompaction: boolean;
  toolReuseRate: number;
  durationMin: number;
  toolCalls: number;
}

const RAPID_MAX_GAP_SEC = 20;
const SPARSE_MIN_GAP_SEC = 90;

const TOOL_DENSITY_LIGHT_MAX = 0.5;
const TOOL_DENSITY_HEAVY_MIN = 3;

const ERROR_SPORADIC_MIN = 1;
const ERROR_REPEATED_MIN = 3;

function bucketRhythm(meanGapSec: number, userTurns: number): RhythmBucket {
  if (userTurns < 2) return 'sustained';
  if (meanGapSec <= RAPID_MAX_GAP_SEC) return 'rapid';
  if (meanGapSec >= SPARSE_MIN_GAP_SEC) return 'sparse';
  return 'sustained';
}

function bucketToolDensity(toolsPerTurn: number): ToolDensityBucket {
  if (toolsPerTurn < TOOL_DENSITY_LIGHT_MAX) return 'light';
  if (toolsPerTurn >= TOOL_DENSITY_HEAVY_MIN) return 'heavy';
  return 'medium';
}

function bucketErrorSpike(errorCount: number): ErrorSpikeBucket {
  if (errorCount < ERROR_SPORADIC_MIN) return 'none';
  if (errorCount >= ERROR_REPEATED_MIN) return 'repeated';
  return 'sporadic';
}

function bucketDuration(durationMin: number): DurationBucket {
  if (durationMin < 15) return '<15m';
  if (durationMin < 60) return '15-60m';
  if (durationMin < 180) return '60-180m';
  return '>180m';
}

function entryCost(entry: TokenEntry): number {
  const { pricing } = resolveModelPricing(entry.model);
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

function sessionCost(data: SessionTokenData | undefined): number {
  if (!data) return 0;
  let total = 0;
  for (const entry of data.entries) total += entryCost(entry);
  return total;
}

function parseMs(iso: string): number | null {
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

function meanInterTurnGapSec(timeline: SessionTimeline): { mean: number; userTurns: number } {
  const userMs: number[] = [];
  for (const e of timeline.entries) {
    if (e.kind !== 'user') continue;
    const ms = parseMs(e.timestamp);
    if (ms != null) userMs.push(ms);
  }
  userMs.sort((a, b) => a - b);
  if (userMs.length < 2) return { mean: 0, userTurns: userMs.length };
  let totalGapMs = 0;
  for (let i = 1; i < userMs.length; i++) totalGapMs += userMs[i] - userMs[i - 1];
  return { mean: totalGapMs / 1000 / (userMs.length - 1), userTurns: userMs.length };
}

function durationMinutes(timeline: SessionTimeline): number {
  const start = parseMs(timeline.startTime);
  const end = parseMs(timeline.endTime);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / 60_000);
}

function toolReuseRate(tools: ToolUsageData | undefined): number {
  if (!tools || tools.calls.length === 0) return 0;
  const seen = new Map<string, number>();
  for (const call of tools.calls) {
    const cmd =
      call.toolName === 'Bash' && typeof call.input?.command === 'string'
        ? call.input.command.trim().split('\n')[0].trim()
        : null;
    const key = cmd ? `Bash::${cmd}` : `${call.toolName}::${call.input?.file_path ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let reusedCalls = 0;
  for (const count of seen.values()) {
    if (count >= 2) reusedCalls += count;
  }
  return reusedCalls / tools.calls.length;
}

function buildSessionMetrics(
  timeline: SessionTimeline,
  tokenById: Map<string, SessionTokenData>,
  toolsById: Map<string, ToolUsageData>,
  apiErrorsBySession: Map<string, number>
): SessionShapeMetrics | null {
  const { sessionId } = timeline;
  const { mean: meanGap, userTurns } = meanInterTurnGapSec(timeline);
  const durationMin = durationMinutes(timeline);
  const token = tokenById.get(sessionId);
  const tools = toolsById.get(sessionId);

  const toolCalls = tools?.calls.length ?? 0;
  const toolErrorCalls = tools?.calls.filter((c) => c.isError === true).length ?? 0;
  const apiErrorCount = apiErrorsBySession.get(sessionId) ?? 0;
  const totalErrorEvents = toolErrorCalls + apiErrorCount;

  const toolsPerTurn = userTurns > 0 ? toolCalls / userTurns : toolCalls;
  const errorRate = toolCalls > 0 ? toolErrorCalls / toolCalls : 0;
  const hasCompaction = (token?.compactionEvents.length ?? 0) > 0;
  const reuseRate = toolReuseRate(tools);

  const signature: TimelineShapeSignature = {
    rhythm: bucketRhythm(meanGap, userTurns),
    toolDensity: bucketToolDensity(toolsPerTurn),
    errorSpike: bucketErrorSpike(totalErrorEvents),
    hasCompaction,
    duration: bucketDuration(durationMin),
  };

  return {
    sessionId,
    signature,
    cost: sessionCost(token),
    errorRate,
    hasCompaction,
    toolReuseRate: reuseRate,
    durationMin,
    toolCalls,
  };
}

function signatureKey(sig: TimelineShapeSignature): string {
  return [
    sig.rhythm,
    sig.toolDensity,
    sig.errorSpike,
    sig.hasCompaction ? 'compacted' : 'no-compact',
    sig.duration,
  ].join('|');
}

function normalize(values: number[]): (v: number) => number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max) || min === max) return () => 0;
  return (v: number) => (v - min) / (max - min);
}

/**
 * Group sessions by their shape signature and compute per-cluster outcome
 * proxies. Returned clusters are sorted descending by `goodOutcomeScore`
 * (clusters whose sessions tended to be cheaper, less error-prone, less likely
 * to compact, and less repetitive rank highest).
 *
 * The score is the mean of four normalised "better is lower" components:
 *   - mean cost
 *   - mean error rate
 *   - mean compaction-hit rate
 *   - mean tool-reuse rate
 * Each component is min-max normalised across clusters then inverted, so the
 * cluster with the lowest cost/errors/compaction/reuse gets a 1.0 on that
 * axis and the cluster with the highest gets a 0.0. The score is purely
 * relative within the loaded dataset.
 *
 * Singleton clusters (1 session) are kept — they're still data — but the UI
 * surfaces a cluster's `sessionCount` so callers can decide how seriously to
 * take any individual row.
 */
/** Build per-session shape metrics for every timeline (shared by the cluster
 * view and the habit-impact view). */
function computeSessionMetrics(
  timelines: SessionTimeline[],
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  apiErrors: ApiErrorEvent[]
): SessionShapeMetrics[] {
  const tokenById = new Map(tokenData.map((d) => [d.sessionId, d]));
  const toolsById = new Map(toolData.map((d) => [d.sessionId, d]));
  const apiErrorsBySession = new Map<string, number>();
  for (const e of apiErrors) {
    apiErrorsBySession.set(e.sessionId, (apiErrorsBySession.get(e.sessionId) ?? 0) + 1);
  }
  const out: SessionShapeMetrics[] = [];
  for (const t of timelines) {
    const m = buildSessionMetrics(t, tokenById, toolsById, apiErrorsBySession);
    if (m) out.push(m);
  }
  return out;
}

export function clusterTimelinesByShape(
  timelines: SessionTimeline[],
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  apiErrors: ApiErrorEvent[]
): TimelineCluster[] {
  const perSession = computeSessionMetrics(timelines, tokenData, toolData, apiErrors);

  const groups = new Map<string, SessionShapeMetrics[]>();
  for (const m of perSession) {
    const key = signatureKey(m.signature);
    const bucket = groups.get(key) ?? [];
    bucket.push(m);
    groups.set(key, bucket);
  }

  const draft = Array.from(groups.entries()).map(([key, sessions]) => {
    const n = sessions.length;
    const meanCost = sessions.reduce((s, x) => s + x.cost, 0) / n;
    const meanErrorRate = sessions.reduce((s, x) => s + x.errorRate, 0) / n;
    const meanCompactionRate =
      sessions.reduce((s, x) => s + (x.hasCompaction ? 1 : 0), 0) / n;
    const meanToolReuseRate = sessions.reduce((s, x) => s + x.toolReuseRate, 0) / n;
    const examples: TimelineShapeExample[] = sessions
      .slice()
      .sort((a, b) => a.cost - b.cost)
      .slice(0, 5)
      .map((x) => ({
        sessionId: x.sessionId,
        cost: x.cost,
        errorRate: x.errorRate,
        durationMin: x.durationMin,
        toolCalls: x.toolCalls,
      }));
    return {
      key,
      signature: sessions[0].signature,
      sessionCount: n,
      meanCost,
      meanErrorRate,
      meanCompactionRate,
      meanToolReuseRate,
      examples,
      sessionIds: sessions.map((x) => x.sessionId),
    };
  });

  const normCost = normalize(draft.map((d) => d.meanCost));
  const normErr = normalize(draft.map((d) => d.meanErrorRate));
  const normCompact = normalize(draft.map((d) => d.meanCompactionRate));
  const normReuse = normalize(draft.map((d) => d.meanToolReuseRate));

  const clusters: TimelineCluster[] = draft.map((d) => {
    const score =
      (1 - normCost(d.meanCost)) * 0.25 +
      (1 - normErr(d.meanErrorRate)) * 0.25 +
      (1 - normCompact(d.meanCompactionRate)) * 0.25 +
      (1 - normReuse(d.meanToolReuseRate)) * 0.25;
    return { ...d, goodOutcomeScore: score };
  });

  clusters.sort((a, b) => {
    if (b.goodOutcomeScore !== a.goodOutcomeScore) {
      return b.goodOutcomeScore - a.goodOutcomeScore;
    }
    return b.sessionCount - a.sessionCount;
  });

  return clusters;
}

// ── Habit-impact view (#323) ────────────────────────────────────────────
//
// The cluster view above groups sessions by the *combination* of all five
// shape buckets at once, which makes most groups singletons and the takeaway
// abstract ("this whole shape tends to be clean"). The habit-impact view
// inverts that: it isolates ONE factor at a time (compaction, tool errors, tool
// density, turn rhythm, tool repetition) and shows how outcomes differ across
// just that factor — so every split has plenty of sessions on each side and the
// finding is per-habit and prescriptive.
//
// "Outcome" is anchored labels-first, proxy-fallback (the decided design):
// `outcome = yourLabel ?? cleanlinessProxy`. A session you've tagged good/bad
// (useSessionTags) is taken at face value; an untagged session falls back to a
// cost+cleanliness proxy (cheaper than median, at-or-below median tool-error
// rate, and not compacted — majority of those three = "good"). The proxy is an
// association, not goal-completion truth, and the UI says so.

export type SessionOutcomeAnchor = 'label' | 'proxy';
export type SessionOutcomeTag = 'good' | 'bad';

export interface HabitFactorSide {
  /** Short label for this side, e.g. "compacted" / "not compacted". */
  label: string;
  sessionCount: number;
  /** Fraction (0..1) of sessions on this side with a "good" outcome. */
  goodRate: number;
  meanCost: number;
  meanErrorRate: number;
  /** Representative sessions (cheapest first), for deep-linking. */
  examples: TimelineShapeExample[];
}

export interface HabitFactor {
  key: string;
  /** Plain-language factor name, e.g. "Compacting context". */
  title: string;
  /** The "more of the habit" side. */
  high: HabitFactorSide;
  /** The "less of the habit" side. */
  low: HabitFactorSide;
  /**
   * Does doing the habit (the `high` side) associate with better, worse, or
   * indistinguishable outcomes vs the `low` side?
   */
  verdict: 'helps' | 'hurts' | 'mixed';
  /** Plain-language magnitude, e.g. "2.3× costlier on the compacted side". */
  magnitude: string;
}

export interface HabitImpactReport {
  /** Factors with enough sessions on both sides to compare, strongest first. */
  factors: HabitFactor[];
  /** Sessions whose outcome came from a user good/bad label. */
  labelledCount: number;
  /** Sessions whose outcome came from the cost+cleanliness proxy. */
  proxyCount: number;
  totalSessions: number;
}

/** Each side needs at least this many sessions or the factor is suppressed —
 * this is what kills the singleton problem the cluster view suffers from. */
const MIN_FACTOR_SIDE = 3;
/** Min gap in good-outcome rate (10 pts) to call a verdict helps/hurts. */
const VERDICT_GOODRATE_EPS = 0.1;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface FactorDef {
  key: string;
  title: string;
  highLabel: string;
  lowLabel: string;
  /** true → high side, false → low side, null → exclude from this factor. */
  classify: (
    m: SessionShapeMetrics,
    ctx: { reuseMedian: number }
  ) => boolean | null;
}

const HABIT_FACTORS: FactorDef[] = [
  {
    key: 'compaction',
    title: 'Compacting context',
    highLabel: 'compacted',
    lowLabel: 'not compacted',
    classify: (m) => m.hasCompaction,
  },
  {
    key: 'tool-errors',
    title: 'Tool errors',
    highLabel: 'with tool errors',
    lowLabel: 'error-free',
    // Only sessions that ran tools can have a tool-error rate.
    classify: (m) => (m.toolCalls > 0 ? m.errorRate > 0 : null),
  },
  {
    key: 'tool-density',
    title: 'Tool density',
    highLabel: 'heavy tool use',
    lowLabel: 'light tool use',
    // Contrast the extremes; "medium" sessions don't sharpen the comparison.
    classify: (m) =>
      m.signature.toolDensity === 'heavy'
        ? true
        : m.signature.toolDensity === 'light'
          ? false
          : null,
  },
  {
    key: 'rhythm',
    title: 'Turn rhythm',
    highLabel: 'rapid-fire turns',
    lowLabel: 'measured pace',
    // Contrast rapid vs sustained; exclude 'sparse' (near-abandoned sessions)
    // so the "measured pace" side isn't a mix of measured and barely-used.
    classify: (m) =>
      m.signature.rhythm === 'rapid'
        ? true
        : m.signature.rhythm === 'sustained'
          ? false
          : null,
  },
  {
    key: 'tool-repetition',
    title: 'Tool repetition',
    highLabel: 'high repetition',
    lowLabel: 'low repetition',
    classify: (m, ctx) =>
      m.toolCalls > 0 ? m.toolReuseRate > ctx.reuseMedian : null,
  },
];

function sessionGoodOutcome(
  m: SessionShapeMetrics,
  tags: Map<string, SessionOutcomeTag>,
  medians: { cost: number; errorRate: number }
): { good: boolean; anchor: SessionOutcomeAnchor } {
  const tag = tags.get(m.sessionId);
  if (tag === 'good') return { good: true, anchor: 'label' };
  if (tag === 'bad') return { good: false, anchor: 'label' };
  // Proxy: cheaper + cleaner + didn't need compaction. Majority of three wins.
  const points =
    (m.cost <= medians.cost ? 1 : 0) +
    (m.errorRate <= medians.errorRate ? 1 : 0) +
    (m.hasCompaction ? 0 : 1);
  return { good: points >= 2, anchor: 'proxy' };
}

function summariseSide(
  label: string,
  sessions: SessionShapeMetrics[],
  goodById: Map<string, boolean>
): HabitFactorSide {
  const n = sessions.length;
  const good = sessions.reduce((s, x) => s + (goodById.get(x.sessionId) ? 1 : 0), 0);
  const examples: TimelineShapeExample[] = sessions
    .slice()
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 3)
    .map((x) => ({
      sessionId: x.sessionId,
      cost: x.cost,
      errorRate: x.errorRate,
      durationMin: x.durationMin,
      toolCalls: x.toolCalls,
    }));
  return {
    label,
    sessionCount: n,
    goodRate: n > 0 ? good / n : 0,
    meanCost: n > 0 ? sessions.reduce((s, x) => s + x.cost, 0) / n : 0,
    meanErrorRate: n > 0 ? sessions.reduce((s, x) => s + x.errorRate, 0) / n : 0,
    examples,
  };
}

/**
 * Per-factor habit-impact analysis (#323). For each candidate factor, split the
 * sessions into a "more of the habit" side and a "less" side, compute each
 * side's good-outcome rate (anchor: labels-first, proxy-fallback) plus mean cost
 * and error rate, and derive a helps/hurts/mixed verdict. Factors without at
 * least {@link MIN_FACTOR_SIDE} sessions on BOTH sides are suppressed. Returned
 * factors are sorted by the size of the good-rate gap (strongest signal first).
 */
export function analyzeHabitImpact(
  timelines: SessionTimeline[],
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  apiErrors: ApiErrorEvent[],
  tags: Map<string, SessionOutcomeTag>
): HabitImpactReport {
  const perSession = computeSessionMetrics(timelines, tokenData, toolData, apiErrors);

  const medians = {
    cost: median(perSession.map((m) => m.cost)),
    errorRate: median(perSession.map((m) => m.errorRate)),
  };
  const reuseMedian = median(
    perSession.filter((m) => m.toolCalls > 0).map((m) => m.toolReuseRate)
  );

  const goodById = new Map<string, boolean>();
  let labelledCount = 0;
  let proxyCount = 0;
  for (const m of perSession) {
    const { good, anchor } = sessionGoodOutcome(m, tags, medians);
    goodById.set(m.sessionId, good);
    if (anchor === 'label') labelledCount++;
    else proxyCount++;
  }

  const factors: HabitFactor[] = [];
  for (const def of HABIT_FACTORS) {
    const high: SessionShapeMetrics[] = [];
    const low: SessionShapeMetrics[] = [];
    for (const m of perSession) {
      const side = def.classify(m, { reuseMedian });
      if (side === true) high.push(m);
      else if (side === false) low.push(m);
    }
    if (high.length < MIN_FACTOR_SIDE || low.length < MIN_FACTOR_SIDE) continue;

    const highSide = summariseSide(def.highLabel, high, goodById);
    const lowSide = summariseSide(def.lowLabel, low, goodById);

    const gap = highSide.goodRate - lowSide.goodRate;
    const verdict: HabitFactor['verdict'] =
      gap >= VERDICT_GOODRATE_EPS ? 'helps' : gap <= -VERDICT_GOODRATE_EPS ? 'hurts' : 'mixed';

    const betterSide = highSide.goodRate >= lowSide.goodRate ? highSide : lowSide;
    const worseSide = betterSide === highSide ? lowSide : highSide;
    const ratio =
      betterSide.meanCost > 0 ? worseSide.meanCost / betterSide.meanCost : 0;
    // Only surfaced for helps/hurts (|gap| >= EPS > 0), so worseSide is the
    // genuinely worse side and the gap is non-zero.
    const magnitude =
      ratio >= 1.15
        ? `${ratio.toFixed(1)}× costlier on the ${worseSide.label} side`
        : `${Math.round(Math.abs(gap) * 100)} pts fewer good outcomes on the ${worseSide.label} side`;

    factors.push({ key: def.key, title: def.title, high: highSide, low: lowSide, verdict, magnitude });
  }

  factors.sort(
    (a, b) =>
      Math.abs(b.high.goodRate - b.low.goodRate) -
      Math.abs(a.high.goodRate - a.low.goodRate)
  );

  return {
    factors,
    labelledCount,
    proxyCount,
    totalSessions: perSession.length,
  };
}

/**
 * Per-session good/bad outcome map, reusing the SAME labels-first /
 * proxy-fallback rule {@link analyzeHabitImpact} applies to each split side.
 *
 * Computed exactly like the habit-impact view's internal anchoring: a session
 * you've tagged good/bad is taken at face value (anchor `'label'`); an untagged
 * session falls back to the cost+cleanliness proxy (cheaper than median,
 * at-or-below median tool-error rate, not compacted — majority of three =
 * "good", anchor `'proxy'`) against the SAME population medians this file
 * already computes. Exported so the tier-3 skill-candidate audit (#739) can
 * filter recurring tool trajectories down to the ones that ended successfully
 * without re-deriving the outcome rule.
 *
 * NOTE: the server passes an empty `tags` map (good/bad labels live in the
 * browser's localStorage, not the assembled dataset), so server-side every
 * outcome resolves via the proxy — which is the intended graceful fallback.
 */
export function computeSessionOutcomes(
  timelines: SessionTimeline[],
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  apiErrors: ApiErrorEvent[],
  tags: Map<string, SessionOutcomeTag>
): Map<string, { good: boolean; anchor: SessionOutcomeAnchor }> {
  const perSession = computeSessionMetrics(timelines, tokenData, toolData, apiErrors);
  const medians = {
    cost: median(perSession.map((m) => m.cost)),
    errorRate: median(perSession.map((m) => m.errorRate)),
  };
  const out = new Map<string, { good: boolean; anchor: SessionOutcomeAnchor }>();
  for (const m of perSession) {
    out.set(m.sessionId, sessionGoodOutcome(m, tags, medians));
  }
  return out;
}

export function describeSignature(sig: TimelineShapeSignature): string {
  const rhythm =
    sig.rhythm === 'rapid'
      ? 'rapid turns'
      : sig.rhythm === 'sparse'
        ? 'sparse turns'
        : 'sustained pace';
  const tools =
    sig.toolDensity === 'light'
      ? 'light tool use'
      : sig.toolDensity === 'heavy'
        ? 'heavy tool use'
        : 'medium tool use';
  const errors =
    sig.errorSpike === 'none'
      ? 'no errors'
      : sig.errorSpike === 'repeated'
        ? 'repeated errors'
        : 'sporadic errors';
  const compact = sig.hasCompaction ? 'compacted' : 'no compaction';
  return `${rhythm}, ${tools}, ${errors}, ${compact}, ${sig.duration}`;
}
