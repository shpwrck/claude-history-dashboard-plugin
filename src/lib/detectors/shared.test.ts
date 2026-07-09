import { describe, it, expect } from 'vitest';
import { automationCostShare, automationCostByClass } from './shared';
import { estimateCost } from '../parse-sessions';
import { CHEAPEST_MODEL } from '../pricing';
import type { SessionTokenData, TokenEntry } from '../../types';

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

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('automationCostByClass (#2139, epic #2138)', () => {
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
    // An interactive human session — must be excluded from the automation partition.
    session('human', 'cli', 'help me debug this', [
      entry('claude-opus-4-8', 4_000_000, 800_000),
    ]),
  ];

  it('routes each automation session into its opener-derived class', () => {
    const r = automationCostByClass(tokenData);
    expect(r.byClass.authoring.sessions).toBe(1);
    expect(r.byClass.mechanical.sessions).toBe(1);
    expect(r.byClass.review.sessions).toBe(1);
    // Interactive session excluded (3 unattended, not 4).
    expect(r.sessionIds).toHaveLength(3);
    expect(r.classes.map((c) => c.taskClass)).toEqual([
      'authoring',
      'mechanical',
      'review',
    ]);
  });

  it('per-class autoCost partitions automationCostShare().autoCost exactly', () => {
    const r = automationCostByClass(tokenData);
    const shareAutoCost = automationCostShare(tokenData).autoCost;
    // Grand total from the helper agrees with the #299 shared helper...
    expect(r.autoCost).toBeCloseTo(shareAutoCost, 10);
    // ...and the three class slices sum back to that grand total (the partition
    // invariant — nothing dropped, no new grand total).
    expect(sum(r.classes.map((c) => c.autoCost))).toBeCloseTo(shareAutoCost, 10);
    // Each class's autoCost equals the estimateCost of its own session.
    expect(r.byClass.authoring.autoCost).toBeCloseTo(estimateCost(tokenData[0]), 10);
    expect(r.byClass.mechanical.autoCost).toBeCloseTo(estimateCost(tokenData[1]), 10);
    expect(r.byClass.review.autoCost).toBeCloseTo(estimateCost(tokenData[2]), 10);
  });

  it('per-class swapSavings partitions the grand swapSavings exactly', () => {
    const r = automationCostByClass(tokenData);
    expect(r.swapSavings).toBeGreaterThan(0);
    expect(sum(r.classes.map((c) => c.swapSavings))).toBeCloseTo(r.swapSavings, 10);
    // Per-class sessions partition the total unattended session count.
    expect(sum(r.classes.map((c) => c.sessions))).toBe(r.sessionIds.length);
  });

  it('counts an already-cheap automation session but contributes $0 swap for it', () => {
    const cheap = [
      session('cheap', 'sdk-cli', 'route-loose classify', [
        entry(CHEAPEST_MODEL, 5_000_000, 1_000_000),
      ]),
    ];
    const r = automationCostByClass(cheap);
    expect(r.byClass.mechanical.sessions).toBe(1);
    expect(r.byClass.mechanical.autoCost).toBeGreaterThan(0);
    expect(r.swapSavings).toBe(0);
    expect(r.byClass.mechanical.swapSavings).toBe(0);
  });

  it('is empty for no automation sessions without dividing by anything', () => {
    const r = automationCostByClass([
      session('human', 'cli', 'do a thing', [entry('claude-opus-4-8', 1_000_000, 200_000)]),
    ]);
    expect(r.autoCost).toBe(0);
    expect(r.swapSavings).toBe(0);
    expect(r.sessionIds).toEqual([]);
    expect(sum(r.classes.map((c) => c.autoCost))).toBe(0);
  });
});
