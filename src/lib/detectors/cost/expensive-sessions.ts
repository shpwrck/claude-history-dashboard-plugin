import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, fmtUsd, short, MIN_SAVINGS_USD } from '../shared';
import { estimateCost } from '../../parse-sessions';
import { topExpensiveSessions } from '../../cost-attribution';

const MARKERS_EXPENSIVE_SESSIONS: AppliedMarkers = {
  headings: [/^##\s+Session scope\b/i],
  bodyPhrases: ['start a fresh session when the task changes'],
};

/** The few sessions that dominate spend — worth reviewing for waste. */
export const detector: Detector = {
  id: 'cost.expensive-sessions',
  appliedMarkers: MARKERS_EXPENSIVE_SESSIONS,
  category: 'cost',
  dataDeps: ['tokenData', 'toolData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_EXPENSIVE_SESSIONS)) return null;
    const top = topExpensiveSessions(input.tokenData, input.toolData, 5);
    const totalCost = input.tokenData.reduce((s, d) => s + estimateCost(d), 0);
    const top3 = top.slice(0, 3);
    const top3Cost = top3.reduce((s, r) => s + r.estimatedCost, 0);
    if (totalCost <= 0 || top3Cost < MIN_SAVINGS_USD) return null;
    const share = (top3Cost / totalCost) * 100;
    // Only worth flagging when spend is concentrated in a handful of sessions.
    if (share < 25 || input.tokenData.length < 5) return null;
    return {
      id: 'cost.expensive-sessions',
      category: 'cost',
      severity: 'info',
      title: 'Spend is concentrated in a few sessions',
      detail: `The top 3 sessions account for ${share.toFixed(0)}% of total estimated spend (${fmtUsd(top3Cost)} of ${fmtUsd(totalCost)}).`,
      action:
        'Review these sessions for runaway context or repeated work that could be scoped down or split.',
      estSavingsUsd: top3Cost,
      affected: top3.length,
      evidence: top3.map(
        (r) => `${short(r.sessionId)}, ${fmtUsd(r.estimatedCost)}, ${r.topTool ?? 'no tools'}`
      ),
      view: 'cost',
      fix: {
        target: 'CLAUDE.md',
        label: 'Add session-scoping guidance',
        note: 'Paste into CLAUDE.md to curb the runaway-context pattern behind the top sessions.',
        snippet: `## Session scope\n- Keep one session to one task; start a fresh session when the task changes so stale context is not re-sent and re-billed each turn.\n- Compact or clear once a sub-task is done rather than letting context grow unbounded.\n- Avoid re-reading large files or directories repeatedly in a single session; reference them once.`,
        appliedMarkers: MARKERS_EXPENSIVE_SESSIONS,
      },
    };
  },
};
