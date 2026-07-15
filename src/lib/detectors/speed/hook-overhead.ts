import type { Detector, RecommendationInput } from '../types';
import type { RuntimeEvents, StopHookStats } from '../../parse-runtime-events';
import { hasStopHook, STALE_WEEKS } from '../shared';

/**
 * speed.hook-overhead (#710, epic #708 — the clock, ADR 0006) — the first
 * Speed-domain detector and the slice that fills the "Go faster" card.
 *
 * Stop hooks run synchronously at the end of every turn, so a slow one adds its
 * wall-clock to each turn the user waits on. That is a pure *clock* lever (make
 * the hook async / drop it), which is exactly what the `speed` domain owns —
 * not cost, not success, not wasted effort.
 *
 * Data honesty (the #261/#134 caveat): per-hook `durationMs` is present on only
 * ~7% of `hookInfos`, so `totalDurationMs` is a best-effort lower bound and the
 * dataset-wide `meanDurationMs` is diluted toward 0 by the untimed majority. We
 * therefore read the AGGREGATE `meanTimedDurationMs` — the mean overhead over
 * only the stop events that actually carried a measured duration — and gate on a
 * minimum number of timed events so a single slow outlier never fires it. We
 * never attribute overhead to an individual hook (the raw data has no hook
 * `name`, only the `command` string).
 *
 * Self-suppressing: once the user backgrounds or removes the slow hook, the
 * measured per-turn overhead falls below the threshold and the finding goes
 * quiet. Dark on the transcript-free SPA dataset (no `runtimeEvents`).
 */

/** Below this mean per-turn hook overhead, the drag isn't worth a finding. */
const MEANINGFUL_OVERHEAD_MS = 2000; // 2s added to every turn
/** At/above this, the per-turn drag is heavy enough to warrant a warning. */
const HEAVY_OVERHEAD_MS = 5000; // 5s
/** Need a real sample of *timed* stop events before trusting the mean. */
const MIN_TIMED_EVENTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
export const HOOK_OVERHEAD_FRESHNESS_MS = STALE_WEEKS * 7 * DAY_MS;

export interface HookOverheadCacheValidity {
  /** Exclusive lower clock bound for which the cached detector output is valid. */
  after: number | null;
  /** Inclusive upper clock bound for which the cached detector output is valid. */
  through: number | null;
}

/**
 * Stop-hook timing aggregated from events whose timestamps fall inside a
 * caller-supplied window. `latestTimedTimestampMs` names the newest event that
 * actually contributed a measured duration, so a detector cannot make a fresh
 * claim from a newer untimed event.
 */
export interface DatedStopHookStats extends StopHookStats {
  latestTimedTimestampMs: number | null;
}

/**
 * Parse the RFC3339 timestamps emitted by transcript runtime events without
 * inheriting the host timezone. Evidence fails closed unless it carries a full
 * calendar date, time, and explicit UTC/numeric offset. Keep the offset inside
 * ISO 8601's interoperable -14:00..+14:00 range; Date.parse() is otherwise
 * permissive about values that cannot be emitted by the harness.
 */
