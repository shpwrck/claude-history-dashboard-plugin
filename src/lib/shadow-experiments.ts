/**
 * Per-experiment rows over the shadow-calls ledger (#2152/#2153, epic #2147).
 *
 * `parse-shadow-calls.ts` folds the ledger into per-axis / per-(source, axis)
 * AGGREGATES for the detectors; this module is the complementary flat read: one
 * row per ledger line, keeping every line's disposition (counted / synthetic /
 * skipped, #2149) on the surface so an individual experiment can be inspected,
 * filtered, and sorted in the drill-down log — and so the dedicated
 * `/api/shadow-experiments.json` route can serve experiment data without
 * shipping the whole dataset blob.
 *
 * Pure + text-in like the other parsers. Volume-bounded: `maxRows` keeps the
 * NEWEST rows (the ledger is append-only, so the suffix is the fresh evidence)
 * and reports how many older lines were dropped — a bound is never silent.
 */

import {
  classifyExperimentSource,
  classifyShadowRecord,
  normalizeExperimentProofStatus,
  normalizeExperimentTimestamp,
  normalizeExperimentVariation,
  type ExperimentProofStatus,
} from './parse-shadow-calls';

export interface ExperimentRow {
  /**
   * 1-based line number within the PARSED WINDOW — a stable row identity for
   * one snapshot. When the reader tail-capped the ledger (#2152) the window is
   * a suffix, so this is NOT the absolute ledger line number; consumers label
   * it "row", not "ledger line".
   */
  line: number;
  /** ISO-8601 timestamp when the record carried a parseable `ts`, else null. */
  ts: string | null;
  /** Experiment source per the #2150 taxonomy (explicit stamp or fallback). */
  source: string;
  axis: string | null;
  /** The record's `mode` verbatim (`live`, `replay`, `replay-skip`, ...), null when absent. */
  mode: string | null;
  /** Which #2149 counting bucket the line landed in — never hidden. */
  disposition: 'counted' | 'synthetic' | 'skipped';
  /** Why a `skipped` row skipped; null for counted/synthetic rows. */
  skipReason: 'malformed' | 'no-axis' | 'bad-mode' | null;
  winner: 'main' | 'shadow' | 'tie' | null;
  /** Short human handle for the source task, when the record carried one. */
  task: string | null;
  /** The varied thing the shadow arm changed, when carried (SCHEMA.md `variation`). */
  variation: string | null;
  /** Explicit proof freshness carried by the receipt; never inferred from source/mode. */
  proofStatus: ExperimentProofStatus | null;
  /** The judge's stated basis/rationale for the verdict, when carried. */
  judgeBasis: string | null;
  mainTokens: number | null;
  shadowTokens: number | null;
  mainCostUsd: number | null;
  shadowCostUsd: number | null;
  /** shadow − main tokens when both known (negative ⇒ shadow leaner). */
  tokenDelta: number | null;
  /** shadow − main $ when both known (negative ⇒ shadow cheaper, #536). */
  costDelta: number | null;
}

export interface ExperimentRowsResult {
  /** Rows in ledger (chronological append) order. */
  rows: ExperimentRow[];
  /** Every non-empty ledger line seen — matches the aggregate's `total`. */
  total: number;
  /** Older lines dropped by the `maxRows` bound (0 when nothing was dropped). */
  dropped: number;
  /**
   * Whole-ledger disposition counts, computed over EVERY line BEFORE the
   * `maxRows` drop — so `counted + synthetic + skipped === total` holds even
   * when `rows` is a bounded suffix, and a consumer's headline reconciles.
   */
  counted: number;
  synthetic: number;
  skipped: number;
}

/** Default row bound — high enough for years at current volume, never silent (see `dropped`). */
export const DEFAULT_MAX_ROWS = 5000;

function str(v: unknown, maxLen = 300): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface RawRecord {
  ts?: unknown;
  mode?: unknown;
  axis?: unknown;
  synthetic?: unknown;
  source?: unknown;
  /** Race-writer-only field — classifyExperimentSource attributes unstamped race rows by it (#2151). */
  raceGoal?: unknown;
  task?: unknown;
  variation?: unknown;
  revalidationStatus?: unknown;
  judge?: { winner?: unknown; basis?: unknown; rationale?: unknown; reason?: unknown } | null;
  main?: { tokens?: unknown; costUsd?: unknown } | null;
  shadow?: { tokens?: unknown; costUsd?: unknown } | null;
}

