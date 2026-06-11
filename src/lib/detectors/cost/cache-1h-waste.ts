import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, MIN_SAVINGS_USD } from '../shared';
import { getModelPricing } from '../../pricing';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

/**
 * 1-hour cache writes are billed at 2x the input rate vs 1.25x for the default
 * 5-minute cache. If those entries didn't actually get reused after 5 minutes,
 * the 1h cache was pure overpay. We surface the *maximum* recoverable amount:
 * the price delta on every 1h-cache token written.
 */
const MARKERS_CACHE_1H_WASTE: AppliedMarkers = {
  headings: [/^##\s+Cach(e|ing)\b/i],
  bodyPhrases: ['default 5-minute prompt cache for routine work'],
};

export const detector: Detector = {
  id: 'cost.cache-1h-waste',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_CACHE_1H_WASTE)) return null;
    let extraCost = 0;
    let tokens = 0;
    const sessions = new Set<string>();
    // The cascade scopes are per-(session, model); collect the canonical keys of
    // every entry that actually wrote to the 1h cache so the convertRate
    // counterfactual (1h-write rate → 5m-write rate) books on exactly those cells.
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
    // Reclaim claim: re-bill the 1h cache-write pool at the 5-minute write rate
    // on the same model. `convertRate` only touches the `cacheWrite1h` residual.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.cache-1h-waste',
      category: 'cost',
      orderKey: 50,
      ownedPools: ['cacheWrite1h'],
      scopeKeys: [...scopeKeys],
      counterfactual: { kind: 'convertRate', rateFrom: 'cacheWrite1h', rateTo: 'cacheWrite5m' },
      evidenceTokens: tokens,
    };
    return {
      id: 'cost.cache-1h-waste',
      category: 'cost',
      severity: extraCost >= 1 ? 'warning' : 'info',
      title: 'Reduce 1-hour cache writes',
      detail: `${(tokens / 1_000_000).toFixed(2)}M tokens were written to the 1-hour cache across ${sessions.size} session(s), billed at 2× input vs 1.25× for the default 5-minute cache.`,
      action:
        'If that context is not reused beyond 5 minutes, prefer the 5-minute cache — up to the amount shown is recoverable.',
      estSavingsUsd: extraCost,
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
