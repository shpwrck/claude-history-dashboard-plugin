import { describe, it, expect } from 'vitest';
import {
  isoWeekStart,
  computeWeeklyDeltas,
  computeWeeklyDeltaBreakdown,
  type WeeklyDeltaInput,
} from './weekly-delta';
import { computeCostTrend } from './cost-trend';
import type { SessionTokenData, TokenEntry } from '../types';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';

// --- Fixture builders -------------------------------------------------------
// computeWeeklyDeltas reads only a handful of fields off each shape, so we build
// minimal objects. Timestamps drive the ISO-week buckets; token entries drive
// cost (priced exactly as computeCostTrend prices them).

function tokenEntry(timestamp: string, inputTokens: number): TokenEntry {
  return {
    timestamp,
    inputTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-sonnet-4-5',
  };
}

function tokenSession(entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId: 's',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4-5',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

function apiError(timestamp: string): ApiErrorEvent {
  return { sessionId: 's', timestamp, summary: 'API Error' };
}

function toolCall(timestamp: string): ToolCall {
  return {
    timestamp,
    toolName: 'Bash',
    input: {} as ToolCall['input'],
    toolUseId: 't',
    isError: false,
    resultBytes: 0,
  };
}

/** A retry storm = >=2 consecutive same-tool calls within 60s, same session. */
function stormSession(sessionId: string, startTimestamps: string[]): ToolUsageData {
  const calls: ToolCall[] = [];
  for (const start of startTimestamps) {
    const base = Date.parse(start);
    // Three calls 5s apart → one retry group whose startTimestamp === `start`.
    calls.push({ ...toolCall(new Date(base).toISOString()) });
    calls.push({ ...toolCall(new Date(base + 5000).toISOString()) });
    calls.push({ ...toolCall(new Date(base + 10000).toISOString()) });
  }
  return { sessionId, calls };
}

// ISO weeks (Monday, UTC):
//   2026-01-05 = Mon of week A (prior complete)
//   2026-01-12 = Mon of week B (last complete)
//   2026-01-19 = Mon of week C (current/partial → excluded)

describe('isoWeekStart', () => {
  it('snaps any day to its ISO-week Monday (UTC)', () => {
    expect(isoWeekStart('2026-01-05')).toBe('2026-01-05'); // Monday
    expect(isoWeekStart('2026-01-07')).toBe('2026-01-05'); // Wednesday
    expect(isoWeekStart('2026-01-11')).toBe('2026-01-05'); // Sunday (week end)
    expect(isoWeekStart('2026-01-12')).toBe('2026-01-12'); // next Monday
  });
});

describe('computeWeeklyDeltas', () => {
  it('computes current/previous/deltaAbs/deltaPct and ranks movers', () => {
    // Week A (prior): 2 errors, 1 storm, cost from 1000 input-token entry.
    // Week B (last):  5 errors, 3 storms, cost from 3000 input-token entry.
    // Week C (partial, excluded): 99 errors so it must NOT leak in.
    const tokenData = [
      tokenSession([
        tokenEntry('2026-01-06T00:00:00Z', 1000), // week A
        tokenEntry('2026-01-13T00:00:00Z', 3000), // week B
        tokenEntry('2026-01-20T00:00:00Z', 9000), // week C (excluded)
      ]),
    ];
    const apiErrors = [
      ...Array(2).fill(0).map(() => apiError('2026-01-06T01:00:00Z')), // A
      ...Array(5).fill(0).map(() => apiError('2026-01-13T01:00:00Z')), // B
      ...Array(99).fill(0).map(() => apiError('2026-01-20T01:00:00Z')), // C
    ];
    const toolData = [
      stormSession('a', ['2026-01-06T02:00:00Z']), // 1 storm, week A
      stormSession('b', [
        '2026-01-13T02:00:00Z',
        '2026-01-13T03:00:00Z',
        '2026-01-13T04:00:00Z',
      ]), // 3 storms, week B
      stormSession('c', ['2026-01-20T02:00:00Z']), // week C (excluded)
    ];
    const input: WeeklyDeltaInput = { tokenData, apiErrors, toolData };
    const result = computeWeeklyDeltas(input);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.currentWeekStart).toBe('2026-01-12');
    expect(result.previousWeekStart).toBe('2026-01-05');

    // Errors: 2 → 5.
    expect(result.errors.previous).toBe(2);
    expect(result.errors.current).toBe(5);
    expect(result.errors.deltaAbs).toBe(3);
    expect(result.errors.deltaPct).toBeCloseTo(1.5, 10); // +150%

    // Retry storms: 1 → 3.
    expect(result.retryStorms.previous).toBe(1);
    expect(result.retryStorms.current).toBe(3);
    expect(result.retryStorms.deltaAbs).toBe(2);
    expect(result.retryStorms.deltaPct).toBeCloseTo(2.0, 10); // +200%

    // Cost: week B (3000 tokens) > week A (1000 tokens), so deltaAbs > 0.
    expect(result.cost.deltaAbs).toBeGreaterThan(0);
    expect(result.cost.deltaPct).toBeCloseTo(2.0, 10); // 3x input → +200%

    // movers ranked by abs(deltaPct): cost (+200) and storms (+200) tie at the
    // top, then errors (+150). Order of the two +200 movers is broken by
    // abs(deltaAbs); whichever, errors must be last.
    expect(result.movers.length).toBe(3);
    expect(result.movers[2].signal).toBe('errors');
    const topSignals = result.movers.slice(0, 2).map((m) => m.signal).sort();
    expect(topSignals).toEqual(['cost', 'retryStorms']);
  });

  it('returns null with fewer than three distinct active ISO weeks (no two complete weeks to compare)', () => {
    // Only two active weeks → after excluding the trailing partial week, only
    // one complete week remains → null.
    const tokenData = [
      tokenSession([
        tokenEntry('2026-01-06T00:00:00Z', 1000), // week A
        tokenEntry('2026-01-13T00:00:00Z', 1000), // week B (partial/current)
      ]),
    ];
    const result = computeWeeklyDeltas({
      tokenData,
      apiErrors: [],
      toolData: [],
    });
    expect(result).toBeNull();
  });

  it('per-week cost equals the sum of computeCostTrend daily costs in that week', () => {
    const tokenData = [
      tokenSession([
        tokenEntry('2026-01-06T00:00:00Z', 1000), // week A
        tokenEntry('2026-01-08T00:00:00Z', 500), // week A (different day)
        tokenEntry('2026-01-13T00:00:00Z', 3000), // week B
        tokenEntry('2026-01-20T00:00:00Z', 9000), // week C (excluded)
      ]),
    ];
    const result = computeWeeklyDeltas({
      tokenData,
      apiErrors: [],
      toolData: [],
    });
    expect(result).not.toBeNull();
    if (!result) return;

    const { daily } = computeCostTrend(tokenData);
    const sumWeek = (weekStart: string) =>
      daily
        .filter((d) => isoWeekStart(d.date) === weekStart)
        .reduce((s, d) => s + d.cost, 0);

    expect(result.cost.previous).toBeCloseTo(
      sumWeek(result.previousWeekStart),
      10
    );
    expect(result.cost.current).toBeCloseTo(
      sumWeek(result.currentWeekStart),
      10
    );
  });
});

