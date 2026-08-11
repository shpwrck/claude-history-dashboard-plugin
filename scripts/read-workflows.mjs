// Shared reader for Workflow-tool run manifests (#435/#661).
//
// Walks `<projectsRoot>/<slug>/<sessionId>/workflows/wf_*.json`, projects each
// manifest down to the ledger shape (the `RawWorkflowRun` the client parser
// `src/lib/parse-workflows.ts` consumes — dropping script source / logs / full
// results and truncating per-agent previews), and returns `{ runs }`
// newest-first.
//
// One projection (`trimWorkflowRun`) feeds two entry points so the wire shape
// stays identical for both consumers:
//   - `readWorkflows(projectsRootOrRoots)`     — async, for the server's
//     /api/workflows route (non-blocking I/O).
//   - `readWorkflowsSync(projectsRootOrRoots)` — sync, for the ingest pipeline's
//     synchronous `assembleDataset()` (#661), which feeds the workflow-health
//     detectors (#635).
// A caller may pass one root or the complete authorized root set. Multi-root
// reads share one discovery budget, run cap, canonical-root dedupe, and final
// sort so adding a hub cannot multiply the declared response limits (#2713).

import { open, opendir, realpath, stat } from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, normalize, resolve, sep } from 'node:path';

const PREVIEW_CAP = 280;
const READ_CHUNK_BYTES = 65_536;

function parseNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export const WORKFLOW_MANIFEST_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES', 1_048_576)
  )
);
export const WORKFLOW_RUN_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES', 50_000)
  )
);
export const WORKFLOW_DISCOVERY_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_DISCOVERY_MAX_ENTRIES', 50_000)
  )
);
export const WORKFLOW_PHASE_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    100_000,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES', 500)
  )
);
export const WORKFLOW_PROGRESS_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES', 5_000)
  )
);
export const WORKFLOW_FIELD_MAX_CHARS = Math.max(
  1,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_WORKFLOW_FIELD_MAX_CHARS', 4_096)
  )
);

function boundedString(value, fallback = null, maxChars = WORKFLOW_FIELD_MAX_CHARS) {
  return typeof value === 'string' ? value.slice(0, maxChars) : fallback;
}

function boundedScalar(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, WORKFLOW_FIELD_MAX_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

/**
 * Normalize a manifest `startTime` to finite epoch milliseconds, or null (#3099).
 *
 * `boundedScalar` preserved arbitrary strings, and the newest-first comparator
 * subtracts them: `'2026-01-01T00:00Z' - '2026-01-02T00:00Z'` is NaN, which
 * Array.prototype.sort reads as "no ordering", so the documented newest-first
 * result silently degraded to directory iteration order and workflow-health
 * consumers received misranked runs. The declared shape is
 * `startTime: number | null` (src/lib/parse-workflows.ts), so normalizing here
 * also stops the projection from violating its own contract.
 *
 * Supported: a finite number; a numeric string; any timestamp `Date.parse`
 * understands (ISO 8601). Anything else is null — unknown, not zero.
 */
export function normalizeStartTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, WORKFLOW_FIELD_MAX_CHARS).trim();
  if (trimmed === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimWorkflowProgressEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'workflow_phase') {
    return {
      type: 'workflow_phase',
      index: boundedScalar(e.index),
      title: boundedString(e.title),
    };
  }
  // Default: a workflow_agent entry. Many fields are OMITTED (not null) on
  // cached / in-flight agents, so coalesce each to null.
  return {
    type: boundedString(e.type, 'workflow_agent'),
    index: boundedScalar(e.index),
    label: boundedString(e.label),
    phaseIndex: boundedScalar(e.phaseIndex),
    phaseTitle: boundedString(e.phaseTitle),
    model: boundedString(e.model),
    state: boundedString(e.state),
    agentType: boundedString(e.agentType),
    startedAt: boundedScalar(e.startedAt),
    durationMs: boundedScalar(e.durationMs),
    tokens: boundedScalar(e.tokens),
    toolCalls: boundedScalar(e.toolCalls),
    promptPreview: boundedString(e.promptPreview, null, PREVIEW_CAP),
    resultPreview: boundedString(e.resultPreview, null, PREVIEW_CAP),
    error: boundedString(e.error, null, PREVIEW_CAP),
  };
}

