import { describe, it, expect } from 'vitest';
import { detector, DOWN_MODEL_PROOF_FRESHNESS_DAYS } from './automation-share';
import { automationCostShare } from '../shared';
import { CHEAPEST_MODEL } from '../../pricing';
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

describe('cost.automation-share per-class measured tier-1 before/after (#2140)', () => {
  // Mechanical automation migrated Opus -> Haiku in-window (an early Opus turn,
  // then two Haiku turns) — a real per-class before/after. Authoring stayed on
  // Opus the whole window, so it has no in-window model change to measure. Review
  // has no sessions at all.
  const tokenData = [
    session('mech-before', 'sdk-cli', 'route-loose classify picker', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-05-02T00:00:00.000Z'),
    ]),
    session('mech-after', 'sdk-cli', 'route-loose classify picker', [
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-09T00:00:00.000Z'),
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-10T00:00:00.000Z'),
    ]),
    session('auth-1', 'sdk-cli', 'coder: implement issue #2140', [
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-03T00:00:00.000Z'),
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-11T00:00:00.000Z'),
    ]),
  ];

  it('upgrades a class that migrated model in-window to a measured tier-1 result', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    const mech = by.mechanical.savingsAttribution;
    // The Opus -> Haiku migration is a genuine before/after, so it is measured.
    expect(mech?.tier).toBe('tier-1-before-after');
    expect(mech?.realizedSavingsUsd).toBeGreaterThan(0);
    // confidence is only present because a real before/after produced it.
    expect(mech?.confidence).toBe('medium');
    expect(mech?.signatureId).toBe('automation-model-pin.mechanical');
    expect(mech?.window?.baseline).toBeDefined();
    expect(mech?.window?.comparison).toBeDefined();
    // sampleSize reflects the priced turns behind the measurement (1 + 2).
    expect(mech?.sampleSize).toBe(3);
    // asOf is the class's freshest billable turn.
    expect(mech?.asOf).toBe('2026-05-10');
  });

  it('keeps a class with no in-window model change at tier-0-estimate (no fabricated confidence)', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // Authoring ran on Opus throughout — recoverable spend exists (swapSavings > 0)
    // but there is no before/after migration, so it stays an honest estimate.
    expect(by.authoring.swapSavingsUsd).toBeGreaterThan(0);
    const auth = by.authoring.savingsAttribution;
    expect(auth?.tier).toBe('tier-0-estimate');
    expect(auth?.realizedSavingsUsd).toBeUndefined();
    expect(auth?.confidence).toBeUndefined();
    expect(auth?.judgeAgreement).toBeUndefined();

    // A class with no automation at all is trivially estimate-only.
    const review = by.review.savingsAttribution;
    expect(review?.tier).toBe('tier-0-estimate');
    expect(review?.sampleSize).toBe(0);
    expect(review?.realizedSavingsUsd).toBeUndefined();
  });
});

describe('cost.automation-share stale down-model proof decay (#2142)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Same shape as the #2140 fixture: mechanical migrated Opus -> Haiku in-window
  // (asOf = its freshest turn, 2026-05-10), producing a MEASURED tier-1
  // before/after. Authoring stayed on Opus (honest tier-0 estimate).
  const tokenData = [
    session('mech-before', 'sdk-cli', 'route-loose classify picker', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-05-02T00:00:00.000Z'),
    ]),
    session('mech-after', 'sdk-cli', 'route-loose classify picker', [
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-09T00:00:00.000Z'),
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-10T00:00:00.000Z'),
    ]),
    session('auth-1', 'sdk-cli', 'coder: implement issue #2142', [
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-03T00:00:00.000Z'),
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-11T00:00:00.000Z'),
    ]),
  ];
  const asOfMs = Date.parse('2026-05-10T00:00:00.000Z');

  it('keeps a measured proof a live tier-1 claim when it is still fresh', () => {
    // now = 10 days after the proof's asOf — well inside the freshness window.
    const now = asOfMs + 10 * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const mech = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).mechanical.savingsAttribution;
    // A fresh before/after stays a present-tense confidence claim.
    expect(mech?.tier).toBe('tier-1-before-after');
    expect(mech?.confidence).toBe('medium');
    expect(mech?.realizedSavingsUsd).toBeGreaterThan(0);
    expect(mech?.stale).toBeFalsy();
    expect(mech?.asOf).toBe('2026-05-10');
  });

  it('demotes a measured proof past the freshness window to a dated estimate, not counted as current confidence', () => {
    // now = well past the 90-day freshness horizon, so a model generation has
    // shipped since the proof was observed.
    const now = asOfMs + (DOWN_MODEL_PROOF_FRESHNESS_DAYS + 24) * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const mech = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).mechanical.savingsAttribution;

    // Decayed back to a dated estimate: the measured-confidence fields are gone,
    // so it is NOT counted as current confidence (auditable-claims contract).
    expect(mech?.tier).toBe('tier-0-estimate');
    expect(mech?.stale).toBe(true);
    expect(mech?.confidence).toBeUndefined();
    expect(mech?.realizedSavingsUsd).toBeUndefined();
    expect(mech?.judgeAgreement).toBeUndefined();
    expect(mech?.window).toBeUndefined();
    // ...but the dated, auditable metadata survives so the reader still sees
    // "as of <date>" and the sample it rested on.
    expect(mech?.asOf).toBe('2026-05-10');
    expect(mech?.sampleSize).toBe(3);
    // The predicted figure is preserved (the measured comparison window here is
    // already the cheapest model, so its premium-above-cheapest is 0).
    expect(typeof mech?.predictedSavingsUsd).toBe('number');
    // The identity is preserved so the class still resolves to its intervention.
    expect(mech?.interventionKey).toBe('cost.automation-share');
    expect(mech?.signatureId).toBe('automation-model-pin.mechanical');
  });

  it('leaves an honest tier-0 estimate untouched even when its data is old', () => {
    // Authoring is already a tier-0 estimate (no in-window migration); a stale
    // asOf must not spuriously flag it — there is no measured claim to demote.
    const now = asOfMs + (DOWN_MODEL_PROOF_FRESHNESS_DAYS + 24) * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const auth = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).authoring.savingsAttribution;
    expect(auth?.tier).toBe('tier-0-estimate');
    expect(auth?.stale).toBeFalsy();
  });
});
