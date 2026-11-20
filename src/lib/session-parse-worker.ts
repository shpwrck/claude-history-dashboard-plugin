/// <reference lib="webworker" />
//
// Session parse worker (#3810, epic #3736). Runs only the neutral session parse
// passes (session-parse.ts) off the main thread for already-decoded session
// files, such as the public sample corpus. Unlike the retiring upload pipeline
// worker it does no archive inflation, history parsing, or artifact
// collection. Posts one `sessionIndex` message, then one message per parse pass,
// then `{ type: 'done' }`; any failure posts `{ type: 'error' }` so the client
// can fall back to a yielding main-thread parse.

import { runSessionParse } from './session-parse';
import type { SessionParseFile } from './session-parse';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<{ files: SessionParseFile[] }>) => {
  try {
    const { files } = e.data;
    // Same id derivation as session-parse-client's sessionIdsOf; kept inline so
    // the worker bundle never imports the client (which constructs this worker).
    const sessionIds = files.map((file) => file.name.replace(/\.jsonl$/, ''));
    ctx.postMessage({ type: 'sessionIndex', sessionIds });
    await runSessionParse(files, (msg) => ctx.postMessage(msg));
    ctx.postMessage({ type: 'done' });
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
