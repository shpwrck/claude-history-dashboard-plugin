import { describe, it, expect } from 'vitest';
import { clusterProject, type OpenerRecord } from './session-restart-retype';

// ---------------------------------------------------------------------------
// #3245 — clusterProject used to enumerate all n(n-1)/2 opener pairs, only
// SKIPPING the Jaccard for out-of-window pairs. It now sweeps a timestamp-sorted
// 7-day window, so pairs beyond the window are never enumerated. The behaviour
// (components, pairs, a/b ordering) is byte-identical; the probe counts INDEXED
// reads of the records array (Proxy `get` trap) to show enumeration is now
// bounded by window occupancy, not the full corpus.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function record(
  sessionId: string,
  tsMs: number,
  shingles: string[],
  project = '/repo/app'
): OpenerRecord {
  return {
    sessionId,
    project,
    projectShort: 'app',
    tsMs,
    opener: sessionId,
    shingles: new Set(shingles),
  };
}

function countingRecords(
  records: OpenerRecord[],
  counter: { visits: number }
): OpenerRecord[] {
  return new Proxy(records, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        counter.visits += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const SHARED = ['git', 'pull', 'npm', 'run', 'build', 'docker', 'push'];

describe('clusterProject preserves clustering behaviour (#3245)', () => {
  it('clusters near-duplicates in-window and drops the out-of-window record', () => {
    const records = [
      record('a', 0, SHARED),
      record('b', 1 * DAY, SHARED),
      record('c', 60 * DAY, SHARED), // > 7 days from a & b — no edge
    ];
    const clusters = clusterProject(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.sessionId).sort()).toEqual([
      'a',
      'b',
    ]);
    // a/b are the lower/higher original index, exactly as the old loop assigned.
    const pair = clusters[0].pairs[0];
    expect(pair.a.sessionId).toBe('a');
    expect(pair.b.sessionId).toBe('b');
    expect(pair.similarity).toBe(1);
  });

  it('clusters correctly regardless of input timestamp order', () => {
    const records = [
      record('late', 3 * DAY, SHARED),
      record('early', 0, SHARED),
      record('mid', 1 * DAY, SHARED),
    ];
    const clusters = clusterProject(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.sessionId).sort()).toEqual([
      'early',
      'late',
      'mid',
    ]);
    // All three pairwise combinations are within window and identical.
    expect(clusters[0].pairs).toHaveLength(3);
  });

  it('leaves disjoint openers unclustered even inside the window', () => {
    const records = [
      record('x', 0, ['alpha', 'beta', 'gamma']),
      record('y', 1 * DAY, ['delta', 'epsilon', 'zeta']),
    ];
    expect(clusterProject(records)).toHaveLength(0);
  });
});

describe('clusterProject enumerates sub-quadratically on sparse histories (#3245)', () => {
  it('reads grow ~linearly, not quadratically, when records are window-separated', () => {
    const sparse = (n: number): OpenerRecord[] =>
      Array.from({ length: n }, (_, i) =>
        record(`s${i}`, i * 8 * DAY, [`opener-${i}`])
      );
    const measure = (n: number): number => {
      const counter = { visits: 0 };
      clusterProject(countingRecords(sparse(n), counter));
      return counter.visits;
    };

    const small = measure(100);
    const large = measure(200);

    // Old all-pairs enumeration read ~n(n-1) elements (9,900 at n=100).
    expect(small).toBeLessThan(3000);
    expect(large / small).toBeLessThan(3);
  });
});
