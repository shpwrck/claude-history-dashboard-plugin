import { describe, it, expect } from 'vitest';
import { buildReclaimTrendline } from './reclaim-trendline';
import { scopeKeyOf, type ReclaimClaim } from './reclaim';
import type { Recommendation } from './detectors/types';
import type { SessionTokenData, TokenEntry } from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────
// Mirror reclaim.test.ts: Opus 4.7 input rate $5/MTok; reprice to Haiku ($1/MTok).
const entry = (over: Partial<TokenEntry> = {}): TokenEntry => ({
  timestamp: '2026-01-05T09:00:00.000Z', // ISO week starting Mon 2026-01-05
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model: 'claude-opus-4-7',
  ...over,
});

const session = (
  sessionId: string,
  model: string,
  entries: TokenEntry[]
): SessionTokenData =>
  ({
    sessionId,
    model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

const claim = (
  over: Partial<ReclaimClaim> & Pick<ReclaimClaim, 'leverId'>
): ReclaimClaim => ({
  category: 'cost',
  orderKey: 50,
  ownedPools: [],
  scopeKeys: [],
  counterfactual: { kind: 'flag-only' },
  evidenceTokens: 0,
  ...over,
});

const rec = (id: string, reclaim: ReclaimClaim): Recommendation =>
  ({
    id,
    category: 'cost',
    severity: 'info',
    title: id,
    detail: '',
    reclaim,
  }) as unknown as Recommendation;

describe('buildReclaimTrendline', () => {
  it('builds a two-line trendline per ISO week (baseline + baseline − reclaim)', () => {
    // Two ISO weeks of the SAME session+model: week A (Jan 5) 1M input, week B
    // (Jan 12) 2M input — both Opus ($5/MTok) repriced to Haiku ($1/MTok).
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ timestamp: '2026-01-06T09:00:00.000Z', inputTokens: 1_000_000 }),
        entry({ timestamp: '2026-01-13T09:00:00.000Z', inputTokens: 2_000_000 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.swap',
        claim({
          leverId: 'cost.swap',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
    ];

    const out = buildReclaimTrendline(recs, td);

    expect(out.points).toHaveLength(2);
    const [a, b] = out.points;
    expect(a.week).toBe('2026-01-05');
    expect(b.week).toBe('2026-01-12');

    // Week A: $5 actual → $1 after reclaim → $4 reclaim.
    expect(a.baseline).toBeCloseTo(5, 6);
    expect(a.afterReclaim).toBeCloseTo(1, 6);
    expect(a.reclaim).toBeCloseTo(4, 6);
    // Week B: $10 actual → $2 after reclaim → $8 reclaim. Slope is positive.
    expect(b.baseline).toBeCloseTo(10, 6);
    expect(b.afterReclaim).toBeCloseTo(2, 6);
    expect(b.reclaim).toBeCloseTo(8, 6);

    // The two series are distinct; afterReclaim is strictly below baseline.
    expect(a.afterReclaim).toBeLessThan(a.baseline);
    expect(b.afterReclaim).toBeLessThan(b.baseline);
  });

  it('computes an INDEPENDENT coverage gauge that is never multiplied into the trendline', () => {
    // One scope: 1M input (claimed) + 1M output (UNCLAIMED). Opus rates:
    // input $5, output $25 → bill $30. The reprice lever owns only `input`, so
    // its coverage cell-union is the $5 input cell → coverage 5/30 ≈ 0.1667.
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.swap',
        claim({
          leverId: 'cost.swap',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
    ];

    const out = buildReclaimTrendline(recs, td);

    // Gauge: claimed input cell ($5) over the $30 repriced bill.
    expect(out.gauge.totalBill).toBeCloseTo(30, 6);
    expect(out.gauge.claimedUsd).toBeCloseTo(5, 6);
    expect(out.gauge.coverage).toBeCloseTo(5 / 30, 6);

    // The trendline baseline is the FULL repriced bill ($30), NOT the bill
    // scaled by coverage. If the gauge were multiplied into the trendline the
    // baseline would be 30 * (5/30) = 5; assert it is the untouched $30.
    expect(out.points).toHaveLength(1);
    expect(out.points[0].baseline).toBeCloseTo(30, 6);
    expect(out.points[0].baseline).not.toBeCloseTo(
      out.gauge.coverage * out.points[0].baseline,
      6
    );

    // The reclaim on the input pool is $5 → $1 = $4, independent of coverage.
    expect(out.points[0].reclaim).toBeCloseTo(4, 6);
    expect(out.totalReclaim).toBeCloseTo(4, 6);
  });

  it('exposes a per-lever marginal breakdown sorted descending', () => {
    // Two disjoint scopes, two levers. Scope 1 input 1M ($5→$1=$4); scope 2
    // input 0.5M ($2.5→$0.5=$2). Levers must appear with their booked marginals.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })]),
      session('s2', 'claude-opus-4-7', [entry({ inputTokens: 500_000 })]),
    ];
    const recs = [
      rec(
        'cost.big',
        claim({
          leverId: 'cost.big',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
      rec(
        'cost.small',
        claim({
          leverId: 'cost.small',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s2', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
    ];

    const out = buildReclaimTrendline(recs, td);

    expect(out.levers.map((l) => l.leverId)).toEqual(['cost.big', 'cost.small']);
    expect(out.levers[0].marginalUsd).toBeCloseTo(4, 6);
    expect(out.levers[1].marginalUsd).toBeCloseTo(2, 6);
    // Descending by marginal.
    expect(out.levers[0].marginalUsd).toBeGreaterThanOrEqual(out.levers[1].marginalUsd);
  });

  it('is empty-safe: no points/levers and a zero gauge on empty data', () => {
    const out = buildReclaimTrendline([], []);
    expect(out.points).toHaveLength(0);
    expect(out.levers).toHaveLength(0);
    expect(out.totalReclaim).toBe(0);
    expect(out.gauge.totalBill).toBe(0);
    expect(out.gauge.claimedUsd).toBe(0);
    expect(out.gauge.coverage).toBe(0);
  });

  it('skips entries with an unparseable timestamp without throwing', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ timestamp: 'not-a-date', inputTokens: 1_000_000 }),
      ]),
    ];
    const out = buildReclaimTrendline([], td);
    // The undated entry produces no week point but still no crash.
    expect(out.points).toHaveLength(0);
  });
});
