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
    expect(result?.realizedSavingsUsd).toBeCloseTo(
      baselinePremium - comparisonPremium,
      6
    );
    expect(result?.predictedSavingsUsd).toBeCloseTo(comparisonPremium, 6);
    expect(result?.attribution).toMatchObject({
      interventionKey: 'cost.automation-share',
      signatureId: 'automation-model-pin',
      tier: 'tier-1-before-after',
      confidence: 'medium',
    });
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
});
