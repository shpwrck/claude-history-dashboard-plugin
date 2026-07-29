import { describe, it, expect } from 'vitest';
import {
  automationCostShare,
  automationCostByClass,
  newestIsoDate,
  newestEpochDate,
  newestTokenDataDate,
} from './shared';
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

// ── asOf derivations (#3232) ────────────────────────────────────────────────

describe('newestIsoDate / newestEpochDate (#3232)', () => {
  it('takes the newest readable instant, regardless of input order', () => {
    expect(
      newestIsoDate([
        '2026-06-09T18:00:00.000Z',
        '2026-06-01T09:00:00.000Z',
        '2026-03-14T00:00:00.000Z',
      ])
    ).toBe('2026-06-09');
    expect(newestIsoDate(['2026-06-09'])).toBe('2026-06-09');
  });

  it('rejects strings Date.parse would silently COERCE into a date', () => {
    // `Date.parse` is a coercion, not a validity test, and every one of these
    // inventions formats as a well-formed YYYY-MM-DD that then sails through
    // the provenance calendar validator — dating a recommendation from a
    // string that never was a timestamp.
    expect(Date.parse('1')).not.toBeNaN(); // the hazard is real…
    expect(newestIsoDate(['1'])).toBeUndefined(); // …and refused here.
    expect(newestIsoDate(['12/25/2026'])).toBeUndefined();
    expect(newestIsoDate(['Jun 9 2026'])).toBeUndefined();
  });

  it('rejects an in-shape date that is not a real calendar day', () => {
    // 2026-02-30 parses and ROLLS OVER to Mar 2, so it only fails on the way
    // back; 2026 is not a leap year, but 2024 is.
    expect(newestIsoDate(['2026-02-30'])).toBeUndefined();
    expect(newestIsoDate(['2026-02-29T10:00:00.000Z'])).toBeUndefined();
    expect(newestIsoDate(['2024-02-29T10:00:00.000Z'])).toBe('2024-02-29');
    expect(newestIsoDate(['2026-06-09T25:00:00.000Z'])).toBeUndefined();
  });

  it('refuses a time without a zone (host-TZ dependent, so not reproducible)', () => {
    // `Date.parse('2026-06-09T23:30')` is read as HOST-LOCAL time, so the same
    // artifact resolves to a different instant — possibly a different calendar
    // DAY — depending on the machine's TZ. A provenance date that moves with
    // the server's timezone is not reproducible (Codex review, PR #3472).
    expect(Date.parse('2026-06-09T23:30')).not.toBeNaN(); // the hazard is real…
    expect(newestIsoDate(['2026-06-09T23:30'])).toBeUndefined(); // …and refused.
    expect(newestIsoDate(['2026-06-09T23:30:00'])).toBeUndefined();
    expect(newestIsoDate(['2026-06-09T23:30:00.000'])).toBeUndefined();
    // Zoned forms and the unambiguous date-only form are accepted.
    expect(newestIsoDate(['2026-06-09T23:30:00Z'])).toBe('2026-06-09');
    expect(newestIsoDate(['2026-06-09T23:30:00+02:00'])).toBe('2026-06-09');
    expect(newestIsoDate(['2026-06-09T23:30:00-0500'])).toBe('2026-06-10');
    expect(newestIsoDate(['2026-06-09'])).toBe('2026-06-09');
  });

  it('skips unreadable entries but still reports the readable ones', () => {
    expect(
      newestIsoDate(['not-a-date', null, undefined, '2026-06-09T12:00:00.000Z', '1'])
    ).toBe('2026-06-09');
    expect(newestIsoDate([])).toBeUndefined();
    expect(newestIsoDate(['not-a-date'])).toBeUndefined();
  });

  it('newestTokenDataDate inherits the same rule (one derivation, not two)', () => {
    const td = (timestamp: string) =>
      ({ sessionId: 's', entries: [{ timestamp }] }) as unknown as SessionTokenData;
    expect(newestTokenDataDate([td('2026-06-09T12:00:00.000Z')])).toBe('2026-06-09');
    expect(newestTokenDataDate([td('1')])).toBeUndefined();
    expect(newestTokenDataDate([])).toBeUndefined();
  });

  it('newestEpochDate takes the max epoch-ms and ignores unusable values', () => {
    const a = Date.parse('2026-06-01T00:00:00.000Z');
    const b = Date.parse('2026-06-09T23:59:00.000Z');
    expect(newestEpochDate([a, b])).toBe('2026-06-09');
    expect(newestEpochDate([b, a])).toBe('2026-06-09');
    expect(newestEpochDate([null, undefined, NaN, 0, a])).toBe('2026-06-01');
    // An out-of-range finite value must not WIN the max and then fail to
    // format — that would discard the valid date beside it (Codex review,
    // PR #3472). `parseWorkflowRun` takes startTime straight from a manifest.
    expect(newestEpochDate([b, 9e15])).toBe('2026-06-09');
    expect(newestEpochDate([9e15, b])).toBe('2026-06-09');
    expect(newestEpochDate([-1, b])).toBe('2026-06-09');
    expect(newestEpochDate([9e15])).toBeUndefined();
    // Beyond year 9999 `toISOString` switches to the expanded-year form and
    // slice(0,10) yields '+010000-01' — not a YYYY-MM-DD, so it would be
    // REJECTED by validateRecProvenance rather than merely mis-dated
    // (Codex review, PR #3472). Must be skipped, not selected.
    const Y10000 = Date.UTC(9999, 11, 31, 23, 59, 59, 999) + 1;
    expect(new Date(Y10000).toISOString().slice(0, 10)).toBe('+010000-01'); // the hazard
    expect(newestEpochDate([Y10000])).toBeUndefined();
    expect(newestEpochDate([b, Y10000])).toBe('2026-06-09');
    // …and the last four-digit-year instant is still accepted.
    expect(newestEpochDate([Date.UTC(9999, 11, 31, 23, 59, 59, 999)])).toBe('9999-12-31');
    expect(newestEpochDate([null, undefined, NaN, 0])).toBeUndefined();
    expect(newestEpochDate([])).toBeUndefined();
  });
});
