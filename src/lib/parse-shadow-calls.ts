/**
 * Parser for the shadow-calls experiment ledger (epic #513, slices #518/#523).
 *
 * The shadow-calls engine (tooling under `~/.claude/shadow-calls/`) runs the same task
 * two ways — Main vs one rotated-axis Shadow — and appends one JSON record per experiment
 * to `~/.claude/shadow-calls/ledger.jsonl`. This parser aggregates that ledger per AXIS so
 * the `workflow.shadow-axis-wins` detector can recommend adopting axes that consistently
 * win, **weighting live evidence above replay** (replay carries cold-start + staleness
 * caveats — see the epic).
 *
 * Pure + text-in (mirrors the other `parse-*.ts`): `parseShadowCalls(jsonlText)`. Malformed
 * lines are skipped. A missing/empty ledger yields a zeroed aggregate, so the detector
 * simply emits nothing.
 *
 * Records flagged `synthetic: true` (hand-seeded demo/batch rows, #570) are skipped — they
 * carry no real source task, so counting them would inflate an axis's `samples`/`shadowWins`
 * and skew the recommendation confidence with fabricated evidence.
 *
 * Record shape (subset we read; see ~/.claude/shadow-calls/SCHEMA.md for the full union):
 *   { mode: 'live'|'replay', axis: string, synthetic?: boolean,
 *     judge?: { winner?: 'main'|'shadow'|'tie' },
 *     main?: { tokens?: number }, shadow?: { tokens?: number } }
 */

export interface AxisAggregate {
  axis: string;
  samples: number;
  live: number;
  replay: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  /** Shadow wins seen under the higher-trust LIVE mode (drives confidence). */
  liveShadowWins: number;
  /** Σ(shadow.tokens − main.tokens) over records where both are known (negative ⇒ cheaper). */
  tokenDeltaSum: number;
  tokenDeltaCount: number;
  /**
   * Σ(shadow.costUsd − main.costUsd) over records where both run costs are known (#536).
   * Price-aware: a cheaper-tier model that used more tokens can still be cheaper in $.
   * Preferred over the raw-token delta when available.
   */
  costDeltaSum: number;
  costDeltaCount: number;
  /**
   * Per-finding sub-aggregate, populated ONLY for the `recs` axis (#579, ADR 0005 Tier 2).
   * Keyed by `record.recs.findingId`; undefined for every other axis. Mirrors the per-axis
   * verdict counters so a single finding can be evaluated in isolation ("finding F changed
   * behaviour in K/N replays") while the per-axis totals stay byte-identical.
   */
  byFinding?: Record<string, RecsFindingAggregate>;
}

/**
 * Per-finding counters for the `recs` axis (#579). Mirrors the subset of `AxisAggregate`
 * that drives a verdict — wins/losses/ties plus the live/replay split — bucketed by the
 * finding a recs shadow was injecting (`record.recs.findingId`).
 */
export interface RecsFindingAggregate {
  findingId: string;
  samples: number;
  shadowWins: number;
  mainWins: number;
  ties: number;
  live: number;
  replay: number;
}

export interface ShadowCallAggregate {
  total: number;
  byAxis: AxisAggregate[];
}

interface ShadowRecord {
  mode?: unknown;
  axis?: unknown;
  synthetic?: unknown;
  judge?: { winner?: unknown } | null;
  main?: { tokens?: unknown; costUsd?: unknown } | null;
  shadow?: { tokens?: unknown; costUsd?: unknown } | null;
  /** Recs-axis-only block written by the replay runner (`recsRecordFields()`). */
  recs?: {
    findingId?: unknown;
    treatment?: unknown;
    paraphraseOverlap?: unknown;
    redundant?: unknown;
  } | null;
}

function emptyFinding(findingId: string): RecsFindingAggregate {
  return {
    findingId,
    samples: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    live: 0,
    replay: 0,
  };
}

function emptyAxis(axis: string): AxisAggregate {
  return {
    axis,
    samples: 0,
    live: 0,
    replay: 0,
    shadowWins: 0,
    mainWins: 0,
    ties: 0,
    liveShadowWins: 0,
    tokenDeltaSum: 0,
    tokenDeltaCount: 0,
    costDeltaSum: 0,
    costDeltaCount: 0,
  };
}

