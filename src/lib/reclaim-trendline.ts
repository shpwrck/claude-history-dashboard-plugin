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
  scopeKeyOf,
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

/** A reclaim claim the guarded cascade could not safely book. */
export interface ReclaimRejection {
  /** Stable lever id reported by the cascade diagnostic. */
  leverId: string;
  /** Human-readable rejection reason. */
  reason: string;
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

/** One category's independent coverage row for the compass breakdown. */
export interface CategoryCoverageBreakdown {
  /** Recommendation category whose claims addressed priced cells. */
  category: RecCategory;
  /** Priced value of this category's addressed cell-union. */
  claimedUsd: number;
  /** `claimedUsd / totalBill` in [0,1] (0 when the bill is empty). */
  coverage: number;
}

/** Everything the CostAttribution reclaim cards need, all from the rollup. */
export interface ReclaimTrendlineData {
  /** Per-ISO-week trendline points, ascending by week. */
  points: ReclaimWeekPoint[];
  /** The window-wide independent coverage gauge. */
  gauge: CoverageGauge;
  /** Per-category coverage rows, descending by claimed USD. */
  byCategory: CategoryCoverageBreakdown[];
  /** Per-lever marginal, descending by booked USD. */
  levers: LeverMarginal[];
  /** Window-wide guarded-marginal rejections, deduped by lever + reason. */
  rejections: ReclaimRejection[];
  /** Window-wide reclaim total (`sum(marginal)` ≡ `billOriginal − billFinal`). */
  totalReclaim: number;
}

/** Deterministic work counters emitted by the representative scale probe. */
export interface ReclaimTrendlineWorkload {
  /** ISO-week cascades produced for the visible trendline. */
  weeks: number;
  /** Window-wide claims supplied by the recommendation surface. */
  claims: number;
  /** Claims actually supplied to weekly cascades after scope indexing. */
  weeklyClaimInputs: number;
  /** Prior exhaustive upper bound: every claim supplied to every week. */
  exhaustiveWeeklyClaimInputs: number;
  /** Distinct `(sessionId, model)` rows across all weekly matrices. */
  weeklyScopeKeys: number;
  /** Scope-index constructions; stays zero when no dated week can query it. */
  claimIndexBuilds: number;
}

export type ReclaimTrendlineWorkloadProbe = (
  workload: ReclaimTrendlineWorkload
) => void;

/** The claims a rec list carries, in stable rec order (mirrors recommendations.ts). */
function claimsOf(recs: Recommendation[]): ReclaimClaim[] {
  const claims: ReclaimClaim[] = [];
  for (const rec of recs) if (rec.reclaim) claims.push(rec.reclaim);
  return claims;
}

function parseRejection(msg: string): ReclaimRejection {
  const idx = msg.indexOf(':');
  if (idx <= 0) {
    return { leverId: 'unknown', reason: msg.trim() };
  }
  return {
    leverId: msg.slice(0, idx).trim(),
    reason: msg.slice(idx + 1).trim(),
  };
}

function rejectionKey(rejection: ReclaimRejection): string {
  return `${rejection.leverId}\0${rejection.reason}`;
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
 * week's tokens). Returns each week's token rows plus its distinct scope keys.
 */
interface ReclaimWeekSlice {
  tokenData: SessionTokenData[];
  scopeKeys: Set<string>;
}

function sliceByWeek(tokenData: SessionTokenData[]): Map<string, ReclaimWeekSlice> {
  // perf-index-contract: reclaim-week-buckets always-consumed: every slice call enumerates all buckets into the returned weekly map
  const byWeek = new Map<
    string,
    { sessions: Map<string, SessionTokenData>; scopeKeys: Set<string> }
  >();
  for (const d of tokenData) {
    for (const entry of d.entries) {
      const week = entryWeek(entry);
      if (!week) continue;
      let weekly = byWeek.get(week);
      if (!weekly) {
        // perf-index-contract: reclaim-week-members always-consumed: construction is guarded by a dated entry that immediately queries and populates both indexes
        weekly = { sessions: new Map(), scopeKeys: new Set() };
        byWeek.set(week, weekly);
      }
      let slice = weekly.sessions.get(d.sessionId);
      if (!slice) {
        // A shallow clone with an empty `entries` list: the cascade reads only
        // `sessionId` + `entries`, so we copy the dimensions and re-bucket entries.
        slice = { ...d, entries: [] };
        weekly.sessions.set(d.sessionId, slice);
      }
      slice.entries.push(entry);
      weekly.scopeKeys.add(scopeKeyOf(d.sessionId, entry.model || 'unknown'));
    }
  }
  // perf-index-contract: reclaim-week-output always-consumed: the sole caller always enumerates this returned map and reads its size
  const out = new Map<string, ReclaimWeekSlice>();
  for (const [week, weekly] of byWeek) {
    out.set(week, {
      tokenData: [...weekly.sessions.values()],
      scopeKeys: weekly.scopeKeys,
    });
  }
  return out;
}

/** Index each claim once by the concrete matrix rows it can address. */
function claimIndexesByScope(claims: ReclaimClaim[]): Map<string, number[]> {
  // perf-index-contract: reclaim-claim-scope-index non-querying
  const byScope = new Map<string, number[]>();
  claims.forEach((claim, claimIndex) => {
    for (const scopeKey of new Set(claim.scopeKeys)) {
      const indexes = byScope.get(scopeKey) ?? [];
      indexes.push(claimIndex);
      byScope.set(scopeKey, indexes);
    }
  });
  return byScope;
}

/**
 * Resolve only the claims applicable to one week's matrix and narrow their
 * scope lists to the rows that week contains. The cascade still owns ordering,
 * validation, coverage, and arithmetic; this index only removes impossible
 * claim/scope work before the weekly call.
 */
function claimsForWeek(
  claims: ReclaimClaim[],
  indexesByScope: Map<string, number[]>,
  scopeKeys: Set<string>
): ReclaimClaim[] {
  // perf-index-contract: reclaim-applicable-claims always-consumed: every weekly call spreads the complete candidate set into deterministic claim order
  const applicableClaimIndexes = new Set<number>();
  for (const scopeKey of scopeKeys) {
    for (const claimIndex of indexesByScope.get(scopeKey) ?? []) {
      applicableClaimIndexes.add(claimIndex);
    }
  }
  // perf-index-contract: reclaim-applicable-order always-consumed: every weekly call immediately maps the complete sorted candidate list into cascade claims
  return [...applicableClaimIndexes]
    .sort((a, b) => a - b)
    .map((claimIndex) => ({
      ...claims[claimIndex],
      // resolveRows preserves claim scope order, which is observable for
      // sequential directUsd drains. Intersect in that same original order;
      // never inherit the weekly token-data Set's insertion order.
      // perf-index-contract: reclaim-claim-scope-order always-consumed: every applicable claim immediately filters its complete de-duplicated scope order against the week
      scopeKeys: [...new Set(claims[claimIndex].scopeKeys)].filter((scopeKey) =>
        scopeKeys.has(scopeKey)
      ),
    }));
}

/**
 * Build the reclaim trendline + coverage gauge from the cascade.
 *
 * - **Trendline:** the cascade is run once PER ISO-week slice of `tokenData`, so
 *   each week's `baseline` is its own repriced actual bill and `afterReclaim` is
 *   its post-counterfactual bill. Claims are indexed once by `scopeKey`; each
 *   weekly cascade receives only claims and scopes present in that week's
 *   matrix, rather than resolving the complete window claim list again.
 * - **Gauge & levers:** computed ONCE over the whole window (a single cascade run
 *   over all `tokenData`), so the gauge is `price(claimed) / totalBill` across the
 *   period and is decoupled from the per-week trendline — it is never multiplied
 *   into any trendline series.
 *
 * `onReject` is forwarded to the window-wide cascade and every applicable
 * weekly cascade (defaulting to a no-op here so the UI does not spam the
 * console; the engine path keeps its own `console.warn`). A claim absent from a
 * week's scope index is not re-rejected for that week.
 */
export function buildReclaimTrendline(
  recs: Recommendation[],
  tokenData: SessionTokenData[],
  onReject: (msg: string) => void = () => {},
  workloadProbe?: ReclaimTrendlineWorkloadProbe
): ReclaimTrendlineData {
  const claims = claimsOf(recs);
  const rejectionsByKey = new Map<string, ReclaimRejection>();
  const collectWindowRejection = (msg: string) => {
    const rejection = parseRejection(msg);
    rejectionsByKey.set(rejectionKey(rejection), rejection);
    onReject(msg);
  };

  // Window-wide cascade → the independent coverage gauge + per-lever marginal.
  const whole = rollupCascade(
    runReclaimCascade(claims, tokenData, collectWindowRejection)
  );
  const gauge = coverageGauge(whole.coverageUnion);
  const byCategory = categoryCoverageBreakdown(
    whole.coverageByCategory,
    whole.totalBill
  );
  const levers: LeverMarginal[] = Object.entries(whole.byLever)
    .map(([leverId, marginalUsd]) => ({ leverId, marginalUsd }))
    .sort((a, b) => b.marginalUsd - a.marginalUsd);
  const rejections = [...rejectionsByKey.values()];

  // Per-week cascade → the two trendline series.
  const weeks = sliceByWeek(tokenData);
  let claimIndexBuilds = 0;
  let indexesByScope: Map<string, number[]> | undefined;
  let weeklyClaimInputs = 0;
  let weeklyScopeKeys = 0;
  const points: ReclaimWeekPoint[] = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, slice]) => {
      if (!indexesByScope) {
        indexesByScope = claimIndexesByScope(claims);
        claimIndexBuilds += 1;
      }
      const weeklyClaims = claimsForWeek(
        claims,
        indexesByScope,
        slice.scopeKeys
      );
      weeklyClaimInputs += weeklyClaims.length;
      weeklyScopeKeys += slice.scopeKeys.size;
      const r = runReclaimCascade(weeklyClaims, slice.tokenData, onReject);
      return {
        week,
        baseline: r.billOriginal,
        afterReclaim: r.billFinal,
        reclaim: r.total,
      };
    });

  workloadProbe?.({
    weeks: weeks.size,
    claims: claims.length,
    weeklyClaimInputs,
    exhaustiveWeeklyClaimInputs: weeks.size * claims.length,
    weeklyScopeKeys,
    claimIndexBuilds,
  });

  return { points, gauge, byCategory, levers, rejections, totalReclaim: whole.total };
}

