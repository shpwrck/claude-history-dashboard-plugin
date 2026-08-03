/**
 * Tests for parse-stats-cache.ts
 *
 * Fixtures are shaped exactly like the `~/.claude/stats-cache.json` artifact
 * (derived from the P1-Sam prototype mock data in `proto/539-stats-cache/index.html`).
 */
import { describe, it, expect } from 'vitest';
import { parseStatsCache, analyzeActivityTrend } from './parse-stats-cache';

// ── Shared fixture (mirrors proto/539-stats-cache mock data) ──────────────

const FIXTURE_DAYS = [
  // last week (older 7)
  { date: '2026-05-21', messageCount: 1017, sessionCount: 1,  toolCallCount: 337 },
  { date: '2026-05-22', messageCount: 806,  sessionCount: 1,  toolCallCount: 181 },
  { date: '2026-05-23', messageCount: 19,   sessionCount: 3,  toolCallCount: 18  },
  { date: '2026-05-24', messageCount: 25,   sessionCount: 2,  toolCallCount: 0   },
  { date: '2026-05-25', messageCount: 430,  sessionCount: 5,  toolCallCount: 402 },
  { date: '2026-05-26', messageCount: 1570, sessionCount: 9,  toolCallCount: 791 },
  { date: '2026-05-27', messageCount: 1233, sessionCount: 7,  toolCallCount: 644 },
  // this week (recent 7)
  { date: '2026-05-28', messageCount: 4075, sessionCount: 38, toolCallCount: 2052 },
  { date: '2026-05-29', messageCount: 3529, sessionCount: 37, toolCallCount: 1595 },
  { date: '2026-05-30', messageCount: 6551, sessionCount: 54, toolCallCount: 2132 },
  { date: '2026-05-31', messageCount: 5570, sessionCount: 58, toolCallCount: 1865 },
  { date: '2026-06-01', messageCount: 2110, sessionCount: 21, toolCallCount: 1208 },
  { date: '2026-06-02', messageCount: 3890, sessionCount: 34, toolCallCount: 1744 },
  { date: '2026-06-03', messageCount: 4620, sessionCount: 41, toolCallCount: 1980 },
];

const FIXTURE_JSON = JSON.stringify({
  version: 3,
  lastComputedDate: '2026-06-03',
  dailyActivity: FIXTURE_DAYS,
});

// ── parseStatsCache ───────────────────────────────────────────────────────

