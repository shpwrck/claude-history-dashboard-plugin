import { describe, expect, it } from 'vitest';
import type { SessionTokenData } from '../types';
import {
  computeContextGrowth,
  scoreSessionHealth,
} from './context-health';

function session(
  sessionId: string,
  model: string,
  peakContext: number
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: peakContext,
    totalOutputTokens: 100,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model,
    messageCount: 1,
    entries: [
      {
        timestamp: '2026-08-11T12:00:00.000Z',
        model,
        inputTokens: peakContext,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

describe('model-aware context health windows', () => {
  it('preserves the normal 200K score and reason bytes', () => {
    const row = session(
      'standard-window',
      'claude-haiku-4-5-20251001',
      150_000
    );

    expect(scoreSessionHealth([row])).toEqual([
      {
        sessionId: 'standard-window',
        score: 80,
        reasons: ['Peak context: 150k'],
      },
    ]);
    expect(computeContextGrowth([row])[0].contextWindow).toEqual({
      resolution: {
        kind: 'exact',
        contextWindowTokens: 200_000,
        source: 'registry',
      },
      usagePercent: 75,
    });
  });

  it('does not apply fixed 200K penalties to a 400K explicit 1M session', () => {
    const row = session(
      'long-window',
      'claude-haiku-4-5-20251001[1m]',
      400_000
    );

    expect(scoreSessionHealth([row])).toEqual([
      { sessionId: 'long-window', score: 100, reasons: [] },
    ]);
    expect(computeContextGrowth([row])[0].contextWindow).toEqual({
      resolution: {
        kind: 'exact',
        contextWindowTokens: 1_000_000,
        source: 'model-marker',
      },
      usagePercent: 40,
    });
  });

  it('scales the peak warning to half of the exact resolved window', () => {
    const row = session('long-window-warning', 'claude-opus-4-8', 600_000);

    expect(scoreSessionHealth([row])).toEqual([
      {
        sessionId: 'long-window-warning',
        score: 80,
        reasons: ['Peak context: 600k'],
      },
    ]);
  });

  it('carries lower-bound certainty without a percentage or threshold penalty', () => {
    const row = session(
      'above-known-window',
      'claude-opus-4-8[1m]',
      1_000_001
    );

    expect(scoreSessionHealth([row])).toEqual([
      { sessionId: 'above-known-window', score: 100, reasons: [] },
    ]);
    expect(computeContextGrowth([row])[0].contextWindow).toEqual({
      resolution: {
        kind: 'lower-bound',
        minimumContextWindowTokens: 1_000_001,
        source: 'observed',
      },
      usagePercent: null,
    });
  });

  it('keeps non-window penalties when window certainty is only a lower bound', () => {
    const row = session(
      'lower-bound-with-compaction',
      'claude-opus-4-8[1m]',
      1_000_001
    );
    row.totalCacheCreationTokens = 1_000;
    row.compactionEvents = [
      {
        timestamp: '2026-08-11T12:05:00.000Z',
        beforeContext: 1_000_001,
        afterContext: 200_000,
        reductionPercent: 80,
      },
    ];

    expect(scoreSessionHealth([row])).toEqual([
      {
        sessionId: 'lower-bound-with-compaction',
        score: 70,
        reasons: ['Low cache hit rate (0%)', '1 compaction'],
      },
    ]);
  });
});
