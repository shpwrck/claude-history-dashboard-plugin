import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate, short } from '../shared';
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
    // `scoreSessionHealth` returns scores sorted ASCENDING, so `low[0]` is the
    // worst-scoring session — the claims below depend on that and would be
    // false if the sort ever changed.
    const worst = low[0];
    const asOf = newestTokenDataDate(input.tokenData);
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
      provenance: {
        observations: [
          {
            claim: `${low.length} of ${scores.length} scored session(s) fell below the flag line`,
            source: 'context-health (scoreSessionHealth over tokenData)',
            field: 'score',
            value: low.length,
          },
          {
            claim: `the flag line is LOW_HEALTH_SCORE = ${LOW_HEALTH_SCORE}`,
            source: 'context-health',
            field: 'LOW_HEALTH_SCORE',
            value: LOW_HEALTH_SCORE,
          },
          {
            claim: `the lowest score observed is ${worst.score}, on session ${short(worst.sessionId)}`,
            source: 'context-health (scoreSessionHealth over tokenData)',
            field: 'score',
            value: worst.score,
          },
          {
            claim: `the leading penalty recorded for that session is "${worst.reasons[0] ?? 'none recorded'}"`,
            source: 'context-health (scoreSessionHealth over tokenData)',
            field: 'reasons[0]',
            value: worst.reasons[0] ?? 'none recorded',
          },
        ],
        // The score is a HEURISTIC composite, not a measurement of a single
        // quantity — saying so is what keeps the number honest (#3183).
        inference:
          'The score is a heuristic composite of cache reuse, compaction and growth, ' +
          'so it ranks sessions against each other and against a chosen line — it is ' +
          'not a measured quantity of waste, and the threshold is a convention rather ' +
          'than an observed cliff.',
        // Newest OBSERVED entry, never `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