function trimWorkflowRun(m, sessionId) {
  // A valid-JSON but degenerate manifest (null / number / array from a
  // truncated or racing write) must not throw — skip it.
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  return {
    runId: boundedString(m.runId),
    workflowName: boundedString(m.workflowName),
    status: boundedString(m.status),
    startTime: normalizeStartTime(m.startTime),
    durationMs: boundedScalar(m.durationMs),
    agentCount: boundedScalar(m.agentCount),
    totalTokens: boundedScalar(m.totalTokens),
    totalToolCalls: boundedScalar(m.totalToolCalls),
    defaultModel: boundedString(m.defaultModel),
    sessionId,
    phases: Array.isArray(m.phases)
      ? m.phases
          .slice(0, WORKFLOW_PHASE_MAX_ENTRIES)
          .map((p) => ({
            title: boundedString(p?.title, ''),
            detail: boundedString(p?.detail, ''),
          }))
      : [],
    workflowProgress: Array.isArray(m.workflowProgress)
      ? m.workflowProgress
          .slice(0, WORKFLOW_PROGRESS_MAX_ENTRIES)
          .map(trimWorkflowProgressEntry)
          .filter(Boolean)
      : [],
  };
}

const isWfManifest = (f) => f.startsWith('wf_') && f.endsWith('.json');
// Newest first. Only normalized numbers are compared; a run with no usable
// timestamp cannot be ranked, so it sorts LAST (deterministically, and stably
// among its peers) instead of poisoning the comparator with NaN.
const byStartDesc = (a, b) => {
  const at = typeof a.startTime === 'number' && Number.isFinite(a.startTime) ? a.startTime : null;
  const bt = typeof b.startTime === 'number' && Number.isFinite(b.startTime) ? b.startTime : null;
  if (at === null && bt === null) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  return bt - at;
};

function workflowLimits(maxDiscoveryEntries = WORKFLOW_DISCOVERY_MAX_ENTRIES) {
  return {
    manifestMaxBytes: WORKFLOW_MANIFEST_MAX_BYTES,
    maxRuns: WORKFLOW_RUN_MAX_ENTRIES,
    maxDiscoveryEntries,
    maxPhasesPerRun: WORKFLOW_PHASE_MAX_ENTRIES,
    maxProgressEntriesPerRun: WORKFLOW_PROGRESS_MAX_ENTRIES,
    fieldMaxChars: WORKFLOW_FIELD_MAX_CHARS,
  };
}

/** Stable cache salt for every cap that can change the projected workflow data. */
export function workflowLimitsSignature(
  maxDiscoveryEntries = WORKFLOW_DISCOVERY_MAX_ENTRIES
) {
  const limits = workflowLimits(maxDiscoveryEntries);
  return [
    `manifestMaxBytes=${limits.manifestMaxBytes}`,
    `maxRuns=${limits.maxRuns}`,
    `maxDiscoveryEntries=${limits.maxDiscoveryEntries}`,
    `maxPhasesPerRun=${limits.maxPhasesPerRun}`,
    `maxProgressEntriesPerRun=${limits.maxProgressEntriesPerRun}`,
    `fieldMaxChars=${limits.fieldMaxChars}`,
  ].join(',');
}

function discoverySnapshot(discovery) {
  return {
    entriesExamined: discovery.entriesExamined,
    directoriesOpened: discovery.directoriesOpened,
  };
}

function workflowResult(runs, skippedManifests, truncated, discovery) {
  runs.sort(byStartDesc);
  return {
    runs,
    limits: workflowLimits(discovery.limit),
    discovery: discoverySnapshot(discovery),
    skippedManifests,
    truncated: truncated || discovery.exhausted,
  };
}

// Keep only the globally newest runs while every authorized root is scanned.
// The heap root is the least-preferred retained entry, so replacement is
// O(log maxRuns) and memory never exceeds the declared response cap. Ordinals
// preserve stable discovery order when timestamps tie or are unavailable.
function createRunRetention() {
  return { heap: [], nextOrdinal: 0 };
}

