import { describe, it, expect } from 'vitest';
import { detector } from './native-bypass';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { runReclaimCascade } from '../../reclaim';

// 12 `grep` bash bypass commands (clears MIN_BYPASS_CALLS=10), each returning
// 400 chars of result → 12 × 400 = 4800 bytes → /4 = 1200 direct waste tokens.
const grepCall = (i: number): ToolCall => ({
  timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
  toolName: 'Bash',
  input: { command: 'grep -rn foo src/' },
  toolUseId: `u${i}`,
  isError: null,
  resultBytes: 400,
});
const toolData: ToolUsageData[] = [
  { sessionId: 's1', calls: Array.from({ length: 12 }, (_, i) => grepCall(i)) },
];

const tokenData: SessionTokenData[] = [
  ({
    sessionId: 's1',
    totalInputTokens: 100_000,
    entries: [
      {
        timestamp: 't',
        model: 'claude-opus-4-7',
        inputTokens: 100_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  } as unknown as SessionTokenData),
];

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput => ({
  tokenData,
  toolData,
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...overrides,
});

describe('workflow.native-bypass (#951)', () => {
  it('fires and emits a workflow ReclaimClaim (direct byte delta)', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.native-bypass');
    expect(rec?.reclaim).toBeDefined();
    expect(rec?.reclaim?.category).toBe('workflow');
    expect(rec?.reclaim?.cause).toBe('workflow-rework');
    expect(rec?.reclaim?.orderKey).toBeGreaterThanOrEqual(10);
    expect(rec?.reclaim?.orderKey).toBeLessThan(40);
    // 4800 bypass result bytes / 4 = 1200 direct tokens.
    expect(rec?.reclaim?.evidenceTokens).toBe(1200);
    expect(rec?.reclaim?.counterfactual.kind).toBe('scaleTokens');
  });

  it('books the byte delta through the cascade and preserves the identity', () => {
    const rec = detector.rule(input(), 0);
    const result = runReclaimCascade([rec!.reclaim!], tokenData);
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.workflow).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('omits the claim when no token data resolves the bypassing session', () => {
    const rec = detector.rule(input({ tokenData: [] }), 0);
    expect(rec?.id).toBe('workflow.native-bypass');
    expect(rec?.reclaim).toBeUndefined();
  });

  it('preserves the existing settings.json deny-rules fix and tools deep-link (#1804 only ADDS the copy affordance)', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.view).toBe('tools');
    expect(rec?.fix?.target).toBe('settings.json');
    expect(rec?.fix?.snippet).toContain('Bash(grep:*)');
  });

  it('stays silent below the bypass-call floor', () => {
    const few: ToolUsageData[] = [
      { sessionId: 's1', calls: Array.from({ length: 3 }, (_, i) => grepCall(i)) },
    ];
    expect(detector.rule(input({ toolData: few }), 0)).toBeNull();
  });
});
