import type { SessionTokenData } from '../types';
import type {
  ModelPinSavingsConfig,
  RecommendationSavingsAttribution,
  SavingsAttributionPeriod,
} from './detectors/types';
import { isUnattendedEntrypoint } from './parse-sessions';
import {
  CHEAPEST_MODEL,
  entryCostAtModel,
  resolveModelPricing,
} from './pricing';

/**
 * Optional per-session predicate that narrows the before/after window math to a
 * SLICE of the automation history — e.g. one task class (#2140). When omitted,
 * all unattended sessions contribute (the default, aggregate behaviour). The
 * predicate is applied on top of the always-on `isUnattendedEntrypoint` gate, so
 * it can only ever narrow the automation set, never widen it to interactive
 * turns. The caller supplies the class predicate; this module stays free of any
 * task-class knowledge.
 */
export type ModelPinSessionFilter = (session: SessionTokenData) => boolean;

export interface ModelPinSavingsInput {
  tokenData: SessionTokenData[];
  baseline: SavingsAttributionPeriod;
  comparison: SavingsAttributionPeriod;
  targetModel?: string;
  interventionKey?: string;
  signatureId?: string;
  /** Narrow the window math to a slice of automation sessions (e.g. a class). */
  sessionFilter?: ModelPinSessionFilter;
}

export interface ModelPinSavingsDerivationInput {
  tokenData: SessionTokenData[];
  targetModel?: string;
  /** Minimum billable unattended entries before the inferred intervention. */
  minBaselineEntries?: number;
  /** Minimum billable unattended entries at/after the inferred intervention. */
  minComparisonEntries?: number;
  /** Required share of comparison entries already priced at or below target. */
  minComparisonTargetShare?: number;
  /** Narrow the inferred window to a slice of automation sessions (e.g. a class). */
  sessionFilter?: ModelPinSessionFilter;
}

export interface ModelPinWindowSummary {
  entries: number;
  sessions: number;
  actualModelSpendUsd: number;
  targetModelSpendUsd: number;
  premiumUsd: number;
  /**
   * Model premium per dollar of target-model spend: `premiumUsd /
   * targetModelSpendUsd` (#3136).
   *
   * `premiumUsd` is a TOTAL and scales with how much work the window contains,
   * so it cannot be compared across windows of different size. This ratio is
   * dimensionless — "for every dollar this workload would have cost on the
   * target model, how many extra dollars did the actual model mix charge" — so
   * it isolates MODEL CHOICE from workload volume. `targetModelSpendUsd` is the
   * right denominator because it reprices the window's own tokens, so it
   * already accounts for input/output mix as well as raw volume.
   *
   * 0 when the window has no target-model-priced spend, in which case the ratio
   * carries no information and no realized claim is made from it.
   */
  premiumRatio: number;
  modelMix: ModelPinModelMixRow[];
}

/**
 * The documented normalization behind a realized-savings figure (#3136).
 *
 * `realizedSavingsUsd = premiumRatioDelta * appliedToTargetSpendUsd`, where the
 * delta is the improvement in model premium per dollar of target-model spend.
 * Every term is exported so the arithmetic is reproducible from the result
 * alone.
 */
export interface ModelPinNormalization {
  kind: 'premium-per-target-dollar';
  baselinePremiumRatio: number;
  comparisonPremiumRatio: number;
  premiumRatioDelta: number;
  /** The clearly-identified workload the rate change is applied to. */
  appliedToTargetSpendUsd: number;
}

export interface ModelPinModelMixRow {
  model: string;
  entries: number;
  sessions: number;
  actualModelSpendUsd: number;
  targetModelSpendUsd: number;
  premiumUsd: number;
}

