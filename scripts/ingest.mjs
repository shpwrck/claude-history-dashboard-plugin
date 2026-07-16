// Incremental ingestion + normalized dataset assembly for the dashboard.
//
// Source of truth = the per-session transcripts under ~/.claude/projects.
// Each top-level session file (plus its subagents/*.jsonl) is parsed ONCE with
// the app's own parsers and cached in SQLite, keyed by a file signature
// (mtime+size). On each request we re-ingest only files whose signature changed
// (e.g. the live, growing session), so the dataset stays fresh without
// re-parsing everything. history.jsonl plus history.d/*.jsonl are unioned in
// for legacy sessions that have no transcript on disk.
//
// Run under `node --import ./scripts/register-ts.mjs` so the .ts parsers resolve.

import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { basename, delimiter, join, dirname, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readWorkflowsSync } from './read-workflows.mjs';
import { listNestedWorkflowAgentTranscripts } from './workflow-transcripts.mjs';
// The host-producer seam (#2077, ADR 0007): shared root discovery + capped
// artifact reads + their cap constants, dependency-free so the zero-node_modules
// server boot graph stays clean. ingest re-exports the cap constants under their
// established names (server.mjs imports them) and routes discovery/reads through
// these helpers so it stays glued to the same bounded reads the producers use.
import {
  resolveArtifactFileMaxBytes,
  resolveRepoMapArtifactMaxEntries,
  readArtifactTextCappedSync,
  readArtifactJsonCappedSync,
  readJsonlTailCappedSync,
  claudeJsonProjectRoots as discoverClaudeJsonProjectRoots,
  repoMapArtifactRoots as discoverRepoMapArtifactRoots,
} from './lib/host-producer.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_GRAPH_ROOT = resolve(process.env.CHD_DOC_GRAPH_ROOT || PROJECT_DIR);
const LIB = join(PROJECT_DIR, 'src', 'lib');
const { resolveSources } = await import(join(LIB, 'sources.ts'));
const { filesystemArtifactSource } = await import(join(LIB, 'artifact-source.ts'));
const DATA_SOURCES = resolveSources({ env: process.env, homeDir: homedir() });
const DEFAULT_SOURCE = DATA_SOURCES[0];
const PROJECTS = DEFAULT_SOURCE.historyDir;
const CLAUDE = dirname(PROJECTS);
const DEFAULT_SOURCE_PROVENANCE = {
  sourceId: DEFAULT_SOURCE.id,
  harness: DEFAULT_SOURCE.harness,
};
const SOURCE_DECORATED_SIGNAL_KEYS = new Set([
  'tokenData',
  'toolData',
  'toolInventories',
  'timelines',
  'apiErrors',
  'agentSettings',
  'attribution',
  'runtimeEvents',
  'churnGeometry',
  'assistantFeatures',
  'deceitSignals',
  'valueFlow',
]);

function withSourceProvenance(value, provenance = DEFAULT_SOURCE_PROVENANCE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...value,
    sourceId: value.sourceId || provenance.sourceId,
    harness: value.harness || provenance.harness,
  };
}

function maybeDecorateSignalValue(datasetKey, value, provenance = DEFAULT_SOURCE_PROVENANCE) {
  return SOURCE_DECORATED_SIGNAL_KEYS.has(datasetKey)
    ? withSourceProvenance(value, provenance)
    : value;
}
// Top-level Claude Code config — carries mcpServers (global) plus a `projects`
// map keyed by absolute project path with per-project mcpServers and
// enabledMcpjsonServers.
const CLAUDE_JSON =
  DEFAULT_SOURCE.configFile || join(dirname(CLAUDE), '.claude.json');
const CLAUDE_HOME = dirname(CLAUDE_JSON);
// CHD_CACHE_DIR: all install-dir writes land here so a plugin reinstall never
// clobbers accumulated runtime state. Defaults to ~/.claude/.cache/chd/ — a
// subdirectory of the data root that is preserved across plugin updates.
// Individual path overrides (CHD_DB_PATH, DASHBOARD_REVIEW_EVENTS_CACHE_PATH)
// take precedence when set; CHD_CACHE_DIR is only the default base.
export const CHD_CACHE_DIR =
  process.env.CHD_CACHE_DIR || join(CLAUDE, '.cache', 'chd');
const SCOPED_INGEST = /^(1|true|yes|on)$/i.test(
  String(process.env.CHD_SCOPED_INGEST || '')
);
function splitPathList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(new RegExp(`[${delimiter === '\\' ? '\\\\' : delimiter},\\n]`))
    .map((part) => part.trim())
    .filter(Boolean);
}

function projectsRootFromPath(raw, assumeHubRoot = false) {
  const abs = resolve(raw);
  if (abs.endsWith(`${sep}projects`)) return abs;
  if (assumeHubRoot) return join(abs, 'projects');
  const nested = join(abs, 'projects');
  return existsSync(nested) ? nested : abs;
}

function projectsRootsFromEnv(name, assumeHubRoot = false) {
  return splitPathList(process.env[name]).map((part) =>
    projectsRootFromPath(part, assumeHubRoot)
  );
}

function uniqueProjectsRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const normalized = resolve(root);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function projectSourceFrom(source, projectsRoot) {
  return {
    source: {
      ...source,
      historyDir: projectsRoot,
    },
    projectsRoot,
  };
}

function hubSourceFromRoot(projectsRoot, index) {
  return projectSourceFrom(
    {
      id: `claude-code-hub-${index + 1}`,
      harness: DEFAULT_SOURCE.harness,
      historyDir: projectsRoot,
    },
    projectsRoot
  );
}

function uniqueProjectSources(sources) {
  const seenRoots = new Set();
  const seenIds = new Set();
  const out = [];
  for (const item of sources) {
    const projectsRoot = resolve(item.projectsRoot);
    if (seenRoots.has(projectsRoot) || seenIds.has(item.source.id)) continue;
    seenRoots.add(projectsRoot);
    seenIds.add(item.source.id);
    out.push(projectSourceFrom(item.source, projectsRoot));
  }
  return out;
}

const PROJECT_CONFIG_ROOTS = splitPathList(
  process.env.DASHBOARD_PROJECT_CONFIG_ROOTS
)
  .filter((root) => root.startsWith('/'))
  .map((root) => resolve(root))
  .sort();

const EXTRA_PROJECT_ROOTS = SCOPED_INGEST
  ? []
  : uniqueProjectsRoots([
      ...projectsRootsFromEnv('DASHBOARD_HUB_PROJECTS_DIR'),
      ...projectsRootsFromEnv('CLAUDE_HUB_PROJECTS_DIR'),
      ...projectsRootsFromEnv('CLAUDE_HUB_DIR', true),
    ]);
const PROJECT_SOURCES = uniqueProjectSources([
  ...DATA_SOURCES.map((source) => projectSourceFrom(source, resolve(source.historyDir))),
  ...EXTRA_PROJECT_ROOTS.map((root, index) => hubSourceFromRoot(root, index)),
]).map(({ source, projectsRoot }) => ({
  source,
  projectsRoot,
  // The artifact-source interface (ADR 0009 §1): every source-relative
  // filesystem read flows through this `list`/`read`-by-`source_id + rel_path
  // + signature` abstraction, so a second source root is just another
  // ArtifactSource. Rooted at `dirname(historyDir)` to match the legacy
  // `sourceArtifactPath`, so single-source paths stay byte-identical.
  artifacts: filesystemArtifactSource(source),
}));
export const PROJECT_ROOTS = PROJECT_SOURCES.map((item) => item.projectsRoot);

// Per-source member attribution (#1999). The push-ingest endpoint stamps the shipper's
// member/displayName/repo out of band at `<root>/.sources/<sourceId>/_source.json` (root =
// `dirname(historyDir)`, the same anchor the artifact-source interface uses). Fold it onto the
// public source descriptor so the dashboard can label/group aggregated sessions by member off the
// existing `sourceId` provenance — no new endpoint. Best-effort: a source with no `_source.json`
// (every single-machine / local source) is returned byte-identically.
// Read `member`/`displayName`/`repo` from a `_source.json` provenance file, returning only
// the present non-empty string fields (or null). Shared by the configured-source enrichment
// (#1999) and the shipped-source discovery (#2136).
function readSourceMemberMeta(metaPath) {
  try {
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!meta || typeof meta !== 'object') return null;
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const out = {};
    if (pick(meta.member)) out.member = pick(meta.member);
    if (pick(meta.displayName)) out.displayName = pick(meta.displayName);
    if (pick(meta.repo)) out.repo = pick(meta.repo);
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function memberMetadataForSource(source) {
  return readSourceMemberMeta(
    join(dirname(source.historyDir), '.sources', source.id, '_source.json')
  );
}

// #2136: shipped-source attribution. The push-ingest endpoint writes each shipper's provenance
// + a per-artifact ledger under `<ingestDir>/.sources/<sourceId>/` while the transcripts land in
// the SHARED `projects/` dir (UUID-named, collision-free). The ledger (`.signatures.json`) records
// exactly which `projects/<proj>/<uuid>.jsonl` transcripts that source shipped — the authoritative
// session->source map. Without this, every shipped session collapses into the one default source
// (the live #2000/#2136 gap on hub: 16 pod-sources, all attributed to `claude-code`). Here we
// enumerate those ledgers as distinct attributable sources and remember which session each shipped,
// so `assembleDataset` can tag it with the pod/member that produced it.
//
// A session-data transcript relpath: `projects/<encoded-project>/<sessionUuid>.jsonl`. Non-transcript
// shipped artifacts (bridge-pointer.json, *.ccr-tip.json, history parts) are ignored for attribution.
const SHIPPED_TRANSCRIPT_RE = /^projects\/[^/]+\/([^/]+)\.jsonl$/;

function discoverShippedSources() {
  const sources = [];
  const sessionToSource = new Map();
  const seenIngestDirs = new Set();
  for (const { source } of PROJECT_SOURCES) {
    const ingestDir = dirname(source.historyDir);
    if (seenIngestDirs.has(ingestDir)) continue;
    seenIngestDirs.add(ingestDir);
    const sourcesRoot = join(ingestDir, '.sources');
    let dirents;
    try {
      dirents = readdirSync(sourcesRoot, { withFileTypes: true });
    } catch {
      continue; // no push-ingest provenance under this root
    }
    for (const ent of dirents) {
      if (!ent.isDirectory()) continue;
      const sourceId = ent.name;
      // A configured/default source already carries its own descriptor; don't shadow it.
      if (ARTIFACT_SOURCE_BY_ID.has(sourceId)) continue;
      const dir = join(sourcesRoot, sourceId);
      let ledger;
      try {
        ledger = JSON.parse(readFileSync(join(dir, '.signatures.json'), 'utf8'));
      } catch {
        continue; // provenance-only (no shipped artifacts) -> nothing to attribute
      }
      const claimed = [];
      for (const relPath of Object.keys(ledger || {})) {
        const m = SHIPPED_TRANSCRIPT_RE.exec(relPath);
        if (m) claimed.push(m[1]);
      }
      if (!claimed.length) continue; // shipped only non-transcript artifacts
      const harness = DEFAULT_SOURCE.harness;
      for (const sessionId of claimed) {
        // First writer wins so attribution is deterministic across the dirent order.
        if (!sessionToSource.has(sessionId)) {
          sessionToSource.set(sessionId, { sourceId, harness });
        }
      }
      const meta = readSourceMemberMeta(join(dir, '_source.json')) || {};
      sources.push({ id: sourceId, harness, historyDir: dir, ...meta });
    }
  }
  return { sources, sessionToSource };
}

const PUBLIC_DATA_SOURCES = PROJECT_SOURCES.map((item) => {
  const meta = memberMetadataForSource(item.source);
  return meta ? { ...item.source, ...meta } : { ...item.source };
});

function provenanceForSource(source) {
  return {
    sourceId: source.id,
    harness: source.harness,
  };
}

// source.id -> its ArtifactSource (ADR 0009 §1). All source-relative reads
// resolve through this so a path is never re-derived outside the interface.
const ARTIFACT_SOURCE_BY_ID = new Map(
  PROJECT_SOURCES.map(({ source, artifacts }) => [source.id, artifacts])
);

// Discovered AFTER ARTIFACT_SOURCE_BY_ID (which it reads to avoid shadowing a configured source).
const { sources: SHIPPED_SOURCES, sessionToSource: SHIPPED_SESSION_SOURCE } =
  discoverShippedSources();

// dataset.sources = configured/default sources + discovered shipped sources (deduped by id).
function datasetSources() {
  const byId = new Map(PUBLIC_DATA_SOURCES.map((s) => [s.id, s]));
  for (const s of SHIPPED_SOURCES) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}

function artifactSourceFor(source) {
  return ARTIFACT_SOURCE_BY_ID.get(source.id) ?? filesystemArtifactSource(source);
}

function historyFileSetForSource(source) {
  const artifacts = artifactSourceFor(source);
  const provenance = provenanceForSource(source);
  // Each entry carries its ArtifactSource + the root-relative path so the union
  // read flows through the interface (`exists`/`read`) rather than re-deriving an
  // abs path and reaching past the abstraction (ADR 0009 §1). `path` (the abs
  // path) is retained for the content-hash gate consumers that stat it directly.
  const legacy = {
    artifacts,
    relPath: 'history.jsonl',
    path: artifacts.resolve('history.jsonl'),
    provenance,
  };
  // history.d/<part>.jsonl — listed through the artifact-source `list`, sorted
  // by relPath for deterministic order (parity with the prior abs-path sort,
  // since a shared directory prefix preserves the same ordering).
  const parts = artifacts
    .list('history.d', (ent) => ent.isFile && ent.name.endsWith('.jsonl'))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((ref) => ({
      artifacts,
      relPath: ref.relPath,
      path: ref.absPath,
      provenance,
    }));
  return { legacy, parts, provenance };
}

function historyFilesForSource(source) {
  const { legacy, parts } = historyFileSetForSource(source);
  return [legacy, ...parts];
}

function sourceHistoryFileSets() {
  return PROJECT_SOURCES.map(({ source }) => historyFileSetForSource(source));
}

function sourceHistoryFiles() {
  return PROJECT_SOURCES.flatMap(({ source }) => historyFilesForSource(source));
}

const SOURCE_AGGREGATE_ARTIFACTS = [
  { relPath: 'sessions', kind: 'dir' },
  { relPath: 'telemetry', kind: 'dir' },
  { relPath: 'debug', kind: 'dir' },
  { relPath: 'file-history', kind: 'dir' },
  { relPath: 'stats-cache.json', kind: 'file' },
];

function sourceArtifactPath(source, relPath) {
  // Resolve through the artifact-source interface (ADR 0009 §1) so the abs path
  // is owned in one place; `resolve` is `join(dirname(historyDir), relPath)`,
  // identical to the prior inline join (single-source byte-for-byte parity).
  return artifactSourceFor(source).resolve(relPath);
}

function sourceArtifactInputs() {
  return PROJECT_SOURCES.flatMap(({ source }) =>
    SOURCE_AGGREGATE_ARTIFACTS.map((artifact) => ({
      ...artifact,
      source,
      path: sourceArtifactPath(source, artifact.relPath),
    }))
  );
}

function mergeStatsCaches(caches) {
  const valid = caches.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  const byDate = new Map();
  let version = 0;
  let lastComputedDate = '';
  for (const cache of valid) {
    version = Math.max(version, cache.version || 0);
    if (cache.lastComputedDate && cache.lastComputedDate > lastComputedDate) {
      lastComputedDate = cache.lastComputedDate;
    }
    for (const row of cache.dailyActivity || []) {
      const existing = byDate.get(row.date) || {
        date: row.date,
        messageCount: 0,
        sessionCount: 0,
        toolCallCount: 0,
      };
      existing.messageCount += row.messageCount || 0;
      existing.sessionCount += row.sessionCount || 0;
      existing.toolCallCount += row.toolCallCount || 0;
      byDate.set(row.date, existing);
    }
  }
  return {
    version,
    lastComputedDate,
    dailyActivity: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// CLAUDE_SHADOW_CALLS_LEDGER must move BOTH readers together — this aggregate
// path and the server's /api/shadow-experiments.json row path — or the Shadow
// Calls view would compose two different ledgers on one page (#2152). The
// override is GLOBAL-ingest only: a scoped enterprise ingest (CHD_SCOPED_INGEST,
// CLAUDE swapped to the principal's data root) must derive its own root's
// ledger, or the process-wide env value would leak the default root's
// experiment history into a scoped member's aggregate.
const SHADOW_CALLS_LEDGER =
  (!SCOPED_INGEST && process.env.CLAUDE_SHADOW_CALLS_LEDGER) ||
  join(CLAUDE, 'shadow-calls', 'ledger.jsonl');
// Proof-batch receipts (#2151): finalized PROOF receipts appended by
// scripts/proof-batch.mjs, one JSON line each. Repo-tracked (data/, not
// ~/.claude) — the runner writes them next to the preregistration they answer.
const PROOF_RECEIPTS_PATH = join(PROJECT_DIR, 'data', 'proof-receipts.jsonl');
// `~/.claude/usage-data` holds the repo-map artifacts we ingest (REPO_MAP_DIR).
const USAGE_DATA = join(CLAUDE, 'usage-data');
const REPO_MAP_DIR = join(USAGE_DATA, 'repo-map');
const DOC_HYGIENE_DIR = join(USAGE_DATA, 'doc-hygiene');
// Defaults to CHD_CACHE_DIR/dashboard.db. `CHD_DB_PATH` overrides it so a
// test can point ingest at a throwaway DB (and a fixture $HOME) without touching
// the real cache — test-only seam, production behaviour is unchanged when unset.
// Using CHD_CACHE_DIR (not PROJECT_DIR/.cache) keeps the DB out of the plugin
// install dir so updates never clobber it (#1336).
const DB_PATH = process.env.CHD_DB_PATH || join(CHD_CACHE_DIR, 'dashboard.db');
const DB_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
const READ_CHUNK_BYTES = 65_536;

function parseNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export const INGEST_SESSION_MAX_BYTES = Math.max(
  65_536,
  Math.min(
    536_870_912,
    parseNonNegativeIntEnv('DASHBOARD_INGEST_SESSION_MAX_BYTES', 67_108_864)
  )
);
export const INGEST_SESSION_MAX_PARTS = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_INGEST_SESSION_MAX_PARTS', 10_000)
  )
);
export const INGEST_PROJECT_MAX_DIRS = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_INGEST_PROJECT_MAX_DIRS', 50_000)
  )
);
export const MEMORY_FILE_MAX_BYTES = Math.max(
  256,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv('DASHBOARD_MEMORY_FILE_MAX_BYTES', 262_144)
  )
);
export const MEMORY_DIR_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_MEMORY_DIR_MAX_ENTRIES', 50_000)
  )
);
export const INGEST_SESSION_DISCOVERY_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES', 250_000)
  )
);
// ARTIFACT_FILE_MAX_BYTES + REPO_MAP_ARTIFACT_MAX_ENTRIES are owned by the
// host-producer seam (./lib/host-producer.mjs) so every producer (ingest,
// repo-map-refresh, the #280 bridge) shares one cap + clamp. Evaluated through
// the seam's resolvers HERE (not re-exported from the seam's frozen const) so a
// fresh `?fixture=` re-import of ingest picks up an env override — the
// env-override test contract (#2077). server.mjs's existing imports of these
// names are unchanged.
export const ARTIFACT_FILE_MAX_BYTES = resolveArtifactFileMaxBytes();
export const REPO_MAP_ARTIFACT_MAX_ENTRIES = resolveRepoMapArtifactMaxEntries();
export const ARTIFACT_DIR_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES', 50_000)
  )
);
export const ARTIFACT_CACHE_JSON_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    536_870_912,
    parseNonNegativeIntEnv('DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES', 67_108_864)
  )
);
export const DATASET_RESPONSE_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    2_147_483_647,
    parseNonNegativeIntEnv('DASHBOARD_DATASET_RESPONSE_MAX_BYTES', 536_870_912)
  )
);
export const SIGNATURE_TREE_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES', 250_000)
  )
);
// Live config inputs assembled into the `liveConfig` dataset bundle. Every
// file/dir below is optional — assembleLiveConfig() degrades to empty values
// when a source is missing or malformed, so a partial config never sinks the
// dataset endpoint.
const SETTINGS_GLOBAL = join(CLAUDE, 'settings.json');
const SETTINGS_LOCAL = join(CLAUDE, 'settings.local.json');
const CLAUDE_MD_GLOBAL = join(CLAUDE, 'CLAUDE.md');
const SKILLS_DIR = join(CLAUDE, 'skills');
const AGENTS_DIR = join(CLAUDE, 'agents');
const COMMANDS_DIR = join(CLAUDE, 'commands');
const PLUGINS_REGISTRY = join(CLAUDE, 'plugins', 'installed_plugins.json');
const PLUGINS_CACHE = join(CLAUDE, 'plugins', 'cache');
// ── #539 ingest artifacts — top-level ~/.claude files/dirs not derived from
// transcripts (per-artifact child issues #559–#569, #572). All optional; every
// reader below degrades to an empty value when the source is missing/malformed.
const TASKS_DIR = join(CLAUDE, 'tasks');
const TEAMS_DIR = join(CLAUDE, 'teams');
const PLANS_DIR = join(CLAUDE, 'plans');
const MODEL_EVAL_RESULTS_DIR = join(CLAUDE, 'model-evals', 'results');
const LAST_UPDATE = join(CLAUDE, '.last-update-result.json');
const MCP_AUTH = join(CLAUDE, 'mcp-needs-auth-cache.json');
const BACKUPS_DIR = join(CLAUDE, 'backups');
const REVIEW_EVENTS_CACHE =
  process.env.DASHBOARD_REVIEW_EVENTS_CACHE_PATH ||
  join(CHD_CACHE_DIR, 'review-events', 'github-review-events.json');

