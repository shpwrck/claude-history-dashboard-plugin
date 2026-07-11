/// <reference lib="webworker" />
//
// Off-thread dataset-slice decoder (#2448). Sibling of dataset-worker.ts (#162):
// the boot-first loader (instant-load.ts) posts a batch of heavy per-view slice
// URLs and this worker does the `fetch` + `JSON.parse` for each OFF the main
// thread, posting each parsed slice back as it lands (`{ type: 'slice' }`), then
// a final `{ type: 'done' }`.
//
// Why it exists: `fetchDatasetProgressive` kicks off all ~19 heavy slices
// (~98 MB parsed on real data — timelines/toolData/tokenData dominate) at once.
// Decoding them with `Response.json()` on the UI thread put the exact large JSON
// parse dataset-worker.ts was built to offload back onto the main thread, which
// can freeze interaction right after the boot shell paints. Moving the parse
// here keeps the main thread free; the parsed values are structured-cloned back
// per-slice (same mechanism as dataset-worker.ts, but spread across smaller
// messages instead of one monolith).
//
// URLs arrive as PARAMS (no `/api/` literal lives here), so — like
// dataset-worker.ts — this is a registered NETWORK_OWNER
// (scripts/check-inbound-boundary.mjs). It is imported only by instant-load.ts,
// which the SPA/sample build aliases to a stub, so this chunk never reaches the
// upload-only bundle.

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface SliceRequest {
  key: string;
  url: string;
}

interface SliceBatch {
  slices: SliceRequest[];
  headers?: Record<string, string>;
}

ctx.onmessage = async (e: MessageEvent<SliceBatch>) => {
  const { slices, headers } = e.data;
  // Fetch every slice concurrently; each parse runs here (off the UI thread) and
  // its result is posted the moment it resolves, so the main thread deserializes
  // slices one at a time rather than in one large task.
  await Promise.all(
    (slices ?? []).map(async ({ key, url }) => {
      try {
        const resp = await fetch(url, {
          credentials: 'same-origin',
          headers: new Headers(headers ?? {}),
        });
        if (!resp.ok) {
          ctx.postMessage({
            type: 'slice-error',
            key,
            error: `dataset slice '${key}' failed: ${resp.status}`,
          });
          return;
        }
        const value = await resp.json();
        const version = resp.headers.get('X-Dataset-Version');
        ctx.postMessage({ type: 'slice', key, value, version });
      } catch (err) {
        ctx.postMessage({
          type: 'slice-error',
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
  ctx.postMessage({ type: 'done' });
};
