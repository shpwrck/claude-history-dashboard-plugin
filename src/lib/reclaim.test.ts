import { describe, it, expect } from 'vitest';
import {
  runReclaimCascade,
  rollupCascade,
  scopeKeyOf,
  DEFAULT_CAUSE,
  type ReclaimClaim,
} from './reclaim';
import type { SessionTokenData, TokenEntry } from '../types';

// ── Fixtures ─────────────────────────────────────────────────────────────
const entry = (over: Partial<TokenEntry> = {}): TokenEntry => ({
  timestamp: 't',
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

const claim = (over: Partial<ReclaimClaim> & Pick<ReclaimClaim, 'leverId'>): ReclaimClaim => ({
  category: 'cost',
  orderKey: 50,
  ownedPools: [],
  scopeKeys: [],
  counterfactual: { kind: 'flag-only' },
  evidenceTokens: 0,
  ...over,
});

// Opus 4.7 rates (per pricing.ts tier(5)): input $5, output $25, cacheWrite5m
// $6.25, cacheWrite1h $10, cacheRead $0.50 (all per MTok). Haiku 4.5 tier(1):
// input $1, output $5, cacheWrite5m $1.25, cacheWrite1h $2, cacheRead $0.10.

describe('runReclaimCascade — guarded-marginal identity', () => {
  it('books a single reprice claim and satisfies sum(marginal) ≡ billOriginal − billFinal', () => {
    // 1M input tokens on Opus 4.7 ($5) repriced to Haiku ($1) ⇒ drop $4.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const claims = [
      claim({
        leverId: 'cost.swap',
        orderKey: 80,
        ownedPools: ['input'],
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
      }),
    ];
    const r = runReclaimCascade(claims, td);
    expect(r.billOriginal).toBeCloseTo(5, 9);
    expect(r.billFinal).toBeCloseTo(1, 9);
    expect(r.total).toBeCloseTo(4, 9);
    const summed = r.booked.reduce((s, b) => s + b.marginalUsd, 0);
    expect(summed).toBeCloseTo(r.billOriginal - r.billFinal, 9);
    expect(r.booked[0].marginalUsd).toBeCloseTo(4, 9);
  });

  it('overlapping levers carve DISJOINT slices — no double counting', () => {
    // One scope, 1M input on Opus. Two levers both reprice the SAME input pool:
    // A → Sonnet ($3), B → Haiku ($1). Cause-order: A first (drop $5→$3 = $2),
    // then B sees the $3 residual and drops it to $1 = $2 more. Total $4, NOT $6.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const A = claim({
      leverId: 'cost.a',
      orderKey: 10,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' },
    });
    const B = claim({
      leverId: 'cost.b',
      orderKey: 20,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
    });
    const r = runReclaimCascade([A, B], td);
    expect(r.total).toBeCloseTo(4, 9); // 5 → 1, not 5 + 5 - 6
    const a = r.booked.find((b) => b.leverId === 'cost.a')!;
    const b = r.booked.find((b) => b.leverId === 'cost.b')!;
    expect(a.marginalUsd).toBeCloseTo(2, 9);
    expect(b.marginalUsd).toBeCloseTo(2, 9);
    expect(a.marginalUsd + b.marginalUsd).toBeCloseTo(r.total, 9);
  });

  it('identity holds under MULTIPLE orderings (order changes only the split)', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const mk = (kA: number, kB: number) => [
      claim({
        leverId: 'cost.a',
        orderKey: kA,
        ownedPools: ['input'],
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' },
      }),
      claim({
        leverId: 'cost.b',
        orderKey: kB,
        ownedPools: ['input'],
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
      }),
    ];
    const fwd = runReclaimCascade(mk(10, 20), td);
    const rev = runReclaimCascade(mk(20, 10), td);
    // Total invariant under reordering …
    expect(fwd.total).toBeCloseTo(rev.total, 9);
    expect(fwd.total).toBeCloseTo(4, 9);
    // … and each run's per-lever marginals still sum to billOriginal − billFinal.
    for (const r of [fwd, rev]) {
      const summed = r.booked.reduce((s, b) => s + b.marginalUsd, 0);
      expect(summed).toBeCloseTo(r.billOriginal - r.billFinal, 9);
    }
    // The SPLIT differs: whichever reprice runs first against the larger residual
    // books the larger slice (Sonnet-first books $2/$2; Haiku-first books $4/$0).
    const haikuFirst = rev.booked.find((b) => b.leverId === 'cost.b')!;
    expect(haikuFirst.marginalUsd).toBeCloseTo(4, 9);
  });

  it('convertRate re-bills 1h cache writes at the 5-minute rate', () => {
    // 1M 1h-cache-write tokens on Opus: cacheWrite1h $10, cacheWrite5m $6.25 ⇒ $3.75.
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }),
      ]),
    ];
    const c = claim({
      leverId: 'cost.cache-1h-waste',
      orderKey: 50,
      ownedPools: ['cacheWrite1h'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'convertRate', rateFrom: 'cacheWrite1h', rateTo: 'cacheWrite5m' },
    });
    const r = runReclaimCascade([c], td);
    expect(r.total).toBeCloseTo(3.75, 9);
    expect(r.booked[0].marginalUsd).toBeCloseTo(3.75, 9);
  });

  it('scaleTokens deletes a pool fraction and its whole cost', () => {
    // Delete 50% of a 1M output pool on Opus ($25/MTok) ⇒ $12.50.
    const td = [session('s1', 'claude-opus-4-7', [entry({ outputTokens: 1_000_000 })])];
    const c = claim({
      leverId: 'cost.trim',
      orderKey: 40,
      ownedPools: ['output'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: 0.5 } },
    });
    const r = runReclaimCascade([c], td);
    expect(r.total).toBeCloseTo(12.5, 9);
  });

  it('directUsd books a flat server fee and cannot exceed the server residual', () => {
    // 100 web searches @ $0.01 = $1 server fee. A $1 directUsd claim books fully;
    // an over-large claim is rejected (residual ≥ 0), not clamped.
    const td = [session('s1', 'claude-opus-4-7', [entry({ webSearchRequests: 100 })])];
    const ok = runReclaimCascade(
      [
        claim({
          leverId: 'cost.web-search-spend',
          orderKey: 60,
          ownedPools: [],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'directUsd', usd: 1 },
        }),
      ],
      td
    );
    expect(ok.total).toBeCloseTo(1, 9);
    expect(ok.booked[0].marginalUsd).toBeCloseTo(1, 9);

    const rejects: string[] = [];
    const over = runReclaimCascade(
      [
        claim({
          leverId: 'cost.web-search-spend',
          orderKey: 60,
          ownedPools: [],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'directUsd', usd: 5 }, // > $1 available
        }),
      ],
      td,
      (m) => rejects.push(m)
    );
    expect(over.booked[0].rejected).toBe(true);
    expect(over.total).toBeCloseTo(0, 9);
    expect(rejects.join(' ')).toMatch(/exceeds server-fee residual/);
  });

  // ── Malformed numeric counterfactuals (#3165) ─────────────────────────────
  describe('rejects malformed numeric counterfactuals without mutation (#3165)', () => {
    const key = scopeKeyOf('s1', 'claude-opus-4-7');
    // Assert every dollar the cascade exposes stays finite and non-negative.
    const assertClean = (r: ReturnType<typeof runReclaimCascade>): void => {
      for (const v of [r.billOriginal, r.billFinal, r.total]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      for (const b of r.booked) {
        expect(Number.isFinite(b.marginalUsd)).toBe(true);
        expect(b.marginalUsd).toBeGreaterThanOrEqual(0);
      }
      for (const v of Object.values(r.byCategory)) {
        expect(Number.isFinite(v as number)).toBe(true);
        expect(v as number).toBeGreaterThanOrEqual(0);
      }
    };

    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects a %s directUsd, leaving the $1 residual untouched', (_label, usd) => {
      // 100 web searches @ $0.01 = $1 server residual.
      const td = [session('s1', 'claude-opus-4-7', [entry({ webSearchRequests: 100 })])];
      const rejects: string[] = [];
      const r = runReclaimCascade(
        [
          claim({
            leverId: 'cost.web-search-spend',
            orderKey: 60,
            ownedPools: [],
            scopeKeys: [key],
            counterfactual: { kind: 'directUsd', usd },
          }),
        ],
        td,
        (m) => rejects.push(m)
      );
      expect(r.booked[0].rejected).toBe(true);
      expect(r.total).toBeCloseTo(0, 9);
      // Residual is NOT increased by a negative reclaim — billFinal stays at the
      // original $1 server fee.
      expect(r.billFinal).toBeCloseTo(r.billOriginal, 9);
      expect(rejects.join(' ')).toMatch(/directUsd must be a finite non-negative/);
      assertClean(r);
    });

    it.each([
      ['negative', -0.5],
      ['greater than one', 2],
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
    ])('rejects a %s scaleTokens fraction, committing no NaN/negative cost', (_label, frac) => {
      // 1M output tokens on Opus ($25/MTok).
      const td = [session('s1', 'claude-opus-4-7', [entry({ outputTokens: 1_000_000 })])];
      const rejects: string[] = [];
      const r = runReclaimCascade(
        [
          claim({
            leverId: 'cost.trim',
            orderKey: 40,
            ownedPools: ['output'],
            scopeKeys: [key],
            counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: frac } },
          }),
        ],
        td,
        (m) => rejects.push(m)
      );
      expect(r.booked[0].rejected).toBe(true);
      expect(r.total).toBeCloseTo(0, 9);
      expect(r.billFinal).toBeCloseTo(r.billOriginal, 9);
      expect(rejects.join(' ')).toMatch(/scaleTokens fraction for output must be finite within \[0,1\]/);
      assertClean(r);
    });

    it('still books a well-formed scaleTokens fraction alongside the guard', () => {
      // Sanity: the guard does not reject a legitimate in-range fraction.
      const td = [session('s1', 'claude-opus-4-7', [entry({ outputTokens: 1_000_000 })])];
      const r = runReclaimCascade(
        [
          claim({
            leverId: 'cost.trim',
            orderKey: 40,
            ownedPools: ['output'],
            scopeKeys: [key],
            counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: 0.5 } },
          }),
        ],
        td
      );
      expect(r.booked[0].rejected).toBe(false);
      expect(r.total).toBeCloseTo(12.5, 9);
      assertClean(r);
    });
  });

  it('rejects a claim whose scopeKey resolves to no priced entry-group', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const rejects: string[] = [];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.ghost',
          orderKey: 50,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('does-not-exist', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td,
      (m) => rejects.push(m)
    );
    expect(r.booked[0].rejected).toBe(true);
    expect(r.total).toBeCloseTo(0, 9);
    expect(rejects.join(' ')).toMatch(/no priced scope/);
  });

  it('flag-only books $0 and mutates no residual', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [claim({ leverId: 'cost.note', counterfactual: { kind: 'flag-only' } })],
      td
    );
    expect(r.total).toBeCloseTo(0, 9);
    expect(r.billFinal).toBeCloseTo(r.billOriginal, 9);
    expect(r.booked[0].rejected).toBe(false);
    expect(r.booked[0].marginalUsd).toBe(0);
  });

  it('per-category breakdown sums to total', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ inputTokens: 1_000_000, webSearchRequests: 100 }),
      ]),
    ];
    const claims = [
      claim({
        leverId: 'cost.swap',
        orderKey: 80,
        ownedPools: ['input'],
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
      }),
      claim({
        leverId: 'cost.web-search-spend',
        orderKey: 60,
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'directUsd', usd: 1 },
      }),
    ];
    const r = runReclaimCascade(claims, td);
    const catSum = Object.values(r.byCategory).reduce((s, v) => s + (v ?? 0), 0);
    expect(catSum).toBeCloseTo(r.total, 9);
    expect(r.byCategory.cost).toBeCloseTo(r.total, 9);
  });

  it('rollupCascade exposes total / byCategory / totalBill', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td
    );
    const rollup = rollupCascade(r);
    expect(rollup.total).toBeCloseTo(4, 9);
    expect(rollup.totalBill).toBeCloseTo(5, 9);
    expect(rollup.byCategory.cost).toBeCloseTo(4, 9);
    // Coverage = total / totalBill.
    expect(rollup.total / rollup.totalBill).toBeCloseTo(0.8, 9);
  });

  it('de-duplicates repeated scopeKeys in one claim (no double-apply)', () => {
    // A malformed claim lists the same scope twice. The reprice must book once
    // ($5→$1 = $4), not twice; the directUsd must not double-count the fee.
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ inputTokens: 1_000_000, webSearchRequests: 100 }),
      ]),
    ];
    const dup = scopeKeyOf('s1', 'claude-opus-4-7');
    const reprice = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [dup, dup],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td
    );
    expect(reprice.booked[0].marginalUsd).toBeCloseTo(4, 9);

    const direct = runReclaimCascade(
      [
        claim({
          leverId: 'cost.web-search-spend',
          orderKey: 60,
          scopeKeys: [dup, dup],
          counterfactual: { kind: 'directUsd', usd: 1 },
        }),
      ],
      td
    );
    expect(direct.booked[0].marginalUsd).toBeCloseTo(1, 9);
    expect(direct.booked[0].rejected).toBe(false);
  });

  it('empty claims roll up to zero with the full bill as denominator', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade([], td);
    expect(r.total).toBe(0);
    expect(r.billOriginal).toBeCloseTo(5, 9);
    expect(rollupCascade(r)).toEqual({
      total: 0,
      byCategory: {},
      byLever: {},
      coverageByCategory: {},
      // #3163: the window-wide union is now threaded through the rollup.
      coverageUnion: { claimedUsd: 0, totalBill: r.billOriginal, coverage: 0 },
      totalBill: r.billOriginal,
    });
  });
});

