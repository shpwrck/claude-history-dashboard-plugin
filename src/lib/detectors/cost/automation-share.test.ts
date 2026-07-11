import { describe, it, expect } from 'vitest';
import { detector } from './automation-share';
import { automationCostShare } from '../shared';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, TokenEntry } from '../../../types';

const entry = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp = 't'
): TokenEntry => ({
  timestamp,
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model,
});

const session = (
  sessionId: string,
  entrypoint: string | undefined,
  opener: string | undefined,
  entries: TokenEntry[]
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    opener,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('cost.automation-share task-class breakdown (#2139, epic #2138)', () => {
  // Three automation sessions, one per class, sized so the rec fires
  // (autoCost >= $1, share >= 15%; all sessions are sdk-* so share = 100%).
  const tokenData = [
    session('author', 'sdk-cli', 'coder: implement issue #2139', [
      entry('claude-opus-4-8', 5_000_000, 1_000_000),
    ]),
    session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
      entry('claude-opus-4-8', 3_000_000, 600_000),
    ]),
    session('rev', 'sdk-py', 'reviewer: review and merge the open PRs', [
      entry('claude-opus-4-8', 2_000_000, 400_000),
    ]),
  ];

  it('emits a three-class breakdown in stable order', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.id).toBe('cost.automation-share');
    expect(rec?.taskClassBreakdown).toBeDefined();
    expect(rec?.taskClassBreakdown?.map((c) => c.taskClass)).toEqual([
      'authoring',
      'mechanical',
      'review',
    ]);
    // Each session landed in its opener-derived class.
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    expect(by.authoring.sessions).toBe(1);
    expect(by.mechanical.sessions).toBe(1);
    expect(by.review.sessions).toBe(1);
  });

  it('per-class actual cost sums to the card autoCost total exactly (the partition invariant)', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const { autoCost } = automationCostShare(tokenData);
    const perClassAutoCost = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.autoCostUsd)
    );
    expect(perClassAutoCost).toBeCloseTo(autoCost, 10);
  });

  it('per-class swap savings sums to the card swapSavings total exactly', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    // The card's ranking dollar weight IS the swapSavings total.
    const swapSavings = rec?.estSavingsUsd ?? 0;
    expect(swapSavings).toBeGreaterThan(0);
    const perClassSwap = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.swapSavingsUsd)
    );
    expect(perClassSwap).toBeCloseTo(swapSavings, 10);
  });

  it('per-class sessions sum to affected, so no session is dropped', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const perClassSessions = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.sessions)
    );
    expect(perClassSessions).toBe(rec?.affected);
    expect(perClassSessions).toBe(3);
  });

  it('names the per-class split in the human-readable detail', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.detail).toContain('By task class');
    expect(rec?.detail).toMatch(/mechanical/);
    expect(rec?.detail).toMatch(/authoring/);
  });
});

describe('cost.automation-share per-class down-model confidence (#2141)', () => {
  // Two dated authoring turns and one mechanical turn, so sample size and asOf
  // are per-class distinguishable.
  const tokenData = [
    session('author', 'sdk-cli', 'coder: implement issue #2141', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-06-01T00:00:00.000Z'),
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-06-03T00:00:00.000Z'),
    ]),
    session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
      entry('claude-opus-4-8', 2_000_000, 400_000, '2026-06-02T00:00:00.000Z'),
    ]),
  ];

  it('attaches an estimate-tier attribution to every class, with no fabricated confidence', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const breakdown = rec?.taskClassBreakdown ?? [];
    expect(breakdown.length).toBe(3);
    for (const c of breakdown) {
      const attr = c.savingsAttribution;
      expect(attr).toBeDefined();
      // Pure token accounting: every class is honestly tier-0-estimate.
      expect(attr?.tier).toBe('tier-0-estimate');
      // No before/after or ablation exists per class, so nothing is fabricated.
      expect(attr?.confidence).toBeUndefined();
      expect(attr?.judgeAgreement).toBeUndefined();
      expect(attr?.realizedSavingsUsd).toBeUndefined();
      expect(attr?.interventionKey).toBe('cost.automation-share');
      expect(attr?.signatureId).toBe(`automation-model-pin.${c.taskClass}`);
      expect(attr?.predictedSavingsUsd).toBeCloseTo(c.swapSavingsUsd, 10);
    }
  });

  it('reports the per-class sample size (billable turns) as n', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // authoring saw two billable turns, mechanical one; review saw none.
    expect(by.authoring.savingsAttribution?.sampleSize).toBe(2);
    expect(by.mechanical.savingsAttribution?.sampleSize).toBe(1);
    expect(by.review.savingsAttribution?.sampleSize).toBe(0);
  });

  it('surfaces the freshest billable turn as an ISO asOf date, omitting it for empty classes', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // authoring's freshest turn is 2026-06-03; mechanical's is 2026-06-02.
    expect(by.authoring.savingsAttribution?.asOf).toBe('2026-06-03');
    expect(by.mechanical.savingsAttribution?.asOf).toBe('2026-06-02');
    // A class with no billable turn has no dated data, so asOf is absent.
    expect(by.review.savingsAttribution?.asOf).toBeUndefined();
  });
});
