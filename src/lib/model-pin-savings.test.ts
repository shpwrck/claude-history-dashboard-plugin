import { describe, expect, it } from 'vitest';
import type { SessionTokenData, TokenEntry } from '../types';
import {
  CHEAPEST_MODEL,
  entryCostAtModel,
  SYNTHETIC_MODEL,
} from './pricing';
import {
  computeModelPinSavings,
  deriveModelPinSavingsConfig,
} from './model-pin-savings';

const baseline = {
  start: '2026-05-01T00:00:00Z',
  end: '2026-05-08T00:00:00Z',
};
const comparison = {
  start: '2026-05-08T00:00:00Z',
  end: '2026-05-15T00:00:00Z',
};

function entry(timestamp: string, model: string): TokenEntry {
  return {
    timestamp,
    model,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 2,
    webFetchRequests: 0,
  };
}

function session(
  sessionId: string,
  entrypoint: string,
  entries: TokenEntry[]
): SessionTokenData {
  return {
    sessionId,
    entrypoint,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

describe('computeModelPinSavings', () => {
  it('computes before/after model mix and realized model-premium savings', () => {
    const baselineOpus = entry('2026-05-02T12:00:00Z', 'claude-opus-4-8');
    const comparisonSonnet = entry('2026-05-09T12:00:00Z', 'claude-sonnet-4-6');
    const comparisonHaiku = entry('2026-05-10T12:00:00Z', CHEAPEST_MODEL);

    const result = computeModelPinSavings({
      tokenData: [
        session('auto-a', 'sdk-cli', [baselineOpus]),
        session('auto-b', 'sdk-py', [comparisonSonnet, comparisonHaiku]),
        session('human', 'cli', [entry('2026-05-03T12:00:00Z', 'claude-opus-4-8')]),
      ],
      baseline,
      comparison,
    });

    expect(result).not.toBeNull();
    const baselinePremium =
      entryCostAtModel(baselineOpus, 'claude-opus-4-8') -
      entryCostAtModel(baselineOpus, CHEAPEST_MODEL);
    const comparisonPremium =
      entryCostAtModel(comparisonSonnet, 'claude-sonnet-4-6') -
      entryCostAtModel(comparisonSonnet, CHEAPEST_MODEL);

    expect(result?.baseline.entries).toBe(1);
    expect(result?.comparison.entries).toBe(2);
    expect(result?.baseline.modelMix.map((row) => row.model)).toEqual([
      'claude-opus-4-8',
    ]);
    expect(result?.comparison.modelMix.map((row) => row.model)).toEqual([
      'claude-sonnet-4-6',
      CHEAPEST_MODEL,
    ]);
    // CHANGED in #3136. This asserted `baselinePremium - comparisonPremium` --
    // the subtraction of two TOTALS across a 1-entry baseline and a 2-entry
    // comparison, i.e. the unmatched-window comparison the finding is about.
    // The figure is now the improvement in premium PER DOLLAR of target-model
    // spend, applied to the comparison window's own workload.
    const baselineTarget =
      entryCostAtModel(baselineOpus, CHEAPEST_MODEL);
    const comparisonTarget =
      entryCostAtModel(comparisonSonnet, CHEAPEST_MODEL) +
      entryCostAtModel(comparisonHaiku, CHEAPEST_MODEL);
    const baselineRatio = baselinePremium / baselineTarget;
    const comparisonRatio = comparisonPremium / comparisonTarget;
    expect(result?.realizedSavingsUsd).toBeCloseTo(
      (baselineRatio - comparisonRatio) * comparisonTarget,
      6
    );
    // ...and the derivation is reproducible from the result alone.
    expect(result?.normalization).toMatchObject({
      kind: 'premium-per-target-dollar',
      appliedToTargetSpendUsd: expect.closeTo(comparisonTarget, 6),
    });
    expect(result!.normalization.premiumRatioDelta).toBeCloseTo(
      baselineRatio - comparisonRatio,
      9
    );
    expect(result?.predictedSavingsUsd).toBeCloseTo(comparisonPremium, 6);
    expect(result?.attribution).toMatchObject({
      interventionKey: 'cost.automation-share',
      signatureId: 'automation-model-pin',
      tier: 'tier-1-before-after',
      confidence: 'medium',
      sampleSize: 3,
      asOf: '2026-05-10',
    });
    // Model-premium measurement is token-only. The fixture carries paid web
    // searches, but server-tool fees do not change when the model changes.
    expect(result?.baseline.actualModelSpendUsd).toBeCloseTo(
      entryCostAtModel(baselineOpus, 'claude-opus-4-8'),
      6
    );
  });

  it('ignores synthetic and interactive entries', () => {
    const realBaseline = entry('2026-05-02T12:00:00Z', 'claude-opus-4-8');
    const realComparison = entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL);

    const result = computeModelPinSavings({
      tokenData: [
        session('auto', 'sdk-cli', [
          realBaseline,
          entry('2026-05-03T12:00:00Z', SYNTHETIC_MODEL),
          realComparison,
        ]),
        session('human', 'cli', [
          entry('2026-05-04T12:00:00Z', 'claude-opus-4-8'),
          entry('2026-05-10T12:00:00Z', 'claude-opus-4-8'),
        ]),
      ],
      baseline,
      comparison,
    });

    const baselinePremium =
      entryCostAtModel(realBaseline, 'claude-opus-4-8') -
      entryCostAtModel(realBaseline, CHEAPEST_MODEL);

    expect(result?.baseline.entries).toBe(1);
    expect(result?.comparison.entries).toBe(1);
    expect(result?.comparison.premiumUsd).toBeCloseTo(0, 6);
    expect(result?.realizedSavingsUsd).toBeCloseTo(baselinePremium, 6);
    expect(result?.attribution.asOf).toBe('2026-05-09');
  });

  it('dates attribution from the latest priced comparison entry actually included', () => {
    const keep = (s: SessionTokenData): boolean => s.sessionId !== 'filtered';
    const result = computeModelPinSavings({
      tokenData: [
        session('included', 'sdk-cli', [
          entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
          entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
          // The comparison end is exclusive.
          entry('2026-05-15T00:00:00Z', CHEAPEST_MODEL),
          // Synthetic and unpriced rows are not measurement samples.
          entry('2026-05-13T12:00:00Z', SYNTHETIC_MODEL),
          entry('2026-05-14T12:00:00Z', 'unknown-provider-model'),
        ]),
        session('interactive', 'cli', [
          entry('2026-05-14T18:00:00Z', CHEAPEST_MODEL),
        ]),
        session('filtered', 'sdk-cli', [
          entry('2026-05-14T20:00:00Z', CHEAPEST_MODEL),
        ]),
        session('outside', 'sdk-cli', [
          entry('2026-06-01T12:00:00Z', CHEAPEST_MODEL),
        ]),
      ],
      baseline,
      comparison,
      sessionFilter: keep,
    });

    expect(result?.comparison.entries).toBe(1);
    expect(result?.attribution).toMatchObject({
      sampleSize: 2,
      asOf: '2026-05-09',
    });
  });

  it('refuses an unpriced or synthetic target model', () => {
    const tokenData = [
      session('auto', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
        entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
      ]),
    ];

    expect(
      computeModelPinSavings({
        tokenData,
        baseline,
        comparison,
        targetModel: 'unknown-provider-model',
      })
    ).toBeNull();
    expect(
      computeModelPinSavings({
        tokenData,
        baseline,
        comparison,
        targetModel: SYNTHETIC_MODEL,
      })
    ).toBeNull();
  });

  it('returns null when either compared window has no billable automation data', () => {
    expect(
      computeModelPinSavings({
        tokenData: [
          session('auto', 'sdk-cli', [
            entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
          ]),
        ],
        baseline,
        comparison,
      })
    ).toBeNull();
  });

  it('reports all-Haiku comparison windows as no remaining predicted savings', () => {
    const result = computeModelPinSavings({
      tokenData: [
        session('auto-a', 'sdk-cli', [
          entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
        ]),
        session('auto-b', 'sdk-cli', [
          entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
        ]),
      ],
      baseline,
      comparison,
    });

    expect(result?.comparison.modelMix).toEqual([
      expect.objectContaining({ model: CHEAPEST_MODEL, premiumUsd: 0 }),
    ]);
    expect(result?.predictedSavingsUsd).toBeCloseTo(0, 6);
    expect(result?.realizedSavingsUsd).toBeGreaterThan(0);
  });
});

