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
import type {
  ClaimDerivation,
  ClaimObservation,
  ClaimProvenance,
} from './claim-provenance';

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
  /** Row-addressed observations plus reproducible metric/score arithmetic. */
  provenance: ClaimProvenance;
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

function observation(
  claim: string,
  source: string,
  record: string,
  field: string,
  value: string | number | boolean
): ClaimObservation {
  return { claim, source, record, field, value };
}

function scoredReceipt(
  observations: ClaimObservation[],
  derivations: ClaimDerivation[],
  scoreComponents: Record<string, number>,
  inference: string
): { score: number; provenance: ClaimProvenance } {
  const score = Object.values(scoreComponents).reduce(
    (sum, component) => sum + component,
    0
  );
  return {
    score,
    provenance: {
      observations,
      derivations: [
        ...derivations,
        {
          id: 'review-queue.score',
          formula: 'sum(score components)',
          operands: scoreComponents,
          value: score,
        },
      ],
      inference,
    },
  };
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
    const receipt = scoredReceipt(
      [
        observation(
          `session ${row.sessionId} incurred ${row.estimatedCost} estimated USD`,
          'parse-sessions',
          row.sessionId,
          'estimateCost(tokenData)',
          row.estimatedCost
        ),
        observation(
          `the top 3 sessions incurred ${top3Cost} estimated USD`,
          'parse-sessions',
          'fleet',
          'topExpensiveSessions[0:3].estimatedCost',
          top3Cost
        ),
        observation(
          `all loaded sessions incurred ${totalCost} estimated USD`,
          'parse-sessions',
          'fleet',
          'tokenData[].estimateCost',
          totalCost
        ),
        ...(row.topTool
          ? [
              observation(
                `${row.topTool} was the session's most-used tool`,
                'parse-tools',
                row.sessionId,
                'topExpensiveSessions().topTool',
                row.topTool
              ),
            ]
          : []),
      ],
      [
        {
          id: 'cost.top3SharePct',
          formula: '100 * top3Cost / totalCost',
          operands: { top3Cost, totalCost, minimumSharePct: 25 },
          value: share,
        },
      ],
      {
        base: 70,
        top3SharePct: share,
        estimatedCostWeight: row.estimatedCost * 10,
      },
      'High estimated spend inside a concentrated top-three cluster makes this session a review candidate.'
    );
    addSignal(bySession, row.sessionId, {
      category: 'cost',
      severity: row.estimatedCost >= MIN_SAVINGS_USD ? 'high' : 'medium',
      score: receipt.score,
      reason:
        `${fmtUsd(row.estimatedCost)} estimated spend; top 3 sessions account ` +
        `for ${share.toFixed(0)}% of total spend` +
        (row.topTool ? `, led by ${row.topTool}` : '') +
        '.',
      evidenceView: 'cost',
      provenance: receipt.provenance,
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
    const receipt = scoredReceipt(
      [
        observation(
          `${errors} tool calls recorded an error outcome`,
          'parse-tools',
          row.sessionId,
          'calls[].isError',
          errors
        ),
        observation(
          `${total} tool calls were recorded`,
          'parse-tools',
          row.sessionId,
          'calls.length',
          total
        ),
      ],
      [
        {
          id: 'tool-errors.errorRate',
          formula: 'errors / totalCalls',
          operands: {
            errors,
            totalCalls: total,
            minimumErrors: 2,
            minimumErrorRate: 0.3,
          },
          value: errorRate,
        },
      ],
      {
        base: 55,
        errorCountWeight: errors * 6,
        errorRateWeight: errorRate * 30,
      },
      'The observed error count/rate crossed the review threshold.'
    );
    addSignal(bySession, row.sessionId, {
      category: 'reliability',
      severity: errors >= 5 || errorRate >= 0.5 ? 'high' : 'medium',
      score: receipt.score,
      reason: `${errors}/${total} tool calls errored (${Math.round(errorRate * 100)}%).`,
      evidenceView: 'errors',
      provenance: receipt.provenance,
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
    const receipt = scoredReceipt(
      [
        observation(
          `${row.count} API error events were recorded`,
          'parse-errors',
          sessionId,
          'apiErrors.length',
          row.count
        ),
        observation(
          `the maximum API retry attempt was ${row.maxRetryAttempt}`,
          'parse-errors',
          sessionId,
          'apiErrors[].retryAttempt',
          row.maxRetryAttempt
        ),
      ],
      [
        {
          id: 'api-errors.threshold',
          formula:
            'count >= minimumCount || maxRetryAttempt >= retryStormThreshold',
          operands: {
            count: row.count,
            minimumCount: 3,
            maxRetryAttempt: row.maxRetryAttempt,
            retryStormThreshold: RETRY_STORM_THRESHOLD,
          },
          value:
            row.count >= 3 ||
            row.maxRetryAttempt >= RETRY_STORM_THRESHOLD,
        },
      ],
      {
        base: 55,
        errorCountWeight: row.count * 5,
        retryAttemptWeight: row.maxRetryAttempt * 8,
      },
      'The API error count or retry attempt crossed the review threshold.'
    );
    addSignal(bySession, sessionId, {
      category: 'reliability',
      severity: row.maxRetryAttempt >= RETRY_STORM_THRESHOLD ? 'high' : 'medium',
      score: receipt.score,
      reason:
        `${row.count} API error${row.count === 1 ? '' : 's'}` +
        (row.maxRetryAttempt > 0 ? `, max retry attempt ${row.maxRetryAttempt}` : '') +
        '.',
      evidenceView: 'errors',
      provenance: receipt.provenance,
    });
  }
}

function addDebugSignals(
  input: ReviewQueueInput,
  bySession: Map<string, ReviewQueueSignal[]>
): void {
  for (const row of input.debugLogs) {
    if (row.maxRetryAttempt >= RETRY_STORM_THRESHOLD) {
      const receipt = scoredReceipt(
        [
          observation(
            `debug logs reached retry attempt ${row.maxRetryAttempt}`,
            'parse-debug',
            row.sessionId,
            'maxRetryAttempt',
            row.maxRetryAttempt
          ),
        ],
        [
          {
            id: 'debug.retryThreshold',
            formula: 'maxRetryAttempt >= retryStormThreshold',
            operands: {
              maxRetryAttempt: row.maxRetryAttempt,
              retryStormThreshold: RETRY_STORM_THRESHOLD,
            },
            value: true,
          },
        ],
        {
          base: 70,
          retryAttemptWeight: row.maxRetryAttempt * 8,
        },
        'The maximum debug-log retry attempt crossed the retry-storm threshold.'
      );
      addSignal(bySession, row.sessionId, {
        category: 'reliability',
        severity: row.maxRetryAttempt >= 8 ? 'critical' : 'high',
        score: receipt.score,
        reason: `Debug log reached API retry attempt ${row.maxRetryAttempt}.`,
        evidenceView: 'report-card',
        provenance: receipt.provenance,
      });
    }

    if (row.ttfbSampleCount > 0 && row.ttfbP90 >= 5_000) {
      const ttfbWeight = Math.min(80, row.ttfbP90 / 500);
      const receipt = scoredReceipt(
        [
          observation(
            `debug logs recorded p90 TTFB ${row.ttfbP90}ms`,
            'parse-debug',
            row.sessionId,
            'ttfbP90',
            row.ttfbP90
          ),
          observation(
            `${row.ttfbSampleCount} TTFB samples contributed`,
            'parse-debug',
            row.sessionId,
            'ttfbSampleCount',
            row.ttfbSampleCount
          ),
        ],
        [
          {
            id: 'debug.ttfbThreshold',
            formula: 'ttfbSampleCount > 0 && ttfbP90 >= floorMs',
            operands: {
              ttfbSampleCount: row.ttfbSampleCount,
              ttfbP90: row.ttfbP90,
              floorMs: 5_000,
            },
            value: true,
          },
        ],
        { base: 55, ttfbWeight },
        'The measured p90 time-to-first-byte crossed the review threshold.'
      );
      addSignal(bySession, row.sessionId, {
        category: 'speed',
        severity: row.ttfbP90 >= 30_000 ? 'critical' : 'high',
        score: receipt.score,
        reason:
          `p90 time-to-first-byte was ${fmtDuration(row.ttfbP90)} ` +
          `across ${row.ttfbSampleCount} sample${row.ttfbSampleCount === 1 ? '' : 's'}.`,
        evidenceView: 'report-card',
        provenance: receipt.provenance,
      });
    }

    if (row.slowFirstByteCount > 0) {
      const receipt = scoredReceipt(
        [
          observation(
            `${row.slowFirstByteCount} slow-first-byte stalls were recorded`,
            'parse-debug',
            row.sessionId,
            'slowFirstByteCount',
            row.slowFirstByteCount
          ),
        ],
        [
          {
            id: 'debug.slowFirstByteThreshold',
            formula: 'slowFirstByteCount > 0',
            operands: { slowFirstByteCount: row.slowFirstByteCount },
            value: true,
          },
        ],
        { base: 45, stallCountWeight: row.slowFirstByteCount * 10 },
        'At least one slow-first-byte stall was observed.'
      );
      addSignal(bySession, row.sessionId, {
        category: 'speed',
        severity: row.slowFirstByteCount >= 3 ? 'high' : 'medium',
        score: receipt.score,
        reason:
          `${row.slowFirstByteCount} slow-first-byte stall` +
          `${row.slowFirstByteCount === 1 ? '' : 's'} recorded in debug logs.`,
        evidenceView: 'report-card',
        provenance: receipt.provenance,
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
      const wastedWeight = Math.min(60, row.totalWastedMs / 10_000);
      const receipt = scoredReceipt(
        [
          observation(
            `${row.stormEvents} retry-storm events were observed`,
            'parse-telemetry',
            row.session_id,
            'stormEvents',
            row.stormEvents
          ),
          observation(
            `${row.totalEvents} failed API events were observed`,
            'parse-telemetry',
            row.session_id,
            'totalEvents',
            row.totalEvents
          ),
          observation(
            `maximum retry attempt was ${row.maxAttempt}`,
            'parse-telemetry',
            row.session_id,
            'maxAttempt',
            row.maxAttempt
          ),
          observation(
            `${row.totalWastedMs}ms total dead wall-clock was observed`,
            'parse-telemetry',
            row.session_id,
            'totalWastedMs',
            row.totalWastedMs
          ),
        ],
        [
          {
            id: 'telemetry.retryStormPct',
            formula: 'round(100 * stormEvents / totalEvents)',
            operands: {
              stormEvents: row.stormEvents,
              totalEvents: row.totalEvents,
              retryStormThreshold: RETRY_STORM_THRESHOLD,
            },
            value: row.retryStormPct,
          },
        ],
        {
          base: 70,
          stormEventWeight: row.stormEvents * 10,
          maxAttemptWeight: row.maxAttempt * 5,
          wastedTimeWeight: wastedWeight,
        },
        'Retry-storm telemetry crossed the attempt/rate review threshold.'
      );
      addSignal(bySession, row.session_id, {
        category: 'reliability',
        severity: row.maxAttempt >= 8 || row.retryStormPct >= 50 ? 'critical' : 'high',
        score: receipt.score,
        reason:
          `${row.stormEvents}/${row.totalEvents} failed API event` +
          `${row.totalEvents === 1 ? '' : 's'} hit retry-storm attempts; ` +
          `${fmtDuration(row.totalWastedMs)} dead wall-clock, max attempt ${row.maxAttempt}.`,
        evidenceView: 'report-card',
        provenance: receipt.provenance,
      });
      continue;
    }

    if (row.totalWastedMs >= 60_000) {
      const wastedWeight = Math.min(50, row.totalWastedMs / 10_000);
      const receipt = scoredReceipt(
        [
          observation(
            `${row.totalWastedMs}ms total dead wall-clock was observed`,
            'parse-telemetry',
            row.session_id,
            'totalWastedMs',
            row.totalWastedMs
          ),
        ],
        [
          {
            id: 'telemetry.wastedThreshold',
            formula: 'totalWastedMs >= floorMs',
            operands: {
              totalWastedMs: row.totalWastedMs,
              floorMs: 60_000,
            },
            value: true,
          },
        ],
        { base: 45, wastedTimeWeight: wastedWeight },
        'Failed API events accumulated at least one minute of dead wall-clock.'
      );
      addSignal(bySession, row.session_id, {
        category: 'speed',
        severity: 'medium',
        score: receipt.score,
        reason: `${fmtDuration(row.totalWastedMs)} dead wall-clock in failed API events.`,
        evidenceView: 'report-card',
        provenance: receipt.provenance,
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
    const receipt = scoredReceipt(
      [
        observation(
          `context health score was ${row.score}`,
          'context-health',
          row.sessionId,
          'scoreSessionHealth().score',
          row.score
        ),
        observation(
          `${row.reasons.length} context-health reasons contributed`,
          'context-health',
          row.sessionId,
          'scoreSessionHealth().reasons.length',
          row.reasons.length
        ),
        ...row.reasons.map((reason, index) =>
          observation(
            `context-health reason ${index + 1} was ${reason}`,
            'context-health',
            row.sessionId,
            `scoreSessionHealth().reasons[${index}]`,
            reason
          )
        ),
      ],
      [
        {
          id: 'context.healthThreshold',
          formula: 'healthScore < lowHealthScore',
          operands: {
            healthScore: row.score,
            lowHealthScore: LOW_HEALTH_SCORE,
          },
          value: true,
        },
      ],
      { base: 50, healthDeficit: LOW_HEALTH_SCORE - row.score },
      'The deterministic context-health score fell below the review floor.'
    );
    addSignal(bySession, row.sessionId, {
      category: 'context',
      severity: row.score <= 30 ? 'high' : 'medium',
      score: receipt.score,
      reason: row.reasons.join('; ') || `Context health score ${row.score}.`,
      evidenceView: 'context',
      provenance: receipt.provenance,
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
    const score = outcome.anchor === 'label' ? 70 : 35;
    const receipt = scoredReceipt(
      [
        observation(
          'the session outcome was classified as unsuccessful',
          'parse-timeline-success',
          sessionId,
          'computeSessionOutcomes().good',
          outcome.good
        ),
        observation(
          `the outcome used the ${outcome.anchor} anchor`,
          'parse-timeline-success',
          sessionId,
          'computeSessionOutcomes().anchor',
          outcome.anchor
        ),
      ],
      [
        {
          id: 'outcome.reviewPosture',
          formula: 'anchor == label ? high : low',
          operands: {
            labelled: outcome.anchor === 'label',
            unsuccessful: !outcome.good,
          },
          value: outcome.anchor === 'label' ? 'high' : 'low',
        },
      ],
      { outcomeWeight: score },
      outcome.anchor === 'label'
        ? 'A user label is treated as the authoritative unsuccessful outcome.'
        : 'The deterministic cleanliness proxy marked this session likely unsuccessful.'
    );
    addSignal(bySession, sessionId, {
      category: 'outcome',
      severity: outcome.anchor === 'label' ? 'high' : 'low',
      score: receipt.score,
      reason:
        outcome.anchor === 'label'
          ? 'Session was labelled as a bad outcome.'
          : 'Outcome proxy marked the session as likely unsuccessful.',
      evidenceView: 'patterns',
      provenance: receipt.provenance,
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
