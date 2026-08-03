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
//   - `readWorkflows(projectsRoot)`     — async, for the server's /api/workflows
//     route (non-blocking I/O).
//   - `readWorkflowsSync(projectsRoot)` — sync, for the ingest pipeline's
//     synchronous `assembleDataset()` (#661), which feeds the workflow-health
//     detectors (#635).
// The projects root is a parameter so neither path hardcodes `~/.claude`.

import { open, opendir, realpath } from 'node:fs/promises';
import { closeSync, existsSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

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

/** Async walk for the server's /api/workflows route. */
export async function readWorkflows(projectsRoot, options = {}) {
  const runs = [];
  let skippedManifests = 0;
  let truncated = false;
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const projectRead = await readDirentsBounded(projectsRoot, discovery);
  if (projectRead.missing) {
    return workflowResult([], skippedManifests, truncated, discovery);
  }
  if (projectRead.truncated) truncated = true;
  const realProjectsRoot = await realpathOrNull(projectsRoot);
  if (!realProjectsRoot) {
    return workflowResult([], skippedManifests, truncated, discovery);
  }
  for (const proj of projectRead.entries) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsRoot, proj.name);
    const realProjPath = await realpathOrNull(projPath);
    if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
    const sessionRead = await readDirentsBounded(projPath, discovery);
    if (sessionRead.missing) continue;
    if (sessionRead.truncated) truncated = true;
    for (const sess of sessionRead.entries) {
      if (!sess.isDirectory()) continue;
      const wfDir = join(projPath, sess.name, 'workflows');
      if (!existsSync(wfDir)) continue;
      const realWfDir = await realpathOrNull(wfDir);
      if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
      const wfRead = await readDirentsBounded(wfDir, discovery);
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
            runs.push(run);
            if (runs.length >= WORKFLOW_RUN_MAX_ENTRIES) {
              truncated = true;
              return workflowResult(runs, skippedManifests, truncated, discovery);
            }
          }
        } catch (err) {
          if (isWorkflowManifestTooLargeError(err)) skippedManifests += 1;
          /* skip an unreadable / malformed manifest */
        }
      }
    }
  }
  return workflowResult(runs, skippedManifests, truncated, discovery);
}

/** Synchronous mirror for the ingest pipeline's `assembleDataset()` (#661). */
export function readWorkflowsSync(projectsRoot, options = {}) {
  const runs = [];
  let skippedManifests = 0;
  let truncated = false;
  const discovery = createDiscoveryBudget(options.discoveryMaxEntries);
  const projectRead = readDirentsBoundedSync(projectsRoot, discovery);
  if (projectRead.missing) {
    return workflowResult([], skippedManifests, truncated, discovery);
  }
  if (projectRead.truncated) truncated = true;
  const realProjectsRoot = realpathOrNullSync(projectsRoot);
  if (!realProjectsRoot) {
    return workflowResult([], skippedManifests, truncated, discovery);
  }
  for (const proj of projectRead.entries) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsRoot, proj.name);
    const realProjPath = realpathOrNullSync(projPath);
    if (!realProjPath || !pathInside(realProjectsRoot, realProjPath)) continue;
    const sessionRead = readDirentsBoundedSync(projPath, discovery);
    if (sessionRead.missing) continue;
    if (sessionRead.truncated) truncated = true;
    for (const sess of sessionRead.entries) {
      if (!sess.isDirectory()) continue;
      const wfDir = join(projPath, sess.name, 'workflows');
      if (!existsSync(wfDir)) continue;
      const realWfDir = realpathOrNullSync(wfDir);
      if (!realWfDir || !pathInside(realProjPath, realWfDir)) continue;
      const wfRead = readDirentsBoundedSync(wfDir, discovery);
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
            runs.push(run);
            if (runs.length >= WORKFLOW_RUN_MAX_ENTRIES) {
              truncated = true;
              return workflowResult(runs, skippedManifests, truncated, discovery);
            }
          }
        } catch (err) {
          if (isWorkflowManifestTooLargeError(err)) skippedManifests += 1;
          /* skip an unreadable / malformed manifest */
        }
      }
    }
  }
  return workflowResult(runs, skippedManifests, truncated, discovery);
}