const { slimSessionTimeline } = await import(
  join(LIB, 'parse-timeline.ts')
);
// Pure Live Session compute (#627 slice 2) — file-based, server+client
// importable. computeLiveSession() below is a thin wrapper that injects the
// session-discovery dependency (listSessionsCached) so this module never has to
// import ingest.mjs (no cycle).
const liveSessionModule = await import(join(LIB, 'live-session.ts'));
const { liveSession } = liveSessionModule;
export const LIVE_SESSION_MAX_BYTES = liveSessionModule.LIVE_SESSION_MAX_BYTES;
const { parseHistoryJsonl, unionHistoryParts, groupBySessions, groupByProjects } = await import(
  join(LIB, 'parse-history.ts')
);
const { parsePromptAnalysis } = await import(join(LIB, 'parse-prompt-analysis.ts'));
const { computeTaskSteering } = await import(join(LIB, 'parse-steering.ts'));
const { safeJsonStringify } = await import(join(LIB, 'json-safe.ts'));
// Pure recommendation engine (no DOM/React) — server-importable so the
// /api/recommendations.json route can mirror the UI's recs (#126).
const {
  buildRecommendations,
  buildRecommendationResult,
  assembleRecommendationInput,
  filterRecommendationsByProject,
  backfillReclaimSavings,
  computeSuppressionTransitions,
  suppressRejectedRecommendations,
} = await import(join(LIB, 'recommendations.ts'));
// Recs adoption-receipt store (#575/#576): reader for the prior SURFACED/
// SUPPRESSED index and the allowlist-drop, killswitch-aware appender.
// `readRejectedFindingIds` (#2206) is the user-reject suppression query,
// re-exported below so the off-main-thread recs worker can read it too.
const { appendAdoptionReceipt, readAdoptionReceiptIndex, readRejectedFindingIds } =
  await import(join(LIB, 'adoption-receipts.ts'));
export { readRejectedFindingIds };
// #2718: server-safe masthead + Cost-route filter boundary (extracted from the
// React view layer into a React-free module) and the canonical ViewData -> engine
// input mapping. The scoped recommendation surfaces reproduce the browser's exact
// global-masthead-then-route filter semantics by running the SAME pure code the
// UI does — parity is structural, not a hand-kept reimplementation.
const { filterViewDataByTime, filterViewDataByProject } = await import(
  join(LIB, 'view-scope.ts')
);
const { filterCostDataByRoute, reclaimScopedInput } = await import(
  join(LIB, 'cost-scope.ts')
);
const { recommendationViewsFromViewData } = await import(
  join(LIB, 'recommendation-view-data.ts')
);
const { ALL_PROJECTS, DEFAULT_TIME_PRESET } = await import(
  join(LIB, 'routing-core.ts')
);
// Durable checkpoint answer-time efficacy reader (#2519). Kept outside the
// dataset/hash path: this dashboard-owned telemetry is queried explicitly and
// never changes transcript-derived dataset freshness.
const { readCheckpointAnswerEfficacy } = await import(
  join(LIB, 'checkpoint-answer-store.ts')
);
export { readCheckpointAnswerEfficacy };
// Shadow-calls experiment ledger (epic #513) — per-axis aggregate feeds the
// workflow.shadow-axis-wins detector (#518/#523).
const {
  parseShadowCalls,
  parseProofReceiptCells,
  modelEvalSourceCell,
  mergeExternalSourceCells,
} = await import(join(LIB, 'parse-shadow-calls.ts'));
const { parseWorkflows } = await import(join(LIB, 'parse-workflows.ts'));
// External guidance snapshots (#1302, epic #656) — repo-committed, static
// reference docs the engine attaches to fired recs as "Learn More" links.
// Read from the repo's data dir (NOT ~/.claude); never fetched at runtime.
const {
  externalGuidanceSnapshotPaths,
  readExternalGuidanceSnapshots,
} = await import(
  join(LIB, 'parse-external-guidance.ts')
);
// Per-project agent memory store + MEMORY.md index (#1965/#1990). Built fresh
// per recs assemble from a local memory walk and threaded into
// `RecommendationInput.memoryStores` so the #1779 memory-hygiene detector fires
// on the real local store instead of staying dark in production.
const { buildMemoryStores } = await import(join(LIB, 'parse-memories.ts'));
// Git delivery-outcome signal (#1757, epic #1911). Pure label/parse logic lives
// in parse-git-outcome.ts (no network, so it stays safe under the zero-deps
// runtime import guard); the live `gh`/GitHub-API fetch that feeds it happens
// HERE, server-side, in readGitOutcomes() below.
const { buildGitOutcomes, gitOutcomesReposFromEnv } = await import(
  join(LIB, 'parse-git-outcome.ts')
);
// Repo doc graph (#2257, epic #2256). buildDocGraph walks this repo's own
// Markdown (root *.md + docs/**) into a SCIP-style node/edge graph the
// doc-hygiene detector reads off `RecommendationInput.docGraph`. Pure over the
// project root — a LOCAL repo-docs walk, no network — so it is safe under the
// zero-deps runtime import guard (node:fs/child_process only, like parse-tasks).
const {
  buildDocGraph,
  docGraphGitHistorySignature,
  docGraphSourcePaths,
  DOC_GRAPH_MAX_FILE_BYTES,
} = await import(join(LIB, 'parse-docs.ts'));
const {
  DOC_HYGIENE_ARTIFACT_KEY_ENV,
  DOC_HYGIENE_EXPECTED_COMMIT_ENV,
  docHygieneArtifactFilename,
  parseDocHygieneArtifact,
} = await import(join(LIB, 'doc-hygiene-artifact.ts'));
// Local snapshot root. The override is a test/deployment seam for supplying an
// isolated committed-snapshot mirror; unset keeps the shipped repo path exactly
// as before. It never fetches or writes guidance.
const EXTERNAL_GUIDANCE_DIR = resolve(
  process.env.CHD_EXTERNAL_GUIDANCE_DIR ||
    join(PROJECT_DIR, 'data', 'external-guidance')
);
// This repo ships only a handful of snapshots. Bound both the reader and the
// per-request metadata signature to the same directory prefix so an accidental
// or hostile override cannot turn sourceSignature() into an unbounded walk.
const EXTERNAL_GUIDANCE_MAX_ENTRIES = 256;
// Keep non-JSON noise in an overridden directory from forcing an unbounded
// scan while still letting ordinary ignored entries leave the 256-snapshot
// eligible surface untouched.
const EXTERNAL_GUIDANCE_MAX_SCANNED_ENTRIES = 4_096;

function externalGuidancePaths() {
  return externalGuidanceSnapshotPaths(EXTERNAL_GUIDANCE_DIR, {
    maxEntries: EXTERNAL_GUIDANCE_MAX_ENTRIES,
    maxScannedEntries: EXTERNAL_GUIDANCE_MAX_SCANNED_ENTRIES,
  });
}

function externalGuidanceSourceSignature() {
  const hash = createHash('sha1');
  let count = 0;
  for (const path of externalGuidancePaths()) {
    try {
      const s = statSync(path);
      hash.update(basename(path));
      hash.update('\0');
      hash.update(String(s.mtimeMs));
      hash.update('\0');
      hash.update(String(s.size));
      hash.update('\0');
      // mtime and size are user-restorable. ctime plus inode identity makes an
      // equal-length in-place rewrite or atomic replacement move this cheap
      // gate without reading snapshot bodies on every request.
      hash.update(String(s.ctimeMs));
      hash.update('\0');
      hash.update(String(s.ino));
      hash.update('\n');
      count += 1;
    } catch {
      /* a concurrently replaced snapshot will move the next signature */
    }
  }
  hash.update(`count:${count}`);
  return `${count}:${hash.digest('hex')}`;
}

function hashExternalGuidanceContent(hash) {
  let count = 0;
  for (const path of externalGuidancePaths()) {
    hash.update(basename(path));
    hash.update('\0');
    try {
      const content = readTextFileCappedSync(path, CONFIG_FILE_MAX_BYTES);
      hash.update(String(Buffer.byteLength(content, 'utf8')));
      hash.update('\0');
      hash.update(content);
    } catch (error) {
      hash.update('unreadable\0');
      hash.update(String(error?.code || 'error'));
    }
    hash.update('\n');
    count += 1;
  }
  hash.update(`count:${count}\n`);
}
// Read fresh on every assemble — NOT memoized. The ingest() content-hash gate
// hashes this dir so a refreshed snapshot (git pull / drift-PR merge under a
// standing dev server) invalidates the persisted dataset cache; a process-
// lifetime memo here would let the stale array be re-persisted under the NEW
// hash, poisoning the cache across restarts. The dir holds a handful of small
// JSON files, so the per-call cost is negligible.
function readExternalGuidance() {
  try {
    return readExternalGuidanceSnapshots(EXTERNAL_GUIDANCE_DIR, {
      maxEntries: EXTERNAL_GUIDANCE_MAX_ENTRIES,
      maxScannedEntries: EXTERNAL_GUIDANCE_MAX_SCANNED_ENTRIES,
    });
  } catch {
    // Missing/malformed snapshot store degrades to "no references", never
    // sinks the dataset endpoint.
    return [];
  }
}

function readDirentsSortedBoundedSync(dir) {
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return { entries: [], truncated: false, missing: true };
  }
  const entries = [];
  let truncated = false;
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entries.length >= MEMORY_DIR_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, truncated, missing: false };
}

// One canonical fixed-depth surface shared by the data reader and both cache
// gates: root `*.md` plus direct `archive/*.md`, never `archive/**/`.
function pathInsideReal(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}

export function memoryOpenCapabilities(constants = fsConstants) {
  return {
    noFollow: Number.isInteger(constants.O_NOFOLLOW),
    nonBlocking: Number.isInteger(constants.O_NONBLOCK),
  };
}

export function memoryOpenFlags(constants = fsConstants) {
  const capabilities = memoryOpenCapabilities(constants);
  return (
    constants.O_RDONLY |
    (capabilities.noFollow ? constants.O_NOFOLLOW : 0) |
    (capabilities.nonBlocking ? constants.O_NONBLOCK : 0)
  );
}

export function memoryOpenedPathMatches(
  realParent,
  selectedPath,
  openedPath,
  platform = process.platform
) {
  const expected =
    platform === 'win32'
      ? win32.join(realParent, win32.basename(selectedPath))
      : join(realParent, basename(selectedPath));
  return platform === 'win32'
    ? openedPath.toLowerCase() === expected.toLowerCase()
    : openedPath === expected;
}

function realpathOpenedMemoryFdSync(fd) {
  for (const fdRoot of ['/proc/self/fd', '/dev/fd']) {
    try {
      const fdPath = join(fdRoot, String(fd));
      const resolved = realpathSync(fdPath);
      // Some non-Linux descriptor filesystems resolve only to their own device
      // entry, not to the opened backing path. Treat that as unavailable so the
      // portable local-mode verification below can run instead.
      if (resolved === fdPath || pathInsideReal(fdRoot, resolved)) continue;
      return resolved;
    } catch {
      /* try the next descriptor filesystem */
    }
  }
  return null;
}

function memoryProjectSelection(memDir, realProjectsRoot) {
  const files = [];
  const dirs = [];
  const readCompleteness = {
    facts: true,
    mainIndex: true,
    archiveIndex: true,
  };
  let realMemDir;
  try {
    realMemDir = realpathSync(memDir);
  } catch {
    realMemDir = null;
  }
  if (
    !realProjectsRoot ||
    !realMemDir ||
    !pathInsideReal(realProjectsRoot, realMemDir)
  ) {
    return {
      files,
      dirs,
      readCompleteness: {
        facts: false,
        mainIndex: false,
        archiveIndex: false,
      },
    };
  }
  // Enumerate and retain only the proven canonical directory. The lexical
  // project path may itself be a symlink that is retargeted after this check.
  dirs.push(realMemDir);
  const root = readDirentsSortedBoundedSync(realMemDir);
  if (root.missing) {
    return {
      files,
      dirs,
      readCompleteness: {
        facts: false,
        mainIndex: false,
        archiveIndex: false,
      },
    };
  }
  if (root.truncated) {
    readCompleteness.facts = false;
    readCompleteness.mainIndex = false;
    readCompleteness.archiveIndex = false;
  }

  for (const entry of root.entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile()) {
      const component =
        entry.name.toLowerCase() === 'memory.md' ? 'mainIndex' : 'facts';
      readCompleteness[component] = false;
      continue;
    }
    files.push({
      name: entry.name,
      path: join(realMemDir, entry.name),
      realParent: realMemDir,
      component:
        entry.name.toLowerCase() === 'memory.md' ? 'mainIndex' : 'facts',
    });
  }

  const archiveEntry = root.entries.find((entry) => entry.name === 'archive');
  if (!archiveEntry) return { files, dirs, readCompleteness };
  if (!archiveEntry.isDirectory()) {
    readCompleteness.facts = false;
    readCompleteness.archiveIndex = false;
    return { files, dirs, readCompleteness };
  }

  const archiveDir = join(realMemDir, 'archive');
  let realArchiveDir;
  try {
    realArchiveDir = realpathSync(archiveDir);
  } catch {
    realArchiveDir = null;
  }
  if (!realArchiveDir || !pathInsideReal(realMemDir, realArchiveDir)) {
    readCompleteness.facts = false;
    readCompleteness.archiveIndex = false;
    return { files, dirs, readCompleteness };
  }
  dirs.push(realArchiveDir);
  const archive = readDirentsSortedBoundedSync(realArchiveDir);
  if (archive.missing || archive.truncated) {
    readCompleteness.facts = false;
    readCompleteness.archiveIndex = false;
  }
  for (const entry of archive.entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile()) {
      const component =
        entry.name.toLowerCase() === 'archive.md'
          ? 'archiveIndex'
          : 'facts';
      readCompleteness[component] = false;
      continue;
    }
    files.push({
      name: `archive/${entry.name}`,
      path: join(realArchiveDir, entry.name),
      realParent: realArchiveDir,
      component:
        entry.name.toLowerCase() === 'archive.md'
          ? 'archiveIndex'
          : 'facts',
    });
  }
  return { files, dirs, readCompleteness };
}

