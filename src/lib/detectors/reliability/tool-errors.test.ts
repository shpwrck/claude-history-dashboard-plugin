import { describe, expect, it } from 'vitest';
import { detector } from './tool-errors';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig } from '../../../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

const ts = (i: number) => `2026-06-12T10:00:0${i}.000Z`;

// A session whose `Edit` calls fail `errorCalls` of `totalCalls` times — enough
// to clear MIN_TOOL_ERROR_CALLS (5) and MIN_TOOL_ERROR_RATE (20%).
function failingTool(totalCalls = 5, errorCalls = 2, toolName = 'Edit'): ToolUsageData {
  const calls: ToolCall[] = Array.from({ length: totalCalls }, (_, i) => ({
    timestamp: ts(i),
    toolName,
    input: {},
    toolUseId: `tool-${i}`,
    isError: i < errorCalls ? true : null,
    resultBytes: 0,
  }));
  return { sessionId: 'session-1', calls };
}

function liveConfigClaudeMd(global: string): LiveConfig {
  return {
    settings: {},
    mcpServers: [],
    claudeMd: { global, perProject: {} },
  } as unknown as LiveConfig;
}

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

// What the opt-in adopt helper appends to CLAUDE.md when this fix is adopted.
const ADOPT_BLOCK_TOOL_ERRORS = [
  '## Claude Coach Adopted Recommendations',
  '',
  '### Tools with high error rates (`reliability.tool-errors`)',
  '',
  'Adopted: 2026-06-12T10:00:00.000Z',
  '',
  '{ "hooks": { "PostToolUse": [] } }',
].join('\n');

describe('reliability.tool-errors', () => {
  it('flags tools that fail a meaningful share of calls', () => {
    const rec = detector.rule(input({ toolData: [failingTool()] }), 0);
    expect(rec).toMatchObject({
      id: 'reliability.tool-errors',
      category: 'reliability',
      severity: 'warning',
      fix: { target: 'hook', label: 'Add a post-edit typecheck hook' },
    });
  });

  it('cites qualifying tool, error-call, threshold, and evidence figures (#3216)', () => {
    const rec = detector.rule(
      input({ toolData: [failingTool()] }),
      Date.parse('2026-06-13T00:00:00.000Z')
    );
    expect(rec?.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.provenance?.asOf).toBe('2026-06-12');
    expect(rec?.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'aggregateToolErrors().{totalCalls,errorRate}',
          value: 1,
        }),
        expect.objectContaining({
          field: 'aggregateToolErrors().errorCalls',
          value: 2,
        }),
        expect.objectContaining({
          field: 'MIN_TOOL_ERROR_RATE',
          value: 20,
        }),
        expect.objectContaining({
          field: 'aggregateToolErrors().{toolName,errorRate,totalCalls}',
        }),
      ])
    );
    expect(rec?.detail).not.toMatch(/often trigger retries/i);
    expect(rec?.provenance?.inference).toMatch(/does not establish.*retry/i);
  });

  it('stays silent below the call/rate thresholds', () => {
    // 4 calls (< MIN_TOOL_ERROR_CALLS) and a single 10% error session.
    expect(detector.rule(input({ toolData: [failingTool(4, 4)] }), 0)).toBeNull();
    expect(detector.rule(input({ toolData: [failingTool(10, 1)] }), 0)).toBeNull();
  });

  it('carries adoption markers on the fix so the scorecard can credit it (#1783)', () => {
    const rec = detector.rule(input({ toolData: [failingTool()] }), 0);
    expect(rec?.fix?.appliedMarkers?.bodyPhrases).toContain('Tools with high error rates');
    expect(rec?.fix?.appliedMarkers?.headings?.length).toBeGreaterThan(0);
  });

  it('suppresses once the fix is adopted via the CLAUDE.md receipt (#1783)', () => {
    expect(
      detector.rule(
        input({
          toolData: [failingTool()],
          liveConfig: liveConfigClaudeMd(ADOPT_BLOCK_TOOL_ERRORS),
        }),
        0
      )
    ).toBeNull();
  });

  it('a different finding adopted in the same section does NOT credit this one (#1783)', () => {
    // Section heading present, but only another finding's title appears — this
    // finding's title is absent, so the strict-AND must keep it firing.
    const otherAdoption = [
      '## Claude Coach Adopted Recommendations',
      '',
      '### Something else (`safety.dangerous-bypass`)',
      '',
      'Adopted: 2026-06-12T10:00:00.000Z',
    ].join('\n');
    const rec = detector.rule(
      input({
        toolData: [failingTool()],
        liveConfig: liveConfigClaudeMd(otherAdoption),
      }),
      0
    );
    expect(rec?.id).toBe('reliability.tool-errors');
  });
});
