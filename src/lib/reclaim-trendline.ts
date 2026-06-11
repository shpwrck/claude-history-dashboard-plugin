/**
 * Reclaim-trendline + coverage-gauge derivation (epic #944, PR6 — issue #952).
 *
 * Pure `src/lib` math that turns the guarded-marginal cascade
 * ({@link runReclaimCascade}/{@link rollupCascade} in `./reclaim`) into the two
 * UI surfaces `CostAttribution.tsx` renders — the visible payoff of the compass
 * reframe (#724, `docs/v0.3-efficiency-accounting.md` §1/§4):
 *
 *  1. **Reclaim trendline** — per ISO week, two lines: `baseline(p)` = the
 *     repriced ACTUAL bill (the cascade's `billOriginal` over that week's token
 *     slice) and `baseline(p) − reclaim(p)` (its `billFinal`). The GAP between
 *     them is the reclaim and its SLOPE is the compass needle. Because the
 *     baseline is the actual bill (never a frozen snapshot) there is nothing to
 *     game (§4 "coverage gauge & trendline").
 *
 *  2. **Coverage gauge** — an INDEPENDENT gauge reading
 *     `price(claimed cells) / repriced totalBill` over the WHOLE window: "the
 *     engine has a dollar opinion on X% of your real bill". It is plotted
 *     SEPARATELY from the trendline and is NEVER multiplied into it (§4: "plotted
 *     separately, never multiplied"). Numerator = the priced set-union of every
 *     category's addressed cells (so overlapping claims count a cell once);
 *     denominator = the repriced bill.
 *
 *  3. **Per-lever marginal** — each lever's booked marginal "given the levers
 *     above it" (`byLever` from the cascade), the cause-first cascade attribution
 *     so each row equals the counterfactual the user can independently act on.
 *
 * This module computes ONLY over the data CostAttribution already receives
 * (`Recommendation[]` claims + `SessionTokenData[]`). No new server call — it
 * routes everything through the existing rollup, so `spa-boundary` stays green.
 */
import { isoWeekStart } from './weekly-delta';
import {
  runReclaimCascade,
  rollupCascade,
  type ReclaimClaim,
  type CategoryCoverage,
} from './reclaim';
import type { RecCategory } from './detectors/types';
import type { Recommendation } from './detectors/types';
import type { SessionTokenData, TokenEntry } from '../types';

/** One ISO-week point on the reclaim trendline. */
export interface ReclaimWeekPoint {
  /** ISO week start (Monday, UTC) `YYYY-MM-DD` — the x label. */
  week: string;
  /** `baseline(p)` — the repriced ACTUAL bill for the week (cascade billOriginal). */
  baseline: number;
  /** `baseline(p) − reclaim(p)` — the bill after every booked counterfactual. */
  afterReclaim: number;
  /** `reclaim(p)` = `baseline − afterReclaim` — the gap the slope tracks. */
  reclaim: number;
}

/** One per-lever marginal row ("marginal given the levers above it"). */
export interface LeverMarginal {
  /** Stable lever id (`${category}.${slug}`), the cascade grouping key. */
  leverId: string;
  /** The marginal USD this lever booked against the running residual. */
  marginalUsd: number;
}

/** The independent coverage gauge — never multiplied into the trendline. */
export interface CoverageGauge {
  /** Priced value of the cell-union every claim addresses (≤ `totalBill`). */
  claimedUsd: number;
  /** The repriced actual bill — the denominator. */
  totalBill: number;
  /** `claimedUsd / totalBill` in [0,1] (0 when the bill is empty). */
  coverage: number;
}

/** Everything the CostAttribution reclaim cards need, all from the rollup. */
export interface ReclaimTrendlineData {
  /** Per-ISO-week trendline points, ascending by week. */
  points: ReclaimWeekPoint[];
  /** The window-wide independent coverage gauge. */
  gauge: CoverageGauge;
  /** Per-lever marginal, descending by booked USD. */
  levers: LeverMarginal[];
  /** Window-wide reclaim total (`sum(marginal)` ≡ `billOriginal − billFinal`). */
  totalReclaim: number;
}

/** The claims a rec list carries, in stable rec order (mirrors recommendations.ts). */
function claimsOf(recs: Recommendation[]): ReclaimClaim[] {
  const claims: ReclaimClaim[] = [];
  for (const rec of recs) if (rec.reclaim) claims.push(rec.reclaim);
  return claims;
}

/** The ISO-week start of a token entry's timestamp, or null when unparseable. */
function entryWeek(entry: TokenEntry): string | null {
  const t = new Date(entry.timestamp).getTime();
  if (!Number.isFinite(t)) return null;
  return isoWeekStart(new Date(t).toISOString().slice(0, 10));
}

