import type { Detector } from '../types';
import { automationCostShare, fmtUsd, isHaikuPinned } from '../shared';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import {
  resolveModelPricing,
  entryCostAtModel,
  CHEAPEST_MODEL,
} from '../../pricing';
import { computeModelPinSavings } from '../../model-pin-savings';
import { scopeKeyOf, type ReclaimClaim, type PoolId } from '../../reclaim';

const ALL_POOLS: PoolId[] = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

/**
 * Cost incurred by automation (any `sdk-*` entrypoint) vs interactive use. Large
 * automated spend on a top-tier model is the clearest model-right-sizing lever.
 */
export const detector: Detector = {
  id: 'cost.automation-share',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig', 'modelPinSavings'],
  rule(input) {
    // The fix is "default automation to Haiku" via settings.json. If the user has
    // already pinned Haiku globally, estimate-only findings are suppressed; a
    // measured before/after win still renders so the user can verify the effect.
    const haikuPinned = isHaikuPinned(input.liveConfig?.settings);
    // autoCost/total/share come from the shared helper (#299) so this rule and the
    // Automation view's cost band agree exactly — no duplicated cost math.
    const { autoCost, total, share } = automationCostShare(input.tokenData);
    // Counterfactual: what the automation turns would have cost on the cheapest
    // model. We sum the per-entry (actual − Haiku) delta using the same swap math
    // the Tokens view uses (entryCostAtModel), so this reuses the one pricing
    // table rather than introducing new rate constants. Synthetic (non-billable)
    // turns are skipped — they have no real cost to recover. Haiku-priced turns
    // contribute a zero delta, so an all-Haiku automation profile yields $0.
    let swapSavings = 0;
    let swapTokens = 0;
    const sessions = new Set<string>();
    const scopeKeys = new Set<string>();
    for (const d of input.tokenData) {
      if (isUnattendedEntrypoint(d.entrypoint)) {
        sessions.add(d.sessionId);
        for (const entry of d.entries) {
          const model = entry.model || 'unknown';
          if (resolveModelPricing(model).isSynthetic) continue;
          const delta =
            entryCostAtModel(entry, model) - entryCostAtModel(entry, CHEAPEST_MODEL);
          if (delta > 0) {
            swapSavings += delta;
            scopeKeys.add(scopeKeyOf(d.sessionId, model));
            swapTokens +=
              entry.inputTokens +
              entry.outputTokens +
              entry.cacheCreationTokens +
              entry.cacheReadTokens;
          }
        }
      }
    }
    // Reclaim claim (model right-sizing): reprice the unattended-automation scopes
    // onto the cheapest model across every pool. Placed LAST in the structural
    // block (orderKey 80, doc §7.1 "model-swap last") so a reprice never discounts
    // tokens a physical lever already removed. `reprice` recomputes residual
    // tokens at the scope's own rate and re-bills them at the cheapest rate.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.automation-share',
      category: 'cost',
      orderKey: 80,
      ownedPools: ALL_POOLS,
      scopeKeys: [...scopeKeys],
      counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
      evidenceTokens: swapTokens,
    };
    const measuredSavings = input.modelPinSavings
      ? computeModelPinSavings({
          tokenData: input.tokenData,
          baseline: input.modelPinSavings.baseline,
          comparison: input.modelPinSavings.comparison,
          targetModel: input.modelPinSavings.targetModel,
        })
      : null;
    if (!measuredSavings?.attribution) {
      if (haikuPinned) return null;
      if (autoCost < 1 || total <= 0) return null;
      if (share < 15) return null;
    }
    // Lead with the concrete recoverable figure (the swap counterfactual) when
    // there's something to recover; fall back to the share-only framing when the
    // automation already runs on the cheapest tier (savings ≈ $0).
    const savingsSentence =
      swapSavings >= 0.01
        ? ` Running those automation turns on Haiku instead would have cost about ${fmtUsd(swapSavings)} less.`
        : '';
    return {
      id: 'cost.automation-share',
      category: 'cost',
      severity: 'info',
      title: 'Automation drives a large share of spend',
      detail: `Automated (sdk-*) sessions account for ${fmtUsd(autoCost)} (${share.toFixed(0)}% of total) across ${sessions.size} session(s).${savingsSentence}`,
      action: haikuPinned
        ? 'Keep automated runs on the cheapest model that meets the quality bar; the observed before/after savings are shown on this card.'
        : 'Confirm automated runs use the cheapest model that meets the quality bar — Haiku/Sonnet often suffice for scripted work.',
      // The dollar weight is the recoverable swap savings, not the full
      // automation spend — you can't recover spend you'd still pay on Haiku.
      estSavingsUsd: swapSavings,
      reclaim,
      ...(measuredSavings?.attribution
        ? { savingsAttribution: measuredSavings.attribution }
        : {}),
      affected: sessions.size,
      view: 'cost',
      ...(haikuPinned
        ? {}
        : {
            fix: {
              target: 'settings.json',
              label: 'Default automation to Haiku',
              note: `Merge into the settings.json your sdk-* runs use, to right-size the ${share.toFixed(0)}% automated spend. Use the cheapest model that holds your quality bar.`,
              snippet: `{\n  "model": "claude-haiku-4-5"\n}`,
            },
          }),
    };
  },
};
