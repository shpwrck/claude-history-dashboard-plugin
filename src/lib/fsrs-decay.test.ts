import { describe, expect, it } from 'vitest';
import {
  AGAIN,
  DECAY,
  EASY,
  FACTOR,
  GOOD,
  HARD,
  INTERVAL_MAX,
  MIN_REFIT_RECEIPTS,
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  STABILITY_MAX,
  STABILITY_MIN,
  initDifficulty,
  initItemState,
  initStability,
  intervalFor,
  nextStabilityForget,
  nextStabilityRecall,
  recordLapse,
  recordRecall,
  refit,
  retrievability,
  type RefitReceipt,
} from './fsrs-decay';

/** All finite, no NaN/Infinity. */
function isFiniteNum(x: number): boolean {
  return typeof x === 'number' && Number.isFinite(x);
}

describe('FSRS constants', () => {
  it('uses the canonical DECAY / FACTOR calibrated to R(t=S)=0.9', () => {
    expect(DECAY).toBe(-0.5);
    expect(FACTOR).toBeCloseTo(19 / 81, 12);
  });
});

describe('retrievability calibration point', () => {
  it('R(t = stability) === 0.9 (the FSRS calibration point)', () => {
    for (const s of [0.5, 1, 3, 10, 42, 365]) {
      expect(retrievability(s, s)).toBeCloseTo(0.9, 10);
    }
  });

  it('R(0, S) === 1 (freshly reviewed is fully retrievable)', () => {
    expect(retrievability(0, 10)).toBeCloseTo(1, 12);
  });
});

describe('monotonic decay', () => {
  it('retrievability strictly decreases as elapsed grows (fixed stability)', () => {
    const stability = 10;
    let prev = retrievability(0, stability);
    for (const elapsed of [1, 2, 5, 10, 20, 50, 100, 1000]) {
      const r = retrievability(elapsed, stability);
      expect(r).toBeLessThan(prev);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      prev = r;
    }
  });

  it('higher stability retains better at the same elapsed', () => {
    const elapsed = 30;
    expect(retrievability(elapsed, 100)).toBeGreaterThan(retrievability(elapsed, 10));
  });
});

describe('stability ordering: hard < good < easy', () => {
  it('a stronger recall grade yields >= stability than a weaker one', () => {
    const d = 5;
    const s = 10;
    const r = 0.9;
    const hard = nextStabilityRecall(d, s, r, HARD);
    const good = nextStabilityRecall(d, s, r, GOOD);
    const easy = nextStabilityRecall(d, s, r, EASY);
    expect(hard).toBeLessThanOrEqual(good);
    expect(good).toBeLessThanOrEqual(easy);
    // and all three grow stability on a recall
    expect(hard).toBeGreaterThan(s * 0.9); // hard may penalize but still a recall
    expect(good).toBeGreaterThan(s);
    expect(easy).toBeGreaterThan(good);
  });

  it('initStability orders again <= hard <= good <= easy', () => {
    expect(initStability(AGAIN)).toBeLessThanOrEqual(initStability(HARD));
    expect(initStability(HARD)).toBeLessThanOrEqual(initStability(GOOD));
    expect(initStability(GOOD)).toBeLessThanOrEqual(initStability(EASY));
  });

  it('initDifficulty falls as grade rises and stays in [1,10]', () => {
    const again = initDifficulty(AGAIN);
    const easy = initDifficulty(EASY);
    expect(again).toBeGreaterThan(easy);
    for (const g of [AGAIN, HARD, GOOD, EASY]) {
      const d = initDifficulty(g);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(10);
    }
  });
});

describe('lapse shrinks and never increases stability (the cap)', () => {
  it('nextStabilityForget <= incoming stability across a range', () => {
    for (const s of [0.5, 1, 5, 10, 50, 200, 1000]) {
      for (const d of [1, 3, 5, 8, 10]) {
        for (const r of [0.5, 0.7, 0.9, 0.99]) {
          const sf = nextStabilityForget(d, s, r);
          expect(sf).toBeLessThanOrEqual(s);
          expect(sf).toBeGreaterThan(0);
          expect(isFiniteNum(sf)).toBe(true);
        }
      }
    }
  });

  it('a lapse yields <= stability than any recall on the same state', () => {
    const d = 5;
    const s = 20;
    const r = 0.85;
    const lapse = nextStabilityForget(d, s, r);
    expect(lapse).toBeLessThanOrEqual(nextStabilityRecall(d, s, r, HARD));
    expect(lapse).toBeLessThanOrEqual(s);
  });

  it('recordLapse shrinks and recordRecall grows a domain item state', () => {
    const state = initItemState(GOOD);
    const recalled = recordRecall(state, 5);
    const lapsed = recordLapse(state, 5);
    expect(recalled.stability).toBeGreaterThan(state.stability);
    expect(lapsed.stability).toBeLessThanOrEqual(state.stability);
  });

  it('caps a lapse at STABILITY_MAX even from an out-of-band incoming stability', () => {
    // With a huge incoming stability, low difficulty and r=0 the forget formula
    // produces sf above STABILITY_MAX; the explicit ceiling clamps it in band.
    const capped = nextStabilityForget(1, 1e12, 0);
    expect(capped).toBeLessThanOrEqual(STABILITY_MAX);
    expect(capped).toBeGreaterThan(0);
    expect(isFiniteNum(capped)).toBe(true);
  });
});