function readSelectedMemoryFileCappedSync(selected) {
  let fd;
  try {
    const beforeReal = realpathSync(selected.path);
    if (!pathInsideReal(selected.realParent, beforeReal)) {
      const error = new Error(
        'Memory file resolves outside its selected directory'
      );
      error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
      throw error;
    }
    if (
      !memoryOpenedPathMatches(
        selected.realParent,
        selected.path,
        beforeReal
      )
    ) {
      const error = new Error('Memory file changed canonical path before open');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    const before = lstatSync(selected.path);
    if (!before.isFile()) {
      const error = new Error('Selected memory path is not a regular file');
      error.code = 'ERR_DASHBOARD_MEMORY_NOT_REGULAR';
      throw error;
    }

    // Open the selected directory entry exactly once. O_NOFOLLOW closes the
    // final-component swap-to-symlink window. O_NONBLOCK prevents a concurrent
    // regular-file-to-FIFO swap from hanging before fstat where POSIX exposes
    // those flags. Windows lacks both, so local mode uses the portable identity
    // checks around the same opened handle instead of disabling memory reads.
    fd = openSync(selected.path, memoryOpenFlags());
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      const error = new Error('Selected memory path is not a regular file');
      error.code = 'ERR_DASHBOARD_MEMORY_NOT_REGULAR';
      throw error;
    }
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      const error = new Error('Memory file changed during secure open');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }

    // Resolve the already-open descriptor, not the mutable pathname. That
    // binds containment to the file actually read even if an ancestor is
    // repeatedly swapped between in-root and escaping directories.
    const realFile = realpathOpenedMemoryFdSync(fd);
    if (realFile && !pathInsideReal(selected.realParent, realFile)) {
      const error = new Error(
        'Memory file resolves outside its selected directory'
      );
      error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
      throw error;
    }
    if (
      realFile &&
      !memoryOpenedPathMatches(
        selected.realParent,
        selected.path,
        realFile
      )
    ) {
      const error = new Error('Memory file changed canonical path during open');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    if (!realFile) {
      // Linux enterprise/scoped ingest must have descriptor-bound containment.
      // Other platforms retain local plugin support with a conservative
      // before/open/after identity check that fails closed on any observed swap.
      if (SCOPED_INGEST) {
        const error = new Error(
          'Cannot bind scoped memory containment to the opened descriptor'
        );
        error.code = 'ERR_DASHBOARD_MEMORY_FD_PATH_UNAVAILABLE';
        throw error;
      }
      const afterReal = realpathSync(selected.path);
      if (!pathInsideReal(selected.realParent, afterReal)) {
        const error = new Error(
          'Memory file resolves outside its selected directory'
        );
        error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
        throw error;
      }
      if (
        !memoryOpenedPathMatches(
          selected.realParent,
          selected.path,
          afterReal
        )
      ) {
        const error = new Error('Memory file changed canonical path during open');
        error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
        throw error;
      }
      const linked = statSync(afterReal);
      if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
        const error = new Error('Memory file changed during secure open');
        error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
        throw error;
      }
    }

    const read = readUtf8FdCappedSync(fd, MEMORY_FILE_MAX_BYTES);
    const after = fstatSync(fd);
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      const error = new Error('Memory file changed while it was being read');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    return read;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Walk every <PROJECTS>/<slug>/memory/ dir and build the per-project store,
// including the fixed-depth archive tier. Read fresh per assemble; the same
// selection feeds sourceSignature() and ingest().contentHash.
export function readMemoryStores() {
  const projects = [];
  let realProjectsRoot;
  try {
    realProjectsRoot = realpathSync(PROJECTS);
  } catch {
    return [];
  }
  let projectDirs;
  try {
    projectDirs = readdirSync(PROJECTS, { withFileTypes: true });
  } catch {
    return [];
  }
  let checked = 0;
  // Sort before the cap so this walk and sourceSignature()'s memory block (which
  // also sorts) sample the SAME ordered prefix of project dirs at the
  // INGEST_PROJECT_MAX_DIRS boundary — otherwise the signature could cover a
  // different project subset than the data it gates.
  for (const ent of [...projectDirs]
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (checked >= INGEST_PROJECT_MAX_DIRS) break;
    checked += 1;
    const slug = ent.name;
    const memDir = join(PROJECTS, slug, 'memory');
    const selection = memoryProjectSelection(memDir, realProjectsRoot);
    if (selection.dirs.length === 0) continue;
    const files = [];
    for (const selected of selection.files) {
      const { name, path: full, component } = selected;
      // `memory/` may be an in-root symlink, so compare canonical paths. A
      // lexical `memDir` prefix check would drop every file selected from the
      // allowed canonical target and make ingest disagree with `/api/memories`.
      if (!pathInsideReal(selected.realParent, full)) continue;
      try {
        files.push({
          name,
          content: readSelectedMemoryFileCappedSync(selected).text,
        });
      } catch {
        selection.readCompleteness[component] = false;
      }
    }
    if (files.length > 0) {
      projects.push({
        slug,
        files,
        readCompleteness: selection.readCompleteness,
      });
    }
  }
  try {
    return buildMemoryStores({ projects });
  } catch {
    return [];
  }
}

// Build the repo doc graph (#2257, epic #2256) over this dashboard's OWN
// Markdown docs (root *.md + docs/**), the seam the doc-hygiene detector
// reads off `RecommendationInput.docGraph`. Mirrors readMemoryStores: a
// non-signal aggregate, built fresh per assemble from a LOCAL repo walk (no
// network, no Anthropic egress), tolerant by design — buildDocGraph itself never
// throws (unreadable files are skipped, a missing root yields an empty graph),
// and this wrapper degrades any surprise to an empty graph so it never sinks the
// dataset endpoint. Root is PROJECT_DIR (the dashboard repo), not ~/.claude.
let warnedIncompleteBundledDocGraph = false;
function readDocGraph() {
  try {
    const graph = buildDocGraph(DOC_GRAPH_ROOT);
    if (
      !process.env.CHD_DOC_GRAPH_ROOT &&
      !warnedIncompleteBundledDocGraph &&
      (!graph.nodes.some((node) => node.path === 'REFERENCES.md') ||
        !graph.nodes.some((node) => node.path.startsWith('docs/')))
    ) {
      warnedIncompleteBundledDocGraph = true;
      console.warn(
        `[ingest] bundled doc graph is incomplete under ${DOC_GRAPH_ROOT}; ` +
          'expected REFERENCES.md and docs/** runtime inputs'
      );
    }
    return graph;
  } catch {
    return { root: DOC_GRAPH_ROOT, nodes: [], edges: [] };
  }
}

// The graph reader and both cache gates share this exact bounded source list.
// Include ctime/inode as well as mtime/size: a caller can restore mtime and byte
// length after an in-place rewrite, but cannot restore ctime, while an atomic
// replacement changes inode identity. The hot signature path adds one bounded
// Git-history probe but still avoids reading doc bodies; graph assembly remains
// the only path that reads them.
function docGraphSourceSignature() {
  const hash = createHash('sha1');
  hash.update(`git:${docGraphGitHistorySignature(DOC_GRAPH_ROOT)}\n`);
  let count = 0;
  for (const relPath of docGraphSourcePaths(DOC_GRAPH_ROOT)) {
    hash.update(relPath);
    hash.update('\0');
    try {
      const s = statSync(join(DOC_GRAPH_ROOT, relPath));
      hash.update(String(s.mtimeMs));
      hash.update('\0');
      hash.update(String(s.size));
      hash.update('\0');
      hash.update(String(s.ctimeMs));
      hash.update('\0');
      hash.update(String(s.ino));
    } catch {
      hash.update('0\0' + '0\0' + '0\0' + '0');
    }
    hash.update('\n');
    count += 1;
  }
  hash.update(`count:${count}`);
  return `${count}:${hash.digest('hex')}`;
}

function hashDocGraphContent(hash) {
  hash.update(`git:${docGraphGitHistorySignature(DOC_GRAPH_ROOT)}\n`);
  let count = 0;
  for (const relPath of docGraphSourcePaths(DOC_GRAPH_ROOT)) {
    const path = join(DOC_GRAPH_ROOT, relPath);
    hash.update(relPath);
    hash.update('\0');
    try {
      const s = statSync(path);
      // Filesystem mtime is part of graph output when git is absent/untracked.
      hash.update(String(s.mtimeMs));
      hash.update('\0');
      hash.update(String(s.size));
      hash.update('\0');
      hash.update(readTextFileCappedSync(path, DOC_GRAPH_MAX_FILE_BYTES));
    } catch (error) {
      hash.update('unreadable\0');
      hash.update(String(error?.code || 'error'));
    }
    hash.update('\n');
    count += 1;
  }
  hash.update(`count:${count}\n`);
}

// Host-produced checker output (#2486, epic #2256). A direct host ingest uses
// the repo-map producer's collision-safe absolute-root encoder. Canonical
// deploys instead pass a safe repo-identity key + expected host commit: `/app`
// cannot reconstruct the host checkout's absolute path (and the runtime image
// intentionally carries no .git), so that explicit locator bridges namespaces
// without weakening identity/freshness validation. Missing/malformed/stale
// artifacts are null and never sink the recommendations endpoint.
export function readDocHygieneArtifact(
  root = PROJECT_DIR,
  artifactDir = DOC_HYGIENE_DIR,
  options = {}
) {
  try {
    const configuredKey =
      options.artifactKey ?? process.env[DOC_HYGIENE_ARTIFACT_KEY_ENV];
    const artifactKey =
      typeof configuredKey === 'string' && configuredKey.length > 0
        ? configuredKey
        : null;
    const keyedFilename = artifactKey
      ? docHygieneArtifactFilename(artifactKey)
      : null;
    if (artifactKey && !keyedFilename) return null;

    const path = keyedFilename
      ? join(artifactDir, keyedFilename)
      : artifactPathFor(artifactDir, root);
    const raw = readArtifactJsonCappedSync(path);

    let expectedCommit =
      options.expectedCommit ??
      process.env[DOC_HYGIENE_EXPECTED_COMMIT_ENV] ??
      null;
    if (!expectedCommit && !artifactKey) {
      try {
        expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        }).trim();
      } catch {
        return null;
      }
    }
    if (!expectedCommit) return null;

    if (artifactKey) {
      // The locator/expected commit come from the host deploy wrapper, while
      // GIT_SHA is baked into the running image. A published image can differ
      // from the local checkout that produced the artifact; never merge that
      // artifact with `/app`'s graph from another commit.
      const runtimeCommit = options.runtimeCommit ?? process.env.GIT_SHA ?? null;
      const validCommit = (value) =>
        typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);
      if (
        !validCommit(expectedCommit) ||
        !validCommit(runtimeCommit) ||
        !(
          expectedCommit.toLowerCase().startsWith(runtimeCommit.toLowerCase()) ||
          runtimeCommit.toLowerCase().startsWith(expectedCommit.toLowerCase())
        )
      ) {
        return null;
      }
    }
    // A keyed path deliberately relaxes absolute-root equality across the
    // host/container namespace. Matching host, artifact, and runtime commits
    // are mandatory on that path, so identity and freshness are never relaxed.
    return parseDocHygieneArtifact(raw, {
      ...(artifactKey
        ? { expectedIdentity: artifactKey }
        : { expectedRoot: root }),
      expectedCommit,
    });
  } catch {
    return null;
  }
}

// Git delivery-outcome signal (#1757, epic #1911). OPT-IN: the live `gh` fetch
// only runs when CHD_GIT_OUTCOMES names a `owner/repo` (or a comma list), so the
// default server path makes ZERO `gh` calls and ships an empty `gitOutcomes`
// (the downstream detector, deferred to a Future child, then emits nothing).
// Opt-in because this is the one signal that shells out at ingest time — we keep
// it off by default rather than firing `gh` on every assemble. Tolerant by
// design: a missing `gh`, a network failure, or a malformed payload degrades to
// `[]` and never sinks the dataset endpoint. The CLASSIFICATION is pure
// (parse-git-outcome.ts, unit-tested without network); only the PR FETCH lives
// here, server-side, and never reaches the Anthropic API.
// UNSET / empty ⇒ [] ⇒ readGitOutcomes short-circuits with ZERO `gh` calls, so
// the default dataset is byte-identical (#2510). Parsing centralized in the pure
// module so the flag-off gate is unit-testable (gitOutcomesReposFromEnv).
const GIT_OUTCOMES_REPOS = gitOutcomesReposFromEnv(process.env.CHD_GIT_OUTCOMES);

function fetchPullRequestsForRepo(repo) {
  // One bounded `gh` call per repo: recent PRs with the fields the pure
  // classifier reads. `--limit` caps the join cost; failures throw and are
  // swallowed by the caller.
  const raw = execFileSync(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '200',
      '--json',
      'number,headRefName,title,body,state',
    ],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) return [];
  // `gh` exposes merge state via `state: 'MERGED'` / `OPEN` / `CLOSED`; the
  // revert/fix-up signals are not on the list payload, so they stay undefined
  // here. A later slice may enrich them by scanning merge-commit trailers —
  // until then a merged PR with no later revert/fix reads as `merged-clean`,
  // the honest default. OPEN PRs enter this pool (`--state all`) but the pure
  // classifier skips them (#2510), so an in-flight PR is never labeled.
  return list.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: String(pr.state || '').toUpperCase() === 'MERGED',
  }));
}

function readGitOutcomes(sessions) {
  if (GIT_OUTCOMES_REPOS.length === 0) return [];
  const pullRequests = [];
  for (const repo of GIT_OUTCOMES_REPOS) {
    try {
      pullRequests.push(...fetchPullRequestsForRepo(repo));
    } catch {
      /* `gh` missing / network / parse failure ⇒ skip this repo's PRs */
    }
  }
  if (pullRequests.length === 0) return [];
  // Stamp every row with the ISO `YYYY-MM-DD` fetch date so a snapshot classified
  // now is not asserted as the repo's current state months later (#2510). The
  // pure classifier reads this off `options.asOf`; stale-demotion is left to the
  // consumer (relative to WHEN it runs) via `demoteStaleGitOutcome`.
  const asOf = new Date().toISOString().slice(0, 10);
  try {
    return buildGitOutcomes(
      sessions.map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        gitBranch: s.gitBranch,
      })),
      pullRequests,
      { asOf }
    );
  } catch {
    return [];
  }
}
// #539 artifact parsers (server-only; each uses node:fs to walk a top-level
// ~/.claude path). Imported here so assembleDataset can fold them into the
// dataset like liveConfig/shadowCalls.
const { parseTasksDir } = await import(join(LIB, 'parse-tasks.ts'));
const { parseTeamsDir, analyzeTeams } = await import(join(LIB, 'parse-teams.ts'));
const { parseSessionRegistryDir } = await import(
  join(LIB, 'parse-session-registry.ts')
);
const { parseTelemetryDir, parseTelemetryLatencyDir } = await import(
  join(LIB, 'parse-telemetry.ts')
);
const { parseDebugDir } = await import(join(LIB, 'parse-debug.ts'));
const { parseStatsCache } = await import(join(LIB, 'parse-stats-cache.ts'));
const { parseFileHistoryDir } = await import(join(LIB, 'parse-file-history.ts'));
const { parsePlansDir } = await import(join(LIB, 'parse-plans.ts'));
const { ingestModelEvalResults } = await import(
  join(LIB, 'model-eval-ingest.ts')
);
const { parseLastUpdate } = await import(join(LIB, 'parse-last-update.ts'));
const { parseMcpAuthCache } = await import(join(LIB, 'parse-mcp-auth.ts'));
const { parseBackupsDir, diffConfigDrift } = await import(
  join(LIB, 'parse-backups.ts')
);
const {
  parseGitHubReviewSyncConfig,
  readGitHubReviewEventsCache,
  refreshGitHubReviewEvents,
  gitHubReviewEventsCacheSignature,
} = await import(join(LIB, 'github-review-sync.ts'));
const { parseConfigSet } = await import(join(LIB, 'parse-config-sections.ts'));
const { attributeConfigSections } = await import(
  join(LIB, 'parse-config-attribution.ts')
);
const { parseFileReread } = await import(join(LIB, 'parse-file-reread.ts'));
const { topChurnFiles } = await import(join(LIB, 'parse-files.ts'));
const { buildRepoMapDataset } = await import(join(LIB, 'parse-repo-map-join.ts'));
// Canonical artifact-path encoding (ADR 0007 producer/consumer seam): share the
// exact helper the producer (scripts/repo-map-generate.mjs) writes through, so the
// consumer can't drift from it. #719/#1004.
// Import the leaf cache module directly, NOT the repo-map barrel (index.ts):
// the barrel re-exports ./parser, which statically imports the build-only
// `web-tree-sitter` devDependency. The server runtime image ships no
// node_modules, so pulling the barrel here crash-loops boot (ERR_MODULE_NOT_FOUND).
// artifactPathFor lives in cache.ts (node builtins + a type only). #1013.
const { artifactPathFor, unwrapPersistedRepoMap } = await import(join(LIB, 'repo-map/cache.ts'));
// Live-config assembly (#627 slice 1) — extracted into src/lib/config-loader.ts.
// It owns the settings.json validator wiring (#167) and the settings/MCP/
// plugins/resources readers; ingest.mjs just calls assembleLiveConfig().
const configLoaderModule = await import(join(LIB, 'config-loader.ts'));
const {
  assembleLiveConfig,
  readTextFileCappedSync,
  readStopHookConfigState,
  hostEnvironmentObservation,
  hostEnvironmentObservationSignature,
} = configLoaderModule;
export const CONFIG_FILE_MAX_BYTES = configLoaderModule.CONFIG_FILE_MAX_BYTES;
export const CONFIG_RESOURCE_MAX_ENTRIES =
  configLoaderModule.CONFIG_RESOURCE_MAX_ENTRIES;
// Capture once: server-side scoped imports temporarily mutate process.env, and
// the content hash must use the exact same launch snapshot as assembly.
const LIVE_CONFIG_ENVIRONMENT_OBSERVATION = SCOPED_INGEST
  ? undefined
  : hostEnvironmentObservation(process.env);

/** Cheap current-state gate for the recommendations response cache (#2554). */
export function stopHookConfigState() {
  return readStopHookConfigState({
    claudeDir: CLAUDE,
    homeDir: CLAUDE_HOME,
    scoped: SCOPED_INGEST,
    projectRoots: liveConfigProjectRoots(repoMapArtifactRoots()),
    environment: LIVE_CONFIG_ENVIRONMENT_OBSERVATION,
  });
}

const GITHUB_REVIEW_SYNC_CONFIG = parseGitHubReviewSyncConfig(process.env, {
  cachePath: REVIEW_EVENTS_CACHE,
});
let reviewEventsRefreshPromise = null;
// Session-transcript BLOB cache (#627 slice 3) — the session_transcript schema
// + its four prepared statements, extracted into src/lib/session-cache.ts.
// initTranscriptCache(db) prepares them against THIS module's shared db handle
// (DI on the existing connection) and owns the CREATE TABLE. SQL + logic are
// byte-identical; the dataset read path (session_blob) is untouched.
// #627 slice 4 adds the session_blob per-session signal cache to the same
// module (persistence kept together): initSessionBlobCache(db, SESSION_SIGNALS)
// owns the generated session_blob schema + additive migration loop and prepares
// its six statements (selSig/allIds/del/allContentHashes/upsert/selAll) against
// THIS module's shared db handle. ingestOne/assembleDataset/the prune loop call
// blobCache.* instead of inline statements. SQL + arg order are byte-identical.
const { initTranscriptCache, initSessionBlobCache } = await import(
  join(LIB, 'session-cache.ts')
);
// Transcript secret-scrubber (#204) — distinct from config-hygiene.ts; redacts
// credential-shaped substrings out of assistant prose before it is persisted.
const { scrubValue } = await import(join(LIB, 'transcript-hygiene.ts'));
const { stripToolCommandBodies } = await import(join(LIB, 'parse-tools.ts'));
// Session-signal descriptor (#524, slice 1) + pure row parser (#855 prototype).
// `session-blob-row.mjs` owns the read/parse/stringify/content_hash row builder
// without opening SQLite, so the worker prototype can reuse the exact parser
// sequence while production ingest remains a single SQLite writer below.
const {
  SESSION_SIGNALS,
  parseSessionBlobRowFromDisk: parseSessionBlobRowFromDiskPure,
  sessionFileSignature: sessionFileSignaturePure,
} = await import('./session-blob-row.mjs');
export { SESSION_SIGNALS };
// Session-blob schema generation (#524, slice 2). The session_blob CREATE
// TABLE, additive ALTER migration list, and INSERT/upsert SQL (+ canonical
// upsert column order) now live behind initSessionBlobCache() in
// src/lib/session-cache.ts (#627 slice 4); ingest.mjs only still needs the
// project-index DDL here (the index create stays in this module).
const { buildCreateIndexSql } = await import(join(LIB, 'signals/schema.ts'));

function tightenDbPath(path) {
  if (!path || path === ':memory:') return;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DB_DIR_MODE });
  try {
    chmodSync(dir, DB_DIR_MODE);
  } catch {
    /* best-effort on filesystems that do not support chmod */
  }
}

function tightenDbFile(path) {
  if (!path || path === ':memory:') return;
  try {
    chmodSync(path, DB_FILE_MODE);
  } catch {
    /* best-effort on filesystems that do not support chmod */
  }
}

tightenDbPath(DB_PATH);
const db = new DatabaseSync(DB_PATH);
tightenDbFile(DB_PATH);
// #627 slice 3: the session_transcript BLOB cache, bound to the shared `db`
// handle above. initTranscriptCache runs its CREATE TABLE IF NOT EXISTS and
// prepares the four statements (gate/upsert/delete/read); persistTranscript()
// and the prune loop call transcriptCache.* instead of inline statements.
const transcriptCache = initTranscriptCache(db);
// One signal descriptor, bound to this file's parsers, is the single source for
// BOTH the schema/upsert generation just below AND the parse / content_hash /
// read-back loops in ingestOne()/assembleDataset(). Defined here (before the
// schema setup) so the DDL derives from the very same array — no schema-only
// copy that could drift on column order. SESSION_SIGNALS is imported from the
// pure row builder and remains the schema/upsert/read-back source of truth.
// The project index DDL stays in this module; the session_blob CREATE TABLE,
// additive migration loop, and the six session_blob prepared statements now
// live behind initSessionBlobCache() in src/lib/session-cache.ts (#627 slice
// 4). It is dependency-injected on this module's shared `db` handle and the
// SESSION_SIGNALS descriptor above (which drives both its generated DDL and its
// upsert column order), so the schema/SQL/arg order are byte-identical to the
// previous inline code. ingestOne/assembleDataset/the prune loop call
// blobCache.* below.
const blobCache = initSessionBlobCache(db, SESSION_SIGNALS);
db.exec(buildCreateIndexSql());
// The canonical column order the upsert args MUST follow — re-exposed from the
// cache so ingestOne builds its byColumn args in the SAME (content_hash-
// affecting) order the upsert SQL was generated from.
const UPSERT_COLUMNS = blobCache.upsertColumns;
// Thin re-export of the session-transcript read (#627 slice 3). The schema +
// statements + read-back mapping now live in src/lib/session-cache.ts; this
// wrapper preserves the server import surface (server.mjs imports getTranscript
// from './ingest.mjs'). Returns the already-compressed brotli BLOBs + the
// content_hash ETag. Missing/stale BLOBs are generated lazily from the source
// transcript so /api/dataset.json does not precompress every transcript during
// cold ingest.
export function getTranscript(sessionId) {
  const s = findSession(sessionId);
  if (!s) return null;
  const currentSig = sigOf([s.topPath, ...s.subPaths]);
  const row = blobCache.readSig(sessionId);
  const cached = transcriptCache.getTranscript(sessionId);
  if (cached && row?.sig === currentSig) return cached;

  const merged = readMergedSessionSync(s);
  persistTranscript(sessionId, merged);
  return transcriptCache.getTranscript(sessionId);
}

// Lazy per-session timeline detail (#1035/#1284). The bulk dataset ships slim
// timelines (`summary` stripped — see assembleDataset); the full
// parse already sits in the session_blob row this ingest pipeline maintains,
// so the detail read is a single O(1) SELECT + no re-parse. Returns the raw
// stored JSON string (the server sends it verbatim) plus the row's
// content_hash for the ETag. Freshness matches the bulk dataset's: both are
// refreshed by the same ingest() pass, so the client never sees detail older
// than the dataset it navigated from.
export function getSessionTimelineDetail(sessionId) {
  const row = blobCache.readRow(sessionId);
  if (!row || !row.timeline_json) return null;
  const timeline = row.timeline_json;
  if (timeline === 'null' || timeline === '') return null;
  return { json: timeline, contentHash: row.content_hash };
}

export function getSessionToolDetail(sessionId) {
  const row = blobCache.readRow(sessionId);
  if (!row || !row.tool_json) return null;
  const tools = row.tool_json;
  if (tools === 'null' || tools === '') return null;
  return { json: tools, contentHash: row.content_hash };
}

