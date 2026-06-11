import { describe, expect, it } from 'vitest';
import { detector } from './cache-economics';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, TokenEntry } from '../../../types';

function entry(
  overrides: Partial<TokenEntry> = {}
): TokenEntry {
  return {
    timestamp: '2026-06-01T00:00:00Z',
    model: 'claude-opus-4-8',
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...overrides,
  };
}

function session(sessionId: string, entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((sum, e) => sum + e.inputTokens, 0),
    totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
    totalCacheCreationTokens: entries.reduce(
      (sum, e) => sum + e.cacheCreationTokens,
      0
    ),
    totalCacheReadTokens: entries.reduce((sum, e) => sum + e.cacheReadTokens, 0),
    model: entries[0]?.model ?? 'claude-opus-4-8',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

function input(tokenData: SessionTokenData[]): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  };
}

describe('cost.cache-economics', () => {
  it('emits a deterministic re-sent-vs-novel context cost split', () => {
    const rec = detector.rule(
      input([
        session('cache-reader-session', [
          entry({
            inputTokens: 1_000_000,
            cacheCreationTokens: 2_000_000,
            cacheReadTokens: 3_000_000,
          }),
        ]),
      ]),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('cost.cache-economics');
    expect(rec!.detail).toContain('$1.50 of context spend');
    expect(rec!.detail).toContain('$17.50 was novel context');
    expect(rec!.detail).toContain('dead-token tranche is not claimed');
    expect(rec!.provenance?.observations[0].field).toBe(
      'TokenEntry.cacheReadTokens'
    );
  });

  it('flags 1-hour cache writes with no same-session cache reads as concrete waste', () => {
    const rec = detector.rule(
      input([
        session('never-read-session', [
          entry({
            cacheCreationTokens: 1_000_000,
            cacheCreation1hTokens: 1_000_000,
          }),
        ]),
      ]),
      0
    );

    expect(rec).not.toBeNull();
    expect(rec!.estSavingsUsd).toBeCloseTo(10, 9);
    expect(rec!.detail).toContain('$10.00 was 1-hour cache write spend');
    expect(rec!.evidence).toContain(
      'never-re: $10.00 1h cache writes, no cache reads'
    );
  });

  it('stays dark when there is no cache-read spend and no unread 1h write', () => {
    const rec = detector.rule(
      input([
        session('plain-input-session', [entry({ inputTokens: 100_000 })]),
      ]),
      0
    );
    expect(rec).toBeNull();
  });
});
