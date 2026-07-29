/**
 * Behavioral + provenance tests for context.over-window (#3185).
 *
 * The detector had no test file of its own: the sample-corpus sweep fired it,
 * but nothing pinned WHICH session its figures describe. The peak-citation test
 * below is the one that matters — `computeContextGrowth` sorts by growth RATE,
 * so the head of its list is not the highest peak, and a claim that names
 * "the highest observed peak" off `over[0]` is simply false.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './over-window';
import { validateRecommendationProvenance } from '../provenance';
import { OVER_WINDOW } from '../../context-health';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const entry = (timestamp: string, inputTokens: number) => ({
  timestamp,
  model: 'claude-sonnet-4-6',
  inputTokens,
  outputTokens: 500,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
});

/** A session whose single turn sits at `peak` tokens of context (growthRate 0). */
const flat = (sessionId: string, peak: number): SessionTokenData =>
  ({
    sessionId,
    totalOutputTokens: 500,
    entries: [entry('2026-06-09T12:00:00.000Z', peak)],
    compactionEvents: [],
  }) as unknown as SessionTokenData;

/** A session that CLIMBS to `peak` over an hour — a high growth rate. */
const climbing = (sessionId: string, peak: number): SessionTokenData =>
  ({
    sessionId,
    totalOutputTokens: 500,
    entries: [
      entry('2026-06-09T11:00:00.000Z', 1_000),
      entry('2026-06-09T12:00:00.000Z', peak),
    ],
    compactionEvents: [],
  }) as unknown as SessionTokenData;

const input = (tokenData: SessionTokenData[], claudeMd?: string): RecommendationInput => ({
  tokenData,
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: claudeMd
    ? ({ claudeMd: { global: claudeMd } } as unknown as RecommendationInput['liveConfig'])
    : null,
});

describe('context.over-window', () => {
  it('fires for a session peaking past the window', () => {
    const rec = detector.rule(input([flat('s1', OVER_WINDOW + 60_000)]), 0);
    expect(rec?.id).toBe('context.over-window');
    expect(rec?.affected).toBe(1);
  });

  it('stays silent at or below the window and when suppressed', () => {
    expect(detector.rule(input([flat('s1', OVER_WINDOW)]), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(
      detector.rule(
        input(
          [flat('s1', OVER_WINDOW + 60_000)],
          '## Context discipline\n\nKeep the working context well under the model\'s window.'
        ),
        0
      )
    ).toBeNull();
  });

  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input([flat('s1', OVER_WINDOW + 60_000)]), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('cites the true highest peak, not the head of the growth-sorted list', () => {
      // `climbing` has a huge growth RATE (1K -> 210K in an hour) so it sorts
      // first, but `flat` holds the higher PEAK. Reading the peak off the head
      // of the list would report 210,000 instead of 300,000.
      const rec = detector.rule(
        input([climbing('fast-growth', 210_000), flat('highest-peak', 300_000)]),
        0
      );
      expect(rec).not.toBeNull();
      const peakObs = rec!.provenance!.observations.find((o) =>
        o.claim.includes('highest observed peak')
      );
      expect(peakObs, 'expected an observation citing the highest peak').toBeDefined();
      expect(peakObs!.value).toBe(300_000);
      expect(peakObs!.field).toBe('peakContext');
      expect(peakObs!.claim).toContain('highest-');
    });

    it('reproduces the affected count from the cited field', () => {
      const cited = (td: SessionTokenData[]) =>
        detector.rule(input(td), 0)!.provenance!.observations[0].value;
      expect(cited([flat('a', 260_000), flat('b', 60_000)])).toBe(1);
      // Push the second session past the window and the cited count follows.
      expect(cited([flat('a', 260_000), flat('b', 260_000)])).toBe(2);
    });

    it('keeps the measured peak apart from the eviction cost it does not measure', () => {
      const rec = detector.rule(input([flat('s1', OVER_WINDOW + 60_000)]), 0);
      // The detail asserts eviction-and-re-send; the inference must say plainly
      // that the re-paid tokens were not measured (#3185).
      expect(rec!.provenance!.inference).toMatch(/not the tokens they re-paid/i);
    });
  });
});
