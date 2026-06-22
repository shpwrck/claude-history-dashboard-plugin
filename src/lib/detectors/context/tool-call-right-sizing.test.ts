import { describe, it, expect } from 'vitest';
import { detector } from './tool-call-right-sizing';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { runReclaimCascade } from '../../reclaim';

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
  it('fires on over-fetch + verbose payloads and emits a structural-prefix cacheRead claim', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('context.tool-call-right-sizing');
    expect(rec?.category).toBe('context');
    // 1 fat Read + 5 verbose MCP returns.
    expect(rec?.affected).toBe(6);
    expect(rec?.reclaim).toBeDefined();
    expect(rec?.reclaim?.cause).toBe('structural-prefix');
    expect(rec?.reclaim?.orderKey).toBeGreaterThanOrEqual(40);
    expect(rec?.reclaim?.orderKey).toBeLessThan(90);
    expect(rec?.reclaim?.ownedPools).toEqual(['cacheRead']);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
    if (rec?.reclaim?.counterfactual.kind === 'scaleTokens') {
      expect(rec.reclaim.counterfactual.poolDeltaFrac.cacheRead).toBeGreaterThan(0);
    }
  });

  it('surfaces the prescriptive per-tool payload ranking in evidence', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.evidence?.some((e) => e.includes('mcp__db__query'))).toBe(true);
    expect(rec?.evidence?.some((e) => /KB\/call/.test(e))).toBe(true);
    expect(rec?.view).toBe('tools');
  });

  it('books a positive cacheRead marginal through the cascade and preserves the identity', () => {
    const rec = detector.rule(input(), 0);
    const result = runReclaimCascade([rec!.reclaim!], tokenData);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.context).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('omits the claim when no token data resolves the affected session (rec still surfaces)', () => {
    const rec = detector.rule(input({ tokenData: [] }), 0);
    expect(rec?.id).toBe('context.tool-call-right-sizing');
    expect(rec?.reclaim).toBeUndefined();
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