export interface ModelPinSavingsResult {
  targetModel: string;
  baseline: ModelPinWindowSummary;
  comparison: ModelPinWindowSummary;
  /**
   * Observed reduction in model premium, normalized for workload volume and
   * applied to the comparison window's own workload (#3136). A Tier 1
   * before/after signal, so directional rather than causal — but no longer
   * confounded by how much work each window happened to contain.
   */
  realizedSavingsUsd: number;
  /** How {@link realizedSavingsUsd} was derived, so it can be checked (#3136). */
  normalization: ModelPinNormalization;
  /** Remaining comparison-window model-swap ceiling. */
  predictedSavingsUsd: number;
  attribution: RecommendationSavingsAttribution;
}

interface PricedEntry {
  sessionId: string;
  model: string;
  timestampMs: number;
  actualCost: number;
  targetCost: number;
}

interface TimestampedPricedEntry extends PricedEntry {
  targetPriced: boolean;
}

/**
 * Infer the first credible automation model-pin before/after window from token
 * history. This is intentionally conservative: it only emits a config when the
 * comparison side is mostly target-priced automation and the priced premium
 * actually drops. Otherwise the recommendation remains estimate-only.
 */
export function deriveModelPinSavingsConfig(
  input: ModelPinSavingsDerivationInput
): ModelPinSavingsConfig | null {
  const targetModel = input.targetModel ?? CHEAPEST_MODEL;
  if (!isBillableModel(targetModel)) return null;
  const minBaselineEntries = input.minBaselineEntries ?? 1;
  const minComparisonEntries = input.minComparisonEntries ?? 1;
  const minComparisonTargetShare = input.minComparisonTargetShare ?? 0.5;
  const entries = collectTimestampedEntries(
    input.tokenData,
    targetModel,
    input.sessionFilter
  );
  if (entries.length < minBaselineEntries + minComparisonEntries) return null;

  let best: { index: number; realizedSavingsUsd: number } | null = null;
  for (let index = minBaselineEntries; index <= entries.length - minComparisonEntries; index += 1) {
    const boundary = entries[index];
    if (!boundary.targetPriced) continue;
    const baseline = entries.slice(0, index);
    const comparison = entries.slice(index);
    const comparisonTargetShare =
      comparison.filter((entry) => entry.targetPriced).length / comparison.length;
    if (comparisonTargetShare < minComparisonTargetShare) continue;

    // Rank candidate boundaries by the SAME volume-normalized measure the
    // realized figure uses (#3136). Ranking on raw premium totals favoured
    // whichever split put more traffic in the baseline, which is a fact about
    // where the split fell rather than about the model change it is meant to
    // locate.
    const baselineRatio = premiumRatioOf(
      sumActual(baseline),
      sumTarget(baseline)
    );
    const comparisonRatio = premiumRatioOf(
      sumActual(comparison),
      sumTarget(comparison)
    );
    const premiumRatioDelta = baselineRatio - comparisonRatio;
    if (premiumRatioDelta <= 0) continue;
    const realizedSavingsUsd = premiumRatioDelta * sumTarget(comparison);
    if (realizedSavingsUsd <= 0) continue;
    if (!best || realizedSavingsUsd > best.realizedSavingsUsd) {
      best = { index, realizedSavingsUsd };
    }
  }

  if (!best) return null;
  const baseline = entries.slice(0, best.index);
  const comparison = entries.slice(best.index);
  const config = {
    baseline: {
      start: new Date(baseline[0].timestampMs).toISOString(),
      end: new Date(comparison[0].timestampMs).toISOString(),
    },
    comparison: {
      start: new Date(comparison[0].timestampMs).toISOString(),
      end: new Date(comparison[comparison.length - 1].timestampMs + 1).toISOString(),
    },
    targetModel,
  };

  return computeModelPinSavings({
    tokenData: input.tokenData,
    ...config,
    sessionFilter: input.sessionFilter,
  })?.realizedSavingsUsd
    ? config
    : null;
}

