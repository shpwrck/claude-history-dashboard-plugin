import type { Detector } from '../types';
import { isModelPinned, newestTokenDataDate, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { CURRENT_MODEL_IDS } from '../../model-registry';
import type { ReclaimClaim } from '../../reclaim';

/** Unknown-model evidence older than this demotes to "as of <date>" (#3201). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

/**
 * Cost figures are UNDERSTATED where the model string was unrecognised: the
 * pricing registry zero-prices a truly unknown model and EXCLUDES its spend
 * from cost estimates rather than guessing a tier (`resolveModelPricing`,
 * `isUnknownModel`). The old Sonnet-tier fallback wording predated that
 * behaviour and asserted the opposite bias (#3201).
 */
export const detector: Detector = {
  id: 'cost.unknown-model',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input, now) {
    // The fix is "pin a known model". If `model` is set globally to anything,
    // future sessions are priced from a known rate, so the rec is satisfied
    // regardless of which model the user chose.
    if (isModelPinned(input.liveConfig?.settings)) return null;
    const unknown = input.tokenData.filter((d) => d.hasUnknownModel);
    if (unknown.length === 0) return null;
    // Flag-only: this is a data-QUALITY nudge ("some cost figures are
    // incomplete"), not a reclaim — there is no recoverable pool to book. Books
    // $0; the affected session count rides as evidence for per-category coverage.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.unknown-model',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    // Dated from the newest OBSERVED entry among the affected sessions (never
    // `now`); a corpus with no readable timestamps honestly omits asOf (#3201).
    const asOf = newestTokenDataDate(unknown);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
    return {
      id: 'cost.unknown-model',
      category: 'cost',
      severity: 'info',
      title: 'Some cost estimates are incomplete',
      detail: `${datePrefix}${unknown.length} session(s) used a model string not in the pricing registry; that spend is zero-priced and excluded from cost estimates, so those sessions' cost figures are understated.`,
      action:
        'Treat those sessions’ cost figures as lower bounds; add the model to the pricing registry (or pin a known model) for accuracy.',
      reclaim,
      affected: unknown.length,
      view: 'tokens',
      fix: {
        target: 'settings.json',
        label: 'Pin a known model',
        note: `Set an explicit model in settings.json so future sessions are priced from a known rate instead of being excluded as unpriced like the ${unknown.length} affected session(s).`,
        snippet: `{\n  "model": "${CURRENT_MODEL_IDS.sonnet}"\n}`,
      },
      // Auditability contract (#1049/#3201): the count is read off the parsed
      // session records; the exclusion behaviour is a registry fact.
      provenance: {
        observations: [
          {
            claim: `${unknown.length} of ${input.tokenData.length} parsed sessions carry hasUnknownModel=true (at least one entry whose model string resolveModelPricing does not recognise)`,
            source: 'parse-sessions',
            field: 'tokenData[].hasUnknownModel',
            value: unknown.length,
          },
          {
            claim:
              'an unrecognised model is zero-priced and its spend is excluded from cost estimates rather than priced under a default tier',
            source: 'pricing.ts',
            field: 'resolveModelPricing (isUnknownModel -> ZERO_PRICING)',
          },
        ],
        inference:
          'Because unknown-model spend is excluded rather than estimated, the affected ' +
          "sessions' cost figures are lower bounds — a data-quality nudge, not a " +
          'reclaim; nothing is booked. Pinning a known model (or registering the ' +
          'model string) makes future sessions priceable.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
