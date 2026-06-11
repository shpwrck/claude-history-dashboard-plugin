// Upload pipeline client (#1069, follow-up to #1067/#1068). Orchestrates the
// single worker-side upload pipeline (upload-pipeline-worker.ts) with a
// transparent yielding main-thread fallback.
//
// `onResult` is called once per parsed result (progressive render) and
// `onStatus` once per progress line, in BOTH paths — so the caller's
// merge-into-state logic is identical whether the worker ran or not. The worker
// path is preferred; we fall back to a responsive (yielding) main-thread build
// when Worker is unavailable (jsdom/tests/old browsers) or the worker fails to
// start or errors.
//
// Re-running the whole build on fallback after a mid-run worker error is safe:
// the caller's per-result merge is idempotent (token-shaped results dedup by
// sessionId; replace-shaped results filter the incoming sessionIds before
// concatenating), so applying a result twice yields the same state.

import type {
  UploadDatasetSummary,
  UploadInput,
  UploadPipelineMessage,
  UploadResult,
} from './upload-dataset';

export type { UploadInput, UploadResult } from './upload-dataset';

interface PipelineHandlers {
  onResult: (msg: UploadResult) => void;
  onStatus?: (message: string) => void;
}

interface PipelineOptions {
  /** Run only the session parse passes (see buildUploadDataset's parseOnly). */
  parseOnly?: boolean;
}

type WorkerMessage =
  | UploadPipelineMessage
  | { type: 'done'; summary: UploadDatasetSummary }
  | { type: 'error'; error?: string };

function dispatch(msg: UploadPipelineMessage, handlers: PipelineHandlers): void {
  if (msg.type === 'status') handlers.onStatus?.(msg.message);
  else handlers.onResult(msg);
}

/** Try the worker; resolve a summary if it completed, null if it could not run. */
function buildInWorker(
  inputs: UploadInput[],
  handlers: PipelineHandlers,
  opts: PipelineOptions
): Promise<UploadDatasetSummary | null> {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(null);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./upload-pipeline-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (summary: UploadDatasetSummary | null) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(summary);
    };
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'done') {
        finish(msg.summary);
      } else if (msg.type === 'error') {
        finish(null);
      } else {
        dispatch(msg, handlers);
      }
    };
    worker.onerror = () => finish(null);
    worker.postMessage({ inputs, parseOnly: opts.parseOnly ?? false });
  });
}

/**
 * Inflate, read, and parse an upload, calling `onResult`/`onStatus` as work
 * completes. Runs in a Web Worker when possible, else on the main thread
 * (responsive, yielding). Resolves with the usable-file summary the caller uses
 * for its close decision.
 */
export async function runUploadPipeline(
  inputs: UploadInput[],
  handlers: PipelineHandlers,
  opts: PipelineOptions = {}
): Promise<UploadDatasetSummary> {
  const fromWorker = await buildInWorker(inputs, handlers, opts);
  if (fromWorker) return fromWorker;

  // Fallback only: dynamic-import the build pipeline so the common
  // (worker-available) path never ships it on the entry chunk.
  const { buildUploadDataset } = await import('./upload-dataset');
  return buildUploadDataset(inputs, (msg) => dispatch(msg, handlers), {
    yielding: true,
    parseOnly: opts.parseOnly ?? false,
  });
}
