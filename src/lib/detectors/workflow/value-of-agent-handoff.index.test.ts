import { describe, it, expect } from 'vitest';
import {
  indexTransitionsByProjectKey,
  indexBarriersByProject,
} from './value-of-agent-handoff';

// ---------------------------------------------------------------------------
// #3251 — collectPreSignals filtered the FULL crossSessionTransitions and
// crossSessionInvalidationBarriers arrays inside the per-final-state loop
// (O(F x T) per evaluation). It now buckets each once. These pins prove the
// buckets answer exactly what the naive filter did (same members, same order,
// null-project transitions dropped) and that F lookups do zero further scans of
// the source array.
// ---------------------------------------------------------------------------

type Transition = Parameters<typeof indexTransitionsByProjectKey>[0][number];
type Barrier = Parameters<typeof indexBarriersByProject>[0][number];

function transition(
  sessionId: string,
  project: string | null,
  key: string
): Transition {
  return {
    sessionId,
    project,
    key,
    order: 0,
    toolUseId: 't',
    toolName: 'Bash',
  } as unknown as Transition;
}

function barrier(sessionId: string, project: string): Barrier {
  return {
    sessionId,
    project,
    order: 0,
    toolUseId: 't',
    toolName: 'Bash',
    ambiguityReason: 'truncated-path-tail',
  } as unknown as Barrier;
}

function counting<T extends object>(arr: T[], counter: { visits: number }): T[] {
  return new Proxy(arr, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        counter.visits += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('indexTransitionsByProjectKey answers the naive filter exactly (#3251)', () => {
  const transitions: Transition[] = [
    transition('s1', '/p', 'k1'),
    transition('s2', '/p', 'k1'),
    transition('s3', '/q', 'k1'),
    transition('s4', '/p', 'k2'),
    transition('s5', null, 'k1'), // null project can never match — dropped
    transition('s6', '/p', 'k1'),
  ];

  it('buckets by project+key, preserving array order', () => {
    const index = indexTransitionsByProjectKey(transitions);
    expect(index.get('/p\0k1')?.map((t) => t.sessionId)).toEqual([
      's1',
      's2',
      's6',
    ]);
    expect(index.get('/p\0k2')?.map((t) => t.sessionId)).toEqual(['s4']);
    expect(index.get('/q\0k1')?.map((t) => t.sessionId)).toEqual(['s3']);
  });

  it('drops null-project transitions (they never matched the loop predicate)', () => {
    const index = indexTransitionsByProjectKey(transitions);
    const all = [...index.values()].flat();
    expect(all.some((t) => t.sessionId === 's5')).toBe(false);
  });

  it('equals `transitions.filter(project & key)` for every bucket', () => {
    const index = indexTransitionsByProjectKey(transitions);
    for (const project of ['/p', '/q']) {
      for (const key of ['k1', 'k2']) {
        const bucket = index.get(`${project}\0${key}`) ?? [];
        const naive = transitions.filter(
          (t) => t.project === project && t.key === key
        );
        expect(bucket).toEqual(naive);
      }
    }
  });
});

describe('indexBarriersByProject buckets by project in order (#3251)', () => {
  it('preserves order and matches the naive filter', () => {
    const barriers: Barrier[] = [
      barrier('s1', '/p'),
      barrier('s2', '/q'),
      barrier('s3', '/p'),
    ];
    const index = indexBarriersByProject(barriers);
    expect(index.get('/p')?.map((b) => b.sessionId)).toEqual(['s1', 's3']);
    expect(index.get('/q')?.map((b) => b.sessionId)).toEqual(['s2']);
    expect(index.get('/p')).toEqual(barriers.filter((b) => b.project === '/p'));
  });
});

describe('the transition index removes the per-final-state full scan (#3251)', () => {
  it('builds in one pass, then answers lookups with zero further array reads', () => {
    const T = 200;
    const transitions = Array.from({ length: T }, (_, i) =>
      transition(`s${i}`, `/p${i % 5}`, `k${i % 7}`)
    );
    const counter = { visits: 0 };
    const index = indexTransitionsByProjectKey(counting(transitions, counter));

    const afterBuild = counter.visits;
    // One pass over the transitions to build the buckets.
    expect(afterBuild).toBeLessThanOrEqual(T * 2);

    // Resolve 60 final states — each is a Map.get, never a full-array filter.
    for (let f = 0; f < 60; f += 1) {
      index.get(`/p${f % 5}\0k${f % 7}`);
    }
    expect(counter.visits).toBe(afterBuild);
  });
});
