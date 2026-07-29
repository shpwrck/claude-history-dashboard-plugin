import { describe, it, expect } from 'vitest';
import { filterCostDataByRoute, reclaimScopedInput } from './cost-scope';
import type { SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { Session } from '../types';

// #2718: the server-safe boundary these surfaces reuse. The masthead
// (filterViewDataByTime/Project) and route (filterCostDataByRoute) filters are the
// moved-verbatim client code already covered by view-registry.test.ts /
// cost-attribution.test.ts; here we lock the two seams the typed surfaces add on
// top: the reduced reclaim engine input and the route filter's public re-export.

function tokenRow(over: Partial<SessionTokenData>): SessionTokenData {
  return {
    sessionId: 's',
    project: '/tmp/demo',
    model: 'claude-opus-4',
    entrypoint: 'cli',
    serviceTier: 'standard',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: 0,
    entries: [],
    compactionEvents: [],
    ...over,
  } as SessionTokenData;
}

describe('reclaimScopedInput (#2718)', () => {
  it('passes the three route-scoped Cost collections through and empties the non-Cost required fields', () => {
    const tokenData = [tokenRow({ sessionId: 's1' })];
    const toolData = [{ sessionId: 's1' }] as unknown as ToolUsageData[];
    const sessions = [{ sessionId: 's1' }] as unknown as Session[];

    const input = reclaimScopedInput({ tokenData, toolData, sessions });

    expect(input.tokenData).toBe(tokenData);
    expect(input.toolData).toBe(toolData);
    expect(input.sessions).toBe(sessions);
    expect(input.projects).toEqual([]);
    expect(input.permissionRows).toEqual([]);
    expect(input.apiErrors).toEqual([]);
  });

  it('leaks no optional engine signal (scope stays exactly the Reclaim card shape)', () => {
    const input = reclaimScopedInput({ tokenData: [], toolData: [], sessions: [] });
    expect(Object.keys(input).sort()).toEqual([
      'apiErrors',
      'permissionRows',
      'projects',
      'sessions',
      'tokenData',
      'toolData',
    ]);
  });

  it('reuses stable empty collections across Reclaim card rerenders', () => {
    const scoped = { tokenData: [], toolData: [], sessions: [] };
    const first = reclaimScopedInput(scoped);
    const second = reclaimScopedInput(scoped);

    expect(second.projects).toBe(first.projects);
    expect(second.permissionRows).toBe(first.permissionRows);
    expect(second.apiErrors).toBe(first.apiErrors);
  });
});

describe('filterCostDataByRoute re-export (#2718)', () => {
  const tokenData = [
    tokenRow({ sessionId: 'a', model: 'claude-opus-4' }),
    tokenRow({ sessionId: 'b', model: 'claude-sonnet-4' }),
  ];
  const toolData = [
    { sessionId: 'a' },
    { sessionId: 'b' },
  ] as unknown as ToolUsageData[];
  const sessions = [
    { sessionId: 'a' },
    { sessionId: 'b' },
  ] as unknown as Session[];

  it('no route filter passes every collection through untouched', () => {
    const scoped = filterCostDataByRoute(tokenData, toolData, sessions, undefined);
    expect(scoped.tokenData).toHaveLength(2);
    expect(scoped.toolData).toBe(toolData);
    expect(scoped.sessions).toBe(sessions);
  });

  it('routeMode substring-matches the model and projects survivors onto toolData/sessions', () => {
    const scoped = filterCostDataByRoute(tokenData, toolData, sessions, { mode: 'opus' });
    expect(scoped.tokenData.map((r) => r.sessionId)).toEqual(['a']);
    expect(scoped.toolData.map((r) => r.sessionId)).toEqual(['a']);
    expect(scoped.sessions.map((r) => r.sessionId)).toEqual(['a']);
  });

  it('composes fuzzy project and entry-date matching before projecting session rows', () => {
    const datedTokenData = [
      tokenRow({
        sessionId: 'a',
        project: '/work/Alpha-Service',
        entries: [{ timestamp: '2026-07-01T12:00:00.000Z' }] as never[],
      }),
      tokenRow({
        sessionId: 'b',
        project: '/work/Alpha-Service',
        entries: [{ timestamp: '2026-07-02T12:00:00.000Z' }] as never[],
      }),
    ];

    const scoped = filterCostDataByRoute(
      datedTokenData,
      toolData,
      sessions,
      { project: 'alpha-service', date: '2026-07-01' }
    );

    expect(scoped.tokenData.map((row) => row.sessionId)).toEqual(['a']);
    expect(scoped.toolData.map((row) => row.sessionId)).toEqual(['a']);
    expect(scoped.sessions.map((row) => row.sessionId)).toEqual(['a']);
  });

  it('gives routeMode precedence over routeEntrypoint and falls back when mode is absent', () => {
    const routedTokenData = [
      tokenRow({ sessionId: 'a', model: 'claude-opus-4', entrypoint: 'cli' }),
      tokenRow({ sessionId: 'b', model: 'claude-sonnet-4', entrypoint: 'sdk-cli' }),
    ];

    expect(
      filterCostDataByRoute(routedTokenData, toolData, sessions, {
        mode: 'opus',
        entrypoint: 'sdk-',
      }).tokenData.map((row) => row.sessionId)
    ).toEqual(['a']);
    expect(
      filterCostDataByRoute(routedTokenData, toolData, sessions, {
        entrypoint: 'sdk-',
      }).tokenData.map((row) => row.sessionId)
    ).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// #3172 (beyond the finding's stated scope) — the Cost route filter had the
// SAME quadratic shape as the two filters the finding named. `sessionProject`
// is an `Array.find` and `tokenDataMatchesRoute` is called once per row, so a
// project drill cost O(rows x sessions) here too. The finding listed only
// `src/lib/route-filtering.ts`; the defect is the call shape, not the module.
//
// Same deterministic probe: count indexed reads of the sessions array.
//   old: rows x sessions visits (100x100 -> 5,050 with matching indices)
//   new: one index pass         (100x100 ->   100)
// ---------------------------------------------------------------------------
describe('filterCostDataByRoute resolves projects in linear session work (#3172)', () => {
  const countingSessions = (rows: Session[], counter: { visits: number }): Session[] =>
    new Proxy(rows, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) counter.visits += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

  // `project: undefined` is the case that actually reaches `sessionProject` —
  // a row carrying its own project short-circuits the lookup entirely.
  const measure = (n: number) => {
    const counter = { visits: 0 };
    const sessions = Array.from(
      { length: n },
      (_, i) => ({ sessionId: `s${i}`, project: `/proj-${i}` }) as unknown as Session
    );
    const tokenData = Array.from({ length: n }, (_, i) =>
      tokenRow({ sessionId: `s${i}`, project: undefined })
    );
    const scoped = filterCostDataByRoute(
      tokenData,
      [] as unknown as ToolUsageData[],
      countingSessions(sessions, counter),
      { project: 'proj' }
    );
    return { visits: counter.visits, kept: scoped.tokenData.length };
  };

  it('visits each session a bounded number of times for a project-filtered cost drill', () => {
    const small = measure(100);
    const large = measure(200);

    expect(small.kept).toBe(100);
    expect(large.kept).toBe(200);

    // TWO linear passes are expected and correct: one builds the index, one
    // projects the surviving session rows at the end of filterCostDataByRoute.
    // The contract is that session work stays a CONSTANT multiple of the
    // session count. The old per-row `find` came to 5,150 / 20,300 here.
    expect(small.visits).toBeLessThanOrEqual(2 * 100);
    expect(large.visits).toBeLessThanOrEqual(2 * 200);

    // Doubling the corpus roughly doubles the work; quadratic would quadruple.
    expect(large.visits / small.visits).toBeLessThan(3);
  });

  it('still prefers the row-carried project over session attribution', () => {
    // The `??` short-circuit is load-bearing: a row that names its own project
    // must never be re-attributed through the index.
    const sessions = [
      { sessionId: 'a', project: '/from-session' },
    ] as unknown as Session[];
    const tokenData = [tokenRow({ sessionId: 'a', project: '/from-row' })];

    expect(
      filterCostDataByRoute(tokenData, [] as unknown as ToolUsageData[], sessions, {
        project: 'from-row',
      }).tokenData.map((r) => r.sessionId)
    ).toEqual(['a']);
    expect(
      filterCostDataByRoute(tokenData, [] as unknown as ToolUsageData[], sessions, {
        project: 'from-session',
      }).tokenData
    ).toEqual([]);
  });

  it('falls back to session attribution when the row carries none, including misses', () => {
    const sessions = [
      { sessionId: 'known', project: '/attributed' },
    ] as unknown as Session[];
    const tokenData = [
      tokenRow({ sessionId: 'known', project: undefined }),
      tokenRow({ sessionId: 'unknown-session', project: undefined }),
    ];

    expect(
      filterCostDataByRoute(tokenData, [] as unknown as ToolUsageData[], sessions, {
        project: 'attributed',
      }).tokenData.map((r) => r.sessionId)
    ).toEqual(['known']);
  });
});
