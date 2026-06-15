import { describe, it, expect } from 'vitest';
import {
  median,
  pairedDeltas,
  pairedMedianDelta,
  pairedMedianPctDelta,
  wilcoxonSignedRank,
  bootstrapCI,
  decideVerdict,
  PRE_REGISTERED_MIN_DECIDED,
  type PairedCost,
} from './proof-stats';

describe('median', () => {
  it('handles odd and even lengths and is order-independent', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
  });
  it('returns NaN for empty input', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('paired deltas', () => {
  const pairs: PairedCost[] = [
    { control: 1.0, treatment: 0.8 },
    { control: 2.0, treatment: 1.4 },
    { control: 1.5, treatment: 1.2 },
  ];
  it('computes treatment - control per pair', () => {
    expect(pairedDeltas(pairs)).toEqual([
      0.8 - 1.0,
      1.4 - 2.0,
      1.2 - 1.5,
    ]);
  });
  it('median delta is negative for a cost reduction', () => {
    expect(pairedMedianDelta(pairs)).toBeCloseTo(-0.3, 10);
  });
  it('percentage delta is relative to the median control', () => {
    // control medians: [1.0, 1.5, 2.0] -> 1.5; median delta -0.3 -> -20%
    expect(pairedMedianPctDelta(pairs)).toBeCloseTo(-20, 6);
  });
  it('returns NaN pct when median control is 0', () => {
    expect(
      Number.isNaN(pairedMedianPctDelta([{ control: 0, treatment: -1 }]))
    ).toBe(true);
  });
});

describe('wilcoxonSignedRank (one-sided reduction)', () => {
  it('is significant when every pair reduces cost strongly', () => {
    // 12 pairs, all clear reductions -> all ranks negative -> max W- -> tiny p.
    const pairs: PairedCost[] = Array.from({ length: 12 }, (_, i) => ({
      control: 10 + i,
      treatment: 10 + i - (2 + i * 0.1),
    }));
    const r = wilcoxonSignedRank(pairs);
    expect(r.n).toBe(12);
    expect(r.pOneSided).toBeLessThan(0.05);
  });
  it('is non-significant when deltas are symmetric around zero', () => {
    const pairs: PairedCost[] = [
      { control: 1, treatment: 1.1 },
      { control: 1, treatment: 0.9 },
      { control: 2, treatment: 2.2 },
      { control: 2, treatment: 1.8 },
      { control: 3, treatment: 3.15 },
      { control: 3, treatment: 2.85 },
    ];
    const r = wilcoxonSignedRank(pairs);
    expect(r.pOneSided).toBeGreaterThan(0.05);
  });
  it('drops zero deltas and reports p=1 with no non-zero deltas', () => {
    const r = wilcoxonSignedRank([
      { control: 1, treatment: 1 },
      { control: 2, treatment: 2 },
    ]);
    expect(r.n).toBe(0);
    expect(r.pOneSided).toBe(1);
  });
});

describe('bootstrapCI (seeded / deterministic)', () => {
  it('is deterministic for a fixed seed', () => {
    const deltas = [-0.2, -0.6, -0.3, -0.5, -0.4, -0.1, -0.7, -0.35];
    const a = bootstrapCI(deltas, { iters: 2000, seed: 42 });
    const b = bootstrapCI(deltas, { iters: 2000, seed: 42 });
    expect(a).toEqual(b);
  });
  it('produces a CI entirely below zero for all-negative deltas', () => {
    const deltas = [-0.2, -0.6, -0.3, -0.5, -0.4, -0.45, -0.7, -0.35, -0.55, -0.5, -0.6, -0.4];
    const ci = bootstrapCI(deltas, { iters: 4000, seed: 7 });
    expect(ci.hi).toBeLessThan(0);
    expect(ci.lo).toBeLessThanOrEqual(ci.hi);
  });
  it('returns NaN bounds for empty input', () => {
    const ci = bootstrapCI([], { iters: 100, seed: 1 });
    expect(Number.isNaN(ci.lo)).toBe(true);
    expect(Number.isNaN(ci.hi)).toBe(true);
  });
});

describe('decideVerdict (§5 decision rule)', () => {
  it('PROVEN: >=15% reduction, CI below 0, p<0.05, quality holds, N>=12', () => {
    const r = decideVerdict({
      pairedMedianPctDelta: -22,
      ci: { lo: -0.6, hi: -0.1 },
      p: 0.001,
      qualityHoldPass: true,
      nDecided: 14,
    });
    expect(r.verdict).toBe('proven');
  });
  it('NULL: N>=12 but effect below MDE / CI straddles zero', () => {
    const r = decideVerdict({
      pairedMedianPctDelta: -5,
      ci: { lo: -0.3, hi: 0.1 },
      p: 0.2,
      qualityHoldPass: true,
      nDecided: 12,
    });
    expect(r.verdict).toBe('null');
  });
  it('REFUTED: treatment costs more, CI excludes zero on the positive side', () => {
    const r = decideVerdict({
      pairedMedianPctDelta: +18,
      ci: { lo: 0.1, hi: 0.5 },
      p: 0.9,
      qualityHoldPass: true,
      nDecided: 13,
    });
    expect(r.verdict).toBe('refuted');
  });
  it('REFUTED: quality-hold fails even if cost dropped', () => {
    const r = decideVerdict({
      pairedMedianPctDelta: -30,
      ci: { lo: -0.6, hi: -0.2 },
      p: 0.001,
      qualityHoldPass: false,
      nDecided: 20,
    });
    expect(r.verdict).toBe('refuted');
  });
  it('not-yet-provable: fewer than 12 DECIDED pairs (NOT a null)', () => {
    const r = decideVerdict({
      pairedMedianPctDelta: -40,
      ci: { lo: -0.9, hi: -0.4 },
      p: 0.0001,
      qualityHoldPass: true,
      nDecided: PRE_REGISTERED_MIN_DECIDED - 1,
    });
    expect(r.verdict).toBe('not-yet-provable');
  });
});
