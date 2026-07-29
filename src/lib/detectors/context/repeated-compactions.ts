import type { Detector } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate, short } from '../shared';
import { computeCompactionRisk } from '../../parse-compaction-risk';

// Sessions that compacted 2+ times — each carried compacted summary re-bills
// tokens on every subsequent turn. A narrower, /clear-oriented slice of the
// compaction cohort than context.compaction-hot-sessions. (#424)

/** How many sessions must qualify before this is reported as a pattern. */
const MIN_SESSIONS = 2;
/**
 * How many compactions make ONE session qualify.
 *
 * Named rather than inlined because it and {@link MIN_SESSIONS} are both `2`
 * but count different things (compactions per session vs qualifying sessions),
 * and the provenance has to cite each against the constant it actually is —
 * conflating them is how a citation ends up pointing at the wrong field (#3188).
 */
const MIN_COMPACTIONS = 2;

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
    ).filter((r) => r.compactionsObserved >= MIN_COMPACTIONS);
    if (repeat.length < MIN_SESSIONS) return null;
    // `computeCompactionRisk` returns rows sorted by riskScore, NOT by
    // compaction count — so `repeat[0]` is the highest-RISK session and calling
    // it "the most compacted" would be a false claim. Take the max over the
    // field the observation actually cites.
    const mostCompacted = repeat.reduce((a, b) =>
      b.compactionsObserved > a.compactionsObserved ? b : a
    );
    const asOf = newestTokenDataDate(input.tokenData);
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
      provenance: {
        observations: [
          {
            claim: `${repeat.length} session(s) recorded ${MIN_COMPACTIONS} or more compaction events`,
            source:
              'parse-compaction-risk (computeCompactionRisk over tokenData.compactionEvents)',
            field: 'compactionsObserved',
            value: repeat.length,
          },
          {
            claim: `the highest compaction count observed is ${mostCompacted.compactionsObserved}, on session ${short(mostCompacted.sessionId)}`,
            source:
              'parse-compaction-risk (computeCompactionRisk over tokenData.compactionEvents)',
            field: 'compactionsObserved',
            value: mostCompacted.compactionsObserved,
          },
          {
            claim: `a session qualifies at MIN_COMPACTIONS = ${MIN_COMPACTIONS} compactions, and the finding is withheld below MIN_SESSIONS = ${MIN_SESSIONS} such sessions`,
            source: 'detectors/context/repeated-compactions',
            field: 'MIN_COMPACTIONS / MIN_SESSIONS',
            value: MIN_SESSIONS,
          },
        ],
        // What is counted is OCCURRENCES. The re-billing in the detail is the
        // documented consequence of carrying a compacted summary forward — the
        // re-billed tokens themselves are not measured here (#3188).
        inference:
          'Compaction events are counted, not the tokens they went on to re-bill. ' +
          'A carried summary is re-sent on every later turn by construction, so ' +
          'repeated compaction indicates sustained context pressure — it is not a ' +
          'measurement of the amount re-paid.',
        // Anchored to the newest OBSERVED turn, never to `now`: the count is
        // only true as of the last thing the corpus actually recorded.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
