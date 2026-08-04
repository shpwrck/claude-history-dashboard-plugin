/**
 * Compaction-risk scoring.
 *
 * A complement to {@link ../lib/context-health.ts}. Where `context-health`
 * looks BACKWARDS ("how healthy was this session?"), this module looks
 * FORWARDS — "if this session keeps going, how likely is it to hit a
 * compaction (or spill past the window)?" — and turns each signal into a
 * concrete avoidance suggestion the user can paste or act on next time.
 *
 * Everything here is a HEURISTIC. The risk score is a weighted sum of
 * thresholded signals, NOT a calibrated probability. The UI is responsible
 * for being transparent about that.
 */
import type {
  SessionTokenData,
  TokenEntry,
} from '../types';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import { OVER_WINDOW } from './context-health';

// ── Heuristic thresholds ────────────────────────────────────────────────
// All exposed so the UI can mirror them in labels / tooltips without drifting.

/** Rolling window (assistant turns) over which `contextGrowthRate` is averaged. */
export const GROWTH_WINDOW_TURNS = 10;

/**
 * Tool-result size threshold above which a result is "large". `resultBytes`
 * is a character count (see parse-tools.ts), and ~4 chars/token is the rule
 * of thumb, so 20_000 chars ≈ 5K tokens.
 */
export const LARGE_TOOL_OUTPUT_BYTES = 20_000;

/** Context utilisation thresholds for risk-class bucketing (percent of 200K). */
export const PEAK_PCT_WARN = 50; // 100K / 200K
export const PEAK_PCT_HIGH = 80; // 160K / 200K

/** Per-turn growth thresholds, in tokens. */
export const GROWTH_PER_TURN_WARN = 5_000;
export const GROWTH_PER_TURN_HIGH = 15_000;

/** Large-tool-output rate thresholds (fraction of tool calls). */
export const LARGE_OUTPUT_RATE_WARN = 0.1;
export const LARGE_OUTPUT_RATE_HIGH = 0.25;

/** Re-read density thresholds (fraction of Read calls that are repeats). */
export const REREAD_DENSITY_WARN = 0.15;
export const REREAD_DENSITY_HIGH = 0.3;

/** Risk-score class boundaries (inclusive lower bound). */
export const RISK_MEDIUM = 30;
export const RISK_HIGH = 60;

export type RiskClass = 'low' | 'medium' | 'high';

export interface CompactionRiskRow {
  sessionId: string;
  /** Peak context utilisation as a percent of the 200K window (0-100+). */
  peakContextPct: number;
  /**
   * Average tokens added per assistant turn over the last
   * {@link GROWTH_WINDOW_TURNS} turns. Negative values are clamped to 0;
   * a compaction inside the window will pull this DOWN, which is the
   * right signal (less likely to compact again immediately).
   */
  contextGrowthRate: number;
  /**
   * Fraction (0-1) of tool calls whose result was larger than
   * {@link LARGE_TOOL_OUTPUT_BYTES} characters.
   */
  largeToolOutputRate: number;
  /**
   * Fraction (0-1) of Read calls that were repeats of a file already read
   * earlier in the same session. A cheap inline calc — does not depend on
   * the (sibling) file-reread parser.
   */
  repeatedReadDensity: number;
  /** Count of compaction events observed in this session. */
  compactionsObserved: number;
  /** Composite 0-100 risk score (higher = more likely to compact soon). */
  riskScore: number;
  riskClass: RiskClass;
  /**
   * Short context-size series (per assistant turn), provided so the UI can
   * render a sparkline without re-iterating the entries.
   */
  growthSeries: number[];
  /** Top contributing factor (one of `peak | growth | tool-output | reread`). */
  topFactor?: 'peak' | 'growth' | 'tool-output' | 'reread' | 'compactions';
  /** Avoidance suggestions, most actionable first. */
  suggestions: string[];
  /** Total tool calls in the session (denominator for largeToolOutputRate). */
  totalToolCalls: number;
  /** Total Read tool calls in the session (denominator for repeatedReadDensity). */
  totalReadCalls: number;
}

// ── Internal helpers ────────────────────────────────────────────────────

function contextSize(entry: TokenEntry): number {
  return entry.inputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
}

function peakContext(entries: TokenEntry[]): number {
  let peak = 0;
  for (const e of entries) {
    const c = contextSize(e);
    if (c > peak) peak = c;
  }
  return peak;
}