describe('deriveModelPinSavingsConfig', () => {
  it('infers a model-pin before/after window from unattended token history', () => {
    const tokenData = [
      session('baseline-auto', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
        entry('2026-05-03T12:00:00Z', 'claude-sonnet-4-6'),
      ]),
      session('comparison-auto', 'sdk-cli', [
        entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
        entry('2026-05-10T12:00:00Z', 'claude-haiku-4-5'),
      ]),
      session('human', 'cli', [
        entry('2026-05-04T12:00:00Z', 'claude-opus-4-8'),
      ]),
    ];

    const config = deriveModelPinSavingsConfig({ tokenData });

    expect(config).toEqual({
      baseline: {
        start: '2026-05-02T12:00:00.000Z',
        end: '2026-05-09T12:00:00.000Z',
      },
      comparison: {
        start: '2026-05-09T12:00:00.000Z',
        end: '2026-05-10T12:00:00.001Z',
      },
      targetModel: CHEAPEST_MODEL,
    });
    expect(
      computeModelPinSavings({
        tokenData,
        ...config!,
      })?.realizedSavingsUsd
    ).toBeGreaterThan(0);
  });

  it('returns null when the comparison side is not mostly target-priced', () => {
    const tokenData = [
      session('baseline-auto', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
      ]),
      session('comparison-auto', 'sdk-cli', [
        entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
        entry('2026-05-10T12:00:00Z', 'claude-opus-4-8'),
        entry('2026-05-11T12:00:00Z', 'claude-sonnet-4-6'),
      ]),
    ];

    expect(deriveModelPinSavingsConfig({ tokenData })).toBeNull();
  });

  it('returns null when the candidate split has no positive realized drop', () => {
    const tokenData = [
      session('baseline-auto', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', CHEAPEST_MODEL),
      ]),
      session('comparison-auto', 'sdk-cli', [
        entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
      ]),
    ];

    expect(deriveModelPinSavingsConfig({ tokenData })).toBeNull();
  });

  it('does not infer a migration from a zero-token server-tool-only comparison row', () => {
    const serverToolOnly = {
      ...entry('2026-05-09T12:00:00Z', 'claude-opus-4-8'),
      inputTokens: 0,
      outputTokens: 0,
      webSearchRequests: 100,
    };
    const tokenData = [
      session('baseline-auto', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
      ]),
      session('comparison-auto', 'sdk-cli', [serverToolOnly]),
    ];

    expect(deriveModelPinSavingsConfig({ tokenData })).toBeNull();
    expect(
      computeModelPinSavings({ tokenData, baseline, comparison })
    ).toBeNull();
  });
});

