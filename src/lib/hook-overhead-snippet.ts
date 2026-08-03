/**
 * Turn the rolled-up stop-hook overhead telemetry into a copyable TUNING
 * CORRECTIVE (#1806, epic #1485). The Agents → Runtime Telemetry surface
 * (`AgentSkill`) shows "Mean hook overhead" / "Max hook overhead" StatCards from
 * {@link import('./parse-runtime-events').aggregateStopHooks}, but those figures
 * only let the user *read* the drag — there is no path to act on it. This is the
 * read-side primitive that turns the number into action: a ready-made corrective
 * the user can paste (into an issue, a note, or alongside their settings.json
 * review) describing how to tune or background the slow Stop hook.
 *
 * Why a prose corrective (not a navigate to the hook config): Claude Code emits
 * no stable per-hook name/id and per-hook `durationMs` is present on only ~7% of
 * fires, so the overhead is a rolled-up aggregate that is NOT attributable to one
 * hook command (see #261 and the ConfigHygiene "Configured hooks" note). A
 * navigate to the hooks list therefore could not pre-select the offending hook,
 * so the genuinely actionable artifact is the same guidance the
 * `speed.hook-overhead` detector (#710) already carries — phrased here as a
 * copyable steer. Like #1804's CLAUDE.md corrective (and unlike a generated shell
 * snippet, #1803), it is prose, so it carries no heredoc-delimiter / injection
 * hazard.
 *
 * Pure string transformation — no fs, no network, no `@api-client` — so it is
 * safe in both the server and SPA (upload) builds. It is also self-suppressing
 * by construction: the surface only renders these cards (and this affordance)
 * when measured stop-hook durations exist, so the corrective never claims an
 * overhead the telemetry did not actually show.
 */

/** The measured stop-hook overhead the corrective is built from. */
export interface HookOverheadCorrectiveInput {
  /** Mean overhead among timed stop events, ms (`meanTimedDurationMs`). */
  meanTimedDurationMs: number;
  /** Worst single timed stop event, ms (`maxDurationMs`). */
  maxDurationMs: number;
  /** Number of stop events that carried a measured `durationMs`. */
  timedEvents: number;
}

/** Mirror the `speed.hook-overhead` detector's "heavy" bar (5s timed mean). */
const HEAVY_OVERHEAD_MS = 5000;

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build a copyable tuning corrective for the rolled-up stop-hook overhead. Quotes
 * the actual measured mean/max so the user can see exactly what the telemetry
 * showed, then steers them to background or drop the slow Stop hook in their
 * `.claude/settings.json`. When the mean clears the detector's "heavy" bar the
 * lead line escalates the urgency; otherwise it reads as a lighter review prompt.
 *
 * Always returns actionable prose — the caller only mounts the affordance when
 * `timedEvents > 0`, so the figures are real, never fabricated.
 */
export function hookOverheadCorrective(
  input: HookOverheadCorrectiveInput
): string {
  const { meanTimedDurationMs, maxDurationMs, timedEvents } = input;
  const heavy = meanTimedDurationMs >= HEAVY_OVERHEAD_MS;
  const lead = heavy
    ? `Among ${timedEvents.toLocaleString()} timed Stop events, measured hook duration averaged ${fmtSeconds(
        meanTimedDurationMs
      )} and reached ${fmtSeconds(
        maxDurationMs
      )}. That measured delay is large enough to tune now.`
    : `Among ${timedEvents.toLocaleString()} timed Stop events, measured hook duration averaged ${fmtSeconds(
        meanTimedDurationMs
      )} and reached ${fmtSeconds(maxDurationMs)} — worth reviewing before it grows.`;
  return [
    lead,
    '',
    'To act on it, review your Stop hooks in `.claude/settings.json`:',
    '- Make the slow hook asynchronous (fire-and-forget, e.g. append ` &` / `nohup … &`) so its wall-clock no longer blocks completion when it fires — but only if its output is advisory; a hook that must gate completion has to stay synchronous.',
    '- Or drop the hook entirely if its side effect is no longer needed.',
    "Per-hook timing is sparse and the runtime emits no per-hook name, so identify the offender from the hook `command` strings in your settings.json.",
  ].join('\n');
}
