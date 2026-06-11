/// <reference lib="webworker" />
//
// Upload pipeline worker (#1069, follow-up to #1067/#1068). Runs the whole
// upload build — zip inflation, file reads, history/session/artifact parsing —
// entirely off the main thread, posting back only parsed results and progress.
// The decoded transcript text never crosses the boundary: it is created and
// consumed inside this worker, so a large ~/.claude upload no longer freezes the
// tab while it inflates, and the #1068 structured-clone handoff is gone for the
// zip path. A final `{ type: 'done', summary }` reports the usable-file count;
// any failure posts `{ type: 'error' }` so the client can fall back to a
// yielding main-thread build.

import { buildUploadDataset, type UploadInput } from './upload-dataset';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<{ inputs: UploadInput[]; parseOnly?: boolean }>) => {
  try {
    const summary = await buildUploadDataset(e.data.inputs, (msg) => ctx.postMessage(msg), {
      parseOnly: e.data.parseOnly ?? false,
    });
    ctx.postMessage({ type: 'done', summary });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
