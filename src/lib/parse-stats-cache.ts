/**
 * Parser for `~/.claude/stats-cache.json` — the CLI-precomputed daily activity rollup.
 *
 * The Claude Code CLI writes a `stats-cache.json` file containing pre-aggregated
 * `dailyActivity[]` rows (one per calendar day), plus metadata. Reading this file
 * gives the dashboard a daily activity sparkline + week-over-week verdict at zero
 * re-aggregation cost — no transcript replay required. The analyzer faithfully ports
 * the WoW computation from the P1-Sam prototype (branch `proto/539-stats-cache`).
 *
 * Artifact path: `~/.claude/stats-cache.json`
 * Server-only: NO — only the live file READ is server-side (`scripts/server.mjs`).
 * The parser also runs in the SPA upload path (`upload-artifacts.ts` →
 * `upload-dataset.ts`) and the result renders in `UsagePulsePf`.
 *
 * See issue #563 for the full design and persona (P1 Sam).
 */

// ── Public types ──────────────────────────────────────────────────────────

export interface DailyActivity {
  /** ISO date string `YYYY-MM-DD`. */
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsCache {
  /** Schema version emitted by the CLI (currently 3). */
  version: number;
  /** ISO date string of the last time the CLI recomputed this file. */
  lastComputedDate: string;
  /** Chronological array of daily activity rows. */
  dailyActivity: DailyActivity[];
}

// ── Week-over-week analysis types ─────────────────────────────────────────

export type ActivityVerdict = 'hotter' | 'cooler' | 'flat';

export interface WoWMetrics {
  /** Sum for the 7 most-recent days. */
  thisWeek: number;
  /** Sum for the 7 days prior to that. */
  lastWeek: number;
  /** Rounded integer percentage change: ((thisWeek - lastWeek) / lastWeek) * 100. */
  pctChange: number;
}

/**
 * The 14-day sparkline series and week-over-week verdict produced by
 * `analyzeActivityTrend`. Designed for the daily-activity card (persona P1 Sam).
 */
export interface ActivityTrendAnalysis {
  /** Tool-call WoW comparison. Primary signal (drives the headline verdict). */
  toolCallCount: WoWMetrics;
  /** Session WoW comparison. */
  sessionCount: WoWMetrics;
  /** Message WoW comparison. */
  messageCount: WoWMetrics;
  /**
   * 14-day `toolCallCount` series (oldest-first), clipped to the last 14 rows
   * of `dailyActivity[]`. Fewer than 14 entries if the cache is young.
   */
  sparkline: number[];
  /**
   * 'hotter' = toolCallCount WoW >= +15%
   * 'cooler' = toolCallCount WoW <= -15%
   * 'flat'   = within [-15%, +15%)
   */
  verdict: ActivityVerdict;
  /** Absolute magnitude of the toolCallCount pctChange (convenience). */
  magnitude: number;
  /**
   * True when `lastComputedDate` is more than 2 calendar days in the past
   * relative to the `now` passed to `analyzeActivityTrend`. Indicates the CLI
   * has not been run recently and the data may be stale.
   */
  stale: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function isIsoCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const timestamp = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === v;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function safeDailyActivity(raw: unknown): DailyActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isIsoCalendarDate(r.date)) return null;
  if (
    !isNonNegativeFiniteNumber(r.messageCount) ||
    !isNonNegativeFiniteNumber(r.sessionCount) ||
    !isNonNegativeFiniteNumber(r.toolCallCount)
  ) {
    return null;
  }
  return {
    date: r.date,
    messageCount: r.messageCount,
    sessionCount: r.sessionCount,
    toolCallCount: r.toolCallCount,
  };
}

function sumField(rows: DailyActivity[], field: keyof DailyActivity): number {
  return rows.reduce((acc, r) => acc + (r[field] as number), 0);
}

/** Rounded WoW pct: ((b - a) / a) * 100. When lastWeek = 0 and thisWeek > 0: 100. */
function wowPct(lastWeek: number, thisWeek: number): number {
  if (lastWeek === 0) return thisWeek > 0 ? 100 : 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
}

function wowMetrics(
  lastRows: DailyActivity[],
  thisRows: DailyActivity[],
  field: keyof DailyActivity
): WoWMetrics {
  const lastWeek = sumField(lastRows, field);
  const thisWeek = sumField(thisRows, field);
  return { thisWeek, lastWeek, pctChange: wowPct(lastWeek, thisWeek) };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Parse the raw text content of `~/.claude/stats-cache.json`.
 * Returns `null` on any parse failure or if the file lacks the required shape.
 * Malformed `dailyActivity` rows are skipped rather than failing the whole parse.
 */
export function parseStatsCache(text: string | null | undefined): StatsCache | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const version = isFiniteNumber(r.version) ? r.version : 0;
  if (!isIsoCalendarDate(r.lastComputedDate)) return null;
  const lastComputedDate = r.lastComputedDate;

  const rawRows = Array.isArray(r.dailyActivity) ? r.dailyActivity : [];
  const dailyActivity: DailyActivity[] = rawRows
    .map(safeDailyActivity)
    .filter((d): d is DailyActivity => d !== null)
    .sort((a, b) => a.date.localeCompare(b.date)); // ensure chronological order

  return { version, lastComputedDate, dailyActivity };
}

/**
 * Compute week-over-week metrics, the 14-day sparkline, and a staleness flag.
 *
 * The WoW split is always the last 14 rows of `dailyActivity[]`:
 *   - `lastWeek` = rows at positions [-14..-8] (older 7)
 *   - `thisWeek` = rows at positions [-7..]   (recent 7)
 *
 * Faithfully ports the prototype JS (`proto/539-stats-cache`):
 *   `last7 = days.slice(-14, -7)`; `this7 = days.slice(-7)`.
 *
 * @param cache    Parsed stats cache (from `parseStatsCache`).
 * @param nowMs    Current timestamp in ms (default: `Date.now()`). Used only for
 *                 the staleness check.
 */
export function analyzeActivityTrend(
  cache: StatsCache,
  nowMs: number = Date.now()
): ActivityTrendAnalysis {
  const days = cache.dailyActivity;
  const lastRows = days.slice(-14, -7); // older 7 of the window
  const thisRows = days.slice(-7);       // most-recent 7

  const toolCall = wowMetrics(lastRows, thisRows, 'toolCallCount');
  const session = wowMetrics(lastRows, thisRows, 'sessionCount');
  const message = wowMetrics(lastRows, thisRows, 'messageCount');

  const sparkline = days.slice(-14).map((d) => d.toolCallCount);

  const pct = toolCall.pctChange;
  const verdict: ActivityVerdict = pct >= 15 ? 'hotter' : pct <= -15 ? 'cooler' : 'flat';
  const magnitude = Math.abs(pct);

  // Staleness: lastComputedDate more than 2 days before now.
  let stale = false;
  if (cache.lastComputedDate) {
    const computedMs = new Date(cache.lastComputedDate).getTime();
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    stale = nowMs - computedMs > TWO_DAYS_MS;
  }

  return {
    toolCallCount: toolCall,
    sessionCount: session,
    messageCount: message,
    sparkline,
    verdict,
    magnitude,
    stale,
  };
}
