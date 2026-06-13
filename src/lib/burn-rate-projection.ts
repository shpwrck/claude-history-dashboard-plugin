import type { CostTrend, DailySpend } from './cost-trend';
import type { Usage, UsageWindow } from './usage';

export type PlanWindowKey = 'fiveHour' | 'sevenDay';

export const PLAN_WINDOW_MS: Record<PlanWindowKey, number> = {
  fiveHour: 5 * 60 * 60 * 1000,
  sevenDay: 7 * 24 * 60 * 60 * 1000,
};

const PLAN_WINDOW_LABELS: Record<PlanWindowKey, string> = {
  fiveHour: '5-hour',
  sevenDay: 'Weekly',
};

export interface PlanWindowProjection {
  key: PlanWindowKey;
  label: string;
  utilization: number;
  reset: number | null;
  status: string | null;
  resetInMs: number | null;
  elapsedFraction: number | null;
  projectedAtReset: number | null;
  timeToLimitMs: number | null;
  limitAtMs: number | null;
}

export interface BurnRateProjection {
  generatedAtMs: number;
  spend: {
    burnRateDailyUsd: number;
    projectedMonthEndUsd: number;
    lastMonthUsd: number;
    firstDay: string | null;
    lastDay: string | null;
    recentDaily: DailySpend[];
  };
  plan: {
    available: boolean;
    reason: string | null;
    representativeClaim: string | null;
    windows: PlanWindowProjection[];
  };
}

function validResetMs(reset: number | null): number | null {
  if (reset == null || !Number.isFinite(reset)) return null;
  const ms = reset * 1000;
  return Number.isFinite(ms) ? ms : null;
}

export function projectUsageWindow(
  key: PlanWindowKey,
  window: UsageWindow | null,
  nowMs: number = Date.now()
): PlanWindowProjection | null {
  if (!window) return null;

  const resetMs = validResetMs(window.reset);
  const durationMs = PLAN_WINDOW_MS[key];
  const status = window.status ?? null;
  let resetInMs: number | null = null;
  let elapsedFraction: number | null = null;
  let projectedAtReset: number | null = null;
  let timeToLimitMs: number | null = null;
  let limitAtMs: number | null = null;

  if (window.utilization >= 1 || status?.toLowerCase() === 'rejected') {
    timeToLimitMs = 0;
    limitAtMs = nowMs;
  }

  if (resetMs !== null) {
    resetInMs = resetMs - nowMs;
    const startMs = resetMs - durationMs;
    const elapsedMs = nowMs - startMs;

    if (resetInMs >= 0 && elapsedMs > 0 && elapsedMs <= durationMs) {
      elapsedFraction = elapsedMs / durationMs;
      projectedAtReset = elapsedFraction > 0 ? window.utilization / elapsedFraction : null;

      if (timeToLimitMs === null && window.utilization > 0 && projectedAtReset !== null) {
        const remainingFraction = Math.max(0, 1 - window.utilization);
        const ratePerMs = window.utilization / elapsedMs;
        const candidateMs = remainingFraction / ratePerMs;

        if (projectedAtReset >= 1 && candidateMs <= resetInMs + 1000) {
          timeToLimitMs = Math.max(0, candidateMs);
          limitAtMs = nowMs + timeToLimitMs;
        }
      }
    }
  }

  return {
    key,
    label: PLAN_WINDOW_LABELS[key],
    utilization: window.utilization,
    reset: window.reset,
    status,
    resetInMs,
    elapsedFraction,
    projectedAtReset,
    timeToLimitMs,
    limitAtMs,
  };
}

export function recentSpendEvidence(trend: CostTrend, days = 7): DailySpend[] {
  if (days <= 0) return [];
  return trend.daily.slice(-days);
}

export function buildBurnRateProjection(
  trend: CostTrend,
  usage: Usage | null,
  nowMs: number = Date.now()
): BurnRateProjection {
  const windows =
    usage?.available === true
      ? [
          projectUsageWindow('fiveHour', usage.fiveHour, nowMs),
          projectUsageWindow('sevenDay', usage.sevenDay, nowMs),
        ].filter((window): window is PlanWindowProjection => window !== null)
      : [];

  return {
    generatedAtMs: nowMs,
    spend: {
      burnRateDailyUsd: trend.burnRate7d,
      projectedMonthEndUsd: trend.projectedMonthEndUsd,
      lastMonthUsd: trend.lastMonthUsd,
      firstDay: trend.firstDay,
      lastDay: trend.lastDay,
      recentDaily: recentSpendEvidence(trend),
    },
    plan: {
      available: usage?.available === true,
      reason: usage?.available === false ? usage.reason : usage === null ? 'loading' : null,
      representativeClaim: usage?.available === true ? usage.representativeClaim : null,
      windows,
    },
  };
}
