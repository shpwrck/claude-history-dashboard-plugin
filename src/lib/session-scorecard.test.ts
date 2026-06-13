import { describe, expect, it } from 'vitest';
import type {
  AssistantFeatures,
  SessionTokenData,
  TokenEntry,
} from '../types';
import type { ApiErrorEvent } from './parse-errors';
import type { ToolCall, ToolUsageData } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import {
  SCORECARD_AXIS_IDS,
  computeSessionScorecard,
  scorecardAxis,
} from './session-scorecard';

const baseTime = '2026-01-01T00:00:00.000Z';

function tokenEntry(partial: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: baseTime,
    inputTokens: 2_000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 4_000,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-opus-4-8',
    ...partial,
  };
}

function tokenData(partial: Partial<SessionTokenData> = {}): SessionTokenData {
  return {
    sessionId: 'sess-1',
    totalInputTokens: 2_000,
    totalOutputTokens: 500,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 4_000,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [tokenEntry()],
    compactionEvents: [],
    hasUnknownModel: false,
    ...partial,
  };
}

function toolCall(toolName: string, partial: Partial<ToolCall> = {}): ToolCall {
  return {
    timestamp: baseTime,
    toolName,
    input: {},
    toolUseId: `${toolName}-1`,
    isError: false,
    resultBytes: 0,
    ...partial,
  };
}

function toolData(calls: ToolCall[] = [toolCall('Read'), toolCall('Edit')]): ToolUsageData {
  return { sessionId: 'sess-1', calls };
}

function timeline(partial: Partial<SessionTimeline> = {}): SessionTimeline {
  return {
    sessionId: 'sess-1',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:06:00.000Z',
    entries: [
      { timestamp: '2026-01-01T00:00:00.000Z', kind: 'user', summary: 'implement this' },
      { timestamp: '2026-01-01T00:06:00.000Z', kind: 'assistant', summary: 'done' },
    ],
    ...partial,
  };
}

const assistantFeatures: AssistantFeatures = {
  sessionId: 'sess-1',
  assistantTurnCount: 2,
  textLength: 1000,
  codeBlockCount: 2,
  toolCallCount: 2,
  refusalCount: 0,
  hedgingCount: 0,
  endsWithQuestionCount: 0,
  thinkingByteLen: 0,
};

