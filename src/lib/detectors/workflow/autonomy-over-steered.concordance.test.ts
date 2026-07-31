import { describe, it, expect } from 'vitest';
import { divergenceAutonomyConcordance } from './autonomy-over-steered';
import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';

// ---------------------------------------------------------------------------
// #3233 — the monotone-inverse concordance gate used to compare every matched
// pair in an n(n-1)/2 double loop on every detector evaluation. It is now a
// Goodman–Kruskal gamma computed in O(n log n) (sort by divergence + count score
// inversions). These tests pin (a) exact equivalence to the old pairwise
// definition, including every tie shape, and (b) that a 100,000-row corpus —
// ~5e9 pairwise iterations under the old code — completes and returns the
// analytically-known value.
// ---------------------------------------------------------------------------

// keyOf is module-private; it is `${sessionId}\0${taskIndex}`.
const key = (sessionId: string, taskIndex: number) =>
  `${sessionId}\0${taskIndex}`;

function makeInputs(pairs: Array<[number, number]>) {
  const rows = pairs.map(
    ([divergence], i) =>
      ({
        sessionId: `s${i}`,
        taskIndex: 0,
        divergenceRate: divergence,
      }) as unknown as TaskSteering
  );
  const successByTask = new Map<string, TaskSuccessProxy>(
    pairs.map(([, score], i) => [
      key(`s${i}`, 0),
      { successScore: score } as unknown as TaskSuccessProxy,
    ])
  );
  return { rows, successByTask };
}

const run = (pairs: Array<[number, number]>): number | null => {
  const { rows, successByTask } = makeInputs(pairs);
  return divergenceAutonomyConcordance(rows, successByTask);
};

/** The original O(n^2) definition, kept verbatim as the equivalence oracle. */
function referenceConcordance(pairs: Array<[number, number]>): number | null {
  if (pairs.length < 3) return null;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const dDiv = pairs[i][0] - pairs[j][0];
      const dScore = pairs[i][1] - pairs[j][1];
      if (dDiv === 0 || dScore === 0) continue;
      if (Math.sign(dDiv) === Math.sign(dScore)) concordant += 1;
      else discordant += 1;
    }
  }
  const total = concordant + discordant;
  if (total === 0) return null;
  return (concordant - discordant) / total;
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

describe('divergenceAutonomyConcordance equals the pairwise reference (#3233)', () => {
  it('returns null below the minimum span count', () => {
    expect(run([[0.1, 1], [0.2, 2]])).toBeNull();
  });

  it('is null when every pair ties in a dimension', () => {
    expect(run([[1, 1], [1, 2], [1, 3]])).toBeNull(); // all divergence-tied
    expect(run([[1, 5], [2, 5], [3, 5]])).toBeNull(); // all score-tied
  });

  it('matches the reference on hand-built tie mixes', () => {
    const cases: Array<Array<[number, number]>> = [
      [[1, 1], [2, 2], [3, 1]],
      [[1, 5], [1, 2], [2, 9]],
      [[1, 1], [1, 1], [2, 2]],
      [[0.1, 0.9], [0.4, 0.5], [0.7, 0.2], [0.9, 0.1]],
    ];
    for (const pairs of cases) {
      expect(run(pairs)).toBe(referenceConcordance(pairs));
    }
  });

  it('matches the reference across randomized tie-heavy corpora', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rnd = mulberry32(seed);
      const n = 3 + Math.floor(rnd() * 14);
      const pairs = Array.from(
        { length: n },
        () => [Math.floor(rnd() * 5), Math.floor(rnd() * 5)] as [number, number]
      );
      expect(run(pairs)).toBe(referenceConcordance(pairs));
    }
  });

  it('scales to 100,000 rows and returns the analytic value', () => {
    const N = 100_000;
    const monotone = Array.from(
      { length: N },
      (_, i) => [i, i] as [number, number]
    );
    expect(run(monotone)).toBe(1); // all concordant

    const inverse = Array.from(
      { length: N },
      (_, i) => [i, N - i] as [number, number]
    );
    expect(run(inverse)).toBe(-1); // all discordant
  });
});
