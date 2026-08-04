import { describe, it, expect } from 'vitest';
import { detector } from './tool-call-right-sizing';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

const call = (
  i: number,
  toolName: string,
  resultBytes: number,
  extra?: Partial<ToolCall>
): ToolCall => ({
  timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  toolName,
  input: {},
  toolUseId: `u${i}`,
  isError: null,
  resultBytes,
  ...extra,
});

// One session: a 60 KB whole-file Read (Face 1 over-fetch) followed by five
// 20 KB MCP returns (Face 2 chronically verbose), then a couple of small calls
// so the fat payloads have a cache-read tail behind them.
const toolData: ToolUsageData[] = [
  {
    sessionId: 'session-aaaa',
    calls: [
      call(0, 'Read', 60_000),
      ...Array.from({ length: 5 }, (_, i) => call(i + 1, 'mcp__db__query', 20_000)),
      call(6, 'Bash', 300),
      call(7, 'Edit', 200),
    ],
  },
];

const tokenData: SessionTokenData[] = [
  {
    sessionId: 'session-aaaa',
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens: 10_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 2_000_000,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
  } as unknown as SessionTokenData,
];

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData,
    toolData,
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

describe('context.tool-call-right-sizing (#1924)', () => {
  it('fires on large payloads as a heuristic candidate without booking a reclaim (#3190)', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('context.tool-call-right-sizing');
    expect(rec?.category).toBe('context');
    // 1 fat Read + 5 verbose MCP returns.
    expect(rec?.affected).toBe(6);
    // #3190: resultBytes cannot attribute per-turn cache reads, so no reclaim is
    // booked — the compounded figure is a labeled projection, not a saving.
    expect(rec?.reclaim).toBeUndefined();
    expect(rec?.detail).toMatch(/heuristic candidate/i);
    expect(rec?.detail).toMatch(/projects to a rough upper bound/i);
    expect(rec?.detail).toMatch(/estimate/i);
    // The removed observational overclaim: no "pulled far more than the task
    // used" / "targeted alternative was smaller" assertion.
    expect(rec?.detail).not.toMatch(/pulled far more into context than the task used/i);
    expect(rec?.detail).not.toMatch(/targeted alternative/i);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('surfaces the prescriptive per-tool payload ranking in evidence', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.evidence?.some((e) => e.includes('mcp__db__query'))).toBe(true);
    expect(rec?.evidence?.some((e) => /KB\/call/.test(e))).toBe(true);
    expect(rec?.view).toBe('tools');
  });

  it('never books a reclaim even with full token data (#3190)', () => {
    // tokenData is present, yet the detector books no deterministic reclaim —
    // the projection stays a labeled estimate, not a cascade claim.
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('context.tool-call-right-sizing');
    expect(rec?.reclaim).toBeUndefined();
  });

  it('makes no over-fetch/reclaim claim for a lone large final Read (#3190)', () => {
    // A single necessary whole-file Read: no later turns re-read it, and there is
    // no basis to claim over-fetch, so the detector stays silent.
    const lone: ToolUsageData[] = [
      { sessionId: 's1', calls: [call(0, 'Read', 200_000)] },
    ];
    expect(detector.rule(input({ toolData: lone }), 0)).toBeNull();
  });

  it('stays silent below the affected-call floor', () => {
    const few: ToolUsageData[] = [
      { sessionId: 's1', calls: [call(0, 'Read', 60_000), call(1, 'Edit', 100)] },
    ];
    expect(detector.rule(input({ toolData: few }), 0)).toBeNull();
  });

  it('does not double-claim native-bypass Bash payloads (dedup vs workflow.native-bypass)', () => {
    // Twelve fat `grep` Bash commands: native-bypass territory, NOT right-sizing.
    const bypass: ToolUsageData[] = [
      {
        sessionId: 's1',
        calls: Array.from({ length: 12 }, (_, i) =>
          call(i, 'Bash', 40_000, {
            input: { command: 'grep -rn foo src/' },
            commandBypassCategories: ['grep'],
          })
        ),
      },
    ];
    expect(detector.rule(input({ toolData: bypass }), 0)).toBeNull();
  });
});
