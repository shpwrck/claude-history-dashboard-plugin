import { describe, it, expect } from 'vitest';
import {
  buildReclaimTrendline,
  type ReclaimTrendlineWorkload,
} from './reclaim-trendline';
import { scopeKeyOf, type ReclaimClaim } from './reclaim';
import { serverToolCost } from './pricing';
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
    category: reclaim.category,
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

  it('preserves claim scope order when weekly token rows arrive reversed (#3164)', () => {
    const scopeA = scopeKeyOf('scope-a', 'claude-opus-4-7');
    const scopeB = scopeKeyOf('scope-b', 'claude-opus-4-7');
    // Both rows are in one week, but token-data order is deliberately the
    // reverse of the first claim's scope order. Each row has a $0.01 server fee.
    const td = [
      session('scope-b', 'claude-opus-4-7', [entry({ webSearchRequests: 1 })]),
      session('scope-a', 'claude-opus-4-7', [entry({ webSearchRequests: 1 })]),
    ];
    const recs = [
      rec(
        'cost.first',
        claim({
          leverId: 'cost.first',
          orderKey: 10,
          scopeKeys: [scopeA, scopeB],
          counterfactual: { kind: 'directUsd', usd: 0.01 },
        })
      ),
      rec(
        'cost.second',
        claim({
          leverId: 'cost.second',
          orderKey: 20,
          scopeKeys: [scopeA],
          counterfactual: { kind: 'directUsd', usd: 0.01 },
        })
      ),
    ];

    const out = buildReclaimTrendline(recs, td, () => {});

    expect(out.points).toHaveLength(1);
    expect(out.points[0].baseline).toBeCloseTo(0.02, 9);
    // Preserving [scopeA, scopeB] makes the first claim drain A, so the second
    // overlapping A-only claim rejects exactly as it does window-wide. Reversing
    // the scopes would drain B first and incorrectly book both claims ($0.02).
    expect(out.points[0].reclaim).toBeCloseTo(0.01, 9);
    expect(out.points[0].afterReclaim).toBeCloseTo(0.01, 9);
    expect(out.totalReclaim).toBeCloseTo(0.01, 9);
  });

  it('allocates a whole-window directUsd reclaim across every contributing week', () => {
    const model = 'claude-opus-4-7';
    const scopeA = scopeKeyOf('scope-a', model);
    const scopeB = scopeKeyOf('scope-b', model);
    const td = [
      session('scope-a', model, [
        entry({ timestamp: '2026-01-06T09:00:00.000Z', webSearchRequests: 1 }),
        entry({ timestamp: '2026-01-13T09:00:00.000Z', webSearchRequests: 1 }),
      ]),
      session('scope-b', model, [
        entry({ timestamp: '2026-01-06T10:00:00.000Z', webSearchRequests: 1 }),
        entry({ timestamp: '2026-01-13T10:00:00.000Z', webSearchRequests: 1 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.flat-reclaim',
        claim({
          leverId: 'cost.flat-reclaim',
          orderKey: 10,
          scopeKeys: [scopeA, scopeB],
          counterfactual: { kind: 'directUsd', usd: 0.03 },
        })
      ),
    ];
    const rejects: string[] = [];

    const out = buildReclaimTrendline(recs, td, (message) => rejects.push(message));

    expect(out.points).toHaveLength(2);
    expect(out.points.every((point) => point.reclaim > 0)).toBe(true);
    expect(out.points.reduce((sum, point) => sum + point.reclaim, 0)).toBeCloseTo(
      out.totalReclaim,
      9
    );
    expect(out.totalReclaim).toBeCloseTo(0.03, 9);
    expect(rejects.filter((message) => message.includes('exceeds server-fee residual'))).toEqual(
      []
    );
  });

  it('weights directUsd weekly allocation by each scope\'s observed server fees', () => {
    const model = 'claude-opus-4-7';
    const scopeA = scopeKeyOf('scope-a', model);
    const scopeB = scopeKeyOf('scope-b', model);
    const td = [
      session('scope-a', model, [
        entry({ timestamp: '2026-01-06T09:00:00.000Z', webSearchRequests: 1 }),
        entry({ timestamp: '2026-01-13T09:00:00.000Z', webSearchRequests: 3 }),
      ]),
      session('scope-b', model, [
        entry({ timestamp: '2026-01-06T10:00:00.000Z', webSearchRequests: 6 }),
        entry({ timestamp: '2026-01-13T10:00:00.000Z', webSearchRequests: 2 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.weighted-flat-reclaim',
        claim({
          leverId: 'cost.weighted-flat-reclaim',
          orderKey: 10,
          // Window-wide order drains all $0.04 from A, then $0.02 from B.
          scopeKeys: [scopeA, scopeB],
          counterfactual: { kind: 'directUsd', usd: 0.06 },
        })
      ),
    ];
    const rejects: string[] = [];

    const out = buildReclaimTrendline(recs, td, (message) => rejects.push(message));
    const canonicalServerUsd = td
      .flatMap((data) => data.entries)
      .reduce((sum, tokenEntry) => sum + serverToolCost(tokenEntry), 0);

    // A's $0.04 allocation splits $0.01/$0.03. B's $0.02 allocation splits
    // 6:2 ($0.015/$0.005), so the two weekly marginals are $0.025/$0.035.
    expect(out.points.map((point) => point.reclaim)).toEqual([
      expect.closeTo(0.025, 9),
      expect.closeTo(0.035, 9),
    ]);
    expect(out.points.reduce((sum, point) => sum + point.reclaim, 0)).toBeCloseTo(
      out.totalReclaim,
      9
    );
    // Whole-window matrix pricing and weekly slice pricing share the same
    // authoritative entry-fee helper, so a pricing-table change cannot make
    // the allocation weights drift from the residual they partition.
    expect(out.gauge.totalBill).toBeCloseTo(canonicalServerUsd, 9);
    expect(out.points.reduce((sum, point) => sum + point.baseline, 0)).toBeCloseTo(
      canonicalServerUsd,
      9
    );
    expect(rejects.filter((message) => message.includes('exceeds server-fee residual'))).toEqual(
      []
    );
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
    expect(out.rejections).toEqual([]);
  });

  it('collects guarded-marginal rejections only from the window-wide cascade run', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ timestamp: '2026-01-06T09:00:00.000Z', inputTokens: 1_000_000 }),
        entry({ timestamp: '2026-01-13T09:00:00.000Z', inputTokens: 2_000_000 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.ghost',
        claim({
          leverId: 'cost.ghost',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('missing-session', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
    ];
    const rawRejects: string[] = [];

    const out = buildReclaimTrendline(recs, td, (msg) => rawRejects.push(msg));

    expect(out.points).toHaveLength(2);
    // The scope index excludes the ghost claim from both weekly cascades, so
    // diagnostics are emitted once by the authoritative window-wide run rather
    // than repeated once per visible week.
    expect(rawRejects).toHaveLength(1);
    expect(out.rejections).toEqual([
      {
        leverId: 'cost.ghost',
        reason: 'claim resolves to no priced scope (precondition)',
      },
    ]);
  });

  it('breaks coverage out per detector category', () => {
    // One session, two disjoint dollar-opinion cells:
    // - cost owns the output pool ($25)
    // - context owns the input pool ($5) as a flag-only advisory claim
    // The category rows should make the coverage gap legible.
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.output-swap',
        claim({
          leverId: 'cost.output-swap',
          category: 'cost',
          orderKey: 80,
          ownedPools: ['output'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        })
      ),
      rec(
        'context.input-note',
        claim({
          leverId: 'context.input-note',
          category: 'context',
          orderKey: 40,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'flag-only' },
        })
      ),
    ];

    const out = buildReclaimTrendline(recs, td);
    const byCategory = new Map(
      out.byCategory.map((row) => [row.category, row])
    );
    const cost = byCategory.get('cost');
    const context = byCategory.get('context');

    expect(out.byCategory.map((row) => row.category)).toEqual([
      'cost',
      'context',
    ]);
    expect(cost).toBeDefined();
    expect(context).toBeDefined();
    expect(cost!.claimedUsd).toBeCloseTo(25, 6);
    expect(context!.claimedUsd).toBeCloseTo(5, 6);
    expect(cost!.coverage).toBeCloseTo(25 / 30, 6);
    expect(context!.coverage).toBeCloseTo(5 / 30, 6);
    expect(context!.coverage).toBeLessThan(cost!.coverage);
    for (const row of out.byCategory) {
      expect(row.coverage).toBeGreaterThanOrEqual(0);
      expect(row.coverage).toBeLessThanOrEqual(1);
    }
    expect(out.gauge.claimedUsd).toBeCloseTo(
      cost!.claimedUsd + context!.claimedUsd,
      6
    );
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
    expect(out.byCategory).toEqual([]);
    expect(out.rejections).toEqual([]);
  });

  it('skips entries with an unparseable timestamp without throwing', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ timestamp: 'not-a-date', inputTokens: 1_000_000 }),
      ]),
    ];
    const recs = [
      rec(
        'cost.undated',
        claim({
          leverId: 'cost.undated',
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        })
      ),
    ];
    let workload: ReclaimTrendlineWorkload | undefined;
    const out = buildReclaimTrendline(recs, td, () => {}, (sample) => {
      workload = sample;
    });
    // The undated entry produces no week point but still no crash.
    expect(out.points).toHaveLength(0);
    // perf-index-contract: reclaim-claim-scope-index non-querying
    expect(workload?.claimIndexBuilds).toBe(0);
  });

  it('keeps a representative 52-week window within its claim-work and latency budgets (#3164)', () => {
    const weekCount = 52;
    const claimsPerWeek = 20;
    const monday = Date.parse('2026-01-05T09:00:00.000Z');
    const td: SessionTokenData[] = [];
    const recs: Recommendation[] = [];
    for (let week = 0; week < weekCount; week += 1) {
      const timestamp = new Date(monday + week * 7 * 24 * 60 * 60 * 1000).toISOString();
      for (let index = 0; index < claimsPerWeek; index += 1) {
        const sessionId = `week-${week}-session-${index}`;
        const scopeKey = scopeKeyOf(sessionId, 'claude-opus-4-7');
        td.push(
          session(sessionId, 'claude-opus-4-7', [
            entry({ timestamp, inputTokens: 10_000 }),
          ])
        );
        recs.push(
          rec(
            `cost.week-${week}-${index}`,
            claim({
              leverId: `cost.week-${week}-${index}`,
              ownedPools: ['input'],
              scopeKeys: [scopeKey],
              counterfactual: {
                kind: 'reprice',
                toModel: 'claude-haiku-4-5-20251001',
              },
            })
          )
        );
      }
    }

    let workload: ReclaimTrendlineWorkload | undefined;
    const started = performance.now();
    const out = buildReclaimTrendline(recs, td, () => {}, (sample) => {
      workload = sample;
    });
    const elapsedMs = performance.now() - started;

    expect(out.points).toHaveLength(weekCount);
    expect(workload).toEqual({
      weeks: weekCount,
      claims: weekCount * claimsPerWeek,
      weeklyClaimInputs: weekCount * claimsPerWeek,
      exhaustiveWeeklyClaimInputs: weekCount * weekCount * claimsPerWeek,
      weeklyScopeKeys: weekCount * claimsPerWeek,
      claimIndexBuilds: 1,
    });
    // A deliberately generous CI ceiling: the fixture is 1,040 scoped claims
    // across a full year. The allocation budget above is the primary invariant;
    // this catches accidental multi-second regressions without timing noise.
    expect(elapsedMs).toBeLessThan(750);
  });
});

