import { describe, expect, it } from 'vitest';
import type { SessionTokenData, TokenEntry } from '../types';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import type { TelemetryEnvFingerprint, TelemetryEvent } from './parse-telemetry';
import type { SessionTimeline } from './parse-timeline';
import {
  buildReviewQueue,
  type ReviewQueueInput,
  type ReviewQueueSignal,
} from './review-queue';
import { validateClaimProvenance } from './claim-provenance';

const EMPTY_INPUT: ReviewQueueInput = {
  tokenData: [],
  toolData: [],
  timelines: [],
  apiErrors: [],
  debugLogs: [],
  telemetry: [],
};

const ENV: TelemetryEnvFingerprint = {
  node_version: 'v24.3.0',
  terminal: 'xterm',
  wsl_version: '',
  linux_distro_id: 'fedora',
  arch: 'x64',
  build_time: '2026-06-01T00:00:00.000Z',
};

function tokenEntry(overrides: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: '2026-06-01T00:00:00.000Z',
    inputTokens: 1_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-opus-4-8',
    ...overrides,
  };
}

function tokenData(
  sessionId: string,
  entries: TokenEntry[],
  overrides: Partial<SessionTokenData> = {}
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: entries.reduce((sum, row) => sum + row.outputTokens, 0),
    totalCacheCreationTokens: entries.reduce(
      (sum, row) => sum + row.cacheCreationTokens,
      0
    ),
    totalCacheReadTokens: entries.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    model: entries[0]?.model ?? 'claude-opus-4-8',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
    ...overrides,
  };
}

function toolCall(
  toolName: string,
  isError: boolean,
  index: number
): ToolCall {
  return {
    timestamp: `2026-06-01T00:00:0${index}.000Z`,
    toolName,
    input: {},
    toolUseId: `tool-${index}`,
    isError,
    resultBytes: 10,
  };
}

function toolData(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls };
}

function apiError(
  sessionId: string,
  retryAttempt: number | undefined = undefined
): ApiErrorEvent {
  return {
    sessionId,
    timestamp: '2026-06-01T00:00:00.000Z',
    summary: 'overloaded',
    source: 'native',
    status: 529,
    retryAttempt,
    maxRetries: 11,
  };
}

function telemetryEvent(
  sessionId: string,
  attempt: number,
  elapsed_ms = 30_001
): TelemetryEvent {
  return {
    event_name: 'tengu_api_slow_first_byte',
    client_timestamp: '2026-06-01T00:00:00.000Z',
    model: 'claude-opus-4-8',
    betas: '',
    session_id: sessionId,
    attempt,
    elapsed_ms,
    env: ENV,
  };
}

