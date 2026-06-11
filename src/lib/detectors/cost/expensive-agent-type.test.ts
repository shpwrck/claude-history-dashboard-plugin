import { describe, it, expect } from 'vitest';
import { detector } from './expensive-agent-type';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData } from '../../parse-tools';
import type { SessionAttribution } from '../../parse-agents';

const taskCall = (i: number) => ({
  timestamp: `2026-01-01T00:00:0${i}Z`,
  toolName: 'Task',
  input: { subagent_type: 'researcher' },
  toolUseId: `u${i}`,
  isError: null,
  resultBytes: 0,
});
const toolData: ToolUsageData[] = [
  { sessionId: 's1', calls: Array.from({ length: 5 }, (_, i) => taskCall(i)) },
];
const attribution: SessionAttribution[] = [
  { sessionId: 's1', agents: { researcher: { invocations: 5, outputTokens: 100_000 } }, skills: {}, mcpServers: {}, mcpTools: {} },
];
const tokenData: SessionTokenData[] = [
  ({
    sessionId: 's1', totalOutputTokens: 100_000,
    entries: [{
      timestamp: 't', model: 'claude-opus-4-7',
      inputTokens: 200_000, outputTokens: 100_000,
      cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0,
      webSearchRequests: 0, webFetchRequests: 0,
    }],
    compactionEvents: [],
  } as unknown as SessionTokenData),
];
const input = (model?: string): RecommendationInput => ({
  tokenData, toolData, sessions: [], projects: [], permissionRows: [], apiErrors: [],
  attribution, agentSettings: [], runtimeEvents: [],
  liveConfig: model ? ({ settings: { model } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('cost.expensive-agent-type (#418)', () => {
  it('fires for an agent type averaging >$0.10/run over >=5 runs', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('cost.expensive-agent-type');
    expect(rec?.detail).toContain('researcher');
    expect(rec?.fix?.snippet).toContain('claude-haiku-4-5');
  });
  it('self-suppresses when Haiku is pinned', () => {
    expect(detector.rule(input('claude-haiku-4-5'), 0)).toBeNull();
  });
});