describe('sessionFilter parameterization (#2140)', () => {
  it('narrows computeModelPinSavings window math to sessions passing the predicate', () => {
    const keepOpus = entry('2026-05-02T12:00:00Z', 'claude-opus-4-8');
    const keepHaiku = entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL);
    const dropOpus = entry('2026-05-10T12:00:00Z', 'claude-opus-4-8');

    const withFilter = computeModelPinSavings({
      tokenData: [
        session('keep', 'sdk-cli', [keepOpus, keepHaiku]),
        session('drop', 'sdk-cli', [dropOpus]),
      ],
      baseline,
      comparison,
      sessionFilter: (s) => s.sessionId === 'keep',
    });

    // Only `keep` contributes — one baseline turn, one comparison turn — even
    // though `drop` is also unattended automation inside the comparison window.
    expect(withFilter?.baseline.entries).toBe(1);
    expect(withFilter?.comparison.entries).toBe(1);
    expect(withFilter?.realizedSavingsUsd).toBeCloseTo(
      entryCostAtModel(keepOpus, 'claude-opus-4-8') -
        entryCostAtModel(keepOpus, CHEAPEST_MODEL),
      6
    );
  });

  it('lets deriveModelPinSavingsConfig infer a per-slice window the aggregate would miss', () => {
    const tokenData = [
      // The `keep` slice migrated Opus -> Haiku cleanly.
      session('keep', 'sdk-cli', [
        entry('2026-05-02T12:00:00Z', 'claude-opus-4-8'),
        entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
      ]),
      // The `drop` slice stayed on Opus, dragging the aggregate comparison side
      // below the target-priced share threshold if it were counted.
      session('drop', 'sdk-cli', [
        entry('2026-05-09T13:00:00Z', 'claude-opus-4-8'),
        entry('2026-05-10T12:00:00Z', 'claude-opus-4-8'),
      ]),
    ];

    // Aggregate (no filter) cannot find a credible before/after: the comparison
    // side is mostly Opus, so the target-priced share is below threshold.
    expect(deriveModelPinSavingsConfig({ tokenData })).toBeNull();

    // The `keep` slice on its own DID migrate, so the filtered derive surfaces it.
    const keepConfig = deriveModelPinSavingsConfig({
      tokenData,
      sessionFilter: (s) => s.sessionId === 'keep',
    });
    expect(keepConfig).not.toBeNull();
    expect(keepConfig?.targetModel).toBe(CHEAPEST_MODEL);
    expect(
      computeModelPinSavings({
        tokenData,
        ...keepConfig!,
        sessionFilter: (s) => s.sessionId === 'keep',
      })?.realizedSavingsUsd
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Model choice must not be confounded with workload volume (#3136)
// ---------------------------------------------------------------------------

describe('realized savings isolate model choice from volume (#3136)', () => {
  const opus = 'claude-opus-4-8';

  it('books nothing when only the TRAFFIC changed', () => {
    // Identical model mix in both windows — every entry on Opus. The only
    // difference is that the comparison window did less work. Any positive
    // figure here is attributing a traffic drop to a model pin that never
    // happened.
    const result = computeModelPinSavings({
      tokenData: [
        session('auto-a', 'sdk-cli', [
          entry('2026-05-02T12:00:00Z', opus),
          entry('2026-05-03T12:00:00Z', opus),
          entry('2026-05-04T12:00:00Z', opus),
        ]),
        session('auto-b', 'sdk-py', [entry('2026-05-09T12:00:00Z', opus)]),
      ],
      baseline,
      comparison,
    });

    expect(result).not.toBeNull();
    // Same premium per dollar of target spend on both sides → no rate change.
    expect(result!.baseline.premiumRatio).toBeCloseTo(
      result!.comparison.premiumRatio,
      9
    );
    expect(result!.realizedSavingsUsd).toBeCloseTo(0, 9);
    expect(result!.normalization.premiumRatioDelta).toBeCloseTo(0, 9);
  });

  it('still books a genuine rate improvement when traffic GREW', () => {
    // One Opus entry before; three cheap entries after. Raw totals could show
    // the comparison premium at or above the baseline's simply because there is
    // more work — which previously erased the improvement.
    const result = computeModelPinSavings({
      tokenData: [
        session('auto-a', 'sdk-cli', [entry('2026-05-02T12:00:00Z', opus)]),
        session('auto-b', 'sdk-py', [
          entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL),
          entry('2026-05-10T12:00:00Z', CHEAPEST_MODEL),
          entry('2026-05-11T12:00:00Z', CHEAPEST_MODEL),
        ]),
      ],
      baseline,
      comparison,
    });

    expect(result).not.toBeNull();
    // The comparison window is entirely on the target model: zero premium.
    expect(result!.comparison.premiumRatio).toBeCloseTo(0, 9);
    expect(result!.baseline.premiumRatio).toBeGreaterThan(0);
    // A real per-unit improvement, applied to the (larger) comparison workload.
    expect(result!.realizedSavingsUsd).toBeGreaterThan(0);
    expect(result!.normalization.appliedToTargetSpendUsd).toBeCloseTo(
      result!.comparison.targetModelSpendUsd,
      9
    );
  });

  it('reproduces its own figure from the exported terms', () => {
    const result = computeModelPinSavings({
      tokenData: [
        session('auto-a', 'sdk-cli', [entry('2026-05-02T12:00:00Z', opus)]),
        session('auto-b', 'sdk-py', [entry('2026-05-09T12:00:00Z', CHEAPEST_MODEL)]),
      ],
      baseline,
      comparison,
    });
    const n = result!.normalization;
    // The claim is checkable rather than merely asserted.
    expect(n.premiumRatioDelta).toBeCloseTo(
      n.baselinePremiumRatio - n.comparisonPremiumRatio,
      9
    );
    expect(result!.realizedSavingsUsd).toBeCloseTo(
      n.premiumRatioDelta * n.appliedToTargetSpendUsd,
      9
    );
  });
});
