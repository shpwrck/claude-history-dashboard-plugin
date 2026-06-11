import type { SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import { computeCostTrend, entryCost } from './cost-trend';
import { detectRetryGroups, type ApiErrorEvent } from './parse-errors';

/**
 * Week-over-week delta aggregation (G2, issue #129).
 *
 * The dashboard surfaces aggregate totals but never "what changed this week vs
 * last week." This module buckets three signals — cost (USD), API errors
 * (count), and retry storms (count) — into ISO weeks (Monday start, UTC) and
 * compares the last *complete* ISO week against the prior complete ISO week.
 * The current, still-running partial week is excluded so the comparison is
 * apples-to-apples.
 *
 * The module is PURE: every bucket is derived from an entry's own timestamp,
 * never the wall clock. Given the same inputs it always returns the same
 * result, which keeps the banner deterministic and unit-testable.
 *
 * Cost re-buckets {@link computeCostTrend}'s `daily` series (which it does not
 * modify), so the per-week cost equals the sum of that day series' costs whose
 * dates fall in the week — no double-counting and no drift from the headline
 * "Est. Cost" figure.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One of the three signals the banner ranks. */
export type WeeklySignal = 'cost' | 'errors' | 'retryStorms';

export interface WeeklyDelta {
  signal: WeeklySignal;
  /** Value in the last complete ISO week. */
  current: number;
  /** Value in the prior complete ISO week. */
  previous: number;
  /** `current - previous`. */
  deltaAbs: number;
  /**
   * Percent change from `previous` to `current`, as a fraction (0.5 = +50%).
   * When `previous` is 0 and `current` is non-zero this is `Infinity` (a "new"
   * signal); when both are 0 it is 0.
   */
  deltaPct: number;
}

export interface WeeklyDeltas {
  /** Monday (ISO `YYYY-MM-DD`, UTC) of the last complete ISO week. */
  currentWeekStart: string;
  /** Monday (ISO `YYYY-MM-DD`, UTC) of the prior complete ISO week. */
  previousWeekStart: string;
  cost: WeeklyDelta;
  errors: WeeklyDelta;
  retryStorms: WeeklyDelta;
  /**
   * The three signals ranked most-changed first by `abs(deltaPct)`, ties
   * broken by `abs(deltaAbs)`. A signal whose `previous` was 0 (deltaPct
   * `Infinity`) sorts above any finite change.
   */
  movers: WeeklyDelta[];
}

/**
 * Monday (ISO week start, UTC) of the ISO week containing `dayKey`, returned in
 * the same `YYYY-MM-DD` format `computeCostTrend` emits. ISO weeks run
 * Monday→Sunday; `getUTCDay()` is 0 for Sunday, so we map Sunday to 6 and every
 * other day to `day-1` to find how many days to step back to Monday.
 */
export function isoWeekStart(dayKey: string): string {
  const ms = new Date(dayKey + 'T00:00:00Z').getTime();
  const dow = new Date(ms).getUTCDay(); // 0=Sun … 6=Sat
  const backToMonday = dow === 0 ? 6 : dow - 1;
  const mondayMs = ms - backToMonday * MS_PER_DAY;
  return new Date(mondayMs).toISOString().slice(0, 10);
}

/** Extract the `YYYY-MM-DD` (UTC) day key from a timestamp, or null if bad. */
function dayKey(timestamp: string): string | null {
  const t = new Date(timestamp).getTime();
  if (!isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function makeDelta(
  signal: WeeklySignal,
  current: number,
  previous: number
): WeeklyDelta {
  const deltaAbs = current - previous;
  let deltaPct: number;
  if (previous === 0) {
    deltaPct = current === 0 ? 0 : Infinity;
  } else {
    deltaPct = deltaAbs / previous;
  }
  return { signal, current, previous, deltaAbs, deltaPct };
}

/** Sort key for `abs(x)` treating `Infinity` as larger than any finite value. */
function absRank(x: number): number {
  return Math.abs(x);
}

export interface WeeklyDeltaInput {
  tokenData: SessionTokenData[];
  apiErrors: ApiErrorEvent[];
  toolData: ToolUsageData[];
}

/**
 * Compute the last-complete-ISO-week-vs-prior-complete-ISO-week deltas for the
 * three signals. Returns `null` when fewer than **three distinct active ISO
 * weeks** exist — i.e. when there aren't two complete weeks to compare after
 * dropping the trailing (possibly partial) week (no meaningful comparison).
 *
 * "Complete" weeks are determined purely from the data, never the wall clock:
 * the most recent ISO week that has any activity is treated as the (possibly
 * partial) current week and excluded; the week before it is the "last complete"
 * week and the one before that is the "prior complete" week. This keeps the
 * function clock-free and deterministic — the cost of that purity is that the
 * banner needs a third active week to appear (the latest active week is always
 * assumed in-progress), rather than literally "two complete calendar weeks".
 */
export function computeWeeklyDeltas(
  input: WeeklyDeltaInput
): WeeklyDeltas | null {
  const { tokenData, apiErrors, toolData } = input;

  // Per-ISO-week buckets for each signal, keyed by the week's Monday.
  const costByWeek = new Map<string, number>();
  const errorsByWeek = new Map<string, number>();
  const stormsByWeek = new Map<string, number>();
  // Union of every week that has *any* activity, used to find the trailing
  // partial week to exclude and the two complete weeks to compare.
  const activeWeeks = new Set<string>();

  const add = (
    map: Map<string, number>,
    week: string,
    amount: number
  ): void => {
    map.set(week, (map.get(week) ?? 0) + amount);
    activeWeeks.add(week);
  };

  // Cost: re-bucket computeCostTrend(...).daily by ISO week. Reusing the day
  // series (rather than re-pricing entries) guarantees the per-week cost equals
  // the sum of that series' daily costs in the week — no drift from the
  // headline figure.
  const { daily } = computeCostTrend(tokenData);
  for (const row of daily) {
    add(costByWeek, isoWeekStart(row.date), row.cost);
  }

  // Errors: one per ApiErrorEvent, bucketed by its timestamp.
  for (const e of apiErrors) {
    const key = dayKey(e.timestamp);
    if (key === null) continue;
    add(errorsByWeek, isoWeekStart(key), 1);
  }

  // Retry storms: one per detected retry group, bucketed by startTimestamp.
  for (const g of detectRetryGroups(toolData)) {
    const key = dayKey(g.startTimestamp);
    if (key === null) continue;
    add(stormsByWeek, isoWeekStart(key), 1);
  }

  // Descending list of active week starts. The most recent is the (possibly
  // partial) current week and is excluded; the next two are the complete weeks
  // we compare. Need at least three distinct active weeks for two *complete*
  // ones to exist after dropping the trailing partial week.
  const weeks = Array.from(activeWeeks).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (weeks.length < 3) return null;

  const currentWeekStart = weeks[1]; // last complete week
  const previousWeekStart = weeks[2]; // prior complete week

  const cost = makeDelta(
    'cost',
    costByWeek.get(currentWeekStart) ?? 0,
    costByWeek.get(previousWeekStart) ?? 0
  );
  const errors = makeDelta(
    'errors',
    errorsByWeek.get(currentWeekStart) ?? 0,
    errorsByWeek.get(previousWeekStart) ?? 0
  );
  const retryStorms = makeDelta(
    'retryStorms',
    stormsByWeek.get(currentWeekStart) ?? 0,
    stormsByWeek.get(previousWeekStart) ?? 0
  );

  const movers = [cost, errors, retryStorms].sort((a, b) => {
    const byPct = absRank(b.deltaPct) - absRank(a.deltaPct);
    if (byPct !== 0 && !Number.isNaN(byPct)) return byPct;
    return absRank(b.deltaAbs) - absRank(a.deltaAbs);
  });

  return {
    currentWeekStart,
    previousWeekStart,
    cost,
    errors,
    retryStorms,
    movers,
  };
}

// ---------------------------------------------------------------------------
// Drill-down: decompose one signal's WoW delta by dimension (#194)
//
// #129's banner says *that* a signal moved week-over-week; this answers *where*
// the movement came from. For a chosen signal it re-walks the same raw inputs
// `computeWeeklyDeltas` consumed, buckets every contributing unit (a priced
// token entry / an API error / a retry storm) into the two compared ISO weeks,
// and splits each week's value across one dimension — project, model, or day.
//
// It stays as PURE as the aggregator above: the two week boundaries are passed
// in (the caller already computed them via `computeWeeklyDeltas`), so a unit is
// assigned to "current"/"previous"/neither purely from its own timestamp — no
// wall clock. Per-row cost reuses `entryCost`, the single source of the
// per-entry pricing formula, so a project/model breakdown's total reconciles
// with the headline cost delta.
// ---------------------------------------------------------------------------

/** Which axis to decompose a signal's delta along. */
export type DrillDimension = 'project' | 'model' | 'day';

/**
 * One row of a drill-down: a single value of the chosen dimension (a project
 * slug, a model id, or a `YYYY-MM-DD` day key) and how that slice moved between
 * the two compared weeks. `deltaAbs`/`deltaPct` follow the same conventions as
 * {@link WeeklyDelta} (Infinity = rose from zero).
 */
export interface WeeklyDeltaBreakdownRow {
  /** The dimension value: project slug, model id, or `YYYY-MM-DD` day key. */
  key: string;
  current: number;
  previous: number;
  deltaAbs: number;
  deltaPct: number;
}

/**
 * The full decomposition of one signal's WoW delta along one dimension, plus a
 * flat list of the contributing sessions (so the UI can list "the sessions
 * behind this"). `signal`/`dimension` echo the request; `currentWeekStart` /
 * `previousWeekStart` echo the compared weeks for labelling.
 */
export interface WeeklyDeltaBreakdown {
  signal: WeeklySignal;
  dimension: DrillDimension;
  currentWeekStart: string;
  previousWeekStart: string;
  /** Total of the signal in each compared week (matches the banner figure). */
  currentTotal: number;
  previousTotal: number;
  /** Per-dimension rows, sorted by `abs(deltaAbs)` desc (biggest mover first). */
  rows: WeeklyDeltaBreakdownRow[];
  /** Sessions that contributed to either week, sorted by `abs(delta)` desc. */
  sessions: WeeklyDeltaSessionRow[];
}

/**
 * One contributing session in a drill-down. `value`/`previousValue` are the
 * session's share of the signal in the current/previous week; `project`/`model`
 * are best-effort tags for display (a session can span models — `model` is the
 * session's primary model string).
 */
export interface WeeklyDeltaSessionRow {
  sessionId: string;
  project?: string;
  model?: string;
  current: number;
  previous: number;
  deltaAbs: number;
}

/** A session's project tag, supplied by the caller (token data carries none). */
export interface SessionProjectTag {
  sessionId: string;
  project: string;
}

/** Input for {@link computeWeeklyDeltaBreakdown}. Mirrors {@link WeeklyDeltaInput}
 *  plus the chosen signal/dimension, the two week boundaries to compare, and an
 *  optional sessionId→project map (token/error/storm data carry no project). */
export interface WeeklyDeltaBreakdownInput extends WeeklyDeltaInput {
  signal: WeeklySignal;
  dimension: DrillDimension;
  /** Monday (`YYYY-MM-DD`, UTC) of the last complete week (from the aggregate). */
  currentWeekStart: string;
  /** Monday (`YYYY-MM-DD`, UTC) of the prior complete week (from the aggregate). */
  previousWeekStart: string;
  /** Optional sessionId→project tags for the `project` dimension and the
   *  session list. A session without a tag falls back to "(unknown project)". */
  projects?: SessionProjectTag[];
}

const UNKNOWN_PROJECT = '(unknown project)';
const UNKNOWN_MODEL = '(unknown model)';

/**
 * A single unit contributing to a signal in one week: its dimension keys (the
 * project / model / day it belongs to), which week it landed in, the owning
 * session, and the amount it adds (a priced cost for `cost`, else 1).
 */
interface SignalUnit {
  week: 'current' | 'previous';
  sessionId: string;
  project: string;
  model: string;
  day: string;
  amount: number;
}

function makeBreakdownRow(
  key: string,
  current: number,
  previous: number
): WeeklyDeltaBreakdownRow {
  const deltaAbs = current - previous;
  let deltaPct: number;
  if (previous === 0) {
    deltaPct = current === 0 ? 0 : Infinity;
  } else {
    deltaPct = deltaAbs / previous;
  }
  return { key, current, previous, deltaAbs, deltaPct };
}

/** Pick the dimension key for a unit given the requested dimension. */
function dimensionKey(unit: SignalUnit, dimension: DrillDimension): string {
  if (dimension === 'project') return unit.project;
  if (dimension === 'model') return unit.model;
  return unit.day;
}

/**
 * Walk the raw inputs for one signal and emit one {@link SignalUnit} per
 * contributing unit that falls in either compared week. `cost` units come from
 * priced token entries (one per entry, amount = its USD cost); `errors` from
 * ApiErrorEvents (amount 1); `retryStorms` from detected retry groups
 * (amount 1). Units outside both weeks are dropped.
 */
function collectSignalUnits(
  input: WeeklyDeltaBreakdownInput,
  projectBySession: Map<string, string>,
  modelBySession: Map<string, string>
): SignalUnit[] {
  const { signal, currentWeekStart, previousWeekStart } = input;
  const units: SignalUnit[] = [];

  const weekOf = (day: string): 'current' | 'previous' | null => {
    const w = isoWeekStart(day);
    if (w === currentWeekStart) return 'current';
    if (w === previousWeekStart) return 'previous';
    return null;
  };

  if (signal === 'cost') {
    for (const session of input.tokenData) {
      for (const entry of session.entries) {
        const day = dayKey(entry.timestamp);
        if (day === null) continue;
        const week = weekOf(day);
        if (week === null) continue;
        units.push({
          week,
          sessionId: session.sessionId,
          project: projectBySession.get(session.sessionId) ?? UNKNOWN_PROJECT,
          model: entry.model || session.model || UNKNOWN_MODEL,
          day,
          amount: entryCost(entry),
        });
      }
    }
  } else if (signal === 'errors') {
    for (const e of input.apiErrors) {
      const day = dayKey(e.timestamp);
      if (day === null) continue;
      const week = weekOf(day);
      if (week === null) continue;
      units.push({
        week,
        sessionId: e.sessionId,
        project: projectBySession.get(e.sessionId) ?? UNKNOWN_PROJECT,
        model: modelBySession.get(e.sessionId) ?? UNKNOWN_MODEL,
        day,
        amount: 1,
      });
    }
  } else {
    // retryStorms
    for (const g of detectRetryGroups(input.toolData)) {
      const day = dayKey(g.startTimestamp);
      if (day === null) continue;
      const week = weekOf(day);
      if (week === null) continue;
      units.push({
        week,
        sessionId: g.sessionId,
        project: projectBySession.get(g.sessionId) ?? UNKNOWN_PROJECT,
        model: modelBySession.get(g.sessionId) ?? UNKNOWN_MODEL,
        day,
        amount: 1,
      });
    }
  }

  return units;
}

/**
 * Decompose one signal's last-complete-vs-prior-complete-week delta along one
 * dimension (project / model / day), and list the sessions behind it.
 *
 * The caller passes the two week boundaries (already known from
 * {@link computeWeeklyDeltas}); this function re-walks the same raw inputs,
 * keeps only the units in those two weeks, and groups them. Each returned row's
 * `current - previous` summed across rows equals `currentTotal - previousTotal`,
 * which equals the corresponding {@link WeeklyDelta.deltaAbs} from the banner.
 *
 * Pure and deterministic: identical inputs always yield an identical result.
 */
export function computeWeeklyDeltaBreakdown(
  input: WeeklyDeltaBreakdownInput
): WeeklyDeltaBreakdown {
  const projectBySession = new Map<string, string>();
  for (const t of input.projects ?? []) {
    projectBySession.set(t.sessionId, t.project);
  }
  // A session's primary model, for tagging error/storm units (which carry no
  // model of their own) and the session list. First non-empty wins.
  const modelBySession = new Map<string, string>();
  for (const session of input.tokenData) {
    if (modelBySession.has(session.sessionId)) continue;
    const model =
      session.model ||
      session.entries.find((e) => e.model)?.model ||
      '';
    if (model) modelBySession.set(session.sessionId, model);
  }

  const units = collectSignalUnits(input, projectBySession, modelBySession);

  // Bucket by dimension key, splitting current vs previous.
  const byDim = new Map<string, { current: number; previous: number }>();
  // Bucket by session, for the contributing-sessions list.
  const bySession = new Map<
    string,
    { current: number; previous: number; project?: string; model?: string }
  >();
  let currentTotal = 0;
  let previousTotal = 0;

  for (const unit of units) {
    if (unit.week === 'current') currentTotal += unit.amount;
    else previousTotal += unit.amount;

    const dimK = dimensionKey(unit, input.dimension);
    const dim = byDim.get(dimK) ?? { current: 0, previous: 0 };
    dim[unit.week] += unit.amount;
    byDim.set(dimK, dim);

    const s = bySession.get(unit.sessionId) ?? {
      current: 0,
      previous: 0,
      project: projectBySession.get(unit.sessionId),
      model: modelBySession.get(unit.sessionId),
    };
    s[unit.week] += unit.amount;
    bySession.set(unit.sessionId, s);
  }

  const rows = Array.from(byDim.entries())
    .map(([key, v]) => makeBreakdownRow(key, v.current, v.previous))
    .sort((a, b) => {
      const byAbs = Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs);
      if (byAbs !== 0) return byAbs;
      // Stable, deterministic tiebreak.
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const sessions: WeeklyDeltaSessionRow[] = Array.from(bySession.entries())
    .map(([sessionId, v]) => ({
      sessionId,
      project: v.project,
      model: v.model,
      current: v.current,
      previous: v.previous,
      deltaAbs: v.current - v.previous,
    }))
    .sort((a, b) => {
      const byAbs = Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs);
      if (byAbs !== 0) return byAbs;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });

  return {
    signal: input.signal,
    dimension: input.dimension,
    currentWeekStart: input.currentWeekStart,
    previousWeekStart: input.previousWeekStart,
    currentTotal,
    previousTotal,
    rows,
    sessions,
  };
}
