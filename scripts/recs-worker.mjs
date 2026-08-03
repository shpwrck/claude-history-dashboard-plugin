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
// cache DB. For time-stable evidence, output is byte-identical to the inline
// build because it runs the SAME assembleRecommendations over the SAME source
// state (contentHash is content-derived and path-independent — verified).
// Separate real-time builds may honestly carry different timestamps for live
// host probes such as hook referenced-path checks.
//
// Launched with `--import scripts/register-ts.mjs` (via execArgv) so the .ts
// parsers ingest.mjs dynamically imports resolve, exactly like the server.
//
// Protocol:
//   parent -> worker: { id, project, surface, filters, organizationIdentity,
//                       emitSuppressionTransitions, adoptionReceiptsPath, shadowCallsDir }
//     `surface` (#2718): absent/null -> legacy raw Recommendation[] body; 'global'
//     | 'reclaim-compass' -> the typed { recommendations, domainCoverage } envelope
//     scoped by `filters`. The clock/config metadata below is dataset-derived and
//     therefore surface-independent.
//   worker -> parent: { id, ok:true, json, contentHash, sourceSig,
//                       docIssueCacheState,
//                       suppressionEmissionId,
//                       guidanceTransitions, guidanceCacheValidity,
//                       hookOverheadCacheValidity, hookOverheadConfigState,
//                       skillHookIntegrityCacheValidity,
//                       editFormatChurnCacheValidity }
//                  |  { id, ok:false, error }
//                  |  { type:'ready' }   (once, after module init)
//                  |  { type:'log', level, message }

import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { access, readFile } from 'node:fs/promises';

if (!parentPort) {
  throw new Error('recs-worker.mjs must be run as a worker_thread');
}

const projectDir = workerData?.projectDir;
if (!projectDir) {
  throw new Error('recs-worker.mjs requires workerData.projectDir');
}

// Deterministic integration-test seam for the reject-vs-worker race. When the
// configured path exists, the first rebuild pauses immediately AFTER reading
// rejection receipts. Production has no path configured and pays no I/O. The
// one-shot gate lets a second, post-invalidation rebuild proceed concurrently.
const AFTER_RECEIPTS_TEST_GATE =
  process.env.CHD_RECS_CACHE_TEST_EVENTS === '1'
    ? process.env.CHD_RECS_WORKER_TEST_AFTER_RECEIPTS_GATE || ''
    : '';
let afterReceiptsTestGateUsed = false;

// Suppression receipts are a side effect, unlike the recommendation body. A
// worker result still has to pass the parent process's final source/config
// gates, so retain the exact accepted dataset until the parent explicitly
// acknowledges that it committed this result. Discarded/racy results expire
// without writing lifecycle state.
const SUPPRESSION_EMISSION_ACK_TIMEOUT_MS = 5 * 60 * 1000;
const pendingSuppressionEmissions = new Map();

function discardPendingSuppressionEmission(id) {
  const pending = pendingSuppressionEmissions.get(id);
  if (!pending) return false;
  pendingSuppressionEmissions.delete(id);
  clearTimeout(pending.timer);
  return true;
}

function stageSuppressionEmission(id, params) {
  const timer = setTimeout(() => {
    pendingSuppressionEmissions.delete(id);
  }, SUPPRESSION_EMISSION_ACK_TIMEOUT_MS);
  timer.unref?.();
  pendingSuppressionEmissions.set(id, { ...params, timer });
}

function acceptPendingSuppressionEmission(id) {
  const pending = pendingSuppressionEmissions.get(id);
  if (!pending) return;
  discardPendingSuppressionEmission(id);
  if (process.env.CHD_RECS_CACHE_TEST_EVENTS === '1') {
    parentPort.postMessage({
      type: 'log',
      level: 'warn',
      message: '[recs-cache-test] worker-suppression-accepted',
    });
  }
  Promise.resolve(
    recordSuppressionTransitions(pending.adoptionReceiptsPath, {
      shadowCallsDir: pending.shadowCallsDir,
      organizationIdentity: pending.organizationIdentity,
      dataset: pending.dataset,
    })
  ).catch((err) => {
    parentPort.postMessage({
      type: 'log',
      level: 'warn',
      message: `[recs-worker] suppression-transition emit failed: ${err?.message || err}`,
    });
  });
}

