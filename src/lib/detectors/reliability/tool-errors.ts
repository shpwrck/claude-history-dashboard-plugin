import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import {
  hasPostEditHook,
  claudeMdMarksApplied,
  MIN_TOOL_ERROR_RATE,
  MIN_TOOL_ERROR_CALLS,
} from '../shared';
import { aggregateToolErrors } from '../../parse-errors';

/**
 * Adoption markers for `reliability.tool-errors` (#1783). The fix pastes a
 * settings.json PostToolUse hook block, not CLAUDE.md prose, so — like
 * `safety.dangerous-bypass` — there is no snippet text in the merged CLAUDE.md
 * to match. We key on the adopt-block wrapper the opt-in helper writes: the
 * `## Claude Coach Adopted Recommendations` section heading (one heading marker)
 * AND this finding's title as a body phrase (the discriminator the helper emits
 * in its `### <title> (`<id>`)` line). Heading + title, strict-AND, so the
 * section alone never credits this finding. (Title, not the bare `<id>`: the
 * #580 specificity guard requires a >=4-word phrase.) The settings-side adoption
 * (adding the hook) is still suppressed earlier by `hasPostEditHook`; these
 * markers are the CLAUDE.md-receipt path the adoption scorecard credits.
 */
const MARKERS_TOOL_ERRORS: AppliedMarkers = {
  headings: [/^##\s+Claude Coach Adopted Recommendations\b/i],
  bodyPhrases: ['Tools with high error rates'],
};

/** Tools failing a meaningful share of the time. */
export const detector: Detector = {
  id: 'reliability.tool-errors',
  appliedMarkers: MARKERS_TOOL_ERRORS,
  category: 'reliability',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input) {
    // Suppress once the fix is adopted via the CLAUDE.md receipt (#1783).
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_TOOL_ERRORS)) return null;
    // The fix is "add a PostToolUse hook on Edit|Write". If the user already has
    // a hook matching either tool, treat the rec as actioned — they may run a
    // typecheck, lint, or a different command, which is exactly what the rec's
    // note tells them to swap in.
    if (hasPostEditHook(input.liveConfig?.settings)) return null;
    const errs = aggregateToolErrors(input.toolData).filter(
      (e) => e.totalCalls >= MIN_TOOL_ERROR_CALLS && e.errorRate >= MIN_TOOL_ERROR_RATE
    );
    if (errs.length === 0) return null;
    return {
      id: 'reliability.tool-errors',
      category: 'reliability',
      severity: 'warning',
      title: 'Tools with high error rates',
      detail: `${errs.length} tool(s) failed on ${(MIN_TOOL_ERROR_RATE * 100).toFixed(0)}%+ of calls. Failed calls waste a round-trip and often trigger retries.`,
      action:
        'Investigate the top offenders — common causes are stale file state, wrong paths, or missing permissions.',
      affected: errs.reduce((s, e) => s + e.errorCalls, 0),
      evidence: errs
        .slice(0, 5)
        .map((e) => `${e.toolName}: ${(e.errorRate * 100).toFixed(0)}% of ${e.totalCalls}`),
      view: 'errors',
      fix: {
        target: 'hook',
        // Illustrative (#1101): `npm run -s typecheck` is a TEMPLATE — the user
        // must swap in their project's real check (many repos have no `typecheck`
        // script), so it is not copy-paste-safe as written.
        fixKind: 'illustrative',
        label: 'Add a post-edit typecheck hook',
        note: 'Merge into the "hooks" object in .claude/settings.json. Swap the command for your project’s real typecheck/lint so broken edits surface immediately instead of compounding.',
        snippet: `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npm run -s typecheck" }
        ]
      }
    ]
  }
}`,
        // Matches the adopt-block wrapper (not this settings.json snippet) so the
        // suppression-transition receipt can resolve a heading (#1783).
        appliedMarkers: MARKERS_TOOL_ERRORS,
      },
    };
  },
};
