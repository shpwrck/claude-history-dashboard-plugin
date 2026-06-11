import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied } from '../shared';
import {
  LOW_HIT_RATE,
  computeCacheEfficiency,
  reclaimableCacheWriteFrac,
} from '../../context-health';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

const MARKERS_LOW_CACHE_HIT: AppliedMarkers = {
  headings: [/^##\s+(Keep the )?prompt cache\b/i],
  bodyPhrases: ['stable context prefix, so avoid churning'],
};

/** Low cache hit rate across sessions — context is being re-sent uncached. */
export const detector: Detector = {
  id: 'context.low-cache-hit',
  category: 'context',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_LOW_CACHE_HIT)) return null;
    const eff = computeCacheEfficiency(input.tokenData).filter(
      (r) => r.totalReads + r.totalWrites > 0
    );
    if (eff.length === 0) return null;
    const low = eff.filter((r) => r.hitRate < LOW_HIT_RATE);
    if (low.length === 0) return null;
    const avg = eff.reduce((s, r) => s + r.hitRate, 0) / eff.length;

    // ── Reclaim claim (epic #944, PR3 / #949) ────────────────────────────────
    // A cache *write* that the session never read back is pure waste — the prefix
    // was churned before the prompt cache could be reused. We delete a fraction of
    // the low-hit-rate sessions' cache-WRITE pools, where the fraction is
    // **derived from the measured hit-rate** (`reclaimableCacheWriteFrac`), never a
    // hardcoded constant: the further below the reuse floor a session sits, the
    // larger its wasted write share. `scaleTokens` carries ONE per-pool fraction
    // for the whole claim, so we book a single token-weighted average frac across
    // the low sessions' cache-write tokens — still strictly grounded in
    // `computeCacheEfficiency` (higher measured hit-rate ⇒ smaller frac).
    const lowIds = new Set(low.map((r) => r.sessionId));
    const fracBySession = new Map(low.map((r) => [r.sessionId, reclaimableCacheWriteFrac(r.hitRate)]));
    const scopeKeys = new Set<string>();
    let weightedFracNum = 0;
    let writeTokens = 0;
    for (const d of input.tokenData) {
      if (!lowIds.has(d.sessionId)) continue;
      const frac = fracBySession.get(d.sessionId) ?? 0;
      for (const e of d.entries) {
        const writes = e.cacheCreationTokens;
        if (writes <= 0) continue;
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
        weightedFracNum += writes * frac;
        writeTokens += writes;
      }
    }
    // Token-weighted mean deletable fraction across the low sessions' write pools.
    const poolFrac = writeTokens > 0 ? weightedFracNum / writeTokens : 0;
    // Only emit a token-touching claim when there is real cache-write to reclaim
    // AND the grounded fraction is non-zero; otherwise the claim has no dollars to
    // book and is omitted (the advisory finding still fires).
    const reclaim: ReclaimClaim | undefined =
      writeTokens > 0 && poolFrac > 0
        ? {
            leverId: 'context.low-cache-hit',
            category: 'context',
            cause: 'structural-prefix',
            // Structural context band [40,90); behavioural causes run ahead.
            orderKey: 60,
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
      id: 'context.low-cache-hit',
      category: 'context',
      severity: 'info',
      title: 'Low cache hit rate on some sessions',
      detail: `${low.length} session(s) read back less than ${(LOW_HIT_RATE * 100).toFixed(0)}% of cached context (overall average ${(avg * 100).toFixed(0)}%). Low reuse means more tokens billed at full input rate.`,
      action:
        'Avoid frequent context churn within a session (large unrelated reads, mode switches) so the prompt cache stays warm.',
      ...(reclaim ? { reclaim } : {}),
      affected: low.length,
      view: 'context',
      fix: {
        target: 'CLAUDE.md',
        label: 'Keep the cache warm',
        note: 'Append to CLAUDE.md so context stays stable within a session and the prompt cache is reused.',
        snippet: `## Keep the prompt cache warm\n\nCache hits require a stable context prefix, so avoid churning it mid-session:\n- Don't interleave large, unrelated file reads into focused work — batch related reads together.\n- Avoid switching permission modes or models in the middle of a task.\n- Don't re-Read files that haven't changed; reuse what's already in context.\n- Group similar work so repeated context (same files, same instructions) is reused rather than re-sent at full input rate.`,
        appliedMarkers: MARKERS_LOW_CACHE_HIT,
      },
    };
  },
};