export function runtimeEventTimestampMs(timestamp: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i.exec(
    timestamp
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyDatedStopHookStats(): DatedStopHookStats {
  return {
    events: 0,
    hookCount: 0,
    totalDurationMs: 0,
    meanDurationMs: 0,
    maxDurationMs: 0,
    timedEvents: 0,
    meanTimedDurationMs: 0,
    errorEvents: 0,
    preventedContinuations: 0,
    latestTimedTimestampMs: null,
  };
}

/**
 * Aggregate only Stop events with parseable timestamps inside the inclusive
 * `[fromMs, throughMs]` window. Invalid bounds return an empty aggregate. This
 * detector-local aggregate keeps freshness policy out of the shared runtime
 * parser and its upload-worker bundle.
 */
export function aggregateDatedStopHooks(
  data: RuntimeEvents[],
  fromMs: number,
  throughMs: number
): DatedStopHookStats {
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(throughMs) ||
    fromMs > throughMs
  ) {
    return emptyDatedStopHookStats();
  }

  const stats = emptyDatedStopHookStats();
  for (const session of data) {
    for (const event of session.stopHooks) {
      const timestampMs = runtimeEventTimestampMs(event.timestamp);
      if (
        timestampMs === null ||
        timestampMs < fromMs ||
        timestampMs > throughMs
      ) {
        continue;
      }

      stats.events += 1;
      stats.hookCount += event.hookCount;
      if (event.hadErrors) stats.errorEvents += 1;
      if (event.preventedContinuation) stats.preventedContinuations += 1;

      // A non-positive or non-finite duration is not measured timing evidence.
      if (
        !Number.isFinite(event.totalDurationMs) ||
        event.totalDurationMs <= 0
      ) {
        continue;
      }
      stats.totalDurationMs += event.totalDurationMs;
      stats.timedEvents += 1;
      stats.maxDurationMs = Math.max(
        stats.maxDurationMs,
        event.totalDurationMs
      );
      stats.latestTimedTimestampMs = Math.max(
        stats.latestTimedTimestampMs ?? Number.NEGATIVE_INFINITY,
        timestampMs
      );
    }
  }
  stats.meanDurationMs =
    stats.events === 0 ? 0 : stats.totalDurationMs / stats.events;
  stats.meanTimedDurationMs =
    stats.timedEvents === 0 ? 0 : stats.totalDurationMs / stats.timedEvents;
  return stats;
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function hasReadableCurrentStopHook(input: RecommendationInput): boolean {
  const liveConfig = input.liveConfig;
  if (!liveConfig) return false;
  const settingsHealth = liveConfig.settingsHealth;
  if (settingsHealth?.present && !settingsHealth.ok) return false;

  // A health verdict with no present user file means the merged user-settings
  // object is not evidence. Older datasets without settingsHealth retain the
  // established fallback, while readable project settings are an independent
  // current source.
  if (
    (!settingsHealth || settingsHealth.present) &&
    hasStopHook(liveConfig.settings)
  ) {
    return true;
  }
  return Object.keys(liveConfig.projectSettings ?? {})
    .sort()
    .some((root) => hasStopHook(liveConfig.projectSettings?.[root]));
}

export type HookOverheadConfigState = 'configured' | 'inactive';

/** Current config bit that changes whether the detector is allowed to emit. */
export function hookOverheadConfigState(
  input: RecommendationInput
): HookOverheadConfigState {
  return hasReadableCurrentStopHook(input) ? 'configured' : 'inactive';
}

/**
 * The exact time-sensitive evidence this detector reads. Exported for the
 * recommendation engine's identity-cache key: the same input object can cross
 * a four-week event boundary as the wall clock moves, so identity alone is not
 * enough to keep a cached finding fresh.
 */
export function currentHookOverheadEvidence(
  input: RecommendationInput,
  now: number
): DatedStopHookStats | null {
  const events = input.runtimeEvents;
  if (!events || events.length === 0) return null;
  if (!hasReadableCurrentStopHook(input)) return null;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    return null;
  }

  return aggregateDatedStopHooks(
    events,
    now - HOOK_OVERHEAD_FRESHNESS_MS,
    now
  );
}

/**
 * Clock interval in which this detector sees the same contributing timing
 * events. Each event enters at its timestamp and leaves just after four weeks;
 * intersecting those intervals makes both the in-process identity cache and
 * the server response cache safe across forward and backward clock movement.
 */
export function hookOverheadCacheValidity(
  input: RecommendationInput,
  now: number
): HookOverheadCacheValidity {
  if (!hasReadableCurrentStopHook(input) || !Number.isFinite(now)) {
    return { after: null, through: null };
  }
  const events = input.runtimeEvents;
  if (!events?.length) return { after: null, through: null };

  let after = Number.NEGATIVE_INFINITY;
  let through = Number.POSITIVE_INFINITY;
  for (const session of events) {
    for (const event of session.stopHooks) {
      if (
        !Number.isFinite(event.totalDurationMs) ||
        event.totalDurationMs <= 0
      ) {
        continue;
      }
      const observedAt = runtimeEventTimestampMs(event.timestamp);
      if (observedAt === null) continue;
      const staleAfter = observedAt + HOOK_OVERHEAD_FRESHNESS_MS;
      if (now < observedAt) {
        // The event becomes eligible AT observedAt. Date.now() is integer-ms,
        // so the current excluded state is valid through the prior millisecond.
        through = Math.min(through, observedAt - 1);
      } else if (now <= staleAfter) {
        after = Math.max(after, observedAt - 1);
        through = Math.min(through, staleAfter);
      } else {
        after = Math.max(after, staleAfter);
      }
    }
  }
  return {
    after: Number.isFinite(after) ? after : null,
    through: Number.isFinite(through) ? through : null,
  };
}

export function hookOverheadCacheValidityContains(
  validity: HookOverheadCacheValidity,
  now: number
): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    (validity.after === null || now > validity.after) &&
    (validity.through === null || now <= validity.through)
  );
}

