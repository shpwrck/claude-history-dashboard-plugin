import type { Detector } from '../types';
import { aggregateStopHooks } from '../../parse-runtime-events';

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

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export const detector: Detector = {
  id: 'speed.hook-overhead',
  category: 'speed',
  dataDeps: ['runtimeEvents'],
  rule(input) {
    const events = input.runtimeEvents;
    if (!events || events.length === 0) return null;

    const { timedEvents, meanTimedDurationMs, maxDurationMs } =
      aggregateStopHooks(events);

    // Need enough measured events, and the typical per-turn overhead must clear
    // the meaningful bar — anything less is noise, not an actionable clock lever.
    if (timedEvents < MIN_TIMED_EVENTS) return null;
    if (meanTimedDurationMs < MEANINGFUL_OVERHEAD_MS) return null;

    const severity = meanTimedDurationMs >= HEAVY_OVERHEAD_MS ? 'warning' : 'info';

    return {
      id: 'speed.hook-overhead',
      category: 'speed',
      severity,
      title: 'Stop hooks are adding seconds to every turn',
      detail: `Stop hooks add about ${fmtSeconds(meanTimedDurationMs)} of wall-clock per turn (mean over ${timedEvents} timed stop event(s), up to ${fmtSeconds(maxDurationMs)}). That latency is paid on every turn the agent finishes, slowing the whole session.`,
      action:
        'Make the slow Stop hook asynchronous (fire-and-forget) so it stops blocking each turn, or drop it if its output is only advisory. Per-hook timing is sparse, so identify the offender from the hook commands in your settings.json.',
      affected: timedEvents,
      view: 'agents',
      fix: {
        target: 'hook',
        label: 'Run the slow Stop hook async',
        note: 'Background the slow Stop hook so its wall-clock no longer lands on every turn. A synchronous hook blocks until its command returns; detaching it (fire-and-forget) keeps the side effect without the per-turn latency. Only do this for advisory hooks — a hook that must gate the turn has to stay synchronous.',
        snippet: `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "nohup your-slow-hook.sh >/dev/null 2>&1 &" }
        ]
      }
    ]
  }
}`,
      },
    };
  },
};