/**
 * The window-wide gauge: the priced set-union of EVERY category's addressed
 * cells over the repriced `totalBill`.
 *
 * This used to SUM the per-category `claimedUsd` figures and clamp the result to
 * `totalBill`, while its own comment described a union (#3163). A sum is not a
 * union: two categories can address the same cell, and that cell was then
 * counted twice. A $5 cell addressed by both cost and context read as $10 of a
 * $30 bill — 33% coverage instead of 17% — and with enough overlap the gauge
 * saturated at 100% while most of the bill was untouched. The clamp hid the
 * overflow rather than fixing it, so the number looked plausible at every
 * magnitude.
 *
 * The union is now computed in the cascade (`coverageUnion`), where the cell
 * identities still exist. It cannot be reconstructed here: a per-category total
 * has already discarded which cells it covers. The gauge stays a pure reporting
 * figure — it is never multiplied into the dollar identity.
 */
function coverageGauge(union: CategoryCoverage): CoverageGauge {
  return {
    claimedUsd: union.claimedUsd,
    totalBill: union.totalBill,
    coverage: union.coverage,
  };
}

function categoryCoverageBreakdown(
  coverageByCategory: Partial<Record<RecCategory, CategoryCoverage>>,
  totalBill: number
): CategoryCoverageBreakdown[] {
  return (Object.entries(coverageByCategory) as [RecCategory, CategoryCoverage][])
    .map(([category, cov]) => {
      const claimedUsd = Math.max(0, Math.min(cov.claimedUsd, totalBill));
      return {
        category,
        claimedUsd,
        coverage: totalBill > 0 ? Math.min(1, claimedUsd / totalBill) : 0,
      };
    })
    .sort(
      (a, b) =>
        b.claimedUsd - a.claimedUsd || a.category.localeCompare(b.category)
    );
}
