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

  /**
   * CHANGED in #3193. This asserted `estSavingsUsd` was the FULL 1h write cost
   * whenever a session recorded zero cache reads of its own — i.e. it pinned
   * the defect: zero same-session reads was being exported as proof the entry
   * went unused and the whole write was recoverable. It establishes neither
   * (a later session may read the entry, and a shorter TTL avoids the rate
   * premium, not the write). The detector still surfaces the signal and the
   * observed spend; what it no longer does is book a recovered amount.
   */
  it('surfaces unread 1-hour writes as a candidate, without booking a saving', () => {
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
    // The measurement survives...
    expect(rec!.detail).toContain('$10.00 was 1-hour cache write spend');
    expect(rec!.evidence).toContain(
      'never-re: $10.00 1h cache writes, no cache reads'
    );
    // ...the counterfactual does not.
    expect(rec!.estSavingsUsd).toBeUndefined();
    // And the copy must not present the candidate as established waste.
    expect(rec!.detail).toContain('not a measured saving');
    expect(rec!.provenance?.inference).toContain('candidate signal only');
  });

  it('scopes the zero-read observation to the session that recorded it (#3193)', () => {
    const rec = detector.rule(
      input([
        session('never-read-session', [
          entry({ cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }),
        ]),
      ]),
      0
    );
    // A reader must not be able to take the zero for the entry's whole
    // lifetime — reuse by a LATER session is simply not observed here.
    const obs = rec!.provenance?.observations.find((o) =>
      o.field.includes('cacheCreation1hTokens')
    );
    expect(obs?.claim).toContain('WITHIN THAT SESSION');
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
