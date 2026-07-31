import { describe, it, expect } from 'vitest';
import {
  buildSessionProjectIndex,
  filterApiErrorsByRoute,
  filterToolDataByRoute,
  makeLazySessionProjectResolver,
  sessionProject,
} from './route-filtering';
import type { Session } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';

// ---------------------------------------------------------------------------
// #3172 — project route filtering performed quadratic session lookups.
//
// `sessionProject()` is an `Array.find` over the whole session list. Both
// `filterToolDataByRoute` and `filterApiErrorsByRoute` called it once per ROW,
// so a project-filtered view cost O(rows x sessions) even though session ->
// project attribution is static for the whole operation.
//
// The probe counts INDEXED READS of the sessions array (a Proxy `get` trap on
// numeric keys) rather than timing anything, so it is deterministic and
// immune to host contention. Both the old `find` scan and the new one-pass
// index read elements through that same trap, which makes the counts directly
// comparable:
//
//   old: row i resolves session i, so `find` visits i+1 elements
//        -> n(n+1)/2 visits   (n=100 -> 5,050;  n=200 -> 20,100)
//   new: one pass over the sessions to build the index
//        -> exactly n visits  (n=100 ->   100;  n=200 ->    200)
// ---------------------------------------------------------------------------

function session(sessionId: string, project: string): Session {
  return { sessionId, project } as unknown as Session;
}

function toolRow(sessionId: string): ToolUsageData {
  return {
    sessionId,
    calls: [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'u',
        isError: null,
        resultBytes: 0,
      },
    ],
  } as unknown as ToolUsageData;
}

function apiErrorRow(sessionId: string): ApiErrorEvent {
  return {
    sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: 'boom',
  } as ApiErrorEvent;
}

