import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, short } from '../shared';
import { OVER_WINDOW, computeContextGrowth } from '../../context-health';

const MARKERS_OVER_WINDOW: AppliedMarkers = {
  headings: [/^##\s+Context discipline\b/i],
  bodyPhrases: ['working context well under the model'],
};

/** Sessions that blew past the usable context window — compact earlier. */
export const detector: Detector = {
  id: 'context.over-window',
  category: 'context',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_OVER_WINDOW)) return null;
    const growth = computeContextGrowth(input.tokenData);
    const over = growth.filter((g) => g.peakContext > OVER_WINDOW);
    if (over.length === 0) return null;
    return {
      id: 'context.over-window',
      category: 'context',
      severity: 'warning',
      title: 'Sessions spilled past the 200K context window',
      detail: `${over.length} session(s) peaked above 200K tokens, where context is evicted and re-sent at cost.`,
      action:
        'Compact earlier or start a fresh session once a task is done — keep working context well under the window.',
      affected: over.length,
      evidence: over
        .slice(0, 5)
        .map((g) => `${short(g.sessionId)}, peak ${(g.peakContext / 1000).toFixed(0)}k`),
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        label: 'Compact earlier',
        note: 'Append to your project (or ~/.claude) CLAUDE.md so Claude trims context before the window fills.',
        snippet: `## Context discipline\n\nKeep the working context well under the model's context window.\n- When the conversation grows large (roughly 150K+ tokens) or right after finishing a discrete task, run \`/compact\` to summarise and reclaim space.\n- When starting genuinely unrelated work, run \`/clear\` to begin a fresh session instead of carrying stale context.\n- Avoid pulling large files or command output into context the current task doesn't need.`,
        appliedMarkers: MARKERS_OVER_WINDOW,
      },
    };
  },
};
