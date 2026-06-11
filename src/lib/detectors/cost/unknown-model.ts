import type { Detector } from '../types';
import { isModelPinned } from '../shared';
import { CURRENT_MODEL_IDS } from '../../model-registry';
import type { ReclaimClaim } from '../../reclaim';

/** Cost figures are guesses where the model string was unrecognised. */
export const detector: Detector = {
  id: 'cost.unknown-model',
  category: 'cost',
  dataDeps: ['tokenData', 'liveConfig'],
  rule(input) {
    // The fix is "pin a known model". If `model` is set globally to anything,
    // future sessions are priced from a known rate, so the rec is satisfied
    // regardless of which model the user chose.
    if (isModelPinned(input.liveConfig?.settings)) return null;
    const unknown = input.tokenData.filter((d) => d.hasUnknownModel);
    if (unknown.length === 0) return null;
    // Flag-only: this is a data-QUALITY nudge ("some cost figures are guesses"),
    // not a reclaim — there is no recoverable pool to book. Books $0; the guessed
    // session count rides as evidence for per-category coverage.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.unknown-model',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.unknown-model',
      category: 'cost',
      severity: 'info',
      title: 'Some cost estimates are guesses',
      detail: `${unknown.length} session(s) used a model string not in the pricing table and fell back to Sonnet-tier rates.`,
      action:
        'Treat those sessions’ cost figures as approximate; add the model to the pricing table for accuracy.',
      reclaim,
      affected: unknown.length,
      view: 'tokens',
      fix: {
        target: 'settings.json',
        label: 'Pin a known model',
        note: `Set an explicit model in settings.json so future sessions are priced from a known rate instead of the Sonnet-tier fallback used for the ${unknown.length} guessed session(s).`,
        snippet: `{\n  "model": "${CURRENT_MODEL_IDS.sonnet}"\n}`,
      },
    };
  },
};