async function waitAtAfterReceiptsTestGate() {
  if (!AFTER_RECEIPTS_TEST_GATE || afterReceiptsTestGateUsed) return;
  try {
    await access(AFTER_RECEIPTS_TEST_GATE);
  } catch {
    return;
  }
  afterReceiptsTestGateUsed = true;
  parentPort.postMessage({
    type: 'log',
    level: 'warn',
    message: '[recs-cache-test] worker-receipts-read',
  });
  await readFile(AFTER_RECEIPTS_TEST_GATE);
}

// Same dynamic-import shape the server uses, so the worker shares the exact
// ingest + serialization code path (no drift).
const ingestApi = await import(join(projectDir, 'scripts', 'ingest.mjs'));
const {
  ingest,
  assembleRecommendationDataset,
  assembleRecommendations,
  assembleScopedRecommendationResult,
  recordSuppressionTransitions,
  readRejectedFindingIds,
  sourceSignature,
  docIssueSnapshotCacheStateForServer,
  docIssueSnapshotCacheStateFromDataset,
} = ingestApi;
const { safeJsonStringify } = await import(
  join(projectDir, 'src', 'lib', 'json-safe.ts')
);
const {
  externalGuidanceCacheValidity,
  externalGuidanceClockTransitions,
} = await import(join(projectDir, 'src', 'lib', 'external-guidance.ts'));
const { hookOverheadCacheValidity, hookOverheadConfigState } = await import(
  join(projectDir, 'src', 'lib', 'detectors', 'speed', 'hook-overhead.ts')
);
const { skillHookIntegrityCacheValidity } = await import(
  join(
    projectDir,
    'src',
    'lib',
    'detectors',
    'maintenance',
    'skill-hook-integrity.ts'
  )
);
const { editFormatChurnCacheValidity } = await import(
  join(projectDir, 'src', 'lib', 'detectors', 'cost', 'edit-format-churn.ts')
);

function sameDocIssueCacheState(a, b) {
  if (a === null || b === null) return a === b;
  return a.identity === b.identity && a.usableThrough === b.usableThrough;
}

function recommendationSourceState() {
  return {
    sourceSig: sourceSignature(),
    docIssueCacheState: docIssueSnapshotCacheStateForServer(),
  };
}

async function buildRecommendationResult({
  project,
  surface,
  filters,
  organizationIdentity,
  adoptionReceiptsPath,
}) {
  const stats = ingest();
  // #2182: assemble ONLY the fields the recs input needs (not the full
  // /api/dataset.json payload). The accepted stable dataset is also reused by
  // suppression-transition emission after the source-state validation below.
  const dataset = assembleRecommendationDataset();
  const guidanceBuiltAt = Date.now();
  const guidanceTransitions = externalGuidanceClockTransitions(
    dataset.externalGuidance
  );
  const guidanceCacheValidity = externalGuidanceCacheValidity(
    guidanceTransitions,
    guidanceBuiltAt
  );
  const hookCacheValidity = hookOverheadCacheValidity(
    dataset,
    guidanceBuiltAt
  );
  const hookConfigState = hookOverheadConfigState(dataset);
  const skillHookCacheValidity = skillHookIntegrityCacheValidity(
    dataset,
    guidanceBuiltAt
  );
  const editChurnCacheValidity = editFormatChurnCacheValidity(
    dataset,
    guidanceBuiltAt
  );
  // User-reject suppression (#2206): drop findings carrying an active REJECTED
  // receipt, mirroring the inline server path. Best-effort — no path -> empty
  // set -> no suppression.
  const rejectedFindingIds = adoptionReceiptsPath
    ? await readRejectedFindingIds(adoptionReceiptsPath)
    : new Set();
  await waitAtAfterReceiptsTestGate();
  // #2718: a `surface` request returns the typed { recommendations,
  // domainCoverage } envelope scoped by `filters`; otherwise the legacy raw
  // Recommendation[]. safeJsonStringify serializes either shape.
  const result = surface
    ? assembleScopedRecommendationResult(surface, filters ?? {}, {
        organizationIdentity: organizationIdentity ?? null,
        dataset,
        rejectedFindingIds,
        now: guidanceBuiltAt,
      })
    : assembleRecommendations(project || undefined, {
        organizationIdentity: organizationIdentity ?? null,
        dataset,
        rejectedFindingIds,
        now: guidanceBuiltAt,
      });
  return {
    dataset,
    docIssueCacheState: docIssueSnapshotCacheStateFromDataset(dataset),
    json: safeJsonStringify(result),
    contentHash: stats.contentHash,
    guidanceTransitions,
    guidanceCacheValidity,
    hookOverheadCacheValidity: hookCacheValidity,
    hookOverheadConfigState: hookConfigState,
    skillHookIntegrityCacheValidity: skillHookCacheValidity,
    editFormatChurnCacheValidity: editChurnCacheValidity,
  };
}

