/**
 * Official Anthropic model pricing.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Last verified: 2026-06-12
 *
 * All rates are USD per million tokens (MTok).
 *
 * Cache pricing tiers:
 *   - 5-minute cache write: 1.25x base input price
 *   - 1-hour cache write:   2x base input price
 *   - Cache read (hit):     0.1x base input price
 *   - Output:               5x base input price
 *
 * Server tool pricing (flat per-request, independent of token cost):
 *   - web_search: $10 per 1,000 requests = $0.01 / request
 *     (verified 2026-05-26, https://platform.claude.com/docs/en/about-claude/pricing
 *      and https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool)
 *   - web_fetch:  no separate per-request charge — billed only via the
 *     standard input-token cost of the fetched content
 *     (verified 2026-05-26). The field is kept at $0 so the tally structure
 *     exists if Anthropic introduces a per-request fee later.
 */

import type { TokenEntry } from '../types';
import {
  CHEAPEST_CURRENT_MODEL_ID,
  CURRENT_FAMILY_PRICING,
  MODEL_PRICING,
  resolveModelFamily,
  type ModelPricing,
} from './model-registry';

export { MODEL_PRICING, type ModelPricing } from './model-registry';

/**
 * Flat per-request prices for server-side tools (USD per request).
 *
 * These are charged in addition to the token cost of the content the tool
 * pulls into context. See pricing notes above for sourcing.
 */
const WEB_SEARCH_REQUEST_USD = 0.01;
const WEB_FETCH_REQUEST_USD = 0;

export const SERVER_TOOL_PRICING = {
  /** $10 / 1,000 web searches (VERIFIED 2026-05-26). */
  webSearchRequest: WEB_SEARCH_REQUEST_USD,
  /**
   * Web fetch has no per-request fee as of 2026-05-26 (VERIFIED — billed
   * only through token cost). Placeholder kept at 0; update here if Anthropic
   * introduces a per-request charge.
   */
  webFetchRequest: WEB_FETCH_REQUEST_USD,
} as const;

/**
 * Canonical flat server-tool fee for one token entry. Keeping this next to the
 * rate table gives every cost surface — session totals, model scenarios, the
 * reclaim residual matrix, and weekly allocation weights — one arithmetic
 * seam when server-tool pricing changes (#3545).
 */
export function serverToolCost(
  entry: Pick<TokenEntry, 'webSearchRequests' | 'webFetchRequests'>
): number {
  return (
    entry.webSearchRequests * WEB_SEARCH_REQUEST_USD +
    entry.webFetchRequests * WEB_FETCH_REQUEST_USD
  );
}

/**
 * Zero-cost pricing tier — used for synthetic / non-billable entries and for
 * truly unrecognized models, whose spend is excluded from cost (not estimated
 * under a default tier). See {@link resolveModelPricing}.
 */
const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};

/**
 * The `<synthetic>` model string is emitted by Claude Code for
 * locally-generated assistant turns (e.g. injected system/UI messages) that
 * are never billed by the API. Pricing them as Sonnet (the old fallback
 * behaviour) silently inflated cost, so we treat them as zero real cost.
 */
export const SYNTHETIC_MODEL = '<synthetic>';

export interface ModelPricingResult {
  pricing: ModelPricing;
  /**
   * True when `model` was not recognized at all (no exact entry and no
   * inferable family). Such models are priced at zero and **excluded** from
   * cost rather than estimated — pricing them as Sonnet silently mis-stated
   * spend. The UI surfaces these as "excluded / unpriced" so their tokens
   * still count while their dollars don't. Synthetic (zero-cost) and
   * exact/family matches are never flagged.
   */
  isUnknownModel: boolean;
  /** True when the transcript did not provide a concrete model id. */
  isMissingModel: boolean;
  /** True when the entry is a non-billable `<synthetic>` turn. */
  isSynthetic: boolean;
}

/**
 * Resolve pricing for a model string, with provenance flags.
 *
 * 1. `<synthetic>` → zero cost (not billable).
 * 2. Exact match against MODEL_PRICING.
 * 3. Family-based fallback (opus → current opus, haiku → current haiku). This
 *    covers bare family strings and registered ids carrying a deployment
 *    suffix like `[1m]` (the 1M-context Opus variant — billed at standard
 *    Opus rates, no long-context premium).
 * 4. Truly unrecognized → zero pricing, flagged `isUnknownModel: true` so the
 *    entry is excluded from cost rather than mispriced under a default tier.
 */
