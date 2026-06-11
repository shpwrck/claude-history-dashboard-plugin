import { describe, it, expect } from 'vitest';
import { detector } from './redundant-reads';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { runReclaimCascade } from '../../reclaim';

// 4 reads of the same file in one session, each returning 4000 chars (~1000 tok).
// Direct waste estimate = (4-1) × 4000 / 4 = 3000 tokens.
const readCall = (i: number): ToolCall => ({
  timestamp: `2026-01-01T00:00:0${i}Z`,
  toolName: 'Read',
  input: { file_path: '/repo/README.md' },
  toolUseId: `u${i}`,
  isError: null,
  resultBytes: 4000,
});
const toolData: ToolUsageData[] = [
  { sessionId: 's1', calls: Array.from({ length: 4 }, (_, i) => readCall(i)) },
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

describe('workflow.redundant-reads (#951)', () => {
  it('fires and emits a workflow ReclaimClaim with the workflow-rework cause', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.redundant-reads');
    expect(rec?.reclaim).toBeDefined();
    expect(rec?.reclaim?.category).toBe('workflow');
    expect(rec?.reclaim?.cause).toBe('workflow-rework');
    // Behavioural band [10,40): workflow sorts after reliability/safety.
    expect(rec?.reclaim?.orderKey).toBeGreaterThanOrEqual(10);
    expect(rec?.reclaim?.orderKey).toBeLessThan(40);
  });

  it('is DIRECT-estimate only — a scaleTokens deletion, no modelled reprice', () => {
    const rec = detector.rule(input(), 0);
    const cf = rec?.reclaim?.counterfactual;
    expect(cf?.kind).toBe('scaleTokens');
    // No reprice/convertRate (those are modelled/heroic counterfactuals).
    expect(cf?.kind).not.toBe('reprice');
    expect(cf?.kind).not.toBe('convertRate');
    // The direct estimate is the measured (reads-1)×bytes/4 = 3000 redundant tokens.
    expect(rec?.reclaim?.evidenceTokens).toBe(3000);
  });

  it('books the direct redundant-read tokens against the input pool through the cascade', () => {
    const rec = detector.rule(input(), 0);
    const result = runReclaimCascade([rec!.reclaim!], tokenData);
    // 3000 input tokens deleted at Opus input rate; just assert it booked > $0
    // and stayed within the identity (residual ≥ 0 holds).
    expect(result.total).toBeGreaterThan(0);
    expect(result.byCategory.workflow).toBeCloseTo(result.total, 9);
    expect(result.billOriginal - result.billFinal).toBeCloseTo(result.total, 9);
  });

  it('self-suppresses when CLAUDE.md already pins key files', () => {
    const liveConfig = {
      claudeMd: {
        global:
          '## Key files (kept in context)\n\nLoad these files once into context, then reuse that copy instead of re-reading them:\n- @README.md',
      },
    } as unknown as RecommendationInput['liveConfig'];
    expect(detector.rule(input({ liveConfig }), 0)).toBeNull();
  });

  it('omits the claim (but still surfaces the rec) when no session token data resolves', () => {
    const rec = detector.rule(input({ tokenData: [] }), 0);
    // redundantReads still flags the pairs from toolData, so the rec surfaces,
    // but with no priced scope there is no dollar claim to book.
    expect(rec?.id).toBe('workflow.redundant-reads');
    expect(rec?.reclaim).toBeUndefined();
  });
});
