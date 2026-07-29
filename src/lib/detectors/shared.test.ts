import { describe, it, expect } from 'vitest';
import {
  automationCostShare,
  automationCostByClass,
  newestIsoDate,
  newestEpochDate,
  newestTokenDataDate,
  buildWindowSumIndex,
  sumInWindow,
  type WindowSumIndex,
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

// ---------------------------------------------------------------------------
// Windowed prefix sums (#3235, #3238).
//
// Both consumers previously rescanned a session's whole token history for every
// span / interrupt — O(Q x T) to recompute a partition that does not depend on
// which query is asking. The complexity claim lives HERE, in the primitive, so
// this is where it is pinned deterministically: a Proxy over the sorted
// timestamp array counts element reads, so the assertions measure query work
// directly rather than wall-clock (which is host-sensitive and, with several
// burns sharing a host, unreliable as evidence).
// ---------------------------------------------------------------------------
describe('buildWindowSumIndex / sumInWindow (#3235, #3238)', () => {
  const row = (ms: number, a: number, b: number) => ({ ms, a, b });
  const build = (rows: { ms: number; a: number; b: number }[]) =>
    buildWindowSumIndex(rows, (r) => r.ms, (r) => [r.a, r.b], 2);

  /** Count indexed reads of the index's timestamp array. */
  function counting(index: WindowSumIndex, counter: { reads: number }): WindowSumIndex {
    return {
      ...index,
      ms: new Proxy(index.ms, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) counter.reads += 1;
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
  }

  it('answers a window query in logarithmic reads, not a linear scan', () => {
    const N = 100_000;
    const index = build(Array.from({ length: N }, (_, i) => row(i * 1000, 1, 2)));

    const counter = { reads: 0 };
    const out = sumInWindow(counting(index, counter), 25_000_000, 75_000_000, true);

    // Correctness first: entries 25,000..75,000 inclusive.
    expect(out).toEqual([50_001, 100_002]);
    // Two binary searches over 100,000 entries is ~2 x 17 reads. A linear scan
    // would read on the order of 100,000. Bound generously but far below linear.
    expect(counter.reads).toBeLessThan(80);
  });

  it('does not grow query reads as the corpus grows', () => {
    const readsFor = (n: number) => {
      const index = build(Array.from({ length: n }, (_, i) => row(i * 1000, 1, 0)));
      const counter = { reads: 0 };
      sumInWindow(counting(index, counter), 0, n * 1000, true);
      return counter.reads;
    };
    // 64x the corpus costs only a few more comparisons, not 64x the work.
    expect(readsFor(128_000) - readsFor(2_000)).toBeLessThan(20);
  });

  it('sorts unsorted input and drops non-finite timestamps', () => {
    const index = build([row(3000, 3, 0), row(1000, 1, 0), row(NaN, 99, 0), row(2000, 2, 0)]);
    expect(index.ms).toEqual([1000, 2000, 3000]);
    // The NaN row is gone, so it can never be summed into any window.
    expect(sumInWindow(index, 0, 10_000, true)).toEqual([6, 0]);
  });

  it('honors the lower-bound convention on both sides', () => {
    const index = build([row(100, 1, 0), row(200, 2, 0), row(300, 4, 0)]);
    // Inclusive lower (#3235 span windows): 100 and 200 both counted.
    expect(sumInWindow(index, 100, 200, true)).toEqual([3, 0]);
    // Exclusive lower (#3238 orphaned windows): the boundary row is NOT
    // re-counted, which is what stops two interrupts double-billing.
    expect(sumInWindow(index, 100, 200, false)).toEqual([2, 0]);
  });

  it('returns zeros for empty indexes, inverted windows, and non-finite bounds', () => {
    const empty = build([]);
    expect(sumInWindow(empty, 0, 100, true)).toEqual([0, 0]);
    const index = build([row(100, 1, 0)]);
    expect(sumInWindow(index, 200, 100, true)).toEqual([0, 0]);
    expect(sumInWindow(index, NaN, 100, true)).toEqual([0, 0]);
    expect(sumInWindow(index, 0, NaN, true)).toEqual([0, 0]);
  });
});
