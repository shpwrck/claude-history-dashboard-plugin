import type { Detector } from '../types';
import { claudeMdMarksApplied, short } from '../shared';
import { computeCompactionRisk } from '../../parse-compaction-risk';

// Sessions that compacted 2+ times — each carried compacted summary re-bills
// tokens on every subsequent turn. A narrower, /clear-oriented slice of the
// compaction cohort than context.compaction-hot-sessions. (#424)
const MIN_SESSIONS = 2;

const MARKERS = {
  headings: [/^##\s+Session resets\b/i],
  bodyPhrases: ['split the remaining work into a new session'],
};

/** Flag chronic repeated compaction within sessions. (#424) */
export const detector: Detector = {
  id: 'context.repeated-compactions',
  appliedMarkers: MARKERS,
  category: 'context',
  dataDeps: ['tokenData', 'toolData', 'timelines', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const repeat = computeCompactionRisk(
      input.tokenData,
      input.toolData,
      input.timelines ?? []
    ).filter((r) => r.compactionsObserved >= 2);
    if (repeat.length < MIN_SESSIONS) return null;
    return {
      id: 'context.repeated-compactions',
      category: 'context',
      severity: 'info',
      title: 'Sessions compacting multiple times — chronic context pressure',
      detail: `${repeat.length} session(s) compacted 2+ times; each carried compacted summary re-bills tokens on every subsequent turn.`,
      action:
        'After a compaction, /clear and start fresh when switching tasks rather than carrying the summary forward; split remaining work into a new session.',
      affected: repeat.length,
      evidence: repeat.slice(0, 5).map((r) => `${short(r.sessionId)}, ${r.compactionsObserved} compactions`),
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'illustrative',
        label: 'Add session-reset guidance',
        note: 'Append to CLAUDE.md so a second compaction triggers a clean reset instead of carrying the summary forward.',
        snippet: `## Session resets

- If a session compacts twice, run \`/clear\` and split the remaining work into a new session rather than carrying the compacted summary forward — it re-bills on every subsequent turn.`,
        appliedMarkers: MARKERS,
      },
    };
  },
};
