import type { Detector } from '../types';
import { hasPostEditHook } from '../shared';
import { computeToolEffectiveness } from '../../parse-tool-effectiveness';

// A tool whose composite effectiveness (error/undo/retry vs forward motion)
// stays low over many invocations. Folds signals that no single component rule
// would catch. (#423)
const MIN_INVOCATIONS = 10;
const MAX_SCORE = 0.4;

/**
 * Flag persistently low-effectiveness tools. Self-suppresses once a PostToolUse
 * validation hook (the recommended fix) is configured. (#423)
 */
export const detector: Detector = {
  id: 'workflow.low-tool-effectiveness',
  category: 'workflow',
  dataDeps: ['toolData', 'apiErrors', 'timelines', 'liveConfig'],
  rule(input) {
    if (hasPostEditHook(input.liveConfig?.settings)) return null;
    const rows = computeToolEffectiveness(
      input.toolData,
      input.apiErrors,
      input.timelines ?? []
    ).filter((r) => r.effectivenessScore < MAX_SCORE && r.invocations >= MIN_INVOCATIONS);
    if (rows.length === 0) return null;
    rows.sort((a, b) => a.effectivenessScore - b.effectivenessScore);
    const top = rows[0];
    return {
      id: 'workflow.low-tool-effectiveness',
      category: 'workflow',
      severity: 'info',
      title: 'Fix tools with persistently low effectiveness',
      detail: `Tool ${top.tool} has an effectiveness score of ${top.effectivenessScore.toFixed(2)} (below ${MAX_SCORE}) over ${top.invocations} invocations — error/undo/retry signals outweigh forward motion.`,
      action:
        'Add a PostToolUse hook that validates the result (exit code, path-exists, typecheck) for the flagged tool so errors surface before the next turn.',
      affected: rows.length,
      evidence: rows.slice(0, 5).map((r) => `${r.tool}: score ${r.effectivenessScore.toFixed(2)} over ${r.invocations}`),
      view: 'tools',
      fix: {
        target: 'hook',
        // Illustrative (#1101): the hook command is a template the user swaps for
        // their real check — `npm run -s typecheck` is not guaranteed to exist.
        fixKind: 'illustrative',
        label: 'Validate the low-scoring tool',
        note: `Merge into .claude/settings.json hooks. Validates ${top.tool} results so errors surface immediately; swap the command for your real check.`,
        snippet: `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "${top.tool}",
        "hooks": [
          { "type": "command", "command": "npm run -s typecheck" }
        ]
      }
    ]
  }
}`,
      },
    };
  },
};
