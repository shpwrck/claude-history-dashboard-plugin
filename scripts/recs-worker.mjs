// scripts/recs-worker.mjs — off-main-thread recommendations rebuild (#2196, epic #2181).
//
// /api/recommendations.json's rebuild — ingest() -> assembleDataset() -> the
// 90-detector engine -> safeJsonStringify — is ~12-17s of UNINTERRUPTED
// synchronous CPU. #2184 moved it off the request path (serve stale, rebuild on
// response `finish`), but the rebuild still runs on the MAIN event loop, so a
// request that lands DURING a rebuild stalls behind it. This worker runs the
// rebuild on a separate thread so the main loop never blocks.
//
// Isolation: the parent spawns us with a worker-private CHD_DB_PATH, so this is
// a fully independent ingest pipeline with its OWN SQLite cache — NO shared-DB
// handle, no WAL migration, no read-only-mode plumbing. We read the same
// ~/.claude source files (read-only, like any reader) and write only our own
// cache DB. Output is byte-identical to the inline build because it runs the
// SAME assembleRecommendations over the SAME source state (contentHash is
// content-derived and path-independent — verified).
//
// Launched with `--import scripts/register-ts.mjs` (via execArgv) so the .ts
// parsers ingest.mjs dynamically imports resolve, exactly like the server.
//
// Protocol:
//   parent -> worker: { id, project, organizationIdentity, emitSuppressionTransitions,
//                       adoptionReceiptsPath, shadowCallsDir }
//   worker -> parent: { id, ok:true, json, contentHash, sourceSig }
//                  |  { id, ok:false, error }
//                  |  { type:'ready' }   (once, after module init)
//                  |  { type:'log', level, message }

import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';

if (!parentPort) {
  throw new Error('recs-worker.mjs must be run as a worker_thread');
}

const projectDir = workerData?.projectDir;
if (!projectDir) {
  throw new Error('recs-worker.mjs requires workerData.projectDir');
}

// Same dynamic-import shape the server uses, so the worker shares the exact
// ingest + serialization code path (no drift).
const {
  ingest,
  assembleRecommendationDataset,
  assembleRecommendations,
  recordSuppressionTransitions,
  readRejectedFindingIds,
  sourceSignature,
} = await import(join(projectDir, 'scripts', 'ingest.mjs'));
const { safeJsonStringify } = await import(
  join(projectDir, 'src', 'lib', 'json-safe.ts')
);

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const {
    id,
    project,
    organizationIdentity,
    emitSuppressionTransitions,
    adoptionReceiptsPath,
    shadowCallsDir,
  } = msg;
  try {
    const stats = ingest();
    // #2182: assemble ONLY the fields the recs input needs (not the full
    // /api/dataset.json payload). Shared by the suppression-transition emit and
    // the recs build below, so a single light assemble serves both (#2071).
    const dataset = assembleRecommendationDataset();
    if (emitSuppressionTransitions && adoptionReceiptsPath) {
      // Best-effort, like the inline path: never fail the rebuild on a receipts
      // write error. Reuses the same dataset (no second assemble).
      Promise.resolve(
        recordSuppressionTransitions(adoptionReceiptsPath, {
          shadowCallsDir,
          organizationIdentity: organizationIdentity ?? null,
          dataset,
        })
      ).catch((err) => {
        parentPort.postMessage({
          type: 'log',
          level: 'warn',
          message: `[recs-worker] suppression-transition emit failed: ${err?.message || err}`,
        });
      });
    }
    // User-reject suppression (#2206): drop findings carrying an active REJECTED
    // receipt, mirroring the inline server path. Best-effort — no path -> empty
    // set -> no suppression.
    const rejectedFindingIds = adoptionReceiptsPath
      ? await readRejectedFindingIds(adoptionReceiptsPath)
      : new Set();
    const recs = assembleRecommendations(project || undefined, {
      organizationIdentity: organizationIdentity ?? null,
      dataset,
      rejectedFindingIds,
    });
    const json = safeJsonStringify(recs);
    parentPort.postMessage({
      id,
      ok: true,
      json,
      contentHash: stats.contentHash,
      sourceSig: sourceSignature(),
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

// Signal readiness AFTER the (async) module init above completes.
parentPort.postMessage({ type: 'ready' });
