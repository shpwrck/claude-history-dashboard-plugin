import type { Detector } from '../types';
import { fmtUsd, newestIsoDate, short, isModelPinned, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { getModelPricing } from '../../pricing';
import { CURRENT_MODEL_IDS } from '../../model-registry';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';

// The current-Opus model the legacy turns should reprice onto (same capability
// tier, $5/MTok input vs legacy $15/MTok). Used as the cascade reprice target.
const CURRENT_OPUS_MODEL = CURRENT_MODEL_IDS.opus;

// Legacy-priced Opus (4.0 / 4.1) bills input at $15/MTok; the same capability
// tier on current Opus (4.5–4.8) is $5/MTok — a ~67% overpay on those turns.
// We identify legacy entries by pricing-object reference equality (the legacy
// and current tiers are distinct objects in pricing.ts) so we never rely on a
// brittle model-name regex, and re-price only their INPUT tokens. (#413)
const LEGACY_REF = getModelPricing('claude-opus-4-1-20250414');
const CURRENT_REF = getModelPricing(CURRENT_OPUS_MODEL);
const RATE_DELTA = LEGACY_REF.input - CURRENT_REF.input; // $/MTok input saved
const MIN_DELTA_USD = 0.5;

/** Legacy-spend evidence older than this demotes to "as of <date>" (#3194). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

/**
 * Flag spend that ran on legacy-priced Opus where current Opus is the same
 * capability tier at ~1/3 the input price. Self-suppresses once any non-legacy
 * model is pinned in settings (the user has moved off legacy pricing). (#413)
 */
export const detector: Detector = {
  id: 'cost.legacy-model-overpay',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input, now) {
    const settingsModel = input.liveConfig?.settings?.model;
    if (
      isModelPinned(input.liveConfig?.settings) &&
      typeof settingsModel === 'string' &&
      getModelPricing(settingsModel) !== LEGACY_REF
    ) {
      return null; // already pinned off legacy pricing
    }
    let delta = 0;
    let inputTokens = 0;
    const sessions = new Set<string>();
    const scopeKeys = new Set<string>();
    const legacyTimestamps: (string | undefined)[] = [];
    for (const d of input.tokenData) {
      for (const e of d.entries) {
        if (getModelPricing(e.model) !== LEGACY_REF) continue;
        const d$ = (e.inputTokens / 1_000_000) * RATE_DELTA;
        if (d$ > 0) {
          delta += d$;
          inputTokens += e.inputTokens;
          sessions.add(d.sessionId);
          scopeKeys.add(scopeKeyOf(d.sessionId, e.model || 'unknown'));
          legacyTimestamps.push(e.timestamp);
        }
      }
    }
    if (delta < MIN_DELTA_USD) return null;
    // Dated from the newest OBSERVED legacy-priced entry (never `now`); no
    // readable timestamps → no asOf (#3194).
    const asOf = newestIsoDate(legacyTimestamps);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
    // Reclaim claim: reprice the legacy-Opus INPUT pool onto current Opus
    // ($15→$5/MTok). `reprice` touches only the `input` pool of the legacy scopes,
    // so the booked marginal equals (inputTokens/1M)·($15−$5) — the same delta.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.legacy-model-overpay',
      category: 'cost',
      orderKey: 55,
      ownedPools: ['input'],
      scopeKeys: [...scopeKeys],
      counterfactual: { kind: 'reprice', toModel: CURRENT_OPUS_MODEL },
      evidenceTokens: inputTokens,
    };
    return {
      id: 'cost.legacy-model-overpay',
      category: 'cost',
      severity: delta >= 1 ? 'warning' : 'info',
      title: 'Switch off legacy-priced Opus to current Opus',
      detail: `${datePrefix}${fmtUsd(delta)} of spend ran on claude-opus-4-1-* (legacy $${LEGACY_REF.input}/MTok input) across ${sessions.size} session(s); the same capability tier on current Opus is $${CURRENT_REF.input}/MTok — a ~${Math.round((RATE_DELTA / LEGACY_REF.input) * 100)}% overpay on those turns.`,
      action:
        `Update the pinned model string (settings.json or the SDK caller) from claude-opus-4-1-* to ${CURRENT_OPUS_MODEL} or newer.`,
      estSavingsUsd: delta,
      reclaim,
      affected: sessions.size,
      evidence: [...sessions].slice(0, 5).map((s) => short(s)),
      view: 'cost',
      // Auditability contract (#1049/#3194): the token volume and both registry
      // rates are the observations; the overpay is a named derivation over them.
      provenance: {
        observations: [
          {
            claim: `${inputTokens.toLocaleString()} input tokens ran on entries whose model prices at the legacy-Opus tier`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[].inputTokens (where getModelPricing(entries[].model) is the legacy-Opus tier)',
            value: inputTokens,
          },
          {
            claim: `${sessions.size} session(s) carry legacy-priced Opus entries`,
            source: 'parse-sessions',
            field: 'tokenData[].sessionId (where an entry prices at the legacy-Opus tier)',
            value: sessions.size,
          },
          {
            claim: `legacy-priced Opus (claude-opus-4-1-*) bills input at $${LEGACY_REF.input}/MTok`,
            source: 'pricing.ts',
            field: "MODEL_PRICING['claude-opus-4-1-20250414'].input",
            value: LEGACY_REF.input,
          },
          {
            claim: `current Opus (${CURRENT_OPUS_MODEL}) bills input at $${CURRENT_REF.input}/MTok`,
            source: 'pricing.ts',
            field: `MODEL_PRICING['${CURRENT_OPUS_MODEL}'].input`,
            value: CURRENT_REF.input,
          },
        ],
        derivations: [
          {
            id: 'input-overpay-usd',
            formula: '(legacyInputTokens / 1e6) * (legacyInputUsdPerMTok - currentInputUsdPerMTok)',
            operands: {
              legacyInputTokens: inputTokens,
              legacyInputUsdPerMTok: LEGACY_REF.input,
              currentInputUsdPerMTok: CURRENT_REF.input,
            },
            value: delta,
          },
        ],
        inference:
          'Current Opus is the same capability tier at a lower input rate, so ' +
          'repricing ONLY the legacy entries’ input tokens onto it is a rate-delta ' +
          'claim over the same token volume — not an estimate of behavioural change. ' +
          'Legacy entries are identified by pricing-object identity, never a ' +
          'model-name regex.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
      fix: {
        target: 'settings.json',
        label: 'Pin current Opus',
        note: 'Set the model to a current-tier Opus in settings.json (or the SDK config that launches these runs). Suppressed once a non-legacy model is pinned.',
        snippet: `{\n  "model": "${CURRENT_OPUS_MODEL}"\n}`,
      },
    };
  },
};