// Persistent compressed-dataset cache. The server's in-memory `datasetCache`
// (the serialize + brotli/gzip result) does not survive a container restart, so
// the first /api/dataset.json after every deploy paid the full ~300–500 ms
// serialize+compress stall. We stash the already-compressed buffers here keyed
// by the same `contentHash` ingest() returns, so a cold start whose source
// state is unchanged reloads them straight from the SQLite volume the ingest
// cache already lives in — no assembleDataset(), no brotli. A changed source
// produces a new contentHash with no matching row, so the cache misses cleanly
// and the server rebuilds (and re-persists). See issue #183.
db.exec(`
  CREATE TABLE IF NOT EXISTS dataset_cache (
    content_hash TEXT PRIMARY KEY,
    etag         TEXT NOT NULL,
    json_br      BLOB NOT NULL,
    json_gz      BLOB NOT NULL,
    created_at   INTEGER NOT NULL
  );
`);

// #1577: fence the cold-start latest-load by the dataset-assembly schema key.
// content_hash already folds the schema in, but loadLatestDatasetCache() returns
// the NEWEST row by created_at and can't filter by "current schema" without a
// stored column — so after a schema-bumping deploy over a PERSISTED cache volume
// the newest row (built by the old code) was served until the background rebuild
// landed. Rows predating this column read NULL schema_key and never match the
// current key, so they're skipped (clean rebuild), not served stale. Idempotent:
// the ALTER throws "duplicate column" once the column exists, which we ignore.
try {
  db.exec('ALTER TABLE dataset_cache ADD COLUMN schema_key TEXT');
} catch {
  /* column already present (added on a prior boot) */
}

// Keep the last few rows for rollback/debugging rather than just the live one —
// a recently-superseded build can be inspected after a regression. Cheap: each
// row is the compressed dataset (~2–3 MB), so a handful costs single-digit MB.
const DATASET_CACHE_KEEP = 3;

// Bump when a per-session PARSER's OUTPUT shape changes without the source
// transcript changing — the session_blob cache gate is keyed purely on file
// mtime+size, so an unchanged transcript would otherwise serve a stale blob
// that lacks the new field. Folding this version into every session `sig`
// forces a one-time reparse of all sessions on the next ingest.
//   v2 (#1927): added per-entry `thinkingTokens` + session `totalThinkingTokens`.
//   v3 (#2006): recalibrated thinking residual (per-block-type token density).
//   v4 (#2036): precompute target-aware rm -rf certainty + dangerous fragment on
//       ToolCall, so body-stripped commands keep correct dangerous-command signal.
// Exported so the dataset-cache-schema regression test can assert the dataset key
// folds this in (the two cache gates must turn over together).
//
// SEAM NOTE (#2075): this gates the per-session TRANSCRIPT cache (sigOf) and is
// folded into the dataset schema key — a DIFFERENT artifact from the
// session_blob row cache, which is gated by SESSION_BLOB_OUTPUT.version in the
// parser-output seam (scripts/lib/parser-output-versions.mjs). The seam lists
// this knob under RELATED_INVALIDATION_KNOBS so the two are discoverable
// together but NOT collapsed — they invalidate distinct caches.
export const PARSER_SIG_VERSION = 'v4';

// Bump when assembleDataset() or an upstream parser changes the serialized
// dataset's shape or meaning without necessarily changing any ~/.claude source
// artifact. The compressed dataset cache is persisted across deploys, so
// source-content hashes alone can otherwise reuse JSON assembled by older code.
// v4 (#2129): PromptAnalysis now serializes filePathTurnCount. The field landed
// while the key was already at v3 (bumped by #2047 for an unrelated signal), so
// a persisted v3 blob assembled before the field exists would be reused for
// unchanged source data and the "Prompt turns by trait" chart would render the
// file/path row as 0. A dedicated bump invalidates those stale v3 blobs.
// v5 (#2136): assembleDataset now enumerates push-shipped sources from
// .sources/<id>/ ledgers and re-attributes each shipped session to the
// pod/member that shipped it. The .sources/ provenance pre-exists (no source
// artifact changes), so without this bump the deployed instance's persisted
// dataset cache would keep serving the old single-source attribution.
// v6 (#2106): slimSessionTimeline now prunes the summary-derived per-entry
// signals (summaryLen/hasCode/isQuestion) to user entries only — and the two
// booleans to sparse-true — shrinking the bulk `timelines` payload (~14 MB on
// the ~1 GB corpus). The source transcripts are unchanged, so without this bump
// a persisted v5 dataset blob would keep shipping the fat per-entry signals.
// v7 (#2107): the /api/dataset.json WIRE bytes now slim per-session tokenData
// entries — zero-valued numeric members (web-search/web-fetch requests, the
// 1h-cache split, thinkingTokens, etc.) are dropped via dataset-body.ts and
// restored to 0 client-side (dataset-slim.ts). The slim is a serialized-shape
// change with no source-artifact change, so a persisted v6 compressed blob would
// keep serving the un-slimmed body; this bump invalidates it. (The in-memory
// dataset and toolData are unchanged; the client rehydrates the dropped zeros.)
// v8 (#2149): parseShadowCalls now returns explicit counting buckets on the
// shadowCalls aggregate — `counted`/`synthetic`/`skipped`/`live`/`replay` — and
// redefines `total` to the full ledger line count (was the real-row count). The
// aggregate is baked into the assembled dataset here (assembleDataset →
// shadowCalls, below), so this is a pure serialized-shape change with NO
// ~/.claude source-artifact change: an unchanged shadow-calls ledger keeps the
// same content hash, so without this bump a persisted v7 dataset blob would keep
// serving the OLD single-`total` shape and the new "Experiments (real)" headline
// would never ship. This knob (not PARSER_SIG_VERSION / SESSION_BLOB_OUTPUT) is
// correct: the shadow ledger is a top-level artifact parsed once into the
// dataset, NOT a per-session transcript/blob signal.
// v9 (#2150): parseShadowCalls adds the uniform (source, axis) provenance cells
// (`bySourceAxis`) to the shadowCalls aggregate. Same reasoning as v8: a pure
// serialized-shape change with NO ~/.claude source-artifact change, so without
// this bump a persisted v8 dataset blob would keep serving an aggregate with no
// source dimension and the by-source rollup would never ship.
// v10 (#2151): unstamped race records reclassify live→race-live, benchmark-tier
// sources stop incrementing liveShadowWins, and artifact-derived cells (proof
// receipts, model-eval batches) merge into bySourceAxis with the new `external`
// counter. An unchanged ledger keeps its content hash, so without this bump a
// persisted v9 blob would keep serving the old attribution + trust weighting.
// v11 (#2246): parseSessionTimeline changes the meaning of `backgrounded` for
// Agent/Task/Workflow calls. SESSION_BLOB_OUTPUT v9 reparses timeline_json, but a
// restart can load and serve a persisted dataset assembled from v8 rows before
// that reparse finishes. Turn over this downstream cache so the old v10 body is
// never accepted as current.
// v12 (#2500): assembleLiveConfig began annotating each hook command with its
// ingest-time `referencedPaths` existence observation and each skill with `danglingRefs`,
// feeding maintenance.skill-hook-integrity. These are a pure serialized-shape
// change with NO ~/.claude source-artifact change — an unchanged settings.json /
// SKILL.md keeps its content hash, so without this bump a persisted v11 blob
// would keep serving liveConfig with no reference-integrity fields and the new
// detector would never fire on deployed data.
// v13 (#2504): assembleDataset now ships a `secretsAtRest` signal array (per-kind
// counts of secret-shaped values in plaintext transcripts + EvidenceRef coords;
// the matched value is never stored). Paired with the SESSION_BLOB_OUTPUT
// 'secrets-at-rest-v10' bump that forces the session_blob reparse — turn over
// this downstream cache so a persisted v12 body (without secretsAtRest) is never
// accepted as current and the detector stays inert on deployed data.
// v14 (#2541): parseWorkflows now preserves bounded workflow-agent `error`
// text in normalized `agents[]`, feeding the workflow rate-limit detector.
// Workflow manifests can be unchanged while a persisted v13 assembled body
// still omits that field, so turn over the downstream dataset cache.
// v15 (#2421): liveConfig.settingsHealth now serializes the names-only host
// environment observation plus findings from both global and local settings,
// each with per-file provenance. Persisted v14 blobs lack those fields and
// must not be served during stale-while-revalidate startup.
// v16 (#2560): parseToolUsage adds sparse `commandHeadIsPermissionPrefix` truth
// to toolData before raw Bash commands are stripped. SESSION_BLOB_OUTPUT v11
// reparses tool_json, while this paired turnover rejects persisted v15 dataset
// bodies assembled from v10 rows that would keep permission adoption unmappable.
// v17 (#2560): parseToolUsage adds bounded `commandBypassAliases` evidence per
// category before raw Bash commands are stripped. SESSION_BLOB_OUTPUT v12
// reparses tool_json, while this paired turnover rejects persisted v16 dataset
// bodies whose wrapped/chained bypasses lost the real executable alias.
// v18 (#2643): shadowCalls now carries bounded per-(axis, variation) ledger
// receipts with freshness/proof coverage. The ledger content can be unchanged
// while a persisted v17 dataset lacks `byVariation` and `variationSkipped`, so
// turn over the assembled-dataset cache without changing transcript or ledger
// schema versions.
// v19 (#2663): toolData now carries parser-owned dangerous permission-prefix
// matches derived before raw Bash bodies are stripped. Reject persisted v18
// bodies whose previews could otherwise be mistaken for executable-prefix truth.
// v20 (#2553): assembleLiveConfig replaces hook referencedPaths' ambiguous
// Boolean `exists` field with timestamped present/missing/unverifiable states.
// Unchanged settings sources would otherwise preserve cached false-missing
// claims from containers that cannot follow host-side skill symlink targets.
// v21 (#2313): parseToolUsage adds sparse `leaveBehindStructure` proof from raw
// full-file Write markdown and `commandDurableKind` truth from full Bash commands
// before bulk ingest strips their bodies. SESSION_BLOB_OUTPUT v14 reparses
// tool_json; this paired turnover rejects persisted v20 bodies that could neither
// prove structural candidates nor expose a durable mutation past the preview.
// Git commitment remains deliberately unproven by transcript data.
// v22 (#2380): the serialized full/light datasets now carry docGraph so every
// client recommendation surface observes the same local doc-hygiene evidence.
export const DATASET_ASSEMBLY_SCHEMA_VERSION = 22;

// The dataset-cache gate (sourceSignature) must also turn over when upstream
// per-session parsed output changes, because that output is folded into the
// assembled dataset (e.g. dangerous-command signals → recommendations). Folding
// PARSER_SIG_VERSION into this key keeps transcript-cache changes coupled. The
// separate SESSION_BLOB_OUTPUT version gates parsed signal rows; when its output
// meaning changes without a source-file change, pair that bump with this dataset
// schema version so a restart cannot serve an old assembled body while reparsing.
export function datasetAssemblySchemaKey() {
  return `dataset-schema:v${DATASET_ASSEMBLY_SCHEMA_VERSION}:parser-${PARSER_SIG_VERSION}`;
}

const selDatasetCache = db.prepare(
  'SELECT etag, json_br, json_gz FROM dataset_cache WHERE content_hash = ?'
);
const selLatestDatasetCache = db.prepare(
  'SELECT content_hash, etag, json_br, json_gz FROM dataset_cache WHERE schema_key = ? ORDER BY created_at DESC LIMIT 1'
);
const insDatasetCache = db.prepare(`
  INSERT INTO dataset_cache (content_hash, etag, json_br, json_gz, created_at, schema_key)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(content_hash) DO UPDATE SET
    etag=excluded.etag, json_br=excluded.json_br,
    json_gz=excluded.json_gz, created_at=excluded.created_at,
    schema_key=excluded.schema_key
`);
const pruneDatasetCache = db.prepare(`
  DELETE FROM dataset_cache WHERE content_hash NOT IN (
    SELECT content_hash FROM dataset_cache ORDER BY created_at DESC LIMIT ?
  )
`);

// Load a persisted compressed dataset by its content fingerprint. Returns the
// same shape the server's in-memory cache uses ({ etag, json, brBuf, gzBuf,
// contentHash }), reconstructing the raw JSON string by gunzipping the stored
// gzip blob (the rare no-encoding client path needs it; br/gz clients are
// served the stored buffers directly). Returns null on miss or a corrupt blob
// so the caller falls back to a fresh rebuild. Best-effort: never throws.
export function loadDatasetCache(contentHash) {
  let row;
  try {
    row = selDatasetCache.get(contentHash);
  } catch {
    return null;
  }
  if (!row) return null;
  const brBuf = Buffer.from(row.json_br);
  const gzBuf = Buffer.from(row.json_gz);
  let json;
  try {
    json = gunzipSync(gzBuf, {
      maxOutputLength: DATASET_RESPONSE_MAX_BYTES,
    }).toString('utf8');
  } catch {
    return null; // corrupt/partial blob — rebuild instead of serving garbage
  }
  return { etag: row.etag, json, brBuf, gzBuf, contentHash };
}

export function loadLatestDatasetCache() {
  let row;
  try {
    row = selLatestDatasetCache.get(datasetAssemblySchemaKey());
  } catch {
    return null;
  }
  if (!row) return null;
  const brBuf = Buffer.from(row.json_br);
  const gzBuf = Buffer.from(row.json_gz);
  let json;
  try {
    json = gunzipSync(gzBuf, {
      maxOutputLength: DATASET_RESPONSE_MAX_BYTES,
    }).toString('utf8');
  } catch {
    return null;
  }
  return { etag: row.etag, json, brBuf, gzBuf, contentHash: row.content_hash };
}

// Persist a freshly built compressed dataset so the next cold start can reuse
// it. Best-effort: a write failure logs and returns — the in-memory cache still
// serves this process, so a read-only/full volume degrades to today's behaviour
// rather than failing the request. `createdAt` is injected by the caller (the
// server) to keep this module free of wall-clock reads.
export function saveDatasetCache(
  { contentHash, etag, brBuf, gzBuf },
  createdAt
) {
  try {
    insDatasetCache.run(contentHash, etag, brBuf, gzBuf, createdAt, datasetAssemblySchemaKey());
    pruneDatasetCache.run(DATASET_CACHE_KEEP);
  } catch (err) {
    console.error('dataset_cache persist failed:', err?.message ?? err);
  }
}

// PARSER_SIG_VERSION is defined above (next to DATASET_ASSEMBLY_SCHEMA_VERSION)
// so the dataset-cache key can fold it in — the two must turn over together.
function sigOf(paths) {
  return paths
    .map((p) => {
      try {
        const s = statSync(p);
        return `${p}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${p}:0:0`;
      }
    })
    .join('|')
    .concat(`#${PARSER_SIG_VERSION}`);
}

// ── Artifact-ingest cache (#624) ────────────────────────────────────────────
// The #539 top-level artifact parsers (tasks/teams/telemetry/debug/file-history/
// plans/backups + the two usage-data insights dirs) re-walked and re-parsed
// their whole tree on EVERY assembleDataset() call — session transcripts got a
// content_hash/SQLite seam but these did not, so cost scaled with artifact-tree
// size per request. This table mirrors the session-blob/dataset caches: each
// artifact is keyed by (artifact_key, signature) where the signature is a cheap
// stat-only fingerprint (mtime + size + entry count, recursively) that changes
// on any add/remove/modify. We parse a dir ONLY when its signature changed and
// persist the parsed JSON; on a HIT we JSON.parse the stored blob.
//
// PARITY: the cache is a transparent optimization, never a data change. The
// dataset is serialized downstream via a single JSON.stringify (server.mjs), and
// JSON.stringify(JSON.parse(JSON.stringify(x))) === JSON.stringify(x) for any x,
// so a HIT's reconstructed object serializes byte-identically to a fresh parse.
// Two boundary rules keep this airtight:
//   1. We cache the PURE, file-derived parse only. Any time-dependent or
//      otherwise non-deterministic post-transform (e.g. analyzeTeams(.., now))
//      runs OUTSIDE the cache, fresh on every call, exactly as before.
//   2. A parser whose output isn't plain JSON (parseTeamsDir returns a Map) gets
//      a per-artifact encode/decode hook so the round-trip is lossless.
db.exec(`
  CREATE TABLE IF NOT EXISTS artifact_cache (
    artifact_key TEXT NOT NULL,
    signature    TEXT NOT NULL,
    json         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (artifact_key, signature)
  );
`);

const selArtifactCache = db.prepare(
  'SELECT json FROM artifact_cache WHERE artifact_key = ? AND signature = ?'
);
const insArtifactCache = db.prepare(`
  INSERT INTO artifact_cache (artifact_key, signature, json, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(artifact_key, signature) DO UPDATE SET
    json=excluded.json, created_at=excluded.created_at
`);
// Drop superseded signatures for an artifact (keep only its current key's row)
// so the table doesn't accumulate one row per historical tree state.
const pruneArtifactCache = db.prepare(
  'DELETE FROM artifact_cache WHERE artifact_key = ? AND signature <> ?'
);

function markSignatureTreeTruncated(hash, state, rel) {
  if (!state.truncated) {
    hash.update('\0truncated\0');
    hash.update(String(state.maxEntries));
    hash.update('\0');
    hash.update(rel || '.');
    hash.update('\n');
  }
  state.truncated = true;
}

function reserveSignatureTreeEntry(hash, state, rel) {
  if (state.entries >= state.maxEntries) {
    markSignatureTreeTruncated(hash, state, rel);
    return false;
  }
  state.entries += 1;
  return true;
}

function walkSignatureTree(root, rel, hash, onFile) {
  const state = { entries: 0, maxEntries: SIGNATURE_TREE_MAX_ENTRIES, truncated: false };
  function walk(abs, baseRel) {
    let dir;
    try {
      dir = opendirSync(abs);
    } catch {
      return;
    }
    try {
      for (;;) {
        const ent = dir.readSync();
        if (!ent) break;
        const childAbs = join(abs, ent.name);
        const r = baseRel ? `${baseRel}/${ent.name}` : ent.name;
        if (!reserveSignatureTreeEntry(hash, state, r)) break;
        if (ent.isDirectory()) {
          walk(childAbs, r);
          if (state.truncated) break;
          continue;
        }
        if (!ent.isFile()) continue;
        onFile(childAbs, r);
      }
    } finally {
      dir.closeSync();
    }
  }
  walk(root, rel);
  return state;
}

// Cheap stat-only signature for an artifact source. Recurses dirs with a bounded
// streaming walker; folds each FILE's relpath + mtimeMs + size into a hash, and
// counts files — so a file add, remove, or modify (mtime/size bump) all change
// the digest inside the configured bound. No file bytes are read. A
// missing/unstatable path yields a stable "absent" digest so the cold/absent case
// is consistent across calls. Mirrors hashTree's traversal but returns a
// self-contained per-artifact digest rather than folding into a shared
// content_hash.
function artifactSignature(path) {
  const hash = createHash('sha1');
  let count = 0;
  let st;
  try {
    st = statSync(path);
  } catch {
    return 'absent';
  }
  if (st.isDirectory()) {
    walkSignatureTree(path, '', hash, (childAbs, r) => {
      try {
        const s = statSync(childAbs);
        hash.update(r);
        hash.update('\0');
        hash.update(String(s.mtimeMs));
        hash.update('\0');
        hash.update(String(s.size));
        hash.update('\n');
        count += 1;
      } catch {
        /* skip unstatable file */
      }
    });
  } else if (st.isFile()) {
    // Single-file artifact: mtime + size is the whole signature.
    hash.update(String(st.mtimeMs));
    hash.update('\0');
    hash.update(String(st.size));
    count = 1;
  } else {
    return 'absent';
  }
  hash.update('\0count\0');
  hash.update(String(count));
  return `${count}:${hash.digest('hex')}`;
}

// Test seam (#624): count how many times the cache MISSED and ran a real parse,
// so an instrumentation test can prove a second assembleDataset() over an
// unchanged corpus does zero artifact reparses. Never read in production paths.
let _artifactParseCount = 0;
export function _getArtifactParseCount() {
  return _artifactParseCount;
}
export function _resetArtifactParseCount() {
  _artifactParseCount = 0;
}

