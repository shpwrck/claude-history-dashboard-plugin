import type {
  Detector,
  TaskClassCostBreakdown,
  RecommendationSavingsAttribution,
  RecObservation,
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
  type ModelPinSavingsResult,
} from '../../model-pin-savings';
import { classifyTaskClass } from '../../task-class';
import type { SessionTokenData } from '../../../types';
import {
  estimateEntryCost,
  isUnattendedEntrypoint,
} from '../../parse-sessions';

/**
 * Freshness horizon (days) for per-class down-model evidence (#2142). Model
 * capabilities and pricing move over time, so a before/after older than a
 * quarter may no longer describe the current cost direction. Beyond this window
 * the measurement is demoted to a dated estimate
 * (`demoteStaleAttribution`) so it is not asserted as CURRENT confidence; a
 * re-measurement with fresher turns refreshes the `asOf` and restores the
 * observational tier; it still does not quality-clear a class.
 */
export const DOWN_MODEL_PROOF_FRESHNESS_DAYS = 90;

function latestBillableAutomationTimestamp(
  tokenData: SessionTokenData[]
): number | null {
  let latest: number | null = null;
  for (const session of tokenData) {
    if (!isUnattendedEntrypoint(session.entrypoint)) continue;
    for (const entry of session.entries) {
      // Keep this aligned with automationCostShare/estimateCost: an otherwise
      // unpriced model can still add paid server-tool fees to the observed bill.
      if (estimateEntryCost(entry) <= 0) continue;
      const timestampMs = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(timestampMs)) continue;
      latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
    }
  }
  return latest;
}

