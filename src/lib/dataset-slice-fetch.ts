// Bounded-concurrency slice-batch runner, extracted from dataset-slice-worker.ts
// (#3122).
//
// Why it exists separately from the worker: `fetchDatasetProgressive` posts a
// batch of ~19 heavy slice URLs (~98 MB parsed on real data) and the worker used
// to map the WHOLE batch into one `Promise.all`, opening all ~19 fetches at once.
// Every response body then landed and was `JSON.parse`d with no ceiling on how
// many large decodes were in flight together, so peak memory tracked the whole
// batch rather than a small working set. This runs the same fetches through a
// small fixed-width pool instead: at most `SLICE_FETCH_CONCURRENCY` fetch+parse
// pairs are ever active, each completed slice is still posted the instant it
// lands (unchanged progressive render), a failed slice never stops the ones
// behind it, and `done` is posted only after every slice has settled.
//
// The runner takes `fetchImpl` and `post` as parameters and holds no `self` /
// `fetch` / `postMessage` reference of its own, so (a) it is importable and
// deterministically testable in the node test env — unlike the worker module,
// whose top-level `self` access throws off-thread — and (b) the `fetch` literal
// stays in dataset-slice-worker.ts, keeping that file the registered
// NETWORK_OWNER for scripts/check-inbound-boundary.mjs.

/** One heavy per-view slice to fetch + decode. */
export interface SliceRequest {
  key: string;
  url: string;
}

/** A batch of slices plus the headers to forward on each fetch. */
export interface SliceBatch {
  slices: SliceRequest[];
  headers?: Record<string, string>;
}

/** Messages the runner emits back toward the main thread. */
export type SliceMessage =
  | { type: 'slice'; key: string; value: unknown; version: string | null }
  | { type: 'slice-error'; key: string; error: string }
  | { type: 'done' };

/**
 * How many slice fetch+parse pairs may be in flight at once (#3122).
 *
 * Two–three keeps the network usefully busy while bounding peak memory to a
 * small working set of large decodes rather than the whole ~98 MB batch. Three
 * is the ceiling: the win over two is marginal and each extra in-flight slice is
 * another multi-MB parsed value held live at the same time.
 */
export const SLICE_FETCH_CONCURRENCY = 3;

/** The minimal fetch surface the runner needs — matches the DOM `fetch`. */
export type SliceFetch = (
  url: string,
  init: { credentials: RequestCredentials; headers: Headers }
) => Promise<Response>;

export interface FetchSliceBatchOptions {
  fetchImpl: SliceFetch;
  post: (message: SliceMessage) => void;
  /** Max fetch+parse pairs in flight; defaults to {@link SLICE_FETCH_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Fetch + decode every slice in `batch` through a bounded-width pool, posting
 * each result as it lands and a single `done` once all have settled.
 *
 * Guarantees, each of which the test in dataset-slice-fetch.test.ts pins:
 * - At most `concurrency` fetches are ever active simultaneously.
 * - Every slice is posted exactly once (a `slice` on success, a `slice-error`
 *   on a non-ok response or a thrown fetch/parse).
 * - A failing slice does not stop the slices behind it — each pool worker just
 *   moves to the next index.
 * - `done` is posted last, exactly once, only after every slice settled.
 */
export async function fetchSliceBatch(
  batch: SliceBatch | undefined,
  { fetchImpl, post, concurrency = SLICE_FETCH_CONCURRENCY }: FetchSliceBatchOptions
): Promise<void> {
  const slices = batch?.slices ?? [];
  const headers = batch?.headers ?? {};
  const limit = Math.max(1, Math.floor(concurrency));

  // A shared cursor the pool workers pull from: each grabs the next unclaimed
  // index and processes it, so no more than `limit` are ever between grab and
  // post at once. This bounds in-flight work by the number of workers, not by
  // the batch size.
  let nextIndex = 0;
  async function poolWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= slices.length) return;
      const { key, url } = slices[index];
      try {
        const resp = await fetchImpl(url, {
          credentials: 'same-origin',
          headers: new Headers(headers),
        });
        if (!resp.ok) {
          post({
            type: 'slice-error',
            key,
            error: `dataset slice '${key}' failed: ${resp.status}`,
          });
          continue;
        }
        const value = await resp.json();
        const version = resp.headers.get('X-Dataset-Version');
        post({ type: 'slice', key, value, version });
      } catch (err) {
        post({
          type: 'slice-error',
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, slices.length) },
    () => poolWorker()
  );
  await Promise.all(workers);
  post({ type: 'done' });
}