// Resolve one artifact through the cache. `key` is the table key; `path` is the
// stat'd source; `parse()` runs the PURE file-read parse on a miss; `encode`/
// `decode` (optional) bridge non-JSON parse outputs (e.g. a Map) to/from the
// stored JSON string. On a HIT, returns decode(JSON.parse(stored)) — provably
// equal-under-JSON.stringify to a fresh parse. On a miss/corrupt-row, parses,
// stores encode(parsed), and returns the fresh parse. Best-effort persistence:
// a write failure logs and still returns the correct fresh value.
function cachedArtifact(key, path, parse, encode, decode) {
  const signature = artifactSignature(path);
  let row;
  try {
    row = selArtifactCache.get(key, signature);
  } catch {
    row = null;
  }
  if (row) {
    try {
      const stored = JSON.parse(row.json);
      return decode ? decode(stored) : stored;
    } catch {
      /* corrupt row — fall through to a fresh parse + overwrite */
    }
  }
  _artifactParseCount += 1;
  const parsed = parse();
  try {
    const toStore = encode ? encode(parsed) : parsed;
    const serialized = JSON.stringify(toStore);
    if (Buffer.byteLength(serialized, 'utf8') <= ARTIFACT_CACHE_JSON_MAX_BYTES) {
      insArtifactCache.run(key, signature, serialized, Date.now());
      pruneArtifactCache.run(key, signature);
    } else {
      pruneArtifactCache.run(key, signature);
    }
  } catch (err) {
    console.error(`artifact_cache persist failed (${key}):`, err?.message ?? err);
  }
  return parsed;
}

function reviewEventsSourceSignature() {
  return SCOPED_INGEST
    ? 'scoped-disabled'
    : gitHubReviewEventsCacheSignature(GITHUB_REVIEW_SYNC_CONFIG);
}

export async function refreshReviewEvents() {
  if (SCOPED_INGEST || !GITHUB_REVIEW_SYNC_CONFIG.enabled) return null;
  if (!reviewEventsRefreshPromise) {
    reviewEventsRefreshPromise = refreshGitHubReviewEvents(GITHUB_REVIEW_SYNC_CONFIG)
      .catch(() => null)
      .finally(() => {
        reviewEventsRefreshPromise = null;
      });
  }
  return reviewEventsRefreshPromise;
}

function readReviewEventsArtifact() {
  if (SCOPED_INGEST || !GITHUB_REVIEW_SYNC_CONFIG.enabled) return null;
  return readGitHubReviewEventsCache(GITHUB_REVIEW_SYNC_CONFIG)?.dataset ?? null;
}

function listDirectSubagentTranscripts(saDir, maxSubPaths) {
  const paths = [];
  let truncated = false;
  let dir;
  try {
    dir = opendirSync(saDir);
  } catch {
    return { paths, truncated };
  }
  const maxEntries = Math.max(1, maxSubPaths + 1);
  let checked = 0;
  try {
    for (;;) {
      const ent = dir.readSync();
      if (!ent) break;
      if (checked >= maxEntries) {
        truncated = true;
        break;
      }
      checked += 1;
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      if (paths.length >= maxSubPaths) {
        truncated = true;
        break;
      }
      paths.push(join(saDir, ent.name));
    }
  } finally {
    dir.closeSync();
  }
  paths.sort();
  return { paths, truncated };
}

// Discover top-level session files and their subagent files from one
// dashboard-native projects/ root with bounded streaming directory scans.
function listSessionsFromProjectsRoot(projectsRoot, source) {
  const out = [];
  let projectsDir;
  try {
    projectsDir = opendirSync(projectsRoot);
  } catch {
    return out;
  }
  let projectEntries = 0;
  let sessionEntries = 0;
  let stop = false;
  try {
    for (;;) {
      const d = projectsDir.readSync();
      if (!d) break;
      if (projectEntries >= INGEST_PROJECT_MAX_DIRS) break;
      projectEntries += 1;
      if (!d.isDirectory()) continue;
      const proj = d.name;
      const pdir = join(projectsRoot, proj);
      let sessionDir;
      try {
        sessionDir = opendirSync(pdir);
      } catch {
        continue;
      }
      try {
        for (;;) {
          const ent = sessionDir.readSync();
          if (!ent) break;
          if (sessionEntries >= INGEST_SESSION_DISCOVERY_MAX_ENTRIES) {
            stop = true;
            break;
          }
          sessionEntries += 1;
          if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
          const sessionId = ent.name.replace(/\.jsonl$/, '');
          const topPath = join(pdir, ent.name);
          const saDir = join(pdir, sessionId, 'subagents');
          let subPaths = [];
          let partLimitExceeded = false;
          const maxSubPaths = Math.max(0, INGEST_SESSION_MAX_PARTS - 1);
          const direct = listDirectSubagentTranscripts(saDir, maxSubPaths);
          subPaths = direct.paths;
          partLimitExceeded = direct.truncated;
          // #636: recurse one more level into nested Workflow-tool agent
          // transcripts (subagents/workflows/<runId>/agent-*.jsonl) so their
          // tokens/tool-use/failures merge into the parent and reconcile with the
          // Tokens/Cost tab. Appended after the one-level files; both flow into
          // the merge AND the sig gate (sigOf([topPath, ...subPaths])).
          if (!partLimitExceeded) {
            const remainingSubPaths = Math.max(
              0,
              INGEST_SESSION_MAX_PARTS - 1 - subPaths.length
            );
            const nested = listNestedWorkflowAgentTranscripts(saDir, {
              maxEntries: remainingSubPaths + 1,
            });
            if (nested.paths.length > remainingSubPaths || nested.truncated) {
              partLimitExceeded = true;
            }
            subPaths = subPaths.concat(nested.paths.slice(0, remainingSubPaths));
          }
          out.push({
            sessionId,
            project: proj,
            sourceId: source.id,
            harness: source.harness,
            topPath,
            subPaths,
            partLimitExceeded,
          });
        }
      } finally {
        try {
          sessionDir.closeSync();
        } catch {
          /* ignore close failures */
        }
      }
      if (stop) break;
    }
  } finally {
    projectsDir.closeSync();
  }
  return out;
}

function sessionRank(s) {
  let bytes = 0;
  let latestMtimeMs = 0;
  for (const filePath of [s.topPath, ...s.subPaths]) {
    try {
      const st = statSync(filePath);
      if (!st.isFile()) continue;
      bytes += st.size;
      latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs);
    } catch {
      /* unreadable files lose the tie-break */
    }
  }
  return { bytes, latestMtimeMs };
}

function shouldReplaceSessionCandidate(candidate, existing) {
  if (candidate.rank.bytes !== existing.rank.bytes) {
    return candidate.rank.bytes > existing.rank.bytes;
  }
  return candidate.rank.latestMtimeMs > existing.rank.latestMtimeMs;
}

// Discover top-level session files and their subagent files with bounded
// streaming directory scans. Oversized corpora are handled by returning the
// bounded prefix; ingest() then prunes any cached rows outside the discovered
// set, keeping the served dataset aligned to the configured discovery budget.
//
// The server flavor can add one or more hub checkouts whose root mirrors the
// native projects/<slug>/<sessionId>.jsonl layout. Dedupe is by sessionId; when
// the same session exists in more than one source, the larger merged snapshot
// wins, with mtime as the deterministic tie-break.
export function listSessions() {
  const bySessionId = new Map();
  for (const { projectsRoot, source } of PROJECT_SOURCES) {
    for (const s of listSessionsFromProjectsRoot(projectsRoot, source)) {
      const candidate = { session: s, rank: sessionRank(s) };
      const existing = bySessionId.get(s.sessionId);
      if (!existing || shouldReplaceSessionCandidate(candidate, existing)) {
        bySessionId.set(s.sessionId, candidate);
      }
    }
  }
  return [...bySessionId.values()].map(({ session }) => session);
}

function findSession(sessionId) {
  return listSessions().find((s) => s.sessionId === sessionId) ?? null;
}

function sessionExceedsIngestLimit(s) {
  if (s.partLimitExceeded) return true;
  if (1 + s.subPaths.length > INGEST_SESSION_MAX_PARTS) return true;
  let bytes = 0;
  for (const filePath of [s.topPath, ...s.subPaths]) {
    try {
      const prefixBytes = bytes > 0 ? 1 : 0;
      bytes += prefixBytes + statSync(filePath).size;
      if (bytes > INGEST_SESSION_MAX_BYTES) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function ingestSessionTooLargeError(maxBytes) {
  const err = new Error(`Merged session exceeds ${maxBytes} byte limit`);
  err.code = 'ERR_DASHBOARD_INGEST_SESSION_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

function isIngestSessionTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_INGEST_SESSION_TOO_LARGE';
}

function readUtf8FdCappedSync(fd, maxBytes, initialBytes = 0) {
  const chunks = [];
  let bytes = initialBytes;
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    if (bytes > maxBytes) throw ingestSessionTooLargeError(maxBytes);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  const raw = Buffer.concat(chunks);
  return {
    text: raw.toString('utf8'),
    bytes,
    raw,
  };
}

function readUtf8FileCappedSync(filePath, maxBytes, initialBytes = 0) {
  const fd = openSync(filePath, 'r');
  try {
    return readUtf8FdCappedSync(fd, maxBytes, initialBytes);
  } finally {
    closeSync(fd);
  }
}

// readArtifactTextCappedSync / readArtifactJsonCappedSync / artifactFileTooLargeError
// now live in the shared host-producer seam (./lib/host-producer.mjs, #2077),
// imported at the top of this file.

function readMergedSessionSync(s, topRead = readUtf8FileCappedSync(s.topPath, INGEST_SESSION_MAX_BYTES)) {
  let merged = topRead.text;
  let mergedBytes = topRead.bytes;
  for (const sp of s.subPaths) {
    try {
      const prefix = merged.length && !merged.endsWith('\n') ? '\n' : '';
      const prefixBytes = Buffer.byteLength(prefix, 'utf8');
      if (mergedBytes + prefixBytes > INGEST_SESSION_MAX_BYTES) {
        throw ingestSessionTooLargeError(INGEST_SESSION_MAX_BYTES);
      }
      const { text, bytes } = readUtf8FileCappedSync(
        sp,
        INGEST_SESSION_MAX_BYTES,
        mergedBytes + prefixBytes
      );
      if (prefix) merged += prefix;
      mergedBytes = bytes;
      const t = text;
      merged += t;
    } catch (err) {
      if (isIngestSessionTooLargeError(err)) throw err;
      /* skip unreadable subagent file */
    }
  }
  return merged;
}

// Walk every assistant line of the merged transcript (top-level + subagents)
// and split its `message.content` blocks into two streams: prose/tool-calls
// (text + tool_use) vs. reasoning (thinking + redacted_thinking). Both are
// scrubbed of credential-shaped substrings (#204) before they leave this
// function. Thinking signatures are dropped — they're opaque base64, useless
// for display, and only bloat the BLOB. Tolerant of the bimodal `message`
// shape (string or block array) the parsers already defend against.
function extractTranscript(mergedText) {
  const content = []; // { type:'text'|'tool_use', ... }
  const thinking = []; // { type:'thinking'|'redacted_thinking', ... }
  for (const line of mergedText.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    const blocks = o.message.content;
    if (typeof blocks === 'string') {
      if (blocks) content.push({ type: 'text', text: blocks });
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        content.push({ type: 'text', text: b.text ?? '' });
      } else if (b.type === 'tool_use') {
        content.push({ type: 'tool_use', name: b.name, input: b.input });
      } else if (b.type === 'thinking') {
        thinking.push({ type: 'thinking', thinking: b.thinking ?? '' });
      } else if (b.type === 'redacted_thinking') {
        thinking.push({ type: 'redacted_thinking' });
      }
    }
  }
  // Scrub every string leaf (covers prose AND nested tool_use inputs) before
  // anything is serialised for persistence.
  return { content: scrubValue(content), thinking: scrubValue(thinking) };
}

const TRANSCRIPT_BROTLI_QUALITY = 5;

function brotli(str) {
  const buf = Buffer.from(str, 'utf8');
  return brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: TRANSCRIPT_BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
}

// Persist a session's assistant transcript as brotli BLOBs, gated on a content
// hash so an unchanged transcript skips compression and the write entirely.
// Returns true when a BLOB was (re)written, false when the gate short-circuited
// — the caller rolls these up into the ingest stats line.
function persistTranscript(sessionId, mergedText) {
  const { content, thinking } = extractTranscript(mergedText);
  if (content.length === 0 && thinking.length === 0) {
    // Session with no assistant prose at all — nothing to store. Drop any
    // stale row (e.g. a transcript that was emptied) so the table stays exact.
    // A delete is not a BLOB write, so it never counts toward transcriptsWritten.
    const existed = transcriptCache.readTranscriptHash(sessionId);
    if (existed) transcriptCache.delTranscript(sessionId);
    return false;
  }
  const contentJson = safeJsonStringify(content);
  const thinkingJson = safeJsonStringify(thinking);
  const h = createHash('sha1');
  h.update(contentJson);
  h.update('\0');
  h.update(thinkingJson);
  const contentHash = h.digest('hex');
  const prev = transcriptCache.readTranscriptHash(sessionId);
  if (prev && prev.content_hash === contentHash) return false; // zero BLOB touch
  transcriptCache.upsertTranscript(
    sessionId,
    brotli(contentJson),
    brotli(thinkingJson),
    contentHash,
    Buffer.byteLength(contentJson, 'utf8')
  );
  return true;
}

export function sessionFileSignature(s) {
  return sessionFileSignaturePure(s);
}

export function parseSessionBlobRowFromDisk(s, sig = sessionFileSignature(s)) {
  return parseSessionBlobRowFromDiskPure(s, sig, {
    maxBytes: INGEST_SESSION_MAX_BYTES,
  });
}

function ingestOne(s, sig) {
  const { byColumn } = parseSessionBlobRowFromDisk(s, sig);
  blobCache.upsertRow(UPSERT_COLUMNS.map((col) => byColumn[col]));

  // Transcript BLOBs are generated lazily by getTranscript(). A changed session
  // invalidates any old cached transcript row so expanding the detail view
  // recomputes from the current source, while /api/dataset.json avoids
  // precompressing every transcript during cold ingest.
  if (transcriptCache.readTranscriptHash(s.sessionId)) {
    transcriptCache.delTranscript(s.sessionId);
  }
  return false;
}

// Walk a directory recursively and feed (relpath, mtimeMs, size) into a hash.
// Used to fingerprint the non-SQLite inputs that flow into assembleDataset()
// (insights artifacts under ~/.claude/usage-data and ~/.claude/history.jsonl)
// so the dataset-cache gate also invalidates when the user re-runs the
// `/insights` CLI skill or appends to history. Missing dirs/files are skipped
// silently — same degradation pattern as readInsights(). The walk is bounded so
// an oversized optional artifact tree cannot dominate every dataset rebuild.
function hashTree(root, rel, hash) {
  walkSignatureTree(root, rel, hash, (abs, r) => {
    try {
      const s = statSync(abs);
      hash.update(r);
      hash.update('\0');
      hash.update(String(s.mtimeMs));
      hash.update('\0');
      hash.update(String(s.size));
      hash.update('\n');
    } catch {
      /* skip unstatable file */
    }
  });
}

function hashFileSig(path, hash) {
  hash.update(path);
  hash.update('\0');
  try {
    const s = statSync(path);
    hash.update(String(s.mtimeMs));
    hash.update('\0');
    hash.update(String(s.size));
  } catch {
    hash.update('0\0' + '0');
  }
  hash.update('\n');
}

function hashMemoryFileContent(selected, hash) {
  hash.update(selected.path);
  hash.update('\0');
  try {
    const { raw, bytes } = readSelectedMemoryFileCappedSync(selected);
    hash.update(String(bytes));
    hash.update('\0');
    hash.update(raw);
  } catch (error) {
    hash.update('unreadable\0');
    hash.update(String(error?.code || 'error'));
  }
  hash.update('\n');
}

function hashMemoryFileIdentity(selected, hash) {
  hash.update(selected.path);
  hash.update('\0');
  try {
    // BigInt stats retain the filesystem's full timestamp precision. The cheap
    // gate must detect in-place writes and atomic replacements without reading
    // up to tens of GiB of bounded memory bodies on every cache-hit request.
    const stat = lstatSync(selected.path, { bigint: true });
    hash.update(stat.isFile() ? 'file\0' : 'non-file\0');
    for (const value of [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ]) {
      hash.update(String(value));
      hash.update('\0');
    }
  } catch (error) {
    hash.update('unavailable\0');
    hash.update(String(error?.code || 'error'));
  }
  hash.update('\n');
}

function hashMemorySelection(project, selection, hash) {
  hash.update(`project:${project}\n`);
  hash.update(`dirs:${selection.dirs.join('\0')}\n`);
  hash.update(
    `complete:${Number(selection.readCompleteness.facts)}${Number(selection.readCompleteness.mainIndex)}${Number(selection.readCompleteness.archiveIndex)}\n`
  );
  for (const selected of selection.files) {
    hashMemoryFileContent(selected, hash);
  }
}

function hashMemorySelectionIdentity(project, selection, hash) {
  hash.update(`project:${project}\n`);
  hash.update(`dirs:${selection.dirs.join('\0')}\n`);
  hash.update(
    `complete:${Number(selection.readCompleteness.facts)}${Number(selection.readCompleteness.mainIndex)}${Number(selection.readCompleteness.archiveIndex)}\n`
  );
  for (const selected of selection.files) {
    hashMemoryFileIdentity(selected, hash);
  }
}

// The host producer (#893) persists the PersistedRepoMap envelope
// `{ version, cacheKey, sizeBounded, droppedFiles, map: RepoMap }`; the consumer
// wants the inner RepoMap. `unwrapPersistedRepoMap` (shared with the producer's
// cache module) extracts `.map` (tolerating a flat artifact) and validates it.
// Without it the top-level `root`/`files` were undefined, so every produced
// artifact read as null and `dataset.repoMap` stayed empty (#1650).
function readRepoMapArtifact(root) {
  try {
    const map = unwrapPersistedRepoMap(readArtifactJsonCappedSync(artifactPathFor(REPO_MAP_DIR, root)));
    if (!map || map.root !== root) return null;
    return map;
  } catch {
    return null;
  }
}

// Roots that already have a persisted repo-map artifact. Delegates to the shared
// host-producer discovery (#2077) so ingest, repo-map-refresh, and the #280
// bridge discover roots through the same capped, entry-bounded read. The shared
// helper's root-only unwrap agrees with the consumer's `unwrapPersistedRepoMap`
// on the `root`/`files` shape, so the discovered set is unchanged.
function repoMapArtifactRoots() {
  return discoverRepoMapArtifactRoots(REPO_MAP_DIR, {
    maxEntries: REPO_MAP_ARTIFACT_MAX_ENTRIES,
    maxBytes: ARTIFACT_FILE_MAX_BYTES,
  });
}

function projectRootsFrom(entries, tokenData) {
  const roots = new Set();
  for (const e of entries) {
    if (typeof e.project === 'string' && e.project.startsWith('/')) {
      roots.add(e.project);
    }
  }
  for (const t of tokenData) {
    if (typeof t.project === 'string' && t.project.startsWith('/')) {
      roots.add(t.project);
    }
  }
  return [...roots].sort();
}

// Absolute project roots from `~/.claude.json` — delegates to the shared
// host-producer discovery (#2077), the same capped read repo-map-refresh now
// uses (it previously read this file uncapped).
function claudeJsonProjectRoots() {
  return discoverClaudeJsonProjectRoots(CLAUDE_JSON, ARTIFACT_FILE_MAX_BYTES);
}

function liveConfigProjectRoots(extraRoots = []) {
  if (SCOPED_INGEST) return [];
  return [
    ...new Set([
      ...PROJECT_CONFIG_ROOTS,
      ...extraRoots,
      ...claudeJsonProjectRoots(),
    ]),
  ].sort();
}

function readConfigSource(scope, path) {
  try {
    const content = readTextFileCappedSync(path, CONFIG_FILE_MAX_BYTES);
    const mtime = statSync(path).mtimeMs;
    return { scope, content, mtime };
  } catch {
    return null;
  }
}

function readRepoConfigSources(roots) {
  const sources = [];
  const globalClaude = readConfigSource('CLAUDE.md', CLAUDE_MD_GLOBAL);
  if (globalClaude) sources.push(globalClaude);
  for (const root of roots) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'REFERENCES.md']) {
      const source = readConfigSource(`${root}/${name}`, join(root, name));
      if (source) sources.push(source);
    }
    for (const name of ['settings.json', 'settings.local.json']) {
      const source = readConfigSource(
        `${root}/.claude/${name}`,
        join(root, '.claude', name)
      );
      if (source) sources.push(source);
    }
  }
  return sources;
}