describe('buildReviewQueue', () => {
  it('ranks an expensive failing session ahead of the rest of the cost cluster', () => {
    const queue = buildReviewQueue({
      ...EMPTY_INPUT,
      tokenData: [
        tokenData('expensive-fail', [
          tokenEntry({ inputTokens: 1_000_000, outputTokens: 50_000 }),
        ]),
        ...['cheap-a', 'cheap-b', 'cheap-c', 'cheap-d'].map((id) =>
          tokenData(id, [tokenEntry({ inputTokens: 1_000 })])
        ),
      ],
      toolData: [
        toolData('expensive-fail', [
          toolCall('Read', true, 1),
          toolCall('Read', true, 2),
          toolCall('Bash', true, 3),
          toolCall('Bash', false, 4),
        ]),
      ],
      apiErrors: [
        apiError('expensive-fail', 1),
        apiError('expensive-fail', 2),
        apiError('expensive-fail', 3),
      ],
    });

    expect(queue[0].sessionId).toBe('expensive-fail');
    expect(queue[0].category).toBe('cost');
    expect(queue[0].severity).toBe('high');
    expect(queue[0].reason).toContain('estimated spend');
    expect(queue[0].signals.map((signal) => signal.category)).toEqual(
      expect.arrayContaining(['cost', 'reliability'])
    );
  });

  it('collapses retry telemetry, debug retries, API errors, and tool errors into one session row', () => {
    const queue = buildReviewQueue({
      ...EMPTY_INPUT,
      toolData: [
        toolData('retry-storm', [
          toolCall('Bash', true, 1),
          toolCall('Bash', true, 2),
          toolCall('Bash', true, 3),
          toolCall('Bash', true, 4),
          toolCall('Read', false, 5),
          toolCall('Read', false, 6),
        ]),
      ],
      apiErrors: [
        apiError('retry-storm', 2),
        apiError('retry-storm', 3),
        apiError('retry-storm', 4),
      ],
      debugLogs: [
        {
          sessionId: 'retry-storm',
          ttfbP50: 1_500,
          ttfbP90: 7_500,
          ttfbMax: 8_000,
          ttfbSampleCount: 5,
          maxRetryAttempt: 5,
          slowFirstByteCount: 2,
          fastModeLostCount: 0,
        },
      ],
      telemetry: [
        telemetryEvent('retry-storm', 4),
        telemetryEvent('retry-storm', 5),
      ],
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      sessionId: 'retry-storm',
      category: 'reliability',
      severity: 'critical',
      evidenceView: 'report-card',
    });
    expect(queue[0].signals.length).toBeGreaterThanOrEqual(5);
    expect(queue[0].reason).toContain('dead wall-clock');
  });

  it('flags context-pressure sessions without requiring cost to be billable', () => {
    const queue = buildReviewQueue({
      ...EMPTY_INPUT,
      tokenData: [
        tokenData(
          'context-pressure',
          [
            tokenEntry({
              model: '<synthetic>',
              inputTokens: 600_000,
              cacheCreationTokens: 20_000,
              cacheCreation1hTokens: 0,
              cacheReadTokens: 0,
            }),
          ],
          {
            totalCacheCreationTokens: 20_000,
            totalCacheReadTokens: 0,
            compactionEvents: Array.from({ length: 3 }, (_, index) => ({
              timestamp: `2026-06-01T00:1${index}:00.000Z`,
              beforeContext: 620_000,
              afterContext: 80_000,
              reductionPercent: 87,
            })),
          }
        ),
      ],
    });

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      sessionId: 'context-pressure',
      category: 'context',
      severity: 'high',
      evidenceView: 'context',
    });
    expect(queue[0].reason).toContain('Peak context: 620k');
  });

  it('emits row-addressed, score-reproducible provenance for every signal path (#3171)', () => {
    const expensive = tokenData('expensive', [
      tokenEntry({ inputTokens: 1_000_000, outputTokens: 50_000 }),
    ]);
    const retryInput: ReviewQueueInput = {
      ...EMPTY_INPUT,
      tokenData: [
        expensive,
        ...['cheap-a', 'cheap-b', 'cheap-c'].map((id) =>
          tokenData(id, [tokenEntry({ inputTokens: 1_000 })])
        ),
      ],
      toolData: [
        toolData('expensive', [
          toolCall('Edit', true, 1),
          toolCall('Edit', true, 2),
          toolCall('Edit', true, 3),
          toolCall('Edit', false, 4),
        ]),
      ],
      apiErrors: [
        apiError('expensive', 2),
        apiError('expensive', 3),
        apiError('expensive', 4),
      ],
      debugLogs: [
        {
          sessionId: 'expensive',
          ttfbP50: 1_500,
          ttfbP90: 7_500,
          ttfbMax: 8_000,
          ttfbSampleCount: 5,
          maxRetryAttempt: 5,
          slowFirstByteCount: 2,
          fastModeLostCount: 0,
        },
      ],
      telemetry: [
        telemetryEvent('expensive', 4),
        telemetryEvent('expensive', 5),
      ],
    };
    const contextInput: ReviewQueueInput = {
      ...EMPTY_INPUT,
      tokenData: [
        tokenData(
          'context-proof',
          [
            tokenEntry({
              model: '<synthetic>',
              inputTokens: 600_000,
              cacheCreationTokens: 20_000,
            }),
          ],
          {
            totalCacheCreationTokens: 20_000,
            compactionEvents: Array.from({ length: 3 }, (_, index) => ({
              timestamp: `2026-06-01T00:1${index}:00.000Z`,
              beforeContext: 620_000,
              afterContext: 80_000,
              reductionPercent: 87,
            })),
          }
        ),
      ],
    };
    const timeline = (sessionId: string): SessionTimeline => ({
      sessionId,
      startTime: '2026-06-01T00:00:00.000Z',
      endTime: '2026-06-01T00:10:00.000Z',
      entries: [
        {
          timestamp: '2026-06-01T00:00:00.000Z',
          kind: 'user',
          summary: 'work',
        },
      ],
    });
    const outcomeInput: ReviewQueueInput = {
      ...EMPTY_INPUT,
      timelines: [timeline('bad-outcome'), timeline('good-outcome')],
      tokenData: [
        tokenData(
          'bad-outcome',
          [tokenEntry({ inputTokens: 1_000_000 })],
          {
            compactionEvents: [
              {
                timestamp: '2026-06-01T00:05:00.000Z',
                beforeContext: 1_000,
                afterContext: 500,
                reductionPercent: 50,
              },
            ],
          }
        ),
        tokenData('good-outcome', [tokenEntry({ inputTokens: 1_000 })]),
      ],
      toolData: [
        toolData('bad-outcome', [toolCall('Read', true, 1)]),
        toolData('good-outcome', [toolCall('Read', false, 1)]),
      ],
    };

    const signals = [
      ...buildReviewQueue(retryInput).flatMap((item) => item.signals),
      ...buildReviewQueue(contextInput).flatMap((item) => item.signals),
      ...buildReviewQueue(outcomeInput).flatMap((item) => item.signals),
    ];
    const sources = new Set(
      signals.flatMap((signal) =>
        signal.provenance.observations.map((observation) => observation.source)
      )
    );
    for (const expected of [
      'parse-sessions',
      'parse-tools',
      'parse-errors',
      'parse-debug',
      'parse-telemetry',
      'context-health',
      'parse-timeline-success',
    ]) {
      expect(sources.has(expected), `missing ${expected}`).toBe(true);
    }

    const assertSignalReceipt = (signal: ReviewQueueSignal) => {
      expect(validateClaimProvenance(signal.provenance)).toEqual([]);
      expect(
        signal.provenance.observations.every(
          (observation) =>
            Boolean(observation.source) &&
            Boolean(observation.record) &&
            Boolean(observation.field) &&
            observation.value !== undefined
        )
      ).toBe(true);
      const score = signal.provenance.derivations?.find(
        (derivation) => derivation.id === 'review-queue.score'
      );
      expect(score).toBeDefined();
      expect(score!.formula).toBe('sum(score components)');
      const reproduced = Object.values(score!.operands).reduce(
        (sum, component) => sum + Number(component),
        0
      );
      expect(reproduced).toBeCloseTo(signal.score, 10);
      expect(score!.value).toBe(signal.score);
    };
    signals.forEach(assertSignalReceipt);
  });
});
