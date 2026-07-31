import { describe, it, expect } from 'vitest';
import { selectMaximalProcedures, type Procedure } from './procedural-memory';

// ---------------------------------------------------------------------------
// #3240 — the maximal-window selection used `qualifying.filter(p =>
// !qualifying.some(q => …))`, an all-pairs O(C^2) scan over every qualifying
// window on each evaluation. It now indexes candidates by their proper
// contiguous sub-blocks, so a candidate only checks its actual supersequences.
// The predicate is unchanged, so the selected set matches the reference exactly;
// the probe counts INDEXED reads of the qualifying array to show the candidate
// enumeration is now linear in the number of qualifying windows.
// ---------------------------------------------------------------------------

function proc(
  project: string,
  groupKeys: string[],
  sessions: string[]
): Procedure {
  return {
    key: `${project}::${groupKeys.join('>')}`,
    project,
    groupKeys,
    stepKeys: groupKeys,
    steps: groupKeys,
    verbSteps: groupKeys,
    sessions: new Set(sessions),
    latestTs: 0,
    sources: new Set(['input.command']),
    fromPreview: false,
  };
}

/** Original O(C^2) definition, kept verbatim as the equivalence oracle. */
function referenceMaximal(qualifying: Procedure[]): Procedure[] {
  const isContiguous = (sub: string[], sup: string[]): boolean => {
    if (sub.length > sup.length) return false;
    for (let s = 0; s + sub.length <= sup.length; s += 1) {
      let ok = true;
      for (let k = 0; k < sub.length; k += 1) {
        if (sup[s + k] !== sub[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  const isSubset = (a: Set<string>, b: Set<string>): boolean => {
    for (const x of a) if (!b.has(x)) return false;
    return true;
  };
  return qualifying.filter(
    (p) =>
      !qualifying.some(
        (q) =>
          q !== p &&
          q.groupKeys.length > p.groupKeys.length &&
          isContiguous(p.groupKeys, q.groupKeys) &&
          isSubset(p.sessions, q.sessions)
      )
  );
}

const keys = (procs: Procedure[]): string[] => procs.map((p) => p.key).sort();

function countingProcedures(
  procs: Procedure[],
  counter: { visits: number }
): Procedure[] {
  return new Proxy(procs, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        counter.visits += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every length-3..8 window over a K-command run, all in the same 3 sessions. */
function windows(K: number, sessions = ['s1', 's2', 's3']): Procedure[] {
  const run = Array.from({ length: K }, (_, i) => `c${i}`);
  const procs: Procedure[] = [];
  for (let len = 3; len <= 8; len += 1) {
    for (let start = 0; start + len <= K; start += 1) {
      procs.push(proc('/p', run.slice(start, start + len), sessions));
    }
  }
  return procs;
}

describe('selectMaximalProcedures matches the all-pairs reference (#3240)', () => {
  it('suppresses a sub-window subsumed by a longer, session-superset window', () => {
    const p = proc('/p', ['a', 'b', 'c'], ['s1', 's2', 's3']);
    const q = proc('/p', ['a', 'b', 'c', 'd'], ['s1', 's2', 's3']);
    expect(keys(selectMaximalProcedures([p, q]))).toEqual(keys([q]));
  });

  it('keeps a higher-support sub-window (finding #5)', () => {
    const p = proc('/p', ['a', 'b', 'c'], ['s1', 's2', 's3', 's4']); // more sessions
    const q = proc('/p', ['a', 'b', 'c', 'd'], ['s1', 's2', 's3']);
    expect(keys(selectMaximalProcedures([p, q]))).toEqual(keys([p, q]));
  });

  it('keeps a non-contiguous shorter sequence', () => {
    const p = proc('/p', ['a', 'c'], ['s1', 's2', 's3']);
    const q = proc('/p', ['a', 'b', 'c', 'd'], ['s1', 's2', 's3']);
    expect(keys(selectMaximalProcedures([p, q]))).toEqual(keys([p, q]));
  });

  it('never subsumes across projects (disjoint sessions)', () => {
    const p = proc('/p', ['a', 'b', 'c'], ['s1', 's2', 's3']);
    const q = proc('/q', ['a', 'b', 'c', 'd'], ['t1', 't2', 't3']);
    expect(keys(selectMaximalProcedures([p, q]))).toEqual(keys([p, q]));
  });

  it('agrees with the reference on the three-identical-long-sessions windows', () => {
    const qs = windows(20);
    expect(keys(selectMaximalProcedures(qs))).toEqual(keys(referenceMaximal(qs)));
  });

  it('agrees with the reference across randomized candidate sets', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'e'];
    const sessionPool = ['s1', 's2', 's3', 's4', 's5'];
    for (let seed = 1; seed <= 40; seed += 1) {
      const rnd = mulberry32(seed);
      const count = 4 + Math.floor(rnd() * 14);
      const qs = Array.from({ length: count }, () => {
        const len = 2 + Math.floor(rnd() * 4);
        const gk = Array.from(
          { length: len },
          () => alphabet[Math.floor(rnd() * alphabet.length)]
        );
        const sess = sessionPool.filter(() => rnd() < 0.6);
        return proc(
          '/p',
          gk,
          sess.length ? sess : ['s1'] // never empty
        );
      });
      // De-dupe identical keys so the unique-key comparison is well-defined.
      const seen = new Set<string>();
      const unique = qs.filter((p) =>
        seen.has(p.key) ? false : (seen.add(p.key), true)
      );
      expect(keys(selectMaximalProcedures(unique))).toEqual(
        keys(referenceMaximal(unique))
      );
    }
  });
});

describe('selectMaximalProcedures enumerates candidates linearly (#3240)', () => {
  it('reads the qualifying array ~linearly, not quadratically', () => {
    const measure = (k: number) => {
      const counter = { visits: 0 };
      const qs = windows(k);
      selectMaximalProcedures(countingProcedures(qs, counter));
      return { visits: counter.visits, count: qs.length };
    };

    const small = measure(40);
    const large = measure(80);

    // Old all-pairs scan read count^2 elements (~42,000 at k=40).
    expect(small.visits).toBeLessThan(2000);
    expect(large.visits / small.visits).toBeLessThan(3);
  });
});