export function computeModelPinSavings(
  input: ModelPinSavingsInput
): ModelPinSavingsResult | null {
  const targetModel = input.targetModel ?? CHEAPEST_MODEL;
  if (!isBillableModel(targetModel)) return null;
  const baselineEntries = collectWindowEntries(
    input.tokenData,
    input.baseline,
    targetModel,
    input.sessionFilter
  );
  const comparisonEntries = collectWindowEntries(
    input.tokenData,
    input.comparison,
    targetModel,
    input.sessionFilter
  );

  if (baselineEntries.length === 0 || comparisonEntries.length === 0) {
    return null;
  }

  const baseline = summarizeWindow(baselineEntries);
  const comparison = summarizeWindow(comparisonEntries);
  // Realized savings from the RATE change, applied to the comparison workload
  // (#3136).
  //
  // This used to be `baseline.premiumUsd - comparison.premiumUsd`: two totals
  // over windows that may hold different entry counts, durations and token
  // volumes. That confounds model choice with workload volume in both
  // directions — a drop in traffic alone books "savings" the model pin did not
  // cause, and a rise in traffic erases a genuine per-unit improvement.
  //
  // Instead: take the improvement in premium PER DOLLAR of target-model spend
  // (the volume-normalized measure), and apply it to a clearly identified
  // workload — the comparison window's own target-model spend. The result reads
  // "on the work actually done after the pin, the old model mix would have
  // charged this much more".
  const premiumRatioDelta = Math.max(
    0,
    baseline.premiumRatio - comparison.premiumRatio
  );
  const realizedSavingsUsd = premiumRatioDelta * comparison.targetModelSpendUsd;
  const predictedSavingsUsd = comparison.premiumUsd;

  return {
    targetModel,
    baseline,
    comparison,
    realizedSavingsUsd,
    // How the figure above was derived, so a reader can check it rather than
    // trust it (#3136). Without this the number is a bare dollar amount whose
    // normalization is invisible.
    normalization: {
      kind: 'premium-per-target-dollar',
      baselinePremiumRatio: baseline.premiumRatio,
      comparisonPremiumRatio: comparison.premiumRatio,
      premiumRatioDelta,
      appliedToTargetSpendUsd: comparison.targetModelSpendUsd,
    },
    predictedSavingsUsd,
    attribution: {
      interventionKey: input.interventionKey ?? 'cost.automation-share',
      signatureId: input.signatureId ?? 'automation-model-pin',
      tier: 'tier-1-before-after',
      predictedSavingsUsd,
      realizedSavingsUsd,
      confidence: 'medium',
      sampleSize: baselineEntries.length + comparisonEntries.length,
      asOf: latestAsOf(comparisonEntries),
      window: {
        baseline: input.baseline,
        comparison: input.comparison,
      },
    },
  };
}

function collectTimestampedEntries(
  tokenData: SessionTokenData[],
  targetModel: string,
  sessionFilter?: ModelPinSessionFilter
): TimestampedPricedEntry[] {
  const entries: TimestampedPricedEntry[] = [];

  for (const session of tokenData) {
    if (!isUnattendedEntrypoint(session.entrypoint)) continue;
    if (sessionFilter && !sessionFilter(session)) continue;
    for (const entry of session.entries) {
      const timestampMs = new Date(entry.timestamp).getTime();
      if (!Number.isFinite(timestampMs)) continue;
      const model = entry.model || session.model || 'unknown';
      if (!isBillableModel(model)) continue;
      const actualCost = entryCostAtModel(entry, model);
      const targetCost = entryCostAtModel(entry, targetModel);
      // Server-tool-only rows do not measure a model-price migration. Without
      // this gate, a 0/0 row looks target-priced and can create a fake split.
      if (!hasModelTokenCost(actualCost, targetCost)) continue;
      entries.push({
        sessionId: session.sessionId,
        model,
        actualCost,
        targetCost,
        timestampMs,
        targetPriced: actualCost <= targetCost + 0.000001,
      });
    }
  }

  return entries.sort((a, b) => a.timestampMs - b.timestampMs);
}

function sumActual(entries: PricedEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.actualCost, 0);
}

function sumTarget(entries: PricedEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.targetCost, 0);
}

