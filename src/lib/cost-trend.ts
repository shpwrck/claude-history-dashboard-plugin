import type { SessionTokenData } from '../types';
import { estimateEntryCost } from './parse-sessions';

/**
 * Cost-over-time / burn-rate analytics.
 *
 * The Cost and Token Usage views surface *aggregate* spend, but not how that
 * spend is distributed over calendar time. This module buckets each token
 * entry's estimated cost by the day of its `timestamp` to produce a daily
 * spend series, plus a trailing 7-day burn rate (average $/day over the most
 * recent week of activity). It reuses the exact same per-entry pricing math as
 * {@link estimateCost} in parse-sessions, so the series totals match the
 * headline "Est. Cost" figure (modulo entries with an unparseable timestamp,
 * which are reported separately rather than silently dropped from the total).
 */

/** One calendar day of spend. `date` is an ISO `YYYY-MM-DD` (UTC) key. */
export interface DailySpend {
  date: string;
  cost: number;
  /** Number of token entries (API calls) attributed to this day. */
  entries: number;
}

export interface CostTrend {
  /** Daily spend, ascending by date. */
  daily: DailySpend[];
  /** Sum of all dated spend (excludes undated entries). */
  totalDatedCost: number;
  /**
   * Cost from entries whose timestamp could not be parsed to a day. Kept out
   * of the daily series but reported so the caller can reconcile against the
   * full estimateCost total.
   */
  undatedCost: number;
  /**
   * Trailing 7-day burn rate in USD/day: total spend over the 7 calendar days
   * ending on the most recent active day, divided by 7. 0 when there is no
   * dated spend.
   */
  burnRate7d: number;
  /** First and last active day in the series (ISO date strings), or null. */
  firstDay: string | null;
  lastDay: string | null;
  /**
   * Projected spend for the calendar month of `lastDay`, at the current pace:
   * month-to-date spend + burnRate7d × days remaining in that month
   * (`lastDay` itself counts as already-spent, not remaining). Anchored on
   * `lastDay` rather than the wall clock so the function stays pure and the
   * projection matches the data shown. 0 when there is no dated spend.
   */
  projectedMonthEndUsd: number;
  /**
   * Total spend in the calendar month immediately before `lastDay`'s month —
   * the "vs last month" baseline. 0 when there is no such spend.
   */
  lastMonthUsd: number;
}

/**
 * Cost of a single token entry. This is `estimateEntryCost` from
 * parse-sessions re-exported under this module's historical name (#2959):
 * there is exactly ONE place the per-entry pricing formula lives, and it is
 * parse-sessions — the byte-identical local copy this alias replaced desynced
 * from the headline Est. Cost math the moment either side changed. Other
 * aggregations (e.g. the weekly-delta drill-down's per-project / per-model
 * cost breakdown and summary.ts's by-day rollup) import it from here.
 */
export const entryCost = estimateEntryCost;

/**
 * Extract the `YYYY-MM-DD` (UTC) day key from a timestamp, or null if bad.
 * Exported so other day-bucketing aggregations (e.g. the Summary view's
 * by-day rollup) bucket on the exact same calendar-day boundary — there is one
 * place the day-key derivation lives, mirroring {@link entryCost} for pricing.
 */
export function dayKey(timestamp: string): string | null {
  const t = new Date(timestamp).getTime();
  if (!isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bucket per-entry estimated cost by calendar day and derive a 7-day burn
 * rate. Pure: depends only on its input.
 */
export function computeCostTrend(data: SessionTokenData[]): CostTrend {
  const byDay = new Map<string, { cost: number; entries: number }>();
  let undatedCost = 0;

  for (const d of data) {
    for (const entry of d.entries) {
      const cost = entryCost(entry);
      const key = dayKey(entry.timestamp);
      if (key === null) {
        undatedCost += cost;
        continue;
      }
      const bucket = byDay.get(key) ?? { cost: 0, entries: 0 };
      bucket.cost += cost;
      bucket.entries += 1;
      byDay.set(key, bucket);
    }
  }

  const daily: DailySpend[] = Array.from(byDay.entries())
    .map(([date, b]) => ({ date, cost: b.cost, entries: b.entries }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const totalDatedCost = daily.reduce((s, r) => s + r.cost, 0);
  const firstDay = daily.length > 0 ? daily[0].date : null;
  const lastDay = daily.length > 0 ? daily[daily.length - 1].date : null;

  // Trailing 7-day burn rate: spend over the 7 calendar days ending on the
  // last active day (inclusive), divided by 7.
  let burnRate7d = 0;
  if (lastDay) {
    const lastMs = new Date(lastDay + 'T00:00:00Z').getTime();
    const windowStartMs = lastMs - 6 * MS_PER_DAY;
    let windowCost = 0;
    for (const row of daily) {
      const ms = new Date(row.date + 'T00:00:00Z').getTime();
      if (ms >= windowStartMs && ms <= lastMs) windowCost += row.cost;
    }
    burnRate7d = windowCost / 7;
  }

  // Month-end pace forecast (#201). Anchored on `lastDay` (the most recent
  // active day) so the function stays pure: "this month" is lastDay's calendar
  // month, "month-to-date" is its spend through lastDay (= every dated row in
  // that month, since lastDay is the max date), and "days remaining" runs from
  // the day after lastDay to the month's end. Projection = month-to-date +
  // burnRate7d × daysRemaining. All UTC, matching the dayKey buckets.
  let projectedMonthEndUsd = 0;
  let lastMonthUsd = 0;
  if (lastDay) {
    const year = Number(lastDay.slice(0, 4));
    const month = Number(lastDay.slice(5, 7)); // 1-12
    const dayOfMonth = Number(lastDay.slice(8, 10));
    // Date.UTC(year, month, 0) → day 0 of the *next* month = last day of this
    // one, so getUTCDate() yields the day count for lastDay's month.
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const daysRemaining = daysInMonth - dayOfMonth;
    const thisPrefix = lastDay.slice(0, 7); // YYYY-MM
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevPrefix = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    let monthToDate = 0;
    for (const row of daily) {
      const prefix = row.date.slice(0, 7);
      if (prefix === thisPrefix) monthToDate += row.cost;
      else if (prefix === prevPrefix) lastMonthUsd += row.cost;
    }
    projectedMonthEndUsd = monthToDate + burnRate7d * daysRemaining;
  }

  return {
    daily,
    totalDatedCost,
    undatedCost,
    burnRate7d,
    firstDay,
    lastDay,
    projectedMonthEndUsd,
    lastMonthUsd,
  };
}