function compareRetainedRuns(a, b) {
  const byStart = byStartDesc(a.run, b.run);
  return byStart !== 0 ? byStart : a.ordinal - b.ordinal;
}

function retainedRunIsWorse(a, b) {
  return compareRetainedRuns(a, b) > 0;
}

function retainWorkflowRun(retention, run) {
  const entry = { run, ordinal: retention.nextOrdinal };
  retention.nextOrdinal += 1;
  const heap = retention.heap;
  if (heap.length < WORKFLOW_RUN_MAX_ENTRIES) {
    heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!retainedRunIsWorse(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return false;
  }

  // The response is capped whether this candidate displaces the current
  // oldest entry or is itself discarded.
  if (!retainedRunIsWorse(heap[0], entry)) return true;
  heap[0] = entry;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worse = index;
    if (left < heap.length && retainedRunIsWorse(heap[left], heap[worse])) worse = left;
    if (right < heap.length && retainedRunIsWorse(heap[right], heap[worse])) worse = right;
    if (worse === index) break;
    [heap[index], heap[worse]] = [heap[worse], heap[index]];
    index = worse;
  }
  return true;
}

function retainedWorkflowRuns(retention) {
  // perf-index-contract: workflow-retention-order always-consumed: every completed aggregate read immediately returns the complete sorted retained-run list
  return retention.heap.sort(compareRetainedRuns).map((entry) => entry.run);
}

function createDiscoveryBudget(requested) {
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, 1_000_000)
      : WORKFLOW_DISCOVERY_MAX_ENTRIES;
  return {
    limit,
    remaining: limit,
    entriesExamined: 0,
    directoriesOpened: 0,
    exhausted: false,
  };
}

async function readDirentsBounded(dirPath, discovery) {
  const entries = [];
  if (discovery.remaining <= 0) {
    discovery.exhausted = true;
    return { entries, missing: false, truncated: true };
  }
  let dir;
  try {
    dir = await opendir(dirPath);
  } catch {
    return { entries, missing: true, truncated: false };
  }
  discovery.directoriesOpened += 1;
  let truncated = false;
  try {
    for (;;) {
      if (discovery.remaining <= 0) {
        discovery.exhausted = true;
        truncated = true;
        break;
      }
      const ent = await dir.read();
      if (!ent) break;
      discovery.remaining -= 1;
      discovery.entriesExamined += 1;
      entries.push(ent);
    }
  } finally {
    try {
      await dir.close();
    } catch {
      /* ignore close failures */
    }
  }
  return { entries, missing: false, truncated };
}

function readDirentsBoundedSync(dirPath, discovery) {
  const entries = [];
  if (discovery.remaining <= 0) {
    discovery.exhausted = true;
    return { entries, missing: false, truncated: true };
  }
  let dir;
  try {
    dir = opendirSync(dirPath);
  } catch {
    return { entries, missing: true, truncated: false };
  }
  discovery.directoriesOpened += 1;
  let truncated = false;
  try {
    for (;;) {
      if (discovery.remaining <= 0) {
        discovery.exhausted = true;
        truncated = true;
        break;
      }
      const ent = dir.readSync();
      if (!ent) break;
      discovery.remaining -= 1;
      discovery.entriesExamined += 1;
      entries.push(ent);
    }
  } finally {
    try {
      dir.closeSync();
    } catch {
      /* ignore close failures */
    }
  }
  return { entries, missing: false, truncated };
}

function pathInside(parent, child) {
  const p = normalize(parent);
  const c = normalize(child);
  return c === p || c.startsWith(p + sep);
}

async function realpathOrNull(pathname) {
  try {
    return await realpath(pathname);
  } catch {
    return null;
  }
}

function realpathOrNullSync(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return null;
  }
}

function workflowManifestTooLargeError() {
  const err = new Error(`Workflow manifest exceeds ${WORKFLOW_MANIFEST_MAX_BYTES} byte limit`);
  err.code = 'ERR_DASHBOARD_WORKFLOW_MANIFEST_TOO_LARGE';
  return err;
}

function isWorkflowManifestTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_WORKFLOW_MANIFEST_TOO_LARGE';
}