describe('defensive clamps (finite, sane, no NaN/Infinity/throw)', () => {
  it('stability <= 0 or non-finite -> retrievability 0', () => {
    expect(retrievability(5, 0)).toBe(0);
    expect(retrievability(5, -10)).toBe(0);
    expect(retrievability(5, Number.NaN)).toBe(0);
    expect(retrievability(5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('negative / non-finite elapsed -> finite value in [0,1]', () => {
    const rNeg = retrievability(-100, 10);
    expect(rNeg).toBeCloseTo(1, 12); // future last-review clamps to 0 elapsed
    expect(isFiniteNum(rNeg)).toBe(true);
    const rNaN = retrievability(Number.NaN, 10);
    expect(rNaN).toBe(0);
    expect(isFiniteNum(retrievability(Number.POSITIVE_INFINITY, 10))).toBe(true);
  });

  it('intervalFor: retention=0 / negative multiplier / bad stability stay in [1, INTERVAL_MAX]', () => {
    for (const iv of [
      intervalFor(10, 0, 1), // retention=0 would divide-by-zero without clamp
      intervalFor(10, -5, 1),
      intervalFor(10, 0.9, -3), // negative multiplier
      intervalFor(10, 0.9, Number.POSITIVE_INFINITY),
      intervalFor(-10, 0.9, 1), // negative stability
      intervalFor(Number.NaN, Number.NaN, Number.NaN),
      intervalFor(1e9, 0.97, 1.5), // huge -> clamped to ceiling
    ]) {
      expect(isFiniteNum(iv)).toBe(true);
      expect(iv).toBeGreaterThanOrEqual(1);
      expect(iv).toBeLessThanOrEqual(INTERVAL_MAX);
      expect(Number.isInteger(iv)).toBe(true);
    }
  });

  it('nextStabilityRecall / nextStabilityForget stay finite in band on corrupt input', () => {
    const badInputs: Array<[number, number, number, number]> = [
      [Number.NaN, Number.NaN, Number.NaN, GOOD],
      [-5, 0, -1, HARD],
      [100, -10, 2, EASY],
      [5, Number.POSITIVE_INFINITY, 0.9, GOOD],
    ];
    for (const [d, s, r, g] of badInputs) {
      const rec = nextStabilityRecall(d, s, r, g);
      const forget = nextStabilityForget(d, s, r);
      for (const v of [rec, forget]) {
        expect(isFiniteNum(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(STABILITY_MIN);
        expect(v).toBeLessThanOrEqual(STABILITY_MAX);
      }
    }
  });

  it('grade is normalized: out-of-range grades do not throw and clamp to [1,4]', () => {
    expect(isFiniteNum(initStability(0))).toBe(true);
    expect(isFiniteNum(initStability(99))).toBe(true);
    expect(initStability(0)).toBe(initStability(1));
    expect(initStability(99)).toBe(initStability(4));
  });

  it('recordRecall / recordLapse re-clamp an out-of-range difficulty into [1,10]', () => {
    // A caller passing an unclamped difficulty must not have it propagate out of
    // range through the returned item state.
    expect(recordRecall({ stability: 10, difficulty: 42 }, 5).difficulty).toBe(10);
    expect(recordLapse({ stability: 10, difficulty: -3 }, 5).difficulty).toBe(1);
    // non-finite difficulty falls back into band, never propagates NaN
    for (const s of [
      recordRecall({ stability: 10, difficulty: Number.NaN }, 5),
      recordLapse({ stability: 10, difficulty: Number.POSITIVE_INFINITY }, 5),
    ]) {
      expect(isFiniteNum(s.difficulty)).toBe(true);
      expect(s.difficulty).toBeGreaterThanOrEqual(1);
      expect(s.difficulty).toBeLessThanOrEqual(10);
    }
  });
});

describe('refit: cold-start default + evidence-gated evergreen', () => {
  function makeReceipts(n: number, opts: { staleCadence?: boolean } = {}): RefitReceipt[] {
    // Predicted ~0.9 for every review. If staleCadence, more lapses than
    // predicted (observed recall below predicted) -> multiplier should shorten.
    return Array.from({ length: n }, (_, i) => {
      const isLapse = opts.staleCadence ? i % 3 === 0 : i % 10 === 0;
      return {
        grade: isLapse ? AGAIN : GOOD,
        predictedRetrievability: 0.9,
      } satisfies RefitReceipt;
    });
  }

  it('refuses below the 50-receipt threshold with an honest reason (using default)', () => {
    const result = refit(makeReceipts(MIN_REFIT_RECEIPTS - 1), '2026-07-09');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.intervalMultiplier).toBe(1);
      expect(result.usingDefault).toBe(true);
      expect(result.receipts).toBe(MIN_REFIT_RECEIPTS - 1);
      expect(result.reason).toMatch(/insufficient evidence/i);
      expect(result.reason).toContain('as of 2026-07-09');
      expect(result.asOf).toBe('2026-07-09');
    }
  });

  it('empty receipts refuse (cold start)', () => {
    const result = refit([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.intervalMultiplier).toBe(1);
      expect(result.receipts).toBe(0);
    }
  });

  it('receipts without a finite prediction are excluded from the count', () => {
    const withoutPredictions: RefitReceipt[] = Array.from(
      { length: MIN_REFIT_RECEIPTS + 10 },
      () => ({ grade: GOOD, predictedRetrievability: null }),
    );
    const result = refit(withoutPredictions);
    expect(result.ok).toBe(false); // none usable -> below threshold
    if (!result.ok) expect(result.receipts).toBe(0);
  });

  it('drops receipts with no observed grade (missing outcome)', () => {
    // 50 valid graded receipts plus 10 with a finite prediction but no grade;
    // the no-grade receipts must NOT count (a missing outcome is not a recall).
    const noGrade = Array.from(
      { length: 10 },
      () => ({ predictedRetrievability: 0.9 }) as unknown as RefitReceipt,
    );
    const result = refit([...makeReceipts(MIN_REFIT_RECEIPTS), ...noGrade]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipts).toBe(MIN_REFIT_RECEIPTS);
  });

  it('rejects receipts whose predicted retrievability is outside [0,1]', () => {
    // 50 valid receipts plus 10 with an out-of-range prediction; the out-of-range
    // receipts are corrupt evidence and must NOT count toward the fit.
    const outOfRange: RefitReceipt[] = Array.from({ length: 10 }, (_, i) => ({
      grade: GOOD,
      predictedRetrievability: i % 2 === 0 ? 1.5 : -0.2,
    }));
    const result = refit([...makeReceipts(MIN_REFIT_RECEIPTS), ...outOfRange]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipts).toBe(MIN_REFIT_RECEIPTS);
  });

  it('fits a clamped multiplier in [0.5, 1.5] at >= 50 receipts', () => {
    const result = refit(makeReceipts(MIN_REFIT_RECEIPTS), '2026-07-09');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isFiniteNum(result.intervalMultiplier)).toBe(true);
      expect(result.intervalMultiplier).toBeGreaterThanOrEqual(MULTIPLIER_MIN);
      expect(result.intervalMultiplier).toBeLessThanOrEqual(MULTIPLIER_MAX);
      expect(result.receipts).toBe(MIN_REFIT_RECEIPTS);
      expect(result.observedRecall).toBeGreaterThanOrEqual(0);
      expect(result.observedRecall).toBeLessThanOrEqual(1);
      expect(result.asOf).toBe('2026-07-09');
    }
  });

  it('a faster-decaying cadence (more lapses than predicted) shortens intervals (< 1)', () => {
    const result = refit(makeReceipts(120, { staleCadence: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // observed recall (~0.67) well below predicted (0.9) -> shorten
      expect(result.intervalMultiplier).toBeLessThan(1);
      expect(result.intervalMultiplier).toBeGreaterThanOrEqual(MULTIPLIER_MIN);
    }
  });

  it('multiplier is clamped even under extreme observed/predicted divergence', () => {
    // Every review a lapse but predictions near-perfect -> ratio blows up,
    // must clamp into [0.5, 1.5].
    const extreme: RefitReceipt[] = Array.from({ length: 60 }, () => ({
      grade: AGAIN,
      predictedRetrievability: 0.999,
    }));
    const result = refit(extreme);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intervalMultiplier).toBeGreaterThanOrEqual(MULTIPLIER_MIN);
      expect(result.intervalMultiplier).toBeLessThanOrEqual(MULTIPLIER_MAX);
      expect(isFiniteNum(result.intervalMultiplier)).toBe(true);
    }
  });
});
