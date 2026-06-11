import type { Detector } from '../types';
import type { LiveSettings } from '../../../types';
import { computeToolEffectiveness } from '../../parse-tool-effectiveness';

// File edits rolled back (git checkout/restore/revert right after) a meaningful
// share of the time — each undo cycle is 2+ wasted round-trips. (#422)
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MIN_INVOCATIONS = 10;
const MIN_UNDO_RATE = 0.1;

function hasPreEditHook(settings: LiveSettings | null | undefined): boolean {
  const pre = settings?.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return false;
  return pre.some((h) => /\bEdit\b|\bWrite\b/.test(typeof h?.matcher === 'string' ? h.matcher : ''));
}

/**
 * Flag file-edit tools with a high immediate-rollback rate. Self-suppresses once
 * a PreToolUse Edit|Write hook is configured (the recommended pre-edit check is
 * in place). (#422)
 */
export const detector: Detector = {
  id: 'workflow.tool-undo-rate',
  category: 'workflow',
  dataDeps: ['toolData', 'apiErrors', 'timelines', 'liveConfig'],
  rule(input) {
    if (hasPreEditHook(input.liveConfig?.settings)) return null;
    const rows = computeToolEffectiveness(
      input.toolData,
      input.apiErrors,
      input.timelines ?? []
    ).filter(
      (r) =>
        EDIT_TOOLS.has(r.tool) &&
        r.invocations >= MIN_INVOCATIONS &&
        r.immediatelyFollowedByUndo / r.invocations >= MIN_UNDO_RATE
    );
    if (rows.length === 0) return null;
    const rate = (r: (typeof rows)[number]) => r.immediatelyFollowedByUndo / r.invocations;
    rows.sort((a, b) => rate(b) - rate(a));
    const top = rows[0];
    return {
      id: 'workflow.tool-undo-rate',
      category: 'workflow',
      severity: 'info',
      title: 'Reduce immediate rollbacks on file-editing tools',
      detail: `${top.tool} edits are rolled back (git checkout/restore/revert immediately after) ${Math.round(rate(top) * 100)}% of the time over ${top.invocations} invocations — each undo cycle is 2+ wasted round-trips.`,
      action:
        'Add a PreToolUse hook that runs a quick lint/typecheck before edits commit, catching errors before they need a rollback.',
      affected: top.immediatelyFollowedByUndo,
      evidence: rows.slice(0, 5).map((r) => `${r.tool}: ${Math.round(rate(r) * 100)}% undo over ${r.invocations}`),
      view: 'tools',
      fix: {
        target: 'settings.json',
        // Illustrative (#1101): a hook template — the note tells the user to swap
        // the command for their own lint/typecheck, so it is not copy-paste-safe
        // as written even though `npm run -s lint` happens to exist here.
        fixKind: 'illustrative',
        label: 'Add a pre-edit check hook',
        note: 'Merge into .claude/settings.json hooks. Swap the command for your real lint/typecheck so broken edits are caught before they need rolling back.',
        snippet: `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npm run -s lint" }
        ]
      }
    ]
  }
}`,
      },
    };
  },
};