function measuredSavingsObservations(
  measured: ModelPinSavingsResult
): RecObservation[] {
  const source = 'parse-sessions/model-pin-savings';
  const target = measured.targetModel;
  return [
    {
      claim: `the configured before/after target model was ${target}`,
      source,
      field: 'modelPinSavings.targetModel + pricing[targetModel]',
      value: target,
    },
    {
      claim: `the baseline window was [${measured.attribution.window?.baseline?.start}, ${measured.attribution.window?.baseline?.end})`,
      source,
      field:
        'modelPinSavings.baseline.{start,end} + sessionData[].entries[].timestamp',
      value: `${measured.attribution.window?.baseline?.start}..<${measured.attribution.window?.baseline?.end}`,
    },
    {
      claim: `the baseline window contained ${measured.baseline.entries} priced unattended ${measured.baseline.entries === 1 ? 'entry' : 'entries'}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,model} filtered to modelPinSavings.baseline',
      value: measured.baseline.entries,
    },
    {
      claim: `baseline actual-model token spend was ${fmtUsd(measured.baseline.actualModelSpendUsd)}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[actual model] within modelPinSavings.baseline',
      value: measured.baseline.actualModelSpendUsd,
    },
    {
      claim: `baseline same-token spend at ${target} rates was ${fmtUsd(measured.baseline.targetModelSpendUsd)}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[targetModel] within modelPinSavings.baseline',
      value: measured.baseline.targetModelSpendUsd,
    },
    {
      claim: `baseline token-only model premium was ${fmtUsd(measured.baseline.premiumUsd)}; server-tool fees were excluded`,
      source,
      field:
        'max(0, sum(entryCostAtModel(entry, actualModel)) - sum(entryCostAtModel(entry, targetModel))) within modelPinSavings.baseline',
      value: measured.baseline.premiumUsd,
    },
    {
      claim: `the comparison window was [${measured.attribution.window?.comparison?.start}, ${measured.attribution.window?.comparison?.end})`,
      source,
      field:
        'modelPinSavings.comparison.{start,end} + sessionData[].entries[].timestamp',
      value: `${measured.attribution.window?.comparison?.start}..<${measured.attribution.window?.comparison?.end}`,
    },
    {
      claim: `the comparison window contained ${measured.comparison.entries} priced unattended ${measured.comparison.entries === 1 ? 'entry' : 'entries'}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,model} filtered to modelPinSavings.comparison',
      value: measured.comparison.entries,
    },
    {
      claim: `comparison actual-model token spend was ${fmtUsd(measured.comparison.actualModelSpendUsd)}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[actual model] within modelPinSavings.comparison',
      value: measured.comparison.actualModelSpendUsd,
    },
    {
      claim: `comparison same-token spend at ${target} rates was ${fmtUsd(measured.comparison.targetModelSpendUsd)}`,
      source,
      field:
        'sessionData[entrypoint sdk-*].entries[].{timestamp,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[targetModel] within modelPinSavings.comparison',
      value: measured.comparison.targetModelSpendUsd,
    },
    {
      claim: `comparison token-only model premium was ${fmtUsd(measured.comparison.premiumUsd)}; server-tool fees were excluded`,
      source,
      field:
        'max(0, sum(entryCostAtModel(entry, actualModel)) - sum(entryCostAtModel(entry, targetModel))) within modelPinSavings.comparison',
      value: measured.comparison.premiumUsd,
    },
    ...(measured.attribution.asOf
      ? [
          {
            claim: `the latest priced unattended comparison entry was observed as of ${measured.attribution.asOf}`,
            source,
            field:
              'max(sessionData[entrypoint sdk-*].entries[].timestamp within modelPinSavings.comparison after model-pricing gates)',
            value: measured.attribution.asOf,
          },
        ]
      : []),
    {
      claim: `baseline minus comparison was a directional ${fmtUsd(measured.realizedSavingsUsd)} model-token premium difference; server-tool fees were excluded`,
      source,
      field: 'max(0, baseline token premium - comparison token premium)',
      value: measured.realizedSavingsUsd,
    },
  ];
}

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
  // come from the observed premium drop (`computeModelPinSavings`). The
  // attribution's own sample/asOf come from priced entries actually inside
  // the measured windows, so unrelated newer turns cannot refresh it.
  return measured.attribution;
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
    // model. The per-entry (actual − Haiku) swap math — skip synthetic turns and
    // sum only positive deltas — now lives in
    // `automationCostByClass` (#2139) so the grand totals and the per-class split
    // are one computation and cannot drift. It also PARTITIONS that spend +
    // savings into `authoring | mechanical | review` (epic #2138): the per-class
    // figures sum back to `autoCost`/`swapSavings` exactly, so the raw automation
    // swap ceiling can be audited per class instead of as one number. No class is
    // booked here: this detector has cost arithmetic, not completion/quality proof.
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
    // Stale-measurement decay (#2142, reusing the #1102 provenance path): a measured
    // before/after older than DOWN_MODEL_PROOF_FRESHNESS_DAYS is demoted back to a
    // dated `tier-0-estimate` with `stale: true` — model versions move, so an
    // expired cost-direction observation must not be counted as current
    // evidence. A re-measurement with fresher turns refreshes the `asOf` and
    // restores the observational tier; it still does not quality-clear a class.
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
      // Per-class classifier provenance (#2376): the matched reasons +
      // representative session refs behind this class's partition, so the split
      // is auditable/reproducible rather than an opaque bucket.
      classification: c.classification,
    }));
    const measuredSavings = input.modelPinSavings
      ? computeModelPinSavings({
          tokenData: input.tokenData,
          baseline: input.modelPinSavings.baseline,
          comparison: input.modelPinSavings.comparison,
          targetModel: input.modelPinSavings.targetModel,
        })
      : null;
    const measuredAttribution = measuredSavings?.attribution
      ? demoteStaleAttribution(
          measuredSavings.attribution,
          now,
          DOWN_MODEL_PROOF_FRESHNESS_DAYS
        )
      : undefined;
    if (!measuredSavings?.attribution) {
      if (haikuPinned) return null;
      if (autoCost < 1 || total <= 0) return null;
      if (share < 15) return null;
    }
    // Lead with the concrete counterfactual ceiling when
    // there's something to recover; fall back to the share-only framing when the
    // automation already runs on the cheapest tier (savings ≈ $0). The swap
    // figure is per-token repricing — an UPPER BOUND that assumes the cheaper
    // model does the same work in the same number of turns, so its copy (below)
    // and provenance flag the equal-completion assumption, iteration risk, and
    // class-completability risk (#2548). Anthropic's model/effort guidance says
    // to balance capability, speed, and cost and test actual prompts/data:
    // https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
    // https://platform.claude.com/docs/en/build-with-claude/effort
    // That supports per-class evaluation rather than a global pin, but does not
    // prove any local class safe. Only a quality-gated T3 replay can clear a
    // class; T2 is directional.
    const savingsSentence =
      swapSavings >= 0.01
        ? ` Repriced at Haiku's token rates, those turns would have cost about ${fmtUsd(swapSavings)} less.`
        : '';
    // Per-class breakdown (#2139): name where the automation spend actually sits.
    // Mechanical (pickers/classify/status-writes/log-only replay) is a lower-risk
    // evaluation candidate; that keyword classification is not proof. Authoring
    // (code writes) stays on the strong model until a quality-gated T3 replay
    // clears it. These partition the `autoCost`
    // above — they sum back to it exactly.
    const byC = byClass.byClass;
    const classSentence =
      autoCost > 0
        ? ` By task class: ${fmtUsd(byC.mechanical.autoCost)} mechanical (lower-risk evaluation candidate, not proof), ${fmtUsd(byC.authoring.autoCost)} authoring (code writes — keep on the strong model), ${fmtUsd(byC.review.autoCost)} review.`
        : '';
    const nonBookableSentence =
      swapSavings >= 0.01
        ? ` The full swap figure is ceiling-only and excluded from booked savings and reclaim because no task class has completion/quality proof; ${fmtUsd(byC.authoring.swapSavings)} of that ceiling is authoring.`
        : '';
    // The equal-completion / iteration / class-completability caveat: the swap
    // figure is a ceiling, never a promised reduction (#2548).
    const swapCaveatSentence =
      swapSavings >= 0.01
        ? ' That swap figure is an upper-bound estimate — it assumes the cheaper model completes the same work in the same number of turns; in practice a cheaper model may need more iterations or fail to complete some task classes.'
        : '';
    // Freshest billable automation turn → the provenance `asOf`; a snapshot older
    // than the down-model freshness horizon demotes the present-tense claim.
    const latestAutoTs = latestBillableAutomationTimestamp(input.tokenData);
    const provenanceAsOf =
      latestAutoTs !== null
        ? new Date(latestAutoTs).toISOString().slice(0, 10)
        : undefined;
    const provenanceStale = isAsOfStale(
      provenanceAsOf,
      now,
      DOWN_MODEL_PROOF_FRESHNESS_DAYS
    );
    const detailLead = provenanceStale
      ? `As of ${provenanceAsOf}, automated`
      : 'Automated';
    const measurementContext =
      measuredAttribution?.tier === 'tier-1-before-after'
        ? 'The observed before/after is directional cost evidence only; it does not prove completion or quality. '
        : measuredAttribution?.stale && measuredAttribution.asOf
          ? `The before/after observation is historical as of ${measuredAttribution.asOf}; remeasure it before relying on its direction. `
          : '';
    const routeGuidance = haikuPinned
      ? 'Treat the existing blanket Haiku pin as unverified by this card. Keep code-authoring on the strong model and retain a cheaper route only after a class-scoped replay (T3) with explicit completion and quality gates clears that class. A before/after (T2) can track cost direction, but cannot quality-clear a route.'
      : 'Down-model a task class only after a class-scoped replay (T3) with explicit completion and quality gates clears it — start evaluation with mechanical (picker/classify/status/log-only) work and keep code-authoring on the strong model. A before/after (T2) can track cost direction, but cannot quality-clear a route; the swap figure remains a ceiling, not a guaranteed reduction.';
    const guidance = `${measurementContext}${routeGuidance}`;
    const action = provenanceStale
      ? `As of ${provenanceAsOf}, this snapshot showed the automation mix above. Revalidate it against current runs before acting. ${guidance}`
      : guidance;
    return {
      id: 'cost.automation-share',
      category: 'cost',
      severity: 'info',
      // The spend/share observation is accounting, but the recommendation's
      // actionable dollar claim is a model-swap counterfactual whose completion
      // and quality assumptions are unproven. T2 is directional calibration,
      // not causal proof that a cheaper model holds the quality bar.
      claimClass: 'causal',
      proofTier:
        measuredAttribution?.tier === 'tier-1-before-after'
          ? 'observational'
          : 'auditable',
      title: provenanceStale
        ? `Automation drove a large share of spend as of ${provenanceAsOf}`
        : 'Automation drives a large share of spend',
      detail: `${detailLead} (sdk-*) sessions account for ${fmtUsd(autoCost)} (${share.toFixed(0)}% of total) across ${sessionCount} session(s).${savingsSentence}${classSentence}${nonBookableSentence}${swapCaveatSentence}`,
      action,
      // Per-class partition of autoCost + the raw swap ceiling (#2139, epic
      // #2138). No class ceiling is exported through estSavingsUsd/reclaim
      // without quality proof.
      taskClassBreakdown,
      ...(measuredAttribution
        ? { savingsAttribution: measuredAttribution }
        : {}),
      // Auditable provenance (#1049/#2548): the swap dollar figure is a
      // tier-0-estimate
      // per-token repricing counterfactual — an upper bound, never proof a class
      // is safe to down-route. The inference states the equal-completion
      // assumption, iteration risk, and class-completability risk so a reader or
      // /recs consumer cannot mistake the estimate for a cleared class.
      provenance: {
        observations: [
          {
            claim: `${sessionCount} unattended sdk-* ${sessionCount === 1 ? 'session was' : 'sessions were'} observed`,
            source: 'parse-sessions',
            field: 'sessionData[].entrypoint',
            value: sessionCount,
          },
          {
            claim: `unattended sdk-* sessions incurred ${fmtUsd(autoCost)} of billable spend, including token and server-tool fees`,
            source: 'parse-sessions',
            field:
              'sessionData[entrypoint sdk-*].entries[].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens,webSearchRequests,webFetchRequests} + pricing[model] + SERVER_TOOL_PRICING',
            value: autoCost,
          },
          {
            claim: `all sessions incurred ${fmtUsd(total)} of total billable spend, including token and server-tool fees`,
            source: 'parse-sessions',
            field:
              'sessionData[].entries[].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens,webSearchRequests,webFetchRequests} + pricing[model] + SERVER_TOOL_PRICING',
            value: total,
          },
          {
            claim: `same-token repricing at ${CHEAPEST_MODEL} rates yields a ${fmtUsd(swapSavings)} ceiling across input, output, cacheWrite5m, cacheWrite1h, and cacheRead; server-tool fees are unchanged and excluded`,
            source: 'parse-sessions',
            field: `sum(max(0, entryCostAtModel(entry, entry.model) - entryCostAtModel(entry, ${CHEAPEST_MODEL}))) over sessionData[entrypoint sdk-*].entries[model resolves to priced non-synthetic].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens}; server-tool fees excluded`,
            value: swapSavings,
          },
          ...(measuredSavings?.attribution
            ? measuredSavingsObservations(measuredSavings)
            : []),
        ],
        inference:
          `The swap figure is a per-token repricing counterfactual (tier-0-estimate): an UPPER BOUND that assumes the cheaper model completes the same work in the same number of turns. It is auditable arithmetic, not proof of completion or quality, so no class ceiling is booked as estSavingsUsd or reclaim. The risk that a cheaper route needs more iterations or fails to complete a class is this detector's inference from that untested equal-turn assumption, not a guaranteed reduction or proof that any class is safe to down-route. Code-authoring especially stays on the strong model until a class-scoped replay (T3) with quality gates clears it; a before/after (T2) is directional cost evidence only. Anthropic's guidance recommends balancing capability, speed, and cost and testing model/effort choices on actual prompts and data.`,
        ...(provenanceAsOf
          ? {
              asOf: provenanceAsOf,
              stale: provenanceStale,
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
              label: 'Example: down-model a T3-cleared class',
              // A blanket global "model" pin is unsafe here: it down-routes every
              // task class, including code-authoring, which the per-task-class
              // safety boundary (epic #2138) keeps on the strong model until a
              // T3 quality gate clears it. So this is an ADAPT-ME example, never a
              // copy-paste-safe validated fix (#2548).
              fixKind: 'illustrative',
              note: `Example only — not a blanket global pin. A top-level "model" applies to every task class including code-authoring. A before/after (T2) is directional cost evidence only; only a class-scoped replay (T3) with explicit completion and quality gates can clear a class. Scope any cheaper route to a T3-cleared class and leave authoring on the strong model. See docs/product/features/down-modelling-confidence.md before adopting.`,
              snippet: `{\n  "model": "claude-haiku-4-5"\n}`,
            },
          }),
    };
  },
};