/** Wrap a session array so every indexed element read is counted. */
function countingSessions(
  sessions: Session[],
  counter: { visits: number }
): Session[] {
  return new Proxy(sessions, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        counter.visits += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function fixture(n: number) {
  return {
    sessions: Array.from({ length: n }, (_, i) => session(`s${i}`, `/proj-${i}`)),
    toolRows: Array.from({ length: n }, (_, i) => toolRow(`s${i}`)),
    errorRows: Array.from({ length: n }, (_, i) => apiErrorRow(`s${i}`)),
  };
}

describe('route filtering resolves projects in linear session work (#3172)', () => {
  it('visits each session once for a project-filtered tool-data filter', () => {
    const measure = (n: number) => {
      const counter = { visits: 0 };
      const { sessions, toolRows } = fixture(n);
      const out = filterToolDataByRoute(
        toolRows,
        countingSessions(sessions, counter),
        { project: 'proj' }
      );
      return { visits: counter.visits, kept: out.length };
    };

    const small = measure(100);
    const large = measure(200);

    // Every row matches, so nothing is short-circuited away.
    expect(small.kept).toBe(100);
    expect(large.kept).toBe(200);

    // The contract: session work is bounded by the session count, not by
    // rows x sessions. The old scan blew straight past this (5,050 / 20,100).
    expect(small.visits).toBeLessThanOrEqual(100);
    expect(large.visits).toBeLessThanOrEqual(200);

    // Doubling the corpus roughly doubles the work; quadratic would quadruple.
    expect(large.visits / small.visits).toBeLessThan(3);
  });

  it('visits each session once for a project-filtered api-error filter', () => {
    const measure = (n: number) => {
      const counter = { visits: 0 };
      const { sessions, errorRows } = fixture(n);
      const out = filterApiErrorsByRoute(
        errorRows,
        countingSessions(sessions, counter),
        { project: 'proj' }
      );
      return { visits: counter.visits, kept: out.length };
    };

    const small = measure(100);
    const large = measure(200);

    expect(small.kept).toBe(100);
    expect(large.kept).toBe(200);
    expect(small.visits).toBeLessThanOrEqual(100);
    expect(large.visits).toBeLessThanOrEqual(200);
    expect(large.visits / small.visits).toBeLessThan(3);
  });

  it('builds no index at all when the filter carries no project key', () => {
    // A date-only filter never asks for attribution, so it must not pay for it.
    const counter = { visits: 0 };
    const { sessions, toolRows } = fixture(50);
    filterToolDataByRoute(toolRows, countingSessions(sessions, counter), {
      date: '2026-01-01',
    });
    expect(counter.visits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Equivalence: the index must answer exactly what `Array.find` answered.
//
// The load-bearing case is a DUPLICATED session id. `Array.find` returns the
// EARLIEST match, so the index has to be first-write-wins; a plain per-session
// `set` would keep the LAST entry and silently change results on exactly the
// large corpora the index exists to speed up.
// ---------------------------------------------------------------------------
describe('the session-project index answers exactly what Array.find did (#3172)', () => {
  const awkward: Session[] = [
    session('dup', '/first-wins'),
    session('dup', '/last-would-be-wrong'),
    session('plain', '/plain'),
    session('empty-project', ''),
    { sessionId: 'no-project' } as unknown as Session,
  ];

  it('agrees with sessionProject() for every id, including duplicates and gaps', () => {
    const index = buildSessionProjectIndex(awkward);
    for (const id of [
      'dup',
      'plain',
      'empty-project',
      'no-project',
      'absent-entirely',
    ]) {
      expect(index.get(id)).toBe(sessionProject(id, awkward));
    }
    // Spelled out, so a first-write-wins regression names itself in the diff.
    expect(index.get('dup')).toBe('/first-wins');
  });

  it('returns an empty index for undefined sessions', () => {
    expect(buildSessionProjectIndex(undefined).size).toBe(0);
    expect(sessionProject('anything', undefined)).toBeUndefined();
  });

  it('keeps filtered rows identical to the pre-index reference implementation', () => {
    const rows = [
      toolRow('dup'),
      toolRow('plain'),
      toolRow('empty-project'),
      toolRow('no-project'),
      toolRow('absent-entirely'),
    ];

    // The exact predicate the old code ran, expressed with the Array.find helper.
    const reference = (project: string) =>
      rows
        .filter((row) => {
          const found = sessionProject(row.sessionId, awkward);
          return (found ?? '').toLowerCase().includes(project.toLowerCase());
        })
        .map((row) => row.sessionId);

    for (const project of ['first-wins', 'last-would-be-wrong', 'plain', '/']) {
      expect(
        filterToolDataByRoute(rows, awkward, { project }).map((r) => r.sessionId)
      ).toEqual(reference(project));
    }

    // 'last-would-be-wrong' is the discriminator: it must match NOTHING,
    // because 'dup' resolves to the first entry.
    expect(
      filterToolDataByRoute(rows, awkward, { project: 'last-would-be-wrong' })
    ).toEqual([]);
  });

  it('keeps a project-less api-error filter matching every row it did before', () => {
    // `textIncludes(value, undefined)` is `true`, so a date-only error filter
    // must not start consulting attribution. Rows for unknown sessions stay.
    const rows = [apiErrorRow('absent-entirely'), apiErrorRow('plain')];
    expect(filterApiErrorsByRoute(rows, awkward, { date: '2026-01-01' })).toEqual(
      rows
    );
    expect(filterApiErrorsByRoute(rows, awkward, { date: '2026-01-02' })).toEqual(
      []
    );
  });
});

// ---------------------------------------------------------------------------
// #3468 — the LAZY resolver shared by the four `src/components` route-filter
// sites. It must build the session index at most once, only on genuine first
// use, and preserve `buildSessionProjectIndex`'s first-write-wins semantics.
// ---------------------------------------------------------------------------
describe('makeLazySessionProjectResolver builds its index lazily and once (#3468)', () => {
  it('does no session work until the first lookup, then exactly one pass', () => {
    const counter = { visits: 0 };
    const { sessions } = fixture(100);
    const resolve = makeLazySessionProjectResolver(
      countingSessions(sessions, counter)
    );

    // Constructed but never queried yet — the #3481 non-querying path pays zero.
    expect(counter.visits).toBe(0);

    expect(resolve('s0')).toBe('/proj-0');
    const afterFirst = counter.visits;
    // One pass over the sessions to build the index, then O(1) lookups.
    expect(afterFirst).toBeLessThanOrEqual(100);
    for (let i = 0; i < 100; i += 1) resolve(`s${i}`);
    expect(counter.visits).toBe(afterFirst);
  });

  it('is first-write-wins for duplicated ids, exactly like sessions.find()', () => {
    const dups: Session[] = [
      session('dup', '/first-wins'),
      session('dup', '/last-would-be-wrong'),
      { sessionId: 'no-project' } as unknown as Session,
    ];
    const resolve = makeLazySessionProjectResolver(dups);
    for (const id of ['dup', 'no-project', 'absent']) {
      expect(resolve(id)).toBe(sessionProject(id, dups));
    }
    expect(resolve('dup')).toBe('/first-wins');
  });

  it('never builds an index for an undefined session list', () => {
    const resolve = makeLazySessionProjectResolver(undefined);
    expect(resolve('anything')).toBeUndefined();
  });
});
