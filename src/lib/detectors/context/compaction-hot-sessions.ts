import type { Detector } from '../types';
import { claudeMdMarksApplied } from '../shared';
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
    if (summary.hotSessions < MIN_HOT_SESSIONS && summary.hotPercent < MIN_HOT_PERCENT) {
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
    };
  },
};
