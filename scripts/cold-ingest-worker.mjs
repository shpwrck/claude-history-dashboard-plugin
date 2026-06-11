import { parentPort, workerData } from 'node:worker_threads';

import {
  parseSessionBlobRowFromDisk,
  sessionFileSignature,
} from './session-blob-row.mjs';

try {
  const rows = [];
  for (const session of workerData.sessions) {
    const sig = sessionFileSignature(session);
    rows.push(parseSessionBlobRowFromDisk(session, sig).byColumn);
  }
  parentPort.postMessage({ ok: true, rows });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.stack || err.message : String(err),
  });
}