async function readWorkflowManifest(realFull) {
  const handle = await open(realFull, 'r');
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, WORKFLOW_MANIFEST_MAX_BYTES + 1));
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > WORKFLOW_MANIFEST_MAX_BYTES) {
        throw workflowManifestTooLargeError();
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readWorkflowManifestSync(realFull) {
  const fd = openSync(realFull, 'r');
  const chunks = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, WORKFLOW_MANIFEST_MAX_BYTES + 1));
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > WORKFLOW_MANIFEST_MAX_BYTES) {
        throw workflowManifestTooLargeError();
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function projectsRootList(projectsRootOrRoots) {
  return Array.isArray(projectsRootOrRoots)
    ? projectsRootOrRoots
    : [projectsRootOrRoots];
}

async function resolveProjectsRoots(projectsRootOrRoots, allowRootSymlinks) {
  const roots = [];
  let seenRealRoots;
  for (const projectsRoot of projectsRootList(projectsRootOrRoots)) {
    const realProjectsRoot = await realpathOrNull(projectsRoot);
    if (
      allowRootSymlinks === false &&
      realProjectsRoot &&
      realProjectsRoot !== resolve(projectsRoot)
    ) {
      continue;
    }
    if (!realProjectsRoot) continue;
    // perf-index-contract: workflow-async-root-dedupe always-consumed: construction occurs only for a resolved root that immediately queries and updates this membership index
    seenRealRoots ??= new Set();
    if (seenRealRoots.has(realProjectsRoot)) continue;
    seenRealRoots.add(realProjectsRoot);
    roots.push({ projectsRoot, realProjectsRoot });
  }
  return roots;
}

function resolveProjectsRootsSync(projectsRootOrRoots, allowRootSymlinks) {
  const roots = [];
  let seenRealRoots;
  for (const projectsRoot of projectsRootList(projectsRootOrRoots)) {
    const realProjectsRoot = realpathOrNullSync(projectsRoot);
    if (
      allowRootSymlinks === false &&
      realProjectsRoot &&
      realProjectsRoot !== resolve(projectsRoot)
    ) {
      continue;
    }
    if (!realProjectsRoot) continue;
    // perf-index-contract: workflow-sync-root-dedupe always-consumed: construction occurs only for a resolved root that immediately queries and updates this membership index
    seenRealRoots ??= new Set();
    if (seenRealRoots.has(realProjectsRoot)) continue;
    seenRealRoots.add(realProjectsRoot);
    roots.push({ projectsRoot, realProjectsRoot });
  }
  return roots;
}

function rootDiscoveryBudget(discovery, remainingRoots) {
  return createDiscoveryBudget(
    Math.max(1, Math.ceil(discovery.remaining / remainingRoots))
  );
}

function mergeRootDiscovery(discovery, rootDiscovery) {
  discovery.remaining = Math.max(0, discovery.remaining - rootDiscovery.entriesExamined);
  discovery.entriesExamined += rootDiscovery.entriesExamined;
  discovery.directoriesOpened += rootDiscovery.directoriesOpened;
}

/** Async walk for the server's /api/workflows route. */
export async function readWorkflows(projectsRootOrRoots, options = {}) {
  const retention = createRunRetention();
  let skippedManifests = 0;
  let truncated = false;
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const roots = await resolveProjectsRoots(
    projectsRootOrRoots,
    options.allowRootSymlinks
  );
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    if (discovery.remaining <= 0) {
      discovery.exhausted = true;
      truncated = true;
      break;
    }
    const { projectsRoot, realProjectsRoot } = roots[rootIndex];
    // Reserve a fair share of the remaining aggregate discovery budget for
    // every canonical root. Unused entries roll forward, but a large local
    // tree cannot consume the entire budget before a hub is examined.
    const rootDiscovery = rootDiscoveryBudget(discovery, roots.length - rootIndex);
    const projectRead = await readDirentsBounded(projectsRoot, rootDiscovery);
    if (projectRead.missing) continue;
    if (projectRead.truncated) truncated = true;
    for (const proj of projectRead.entries) {
      if (!proj.isDirectory()) continue;
      const projPath = join(projectsRoot, proj.name);
      const realProjPath = await realpathOrNull(projPath);
      if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
      const sessionRead = await readDirentsBounded(projPath, rootDiscovery);
      if (sessionRead.missing) continue;
      if (sessionRead.truncated) truncated = true;
      for (const sess of sessionRead.entries) {
        if (!sess.isDirectory()) continue;
        const wfDir = join(projPath, sess.name, 'workflows');
        if (!existsSync(wfDir)) continue;
        const realWfDir = await realpathOrNull(wfDir);
        if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
        const wfRead = await readDirentsBounded(wfDir, rootDiscovery);
        if (wfRead.missing) continue;
        if (wfRead.truncated) truncated = true;
        const wfFiles = wfRead.entries
          .filter((f) => f.isFile() && isWfManifest(f.name))
          .map((f) => f.name);
        for (const name of wfFiles) {
          const full = join(wfDir, name);
          if (!pathInside(wfDir, full)) continue;
          try {
            const realFull = await realpathOrNull(full);
            if (!realFull || !pathInside(realWfDir, realFull)) continue;
            const run = trimWorkflowRun(JSON.parse(await readWorkflowManifest(realFull)), sess.name);
            if (run) {
              if (retainWorkflowRun(retention, run)) truncated = true;
            }
          } catch (err) {
            if (isWorkflowManifestTooLargeError(err)) skippedManifests += 1;
            /* skip an unreadable / malformed manifest */
          }
        }
      }
    }
    mergeRootDiscovery(discovery, rootDiscovery);
  }
  return workflowResult(
    retainedWorkflowRuns(retention),
    skippedManifests,
    truncated,
    discovery
  );
}