function collectWindowEntries(
  tokenData: SessionTokenData[],
  period: SavingsAttributionPeriod,
  targetModel: string,
  sessionFilter?: ModelPinSessionFilter
): PricedEntry[] {
  const entries: PricedEntry[] = [];

  for (const session of tokenData) {
    if (!isUnattendedEntrypoint(session.entrypoint)) continue;
    if (sessionFilter && !sessionFilter(session)) continue;

    for (const entry of session.entries) {
      const timestampMs = timestampInPeriod(entry.timestamp, period);
      if (timestampMs === null) continue;
      const model = entry.model || session.model || 'unknown';
      if (!isBillableModel(model)) continue;

      const actualCost = entryCostAtModel(entry, model);
      const targetCost = entryCostAtModel(entry, targetModel);
      if (!hasModelTokenCost(actualCost, targetCost)) continue;
      entries.push({
        sessionId: session.sessionId,
        model,
        timestampMs,
        actualCost,
        targetCost,
      });
    }
  }

  return entries;
}

function timestampInPeriod(
  timestamp: string,
  period: SavingsAttributionPeriod
): number | null {
  const t = new Date(timestamp).getTime();
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return t >= start && t < end ? t : null;
}

function isBillableModel(model: string): boolean {
  const resolved = resolveModelPricing(model);
  return !resolved.isSynthetic && !resolved.isUnknownModel && !resolved.isMissingModel;
}

function hasModelTokenCost(actualCost: number, targetCost: number): boolean {
  return actualCost > 0 || targetCost > 0;
}

function latestAsOf(entries: PricedEntry[]): string {
  return new Date(Math.max(...entries.map((entry) => entry.timestampMs)))
    .toISOString()
    .slice(0, 10);
}

/**
 * Model premium per dollar of target-model spend — the volume-normalized
 * measure realized savings are derived from (#3136). Returns 0 when there is no
 * target-model-priced spend to normalize against, so a window with nothing in it
 * cannot manufacture a ratio.
 */
function premiumRatioOf(actualUsd: number, targetUsd: number): number {
  if (!(targetUsd > 0)) return 0;
  return Math.max(0, actualUsd - targetUsd) / targetUsd;
}

function summarizeWindow(entries: PricedEntry[]): ModelPinWindowSummary {
  const sessions = new Set<string>();
  const byModel = new Map<string, PricedEntry[]>();
  let actualModelSpendUsd = 0;
  let targetModelSpendUsd = 0;

  for (const entry of entries) {
    sessions.add(entry.sessionId);
    actualModelSpendUsd += entry.actualCost;
    targetModelSpendUsd += entry.targetCost;
    const modelEntries = byModel.get(entry.model) ?? [];
    modelEntries.push(entry);
    byModel.set(entry.model, modelEntries);
  }

  return {
    entries: entries.length,
    sessions: sessions.size,
    actualModelSpendUsd,
    targetModelSpendUsd,
    premiumUsd: Math.max(0, actualModelSpendUsd - targetModelSpendUsd),
    premiumRatio: premiumRatioOf(actualModelSpendUsd, targetModelSpendUsd),
    modelMix: Array.from(byModel.entries())
      .map(([model, modelEntries]) => summarizeModel(model, modelEntries))
      .sort((a, b) => {
        const byPremium = b.premiumUsd - a.premiumUsd;
        if (byPremium !== 0) return byPremium;
        return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
      }),
  };
}

function summarizeModel(
  model: string,
  entries: PricedEntry[]
): ModelPinModelMixRow {
  const sessions = new Set(entries.map((entry) => entry.sessionId));
  const actualModelSpendUsd = entries.reduce(
    (sum, entry) => sum + entry.actualCost,
    0
  );
  const targetModelSpendUsd = entries.reduce(
    (sum, entry) => sum + entry.targetCost,
    0
  );

  return {
    model,
    entries: entries.length,
    sessions: sessions.size,
    actualModelSpendUsd,
    targetModelSpendUsd,
    premiumUsd: Math.max(0, actualModelSpendUsd - targetModelSpendUsd),
  };
}