/**
 * Split `tokenData` into per-ISO-week slices, partitioning each session's
 * `entries` by the entry's own timestamp so a session spanning two weeks
 * contributes its spend to each week it touched (the residual matrix is keyed by
 * `(sessionId, model)`, so a per-week slice naturally scopes the cascade to that
 * week's tokens). Returns a map week → that week's `SessionTokenData[]`.
 */
function sliceByWeek(tokenData: SessionTokenData[]): Map<string, SessionTokenData[]> {
  const byWeek = new Map<string, Map<string, SessionTokenData>>();
  for (const d of tokenData) {
    for (const entry of d.entries) {
      const week = entryWeek(entry);
      if (!week) continue;
      let sessions = byWeek.get(week);
      if (!sessions) {
        sessions = new Map<string, SessionTokenData>();
        byWeek.set(week, sessions);
      }
      let slice = sessions.get(d.sessionId);
      if (!slice) {
        // A shallow clone with an empty `entries` list: the cascade reads only
        // `sessionId` + `entries`, so we copy the dimensions and re-bucket entries.
        slice = { ...d, entries: [] };
        sessions.set(d.sessionId, slice);
      }
      slice.entries.push(entry);
    }
  }
  const out = new Map<string, SessionTokenData[]>();
  for (const [week, sessions] of byWeek) out.set(week, [...sessions.values()]);
  return out;
}

/**
 * Build the reclaim trendline + coverage gauge from the cascade.
 *
 * - **Trendline:** the cascade is run once PER ISO-week slice of `tokenData`, so
 *   each week's `baseline` is its own repriced actual bill and `afterReclaim` is
 *   its post-counterfactual bill. The same `claims` are passed to every week;
 *   their `scopeKeys` only resolve to that week's sessions, so a week naturally
 *   books only the reclaim of the spend it contains.
 * - **Gauge & levers:** computed ONCE over the whole window (a single cascade run
 *   over all `tokenData`), so the gauge is `price(claimed) / totalBill` across the
 *   period and is decoupled from the per-week trendline — it is never multiplied
 *   into any trendline series.
 *
 * `onReject` is forwarded to every cascade run (defaulting to a no-op here so the
 * UI does not spam the console; the engine path keeps its own `console.warn`).
 */
export function buildReclaimTrendline(
  recs: Recommendation[],
  tokenData: SessionTokenData[],
  onReject: (msg: string) => void = () => {}
): ReclaimTrendlineData {
  const claims = claimsOf(recs);

  // Window-wide cascade → the independent coverage gauge + per-lever marginal.
  const whole = rollupCascade(runReclaimCascade(claims, tokenData, onReject));
  const gauge = coverageGauge(whole.coverageByCategory, whole.totalBill);
  const levers: LeverMarginal[] = Object.entries(whole.byLever)
    .map(([leverId, marginalUsd]) => ({ leverId, marginalUsd }))
    .sort((a, b) => b.marginalUsd - a.marginalUsd);

  // Per-week cascade → the two trendline series.
  const weeks = sliceByWeek(tokenData);
  const points: ReclaimWeekPoint[] = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, slice]) => {
      const r = runReclaimCascade(claims, slice, onReject);
      return {
        week,
        baseline: r.billOriginal,
        afterReclaim: r.billFinal,
        reclaim: r.total,
      };
    });

  return { points, gauge, levers, totalReclaim: whole.total };
}

/**
 * Collapse the cascade's per-category coverage into a single window-wide gauge:
 * the priced set-union of EVERY category's addressed cells over the repriced
 * `totalBill`. Categories address disjoint OR overlapping cells; the cascade
 * already unions within a category, but two categories can pin the same cell, so
 * we re-union across categories on the cell-priced figures.
 *
 * Because the per-category `claimedUsd` figures may double-count a cell two
 * categories both address, summing them could exceed `totalBill`. We therefore
 * clamp the numerator to `totalBill` (belt-and-suspenders, matching the cascade's
 * own per-category clamp) so `coverage` stays in [0,1]. The gauge stays a pure
 * reporting figure — it is never multiplied into the dollar identity.
 */
function coverageGauge(
  coverageByCategory: Partial<Record<RecCategory, CategoryCoverage>>,
  totalBill: number
): CoverageGauge {
  let claimedUsd = 0;
  for (const cov of Object.values(coverageByCategory)) {
    if (cov) claimedUsd += cov.claimedUsd;
  }
  claimedUsd = Math.min(claimedUsd, totalBill);
  return {
    claimedUsd,
    totalBill,
    coverage: totalBill > 0 ? claimedUsd / totalBill : 0,
  };
}
