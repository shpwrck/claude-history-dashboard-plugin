import type { SessionTokenData, View } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import type { SessionTimeline } from './parse-timeline';
import type { DebugSessionMetrics } from './parse-debug';
import type { TelemetryEvent } from './parse-telemetry';
import { estimateCost } from './parse-sessions';
import { topExpensiveSessions } from './cost-attribution';
import { scoreSessionHealth, LOW_HEALTH_SCORE } from './context-health';
import { computeSessionOutcomes } from './parse-timeline-success';
import {
  analyzeReliability,
  RETRY_STORM_THRESHOLD,
} from './parse-telemetry';
import { MIN_SAVINGS_USD, fmtUsd } from './detectors/shared';

export type ReviewQueueCategory =
  | 'cost'
  | 'reliability'
  | 'speed'
  | 'context'
  | 'outcome';

export type ReviewQueueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewQueueSignal {
  category: ReviewQueueCategory;
  severity: ReviewQueueSeverity;
  score: number;
  reason: string;
  evidenceView: View;
}

export interface ReviewQueueItem {
  id: string;
  sessionId: string;
  category: ReviewQueueCategory;
  severity: ReviewQueueSeverity;
  score: number;
  reason: string;
  evidenceView: View;
  evidenceLabel: string;
  signals: ReviewQueueSignal[];
}

export interface ReviewQueueInput {
  tokenData: SessionTokenData[];
  toolData: ToolUsageData[];
  timelines: SessionTimeline[];
  apiErrors: ApiErrorEvent[];
  debugLogs: DebugSessionMetrics[];
  telemetry: TelemetryEvent[];
}

const SEVERITY_RANK: Record<ReviewQueueSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_LABEL: Record<ReviewQueueCategory, string> = {
  cost: 'Cost',
  reliability: 'Reliability',
  speed: 'Speed',
  context: 'Context',
  outcome: 'Outcome',
};

const VIEW_LABEL: Partial<Record<View, string>> = {
  cost: 'Cost',
  errors: 'Errors',
  'report-card': 'Report Card',
  context: 'Context Health',
  patterns: 'Session Patterns',
};

function compareSignals(a: ReviewQueueSignal, b: ReviewQueueSignal): number {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  if (b.score !== a.score) return b.score - a.score;
  return a.category.localeCompare(b.category);
}

function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function addSignal(
  bySession: Map<string, ReviewQueueSignal[]>,
  sessionId: string,
  signal: ReviewQueueSignal
): void {
  if (!sessionId) return;
  const bucket = bySession.get(sessionId) ?? [];
  bucket.push(signal);
  bySession.set(sessionId, bucket);
}

function addCostSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  const totalCost = input.tokenData.reduce((sum, row) => sum + estimateCost(row), 0);
  if (totalCost <= 0) return;

  const top = topExpensiveSessions(input.tokenData, input.toolData, 5);
  const top3 = top.slice(0, 3);
  const top3Cost = top3.reduce((sum, row) => sum + row.estimatedCost, 0);
  if (top3Cost < MIN_SAVINGS_USD) return;

  const share = (top3Cost / totalCost) * 100;
  if (share < 25) return;

  for (const row of top3) {
    if (row.estimatedCost <= 0) continue;
    addSignal(bySession, row.sessionId, {
      category: 'cost',
      severity: row.estimatedCost >= MIN_SAVINGS_USD ? 'high' : 'medium',
      score: 70 + share + row.estimatedCost * 10,
      reason:
        `${fmtUsd(row.estimatedCost)} estimated spend; top 3 sessions account ` +
        `for ${share.toFixed(0)}% of total spend` +
        (row.topTool ? `, led by ${row.topTool}` : '') +
        '.',
      evidenceView: 'cost',
    });
  }
}

function addToolErrorSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  for (const row of input.toolData) {
    const total = row.calls.length;
    if (total === 0) continue;
    const errors = row.calls.filter((call) => call.isError === true).length;
    const errorRate = errors / total;
    if (errors < 3 && !(errors >= 2 && errorRate >= 0.3)) continue;
    addSignal(bySession, row.sessionId, {
      category: 'reliability',
      severity: errors >= 5 || errorRate >= 0.5 ? 'high' : 'medium',
      score: 55 + errors * 6 + errorRate * 30,
      reason: `${errors}/${total} tool calls errored (${Math.round(errorRate * 100)}%).`,
      evidenceView: 'errors',
    });
  }

  const apiBySession = new Map<string, { count: number; maxRetryAttempt: number }>();
  for (const event of input.apiErrors) {
    const bucket = apiBySession.get(event.sessionId) ?? { count: 0, maxRetryAttempt: 0 };
    bucket.count += 1;
    bucket.maxRetryAttempt = Math.max(bucket.maxRetryAttempt, event.retryAttempt ?? 0);
    apiBySession.set(event.sessionId, bucket);
  }
  for (const [sessionId, row] of apiBySession) {
    if (row.count < 3 && row.maxRetryAttempt < RETRY_STORM_THRESHOLD) continue;
    addSignal(bySession, sessionId, {
      category: 'reliability',
      severity: row.maxRetryAttempt >= RETRY_STORM_THRESHOLD ? 'high' : 'medium',
      score: 55 + row.count * 5 + row.maxRetryAttempt * 8,
      reason:
        `${row.count} API error${row.count === 1 ? '' : 's'}` +
        (row.maxRetryAttempt > 0 ? `, max retry attempt ${row.maxRetryAttempt}` : '') +
        '.',
      evidenceView: 'errors',
    });
  }
}

function addDebugSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  for (const row of input.debugLogs) {
    if (row.maxRetryAttempt >= RETRY_STORM_THRESHOLD) {
      addSignal(bySession, row.sessionId, {
        category: 'reliability',
        severity: row.maxRetryAttempt >= 8 ? 'critical' : 'high',
        score: 70 + row.maxRetryAttempt * 8,
        reason: `Debug log reached API retry attempt ${row.maxRetryAttempt}.`,
        evidenceView: 'report-card',
      });
    }

    if (row.ttfbSampleCount > 0 && row.ttfbP90 >= 5_000) {
      addSignal(bySession, row.sessionId, {
        category: 'speed',
        severity: row.ttfbP90 >= 30_000 ? 'critical' : 'high',
        score: 55 + Math.min(80, row.ttfbP90 / 500),
        reason:
          `p90 time-to-first-byte was ${fmtDuration(row.ttfbP90)} ` +
          `across ${row.ttfbSampleCount} sample${row.ttfbSampleCount === 1 ? '' : 's'}.`,
        evidenceView: 'report-card',
      });
    }

    if (row.slowFirstByteCount > 0) {
      addSignal(bySession, row.sessionId, {
        category: 'speed',
        severity: row.slowFirstByteCount >= 3 ? 'high' : 'medium',
        score: 45 + row.slowFirstByteCount * 10,
        reason:
          `${row.slowFirstByteCount} slow-first-byte stall` +
          `${row.slowFirstByteCount === 1 ? '' : 's'} recorded in debug logs.`,
        evidenceView: 'report-card',
      });
    }
  }
}

function addTelemetrySignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  const reliability = analyzeReliability(input.telemetry);
  for (const row of reliability.bySession) {
    if (row.stormEvents > 0 || row.maxAttempt >= RETRY_STORM_THRESHOLD) {
      addSignal(bySession, row.session_id, {
        category: 'reliability',
        severity: row.maxAttempt >= 8 || row.retryStormPct >= 50 ? 'critical' : 'high',
        score:
          70 +
          row.stormEvents * 10 +
          row.maxAttempt * 5 +
          Math.min(60, row.totalWastedMs / 10_000),
        reason:
          `${row.stormEvents}/${row.totalEvents} failed API event` +
          `${row.totalEvents === 1 ? '' : 's'} hit retry-storm attempts; ` +
          `${fmtDuration(row.totalWastedMs)} dead wall-clock, max attempt ${row.maxAttempt}.`,
        evidenceView: 'report-card',
      });
      continue;
    }

    if (row.totalWastedMs >= 60_000) {
      addSignal(bySession, row.session_id, {
        category: 'speed',
        severity: 'medium',
        score: 45 + Math.min(50, row.totalWastedMs / 10_000),
        reason: `${fmtDuration(row.totalWastedMs)} dead wall-clock in failed API events.`,
        evidenceView: 'report-card',
      });
    }
  }
}

function addContextSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  for (const row of scoreSessionHealth(input.tokenData)) {
    if (row.score >= LOW_HEALTH_SCORE) continue;
    addSignal(bySession, row.sessionId, {
      category: 'context',
      severity: row.score <= 30 ? 'high' : 'medium',
      score: 50 + (LOW_HEALTH_SCORE - row.score),
      reason: row.reasons.join('; ') || `Context health score ${row.score}.`,
      evidenceView: 'context',
    });
  }
}

function addOutcomeSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  const outcomes = computeSessionOutcomes(
    input.timelines,
    input.tokenData,
    input.toolData,
    input.apiErrors,
    new Map()
  );
  for (const [sessionId, outcome] of outcomes) {
    if (outcome.good) continue;
    addSignal(bySession, sessionId, {
      category: 'outcome',
      severity: outcome.anchor === 'label' ? 'high' : 'low',
      score: outcome.anchor === 'label' ? 70 : 35,
      reason:
        outcome.anchor === 'label'
          ? 'Session was labelled as a bad outcome.'
          : 'Outcome proxy marked the session as likely unsuccessful.',
      evidenceView: 'patterns',
    });
  }
}

function buildReason(top: ReviewQueueSignal, signals: ReviewQueueSignal[]): string {
  const secondary = Array.from(new Set(signals
    .filter((signal) => signal !== top)
    .map((signal) => signal.category)
    .filter((category) => category !== top.category)))
    .slice(0, 2)
    .map((category) => CATEGORY_LABEL[category].toLowerCase());
  if (secondary.length === 0) return top.reason;
  return `${top.reason} Also flagged for ${secondary.join(' and ')}.`;
}

export function buildReviewQueue(input: ReviewQueueInput): ReviewQueueItem[] {
  const bySession = new Map<string, ReviewQueueSignal[]>();

  addCostSignals(input, bySession);
  addToolErrorSignals(input, bySession);
  addDebugSignals(input, bySession);
  addTelemetrySignals(input, bySession);
  addContextSignals(input, bySession);
  addOutcomeSignals(input, bySession);

  const items: ReviewQueueItem[] = [];
  for (const [sessionId, rawSignals] of bySession) {
    const signals = rawSignals.slice().sort(compareSignals);
    const top = signals[0];
    const extraScore = signals
      .slice(1)
      .reduce((sum, signal) => sum + Math.min(15, signal.score / 10), 0);
    items.push({
      id: `${sessionId}:${top.category}`,
      sessionId,
      category: top.category,
      severity: top.severity,
      score: top.score + extraScore,
      reason: buildReason(top, signals),
      evidenceView: top.evidenceView,
      evidenceLabel: VIEW_LABEL[top.evidenceView] ?? top.evidenceView,
      signals,
    });
  }

  return items.sort((a, b) => {
    const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severity !== 0) return severity;
    if (b.score !== a.score) return b.score - a.score;
    return a.sessionId.localeCompare(b.sessionId);
  });
}