/**
 * Flatten the ledger into per-experiment rows. Every non-empty line yields
 * exactly one row (bucketed exactly like the #2149 aggregate), so
 * `rows.length + dropped === total` and the log reconciles against both the
 * aggregate and the raw ledger.
 */
export function parseShadowCallRows(
  jsonlText: string | null | undefined,
  { maxRows = DEFAULT_MAX_ROWS }: { maxRows?: number } = {}
): ExperimentRowsResult {
  const rows: ExperimentRow[] = [];
  let total = 0;
  let counted = 0;
  let synthetic = 0;
  let skipped = 0;
  if (!jsonlText) return { rows, total: 0, dropped: 0, counted: 0, synthetic: 0, skipped: 0 };

  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;

    const base: ExperimentRow = {
      line: total,
      ts: null,
      // 'unknown' is honest for a row that never parsed: attributing junk to
      // the organic 'live' stream would fabricate provenance.
      source: 'unknown',
      axis: null,
      mode: null,
      disposition: 'skipped',
      skipReason: 'malformed',
      winner: null,
      task: null,
      variation: null,
      proofStatus: null,
      judgeBasis: null,
      mainTokens: null,
      shadowTokens: null,
      mainCostUsd: null,
      shadowCostUsd: null,
      tokenDelta: null,
      costDelta: null,
    };

    let rec: RawRecord;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Valid-but-non-object JSON (`null`, `5`, `"x"`) is malformed for our
      // purposes — without this guard a bare `null` line would throw on the
      // property reads below and 500 the whole experiments route.
      if (typeof parsed !== 'object' || parsed === null) {
        skipped++;
        rows.push(base);
        continue;
      }
      rec = parsed as RawRecord;
    } catch {
      skipped++;
      rows.push(base); // malformed line — surfaced as a row, not dropped (#2149 parity)
      continue;
    }

    // The disposition comes from the SAME rule the aggregate parser uses
    // (classifyShadowRecord), so the log can never disagree with the headline.
    const cls = classifyShadowRecord(rec);
    const winner = rec.judge?.winner;
    // Source: the taxonomy fallback assumes a valid live/replay mode; a row the
    // engine skipped (`replay-skip`, bad mode) without an explicit stamp gets
    // 'unknown' rather than being misattributed to the organic 'live' stream.
    const hasStamp = typeof rec.source === 'string' && rec.source.trim() !== '';
    const source =
      hasStamp || cls.mode !== null || rec.axis === 'config-scoping'
        ? classifyExperimentSource(rec)
        : 'unknown';

    const row: ExperimentRow = {
      ...base,
      ts: normalizeExperimentTimestamp(rec.ts),
      source,
      axis: cls.axis,
      mode: typeof rec.mode === 'string' ? rec.mode : null,
      disposition: cls.disposition,
      skipReason: cls.skipReason,
      winner:
        winner === 'main' || winner === 'shadow' || winner === 'tie' ? winner : null,
      task: str(rec.task, 200),
      variation: normalizeExperimentVariation(rec.variation),
      proofStatus: normalizeExperimentProofStatus(rec.revalidationStatus),
      judgeBasis:
        str(rec.judge?.basis) ?? str(rec.judge?.rationale) ?? str(rec.judge?.reason),
      mainTokens: num(rec.main?.tokens),
      shadowTokens: num(rec.shadow?.tokens),
      mainCostUsd: num(rec.main?.costUsd),
      shadowCostUsd: num(rec.shadow?.costUsd),
    };
    if (row.mainTokens !== null && row.shadowTokens !== null) {
      row.tokenDelta = row.shadowTokens - row.mainTokens;
    }
    if (row.mainCostUsd !== null && row.shadowCostUsd !== null) {
      row.costDelta = row.shadowCostUsd - row.mainCostUsd;
    }
    if (cls.disposition === 'counted') counted++;
    else if (cls.disposition === 'synthetic') synthetic++;
    else skipped++;

    rows.push(row);
  }

  // Volume bound: keep the NEWEST rows (ledger is append-only), report the cut.
  // The disposition counts above are whole-ledger (pre-drop) on purpose.
  if (rows.length > maxRows) {
    const dropped = rows.length - maxRows;
    return { rows: rows.slice(dropped), total, dropped, counted, synthetic, skipped };
  }
  return { rows, total, dropped: 0, counted, synthetic, skipped };
}

/** Shared filter-dropdown sentinel for "no filter" (log + trends cards, #2153/#2154). */
export const ANY_FILTER = '(all)';

/**
 * Distinct non-null values of one row field, sorted — the option list for a
 * filter dropdown. Shared by the log and trends cards so their dropdowns can
 * never drift apart. Pass `predicate` to restrict which rows contribute
 * (e.g. counted rows only for the trends).
 */