// ── PR2 (#948): pure-label extension — cause / open leverId / flag-only coverage ──
describe('runReclaimCascade — PR2 label/coverage extension', () => {
  it('cause + category are PURE labels: identity holds and is byte-identical with or without them', () => {
    // Same arithmetic claim, once bare (PR1 shape) and once fully labelled.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const bare = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td
    );
    const labelled = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td
    );
    // Labels never move a dollar: total / bills identical.
    expect(labelled.total).toBeCloseTo(bare.total, 9);
    expect(labelled.billOriginal).toBeCloseTo(bare.billOriginal, 9);
    expect(labelled.billFinal).toBeCloseTo(bare.billFinal, 9);
    expect(labelled.total).toBeCloseTo(4, 9);
    // An absent cause defaults to the unclassified bucket.
    expect(bare.booked[0].cause).toBe(DEFAULT_CAUSE);
    expect(labelled.booked[0].cause).toBe('model-tier');
  });

  it('cause-first ordering carves the split (equal orderKeys); identity invariant across causes', () => {
    // Two levers reprice the SAME input pool. The behavioural cause (failed-tool-
    // retry, rank 10) runs ahead of the structural model-tier (rank 50) when their
    // explicit orderKeys are equal, so the cause lever books the larger slice.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const retry = claim({
      leverId: 'reliability.retry-prefix',
      category: 'reliability',
      cause: 'failed-tool-retry',
      orderKey: 50,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' }, // $5 → $3
    });
    const tier = claim({
      leverId: 'cost.model-tier',
      category: 'cost',
      cause: 'model-tier',
      orderKey: 50,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' }, // → $1
    });
    // Feed both orders; cause-rank, not list order, decides who runs first.
    const r1 = runReclaimCascade([retry, tier], td);
    const r2 = runReclaimCascade([tier, retry], td);
    for (const r of [r1, r2]) {
      expect(r.total).toBeCloseTo(4, 9); // 5 → 1
      const summed = r.booked.reduce((s, b) => s + b.marginalUsd, 0);
      expect(summed).toBeCloseTo(r.billOriginal - r.billFinal, 9);
      // failed-tool-retry runs first against the $5 residual ($5→$3 = $2);
      // model-tier then sees $3 and drops to $1 = $2 more.
      expect(r.byLever['reliability.retry-prefix']).toBeCloseTo(2, 9);
      expect(r.byLever['cost.model-tier']).toBeCloseTo(2, 9);
      // Per-category split mirrors the per-lever split.
      expect(r.byCategory.reliability).toBeCloseTo(2, 9);
      expect(r.byCategory.cost).toBeCloseTo(2, 9);
    }
  });

  it('cause-first is PRIMARY: a behavioural cause books first even when its orderKey is HIGHER', () => {
    // The decisive case (doc §4): a structural cost lever has a NUMERICALLY LOWER
    // orderKey than the behavioural reliability lever, yet cause-first must still
    // run the reliability lever first so its marginal is non-zero (not swallowed).
    // Both reprice the same 1M input pool on Opus ($5).
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const structural = claim({
      leverId: 'cost.model-tier',
      category: 'cost',
      cause: 'model-tier', // rank 50
      orderKey: 10, // LOWER than the reliability lever's orderKey…
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' }, // $5 → $1
    });
    const behavioural = claim({
      leverId: 'reliability.retry-prefix',
      category: 'reliability',
      cause: 'failed-tool-retry', // rank 10 — must win despite the higher orderKey
      orderKey: 90, // …HIGHER than the structural lever's orderKey
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' }, // $5 → $3
    });
    for (const order of [
      [structural, behavioural],
      [behavioural, structural],
    ]) {
      const r = runReclaimCascade(order, td);
      // Identity holds regardless of ordering.
      expect(r.total).toBeCloseTo(4, 9); // 5 → 1
      const summed = r.booked.reduce((s, b) => s + b.marginalUsd, 0);
      expect(summed).toBeCloseTo(r.billOriginal - r.billFinal, 9);
      // Cause-first wins over the lower structural orderKey: the reliability lever
      // runs first against the full $5 residual ($5→$3 = $2 booked, NON-ZERO),
      // then the structural lever sees $3 and drops it to $1 = $2 more.
      expect(r.byLever['reliability.retry-prefix']).toBeCloseTo(2, 9);
      expect(r.byLever['cost.model-tier']).toBeCloseTo(2, 9);
      expect(r.byCategory.reliability).toBeCloseTo(2, 9);
      // The behavioural marginal is specifically NOT swallowed to $0.
      expect(r.byLever['reliability.retry-prefix']).toBeGreaterThan(0);
    }
  });

  it('byLever sums to total and mirrors byCategory', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' }, // input $5→$1 = $4
        }),
        claim({
          leverId: 'context.trim',
          category: 'context',
          cause: 'structural-prefix',
          orderKey: 70,
          ownedPools: ['output'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { output: 0.5 } }, // output $25 * 0.5 = $12.50
        }),
      ],
      td
    );
    const leverSum = Object.values(r.byLever).reduce((s, v) => s + v, 0);
    expect(leverSum).toBeCloseTo(r.total, 9);
    expect(r.byLever['cost.swap']).toBeCloseTo(4, 9);
    expect(r.byLever['context.trim']).toBeCloseTo(12.5, 9);
    expect(r.byCategory.cost).toBeCloseTo(r.byLever['cost.swap'], 9);
    expect(r.byCategory.context).toBeCloseTo(r.byLever['context.trim'], 9);
  });

  it('flag-only books $0, moves NO residual, but DOES raise its category coverage', () => {
    // 1M input on Opus = $5 bill. A flag-only context claim names the input pool:
    // it books nothing (total stays 0, billFinal == billOriginal) yet its evidence
    // makes context coverage = $5 / $5 = 1.0.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'context.prefix-note',
          category: 'context',
          cause: 'structural-prefix',
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'flag-only' },
          evidenceTokens: 1_000_000,
        }),
      ],
      td
    );
    // Dollar identity untouched by the flag-only sentinel.
    expect(r.total).toBeCloseTo(0, 9);
    expect(r.billFinal).toBeCloseTo(r.billOriginal, 9);
    expect(r.byLever['context.prefix-note'] ?? 0).toBe(0);
    expect(r.byCategory.context ?? 0).toBe(0);
    // …but coverage DOES count the addressed cell.
    const cov = r.coverageByCategory.context!;
    expect(cov.claimedUsd).toBeCloseTo(5, 9);
    expect(cov.totalBill).toBeCloseTo(5, 9);
    expect(cov.coverage).toBeCloseTo(1, 9);
  });

  it('flag-only carrying ONLY unmapped evidenceTokens (no resolvable cell) adds $0 dollar coverage', () => {
    // Dollar coverage = "the engine has a DOLLAR OPINION on X% of the bill". A
    // flag-only reliability lever names its scope but pins NO ownedPools, so it
    // resolves to no priced cell — its raw evidenceTokens are deliberately NOT
    // priced (we don't fabricate a blended rate). It books $0 AND adds $0 coverage,
    // so the category is omitted entirely (sparse).
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 })]),
    ];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'reliability.retry-evidence',
          category: 'reliability',
          cause: 'failed-tool-retry',
          ownedPools: [], // no resolvable cell → no dollar opinion
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'flag-only' },
          evidenceTokens: 1_000_000,
        }),
      ],
      td
    );
    // Books $0 to the identity.
    expect(r.total).toBeCloseTo(0, 9);
    expect(r.billFinal).toBeCloseTo(r.billOriginal, 9);
    expect(r.byLever['reliability.retry-evidence'] ?? 0).toBe(0);
    expect(r.byCategory.reliability ?? 0).toBe(0);
    // …and $0 dollar coverage: the category is omitted (no fabricated price).
    expect(Object.prototype.hasOwnProperty.call(r.coverageByCategory, 'reliability')).toBe(false);
    expect(r.coverageByCategory.reliability).toBeUndefined();
  });

  it('NO double-count: a pinned cell + a same-scope flag-only-evidence claim stay at the cell price', () => {
    // The regression the prior round introduced: a $5 input cell PLUS a same-scope
    // flag-only claim carrying only evidenceTokens must NOT sum to $5 + $blended.
    // Dollar coverage is the priced cell-union → exactly $5, not $28.18.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000, outputTokens: 10_000_000 })]),
    ];
    const cellClaim = claim({
      leverId: 'cost.cell',
      category: 'cost',
      cause: 'model-tier',
      ownedPools: ['input'], // pins the $5 input cell
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
    });
    const evidenceClaim = claim({
      leverId: 'cost.evidence',
      category: 'cost',
      cause: 'model-tier',
      ownedPools: [], // unmapped evidence — must add $0
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 1_000_000,
    });
    const r = runReclaimCascade([cellClaim, evidenceClaim], td);
    const cov = r.coverageByCategory.cost!;
    // Bill = 1M input ($5) + 10M output ($250) = $255. Addressed = just the $5 input.
    expect(cov.totalBill).toBeCloseTo(255, 9);
    expect(cov.claimedUsd).toBeCloseTo(5, 9); // NOT $28.18 — no additive evidence pricing
    expect(cov.coverage).toBeCloseTo(5 / 255, 9);
  });

  it('NO double-count: two flag-only-evidence claims on one scope add $0, not additive', () => {
    // Two flag-only levers describing the SAME re-read, each carrying evidenceTokens
    // but no pinned cell. Dollar coverage must be $0 (omitted), never $5+$5=$10.
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 2_000_000 })])]; // $10 bill
    const a = claim({
      leverId: 'reliability.a',
      category: 'reliability',
      cause: 'failed-tool-retry',
      ownedPools: [],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 1_000_000,
    });
    const b = claim({
      leverId: 'reliability.b',
      category: 'reliability',
      cause: 'failed-tool-retry',
      ownedPools: [],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 1_000_000,
    });
    const r = runReclaimCascade([a, b], td);
    expect(r.coverageByCategory.reliability).toBeUndefined(); // $0, not additive $10
  });

  it('coverageByCategory is SPARSE: a ghost / empty-evidence category is omitted (no { claimedUsd: 0 } entry)', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [
        // A real cost claim → cost coverage present.
        claim({
          leverId: 'cost.swap',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
        // A ghost reliability claim: scope does not resolve → addresses nothing.
        claim({
          leverId: 'reliability.ghost',
          category: 'reliability',
          cause: 'failed-tool-retry',
          orderKey: 50,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('does-not-exist', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
        // A flag-only safety claim with zero evidence and no pinned cell.
        claim({
          leverId: 'safety.note',
          category: 'safety',
          cause: 'safety-redo',
          ownedPools: [],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'flag-only' },
          evidenceTokens: 0,
        }),
      ],
      td
    );
    // Only the category that addresses priced bill appears.
    expect(r.coverageByCategory.cost).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(r.coverageByCategory, 'reliability')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(r.coverageByCategory, 'safety')).toBe(false);
    expect(Object.keys(r.coverageByCategory)).toEqual(['cost']);
  });

  it('coverage = price(addressed cells) / totalBill; unclaimed pools lower it; overlap counts once', () => {
    // Two scopes: s1 has 1M input ($5) + 1M output ($25) = $30; s2 has 1M input
    // ($5). Total bill $35. Two cost claims BOTH address s1's input pool (overlap),
    // plus s1 output. s2 input is unclaimed → it lowers coverage.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 })]),
      session('s2', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })]),
    ];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.a',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 10,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' },
        }),
        claim({
          leverId: 'cost.b',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 20,
          // Overlaps s1 input (counted once) AND adds s1 output.
          ownedPools: ['input', 'output'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'scaleTokens', poolDeltaFrac: { input: 0, output: 1 } },
        }),
      ],
      td
    );
    // Addressed cells (union): s1 input ($5) + s1 output ($25) = $30. NOT counted:
    // s2 input ($5). Coverage = 30 / 35.
    const cov = r.coverageByCategory.cost!;
    expect(cov.totalBill).toBeCloseTo(35, 9);
    expect(cov.claimedUsd).toBeCloseTo(30, 9);
    expect(cov.coverage).toBeCloseTo(30 / 35, 9);
    // Coverage is priced on the ORIGINAL matrix and is NOT the reclaimed dollars.
    expect(cov.claimedUsd).not.toBeCloseTo(r.total, 1);
  });

  it('directUsd contributes its server-fee residual to coverage, not a token cell', () => {
    // 100 web searches = $1 server fee; 1M input = $5. Bill $6. A directUsd claim
    // opines on the $1 server fee ⇒ cost coverage = 1 / 6.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000, webSearchRequests: 100 })]),
    ];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.web-search-spend',
          category: 'cost',
          orderKey: 60,
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'directUsd', usd: 1 },
        }),
      ],
      td
    );
    const cov = r.coverageByCategory.cost!;
    expect(cov.totalBill).toBeCloseTo(6, 9);
    expect(cov.claimedUsd).toBeCloseTo(1, 9);
    expect(cov.coverage).toBeCloseTo(1 / 6, 9);
  });

  it('rollupCascade exposes byLever + coverageByCategory alongside total/totalBill', () => {
    const td = [session('s1', 'claude-opus-4-7', [entry({ inputTokens: 1_000_000 })])];
    const r = runReclaimCascade(
      [
        claim({
          leverId: 'cost.swap',
          category: 'cost',
          cause: 'model-tier',
          orderKey: 80,
          ownedPools: ['input'],
          scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
          counterfactual: { kind: 'reprice', toModel: 'claude-haiku-4-5-20251001' },
        }),
      ],
      td
    );
    const rollup = rollupCascade(r);
    expect(rollup.byLever['cost.swap']).toBeCloseTo(4, 9);
    expect(rollup.coverageByCategory.cost!.coverage).toBeCloseTo(1, 9); // input pool fully addressed
    expect(rollup.coverageByCategory.cost!.claimedUsd).toBeCloseTo(5, 9);
    // Reclaimed dollars ($4) and coverage dollars ($5) are deliberately different.
    expect(rollup.total).toBeCloseTo(4, 9);
  });
});
