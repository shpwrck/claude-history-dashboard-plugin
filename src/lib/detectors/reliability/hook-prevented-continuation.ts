import type { Detector } from '../types';
import { aggregateStopHooks } from '../../parse-runtime-events';

// Stop hooks returning a blocking exit halt the session mid-run — most
// disruptive to unattended (sdk-*) workflows where nobody can intervene. (#420)
const MIN_PREVENTED = 5;

/** Flag stop hooks that blocked agent continuation. (#420) */
export const detector: Detector = {
  id: 'reliability.hook-prevented-continuation',
  category: 'reliability',
  dataDeps: ['runtimeEvents'],
  rule(input) {
    const events = input.runtimeEvents;
    if (!events || events.length === 0) return null;
    const { preventedContinuations } = aggregateStopHooks(events);
    if (preventedContinuations < MIN_PREVENTED) return null;
    return {
      id: 'reliability.hook-prevented-continuation',
      category: 'reliability',
      severity: 'warning',
      title: 'Stop hooks are blocking agent continuation',
      detail: `${preventedContinuations} stop-hook event(s) returned a blocking exit, halting the session mid-run — most disruptive to unattended (sdk-*) workflows.`,
      action:
        'Review the blocking hook; if the block is unintentional, gate on the command exit code (or append "|| true") so it only blocks on real failures.',
      affected: preventedContinuations,
      view: 'errors',
      fix: {
        target: 'hook',
        label: 'Gate the hook on exit code',
        note: 'Restructure the Stop hook so it only blocks on a genuine failure. A hook blocks when its command exits non-zero; gate it (or append "|| true") so advisory output never halts the run.',
        snippet: `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "your-check.sh || true" }
        ]
      }
    ]
  }
}`,
      },
    };
  },
};
