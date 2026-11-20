// Session parse client (#3810, epic #3736). Parses already-decoded session
// files with the neutral session parser, in a Web Worker when possible and on
// the main thread (yielding) otherwise. This is the sample corpus's parse path;
// it carries none of the upload pipeline (archive inflation, history, artifact
// collection).
//
// `onResult` is called once per message in BOTH paths, in the same order:
// `sessionIndex` first, then one message per parse pass. Re-running the parse on
// the fallback after a mid-run worker error is safe because the caller's
// per-result merge is idempotent.

import type { SessionParseEmit, SessionParseFile } from './session-parse';

export type SessionParseResult =
  | { type: 'sessionIndex'; sessionIds: string[] }
  | SessionParseEmit;

export interface SessionParseRequest {
  files: SessionParseFile[];
}

type WorkerMessage = SessionParseResult | { type: 'done' } | { type: 'error'; error?: string };

/** Session ids in file order (filename minus `.jsonl`). */
export function sessionIdsOf(files: SessionParseFile[]): string[] {
  return files.map((file) => file.name.replace(/\.jsonl$/, ''));
}

/** Try the worker; resolve true if it completed, false if it could not run. */
function parseInWorker(
  files: SessionParseFile[],
  onResult: (msg: SessionParseResult) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(false);
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL('./session-parse-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(ok);
    };
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'done') finish(true);
      else if (msg.type === 'error') finish(false);
      else onResult(msg);
    };
    worker.onerror = () => finish(false);
    const request: SessionParseRequest = { files };
    worker.postMessage(request);
  });
}

/**
 * Parse decoded session files, calling `onResult` as each pass finishes. Uses a
 * Web Worker when available, else a yielding main-thread parse.
 */
export async function runSessionParseOffThread(
  files: SessionParseFile[],
  onResult: (msg: SessionParseResult) => void
): Promise<void> {
  if (files.length === 0) return;
  if (await parseInWorker(files, onResult)) return;

  // Fallback only: dynamic-import the parser so the worker path never ships it
  // on the caller's chunk.
  const { runSessionParse } = await import('./session-parse');
  onResult({ type: 'sessionIndex', sessionIds: sessionIdsOf(files) });
  await runSessionParse(files, onResult, { yielding: true });
}