export function parseShadowCalls(
  jsonlText: string | null | undefined
): ShadowCallAggregate {
  const byAxis = new Map<string, AxisAggregate>();
  let total = 0;
  if (!jsonlText) return { total: 0, byAxis: [] };

  for (const line of jsonlText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: ShadowRecord;
    try {
      rec = JSON.parse(trimmed) as ShadowRecord;
    } catch {
      continue;
    }
    // Skip hand-seeded demo/batch rows (#570): no real source task, so they'd fabricate evidence.
    if (rec.synthetic === true) continue;
    const axis = typeof rec.axis === 'string' ? rec.axis : null;
    const mode = rec.mode === 'live' || rec.mode === 'replay' ? rec.mode : null;
    if (!axis || !mode) continue;

    total++;
    let a = byAxis.get(axis);
    if (!a) {
      a = emptyAxis(axis);
      byAxis.set(axis, a);
    }
    a.samples++;
    if (mode === 'live') a.live++;
    else a.replay++;

    const winner = rec.judge?.winner;
    if (winner === 'shadow') {
      a.shadowWins++;
      if (mode === 'live') a.liveShadowWins++;
    } else if (winner === 'main') {
      a.mainWins++;
    } else if (winner === 'tie') {
      a.ties++;
    }

    // Per-finding sub-aggregate, recs axis only (#579). Additive: reuses the same `winner`
    // mapping and the `synthetic:true` skip already applied to the per-axis totals above.
    if (axis === 'recs') {
      const findingId =
        rec.recs && typeof rec.recs.findingId === 'string' ? rec.recs.findingId : null;
      if (findingId) {
        if (!a.byFinding) a.byFinding = {};
        let f = a.byFinding[findingId];
        if (!f) {
          f = emptyFinding(findingId);
          a.byFinding[findingId] = f;
        }
        f.samples++;
        if (mode === 'live') f.live++;
        else f.replay++;
        if (winner === 'shadow') f.shadowWins++;
        else if (winner === 'main') f.mainWins++;
        else if (winner === 'tie') f.ties++;
      }
    }

    const ms = rec.main?.tokens;
    const ss = rec.shadow?.tokens;
    if (typeof ms === 'number' && typeof ss === 'number') {
      a.tokenDeltaSum += ss - ms;
      a.tokenDeltaCount++;
    }

    const mc = rec.main?.costUsd;
    const sc = rec.shadow?.costUsd;
    if (typeof mc === 'number' && typeof sc === 'number') {
      a.costDeltaSum += sc - mc;
      a.costDeltaCount++;
    }
  }

  // Stable, deterministic order (by axis key) so the detector + ETag stay stable.
  const sorted = [...byAxis.values()].sort((x, y) => x.axis.localeCompare(y.axis));
  return { total, byAxis: sorted };
}

/** Mean token delta for an axis (shadow − main), or null when no paired token data. */
export function avgTokenDelta(a: AxisAggregate): number | null {
  return a.tokenDeltaCount > 0 ? a.tokenDeltaSum / a.tokenDeltaCount : null;
}

/** Mean $ cost delta for an axis (shadow − main), or null when no paired cost data (#536). */
export function avgCostDelta(a: AxisAggregate): number | null {
  return a.costDeltaCount > 0 ? a.costDeltaSum / a.costDeltaCount : null;
}

/**
 * Is the shadow variation cheaper for this axis? Price-aware ($) when available (#536),
 * else falls back to raw tokens. Returns null when neither signal is present.
 */
export function shadowCheaper(a: AxisAggregate): boolean | null {
  const cost = avgCostDelta(a);
  if (cost !== null) return cost < 0;
  const tok = avgTokenDelta(a);
  return tok !== null ? tok < 0 : null;
}

/**
 * Decided comparisons for a single recs finding: shadow wins + main wins, ties excluded
 * (parity with the per-axis decided rule, #545). #579 reuses this to gate its per-finding
 * efficacy verdict on a minimum number of decided samples.
 */
export function decidedForFinding(f: RecsFindingAggregate): number {
  return f.shadowWins + f.mainWins;
}
