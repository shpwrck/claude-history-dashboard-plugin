import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, short } from '../shared';
import { LOW_HEALTH_SCORE, scoreSessionHealth } from '../../context-health';

const MARKERS_LOW_HEALTH: AppliedMarkers = {
  headings: [/^##\s+(Keep the session|Session) heal/i],
  bodyPhrases: ['Avoid switching permission modes mid-session'],
};

/** Heuristic health score below the flag line. */
export const detector: Detector = {
  id: 'context.low-health',
  appliedMarkers: MARKERS_LOW_HEALTH,
  category: 'context',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_LOW_HEALTH)) return null;
    const scores = scoreSessionHealth(input.tokenData);
    const low = scores.filter((s) => s.score < LOW_HEALTH_SCORE);
    if (low.length === 0) return null;
    return {
      id: 'context.low-health',
      category: 'context',
      severity: 'warning',
      title: 'Low session-health scores',
      detail: `${low.length} session(s) scored below ${LOW_HEALTH_SCORE} on the context-health heuristic (cache reuse, compaction, growth).`,
      action: 'Open Context Health to see the per-session reasons and address the worst offenders.',
      affected: low.length,
      evidence: low
        .slice(0, 5)
        .map((s) => `${short(s.sessionId)}, ${s.score}, ${s.reasons[0] ?? ''}`),
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'illustrative',
        label: 'Keep context healthy',
        note: 'Append to CLAUDE.md to curb the growth/churn that drags the health score down.',
        snippet: `## Keep the session healthy\n\n- Read a file once and work from that context; don't re-Read unchanged files.\n- Don't load large or unrelated files "just in case" — pull only what the current task needs.\n- After completing a task, \`/compact\` (to keep going) or \`/clear\` (for unrelated next work) rather than letting context grow unbounded.\n- Avoid switching permission modes mid-session; it churns context and hurts cache reuse.`,
        appliedMarkers: MARKERS_LOW_HEALTH,
      },
    };
  },
};