describe('parseStatsCache', () => {
  it('parses a well-formed JSON string into a StatsCache', () => {
    const result = parseStatsCache(FIXTURE_JSON);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(3);
    expect(result!.lastComputedDate).toBe('2026-06-03');
    expect(result!.dailyActivity).toHaveLength(14);
  });

  it('preserves daily activity fields exactly', () => {
    const result = parseStatsCache(FIXTURE_JSON)!;
    const first = result.dailyActivity[0];
    expect(first.date).toBe('2026-05-21');
    expect(first.messageCount).toBe(1017);
    expect(first.sessionCount).toBe(1);
    expect(first.toolCallCount).toBe(337);
  });

  it('sorts dailyActivity chronologically even if out of order in the file', () => {
    const reversed = JSON.stringify({
      version: 3,
      lastComputedDate: '2026-06-03',
      dailyActivity: [...FIXTURE_DAYS].reverse(),
    });
    const result = parseStatsCache(reversed)!;
    expect(result.dailyActivity[0].date).toBe('2026-05-21');
    expect(result.dailyActivity[13].date).toBe('2026-06-03');
  });

  it('returns null for null/undefined/empty input', () => {
    expect(parseStatsCache(null)).toBeNull();
    expect(parseStatsCache(undefined)).toBeNull();
    expect(parseStatsCache('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStatsCache('not json')).toBeNull();
    expect(parseStatsCache('{broken')).toBeNull();
  });

  it('returns null when lastComputedDate is missing', () => {
    const bad = JSON.stringify({ version: 3, dailyActivity: [] });
    expect(parseStatsCache(bad)).toBeNull();
  });

  it('rejects malformed or impossible lastComputedDate values (#3154)', () => {
    for (const lastComputedDate of ['not-a-date', '2026/06/03', '2026-02-30']) {
      expect(parseStatsCache(JSON.stringify({
        version: 3,
        lastComputedDate,
        dailyActivity: [],
      }))).toBeNull();
    }
  });

  it('skips malformed dailyActivity rows and keeps valid ones', () => {
    const mixed = JSON.stringify({
      version: 3,
      lastComputedDate: '2026-06-03',
      dailyActivity: [
        null,
        'string-not-object',
        { date: '2026-06-01', messageCount: 10, sessionCount: 1, toolCallCount: 5 },
        { toolCallCount: 5 }, // missing date → skipped
        { date: 'not-a-date', messageCount: 1, sessionCount: 1, toolCallCount: 1 },
        { date: '2026-02-30', messageCount: 1, sessionCount: 1, toolCallCount: 1 },
      ],
    });
    const result = parseStatsCache(mixed)!;
    expect(result.dailyActivity).toHaveLength(1);
    expect(result.dailyActivity[0].date).toBe('2026-06-01');
  });

  it('skips rows with missing, negative, or non-finite activity counts (#3154)', () => {
    const malformedCounts = JSON.stringify({
      version: 3,
      lastComputedDate: '2026-06-03',
      dailyActivity: [
        { date: '2026-06-01' },
        { date: '2026-06-02', messageCount: -1, sessionCount: 1, toolCallCount: 1 },
        { date: '2026-06-03', messageCount: 1, sessionCount: '1', toolCallCount: 1 },
        { date: '2026-06-04', messageCount: 1, sessionCount: 1, toolCallCount: 'OVERFLOW' },
      ],
    }).replace('"OVERFLOW"', '1e309');

    expect(parseStatsCache(malformedCounts)?.dailyActivity).toEqual([]);
  });
});

// ── analyzeActivityTrend ─────────────────────────────────────────────────

describe('analyzeActivityTrend', () => {
  const cache = parseStatsCache(FIXTURE_JSON)!;

  // Prototype reference values (computed the same way as the prototype JS):
  // last7 toolCallCount sum: 337+181+18+0+402+791+644 = 2373
  // this7 toolCallCount sum: 2052+1595+2132+1865+1208+1744+1980 = 12576
  // pct = round(((12576-2373)/2373)*100) = round(429.8...) = 430
  const TC_LAST = 337 + 181 + 18 + 0 + 402 + 791 + 644;   // 2373
  const TC_THIS = 2052 + 1595 + 2132 + 1865 + 1208 + 1744 + 1980; // 12576

  it('computes correct toolCallCount WoW sums', () => {
    const analysis = analyzeActivityTrend(cache);
    expect(analysis.toolCallCount.lastWeek).toBe(TC_LAST);
    expect(analysis.toolCallCount.thisWeek).toBe(TC_THIS);
  });

  it('computes correct toolCallCount pctChange matching the prototype', () => {
    const analysis = analyzeActivityTrend(cache);
    const expected = Math.round(((TC_THIS - TC_LAST) / TC_LAST) * 100);
    expect(analysis.toolCallCount.pctChange).toBe(expected);
    expect(expected).toBeGreaterThan(400); // prototype shows ~430%
  });

  it('returns verdict "hotter" for the fixture (WoW >> 15%)', () => {
    const analysis = analyzeActivityTrend(cache);
    expect(analysis.verdict).toBe('hotter');
  });

  it('returns verdict "cooler" when this week is materially lower', () => {
    // Scale this week DOWN to ~10% of last week — clearly cooler.
    const coolerDays = [
      ...FIXTURE_DAYS.slice(0, 7),
      ...FIXTURE_DAYS.slice(7).map((d) => ({ ...d, toolCallCount: Math.round(d.toolCallCount * 0.1) })),
    ];
    const coolerCache = parseStatsCache(
      JSON.stringify({ version: 3, lastComputedDate: '2026-06-03', dailyActivity: coolerDays })
    )!;
    const analysis = analyzeActivityTrend(coolerCache);
    expect(analysis.verdict).toBe('cooler');
  });

  it('returns verdict "flat" when both weeks are identical', () => {
    const flatDays = FIXTURE_DAYS.map((d) => ({ ...d, toolCallCount: 100 }));
    const flatCache = parseStatsCache(
      JSON.stringify({ version: 3, lastComputedDate: '2026-06-03', dailyActivity: flatDays })
    )!;
    const analysis = analyzeActivityTrend(flatCache);
    expect(analysis.verdict).toBe('flat');
    expect(analysis.toolCallCount.pctChange).toBe(0);
  });

  it('handles zero lastWeek gracefully (returns 100% when thisWeek > 0)', () => {
    const zeroDays = [
      ...FIXTURE_DAYS.slice(0, 7).map((d) => ({ ...d, toolCallCount: 0 })),
      ...FIXTURE_DAYS.slice(7),
    ];
    const zeroCache = parseStatsCache(
      JSON.stringify({ version: 3, lastComputedDate: '2026-06-03', dailyActivity: zeroDays })
    )!;
    const analysis = analyzeActivityTrend(zeroCache);
    expect(analysis.toolCallCount.pctChange).toBe(100);
    expect(analysis.verdict).toBe('hotter');
  });

  it('handles zero lastWeek AND zero thisWeek (flat, 0%)', () => {
    const allZero = FIXTURE_DAYS.map((d) => ({ ...d, toolCallCount: 0 }));
    const zeroCache = parseStatsCache(
      JSON.stringify({ version: 3, lastComputedDate: '2026-06-03', dailyActivity: allZero })
    )!;
    const analysis = analyzeActivityTrend(zeroCache);
    expect(analysis.toolCallCount.pctChange).toBe(0);
    expect(analysis.verdict).toBe('flat');
  });

  it('emits a 14-element sparkline for a full 14-day cache', () => {
    const analysis = analyzeActivityTrend(cache);
    expect(analysis.sparkline).toHaveLength(14);
    expect(analysis.sparkline[0]).toBe(FIXTURE_DAYS[0].toolCallCount);
    expect(analysis.sparkline[13]).toBe(FIXTURE_DAYS[13].toolCallCount);
  });

  it('emits a shorter sparkline when fewer than 14 rows are present', () => {
    const shortCache = parseStatsCache(
      JSON.stringify({
        version: 3,
        lastComputedDate: '2026-06-03',
        dailyActivity: FIXTURE_DAYS.slice(0, 5),
      })
    )!;
    const analysis = analyzeActivityTrend(shortCache);
    expect(analysis.sparkline).toHaveLength(5);
  });

  it('computes session and message WoW correctly', () => {
    const analysis = analyzeActivityTrend(cache);
    const scLast = FIXTURE_DAYS.slice(0, 7).reduce((s, d) => s + d.sessionCount, 0);
    const scThis = FIXTURE_DAYS.slice(7).reduce((s, d) => s + d.sessionCount, 0);
    expect(analysis.sessionCount.lastWeek).toBe(scLast);
    expect(analysis.sessionCount.thisWeek).toBe(scThis);

    const mcLast = FIXTURE_DAYS.slice(0, 7).reduce((s, d) => s + d.messageCount, 0);
    const mcThis = FIXTURE_DAYS.slice(7).reduce((s, d) => s + d.messageCount, 0);
    expect(analysis.messageCount.lastWeek).toBe(mcLast);
    expect(analysis.messageCount.thisWeek).toBe(mcThis);
  });

  // ── Week boundary (the split is always last 14 rows, older-7 vs recent-7) ──

  it('uses the last 14 rows only when more than 14 rows exist', () => {
    // Prepend 3 extra rows with very high tool calls — they should be ignored.
    const extraDays = [
      { date: '2026-05-18', messageCount: 0, sessionCount: 0, toolCallCount: 99999 },
      { date: '2026-05-19', messageCount: 0, sessionCount: 0, toolCallCount: 99999 },
      { date: '2026-05-20', messageCount: 0, sessionCount: 0, toolCallCount: 99999 },
      ...FIXTURE_DAYS,
    ];
    const bigCache = parseStatsCache(
      JSON.stringify({ version: 3, lastComputedDate: '2026-06-03', dailyActivity: extraDays })
    )!;
    const analysis = analyzeActivityTrend(bigCache);
    // Should match the standard fixture analysis (extra rows outside the 14-day window).
    expect(analysis.toolCallCount.lastWeek).toBe(TC_LAST);
    expect(analysis.toolCallCount.thisWeek).toBe(TC_THIS);
  });

  // ── Staleness ─────────────────────────────────────────────────────────────

  it('marks stale=false when lastComputedDate is today', () => {
    const now = new Date('2026-06-03T12:00:00Z').getTime();
    const analysis = analyzeActivityTrend(cache, now);
    expect(analysis.stale).toBe(false);
  });

  it('marks stale=false when lastComputedDate is 1 day ago', () => {
    const now = new Date('2026-06-04T00:00:00Z').getTime();
    const analysis = analyzeActivityTrend(cache, now);
    expect(analysis.stale).toBe(false);
  });

  it('marks stale=true when lastComputedDate is more than 2 days ago', () => {
    const now = new Date('2026-06-07T00:00:00Z').getTime();
    const analysis = analyzeActivityTrend(cache, now);
    expect(analysis.stale).toBe(true);
  });

  it('magnitude equals absolute value of pctChange', () => {
    const analysis = analyzeActivityTrend(cache);
    expect(analysis.magnitude).toBe(Math.abs(analysis.toolCallCount.pctChange));
  });
});
