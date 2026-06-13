import { describe, expect, it } from 'vitest';
import { buildForensicModel } from './forensic-graph';
import type { SessionTimeline } from './parse-timeline';
import type { ValueFlowSession } from './parse-value-flow';
import type { SessionTokenData } from '../types';

const timeline: SessionTimeline = {
  sessionId: 'session-a',
  startTime: '2026-01-01T00:00:00.000Z',
  endTime: '2026-01-01T00:01:00.000Z',
  entries: [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'user',
      summary: 'Deploy the service',
    },
    {
      timestamp: '2026-01-01T00:00:01.000Z',
      kind: 'tool_use',
      toolName: 'Read',
      toolUseId: 'tool-read',
      summary: 'Read deploy-output.txt',
    },
    {
      timestamp: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      toolUseId: 'tool-read',
    },
    {
      timestamp: '2026-01-01T00:00:03.000Z',
      kind: 'user',
      summary: 'Now run it',
    },
    {
      timestamp: '2026-01-01T00:00:04.000Z',
      kind: 'tool_use',
      toolName: 'Bash',
      toolUseId: 'tool-bash',
      summary: 'deploy --target deploy-target-9f83a1c7',
    },
  ],
};

const valueFlow: ValueFlowSession = {
  sessionId: 'session-a',
  edges: [
    {
      sessionId: 'session-a',
      value: 'deploy-target-9f83a1c7',
      source: {
        sessionId: 'session-a',
        entryIndex: 2,
        timestamp: '2026-01-01T00:00:02.000Z',
        toolUseId: 'tool-read',
      },
      target: {
        sessionId: 'session-a',
        entryIndex: 4,
        timestamp: '2026-01-01T00:00:04.000Z',
        toolUseId: 'tool-bash',
      },
      sourceToolUseId: 'tool-read',
      targetToolUseId: 'tool-bash',
      confidence: 'high',
      reason: 'distinctive-value-reuse',
    },
  ],
  hypotheses: [],
};

const tokenData: SessionTokenData = {
  sessionId: 'session-a',
  totalInputTokens: 100,
  totalOutputTokens: 900,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  model: 'claude-sonnet-4-6',
  messageCount: 2,
  hasUnknownModel: false,
  entries: [
    {
      timestamp: '2026-01-01T00:00:01.500Z',
      inputTokens: 50,
      outputTokens: 600,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: 'claude-sonnet-4-6',
    },
    {
      timestamp: '2026-01-01T00:00:04.500Z',
      inputTokens: 50,
      outputTokens: 300,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: 'claude-sonnet-4-6',
    },
  ],
  compactionEvents: [],
};

describe('buildForensicModel', () => {
  it('folds entries into turns, attaches tool calls, and anchors flow edges on tool_use nodes', () => {
    const model = buildForensicModel(timeline, tokenData, valueFlow);

    expect(model.turns).toHaveLength(2);
    expect(model.turns[0].label).toBe('Deploy the service');
    expect(model.turns[0].toolCalls.map((t) => t.toolName)).toEqual(['Read']);
    expect(model.turns[1].toolCalls.map((t) => t.toolName)).toEqual(['Bash']);

    expect(model.turns[0].outputTokens).toBe(600);
    expect(model.turns[1].outputTokens).toBe(300);

    expect(model.edges).toEqual([
      {
        sourceEntryIndex: 1,
        targetEntryIndex: 4,
        value: 'deploy-target-9f83a1c7',
      },
    ]);
  });

  it('anchors edges by toolUseId so a time-filtered timeline cannot mis-attribute', () => {
    const filtered: SessionTimeline = {
      ...timeline,
      entries: timeline.entries.slice(1),
    };
    const model = buildForensicModel(filtered, undefined, valueFlow);
    expect(model.edges).toEqual([
      {
        sourceEntryIndex: 0,
        targetEntryIndex: 3,
        value: 'deploy-target-9f83a1c7',
      },
    ]);

    const toolless: SessionTimeline = {
      ...timeline,
      entries: timeline.entries.filter((e) => e.toolUseId !== 'tool-bash'),
    };
    expect(buildForensicModel(toolless, undefined, valueFlow).edges).toEqual(
      []
    );
  });
});
