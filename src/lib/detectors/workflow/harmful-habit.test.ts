import { describe, it, expect } from 'vitest';
import { detector } from './harmful-habit';
import type { RecommendationInput } from '../types';
import type { SessionTimeline } from '../../parse-timeline';
import type { SessionTokenData } from '../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

// Build a corpus where the "tool errors" habit is the only factor with enough
// sessions on both sides: 3 cheap, error-free sessions vs 3 costly, all-error
// sessions. With session tags absent (the engine never sees them) the proxy
// anchors error-free+cheap as "good" and errored+costly as "bad", so the habit
// side has a 0% good-outcome rate vs 100% on the clean side → a `hurts` verdict.
//
// Cost is driven by `webSearchRequests` (a fixed per-request charge) rather than
// token volume, so the gap does not depend on per-model pricing. No compaction
// and no repeated tool inputs, so the compaction / tool-repetition factors stay
// suppressed and tool-errors is the unambiguous headline.

const timeline = (sessionId: string): SessionTimeline =>
  ({
    sessionId,
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:00:00Z',
    entries: [],
  }) as unknown as SessionTimeline;

const tokens = (sessionId: string, webSearchRequests: number): SessionTokenData =>
  ({
    sessionId,
    entries: [
      {
        timestamp: 't',
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  }) as unknown as SessionTokenData;

// Distinct commands per call (and per session) → tool-reuse rate stays 0, so the
// tool-repetition factor never splits.
const tools = (sessionId: string, isError: boolean): ToolUsageData => ({
  sessionId,
  calls: Array.from({ length: 4 }, (_, i): ToolCall => ({
    timestamp: `2026-01-01T00:00:0${i}Z`,
    toolName: 'Bash',
    input: { command: `cmd-${sessionId}-${i}` },
    toolUseId: `${sessionId}-${i}`,
    isError,
    resultBytes: 0,
  })),
});

function corpus(): RecommendationInput {
  const clean = ['c1', 'c2', 'c3'];
  const errored = ['e1', 'e2', 'e3'];
  return {
    tokenData: [
      ...clean.map((id) => tokens(id, 0)),
      ...errored.map((id) => tokens(id, 100)),
    ],
    toolData: [
      ...clean.map((id) => tools(id, false)),
      ...errored.map((id) => tools(id, true)),
    ],
    timelines: [...clean, ...errored].map(timeline),
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  };
}

describe('workflow.harmful-habit (#549)', () => {
  it('fires when a habit factor earns a hurts verdict', () => {
    const rec = detector.rule(corpus(), 0);
    expect(rec?.id).toBe('workflow.harmful-habit');
    expect(rec?.category).toBe('workflow');
    expect(rec?.view).toBe('patterns');
    // 100-pt good-outcome gap → bumped above the info baseline.
    expect(rec?.severity).toBe('warning');
    // The habit side (sessions WITH tool errors) is the affected set.
    expect(rec?.affected).toBe(3);
    expect(rec?.detail).toContain('good-outcome rate');
    expect(rec?.detail).toContain('with tool errors');
    expect(rec?.title).toContain('Tool errors');
    expect(rec?.action).toContain('Patterns view');
    expect((rec?.evidence ?? []).length).toBeGreaterThan(0);
  });

  it('is silent when no factor has enough sessions on both sides', () => {
    expect(detector.rule({ ...corpus(), timelines: [] }, 0)).toBeNull();
    expect(
      detector.rule(
        {
          tokenData: [],
          toolData: [],
          timelines: [],
          sessions: [],
          projects: [],
          permissionRows: [],
          apiErrors: [],
          liveConfig: null,
        },
        0
      )
    ).toBeNull();
  });
});
