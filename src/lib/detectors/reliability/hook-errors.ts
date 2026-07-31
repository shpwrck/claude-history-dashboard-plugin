import type { Detector } from '../types';
import { aggregateStopHooks } from '../../parse-runtime-events';
import { hasStopHook, newestIsoDate } from '../shared';

// Stop hooks erroring out: an erroring guard (lint, typecheck, git, notify)
// silently does nothing on every affected turn. The raw data has no per-hook
// name, so this reports a total, not the offending hook. (#419)
const MIN_ERROR_EVENTS = 3;

/** Flag stop-hook error events. (#419) */
export const detector: Detector = {
  id: 'reliability.hook-errors',
  category: 'reliability',
  dataDeps: ['runtimeEvents', 'liveConfig'],
  rule(input) {
    const events = input.runtimeEvents;
    if (!events || events.length === 0) return null;
    const { errorEvents } = aggregateStopHooks(events);
    if (errorEvents < MIN_ERROR_EVENTS) return null;

    // #3210: the error count is HISTORICAL, so anchor it to the newest recorded
    // error event's date — derived from the DATA, never from `now`. Unreadable
    // timestamps yield no asOf (honest absence beats a fabricated date).
    const asOf = newestIsoDate(
      events.flatMap((s) =>
        s.stopHooks.filter((h) => h.hadErrors).map((h) => h.timestamp)
      )
    );

    // Stale-input demotion (#1102, tightened by #3210): only a CONFIRMED
    // currently-configured Stop hook justifies the present-tense warning. Both
    // failure modes — a readable config with no Stop hook, and an unreadable
    // config — cannot confirm the hook is still active, so both demote to
    // historical/as-of wording at info severity. "Can't tell" must not be
    // phrased as "is still failing".
    const configReadable = input.liveConfig != null;
    const stopConfigured = hasStopHook(input.liveConfig?.settings);
    const demote = !stopConfigured;
    const asOfLead = asOf ? `As of ${asOf}, ` : '';

    return {
      id: 'reliability.hook-errors',
      category: 'reliability',
      severity: demote ? 'info' : 'warning',
      title: demote
        ? configReadable
          ? 'Stop hooks errored in the past (none configured now)'
          : 'Stop hooks errored in the past (current hook status unknown)'
        : 'Stop hooks are firing with errors',
      detail: demote
        ? configReadable
          ? `${asOfLead}Stop hooks had errored on ${errorEvents} event(s) across your history. No Stop hook is configured in settings.json now, so this is historical — an erroring guard (lint, typecheck, git, notify) would have silently done nothing on every affected turn.`
          : `${asOfLead}Stop hooks had errored on ${errorEvents} event(s) across your history. Current settings.json could not be read, so whether an erroring Stop hook is still configured is unknown — treat this as historical evidence, not a current failure.`
        : `Stop hooks errored on ${errorEvents} event(s) across your history; an erroring guard (lint, typecheck, git, notify) silently does nothing on every affected turn.`,
      action: demote
        ? configReadable
          ? 'No action needed unless you re-add a Stop hook; if you do, make sure its command handles errors so it does not fail silently. (visible in stop_hook_summary lines)'
          : 'Re-check your current settings.json Stop hooks first; if one is still configured, inspect its command (visible in stop_hook_summary lines) and add error handling so it does not fail silently.'
        : 'Inspect the failing hook command (visible in stop_hook_summary lines), fix it or add error handling so it does not fail silently.',
      affected: errorEvents,
      provenance: {
        observations: [
          {
            claim: `${errorEvents} Stop-hook error event(s) recorded across history${asOf ? `, newest dated ${asOf}` : ''}`,
            source: 'parse-runtime-events',
            field: 'aggregateStopHooks().errorEvents',
            value: errorEvents,
          },
          {
            claim: stopConfigured
              ? 'a Stop hook is currently configured'
              : configReadable
                ? 'no Stop hook is currently configured'
                : 'current settings.json could not be read',
            source: 'settings.json',
            field: 'hooks.Stop',
          },
        ],
        inference: demote
          ? configReadable
            ? 'The error count is historical and no Stop hook is configured now, so the failure is not current — wording is demoted to past tense.'
            : 'The error count is historical and the current configuration cannot confirm the hook is still active, so the claim is demoted to dated historical wording instead of a present-tense failure.'
          : 'A Stop hook is currently configured, so the historical error count likely reflects an ongoing silent-failure risk.',
        ...(asOf ? { asOf } : {}),
      },
      view: 'errors',
    };
  },
};