describe('computeSessionScorecard', () => {
  it('returns all stable axes for a healthy session', () => {
    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData(),
      timeline: timeline(),
      apiErrors: [],
      permissionRows: [{ sessionId: 'sess-1', mode: 'default' }],
      assistantFeatures,
    });

    expect(scorecard.axes.map((axis) => axis.id)).toEqual(SCORECARD_AXIS_IDS);
    expect(scorecard.axes.map((axis) => axis.id)).toContain('outcome');
    expect(scorecardAxis(scorecard, 'outcome').label).toBe('Outcome');
    expect(scorecard.axes.every((axis) => axis.score >= 70)).toBe(true);
    expect(scorecard.axes.every((axis) => axis.evidence.length > 0)).toBe(true);
    expect(scorecard.axes.some((axis) => axis.confidence === 'high')).toBe(true);
    expect(scorecardAxis(scorecard, 'security')).toMatchObject({
      score: 100,
      confidence: 'high',
    });
    expect(scorecardAxis(scorecard, 'portability')).toMatchObject({
      score: 100,
      confidence: 'high',
    });
    expect(scorecardAxis(scorecard, 'reliability')).toMatchObject({
      score: 100,
      confidence: 'high',
    });
    expect(scorecardAxis(scorecard, 'focus')).toMatchObject({
      score: 100,
      confidence: 'high',
    });
  });

  it('scores proxy-anchored Outcome from deterministic session signals', () => {
    const clean = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData([toolCall('Read'), toolCall('Edit')]),
      timeline: timeline(),
      apiErrors: [],
      sessionOutcome: { good: true, anchor: 'proxy' },
    });
    const noisy = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData({
        compactionEvents: [
          {
            timestamp: '2026-01-01T00:31:00.000Z',
            beforeContext: 180_000,
            afterContext: 60_000,
            reductionPercent: 67,
          },
        ],
      }),
      toolData: toolData([toolCall('Read', { isError: true }), toolCall('Edit')]),
      timeline: timeline(),
      apiErrors: [
        { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded' },
      ],
      sessionOutcome: { good: false, anchor: 'proxy' },
    });

    const cleanOutcome = scorecardAxis(clean, 'outcome');
    const noisyOutcome = scorecardAxis(noisy, 'outcome');

    expect(cleanOutcome.confidence).toBe('medium');
    expect(cleanOutcome.score).toBeGreaterThan(noisyOutcome.score);
    expect(noisyOutcome.score).not.toBe(75);
    expect(cleanOutcome.evidence.join(' ')).toContain('deterministic proxy');
  });

  it('marks label-anchored Outcome as high confidence', () => {
    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData(),
      timeline: timeline(),
      apiErrors: [],
      sessionOutcome: { good: true, anchor: 'label' },
    });

    const outcome = scorecardAxis(scorecard, 'outcome');
    expect(outcome.confidence).toBe('high');
    expect(outcome.evidence.join(' ')).toContain('session label');
  });

  it('penalizes expensive high-context sessions on cost and focus', () => {
    const bloated = tokenData({
      totalInputTokens: 1_500_000,
      totalOutputTokens: 150_000,
      totalCacheCreationTokens: 300_000,
      totalCacheReadTokens: 0,
      entries: [
        tokenEntry({
          timestamp: '2026-01-01T00:00:00.000Z',
          inputTokens: 10_000,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
        tokenEntry({
          timestamp: '2026-01-01T00:30:00.000Z',
          inputTokens: 240_000,
          outputTokens: 20_000,
          cacheCreationTokens: 20_000,
          cacheReadTokens: 0,
        }),
      ],
      compactionEvents: [
        {
          timestamp: '2026-01-01T00:31:00.000Z',
          beforeContext: 240_000,
          afterContext: 50_000,
          reductionPercent: 79,
        },
      ],
    });

    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: bloated,
      toolData: toolData(),
      timeline: timeline(),
      apiErrors: [],
    });

    expect(scorecardAxis(scorecard, 'cost').score).toBeLessThan(50);
    expect(scorecardAxis(scorecard, 'focus').score).toBeLessThan(60);
    expect(scorecardAxis(scorecard, 'cost').evidence.join(' ')).toContain('Peak context');
  });

  it('penalizes error-heavy and dangerous sessions on reliability and security', () => {
    const apiErrors: ApiErrorEvent[] = [
      { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded', retryAttempt: 2 },
      { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded', retryAttempt: 3 },
    ];
    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData([
        toolCall('Bash', {
          input: { command: 'rm -rf build' },
          isError: true,
        }),
        toolCall('Edit', { isError: true }),
      ]),
      timeline: timeline(),
      apiErrors,
      permissionRows: [{ sessionId: 'sess-1', mode: 'bypassPermissions' }],
    });

    expect(scorecardAxis(scorecard, 'reliability').score).toBeLessThan(60);
    expect(scorecardAxis(scorecard, 'security').score).toBeLessThan(50);
    expect(scorecardAxis(scorecard, 'security').evidence.join(' ')).toContain(
      'dangerous command'
    );
  });

  it('pulls medium-confidence floor-at-100 axes toward neutral', () => {
    const toolsOnly = computeSessionScorecard({
      sessionId: 'sess-1',
      toolData: toolData([toolCall('Read')]),
    });
    const apiOnly = computeSessionScorecard({
      sessionId: 'sess-1',
      apiErrors: [
        { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded' },
      ],
    });

    expect(scorecardAxis(toolsOnly, 'security')).toMatchObject({
      score: 70,
      confidence: 'medium',
    });
    expect(scorecardAxis(toolsOnly, 'portability')).toMatchObject({
      score: 70,
      confidence: 'medium',
    });
    expect(scorecardAxis(toolsOnly, 'focus')).toMatchObject({
      score: 70,
      confidence: 'medium',
    });
    expect(scorecardAxis(apiOnly, 'reliability')).toMatchObject({
      score: 66,
      confidence: 'medium',
    });
  });

  it('keeps partial-data sessions renderable with low-confidence evidence', () => {
    const scorecard = computeSessionScorecard({ sessionId: 'partial' });

    expect(scorecard.axes).toHaveLength(SCORECARD_AXIS_IDS.length);
    expect(scorecard.axes.every((axis) => axis.confidence === 'low')).toBe(true);
    expect(scorecard.axes.every((axis) => axis.evidence[0].includes('No '))).toBe(true);
    expect(scorecard.axes.every((axis) => axis.score === 50)).toBe(true);
  });
});
