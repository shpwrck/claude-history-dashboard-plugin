import { describe, it, expect } from 'vitest';
import { detector } from './harmful-habit';
import type { RecommendationInput } from '../types';
import type { SessionTimeline } from '../../parse-timeline';
import type { SessionTokenData } from '../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { validateRecommendationProvenance } from '../provenance';

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

const timeline = (sessionId: string, date: string): SessionTimeline =>
  ({
    sessionId,
    startTime: `${date}T00:00:00Z`,
    endTime: `${date}T00:00:00Z`,
    entries: [],
  }) as unknown as SessionTimeline;

const tokens = (
  sessionId: string,
  webSearchRequests: number,
  date: string
): SessionTokenData =>
  ({
    sessionId,
    entries: [
      {
        timestamp: `${date}T00:00:00Z`,
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
const tools = (
  sessionId: string,
  isError: boolean,
  date: string
): ToolUsageData => ({
  sessionId,
  calls: Array.from({ length: 4 }, (_, i): ToolCall => ({
    timestamp: `${date}T00:00:0${i}Z`,
    toolName: 'Bash',
    input: { command: `cmd-${sessionId}-${i}` },
    toolUseId: `${sessionId}-${i}`,
    isError,
    resultBytes: 0,
  })),
});

function corpus(date = '2026-01-01'): RecommendationInput {
  const clean = ['c1', 'c2', 'c3'];
  const errored = ['e1', 'e2', 'e3'];
  return {
    tokenData: [
      ...clean.map((id) => tokens(id, 0, date)),
      ...errored.map((id) => tokens(id, 100, date)),
    ],
    toolData: [
      ...clean.map((id) => tools(id, false, date)),
      ...errored.map((id) => tools(id, true, date)),
    ],
    timelines: [...clean, ...errored].map((id) => timeline(id, date)),
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

  it('cites the factor split, observed rates, proxy boundary, and supporting date', () => {
    const rec = detector.rule(
      corpus('2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.asOf).toBe('2026-06-09');
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'analyzeHabitImpact().factors[].key',
          value: 'tool-errors',
        }),
        expect.objectContaining({
          field:
            'analyzeHabitImpact().factors[].high.{sessionCount,goodRate}',
          value: '3/0',
        }),
        expect.objectContaining({
          field:
            'analyzeHabitImpact().factors[].low.{sessionCount,goodRate}',
          value: '3/1',
        }),
        expect.objectContaining({
          field: 'analyzeHabitImpact().{totalSessions,labelledCount,proxyCount}',
          value: '6/0/6',
        }),
      ])
    );
    expect(rec.provenance?.inference).toMatch(/association|caus/i);
  });

  it('demotes old history while preserving fresh wording', () => {
    const stale = detector.rule(
      corpus('2026-01-01'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(stale.detail).toMatch(/^As of 2026-01-01,/);
    expect(stale.provenance?.asOf).toBe('2026-01-01');
    expect(stale.provenance?.stale).toBe(true);

    const fresh = detector.rule(
      corpus('2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(fresh.detail).not.toMatch(/^As of /);
    expect(fresh.provenance?.stale).toBe(false);
  });

  it('uses the newest contributing artifact but ignores unrelated sessions', () => {
    const data = corpus('2026-06-01');
    data.toolData[0].calls[0].timestamp = '2026-06-09T12:00:00Z';
    data.toolData.push(
      tools('not-in-timelines', false, '2026-06-10')
    );

    const rec = detector.rule(
      data,
      Date.parse('2026-06-11T00:00:00Z')
    )!;
    expect(rec.provenance?.asOf).toBe('2026-06-09');
  });
});