/** Synchronous mirror for the ingest pipeline's `assembleDataset()` (#661). */
export function readWorkflowsSync(projectsRootOrRoots, options = {}) {
  const retention = createRunRetention();
  let skippedManifests = 0;
  let truncated = false;
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const roots = resolveProjectsRootsSync(
    projectsRootOrRoots,
    options.allowRootSymlinks
  );
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    if (discovery.remaining <= 0) {
      discovery.exhausted = true;
      truncated = true;
      break;
    }
    const { projectsRoot, realProjectsRoot } = roots[rootIndex];
    const rootDiscovery = rootDiscoveryBudget(discovery, roots.length - rootIndex);
    const projectRead = readDirentsBoundedSync(projectsRoot, rootDiscovery);
    if (projectRead.missing) continue;
    if (projectRead.truncated) truncated = true;
    for (const proj of projectRead.entries) {
      if (!proj.isDirectory()) continue;
      const projPath = join(projectsRoot, proj.name);
      const realProjPath = realpathOrNullSync(projPath);
      if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
      const sessionRead = readDirentsBoundedSync(projPath, rootDiscovery);
      if (sessionRead.missing) continue;
      if (sessionRead.truncated) truncated = true;
      for (const sess of sessionRead.entries) {
        if (!sess.isDirectory()) continue;
        const wfDir = join(projPath, sess.name, 'workflows');
        if (!existsSync(wfDir)) continue;
        const realWfDir = realpathOrNullSync(wfDir);
        if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
        const wfRead = readDirentsBoundedSync(wfDir, rootDiscovery);
        if (wfRead.missing) continue;
        if (wfRead.truncated) truncated = true;
        const wfFiles = wfRead.entries
          .filter((f) => f.isFile() && isWfManifest(f.name))
          .map((f) => f.name);
        for (const name of wfFiles) {
          const full = join(wfDir, name);
          if (!pathInside(wfDir, full)) continue;
          try {
            const realFull = realpathOrNullSync(full);
            if (!realFull || !pathInside(realWfDir, realFull)) continue;
            const run = trimWorkflowRun(JSON.parse(readWorkflowManifestSync(realFull)), sess.name);
            if (run) {
              if (retainWorkflowRun(retention, run)) truncated = true;
            }
          } catch (err) {
            if (isWorkflowManifestTooLargeError(err)) skippedManifests += 1;
            /* skip an unreadable / malformed manifest */
          }
        }
      }
    }
    mergeRootDiscovery(discovery, rootDiscovery);
  }
  return workflowResult(
    retainedWorkflowRuns(retention),
    skippedManifests,
    truncated,
    discovery
  );
}

