import { describe, expect, it } from 'vitest';
import { computeSessionOverview, peakContextMetric } from './session-overview';
import type { SessionTokenData } from '../types';
import type { SessionTimeline } from './parse-timeline';

describe('computeSessionOverview', () => {
  it('counts user turns from derived summary lengths when summaries are stripped', () => {
    const timeline: SessionTimeline = {
      sessionId: 'sess-derived',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:02:00.000Z',
      slim: true,
      entries: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          kind: 'user',
          summaryLen: 14,
          hasCode: false,
          isQuestion: false,
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          kind: 'user',
          summaryLen: 0,
          hasCode: false,
          isQuestion: false,
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          kind: 'assistant',
          summaryLen: 0,
          hasCode: false,
          isQuestion: false,
        },
      ],
    };

    const overview = computeSessionOverview(
      timeline.sessionId,
      undefined,
      undefined,
      timeline,
      []
    );

    expect(overview.userTurns).toBe(1);
  });
});

function tokens(model: string, peak: number): SessionTokenData {
  return {
    sessionId: 's',
    model,
    totalInputTokens: peak,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasUnknownModel: false,
    compactionEvents: [],
    entries: [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        model,
        inputTokens: peak,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
  } as unknown as SessionTokenData;
}

describe('computeSessionOverview context window (#3797, #3798)', () => {
  const overview = (model: string, peak: number) =>
    computeSessionOverview('s', tokens(model, peak), undefined, undefined, []);

  it('resolves a [1m] session at 400K to an exact 1M window and 40%', () => {
    const o = overview('claude-opus-4-8[1m]', 400_000);
    expect(o.contextWindow?.resolution).toMatchObject({ kind: 'exact', contextWindowTokens: 1_000_000 });
    expect(o.peakContextPercent).toBeCloseTo(40);
    expect(peakContextMetric(o)).toEqual({ value: '40%', sub: '400.0K / 1M', warn: false });
  });

  it('keeps a 200K session at the same percentage and copy as before', () => {
    const o = overview('claude-haiku-4-5-20251001', 100_000);
    expect(o.contextWindow?.resolution).toMatchObject({ kind: 'exact', contextWindowTokens: 200_000 });
    expect(o.peakContextPercent).toBe(50);
    expect(peakContextMetric(o)).toEqual({ value: '50%', sub: '100.0K / 200K', warn: true });
  });

  it('carries no exact percentage or denominator for a lower-bound window', () => {
    const o = overview('claude-opus-4-8[1m]', 1_000_001);
    expect(o.contextWindow?.resolution.kind).toBe('lower-bound');
    expect(o.contextWindow?.usagePercent).toBeNull();
    expect(o.peakContextPercent).toBeNull();
    const copy = peakContextMetric(o);
    expect(copy.value).not.toMatch(/%/);
    expect(copy.sub).not.toMatch(/\//);
    expect(copy.sub).toMatch(/window unknown/);
    expect(copy.warn).toBe(true);
  });

  it('never prints a fixed 200K denominator for a non-200K window', () => {
    const copy = peakContextMetric(overview('claude-opus-4-8[1m]', 300_000));
    expect(copy.sub).not.toContain('/ 200K');
  });

  it('prints no denominator without token data', () => {
    const o = computeSessionOverview('s', undefined, undefined, undefined, [{} as never]);
    expect(o.contextWindow).toBeUndefined();
    expect(peakContextMetric(o)).toEqual({
      value: 'n/a',
      sub: 'no token data for a context window',
      warn: false,
    });
  });

  it('warns on the rounded percentage the card shows', () => {
    const copy = peakContextMetric(overview('claude-haiku-4-5-20251001', 99_200));
    expect(copy.value).toBe('50%');
    expect(copy.warn).toBe(true);
    expect(peakContextMetric(overview('claude-haiku-4-5-20251001', 98_000)).warn).toBe(false);
  });
});