describe('computeWeeklyDeltaBreakdown', () => {
  // Shared two-week window for the drill-down tests:
  //   previous = 2026-01-05, current = 2026-01-12 (matches the aggregate above).
  const previousWeekStart = '2026-01-05';
  const currentWeekStart = '2026-01-12';

  it('decomposes errors by project and reconciles the per-row delta to the total', () => {
    // Week A (prev): 1 error in proj-a. Week B (now): 2 in proj-a, 1 in proj-b.
    const apiErrors = [
      apiError('2026-01-06T01:00:00Z'), // prev, session s-a → proj-a
      apiError('2026-01-13T01:00:00Z'), // now,  session s-a → proj-a
      apiError('2026-01-13T02:00:00Z'), // now,  session s-a → proj-a
      apiError('2026-01-13T03:00:00Z'), // now,  session s-b → proj-b
    ];
    // apiError() hard-codes sessionId 's'; override per-event for attribution.
    apiErrors[0].sessionId = 's-a';
    apiErrors[1].sessionId = 's-a';
    apiErrors[2].sessionId = 's-a';
    apiErrors[3].sessionId = 's-b';

    const breakdown = computeWeeklyDeltaBreakdown({
      tokenData: [],
      apiErrors,
      toolData: [],
      projects: [
        { sessionId: 's-a', project: 'proj-a' },
        { sessionId: 's-b', project: 'proj-b' },
      ],
      signal: 'errors',
      dimension: 'project',
      currentWeekStart,
      previousWeekStart,
    });

    expect(breakdown.previousTotal).toBe(1);
    expect(breakdown.currentTotal).toBe(3);

    const byKey = Object.fromEntries(breakdown.rows.map((r) => [r.key, r]));
    expect(byKey['proj-a'].previous).toBe(1);
    expect(byKey['proj-a'].current).toBe(2);
    expect(byKey['proj-a'].deltaAbs).toBe(1);
    expect(byKey['proj-b'].previous).toBe(0);
    expect(byKey['proj-b'].current).toBe(1);
    expect(byKey['proj-b'].deltaPct).toBe(Infinity); // rose from zero

    // Per-row deltas sum to the total delta (no double-counting / leakage).
    const rowDeltaSum = breakdown.rows.reduce((s, r) => s + r.deltaAbs, 0);
    expect(rowDeltaSum).toBe(breakdown.currentTotal - breakdown.previousTotal);

    // Biggest mover first (proj-a Δ+1 ties proj-b Δ+1 → stable by key).
    expect(breakdown.rows[0].key).toBe('proj-a');
  });

  it('tags an untagged session as "(unknown project)"', () => {
    const apiErrors = [apiError('2026-01-13T01:00:00Z')]; // sessionId 's'
    const breakdown = computeWeeklyDeltaBreakdown({
      tokenData: [],
      apiErrors,
      toolData: [],
      projects: [], // no tag for 's'
      signal: 'errors',
      dimension: 'project',
      currentWeekStart,
      previousWeekStart,
    });
    expect(breakdown.rows[0].key).toBe('(unknown project)');
  });

  it('decomposes cost by model and reconciles the breakdown total to the banner delta', () => {
    const tokenData = [
      tokenSession([
        { ...tokenEntry('2026-01-06T00:00:00Z', 1000), model: 'claude-sonnet-4-5' }, // prev
        { ...tokenEntry('2026-01-13T00:00:00Z', 3000), model: 'claude-sonnet-4-5' }, // now
        { ...tokenEntry('2026-01-13T01:00:00Z', 500), model: 'claude-haiku-4-5' }, // now
        { ...tokenEntry('2026-01-20T00:00:00Z', 9000), model: 'claude-sonnet-4-5' }, // week C, excluded
      ]),
    ];
    const agg = computeWeeklyDeltas({ tokenData, apiErrors: [], toolData: [] });
    expect(agg).not.toBeNull();
    if (!agg) return;

    const breakdown = computeWeeklyDeltaBreakdown({
      tokenData,
      apiErrors: [],
      toolData: [],
      projects: [],
      signal: 'cost',
      dimension: 'model',
      currentWeekStart: agg.currentWeekStart,
      previousWeekStart: agg.previousWeekStart,
    });

    // The breakdown's week totals match the banner's cost figures exactly.
    expect(breakdown.previousTotal).toBeCloseTo(agg.cost.previous, 10);
    expect(breakdown.currentTotal).toBeCloseTo(agg.cost.current, 10);

    // Sum of per-model current values == currentTotal (no leakage).
    const sumCurrent = breakdown.rows.reduce((s, r) => s + r.current, 0);
    expect(sumCurrent).toBeCloseTo(breakdown.currentTotal, 10);

    // Two models appear in the current week.
    const keys = breakdown.rows.map((r) => r.key).sort();
    expect(keys).toContain('claude-sonnet-4-5');
    expect(keys).toContain('claude-haiku-4-5');
  });

  it('decomposes by day and lists contributing sessions sorted by |delta|', () => {
    const tokenData = [
      tokenSession([
        tokenEntry('2026-01-06T00:00:00Z', 1000), // prev, session 's'
        tokenEntry('2026-01-13T00:00:00Z', 5000), // now,  session 's'
      ]),
    ];
    const breakdown = computeWeeklyDeltaBreakdown({
      tokenData,
      apiErrors: [],
      toolData: [],
      projects: [{ sessionId: 's', project: 'proj-x' }],
      signal: 'cost',
      dimension: 'day',
      currentWeekStart,
      previousWeekStart,
    });

    // Two distinct days, keyed by YYYY-MM-DD.
    const dayKeys = breakdown.rows.map((r) => r.key).sort();
    expect(dayKeys).toEqual(['2026-01-06', '2026-01-13']);

    // The single session shows up in the contributing list with both weeks.
    expect(breakdown.sessions.length).toBe(1);
    expect(breakdown.sessions[0].sessionId).toBe('s');
    expect(breakdown.sessions[0].project).toBe('proj-x');
    expect(breakdown.sessions[0].current).toBeGreaterThan(
      breakdown.sessions[0].previous
    );
  });

  it('excludes units outside the two compared weeks', () => {
    const apiErrors = [
      apiError('2026-01-13T01:00:00Z'), // current week
      apiError('2026-01-20T01:00:00Z'), // week C — must NOT count
      apiError('2025-12-01T01:00:00Z'), // far older — must NOT count
    ];
    const breakdown = computeWeeklyDeltaBreakdown({
      tokenData: [],
      apiErrors,
      toolData: [],
      projects: [],
      signal: 'errors',
      dimension: 'day',
      currentWeekStart,
      previousWeekStart,
    });
    expect(breakdown.currentTotal).toBe(1);
    expect(breakdown.previousTotal).toBe(0);
    expect(breakdown.rows.length).toBe(1);
  });
});