function hashStatIdentity(hash, value) {
  hash.update(String(value.dev ?? 0));
  hash.update('\0');
  hash.update(String(value.ino ?? 0));
  hash.update('\0');
  hash.update(String(value.size ?? 0));
  hash.update('\0');
  hash.update(String(value.mtimeMs ?? 0));
  hash.update('\0');
  hash.update(String(value.ctimeMs ?? 0));
  hash.update('\n');
}

function identityHeader(hash, projectsRootOrRoots, discovery) {
  hash.update('workflow-source-v1\n');
  hash.update(workflowLimitsSignature(discovery.limit));
  hash.update('\n');
  for (const configuredRoot of projectsRootList(projectsRootOrRoots)) {
    hash.update('configured-root\0');
    hash.update(resolve(configuredRoot));
    hash.update('\n');
  }
}

function identityFooter(hash, discovery) {
  hash.update('discovery\0');
  hash.update(String(discovery.entriesExamined));
  hash.update('\0');
  hash.update(String(discovery.directoriesOpened));
  hash.update('\0');
  hash.update(discovery.exhausted ? 'exhausted' : 'complete');
  hash.update('\n');
  return {
    signature: hash.digest('hex'),
    discovery: discoverySnapshot(discovery),
    truncated: discovery.exhausted,
  };
}

function sortedIdentityDirents(entries) {
  // perf-index-contract: workflow-identity-order always-consumed: every reconciliation immediately hashes the complete selected entry set in deterministic path order
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stat-only identity of the exact bounded workflow discovery surface.
 *
 * This deliberately reads no manifest bodies. It is used only by the background
 * reconciliation backstop; request-time freshness uses the tracker token below.
 */
export async function workflowSourceIdentity(projectsRootOrRoots, options = {}) {
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const hash = createHash('sha1');
  identityHeader(hash, projectsRootOrRoots, discovery);
  const roots = await resolveProjectsRoots(
    projectsRootOrRoots,
    options.allowRootSymlinks
  );
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    if (discovery.remaining <= 0) {
      discovery.exhausted = true;
      break;
    }
    const { projectsRoot, realProjectsRoot } = roots[rootIndex];
    hash.update('root\0');
    hash.update(realProjectsRoot);
    hash.update('\0');
    try {
      hashStatIdentity(hash, await stat(realProjectsRoot));
    } catch {
      hash.update('unstatable\n');
    }
    const rootDiscovery = rootDiscoveryBudget(discovery, roots.length - rootIndex);
    const projectRead = await readDirentsBounded(projectsRoot, rootDiscovery);
    for (const proj of sortedIdentityDirents(projectRead.entries)) {
      if (!proj.isDirectory()) continue;
      const projPath = join(projectsRoot, proj.name);
      const realProjPath = await realpathOrNull(projPath);
      if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
      const sessionRead = await readDirentsBounded(projPath, rootDiscovery);
      for (const sess of sortedIdentityDirents(sessionRead.entries)) {
        if (!sess.isDirectory()) continue;
        const wfDir = join(projPath, sess.name, 'workflows');
        const realWfDir = await realpathOrNull(wfDir);
        if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
        const wfRead = await readDirentsBounded(wfDir, rootDiscovery);
        for (const entry of sortedIdentityDirents(wfRead.entries)) {
          if (!entry.isFile() || !isWfManifest(entry.name)) continue;
          const realFull = await realpathOrNull(join(wfDir, entry.name));
          if (!realFull || !pathInside(realWfDir, realFull)) continue;
          hash.update('manifest\0');
          hash.update(realFull);
          hash.update('\0');
          try {
            hashStatIdentity(hash, await stat(realFull));
          } catch {
            hash.update('unstatable\n');
          }
        }
      }
    }
    mergeRootDiscovery(discovery, rootDiscovery);
  }
  return identityFooter(hash, discovery);
}

