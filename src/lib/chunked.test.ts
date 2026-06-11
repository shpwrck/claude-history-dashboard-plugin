import { describe, it, expect } from 'vitest';
import { mapChunked } from './chunked';

describe('mapChunked', () => {
  it('produces the same result as a plain map, in order', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const out = await mapChunked(items, (n) => n * 2, { chunkSize: 64 });
    expect(out).toEqual(items.map((n) => n * 2));
  });

  it('passes the index to fn', async () => {
    const out = await mapChunked(['a', 'b', 'c'], (v, i) => `${i}:${v}`, {
      chunkSize: 2,
    });
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('handles an empty array without yielding', async () => {
    let progressCalls = 0;
    const out = await mapChunked<number, number>([], (n) => n, {
      onProgress: () => progressCalls++,
    });
    expect(out).toEqual([]);
    expect(progressCalls).toBe(0);
  });

  it('reports monotonic progress ending at the total', async () => {
    const calls: Array<[number, number]> = [];
    await mapChunked(Array.from({ length: 10 }, (_, i) => i), (n) => n, {
      chunkSize: 4,
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it('clamps a non-positive chunkSize to 1 rather than looping forever', async () => {
    const out = await mapChunked([1, 2, 3], (n) => n + 1, { chunkSize: 0 });
    expect(out).toEqual([2, 3, 4]);
  });
});