/**
 * Average per-turn token delta over the last `window` assistant entries.
 * Falls back to the full session if there are fewer than `window` entries.
 * Net-growth semantics: a compaction (a negative delta) reduces the total, so
 * a window that net-shrank reports 0.
 *
 * #3139: the previous implementation summed only POSITIVE deltas, so a
 * compaction drop inside the window did not pull the rate down at all. For a
 * 100k → 120k → 20k → 40k series it reported (20k + 20k) / 3 ≈ 13.3k tokens/turn
 * and could emit a "steady growth" suggestion immediately after a compaction —
 * a claim not reproducible from the documented net-delta calculation. Summing
 * the SIGNED aggregate delta and clamping the average to zero makes the reported
 * value the net expansion the docstring promises.
 */
function rollingGrowthPerTurn(entries: TokenEntry[], window: number): number {
  if (entries.length < 2) return 0;
  const slice = entries.slice(-Math.min(window, entries.length));
  if (slice.length < 2) return 0;
  let delta = 0;
  for (let i = 1; i < slice.length; i++) {
    delta += contextSize(slice[i]) - contextSize(slice[i - 1]);
  }
  // Average the SIGNED aggregate delta over the number of transitions, then
  // clamp: a net-shrinking window is not "growth".
  const transitions = slice.length - 1;
  return transitions > 0 ? Math.max(0, delta / transitions) : 0;
}

function growthSeries(entries: TokenEntry[]): number[] {
  if (entries.length === 0) return [];
  // Cap series length so the sparkline stays cheap to render.
  const MAX_POINTS = 60;
  if (entries.length <= MAX_POINTS) {
    return entries.map(contextSize);
  }
  // Down-sample by striding evenly so the shape survives.
  const step = entries.length / MAX_POINTS;
  const out: number[] = [];
  for (let i = 0; i < MAX_POINTS; i++) {
    const idx = Math.min(entries.length - 1, Math.floor(i * step));
    out.push(contextSize(entries[idx]));
  }
  return out;
}

function largeToolOutputRate(calls: ToolCall[]): number {
  if (calls.length === 0) return 0;
  let big = 0;
  for (const c of calls) {
    if (c.resultBytes >= LARGE_TOOL_OUTPUT_BYTES) big += 1;
  }
  return big / calls.length;
}

interface RereadStat {
  density: number;
  /** Most-repeated file path, if any. */
  topPath?: string;
  /** Times the top path was read in this session. */
  topReads: number;
  /** Total Read tool calls (denominator for density). */
  totalReadCalls: number;
}

/**
 * Re-read density = (Read calls beyond the first per path) / (total Read calls).
 * 0 when no file was Read more than once. Inline so this module does NOT
 * depend on the sibling reread parser (#5 / PR #104).
 */
function rereadStat(calls: ToolCall[]): RereadStat {
  let totalReads = 0;
  const perPath = new Map<string, number>();
  for (const c of calls) {
    if (c.toolName !== 'Read') continue;
    const path = c.input?.file_path;
    if (typeof path !== 'string' || path.length === 0) continue;
    totalReads += 1;
    perPath.set(path, (perPath.get(path) ?? 0) + 1);
  }
  if (totalReads === 0) return { density: 0, topReads: 0, totalReadCalls: 0 };
  let repeats = 0;
  let topPath: string | undefined;
  let topReads = 0;
  for (const [path, n] of perPath) {
    if (n > 1) repeats += n - 1;
    if (n > topReads) {
      topReads = n;
      topPath = path;
    }
  }
  return { density: repeats / totalReads, topPath, topReads, totalReadCalls: totalReads };
}

