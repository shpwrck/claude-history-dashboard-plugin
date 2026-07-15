import type {
  Detector,
  TaskClassCostBreakdown,
  RecommendationSavingsAttribution,
} from '../types';
import {
  automationCostShare,
  automationCostByClass,
  fmtUsd,
  isHaikuPinned,
  type AutomationClassCost,
} from '../shared';
import { CHEAPEST_MODEL } from '../../pricing';
import { demoteStaleAttribution, isAsOfStale } from '../provenance';
import {
  computeModelPinSavings,
  deriveModelPinSavingsConfig,
} from '../../model-pin-savings';
import { classifyTaskClass } from '../../task-class';
import type { SessionTokenData } from '../../../types';
import { type ReclaimClaim, type PoolId } from '../../reclaim';

const ALL_POOLS: PoolId[] = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

/**
 * Freshness horizon (days) for a per-class down-model proof (#2142). Anthropic
 * ships a new model generation on the order of one-to-three months, so a
 * measured "the cheaper model held the bar" before/after older than a quarter
 * spans at least one model version — the tradeoff it measured may no longer
 * hold. Beyond this window a measured proof is demoted to a dated estimate
 * (`demoteStaleAttribution`) so it is not asserted as CURRENT confidence; a
 * re-validation with fresher turns refreshes the `asOf` and restores the tier.
 */
export const DOWN_MODEL_PROOF_FRESHNESS_DAYS = 90;

/**
 * The honest, always-available per-class attribution: pure token-accounting, so
 * `tier-0-estimate` with NO fabricated confidence/judgeAgreement (#2141). We
 * still surface the sample size (billable turns) and `asOf` freshness so a reader
 * or auto-router can gate on how much evidence backs the class figure.
 */
function estimateClassAttribution(
  c: AutomationClassCost
): RecommendationSavingsAttribution {
  return {
    interventionKey: 'cost.automation-share',
    signatureId: `automation-model-pin.${c.taskClass}`,
    tier: 'tier-0-estimate',
    predictedSavingsUsd: c.swapSavings,
    sampleSize: c.sampleSize,
    ...(c.latestTimestampMs !== null
      ? { asOf: new Date(c.latestTimestampMs).toISOString().slice(0, 10) }
      : {}),
  };
}

/**
 * Per-class down-model savings attribution (#2140). Upgrades a class's honest
 * `tier-0-estimate` to a measured `tier-1-before-after` ONLY when that class's
 * automation actually migrated to a cheaper model IN-WINDOW.
 *
 * The measured tier reuses the exact before/after window math the card level
 * already runs (`deriveModelPinSavingsConfig` + `computeModelPinSavings`), now
 * PARAMETERIZED by a per-class session predicate — no new framework. Each class
 * derives its OWN before/after boundary independently of the aggregate window,
 * so a class-specific migration the aggregate blurs out (e.g. mechanical went
 * Opus→Haiku while authoring stayed on Opus) still surfaces as a real
 * measurement instead of being averaged away.
 *
 * `deriveModelPinSavingsConfig` only returns a config when the comparison side is
 * mostly target-priced AND the priced premium dropped — i.e. the class genuinely
 * moved to the cheaper model in-window. A class with NO in-window model change
 * yields `null` and stays `tier-0-estimate` (honest tier, never upgraded without
 * data — AGENTS.md: recommendations are auditable claims).
 */
function classSavingsAttribution(
  c: AutomationClassCost,
  tokenData: SessionTokenData[]
): RecommendationSavingsAttribution {
  const estimate = estimateClassAttribution(c);
  // A class with no premium spend never ran on a costlier-than-Haiku model, so
  // there is no before/after model change to measure — stays an honest estimate.
  // (Cheap guard: skips the O(n^2) window search for all-cheapest classes.)
  if (c.swapSavings <= 0) return estimate;

  const classFilter = (s: SessionTokenData): boolean =>
    classifyTaskClass({ entrypoint: s.entrypoint, opener: s.opener }) === c.taskClass;

  const config = deriveModelPinSavingsConfig({ tokenData, sessionFilter: classFilter });
  if (!config) return estimate;

  const measured = computeModelPinSavings({
    tokenData,
    ...config,
    sessionFilter: classFilter,
    signatureId: `automation-model-pin.${c.taskClass}`,
  });
  if (!measured?.attribution) return estimate;

  // Measured before/after for this class. `realizedSavingsUsd` + `confidence`
  // come from the observed premium drop (`computeModelPinSavings`); we carry the
  // class's own `sampleSize`/`asOf` so the auditable metadata matches the tier-0
  // rows and a reader can still gate on evidence depth and freshness.
  return {
    ...measured.attribution,
    sampleSize: measured.baseline.entries + measured.comparison.entries,
    ...(c.latestTimestampMs !== null
      ? { asOf: new Date(c.latestTimestampMs).toISOString().slice(0, 10) }
      : {}),
  };
}