/** Synchronous cold-start/ingest mirror of workflowSourceIdentity(). */
export function workflowSourceIdentitySync(projectsRootOrRoots, options = {}) {
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const hash = createHash('sha1');
  identityHeader(hash, projectsRootOrRoots, discovery);
  const roots = resolveProjectsRootsSync(
    projectsRootOrRoots,
    options.allowRootSymlinks
  );
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    if (discovery.remaining <= 0) {
      discovery.exhausted = true;
      break;
    }
    const { projectsRoot, realProjectsRoot } = roots[rootIndex];
    hash.update('root\0');
    hash.update(realProjectsRoot);
    hash.update('\0');
    try {
      hashStatIdentity(hash, statSync(realProjectsRoot));
    } catch {
      hash.update('unstatable\n');
    }
    const rootDiscovery = rootDiscoveryBudget(discovery, roots.length - rootIndex);
    const projectRead = readDirentsBoundedSync(projectsRoot, rootDiscovery);
    for (const proj of sortedIdentityDirents(projectRead.entries)) {
      if (!proj.isDirectory()) continue;
      const projPath = join(projectsRoot, proj.name);
      const realProjPath = realpathOrNullSync(projPath);
      if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
      const sessionRead = readDirentsBoundedSync(projPath, rootDiscovery);
      for (const sess of sortedIdentityDirents(sessionRead.entries)) {
        if (!sess.isDirectory()) continue;
        const wfDir = join(projPath, sess.name, 'workflows');
        const realWfDir = realpathOrNullSync(wfDir);
        if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
        const wfRead = readDirentsBoundedSync(wfDir, rootDiscovery);
        for (const entry of sortedIdentityDirents(wfRead.entries)) {
          if (!entry.isFile() || !isWfManifest(entry.name)) continue;
          const realFull = realpathOrNullSync(join(wfDir, entry.name));
          if (!realFull || !pathInside(realWfDir, realFull)) continue;
          hash.update('manifest\0');
          hash.update(realFull);
          hash.update('\0');
          try {
            hashStatIdentity(hash, statSync(realFull));
          } catch {
            hash.update('unstatable\n');
          }
        }
      }
    }
    mergeRootDiscovery(discovery, rootDiscovery);
  }
  return identityFooter(hash, discovery);
}

function projectionSignature(result) {
  return createHash('sha1')
    .update('workflow-projection-v1\n')
    .update(JSON.stringify(result))
    .digest('hex');
}

/** One producer snapshot: the exact projected value plus identities for both gates. */
export function readWorkflowProjectionSync(projectsRootOrRoots, options = {}) {
  const result = readWorkflowsSync(projectsRootOrRoots, options);
  const source = workflowSourceIdentitySync(projectsRootOrRoots, options);
  return {
    result,
    projectionSignature: projectionSignature(result),
    sourceIdentity: source.signature,
  };
}

function rootWatchIdentity(pathname) {
  try {
    const real = realpathSync(pathname);
    const value = statSync(real);
    return `${real}\0${value.dev ?? 0}\0${value.ino ?? 0}`;
  } catch {
    return null;
  }
}

function relevantWorkflowWatchEvent(filename) {
  if (filename == null) return true;
  const normalized = String(filename).replaceAll('\\', '/');
  const segments = normalized.split('/');
  const leaf = segments.at(-1) ?? '';
  // Recursive-watch filename detail varies by platform: some report a path from
  // the watched root, others only the changed basename. Either shape must keep
  // the healthy manifest fast path under one second.
  return segments.includes('workflows') || isWfManifest(leaf);
}

/**
 * Fast watcher token with a bounded stat-only reconciliation backstop.
 *
 * The first signature call performs the one exact cold scan. Later signature
 * calls are constant-time; recursive traversal happens only on the unref'd
 * background interval or as part of an ingest that already needs the data.
 */
