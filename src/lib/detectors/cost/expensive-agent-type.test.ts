import { describe, it, expect } from 'vitest';
import { detector } from './expensive-agent-type';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData } from '../../parse-tools';
import type { SessionAttribution } from '../../parse-agents';
import { effectiveFixKind, isBlanketModelPinSnippet } from '../fix-validity';

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

// ---------------------------------------------------------------------------
// The claim must not outrun the evidence (#3195)
// ---------------------------------------------------------------------------

describe('cost.expensive-agent-type claim discipline (#3195)', () => {
  it('does not assert what right-sizing would recover', () => {
    const rec = detector.rule(input(), 0);
    // The detector's own comment says it has aggregate run-count evidence and
    // NO scoped, quality-backed right-sizing claim. The detail used to promise
    // "right-sizing its model recovers most of that" anyway.
    expect(rec?.detail).not.toMatch(/recover/i);
    // Mean cost per run is the measurement, and it stays.
    expect(rec?.detail).toContain('/run over 5 runs');
  });

  it('books nothing, because a flag is all the evidence supports', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim?.counterfactual.kind).toBe('flag-only');
  });

  it('does not offer the blanket model pin as a copy-paste fix', () => {
    const rec = detector.rule(input(), 0);
    // A top-level "model" key re-routes EVERY task class, not just the flagged
    // agent type. fix-validity already has a predicate for this exact shape.
    expect(isBlanketModelPinSnippet(rec!.fix!.snippet)).toBe(true);
    // ...so it must not be published as copy-paste-safe. Absent fixKind would
    // mean 'validated'.
    expect(effectiveFixKind(rec!.fix!)).toBe('illustrative');
    expect(rec?.fix?.note).toMatch(/do NOT paste as-is/i);
  });
});