function hashRepoConfigFiles(roots, hash) {
  for (const root of roots) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'REFERENCES.md']) {
      hashFileSig(join(root, name), hash);
    }
    for (const name of ['settings.json', 'settings.local.json']) {
      hashFileSig(join(root, '.claude', name), hash);
    }
  }
}

function hashProjectLiveConfigFiles(roots, hash) {
  for (const root of roots) {
    hashFileSig(join(root, 'CLAUDE.md'), hash);
    for (const name of ['settings.json', 'settings.local.json']) {
      hashFileSig(join(root, '.claude', name), hash);
    }
    for (const name of ['skills', 'agents', 'commands']) {
      hash.update(`${root}/.claude/${name}\n`);
      hashTree(join(root, '.claude', name), '', hash);
    }
  }
}

// Cheap "could anything have changed since the last full ingest?" signature
// for the server's stat-gate (#182). Stats only the projects dir, each
// top-level project dir, top-level dataset files, liveConfig dirs, and a bounded
// repo-map root-discovery set — no recursion into transcripts and no SQLite.
// Lets the server skip the full ingest() walk on a refresh when nothing
// structural changed.
//
// ACCEPTED LIMITATION (by design — see issue #182): POSIX directory mtime moves
// only on entry add/remove/rename, NOT on in-place appends to an existing file.
// So an active session writing more turns to its current <session>.jsonl does
// NOT change this signature, and that append will lag until the next structural
// change (a new/removed session file or project dir, or a history.jsonl /
// ~/.claude.json change). This endpoint is retrospective; in-flight liveness is
// the Live Session widget's job (#131), which reads the active transcript
// directly. history.jsonl / ~/.claude.json are folded in to catch THEIR OWN
// changes (their file mtime does move on append) — not as a transcript-freshness
// proxy (history.jsonl was observed ~9h stale while transcripts were written).
export function sourceSignature() {
  const parts = [];
  parts.push(datasetAssemblySchemaKey());
  for (const projectsRoot of PROJECT_ROOTS) {
    let maxDirMtime = 0;
    const note = (ms) => {
      if (ms > maxDirMtime) maxDirMtime = ms;
    };
    try {
      note(statSync(projectsRoot).mtimeMs);
    } catch {
      /* missing projects dir — contributes 0 */
    }
    let projectsDir;
    try {
      projectsDir = opendirSync(projectsRoot);
    } catch {
      projectsDir = null;
    }
    if (projectsDir) {
      let checked = 0;
      try {
        for (;;) {
          const d = projectsDir.readSync();
          if (!d) break;
          if (checked >= INGEST_PROJECT_MAX_DIRS) break;
          checked += 1;
          if (!d.isDirectory()) continue;
          try {
            note(statSync(join(projectsRoot, d.name)).mtimeMs);
          } catch {
            /* skip unstatable project dir */
          }
        }
      } finally {
        projectsDir.closeSync();
      }
    }
    parts.push(`projects:${projectsRoot}:${Math.floor(maxDirMtime)}`);
  }
  // Memory stores (#1990/#2558): readMemoryStores() reads each
  // <PROJECTS>/<slug>/memory fixed-depth surface (main + archive indexes and
  // direct fact files) into RecommendationInput.memoryStores. A
  // project dir's mtime does NOT advance when a grandchild memory FILE is edited
  // in place (POSIX dir-mtime semantics), so the `projects:` dir signature above
  // misses index/fact edits — exactly the changes the #1779 detector keys on.
  // Hash the exact bounded selection plus replacement-safe file identities and
  // full-precision stats. Raw bytes belong only in ingest().contentHash during
  // a rebuild; reading every body here would turn the cheap request-time gate
  // into a worst-case multi-GiB synchronous scan.
  {
    let memDirs;
    let realProjectsRoot;
    try {
      memDirs = readdirSync(PROJECTS, { withFileTypes: true });
      realProjectsRoot = realpathSync(PROJECTS);
    } catch {
      memDirs = [];
      realProjectsRoot = null;
    }
    let checked = 0;
    for (const ent of [...memDirs]
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (checked >= INGEST_PROJECT_MAX_DIRS) break;
      checked += 1;
      const memDir = join(PROJECTS, ent.name, 'memory');
      const selection = memoryProjectSelection(memDir, realProjectsRoot);
      if (selection.dirs.length === 0) continue;
      const memoryHash = createHash('sha1');
      hashMemorySelectionIdentity(ent.name, selection, memoryHash);
      parts.push(`memory-identity:${memoryHash.digest('hex')}`);
    }
  }
  // Files whose CONTENT feeds the dataset: history.jsonl/history.d entries plus
  // the liveConfig sources whose bytes are read and parsed (settings.json x2,
  // CLAUDE.md, ~/.claude.json, installed_plugins.json).
  // mtime+size catches in-place edits to these (a file's mtime advances on
  // write, unlike a dir's). They MUST be in the signature: ingest()'s
  // contentHash covers the same sources, so without them a settings.json /
  // CLAUDE.md edit with no transcript change would be skipped and serve a stale
  // liveConfig (the config-hygiene engine, #174) until the next structural
  // change — a real correctness regression, not the accepted append-lag.
  for (const f of [
    ...sourceHistoryFiles().map(({ path }) => path),
    CLAUDE_JSON,
    SETTINGS_GLOBAL,
    SETTINGS_LOCAL,
    CLAUDE_MD_GLOBAL,
    PLUGINS_REGISTRY,
  ]) {
    try {
      const s = statSync(f);
      parts.push(`${f}:${Math.floor(s.mtimeMs)}:${s.size}`);
    } catch {
      parts.push(`${f}:0:0`);
    }
  }
  // liveConfig resource dirs: their membership feeds the dataset, and skill
  // descriptions are read from SKILL.md under the config file cap. Hashing the
  // tree's mtime/size pairs catches both add/remove/rename and bounded metadata
  // edits without loading those files during the cheap source-signature pass.
  for (const d of [SKILLS_DIR, AGENTS_DIR, COMMANDS_DIR, PLUGINS_CACHE]) {
    try {
      parts.push(`${d}:${Math.floor(statSync(d).mtimeMs)}`);
    } catch {
      parts.push(`${d}:0`);
    }
  }
  try {
    parts.push(
      `${MODEL_EVAL_RESULTS_DIR}:${Math.floor(statSync(MODEL_EVAL_RESULTS_DIR).mtimeMs)}`
    );
  } catch {
    parts.push(`${MODEL_EVAL_RESULTS_DIR}:0`);
  }
  try {
    parts.push(`${REPO_MAP_DIR}:${Math.floor(statSync(REPO_MAP_DIR).mtimeMs)}`);
  } catch {
    parts.push(`${REPO_MAP_DIR}:0`);
  }
  try {
    parts.push(`${DOC_HYGIENE_DIR}:${Math.floor(statSync(DOC_HYGIENE_DIR).mtimeMs)}`);
  } catch {
    parts.push(`${DOC_HYGIENE_DIR}:0`);
  }
  for (const artifact of sourceArtifactInputs()) {
    parts.push(
      `source-artifact:${artifact.source.id}:${artifact.relPath}:${artifactSignature(artifact.path)}`
    );
  }
  parts.push(`review-events:${reviewEventsSourceSignature()}`);
  // External-guidance files are read fresh into the dataset/recommendations
  // inputs. Fold their bounded stat-only signature into this cheap gate as well
  // as ingest()'s content hash; otherwise a same-process snapshot replacement
  // can early-hit both response caches forever until another source moves.
  parts.push(
    `external-guidance:${EXTERNAL_GUIDANCE_DIR}:${externalGuidanceSourceSignature()}`
  );
  parts.push(`doc-graph:${DOC_GRAPH_ROOT}:${docGraphSourceSignature()}`);
  if (!SCOPED_INGEST) {
    for (const root of liveConfigProjectRoots(repoMapArtifactRoots())) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'REFERENCES.md']) {
        const f = join(root, name);
        try {
          const s = statSync(f);
          parts.push(`${f}:${Math.floor(s.mtimeMs)}:${s.size}`);
        } catch {
          parts.push(`${f}:0:0`);
        }
      }
      for (const name of ['settings.json', 'settings.local.json']) {
        const f = join(root, '.claude', name);
        try {
          const s = statSync(f);
          parts.push(`${f}:${Math.floor(s.mtimeMs)}:${s.size}`);
        } catch {
          parts.push(`${f}:0:0`);
        }
      }
      for (const name of ['skills', 'agents', 'commands']) {
        const d = join(root, '.claude', name);
        try {
          parts.push(`${d}:${Math.floor(statSync(d).mtimeMs)}`);
        } catch {
          parts.push(`${d}:0`);
        }
      }
    }
  }
  return parts.join('|');
}