// ---------------------------------------------------------------------------
// The gauge is a UNION, not a sum (#3163)
// ---------------------------------------------------------------------------

describe('coverage gauge across overlapping categories (#3163)', () => {
  // One $5 cell (1M Opus input @ $5/MTok) inside a $30 bill (the other $25 is
  // output, which nothing addresses).
  const td = [
    session('s1', 'claude-opus-4-7', [
      entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ]),
  ];
  const scope = scopeKeyOf('s1', 'claude-opus-4-7');

  it('counts a cell addressed by two categories once', () => {
    // cost and context both pin the SAME (scope, input) cell.
    const out = buildReclaimTrendline(
      [
        rec(
          'cost.pins-input',
          claim({ leverId: 'cost.pins-input', category: 'cost', ownedPools: ['input'], scopeKeys: [scope] })
        ),
        rec(
          'context.pins-input',
          claim({
            leverId: 'context.pins-input',
            category: 'context',
            orderKey: 40,
            ownedPools: ['input'],
            scopeKeys: [scope],
          })
        ),
      ],
      td
    );

    // The regression: summing the two category totals reported $10 of the $5
    // cell — double the cell's own price — and inflated coverage to match.
    expect(out.gauge.claimedUsd).toBeCloseTo(5, 9);
    expect(out.gauge.coverage).toBeCloseTo(5 / out.gauge.totalBill, 9);

    // ...while each category legitimately shows the full cell it addresses.
    const byCat = new Map(out.byCategory.map((c) => [c.category, c.claimedUsd]));
    expect(byCat.get('cost')).toBeCloseTo(5, 9);
    expect(byCat.get('context')).toBeCloseTo(5, 9);
    // Which is exactly why the sum (10) is not the union (5).
    expect((byCat.get('cost') ?? 0) + (byCat.get('context') ?? 0)).toBeCloseTo(10, 9);
  });

  it('still adds disjoint cells from different categories', () => {
    const out = buildReclaimTrendline(
      [
        rec(
          'cost.pins-input',
          claim({ leverId: 'cost.pins-input', category: 'cost', ownedPools: ['input'], scopeKeys: [scope] })
        ),
        rec(
          'context.pins-output',
          claim({
            leverId: 'context.pins-output',
            category: 'context',
            orderKey: 40,
            ownedPools: ['output'],
            scopeKeys: [scope],
          })
        ),
      ],
      td
    );
    // Disjoint cells: $5 input + $25 output = the whole bill.
    expect(out.gauge.claimedUsd).toBeCloseTo(out.gauge.totalBill, 9);
    expect(out.gauge.coverage).toBeCloseTo(1, 9);
  });

  it('never reports coverage above 1', () => {
    const out = buildReclaimTrendline(
      ['a', 'b', 'c', 'd'].map((n) =>
        rec(
          `cost.${n}`,
          claim({ leverId: `cost.${n}`, category: 'cost', ownedPools: ['input'], scopeKeys: [scope] })
        )
      ),
      td
    );
    expect(out.gauge.coverage).toBeLessThanOrEqual(1);
    expect(out.gauge.claimedUsd).toBeCloseTo(5, 9);
  });
});