export function createWorkflowFreshnessTracker(projectsRootOrRoots, options = {}) {
  const roots = projectsRootList(projectsRootOrRoots).map((value) => resolve(value));
  const reconcileIntervalMs = Math.max(
    10,
    Math.min(options.reconcileIntervalMs ?? 60_000, 60_000)
  );
  const identityOptions = {
    allowRootSymlinks: options.allowRootSymlinks,
    discoveryMaxEntries: options.discoveryMaxEntries,
  };
  // perf-index-contract: workflow-watchers always-consumed: every tracker lifecycle queries this root-keyed registry to replace, close, report, and dispose active watchers
  const watchers = new Map();
  let baselineIdentity = null;
  let coldIdentity = null;
  let epoch = 0;
  let syncScans = 0;
  let asyncScans = 0;
  let interval = null;
  let reconcilePromise = null;
  let debounce = null;
  let active = false;
  let lifecycle = 0;

  const markDirty = () => {
    if (!active || debounce) return;
    epoch += 1;
    debounce = setTimeout(() => {
      debounce = null;
    }, 25);
    debounce.unref?.();
  };

  const closeWatcher = (root) => {
    const record = watchers.get(root);
    if (!record) return;
    record.closing = true;
    watchers.delete(root);
    try {
      record.watcher.close();
    } catch {
      /* already closed */
    }
  };

  const syncWatchers = () => {
    if (!active || options.watch === false) return;
    for (const root of roots) {
      const identity = rootWatchIdentity(root);
      const current = watchers.get(root);
      if (current && current.identity === identity) continue;
      if (current) closeWatcher(root);
      if (!identity) continue;
      try {
        const watcher = watch(
          root,
          { persistent: false, recursive: true },
          (_eventType, filename) => {
            if (relevantWorkflowWatchEvent(filename)) markDirty();
          }
        );
        const record = { watcher, identity, closing: false };
        watchers.set(root, record);
        watcher.on('error', () => {
          if (record.closing || !active) return;
          markDirty();
          closeWatcher(root);
        });
        watcher.on('close', () => {
          if (record.closing || !active) return;
          watchers.delete(root);
          markDirty();
        });
        watcher.unref?.();
      } catch {
        // Unsupported recursive watches degrade to the periodic reconciliation.
      }
    }
  };

  const ensureStarted = () => {
    if (!active) {
      active = true;
      lifecycle += 1;
    }
    if (baselineIdentity == null) {
      const initial = workflowSourceIdentitySync(projectsRootOrRoots, identityOptions);
      syncScans += 1;
      baselineIdentity = initial.signature;
      coldIdentity = initial.signature;
      syncWatchers();
    }
    if (!interval && options.reconcile !== false) {
      interval = setInterval(() => {
        void reconcileNow().catch(() => {
          // A failed backstop must not become an unhandled rejection or silently
          // settle the cache gate. Force one invalidation and retry next interval;
          // the ordinary ingest walk still degrades unreadable input safely.
          markDirty();
          syncWatchers();
        });
      }, reconcileIntervalMs);
      interval.unref?.();
    }
  };

  const reconcileNow = async () => {
    ensureStarted();
    if (reconcilePromise) return reconcilePromise;
    const reconcileLifecycle = lifecycle;
    const pending = (async () => {
      const next = await workflowSourceIdentity(projectsRootOrRoots, identityOptions);
      asyncScans += 1;
      if (!active || lifecycle !== reconcileLifecycle) return next.signature;
      if (next.signature !== baselineIdentity) {
        baselineIdentity = next.signature;
        epoch += 1;
      }
      syncWatchers();
      return next.signature;
    });
    const tracked = pending().finally(() => {
      if (reconcilePromise === tracked) reconcilePromise = null;
    });
    reconcilePromise = tracked;
    return reconcilePromise;
  };

  const suspend = () => {
    active = false;
    lifecycle += 1;
    if (interval) clearInterval(interval);
    interval = null;
    if (debounce) clearTimeout(debounce);
    debounce = null;
    reconcilePromise = null;
    for (const root of [...watchers.keys()]) closeWatcher(root);
    baselineIdentity = null;
    coldIdentity = null;
    epoch = 0;
  };

  return {
    signature() {
      ensureStarted();
      return `${coldIdentity}:${epoch}`;
    },
    observeSourceIdentity(identity) {
      ensureStarted();
      baselineIdentity = identity;
      // ingest() just accepted a complete producer snapshot. Re-arm immediately:
      // a distinct edit/add/remove after that boundary must not be swallowed by
      // the short burst debounce from the preceding filesystem event.
      if (debounce) clearTimeout(debounce);
      debounce = null;
    },
    reconcileNow,
    markDirtyForTests: markDirty,
    debugState() {
      return {
        epoch,
        syncScans,
        asyncScans,
        watcherCount: watchers.size,
        baselineIdentity,
        active,
      };
    },
    // Scoped-ingest eviction releases resources. A later signature call may
    // safely restart from a new exact cold baseline on this cached module.
    dispose: suspend,
  };
}
