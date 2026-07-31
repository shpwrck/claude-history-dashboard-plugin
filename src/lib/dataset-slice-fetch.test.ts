import { describe, it, expect } from 'vitest';
import {
  fetchSliceBatch,
  SLICE_FETCH_CONCURRENCY,
  type SliceBatch,
  type SliceMessage,
} from './dataset-slice-fetch';

// A fetch stub that (a) records the peak number of simultaneously in-flight
// fetches so the concurrency ceiling can be asserted, and (b) resolves each
// fetch on a caller-controlled tick so overlap is deterministic rather than
// timing-dependent. `fail` keys reject; every other key resolves ok with a body.
function makeInstrumentedFetch(opts: {
  fail?: Set<string>;
  badStatus?: Map<string, number>;
}) {
  let active = 0;
  let peak = 0;
  const resolvers: Array<() => void> = [];
  const keyOf = (url: string) => url.replace(/^slice:/, '');
  const fetchImpl = ((url: string) => {
    active++;
    peak = Math.max(peak, active);
    const key = keyOf(url);
    return new Promise<Response>((resolve, reject) => {
      // Hold the fetch open until release() is pumped, so all fetches admitted
      // by the pool overlap and `peak` reflects the true ceiling.
      resolvers.push(() => {
        active--;
        if (opts.fail?.has(key)) {
          reject(new Error(`network down for ${key}`));
          return;
        }
        const status = opts.badStatus?.get(key) ?? 200;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (h: string) => (h === 'X-Dataset-Version' ? 'v1' : null) },
          json: async () => ({ key, payload: `body-${key}` }),
        } as unknown as Response);
      });
    });
  }) as unknown as Parameters<typeof fetchSliceBatch>[1]['fetchImpl'];

  // Drain any pending fetches, then keep draining as the pool admits more, until
  // no fetch is outstanding. Each microtask flush lets the pool grab its next.
  async function drain() {
    while (resolvers.length > 0) {
      const pending = resolvers.splice(0, resolvers.length);
      for (const r of pending) r();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  return { fetchImpl, drain, peak: () => peak };
}

function makeBatch(n: number): SliceBatch {
  return {
    slices: Array.from({ length: n }, (_, i) => ({
      key: `k${i}`,
      url: `slice:k${i}`,
    })),
    headers: { 'X-Test': '1' },
  };
}

describe('fetchSliceBatch (#3122 bounded concurrency)', () => {
  it('never exceeds the concurrency ceiling for a 19-item batch', async () => {
    const posted: SliceMessage[] = [];
    const inst = makeInstrumentedFetch({});
    const run = fetchSliceBatch(makeBatch(19), {
      fetchImpl: inst.fetchImpl,
      post: (m) => posted.push(m),
      concurrency: 3,
    });
    await inst.drain();
    await run;

    expect(inst.peak()).toBeLessThanOrEqual(3);
    // Every slice posted exactly once, plus one final done.
    const slices = posted.filter((m) => m.type === 'slice');
    expect(slices).toHaveLength(19);
    const keys = new Set(slices.map((m) => (m as { key: string }).key));
    expect(keys.size).toBe(19);
    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(posted[posted.length - 1].type).toBe('done');
  });

  it('a failing slice does not stop the slices behind it', async () => {
    const posted: SliceMessage[] = [];
    const inst = makeInstrumentedFetch({
      fail: new Set(['k2']),
      badStatus: new Map([['k5', 500]]),
    });
    const run = fetchSliceBatch(makeBatch(19), {
      fetchImpl: inst.fetchImpl,
      post: (m) => posted.push(m),
      concurrency: 2,
    });
    await inst.drain();
    await run;

    expect(inst.peak()).toBeLessThanOrEqual(2);
    const errors = posted.filter((m) => m.type === 'slice-error');
    const errorKeys = new Set(errors.map((m) => (m as { key: string }).key));
    expect(errorKeys).toEqual(new Set(['k2', 'k5']));
    // The other 17 still succeeded.
    expect(posted.filter((m) => m.type === 'slice')).toHaveLength(17);
    // done is still posted, last and once, after every slice settled.
    expect(posted.filter((m) => m.type === 'done')).toHaveLength(1);
    expect(posted[posted.length - 1].type).toBe('done');
  });

  it('posts done immediately for an empty batch and defaults concurrency', async () => {
    const posted: SliceMessage[] = [];
    const inst = makeInstrumentedFetch({});
    await fetchSliceBatch(
      { slices: [] },
      { fetchImpl: inst.fetchImpl, post: (m) => posted.push(m) }
    );
    expect(posted).toEqual([{ type: 'done' }]);
    expect(SLICE_FETCH_CONCURRENCY).toBeGreaterThanOrEqual(2);
  });
});
