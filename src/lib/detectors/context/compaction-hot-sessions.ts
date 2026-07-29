import type { Detector } from '../types';
import { claudeMdMarksApplied, newestTokenDataDate } from '../shared';
import {
  computeCompactionRisk,
  summarizeCompactionRisk,
} from '../../parse-compaction-risk';
import { computeCacheEfficiency, reclaimableCacheWriteFrac } from '../../context-health';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

// A cohort of sessions sitting in the high compaction-risk band — uncontrolled
// compaction re-sends 10–40K tokens per event. (#415)
const MIN_HOT_SESSIONS = 2;
const MIN_HOT_PERCENT = 40;

/**
 * Smallest fleet for which the PERCENT arm is allowed to fire (#3424).
 *
 * `hotPercent` is `hot / total`, so a single hot session in a one-session corpus
 * reads as "100% of the fleet" and tripped the percent arm on its own — the
 * detector then announced "Multiple sessions at high compaction risk" about one
 * session, and reported a fleet proportion computed from n=1. A proportion is
 * not a fleet statistic until there is a fleet.
 *
 * DERIVED from the two thresholds above rather than picked: below
 * `MIN_HOT_SESSIONS / (MIN_HOT_PERCENT / 100)` = 2 / 0.4 = 5 sessions, the
 * percent arm can only ever fire for FEWER hot sessions than the absolute arm
 * already requires, so it can only weaken the bar. At or above it the two arms
 * agree at the boundary (40% of 5 is 2), which also keeps the "Multiple
 * sessions" headline true whenever this fires.
 */
const MIN_FLEET_FOR_PERCENT = Math.ceil(MIN_HOT_SESSIONS / (MIN_HOT_PERCENT / 100));

