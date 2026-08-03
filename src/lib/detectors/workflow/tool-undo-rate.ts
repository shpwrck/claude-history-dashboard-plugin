import type { Detector } from '../types';
import type { LiveSettings } from '../../../types';
import { computeToolEffectiveness } from '../../parse-tool-effectiveness';
import { newestIsoDate, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';

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
  rule(input, now) {
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
    const undoRatePercent = Math.round(rate(top) * 100);
    const asOf = newestIsoDate(
      input.toolData.flatMap((session) =>
        session.calls
          .filter((call) => call.toolName === top.tool)
          .map((call) => call.timestamp)
      )
    );
    const stale = isAsOfStale(asOf, now, STALE_WEEKS * 7);
    const historyLead = stale
      ? `As of ${asOf}, ${top.tool} edits were`
      : `${top.tool} edits are`;
    return {
      id: 'workflow.tool-undo-rate',
      category: 'workflow',
      severity: 'info',
      title: 'Reduce immediate rollbacks on file-editing tools',
      detail: `${historyLead} rolled back (git checkout/restore/revert immediately after) ${undoRatePercent}% of the time over ${top.invocations} invocations — each undo cycle is 2+ wasted round-trips.`,
      action: stale
        ? 'Treat this as historical evidence and remeasure current edit rollbacks before changing hooks. If the pattern persists, add a PreToolUse check that runs a quick lint/typecheck before edits commit.'
        : 'Add a PreToolUse hook that runs a quick lint/typecheck before edits commit, catching errors before they need a rollback.',
      affected: top.immediatelyFollowedByUndo,
      evidence: rows.slice(0, 5).map((r) => `${r.tool}: ${Math.round(rate(r) * 100)}% undo over ${r.invocations}`),
      view: 'tools',
      provenance: {
        observations: [
          {
            claim: `the highest qualifying rollback-rate row is ${top.tool}`,
            source:
              'parse-tool-effectiveness (computeToolEffectiveness over toolData, apiErrors, and timelines)',
            field: 'computeToolEffectiveness().tool',
            value: top.tool,
          },
          {
            claim: `${top.invocations} dated ${top.tool} invocation(s) formed the denominator`,
            source: 'parse-tool-effectiveness (computeToolEffectiveness)',
            field: 'computeToolEffectiveness().invocations',
            value: top.invocations,
          },
          {
            claim: `${top.immediatelyFollowedByUndo} invocation(s) carried the immediate-undo signal`,
            source: 'parse-tool-effectiveness (computeToolEffectiveness)',
            field: 'computeToolEffectiveness().immediatelyFollowedByUndo',
            value: top.immediatelyFollowedByUndo,
          },
          ...(asOf
            ? [
                {
                  claim: `the latest contributing ${top.tool} call falls on ${asOf}`,
                  source: 'parse-tools',
                  record: top.tool,
                  field: 'toolData[].calls[].timestamp',
                  value: asOf,
                },
              ]
            : []),
        ],
        derivations: [
          {
            id: 'undo-rate-percent',
            formula:
              'round((immediatelyFollowedByUndo / invocations) * 100)',
            operands: {
              immediatelyFollowedByUndo: top.immediatelyFollowedByUndo,
              invocations: top.invocations,
            },
            value: undoRatePercent,
          },
        ],
        inference:
          'An immediate git checkout/restore/revert after an edit is a bounded proximity signal for rollback, not proof that the edit itself was wrong. The “2+ round-trips” phrase counts the edit and undo motions as a minimum workflow cost; it is not a measured wall-clock estimate.',
        ...(asOf ? { asOf, stale } : {}),
      },
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
