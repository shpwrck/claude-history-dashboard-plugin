import { describe, expect, it } from 'vitest';
import type { SessionTokenData, Session } from '../types';
import { attributeCostByProject, UNKNOWN_PROJECT_BUCKET } from './cost-attribution';
import { computeCostTrend } from './cost-trend';
import {
  spendByProject,
  spendByProjectShare,
  spendByDay,
  spendByModel,
  spendByTokenType,
  spendBySessionType,
  modelFamily,
  spendTotals,
  sessionTotalTokens,
} from './summary';

// Minimal fixtures — only the fields the lib helpers read, cast to the shared
// types. NOTE: estimateCost (via attributeCostByProject) iterates `entries`,
// while the token rollups read the top-level total*Tokens; both are populated
// and kept consistent here, exactly as real ingest produces them.
const sessions = [
  { sessionId: 'sess-aaa', project: '/home/user/alpha', projectShort: 'alpha' },
  { sessionId: 'sess-bbb', project: '/home/user/beta', projectShort: 'beta' },
] as unknown as Session[];

function tok(
  sessionId: string,
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalCacheReadTokens: cacheRead,
    model: 'claude-3-5-sonnet-20241022',
    messageCount: 1,
    entries: [
      {
        timestamp: '2026-01-01T09:30:00.000Z',
        model: 'claude-3-5-sonnet-20241022',
        inputTokens: input,
        outputTokens: output,
        cacheCreationTokens: cacheCreation,
        cacheCreation1hTokens: 0,
        cacheReadTokens: cacheRead,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

describe('sessionTotalTokens', () => {
  it('sums all four token types', () => {
    expect(sessionTotalTokens(tok('s', 1, 2, 3, 4))).toBe(10);
  });
});

describe('spendTotals', () => {
  it('sums token types across sessions and counts them', () => {
    const totals = spendTotals([tok('a', 100, 10, 5, 1), tok('b', 50, 5, 0, 2)]);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(15);
    expect(totals.cacheCreationTokens).toBe(5);
    expect(totals.cacheReadTokens).toBe(3);
    expect(totals.totalTokens).toBe(173);
    expect(totals.sessionCount).toBe(2);
    expect(totals.cost).toBeGreaterThan(0);
  });

  it('returns zeros for an empty dataset', () => {
    const totals = spendTotals([]);
    expect(totals.totalTokens).toBe(0);
    expect(totals.cost).toBe(0);
    expect(totals.sessionCount).toBe(0);
  });
});

describe('spendByProject', () => {
  it('ranks projects by total tokens descending', () => {
    // beta has more total tokens than alpha despite alpha being added first.
    const rows = spendByProject(
      [tok('sess-aaa', 1_000, 100, 0, 0), tok('sess-bbb', 5_000, 500, 200, 0)],
      sessions
    );
    expect(rows.map((r) => r.project)).toEqual([
      '/home/user/beta',
      '/home/user/alpha',
    ]);
    expect(rows[0].totalTokens).toBe(5_700);
    expect(rows[1].totalTokens).toBe(1_100);
  });

  it('breaks tokens out by type per project', () => {
    const [row] = spendByProject([tok('sess-aaa', 10, 20, 30, 40)], sessions);
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(20);
    expect(row.cacheCreationTokens).toBe(30);
    expect(row.cacheReadTokens).toBe(40);
    expect(row.totalTokens).toBe(100);
    expect(row.sessionCount).toBe(1);
  });

  it('matches attributeCostByProject cost figures exactly', () => {
    const data = [tok('sess-aaa', 10_000, 500, 0, 0), tok('sess-bbb', 5_000, 200, 0, 0)];
    const summaryRows = spendByProject(data, sessions);
    const costRows = attributeCostByProject(data, sessions);
    const costByProject = new Map(costRows.map((r) => [r.project, r.estimatedCost]));
    for (const row of summaryRows) {
      expect(row.cost).toBe(costByProject.get(row.project));
    }
  });

  it('buckets sessions with an unknown project into _unknown', () => {
    const rows = spendByProject([tok('orphan-session', 100, 0, 0, 0)], sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe(UNKNOWN_PROJECT_BUCKET);
    expect(rows[0].totalTokens).toBe(100);
  });

  it('returns an empty array for no token data', () => {
    expect(spendByProject([], sessions)).toEqual([]);
  });
});

/** A session whose entries carry explicit timestamps (for by-day bucketing). */
function tokDays(
  sessionId: string,
  entries: { ts: string; input: number; output: number }[]
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((s, e) => s + e.input, 0),
    totalOutputTokens: entries.reduce((s, e) => s + e.output, 0),
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-3-5-sonnet-20241022',
    messageCount: entries.length,
    entries: entries.map((e) => ({
      timestamp: e.ts,
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: e.input,
      outputTokens: e.output,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    })),
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

describe('spendByDay', () => {
  it('buckets entries by UTC day, sorted ascending', () => {
    const rows = spendByDay([
      tokDays('s1', [
        { ts: '2026-01-02T10:00:00.000Z', input: 100, output: 10 },
        { ts: '2026-01-01T23:00:00.000Z', input: 200, output: 20 },
      ]),
      tokDays('s2', [{ ts: '2026-01-01T08:00:00.000Z', input: 50, output: 5 }]),
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-02']);
    // Day 1: 200+20 (s1) + 50+5 (s2) = 275 tokens over 2 entries.
    expect(rows[0].totalTokens).toBe(275);
    expect(rows[0].entries).toBe(2);
    // Day 2: 100+10 = 110 tokens over 1 entry.
    expect(rows[1].totalTokens).toBe(110);
    expect(rows[1].entries).toBe(1);
  });

  it('drops entries with an unparseable timestamp', () => {
    const rows = spendByDay([
      tokDays('s1', [
        { ts: 'not-a-date', input: 999, output: 99 },
        { ts: '2026-03-15T12:00:00.000Z', input: 10, output: 1 },
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-03-15');
    expect(rows[0].totalTokens).toBe(11);
  });

  it('per-day cost equals computeCostTrend daily cost by construction', () => {
    const data = [
      tokDays('s1', [
        { ts: '2026-01-01T10:00:00.000Z', input: 10_000, output: 500 },
        { ts: '2026-01-02T10:00:00.000Z', input: 5_000, output: 200 },
      ]),
    ];
    const byDay = spendByDay(data);
    const trend = computeCostTrend(data);
    const trendByDate = new Map(trend.daily.map((d) => [d.date, d.cost]));
    for (const row of byDay) {
      expect(row.cost).toBeCloseTo(trendByDate.get(row.date) ?? -1, 10);
    }
  });

  it('returns an empty array for no token data', () => {
    expect(spendByDay([])).toEqual([]);
  });
});

/** A session whose entries carry explicit per-entry models (for by-model). */
function tokModels(
  sessionId: string,
  entries: { model: string; input: number; output: number }[]
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((s, e) => s + e.input, 0),
    totalOutputTokens: entries.reduce((s, e) => s + e.output, 0),
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries: entries.map((e) => ({
      timestamp: '2026-01-01T10:00:00.000Z',
      model: e.model,
      inputTokens: e.input,
      outputTokens: e.output,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
    })),
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

describe('modelFamily', () => {
  it('maps model strings to families', () => {
    expect(modelFamily('claude-fable-5')).toBe('Fable');
    expect(modelFamily('claude-mythos-5')).toBe('Mythos');
    expect(modelFamily('claude-opus-4-8')).toBe('Opus');
    expect(modelFamily('claude-3-5-sonnet-20241022')).toBe('Sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('Haiku');
    expect(modelFamily('<synthetic>')).toBe('Synthetic');
    expect(modelFamily('unknown')).toBe('Unknown');
    expect(modelFamily('gpt-4o')).toBe('Unknown');
  });
});

describe('spendByModel', () => {
  it('aggregates per family across entries, ranked by tokens', () => {
    const rows = spendByModel([
      tokModels('s1', [
        { model: 'claude-opus-4-8', input: 1_000, output: 100 },
        { model: 'claude-haiku-4-5-20251001', input: 50, output: 5 },
      ]),
      tokModels('s2', [
        { model: 'claude-3-5-sonnet-20241022', input: 500, output: 50 },
      ]),
    ]);
    expect(rows.map((r) => r.family)).toEqual(['Opus', 'Sonnet', 'Haiku']);
    expect(rows[0].totalTokens).toBe(1_100);
    expect(rows[0].entries).toBe(1);
    // Opus is priced far above sonnet/haiku, so it leads on cost too.
    expect(rows[0].cost).toBeGreaterThan(rows[1].cost);
  });

  it('token totals across families equal the grand total', () => {
    const data = [
      tokModels('s1', [
        { model: 'claude-opus-4-8', input: 1_000, output: 100 },
        { model: 'claude-3-5-sonnet-20241022', input: 500, output: 50 },
      ]),
    ];
    const sum = spendByModel(data).reduce((s, r) => s + r.totalTokens, 0);
    expect(sum).toBe(spendTotals(data).totalTokens);
  });

  it('puts missing/unrecognized models in the Unknown bucket', () => {
    const rows = spendByModel([
      tokModels('s1', [{ model: 'unknown', input: 10, output: 1 }]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe('Unknown');
    expect(rows[0].totalTokens).toBe(11);
  });

  it('prices real Fable traffic in its own model bucket', () => {
    const rows = spendByModel([
      tokModels('s1', [
        { model: 'claude-fable-5', input: 1_000_000, output: 1_000_000 },
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].family).toBe('Fable');
    expect(rows[0].cost).toBeCloseTo(60, 9);
  });

  it('returns an empty array for no token data', () => {
    expect(spendByModel([])).toEqual([]);
  });
});

describe('spendByTokenType', () => {
  it('returns the four types in fixed order, summing each across sessions', () => {
    const rows = spendByTokenType([
      tok('a', 100, 10, 5, 1),
      tok('b', 50, 5, 0, 2),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      'input',
      'output',
      'cacheCreation',
      'cacheRead',
    ]);
    expect(rows.map((r) => r.tokens)).toEqual([150, 15, 5, 3]);
  });

  it('token totals equal the grand total', () => {
    const data = [tok('a', 100, 10, 5, 1), tok('b', 50, 5, 0, 2)];
    const sum = spendByTokenType(data).reduce((s, r) => s + r.tokens, 0);
    expect(sum).toBe(spendTotals(data).totalTokens);
  });

  it('keeps cache-write and cache-read distinct', () => {
    const [, , write, read] = spendByTokenType([tok('a', 0, 0, 7, 9)]);
    expect(write.label).toBe('Cache Write');
    expect(write.tokens).toBe(7);
    expect(read.label).toBe('Cache Read');
    expect(read.tokens).toBe(9);
  });

  it('returns four zero rows for no token data', () => {
    expect(spendByTokenType([]).map((r) => r.tokens)).toEqual([0, 0, 0, 0]);
  });
});

describe('spendByProjectShare', () => {
  it('keeps the top N and folds the tail into an Other bucket', () => {
    // alpha=1100 tokens, beta=5700 → beta ranks first.
    const data = [tok('sess-aaa', 1_000, 100, 0, 0), tok('sess-bbb', 5_000, 700, 0, 0)];
    const rows = spendByProjectShare(data, sessions, 1);
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('~/beta');
    expect(rows[1].label).toBe('Other (1 project)');
    expect(rows[1].tokens).toBe(1_100);
  });

  it('shares sum to the grand total (so percentages reach 100%)', () => {
    const data = [tok('sess-aaa', 1_000, 100, 0, 0), tok('sess-bbb', 5_000, 700, 0, 0)];
    const sum = spendByProjectShare(data, sessions, 1).reduce((s, r) => s + r.tokens, 0);
    expect(sum).toBe(spendTotals(data).totalTokens);
  });

  it('adds no Other row when projects fit within topN', () => {
    const data = [tok('sess-aaa', 1_000, 100, 0, 0), tok('sess-bbb', 5_000, 700, 0, 0)];
    const rows = spendByProjectShare(data, sessions, 8);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.label.startsWith('Other'))).toBe(false);
  });

  it('returns an empty array for no token data', () => {
    expect(spendByProjectShare([], sessions)).toEqual([]);
  });
});

describe('spendBySessionType', () => {
  const classify = (id: string): string | undefined =>
    ({ 'sess-aaa': 'single_task', 'sess-bbb': 'quick_question' } as Record<string, string>)[id];

  it('buckets spend by sessionType, prettifying labels', () => {
    const rows = spendBySessionType(
      [tok('sess-aaa', 5_000, 500, 0, 0), tok('sess-bbb', 100, 10, 0, 0)],
      classify
    );
    expect(rows.map((r) => r.label)).toEqual(['Single task', 'Quick question']);
    expect(rows[0].tokens).toBe(5_500);
    expect(rows[0].uncategorized).toBe(false);
  });

  it('puts sessions with no facet in an explicit Uncategorized bucket, sorted last', () => {
    const rows = spendBySessionType(
      [
        tok('sess-aaa', 5_000, 500, 0, 0), // single_task
        tok('orphan', 9_000, 900, 0, 0), // no facet → Uncategorized (more tokens)
      ],
      classify
    );
    // Despite more tokens, Uncategorized is forced last.
    expect(rows[rows.length - 1].uncategorized).toBe(true);
    expect(rows[rows.length - 1].label).toBe('Uncategorized');
    const uncat = rows.find((r) => r.uncategorized);
    expect(uncat?.tokens).toBe(9_900);
  });

  it('with no classifier, every session is Uncategorized (signals the partial state)', () => {
    const rows = spendBySessionType([tok('sess-aaa', 100, 10, 0, 0)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].uncategorized).toBe(true);
    expect(rows.some((r) => !r.uncategorized)).toBe(false);
  });

  it('never drops a session: token totals equal the grand total', () => {
    const data = [tok('sess-aaa', 5_000, 500, 0, 0), tok('orphan', 9_000, 900, 0, 0)];
    const sum = spendBySessionType(data, classify).reduce((s, r) => s + r.tokens, 0);
    expect(sum).toBe(spendTotals(data).totalTokens);
  });

  it('returns an empty array for no token data', () => {
    expect(spendBySessionType([])).toEqual([]);
  });
});