export function resolveModelPricing(model: string): ModelPricingResult {
  const normalized = model.trim();
  if (!normalized || normalized.toLowerCase() === 'unknown') {
    return {
      pricing: ZERO_PRICING,
      isUnknownModel: false,
      isMissingModel: true,
      isSynthetic: false,
    };
  }

  if (normalized === SYNTHETIC_MODEL) {
    return {
      pricing: ZERO_PRICING,
      isUnknownModel: false,
      isMissingModel: false,
      isSynthetic: true,
    };
  }

  const exact = MODEL_PRICING[normalized];
  if (exact) {
    return {
      pricing: exact,
      isUnknownModel: false,
      isMissingModel: false,
      isSynthetic: false,
    };
  }

  const family = resolveModelFamily(normalized);
  if (family) {
    return {
      pricing: CURRENT_FAMILY_PRICING[family],
      isUnknownModel: false,
      isMissingModel: false,
      isSynthetic: false,
    };
  }

  // Truly unrecognized: exclude from cost (zero pricing) and flag it, so its
  // spend is dropped rather than estimated under an arbitrary default tier.
  return {
    pricing: ZERO_PRICING,
    isUnknownModel: true,
    isMissingModel: false,
    isSynthetic: false,
  };
}

/**
 * Look up pricing for a model string (pricing tier only).
 *
 * Thin wrapper over {@link resolveModelPricing} retained for callers that
 * only need the rate table. See `resolveModelPricing` for the unknown-model
 * and synthetic flags.
 */
export function getModelPricing(model: string): ModelPricing {
  return resolveModelPricing(model).pricing;
}

/**
 * Cheapest current model — the floor of the model-swap "ceiling" math. Swapping
 * a turn here yields the maximum same-token price ceiling. Callers decide
 * whether that counterfactual is bookable. Named so swap callers (TokenUsage's
 * swapScenario, the automation-cost counterfactual) don't sprinkle the raw id
 * around.
 */
export const CHEAPEST_MODEL = CHEAPEST_CURRENT_MODEL_ID;

/** Dollar contribution of each independently billed term in one token entry. */
export interface EntryCostBreakdown {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  serverTools: number;
}

/**
 * Price every billed term in one token entry against an explicit pricing tier.
 * Consumers select or sum these named terms according to their own claim:
 * observed totals include all six, while model-swap counterfactuals exclude
 * model-independent server-tool fees.
 */
export function entryCostBreakdown(
  entry: TokenEntry,
  pricing: ModelPricing
): EntryCostBreakdown {
  const cacheWrite1hTokens = Math.min(
    entry.cacheCreation1hTokens,
    entry.cacheCreationTokens
  );
  const cacheWrite5mTokens =
    entry.cacheCreationTokens - cacheWrite1hTokens;
  return {
    input: (entry.inputTokens / 1_000_000) * pricing.input,
    output: (entry.outputTokens / 1_000_000) * pricing.output,
    cacheWrite5m:
      (cacheWrite5mTokens / 1_000_000) * pricing.cacheWrite5m,
    cacheWrite1h:
      (cacheWrite1hTokens / 1_000_000) * pricing.cacheWrite1h,
    cacheRead: (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead,
    serverTools: serverToolCost(entry),
  };
}

/**
 * Cost of a single token entry priced under an explicit model tier (the
 * model-swap counterfactual). Used both by the Tokens view's swap scenario and
 * the automation-cost recommendation to answer "what would this turn have cost
 * on a cheaper model?" — reusing the one pricing table rather than duplicating
 * rates. Excludes server-tool (web search/fetch) charges, which don't change
 * with the chat model.
 */
export function entryCostAtModel(entry: TokenEntry, model: string): number {
  const pricing = getModelPricing(model);
  const terms = entryCostBreakdown(entry, pricing);
  return (
    terms.input +
    terms.output +
    terms.cacheWrite5m +
    terms.cacheWrite1h +
    terms.cacheRead
  );
}