async function buildStableRecommendationResult(params) {
  let expectedSourceState = recommendationSourceState();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const built = await buildRecommendationResult(params);
    const completedSourceState = recommendationSourceState();
    const sourceSigStable =
      expectedSourceState.sourceSig === completedSourceState.sourceSig;
    const docIssueStateStable =
      sameDocIssueCacheState(
        expectedSourceState.docIssueCacheState,
        completedSourceState.docIssueCacheState
      ) &&
      sameDocIssueCacheState(
        built.docIssueCacheState,
        completedSourceState.docIssueCacheState
      );
    if (docIssueStateStable && (sourceSigStable || attempt === 1)) {
      return {
        ...built,
        sourceState: {
          ...completedSourceState,
          // A final source-racy build is safe to serve because its exact
          // document-issue trust state is current, but it is not safe to cache
          // under a signature the built dataset did not observe. The parent
          // response cache will retry/commit it as explicitly unsettled.
          sourceSig: sourceSigStable ? completedSourceState.sourceSig : null,
        },
      };
    }
    if (attempt === 1) {
      const err = new Error(
        'Recommendation source state changed across the bounded rebuild retry'
      );
      err.code = 'SOURCE_CHANGED_DURING_BUILD';
      throw err;
    }
    parentPort.postMessage({
      type: 'log',
      level: 'warn',
      message: '[recs-worker] source changed during rebuild; retrying once',
    });
    expectedSourceState = completedSourceState;
  }
  throw new Error('Unreachable recommendation worker build state');
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'accept-suppression-transitions') {
    acceptPendingSuppressionEmission(msg.id);
    return;
  }
  if (msg.type === 'discard-suppression-transitions') {
    const discarded = discardPendingSuppressionEmission(msg.id);
    if (discarded && process.env.CHD_RECS_CACHE_TEST_EVENTS === '1') {
      parentPort.postMessage({
        type: 'log',
        level: 'warn',
        message: '[recs-cache-test] worker-suppression-discarded',
      });
    }
    return;
  }
  const {
    id,
    project,
    surface,
    filters,
    organizationIdentity,
    emitSuppressionTransitions,
    adoptionReceiptsPath,
    shadowCallsDir,
  } = msg;
  try {
    const built = await buildStableRecommendationResult({
      project,
      surface,
      filters,
      organizationIdentity,
      adoptionReceiptsPath,
    });
    const suppressionEmissionId =
      emitSuppressionTransitions && adoptionReceiptsPath ? id : null;
    if (suppressionEmissionId !== null) {
      stageSuppressionEmission(suppressionEmissionId, {
        adoptionReceiptsPath,
        shadowCallsDir,
        organizationIdentity: organizationIdentity ?? null,
        dataset: built.dataset,
      });
    }
    parentPort.postMessage({
      id,
      ok: true,
      json: built.json,
      contentHash: built.contentHash,
      guidanceTransitions: built.guidanceTransitions,
      guidanceCacheValidity: built.guidanceCacheValidity,
      hookOverheadCacheValidity: built.hookOverheadCacheValidity,
      hookOverheadConfigState: built.hookOverheadConfigState,
      skillHookIntegrityCacheValidity: built.skillHookIntegrityCacheValidity,
      editFormatChurnCacheValidity: built.editFormatChurnCacheValidity,
      sourceSig: built.sourceState.sourceSig,
      docIssueCacheState: built.docIssueCacheState,
      suppressionEmissionId,
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

// Signal readiness AFTER the (async) module init above completes.
parentPort.postMessage({ type: 'ready' });
