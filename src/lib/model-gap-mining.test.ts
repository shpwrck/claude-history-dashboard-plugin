import { describe, it, expect } from 'vitest';
import {
  mineModelGaps,
  buildGapMiningRuns,
  mineModelGapsFromDataset,
  type GapMiningRun,
} from './model-gap-mining';
import type { SessionTokenData, TokenEntry } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';

function run(over: Partial<GapMiningRun>): GapMiningRun {
  return {
    runId: 'r',
    modelId: 'claude-sonnet-4-6',
    family: 'sonnet',
    costProxyUsd: 0,
    totalTokens: 0,
    durationMs: 0,
    turns: 1,
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    ...over,
  };
}

describe('mineModelGaps (core)', () => {
  it('returns [] for no runs', () => {
    expect(mineModelGaps([])).toEqual([]);
  });

  it('drops calm runs with no cost/duration/failure signal', () => {
    const calm = run({ runId: 'calm', costProxyUsd: 0, durationMs: 0, toolErrors: 0, apiErrors: 0 });
    expect(mineModelGaps([calm])).toEqual([]);
  });

  it('ranks an expensive sonnet run as a sonnet->opus candidate', () => {
    const cheap = run({ runId: 'cheap', costProxyUsd: 1, durationMs: 1000, turns: 5, totalTokens: 1000 });
    const pricey = run({ runId: 'pricey', costProxyUsd: 50, durationMs: 60000, turns: 5, totalTokens: 500_000 });
    const out = mineModelGaps([cheap, pricey]);
    expect(out[0].runId).toBe('pricey');
    expect(out[0].direction).toBe('sonnet->opus');
    // Cost/duration/inefficiency evidence is token-cost-discovery (rule 4).
    expect(out[0].evidence.some((e) => e.strength === 'token-cost-discovery')).toBe(true);
    expect(out[0].evidence.every((e) => e.strength !== 'shadow-replay-verdict')).toBe(true);
  });

  it('ranks a struggling haiku run as a haiku->sonnet candidate with proxy-detector failure evidence', () => {
    const haiku = run({
      runId: 'h',
      modelId: 'claude-haiku-4-5-20251001',
      family: 'haiku',
      costProxyUsd: 0.2,
      durationMs: 5000,
      turns: 3,
      totalTokens: 30_000,
      toolErrors: 6,
      apiErrors: 2,
    });
    const [cand] = mineModelGaps([haiku]);
    expect(cand.direction).toBe('haiku->sonnet');
    const failure = cand.evidence.find((e) => e.strength === 'proxy-detector-signal');
    expect(failure).toBeDefined();
    expect(failure!.delta).toBe(8); // 6 tool + 2 api
  });

  it('never emits a quality dimension or a quality-strength label from cost alone', () => {
    const pricey = run({ runId: 'p', costProxyUsd: 99, totalTokens: 1_000_000, turns: 2 });
    const [cand] = mineModelGaps([pricey]);
    // The candidate carries a discovery rank, not a quality score.
    expect(cand).not.toHaveProperty('quality');
    expect(cand).not.toHaveProperty('scores');
    expect(cand.discoveryScore).toBeGreaterThan(0);
    // Cost-derived evidence is the weakest strength, never objective/verdict.
    const costEv = cand.evidence.find((e) => e.detail.includes('cost proxy'));
    expect(costEv?.strength).toBe('token-cost-discovery');
  });

  it('honours maxCandidates', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run({ runId: `r${i}`, costProxyUsd: (i + 1) * 10, durationMs: 1000 })
    );
    expect(mineModelGaps(runs, { maxCandidates: 2 })).toHaveLength(2);
  });
});

// ── Adapter over parsed dashboard data ───────────────────────────────────────

function entry(model: string, over: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: '2026-06-01T00:00:00Z',
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...over,
  } as unknown as TokenEntry;
}

function tokenSession(sessionId: string, entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

describe('buildGapMiningRuns / mineModelGapsFromDataset (adapter)', () => {
  it('builds runs from token/timeline/tool/error data and skips unresolved-model sessions', () => {
    const tokenData: SessionTokenData[] = [
      tokenSession('s-opus', [entry('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 200_000 })]),
      tokenSession('s-unknown', [entry('some-unknown-model', { inputTokens: 10 })]),
    ];
    const timelines: SessionTimeline[] = [
      {
        sessionId: 's-opus',
        startTime: '2026-06-01T00:00:00Z',
        endTime: '2026-06-01T00:02:00Z',
        entries: [
          { timestamp: '2026-06-01T00:00:00Z', kind: 'user', summary: 'do a thing' },
          { timestamp: '2026-06-01T00:01:00Z', kind: 'user', summary: 'again' },
        ],
      } as unknown as SessionTimeline,
    ];
    const toolData: ToolUsageData[] = [
      {
        sessionId: 's-opus',
        calls: [
          { timestamp: 't', toolName: 'Bash', input: { command: 'x' }, toolUseId: 'u1', isError: true, resultBytes: 0 },
          { timestamp: 't', toolName: 'Bash', input: { command: 'y' }, toolUseId: 'u2', isError: null, resultBytes: 0 },
        ],
      },
    ];
    const apiErrors = [
      { sessionId: 's-opus', status: 529 },
    ] as unknown as ApiErrorEvent[];

    const runs = buildGapMiningRuns({ tokenData, timelines, toolData, apiErrors });
    expect(runs).toHaveLength(1); // s-unknown skipped
    const r = runs[0];
    expect(r.runId).toBe('s-opus');
    expect(r.family).toBe('opus');
    expect(r.costProxyUsd).toBeGreaterThan(0);
    expect(r.durationMs).toBe(120_000);
    expect(r.turns).toBe(2);
    expect(r.toolErrors).toBe(1);
    expect(r.apiErrors).toBe(1);

    const candidates = mineModelGapsFromDataset({ tokenData, timelines, toolData, apiErrors });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].direction).toBe('sonnet->opus');
  });

  it('returns [] when there is no token data', () => {
    expect(mineModelGapsFromDataset({ tokenData: [] })).toEqual([]);
  });
});
