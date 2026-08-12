/// <reference lib="webworker" />
//
// Off-thread dataset-slice decoder (#2448). Sibling of dataset-worker.ts (#162):
// the boot-first loader (instant-load.ts) posts a batch of heavy per-view slice
// URLs and this worker does the `fetch` + `JSON.parse` for each OFF the main
// thread, posting each parsed slice back as it lands (`{ type: 'slice' }`), then
// a final `{ type: 'done' }`.
//
// Why it exists: `fetchDatasetProgressive` posts all ~19 heavy slices
// (~98 MB parsed on real data — timelines/toolData/tokenData dominate). Decoding
// them with `Response.json()` on the UI thread put the exact large JSON parse
// dataset-worker.ts was built to offload back onto the main thread, which can
// freeze interaction right after the boot shell paints. Moving the parse here
// keeps the main thread free; the parsed values are structured-cloned back
// per-slice (same mechanism as dataset-worker.ts, but spread across smaller
// messages instead of one monolith).
//
// The fetch+parse fan-out is bounded (#3122): the batch used to map entirely
// into one `Promise.all`, so all ~19 large decodes could be resolving live at
// once and peak memory tracked the whole batch. `fetchSliceBatch` runs them
// through a small fixed-width pool instead (see dataset-slice-fetch.ts), still
// posting each slice the moment it lands. The concurrency logic lives in that
// pure sibling so it is testable off-thread; the `fetch` literal stays HERE so
// this file remains the registered NETWORK_OWNER for
// scripts/check-inbound-boundary.mjs.
//
// URLs arrive as PARAMS (no `/api/` literal lives here). It is imported only by
// instant-load.ts, which the SPA/sample build aliases to a stub, so this chunk
// never reaches the public sample bundle.

import { fetchSliceBatch, type SliceBatch } from './dataset-slice-fetch';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<SliceBatch>) => {
  // Bounded-concurrency fetch+parse; each parsed slice is posted the moment it
  // resolves (progressive render), then a final `done`. The `fetch` reference is
  // handed in so it stays textually in this NETWORK_OWNER module.
  await fetchSliceBatch(e.data, {
    fetchImpl: (url, init) => fetch(url, init),
    post: (message) => ctx.postMessage(message),
  });
};