function classify(score: number): RiskClass {
  if (score >= RISK_HIGH) return 'high';
  if (score >= RISK_MEDIUM) return 'medium';
  return 'low';
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

// ── Suggestions ─────────────────────────────────────────────────────────

interface SuggestionInput {
  peakContextPct: number;
  contextGrowthRate: number;
  largeToolOutputRate: number;
  repeatedReadDensity: number;
  compactionsObserved: number;
  topReadPath?: string;
  topReadCount: number;
  largeToolCount: number;
  totalToolCalls: number;
}

function buildSuggestions(s: SuggestionInput): string[] {
  const out: string[] = [];

  if (s.peakContextPct >= PEAK_PCT_HIGH) {
    out.push(
      `Peaked at ${s.peakContextPct.toFixed(0)}% of the 200K window — run /compact before the next milestone, or /clear when switching tasks.`
    );
  } else if (s.peakContextPct >= PEAK_PCT_WARN) {
    out.push(
      `Context climbed to ${s.peakContextPct.toFixed(0)}% of the window — consider /compact at task boundaries to avoid an automatic compaction later.`
    );
  }

  if (s.repeatedReadDensity >= REREAD_DENSITY_WARN && s.topReadPath) {
    const file = basename(s.topReadPath);
    out.push(
      `Move documentation ${file} to CLAUDE.md instead of re-reading it — read ${s.topReadCount}× this session.`
    );
  }

  if (s.largeToolOutputRate >= LARGE_OUTPUT_RATE_WARN && s.totalToolCalls > 0) {
    out.push(
      `${s.largeToolCount} of ${s.totalToolCalls} tool calls returned >5K tokens — scope Reads with offset/limit and prefer Grep over cat for large files.`
    );
  }

  if (s.contextGrowthRate >= GROWTH_PER_TURN_HIGH) {
    out.push(
      `Context grew ~${formatTokensShort(s.contextGrowthRate)} tokens per turn — drop the largest attached file or split the task into focused sessions.`
    );
  } else if (s.contextGrowthRate >= GROWTH_PER_TURN_WARN) {
    out.push(
      `Steady ~${formatTokensShort(s.contextGrowthRate)} tokens/turn growth — pause to /compact between sub-tasks to keep cache hits high.`
    );
  }

  if (s.compactionsObserved >= 2) {
    out.push(
      `${s.compactionsObserved} compactions already occurred — consider /clear before resuming; carrying compacted summaries forward still costs cache tokens each turn.`
    );
  }

  return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────

interface ScoreParts {
  peak: number;
  growth: number;
  toolOutput: number;
  reread: number;
  compactions: number;
}

function scoreParts(args: {
  peakContextPct: number;
  contextGrowthRate: number;
  largeToolOutputRate: number;
  repeatedReadDensity: number;
  compactionsObserved: number;
}): ScoreParts {
  const { peakContextPct, contextGrowthRate, largeToolOutputRate, repeatedReadDensity, compactionsObserved } = args;

  // Peak: 0 below WARN, ramps to ~35 at the OVER_WINDOW line, capped at 40.
  let peak = 0;
  if (peakContextPct >= PEAK_PCT_HIGH) {
    peak = 25 + Math.min(15, ((peakContextPct - PEAK_PCT_HIGH) / 20) * 15);
  } else if (peakContextPct >= PEAK_PCT_WARN) {
    peak = ((peakContextPct - PEAK_PCT_WARN) / (PEAK_PCT_HIGH - PEAK_PCT_WARN)) * 25;
  }

  // Growth: 0 below WARN, 25 at HIGH and above (capped).
  let growth = 0;
  if (contextGrowthRate >= GROWTH_PER_TURN_HIGH) {
    growth = 25;
  } else if (contextGrowthRate >= GROWTH_PER_TURN_WARN) {
    growth =
      ((contextGrowthRate - GROWTH_PER_TURN_WARN) /
        (GROWTH_PER_TURN_HIGH - GROWTH_PER_TURN_WARN)) *
      25;
  }

  let toolOutput = 0;
  if (largeToolOutputRate >= LARGE_OUTPUT_RATE_HIGH) {
    toolOutput = 20;
  } else if (largeToolOutputRate >= LARGE_OUTPUT_RATE_WARN) {
    toolOutput =
      ((largeToolOutputRate - LARGE_OUTPUT_RATE_WARN) /
        (LARGE_OUTPUT_RATE_HIGH - LARGE_OUTPUT_RATE_WARN)) *
      20;
  }

  let reread = 0;
  if (repeatedReadDensity >= REREAD_DENSITY_HIGH) {
    reread = 15;
  } else if (repeatedReadDensity >= REREAD_DENSITY_WARN) {
    reread =
      ((repeatedReadDensity - REREAD_DENSITY_WARN) /
        (REREAD_DENSITY_HIGH - REREAD_DENSITY_WARN)) *
      15;
  }

  // Each compaction already observed is evidence the session generates
  // pressure faster than the cap allows. Linear, capped at 15.
  const compactions = Math.min(15, compactionsObserved * 7);

  return { peak, growth, toolOutput, reread, compactions };
}

function topFactor(parts: ScoreParts): CompactionRiskRow['topFactor'] {
  const entries: Array<[CompactionRiskRow['topFactor'], number]> = [
    ['peak', parts.peak],
    ['growth', parts.growth],
    ['tool-output', parts.toolOutput],
    ['reread', parts.reread],
    ['compactions', parts.compactions],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const [name, value] = entries[0];
  return value > 0 ? name : undefined;
}

// ── Public entry point ──────────────────────────────────────────────────

/**
 * Compute per-session compaction risk. Stable per `tokenData` ordering — the
 * caller is expected to sort the returned rows for display.
 *
 * `toolData` and `timelines` are optional: when missing, the corresponding
 * signals (`largeToolOutputRate`, `repeatedReadDensity`) drop to zero and
 * the score simply reflects the token-side signals. `timelines` is accepted
 * as part of the public signature so future signals (turn-level pacing,
 * tool-input bloat) can be added without breaking callers; it is not yet
 * read.
 */
export function computeCompactionRisk(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[] = [],
  timelines: SessionTimeline[] = []
): CompactionRiskRow[] {
  void timelines;
  const toolBySession = new Map<string, ToolUsageData>();
  for (const t of toolData) toolBySession.set(t.sessionId, t);

  const rows: CompactionRiskRow[] = [];

  for (const d of tokenData) {
    if (d.entries.length === 0) continue;
    const peak = peakContext(d.entries);
    const peakContextPct = (peak / OVER_WINDOW) * 100;
    const contextGrowthRate = rollingGrowthPerTurn(d.entries, GROWTH_WINDOW_TURNS);

    const calls = toolBySession.get(d.sessionId)?.calls ?? [];
    const largeRate = largeToolOutputRate(calls);
    const reread = rereadStat(calls);
    const compactionsObserved = d.compactionEvents.length;

    const parts = scoreParts({
      peakContextPct,
      contextGrowthRate,
      largeToolOutputRate: largeRate,
      repeatedReadDensity: reread.density,
      compactionsObserved,
    });
    const riskScore = Math.min(
      100,
      Math.round(parts.peak + parts.growth + parts.toolOutput + parts.reread + parts.compactions)
    );

    const largeToolCount = calls.filter((c) => c.resultBytes >= LARGE_TOOL_OUTPUT_BYTES).length;

    const suggestions = buildSuggestions({
      peakContextPct,
      contextGrowthRate,
      largeToolOutputRate: largeRate,
      repeatedReadDensity: reread.density,
      compactionsObserved,
      topReadPath: reread.topPath,
      topReadCount: reread.topReads,
      largeToolCount,
      totalToolCalls: calls.length,
    });

    rows.push({
      sessionId: d.sessionId,
      peakContextPct,
      contextGrowthRate,
      largeToolOutputRate: largeRate,
      repeatedReadDensity: reread.density,
      compactionsObserved,
      riskScore,
      riskClass: classify(riskScore),
      growthSeries: growthSeries(d.entries),
      topFactor: topFactor(parts),
      suggestions,
      totalToolCalls: calls.length,
      totalReadCalls: reread.totalReadCalls,
    });
  }

  return rows.sort((a, b) => b.riskScore - a.riskScore);
}

/**
 * Aggregate the most-common avoidable cause across hot (medium+high) sessions.
 * Used by the Recommendations card. Returns null when there is not enough
 * signal — fewer than one hot session or no suggestion text harvested.
 */
export interface CompactionRiskSummary {
  totalSessions: number;
  hotSessions: number;
  hotPercent: number;
  /** Most common first-suggestion across hot sessions. */
  topSuggestion?: string;
  /** Number of hot sessions whose top suggestion equals `topSuggestion`. */
  topSuggestionCount: number;
}

/**
 * Bucket the leading suggestion of each hot session into a small set of
 * coarse "themes" so the headline reads like a recommendation, not a
 * one-off message. Anything unknown maps to a generic fallback theme.
 */
function suggestionTheme(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('/clear')) return 'Run /clear when switching tasks';
  if (lower.includes('/compact')) return 'Run /compact at task boundaries';
  if (lower.includes('claude.md')) return 'Pin re-read files in CLAUDE.md';
  if (lower.includes('tool calls returned')) return 'Scope large tool outputs (Read offset/limit, prefer Grep)';
  if (lower.includes('grew ~') || lower.includes('tokens/turn')) return 'Split the task into focused sessions';
  return 'Adopt a context-discipline routine';
}

export function summarizeCompactionRisk(
  rows: CompactionRiskRow[]
): CompactionRiskSummary {
  const total = rows.length;
  const hot = rows.filter((r) => r.riskClass !== 'low');
  if (total === 0) {
    return {
      totalSessions: 0,
      hotSessions: 0,
      hotPercent: 0,
      topSuggestionCount: 0,
    };
  }
  const themeCounts = new Map<string, number>();
  for (const r of hot) {
    const first = r.suggestions[0];
    if (!first) continue;
    const theme = suggestionTheme(first);
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
  }
  let topSuggestion: string | undefined;
  let topSuggestionCount = 0;
  for (const [theme, n] of themeCounts) {
    if (n > topSuggestionCount) {
      topSuggestion = theme;
      topSuggestionCount = n;
    }
  }
  return {
    totalSessions: total,
    hotSessions: hot.length,
    hotPercent: (hot.length / total) * 100,
    topSuggestion,
    topSuggestionCount,
  };
}
