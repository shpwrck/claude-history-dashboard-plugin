import { describe, it, expect } from 'vitest';
import {
  detector,
  LAST_N_RUNS,
  MIN_BASELINE_RUNS,
  STALE_AFTER_DAYS,
} from './last-n-runs-audit';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const BASE = Date.parse('2026-05-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** One single-entry session whose peak context is `peak`, ending `dayOffset` days after BASE. */
function run(i: number, peak: number, dayOffset: number): SessionTokenData {
  const ts = new Date(BASE + dayOffset * DAY).toISOString();
  return {
    sessionId: `s${i}`,
    entrypoint: 'cli',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: peak,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [
      {
        timestamp: ts,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: peak,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

/** baseline runs (older) then window runs (newer), chronological. */
function dataset(baselinePeak: number, windowPeak: number, baselineN = MIN_BASELINE_RUNS): SessionTokenData[] {
  const baseline = Array.from({ length: baselineN }, (_, i) => run(i, baselinePeak, i));
  const window = Array.from({ length: LAST_N_RUNS }, (_, i) => run(baselineN + i, windowPeak, baselineN + i));
  return [...baseline, ...window];
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
  } as unknown as RecommendationInput;
}

const NOW_FRESH = BASE + (MIN_BASELINE_RUNS + LAST_N_RUNS) * DAY;

describe('context.last-n-runs-audit', () => {
  it('fires when the last N runs average materially more context than the baseline', () => {
    const rec = detector.rule(input(dataset(40_000, 80_000)), NOW_FRESH);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('context.last-n-runs-audit');
    expect(rec!.category).toBe('context');
    expect(rec!.severity).toBe('warning'); // 100% growth ≥ WARN_GROWTH_PCT
    expect(rec!.affected).toBe(LAST_N_RUNS);
    expect(rec!.detail).toContain('100%');
    expect(rec!.title).toContain('is trending up');
    expect(rec!.detail).toContain('average peak context is ');
    expect(rec!.evidence?.length).toBeGreaterThan(0);
  });

  it('emits contract-compliant provenance with an asOf date', () => {
    const rec = detector.rule(input(dataset(40_000, 80_000)), NOW_FRESH);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    const p = rec!.provenance!;
    expect(p.observations.length).toBeGreaterThan(0);
    for (const o of p.observations) expect(o.source).toBe('parse-sessions');
    expect(p.inference).toMatch(/%/);
    expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.stale).toBe(false);
  });

  it('stays silent when growth is below the threshold', () => {
    // 45k vs 40k baseline = 12.5% < 25%.
    expect(detector.rule(input(dataset(40_000, 45_000)), NOW_FRESH)).toBeNull();
  });

  it('stays silent below the absolute window-context noise floor', () => {
    // 100% growth but tiny absolute window mean (20k < 50k floor).
    expect(detector.rule(input(dataset(10_000, 20_000)), NOW_FRESH)).toBeNull();
  });

  it('stays silent without enough runs for a baseline', () => {
    // Only LAST_N_RUNS total — no baseline runs at all.
    const tokenData = Array.from({ length: LAST_N_RUNS }, (_, i) => run(i, 80_000, i));
    expect(detector.rule(input(tokenData), NOW_FRESH)).toBeNull();
  });

  it('demotes wording to "as of <date>" and marks provenance stale when the last run is old', () => {
    const data = dataset(40_000, 80_000);
    const lastTs = BASE + (MIN_BASELINE_RUNS + LAST_N_RUNS - 1) * DAY;
    const nowStale = lastTs + (STALE_AFTER_DAYS + 1) * DAY;
    const rec = detector.rule(input(data), nowStale);
    expect(rec).not.toBeNull();
    expect(rec!.title).toContain('was trending up');
    expect(rec!.detail).toMatch(/^As of \d{4}-\d{2}-\d{2},/);
    // No present-tense state assertion survives into the stale body.
    expect(rec!.detail).toContain('average peak context was ');
    expect(rec!.detail).not.toContain('average peak context is ');
    expect(rec!.provenance!.stale).toBe(true);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });
});
