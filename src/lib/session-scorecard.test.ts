import { describe, expect, it } from 'vitest';
import type {
  AssistantFeatures,
  SessionTokenData,
  TokenEntry,
} from '../types';
import type { ApiErrorEvent } from './parse-errors';
import {
  deriveBashCommandSignals,
  stripToolCommandBodies,
  type ToolCall,
  type ToolUsageData,
} from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import type { RuntimeEvents } from './parse-runtime-events';
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

function runtimeEvents(
  stopTimestamps: string[],
  errorTimestamps: string[] = []
): RuntimeEvents {
  const errored = new Set(errorTimestamps);
  return {
    sessionId: 'sess-1',
    turns: [],
    stopHooks: stopTimestamps.map((timestamp) => ({
      sessionId: 'sess-1',
      timestamp,
      hookCount: 1,
      totalDurationMs: 0,
      hadErrors: errored.has(timestamp),
      preventedContinuation: false,
    })),
    awaySummaries: [],
    scheduledFires: [],
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

  it('applies a graduated cache-hit cost curve without a cliff at 50%', () => {
    const costScoreForCache = (read: number, created: number) =>
      scorecardAxis(
        computeSessionScorecard({
          sessionId: 'sess-1',
          tokenData: tokenData({
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: read,
            totalCacheCreationTokens: created,
            entries: [
              tokenEntry({
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: read,
                cacheCreationTokens: created,
              }),
            ],
          }),
        }),
        'cost'
      ).score;

    expect(costScoreForCache(0, 100)).toBeLessThan(costScoreForCache(25, 75));
    expect(costScoreForCache(25, 75)).toBeLessThan(costScoreForCache(50, 50));
    expect(costScoreForCache(50, 50)).toBeLessThan(costScoreForCache(75, 25));
    expect(costScoreForCache(75, 25)).toBeLessThan(costScoreForCache(100, 0));
    expect(costScoreForCache(49, 51)).toBe(costScoreForCache(50, 50));
    expect(costScoreForCache(50, 50)).toBe(costScoreForCache(51, 49));
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
          input: { command: 'rm -rf ~' },
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

  it('weights recovered API errors lighter than unrecovered API errors', () => {
    const recovered = computeSessionScorecard({
      sessionId: 'sess-1',
      apiErrors: [
        { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded' },
        {
          sessionId: 'sess-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          summary: 'overloaded',
          retryAttempt: 2,
          maxRetries: 3,
        },
      ],
      timeline: timeline({
        entries: [
          { timestamp: baseTime, kind: 'user', summary: 'start' },
          { timestamp: '2026-01-01T00:03:00.000Z', kind: 'assistant', summary: 'continued' },
        ],
      }),
    });
    const unrecovered = computeSessionScorecard({
      sessionId: 'sess-1',
      apiErrors: [
        { sessionId: 'sess-1', timestamp: baseTime, summary: 'overloaded' },
        {
          sessionId: 'sess-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          summary: 'overloaded',
        },
      ],
    });
    const recoveredReliability = scorecardAxis(recovered, 'reliability');
    const unrecoveredReliability = scorecardAxis(unrecovered, 'reliability');

    expect(recoveredReliability.score).toBeGreaterThan(unrecoveredReliability.score);
    expect(recoveredReliability.evidence.join(' ')).toContain('recovered API error');
    expect(unrecoveredReliability.evidence.join(' ')).toContain('unrecovered API error');
  });

  it('folds stop-hook errors into reliability', () => {
    const cleanHooks = computeSessionScorecard({
      sessionId: 'sess-1',
      runtimeEvents: runtimeEvents(['2026-01-01T00:05:00.000Z']),
    });
    const erroredHooks = computeSessionScorecard({
      sessionId: 'sess-1',
      runtimeEvents: runtimeEvents(
        ['2026-01-01T00:05:00.000Z'],
        ['2026-01-01T00:05:00.000Z']
      ),
    });
    const cleanReliability = scorecardAxis(cleanHooks, 'reliability');
    const erroredReliability = scorecardAxis(erroredHooks, 'reliability');

    expect(erroredReliability.score).toBeLessThan(cleanReliability.score);
    expect(erroredReliability.evidence.join(' ')).toContain('stop-hook error');
  });

  it('keeps explicit dangerous-command penalties high confidence with permission data', () => {
    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData([
        toolCall('Bash', {
          input: { command: 'rm -rf ~' },
        }),
      ]),
      permissionRows: [{ sessionId: 'sess-1', mode: 'default' }],
    });

    expect(scorecardAxis(scorecard, 'security')).toMatchObject({
      score: 70,
      confidence: 'high',
    });
  });

  it('lowers security confidence for ambiguous dangerous-command matches', () => {
    const scorecard = computeSessionScorecard({
      sessionId: 'sess-1',
      tokenData: tokenData(),
      toolData: toolData([
        toolCall('Bash', {
          input: { command: 'dd if=input.img of=copy.img bs=1m' },
        }),
      ]),
      permissionRows: [{ sessionId: 'sess-1', mode: 'default' }],
    });
    const security = scorecardAxis(scorecard, 'security');

    expect(security.confidence).toBe('medium');
    expect(security.score).toBe(66);
    expect(security.evidence.join(' ')).toContain('ambiguous dangerous command');
  });

  it('scores multi-task stop-hook sessions lower on focus than single-task sessions', () => {
    const sameContext = tokenData({
      messageCount: 3,
      entries: [
        tokenEntry({ timestamp: '2026-01-01T00:00:00.000Z' }),
        tokenEntry({ timestamp: '2026-01-01T00:10:00.000Z' }),
        tokenEntry({ timestamp: '2026-01-01T00:20:00.000Z' }),
      ],
    });
    const baseInput = {
      sessionId: 'sess-1',
      tokenData: sameContext,
      toolData: toolData(),
      timeline: timeline(),
    };
    const singleTask = computeSessionScorecard({
      ...baseInput,
      runtimeEvents: runtimeEvents(['2026-01-01T00:30:00.000Z']),
    });
    const multiTask = computeSessionScorecard({
      ...baseInput,
      runtimeEvents: runtimeEvents([
        '2026-01-01T00:05:00.000Z',
        '2026-01-01T00:15:00.000Z',
        '2026-01-01T00:25:00.000Z',
      ]),
    });
    const singleFocus = scorecardAxis(singleTask, 'focus');
    const multiFocus = scorecardAxis(multiTask, 'focus');

    expect(multiFocus.score).toBeLessThan(singleFocus.score);
    expect(multiFocus.evidence.join(' ')).toContain('task span');
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

  it('preserves late .claude path evidence when bounded command bodies are stripped', () => {
    const command = `${'x'.repeat(70 * 1024)}.claude/settings.json`;
    const raw = toolData([
      toolCall('Bash', {
        input: { command },
        ...deriveBashCommandSignals(command),
      }),
    ]);
    expect(raw.calls[0].commandAnalysisTruncated).toBe(true);
    expect(raw.calls[0].commandMentionsClaudePath).toBe(true);

    const stripped = stripToolCommandBodies(raw);
    expect(stripped.calls[0].input.command).toBeUndefined();
    expect(
      scorecardAxis(
        computeSessionScorecard({ sessionId: 'sess-1', toolData: stripped }),
        'portability'
      )
    ).toEqual(
      scorecardAxis(
        computeSessionScorecard({ sessionId: 'sess-1', toolData: raw }),
        'portability'
      )
    );
  });

  it('keeps partial-data sessions renderable with low-confidence evidence', () => {
    const scorecard = computeSessionScorecard({ sessionId: 'partial' });

    expect(scorecard.axes).toHaveLength(SCORECARD_AXIS_IDS.length);
    expect(scorecard.axes.every((axis) => axis.confidence === 'low')).toBe(true);
    expect(scorecard.axes.every((axis) => axis.evidence[0].includes('No '))).toBe(true);
    expect(scorecard.axes.every((axis) => axis.score === 50)).toBe(true);
  });
});