export function uniqueValues(
  rows: ExperimentRow[],
  pick: (r: ExperimentRow) => string | null,
  predicate?: (r: ExperimentRow) => boolean
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (predicate && !predicate(r)) continue;
    const v = pick(r);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** One UTC day of the experiment stream (#2154). */
export interface ExperimentTrendBucket {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Counted experiments that day. */
  total: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  costDeltaSum: number;
  costDeltaCount: number;
  tokenDeltaSum: number;
  tokenDeltaCount: number;
}

export interface ExperimentTrendsResult {
  /** Contiguous UTC-day buckets, oldest → newest; gap days present with zeros. */
  buckets: ExperimentTrendBucket[];
  /** Counted rows that carried no parseable `ts` and so appear in no bucket. */
  untimed: number;
  /** Timed counted rows older than the `maxDays` window, excluded from `buckets`. */
  beforeWindow: number;
}

/** Longest contiguous day window the trend covers — bounds a stray epoch-zero ts. */
export const DEFAULT_TREND_MAX_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyBucket(day: string): ExperimentTrendBucket {
  return {
    day,
    total: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    costDeltaSum: 0,
    costDeltaCount: 0,
    tokenDeltaSum: 0,
    tokenDeltaCount: 0,
  };
}

/**
 * Bucket COUNTED experiment rows into contiguous UTC days keyed on the record
 * `ts` (#2154). Empty days inside the range are real zero buckets (a gap in the
 * stream is signal, not a plotting artifact), the window is bounded to the
 * newest `maxDays` days (`beforeWindow` reports what fell off, never silently),
 * and rows without a parseable `ts` are surfaced as `untimed`. Synthetic and
 * skipped rows never trend — the trend is real evidence only, like `byAxis`.
 * Callers filter `rows` by axis/source BEFORE bucketing to slice the trend.
 */
export function bucketExperimentTrends(
  rows: ExperimentRow[],
  { maxDays = DEFAULT_TREND_MAX_DAYS }: { maxDays?: number } = {}
): ExperimentTrendsResult {
  const byDay = new Map<string, ExperimentTrendBucket>();
  let untimed = 0;
  let minDayMs = Number.POSITIVE_INFINITY;
  let maxDayMs = Number.NEGATIVE_INFINITY;

  const timed: { dayMs: number; row: ExperimentRow }[] = [];
  for (const row of rows) {
    if (row.disposition !== 'counted') continue;
    const ms = row.ts ? Date.parse(row.ts) : NaN;
    if (Number.isNaN(ms)) {
      untimed++;
      continue;
    }
    const dayMs = Math.floor(ms / DAY_MS) * DAY_MS;
    timed.push({ dayMs, row });
    if (dayMs < minDayMs) minDayMs = dayMs;
    if (dayMs > maxDayMs) maxDayMs = dayMs;
  }
  if (timed.length === 0) return { buckets: [], untimed, beforeWindow: 0 };

  // Bound the window to the newest maxDays days so one stray ancient timestamp
  // cannot explode the gap fill; what falls off is counted, not hidden.
  const windowStartMs = Math.max(minDayMs, maxDayMs - (maxDays - 1) * DAY_MS);
  let beforeWindow = 0;
  // The fill starts at the oldest KEPT row's day (not the theoretical window
  // edge), so a sparse window plots its real span without leading zero days.
  let firstKeptDayMs = maxDayMs;

  for (const { dayMs, row } of timed) {
    if (dayMs < windowStartMs) {
      beforeWindow++;
      continue;
    }
    if (dayMs < firstKeptDayMs) firstKeptDayMs = dayMs;
    const day = new Date(dayMs).toISOString().slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = emptyBucket(day);
      byDay.set(day, bucket);
    }
    bucket.total++;
    if (row.winner === 'shadow') bucket.shadowWins++;
    else if (row.winner === 'main') bucket.mainWins++;
    else if (row.winner === 'tie') bucket.ties++;
    if (row.costDelta !== null) {
      bucket.costDeltaSum += row.costDelta;
      bucket.costDeltaCount++;
    }
    if (row.tokenDelta !== null) {
      bucket.tokenDeltaSum += row.tokenDelta;
      bucket.tokenDeltaCount++;
    }
  }

  const buckets: ExperimentTrendBucket[] = [];
  for (let ms = firstKeptDayMs; ms <= maxDayMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    buckets.push(byDay.get(day) ?? emptyBucket(day));
  }
  return { buckets, untimed, beforeWindow };
}
