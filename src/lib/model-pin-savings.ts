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
  modelMix: ModelPinModelMixRow[];
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
   * Observed reduction in model premium between the two windows. This is a
   * Tier 1 before/after signal, so it is directional rather than causal.
   */
  realizedSavingsUsd: number;
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

    const baselinePremium = sumPremium(baseline);
    const comparisonPremium = sumPremium(comparison);
    const realizedSavingsUsd = baselinePremium - comparisonPremium;
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
  const realizedSavingsUsd = Math.max(
    0,
    baseline.premiumUsd - comparison.premiumUsd
  );
  const predictedSavingsUsd = comparison.premiumUsd;

  return {
    targetModel,
    baseline,
    comparison,
    realizedSavingsUsd,
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

function sumPremium(entries: PricedEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + Math.max(0, entry.actualCost - entry.targetCost),
    0
  );
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
