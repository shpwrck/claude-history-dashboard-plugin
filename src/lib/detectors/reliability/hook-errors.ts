import type { Detector } from '../types';
import { aggregateStopHooks } from '../../parse-runtime-events';
import { hasStopHook } from '../shared';

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

    // Stale-input demotion (#1102): `errorEvents` is a HISTORICAL count from
    // runtime events. Only phrase it in the present tense ("are firing") when a
    // Stop hook is still configured. When the bundle is readable and shows no
    // Stop hook, the offending hook has since been removed — demote to past
    // tense rather than asserting a current failure. `null` liveConfig means
    // "can't tell" → keep the original present-tense wording (don't hide it).
    const configReadable = input.liveConfig != null;
    const stopConfigured = hasStopHook(input.liveConfig?.settings);
    const demote = configReadable && !stopConfigured;

    return {
      id: 'reliability.hook-errors',
      category: 'reliability',
      severity: demote ? 'info' : 'warning',
      title: demote
        ? 'Stop hooks errored in the past (none configured now)'
        : 'Stop hooks are firing with errors',
      detail: demote
        ? `Stop hooks errored on ${errorEvents} event(s) across your history. No Stop hook is configured in settings.json now, so this is historical — an erroring guard (lint, typecheck, git, notify) would have silently done nothing on every affected turn.`
        : `Stop hooks errored on ${errorEvents} event(s) across your history; an erroring guard (lint, typecheck, git, notify) silently does nothing on every affected turn.`,
      action: demote
        ? 'No action needed unless you re-add a Stop hook; if you do, make sure its command handles errors so it does not fail silently. (visible in stop_hook_summary lines)'
        : 'Inspect the failing hook command (visible in stop_hook_summary lines), fix it or add error handling so it does not fail silently.',
      affected: errorEvents,
      provenance: {
        observations: [
          {
            claim: `${errorEvents} Stop-hook error event(s) recorded across history`,
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
          ? 'The error count is historical and no Stop hook is configured now, so the failure is not current — wording is demoted to past tense.'
          : 'A Stop hook is (or may be) configured, so the historical error count likely reflects an ongoing silent-failure risk.',
      },
      view: 'errors',
    };
  },
};