// Re-parse only changed/new sessions; forget deleted ones. Returns counts
// plus a `contentHash` that covers every input feeding assembleDataset():
//   - per-row content_hash for SQLite session blobs (mtime-tick stable)
//   - mtime/size signatures for usage-data/ insights artifacts
//   - mtime/size signature for history.jsonl
// Callers can skip downstream work (e.g. rebuilding the compressed dataset
// cache) when this hash matches the prior call.
export function ingest() {
  const sessions = listSessions();
  const seen = new Set();
  let reparsed = 0;
  let transcriptsWritten = 0;
  let removed = 0;
  let skippedSessions = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of sessions) {
      seen.add(s.sessionId);
      if (sessionExceedsIngestLimit(s)) {
        blobCache.deleteRow(s.sessionId);
        transcriptCache.delTranscript(s.sessionId);
        skippedSessions += 1;
        continue;
      }
      const sig = sessionFileSignature(s);
      const row = blobCache.readSig(s.sessionId);
      if (!row || row.sig !== sig) {
        try {
          if (ingestOne(s, sig)) transcriptsWritten += 1;
          reparsed += 1;
        } catch (err) {
          if (!isIngestSessionTooLargeError(err)) throw err;
          blobCache.deleteRow(s.sessionId);
          transcriptCache.delTranscript(s.sessionId);
          skippedSessions += 1;
        }
      }
    }
    for (const { session_id } of blobCache.listIds()) {
      if (!seen.has(session_id)) {
        blobCache.deleteRow(session_id);
        transcriptCache.delTranscript(session_id);
        removed += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const hash = createHash('sha1');
  // Section 0: dataset assembly schema. Source artifacts can stay byte-identical
  // while code changes add/remove serialized fields, so persisted compressed
  // dataset rows must be keyed by a schema/version salt as well as source bytes.
  hash.update(datasetAssemblySchemaKey());
  hash.update('\n');
  // Section 1: aggregate per-row content_hash values. Rows ingested before
  // the content_hash column was added may be NULL — that's fine, identical
  // NULL sets still hash identically on subsequent calls. They'll get a real
  // hash the next time the row is re-ingested (mtime bump etc.).
  hash.update('sessions\n');
  for (const r of blobCache.listContentHashes()) {
    hash.update(r.session_id);
    hash.update('\0');
    hash.update(r.content_hash ?? '');
    hash.update('\n');
  }
  // Section 2: ~/.claude/usage-data. The repo-map artifacts under usage-data/
  // repo-map flow into the dataset, so the dataset_cache content_hash must
  // include this tree or a repo-map regeneration would never invalidate the
  // cache. mtime/size is sufficient: these files only change on a rebuild.
  hash.update('usage-data\n');
  hashTree(USAGE_DATA, '', hash);
  // Section 3: ~/.claude/history.jsonl and history.d parts (unioned in for
  // transcript-less sessions). Same rationale — read fresh per assemble, must
  // be in the gate.
  hash.update('history\n');
  for (const { path } of sourceHistoryFiles()) {
    hashFileSig(path, hash);
  }
  // The memory-hygiene input is assembled fresh and is not stored in session
  // blobs. Hash the exact same fixed-depth selection as readMemoryStores(); a
  // sourceSignature-only change would otherwise hit the old content hash and
  // restamp stale recommendation bytes.
  hash.update('memory-stores\n');
  let memoryProjects;
  let realMemoryProjectsRoot;
  try {
    memoryProjects = readdirSync(PROJECTS, { withFileTypes: true });
    realMemoryProjectsRoot = realpathSync(PROJECTS);
  } catch {
    memoryProjects = [];
    realMemoryProjectsRoot = null;
  }
  let memoryProjectsChecked = 0;
  for (const entry of [...memoryProjects]
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (memoryProjectsChecked >= INGEST_PROJECT_MAX_DIRS) break;
    memoryProjectsChecked += 1;
    const memDir = join(PROJECTS, entry.name, 'memory');
    const selection = memoryProjectSelection(memDir, realMemoryProjectsRoot);
    if (selection.dirs.length === 0) continue;
    for (const dir of selection.dirs) hashFileSig(dir, hash);
    hashMemorySelection(entry.name, selection, hash);
  }
  // Shadow-calls ledger (epic #513) — read fresh per assemble (like history), so it
  // must be in the gate or new experiments would never invalidate the recs cache.
  hash.update('shadow-calls\n');
  hashFileSig(SHADOW_CALLS_LEDGER, hash);
  // Proof receipts feed the shadow-calls (source, axis) cells (#2151): a new
  // receipt must invalidate the dataset cache or the cells serve stale. Guarded
  // so the absent-file case keeps the hash input byte-identical to before.
  if (existsSync(PROOF_RECEIPTS_PATH)) {
    hash.update('proof-receipts\n');
    hashFileSig(PROOF_RECEIPTS_PATH, hash);
  }
  // Section 4: liveConfig bundle. Every source the bundle assembles from goes
  // in the gate so any edit (settings.json, CLAUDE.md, plugin install,
  // ~/.claude.json mcpServers change, new skill/agent/command file) forces a
  // dataset cache rebuild on the next request. Tolerant: missing paths just
  // contribute their stat-failure placeholder, identical across calls.
  hash.update('liveConfig\n');
  hash.update('host-environment-observation\n');
  hash.update(hostEnvironmentObservationSignature(
    LIVE_CONFIG_ENVIRONMENT_OBSERVATION,
    SCOPED_INGEST
  ));
  hash.update('\n');
  hashFileSig(SETTINGS_GLOBAL, hash);
  hashFileSig(SETTINGS_LOCAL, hash);
  hashFileSig(CLAUDE_MD_GLOBAL, hash);
  hashFileSig(PLUGINS_REGISTRY, hash);
  hashFileSig(CLAUDE_JSON, hash);
  // Walk the resource directories so a new SKILL.md or command file
  // invalidates without us having to re-stat each individual file.
  hash.update('skills\n');
  hashTree(SKILLS_DIR, '', hash);
  hash.update('agents\n');
  hashTree(AGENTS_DIR, '', hash);
  hash.update('commands\n');
  hashTree(COMMANDS_DIR, '', hash);
  // Plugin cache moves whenever a plugin is installed/upgraded — covers
  // enumeratePluginBundle's discovery surface.
  hash.update('plugins-cache\n');
  hashTree(PLUGINS_CACHE, '', hash);
  // Host-generated repo-map artifacts feed the server-only `repoMap` dataset
  // key (#889). They live under usage-data but are not tied to an `/insights`
  // run, so keep them explicit in the gate.
  hash.update('repo-map\n');
  hashTree(REPO_MAP_DIR, '', hash);
  if (!SCOPED_INGEST) {
    hash.update('repo-map-config\n');
    hashRepoConfigFiles(repoMapArtifactRoots(), hash);
    hash.update('project-live-config\n');
    hashProjectLiveConfigFiles(liveConfigProjectRoots(repoMapArtifactRoots()), hash);
  }
  // Completed model-eval result artifacts (#1242): a new/changed artifact must
  // invalidate the compressed dataset cache or the summary is served stale
  // until an unrelated input moves. Guarded so the absent-dir case contributes
  // nothing and the hash input stays byte-identical to before this feature.
  if (existsSync(MODEL_EVAL_RESULTS_DIR)) {
    hash.update('model-evals\n');
    hashTree(MODEL_EVAL_RESULTS_DIR, '', hash);
  }
  hash.update('source-artifacts\n');
  for (const artifact of sourceArtifactInputs()) {
    hash.update(artifact.source.id);
    hash.update('\0');
    hash.update(artifact.relPath);
    hash.update('\0');
    if (artifact.kind === 'file') {
      hashFileSig(artifact.path, hash);
    } else {
      hashTree(artifact.path, '', hash);
    }
    hash.update('\n');
  }
  hash.update('review-events\n');
  hash.update(reviewEventsSourceSignature());
  hash.update('\n');
  // Repo-committed external guidance snapshots (#1302) feed the dataset's
  // `externalGuidance` key. They only change with a checkout/image rebuild,
  // but the dataset cache persists in SQLite across restarts, so they must be
  // in the gate or a refreshed snapshot would be served stale.
  hash.update('external-guidance\n');
  hashExternalGuidanceContent(hash);
  // Repo Markdown feeds the serialized docGraph and the doc-hygiene detector.
  // Reuse the same bounded stat surface as sourceSignature() so neither cache
  // can serve a graph from before an in-place doc edit or membership change.
  hash.update('doc-graph\n');
  hash.update(DOC_GRAPH_ROOT);
  hash.update('\0');
  hashDocGraphContent(hash);
  const contentHash = hash.digest('hex');
  return {
    total: sessions.length,
    reparsed,
    removed,
    transcriptsWritten,
    skippedSessions,
    contentHash,
  };
}


// Assemble server-side aggregate artifacts, mostly #539 top-level ~/.claude
// artifacts, gated on a cheap per-dir stat signature through the artifact cache
// (#624). For each artifact: keep the original
// existsSync guard (absent ⇒ the default value, parser never called), route the
// existing-source case through cachedArtifact so an unchanged tree is read back
// from SQLite instead of re-walked, and apply any non-deterministic post-
// transform OUTSIDE the cache so the result stays byte-identical to today:
//   - teams: parseTeamsDir returns a Map (not JSON-safe), so it's cached via an
//     entries[] encode/decode round-trip; analyzeTeams(.., Date.now()) runs
//     fresh per call OUTSIDE the cache, exactly as the old inline code did.
//   - configBackups: parseBackupsDir is the cached file-read; the pure
//     diffConfigDrift transform runs each call (cheap, deterministic).
//   - source-root artifacts from push ingest (sessions/telemetry/debug/
//     file-history/stats-cache.json) are parsed once per registered source and
//     concatenated/merged without changing the underlying parsers.
// Single-file artifacts (updateResults, mcpAuth) are cheap single reads, not
// tree walks, so they stay uncached — same behaviour as before.
export function assembleArtifacts() {
  let tasks = [];
  let teams = [];
  let reviewEvents = null;
  let sessionRegistry = [];
  let telemetry = [];
  let modelLatency = [];
  let debugLogs = [];
  let statsCache = null;
  let fileHistory = [];
  let plans = [];
  let modelEvalSummary = null;
  let updateResults = [];
  let mcpAuth = null;
  let configBackups = [];

  try {
    if (existsSync(TASKS_DIR)) {
      tasks = cachedArtifact('tasks', TASKS_DIR, () =>
        parseTasksDir(TASKS_DIR, {
          maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
          maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
        })
      );
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(TEAMS_DIR)) {
      // Cache the PURE Map parse (encoded as entries[]); apply the
      // time-dependent analyzeTeams() outside the cache, fresh per call.
      const teamMap = cachedArtifact(
        'teams',
        TEAMS_DIR,
        () =>
          parseTeamsDir(TEAMS_DIR, {
            maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
            maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
          }),
        (m) => [...m.entries()],
        (e) => new Map(e)
      );
      teams = analyzeTeams(teamMap, Date.now());
    }
  } catch { /* ignore */ }
  try {
    reviewEvents = readReviewEventsArtifact();
  } catch { /* ignore */ }
  for (const { source } of PROJECT_SOURCES) {
    const sessionsDir = sourceArtifactPath(source, 'sessions');
    try {
      if (existsSync(sessionsDir)) {
        sessionRegistry.push(
          ...cachedArtifact(`session-registry:${source.id}`, sessionsDir, () =>
            parseSessionRegistryDir(sessionsDir, {
              maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
              maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
            })
          )
        );
      }
    } catch { /* ignore */ }
  }
  for (const { source } of PROJECT_SOURCES) {
    const telemetryDir = sourceArtifactPath(source, 'telemetry');
    try {
      if (existsSync(telemetryDir)) {
        telemetry.push(
          ...cachedArtifact(`telemetry:${source.id}`, telemetryDir, () =>
            parseTelemetryDir(telemetryDir, {
              maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
              maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
            })
          )
        );
        modelLatency.push(
          ...cachedArtifact(`model-latency:${source.id}`, telemetryDir, () =>
            parseTelemetryLatencyDir(telemetryDir, {
              maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
              maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
            })
          )
        );
      }
    } catch { /* ignore */ }
  }
  for (const { source } of PROJECT_SOURCES) {
    const debugDir = sourceArtifactPath(source, 'debug');
    try {
      if (existsSync(debugDir)) {
        debugLogs.push(
          ...cachedArtifact(`debug:${source.id}`, debugDir, () =>
            parseDebugDir(debugDir, {
              maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
              maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
            })
          )
        );
      }
    } catch { /* ignore */ }
  }
  try {
    const statsCaches = [];
    for (const { source } of PROJECT_SOURCES) {
      const statsPath = sourceArtifactPath(source, 'stats-cache.json');
      try {
        if (existsSync(statsPath)) {
          statsCaches.push(parseStatsCache(readArtifactTextCappedSync(statsPath)));
        }
      } catch { /* ignore source stats */ }
    }
    statsCache = mergeStatsCaches(statsCaches);
  } catch { /* ignore */ }
  for (const { source } of PROJECT_SOURCES) {
    const fileHistoryDir = sourceArtifactPath(source, 'file-history');
    try {
      if (existsSync(fileHistoryDir)) {
        fileHistory.push(
          ...cachedArtifact(`file-history:${source.id}`, fileHistoryDir, () =>
            parseFileHistoryDir(fileHistoryDir, {
              maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
            })
          )
        );
      }
    } catch { /* ignore */ }
  }
  try {
    if (existsSync(PLANS_DIR)) {
      plans = cachedArtifact('plans', PLANS_DIR, () =>
        parsePlansDir(PLANS_DIR, {
          maxFileBytes: ARTIFACT_FILE_MAX_BYTES,
          maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
        })
      );
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(MODEL_EVAL_RESULTS_DIR)) {
      modelEvalSummary = cachedArtifact(
        'model-eval-results',
        MODEL_EVAL_RESULTS_DIR,
        () => {
          // Name-sorted, entry-capped *.json artifacts, each JSON-parsed under
          // its own guard, folded through the pure #1085 summarizer (which
          // sanitizes per artifact, so a malformed file is dropped, not fatal).
          const names = [];
          const dir = opendirSync(MODEL_EVAL_RESULTS_DIR);
          try {
            let ent;
            while ((ent = dir.readSync()) !== null) {
              if (names.length >= ARTIFACT_DIR_MAX_ENTRIES) break;
              if (ent.isFile() && ent.name.endsWith('.json')) names.push(ent.name);
            }
          } finally {
            dir.closeSync();
          }
          names.sort();
          const raws = [];
          for (const name of names.slice(0, ARTIFACT_DIR_MAX_ENTRIES)) {
            try {
              raws.push(
                JSON.parse(
                  readArtifactTextCappedSync(join(MODEL_EVAL_RESULTS_DIR, name))
                )
              );
            } catch { /* malformed artifact file — skip */ }
          }
          return ingestModelEvalResults(raws);
        },
        undefined,
        // Backfill for rows cached by a pre-#1387 build: the artifact cache
        // replays stored JSON verbatim on a signature hit, and those rows
        // predate the required `artifacts` ledger field — without this, a
        // warm-cache upgraded deploy serves a summary that contradicts the
        // declared ModelEvalSummary type.
        (stored) =>
          stored && stored.artifacts == null
            ? { ...stored, artifacts: [] }
            : stored
      );
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(LAST_UPDATE)) {
      const u = parseLastUpdate(readArtifactTextCappedSync(LAST_UPDATE));
      updateResults = u ? [u] : [];
    }
  } catch { /* ignore */ }
  try { if (existsSync(MCP_AUTH)) mcpAuth = parseMcpAuthCache(readArtifactTextCappedSync(MCP_AUTH)); } catch { /* ignore */ }
  try {
    if (existsSync(BACKUPS_DIR)) {
      // Cache the PURE parse; diffConfigDrift (pure, cheap) runs each call.
      const snapshots = cachedArtifact('backups', BACKUPS_DIR, () =>
        parseBackupsDir(BACKUPS_DIR, undefined, {
          maxFileBytes: CONFIG_FILE_MAX_BYTES,
          maxEntries: ARTIFACT_DIR_MAX_ENTRIES,
        })
      );
      configBackups = diffConfigDrift(snapshots);
    }
  } catch { /* ignore */ }

  return {
    tasks,
    teams,
    reviewEvents,
    sessionRegistry,
    telemetry,
    modelLatency,
    debugLogs,
    statsCache,
    fileHistory,
    plans,
    modelEvalSummary,
    updateResults,
    mcpAuth,
    configBackups,
  };
}

// #2182 (epic #2181): call-count instrumentation so a test can PROVE the recs
// path assembles the LIGHT recommendation dataset and never triggers the full
// assembleDataset() build. Test-only observable; never affects output.
const assemblyCallCounts = { full: 0, recommendation: 0 };
export function assemblyInstrumentation() {
  return { ...assemblyCallCounts };
}

// Shared assembly core (#2182). Builds every signal array, the entries union,
// the aggregate/artifact fields, and the repoMap INPUTS that BOTH the full
// /api/dataset.json payload (assembleDataset) and the lighter recommendation
// dataset (assembleRecommendationDataset) consume — through the SAME per-signal
// fold and the SAME builders, so their shared fields are byte-identical. The
// full-only extras (the embedded first-pass recommendations that populate
// repoMap.files[].recommendations and the schema/window metadata) plus the two
// divergent repoMap builds stay with each caller below. Prompt analysis is
// intentionally caller-owned: both full and served-light paths derive the same
// compact numeric rows from the shared entries array.
function assembleDatasetCore() {
  const rows = blobCache.readAllRows();
  const sessionProvenanceById = new Map(
    listSessions().map((session) => {
      // #2136: a shipped session is attributed to the pod/member that shipped it
      // (per its ledger), overriding the default source it was physically read under.
      const shipped = SHIPPED_SESSION_SOURCE.get(session.sessionId);
      return [
        session.sessionId,
        shipped
          ? { sourceId: shipped.sourceId, harness: shipped.harness }
          : {
              sourceId: session.sourceId || DEFAULT_SOURCE_PROVENANCE.sourceId,
              harness: session.harness || DEFAULT_SOURCE_PROVENANCE.harness,
            },
      ];
    })
  );
  const tokenData = [];
  const toolData = [];
  const toolInventories = [];
  const timelines = [];
  const apiErrors = [];
  const permissionRows = [];
  const permissionChanges = [];
  const agentSettings = [];
  const attribution = [];
  const runtimeEvents = [];
  const churnGeometry = [];
  const assistantFeatures = [];
  const deceitSignals = [];
  const secretsAtRest = [];
  const taskSuccess = [];
  const valueFlow = [];
  const entries = [];
  const transcriptSessionIds = new Set();

  // Read-back is driven by the signal descriptor (#524, slice 1). `out` maps
  // each push-truthy/spread signal's `datasetKey` to the array declared above,
  // so the generic folds push into the very same arrays the return object ships
  // — byte-identical to the old per-column inline block. `perm` and `entries`
  // are `special` and handled explicitly (perm fan-out; entries spread, with
  // the history.jsonl union still applied AFTER the row loop below).
  const out = {
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    agentSettings,
    attribution,
    runtimeEvents,
    churnGeometry,
    assistantFeatures,
    deceitSignals,
    secretsAtRest,
    taskSuccess,
    valueFlow,
  };
  for (const r of rows) {
    transcriptSessionIds.add(r.session_id);
    const provenance =
      sessionProvenanceById.get(r.session_id) || DEFAULT_SOURCE_PROVENANCE;
    // r.title is already inlined into each derived entry (see deriveEntries),
    // so we don't ship a duplicate top-level titles map.
    for (const s of SESSION_SIGNALS) {
      if (s.aggregate === 'push-truthy') {
        // `unconditional`: parse the column directly (the original code did
        // `JSON.parse(r.col)` with no guard); `guarded`: only parse when the
        // column is non-empty (`r.col ? JSON.parse(r.col) : null`). Then push
        // iff truthy. This per-signal distinction is what keeps output identical.
        const v =
          s.parseGuard === 'guarded'
            ? r[s.column]
              ? JSON.parse(r[s.column])
              : null
            : JSON.parse(r[s.column]);
        // #1035/#1284: the bulk dataset ships timelines with entry summaries
        // stripped (the largest measured single payload field, rendered only
        // by the per-session detail view). The session_blob row keeps the full
        // parse; getSessionTimelineDetail() below serves it lazily.
        if (v) {
          const value =
            s.datasetKey === 'timelines'
              ? slimSessionTimeline(v)
              : s.datasetKey === 'toolData'
                ? stripToolCommandBodies(v)
                : v;
          out[s.datasetKey].push(
            maybeDecorateSignalValue(s.datasetKey, value, provenance)
          );
        }
      } else if (s.aggregate === 'spread') {
        for (const e of JSON.parse(r[s.column]) || []) {
          out[s.datasetKey].push(
            maybeDecorateSignalValue(s.datasetKey, e, provenance)
          );
        }
      } else if (s.id === 'perm') {
        const perm = JSON.parse(r[s.column]) || { perModeEntries: [], changes: [] };
        for (const p of perm.perModeEntries || []) permissionRows.push(p);
        for (const c of perm.changes || []) permissionChanges.push(c);
      } else if (s.id === 'entries') {
        for (const en of JSON.parse(r[s.column]) || []) {
          entries.push(withSourceProvenance(en, provenance));
        }
      }
    }
  }

  // Union: include history entries for sessions with no transcript. Within each
  // source, history.d/<sessionId>.jsonl parts own their sessions and suppress
  // duplicate entries from the legacy flat history.jsonl fallback.
  for (const { legacy, parts, provenance } of sourceHistoryFileSets()) {
    let legacyEntries = [];
    const partEntries = [];

    if (legacy.artifacts.exists(legacy.relPath)) {
      try {
        legacyEntries = parseHistoryJsonl(
          legacy.artifacts.read(legacy.relPath, { maxBytes: ARTIFACT_FILE_MAX_BYTES }).text
        );
      } catch {
        /* ignore malformed legacy history */
      }
    }

    for (const part of parts) {
      if (!part.artifacts.exists(part.relPath)) continue;
      try {
        partEntries.push(
          ...parseHistoryJsonl(
            part.artifacts.read(part.relPath, { maxBytes: ARTIFACT_FILE_MAX_BYTES }).text
          )
        );
      } catch {
        /* ignore malformed history part */
      }
    }

    const hist = unionHistoryParts(legacyEntries, partEntries);
    for (const e of hist) {
      if (!transcriptSessionIds.has(e.sessionId)) {
        entries.push(withSourceProvenance(e, provenance));
      }
    }
  }
  const taskSteering = computeTaskSteering({
    entries,
    runtimeEvents,
    tokenData,
  });
  const repoMapRoots = repoMapArtifactRoots();
  const liveConfigRoots = liveConfigProjectRoots(repoMapRoots);

  const liveConfig = assembleLiveConfig({
    claudeDir: CLAUDE,
    homeDir: CLAUDE_HOME,
    scoped: SCOPED_INGEST,
    projectRoots: liveConfigRoots,
    // Enterprise scoped ingest must not expose operator environment names to
    // tenant datasets. Single-user local mode observes names only.
    environment: LIVE_CONFIG_ENVIRONMENT_OBSERVATION,
  });

  // Shadow-calls experiment ledger (epic #513). Optional file; absent/malformed
  // ⇒ a zeroed aggregate, so the shadow-axis-wins detector simply emits nothing.
  // Tail-capped read (#2152): an oversized ledger degrades to its newest tail
  // with `truncated: true` surfaced on the aggregate, instead of the old capped
  // read throwing and this catch silently serving a ZEROED aggregate — months of
  // experiment evidence must never vanish without a visible flag.
  let shadowCalls = parseShadowCalls(null);
  if (existsSync(SHADOW_CALLS_LEDGER)) {
    try {
      const ledger = readJsonlTailCappedSync(SHADOW_CALLS_LEDGER);
      shadowCalls = parseShadowCalls(ledger.text);
      if (ledger.truncated) {
        shadowCalls.truncated = true;
        console.warn(
          `[ingest] shadow-calls ledger exceeds the ${ARTIFACT_FILE_MAX_BYTES}-byte artifact cap ` +
            `(${ledger.totalBytes} bytes); parsed only the newest tail and flagged the aggregate truncated`
        );
      }
    } catch {
      /* ignore unreadable ledger */
    }
  }

  // Workflow-tool run manifests (#435/#661): walk every
  // <project>/<session>/workflows/wf_*.json, project + parse to WorkflowRun[] so
  // the workflow-health detectors (#635) reconcile against real runs. Server-only
  // — not in the SPA upload bundle, so the SPA dataset simply ships [].
  let workflows = [];
  for (const projectsRoot of PROJECT_ROOTS) {
    try {
      workflows.push(...parseWorkflows(readWorkflowsSync(projectsRoot)));
    } catch {
      /* ignore — a malformed walk degrades to no workflow recs, never sinks ingest */
    }
  }

  // ── Server aggregate artifacts (top-level ~/.claude plus enterprise slots) ──
  // Gated on a cheap per-artifact stat signature through the artifact cache
  // (#624): a dir whose tree is unchanged skips re-walk/re-parse entirely and
  // its parsed value is read back from SQLite. Behaviour is otherwise identical
  // to the old inline block — each reader is guarded so a missing/malformed
  // source degrades to an empty value and never sinks the dataset endpoint.
  // These are NOT in the tdrop upload bundle, so the SPA dataset ships them
  // empty (#539 follow-up note).
  const {
    tasks,
    teams,
    reviewEvents,
    sessionRegistry,
    telemetry,
    modelLatency,
    debugLogs,
    statsCache,
    fileHistory,
    plans,
    modelEvalSummary,
    updateResults,
    mcpAuth,
    configBackups,
  } = assembleArtifacts();
  const externalGuidance = readExternalGuidance();
  const docGraph = readDocGraph();

  // Artifact-derived experiment sources (#2151): proof receipts + model-eval
  // batches join the ledger's uniform (source, axis) cells so every experiment
  // kind reports through ONE surface (epic #2147). Their samples land in
  // `external`, never `counted`, so the #2149 line-for-line ledger
  // reconciliation stays exact. Race records need no wiring here: they append
  // to the ledger itself and the parser now classifies them `race-live`.
  try {
    const externalCells = [];
    if (existsSync(PROOF_RECEIPTS_PATH)) {
      externalCells.push(
        ...parseProofReceiptCells(readFileSync(PROOF_RECEIPTS_PATH, 'utf8')).cells
      );
    }
    const modelEvalCell = modelEvalSourceCell(modelEvalSummary);
    if (modelEvalCell) externalCells.push(modelEvalCell);
    shadowCalls = mergeExternalSourceCells(shadowCalls, externalCells);
  } catch {
    /* ignore — unreadable receipts degrade to ledger-only cells, never sink ingest */
  }

  const roots = projectRootsFrom(entries, tokenData);
  const maps = roots.map(readRepoMapArtifact).filter(Boolean);
  const configSections = SCOPED_INGEST
    ? []
    : parseConfigSet(readRepoConfigSources(roots));
  const configAttribution = SCOPED_INGEST
    ? []
    : attributeConfigSections(configSections, { toolData });
  const fileReread = parseFileReread(toolData, tokenData);
  const churnFiles = topChurnFiles(toolData);
  const recSessions = groupBySessions(entries);
  const recProjects = groupByProjects(recSessions);
  // Git delivery-outcome signal (#1757): opt-in `gh` fetch + pure classify.
  // Empty unless CHD_GIT_OUTCOMES names a repo, so the default path is unchanged.
  const gitOutcomes = readGitOutcomes(recSessions);
  const signalInput = {};
  for (const s of SESSION_SIGNALS) {
    if (s.datasetKey) signalInput[s.datasetKey] = {
      tokenData,
      toolData,
      toolInventories,
      timelines,
      apiErrors,
      agentSettings,
      attribution,
      runtimeEvents,
      taskSteering,
      churnGeometry,
      assistantFeatures,
      deceitSignals,
      secretsAtRest,
      taskSuccess,
      valueFlow,
    }[s.datasetKey];
  }
  return {
    // Signal arrays (the 13 SESSION_SIGNALS datasetKeys)
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    agentSettings,
    attribution,
    runtimeEvents,
    churnGeometry,
    assistantFeatures,
    deceitSignals,
    secretsAtRest,
    taskSuccess,
    valueFlow,
    // Special signals
    entries,
    permissionRows,
    permissionChanges,
    // Aggregates
    taskSteering,
    liveConfig,
    shadowCalls,
    workflows,
    // Server artifacts
    tasks,
    teams,
    reviewEvents,
    sessionRegistry,
    telemetry,
    modelLatency,
    debugLogs,
    statsCache,
    fileHistory,
    plans,
    modelEvalSummary,
    updateResults,
    mcpAuth,
    configBackups,
    externalGuidance,
    gitOutcomes,
    docGraph,
    // repoMap inputs (each caller builds repoMap; only the full path folds in
    // the embedded recommendations)
    maps,
    configSections,
    configAttribution,
    fileReread,
    churnFiles,
    // Embedded first-pass recommendation inputs (full path only)
    recSessions,
    recProjects,
    signalInput,
  };
}

// Assemble the normalized payload the client consumes. Transcript-derived
// entries are authoritative; history.d parts override history.jsonl for the
// same session before history-only sessions are unioned in.
export function assembleDataset() {
  assemblyCallCounts.full += 1;
  const {
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    agentSettings,
    attribution,
    runtimeEvents,
    churnGeometry,
    assistantFeatures,
    deceitSignals,
    secretsAtRest,
    taskSuccess,
    valueFlow,
    entries,
    permissionRows,
    permissionChanges,
    taskSteering,
    liveConfig,
    shadowCalls,
    workflows,
    tasks,
    teams,
    reviewEvents,
    sessionRegistry,
    telemetry,
    modelLatency,
    debugLogs,
    statsCache,
    fileHistory,
    plans,
    modelEvalSummary,
    updateResults,
    mcpAuth,
    configBackups,
    externalGuidance,
    gitOutcomes,
    docGraph,
    maps,
    configSections,
    configAttribution,
    fileReread,
    churnFiles,
    recSessions,
    recProjects,
    signalInput,
  } = assembleDatasetCore();
  const promptAnalysis = parsePromptAnalysis(entries);
  const recommendations = buildRecommendations(
    assembleRecommendationInput({
      ...signalInput,
      sessions: recSessions,
      projects: recProjects,
      permissionRows,
      liveConfig,
      shadowCalls,
      workflows,
      tasks,
      teams,
      reviewEvents,
      sessionRegistry,
      telemetry,
      modelLatency,
      debugLogs,
      statsCache,
      fileHistory,
      plans,
      modelEvalSummary,
      updateResults,
      mcpAuth,
      configBackups,
      externalGuidance,
      gitOutcomes,
      docGraph,
      promptAnalysis,
    })
  );
  const repoMap = buildRepoMapDataset({
    maps,
    configSections,
    configAttribution,
    fileReread,
    churnFiles,
    recommendations,
  });

  // Schema envelope (#127): self-describing metadata for machine consumers
  // (Aya, P10) — schema version, the data's time window, and units for the
  // ambiguous numeric fields. Additive *sibling* keys (no `data:` nesting), so
  // the client load path is unchanged. schemaVersion/units are constants and
  // windowStart/windowEnd are data-derived, so none of them churn the ETag
  // when only generatedAt moves (server.mjs drops generatedAt from the stable
  // view before hashing).
  const generatedAt = Date.now();
  // Window bounds from the entries' timestamps (epoch-ms; 0 marks "unknown",
  // so skip those). With no usable timestamp, collapse the window onto
  // generatedAt so the fields are always present and ISO-valid.
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const e of entries) {
    const t = e.timestamp;
    if (typeof t === 'number' && t > 0) {
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
  }
  const hasWindow = minTs !== Infinity;
  const windowStart = new Date(hasWindow ? minTs : generatedAt).toISOString();
  const windowEnd = new Date(hasWindow ? maxTs : generatedAt).toISOString();

  return {
    schemaVersion: '1',
    generatedAt,
    windowStart,
    windowEnd,
    sources: datasetSources(),
    sourceId: DEFAULT_SOURCE.id,
    harness: DEFAULT_SOURCE.harness,
    // Units for numeric fields whose name doesn't already encode the unit.
    // Curated + extensible — not an exhaustive catalogue of every numeric leaf.
    units: {
      peakContext: 'tokens',
      peakContextSize: 'tokens',
      durationMs: 'ms',
      estimatedCost: 'usd',
      totalCost: 'usd',
      textLength: 'characters',
      thinkingByteLen: 'bytes',
      totalPromptChars: 'characters',
      avgPromptChars: 'characters',
    },
    entries,
    tokenData,
    toolData,
    toolInventories,
    timelines,
    apiErrors,
    permissionRows,
    permissionChanges,
    agentSettings,
    attribution,
    runtimeEvents,
    taskSteering,
    churnGeometry,
    promptAnalysis,
    liveConfig,
    assistantFeatures,
    deceitSignals,
    secretsAtRest,
    taskSuccess,
    valueFlow,
    shadowCalls,
    workflows,
    repoMap,
    // Server aggregate artifacts (empty/null in the SPA dataset)
    tasks,
    teams,
    reviewEvents,
    sessionRegistry,
    telemetry,
    modelLatency,
    debugLogs,
    statsCache,
    fileHistory,
    plans,
    modelEvalSummary,
    updateResults,
    mcpAuth,
    configBackups,
    externalGuidance,
    // Git delivery-outcome rows (#1757); empty unless CHD_GIT_OUTCOMES is set.
    gitOutcomes,
    docGraph,
  };
}

// Lighter assembly for the recommendation path (#2182, epic #2181). Builds ONLY
// the fields `assembleRecommendationContext` reads off the dataset — via the
// SAME `assembleDatasetCore()` builders as the full dataset — and SKIPS the
// full-only work the recs input never consumes:
//   * the embedded first-pass `buildRecommendations()` detector-catalog pass whose
//     ONLY output is repoMap.files[].recommendations — a cross-link NO served
//     detector reads (verified), so omitting it leaves the served recs body
//     byte-identical while dropping a full detector pass from the rebuild;
//   * the schema envelope + window scan + units metadata (dataset-only).
// The result carries every field the recs input needs, so a caller can pass it
// as `options.dataset` to `assembleRecommendations` /
// `recordSuppressionTransitions` exactly like the full dataset — but without
// building the ~132 MB serialized payload's dataset-only extras. Full
// `assembleDataset()` (for /api/dataset.json and its embedded recs) is unchanged.
export function assembleRecommendationDataset() {
  assemblyCallCounts.recommendation += 1;
  const core = assembleDatasetCore();
  // Compact numeric rows only: parsePromptAnalysis retains no prompt prose.
  // workflow.prompt-clarity consumes these on /api/recommendations.json and
  // /recs, so the served-light path must match the human/full dataset.
  const promptAnalysis = parsePromptAnalysis(core.entries);
  // repoMap WITHOUT the embedded recommendations: files[].recommendations is
  // empty here (no served detector reads it), every other repoMap field matches
  // the full path, so the served recs are byte-identical.
  const repoMap = buildRepoMapDataset({
    maps: core.maps,
    configSections: core.configSections,
    configAttribution: core.configAttribution,
    fileReread: core.fileReread,
    churnFiles: core.churnFiles,
  });
  return {
    entries: core.entries,
    tokenData: core.tokenData,
    toolData: core.toolData,
    toolInventories: core.toolInventories,
    timelines: core.timelines,
    apiErrors: core.apiErrors,
    agentSettings: core.agentSettings,
    attribution: core.attribution,
    runtimeEvents: core.runtimeEvents,
    churnGeometry: core.churnGeometry,
    assistantFeatures: core.assistantFeatures,
    deceitSignals: core.deceitSignals,
    secretsAtRest: core.secretsAtRest,
    taskSuccess: core.taskSuccess,
    valueFlow: core.valueFlow,
    permissionRows: core.permissionRows,
    taskSteering: core.taskSteering,
    promptAnalysis,
    liveConfig: core.liveConfig,
    shadowCalls: core.shadowCalls,
    workflows: core.workflows,
    tasks: core.tasks,
    teams: core.teams,
    reviewEvents: core.reviewEvents,
    sessionRegistry: core.sessionRegistry,
    telemetry: core.telemetry,
    modelLatency: core.modelLatency,
    debugLogs: core.debugLogs,
    statsCache: core.statsCache,
    fileHistory: core.fileHistory,
    plans: core.plans,
    modelEvalSummary: core.modelEvalSummary,
    updateResults: core.updateResults,
    mcpAuth: core.mcpAuth,
    configBackups: core.configBackups,
    externalGuidance: core.externalGuidance,
    gitOutcomes: core.gitOutcomes,
    docGraph: core.docGraph,
    repoMap,
  };
}

// Build the recommendation list server-side from the same assembled dataset the
// /api/dataset.json route serializes, so headless / agent consumers (Aya, P10)
// get recs byte-identical to the UI's Recommendations view — same stable `id`s
// and `fix` snippets — without booting a browser (#126). `sessions`/`projects`
// are derived from `entries` exactly as the client does (App.tsx:
// groupBySessions -> groupByProjects), then fed to the pure buildRecommendations
// engine with the same field mapping the UI's Recommendations component uses
// (tokenData, toolData, sessions, projects, permissionRows, apiErrors,
// promptAnalysis, liveConfig). Deterministic in the dataset, so the route can derive a stable
// ETag straight from the serialized output.
//
// `project` (#330): when set, the global recs are narrowed to those attributable
// to that project path (via the session-ids leading each rec's evidence). When
// omitted/falsy the full global list is returned unchanged — byte-identical to
// pre-#330, so the v1 `/recs` consumer keeps working.
// Assemble the {@link RecommendationInput} the engine runs over, plus the
// `sessions` list the project filter and (#576) transition diff need. Shared by
// `assembleRecommendations` (the recs route) and `recordSuppressionTransitions`
// (the adoption-receipt emit) so both observe the exact same dataset state.
function assembleRecommendationContext(options = {}) {
  // Reuse a caller-provided dataset (#2071) so a single recs request assembles
  // the dataset once — shared by the recs build and the suppression-transition
  // emit — instead of assembling it twice. Falls back to the LIGHTER
  // recommendation dataset (#2182) when no dataset is supplied: it carries every
  // field consumed below via the SAME builders as assembleDataset() but skips the
  // dataset-only extras (the embedded first-pass recs and schema metadata), so
  // the served recs are byte-identical while the rebuild drops a full detector
  // pass. Full assembleDataset() stays available for callers that
  // inject it (e.g. a request that also serves /api/dataset.json).
  const dataset = options.dataset ?? assembleRecommendationDataset();
  const sessions = groupBySessions(dataset.entries);
  const projects = groupByProjects(sessions);
  // Signal-derived RecommendationInput fields flow straight from the descriptor
  // (#524 slice 3): each push-truthy/spread signal's `datasetKey` IS its
  // RecommendationInput key and its assembleDataset() output key, so a new
  // detector-consumed signal needs only its descriptor entry + a
  // RecommendationInput type field — no edit here. The non-signal fields
  // stay explicit: `sessions`/`projects` are derived from entries, `permissionRows`
  // comes from the perm fan-out, and `liveConfig` is assembled separately.
  const signalInput = {};
  for (const s of SESSION_SIGNALS) {
    if (s.datasetKey) signalInput[s.datasetKey] = dataset[s.datasetKey];
  }
  const input = assembleRecommendationInput({
    ...signalInput,
    sessions,
    projects,
    permissionRows: dataset.permissionRows,
    liveConfig: dataset.liveConfig,
    // Compact prompt traits are derived from shared entries in both the full
    // and served-light datasets; no prompt prose is retained.
    promptAnalysis: dataset.promptAnalysis,
    // Non-signal aggregate (like liveConfig): the shadow-calls ledger digest
    // is assembled separately, not a per-session SESSION_SIGNAL, so it stays
    // explicit here rather than flowing through `signalInput` (#513).
    shadowCalls: dataset.shadowCalls,
    taskSteering: dataset.taskSteering,
    // Workflow-tool runs (#661): non-signal aggregate, like shadowCalls — feeds
    // the #635 workflow-health detectors.
    workflows: dataset.workflows,
    // Server artifacts: non-signal aggregates (like shadowCalls), assembled
    // separately above and passed straight through to the detectors.
    tasks: dataset.tasks,
    teams: dataset.teams,
    organizationIdentity: options.organizationIdentity ?? null,
    reviewEvents: dataset.reviewEvents,
    sessionRegistry: dataset.sessionRegistry,
    telemetry: dataset.telemetry,
    modelLatency: dataset.modelLatency,
    debugLogs: dataset.debugLogs,
    statsCache: dataset.statsCache,
    fileHistory: dataset.fileHistory,
    plans: dataset.plans,
    // Model-eval results rollup (#1085/#1242): non-signal aggregate, like the
    // other server artifacts — feeds the #1086 act-now routing-gap detector.
    modelEvalSummary: dataset.modelEvalSummary,
    updateResults: dataset.updateResults,
    mcpAuth: dataset.mcpAuth,
    configBackups: dataset.configBackups,
    repoMap: dataset.repoMap,
    // Repo-committed guidance snapshots (#1302): non-signal aggregate; the
    // engine's attach pass turns them into "Learn More" references.
    externalGuidance: dataset.externalGuidance,
    // Per-project memory store + MEMORY.md index (#1965): non-signal aggregate,
    // the seam the #1779 memory-hygiene detector reads. Built fresh from a local
    // memory walk (#1990); sourceSignature() covers the memory dirs/files so an
    // edit invalidates the recs cache. Empty (`[]`) when no memory dirs exist or
    // on the SPA/upload dataset, so the detector simply emits nothing there.
    memoryStores: readMemoryStores(),
    // Git delivery-outcome rows (#1757): non-signal aggregate computed in
    // assembleDataset (opt-in `gh` fetch + pure classify). SIGNAL ONLY — no
    // detector reads it yet; empty unless CHD_GIT_OUTCOMES names a repo.
    gitOutcomes: dataset.gitOutcomes,
    // Repo doc graph (#2257): non-signal aggregate, the seam the
    // doc-hygiene detector (epic #2256) reads. Built fresh from a LOCAL walk of
    // this repo's own Markdown; empty on the SPA/upload dataset or when docs are
    // absent, so the detector simply emits nothing there.
    docGraph: dataset.docGraph ?? readDocGraph(),
    // Optional host-produced Lychee output. Flag-off runner operation is local
    // and offline; ingest only reads the persisted JSON and never invokes a
    // checker or makes an external call.
    docHygieneArtifact: readDocHygieneArtifact(),
  });
  return { input, sessions };
}

export function assembleRecommendations(project, options = {}) {
  return assembleRecommendationResult(project, options).recommendations;
}

export function assembleRecommendationResult(project, options = {}) {
  const { input, sessions } = assembleRecommendationContext(options);
  // Back-fill each rec's `estSavingsUsd` from its booked cascade marginal so the
  // served per-card dollar figure is the deduped, residual-guarded slice of the
  // bill (#944) — NOT the raw, possibly-overlapping detector estimate. Run on
  // the global recs before any project slice so the cascade dedup is computed
  // over the full lever set (dc-reclaim-1).
  const result = buildRecommendationResult(input, options.now);
  // Drop findings the user explicitly rejected (#2206, epic #1298) BEFORE the
  // reclaim cascade. A REJECTED adoption receipt suppresses its finding from
  // output; reversible via an un-reject (active:false) receipt. The rejected set
  // is read by the async caller (server/worker, which own the receipts path) and
  // threaded in via options; absent/empty -> no suppression, so non-server
  // callers and the SPA path stay byte-identical. Suppress first so
  // backfillReclaimSavings books the guarded-marginal cascade over ONLY the
  // surviving cards — otherwise a hidden rejected card consumes residual budget
  // and undercounts the visible card's estSavingsUsd.
  const surviving = suppressRejectedRecommendations(
    result.recommendations,
    options.rejectedFindingIds ?? new Set()
  );
  const recs = backfillReclaimSavings(surviving, input.tokenData);
  return {
    ...result,
    recommendations: project
      ? filterRecommendationsByProject(recs, project, sessions)
      : recs,
  };
}

// Adapt the lighter recommendation dataset into a full {@link ViewData} shape so
// the extracted masthead filters (view-scope.ts) can run over it byte-identically
// to the browser. `sessions`/`projects` are derived exactly as the client does
// (groupBySessions -> groupByProjects); the two ViewData collections the recs
// dataset does not carry (`memories`, `permissionChanges`) default to empty so a
// filter field-map never dereferences undefined. No served detector reads either,
// so the served recs stay byte-identical.
function recommendationDatasetToViewData(dataset, sessions, projects) {
  return {
    ...dataset,
    sessions,
    projects,
    memories: dataset.memories ?? [],
    permissionChanges: dataset.permissionChanges ?? [],
  };
}

// Typed, scope-exact recommendation analysis for the browser viewer surfaces
// (#2718, epic #2443). Returns the `{ recommendations, domainCoverage }` envelope
// `buildRecommendationResult` produces, computed over an input scoped EXACTLY like
// the corresponding client surface:
//   * `surface: 'global'` — the masthead time+project filter (dashboardTime,
//     dashboardProject) applied to the ViewData, mapped through the canonical
//     `recommendationViewsFromViewData` envelope. Equals what the browser
//     Recommendations/Home/Ask-Claude views compute today under those filters.
//   * `surface: 'reclaim-compass'` — the same masthead scope, THEN the Cost route
//     filter (routeProject/routeDate/routeMode/routeEntrypoint), then the reduced
//     engine input the Reclaim card feeds today (the three route-scoped Cost
//     collections; the other three required base fields empty; optionals omitted).
// Rejected-finding receipts suppress on BOTH surfaces (options.rejectedFindingIds).
// The masthead/route filter code is the SAME pure code the UI runs, so parity is
// structural. This path never emits suppression-transition receipts — that
// canonical side effect belongs only to the unfiltered global legacy route.
export function assembleScopedRecommendationResult(
  surface,
  filters = {},
  options = {}
) {
  const dataset = options.dataset ?? assembleRecommendationDataset();
  const sessions = groupBySessions(dataset.entries);
  const projects = groupByProjects(sessions);
  const viewData = recommendationDatasetToViewData(dataset, sessions, projects);
  // Default to the browser's default masthead (DEFAULT_DASHBOARD_FILTER: 24h +
  // All projects) when a direct caller omits a field, so a programmatic call
  // matches the HTTP contract's defaults instead of silently widening to the
  // whole corpus. The HTTP path always passes an explicit, validated tuple.
  const mastheadFilter = {
    time: filters.dashboardTime ?? DEFAULT_TIME_PRESET,
    project: filters.dashboardProject ?? ALL_PROJECTS,
  };
  const scoped = filterViewDataByProject(
    filterViewDataByTime(viewData, mastheadFilter),
    mastheadFilter
  );
  let views;
  if (surface === 'reclaim-compass') {
    const routeFilter = {};
    if (filters.routeProject) routeFilter.project = filters.routeProject;
    if (filters.routeDate) routeFilter.date = filters.routeDate;
    if (filters.routeMode) routeFilter.mode = filters.routeMode;
    if (filters.routeEntrypoint) routeFilter.entrypoint = filters.routeEntrypoint;
    const scopedCost = filterCostDataByRoute(
      scoped.tokenData,
      scoped.toolData,
      scoped.sessions,
      routeFilter
    );
    views = reclaimScopedInput(scopedCost);
  } else {
    views = {
      ...recommendationViewsFromViewData(scoped),
      // The browser dataset has no organization identity, but enterprise server
      // requests do. Preserve that server-side enrichment on the global typed
      // surface so owner/reviewer alias grouping and provenance match the legacy
      // route. Reclaim deliberately keeps its reduced, optional-signal-free input.
      organizationIdentity: options.organizationIdentity ?? null,
    };
  }
  const input = assembleRecommendationInput(views);
  const result = buildRecommendationResult(input, options.now);
  const recommendations = suppressRejectedRecommendations(
    result.recommendations,
    options.rejectedFindingIds ?? new Set()
  );
  return { recommendations, domainCoverage: result.domainCoverage };
}

/**
 * Engine-loop suppression-transition emit (#576, epic #573; ADR 0005). Computes
 * the `claudeMdMarksApplied()` FIRING→SUPPRESSED transition over the current
 * dataset and writes one `SUPPRESSED` adoption receipt per finding's first
 * attributed flip through #575's allowlist-drop, killswitch-aware writer. The
 * prior-receipt index gates the diff: a finding needs a prior `SURFACED` entry
 * to be coached, and one already-written `SUPPRESSED` entry makes a re-run a
 * no-op (idempotent). Returns the result for logging; never throws on a write
 * error (best-effort, like the rest of the recs route's side effects).
 */
export async function recordSuppressionTransitions(receiptsFile, opts = {}) {
  const { organizationIdentity = null, dataset = undefined, ...receiptOpts } = opts;
  const prior = await readAdoptionReceiptIndex(receiptsFile);
  const { input } = assembleRecommendationContext({ organizationIdentity, dataset });
  const result = await computeSuppressionTransitions(input, {
    surfacedFindingIds: prior.surfacedFindingIds,
    suppressedFindingIds: prior.suppressedFindingIds,
  });
  let written = 0;
  for (const t of result.transitions) {
    const r = await appendAdoptionReceipt(receiptsFile, t, receiptOpts);
    if (r.ok && r.written) written += 1;
  }
  return { ...result, written };
}

// Live Session widget backend (#131). Detects the single in-flight transcript
// — the one whose newest event is the most recent AND less than
// IDLE_TURN_THRESHOLD_MS (15 min) old — and returns just enough to render the
// landing widget: tokens burned so far, model in use, context % full, and time
// since the last user turn. This reads the active transcript DIRECTLY off disk
// rather than going through the SQLite ingest cache, because an in-place append
// to a live <session>.jsonl does NOT move the source signature the dataset
// route gates on (POSIX dir-mtime semantics — see sourceSignature()), so the
// cached dataset lags an active session by design. Liveness must not.
//
// The file-reading helpers + the "why" badge (re-read loop / retry storm) live
// in src/lib/live-session.ts as of #627 (slice 2): computeLiveSession() here is
// a thin wrapper that injects the session-discovery dep (listSessionsCached).

// Memoized listSessions() for the live route (#266 review #1). listSessions()
// walks bounded project/session/subagent directory entries; on a slow bind-mount,
// doing that synchronously on every 10s poll can stack polls and block the event
// loop (delaying the dataset route too). The session *set* only changes when a
// session/project file is added/removed/renamed — exactly what sourceSignature()
// already fingerprints for the dataset route — so we reuse that signature to
// skip the re-walk when it hasn't moved. Per-file mtime stats (the cheap part)
// still run each poll to find the freshest candidate, including a live in-place
// append the signature can't see.
let liveSessionsCache = null; // { sig, sessions }
function listSessionsCached() {
  const sig = sourceSignature();
  if (liveSessionsCache && liveSessionsCache.sig === sig) {
    return liveSessionsCache.sessions;
  }
  const sessions = listSessions();
  liveSessionsCache = { sig, sessions };
  return sessions;
}

// Thin server wrapper (#627 slice 2). The pure compute — candidate selection,
// transcript reads, liveness, token/pattern parsing — lives in
// src/lib/live-session.ts as liveSession(sessions, now). Here we just inject the
// session-discovery dependency (the memoized listSessionsCached) and the clock,
// keeping computeLiveSession's signature/export surface intact for server.mjs.
export function computeLiveSession(now = Date.now()) {
  return liveSession(listSessionsCached(), now);
}
