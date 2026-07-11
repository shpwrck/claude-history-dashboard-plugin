import type { Detector, TaskClassCostBreakdown } from '../types';
import { automationCostShare, automationCostByClass, fmtUsd, isHaikuPinned } from '../shared';
import { CHEAPEST_MODEL } from '../../pricing';
import { computeModelPinSavings } from '../../model-pin-savings';
import { type ReclaimClaim, type PoolId } from '../../reclaim';

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
    // model. The per-entry (actual − Haiku) swap math — skip synthetic turns, sum
    // only positive deltas, collect reclaim scopes/tokens — now lives in
    // `automationCostByClass` (#2139) so the grand totals and the per-class split
    // are one computation and cannot drift. It also PARTITIONS that spend +
    // savings into `authoring | mechanical | review` (epic #2138): the per-class
    // figures sum back to `autoCost`/`swapSavings` exactly, so the $7,160
    // automation reclaim can be read per class instead of as one number.
    const byClass = automationCostByClass(input.tokenData);
    const swapSavings = byClass.swapSavings;
    const sessionCount = byClass.sessionIds.length;
    // Per-class confidence accounting (#2141). The per-class swap savings is a
    // pure token-accounting estimate — there is no per-class before/after window
    // or judged ablation — so each class is honestly `tier-0-estimate` with NO
    // fabricated confidence/judgeAgreement. We still surface the sample size
    // (billable turns behind the estimate) and the data's `asOf` freshness so a
    // reader or auto-router can gate on how much evidence backs the class figure.
    const taskClassBreakdown: TaskClassCostBreakdown[] = byClass.classes.map((c) => ({
      taskClass: c.taskClass,
      autoCostUsd: c.autoCost,
      swapSavingsUsd: c.swapSavings,
      sessions: c.sessions,
      savingsAttribution: {
        interventionKey: 'cost.automation-share',
        signatureId: `automation-model-pin.${c.taskClass}`,
        tier: 'tier-0-estimate' as const,
        predictedSavingsUsd: c.swapSavings,
        sampleSize: c.sampleSize,
        ...(c.latestTimestampMs !== null
          ? { asOf: new Date(c.latestTimestampMs).toISOString().slice(0, 10) }
          : {}),
      },
    }));
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
      scopeKeys: byClass.scopeKeys,
      counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
      evidenceTokens: byClass.swapTokens,
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
    // Per-class breakdown (#2139): name where the automation spend actually sits.
    // Mechanical (pickers/classify/status-writes/log-only replay) is the safest
    // to down-model; authoring (code writes) the riskiest. These partition the
    // `autoCost` above — they sum back to it exactly.
    const byC = byClass.byClass;
    const classSentence =
      autoCost > 0
        ? ` By task class: ${fmtUsd(byC.mechanical.autoCost)} mechanical, ${fmtUsd(byC.authoring.autoCost)} authoring, ${fmtUsd(byC.review.autoCost)} review.`
        : '';
    return {
      id: 'cost.automation-share',
      category: 'cost',
      severity: 'info',
      title: 'Automation drives a large share of spend',
      detail: `Automated (sdk-*) sessions account for ${fmtUsd(autoCost)} (${share.toFixed(0)}% of total) across ${sessionCount} session(s).${savingsSentence}${classSentence}`,
      action: haikuPinned
        ? 'Keep automated runs on the cheapest model that meets the quality bar; the observed before/after savings are shown on this card.'
        : 'Confirm automated runs use the cheapest model that meets the quality bar — Haiku/Sonnet often suffice for scripted work.',
      // The dollar weight is the recoverable swap savings, not the full
      // automation spend — you can't recover spend you'd still pay on Haiku.
      estSavingsUsd: swapSavings,
      reclaim,
      // Per-class partition of autoCost + swapSavings (#2139, epic #2138). The
      // classes sum back to the card's totals exactly; nothing is dropped.
      taskClassBreakdown,
      ...(measuredSavings?.attribution
        ? { savingsAttribution: measuredSavings.attribution }
        : {}),
      affected: sessionCount,
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
