import { describe, expect, it } from 'vitest';
import type { CostTrend } from './cost-trend';
import {
  PLAN_WINDOW_MS,
  buildBurnRateProjection,
  projectUsageWindow,
} from './burn-rate-projection';

const NOW = Date.UTC(2026, 0, 8, 12, 0, 0);

const trend: CostTrend = {
  daily: [
    { date: '2026-01-02', cost: 2, entries: 2 },
    { date: '2026-01-03', cost: 3, entries: 3 },
    { date: '2026-01-04', cost: 4, entries: 4 },
    { date: '2026-01-05', cost: 5, entries: 5 },
    { date: '2026-01-06', cost: 6, entries: 6 },
    { date: '2026-01-07', cost: 7, entries: 7 },
    { date: '2026-01-08', cost: 8, entries: 8 },
    { date: '2026-01-09', cost: 9, entries: 9 },
  ],
  totalDatedCost: 44,
  undatedCost: 0,
  burnRate7d: 6,
  firstDay: '2026-01-02',
  lastDay: '2026-01-09',
  projectedMonthEndUsd: 138,
  lastMonthUsd: 84,
};

describe('projectUsageWindow', () => {
  it('projects when the 5-hour window is half elapsed and half used', () => {
    const reset = (NOW + PLAN_WINDOW_MS.fiveHour / 2) / 1000;
    const projected = projectUsageWindow(
      'fiveHour',
      { utilization: 0.5, reset, status: 'allowed' },
      NOW
    );

    expect(projected?.elapsedFraction).toBeCloseTo(0.5);
    expect(projected?.projectedAtReset).toBeCloseTo(1);
    expect(projected?.timeToLimitMs).toBeCloseTo(PLAN_WINDOW_MS.fiveHour / 2);
  });

  it('leaves time-to-limit empty when current weekly pace stays below the cap', () => {
    const reset = (NOW + PLAN_WINDOW_MS.sevenDay / 2) / 1000;
    const projected = projectUsageWindow(
      'sevenDay',
      { utilization: 0.2, reset, status: 'allowed' },
      NOW
    );

    expect(projected?.elapsedFraction).toBeCloseTo(0.5);
    expect(projected?.projectedAtReset).toBeCloseTo(0.4);
    expect(projected?.timeToLimitMs).toBeNull();
  });

  it('marks a rejected window as already at the limit', () => {
    const projected = projectUsageWindow(
      'fiveHour',
      { utilization: 0.93, reset: null, status: 'rejected' },
      NOW
    );

    expect(projected?.timeToLimitMs).toBe(0);
    expect(projected?.limitAtMs).toBe(NOW);
  });
});

describe('buildBurnRateProjection', () => {
  it('carries recent spend evidence and available plan windows', () => {
    const projection = buildBurnRateProjection(
      trend,
      {
        available: true,
        fiveHour: {
          utilization: 0.5,
          reset: (NOW + PLAN_WINDOW_MS.fiveHour / 2) / 1000,
          status: 'allowed',
        },
        sevenDay: {
          utilization: 0.7,
          reset: (NOW + PLAN_WINDOW_MS.sevenDay / 2) / 1000,
          status: 'allowed',
        },
        overage: null,
        representativeClaim: 'seven_day',
      },
      NOW
    );

    expect(projection.spend.recentDaily.map((row) => row.date)).toEqual([
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
    ]);
    expect(projection.plan.available).toBe(true);
    expect(projection.plan.windows.map((window) => window.key)).toEqual([
      'fiveHour',
      'sevenDay',
    ]);
    expect(projection.plan.representativeClaim).toBe('seven_day');
  });

  it('keeps spend projection available when usage headers are unavailable', () => {
    const projection = buildBurnRateProjection(
      trend,
      { available: false, reason: 'auth-failed' },
      NOW
    );

    expect(projection.spend.projectedMonthEndUsd).toBe(138);
    expect(projection.plan.available).toBe(false);
    expect(projection.plan.reason).toBe('auth-failed');
    expect(projection.plan.windows).toEqual([]);
  });
});
