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
        'Review the blocking Stop hook(s); if the block is unintentional, exempt only the specific exit codes that are advisory, so a genuine failure still halts the run.',
      affected: preventedContinuations,
      view: 'errors',
      fix: {
        target: 'hook',
        label: 'Exempt only the advisory exit codes',
        // ILLUSTRATIVE, not copy-paste (#3211). The previous snippet was
        // `your-check.sh || true`, which the action and note both described as
        // blocking on real failures while it converted EVERY non-zero result to
        // success — copying it removed the exact signal the surrounding text
        // promised to keep. It cannot be repaired into a validated one-click
        // fix: this detector reads `preventedContinuation`, a per-EVENT boolean
        // from `stop_hook_summary` (see parse-runtime-events), so it observes
        // no exit code at all, and in a multi-hook event it cannot even
        // attribute the block to one hook. Which code means "advisory" is a
        // fact about the user's script that we cannot know, so the template
        // asks for it instead of inventing it.
        //
        // Safe UNEDITED: `ADVISORY_EXIT_CODE` never matches a numeric status,
        // so every non-zero exit is passed through and still blocks. Editing it
        // can only exempt codes the user names — the mistake the old snippet
        // made (mask everything) is not reachable by copying this one.
        fixKind: 'illustrative',
        note:
          'A Stop hook blocks when its command exits non-zero. Replace ADVISORY_EXIT_CODE with the exit code(s) your check uses for outcomes that should NOT halt the run (add more with "|", e.g. 0|10|20). Every other non-zero exit is passed through unchanged, so genuine failures still block. As written — before you substitute a real code — nothing is exempted and the hook blocks exactly as it does today.',
        snippet: `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "your-check.sh; status=$?; case \\"$status\\" in 0|ADVISORY_EXIT_CODE) exit 0 ;; esac; exit \\"$status\\""
          }
        ]
      }
    ]
  }
}`,
      },
    };
  },
};