const MARKERS = {
  headings: [/^##\s+Context discipline\b/i],
  bodyPhrases: ['letting context grow until it auto-compacts'],
};

/**
 * Flag a hot compaction-risk cohort, leading with the pre-bucketed dominant
 * suggestion. Self-suppresses on the context-discipline CLAUDE.md note (shared
 * with context.over-window). (#415)
 */
export const detector: Detector = {
  id: 'context.compaction-hot-sessions',
  appliedMarkers: MARKERS,
  category: 'context',
  dataDeps: ['tokenData', 'toolData', 'timelines', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const rows = computeCompactionRisk(
      input.tokenData,
      input.toolData,
      input.timelines ?? []
    );
    const summary = summarizeCompactionRisk(rows);
    // The percent arm needs a fleet to be a proportion OF (#3424); below that
    // only the absolute hot-session count can fire.
    const percentArmApplies =
      summary.totalSessions >= MIN_FLEET_FOR_PERCENT &&
      summary.hotPercent >= MIN_HOT_PERCENT;
    if (summary.hotSessions < MIN_HOT_SESSIONS && !percentArmApplies) {
      return null;
    }
    const lead = summary.topSuggestion ? ` Dominant fix for the cohort: ${summary.topSuggestion}.` : '';

    // ── Reclaim claim (epic #944, PR3 / #949) ────────────────────────────────
    // Uncontrolled compaction re-feeds the compacted prefix on every later turn —
    // a hot session pays its prefix as cache-WRITE far more than it reuses it. We
    // delete a fraction of the hot cohort's cache-write pools, where the fraction
    // is **derived from each session's measured cache hit-rate**
    // (`reclaimableCacheWriteFrac`), never a hardcoded constant: the further below
    // the reuse floor a hot session sits, the more of its repeated prefix-writes
    // bought nothing. `scaleTokens` carries one per-pool fraction for the whole
    // claim, so we book a token-weighted mean frac over the hot sessions' write
    // tokens — strictly grounded in `computeCacheEfficiency`, conservative (a hot
    // session already at/above the reuse floor contributes 0). The cascade's
    // residual carving keeps this from double-booking the cells low-cache-hit also
    // touches (doc §4 guarded-marginal identity).
    const hotIds = new Set(rows.filter((r) => r.riskClass !== 'low').map((r) => r.sessionId));
    const fracBySession = new Map(
      computeCacheEfficiency(input.tokenData)
        .filter((r) => hotIds.has(r.sessionId))
        .map((r) => [r.sessionId, reclaimableCacheWriteFrac(r.hitRate)])
    );
    const scopeKeys = new Set<string>();
    let weightedFracNum = 0;
    let writeTokens = 0;
    for (const d of input.tokenData) {
      if (!hotIds.has(d.sessionId)) continue;
      const frac = fracBySession.get(d.sessionId) ?? 0;
      for (const e of d.entries) {
        const writes = e.cacheCreationTokens;
        if (writes <= 0) continue;
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        weightedFracNum += writes * frac;
        writeTokens += writes;
      }
    }
    const poolFrac = writeTokens > 0 ? weightedFracNum / writeTokens : 0;
    const reclaim: ReclaimClaim | undefined =
      writeTokens > 0 && poolFrac > 0
        ? {
            leverId: 'context.compaction-hot-sessions',
            category: 'context',
            cause: 'structural-prefix',
            // Structural context band [40,90); slightly after low-cache-hit so the
            // narrower compaction cohort books against the residual it leaves.
            orderKey: 62,
            ownedPools: ['cacheWrite5m', 'cacheWrite1h'],
            scopeKeys: [...scopeKeys],
            counterfactual: {
              kind: 'scaleTokens',
              poolDeltaFrac: { cacheWrite5m: poolFrac, cacheWrite1h: poolFrac },
            },
            evidenceTokens: writeTokens,
          }
        : undefined;

    const asOf = newestTokenDataDate(input.tokenData);

    return {
      id: 'context.compaction-hot-sessions',
      category: 'context',
      severity: 'warning',
      title: 'Multiple sessions at high compaction risk',
      detail: `${summary.hotSessions} session(s) (${summary.hotPercent.toFixed(0)}% of the fleet) are in the high compaction-risk band; uncontrolled compaction re-sends 10–40K tokens per event.`,
      action: `Run /compact at task boundaries, /clear when switching tasks, and scope Read with offset/limit.${lead}`,
      ...(reclaim ? { reclaim } : {}),
      affected: summary.hotSessions,
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'illustrative',
        label: 'Add context discipline',
        note: 'Append to CLAUDE.md so sessions trim context before they thrash into repeated compaction.',
        snippet: `## Context discipline

- Run \`/compact\` at sub-task boundaries and \`/clear\` when switching tasks, rather than letting context grow until it auto-compacts.
- Read with \`offset\`/\`limit\` and prefer Grep over reading whole large files.
- Don't pull large or unrelated files into context the current task doesn't need.`,
        appliedMarkers: MARKERS,
      },
      provenance: {
        observations: [
          {
            claim: `${summary.hotSessions} of ${summary.totalSessions} scored session(s) sit in the medium-or-high compaction-risk band`,
            source: 'parse-compaction-risk (computeCompactionRisk + summarizeCompactionRisk)',
            field: 'riskClass',
            value: summary.hotSessions,
          },
          {
            claim: `that is ${summary.hotPercent.toFixed(0)}% of the scored fleet`,
            source: 'parse-compaction-risk (summarizeCompactionRisk)',
            field: 'hotPercent',
            value: Number(summary.hotPercent.toFixed(2)),
          },
          {
            claim: `the finding needs either MIN_HOT_SESSIONS = ${MIN_HOT_SESSIONS} hot sessions, or ${MIN_HOT_PERCENT}% of a fleet of at least MIN_FLEET_FOR_PERCENT = ${MIN_FLEET_FOR_PERCENT}`,
            source: 'detectors/context/compaction-hot-sessions',
            field: 'MIN_HOT_SESSIONS / MIN_HOT_PERCENT / MIN_FLEET_FOR_PERCENT',
            value: MIN_HOT_SESSIONS,
          },
          summary.topSuggestion
            ? {
                claim: `the most common leading suggestion across the hot cohort is "${summary.topSuggestion}", on ${summary.topSuggestionCount} of them`,
                source: 'parse-compaction-risk (summarizeCompactionRisk)',
                field: 'topSuggestion / topSuggestionCount',
                value: summary.topSuggestionCount,
              }
            : {
                claim: 'no leading suggestion was harvested from the hot cohort',
                source: 'parse-compaction-risk (summarizeCompactionRisk)',
                field: 'topSuggestion',
              },
          ...(reclaim
            ? [
                {
                  claim: `${writeTokens} cache-write token(s) across the hot cohort back the reclaim claim, of which the measured cache-shortfall fraction is ${(poolFrac * 100).toFixed(1)}%`,
                  source: 'context-health (computeCacheEfficiency + reclaimableCacheWriteFrac)',
                  field: 'tokenData[].entries[].cacheCreationTokens / hitRate',
                  value: writeTokens,
                },
              ]
            : []),
        ],
        // The band membership and the cache-write pool are measured. The
        // "10-40K tokens per event" in `detail` is a DOCUMENTED range, not a
        // per-event measurement taken here — several v0.6 findings exist
        // precisely because a detail sentence asserted a cost the detector
        // never measured (#3180).
        inference:
          'What is measured is band membership (a heuristic composite of peak, growth, ' +
          'tool-output rate, re-read density and compaction count) and the cohort\'s ' +
          'cache-write pool. The 10-40K-tokens-per-event figure in the headline is a ' +
          'documented range for compaction in general — this detector does not measure ' +
          'the tokens any individual compaction re-sent. The risk band is a forward-looking ' +
          'score, so a hot session has not necessarily compacted yet.',
        // Newest OBSERVED entry, never `now`.
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