export const detector: Detector = {
  id: 'speed.hook-overhead',
  category: 'speed',
  dataDeps: ['runtimeEvents', 'liveConfig'],
  rule(input, now) {
    // This finding proposes changing a CURRENT Stop hook. If the current bundle
    // is absent, its raw settings were unreadable/invalid, or no Stop hook is
    // configured anymore, historical timing cannot identify an actionable
    // target and must fail closed.
    const evidence = currentHookOverheadEvidence(input, now);
    if (!evidence) return null;
    const {
      timedEvents,
      meanTimedDurationMs,
      maxDurationMs,
      latestTimedTimestampMs,
    } = evidence;

    // Need enough measured events, and the typical per-turn overhead must clear
    // the meaningful bar — anything less is noise, not an actionable clock lever.
    if (timedEvents < MIN_TIMED_EVENTS) return null;
    if (meanTimedDurationMs < MEANINGFUL_OVERHEAD_MS) return null;
    if (latestTimedTimestampMs === null) return null;

    const severity = meanTimedDurationMs >= HEAVY_OVERHEAD_MS ? 'warning' : 'info';
    const asOf = new Date(latestTimedTimestampMs).toISOString().slice(0, 10);
    const meanSeconds = fmtSeconds(meanTimedDurationMs);
    const maxSeconds = fmtSeconds(maxDurationMs);

    return {
      id: 'speed.hook-overhead',
      category: 'speed',
      severity,
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Recent Stop-hook events measured seconds of overhead',
      detail: `The current ${STALE_WEEKS}-week freshness filter retains ${timedEvents} timed Stop events that measured about ${meanSeconds} of aggregate hook wall-clock per event on average (up to ${maxSeconds}); the latest contributing event was ${asOf}. A Stop hook is still configured in readable current user or project settings. Runtime telemetry does not identify which configured hook contributed the measured time.`,
      action:
        'Review the Stop hook commands in your current user and project settings. Make an advisory candidate asynchronous (fire-and-forget) so it stops blocking each turn, or drop it if its output is no longer needed. Keep any hook that must gate the turn synchronous; the aggregate telemetry cannot identify an individual offender.',
      affected: timedEvents,
      view: 'agents',
      evidence: [
        `${timedEvents} dated, timed Stop event(s) retained by the ${STALE_WEEKS}-week freshness filter: mean ${meanSeconds}, maximum ${maxSeconds}`,
        `Latest contributing event: ${asOf}; readable current user/project settings hooks.Stop: configured`,
      ],
      provenance: {
        observations: [
          {
            claim: `${timedEvents} dated Stop event(s) inside the evaluation window carried measured hook duration`,
            source: 'parse-runtime-events',
            field: 'runtimeEvents[].stopHooks[].timestamp / totalDurationMs',
            value: timedEvents,
          },
          {
            claim: `mean measured aggregate Stop-hook duration was ${meanSeconds}`,
            source: 'parse-runtime-events',
            field: 'aggregateDatedStopHooks().meanTimedDurationMs',
            value: meanTimedDurationMs,
          },
          {
            claim: `maximum measured aggregate Stop-hook duration was ${maxSeconds}`,
            source: 'parse-runtime-events',
            field: 'aggregateDatedStopHooks().maxDurationMs',
            value: maxDurationMs,
          },
          {
            claim: `latest contributing timed Stop event was dated ${asOf}`,
            source: 'parse-runtime-events',
            field: 'runtimeEvents[].stopHooks[].timestamp',
            value: asOf,
          },
          {
            claim: 'readable current user or project settings contain a Stop hook',
            source: 'config-loader',
            field:
              'liveConfig.settings.hooks.Stop / liveConfig.projectSettings[*].hooks.Stop',
          },
        ],
        inference:
          'Recent measured aggregate Stop-hook wall-clock clears the existing sample and overhead thresholds while a Stop hook is still configured, so reviewing the configured commands is an actionable speed investigation. The telemetry cannot attribute the aggregate to an individual hook.',
        asOf,
        stale: false,
      },
      fix: {
        target: 'hook',
        label: 'Example: run an advisory Stop hook async',
        note: 'Illustrative only: replace the placeholder after inspecting your configured Stop commands. Backgrounding keeps an advisory side effect without blocking the turn, but a hook that must gate the turn has to stay synchronous.',
        snippet: `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "nohup your-advisory-hook.sh >/dev/null 2>&1 &" }
        ]
      }
    ]
  }
}`,
        fixKind: 'illustrative',
      },
    };
  },
};
