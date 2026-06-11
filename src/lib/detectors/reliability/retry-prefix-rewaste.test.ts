import { describe, it, expect } from 'vitest';
import { detector } from './retry-prefix-rewaste';
import { PREFIX_REWASTE_FRAC } from './reclaim-prefix';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import type { SessionTokenData, TokenEntry } from '../../types';
import { runReclaimCascade, scopeKeyOf } from '../../reclaim';

// ── Fixtures ─────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

const call = (toolName: string, offsetSec: number, isError: boolean): ToolCall =>
  ({
    timestamp: at(offsetSec),
    toolName,
    input: {},
    toolUseId: `u${offsetSec}`,
    isError,
    resultBytes: 0,
  }) as unknown as ToolCall;

const toolSession = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({
  sessionId,
  calls,
});

const entry = (over: Partial<TokenEntry> = {}): TokenEntry => ({
  timestamp: at(1),
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model: 'claude-opus-4-7',
  ...over,
});

const session = (
  sessionId: string,
  model: string,
  entries: TokenEntry[]
): SessionTokenData =>
  ({
    sessionId,
    model,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

const input = (
  over: Partial<RecommendationInput> = {}
): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...over,
});

describe('reliability.retry-prefix-rewaste (#950)', () => {
  it('fires on an errored retry group with priced cache-read in window', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 2_000_000, timestamp: at(1) })]),
    ];
    const tools = [
      toolSession('s1', [call('Bash', 0, false), call('Bash', 2, true)]),
    ];
    const rec = detector.rule(input({ tokenData: td, toolData: tools }), 0);
    expect(rec?.id).toBe('reliability.retry-prefix-rewaste');
    expect(rec?.category).toBe('reliability');
    expect(rec?.reclaim?.cause).toBe('failed-tool-retry');
    expect(rec?.reclaim?.ownedPools).toEqual(['cacheRead']);
    expect(rec?.reclaim?.scopeKeys).toEqual([scopeKeyOf('s1', 'claude-opus-4-7')]);
  });

  it('books $0 on a high-count but error-FREE retry group (hasErrors gate, not count)', () => {
    // 6 back-to-back same-tool calls, ZERO errors → hasErrors:false → no claim.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 5_000_000, timestamp: at(1) })]),
    ];
    const noErr: ToolCall[] = [];
    for (let i = 0; i < 6; i++) noErr.push(call('Bash', i, false));
    const rec = detector.rule(
      input({ tokenData: td, toolData: [toolSession('s1', noErr)] }),
      0
    );
    expect(rec).toBeNull();
  });

  it('uses a conservative cacheRead-only fraction — never deletes the whole turn', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ cacheReadTokens: 1_000_000, outputTokens: 1_000_000, inputTokens: 1_000_000, timestamp: at(1) }),
      ]),
    ];
    const tools = [toolSession('s1', [call('Bash', 0, true), call('Bash', 2, true)])];
    const rec = detector.rule(input({ tokenData: td, toolData: tools }), 0);
    const cf = rec?.reclaim?.counterfactual;
    expect(cf?.kind).toBe('scaleTokens');
    if (cf?.kind !== 'scaleTokens') throw new Error('expected scaleTokens');
    // ONLY cacheRead is scaled, and by a small fraction well below 1 (no whole-turn).
    expect(cf.poolDeltaFrac.cacheRead).toBe(PREFIX_REWASTE_FRAC);
    expect(cf.poolDeltaFrac.cacheRead).toBeLessThan(0.2);
    expect(cf.poolDeltaFrac.output).toBeUndefined();
    expect(cf.poolDeltaFrac.input).toBeUndefined();

    // Run through the cascade: it books only a fraction of cache-read, leaving
    // output+input (the legitimate co-located work) and most of cache-read intact.
    const result = runReclaimCascade([rec!.reclaim!], td, () => {});
    // cache-read cell = 1M * $0.50/M = $0.50; only PREFIX_REWASTE_FRAC is booked.
    expect(result.total).toBeCloseTo(0.5 * PREFIX_REWASTE_FRAC, 9);
    // The whole turn ($0.50 cacheRead + $25 output + $5 input = $30.50) is NOT deleted.
    expect(result.total).toBeLessThan(0.5);
  });

  it('preserves the cascade identity sum(marginal) ≡ billOriginal − billFinal', () => {
    const td = [
      session('s1', 'claude-opus-4-7', [
        entry({ cacheReadTokens: 4_000_000, outputTokens: 500_000, timestamp: at(1) }),
      ]),
    ];
    const tools = [toolSession('s1', [call('Bash', 0, true), call('Bash', 2, true)])];
    const rec = detector.rule(input({ tokenData: td, toolData: tools }), 0);
    const result = runReclaimCascade([rec!.reclaim!], td, () => {});
    const summed = result.booked.reduce((s, b) => s + b.marginalUsd, 0);
    expect(summed).toBeCloseTo(result.billOriginal - result.billFinal, 9);
    expect(result.billFinal).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('stays silent with no errored groups, no token scope, or no cache-read', () => {
    // No errors at all.
    expect(detector.rule(input({ toolData: [toolSession('s1', [call('Bash', 0, false)])] }), 0)).toBeNull();
    // Errored group but no token data in window.
    const tools = [toolSession('s1', [call('Bash', 0, true), call('Bash', 2, true)])];
    expect(detector.rule(input({ toolData: tools }), 0)).toBeNull();
    // Errored group but the in-window entry has zero cache-read.
    const td = [session('s1', 'claude-opus-4-7', [entry({ outputTokens: 1_000_000, timestamp: at(1) })])];
    expect(detector.rule(input({ tokenData: td, toolData: tools }), 0)).toBeNull();
  });

  it('ignores token entries OUTSIDE the errored window (timestamp-approximate join)', () => {
    // Errored group spans [0s, 2s]; the cache-read entry is at 1 hour later.
    const td = [
      session('s1', 'claude-opus-4-7', [entry({ cacheReadTokens: 9_000_000, timestamp: at(3600) })]),
    ];
    const tools = [toolSession('s1', [call('Bash', 0, true), call('Bash', 2, true)])];
    expect(detector.rule(input({ tokenData: td, toolData: tools }), 0)).toBeNull();
  });
});
