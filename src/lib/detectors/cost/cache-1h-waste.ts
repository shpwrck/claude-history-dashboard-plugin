import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, fmtUsd, MIN_SAVINGS_USD } from '../shared';
import { getModelPricing } from '../../pricing';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/**
 * 1-hour cache writes are billed at 2x the input rate vs 1.25x for the default
 * 5-minute cache. The price delta on every 1h-cache token written is a
 * MAXIMUM EXPOSURE, not a booked saving (#3192).
 *
 * Recovering it requires that the context was not reused after five minutes —
 * exactly the condition the action states. This detector cannot see that: the
 * loop reads `cacheCreation1hTokens`, `cacheCreationTokens`, `model` and
 * `sessionId`, and no reuse-timing field exists in the token counters at all.
 * A legitimately reused 1-hour entry is indistinguishable here from a wasted
 * one, so booking the delta counted correctly-used cache as recoverable waste.
 * The arithmetic stays (it is a real measurement of the rate premium paid); the
 * claim that it is recoverable does not.
 */
const MARKERS_CACHE_1H_WASTE: AppliedMarkers = {
  headings: [/^##\s+Cach(e|ing)\b/i],
  bodyPhrases: ['default 5-minute prompt cache for routine work'],
};

export const detector: Detector = {
  id: 'cost.cache-1h-waste',
  appliedMarkers: MARKERS_CACHE_1H_WASTE,
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_CACHE_1H_WASTE)) return null;
    let extraCost = 0;
    let tokens = 0;
    const sessions = new Set<string>();
    const scopeKeys = new Set<string>();
    for (const d of input.tokenData) {
      for (const e of d.entries) {
        const cache1h = Math.min(e.cacheCreation1hTokens, e.cacheCreationTokens);
        if (cache1h <= 0) continue;
        const p = getModelPricing(e.model);
        extraCost += (cache1h / 1_000_000) * (p.cacheWrite1h - p.cacheWrite5m);
        tokens += cache1h;
        sessions.add(d.sessionId);
        scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
      }
    }
    if (extraCost < MIN_SAVINGS_USD) return null;
    // Flag-only (#3192). This previously booked a `convertRate` counterfactual
    // that re-billed the whole 1h cache-write pool at the 5-minute rate — i.e.
    // it asserted every 1h write should have been a 5m write. Without
    // reuse-timing evidence that is unsupportable, so the lever carries its
    // evidence for per-category coverage and books $0. Restoring a booked
    // counterfactual requires a reuse signal this parser does not yet produce.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.cache-1h-waste',
      category: 'cost',
      orderKey: 50,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: tokens,
    };
    return {
      id: 'cost.cache-1h-waste',
      category: 'cost',
      severity: extraCost >= 1 ? 'warning' : 'info',
      title: 'Reduce 1-hour cache writes',
      detail: `${(tokens / 1_000_000).toFixed(2)}M tokens were written to the 1-hour cache across ${sessions.size} session(s), billed at 2× input vs 1.25× for the default 5-minute cache — a rate premium of ${fmtUsd(extraCost)} over what the same tokens would have cost at the 5-minute write rate.`,
      action:
        'Check whether that context is genuinely reused beyond 5 minutes. Where it is not, the 5-minute cache is cheaper — but how much of the premium above is avoidable depends on reuse timing, which is not recorded in the token counters, so none of it is counted as recovered.',
      // No estSavingsUsd (#3192): the premium above is measured, its
      // recoverable fraction is not. See the module comment.
      reclaim,
      affected: sessions.size,
      view: 'tokens',
      fix: {
        target: 'CLAUDE.md',
        label: 'Note the 1h-cache tradeoff',
        note: 'Paste into CLAUDE.md so sessions avoid the 2× cache write when context is short-lived. No settings key controls cache TTL.',
        snippet: `## Caching\n- Prefer the default 5-minute prompt cache for routine work; it is billed at 1.25× input vs 2× for the 1-hour cache.\n- Only rely on the 1-hour cache for context genuinely reused across gaps >5 min. For short, scoped tasks, finish or compact before idle gaps so context is not re-written to the pricier 1h cache.`,
        appliedMarkers: MARKERS_CACHE_1H_WASTE,
      },
    };
  },
};