/**
 * Cost incurred by automation (any `sdk-*` entrypoint) vs interactive use. Large
 * automated spend on a top-tier model is the clearest model-right-sizing lever.
 */
export const detector: Detector = {
  id: 'cost.automation-share',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig', 'modelPinSavings'],
  rule(input, now) {
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
    // Per-class confidence accounting (#2141 estimate floor, #2140 measured
    // tier). The per-class swap savings is a pure token-accounting estimate, so a
    // class is honestly `tier-0-estimate` with NO fabricated
    // confidence/judgeAgreement — UNLESS that class's automation actually
    // migrated to a cheaper model in-window, in which case `classSavingsAttribution`
    // upgrades it to a measured `tier-1-before-after` with a real
    // `realizedSavingsUsd` + `confidence` (see the helper). Either way we surface
    // the sample size (billable turns behind the figure) and the data's `asOf`
    // freshness so a reader or auto-router can gate on the evidence.
    //
    // Stale-proof decay (#2142, reusing the #1102 provenance path): a measured
    // before/after older than DOWN_MODEL_PROOF_FRESHNESS_DAYS is demoted back to a
    // dated `tier-0-estimate` with `stale: true` — model versions move, so an
    // expired "cheaper model held the bar" verdict must not be counted as current
    // confidence. A re-validation with fresher turns refreshes the `asOf` and
    // restores the measured tier.
    const taskClassBreakdown: TaskClassCostBreakdown[] = byClass.classes.map((c) => ({
      taskClass: c.taskClass,
      autoCostUsd: c.autoCost,
      swapSavingsUsd: c.swapSavings,
      sessions: c.sessions,
      savingsAttribution: demoteStaleAttribution(
        classSavingsAttribution(c, input.tokenData),
        now,
        DOWN_MODEL_PROOF_FRESHNESS_DAYS
      ),
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
    // automation already runs on the cheapest tier (savings ≈ $0). The swap
    // figure is per-token repricing — an UPPER BOUND that assumes the cheaper
    // model does the same work in the same number of turns, so its copy (below)
    // and provenance flag the equal-completion assumption, iteration risk, and
    // class-completability risk (#2548). Anthropic frames model choice as a
    // capability decision, not a blanket cost lever (platform.claude.com
    // model/effort guidance:
    // https://platform.claude.com/docs/en/build-with-claude/effort.md); that
    // first-party rationale is why the safe scope is per task class (epic #2138),
    // never a global pin — but it is general guidance, not proof any class here
    // is safe (only a T2/T3 receipt is).
    const savingsSentence =
      swapSavings >= 0.01
        ? ` Repriced at Haiku's token rates, those turns would have cost about ${fmtUsd(swapSavings)} less.`
        : '';
    // Per-class breakdown (#2139): name where the automation spend actually sits.
    // Mechanical (pickers/classify/status-writes/log-only replay) is the safest
    // to down-model; authoring (code writes) is UNPROVEN and stays on the strong
    // model until a per-class proof clears it. These partition the `autoCost`
    // above — they sum back to it exactly.
    const byC = byClass.byClass;
    const classSentence =
      autoCost > 0
        ? ` By task class: ${fmtUsd(byC.mechanical.autoCost)} mechanical (safest to down-model), ${fmtUsd(byC.authoring.autoCost)} authoring (code writes — unproven, keep on the strong model), ${fmtUsd(byC.review.autoCost)} review.`
        : '';
    // The equal-completion / iteration / class-completability caveat: the swap
    // figure is a ceiling, never a promised reduction (#2548).
    const swapCaveatSentence =
      swapSavings >= 0.01
        ? ' That swap figure is an upper-bound estimate — it assumes the cheaper model completes the same work in the same number of turns; in practice a cheaper model may need more iterations or fail to complete some task classes.'
        : '';
    // Freshest billable automation turn → the provenance `asOf`; a snapshot older
    // than the down-model freshness horizon demotes the present-tense claim.
    const latestAutoTs = Math.max(
      ...byClass.classes.map((c) => c.latestTimestampMs ?? Number.NEGATIVE_INFINITY)
    );
    const provenanceAsOf =
      Number.isFinite(latestAutoTs) && latestAutoTs > 0
        ? new Date(latestAutoTs).toISOString().slice(0, 10)
        : undefined;
    return {
      id: 'cost.automation-share',
      category: 'cost',
      severity: 'info',
      title: 'Automation drives a large share of spend',
      detail: `Automated (sdk-*) sessions account for ${fmtUsd(autoCost)} (${share.toFixed(0)}% of total) across ${sessionCount} session(s).${savingsSentence}${classSentence}${swapCaveatSentence}`,
      action: haikuPinned
        ? 'Keep automated runs on the cheapest model that holds the quality bar of each task class — down-model only proof-cleared classes and leave code-authoring on the strong model; the observed before/after savings are shown on this card.'
        : 'Down-model only the task classes a per-class before/after (T2) or replay (T3) proof has cleared on your own history — start with mechanical (picker/classify/status/log-only) work and keep code-authoring on the strong model. A cheaper model can take more iterations or fail to complete a class, so the swap figure is a ceiling, not a guaranteed reduction.',
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
      // Auditable provenance (#1049/#2548): the swap dollar figure is a T1
      // per-token repricing counterfactual — an upper bound, never proof a class
      // is safe to down-route. The inference states the equal-completion
      // assumption, iteration risk, and class-completability risk so a reader or
      // /recs consumer cannot mistake the estimate for a cleared class.
      provenance: {
        observations: [
          {
            claim: `${share.toFixed(0)}% of billable token spend (~${fmtUsd(autoCost)}) ran on unattended sdk-* entrypoints across ${sessionCount} session(s)`,
            source: 'parse-sessions',
            field: 'entrypoint',
            value: sessionCount,
          },
          {
            claim: `repricing those turns at ${CHEAPEST_MODEL}'s token rates yields a counterfactual ${fmtUsd(swapSavings)} lower bill`,
            source: 'parse-sessions',
            field: 'entries[].model',
            value: Number(swapSavings.toFixed(2)),
          },
        ],
        inference:
          `The swap figure is a per-token repricing counterfactual (T1 estimate): an UPPER BOUND that assumes the cheaper model completes the same work in the same number of turns. A cheaper model may need more iterations or fail to complete a class, so it is neither a guaranteed reduction nor proof that any class is safe to down-route — code-authoring especially stays on the strong model until a per-class before/after (T2) or replay (T3) proof clears it. This mirrors Anthropic's own guidance that model choice is a capability decision, not a blanket cost lever.`,
        ...(provenanceAsOf
          ? {
              asOf: provenanceAsOf,
              stale: isAsOfStale(provenanceAsOf, now, DOWN_MODEL_PROOF_FRESHNESS_DAYS),
            }
          : {}),
      },
      affected: sessionCount,
      view: 'cost',
      ...(haikuPinned
        ? {}
        : {
            fix: {
              target: 'settings.json',
              label: 'Example: down-model a proof-cleared class',
              // A blanket global "model" pin is unsafe here: it down-routes every
              // task class, including code-authoring, which the per-task-class
              // safety boundary (epic #2138) keeps on the strong model until a
              // proof clears it. So this is an ADAPT-ME example, never a
              // copy-paste-safe validated fix (#2548).
              fixKind: 'illustrative',
              note: `Example only — not a blanket global pin. A top-level "model" applies to every task class including code-authoring; scope the cheaper model to the sdk-* runs whose class a before/after (T2) or replay (T3) proof has cleared, and leave authoring on the strong model. See docs/product/features/down-modelling-confidence.md before adopting.`,
              snippet: `{\n  "model": "claude-haiku-4-5"\n}`,
            },
          }),
    };
  },
};
