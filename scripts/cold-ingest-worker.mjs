import { parentPort, workerData } from 'node:worker_threads';

import {
  parseSessionBlobRowFromDisk,
  sessionFileSignature,
} from './session-blob-row.mjs';

function postBatchAndWaitForAck(rows, sequence) {
  return new Promise((resolve, reject) => {
    parentPort.once('message', (message) => {
      if (message?.type === 'ack' && message.sequence === sequence) {
        resolve();
      } else {
        reject(
          new Error(
            `cold ingest worker ${workerData.workerId}: invalid acknowledgement for batch ${sequence}`
          )
        );
      }
    });
    parentPort.postMessage({
      ok: true,
      type: 'rows',
      workerId: workerData.workerId,
      sequence,
      rows,
    });
  });
}

try {
  let rows = [];
  let sequence = 0;
  let sentRows = 0;
  for (const session of workerData.sessions) {
    const sig = sessionFileSignature(session);
    rows.push(parseSessionBlobRowFromDisk(session, sig).byColumn);
    if (rows.length === workerData.rowBatchSize) {
      await postBatchAndWaitForAck(rows, sequence);
      sentRows += rows.length;
      rows = [];
      sequence += 1;
    }
  }
  if (rows.length > 0) {
    await postBatchAndWaitForAck(rows, sequence);
    sentRows += rows.length;
    sequence += 1;
  }
  parentPort.postMessage({
    ok: true,
    type: 'done',
    workerId: workerData.workerId,
    batches: sequence,
    rows: sentRows,
  });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.stack || err.message : String(err),
  });
}
