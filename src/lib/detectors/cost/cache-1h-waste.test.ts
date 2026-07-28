/**
 * cost.cache-1h-waste — the rate premium is measured, its recoverable fraction
 * is not (#3192).
 *
 * This detector had no test file of its own. The change it now carries is a
 * claim demotion, so it needs one: the arithmetic must survive and the booking
 * must not.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './cache-1h-waste';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import { runReclaimCascade } from '../../reclaim';

const session = (sessionId: string, cache1hTokens: number): SessionTokenData =>
  ({
    sessionId,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: cache1hTokens,
        cacheCreation1hTokens: cache1hTokens,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  }) as unknown as SessionTokenData;

const input = (tokenData: SessionTokenData[]): RecommendationInput => ({
  tokenData, toolData: [], sessions: [], projects: [], permissionRows: [],
  apiErrors: [], liveConfig: null,
});

describe('cost.cache-1h-waste (#3192)', () => {
  it('reports the measured rate premium', () => {
    const rec = detector.rule(input([session('s1', 4_000_000)]), 0);
    expect(rec?.id).toBe('cost.cache-1h-waste');
    // Arithmetic on observed tokens at two published rates — a real
    // measurement, and it survives the demotion.
    expect(rec?.detail).toContain('a rate premium of');
    expect(rec?.detail).toContain('4.00M tokens');
  });

  it('books no saving, because reuse timing is not recorded anywhere', () => {
    const rec = detector.rule(input([session('s1', 4_000_000)]), 0);
    // Previously: estSavingsUsd = the full 1h→5m delta on EVERY 1h write, and
    // a convertRate reclaim re-billing the whole pool at the 5m rate. Both
    // assert the context was not reused past five minutes; the loop reads only
    // token counters and no reuse-timing field exists.
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim?.counterfactual.kind).toBe('flag-only');
    expect(rec?.reclaim?.ownedPools).toEqual([]);
  });

  it('moves no money through the cascade', () => {
    const td = [session('s1', 4_000_000)];
    const rec = detector.rule(input(td), 0);
    const result = runReclaimCascade([rec!.reclaim!], td);
    expect(result.total).toBe(0);
    expect(result.billFinal).toBeCloseTo(result.billOriginal, 9);
  });

  it('states the dependency on reuse timing instead of assuming it', () => {
    const rec = detector.rule(input([session('s1', 4_000_000)]), 0);
    expect(rec?.action).toMatch(/reuse timing, which is not recorded/i);
    expect(rec?.action).toMatch(/none of it is counted as recovered/i);
  });

  it('stays dark below the materiality floor', () => {
    expect(detector.rule(input([session('s1', 100)]), 0)).toBeNull();
  });
});
