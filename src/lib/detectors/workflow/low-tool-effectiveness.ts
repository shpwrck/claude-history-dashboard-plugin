import type { Detector } from '../types';
import {
  hasPostEditHook,
  newestIsoDate,
  STALE_WEEKS,
} from '../shared';
import { isAsOfStale } from '../provenance';
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
  rule(input, now) {
    if (hasPostEditHook(input.liveConfig?.settings)) return null;
    const rows = computeToolEffectiveness(
      input.toolData,
      input.apiErrors,
      input.timelines ?? []
    ).filter((r) => r.effectivenessScore < MAX_SCORE && r.invocations >= MIN_INVOCATIONS);
    if (rows.length === 0) return null;
    rows.sort((a, b) => a.effectivenessScore - b.effectivenessScore);
    const top = rows[0];
    // computeToolEffectiveness counts only calls with readable timestamps. Date
    // this tool's row from those same invocations rather than a newer,
    // unrelated tool elsewhere in the corpus.
    const asOf = newestIsoDate(
      input.toolData.flatMap((session) =>
        session.calls
          .filter((call) => call.toolName === top.tool)
          .map((call) => call.timestamp)
      )
    );
    const stale = isAsOfStale(asOf, now, STALE_WEEKS * 7);
    const historyLead = stale ? `As of ${asOf}, tool` : 'Tool';
    const displayedScore = Number(top.effectivenessScore.toFixed(2));
    return {
      id: 'workflow.low-tool-effectiveness',
      category: 'workflow',
      severity: 'info',
      title: 'Fix tools with persistently low effectiveness',
      detail: `${historyLead} ${top.tool} has an effectiveness score of ${top.effectivenessScore.toFixed(2)} (below ${MAX_SCORE}) over ${top.invocations} invocations — error/undo/retry signals outweigh forward motion.`,
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
      provenance: {
        observations: [
          {
            claim: `the lowest qualifying row identifies tool ${top.tool}`,
            source:
              'parse-tool-effectiveness (computeToolEffectiveness over toolData, apiErrors, and timelines)',
            field: 'computeToolEffectiveness().tool',
            value: top.tool,
          },
          {
            claim: `${top.invocations} dated invocation(s) were counted for ${top.tool}`,
            source: 'parse-tool-effectiveness (computeToolEffectiveness)',
            field: 'computeToolEffectiveness().invocations',
            value: top.invocations,
          },
          {
            claim: `${rows.length} tool row(s) cleared both qualification floors`,
            source:
              'workflow.low-tool-effectiveness over computeToolEffectiveness rows',
            field: 'rows.length',
            value: rows.length,
          },
          {
            claim:
              `the composite inputs were ${top.immediatelyFollowedByError} error, ` +
              `${top.immediatelyFollowedByRetry} retry, ` +
              `${top.immediatelyFollowedByUndo} undo, and ` +
              `${top.immediatelyFollowedByProgress} forward-motion signal(s)`,
            source: 'parse-tool-effectiveness (computeToolEffectiveness)',
            field:
              'computeToolEffectiveness().{immediatelyFollowedByError,immediatelyFollowedByRetry,immediatelyFollowedByUndo,immediatelyFollowedByProgress}',
            value:
              `${top.immediatelyFollowedByError}/` +
              `${top.immediatelyFollowedByRetry}/` +
              `${top.immediatelyFollowedByUndo}/` +
              `${top.immediatelyFollowedByProgress}`,
          },
          {
            claim: `the displayed effectiveness score is ${displayedScore}`,
            source: 'parse-tool-effectiveness (computeToolEffectiveness)',
            field: 'computeToolEffectiveness().effectivenessScore',
            value: displayedScore,
          },
          {
            claim: `rows qualify below MAX_SCORE = ${MAX_SCORE}`,
            source: 'workflow.low-tool-effectiveness detector',
            field: 'MAX_SCORE',
            value: MAX_SCORE,
          },
          {
            claim: `rows require at least MIN_INVOCATIONS = ${MIN_INVOCATIONS}`,
            source: 'workflow.low-tool-effectiveness detector',
            field: 'MIN_INVOCATIONS',
            value: MIN_INVOCATIONS,
          },
        ],
        inference:
          'The score is a directional proxy combining nearby error, retry, undo, and ' +
          'forward-motion signals. It is not ground truth that the tool failed its task, ' +
          'nor proof that the tool itself caused the surrounding behavior.',
        ...(asOf ? { asOf, stale } : {}),
      },
    };
  },
};
