import { describe, expect, it } from 'vitest';
import type { RecommendationInput } from '../types';
import { detector } from './model-latency';
import { validateRecommendationProvenance } from '../provenance';

function baseInput(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...over,
  };
}

function sample(
  session_id: string,
  model: string,
  apiDurationMs: number,
  outputTokens: number,
  client_timestamp = '2026-06-13T12:00:00Z'
): NonNullable<RecommendationInput['modelLatency']>[number] {
  return {
    session_id,
    model,
    apiDurationMs,
    toolDurationMs: 0,
    inputTokens: 0,
    outputTokens,
    client_timestamp,
  };
}

const triggerSamples = (
  timestamp = '2026-06-13T12:00:00Z'
): NonNullable<RecommendationInput['modelLatency']> => [
  sample('slow-a', 'claude-opus-4-8[1m]', 70_000, 1_000, timestamp),
  sample('slow-b', 'claude-opus-4-8[1m]', 70_000, 1_000, timestamp),
  sample('slow-c', 'claude-opus-4-8[1m]', 70_000, 1_000, timestamp),
  sample('fast-a', 'claude-haiku-4-5-20251001', 15_000, 1_000, timestamp),
  sample('fast-b', 'claude-haiku-4-5-20251001', 15_000, 1_000, timestamp),
  sample('fast-c', 'claude-haiku-4-5-20251001', 15_000, 1_000, timestamp),
];

describe('speed.model-latency (#915)', () => {
  it('fires on a non-legacy slow model with a measured faster baseline', () => {
    const rec = detector.rule(baseInput({ modelLatency: triggerSamples() }), 0);

    expect(rec?.id).toBe('speed.model-latency');
    expect(rec?.category).toBe('speed');
    expect(rec?.severity).toBe('info');
    expect(rec?.estTimeReclaimedMin).toBeCloseTo(2.8);
    expect(rec?.detail).toContain('excludes the 30s slow-first-byte timeout ceiling');
    expect(rec?.action).toContain('route or pin that workflow');
    expect(rec?.evidence?.[0]).toContain('slow-a');
  });

  it('stays silent on sparse, single-model, or small-effect telemetry', () => {
    expect(
      detector.rule(
        baseInput({
          modelLatency: [
            sample('a', 'claude-opus-4-8[1m]', 11_000, 600),
            sample('b', 'claude-opus-4-8[1m]', 12_000, 696),
          ],
        }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        baseInput({
          modelLatency: [
            sample('slow-a', 'claude-opus-4-8[1m]', 70_000, 1_000),
            sample('fast-a', 'claude-haiku-4-5-20251001', 15_000, 1_000),
          ],
        }),
        0
      )
    ).toBeNull();
    expect(
      detector.rule(
        baseInput({
          modelLatency: [
            sample('a', 'claude-opus-4-8[1m]', 30_000, 1_000),
            sample('b', 'claude-opus-4-8[1m]', 30_000, 1_000),
            sample('c', 'claude-haiku-4-5-20251001', 24_000, 1_000),
            sample('d', 'claude-haiku-4-5-20251001', 24_000, 1_000),
          ],
        }),
        0
      )
    ).toBeNull();
  });

  it('does not duplicate legacy-priced Opus overpay', () => {
    const rec = detector.rule(
      baseInput({
        modelLatency: [
          sample('legacy-a', 'claude-opus-4-1-20250414', 90_000, 1_000),
          sample('legacy-b', 'claude-opus-4-1-20250414', 90_000, 1_000),
          sample('fast-a', 'claude-haiku-4-5-20251001', 15_000, 1_000),
          sample('fast-b', 'claude-haiku-4-5-20251001', 15_000, 1_000),
        ],
      }),
      0
    );

    expect(rec).toBeNull();
  });

  it('cites both cohort operands and the equal-output reclaimed-time arithmetic', () => {
    const rec = detector.rule(
      baseInput({ modelLatency: triggerSamples() }),
      Date.parse('2026-06-14T00:00:00Z')
    )!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.asOf).toBe('2026-06-13');
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: 'claude-opus-4-8[1m]',
          field: 'modelLatency[].{apiDurationMs,outputTokens}',
          value: '210000/3000',
        }),
        expect.objectContaining({
          record: 'claude-haiku-4-5-20251001',
          field: 'modelLatency[].{apiDurationMs,outputTokens}',
          value: '45000/3000',
        }),
      ])
    );
    expect(rec.provenance?.derivations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'slow-ms-per-output-token',
          operands: { totalApiDurationMs: 210_000, totalOutputTokens: 3_000 },
          value: 70,
        }),
        expect.objectContaining({
          id: 'baseline-ms-per-output-token',
          operands: { totalApiDurationMs: 45_000, totalOutputTokens: 3_000 },
          value: 15,
        }),
        expect.objectContaining({
          id: 'reclaimed-ms-on-slow-output-volume',
          operands: {
            slowMsPerOutputToken: 70,
            baselineMsPerOutputToken: 15,
            slowOutputTokens: 3_000,
          },
          value: 165_000,
        }),
      ])
    );
  });

  it('demotes stale latency telemetry to explicitly historical wording', () => {
    const rec = detector.rule(
      baseInput({ modelLatency: triggerSamples('2026-01-01T12:00:00Z') }),
      Date.parse('2026-06-14T00:00:00Z')
    )!;

    expect(rec.provenance?.asOf).toBe('2026-01-01');
    expect(rec.provenance?.stale).toBe(true);
    expect(rec.detail).toMatch(/^As of 2026-01-01,/);
    expect(rec.action).toMatch(/^Treat this as historical evidence/);
    expect(rec.action).toContain('remeasure');
  });
});
