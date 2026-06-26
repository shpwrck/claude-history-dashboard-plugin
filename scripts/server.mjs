#!/usr/bin/env node
// Live backend for the Claude History Dashboard.
//
// Serves the built SPA from dist/, but computes the data routes live from
// ~/.claude on every request so the dashboard's "Reload from disk" button
// reflects the current state without a rebuild:
//
//   GET /sessions-manifest.json        -> live list of top-level session files
//   GET /projects/<proj>/<id>.jsonl    -> session file + merged subagents/*.jsonl
//   GET /history.jsonl                 -> ~/.claude/history.jsonl
//   GET /api/sources/<sourceId>/sessions/<proj>/<id>.jsonl
//   GET /api/sources/<sourceId>/history.jsonl
//   everything else                    -> static file from dist/ (SPA fallback)
//
// Env: HOST (default 127.0.0.1), PORT (default 5173). The mutating policy route
//      is defended by a per-process token + same-origin Origin + application/
//      json content-type (#308/#311); the network boundary is a loopback-bound
//      published port, not the (NAT'd) peer address.

import { createServer } from 'node:http';
import { appendFile, chmod, mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { closeSync, constants as fsConstants, createReadStream, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, normalize, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzip,
  gzipSync,
  constants as zconstants,
} from 'node:zlib';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

// Async (libuv-threadpool) compressors. Unlike the *Sync variants these run the
// CPU-heavy brotli/gzip work OFF the event loop, so compressing the multi-MB
// dataset no longer stalls every concurrent request (health checks, static
// assets, other /api routes) for the ~310 ms+ compress window. See #1015.
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
import {
  ingest,
  assembleDataset,
  assembleRecommendations,
  loadDatasetCache,
  loadLatestDatasetCache,
  saveDatasetCache,
  sourceSignature,
  getTranscript,
  getSessionTimelineDetail,
  getSessionToolDetail,
  ARTIFACT_FILE_MAX_BYTES,
  ARTIFACT_DIR_MAX_ENTRIES,
  ARTIFACT_CACHE_JSON_MAX_BYTES,
  DATASET_RESPONSE_MAX_BYTES,
  SIGNATURE_TREE_MAX_ENTRIES,
  REPO_MAP_ARTIFACT_MAX_ENTRIES,
  CONFIG_FILE_MAX_BYTES,
  CONFIG_RESOURCE_MAX_ENTRIES,
  INGEST_SESSION_MAX_BYTES,
  INGEST_SESSION_MAX_PARTS,
  INGEST_PROJECT_MAX_DIRS,
  INGEST_SESSION_DISCOVERY_MAX_ENTRIES,
  LIVE_SESSION_MAX_BYTES,
  computeLiveSession,
  recordSuppressionTransitions,
  refreshReviewEvents,
} from './ingest.mjs';
import {
  readWorkflows,
  WORKFLOW_MANIFEST_MAX_BYTES,
  WORKFLOW_RUN_MAX_ENTRIES,
  WORKFLOW_PHASE_MAX_ENTRIES,
  WORKFLOW_PROGRESS_MAX_ENTRIES,
  WORKFLOW_FIELD_MAX_CHARS,
} from './read-workflows.mjs';
import { listNestedWorkflowAgentTranscripts } from './workflow-transcripts.mjs';
import { resolveStatGatedCache } from './lib/stat-gated-cache.mjs';

const PROJECT_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const { resolveSources } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'sources.ts')
);
const DATA_SOURCES = resolveSources({ env: process.env, homeDir: homedir() });
const DEFAULT_SOURCE = DATA_SOURCES[0];
const DATA_SOURCE_BY_ID = new Map(DATA_SOURCES.map((source) => [source.id, source]));
const PROJECTS = DEFAULT_SOURCE.historyDir;
const CLAUDE = dirname(PROJECTS);
// CHD_CACHE_DIR: all install-dir runtime writes land here so a plugin reinstall
// never clobbers accumulated state. Defaults to ~/.claude/.cache/chd/ — a
// subdirectory of the Claude data root that survives plugin updates.
// Individual path overrides (*_PATH env vars) take precedence when set;
// CHD_CACHE_DIR is only the fallback base for any path not explicitly overridden.
// Reuses the same env var as ingest.mjs so a single override covers both (#1336).
const CHD_CACHE_DIR =
  process.env.CHD_CACHE_DIR || join(CLAUDE, '.cache', 'chd');
// The usage-gauge core (#626) lives in src/lib/*.ts so its pure logic
// (credential walk, header parsing, payload assembly) is unit-testable without
// booting a server. Imported dynamically (like ingest.mjs's .ts parsers) so it
// resolves under the register-ts loader the container launches with.
const { findAccessToken, buildUsagePayload } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'usage-gauge.ts')
);
const { hybridSearchEntries } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'hybrid-search.ts')
);
// Policy write-back core (#625) lives in src/lib/policy-writer.ts — the pure
// validate/merge/dedupe steps + the backup/write contract for the one route
// that mutates ~/.claude/settings.json. Imported dynamically (like the .ts
// parsers in ingest.mjs) so it resolves under the register-ts loader the
// container launches with.
const { validatePolicyInput, applyPolicyWrite } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'policy-writer.ts')
);
const {
  ADOPTION_RECEIPT_LINE_MAX_BYTES,
  appendAdoptionReceipt,
  readAdoptionReceipts,
} = await import(join(PROJECT_DIR, 'src', 'lib', 'adoption-receipts.ts'));
const { parseGitHubReviewSyncConfig } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'github-review-sync.ts')
);
// Boot-time drain of the recs adoption-receipt SPOOL (#581): when the dashboard
// was down, the SessionStart recs hook appended SURFACED receipts to a
// dashboard-owned spool instead of POSTing; on boot we flush that spool into the
// canonical receipts log through the same fail-closed allowlist sanitizer.
const { drainAdoptionSpoolQuiet } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'adoption-spool.ts')
);
// JSON export validity (#1104): served JSON bodies are scrubbed of lone UTF-16
// surrogates before serialization so strict (non-JS) parsers don't reject the
// `\udXXX` escapes JSON.stringify well-forms them into. Same register-ts
// dynamic import as the helpers above.
const { safeJsonStringify } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'json-safe.ts')
);
// Single-serialization dataset body + ETag-stable bytes (#2070). Same register-ts
// dynamic import as the helpers above.
const { buildDatasetBody } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'dataset-body.ts')
);
// Restores the zero-valued tokenData numerics that buildDatasetBody slims out of
// the wire (#2107), for the one server path that re-parses the slimmed cache JSON
// instead of the full in-memory dataset (the LLM-audit route below).
const { rehydrateDataset } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'dataset-slim.ts')
);
// Server LLM calls are registered and enforced through this chokepoint (#931).
const { callAnthropic, callAnthropicMessages, egressScrub } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'anthropic-egress.ts')
);
const { getLlmUsageEntry } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'llm-registry.ts')
);
// Tier-3 judge-audit harness (#605/#738) lives in src/lib/audit/judge.ts.
// The route injects a governed chat function rather than letting the audit core
// own network egress, so the SPA bundle and browser client stay decoupled.
const { runAudits, makeClaudeJudge, makeClaudeDraftJudge } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'audit', 'judge.ts')
);
const { CURRENT_MODEL_IDS } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'model-registry.ts')
);
// Per-session estimated cost ($) feeds the agentic-opportunity audit's
// displaced-cost weighting (#741).
const { topExpensiveSessions } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'cost-attribution.ts')
);
const { groupBySessions, groupByProjects } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-history.ts')
);
const {
  buildDailyDigest,
  isDailyDigestDate,
  todayDigestDate,
} = await import(join(PROJECT_DIR, 'src', 'lib', 'build-daily-digest.ts'));
const { estimateCost, isUnattendedEntrypoint } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-sessions.ts')
);
const { aggregateTools } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-tools.ts')
);
const {
  aggregatePermissionModes,
  computeSafetyScores,
  detectDangerousCommands,
} = await import(join(PROJECT_DIR, 'src', 'lib', 'parse-permissions.ts'));
// Per-session good/bad outcome flag feeds the skill-candidate audit's
// successful-trajectory filter (#739). Same labels-first / proxy-fallback rule
// the habit-impact view uses; server-side the tags map is empty (labels live in
// the browser), so every outcome resolves via the cost+cleanliness proxy.
const { computeSessionOutcomes } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-timeline-success.ts')
);
// High-churn files corroborate the boomerang/rework-rate audit's per-session
// rework signal (#742) — the same topChurnFiles >= HIGH_CHURN signal behind the
// workflow.file-churn detector.
const { topChurnFiles } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-files.ts')
);
const { HIGH_CHURN } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'detectors', 'shared.ts')
);
// DIST_DIR/CLAUDE_DIR overrides exist only so the route tests can point the
// server at throwaway temp dirs (see scripts/policy-write.test.mjs). In the
// container neither is set, so these resolve to the real bundled dist/ and the
// bind-mounted ~/.claude exactly as before.
const DIST = process.env.DIST_DIR || join(PROJECT_DIR, 'dist');
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

const PROJECT_ROOTS = uniqueProjectsRoots([
  PROJECTS,
  ...projectsRootsFromEnv('DASHBOARD_HUB_PROJECTS_DIR'),
  ...projectsRootsFromEnv('CLAUDE_HUB_PROJECTS_DIR'),
  ...projectsRootsFromEnv('CLAUDE_HUB_DIR', true),
]);
const SHADOW_CALLS_DIR = join(CLAUDE, 'shadow-calls');
// All runtime writes below default to CHD_CACHE_DIR so they land outside the
// plugin install dir and survive updates (#1336). Individual *_PATH overrides
// take precedence when explicitly set (test / container / custom-deploy use cases).
const ADOPTION_RECEIPTS =
  process.env.ADOPTION_RECEIPTS_PATH ||
  join(CHD_CACHE_DIR, 'adoption-receipts.jsonl');
const ENTERPRISE_AUDIT_LOG =
  process.env.ENTERPRISE_AUDIT_LOG_PATH ||
  join(CHD_CACHE_DIR, 'enterprise-audit.jsonl');
const ENTERPRISE_AUDIT_FILE_MODE = 0o600;
// Dashboard-owned spool the SessionStart recs hook appends to when the server is
// down (#581). Drained into ADOPTION_RECEIPTS on boot. Sibling of the receipts
// log in the same dashboard data dir — NEVER under the install dir.
const ADOPTION_SPOOL =
  process.env.ADOPTION_SPOOL_PATH ||
  join(CHD_CACHE_DIR, 'adoption-spool.jsonl');
const REVIEW_EVENTS_CACHE =
  process.env.DASHBOARD_REVIEW_EVENTS_CACHE_PATH ||
  join(CHD_CACHE_DIR, 'review-events', 'github-review-events.json');
// Default to loopback (#308): the dashboard's original mutating route
// (POST /api/policy/write) edits the user's global ~/.claude/settings.json,
// which gates destructive-command permissions. Binding 0.0.0.0 by default
// exposed that write to the whole LAN. An operator can still set HOST=0.0.0.0
// behind a trusted proxy, but write routes require a same-origin browser Origin,
// a per-process CSRF token, and optionally exact public origins configured in
// DASHBOARD_ALLOWED_ORIGINS.
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parsePortEnv('PORT', 5173);
const DASHBOARD_REQUEST_TIMEOUT_MS = parseBoundedTimeoutMs(
  'DASHBOARD_REQUEST_TIMEOUT_MS',
  120_000,
  1_000,
  3_600_000
);
const DASHBOARD_HEADERS_TIMEOUT_MS = Math.min(
  DASHBOARD_REQUEST_TIMEOUT_MS,
  parseBoundedTimeoutMs('DASHBOARD_HEADERS_TIMEOUT_MS', 60_000, 1_000, 600_000)
);
const DASHBOARD_KEEP_ALIVE_TIMEOUT_MS = parseBoundedTimeoutMs(
  'DASHBOARD_KEEP_ALIVE_TIMEOUT_MS',
  5_000,
  1_000,
  120_000
);
const DASHBOARD_SOCKET_TIMEOUT_MS = parseBoundedTimeoutMs(
  'DASHBOARD_SOCKET_TIMEOUT_MS',
  120_000,
  1_000,
  3_600_000
);
const DASHBOARD_ENABLE_HSTS = parseBooleanEnv('DASHBOARD_ENABLE_HSTS');
const DASHBOARD_ENABLE_SERVER_LLM_AUDITS = parseBooleanEnv(
  'DASHBOARD_ENABLE_SERVER_LLM_AUDITS'
);
// Fail-closed feature gate (#1581): the audit-judge path may only egress when
// its registered scrub is the transmission-grade redactor. If the registry is
// reverted to the identity 'stub' (or any non-'redact' mode), the feature
// disables itself instead of leaking unredacted transcript content — even when
// the operator opt-in flag above is set.
const SERVER_AUDIT_EGRESS_SCRUB_READY =
  getLlmUsageEntry('server.audit-judge')?.egressScrub === 'redact';
const DASHBOARD_ENABLE_SERVER_USAGE_GAUGE = parseBooleanEnv(
  'DASHBOARD_ENABLE_SERVER_USAGE_GAUGE'
);
const DASHBOARD_ENABLE_BROWSER_LLM_EGRESS = parseBooleanEnv(
  'DASHBOARD_ENABLE_BROWSER_LLM_EGRESS'
);
const DASHBOARD_TRUST_PROXY_HEADERS = parseBooleanEnv(
  'DASHBOARD_TRUST_PROXY_HEADERS'
);
const DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES = Math.max(
  128,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES', 16_384)
  )
);
const DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    4_096,
    parseNonNegativeIntEnv('DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES', 64)
  )
);
const {
  addresses: DASHBOARD_TRUSTED_PROXY_ADDRESSES,
  invalidCount: DASHBOARD_TRUSTED_PROXY_ADDRESS_INVALID_COUNT,
  maxBytesExceeded: DASHBOARD_TRUSTED_PROXY_ADDRESS_MAX_BYTES_EXCEEDED,
  entryLimitExceeded: DASHBOARD_TRUSTED_PROXY_ADDRESS_ENTRY_LIMIT_EXCEEDED,
} = parseTrustedProxyAddresses('DASHBOARD_TRUSTED_PROXY_ADDRESSES');
const DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES = Math.max(
  128,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES', 16_384)
  )
);
const DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    4_096,
    parseNonNegativeIntEnv('DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES', 64)
  )
);
const {
  origins: DASHBOARD_ALLOWED_ORIGINS,
  invalidCount: DASHBOARD_ALLOWED_ORIGIN_INVALID_COUNT,
  maxBytesExceeded: DASHBOARD_ALLOWED_ORIGIN_MAX_BYTES_EXCEEDED,
  entryLimitExceeded: DASHBOARD_ALLOWED_ORIGIN_ENTRY_LIMIT_EXCEEDED,
} = parseAllowedOriginEnv('DASHBOARD_ALLOWED_ORIGINS');
const DASHBOARD_WRITE_ORIGINS = Array.from(
  new Set(
    [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `http://[::1]:${PORT}`,
      `https://127.0.0.1:${PORT}`,
      `https://localhost:${PORT}`,
      `https://[::1]:${PORT}`,
      ...DASHBOARD_ALLOWED_ORIGINS,
    ]
      .map((value) => normalizeAllowedOrigin(value))
      .filter(Boolean)
  )
);
const ENTERPRISE_SCOPE_ENFORCEMENT = parseBooleanEnv(
  'DASHBOARD_AUTH_ENFORCE_SCOPES'
);
const DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES = Math.max(
  512,
  Math.min(
    65_536,
    parseNonNegativeIntEnv(
      'DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES',
      16_384
    )
  )
);
const {
  policy: DASHBOARD_CONTENT_SECURITY_POLICY_OVERRIDE,
  maxBytesExceeded: DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES_EXCEEDED,
} = parseContentSecurityPolicyOverride('DASHBOARD_CONTENT_SECURITY_POLICY');
const ENTERPRISE_RATE_LIMIT_WINDOW_MS = parseNonNegativeIntEnv(
  'ENTERPRISE_RATE_LIMIT_WINDOW_MS',
  60_000
);
const ENTERPRISE_AUTH_RATE_LIMIT = parseNonNegativeIntEnv(
  'ENTERPRISE_AUTH_RATE_LIMIT',
  120
);
const ENTERPRISE_API_RATE_LIMIT = parseNonNegativeIntEnv(
  'ENTERPRISE_API_RATE_LIMIT',
  1_200
);
const ENTERPRISE_RATE_LIMIT_MAX_BUCKETS = Math.max(
  1_000,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('ENTERPRISE_RATE_LIMIT_MAX_BUCKETS', 50_000)
  )
);
const ENTERPRISE_RAW_TOKEN_MIN_LENGTH = Math.min(
  4_096,
  parseNonNegativeIntEnv('DASHBOARD_AUTH_MIN_TOKEN_LENGTH', 32)
);
const ENTERPRISE_MAX_BEARER_TOKEN_BYTES = Math.max(
  256,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_MAX_BEARER_BYTES', 8_192)
  )
);
const DASHBOARD_BASIC_AUTH_MAX_BYTES = Math.max(
  128,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_BASIC_AUTH_MAX_BYTES', 8_192)
  )
);
const DASHBOARD_BASIC_AUTH_HEADER_MAX_BYTES = Math.min(
  262_144,
  DASHBOARD_BASIC_AUTH_MAX_BYTES * 3
);
const ENTERPRISE_SESSION_COOKIE_NAME = 'chd_enterprise_session';
const ENTERPRISE_SESSION_COOKIE_MAX_BYTES = 4_096;
const ENTERPRISE_SESSION_COOKIE_AAD = Buffer.from('claude-history-dashboard.enterprise-session.v1');
const ENTERPRISE_SESSION_SECRET_MIN_BYTES = 32;
const ENTERPRISE_SESSION_SECRET_MAX_BYTES = 4_096;
const ENTERPRISE_SESSION_EPOCH_MAX_BYTES = 1_024;
const ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS = Math.max(
  60,
  Math.min(
    604_800,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS', 28_800)
  )
);
const ENTERPRISE_SESSION_COOKIE_SECURE =
  DASHBOARD_ENABLE_HSTS || parseBooleanEnv('DASHBOARD_AUTH_SESSION_COOKIE_SECURE');
const ENTERPRISE_SESSION_EPOCH_CONFIG = enterpriseSessionEpochConfig();
const ENTERPRISE_SESSION_SECRET_CONFIG = enterpriseSessionSecretConfig();
const ENTERPRISE_AUTH_TOKENS_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_TOKENS_MAX_BYTES', 1_048_576)
  )
);
const ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    4_096,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_TOKENS_MAX_ENTRIES', 256)
  )
);
const ENTERPRISE_ORG_PRINCIPAL_MAX_LIMIT = Math.max(
  1,
  Math.min(
    50_000,
    parseNonNegativeIntEnv('ENTERPRISE_ORG_PRINCIPAL_MAX_LIMIT', 5_000)
  )
);
const ENTERPRISE_ORG_PRINCIPAL_DEFAULT_LIMIT = Math.max(
  1,
  Math.min(
    ENTERPRISE_ORG_PRINCIPAL_MAX_LIMIT,
    parseNonNegativeIntEnv('ENTERPRISE_ORG_PRINCIPAL_DEFAULT_LIMIT', 500)
  )
);
const DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES = Math.max(
  1,
  Math.min(
    268_435_456,
    parseNonNegativeIntEnv('DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES', 16_777_216)
  )
);
const DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES', 50_000)
  )
);
const ENTERPRISE_AUDIT_READ_MAX_BYTES = Math.max(
  8_192,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv('ENTERPRISE_AUDIT_READ_MAX_BYTES', 1_048_576)
  )
);
const ENTERPRISE_AUDIT_LINE_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('ENTERPRISE_AUDIT_LINE_MAX_BYTES', 65_536)
  )
);
const ENTERPRISE_AUDIT_ACTIVITY_SUMMARY_MAX_EVENTS = 250;
const DASHBOARD_ADOPTION_RECEIPT_READ_MAX_BYTES = Math.max(
  8_192,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv(
      'DASHBOARD_ADOPTION_RECEIPT_READ_MAX_BYTES',
      1_048_576
    )
  )
);
const ENTERPRISE_AUDIT_ROTATE_MAX_BYTES = Math.min(
  1_073_741_824,
  parseNonNegativeIntEnv('ENTERPRISE_AUDIT_ROTATE_MAX_BYTES', 67_108_864)
);
const ENTERPRISE_AUDIT_ROTATE_MAX_FILES = Math.min(
  50,
  parseNonNegativeIntEnv('ENTERPRISE_AUDIT_ROTATE_MAX_FILES', 5)
);
const ENTERPRISE_SCOPED_DATASET_MAX_STATES = Math.max(
  1,
  Math.min(
    5_000,
    parseNonNegativeIntEnv('ENTERPRISE_SCOPED_DATASET_MAX_STATES', 500)
  )
);
const DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    10_000,
    parseNonNegativeIntEnv('DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES', 256)
  )
);
// Bounds for the per-state /api/digest and /api/search response caches (#1573).
// Search keys include the free-text query, so its cache can hold more distinct
// keys than digest (one per date) under varied traffic; both stay LRU-bounded.
const DASHBOARD_DIGEST_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.min(10_000, parseNonNegativeIntEnv('DASHBOARD_DIGEST_CACHE_MAX_ENTRIES', 64))
);
const DASHBOARD_SEARCH_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.min(10_000, parseNonNegativeIntEnv('DASHBOARD_SEARCH_CACHE_MAX_ENTRIES', 256))
);
const DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES = Math.max(
  1,
  Math.min(
    536_870_912,
    parseNonNegativeIntEnv(
      'DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES',
      67_108_864
    )
  )
);
const DASHBOARD_AUDIT_RESPONSE_MAX_BYTES = Math.max(
  1,
  Math.min(
    67_108_864,
    parseNonNegativeIntEnv('DASHBOARD_AUDIT_RESPONSE_MAX_BYTES', 4_194_304)
  )
);
const DASHBOARD_AUDIT_MAX_JUDGE_CALLS = Math.min(
  10_000,
  parseNonNegativeIntEnv('DASHBOARD_AUDIT_MAX_JUDGE_CALLS', 64)
);
const DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS = Math.max(
  1,
  Math.min(
    8_192,
    parseNonNegativeIntEnv('DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS', 1_024)
  )
);
const DASHBOARD_AUDIT_MODEL =
  process.env.DASHBOARD_AUDIT_MODEL || CURRENT_MODEL_IDS.sonnet;
const DASHBOARD_AUDIT_INPUT_MAX_ROWS = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_AUDIT_INPUT_MAX_ROWS', 50_000)
  )
);
const DASHBOARD_MUTATING_BODY_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('DASHBOARD_MUTATING_BODY_MAX_BYTES', 1_048_576)
  )
);
const DASHBOARD_RAW_FILE_MAX_BYTES = Math.max(
  65_536,
  Math.min(
    536_870_912,
    parseNonNegativeIntEnv('DASHBOARD_RAW_FILE_MAX_BYTES', 67_108_864)
  )
);
const DASHBOARD_RAW_SESSION_MAX_PARTS = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_RAW_SESSION_MAX_PARTS', 10_000)
  )
);
const DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES = Math.max(
  65_536,
  Math.min(
    536_870_912,
    parseNonNegativeIntEnv(
      'DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES',
      DASHBOARD_RAW_FILE_MAX_BYTES
    )
  )
);
const DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES', 65_536)
  )
);
const DASHBOARD_MEMORY_FILE_MAX_BYTES = Math.max(
  256,
  Math.min(
    16_777_216,
    parseNonNegativeIntEnv('DASHBOARD_MEMORY_FILE_MAX_BYTES', 262_144)
  )
);
const DASHBOARD_MEMORY_RESPONSE_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    67_108_864,
    parseNonNegativeIntEnv('DASHBOARD_MEMORY_RESPONSE_MAX_BYTES', 4_194_304)
  )
);
const DASHBOARD_MEMORY_MAX_FILES = Math.max(
  1,
  Math.min(1_000_000, parseNonNegativeIntEnv('DASHBOARD_MEMORY_MAX_FILES', 50_000))
);
const DASHBOARD_MEMORY_DIR_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_MEMORY_DIR_MAX_ENTRIES', 50_000)
  )
);

// Per-process CSRF/auth token for the mutating policy route (#308). Generated
// fresh on every boot so it can't be guessed or replayed across restarts. The
// SPA fetches it from the same-origin GET /api/csrf-token bootstrap (which a
// cross-origin attacker page cannot read), then sends it back as a Bearer/
// X-CSRF-Token header on the write. A test override (POLICY_WRITE_TOKEN) lets
// the route test assert exact match/mismatch behavior deterministically.
const POLICY_WRITE_TOKEN_MAX_BYTES = 8_192;
const POLICY_WRITE_TOKEN_CONFIG = parsePolicyWriteTokenEnv('POLICY_WRITE_TOKEN');
const POLICY_WRITE_TOKEN = POLICY_WRITE_TOKEN_CONFIG.token || randomBytes(32).toString('hex');

// Brotli quality used when (re)building the cached dataset buffer. The
// 8–9 MB dataset JSON takes ~18.7 s to compress at q=11 vs ~310 ms at q=5
// on the same input — 60×+ faster for a body only ~24% larger. Since the
// real bottleneck of first-data latency was this single sync compress call
// (see docs/perf-sprint/baseline.md), q=5 is the better tradeoff. Easy to
// raise back up here if disk/wire ever becomes the bottleneck instead.
const DATASET_BROTLI_QUALITY = 5;
const STATIC_COMPRESS_MAX_BYTES = 8_388_608;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function live(res, type) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Source', 'live'); // marks a dynamically-computed response
  res.setHeader('Content-Type', type);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', dashboardContentSecurityPolicy());
  if (DASHBOARD_ENABLE_HSTS) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains'
    );
  }
}

function dashboardContentSecurityPolicy() {
  if (DASHBOARD_CONTENT_SECURITY_POLICY_OVERRIDE) {
    return DASHBOARD_CONTENT_SECURITY_POLICY_OVERRIDE;
  }
  const connectSrc = ["connect-src 'self'"];
  if (!ENTERPRISE_AUTH_ON || DASHBOARD_ENABLE_BROWSER_LLM_EGRESS) {
    connectSrc.push('https://api.anthropic.com');
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    connectSrc.join(' '),
    "worker-src 'self' blob:",
  ].join('; ');
}

function parseContentSecurityPolicyOverride(name) {
  const raw = String(process.env[name] || '');
  if (
    Buffer.byteLength(raw, 'utf8') >
    DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES
  ) {
    return {
      policy: '',
      maxBytesExceeded: true,
    };
  }
  return {
    policy: raw,
    maxBytesExceeded: false,
  };
}

function revalidatingLiveCacheControl() {
  return ENTERPRISE_AUTH_ON ? 'no-store' : 'no-cache';
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function parsePortEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 65_535
  ) {
    throw new Error(
      `${name} must be an integer between 1 and 65535; got ${JSON.stringify(raw)}`
    );
  }
  return parsed;
}

function parseBoundedTimeoutMs(name, fallback, min, max) {
  return Math.max(min, Math.min(max, parseNonNegativeIntEnv(name, fallback)));
}

function parsePolicyWriteTokenEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) {
    return {
      token: '',
      configured: false,
      maxBytesExceeded: false,
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > POLICY_WRITE_TOKEN_MAX_BYTES) {
    return {
      token: '',
      configured: true,
      maxBytesExceeded: true,
    };
  }
  return {
    token: raw,
    configured: true,
    maxBytesExceeded: false,
  };
}

function parseBasicAuthCredentialEnv(name) {
  const raw = String(process.env[name] || '');
  if (!raw) {
    return {
      configured: false,
      digest: null,
      maxBytesExceeded: false,
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > DASHBOARD_BASIC_AUTH_MAX_BYTES) {
    return {
      configured: true,
      digest: null,
      maxBytesExceeded: true,
    };
  }
  return {
    configured: true,
    digest: createHash('sha256').update(raw).digest(),
    maxBytesExceeded: false,
  };
}

function parseBooleanEnv(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function parseBoundedCsvEnv(
  name,
  fallback = [],
  { maxBytes, maxEntries, maxEntryChars } = {}
) {
  const rawConfig = String(process.env[name] || '');
  const raw = rawConfig.trim();
  if (raw && maxBytes && Buffer.byteLength(rawConfig, 'utf8') > maxBytes) {
    return {
      values: [],
      maxBytesExceeded: true,
      entryLimitExceeded: false,
      entrySizeExceeded: false,
    };
  }
  const source = raw ? rawConfig.split(',') : fallback;
  const values = [];
  let entryCount = 0;
  let entryLimitExceeded = false;
  let entrySizeExceeded = false;
  for (const entry of source) {
    const value = String(entry || '').trim().toLowerCase();
    if (!value) continue;
    entryCount += 1;
    if (maxEntries && entryCount > maxEntries) {
      entryLimitExceeded = true;
      break;
    }
    if (maxEntryChars && value.length > maxEntryChars) {
      entrySizeExceeded = true;
      continue;
    }
    values.push(value);
  }
  return {
    values: Array.from(new Set(values)),
    maxBytesExceeded: false,
    entryLimitExceeded,
    entrySizeExceeded,
  };
}

function parseJwtDataRootTemplateEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) {
    return {
      template: '',
      configured: false,
      maxBytesExceeded: false,
    };
  }
  if (
    Buffer.byteLength(raw, 'utf8') >
    ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES
  ) {
    return {
      template: '',
      configured: true,
      maxBytesExceeded: true,
    };
  }
  return {
    template: raw,
    configured: true,
    maxBytesExceeded: false,
  };
}

function parseTrustedProxyAddresses(name) {
  const rawConfig = String(process.env[name] || '');
  if (
    Buffer.byteLength(rawConfig, 'utf8') >
    DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES
  ) {
    return {
      addresses: [],
      invalidCount: 0,
      maxBytesExceeded: true,
      entryLimitExceeded: false,
    };
  }
  const addresses = [];
  let invalidCount = 0;
  let entryCount = 0;
  let entryLimitExceeded = false;
  for (const entry of rawConfig.split(',')) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    entryCount += 1;
    if (entryCount > DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES) {
      entryLimitExceeded = true;
      break;
    }
    const address = normalizePeerAddress(raw);
    if (address) {
      addresses.push(address);
    } else {
      invalidCount += 1;
    }
  }
  return {
    addresses: Array.from(new Set(addresses)),
    invalidCount,
    maxBytesExceeded: false,
    entryLimitExceeded,
  };
}

function normalizeAllowedOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return '';
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
  return parsed.origin;
}

function parseAllowedOriginEnv(name) {
  const rawConfig = String(process.env[name] || '');
  if (
    Buffer.byteLength(rawConfig, 'utf8') >
    DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES
  ) {
    return {
      origins: [],
      invalidCount: 0,
      maxBytesExceeded: true,
      entryLimitExceeded: false,
    };
  }
  const origins = [];
  let invalidCount = 0;
  let entryCount = 0;
  let entryLimitExceeded = false;
  for (const entry of rawConfig.split(',')) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    entryCount += 1;
    if (entryCount > DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES) {
      entryLimitExceeded = true;
      break;
    }
    const origin = normalizeAllowedOrigin(raw);
    if (origin) {
      origins.push(origin);
    } else {
      invalidCount += 1;
    }
  }
  return {
    origins: Array.from(new Set(origins)),
    invalidCount,
    maxBytesExceeded: false,
    entryLimitExceeded,
  };
}

// Pick the best supported encoding from the request's Accept-Encoding header.
// Prefers brotli over gzip; returns null when the client accepts neither.
function negotiateEncoding(req) {
  const header = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (!header) return null;
  // Treat any non-zero-q token as acceptable; a strict q=0 means refused.
  const accepts = (name) => {
    const m = header.match(
      new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q=([0-9.]+))?`)
    );
    if (!m) return false;
    return m[1] === undefined || Number(m[1]) > 0;
  };
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

// Brotli params for a given quality + input size.
function brotliParams(buf, quality) {
  return {
    params: {
      [zconstants.BROTLI_PARAM_QUALITY]: quality,
      [zconstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  };
}

// Compress a buffer with brotli at the given quality (sync — used by the small
// live-body path in sendBody where the body is tiny and the call is rare).
function brotli(buf, quality) {
  return brotliCompressSync(buf, brotliParams(buf, quality));
}

// Async brotli for the large dataset build — runs off the event loop.
function brotliAsync(buf, quality) {
  return brotliCompressAsync(buf, brotliParams(buf, quality));
}

// Send a (possibly large) body, compressing with brotli/gzip when the client
// asks for it. `headers` are applied first so callers can set Content-Type etc.
// Always sets Vary: Accept-Encoding so caches key on the negotiated encoding.
//
// `quality` controls per-request brotli effort (default 5, a cheap level for
// arbitrary live bodies). `precompressed` lets callers hand in already-built
// {br, gz} buffers (e.g. the cached dataset) so we never recompress.
function sendBody(req, res, body, { etag, quality = 5, precompressed } = {}) {
  appendVary(res, 'Accept-Encoding');
  if (etag) res.setHeader('ETag', etag);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const encoding = negotiateEncoding(req);
  let out = buf;
  if (encoding === 'br') {
    res.setHeader('Content-Encoding', 'br');
    out = precompressed?.br ?? brotli(buf, quality);
  } else if (encoding === 'gzip') {
    res.setHeader('Content-Encoding', 'gzip');
    out = precompressed?.gz ?? gzipSync(buf, { level: 6 });
  }
  res.setHeader('Content-Length', out.length);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(out);
}

// Strongly stable ETag for the dataset, computed from an already-serialized
// stable JSON string (everything except the volatile `generatedAt`). Quoted
// per RFC 7232.
function datasetEtagFrom(stableJson) {
  const h = createHash('sha1').update(stableJson).digest('base64');
  return `"${h}"`;
}

// Memoized compressed dataset. The body, ETag, and both compressed buffers are
// all derived from a single stringify + a single full brotli/gzip pass, and
// are only recomputed when the underlying data actually changed. We track the
// `contentHash` from ingest() (a stable fingerprint over every row's signature)
// so that mtime-only bumps on live transcripts — which trigger reparsed > 0
// but produce byte-identical blobs — don't invalidate the cache. See
// docs/perf-sprint/baseline.md and issue #159.
//
// Brotli runs at DATASET_BROTLI_QUALITY (q=5) here rather than q=11 because
// the rebuild path is on the hot first-data request when the cache is cold or
// when content has actually changed. q=11 was a ~19 s sync stall per rebuild
// at this dataset size, where q=5 is ~310 ms for only ~24% larger output.
const GLOBAL_INGEST_API = {
  ingest,
  assembleDataset,
  assembleRecommendations,
  loadDatasetCache,
  loadLatestDatasetCache,
  saveDatasetCache,
  sourceSignature,
  getTranscript,
  getSessionTimelineDetail,
  getSessionToolDetail,
  computeLiveSession,
  recordSuppressionTransitions,
  refreshReviewEvents,
};

function datasetState(apiPromise, key = 'global') {
  return {
    key,
    apiPromise,
    lastAccess: Date.now(),
    datasetCache: null, // { etag, json, brBuf, gzBuf, contentHash }
    datasetRefresh: null,
    // Single-flight guard for the truly-cold (no cache at all) build path so
    // concurrent first requests await one shared async build (#1015).
    datasetColdBuild: null,
    // Bounded response cache for /api/recommendations.json. The dataset route
    // has a compressed-body cache; recommendations are smaller, but still
    // expensive enough to avoid repeat ingest+assemble work under org traffic.
    recommendationsCache: new Map(),
    recommendationsBuilds: new Map(),
    // Bounded response caches for /api/digest and /api/search (#1573). Both
    // routes previously ran a full ingest()+assembleDataset() (and, for search,
    // a score+embed over every entry) on the event loop per request with no
    // gate, single-flight, or cache — head-of-line blocking under concurrency.
    // Mirroring the recommendations machinery: a sourceSignature() stat-gate
    // keys the cache, a `*Builds` Map single-flights concurrent identical
    // requests, and the cache holds the computed response payload. The search
    // key folds in the query + project + limit (the score/embed cost is
    // per-query); the digest key folds in the requested date.
    digestCache: new Map(),
    digestBuilds: new Map(),
    searchCache: new Map(),
    searchBuilds: new Map(),
    // Source signature from the last full ingest() (#182). Lets the dataset
    // handler skip the O(files) ingest walk when a cheap stat signature is
    // unchanged. null until the first ingest runs.
    lastSourceSig: null,
    // One assembled dataset reused per contentHash (#2071). A recs request
    // assembles the ~128 MB dataset twice (recs build + suppression emit); this
    // single slot collapses that to once, and lets consecutive recs requests on
    // the same content skip re-assembly entirely. Overwritten when contentHash
    // moves, so its memory cost is one dataset object bounded by the dataset's
    // own growth. null until the first recs build assembles.
    assembledMemo: null, // { contentHash, dataset }
  };
}

const globalDatasetState = datasetState(Promise.resolve(GLOBAL_INGEST_API));
const scopedDatasetStates = new Map();
let scopedIngestImportQueue = Promise.resolve();

function enterpriseDataRootKey(dataRoot) {
  return createHash('sha256').update(dataRoot).digest('hex').slice(0, 24);
}

function scopedIngestDbPath(dataRoot) {
  return join(
    CHD_CACHE_DIR,
    'enterprise-roots',
    `${enterpriseDataRootKey(dataRoot)}.db`
  );
}

function restoreEnvValue(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function importScopedIngest(dataRoot) {
  const key = enterpriseDataRootKey(dataRoot);
  const next = scopedIngestImportQueue
    .catch(() => {})
    .then(async () => {
      const prevClaudeDir = process.env.CLAUDE_DIR;
      const prevClaudeHomeDir = process.env.CLAUDE_HOME_DIR;
      const prevDbPath = process.env.CHD_DB_PATH;
      const prevScopedIngest = process.env.CHD_SCOPED_INGEST;
      process.env.CLAUDE_DIR = dataRoot;
      process.env.CLAUDE_HOME_DIR = dirname(dataRoot);
      process.env.CHD_DB_PATH = scopedIngestDbPath(dataRoot);
      process.env.CHD_SCOPED_INGEST = '1';
      try {
        return await import(`./ingest.mjs?enterpriseRoot=${key}`);
      } finally {
        restoreEnvValue('CLAUDE_DIR', prevClaudeDir);
        restoreEnvValue('CLAUDE_HOME_DIR', prevClaudeHomeDir);
        restoreEnvValue('CHD_DB_PATH', prevDbPath);
        restoreEnvValue('CHD_SCOPED_INGEST', prevScopedIngest);
      }
    });
  scopedIngestImportQueue = next.catch(() => {});
  return next;
}

function enterpriseRequestUsesGlobalIngest(req) {
  const principal = req.enterprisePrincipal;
  return !ENTERPRISE_AUTH_ON || principal?.role === 'admin' || !principal?.dataRoot;
}

function pruneScopedDatasetStates(activeKey) {
  if (scopedDatasetStates.size <= ENTERPRISE_SCOPED_DATASET_MAX_STATES) return;
  const candidates = [...scopedDatasetStates.entries()]
    .filter(([key]) => key !== activeKey)
    .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
  for (const [key] of candidates) {
    if (scopedDatasetStates.size <= ENTERPRISE_SCOPED_DATASET_MAX_STATES) return;
    scopedDatasetStates.delete(key);
  }
}

function enterpriseRequestDatasetState(req) {
  const principal = req.enterprisePrincipal;
  if (enterpriseRequestUsesGlobalIngest(req)) return globalDatasetState;
  const key = enterpriseDataRootKey(principal.dataRoot);
  let state = scopedDatasetStates.get(key);
  if (!state) {
    state = datasetState(importScopedIngest(principal.dataRoot), key);
    scopedDatasetStates.set(key, state);
  }
  state.lastAccess = Date.now();
  pruneScopedDatasetStates(key);
  return state;
}

async function enterpriseRequestIngestApi(req) {
  return enterpriseRequestDatasetState(req).apiPromise;
}

async function refreshReviewEventsForIngest(ingestApi) {
  if (typeof ingestApi.refreshReviewEvents !== 'function') return null;
  return ingestApi.refreshReviewEvents();
}

// Shared ingest preamble for the dataset-bearing routes (#2076). Every one of
// /api/dataset.json, /api/recommendations.json, /api/digest and /api/search
// resolved the per-request dataset state, awaited its ingest API promise, and
// refreshed review events with the exact same three lines before doing anything
// route-specific. This captures that preamble plus the cache-reuse policy in one
// place so the routes share it instead of repeating it.
//
//   useCache:true  — the caller drives ingest through its own cache machinery
//                    (the dataset stat-gate / cold-build, or the recommendations
//                    response cache), so this helper must NOT call ingest().
//   useCache:false — the caller (digest/search) has no dataset cache and runs a
//                    full ingest()+assembleDataset() per request, so fold the
//                    ingest() call in here, in the same position it ran before
//                    (immediately after refreshReviewEventsForIngest).
//
// Pure seam extraction: the resulting call order is byte-for-byte identical to
// the inlined preamble at each site. Per-request ingest semantics for
// digest/search are deliberately unchanged here (that caching is issue #1573).
async function loadIngestedDataset(req, { useCache = false } = {}) {
  const ingestState = enterpriseRequestDatasetState(req);
  const ingestApi = await ingestState.apiPromise;
  await refreshReviewEventsForIngest(ingestApi);
  if (!useCache) ingestApi.ingest();
  return { ingestState, ingestApi };
}

async function buildDatasetCache(api, contentHash) {
  const dataset = api.assembleDataset();
  // Serialize the dataset exactly ONCE (#2070). buildDatasetBody serializes the
  // stable view (dataset minus the volatile generatedAt), then splices
  // generatedAt back into the served body without a second full stringify. The
  // ETag hashes `stableJson` directly, so it only changes with the actual data,
  // not the per-build timestamp. Lone surrogates are scrubbed so the export
  // stays valid for strict parsers (#1104).
  const { json, stableJson } = buildDatasetBody(dataset);
  // Measure the serialized byte length BEFORE materializing the response Buffer
  // (#1582). Buffer.byteLength(json) is exactly Buffer.from(json).length for the
  // default utf8 encoding, so the 413 threshold and reported `actualBytes` are
  // unchanged — but an over-cap dataset no longer co-resides the object, the JSON
  // string, AND a full Buffer copy before the throw: it bails at the string stage
  // and never allocates the second multi-hundred-MB Buffer. The success path is
  // byte-identical: under the cap, `buf` is built exactly as before.
  const responseBytes = Buffer.byteLength(json);
  if (responseBytes > DATASET_RESPONSE_MAX_BYTES) {
    const err = new Error(`Dataset response exceeds ${DATASET_RESPONSE_MAX_BYTES} byte limit`);
    err.code = 'DATASET_RESPONSE_TOO_LARGE';
    err.maxBytes = DATASET_RESPONSE_MAX_BYTES;
    err.actualBytes = responseBytes;
    throw err;
  }
  const buf = Buffer.from(json);
  const etag = datasetEtagFrom(stableJson);
  // Compress both encodings concurrently on the libuv threadpool so the brotli
  // (~310 ms at this size) and gzip never block the event loop (#1015). The
  // result shape is identical to the old synchronous build.
  const [brBuf, gzBuf] = await Promise.all([
    brotliAsync(buf, DATASET_BROTLI_QUALITY),
    gzipAsync(buf, { level: 6 }),
  ]);
  return { etag, json, brBuf, gzBuf, contentHash };
}

// Map an assembled dataset into the minimal per-session shape the tier-3 audits
// reason over (#738). Defensive about field names: token totals come from
// tokenData, tool-call counts from toolData's per-session `calls` array; missing
// rows degrade to 0 rather than throw.
function auditRows(value) {
  return Array.isArray(value)
    ? value.slice(0, DASHBOARD_AUDIT_INPUT_MAX_ROWS)
    : [];
}

function auditMaxOutputTokens(value) {
  if (!Number.isFinite(value)) return DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS;
  return Math.max(
    1,
    Math.min(DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS, Math.floor(value))
  );
}

function serverAuditLlmCapReceipt() {
  return {
    registryId: 'server.audit-judge',
    callBudget: {
      env: 'DASHBOARD_AUDIT_MAX_JUDGE_CALLS',
      limit: DASHBOARD_AUDIT_MAX_JUDGE_CALLS,
    },
    inputBounds: [
      {
        env: 'DASHBOARD_AUDIT_INPUT_MAX_ROWS',
        limit: DASHBOARD_AUDIT_INPUT_MAX_ROWS,
      },
      {
        env: 'DASHBOARD_AUDIT_RESPONSE_MAX_BYTES',
        limit: DASHBOARD_AUDIT_RESPONSE_MAX_BYTES,
      },
    ],
    outputTokenLimit: {
      env: 'DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS',
      limit: DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS,
    },
    spendControls: [
      'DASHBOARD_ENABLE_SERVER_LLM_AUDITS',
      'ANTHROPIC_API_KEY',
      'Anthropic Console workspace spend limit',
    ],
  };
}

function toAuditSessions(ds) {
  const sessions = auditRows(ds?.sessions);
  const toolData = auditRows(ds?.toolData);
  const tokenData = auditRows(ds?.tokenData);
  const toolBySession = new Map(
    toolData.map((t) => [t.sessionId, (t.calls ?? []).length])
  );
  const tokenBySession = new Map();
  for (const t of tokenData) {
    const total =
      (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0) ||
      (t.entries ?? []).reduce(
        (a, e) =>
          a + (e.inputTokens ?? e.input_tokens ?? 0) + (e.outputTokens ?? e.output_tokens ?? 0),
        0
      );
    tokenBySession.set(t.sessionId, total);
  }
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    project: s.projectShort || s.project || '',
    totalTokens: tokenBySession.get(s.sessionId) || 0,
    toolCalls: toolBySession.get(s.sessionId) || 0,
    messageCount: s.messageCount || 0,
  }));
}

// Map the assembled dataset into the per-session ordered-tool + cost shape the
// agentic-opportunity audit reasons over (#741). Tool order comes from
// toolData[].calls[].toolName; per-session $ from cost-attribution. Defensive:
// missing rows degrade to empty tools / 0 cost rather than throw.
function toAgenticSessions(ds) {
  const sessions = auditRows(ds?.sessions);
  const tokenData = auditRows(ds?.tokenData);
  const toolData = auditRows(ds?.toolData);
  const projectBySession = new Map(
    sessions.map((s) => [s.sessionId, s.projectShort || s.project || ''])
  );
  let costBySession = new Map();
  try {
    for (const row of topExpensiveSessions(
      tokenData,
      toolData,
      DASHBOARD_AUDIT_INPUT_MAX_ROWS
    )) {
      costBySession.set(row.sessionId, row.estimatedCost || 0);
    }
  } catch {
    costBySession = new Map();
  }
  return toolData
    .map((t) => ({
      sessionId: t.sessionId,
      project: projectBySession.get(t.sessionId) || '',
      tools: (t.calls ?? []).map((c) => c.toolName).filter(Boolean),
      cost: costBySession.get(t.sessionId) || 0,
    }))
    .filter((s) => s.tools.length > 0);
}

// Map the assembled dataset into the per-session ordered-tool + success-flag
// shape the skill-candidate audit reasons over (#739). Tool order comes from
// toolData[].calls[].toolName (same as toAgenticSessions); the `good` flag comes
// from parse-timeline-success.computeSessionOutcomes — the PREFERRED outcome
// source (its 5 inputs timelines/tokenData/toolData/apiErrors/tags all exist on
// the assembled dataset). The tags map is empty server-side (good/bad labels
// live in the browser's localStorage, not the dataset), so every outcome
// resolves via the cost+cleanliness proxy — the intended graceful fallback.
// Defensive: a failure in outcome computation degrades every session to good:
// false (no candidates) rather than throwing, mirroring how toAgenticSessions
// wraps topExpensiveSessions.
function toSkillCandidateSessions(ds) {
  const sessions = auditRows(ds?.sessions);
  const timelines = auditRows(ds?.timelines);
  const tokenData = auditRows(ds?.tokenData);
  const toolData = auditRows(ds?.toolData);
  const apiErrors = auditRows(ds?.apiErrors);
  const projectBySession = new Map(
    sessions.map((s) => [s.sessionId, s.projectShort || s.project || ''])
  );
  let outcomes = new Map();
  try {
    outcomes = computeSessionOutcomes(
      timelines,
      tokenData,
      toolData,
      apiErrors,
      new Map() // no good/bad labels server-side -> proxy decides every outcome
    );
  } catch {
    outcomes = new Map();
  }
  return toolData
    .map((t) => ({
      sessionId: t.sessionId,
      project: projectBySession.get(t.sessionId) || '',
      tools: (t.calls ?? []).map((c) => c.toolName).filter(Boolean),
      good: outcomes.get(t.sessionId)?.good === true,
    }))
    .filter((s) => s.tools.length > 0);
}

// Map the assembled dataset into the boomerang/rework-rate audit's input (#742):
// per-session rework rows from fileHistory (FileHistorySession already carries
// reworkScore/churn/burstRate; project resolved via the sessions map like
// toAgenticSessions) plus the high-churn files (topChurnFiles filtered to
// churn >= HIGH_CHURN) that corroborate cross-session re-touch. Defensive: any
// failure degrades to empty input (no candidates) rather than throwing, mirroring
// how toAgenticSessions/toSkillCandidateSessions wrap their helpers.
function toBoomerangInput(ds) {
  try {
    const sessions = auditRows(ds?.sessions);
    const fileHistory = auditRows(ds?.fileHistory);
    const toolData = auditRows(ds?.toolData);
    const projectBySession = new Map(
      sessions.map((s) => [s.sessionId, s.projectShort || s.project || ''])
    );
    const reworkSessions = fileHistory.map((s) => ({
      sessionId: s.sessionId,
      project: projectBySession.get(s.sessionId) || '',
      reworkScore: s.reworkScore || 0,
      churn: s.churn || 0,
      burstRate: s.burstRate || 0,
    }));
    let churnFiles = [];
    try {
      churnFiles = topChurnFiles(toolData)
        .filter((c) => c.churn >= HIGH_CHURN)
        .map((c) => ({ filePath: c.filePath, churn: c.churn, sessions: c.sessions }));
    } catch {
      churnFiles = [];
    }
    return { reworkSessions, churnFiles };
  } catch {
    return { reworkSessions: [], churnFiles: [] };
  }
}

// Coarse model family from a raw model id (e.g. "claude-opus-4-...-20250514"
// -> "opus"). Buckets to the three Claude families plus an "other" catch-all so
// the regression's categorical model factor has a few well-populated levels
// rather than dozens of one-session ids. Returns "unknown" for missing ids.
function coarseModelFamily(model) {
  const m = (model || '').toLowerCase();
  if (!m || m === 'unknown') return 'unknown';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}

// Dominant tool name for a session (the most-frequent toolName across its
// calls). The natural-experiment audit uses this as a coarse categorical tool
// factor. Returns "none" when the session made no tool calls.
function dominantTool(calls) {
  const counts = new Map();
  for (const c of calls ?? []) {
    const name = c?.toolName;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = 'none';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && name < best)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// Map the assembled dataset into the natural-experiment regression rows (#744):
// per-session OUTCOME (parse-timeline-success.computeSessionOutcomes, same call
// + empty tags Map as toSkillCandidateSessions), MODEL factor (coarse family
// from tokenData[].model), TOOL factor (dominant tool from toolData[].calls),
// and the per-session DIFFICULTY proxy computed DIRECTLY as the session's total
// tokens (input + output) — NOT the global aggregatePerTaskCost aggregate.
// Defensive: any failure degrades to [] (no rows -> audit skipped) rather than
// throwing, mirroring toBoomerangInput.
function toNaturalExperimentRows(ds) {
  try {
    const timelines = auditRows(ds?.timelines);
    const tokenData = auditRows(ds?.tokenData);
    const toolData = auditRows(ds?.toolData);
    const apiErrors = auditRows(ds?.apiErrors);
    let outcomes = new Map();
    try {
      outcomes = computeSessionOutcomes(
        timelines,
        tokenData,
        toolData,
        apiErrors,
        new Map() // no good/bad labels server-side -> proxy decides every outcome
      );
    } catch {
      outcomes = new Map();
    }
    const toolBySession = new Map(
      toolData.map((t) => [t.sessionId, t.calls ?? []])
    );
    return tokenData
      .map((t) => {
        const difficulty =
          (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0);
        return {
          sessionId: t.sessionId,
          outcome: outcomes.get(t.sessionId)?.good === true ? 1 : 0,
          model: coarseModelFamily(t.model),
          toolFactor: dominantTool(toolBySession.get(t.sessionId)),
          difficulty,
        };
      })
      // Drop zero-token rows: no difficulty signal and likely empty/legacy.
      .filter((r) => r.difficulty > 0);
  } catch {
    return [];
  }
}

// Map the assembled dataset into the start/stop-oracle audit's rows (#743):
// per-session OPENER (the new tokenData[].opener field from parse-sessions) +
// good/bad OUTCOME (parse-timeline-success.computeSessionOutcomes, same call +
// empty tags Map as toNaturalExperimentRows/toSkillCandidateSessions) + project
// from the sessions map. Sessions with no opener are skipped (no feature to
// derive). Defensive: any failure degrades to [] (no rows -> audit skipped)
// rather than throwing, mirroring toNaturalExperimentRows.
function toStartStopRows(ds) {
  try {
    const sessions = auditRows(ds?.sessions);
    const timelines = auditRows(ds?.timelines);
    const tokenData = auditRows(ds?.tokenData);
    const toolData = auditRows(ds?.toolData);
    const apiErrors = auditRows(ds?.apiErrors);
    const projectBySession = new Map(
      sessions.map((s) => [s.sessionId, s.projectShort || s.project || ''])
    );
    let outcomes = new Map();
    try {
      outcomes = computeSessionOutcomes(
        timelines,
        tokenData,
        toolData,
        apiErrors,
        new Map() // no good/bad labels server-side -> proxy decides every outcome
      );
    } catch {
      outcomes = new Map();
    }
    return tokenData
      .filter((t) => typeof t.opener === 'string' && t.opener.trim().length > 0)
      .map((t) => ({
        sessionId: t.sessionId,
        project: projectBySession.get(t.sessionId) || '',
        opener: t.opener,
        good: outcomes.get(t.sessionId)?.good === true,
      }));
  } catch {
    return [];
  }
}

// Map the assembled dataset into the judge-based deceit audit's candidates
// (#687): one row per session that has assistant turns, carrying the
// assistant-turn count (seed ordering) + project (evidence ref). The seed +
// cap happen inside the audit (seedDeceitCandidates); here we only join the
// per-session deceitSignals to a project. Defensive: any failure degrades to []
// (no candidates -> audit skipped), mirroring toStartStopRows.
function toDeceitCandidates(ds) {
  try {
    const sessions = auditRows(ds?.sessions);
    const deceitSignals = auditRows(ds?.deceitSignals);
    const projectBySession = new Map(
      sessions.map((s) => [s.sessionId, s.projectShort || s.project || ''])
    );
    return deceitSignals
      .filter((s) => s && typeof s.sessionId === 'string' && s.assistantTurnCount > 0)
      .map((s) => ({
        sessionId: s.sessionId,
        project: projectBySession.get(s.sessionId) || '',
        assistantTurnCount: s.assistantTurnCount,
      }));
  } catch {
    return [];
  }
}

// Fetch a session's stored transcript as the raw content-JSON string for the
// deceit judge (#687): decompress the brotli `content_br` blob to the
// `[{type:'text'}|{type:'tool_use'}]` array text the judge formatter reads.
// `null` when the session has no stored transcript. Defensive: any failure ->
// null (that candidate is skipped), never throws into the audit run.
function getTranscriptText(sessionId) {
  try {
    const row = getTranscript(sessionId);
    if (!row || row.contentBr == null) return null;
    return decompressTranscriptContent(row).toString('utf8');
  } catch {
    return null;
  }
}

function roundOrgMetric(value, places = 4) {
  const n = Number(value) || 0;
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

function countOrgValues(values) {
  const counts = new Map();
  for (const value of values) {
    const key = value || 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function organizationRoleCounts() {
  const counts = { admin: 0, member: 0, viewer: 0 };
  if (!ENTERPRISE_AUTH_ON) {
    counts.admin = 1;
    return counts;
  }
  for (const record of ENTERPRISE_PRINCIPALS) {
    if (!enterprisePrincipalInConfiguredOrg(record.principal)) continue;
    const role = normalizeEnterpriseRole(record.principal?.role);
    counts[role] += 1;
  }
  return counts;
}

function organizationProjectKey(project) {
  return createHash('sha256')
    .update(`${ENTERPRISE_ORG_ID}\0${project || 'unknown'}`)
    .digest('hex')
    .slice(0, 12);
}

function topOrganizationProjects(projects, tokenData) {
  const projectBySession = new Map();
  const entrySessionIdsByProject = new Map();
  const messageCountByProject = new Map();
  for (const project of projects) {
    messageCountByProject.set(project.project, project.messageCount || 0);
    const ids = entrySessionIdsByProject.get(project.project) ?? new Set();
    for (const session of project.sessions ?? []) {
      projectBySession.set(session.sessionId, project.project);
      ids.add(session.sessionId);
    }
    entrySessionIdsByProject.set(project.project, ids);
  }

  const buckets = new Map();
  for (const tok of tokenData) {
    const project = projectBySession.get(tok.sessionId) || tok.project || 'unknown';
    const bucket = buckets.get(project) ?? {
      project,
      estimatedCostUsd: 0,
      tokenSessionIds: new Set(),
    };
    bucket.estimatedCostUsd += estimateCost(tok);
    bucket.tokenSessionIds.add(tok.sessionId);
    buckets.set(project, bucket);
  }
  for (const project of projects) {
    if (!buckets.has(project.project)) {
      buckets.set(project.project, {
        project: project.project,
        estimatedCostUsd: 0,
        tokenSessionIds: new Set(),
      });
    }
  }

  return [...buckets.values()]
    .map((bucket) => {
      const entrySessionIds =
        entrySessionIdsByProject.get(bucket.project) ?? new Set();
      const sessionIds = new Set([
        ...entrySessionIds,
        ...bucket.tokenSessionIds,
      ]);
      return {
        projectKey: organizationProjectKey(bucket.project),
        sessionCount: sessionIds.size,
        messageCount: messageCountByProject.get(bucket.project) || 0,
        estimatedCostUsd: roundOrgMetric(bucket.estimatedCostUsd),
      };
    })
    .filter((project) => project.sessionCount > 0)
    .sort(
      (a, b) =>
        b.estimatedCostUsd - a.estimatedCostUsd ||
        b.sessionCount - a.sessionCount ||
        a.projectKey.localeCompare(b.projectKey)
    )
    .slice(0, 10)
    .map((project, index) => ({
      rank: index + 1,
      label: `Project ${index + 1}`,
      ...project,
    }));
}

function buildEnterpriseOrganizationRollup(dataset, principal) {
  const entries = Array.isArray(dataset?.entries) ? dataset.entries : [];
  const tokenData = Array.isArray(dataset?.tokenData) ? dataset.tokenData : [];
  const toolData = Array.isArray(dataset?.toolData) ? dataset.toolData : [];
  const permissionRows = Array.isArray(dataset?.permissionRows)
    ? dataset.permissionRows
    : [];
  const apiErrors = Array.isArray(dataset?.apiErrors) ? dataset.apiErrors : [];

  const sessions = groupBySessions(entries);
  const projects = groupByProjects(sessions);
  const sessionIds = new Set([
    ...sessions.map((session) => session.sessionId),
    ...tokenData.map((row) => row.sessionId),
    ...toolData.map((row) => row.sessionId),
  ]);
  const permissionSessionIds = new Set(
    permissionRows.map((row) => row.sessionId)
  );

  const tokenTotals = tokenData.reduce(
    (acc, row) => {
      acc.input += row.totalInputTokens || 0;
      acc.output += row.totalOutputTokens || 0;
      acc.cacheCreation += row.totalCacheCreationTokens || 0;
      acc.cacheRead += row.totalCacheReadTokens || 0;
      acc.estimatedCostUsd += estimateCost(row);
      return acc;
    },
    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, estimatedCostUsd: 0 }
  );

  const toolRows = aggregateTools(toolData);
  const toolTotals = toolRows.reduce(
    (acc, row) => {
      acc.calls += row.count || 0;
      acc.errors += row.errorCount || 0;
      return acc;
    },
    { calls: 0, errors: 0 }
  );
  const dangerous = detectDangerousCommands(toolData);
  const safetyScores = computeSafetyScores(dangerous, permissionRows);
  const dangerousSessionCount = new Set(
    dangerous.map((row) => row.sessionId)
  ).size;
  const bypassPermissionSessions = safetyScores.filter(
    (row) => row.bypassMode
  ).length;
  const unattendedSessions = new Set(
    tokenData
      .filter((row) => isUnattendedEntrypoint(row.entrypoint))
      .map((row) => row.sessionId)
  ).size;
  const configuredPrincipals =
    (ENTERPRISE_AUTH_ON ? ENTERPRISE_PRINCIPALS.length : 1) +
    (ENTERPRISE_JWT_CONFIGURED ? 1 : 0);

  return {
    schemaVersion: '1',
    mode: ENTERPRISE_AUTH_ON ? 'enterprise' : 'single-user',
    generatedAt: new Date(dataset?.generatedAt || Date.now()).toISOString(),
    window: {
      start: dataset?.windowStart || null,
      end: dataset?.windowEnd || null,
    },
    organization: {
      id: ENTERPRISE_ORG_ID,
      name: ENTERPRISE_ORG_NAME,
    },
    requester: principal
      ? {
          userId: principal.userId,
          email: principal.email,
          role: normalizeEnterpriseRole(principal.role),
        }
      : null,
    principals: {
      configured: configuredPrincipals,
      roles: organizationRoleCounts(),
    },
    capabilities: enterpriseCapabilitiesForPrincipal(
      principal || { role: 'admin' }
    ),
    counts: {
      sessions: sessionIds.size,
      projects: projects.length,
      userMessages: entries.filter(
        (entry) => entry.display !== 'init' && entry.display !== 'exit'
      ).length,
      tokenSessions: tokenData.length,
      toolSessions: toolData.length,
      permissionSessions: permissionSessionIds.size,
      apiErrors: apiErrors.length,
      unattendedSessions,
      bypassPermissionSessions,
      dangerousCommandSessions: dangerousSessionCount,
    },
    usage: {
      tokens: {
        input: tokenTotals.input,
        output: tokenTotals.output,
        cacheCreation: tokenTotals.cacheCreation,
        cacheRead: tokenTotals.cacheRead,
        total:
          tokenTotals.input +
          tokenTotals.output +
          tokenTotals.cacheCreation +
          tokenTotals.cacheRead,
      },
      estimatedCostUsd: roundOrgMetric(tokenTotals.estimatedCostUsd),
      models: countOrgValues(tokenData.map((row) => row.model)).slice(0, 8),
      serviceTiers: countOrgValues(tokenData.map((row) => row.serviceTier)).slice(
        0,
        8
      ),
    },
    tools: {
      totalCalls: toolTotals.calls,
      errorCalls: toolTotals.errors,
      errorRate:
        toolTotals.calls === 0
          ? 0
          : roundOrgMetric((toolTotals.errors / toolTotals.calls) * 100, 2),
      topTools: toolRows.slice(0, 10).map((row) => ({
        toolName: row.toolName,
        count: row.count,
        errorCount: row.errorCount,
        errorRate: roundOrgMetric(row.errorRate, 2),
      })),
    },
    safety: {
      permissionModes: aggregatePermissionModes(permissionRows).slice(0, 10),
      dangerousCommands: {
        count: dangerous.length,
        sessions: dangerousSessionCount,
        patterns: countOrgValues(dangerous.map((row) => row.pattern)).slice(
          0,
          10
        ),
      },
      bypassPermissionSessions,
    },
    topProjects: topOrganizationProjects(projects, tokenData),
    privacy: {
      redacted: true,
      projectKeys: 'sha256(orgId + project path), first 12 hex chars',
      excludes: [
        'raw transcript text',
        'session ids',
        'session titles',
        'session openers',
        'tool inputs',
        'project paths',
        'pasted contents',
      ],
    },
  };
}

// Map the assembled dataset into the MCP adoption-gap audit's input (#740):
//   - installedServers: configured MCP server names from liveConfig.mcpServers
//     (each LiveMcpServer is keyed by `id`) — the baseline used to EXCLUDE
//     already-covered capabilities (already-installed is the cost concern, not
//     adoption).
//   - usage: coarse, EXPLAINABLE capability signals aggregated from toolData.
//     Bulk Bash calls strip raw command bodies, so command-prefix signals come
//     from compact parse-tools fields: commandHead plus a short commandPreview
//     fallback for chained shell snippets (`git status && gh pr list`).
//     Each signal's weight is its match count; signals below the audit's support
//     floor never fire. Defensive: any failure degrades to empty input (no usage
//     -> audit skipped), mirroring toBoomerangInput.
function toMcpAdoptionInput(ds) {
  try {
    const toolData = auditRows(ds?.toolData);
    const installedServers = auditRows(ds?.liveConfig?.mcpServers)
      .map((s) => s?.id)
      .filter((id) => typeof id === 'string' && id.length > 0);

    // Tool-name frequencies + Bash command-prefix counts across all sessions.
    let webCalls = 0; // WebFetch / WebSearch
    let browserCalls = 0; // browser-driving tools (incl. mcp__playwright__*)
    let ghCalls = 0; // Bash `gh ...`
    let dbCalls = 0; // Bash psql/sqlite/mysql/sqlite3
    for (const t of toolData) {
      for (const call of t?.calls ?? []) {
        const name = (call?.toolName || '').toLowerCase();
        if (name === 'webfetch' || name === 'websearch') webCalls += 1;
        // A browser-driving need shows up either as bare browser tools or as
        // already-namespaced mcp__playwright__* tool calls.
        if (name.includes('browser') || name.includes('playwright')) {
          browserCalls += 1;
        }
        // Compact Bash command text -> command-prefix signals.
        if ((call?.toolName || '') === 'Bash') {
          const head = typeof call?.commandHead === 'string' ? call.commandHead : '';
          const cmd = (
            typeof call?.input?.command === 'string'
              ? call.input.command
              : typeof call?.commandPreview === 'string'
                ? call.commandPreview
                : ''
          ).trim();
          if (head === 'gh' || /(^|[\s;&|(])gh\s/.test(' ' + cmd)) ghCalls += 1;
          if (
            ['psql', 'sqlite', 'sqlite3', 'mysql'].includes(head) ||
            /(^|[\s;&|(])(psql|sqlite3?|mysql)\b/.test(' ' + cmd)
          ) {
            dbCalls += 1;
          }
        }
      }
    }

    const usage = [];
    if (webCalls > 0) {
      usage.push({
        capability: 'web-fetch',
        evidence: `WebFetch/WebSearch used ${webCalls} time(s)`,
        weight: webCalls,
      });
    }
    if (browserCalls > 0) {
      usage.push({
        capability: 'browser',
        evidence: `browser-driving tool calls seen ${browserCalls} time(s)`,
        weight: browserCalls,
      });
    }
    if (ghCalls > 0) {
      usage.push({
        capability: 'github',
        evidence: `Bash \`gh\` invoked ${ghCalls} time(s)`,
        weight: ghCalls,
      });
    }
    if (dbCalls > 0) {
      usage.push({
        capability: 'database',
        evidence: `Bash DB CLIs (psql/sqlite/mysql) invoked ${dbCalls} time(s)`,
        weight: dbCalls,
      });
    }

    return { installedServers, usage };
  } catch {
    return { installedServers: [], usage: [] };
  }
}

async function rebuildDatasetCache(state, sig) {
  const api = await state.apiPromise;
  const stats = api.ingest();
  let cached = !!state.datasetCache && state.datasetCache.contentHash === stats.contentHash;
  if (!cached) {
    const fromDisk = api.loadDatasetCache(stats.contentHash);
    if (fromDisk) {
      state.datasetCache = fromDisk;
      cached = true;
    } else {
      state.datasetCache = await buildDatasetCache(api, stats.contentHash);
      api.saveDatasetCache(state.datasetCache, Date.now());
    }
  }
  state.lastSourceSig = sig;
  return { stats, cached };
}

function startDatasetRefresh(state, sig) {
  if (state.datasetRefresh) return;
  state.datasetRefresh = new Promise((resolve) => {
    setImmediate(() => {
      rebuildDatasetCache(state, sig)
        .catch((err) => {
          console.error('dataset background refresh failed:', err?.message ?? err);
        })
        .finally(() => {
          state.datasetRefresh = null;
          resolve();
        });
    });
  });
}

function recommendationIdentityCacheKey(organizationIdentity) {
  if (!organizationIdentity?.contributors?.length) return 'none';
  return createHash('sha256')
    .update(safeJsonStringify(organizationIdentity))
    .digest('hex')
    .slice(0, 16);
}

function recommendationsCacheKey(project, identityKey = 'none') {
  const base = !project
    ? 'global'
    : `project:${createHash('sha1').update(project).digest('hex')}`;
  return identityKey === 'none' ? base : `${base}:identity:${identityKey}`;
}

function pruneRecommendationsCache(state) {
  if (
    state.recommendationsCache.size <=
    DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES
  ) {
    return;
  }
  const entries = [...state.recommendationsCache.entries()].sort(
    (a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0)
  );
  for (const [key] of entries) {
    if (
      state.recommendationsCache.size <=
      DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES
    ) {
      return;
    }
    state.recommendationsCache.delete(key);
  }
}

function pruneRecommendationsBuilds(state) {
  if (
    state.recommendationsBuilds.size <=
    DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES
  ) {
    return;
  }
  const entries = [...state.recommendationsBuilds.entries()].sort(
    (a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0)
  );
  for (const [key] of entries) {
    if (
      state.recommendationsBuilds.size <=
      DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES
    ) {
      return;
    }
    state.recommendationsBuilds.delete(key);
  }
}

// Reuse one assembled dataset per contentHash across a recs request's two
// internal assembles (recs build + suppression emit) and across consecutive
// recs requests, instead of rebuilding the ~128 MB dataset each time (#2071).
// The memo is a single slot on the per-request dataset state, overwritten when
// the contentHash moves. The exported assembleDataset() is intentionally left
// un-memoized so the ingest parity tests still exercise the warm assembly path.
function memoizedAssembleDataset(state, api, contentHash) {
  if (state.assembledMemo && state.assembledMemo.contentHash === contentHash) {
    return state.assembledMemo.dataset;
  }
  const dataset = api.assembleDataset();
  state.assembledMemo = { contentHash, dataset };
  return dataset;
}

// ── Off-main-thread recommendations rebuild worker (#2196, epic #2181) ───────
// The recs rebuild is multi-second synchronous CPU; running it inline (even
// finish-deferred, #2184) stalls the event loop, so a request landing during a
// rebuild waits behind it. This long-lived worker runs the rebuild on its own
// thread with its OWN SQLite cache (worker-private CHD_DB_PATH), so the main
// loop never blocks. The worker serves the GLOBAL ingest path only; enterprise
// per-principal scoped rebuilds and the cold first-build fall back to the inline
// path. Set CHD_RECS_WORKER=0 to disable and always build inline.
const RECS_WORKER_ENABLED = process.env.CHD_RECS_WORKER !== '0';
let recsWorker = null;
let recsWorkerReqId = 0;
const recsWorkerPending = new Map(); // id -> { resolve, reject }

function recsWorkerDbPath() {
  return (
    process.env.CHD_RECS_WORKER_DB_PATH ||
    join(CHD_CACHE_DIR, 'dashboard-recs-worker.db')
  );
}

function failRecsWorker(worker, err) {
  // Bind to the specific worker: a dying worker emits BOTH 'error' and 'exit',
  // and a fresh worker may have been spawned between them. Only tear down state
  // if `worker` is still the active one, so the second event (or a stale
  // handler) can't null a healthy replacement or reject its in-flight pendings.
  if (worker && recsWorker !== worker) {
    try {
      worker.terminate?.();
    } catch {
      /* already gone */
    }
    return;
  }
  recsWorker = null;
  for (const [, p] of recsWorkerPending) p.reject(err);
  recsWorkerPending.clear();
  try {
    worker?.terminate?.();
  } catch {
    /* already gone */
  }
}

function spawnRecsWorker() {
  if (recsWorker) return recsWorker;
  if (!RECS_WORKER_ENABLED) return null;
  try {
    const w = new Worker(join(PROJECT_DIR, 'scripts', 'recs-worker.mjs'), {
      // Same register-ts loader the server boots with, so the worker resolves
      // the .ts parsers ingest.mjs dynamically imports.
      execArgv: ['--import', join(PROJECT_DIR, 'scripts', 'register-ts.mjs')],
      workerData: { projectDir: PROJECT_DIR },
      // Worker-private SQLite cache so the worker's ingest never shares the main
      // process's DB handle (no WAL / shared-handle concurrency).
      env: { ...process.env, CHD_DB_PATH: recsWorkerDbPath() },
    });
    w.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') return;
      if (msg.type === 'log') {
        console.warn(msg.message);
        return;
      }
      const p = recsWorkerPending.get(msg.id);
      if (!p) return;
      recsWorkerPending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg);
      } else {
        p.reject(new Error(msg.error || 'recs worker rebuild failed'));
      }
    });
    w.on('error', (err) => failRecsWorker(w, err));
    w.on('exit', (code) =>
      failRecsWorker(
        w,
        new Error(code !== 0 ? `recs worker exited with code ${code}` : 'recs worker exited')
      )
    );
    // Don't keep the process alive solely for the worker.
    w.unref?.();
    recsWorker = w;
  } catch (err) {
    console.warn('[recs-worker] spawn failed:', err?.message || err);
    recsWorker = null;
  }
  return recsWorker;
}

// Resolves { json, contentHash, sourceSig } from the worker, or rejects (caller
// falls back to the inline build). Single message round-trip; the caller owns
// single-flight via the reserved cache slot.
// Safety valve: a worker rebuild that never replies (pathological hang) would
// otherwise leave the reserved single-flight slot pending forever, wedging all
// future refreshes for that key. On timeout we reject (→ inline fallback) and
// drop the pending entry; a late worker reply for a dropped id is ignored. The
// budget is generous — a cold worker ingest on a large corpus plus assemble runs
// well under this. Override with CHD_RECS_WORKER_TIMEOUT_MS.
const RECS_WORKER_TIMEOUT_MS = Math.max(
  10_000,
  parseNonNegativeIntEnv('CHD_RECS_WORKER_TIMEOUT_MS', 180_000)
);

function requestRecsRebuildViaWorker(project, organizationIdentity, emitSuppressionTransitions) {
  const w = spawnRecsWorker();
  if (!w) return Promise.reject(new Error('recs worker unavailable'));
  const id = ++recsWorkerReqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (recsWorkerPending.delete(id)) {
        reject(new Error(`recs worker rebuild timed out after ${RECS_WORKER_TIMEOUT_MS}ms`));
      }
    }, RECS_WORKER_TIMEOUT_MS);
    timer.unref?.();
    recsWorkerPending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      w.postMessage({
        id,
        project: project || null,
        organizationIdentity: organizationIdentity || null,
        emitSuppressionTransitions: !!emitSuppressionTransitions,
        adoptionReceiptsPath: ADOPTION_RECEIPTS,
        shadowCallsDir: SHADOW_CALLS_DIR,
      });
    } catch (err) {
      clearTimeout(timer);
      recsWorkerPending.delete(id);
      reject(err);
    }
  });
}

// Worker-backed twin of buildRecommendationsCacheEntry: the rebuild runs off the
// event loop; the main thread only does the cheap size-gate + ETag + cache.set.
// Reuses the request-time `sourceSig` (like the inline path) so the freshness
// gate stays consistent; the worker's content-derived contentHash matches the
// main process's for the same source state (verified path-independent).
async function buildRecommendationsCacheEntryViaWorker(
  state,
  key,
  sourceSig,
  project,
  { emitSuppressionTransitions = false, organizationIdentity = null } = {}
) {
  const { json, contentHash } = await requestRecsRebuildViaWorker(
    project,
    organizationIdentity,
    emitSuppressionTransitions
  );
  const actualBytes = Buffer.byteLength(json, 'utf8');
  if (actualBytes > DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES) {
    const err = new Error(
      `Recommendations response exceeds ${DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES} byte limit`
    );
    err.code = 'ERR_DASHBOARD_RECOMMENDATIONS_RESPONSE_TOO_LARGE';
    err.maxBytes = DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES;
    err.actualBytes = actualBytes;
    throw err;
  }
  const entry = {
    etag: datasetEtagFrom(json),
    json,
    contentHash,
    sourceSig,
    lastAccess: Date.now(),
  };
  state.recommendationsCache.set(key, entry);
  pruneRecommendationsCache(state);
  return entry;
}

async function buildRecommendationsCacheEntry(
  state,
  api,
  key,
  sourceSig,
  project,
  { emitSuppressionTransitions = false, organizationIdentity = null } = {}
) {
  const stats = api.ingest();
  // Assemble once and thread the same dataset into both the suppression emit
  // and the recs build (#2071) — each previously called assembleDataset()
  // independently, doubling the synchronous event-loop stall per request.
  const dataset = memoizedAssembleDataset(state, api, stats.contentHash);
  if (emitSuppressionTransitions) {
    api
      .recordSuppressionTransitions(ADOPTION_RECEIPTS, {
        shadowCallsDir: SHADOW_CALLS_DIR,
        organizationIdentity,
        dataset,
      })
      .catch((err) => {
        console.warn(
          '[adoption] suppression-transition emit failed:',
          err?.message || err
        );
      });
  }
  const recs = api.assembleRecommendations(project || undefined, {
    organizationIdentity,
    dataset,
  });
  const json = safeJsonStringify(recs); // scrub lone surrogates so the export stays strict-parser-valid (#1104)
  const actualBytes = Buffer.byteLength(json, 'utf8');
  if (actualBytes > DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES) {
    const err = new Error(
      `Recommendations response exceeds ${DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES} byte limit`
    );
    err.code = 'ERR_DASHBOARD_RECOMMENDATIONS_RESPONSE_TOO_LARGE';
    err.maxBytes = DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES;
    err.actualBytes = actualBytes;
    throw err;
  }
  const entry = {
    etag: datasetEtagFrom(json),
    json,
    contentHash: stats.contentHash,
    sourceSig,
    lastAccess: Date.now(),
  };
  state.recommendationsCache.set(key, entry);
  pruneRecommendationsCache(state);
  return entry;
}

async function recommendationsResponseCache(
  state,
  api,
  project,
  {
    emitSuppressionTransitions = false,
    organizationIdentity = null,
    allowWorker = false,
  } = {}
) {
  const sourceSig = api.sourceSignature();
  const identityKey = recommendationIdentityCacheKey(organizationIdentity);
  const key = recommendationsCacheKey(project, identityKey);
  const cached = state.recommendationsCache.get(key);
  if (cached && cached.sourceSig === sourceSig) {
    cached.lastAccess = Date.now();
    return { entry: cached, cache: 'hit' };
  }
  // Content-hash gate (parity with the dataset route's #182 stat-gate). The
  // sourceSignature() above is a CHEAP mtime fingerprint that an active agent
  // session trips on nearly every request (each transcript write bumps the
  // project-dir mtime) — but the recommendation BODY only changes when the
  // ingested CONTENT changes. ingest() is incremental (~200ms warm), so when it
  // reports the same contentHash the cached recs are byte-identical: restamp the
  // entry's signature and serve it as a hit, skipping the multi-second
  // assemble+detector rebuild entirely. This is what keeps the dataset route at
  // ~0.4s under the same churn while the un-gated recs route paid the full
  // recompute every request (#2184).
  if (cached) {
    const stats = api.ingest();
    if (stats.contentHash === cached.contentHash) {
      cached.sourceSig = sourceSig;
      cached.lastAccess = Date.now();
      return { entry: cached, cache: 'hit-content' };
    }
  }
  // Stale-while-revalidate (#2184). The content changed (gate above fell
  // through) but we still hold a last-good cached entry: serve it immediately
  // and refresh in the background. The recs body is small and advisory and the
  // underlying ~/.claude data is at most seconds stale, so this trades brief
  // staleness for a fast response. CRUCIALLY the rebuild must run AFTER the
  // current response has flushed: buildRecommendationsCacheEntry is ~12-17s of
  // UNINTERRUPTED synchronous CPU (assembleDataset -> 90-detector engine ->
  // safeJsonStringify) with no internal await, so running it on this tick — even
  // via setImmediate/setTimeout — blocks the event loop before the stale body
  // reaches the socket (measured: the "stale" response itself still took ~17s).
  // The route therefore wires the returned `scheduleRefresh` thunk to the
  // response's `finish` event, so the rebuild only starts once the bytes are
  // out. A single-flight slot is reserved synchronously so concurrent requests
  // (which find the reserved slot) don't stack a second rebuild.
  if (cached) {
    cached.lastAccess = Date.now();
    const existing = state.recommendationsBuilds.get(key);
    if (existing) {
      existing.lastAccess = Date.now();
      return { entry: cached, cache: 'stale', scheduleRefresh: null };
    }
    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }).finally(() => {
      const current = state.recommendationsBuilds.get(key);
      if (current?.promise === promise) {
        state.recommendationsBuilds.delete(key);
      }
    });
    // Mark the reserved promise handled so a failed background rebuild never
    // becomes an unhandled rejection (the cold path below awaits its own build
    // and still surfaces errors through the route try/catch).
    promise.catch(() => {});
    state.recommendationsBuilds.set(key, {
      sourceSig,
      promise,
      lastAccess: Date.now(),
    });
    pruneRecommendationsBuilds(state);
    let fired = false;
    const inlineBuild = () =>
      buildRecommendationsCacheEntry(state, api, key, sourceSig, project, {
        emitSuppressionTransitions,
        organizationIdentity,
      });
    const scheduleRefresh = () => {
      if (fired) return;
      fired = true;
      // #2196: on the global ingest path, run the rebuild on the worker thread
      // so the event loop never blocks (even concurrent requests during the
      // rebuild stay fast). Fall back to the inline finish-deferred build
      // (#2184) when the worker is disabled/unavailable or dies mid-rebuild — a
      // 413 size cap is a real result, not a worker failure, so it is NOT
      // retried inline.
      const build =
        allowWorker && RECS_WORKER_ENABLED
          ? buildRecommendationsCacheEntryViaWorker(state, key, sourceSig, project, {
              emitSuppressionTransitions,
              organizationIdentity,
            }).catch((err) => {
              if (isRecommendationsResponseTooLargeError(err)) throw err;
              console.warn(
                '[recs-worker] rebuild failed, falling back to inline:',
                err?.message || err
              );
              return inlineBuild();
            })
          : inlineBuild();
      build.then(settle.resolve, (err) => {
        console.warn(
          '[recommendations] background refresh failed:',
          err?.message || err
        );
        settle.reject(err);
      });
    };
    return { entry: cached, cache: 'stale', scheduleRefresh };
  }
  // Cold key (no cached entry to serve): build now and await it. This is the
  // only path that blocks, and only on the very first request for a key.
  let build = state.recommendationsBuilds.get(key);
  if (!build || build.sourceSig !== sourceSig) {
    const promise = buildRecommendationsCacheEntry(
      state,
      api,
      key,
      sourceSig,
      project,
      { emitSuppressionTransitions, organizationIdentity }
    ).finally(() => {
      const current = state.recommendationsBuilds.get(key);
      if (current?.promise === promise) {
        state.recommendationsBuilds.delete(key);
      }
    });
    build = { sourceSig, promise, lastAccess: Date.now() };
    state.recommendationsBuilds.set(key, build);
    pruneRecommendationsBuilds(state);
  } else {
    build.lastAccess = Date.now();
  }
  const entry = await build.promise;
  return { entry, cache: 'miss' };
}

// Stat-gated, single-flight response cache for the digest and search routes
// (#1573), the same shape recommendationsResponseCache already uses: a
// sourceSignature() stat-gate decides freshness, the cache holds the computed
// payload per key, and a `*Builds` Map collapses concurrent identical requests
// (same key + same sourceSig) onto ONE build. The route-agnostic core lives in
// ./lib/stat-gated-cache.mjs so it can be unit-tested directly; this wrapper just
// supplies the ingest API's signature getter and the build invocation.
function statGatedResponseCache(api, { cacheMap, buildsMap, key, max, build }) {
  return resolveStatGatedCache({
    sourceSignature: () => api.sourceSignature(),
    cacheMap,
    buildsMap,
    key,
    max,
    build,
    buildArgs: [api],
  });
}

// /api/digest cache key: one entry per requested calendar date. The digest is a
// pure function of (assembled dataset, date), so the sourceSig stat-gate covers
// dataset changes and the date is the only per-request input.
function digestCacheKey(date) {
  return `date:${date}`;
}

// /api/search cache key: scoring + embedding runs per query, so the key MUST
// fold in every input that changes the result — the normalized query text, the
// project filter, and the result limit. Anything with the same triple shares one
// cached (and single-flighted) score+embed pass.
function searchCacheKey(q, project, limit) {
  return JSON.stringify(['q', q, 'project', project ?? null, 'limit', limit]);
}

// Build the /api/digest payload for one date, reusing the assembled dataset per
// contentHash via memoizedAssembleDataset (#2071) so concurrent dates on the same
// corpus assemble once. ingest() is required to learn contentHash; on an unchanged
// source it is the same cheap stat-walk the stat-gate already accounts for.
function buildDigestPayload(state, api, date) {
  const stats = api.ingest();
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  return buildDailyDigest(
    {
      sessions: groupBySessions(ds.entries || []),
      tokenData: ds.tokenData || [],
      toolData: ds.toolData || [],
      timelines: ds.timelines || [],
      apiErrors: ds.apiErrors || [],
      taskSuccess: ds.taskSuccess || [],
      statsCache: ds.statsCache || null,
    },
    date
  );
}

// Build the /api/search payload for one (query, project, limit), reusing the
// assembled dataset per contentHash (#2071); the per-query score+embed is the
// expensive part the cache exists to collapse.
function buildSearchPayload(state, api, q, project, limit) {
  const stats = api.ingest();
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  const results = hybridSearchEntries(ds.entries || [], q, {
    project,
    limit,
    semanticEnabled: true,
  }).map((result) => ({
    ...result,
    entry: { ...result.entry, pastedContents: {} },
  }));
  return { mode: 'hybrid', semanticAvailable: true, results };
}

// RFC 7232 If-None-Match check. Handles comma-separated lists and the "*" form.
function etagMatches(req, etag) {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  if (inm.trim() === '*') return true;
  return inm
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag);
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

function realpathSyncOrNull(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return null;
  }
}

function rawFileTooLargeError(maxBytes) {
  const err = new Error(`Raw file exceeds ${maxBytes} byte limit`);
  err.code = 'ERR_DASHBOARD_RAW_FILE_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

function isRawFileTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_RAW_FILE_TOO_LARGE';
}

function rawSessionTooManyPartsError(maxParts) {
  const err = new Error(`Merged raw session exceeds ${maxParts} part limit`);
  err.code = 'ERR_DASHBOARD_RAW_SESSION_TOO_MANY_PARTS';
  err.maxParts = maxParts;
  return err;
}

function isRawSessionTooManyPartsError(err) {
  return err?.code === 'ERR_DASHBOARD_RAW_SESSION_TOO_MANY_PARTS';
}

function transcriptBlobTooLargeError(maxBytes) {
  const err = new Error(`Transcript exceeds ${maxBytes} byte limit`);
  err.code = 'ERR_DASHBOARD_TRANSCRIPT_TOO_LARGE';
  err.maxBytes = maxBytes;
  return err;
}

function isTranscriptBlobTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_TRANSCRIPT_TOO_LARGE';
}

function isTranscriptTooLargeError(err) {
  return (
    isTranscriptBlobTooLargeError(err) ||
    err?.code === 'ERR_DASHBOARD_INGEST_SESSION_TOO_LARGE'
  );
}

function isDatasetResponseTooLargeError(err) {
  return err?.code === 'DATASET_RESPONSE_TOO_LARGE';
}

function isRecommendationsResponseTooLargeError(err) {
  return err?.code === 'ERR_DASHBOARD_RECOMMENDATIONS_RESPONSE_TOO_LARGE';
}

function transcriptContentByteLen(row) {
  const value = Number(row?.contentByteLen);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function decompressTranscriptBlob(blob) {
  try {
    return brotliDecompressSync(Buffer.from(blob), {
      maxOutputLength: DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES,
    });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw transcriptBlobTooLargeError(DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES);
    }
    throw err;
  }
}

function decompressTranscriptContent(row) {
  const byteLen = transcriptContentByteLen(row);
  if (byteLen !== null && byteLen > DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES) {
    throw transcriptBlobTooLargeError(DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES);
  }
  return decompressTranscriptBlob(row.contentBr);
}

function readUtf8FileCapped(filePath, maxBytes, initialBytes = 0) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = initialBytes;
    let settled = false;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        stream.destroy(rawFileTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err) => {
      if (settled && !isRawFileTooLargeError(err)) return;
      reject(err);
    });
    stream.on('end', () => {
      if (settled) return;
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        bytes,
      });
    });
  });
}

async function readTextFileInsideRoot(root, relativePath) {
  const file = join(root, relativePath);
  const [realRoot, realFile] = await Promise.all([
    realpathOrNull(root),
    realpathOrNull(file),
  ]);
  if (!realRoot || !realFile || !pathInside(realRoot, realFile)) return null;
  return (await readUtf8FileCapped(realFile, DASHBOARD_RAW_FILE_MAX_BYTES)).text;
}

async function readDirentsBounded(dirPath, maxEntries) {
  const entries = [];
  let truncated = false;
  let dir;
  try {
    dir = await opendir(dirPath);
  } catch {
    return { entries, truncated, missing: true };
  }
  let checked = 0;
  try {
    for (;;) {
      const ent = await dir.read();
      if (!ent) break;
      if (checked >= maxEntries) {
        truncated = true;
        break;
      }
      checked += 1;
      entries.push(ent);
    }
  } finally {
    try {
      await dir.close();
    } catch {
      /* ignore close failures */
    }
  }
  return { entries, truncated, missing: false };
}

async function buildManifest(
  projectsRoot = PROJECTS,
  maxEntries = DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES
) {
  const out = [];
  let truncated = false;
  const seen = new Set();
  const roots = Array.isArray(projectsRoot) ? projectsRoot : [projectsRoot];
  for (const root of roots) {
    const projects = await readDirentsBounded(root, maxEntries);
    if (projects.missing) {
      continue;
    }
    if (projects.truncated) truncated = true;
    for (const d of projects.entries) {
      if (!d.isDirectory()) continue;
      const project = d.name;
      const files = await readDirentsBounded(join(root, project), maxEntries);
      if (files.missing) {
        continue;
      }
      if (files.truncated) truncated = true;
      for (const f of files.entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          const key = `${project}/${f.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name: f.name, project, path: `/projects/${project}/${f.name}` });
          if (out.length >= maxEntries) {
            truncated = true;
            return { entries: out, limit: maxEntries, truncated };
          }
        }
      }
    }
  }
  return { entries: out, limit: maxEntries, truncated };
}

// Concatenate the top-level session file with every subagent file under
// <proj>/<id>/subagents/*.jsonl, mirroring the old sync-data.sh merge so
// subagent activity counts toward the parent session.
async function readMergedSessionFromRoot(project, file, projectsRoot = PROJECTS) {
  const root = normalize(projectsRoot);
  const base = normalize(join(root, project));
  const top = join(base, file);
  if (
    !pathInside(root, base) ||
    !pathInside(base, top) ||
    !file.endsWith('.jsonl') ||
    !existsSync(top)
  ) {
    return null;
  }
  const [realRoot, realBase, realTop] = await Promise.all([
    realpathOrNull(root),
    realpathOrNull(base),
    realpathOrNull(top),
  ]);
  if (
    !realRoot ||
    !realBase ||
    !realTop ||
    !pathInside(realRoot, realBase) ||
    !pathInside(realBase, realTop)
  ) {
    return null;
  }
  let { text: body, bytes: bodyBytes } = await readUtf8FileCapped(
    realTop,
    DASHBOARD_RAW_FILE_MAX_BYTES
  );
  let mergedParts = 1;
  const id = file.replace(/\.jsonl$/, '');
  const saDir = join(base, id, 'subagents');
  if (existsSync(saDir)) {
    const realSaDir = await realpathOrNull(saDir);
    if (!realSaDir || !pathInside(realBase, realSaDir)) return body;
    const subRead = await readDirentsBounded(
      saDir,
      DASHBOARD_RAW_SESSION_MAX_PARTS
    );
    if (subRead.truncated) {
      throw rawSessionTooManyPartsError(DASHBOARD_RAW_SESSION_MAX_PARTS);
    }
    const subs = subRead.entries
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .map((f) => f.name)
      .sort();
    for (const sa of subs) {
      const full = join(saDir, sa);
      if (!pathInside(saDir, full) || !existsSync(full)) continue;
      const realFull = await realpathOrNull(full);
      if (!realFull || !pathInside(realSaDir, realFull)) continue;
      if (mergedParts >= DASHBOARD_RAW_SESSION_MAX_PARTS) {
        throw rawSessionTooManyPartsError(DASHBOARD_RAW_SESSION_MAX_PARTS);
      }
      const prefix = body.length && !body.endsWith('\n') ? '\n' : '';
      const prefixBytes = Buffer.byteLength(prefix);
      if (bodyBytes + prefixBytes > DASHBOARD_RAW_FILE_MAX_BYTES) {
        throw rawFileTooLargeError(DASHBOARD_RAW_FILE_MAX_BYTES);
      }
      const { text, bytes } = await readUtf8FileCapped(
        realFull,
        DASHBOARD_RAW_FILE_MAX_BYTES,
        bodyBytes + prefixBytes
      );
      bodyBytes = bytes;
      body += prefix;
      body += text;
      mergedParts += 1;
    }
    // #636: recurse one more level into nested Workflow-tool agent transcripts
    // (subagents/workflows/<runId>/agent-*.jsonl) so workflow-agent activity
    // counts toward the parent here too, matching ingest.mjs's merged blob.
    if (mergedParts >= DASHBOARD_RAW_SESSION_MAX_PARTS) {
      throw rawSessionTooManyPartsError(DASHBOARD_RAW_SESSION_MAX_PARTS);
    }
    const nested = listNestedWorkflowAgentTranscripts(saDir, {
      maxEntries: DASHBOARD_RAW_SESSION_MAX_PARTS - mergedParts + 1,
    });
    for (const full of nested.paths) {
      if (!pathInside(saDir, full) || !existsSync(full)) continue;
      const realFull = await realpathOrNull(full);
      if (!realFull || !pathInside(realSaDir, realFull)) continue;
      if (mergedParts >= DASHBOARD_RAW_SESSION_MAX_PARTS) {
        throw rawSessionTooManyPartsError(DASHBOARD_RAW_SESSION_MAX_PARTS);
      }
      const prefix = body.length && !body.endsWith('\n') ? '\n' : '';
      const prefixBytes = Buffer.byteLength(prefix);
      if (bodyBytes + prefixBytes > DASHBOARD_RAW_FILE_MAX_BYTES) {
        throw rawFileTooLargeError(DASHBOARD_RAW_FILE_MAX_BYTES);
      }
      const { text, bytes } = await readUtf8FileCapped(
        realFull,
        DASHBOARD_RAW_FILE_MAX_BYTES,
        bodyBytes + prefixBytes
      );
      bodyBytes = bytes;
      body += prefix;
      body += text;
      mergedParts += 1;
    }
  }
  return body;
}

async function readMergedSession(project, file, projectsRoot = PROJECTS) {
  const roots = Array.isArray(projectsRoot) ? projectsRoot : [projectsRoot];
  for (const root of roots) {
    const body = await readMergedSessionFromRoot(project, file, root);
    if (body !== null) return body;
  }
  return null;
}

// Text-based static assets worth compressing on the wire. Images and fonts
// (.png/.woff2/.ico/.jpg etc.) are already compressed, so we stream those raw.
const COMPRESSIBLE_STATIC = new Set([
  '.js',
  '.css',
  '.svg',
  '.json',
  '.map',
  '.html',
]);

async function serveStatic(req, pathname, res) {
  const assetRequest = pathname === '/assets' || pathname.startsWith('/assets/');
  let rel = pathname === '/' ? '/index.html' : pathname;
  let filePath = normalize(join(DIST, rel));
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.statusCode = 403;
    res.end('');
    return;
  }
  let info = null;
  try {
    info = await stat(filePath);
  } catch {
    info = null;
  }
  if (info && info.isDirectory()) {
    filePath = join(filePath, 'index.html');
    try {
      info = await stat(filePath);
    } catch {
      info = null;
    }
  }
  if (!info) {
    if (assetRequest) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('not found');
      return;
    }
    // SPA fallback: unknown non-file route -> index.html
    filePath = join(DIST, 'index.html');
    try {
      info = await stat(filePath);
    } catch {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
  }
  const [realDist, realFile] = await Promise.all([
    realpathOrNull(DIST),
    realpathOrNull(filePath),
  ]);
  if (!realDist || !realFile || !pathInside(realDist, realFile)) {
    res.statusCode = 403;
    res.end('');
    return;
  }
  filePath = realFile;
  const ext = extname(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  if (assetRequest) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (ext === '.html') {
    res.setHeader('Cache-Control', 'no-store');
  }
  // Compress text assets (JS/CSS/SVG/JSON/maps/HTML) per-request through the
  // same brotli/gzip negotiation the dataset uses, honoring Accept-Encoding +
  // Vary. Use a cheaper brotli level than the cached dataset since these are
  // compressed on every request. Stream oversized or binary assets raw.
  if (COMPRESSIBLE_STATIC.has(ext) && info.size <= STATIC_COMPRESS_MAX_BYTES) {
    sendBody(req, res, await readFile(filePath), { quality: 5 });
    return;
  }
  createReadStream(filePath).pipe(res);
}

// Send a small JSON body with an explicit status. Used by the mutating policy
// route — its responses are tiny and never cached, so we skip the brotli/ETag
// machinery of sendBody().
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendRawFileTooLarge(res, err) {
  return sendJson(res, 413, {
    ok: false,
    error: 'Raw file exceeds configured byte limit',
    maxBytes: err?.maxBytes || DASHBOARD_RAW_FILE_MAX_BYTES,
  });
}

function sendRawSessionTooManyParts(res, err) {
  return sendJson(res, 413, {
    ok: false,
    error: 'Merged raw session exceeds configured part limit',
    maxParts: err?.maxParts || DASHBOARD_RAW_SESSION_MAX_PARTS,
  });
}

function sendTranscriptTooLarge(res, err) {
  return sendJson(res, 413, {
    ok: false,
    error: 'Transcript exceeds configured byte limit',
    maxBytes: err?.maxBytes || DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES,
  });
}

function sendDatasetResponseTooLarge(res, err) {
  return sendJson(res, 413, {
    ok: false,
    error: 'Dataset response exceeds configured byte limit',
    maxBytes: err?.maxBytes || DATASET_RESPONSE_MAX_BYTES,
    actualBytes: err?.actualBytes,
  });
}

function sendRecommendationsResponseTooLarge(res, err) {
  return sendJson(res, 413, {
    ok: false,
    error: 'Recommendations response exceeds configured byte limit',
    maxBytes: err?.maxBytes || DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES,
    actualBytes: err?.actualBytes,
  });
}

function sendAuditResponse(req, res, payload) {
  const body = JSON.stringify(payload);
  const actualBytes = Buffer.byteLength(body, 'utf8');
  if (actualBytes > DASHBOARD_AUDIT_RESPONSE_MAX_BYTES) {
    return sendJson(res, 413, {
      ok: false,
      error: 'Audit response exceeds configured byte limit',
      maxBytes: DASHBOARD_AUDIT_RESPONSE_MAX_BYTES,
      actualBytes,
    });
  }
  live(res, 'application/json; charset=utf-8');
  return sendBody(req, res, body);
}

function appendVary(res, value) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }
  const values = new Set(
    String(current)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
  values.add(value);
  res.setHeader('Vary', [...values].join(', '));
}

// Agent memories (#458). Walk every ~/.claude/projects/<slug>/memory/ dir and
// return raw markdown per *.md file — INCLUDING the MEMORY.md index (#1990) so
// `buildMemoryStores` can populate `store.index`/`indexRaw` and the #1779
// memory-hygiene detector can fire; `parseMemories` still filters the index out
// of the Memories view. Grouped by project slug. Read fresh per request; the
// client parses the frontmatter. Any unreadable project/file is skipped rather
// than failing the whole response.
async function readMemories(projectsRoot = PROJECTS) {
  const out = [];
  let contentBytes = 0;
  let returnedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;
  let responseLimitReached = false;
  let fileLimitReached = false;
  const projectDirs = await readDirentsBounded(
    projectsRoot,
    DASHBOARD_MEMORY_DIR_MAX_ENTRIES
  );
  if (projectDirs.missing) {
    return {
      projects: [],
      limits: {
        fileMaxBytes: DASHBOARD_MEMORY_FILE_MAX_BYTES,
        responseMaxBytes: DASHBOARD_MEMORY_RESPONSE_MAX_BYTES,
        maxFiles: DASHBOARD_MEMORY_MAX_FILES,
        directoryMaxEntries: DASHBOARD_MEMORY_DIR_MAX_ENTRIES,
      },
      skippedFiles,
      truncated,
    };
  }
  if (projectDirs.truncated) truncated = true;
  const realProjectsRoot = await realpathOrNull(projectsRoot);
  if (!realProjectsRoot) {
    return {
      projects: [],
      limits: {
        fileMaxBytes: DASHBOARD_MEMORY_FILE_MAX_BYTES,
        responseMaxBytes: DASHBOARD_MEMORY_RESPONSE_MAX_BYTES,
        maxFiles: DASHBOARD_MEMORY_MAX_FILES,
        directoryMaxEntries: DASHBOARD_MEMORY_DIR_MAX_ENTRIES,
      },
      skippedFiles,
      truncated,
    };
  }
  for (const ent of projectDirs.entries) {
    if (fileLimitReached) break;
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const memDir = join(projectsRoot, slug, 'memory');
    if (!existsSync(memDir)) continue;
    const realMemDir = await realpathOrNull(memDir);
    if (!realMemDir || !pathInside(realProjectsRoot, realMemDir)) continue;
    const mdFiles = await readDirentsBounded(
      memDir,
      DASHBOARD_MEMORY_DIR_MAX_ENTRIES
    );
    if (mdFiles.missing) {
      continue;
    }
    if (mdFiles.truncated) truncated = true;
    const files = [];
    for (const name of mdFiles.entries
      .map((file) => file.name)
      .filter((file) => file.endsWith('.md'))
      .sort()) {
      if (fileLimitReached || responseLimitReached) {
        skippedFiles += 1;
        truncated = true;
        fileLimitReached = returnedFiles >= DASHBOARD_MEMORY_MAX_FILES;
        continue;
      }
      const full = join(memDir, name);
      // Defense in depth: never escape the memory dir via a crafted name.
      if (!pathInside(memDir, full)) continue;
      try {
        const realFull = await realpathOrNull(full);
        if (!realFull || !pathInside(realMemDir, realFull)) continue;
        const { text, bytes } = await readUtf8FileCapped(
          realFull,
          DASHBOARD_MEMORY_FILE_MAX_BYTES
        );
        if (contentBytes + bytes > DASHBOARD_MEMORY_RESPONSE_MAX_BYTES) {
          skippedFiles += 1;
          truncated = true;
          responseLimitReached = true;
          continue;
        }
        contentBytes += bytes;
        returnedFiles += 1;
        files.push({ name, content: text });
        if (returnedFiles >= DASHBOARD_MEMORY_MAX_FILES) {
          truncated = true;
          fileLimitReached = true;
          break;
        }
      } catch (err) {
        if (isRawFileTooLargeError(err)) {
          skippedFiles += 1;
          truncated = true;
        }
        /* skip an unreadable file */
      }
    }
    if (files.length > 0) out.push({ slug, files });
  }
  return {
    projects: out,
    limits: {
      fileMaxBytes: DASHBOARD_MEMORY_FILE_MAX_BYTES,
      responseMaxBytes: DASHBOARD_MEMORY_RESPONSE_MAX_BYTES,
      maxFiles: DASHBOARD_MEMORY_MAX_FILES,
      directoryMaxEntries: DASHBOARD_MEMORY_DIR_MAX_ENTRIES,
    },
    skippedFiles,
    truncated,
  };
}

// Read a request body with a hard size cap. Mutating JSON payloads are small, so
// 1 MiB is a generous default that still stops a runaway client.
function readRequestBody(req, maxBytes = DASHBOARD_MUTATING_BODY_MAX_BYTES, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (message, { destroy = false } = {}) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(new Error(message));
      if (destroy) {
        req.destroy();
      } else {
        req.resume();
      }
    };
    const handleError = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('error', handleError);

    const declaredLength = Number(req.headers['content-length'] || '');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      fail(`Request body exceeds ${maxBytes} byte limit`);
      return;
    }

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(`Request body exceeds ${maxBytes} byte limit`, { destroy: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      resolve(raw ? buf : buf.toString('utf8'));
    });
  });
}

// GET /api/usage — live plan-limit gauge (#130). Reads the OAuth subscription
// credential from ~/.claude/.credentials.json (the SAME credential Claude Code
// itself uses) and makes one deliberately tiny throwaway ping through the
// registered Anthropic chokepoint purely to read back the rate-limit
// response headers, exactly as the `session-usage` skill does. Those headers
// carry the live 5-hour and 7-day window utilizations and are present even on a
// 429, so this still works when the user is already maxed out. The OAuth token
// stays server-side; only parsed numbers ever reach the browser.
//
// Degrade like /api/live: NEVER 500. When there is no credential file, no
// token in it, or no usage headers came back, return { available: false,
// reason } so the client can show a quiet "log in to Claude Code" affordance.

// findAccessToken, parseUsageWindow, and the payload assembly now live in
// src/lib/usage-gauge.ts (#626) as findAccessToken / parseUsageWindow /
// buildUsagePayload, imported at the top of this file.

async function handleUsage(req, res) {
  if (ENTERPRISE_AUTH_ON && !DASHBOARD_ENABLE_SERVER_USAGE_GAUGE) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.usage_gauge',
      outcome: 'skipped',
      status: 200,
      path: '/api/usage',
      reason: 'server_usage_gauge_disabled',
      principal: req.enterprisePrincipal,
    });
    live(res, 'application/json; charset=utf-8');
    sendBody(
      req,
      res,
      JSON.stringify({
        available: false,
        reason: 'server_usage_gauge_disabled',
      })
    );
    return;
  }

  // 1) Resolve the OAuth token. A missing file or absent token is a clean
  //    available:false, not an error.
  let token;
  try {
    const { text: raw } = await readUtf8FileCapped(
      join(CLAUDE, '.credentials.json'),
      DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES
    );
    token = findAccessToken(JSON.parse(raw));
  } catch {
    token = null;
  }
  if (!token) {
    live(res, 'application/json; charset=utf-8');
    sendBody(
      req,
      res,
      JSON.stringify({
        available: false,
        reason: 'not-logged-in',
      })
    );
    return;
  }

  // 2) One tiny throwaway ping (haiku, max_tokens: 1) purely to read the
  //    rate-limit headers back. They ride on every response, including a 429.
  let apiRes;
  try {
    apiRes = await callAnthropic('server.usage-gauge', {
      credential: { kind: 'oauth', token },
      path: '/messages',
      method: 'POST',
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      containsClaudeData: false,
    });
  } catch (err) {
    // Network failure reaching the API — degrade, never 500.
    console.error('usage ping failed:', err?.message ?? err);
    live(res, 'application/json; charset=utf-8');
    sendBody(
      req,
      res,
      JSON.stringify({ available: false, reason: 'fetch-failed' })
    );
    return;
  }

  // 3) Scrape the unified headers (strip the long prefix to short keys), then
  //    hand off to the extracted core to build the payload (windows, overage,
  //    representative-claim, or the available:false reason).
  const h = {};
  for (const [k, v] of apiRes.headers.entries()) {
    if (k.startsWith('anthropic-ratelimit-unified-')) {
      h[k.replace('anthropic-ratelimit-unified-', '')] = v;
    }
  }

  const payload = buildUsagePayload(h, apiRes.status);
  live(res, 'application/json; charset=utf-8');
  sendBody(req, res, JSON.stringify(payload));
}

// validatePermissionsBody, the append+dedupe merge, and the backup/write
// contract now live in src/lib/policy-writer.ts (#625) as validatePolicyInput /
// mergeAndDedupe / applyPolicyWrite, imported at the top of this file.

// --- Authentication gate for the mutating policy route (#308, #311) ---------
// The write to global ~/.claude/settings.json is defended in depth. Originally
// (#308) this had THREE layers: a loopback `remoteAddress` check, a same-origin
// Origin check, and a per-process token. Under podman's pasta NAT the container
// sees the pasta gateway as `req.socket.remoteAddress`, never a loopback
// literal, so the remoteAddress layer over-blocked every legitimate host→
// container request (#311). That NAT-fragile layer is dropped; the two
// remaining layers are independently sufficient against cross-origin CSRF:
//   - a cross-origin page cannot read the same-origin /api/csrf-token body
//     (SOP), so it cannot learn the token to forge the write;
//   - the Origin + Content-Type checks reject the simple-request CSRF vectors.
// The network boundary ("reachable from the host") is enforced by publishing
// the container port loopback-only on the host (docker-compose.local.yml:
// "127.0.0.1:5173:5173"), not by inspecting the NAT'd peer address.

// Constant-time token compare that tolerates length mismatch without throwing.
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest()
  );
}

function requestHeaderValues(req, name) {
  const lowerName = name.toLowerCase();
  const values = [];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
      if (String(req.rawHeaders[i] || '').toLowerCase() === lowerName) {
        values.push(String(req.rawHeaders[i + 1] || ''));
      }
    }
  }
  if (values.length > 0) return values;
  const value = req.headers[lowerName];
  if (Array.isArray(value)) return value.map((item) => String(item || ''));
  return typeof value === 'string' ? [value] : [];
}

function singleRequestHeaderValue(req, name) {
  const values = requestHeaderValues(req, name)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return values.length === 1 ? values[0] : '';
}

// Pull the write CSRF token from X-CSRF-Token when present. Authorization:
// Bearer remains a fallback for older/local callers, while enterprise bearer
// auth can coexist in Authorization for route authorization.
function extractToken(req) {
  const csrf = singleRequestHeaderValue(req, 'x-csrf-token');
  if (csrf) {
    return Buffer.byteLength(csrf, 'utf8') > POLICY_WRITE_TOKEN_MAX_BYTES
      ? null
      : csrf;
  }
  const auth = singleRequestHeaderValue(req, 'authorization');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const token = m[1].trim();
    return Buffer.byteLength(token, 'utf8') > POLICY_WRITE_TOKEN_MAX_BYTES
      ? null
      : token;
  }
  return null;
}

function extractBearerToken(req) {
  const auth = singleRequestHeaderValue(req, 'authorization');
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (Buffer.byteLength(token, 'utf8') > ENTERPRISE_MAX_BEARER_TOKEN_BYTES) {
    return null;
  }
  return token;
}

function enterpriseSessionSecretConfig() {
  const secretConfig = readEnterpriseSessionSecretConfig({
    envName: 'DASHBOARD_AUTH_SESSION_SECRET',
    fileName: 'DASHBOARD_AUTH_SESSION_SECRET_FILE',
  });
  const currentKeyConfig = deriveEnterpriseSessionSecretKey(secretConfig);
  const previousSecretConfig = readEnterpriseSessionSecretConfig({
    envName: 'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET',
    fileName: 'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE',
  });
  const previousKeyConfig =
    previousSecretConfig.configured || previousSecretConfig.error
      ? deriveEnterpriseSessionSecretKey(previousSecretConfig)
      : null;
  const errors = [
    currentKeyConfig.error,
    previousKeyConfig?.error,
    previousSecretConfig.configured && !secretConfig.configured
      ? 'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET requires DASHBOARD_AUTH_SESSION_SECRET or DASHBOARD_AUTH_SESSION_SECRET_FILE'
      : null,
  ].filter(Boolean);
  if (errors.length > 0) {
    const key = randomBytes(32);
    return {
      key,
      decryptKeys: [key],
      stable: false,
      previousKeyCount: 0,
      error: errors.join('; '),
    };
  }
  if (!currentKeyConfig.stable) {
    return {
      key: currentKeyConfig.key,
      decryptKeys: [currentKeyConfig.key],
      stable: false,
      previousKeyCount: 0,
      error: null,
    };
  }
  const decryptKeys = [currentKeyConfig.key];
  if (previousKeyConfig?.stable && !previousKeyConfig.key.equals(currentKeyConfig.key)) {
    decryptKeys.push(previousKeyConfig.key);
  }
  return {
    key: currentKeyConfig.key,
    decryptKeys,
    stable: true,
    previousKeyCount: decryptKeys.length - 1,
    error: null,
  };
}

function deriveEnterpriseSessionSecretKey(secretConfig) {
  if (secretConfig.error) {
    return {
      key: randomBytes(32),
      stable: false,
      configured: secretConfig.configured,
      error: secretConfig.error,
    };
  }
  const raw = secretConfig.rawSecret;
  if (!raw && !secretConfig.configured) {
    return {
      key: randomBytes(32),
      stable: false,
      configured: false,
      error: null,
    };
  }
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.byteLength > ENTERPRISE_SESSION_SECRET_MAX_BYTES) {
    return {
      key: randomBytes(32),
      stable: false,
      configured: secretConfig.configured,
      error: `${secretConfig.source} exceeds ${ENTERPRISE_SESSION_SECRET_MAX_BYTES} byte limit`,
    };
  }
  if (bytes.byteLength < ENTERPRISE_SESSION_SECRET_MIN_BYTES) {
    return {
      key: randomBytes(32),
      stable: false,
      configured: secretConfig.configured,
      error: `${secretConfig.source} must be at least ${ENTERPRISE_SESSION_SECRET_MIN_BYTES} bytes`,
    };
  }
  return {
    key: createHash('sha256').update(bytes).digest(),
    stable: true,
    configured: true,
    error: null,
  };
}

function readEnterpriseSessionSecretConfig({ envName, fileName }) {
  const envSecret = String(process.env[envName] || '').trim();
  const secretFile = String(process.env[fileName] || '').trim();
  if (envSecret && secretFile) {
    return {
      rawSecret: '',
      source: fileName,
      configured: true,
      error: `${envName} and ${fileName} cannot both be configured`,
    };
  }
  if (!secretFile) {
    return {
      rawSecret: envSecret,
      source: envName,
      configured: Boolean(envSecret),
      error: null,
    };
  }
  if (!isAbsolute(secretFile)) {
    return {
      rawSecret: '',
      source: fileName,
      configured: true,
      error: `${fileName} must be an absolute path`,
    };
  }
  let fd = null;
  try {
    fd = openSync(secretFile, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) {
      return {
        rawSecret: '',
        source: fileName,
        configured: true,
        error: `${fileName} must point to a regular file`,
      };
    }
    if (info.size > ENTERPRISE_SESSION_SECRET_MAX_BYTES) {
      return {
        rawSecret: '',
        source: fileName,
        configured: true,
        error: `${fileName} exceeds ${ENTERPRISE_SESSION_SECRET_MAX_BYTES} byte limit`,
      };
    }
    const chunks = [];
    let totalBytes = 0;
    const maxReadBytes = ENTERPRISE_SESSION_SECRET_MAX_BYTES + 1;
    while (totalBytes < maxReadBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maxReadBytes - totalBytes));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > ENTERPRISE_SESSION_SECRET_MAX_BYTES) {
        return {
          rawSecret: '',
          source: fileName,
          configured: true,
          error: `${fileName} exceeds ${ENTERPRISE_SESSION_SECRET_MAX_BYTES} byte limit`,
        };
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return {
      rawSecret: Buffer.concat(chunks, totalBytes).toString('utf8').trim(),
      source: fileName,
      configured: true,
      error: null,
    };
  } catch {
    return {
      rawSecret: '',
      source: fileName,
      configured: true,
      error: `${fileName} could not be read`,
    };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup of startup config descriptor */
      }
    }
  }
}

function enterpriseSessionEpochConfig() {
  const value = String(process.env.DASHBOARD_AUTH_SESSION_EPOCH || '').trim();
  if (Buffer.byteLength(value, 'utf8') > ENTERPRISE_SESSION_EPOCH_MAX_BYTES) {
    return {
      value: '',
      error: `DASHBOARD_AUTH_SESSION_EPOCH exceeds ${ENTERPRISE_SESSION_EPOCH_MAX_BYTES} byte limit`,
    };
  }
  return { value, error: null };
}

function enterpriseCredentialHashFromToken(token) {
  if (!token) return undefined;
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function requestCookieValues(req, name) {
  const matches = [];
  for (const header of requestHeaderValues(req, 'cookie')) {
    for (const part of String(header || '').split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      if (key !== name) continue;
      const value = part.slice(index + 1).trim();
      if (value) matches.push(value);
    }
  }
  return matches;
}

function requestEnterpriseSessionCookie(req) {
  const values = requestCookieValues(req, ENTERPRISE_SESSION_COOKIE_NAME);
  return values.length === 1 ? values[0] : '';
}

function hasEnterpriseSessionCookie(req) {
  return requestCookieValues(req, ENTERPRISE_SESSION_COOKIE_NAME).length > 0;
}

function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, value]);
  } else {
    res.setHeader('Set-Cookie', [String(current), value]);
  }
}

function enterpriseSessionCookieAttributes(maxAgeSeconds) {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ENTERPRISE_SESSION_COOKIE_SECURE ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function clearEnterpriseSessionCookie(res) {
  appendSetCookie(
    res,
    `${ENTERPRISE_SESSION_COOKIE_NAME}=; ${enterpriseSessionCookieAttributes(0)}`
  );
}

function enterpriseSessionCookieValue(principal, expiresAtSeconds = null) {
  const now = Math.floor(Date.now() / 1000);
  const maxExp = now + ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS;
  const configuredExp = Number(expiresAtSeconds);
  const exp =
    Number.isFinite(configuredExp) && configuredExp > now
      ? Math.min(Math.floor(configuredExp), maxExp)
      : maxExp;
  const payload = {
    v: 1,
    iat: now,
    exp,
    epoch: ENTERPRISE_SESSION_EPOCH_CONFIG.value,
    principal,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENTERPRISE_SESSION_SECRET_CONFIG.key, iv);
  cipher.setAAD(ENTERPRISE_SESSION_COOKIE_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function openEnterpriseSessionCookie(value) {
  const cookie = String(value || '').trim();
  if (!cookie) return { principal: null, reason: 'missing_session' };
  if (Buffer.byteLength(cookie, 'utf8') > ENTERPRISE_SESSION_COOKIE_MAX_BYTES) {
    return { principal: null, reason: 'session_cookie_too_large' };
  }
  const parts = cookie.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { principal: null, reason: 'invalid_session' };
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      return { principal: null, reason: 'invalid_session' };
    }
    const decryptKeys = ENTERPRISE_SESSION_SECRET_CONFIG.decryptKeys || [
      ENTERPRISE_SESSION_SECRET_CONFIG.key,
    ];
    for (const key of decryptKeys) {
      const session = openEnterpriseSessionCookieWithKey(cookie, key, iv, ciphertext, tag);
      if (session.reason !== 'invalid_session') return session;
    }
    return { principal: null, reason: 'invalid_session' };
  } catch {
    return { principal: null, reason: 'invalid_session' };
  }
}

function openEnterpriseSessionCookieWithKey(cookie, key, iv, ciphertext, tag) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(ENTERPRISE_SESSION_COOKIE_AAD);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    const payload = JSON.parse(raw);
    if (!payload || payload.v !== 1 || !payload.principal || typeof payload.principal !== 'object') {
      return { principal: null, reason: 'invalid_session' };
    }
    const exp = Number(payload.exp);
    const iat = Number(payload.iat);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(exp) || exp <= now) {
      return { principal: null, reason: 'expired_session' };
    }
    if (!Number.isFinite(iat) || iat > now + 60 || exp - iat > ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS) {
      return { principal: null, reason: 'invalid_session' };
    }
    if (String(payload.epoch || '') !== ENTERPRISE_SESSION_EPOCH_CONFIG.value) {
      return { principal: null, reason: 'stale_session' };
    }
    const principal = normalizeEnterprisePrincipal(payload.principal);
    if (!principal.userId || !principal.orgId) {
      return { principal: null, reason: 'invalid_session' };
    }
    return {
      principal,
      reason: null,
      sessionHash: createHash('sha256').update(cookie).digest('hex').slice(0, 24),
    };
  } catch {
    return { principal: null, reason: 'invalid_session' };
  }
}

function enterpriseTokenSessionExpiresAt(token) {
  const parsed = parseJwt(token);
  const exp = Number(parsed?.claims?.exp);
  return Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : null;
}

function setEnterpriseSessionCookie(res, principal, expiresAtSeconds = null) {
  const now = Math.floor(Date.now() / 1000);
  const maxAgeSeconds =
    expiresAtSeconds && expiresAtSeconds > now
      ? Math.min(ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS, expiresAtSeconds - now)
      : ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS;
  const value = enterpriseSessionCookieValue(principal, expiresAtSeconds);
  if (Buffer.byteLength(value, 'utf8') > ENTERPRISE_SESSION_COOKIE_MAX_BYTES) {
    return false;
  }
  appendSetCookie(
    res,
    `${ENTERPRISE_SESSION_COOKIE_NAME}=${value}; ${enterpriseSessionCookieAttributes(maxAgeSeconds)}`
  );
  return true;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function normalizeEnterpriseTokenSha256(raw) {
  const value = String(raw || '').trim();
  const hex = value.toLowerCase().startsWith('sha256:')
    ? value.slice('sha256:'.length)
    : value;
  const normalized = hex.toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : '';
}

function firstEnterpriseTokenSha256(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeEnterpriseTokenSha256(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function enterpriseCredentialFingerprint(record) {
  const tokenSha256 = normalizeEnterpriseTokenSha256(record?.tokenSha256);
  if (tokenSha256) return tokenSha256;
  const token = String(record?.token || '').trim();
  return token ? createHash('sha256').update(token).digest('hex') : '';
}

function enterpriseRawTokenMetadata(token) {
  const value = String(token || '').trim();
  if (!value) {
    return { tokenSha256: '', rawTokenConfigured: false, rawTokenLength: 0 };
  }
  return {
    tokenSha256: createHash('sha256').update(value).digest('hex'),
    rawTokenConfigured: true,
    rawTokenLength: value.length,
  };
}

// True when the request's Origin header names this server's own loopback origin
// on the bound PORT, or an operator-configured public origin. A missing Origin
// is rejected (a same-origin fetch from the SPA always sends one for a non-GET
// cross-origin-capable request; CSRF probes with no Origin must not pass).
function isSameOrigin(req) {
  const origin = singleRequestHeaderValue(req, 'origin');
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return DASHBOARD_WRITE_ORIGINS.includes(parsed.origin);
}

// Run the full auth gate for the write route. Returns true when the request may
// proceed; otherwise writes the appropriate rejection response and returns
// false. Layers (in order, all required):
//   1. same-origin Origin on bound PORT  -> 403 if foreign/absent
//   2. Content-Type exactly application/json -> 415 otherwise
//   3. per-process token (Bearer/X-CSRF-Token) -> 401 on missing/mismatch
// (The #308 loopback-`remoteAddress` layer was removed in #311 because podman's
// pasta NAT makes the peer address the gateway, not a loopback literal; the
// network boundary is now the loopback-bound host port publish.)
function passesWriteAuth(req, res) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden: cross-origin request rejected' });
    return false;
  }
  const ctype = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (ctype !== 'application/json') {
    sendJson(res, 415, { ok: false, error: 'Unsupported Media Type: Content-Type must be application/json' });
    return false;
  }
  if (!tokensMatch(extractToken(req), POLICY_WRITE_TOKEN)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized: missing or invalid CSRF token' });
    return false;
  }
  return true;
}

// POST /api/policy/write — write-back for the Policy Builder (#199). Appends the
// generated permission rules into the GLOBAL ~/.claude/settings.json. Safety
// contract (non-negotiable): validate the body first; back up the existing file
// with a timestamped copy BEFORE writing; append + dedupe (never drop/rewrite
// existing rules; idempotent). On any failure return non-200 and leave the
// original file untouched.
async function handlePolicyWrite(req, res) {
  // 0) Authenticate the caller before touching the body or the file (#308,
  //    #311): same-origin + application/json + per-process token. Any failure
  //    short-circuits with a rejection and leaves settings.json intact.
  if (!passesWriteAuth(req, res)) return;

  // 1) Read + parse the body (HTTP framing), then hand off to the extracted
  //    core. Validation, the corrupt-file refusal, the timestamped backup, and
  //    the append+dedupe write all live in src/lib/policy-writer.ts (#625);
  //    this handler only maps results to status codes.
  let raw;
  try {
    raw = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 413, { ok: false, error: err.message || 'Failed to read request body' });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON' });
  }
  const valid = validatePolicyInput(parsed);
  if (!valid.ok) {
    return sendJson(res, 400, { ok: false, error: valid.error });
  }

  const file = join(CLAUDE, 'settings.json');
  const result = await applyPolicyWrite(file, valid.perms, {
    maxExistingBytes: CONFIG_FILE_MAX_BYTES,
  });
  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error });
  }

  return sendJson(res, 200, {
    ok: true,
    file: result.file,
    backup: result.backup,
    added: result.added,
    addedCount: result.addedCount,
  });
}

// POST /api/adoption/receipts — append-only recs adoption receipt writer
// (#575). Same auth gate as policy write because this is a mutating local route,
// but it writes only to the dashboard-owned data dir and the core writer drops
// every non-allowlisted field before append.
async function handleAdoptionReceiptWrite(req, res) {
  if (!passesWriteAuth(req, res)) return;

  let raw;
  try {
    raw = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 413, { ok: false, error: err.message || 'Failed to read request body' });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON' });
  }

  const result = await appendAdoptionReceipt(ADOPTION_RECEIPTS, parsed, {
    shadowCallsDir: SHADOW_CALLS_DIR,
  });
  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error });
  }
  return sendJson(res, 200, result);
}

// --- Session dispatch (#1251, Slice 1) ------------------------------------------------------------
// Create/list/delete RemoteSession CRs on the cluster so org members provision claude.ai/code
// sessions from the dashboard. SERVER-TIER only (the static SPA can't reach a cluster). All cluster
// I/O is lazy-imported inside handlers so the server boots fine with no cluster configured (MEMORY
// server-runtime-has-no-node-modules). Talking to the kube API is NOT an Anthropic call — ADR 0008
// governance does not apply.
const PROBAITIO_CLUSTER_NAME = process.env.PROBAITIO_CLUSTER_NAME || 'hub';

function projectRemoteSession(item) {
  const spec = item?.spec || {};
  const status = item?.status || {};
  return {
    name: item?.metadata?.name || '',
    displayName: spec.displayName || '',
    repo: spec.repo || '',
    ref: spec.ref || '',
    poolSize: spec.poolSize ?? 0,
    phase: status.phase || '',
    reason: status.reason || '',
    warmReady: status.warmReady ?? 0,
    url: status.url || '',
    podName: status.podName || '',
    pods: Array.isArray(status.pods)
      ? status.pods.map((p) => ({
          name: p.name || '',
          phase: p.phase || '',
          registeredEnvUrl: p.registeredEnvUrl || '',
          registeredEnvName: p.registeredEnvName || '',
        }))
      : [],
    creationTimestamp: item?.metadata?.creationTimestamp || '',
  };
}

async function handleSessionsList(_req, res) {
  let kube;
  try {
    kube = await import('./lib/kube-client.mjs');
  } catch {
    return sendJson(res, 500, { ok: false, error: 'dispatch module unavailable' });
  }
  if (!kube.isConfigured()) {
    return sendJson(res, 200, { ok: true, configured: false, sessions: [] });
  }
  try {
    const ns = kube.dispatchNamespace();
    const list = await kube.remoteSessions.list(ns);
    const sessions = (list.items || []).map(projectRemoteSession);
    return sendJson(res, 200, {
      ok: true,
      configured: true,
      namespace: ns,
      cluster: PROBAITIO_CLUSTER_NAME,
      sessions,
    });
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: e.message || 'cluster list failed' });
  }
}

async function handleSessionsCreate(req, res) {
  if (!passesWriteAuth(req, res)) return;
  let raw;
  try {
    raw = await readRequestBody(req);
  } catch (err) {
    return sendJson(res, 413, { ok: false, error: err.message || 'Failed to read request body' });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON' });
  }
  let dispatch;
  try {
    dispatch = await import('./lib/remotesession-dispatch.mjs');
  } catch {
    return sendJson(res, 500, { ok: false, error: 'dispatch module unavailable' });
  }
  const v = dispatch.validateDispatchInput(body);
  if (!v.ok) return sendJson(res, 400, { ok: false, error: v.errors.join('; ') });

  let kube;
  try {
    kube = await import('./lib/kube-client.mjs');
  } catch {
    return sendJson(res, 500, { ok: false, error: 'dispatch module unavailable' });
  }
  if (!kube.isConfigured()) {
    return sendJson(res, 503, { ok: false, error: 'no cluster configured for dispatch' });
  }
  const manifest = dispatch.buildRemoteSessionManifest({
    cluster: PROBAITIO_CLUSTER_NAME,
    repo: v.repo,
    ref: v.ref,
    displayName: v.displayName,
    poolSize: v.poolSize,
  });
  const ns = kube.dispatchNamespace();
  try {
    const created = await kube.remoteSessions.create(ns, manifest);
    return sendJson(res, 201, { ok: true, session: projectRemoteSession(created) });
  } catch (e) {
    if (e.status === 409) {
      // Deterministic name => re-provision of the same repo. MVP: surface as already-provisioned;
      // the existing CR keeps the pool warm and the card refreshes the live list.
      return sendJson(res, 200, { ok: true, alreadyProvisioned: true, name: manifest.metadata.name });
    }
    return sendJson(res, 502, { ok: false, error: e.message || 'cluster create failed' });
  }
}

async function handleSessionsDelete(req, res, name) {
  if (!passesWriteAuth(req, res)) return;
  // Strict RFC1123-subdomain: MUST start and end alphanumeric. This rejects dot-only segments
  // (".", "..") that WHATWG URL parsing would normalize into a parent path (.../remotesessions/.. =>
  // .../namespaces/<ns>/), so a delete can never escape the per-session collection segment.
  if (!name || name.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    return sendJson(res, 400, { ok: false, error: 'invalid session name' });
  }
  let kube;
  try {
    kube = await import('./lib/kube-client.mjs');
  } catch {
    return sendJson(res, 500, { ok: false, error: 'dispatch module unavailable' });
  }
  if (!kube.isConfigured()) {
    return sendJson(res, 503, { ok: false, error: 'no cluster configured for dispatch' });
  }
  const ns = kube.dispatchNamespace();
  try {
    await kube.remoteSessions.del(ns, name);
    return sendJson(res, 200, { ok: true, deleted: name });
  } catch (e) {
    if (e.status === 404) return sendJson(res, 404, { ok: false, error: 'session not found' });
    return sendJson(res, 502, { ok: false, error: e.message || 'cluster delete failed' });
  }
}

// --- Session-history push-ingest (#1563 Slice 1, ADR 0009 §3) ------------------------------------
// The session-data shipper (a sidecar in each remote-control pod) POSTs its session artifacts here;
// the dashboard writes them collision-free under a per-source namespace it later aggregates. Auth is
// a shared bearer token (the shipper is cross-origin from a pod, so the same-origin CSRF gate does
// not apply); endpoint is DISABLED (no token / no ingest dir configured) to fail safe.
const PROBAITIO_INGEST_DIR = process.env.PROBAITIO_INGEST_DIR || '';
const PROBAITIO_INGEST_TOKEN = process.env.PROBAITIO_INGEST_TOKEN || '';
const INGEST_MAX_ARTIFACTS = 2000; // per batch
const INGEST_MAX_BYTES = 64 * 1024 * 1024; // per artifact (decoded)

function ingestEnabled() {
  return Boolean(PROBAITIO_INGEST_DIR && PROBAITIO_INGEST_TOKEN);
}

function passesIngestAuth(req, res) {
  if (!tokensMatch(extractToken(req), PROBAITIO_INGEST_TOKEN)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized: missing or invalid ingest token' });
    return false;
  }
  return true;
}

// A source id is one shipper's stream (one session pod) — must be a safe single path segment so it
// can never escape the ingest dir. The member/displayName is provenance metadata, not the id.
function safeSourceId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,126}$/.test(id) && id !== '.' && id !== '..';
}

async function handleIngestArtifacts(req, res, sourceId) {
  if (!ingestEnabled()) {
    return sendJson(res, 503, { ok: false, error: 'ingest not configured on this dashboard' });
  }
  if (!passesIngestAuth(req, res)) return;
  if (!safeSourceId(sourceId)) {
    return sendJson(res, 400, { ok: false, error: 'invalid source id' });
  }
  let bodyBuf;
  try {
    bodyBuf = await readRequestBody(req, INGEST_MAX_BYTES + 1024 * 1024, { raw: true });
  } catch (err) {
    return sendJson(res, 413, { ok: false, error: err.message || 'Failed to read request body' });
  }
  let body;
  try {
    // The shipper may gzip the body (it compresses ~3x; the base64 transcript payload is bulky).
    // Bound the inflated size to guard against a gzip bomb.
    const gz = String(req.headers['content-encoding'] || '').toLowerCase().includes('gzip');
    const json = (gz ? gunzipSync(bodyBuf, { maxOutputLength: 4 * INGEST_MAX_BYTES }) : bodyBuf).toString('utf8');
    body = JSON.parse(json);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON (or gunzip failed)' });
  }
  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : null;
  if (!artifacts) return sendJson(res, 400, { ok: false, error: 'artifacts[] required' });
  if (artifacts.length > INGEST_MAX_ARTIFACTS) {
    return sendJson(res, 413, { ok: false, error: `too many artifacts (max ${INGEST_MAX_ARTIFACTS})` });
  }

  const { classifyClaudePath } = await import('../src/lib/claude-tree-classification.ts');
  // Write into the SHARED tree (#1563 Slice 2): session-data lands at its natural relPath under the
  // ingest dir, so when PROBAITIO_INGEST_DIR = CLAUDE_DIR the dashboard's existing projects/ root
  // aggregates ALL members dynamically (transcripts are UUID-named => collision-free; the shipper
  // already routes the single history.jsonl to a per-session history.d/<sourceId>.jsonl). The
  // per-source idempotency ledger + member provenance live OUT of band under .sources/<sourceId>/
  // (a path no session-data artifact can target, since the classifier only admits session-data).
  try {
    await mkdir(PROBAITIO_INGEST_DIR, { recursive: true });
  } catch {
    return sendJson(res, 500, { ok: false, error: 'ingest dir unavailable' });
  }
  const realIngest = await realpathOrNull(PROBAITIO_INGEST_DIR);
  if (!realIngest) return sendJson(res, 500, { ok: false, error: 'ingest dir unavailable' });
  const metaRoot = join(PROBAITIO_INGEST_DIR, '.sources', sourceId);
  await mkdir(metaRoot, { recursive: true });

  // Per-source single-writer ledger: relPath -> last signature; a re-shipped artifact is skipped.
  const ledgerPath = join(metaRoot, '.signatures.json');
  let ledger = {};
  try {
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) || {};
  } catch {
    ledger = {};
  }

  let written = 0;
  let skipped = 0;
  const refused = [];
  for (const a of artifacts) {
    const relPath = typeof a?.relPath === 'string' ? a.relPath.replace(/\\/g, '/').replace(/^\.?\//, '') : '';
    const signature = typeof a?.signature === 'string' ? a.signature : '';
    if (!relPath || relPath.includes('..')) {
      refused.push({ relPath, reason: 'bad-path' });
      continue;
    }
    if (classifyClaudePath(relPath) !== 'session-data') {
      refused.push({ relPath, reason: 'not-session-data' }); // refuse config + secret (ADR 0009)
      continue;
    }
    if (signature && ledger[relPath] === signature) {
      skipped += 1; // idempotent: already have this exact content
      continue;
    }
    const dest = join(PROBAITIO_INGEST_DIR, relPath);
    // Confirm the destination stays inside the ingest dir (no traversal).
    if (!pathInside(realIngest, normalize(dest))) {
      refused.push({ relPath, reason: 'escapes-root' });
      continue;
    }
    const buf = a?.contentB64
      ? Buffer.from(String(a.contentB64), 'base64')
      : Buffer.from(String(a?.content ?? ''), 'utf8');
    if (buf.length > INGEST_MAX_BYTES) {
      refused.push({ relPath, reason: 'too-large' });
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    // Re-verify containment against the symlink-RESOLVED parent (the normalize()
    // gate above is symlink-blind), then open with O_NOFOLLOW so neither a
    // symlinked parent component nor a symlinked dest can redirect the write
    // outside the ingest root (#2065).
    const realParent = await realpathOrNull(dirname(dest));
    if (!realParent || !pathInside(realIngest, realParent)) {
      refused.push({ relPath, reason: 'escapes-root' });
      continue;
    }
    let fh;
    try {
      fh = await open(
        dest,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        0o600
      );
      await fh.writeFile(buf);
    } catch (err) {
      if (err?.code === 'ELOOP') {
        refused.push({ relPath, reason: 'symlink-dest' });
        continue;
      }
      throw err;
    } finally {
      await fh?.close();
    }
    if (signature) ledger[relPath] = signature;
    written += 1;
  }

  // Provenance: stamp member/displayName/repo so the dashboard can attribute aggregated sessions.
  if (body?.meta && typeof body.meta === 'object') {
    try {
      await writeFile(join(metaRoot, '_source.json'), JSON.stringify({ sourceId, ...body.meta }));
    } catch {
      /* best-effort provenance */
    }
  }
  try {
    await writeFile(ledgerPath, JSON.stringify(ledger));
  } catch {
    /* ledger persistence is best-effort; a lost ledger just re-writes identical content next time */
  }
  return sendJson(res, 200, { ok: true, sourceId, written, skipped, refused });
}

// GET /api/adoption/receipts — read-only replay of the append-only receipt log
// (#577). Each line is re-sanitized through the SAME allowlist-drop writer used
// on write, so a hand-edited or legacy line can never surface a field outside
// the SURFACED/SUPPRESSED allowlist. Empty array when the store does not exist.
async function handleAdoptionReceiptRead(req, res) {
  try {
    // Delegate to the single canonical read-side parse->sanitize loop so this
    // route's allowlist drop stays identical to the writer/index/spool paths.
    const { receipts } = await readAdoptionReceipts(ADOPTION_RECEIPTS, {
      maxBytes: DASHBOARD_ADOPTION_RECEIPT_READ_MAX_BYTES,
    });
    return sendJson(res, 200, { ok: true, receipts });
  } catch (err) {
    return sendJson(res, 500, {
      ok: false,
      error: `Failed to read adoption receipts: ${err.message}`,
    });
  }
}

// Optional HTTP Basic Auth gate. When DASHBOARD_USER + DASHBOARD_PASS are both
// set, every route requires them — this is what protects the dashboard once the
// host port is bound beyond loopback (the server reads ~/.claude live). Unset →
// open (the loopback-only default needs no auth). Credentials come from env so
// no secret lives in the repo. NOTE: Basic Auth over plain HTTP is cleartext —
// only expose on a trusted network or behind TLS / a tunnel.
const BASIC_AUTH_USER_CONFIG = parseBasicAuthCredentialEnv('DASHBOARD_USER');
const BASIC_AUTH_PASS_CONFIG = parseBasicAuthCredentialEnv('DASHBOARD_PASS');
const BASIC_AUTH_ON =
  BASIC_AUTH_USER_CONFIG.configured && BASIC_AUTH_PASS_CONFIG.configured;
function checkBasicAuth(req, { allowEnterpriseBearer = false } = {}) {
  if (!BASIC_AUTH_ON) return true; // not configured → open (loopback default)
  const auth = singleRequestHeaderValue(req, 'authorization');
  if (
    allowEnterpriseBearer &&
    ENTERPRISE_AUTH_ON &&
    (/^Bearer\s+.+/i.test(auth) || Boolean(requestEnterpriseSessionCookie(req)))
  ) {
    return true;
  }
  if (BASIC_AUTH_USER_CONFIG.maxBytesExceeded || BASIC_AUTH_PASS_CONFIG.maxBytesExceeded) {
    return false;
  }
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (!m) return false;
  if (Buffer.byteLength(m[1], 'utf8') > DASHBOARD_BASIC_AUTH_HEADER_MAX_BYTES) {
    return false;
  }
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const ix = decoded.indexOf(':');
  if (ix === -1) return false;
  const username = decoded.slice(0, ix);
  const password = decoded.slice(ix + 1);
  if (
    Buffer.byteLength(username, 'utf8') > DASHBOARD_BASIC_AUTH_MAX_BYTES ||
    Buffer.byteLength(password, 'utf8') > DASHBOARD_BASIC_AUTH_MAX_BYTES
  ) {
    return false;
  }
  // sha256 each side to a fixed length so timingSafeEqual neither throws on a
  // length mismatch nor leaks the credential length via timing.
  const eq = (provided, expectedDigest) =>
    Buffer.isBuffer(expectedDigest) &&
    timingSafeEqual(
      createHash('sha256').update(provided).digest(),
      expectedDigest
    );
  return eq(username, BASIC_AUTH_USER_CONFIG.digest) && eq(password, BASIC_AUTH_PASS_CONFIG.digest);
}

const ENTERPRISE_AUTH_MODE =
  String(process.env.DASHBOARD_AUTH_MODE || '').toLowerCase() === 'enterprise';
const ENTERPRISE_PRINCIPAL_FIELD_MAX_CHARS = Math.max(
  64,
  Math.min(
    4_096,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS', 512)
  )
);
const ENTERPRISE_SCOPE_MAX_ENTRIES = Math.max(
  1,
  Math.min(1_024, parseNonNegativeIntEnv('DASHBOARD_AUTH_SCOPE_MAX_ENTRIES', 64))
);
const ENTERPRISE_SCOPE_SOURCE_MAX_BYTES = Math.max(
  128,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES', 8_192)
  )
);
const ENTERPRISE_SCOPE_MAX_CHARS = Math.max(
  16,
  Math.min(1_024, parseNonNegativeIntEnv('DASHBOARD_AUTH_SCOPE_MAX_CHARS', 128))
);
const ENTERPRISE_JWT_PINNING_MAX_BYTES = Math.max(
  128,
  Math.min(
    16_384,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES', 2_048)
  )
);
const ENTERPRISE_ORG_ID = firstNonEmptyString(
  process.env.DASHBOARD_ORG_ID,
  'local-org'
);
const ENTERPRISE_ORG_NAME = firstNonEmptyString(
  process.env.DASHBOARD_ORG_NAME,
  'Local organization'
);
const {
  value: ENTERPRISE_JWT_ISSUER,
  error: ENTERPRISE_JWT_ISSUER_CONFIG_ERROR,
} = parseBoundedTrimmedEnv(
  'DASHBOARD_AUTH_JWT_ISSUER',
  ENTERPRISE_JWT_PINNING_MAX_BYTES
);
const {
  value: ENTERPRISE_JWT_AUDIENCE,
  error: ENTERPRISE_JWT_AUDIENCE_CONFIG_ERROR,
} = parseBoundedTrimmedEnv(
  'DASHBOARD_AUTH_JWT_AUDIENCE',
  ENTERPRISE_JWT_PINNING_MAX_BYTES
);
const ENTERPRISE_JWT_ORG_ID_CLAIM = String(
  process.env.DASHBOARD_AUTH_JWT_ORG_ID_CLAIM || ''
).trim();
const ENTERPRISE_JWT_ROLE_CLAIM =
  process.env.DASHBOARD_AUTH_JWT_ROLE_CLAIM || 'role';
const ENTERPRISE_JWT_SCOPE_CLAIM =
  process.env.DASHBOARD_AUTH_JWT_SCOPE_CLAIM || 'scope';
const ENTERPRISE_JWT_TEAM_ID_CLAIM =
  process.env.DASHBOARD_AUTH_JWT_TEAM_ID_CLAIM || 'team';
const ENTERPRISE_JWT_TEAM_NAME_CLAIM =
  process.env.DASHBOARD_AUTH_JWT_TEAM_NAME_CLAIM || 'team_name';
const ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES = Math.max(
  128,
  Math.min(
    65_536,
    parseNonNegativeIntEnv(
      'DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES',
      4_096
    )
  )
);
const {
  template: ENTERPRISE_JWT_DATA_ROOT_TEMPLATE,
  configured: ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_CONFIGURED,
  maxBytesExceeded: ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES_EXCEEDED,
} = parseJwtDataRootTemplateEnv('DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE');
const ENTERPRISE_JWT_CLAIM_PATH_MAX_BYTES = Math.max(
  32,
  Math.min(
    4_096,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_BYTES', 512)
  )
);
const ENTERPRISE_JWT_CLAIM_PATH_MAX_SEGMENTS = Math.max(
  1,
  Math.min(
    64,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS', 16)
  )
);
const ENTERPRISE_JWT_HEADER_MAX_BYTES = Math.max(
  64,
  Math.min(
    16_384,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_HEADER_MAX_BYTES', 2_048)
  )
);
const ENTERPRISE_JWT_CLAIMS_MAX_BYTES = Math.max(
  128,
  Math.min(
    262_144,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_CLAIMS_MAX_BYTES', 16_384)
  )
);
const ENTERPRISE_JWT_SIGNATURE_MAX_BYTES = Math.max(
  64,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_SIGNATURE_MAX_BYTES', 4_096)
  )
);
const ENTERPRISE_DATA_ROOT_BASE = normalizeEnterpriseDataRootPath(
  process.env.DASHBOARD_AUTH_DATA_ROOT_BASE || ''
);
const ENTERPRISE_JWKS_URL_MAX_BYTES = Math.max(
  128,
  Math.min(
    16_384,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_URL_MAX_BYTES', 2_048)
  )
);
const ENTERPRISE_JWKS_URL = String(
  process.env.DASHBOARD_AUTH_JWKS_URL || ''
).trim();
const ENTERPRISE_JWKS_CACHE_TTL_MS = Math.max(
  30_000,
  Math.min(
    3_600_000,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_CACHE_TTL_MS', 300_000)
  )
);
const ENTERPRISE_JWKS_FETCH_TIMEOUT_MS = Math.max(
  500,
  Math.min(
    30_000,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_FETCH_TIMEOUT_MS', 5_000)
  )
);
const ENTERPRISE_JWKS_MAX_BYTES = Math.max(
  1_024,
  Math.min(
    1_048_576,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_MAX_BYTES', 65_536)
  )
);
const ENTERPRISE_JWKS_MAX_KEYS = Math.max(
  1,
  Math.min(1_024, parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_MAX_KEYS', 32))
);
const ENTERPRISE_JWKS_MIN_REFRESH_MS = Math.max(
  1_000,
  Math.min(
    300_000,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWKS_MIN_REFRESH_MS', 30_000)
  )
);
const ENTERPRISE_JWT_MIN_RSA_BITS = Math.max(
  2048,
  Math.min(
    16_384,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_MIN_RSA_BITS', 2048)
  )
);
const ENTERPRISE_JWT_MAX_LIFETIME_SECONDS = Math.min(
  2_592_000,
  parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_MAX_LIFETIME_SECONDS', 86_400)
);
const ENTERPRISE_JWT_CLOCK_SKEW_SECONDS = Math.min(
  300,
  parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_CLOCK_SKEW_SECONDS', 60)
);
const ENTERPRISE_JWT_ROLE_MAP_MAX_BYTES = Math.max(
  128,
  Math.min(
    65_536,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES', 8_192)
  )
);
const ENTERPRISE_JWT_ROLE_MAP_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_024,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES', 128)
  )
);
const ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS = Math.max(
  8,
  Math.min(
    1_024,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS', 128)
  )
);
const ENTERPRISE_JWT_ROLE_CLAIM_MAX_VALUES = Math.max(
  1,
  Math.min(
    1_024,
    parseNonNegativeIntEnv('DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES', 128)
  )
);
const ENTERPRISE_JWT_ADMIN_ROLE_CONFIG = parseBoundedCsvEnv(
  'DASHBOARD_AUTH_JWT_ADMIN_ROLES',
  ['admin', 'owner'],
  {
    maxBytes: ENTERPRISE_JWT_ROLE_MAP_MAX_BYTES,
    maxEntries: ENTERPRISE_JWT_ROLE_MAP_MAX_ENTRIES,
    maxEntryChars: ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS,
  }
);
const ENTERPRISE_JWT_MEMBER_ROLE_CONFIG = parseBoundedCsvEnv(
  'DASHBOARD_AUTH_JWT_MEMBER_ROLES',
  ['member'],
  {
    maxBytes: ENTERPRISE_JWT_ROLE_MAP_MAX_BYTES,
    maxEntries: ENTERPRISE_JWT_ROLE_MAP_MAX_ENTRIES,
    maxEntryChars: ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS,
  }
);
const ENTERPRISE_JWT_VIEWER_ROLE_CONFIG = parseBoundedCsvEnv(
  'DASHBOARD_AUTH_JWT_VIEWER_ROLES',
  ['viewer', 'read-only', 'readonly'],
  {
    maxBytes: ENTERPRISE_JWT_ROLE_MAP_MAX_BYTES,
    maxEntries: ENTERPRISE_JWT_ROLE_MAP_MAX_ENTRIES,
    maxEntryChars: ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS,
  }
);
const ENTERPRISE_JWT_ADMIN_ROLES = ENTERPRISE_JWT_ADMIN_ROLE_CONFIG.values;
const ENTERPRISE_JWT_MEMBER_ROLES = ENTERPRISE_JWT_MEMBER_ROLE_CONFIG.values;
const ENTERPRISE_JWT_VIEWER_ROLES = ENTERPRISE_JWT_VIEWER_ROLE_CONFIG.values;
const ENTERPRISE_JWT_ROLE_CONFIGS = [
  {
    name: 'DASHBOARD_AUTH_JWT_ADMIN_ROLES',
    config: ENTERPRISE_JWT_ADMIN_ROLE_CONFIG,
  },
  {
    name: 'DASHBOARD_AUTH_JWT_MEMBER_ROLES',
    config: ENTERPRISE_JWT_MEMBER_ROLE_CONFIG,
  },
  {
    name: 'DASHBOARD_AUTH_JWT_VIEWER_ROLES',
    config: ENTERPRISE_JWT_VIEWER_ROLE_CONFIG,
  },
];

function normalizeEnterpriseRole(role, fallback = 'member') {
  const r = String(role || fallback).trim().toLowerCase();
  return ['admin', 'member', 'viewer'].includes(r) ? r : fallback;
}

function normalizeEnterpriseDataRootPath(raw) {
  const configured = String(raw || '').trim();
  if (!configured) return undefined;
  const expanded =
    configured === '~'
      ? homedir()
      : configured.startsWith(`~${sep}`)
        ? join(homedir(), configured.slice(2))
        : configured;
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}

function normalizeEnterpriseDataRoot(raw = {}, fallback = {}) {
  const normalized = normalizeEnterpriseDataRootPath(
    raw.dataRoot || raw.claudeDir || fallback.dataRoot || fallback.claudeDir || ''
  );
  if (!normalized) return undefined;
  if (ENTERPRISE_DATA_ROOT_BASE && !pathInside(ENTERPRISE_DATA_ROOT_BASE, normalized)) {
    return undefined;
  }
  const realBase = ENTERPRISE_DATA_ROOT_BASE
    ? realpathSyncOrNull(ENTERPRISE_DATA_ROOT_BASE)
    : null;
  const realRoot = ENTERPRISE_DATA_ROOT_BASE
    ? realpathSyncOrNull(normalized)
    : null;
  if (realBase && realRoot && !pathInside(realBase, realRoot)) {
    return undefined;
  }
  return normalized;
}

function normalizeEnterpriseScopes(...values) {
  const scopes = [];
  const seen = new Set();
  const stack = [...values].reverse();
  const addScope = (scope) => {
    const text = boundedEnterpriseText(scope, ENTERPRISE_SCOPE_MAX_CHARS);
    if (!text || seen.has(text)) return;
    seen.add(text);
    if (scopes.length < ENTERPRISE_SCOPE_MAX_ENTRIES) scopes.push(text);
  };
  while (stack.length > 0 && scopes.length < ENTERPRISE_SCOPE_MAX_ENTRIES) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push(value[i]);
      }
    } else if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > ENTERPRISE_SCOPE_SOURCE_MAX_BYTES) {
        continue;
      }
      for (const scope of value.split(/[,\s]+/)) {
        addScope(scope);
        if (scopes.length >= ENTERPRISE_SCOPE_MAX_ENTRIES) break;
      }
    }
  }
  return scopes;
}

function enterpriseScopesEnforced() {
  return ENTERPRISE_AUTH_ON && ENTERPRISE_SCOPE_ENFORCEMENT;
}

function enterpriseScopeMatches(granted, required) {
  if (granted === '*' || granted === required) return true;
  const [namespace] = required.split(':');
  return namespace ? granted === `${namespace}:*` : false;
}

function enterprisePrincipalHasScope(principal, requiredScopes) {
  if (!enterpriseScopesEnforced()) return true;
  const grantedScopes = normalizeEnterpriseScopes(principal?.scopes);
  return requiredScopes.some((required) =>
    grantedScopes.some((granted) => enterpriseScopeMatches(granted, required))
  );
}

function boundedEnterpriseText(
  value,
  maxLength = ENTERPRISE_PRINCIPAL_FIELD_MAX_CHARS
) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const prefixLength = Math.max(1, maxLength - hash.length - 1);
  return `${text.slice(0, prefixLength)}-${hash}`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = boundedEnterpriseText(value);
    if (text) return text;
  }
  return '';
}

function parseBoundedTrimmedEnv(name, maxBytes) {
  const value = String(process.env[name] || '').trim();
  if (!value) return { value: '', error: null };
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    return {
      value: '',
      error: `${name} exceeds ${maxBytes} byte limit`,
    };
  }
  return { value, error: null };
}

function normalizeEnterprisePrincipal(raw = {}, fallback = {}) {
  const email = firstNonEmptyString(raw.email, fallback.email);
  const userId = firstNonEmptyString(
    raw.userId,
    raw.id,
    fallback.userId,
    email,
    'enterprise-user'
  );
  const role = normalizeEnterpriseRole(raw.role, fallback.role || 'member');
  const orgId = firstNonEmptyString(raw.orgId, fallback.orgId, ENTERPRISE_ORG_ID);
  const orgName = firstNonEmptyString(raw.orgName, fallback.orgName, ENTERPRISE_ORG_NAME);
  const teamId = firstNonEmptyString(
    raw.teamId,
    raw.team,
    fallback.teamId,
    fallback.team
  );
  const teamName = firstNonEmptyString(
    raw.teamName,
    raw.teamDisplayName,
    fallback.teamName,
    fallback.teamDisplayName,
    teamId
  );
  const scopes = normalizeEnterpriseScopes(
    raw.scopes,
    raw.scope,
    fallback.scopes,
    fallback.scope
  );
  return {
    userId,
    email: email || undefined,
    name: firstNonEmptyString(raw.name, fallback.name, email, userId),
    role,
    orgId,
    orgName,
    teamId: teamId || undefined,
    teamName: teamName || undefined,
    scopes,
    dataRoot: normalizeEnterpriseDataRoot(raw, fallback),
  };
}

function base64UrlJson(segment, maxBytes) {
  try {
    const decoded = Buffer.from(segment, 'base64url');
    if (decoded.byteLength > maxBytes) return null;
    return JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const header = base64UrlJson(parts[0], ENTERPRISE_JWT_HEADER_MAX_BYTES);
  const claims = base64UrlJson(parts[1], ENTERPRISE_JWT_CLAIMS_MAX_BYTES);
  if (!header || !claims || typeof header !== 'object' || typeof claims !== 'object') {
    return null;
  }
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.byteLength > ENTERPRISE_JWT_SIGNATURE_MAX_BYTES) return null;
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature,
  };
}

function jwtClaimPathLimitReason(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (Buffer.byteLength(raw, 'utf8') > ENTERPRISE_JWT_CLAIM_PATH_MAX_BYTES) {
    return `exceeds ${ENTERPRISE_JWT_CLAIM_PATH_MAX_BYTES} byte limit`;
  }
  const segments = raw.split('.').filter(Boolean);
  if (segments.length > ENTERPRISE_JWT_CLAIM_PATH_MAX_SEGMENTS) {
    return `exceeds ${ENTERPRISE_JWT_CLAIM_PATH_MAX_SEGMENTS} segment limit`;
  }
  return '';
}

function jwtClaimPathSegments(path) {
  const raw = String(path || '').trim();
  if (!raw) return [];
  if (jwtClaimPathLimitReason(raw)) return null;
  return raw.split('.').filter(Boolean);
}

function getClaim(claims, path) {
  let cur = claims;
  const segments = jwtClaimPathSegments(path);
  if (!segments) return undefined;
  for (const part of segments) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function claimValues(value, maxValues = ENTERPRISE_JWT_ROLE_CLAIM_MAX_VALUES) {
  const values = [];
  const addValue = (raw) => {
    const text = boundedEnterpriseText(raw, ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS)
      .toLowerCase();
    if (text && values.length < maxValues) values.push(text);
  };
  const stack = [value];
  while (stack.length > 0 && values.length < maxValues) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i -= 1) {
        stack.push(item[i]);
      }
    } else if (typeof item === 'string') {
      for (const part of item.split(/[,\s]+/)) {
        addValue(part);
        if (values.length >= maxValues) break;
      }
    } else if (item != null) {
      addValue(item);
    }
  }
  return values;
}

function jwtRoleFromClaims(claims) {
  const values = claimValues(getClaim(claims, ENTERPRISE_JWT_ROLE_CLAIM));
  if (values.some((value) => ENTERPRISE_JWT_ADMIN_ROLES.includes(value))) {
    return 'admin';
  }
  if (values.some((value) => ENTERPRISE_JWT_MEMBER_ROLES.includes(value))) {
    return 'member';
  }
  if (values.some((value) => ENTERPRISE_JWT_VIEWER_ROLES.includes(value))) {
    return 'viewer';
  }
  const fallbackRole = normalizeEnterpriseRole(values[0], 'member');
  return fallbackRole === 'admin' ? 'member' : fallbackRole;
}

function jwtStringClaim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function jwtDirectStringClaim(claims, name) {
  if (
    Object.prototype.hasOwnProperty.call(claims, name) &&
    typeof claims[name] !== 'string'
  ) {
    return { valid: false, value: '' };
  }
  return { valid: true, value: jwtStringClaim(claims[name]) };
}

function safeJwtPathSegment(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  const cleaned = raw.replace(/[^A-Za-z0-9@._-]+/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
  if (cleaned === raw && cleaned.length <= 160) return cleaned;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const prefixLength = Math.max(1, 160 - hash.length - 1);
  const prefix = cleaned.slice(0, prefixLength);
  if (!prefix || prefix === '.' || prefix === '..') {
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
  return `${prefix}-${hash}`;
}

function jwtDataRootFromClaims(claims) {
  if (!ENTERPRISE_JWT_DATA_ROOT_TEMPLATE) return undefined;
  const subject = jwtStringClaim(claims.sub);
  const email = jwtStringClaim(claims.email);
  const preferredUsername = jwtStringClaim(claims.preferred_username);
  const userId = subject || preferredUsername || email;
  const teamId = jwtStringClaim(getClaim(claims, ENTERPRISE_JWT_TEAM_ID_CLAIM));
  const replacements = {
    sub: safeJwtPathSegment(subject),
    email: safeJwtPathSegment(email),
    preferred_username: safeJwtPathSegment(preferredUsername),
    userId: safeJwtPathSegment(userId),
    team: safeJwtPathSegment(teamId),
    teamId: safeJwtPathSegment(teamId),
  };
  return ENTERPRISE_JWT_DATA_ROOT_TEMPLATE.replace(
    /\{(sub|email|preferred_username|userId|team|teamId)\}/g,
    (_, key) => replacements[key] || 'unknown'
  );
}

function parseEnterpriseJwks(rawJwks, source) {
  try {
    const parsed = JSON.parse(rawJwks);
    const rawKeys = Array.isArray(parsed) ? parsed : parsed?.keys;
    if (!Array.isArray(rawKeys)) {
      return {
        keys: [],
        error: `${source} must be a JWKS object or key array`,
        weakKeyCount: 0,
      };
    }
    if (rawKeys.length > ENTERPRISE_JWKS_MAX_KEYS) {
      return {
        keys: [],
        error: `${source} exceeds ${ENTERPRISE_JWKS_MAX_KEYS} key limit`,
        weakKeyCount: 0,
      };
    }
    const keys = [];
    const seenKids = new Set();
    const duplicateKids = new Set();
    let weakKeyCount = 0;
    let nonSigningKeyCount = 0;
    for (const jwk of rawKeys) {
      if (!jwk || typeof jwk !== 'object') continue;
      if (jwk.kty !== 'RSA') continue;
      if (jwk.alg && jwk.alg !== 'RS256') continue;
      if (jwk.use && jwk.use !== 'sig') {
        nonSigningKeyCount += 1;
        continue;
      }
      if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) {
        nonSigningKeyCount += 1;
        continue;
      }
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        const modulusLength = key.asymmetricKeyDetails?.modulusLength || 0;
        if (modulusLength < ENTERPRISE_JWT_MIN_RSA_BITS) {
          weakKeyCount += 1;
          continue;
        }
        const kid = typeof jwk.kid === 'string' ? jwk.kid.trim() : '';
        if (kid) {
          if (seenKids.has(kid)) {
            duplicateKids.add(kid);
          } else {
            seenKids.add(kid);
          }
        }
        keys.push({
          kid: kid || undefined,
          key,
        });
      } catch {
        /* skip invalid public keys; fail below if none remain */
      }
    }
    if (keys.length === 0) {
      return {
        keys: [],
        error:
          weakKeyCount > 0
            ? `${source} has no RS256 keys at or above ${ENTERPRISE_JWT_MIN_RSA_BITS} bits`
            : nonSigningKeyCount > 0
              ? `${source} has no usable RS256 signing keys`
            : `${source} has no usable RS256 keys`,
        weakKeyCount,
      };
    }
    if (duplicateKids.size > 0) {
      return {
        keys: [],
        error: `${source} has ${duplicateKids.size} duplicate JWT key id(s)`,
        weakKeyCount,
      };
    }
    return { keys, error: null, weakKeyCount };
  } catch {
    return {
      keys: [],
      error: `${source} is not valid JSON`,
      weakKeyCount: 0,
    };
  }
}

function validateEnterpriseJwksUrl(rawUrl) {
  if (!rawUrl) return null;
  if (Buffer.byteLength(rawUrl, 'utf8') > ENTERPRISE_JWKS_URL_MAX_BYTES) {
    return `DASHBOARD_AUTH_JWKS_URL exceeds ${ENTERPRISE_JWKS_URL_MAX_BYTES} byte limit`;
  }
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const localhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && localhost)) {
      return null;
    }
    return 'DASHBOARD_AUTH_JWKS_URL must use HTTPS, except localhost HTTP for development';
  } catch {
    return 'DASHBOARD_AUTH_JWKS_URL is not a valid URL';
  }
}

function loadEnterpriseJwtConfig() {
  const rawJwks = String(process.env.DASHBOARD_AUTH_JWKS || '').trim();
  const urlError = validateEnterpriseJwksUrl(ENTERPRISE_JWKS_URL);
  const staticConfig = rawJwks
    ? Buffer.byteLength(rawJwks, 'utf8') > ENTERPRISE_JWKS_MAX_BYTES
      ? {
          keys: [],
          error: `DASHBOARD_AUTH_JWKS exceeds ${ENTERPRISE_JWKS_MAX_BYTES} byte limit`,
          weakKeyCount: 0,
        }
      : parseEnterpriseJwks(rawJwks, 'DASHBOARD_AUTH_JWKS')
    : { keys: [], error: null, weakKeyCount: 0 };
  return {
    keys: staticConfig.keys,
    error:
      [
        staticConfig.error,
        urlError,
        ENTERPRISE_JWT_ISSUER_CONFIG_ERROR,
        ENTERPRISE_JWT_AUDIENCE_CONFIG_ERROR,
      ]
        .filter(Boolean)
        .join('; ') || null,
    weakKeyCount: staticConfig.weakKeyCount || 0,
  };
}

function readEnterpriseStaticTokenConfig() {
  const envTokens = String(process.env.DASHBOARD_AUTH_TOKENS || '').trim();
  const tokensFile = String(process.env.DASHBOARD_AUTH_TOKENS_FILE || '').trim();
  if (envTokens && tokensFile) {
    return {
      rawTokens: '',
      source: 'DASHBOARD_AUTH_TOKENS_FILE',
      error: 'DASHBOARD_AUTH_TOKENS and DASHBOARD_AUTH_TOKENS_FILE cannot both be configured',
    };
  }
  if (!tokensFile) {
    return {
      rawTokens: envTokens,
      source: 'DASHBOARD_AUTH_TOKENS',
      error: null,
    };
  }
  if (!isAbsolute(tokensFile)) {
    return {
      rawTokens: '',
      source: 'DASHBOARD_AUTH_TOKENS_FILE',
      error: 'DASHBOARD_AUTH_TOKENS_FILE must be an absolute path',
    };
  }
  let fd = null;
  try {
    fd = openSync(tokensFile, 'r');
    const info = fstatSync(fd);
    if (!info.isFile()) {
      return {
        rawTokens: '',
        source: 'DASHBOARD_AUTH_TOKENS_FILE',
        error: 'DASHBOARD_AUTH_TOKENS_FILE must point to a regular file',
      };
    }
    if (info.size > ENTERPRISE_AUTH_TOKENS_MAX_BYTES) {
      return {
        rawTokens: '',
        source: 'DASHBOARD_AUTH_TOKENS_FILE',
        error: `DASHBOARD_AUTH_TOKENS_FILE exceeds ${ENTERPRISE_AUTH_TOKENS_MAX_BYTES} byte limit`,
      };
    }
    const chunks = [];
    let totalBytes = 0;
    const maxReadBytes = ENTERPRISE_AUTH_TOKENS_MAX_BYTES + 1;
    while (totalBytes < maxReadBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maxReadBytes - totalBytes));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > ENTERPRISE_AUTH_TOKENS_MAX_BYTES) {
        return {
          rawTokens: '',
          source: 'DASHBOARD_AUTH_TOKENS_FILE',
          error: `DASHBOARD_AUTH_TOKENS_FILE exceeds ${ENTERPRISE_AUTH_TOKENS_MAX_BYTES} byte limit`,
        };
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const rawTokens = Buffer.concat(chunks, totalBytes).toString('utf8').trim();
    return {
      rawTokens,
      source: 'DASHBOARD_AUTH_TOKENS_FILE',
      error: null,
    };
  } catch {
    return {
      rawTokens: '',
      source: 'DASHBOARD_AUTH_TOKENS_FILE',
      error: 'DASHBOARD_AUTH_TOKENS_FILE could not be read',
    };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup of startup config descriptor */
      }
    }
  }
}

function loadEnterprisePrincipals() {
  const principals = [];
  const tokenConfig = readEnterpriseStaticTokenConfig();
  const tokenConfigSource = tokenConfig.source;
  let error = tokenConfig.error;
  let invalidTokenFingerprints = 0;
  let oversizedStaticBearerCount = 0;
  const rawTokens = tokenConfig.error ? '' : tokenConfig.rawTokens;
  if (rawTokens) {
    const rawTokensBytes = Buffer.byteLength(rawTokens, 'utf8');
    if (rawTokensBytes > ENTERPRISE_AUTH_TOKENS_MAX_BYTES) {
      error = `${tokenConfigSource} exceeds ${ENTERPRISE_AUTH_TOKENS_MAX_BYTES} byte limit`;
    } else {
      try {
        const parsed = JSON.parse(rawTokens);
        if (Array.isArray(parsed)) {
          if (parsed.length > ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES) {
            error = `${tokenConfigSource} exceeds ${ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES} entry limit`;
          } else {
            for (const item of parsed) {
              if (!item || typeof item !== 'object') continue;
              let token = String(item.token || '').trim();
              if (
                token &&
                Buffer.byteLength(token, 'utf8') > ENTERPRISE_MAX_BEARER_TOKEN_BYTES
              ) {
                oversizedStaticBearerCount += 1;
                token = '';
              }
              const tokenHashCandidates = [
                item.tokenSha256,
                item.tokenHash,
                item.sha256,
              ].filter((value) => String(value || '').trim());
              const tokenSha256 = firstEnterpriseTokenSha256(
                ...tokenHashCandidates
              );
              if (tokenHashCandidates.length > 0 && !tokenSha256) {
                invalidTokenFingerprints += 1;
              }
              const rawToken = enterpriseRawTokenMetadata(token);
              const storedTokenSha256 = tokenSha256 || rawToken.tokenSha256;
              if (!storedTokenSha256) continue;
              const {
                token: _token,
                tokenSha256: _tokenSha256,
                tokenHash: _tokenHash,
                sha256: _sha256,
                ...principal
              } = item;
              void _token;
              void _tokenSha256;
              void _tokenHash;
              void _sha256;
              principals.push({
                tokenSha256: storedTokenSha256,
                rawTokenConfigured: rawToken.rawTokenConfigured,
                rawTokenLength: rawToken.rawTokenLength || undefined,
                principal: normalizeEnterprisePrincipal(principal),
              });
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          const entries = Object.entries(parsed);
          if (entries.length > ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES) {
            error = `${tokenConfigSource} exceeds ${ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES} entry limit`;
          } else {
            for (const [token, principal] of entries) {
              const key = String(token).trim();
              if (!key) continue;
              const hashKey = key.toLowerCase().startsWith('sha256:');
              if (
                !hashKey &&
                Buffer.byteLength(key, 'utf8') > ENTERPRISE_MAX_BEARER_TOKEN_BYTES
              ) {
                oversizedStaticBearerCount += 1;
                continue;
              }
              const tokenSha256 = hashKey
                ? normalizeEnterpriseTokenSha256(key)
                : '';
              if (hashKey && !tokenSha256) {
                invalidTokenFingerprints += 1;
                continue;
              }
              const rawToken = hashKey
                ? {
                    tokenSha256: '',
                    rawTokenConfigured: false,
                    rawTokenLength: 0,
                  }
                : enterpriseRawTokenMetadata(key);
              principals.push({
                tokenSha256: tokenSha256 || rawToken.tokenSha256 || undefined,
                rawTokenConfigured: rawToken.rawTokenConfigured,
                rawTokenLength: rawToken.rawTokenLength || undefined,
                principal: normalizeEnterprisePrincipal(
                  principal && typeof principal === 'object' ? principal : {}
                ),
              });
            }
          }
        } else {
          error = `${tokenConfigSource} must be a JSON object or array`;
        }
      } catch {
        error = `${tokenConfigSource} is not valid JSON`;
      }
    }
  }
  if (invalidTokenFingerprints > 0) {
    error = [error, `${tokenConfigSource} has ${invalidTokenFingerprints} invalid SHA-256 token fingerprint(s)`]
      .filter(Boolean)
      .join('; ');
  }
  if (oversizedStaticBearerCount > 0) {
    error = [
      error,
      `${tokenConfigSource} has ${oversizedStaticBearerCount} raw bearer token(s) above ${ENTERPRISE_MAX_BEARER_TOKEN_BYTES} byte limit`,
    ]
      .filter(Boolean)
      .join('; ');
  }

  let adminToken = String(process.env.DASHBOARD_ADMIN_TOKEN || '').trim();
  const adminTokenSha256Raw = String(
    process.env.DASHBOARD_ADMIN_TOKEN_SHA256 || ''
  ).trim();
  if (
    adminToken &&
    Buffer.byteLength(adminToken, 'utf8') > ENTERPRISE_MAX_BEARER_TOKEN_BYTES
  ) {
    error = [
      error,
      `DASHBOARD_ADMIN_TOKEN exceeds ${ENTERPRISE_MAX_BEARER_TOKEN_BYTES} byte limit`,
    ]
      .filter(Boolean)
      .join('; ');
    adminToken = '';
  }
  const adminTokenSha256 = firstEnterpriseTokenSha256(adminTokenSha256Raw);
  if (adminTokenSha256Raw && !adminTokenSha256) {
    error = [
      error,
      'DASHBOARD_ADMIN_TOKEN_SHA256 is not a valid SHA-256 token fingerprint',
    ]
      .filter(Boolean)
      .join('; ');
  }
  const rawAdminToken = enterpriseRawTokenMetadata(adminToken);
  if (adminToken || adminTokenSha256) {
    principals.push({
      tokenSha256: adminTokenSha256 || rawAdminToken.tokenSha256 || undefined,
      rawTokenConfigured: rawAdminToken.rawTokenConfigured,
      rawTokenLength: rawAdminToken.rawTokenLength || undefined,
      principal: normalizeEnterprisePrincipal(
        {
          userId: process.env.DASHBOARD_ADMIN_USER_ID || 'admin',
          email: process.env.DASHBOARD_ADMIN_EMAIL || 'admin@local',
          name: process.env.DASHBOARD_ADMIN_NAME || 'Dashboard Admin',
          role: 'admin',
          scope:
            process.env.DASHBOARD_ADMIN_SCOPES ||
            'org:read org:write audit:read sessions:read',
        },
        { role: 'admin' }
      ),
    });
  }

  const seenCredentialFingerprints = new Set();
  const duplicateCredentialFingerprints = new Set();
  for (const record of principals) {
    const fingerprint = enterpriseCredentialFingerprint(record);
    if (!fingerprint) continue;
    if (seenCredentialFingerprints.has(fingerprint)) {
      duplicateCredentialFingerprints.add(fingerprint);
    } else {
      seenCredentialFingerprints.add(fingerprint);
    }
  }
  if (duplicateCredentialFingerprints.size > 0) {
    error = [
      error,
      `Enterprise auth has ${duplicateCredentialFingerprints.size} duplicate bearer credential fingerprint(s)`,
    ]
      .filter(Boolean)
      .join('; ');
  }
  const crossOrgPrincipalCount = principals.filter(
    (record) => !enterprisePrincipalInConfiguredOrg(record.principal)
  ).length;
  if (crossOrgPrincipalCount > 0) {
    error = [
      error,
      `Enterprise auth has ${crossOrgPrincipalCount} principal(s) outside DASHBOARD_ORG_ID`,
    ]
      .filter(Boolean)
      .join('; ');
  }

  return { principals, error };
}

const {
  principals: ENTERPRISE_PRINCIPALS,
  error: ENTERPRISE_TOKEN_CONFIG_ERROR,
} = loadEnterprisePrincipals();
const ENTERPRISE_PRINCIPALS_BY_CREDENTIAL_SHA256 = new Map(
  ENTERPRISE_PRINCIPALS.map((record) => [
    enterpriseCredentialFingerprint(record),
    record.principal,
  ]).filter(([fingerprint, principal]) => fingerprint && principal)
);
const {
  keys: ENTERPRISE_JWT_KEYS,
  error: ENTERPRISE_JWT_CONFIG_ERROR,
  weakKeyCount: ENTERPRISE_JWT_WEAK_KEY_COUNT,
} = loadEnterpriseJwtConfig();
const ENTERPRISE_JWT_SIGNING_CONFIGURED =
  ENTERPRISE_JWT_KEYS.length > 0 || Boolean(ENTERPRISE_JWKS_URL);
const ENTERPRISE_JWT_ISSUER_REQUIRED_ERROR =
  ENTERPRISE_JWT_SIGNING_CONFIGURED &&
  !ENTERPRISE_JWT_ISSUER &&
  !ENTERPRISE_JWT_ISSUER_CONFIG_ERROR
    ? 'DASHBOARD_AUTH_JWT_ISSUER is required when enterprise JWT auth is configured'
    : null;
const ENTERPRISE_JWT_CONFIGURED =
  ENTERPRISE_JWT_SIGNING_CONFIGURED &&
  !ENTERPRISE_JWT_CONFIG_ERROR &&
  !ENTERPRISE_JWT_ISSUER_REQUIRED_ERROR;
const ENTERPRISE_AUTH_CONFIG_ERROR =
  [
    ENTERPRISE_TOKEN_CONFIG_ERROR,
    ENTERPRISE_JWT_CONFIG_ERROR,
    ENTERPRISE_JWT_ISSUER_REQUIRED_ERROR,
    ENTERPRISE_SESSION_EPOCH_CONFIG.error,
    ENTERPRISE_SESSION_SECRET_CONFIG.error,
  ]
    .filter(Boolean)
    .join('; ') || null;
const ENTERPRISE_AUTH_ON =
  ENTERPRISE_AUTH_MODE ||
  ENTERPRISE_PRINCIPALS.length > 0 ||
  Boolean(process.env.DASHBOARD_AUTH_TOKENS) ||
  Boolean(process.env.DASHBOARD_AUTH_TOKENS_FILE) ||
  Boolean(process.env.DASHBOARD_ADMIN_TOKEN) ||
  Boolean(process.env.DASHBOARD_ADMIN_TOKEN_SHA256) ||
  Boolean(process.env.DASHBOARD_AUTH_JWKS) ||
  Boolean(ENTERPRISE_JWKS_URL);
const ENTERPRISE_AUTH_CONFIGURED =
  (ENTERPRISE_PRINCIPALS.length > 0 || ENTERPRISE_JWT_CONFIGURED) &&
  !ENTERPRISE_AUTH_CONFIG_ERROR;
if (ENTERPRISE_AUTH_ON && ENTERPRISE_JWT_ISSUER_REQUIRED_ERROR) {
  throw new Error(`[enterprise-auth] ${ENTERPRISE_JWT_ISSUER_REQUIRED_ERROR}`);
}

// Fail-open-bind guard (#2064). The dashboard reads ~/.claude live, so it must
// not be reachable UNAUTHENTICATED beyond loopback. Inside our container HOST is
// always 0.0.0.0 (so the published port works), so HOST alone can't reveal
// whether the port is actually exposed to the LAN — DASHBOARD_BIND_HOST, which
// docker-compose forwards from BIND_HOST, carries the real host publish
// interface. When that is explicitly non-loopback with no auth configured, refuse
// to start (fail closed). For a bare `node` run that only sets a non-loopback
// HOST (ambiguous — could be the container default), warn loudly instead of
// breaking the boot. DASHBOARD_ALLOW_INSECURE_BIND=1 overrides the hard failure.
function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return (
    h === '' ||
    h === 'localhost' ||
    h === 'loopback' ||
    h === '::1' ||
    h.startsWith('127.')
  );
}
{
  const anyAuthConfigured = BASIC_AUTH_ON || ENTERPRISE_AUTH_ON;
  const publishHost = String(process.env.DASHBOARD_BIND_HOST || '').trim();
  const insecureBindOverride =
    String(process.env.DASHBOARD_ALLOW_INSECURE_BIND || '') === '1';
  const confidentExposure = publishHost !== '' && !isLoopbackHost(publishHost);
  const ambiguousExposure = publishHost === '' && !isLoopbackHost(HOST);
  if (!anyAuthConfigured && (confidentExposure || ambiguousExposure)) {
    const where = confidentExposure
      ? `DASHBOARD_BIND_HOST=${publishHost}`
      : `HOST=${HOST}`;
    const detail =
      `the dashboard is bound beyond loopback (${where}) with no DASHBOARD_USER/DASHBOARD_PASS ` +
      `and no DASHBOARD_AUTH_MODE=enterprise, so it is reachable UNAUTHENTICATED while reading ~/.claude live`;
    if (confidentExposure && !insecureBindOverride) {
      throw new Error(
        `[security] Refusing to start: ${detail}. Set DASHBOARD_USER/DASHBOARD_PASS, ` +
          `enable enterprise auth, bind to loopback, or set DASHBOARD_ALLOW_INSECURE_BIND=1 to override.`
      );
    }
    console.warn(
      `[security] WARNING: ${detail}.` +
        (insecureBindOverride ? ' DASHBOARD_ALLOW_INSECURE_BIND=1 set — proceeding.' : '')
    );
  }
}
let enterpriseAuditWriteQueue = Promise.resolve();
const enterpriseRateLimitBuckets = new Map();
let enterpriseRateLimitNextPruneAt = 0;
const enterpriseRemoteJwksCache = {
  keys: [],
  expiresAt: 0,
  lastAttemptAt: 0,
  error: null,
  promise: null,
  weakKeyCount: 0,
  duplicateKidCount: 0,
};

async function readBoundedTextResponse(res, maxBytes) {
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`JWKS response exceeds ${maxBytes} byte limit`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new Error(`JWKS response exceeds ${maxBytes} byte limit`);
    }
    return body.toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`JWKS response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchEnterpriseRemoteJwks() {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ENTERPRISE_JWKS_FETCH_TIMEOUT_MS
  );
  try {
    const res = await fetch(ENTERPRISE_JWKS_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${res.status}`);
    }
    const text = await readBoundedTextResponse(res, ENTERPRISE_JWKS_MAX_BYTES);
    const parsed = parseEnterpriseJwks(text, 'DASHBOARD_AUTH_JWKS_URL');
    if (parsed.error) throw new Error(parsed.error);
    enterpriseRemoteJwksCache.keys = parsed.keys;
    enterpriseRemoteJwksCache.weakKeyCount = parsed.weakKeyCount || 0;
    enterpriseRemoteJwksCache.error = null;
    enterpriseRemoteJwksCache.expiresAt = Date.now() + ENTERPRISE_JWKS_CACHE_TTL_MS;
    return enterpriseRemoteJwksCache.keys;
  } finally {
    clearTimeout(timeout);
  }
}

async function enterpriseRemoteJwtKeys({ forceRefresh = false } = {}) {
  if (!ENTERPRISE_JWKS_URL || ENTERPRISE_JWT_CONFIG_ERROR) return [];
  const now = Date.now();
  if (!forceRefresh && enterpriseRemoteJwksCache.expiresAt > now) {
    return enterpriseRemoteJwksCache.keys;
  }
  if (
    forceRefresh &&
    now - enterpriseRemoteJwksCache.lastAttemptAt < ENTERPRISE_JWKS_MIN_REFRESH_MS
  ) {
    return enterpriseRemoteJwksCache.expiresAt > now
      ? enterpriseRemoteJwksCache.keys
      : [];
  }
  if (!enterpriseRemoteJwksCache.promise) {
    enterpriseRemoteJwksCache.lastAttemptAt = now;
    enterpriseRemoteJwksCache.promise = fetchEnterpriseRemoteJwks()
      .catch((err) => {
        enterpriseRemoteJwksCache.error = err.message;
        enterpriseRemoteJwksCache.expiresAt = 0;
        return [];
      })
      .finally(() => {
        enterpriseRemoteJwksCache.promise = null;
      });
  }
  return enterpriseRemoteJwksCache.promise;
}

async function enterpriseJwtKeys({ forceRefresh = false } = {}) {
  const remoteKeys = await enterpriseRemoteJwtKeys({ forceRefresh });
  const keys = [...ENTERPRISE_JWT_KEYS, ...remoteKeys];
  if (ENTERPRISE_JWKS_URL) {
    enterpriseRemoteJwksCache.duplicateKidCount = countDuplicateJwtKids(keys);
  }
  return keys;
}

function countDuplicateJwtKids(keys) {
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of keys) {
    const kid = typeof entry?.kid === 'string' ? entry.kid.trim() : '';
    if (!kid) continue;
    if (seen.has(kid)) {
      duplicates.add(kid);
    } else {
      seen.add(kid);
    }
  }
  return duplicates.size;
}

function jwtAudienceMatches(claims) {
  if (!ENTERPRISE_JWT_AUDIENCE) return true;
  const aud = claims.aud;
  if (Array.isArray(aud)) return aud.includes(ENTERPRISE_JWT_AUDIENCE);
  return aud === ENTERPRISE_JWT_AUDIENCE;
}

function jwtTimeValid(claims) {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp)) return false;
  if (claims.exp <= now - ENTERPRISE_JWT_CLOCK_SKEW_SECONDS) return false;
  if (Number.isFinite(claims.nbf)) {
    if (claims.nbf > now + ENTERPRISE_JWT_CLOCK_SKEW_SECONDS) return false;
    if (claims.nbf >= claims.exp) return false;
  }
  if (Number.isFinite(claims.iat) && claims.iat >= claims.exp) {
    return false;
  }
  if (ENTERPRISE_JWT_MAX_LIFETIME_SECONDS > 0) {
    if (!Number.isFinite(claims.iat)) return false;
    if (claims.iat > now + ENTERPRISE_JWT_CLOCK_SKEW_SECONDS) return false;
    if (claims.exp - claims.iat > ENTERPRISE_JWT_MAX_LIFETIME_SECONDS) {
      return false;
    }
  }
  return true;
}

function jwtHeaderKid(header) {
  if (!Object.prototype.hasOwnProperty.call(header, 'kid')) {
    return { valid: true, kid: '' };
  }
  if (typeof header.kid !== 'string') {
    return { valid: false, kid: '' };
  }
  const kid = header.kid.trim();
  return kid ? { valid: true, kid } : { valid: false, kid: '' };
}

function jwtSignatureMatches(parsed, keys) {
  if (parsed.header.alg !== 'RS256') return false;
  const { valid, kid } = jwtHeaderKid(parsed.header);
  if (!valid) return false;
  const candidates = kid
    ? keys.filter((entry) => entry.kid === kid)
    : keys;
  if (kid && candidates.length !== 1) return false;
  return candidates.some((entry) =>
    verifySignature(
      'RSA-SHA256',
      Buffer.from(parsed.signingInput),
      entry.key,
      parsed.signature
    )
  );
}

async function jwtSignatureValid(parsed) {
  const { valid, kid } = jwtHeaderKid(parsed.header);
  if (!valid) return false;
  const keys = await enterpriseJwtKeys();
  if (jwtSignatureMatches(parsed, keys)) return true;
  if (kid && ENTERPRISE_JWKS_URL) {
    return jwtSignatureMatches(
      parsed,
      await enterpriseJwtKeys({ forceRefresh: true })
    );
  }
  return false;
}

async function findEnterpriseJwtPrincipal(token) {
  if (!ENTERPRISE_JWT_CONFIGURED) return null;
  const parsed = parseJwt(token);
  if (!parsed) return null;
  if (ENTERPRISE_JWT_ISSUER && parsed.claims.iss !== ENTERPRISE_JWT_ISSUER) {
    return null;
  }
  if (!jwtAudienceMatches(parsed.claims)) return null;
  if (!jwtTimeValid(parsed.claims)) return null;
  if (!(await jwtSignatureValid(parsed))) return null;

  const subject = jwtDirectStringClaim(parsed.claims, 'sub');
  const emailClaim = jwtDirectStringClaim(parsed.claims, 'email');
  const preferredUsernameClaim = jwtDirectStringClaim(
    parsed.claims,
    'preferred_username'
  );
  if (!subject.valid || !emailClaim.valid || !preferredUsernameClaim.valid) {
    return null;
  }
  const email = emailClaim.value;
  const preferredUsername = preferredUsernameClaim.value;
  const userId = subject.value || preferredUsername || email;
  if (!userId) return null;
  if (ENTERPRISE_JWT_ORG_ID_CLAIM) {
    const orgId = jwtStringClaim(
      getClaim(parsed.claims, ENTERPRISE_JWT_ORG_ID_CLAIM)
    );
    if (orgId !== ENTERPRISE_ORG_ID) return null;
  }
  const teamId = jwtStringClaim(
    getClaim(parsed.claims, ENTERPRISE_JWT_TEAM_ID_CLAIM)
  );
  const teamName =
    jwtStringClaim(getClaim(parsed.claims, ENTERPRISE_JWT_TEAM_NAME_CLAIM)) ||
    teamId;
  return normalizeEnterprisePrincipal({
    userId,
    email,
    name: jwtStringClaim(parsed.claims.name) || preferredUsername || email || userId,
    role: jwtRoleFromClaims(parsed.claims),
    orgId: ENTERPRISE_ORG_ID,
    orgName: ENTERPRISE_ORG_NAME,
    scopes: normalizeEnterpriseScopes(
      getClaim(parsed.claims, ENTERPRISE_JWT_SCOPE_CLAIM)
    ),
    teamId,
    teamName,
    dataRoot: jwtDataRootFromClaims(parsed.claims),
  });
}

function findEnterpriseStaticPrincipal(token) {
  const tokenSha256 = createHash('sha256').update(token).digest('hex');
  return ENTERPRISE_PRINCIPALS_BY_CREDENTIAL_SHA256.get(tokenSha256) || null;
}

async function findEnterprisePrincipalFromToken(token) {
  if (!ENTERPRISE_AUTH_ON || !ENTERPRISE_AUTH_CONFIGURED || !token) return null;
  const staticPrincipal = findEnterpriseStaticPrincipal(token);
  if (staticPrincipal) return staticPrincipal;
  return findEnterpriseJwtPrincipal(token);
}

function findEnterprisePrincipalFromSessionCookie(req) {
  const cookies = requestCookieValues(req, ENTERPRISE_SESSION_COOKIE_NAME);
  if (cookies.length > 1) {
    req.enterpriseAuthFailureReason = 'invalid_session';
    req.enterpriseCredentialHash = createHash('sha256')
      .update(cookies.join('\n'))
      .digest('hex')
      .slice(0, 24);
    return null;
  }
  const cookie = cookies[0] || '';
  if (!cookie) return null;
  const session = openEnterpriseSessionCookie(cookie);
  if (session.principal) {
    req.enterpriseCredentialHash = session.sessionHash;
    return session.principal;
  }
  req.enterpriseAuthFailureReason = session.reason || 'invalid_session';
  req.enterpriseCredentialHash = createHash('sha256').update(cookie).digest('hex').slice(0, 24);
  return null;
}

async function findEnterprisePrincipal(req) {
  if (!ENTERPRISE_AUTH_ON || !ENTERPRISE_AUTH_CONFIGURED) return null;
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    req.enterpriseCredentialHash = enterpriseCredentialHashFromToken(bearerToken);
    return findEnterprisePrincipalFromToken(bearerToken);
  }
  return findEnterprisePrincipalFromSessionCookie(req);
}

function enterpriseTokenHash(req) {
  if (req.enterpriseCredentialHash) return req.enterpriseCredentialHash;
  const token = extractBearerToken(req);
  if (!token) return undefined;
  return enterpriseCredentialHashFromToken(token);
}

function enterpriseRateLimitEnabled(limit) {
  return ENTERPRISE_AUTH_ON && ENTERPRISE_RATE_LIMIT_WINDOW_MS > 0 && limit > 0;
}

function enterpriseRateLimitKey(req, group) {
  const remoteAddress = enterpriseRemoteAddress(req);
  if (group === 'auth') return `${group}:${remoteAddress}`;
  const tokenHash = enterpriseTokenHash(req) || 'no-token';
  return `${group}:${tokenHash}:${remoteAddress}`;
}

function pruneEnterpriseRateLimitBuckets(now) {
  const needsCapacity = enterpriseRateLimitBuckets.size >= ENTERPRISE_RATE_LIMIT_MAX_BUCKETS;
  if (!needsCapacity && now < enterpriseRateLimitNextPruneAt) {
    return;
  }
  enterpriseRateLimitNextPruneAt =
    now + Math.min(ENTERPRISE_RATE_LIMIT_WINDOW_MS, 30_000);
  for (const [key, bucket] of enterpriseRateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) enterpriseRateLimitBuckets.delete(key);
  }
  while (needsCapacity && enterpriseRateLimitBuckets.size >= ENTERPRISE_RATE_LIMIT_MAX_BUCKETS) {
    const oldestKey = enterpriseRateLimitBuckets.keys().next().value;
    if (!oldestKey) break;
    enterpriseRateLimitBuckets.delete(oldestKey);
  }
}

function checkEnterpriseRateLimit(req, res, { group, limit, path }) {
  if (!enterpriseRateLimitEnabled(limit)) return true;
  const now = Date.now();
  pruneEnterpriseRateLimitBuckets(now);
  const key = enterpriseRateLimitKey(req, group);
  let bucket = enterpriseRateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + ENTERPRISE_RATE_LIMIT_WINDOW_MS };
    enterpriseRateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const remaining = Math.max(0, limit - bucket.count);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(retryAfter));
  if (bucket.count <= limit) return true;
  res.setHeader('Retry-After', String(retryAfter));
  appendEnterpriseAuditEvent(req, {
    type: 'enterprise.rate_limited',
    outcome: 'denied',
    status: 429,
    path,
    reason: `rate_limit:${group}`,
  });
  sendJson(res, 429, {
    ok: false,
    authRequired: true,
    authenticated: false,
    configured: ENTERPRISE_AUTH_CONFIGURED,
    error: 'Too many enterprise requests; retry after the rate limit resets',
    retryAfterSeconds: retryAfter,
  });
  return false;
}

function checkEnterpriseRateLimitHeadroom(req, res, { group, limit, path }) {
  if (!enterpriseRateLimitEnabled(limit)) return true;
  const now = Date.now();
  pruneEnterpriseRateLimitBuckets(now);
  const key = enterpriseRateLimitKey(req, group);
  const bucket = enterpriseRateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now || bucket.count < limit) return true;
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(retryAfter));
  res.setHeader('Retry-After', String(retryAfter));
  appendEnterpriseAuditEvent(req, {
    type: 'enterprise.rate_limited',
    outcome: 'denied',
    status: 429,
    path,
    reason: `rate_limit:${group}`,
  });
  sendJson(res, 429, {
    ok: false,
    authRequired: true,
    authenticated: false,
    configured: ENTERPRISE_AUTH_CONFIGURED,
    error: 'Too many enterprise requests; retry after the rate limit resets',
    retryAfterSeconds: retryAfter,
  });
  return false;
}

function enterpriseAuditPrincipal(principal) {
  if (!principal) return undefined;
  const record = {
    userId: auditString(principal.userId, 256),
    role: auditString(principal.role, 64),
    orgId: auditString(principal.orgId, 256),
    teamId: auditString(principal.teamId, 256),
  };
  return Object.values(record).some(Boolean) ? record : undefined;
}

function enterprisePrincipalInConfiguredOrg(principal) {
  return principal?.orgId === ENTERPRISE_ORG_ID;
}

async function enterpriseDataRootWithinBoundary(dataRoot) {
  if (!ENTERPRISE_DATA_ROOT_BASE || !dataRoot) return true;
  if (!pathInside(ENTERPRISE_DATA_ROOT_BASE, dataRoot)) return false;
  const [realBase, realRoot] = await Promise.all([
    realpathOrNull(ENTERPRISE_DATA_ROOT_BASE),
    realpathOrNull(dataRoot),
  ]);
  if (!realRoot) return true;
  if (!realBase) return pathInside(ENTERPRISE_DATA_ROOT_BASE, dataRoot);
  return pathInside(realBase, realRoot);
}

async function enterprisePrincipalDataRootAllowed(principal) {
  return enterpriseDataRootWithinBoundary(principal?.dataRoot);
}

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : '';
}

function enterpriseRequestId(req) {
  if (!req.enterpriseRequestId) {
    req.enterpriseRequestId =
      normalizeRequestId(req.headers?.['x-request-id']) || randomUUID();
  }
  return req.enterpriseRequestId;
}

function normalizeForwardedAddress(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = String(raw || '').split(',')[0]?.trim() || '';
  if (!first || first.length > 128) return '';
  const unquoted = first.replace(/^"|"$/g, '');
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(unquoted);
  const colonCount = (unquoted.match(/:/g) || []).length;
  const withoutPort = bracketed
    ? bracketed[1]
    : colonCount === 1
      ? unquoted.replace(/:\d+$/, '')
      : unquoted;
  return /^[A-Za-z0-9.:_-]{1,128}$/.test(withoutPort) ? withoutPort : '';
}

function normalizePeerAddress(value) {
  const address = normalizeForwardedAddress(value).toLowerCase();
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function forwardedHeaderAddress(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = String(raw || '').split(',')[0] || '';
  const match = /(?:^|;)\s*for=([^;]+)/i.exec(first);
  return normalizeForwardedAddress(match?.[1]);
}

function enterpriseRemoteAddress(req) {
  const socketAddress = normalizePeerAddress(req.socket?.remoteAddress) || req.socket?.remoteAddress || 'unknown';
  const trustForwardedHeaders =
    DASHBOARD_TRUST_PROXY_HEADERS &&
    (DASHBOARD_TRUSTED_PROXY_ADDRESSES.length > 0
      ? DASHBOARD_TRUSTED_PROXY_ADDRESSES.includes(socketAddress)
      : !ENTERPRISE_AUTH_ON);
  if (trustForwardedHeaders) {
    return (
      normalizeForwardedAddress(req.headers?.['x-forwarded-for']) ||
      forwardedHeaderAddress(req.headers?.forwarded) ||
      socketAddress
    );
  }
  return socketAddress;
}

function auditString(value, maxLength = 256) {
  if (value == null) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

const ENTERPRISE_AUDIT_TOKEN_HASH_RE = /^[a-f0-9]{16,64}$/;
function auditTokenHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return ENTERPRISE_AUDIT_TOKEN_HASH_RE.test(text) ? text : undefined;
}

function sanitizeEnterpriseAuditRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const status = Number(record.status);
  const inputBytes = Number(record.inputBytes);
  const outputBytes = Number(record.outputBytes);
  const sanitized = {
    timestamp: auditString(record.timestamp, 64),
    requestId: normalizeRequestId(record.requestId) || undefined,
    type: auditString(record.type, 128),
    outcome: auditString(record.outcome, 64),
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
    method: auditString(record.method, 16),
    path: auditString(record.path, 2048),
    reason: auditString(record.reason, 256),
    principal: enterpriseAuditPrincipal(record.principal),
    tokenHash: auditTokenHash(record.tokenHash),
    remoteAddress: normalizeForwardedAddress(record.remoteAddress) || undefined,
    llmUsageId: auditString(record.llmUsageId, 128),
    egressScrub: auditString(record.egressScrub, 64),
    inputBytes:
      Number.isFinite(inputBytes) && inputBytes >= 0
        ? Math.floor(inputBytes)
        : undefined,
    outputBytes:
      Number.isFinite(outputBytes) && outputBytes >= 0
        ? Math.floor(outputBytes)
        : undefined,
  };
  return Object.values(sanitized).some(Boolean) ? sanitized : null;
}

function enterprisePublicPrincipal(principal) {
  return {
    userId: principal.userId,
    email: principal.email,
    name: principal.name,
    role: principal.role,
    orgId: principal.orgId,
    orgName: principal.orgName,
    teamId: principal.teamId,
    teamName: principal.teamName,
    scopes: principal.scopes,
    dataRootConfigured: Boolean(principal.dataRoot),
  };
}

function appendEnterpriseAuditEvent(req, event) {
  if (!ENTERPRISE_AUTH_ON) return;
  const record = {
    timestamp: new Date().toISOString(),
    requestId: enterpriseRequestId(req),
    type: auditString(event.type, 128),
    outcome: auditString(event.outcome, 64),
    status: Number.isFinite(event.status) ? event.status : undefined,
    method: auditString(event.method || req.method || 'GET', 16),
    path: auditString(event.path, 2048),
    reason: auditString(event.reason, 256),
    principal: enterpriseAuditPrincipal(event.principal),
    tokenHash: auditTokenHash(enterpriseTokenHash(req)),
    remoteAddress: auditString(enterpriseRemoteAddress(req), 128),
    llmUsageId: auditString(event.llmUsageId, 128),
    egressScrub: auditString(event.egressScrub, 64),
    inputBytes: Number.isFinite(event.inputBytes)
      ? Math.floor(event.inputBytes)
      : undefined,
    outputBytes: Number.isFinite(event.outputBytes)
      ? Math.floor(event.outputBytes)
      : undefined,
  };
  const line = `${JSON.stringify(record)}\n`;
  enterpriseAuditWriteQueue = enterpriseAuditWriteQueue
    .then(async () => {
      await mkdir(dirname(ENTERPRISE_AUDIT_LOG), { recursive: true });
      await setEnterpriseAuditLogPermissions(ENTERPRISE_AUDIT_LOG);
      await rotateEnterpriseAuditLogIfNeeded(Buffer.byteLength(line));
      await appendFile(ENTERPRISE_AUDIT_LOG, line, {
        encoding: 'utf8',
        mode: ENTERPRISE_AUDIT_FILE_MODE,
      });
      await setEnterpriseAuditLogPermissions(ENTERPRISE_AUDIT_LOG);
    })
    .catch((err) => {
      console.warn('[enterprise-audit] append failed:', err?.message || err);
    });
}

async function setEnterpriseAuditLogPermissions(path) {
  try {
    await chmod(path, ENTERPRISE_AUDIT_FILE_MODE);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function rotateIfExists(from, to) {
  try {
    await setEnterpriseAuditLogPermissions(from);
    await rename(from, to);
    await setEnterpriseAuditLogPermissions(to);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

async function rotateEnterpriseAuditLogIfNeeded(incomingBytes) {
  if (
    ENTERPRISE_AUDIT_ROTATE_MAX_BYTES <= 0 ||
    ENTERPRISE_AUDIT_ROTATE_MAX_FILES <= 0
  ) {
    return;
  }
  let info;
  try {
    info = await stat(ENTERPRISE_AUDIT_LOG);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (!info.isFile() || info.size + incomingBytes <= ENTERPRISE_AUDIT_ROTATE_MAX_BYTES) {
    return;
  }
  await rm(`${ENTERPRISE_AUDIT_LOG}.${ENTERPRISE_AUDIT_ROTATE_MAX_FILES}`, {
    force: true,
  });
  for (let i = ENTERPRISE_AUDIT_ROTATE_MAX_FILES - 1; i >= 1; i -= 1) {
    await rotateIfExists(`${ENTERPRISE_AUDIT_LOG}.${i}`, `${ENTERPRISE_AUDIT_LOG}.${i + 1}`);
  }
  await rotateIfExists(ENTERPRISE_AUDIT_LOG, `${ENTERPRISE_AUDIT_LOG}.1`);
}

function parseEnterpriseAuditLimit(req) {
  const raw = new URL(req.url, 'http://localhost').searchParams.get('limit');
  const parsed = Number(raw || 200);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function parseBoundedSearchInt(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function readEnterpriseAuditTail() {
  let info;
  try {
    info = await stat(ENTERPRISE_AUDIT_LOG);
  } catch {
    return '';
  }
  if (!info.isFile() || info.size <= 0) return '';
  const bytesToRead = Math.min(info.size, ENTERPRISE_AUDIT_READ_MAX_BYTES);
  const start = info.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const file = await open(ENTERPRISE_AUDIT_LOG, 'r');
  try {
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, start);
    let raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }
    return raw;
  } finally {
    await file.close();
  }
}

async function readEnterpriseAuditEvents(limit) {
  const raw = await readEnterpriseAuditTail();
  const events = [];
  for (const line of raw
    .split('\n')
    .filter(Boolean)
    .reverse()) {
    if (events.length >= limit) break;
    if (Buffer.byteLength(line, 'utf8') > ENTERPRISE_AUDIT_LINE_MAX_BYTES) {
      continue;
    }
    try {
      const event = sanitizeEnterpriseAuditRecord(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // Ignore malformed hand-edited or partially written audit records.
    }
  }
  return events;
}

function incrementAuditCount(counts, key) {
  const safeKey = auditString(key, 128) || 'unknown';
  counts[safeKey] = (counts[safeKey] || 0) + 1;
}

function topAuditCounts(counts, limit = 6) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function enterpriseAuditActivitySummary(events) {
  const outcomes = {};
  const principalRoles = {};
  const types = {};
  let allowed = 0;
  let denied = 0;
  let skipped = 0;
  let other = 0;
  let rateLimited = 0;
  let serverErrors = 0;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;

  for (const event of events) {
    const ts = Date.parse(event.timestamp || '');
    if (Number.isFinite(ts)) {
      startMs = Math.min(startMs, ts);
      endMs = Math.max(endMs, ts);
    }

    const outcome = event.outcome || 'unknown';
    incrementAuditCount(outcomes, outcome);
    if (outcome === 'allowed') allowed += 1;
    else if (outcome === 'denied') denied += 1;
    else if (outcome === 'skipped') skipped += 1;
    else other += 1;

    incrementAuditCount(principalRoles, event.principal?.role || 'anonymous');
    incrementAuditCount(types, event.type || 'event');

    if (
      event.status === 429 ||
      event.type === 'enterprise.rate_limited' ||
      String(event.reason || '').startsWith('rate_limit:')
    ) {
      rateLimited += 1;
    }
    if (Number.isInteger(event.status) && event.status >= 500) {
      serverErrors += 1;
    }
  }

  return {
    source: 'enterprise audit log tail',
    window: {
      start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      end: endMs > 0 ? new Date(endMs).toISOString() : null,
    },
    events: {
      total: events.length,
      allowed,
      denied,
      skipped,
      other,
      rateLimited,
      serverErrors,
    },
    outcomes,
    principalRoles,
    topTypes: topAuditCounts(types),
    privacy: {
      redacted: true,
      derivedFrom: ['sanitized enterprise audit events'],
      excludes: [
        'raw bearer tokens',
        'token fingerprints',
        'request paths',
        'request ids',
        'remote addresses',
        'raw transcript text',
      ],
    },
  };
}

function enterpriseSecurityControlSummary(securityPosture) {
  const states = (securityPosture?.controls || []).map((control) => ({
    id: control.id,
    label: control.label,
    state: control.state,
  }));
  const counts = states.reduce(
    (acc, control) => {
      if (control.state === 'enabled') acc.enabled += 1;
      else if (control.state === 'disabled') acc.disabled += 1;
      else if (control.state === 'action-required') acc.actionRequired += 1;
      else acc.other += 1;
      return acc;
    },
    { total: states.length, enabled: 0, disabled: 0, actionRequired: 0, other: 0 }
  );
  return {
    generatedAt: securityPosture?.generatedAt || new Date().toISOString(),
    controls: {
      ...counts,
      actionRequiredIds: states
        .filter((control) => control.state === 'action-required')
        .map((control) => control.id),
      states,
    },
  };
}

function enterpriseReadinessReceipt({
  rollup,
  securityPosture,
  identityCoverage,
  auditActivity,
  principal,
}) {
  const posture = enterpriseSecurityControlSummary(securityPosture);
  const configuredPrincipals = rollup?.principals?.configured || 0;
  const scopedDataRoots =
    identityCoverage?.contributors?.withScopedDataRoot ||
    identityCoverage?.teams?.withScopedDataRoots ||
    0;
  const status =
    posture.controls.actionRequired === 0 ? 'ready' : 'review-required';
  return {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    status,
    mode: ENTERPRISE_AUTH_ON ? 'enterprise' : 'single-user',
    organization: { id: ENTERPRISE_ORG_ID, name: ENTERPRISE_ORG_NAME },
    reviewer: principal
      ? {
          role: normalizeEnterpriseRole(principal.role),
          capabilities: enterpriseCapabilitiesForPrincipal(principal),
        }
      : null,
    summary: {
      actionRequiredControls: posture.controls.actionRequired,
      enabledControls: posture.controls.enabled,
      disabledControls: posture.controls.disabled,
      configuredPrincipals,
      teams: identityCoverage?.teams?.total || 0,
      scopedDataRoots,
      sessions: rollup?.counts?.sessions || 0,
      projects: rollup?.counts?.projects || 0,
      auditEvents: auditActivity?.events?.total || 0,
      deniedAuditEvents: auditActivity?.events?.denied || 0,
      rateLimitedAuditEvents: auditActivity?.events?.rateLimited || 0,
      serverErrorAuditEvents: auditActivity?.events?.serverErrors || 0,
    },
    evidence: {
      posture,
      identityCoverage,
      auditActivity,
      rollup: rollup
        ? {
            schemaVersion: rollup.schemaVersion,
            generatedAt: rollup.generatedAt,
            window: rollup.window,
            principals: rollup.principals,
            counts: rollup.counts,
            usage: rollup.usage,
            tools: {
              totalCalls: rollup.tools.totalCalls,
              errorCalls: rollup.tools.errorCalls,
              errorRate: rollup.tools.errorRate,
            },
            safety: rollup.safety,
            privacy: rollup.privacy,
          }
        : null,
      routeAccess: {
        inventoryGate: 'npm run gate:enterprise-routes',
        unclassifiedApiRoutesFailClosed: true,
        adminGlobalViews: true,
        scopedUserViewsRequireDataRoot: true,
        rawTranscriptRoutesHighestSensitivity: true,
        writesRequireAdminAndCsrf: true,
      },
      bounds: {
        organizationResponseMaxBytes: DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES,
        principalDefaultLimit: ENTERPRISE_ORG_PRINCIPAL_DEFAULT_LIMIT,
        principalMaxLimit: ENTERPRISE_ORG_PRINCIPAL_MAX_LIMIT,
        auditActivityMaxEvents: ENTERPRISE_AUDIT_ACTIVITY_SUMMARY_MAX_EVENTS,
        auditReadMaxBytes: ENTERPRISE_AUDIT_READ_MAX_BYTES,
        auditLineMaxBytes: ENTERPRISE_AUDIT_LINE_MAX_BYTES,
        auditRotateMaxBytes: ENTERPRISE_AUDIT_ROTATE_MAX_BYTES,
        authTokenMaxEntries: ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES,
        rateLimitWindowMs: ENTERPRISE_RATE_LIMIT_WINDOW_MS,
        rateLimitMaxBuckets: ENTERPRISE_RATE_LIMIT_MAX_BUCKETS,
        scopedDatasetMaxStates: ENTERPRISE_SCOPED_DATASET_MAX_STATES,
      },
    },
    privacy: {
      redacted: true,
      derivedFrom: [
        'enterprise security posture states',
        'redacted organization rollup aggregates',
        'enterprise principal identity coverage',
        'sanitized enterprise audit activity summary',
      ],
      excludes: [
        'raw bearer tokens',
        'token fingerprints',
        'request paths',
        'request ids',
        'remote addresses',
        'data roots',
        'raw transcript text',
        'session ids',
        'raw project paths',
        'tool inputs',
        'security control details',
      ],
    },
  };
}

function enterpriseCapabilitiesForPrincipal(principal) {
  const isAdmin = principal?.role === 'admin';
  const hasDataRoot = Boolean(principal?.dataRoot);
  const canUseBrowserLlmEgress =
    !ENTERPRISE_AUTH_ON || DASHBOARD_ENABLE_BROWSER_LLM_EGRESS;
  const canReadOwnSessions =
    (isAdmin || hasDataRoot) &&
    enterprisePrincipalHasScope(principal, [
      'sessions:read',
      'transcripts:read',
      'org:read',
    ]);
  const canReadOrganizationData =
    isAdmin && enterprisePrincipalHasScope(principal, ['org:read']);
  const canReadAuditLog =
    isAdmin && enterprisePrincipalHasScope(principal, ['audit:read', 'org:read']);
  const canWritePolicy =
    isAdmin &&
    enterprisePrincipalHasScope(principal, ['org:write', 'policy:write']);
  return {
    canReadOwnSessions,
    canReadOrganizationRollup: canReadOrganizationData,
    canReadOrganizationData,
    canReadAuditLog,
    canReadRawTranscripts:
      (isAdmin || hasDataRoot) &&
      enterprisePrincipalHasScope(principal, [
        'sessions:read',
        'transcripts:read',
        'org:read',
      ]),
    canWritePolicy,
    canImportLocalData: false,
    canUseBrowserLlmEgress,
    hasScopedDataRoot: hasDataRoot,
  };
}

function enterpriseCapabilities(role) {
  return enterpriseCapabilitiesForPrincipal({ role });
}

function enterpriseSecurityControl(id, label, state, summary, detail) {
  return { id, label, state, summary, detail };
}

function enterpriseAuditRetentionDetail() {
  if (
    ENTERPRISE_AUDIT_ROTATE_MAX_BYTES <= 0 ||
    ENTERPRISE_AUDIT_ROTATE_MAX_FILES <= 0
  ) {
    return 'Audit file rotation is disabled; use external retention for long-running deployments.';
  }
  return `Rotation keeps ${ENTERPRISE_AUDIT_ROTATE_MAX_FILES} file(s) at ${ENTERPRISE_AUDIT_ROTATE_MAX_BYTES} byte(s) each.`;
}

function enterpriseRawCredentialCount() {
  return ENTERPRISE_PRINCIPALS.filter(
    (record) => record.rawTokenConfigured || record.token
  ).length;
}

function enterpriseWeakRawCredentialCount() {
  if (ENTERPRISE_RAW_TOKEN_MIN_LENGTH <= 0) return 0;
  return ENTERPRISE_PRINCIPALS.filter((record) => {
    if (record.rawTokenConfigured) {
      return Number(record.rawTokenLength || 0) < ENTERPRISE_RAW_TOKEN_MIN_LENGTH;
    }
    return (
      record.token && String(record.token).length < ENTERPRISE_RAW_TOKEN_MIN_LENGTH
    );
  }).length;
}

function enterpriseHostIsLoopback() {
  const host = String(HOST || '').trim().toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

function enterpriseTransportSecurityState() {
  if (!ENTERPRISE_AUTH_ON) return 'disabled';
  if (DASHBOARD_ENABLE_HSTS || enterpriseHostIsLoopback()) return 'enabled';
  return 'action-required';
}

function githubReviewSyncPostureControl() {
  const config = parseGitHubReviewSyncConfig(process.env, {
    cachePath: REVIEW_EVENTS_CACHE,
  });
  const source = String(process.env.DASHBOARD_REVIEW_EVENTS_SOURCE ?? '')
    .trim()
    .toLowerCase();
  const sourceEnabled = source === 'github';
  const rawRepos = String(process.env.DASHBOARD_GITHUB_REVIEW_REPOS ?? '');
  const reposTooLarge =
    sourceEnabled &&
    Buffer.byteLength(rawRepos, 'utf8') > config.reposMaxBytes;
  const problems = sourceEnabled
    ? [
        config.apiBaseUrl
          ? null
          : 'DASHBOARD_GITHUB_REVIEW_API_BASE must be an HTTPS URL without embedded credentials',
        config.token ? null : 'DASHBOARD_GITHUB_REVIEW_TOKEN is required',
        reposTooLarge
          ? `DASHBOARD_GITHUB_REVIEW_REPOS exceeds ${config.reposMaxBytes} byte(s) and was ignored`
          : null,
        !reposTooLarge && !rawRepos.trim()
          ? 'DASHBOARD_GITHUB_REVIEW_REPOS is required'
          : null,
        !reposTooLarge && rawRepos.trim() && config.repos.length === 0
          ? 'DASHBOARD_GITHUB_REVIEW_REPOS has no valid owner/repo entries'
          : null,
      ].filter(Boolean)
    : [];
  const state = !sourceEnabled
    ? 'disabled'
    : problems.length > 0
      ? 'action-required'
      : 'enabled';
  const summary = !sourceEnabled
    ? 'Disabled by default; set DASHBOARD_REVIEW_EVENTS_SOURCE=github to opt in'
    : problems.length > 0
      ? problems.join('; ')
      : `Enabled for ${config.repos.length} GitHub repo(s) against ${config.apiBaseUrl}; fetch timeout ${config.fetchTimeoutMs}ms, response cap ${config.maxResponseBytes} byte(s), cache TTL ${config.cacheTtlMs}ms`;
  const detail =
    'Server-only GitHub review sync fetches pending PR review requests into the transcript-free reviewEvents aggregate for admin/global recommendations. ' +
    `Repo config is capped at ${config.reposMaxBytes} byte(s) and ${config.maxRepos} repo(s); each refresh reads at most ${config.maxPullsPerRepo} pull(s) per repo, ${config.maxTimelineRequests} timeline request(s), ${config.maxTimelineEventsPerPr} event(s) per timeline, and ${config.maxRecords} record(s). ` +
    'The admin posture exposes only status, counts, URL posture, and limits; it never returns the GitHub token or raw repository allowlist. Scoped member/viewer ingest keeps reviewEvents disabled.';
  return enterpriseSecurityControl(
    'github-review-sync',
    'GitHub review sync',
    state,
    summary,
    detail
  );
}

function enterpriseSecurityPosture() {
  const authRateLimitOn = enterpriseRateLimitEnabled(ENTERPRISE_AUTH_RATE_LIMIT);
  const apiRateLimitOn = enterpriseRateLimitEnabled(ENTERPRISE_API_RATE_LIMIT);
  const disabledRateLimitBuckets = [
    !authRateLimitOn ? 'auth/session and invalid-token attempts' : null,
    !apiRateLimitOn ? 'authenticated API routes' : null,
  ].filter(Boolean);
  const rateLimitState = !ENTERPRISE_AUTH_ON
    ? 'disabled'
    : disabledRateLimitBuckets.length > 0
      ? 'action-required'
      : 'enabled';
  const scopeEnforcementState = !ENTERPRISE_AUTH_ON
    ? 'disabled'
    : ENTERPRISE_SCOPE_ENFORCEMENT
      ? 'enabled'
      : 'action-required';
  const serverLlmAuditKeyConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  const serverLlmAuditState = DASHBOARD_ENABLE_SERVER_LLM_AUDITS
    ? serverLlmAuditKeyConfigured
      ? 'enabled'
      : 'action-required'
    : 'disabled';
  const serverUsageGaugeState =
    !ENTERPRISE_AUTH_ON || DASHBOARD_ENABLE_SERVER_USAGE_GAUGE
      ? 'enabled'
      : 'disabled';
  const datasetStates = [globalDatasetState, ...scopedDatasetStates.values()];
  const recommendationCacheEntries = datasetStates.reduce(
    (sum, state) => sum + state.recommendationsCache.size,
    0
  );
  const recommendationCacheBuilds = datasetStates.reduce(
    (sum, state) => sum + state.recommendationsBuilds.size,
    0
  );
  const cspOverrideActive = Boolean(DASHBOARD_CONTENT_SECURITY_POLICY_OVERRIDE);
  const browserLlmEgressState =
    ENTERPRISE_AUTH_ON &&
    cspOverrideActive &&
    !DASHBOARD_ENABLE_BROWSER_LLM_EGRESS
      ? 'action-required'
      : !ENTERPRISE_AUTH_ON || DASHBOARD_ENABLE_BROWSER_LLM_EGRESS
      ? 'enabled'
      : 'disabled';
  const rawCredentialCount = enterpriseRawCredentialCount();
  const weakRawCredentialCount = enterpriseWeakRawCredentialCount();
  const transportSecurityState = enterpriseTransportSecurityState();
  const browserSessionCookieProblems = [
    ENTERPRISE_SESSION_EPOCH_CONFIG.error,
    ENTERPRISE_SESSION_SECRET_CONFIG.error,
    !ENTERPRISE_SESSION_SECRET_CONFIG.stable
      ? 'DASHBOARD_AUTH_SESSION_SECRET or DASHBOARD_AUTH_SESSION_SECRET_FILE is not configured; browser sessions rotate on server restart and are not multi-replica safe'
      : null,
    ENTERPRISE_SESSION_COOKIE_SECURE || enterpriseHostIsLoopback()
      ? null
      : 'DASHBOARD_AUTH_SESSION_COOKIE_SECURE is false on a non-loopback enterprise host',
  ].filter(Boolean);
  const browserSessionCookieState = !ENTERPRISE_AUTH_ON
    ? 'disabled'
    : browserSessionCookieProblems.length > 0
      ? 'action-required'
      : 'enabled';
  const browserSessionRotationSummary =
    ENTERPRISE_SESSION_SECRET_CONFIG.previousKeyCount > 0
      ? `; ${ENTERPRISE_SESSION_SECRET_CONFIG.previousKeyCount} previous decrypt-only key(s) accepted during rotation`
      : '';
  const browserSessionCookieSummary = !ENTERPRISE_AUTH_ON
    ? 'Enterprise auth is disabled'
    : browserSessionCookieProblems.length > 0
      ? browserSessionCookieProblems.join('; ')
      : `HttpOnly SameSite=Strict browser sessions last at most ${ENTERPRISE_SESSION_COOKIE_MAX_AGE_SECONDS} second(s)${browserSessionRotationSummary}`;
  const writeOriginConfigProblems = [
    DASHBOARD_ALLOWED_ORIGIN_MAX_BYTES_EXCEEDED
      ? `origin config exceeds ${DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES} byte limit and was ignored`
      : null,
    DASHBOARD_ALLOWED_ORIGIN_ENTRY_LIMIT_EXCEEDED
      ? `origin config exceeds ${DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES} entry limit; extra entries ignored`
      : null,
    DASHBOARD_ALLOWED_ORIGIN_INVALID_COUNT > 0
      ? DASHBOARD_ALLOWED_ORIGIN_INVALID_COUNT === 1
        ? '1 invalid origin entry ignored'
        : `${DASHBOARD_ALLOWED_ORIGIN_INVALID_COUNT} invalid origin entries ignored`
      : null,
  ].filter(Boolean);
  const writeOriginState =
    writeOriginConfigProblems.length > 0
      ? 'action-required'
      : DASHBOARD_ALLOWED_ORIGINS.length > 0
        ? 'enabled'
        : 'disabled';
  const writeOriginSummary =
    writeOriginConfigProblems.length > 0
      ? `${DASHBOARD_ALLOWED_ORIGINS.length} configured public write origin(s); ${writeOriginConfigProblems.join('; ')}`
      : DASHBOARD_ALLOWED_ORIGINS.length > 0
        ? `${DASHBOARD_ALLOWED_ORIGINS.length} configured public write origin(s)`
        : 'Only loopback origins on the dashboard port are accepted for write CSRF checks';
  const jwtClaimsPinned = Boolean(
    ENTERPRISE_JWT_ISSUER && ENTERPRISE_JWT_AUDIENCE
  );
  const jwtWeakKeyCount =
    (ENTERPRISE_JWT_WEAK_KEY_COUNT || 0) +
    (enterpriseRemoteJwksCache.weakKeyCount || 0);
  const securityHeadersState =
    cspOverrideActive || DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES_EXCEEDED
      ? 'action-required'
      : 'enabled';
  const securityHeadersSummary =
    DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES_EXCEEDED
      ? `DASHBOARD_CONTENT_SECURITY_POLICY exceeds ${DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES} byte limit and was ignored; default CSP is applied`
      : cspOverrideActive
        ? 'HTTP headers are applied with an operator-supplied CSP override'
        : 'CSP, frame denial, nosniff, no-referrer, permissions policy, and cross-origin isolation headers are applied';
  const jwtLifetimeState =
    ENTERPRISE_JWT_CONFIGURED && ENTERPRISE_JWT_MAX_LIFETIME_SECONDS <= 0
      ? 'action-required'
      : ENTERPRISE_JWT_CONFIGURED
        ? 'enabled'
        : 'disabled';
  const remoteJwksError =
    ENTERPRISE_JWKS_URL && enterpriseRemoteJwksCache.error
      ? boundedEnterpriseText(enterpriseRemoteJwksCache.error, 256)
      : '';
  const duplicateJwtKidCount =
    ENTERPRISE_JWKS_URL && enterpriseRemoteJwksCache.duplicateKidCount > 0
      ? enterpriseRemoteJwksCache.duplicateKidCount
      : 0;
  const jwksNetworkState = remoteJwksError
    ? 'action-required'
    : duplicateJwtKidCount > 0
      ? 'action-required'
    : ENTERPRISE_JWKS_URL || ENTERPRISE_JWT_KEYS.length > 0
      ? 'enabled'
      : 'disabled';
  const jwksNetworkSummary = remoteJwksError
    ? `Last remote JWKS refresh failed: ${remoteJwksError}`
    : duplicateJwtKidCount > 0
      ? `Combined static and remote JWKS sources expose ${duplicateJwtKidCount} duplicate key id(s); matching JWTs fail closed`
    : ENTERPRISE_JWKS_URL
      ? `Remote JWKS URL config is capped at ${ENTERPRISE_JWKS_URL_MAX_BYTES} byte(s); fetches time out after ${ENTERPRISE_JWKS_FETCH_TIMEOUT_MS}ms, read at most ${ENTERPRISE_JWKS_MAX_BYTES} byte(s), parse at most ${ENTERPRISE_JWKS_MAX_KEYS} key(s), cache for ${ENTERPRISE_JWKS_CACHE_TTL_MS}ms, and throttle key-id refreshes for ${ENTERPRISE_JWKS_MIN_REFRESH_MS}ms`
      : ENTERPRISE_JWT_KEYS.length > 0
        ? `Static JWKS payloads are capped at ${ENTERPRISE_JWKS_MAX_BYTES} byte(s) and ${ENTERPRISE_JWKS_MAX_KEYS} key(s)`
        : 'JWKS verification is not configured';
  const jwtClaimPathProblems = [
    ['DASHBOARD_AUTH_JWT_ORG_ID_CLAIM', ENTERPRISE_JWT_ORG_ID_CLAIM],
    ['DASHBOARD_AUTH_JWT_ROLE_CLAIM', ENTERPRISE_JWT_ROLE_CLAIM],
    ['DASHBOARD_AUTH_JWT_SCOPE_CLAIM', ENTERPRISE_JWT_SCOPE_CLAIM],
    ['DASHBOARD_AUTH_JWT_TEAM_ID_CLAIM', ENTERPRISE_JWT_TEAM_ID_CLAIM],
    ['DASHBOARD_AUTH_JWT_TEAM_NAME_CLAIM', ENTERPRISE_JWT_TEAM_NAME_CLAIM],
  ].flatMap(([name, value]) => {
    const reason = jwtClaimPathLimitReason(value);
    return reason ? [`${name} ${reason}`] : [];
  });
  const jwtClaimPathState = ENTERPRISE_JWT_CONFIGURED
    ? jwtClaimPathProblems.length > 0
      ? 'action-required'
      : 'enabled'
    : 'disabled';
  const jwtClaimPathSummary = ENTERPRISE_JWT_CONFIGURED
    ? jwtClaimPathProblems.length > 0
      ? jwtClaimPathProblems.join('; ')
      : `JWT claim paths are capped at ${ENTERPRISE_JWT_CLAIM_PATH_MAX_BYTES} byte(s) and ${ENTERPRISE_JWT_CLAIM_PATH_MAX_SEGMENTS} segment(s)`
    : 'JWT authentication is not configured';
  const jwtRoleMapProblems = ENTERPRISE_JWT_ROLE_CONFIGS.flatMap(
    ({ name, config }) =>
      [
        config.maxBytesExceeded
          ? `${name} exceeds ${ENTERPRISE_JWT_ROLE_MAP_MAX_BYTES} byte limit and was ignored`
          : null,
        config.entryLimitExceeded
          ? `${name} exceeds ${ENTERPRISE_JWT_ROLE_MAP_MAX_ENTRIES} entry limit; extra entries ignored`
          : null,
        config.entrySizeExceeded
          ? `${name} has entries above ${ENTERPRISE_JWT_ROLE_MAP_ENTRY_MAX_CHARS} character limit; over-length entries ignored`
          : null,
      ].filter(Boolean)
  );
  const jwtRoleMapState = ENTERPRISE_JWT_CONFIGURED
    ? jwtRoleMapProblems.length > 0
      ? 'action-required'
      : 'enabled'
    : 'disabled';
  const jwtRoleMapSummary = ENTERPRISE_JWT_CONFIGURED
    ? jwtRoleMapProblems.length > 0
      ? jwtRoleMapProblems.join('; ')
      : `JWT role mappings loaded: ${ENTERPRISE_JWT_ADMIN_ROLES.length} admin, ${ENTERPRISE_JWT_MEMBER_ROLES.length} member, ${ENTERPRISE_JWT_VIEWER_ROLES.length} viewer`
    : 'JWT authentication is not configured';
  const trustedProxyConfigProblems = [
    DASHBOARD_TRUSTED_PROXY_ADDRESS_MAX_BYTES_EXCEEDED
      ? `proxy allowlist exceeds ${DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES} byte limit and was ignored`
      : null,
    DASHBOARD_TRUSTED_PROXY_ADDRESS_ENTRY_LIMIT_EXCEEDED
      ? `proxy allowlist exceeds ${DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES} entry limit; extra entries ignored`
      : null,
    DASHBOARD_TRUSTED_PROXY_ADDRESS_INVALID_COUNT > 0
      ? DASHBOARD_TRUSTED_PROXY_ADDRESS_INVALID_COUNT === 1
        ? '1 invalid proxy peer address ignored'
        : `${DASHBOARD_TRUSTED_PROXY_ADDRESS_INVALID_COUNT} invalid proxy peer addresses ignored`
      : null,
  ].filter(Boolean);
  const trustedProxyState = !ENTERPRISE_AUTH_ON || !DASHBOARD_TRUST_PROXY_HEADERS
    ? 'disabled'
    : trustedProxyConfigProblems.length > 0 ||
        DASHBOARD_TRUSTED_PROXY_ADDRESSES.length === 0
      ? 'action-required'
      : 'enabled';
  const trustedProxySummary = !DASHBOARD_TRUST_PROXY_HEADERS
    ? 'Forwarded client headers are ignored'
    : trustedProxyConfigProblems.length > 0
      ? `${DASHBOARD_TRUSTED_PROXY_ADDRESSES.length} configured proxy peer address(es); ${trustedProxyConfigProblems.join('; ')}`
      : DASHBOARD_TRUSTED_PROXY_ADDRESSES.length > 0
        ? `Forwarded client headers are accepted from ${DASHBOARD_TRUSTED_PROXY_ADDRESSES.length} configured proxy peer address(es)`
        : ENTERPRISE_AUTH_ON
          ? 'Forwarded client headers are ignored until DASHBOARD_TRUSTED_PROXY_ADDRESSES is configured'
          : 'Forwarded client headers are trusted from any peer';
  const scopedRootSourcesConfigured =
    ENTERPRISE_PRINCIPALS.some((record) => Boolean(record.principal?.dataRoot)) ||
    ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_CONFIGURED;
  const dataRootBoundaryProblems = [
    ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES_EXCEEDED
      ? `JWT data-root template exceeds ${ENTERPRISE_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES} byte limit and was ignored`
      : null,
  ].filter(Boolean);
  const dataRootBoundaryState =
    !ENTERPRISE_AUTH_ON || !scopedRootSourcesConfigured
      ? 'disabled'
      : dataRootBoundaryProblems.length > 0
        ? 'action-required'
        : ENTERPRISE_DATA_ROOT_BASE
          ? 'enabled'
          : 'action-required';
  const dataRootBoundarySummary =
    dataRootBoundaryProblems.length > 0
      ? dataRootBoundaryProblems.join('; ')
      : ENTERPRISE_DATA_ROOT_BASE
        ? `Scoped principal data roots must stay under ${ENTERPRISE_DATA_ROOT_BASE}`
        : scopedRootSourcesConfigured
          ? 'Scoped principal data roots are configured without an app-level base directory'
          : 'No scoped principal data roots are configured';
  const proxyAddressSource = DASHBOARD_TRUST_PROXY_HEADERS
    ? DASHBOARD_TRUSTED_PROXY_ADDRESSES.length > 0
      ? 'trusted proxy headers from configured proxy peers'
      : ENTERPRISE_AUTH_ON
        ? 'socket; forwarded headers ignored until trusted proxy peers are configured'
        : 'trusted proxy headers from any peer'
    : 'socket';
  const authSummary = [
    ENTERPRISE_PRINCIPALS.length > 0
      ? `${ENTERPRISE_PRINCIPALS.length} configured bearer principal(s)`
      : null,
    ENTERPRISE_JWT_KEYS.length > 0
      ? `${ENTERPRISE_JWT_KEYS.length} static JWT signing key(s)`
      : null,
    ENTERPRISE_JWKS_URL ? 'remote JWKS URL configured' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const mutatingBodySummary = POLICY_WRITE_TOKEN_CONFIG.maxBytesExceeded
    ? `POLICY_WRITE_TOKEN exceeds ${POLICY_WRITE_TOKEN_MAX_BYTES} byte(s) and was ignored; write bodies remain capped at ${DASHBOARD_MUTATING_BODY_MAX_BYTES} byte(s)`
    : `Policy and adoption receipt writes reject bodies above ${DASHBOARD_MUTATING_BODY_MAX_BYTES} byte(s) before JSON parsing`;
  return {
    generatedAt: new Date().toISOString(),
    controls: [
      enterpriseSecurityControl(
        'auth',
        'Bearer authentication',
        ENTERPRISE_AUTH_CONFIGURED ? 'enabled' : 'action-required',
        ENTERPRISE_AUTH_CONFIGURED
          ? authSummary || 'Enterprise bearer auth configured'
          : 'Enterprise auth is enabled but no valid token principal is configured',
        'Tokens can be configured as raw credentials, SHA-256 hashes, or RS256 JWTs verified against DASHBOARD_AUTH_JWKS or DASHBOARD_AUTH_JWKS_URL. Credentials are never returned by admin APIs.'
      ),
      enterpriseSecurityControl(
        'browser-session-cookie',
        'Browser session cookie',
        browserSessionCookieState,
        browserSessionCookieSummary,
        `POST /api/auth/session exchanges a valid enterprise bearer or JWT credential for an encrypted HttpOnly SameSite=Strict cookie capped at ${ENTERPRISE_SESSION_COOKIE_MAX_BYTES} byte(s). Set DASHBOARD_AUTH_SESSION_SECRET or DASHBOARD_AUTH_SESSION_SECRET_FILE to at least ${ENTERPRISE_SESSION_SECRET_MIN_BYTES} byte(s) for restart-safe and multi-replica sessions, use DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET or DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE only as a temporary decrypt-only key during rolling rotation, change DASHBOARD_AUTH_SESSION_EPOCH to revoke all browser sessions across replicas, and set DASHBOARD_AUTH_SESSION_COOKIE_SECURE=true when browsers reach the dashboard over HTTPS through a proxy.`
      ),
      enterpriseSecurityControl(
        'authorization',
        ENTERPRISE_SCOPE_ENFORCEMENT
          ? 'Role and scope route authorization'
          : 'Role-based route authorization',
        'enabled',
        ENTERPRISE_SCOPE_ENFORCEMENT
          ? 'Configured-org principals require both a compatible role and explicit scope'
          : 'Admin-only organization and write routes; scoped roots unlock same-org member/viewer datasets, transcripts, and live reads',
        'Static principal configs containing any principal outside DASHBOARD_ORG_ID make enterprise auth fail closed before route authorization. JWT principals with a configured org claim must match DASHBOARD_ORG_ID before they authenticate. Member and viewer principals can authenticate, but cannot read global data. A per-principal data root scopes dataset, recommendation, transcript, timeline-detail, live, manifest, history, project-file, memory, and workflow routes; file-backed reads resolve real paths and reject symlink escapes. Unclassified protected API routes fail closed until they are explicitly mapped. Set DASHBOARD_AUTH_ENFORCE_SCOPES=true to require explicit least-privilege scopes on top of roles.'
      ),
      enterpriseSecurityControl(
        'credential-storage',
        'Static credential storage',
        rawCredentialCount > 0 ? 'action-required' : 'enabled',
        rawCredentialCount > 0
          ? `${rawCredentialCount} raw bearer secret(s) configured`
          : 'No raw bearer secrets in static principal config',
        'Use tokenSha256 fingerprints in DASHBOARD_AUTH_TOKENS or DASHBOARD_AUTH_TOKENS_FILE, or RS256 JWT verification, for production deployments; raw tokens should stay in the user credential channel.'
      ),
      enterpriseSecurityControl(
        'credential-strength',
        'Static credential strength',
        weakRawCredentialCount > 0 ? 'action-required' : 'enabled',
        ENTERPRISE_RAW_TOKEN_MIN_LENGTH <= 0
          ? 'Raw bearer token length checks are disabled'
          : weakRawCredentialCount > 0
            ? `${weakRawCredentialCount} raw bearer secret(s) shorter than ${ENTERPRISE_RAW_TOKEN_MIN_LENGTH} character(s)`
            : `No raw bearer secrets shorter than ${ENTERPRISE_RAW_TOKEN_MIN_LENGTH} character(s)`,
        'Use high-entropy bearer tokens for bootstrap principals; DASHBOARD_AUTH_MIN_TOKEN_LENGTH controls the posture threshold, and tokenSha256 or RS256 JWT auth avoids storing raw static bearer secrets in app config.'
      ),
      enterpriseSecurityControl(
        'static-token-config-size',
        'Static token config size cap',
        'enabled',
        `Static token config is capped at ${ENTERPRISE_AUTH_TOKENS_MAX_BYTES} byte(s) and ${ENTERPRISE_AUTH_TOKENS_MAX_ENTRIES} principal entry(s) before use`,
        'DASHBOARD_AUTH_TOKENS_MAX_BYTES bounds DASHBOARD_AUTH_TOKENS and DASHBOARD_AUTH_TOKENS_FILE parsing, and DASHBOARD_AUTH_TOKENS_MAX_ENTRIES fails closed before oversized static rosters create a large per-request credential scan. Use RS256 JWT verification for large organizations instead of shipping large bearer rosters through static bootstrap config.'
      ),
      enterpriseSecurityControl(
        'principal-metadata-size',
        'Principal metadata size cap',
        'enabled',
        `Principal identifiers and display fields are capped at ${ENTERPRISE_PRINCIPAL_FIELD_MAX_CHARS} character(s)`,
        'DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS bounds configured organization IDs, user IDs, email addresses, names, and team metadata before those values are returned by admin APIs or written to audit logs. Oversized fields keep a stable hash suffix.'
      ),
      enterpriseSecurityControl(
        'principal-scope-size',
        'Principal scope size cap',
        'enabled',
        `Principal scope source strings are capped at ${ENTERPRISE_SCOPE_SOURCE_MAX_BYTES} byte(s), lists at ${ENTERPRISE_SCOPE_MAX_ENTRIES} scope value(s), and values at ${ENTERPRISE_SCOPE_MAX_CHARS} character(s)`,
        'DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES, DASHBOARD_AUTH_SCOPE_MAX_ENTRIES, and DASHBOARD_AUTH_SCOPE_MAX_CHARS bound static and JWT-derived scope metadata before session/admin payloads and before least-privilege scope checks. Overlarge source strings and extra scopes are ignored.'
      ),
      enterpriseSecurityControl(
        'organization-response-size',
        'Organization response cap',
        'enabled',
        `Admin organization responses are capped at ${DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES} byte(s)`,
        'DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES bounds serialized /api/enterprise/organization and /api/organization/rollup.json payloads after principal pagination, team rollup, redacted operational rollup, posture, and audit summary assembly. Oversized admin payloads return 413 instead of being served.'
      ),
      enterpriseSecurityControl(
        'bearer-token-size',
        'Bearer token size cap',
        'enabled',
        `Bearer tokens above ${ENTERPRISE_MAX_BEARER_TOKEN_BYTES} byte(s) are rejected before credential hashing or JWT parsing`,
        `DASHBOARD_AUTH_MAX_BEARER_BYTES bounds per-request bearer credential work. JWT decoded header, claims, and signature segments are independently capped by DASHBOARD_AUTH_JWT_HEADER_MAX_BYTES=${ENTERPRISE_JWT_HEADER_MAX_BYTES}, DASHBOARD_AUTH_JWT_CLAIMS_MAX_BYTES=${ENTERPRISE_JWT_CLAIMS_MAX_BYTES}, and DASHBOARD_AUTH_JWT_SIGNATURE_MAX_BYTES=${ENTERPRISE_JWT_SIGNATURE_MAX_BYTES}. Raise these only when the IdP issues legitimately larger JWTs.`
      ),
      enterpriseSecurityControl(
        'jwt-claim-pinning',
        'JWT claim pinning',
        ENTERPRISE_JWT_CONFIGURED
          ? jwtClaimsPinned
            ? 'enabled'
            : 'action-required'
          : 'disabled',
        ENTERPRISE_JWT_CONFIGURED
          ? jwtClaimsPinned
            ? 'JWT issuer and audience are pinned'
            : 'JWT signing keys are configured without both issuer and audience pinning'
          : 'JWT authentication is not configured',
        'Set DASHBOARD_AUTH_JWT_ISSUER and DASHBOARD_AUTH_JWT_AUDIENCE for production IdP deployments. DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES bounds each expected issuer/audience value before comparisons. Set DASHBOARD_AUTH_JWT_ORG_ID_CLAIM when tokens carry an organization or tenant claim that should match DASHBOARD_ORG_ID.'
      ),
      enterpriseSecurityControl(
        'jwt-claim-path-bounds',
        'JWT claim path bounds',
        jwtClaimPathState,
        jwtClaimPathSummary,
        'DASHBOARD_AUTH_JWT_ORG_ID_CLAIM, DASHBOARD_AUTH_JWT_ROLE_CLAIM, DASHBOARD_AUTH_JWT_SCOPE_CLAIM, DASHBOARD_AUTH_JWT_TEAM_ID_CLAIM, and DASHBOARD_AUTH_JWT_TEAM_NAME_CLAIM are dot-delimited claim paths. DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_BYTES and DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS bound per-request JWT claim traversal.'
      ),
      enterpriseSecurityControl(
        'jwt-role-mapping',
        'JWT role mapping',
        jwtRoleMapState,
        jwtRoleMapSummary,
        'DASHBOARD_AUTH_JWT_ADMIN_ROLES, DASHBOARD_AUTH_JWT_MEMBER_ROLES, and DASHBOARD_AUTH_JWT_VIEWER_ROLES map IdP role claims into dashboard roles. Admin access is granted only by the admin role map; DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES bounds per-token role claim flattening, and DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES, DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES, and DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS bound each parser.'
      ),
      enterpriseSecurityControl(
        'jwt-key-strength',
        'JWT signing key strength',
        ENTERPRISE_JWT_CONFIGURED
          ? jwtWeakKeyCount > 0
            ? 'action-required'
            : 'enabled'
          : 'disabled',
        ENTERPRISE_JWT_CONFIGURED
          ? jwtWeakKeyCount > 0
            ? `${jwtWeakKeyCount} RSA signing key(s) below ${ENTERPRISE_JWT_MIN_RSA_BITS} bits were ignored`
            : `Loaded JWT RSA signing keys meet the ${ENTERPRISE_JWT_MIN_RSA_BITS}-bit minimum`
          : 'JWT authentication is not configured',
        'Rotate IdP signing keys below the configured floor; weak keys are not used for token verification. DASHBOARD_AUTH_JWT_MIN_RSA_BITS can raise the minimum above 2048 bits.'
      ),
      enterpriseSecurityControl(
        'jwt-token-lifetime',
        'JWT token lifetime',
        jwtLifetimeState,
        ENTERPRISE_JWT_CONFIGURED
          ? ENTERPRISE_JWT_MAX_LIFETIME_SECONDS > 0
            ? `JWT exp/iat lifetime is capped at ${ENTERPRISE_JWT_MAX_LIFETIME_SECONDS} seconds`
            : 'JWT maximum lifetime checks are disabled'
          : 'JWT authentication is not configured',
        'JWTs must include exp. Present iat and nbf claims must be before exp. When DASHBOARD_AUTH_JWT_MAX_LIFETIME_SECONDS is greater than 0, JWTs must also include iat, cannot be issued in the future, and cannot exceed the configured lifetime.'
      ),
      enterpriseSecurityControl(
        'jwks-network-bounds',
        'JWKS parsing and network bounds',
        jwksNetworkState,
        jwksNetworkSummary,
        'DASHBOARD_AUTH_JWKS_URL_MAX_BYTES bounds remote IdP endpoint config before URL parsing. DASHBOARD_AUTH_JWKS_MAX_BYTES bounds static JWKS parsing and remote JWKS reads, and DASHBOARD_AUTH_JWKS_MAX_KEYS bounds key construction. DASHBOARD_AUTH_JWKS_FETCH_TIMEOUT_MS, DASHBOARD_AUTH_JWKS_CACHE_TTL_MS, and DASHBOARD_AUTH_JWKS_MIN_REFRESH_MS also bound remote IdP network work. Runtime remote JWKS errors are bounded before they appear in admin posture.'
      ),
      enterpriseSecurityControl(
        'scope-enforcement',
        'Least-privilege scopes',
        scopeEnforcementState,
        ENTERPRISE_SCOPE_ENFORCEMENT
          ? 'Route capabilities require matching principal scopes'
          : ENTERPRISE_AUTH_ON
            ? 'Roles authorize routes; enable DASHBOARD_AUTH_ENFORCE_SCOPES for least-privilege checks'
            : 'Scopes are recorded and displayed but roles remain the authorization source',
        'Supported scopes include sessions:read, transcripts:read, org:read, org:write, policy:write, audit:read, namespace wildcards such as org:*, and * for break-glass principals. Enterprise deployments should enable DASHBOARD_AUTH_ENFORCE_SCOPES when the IdP or static principal config can issue scoped claims.'
      ),
      enterpriseSecurityControl(
        'data-root-boundary',
        'Scoped data-root boundary',
        dataRootBoundaryState,
        dataRootBoundarySummary,
        'Set DASHBOARD_AUTH_DATA_ROOT_BASE to the approved tenant data directory in production. When set, static principal dataRoot/claudeDir values and JWT data-root templates outside that normalized base are treated as unconfigured, so member/viewer data access fails closed. DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES bounds JWT template substitution work before per-principal roots are derived.'
      ),
      enterpriseSecurityControl(
        'audit-log',
        'Enterprise audit log',
        ENTERPRISE_AUTH_ON ? 'enabled' : 'disabled',
        ENTERPRISE_AUTH_ON
          ? 'Auth decisions, denied routes, privileged routes, and rate-limit events are appended'
          : 'Enterprise audit logging starts when enterprise auth is enabled',
        `Audit records include principal metadata and bearer-token fingerprints, not raw tokens. Admin reads tail at most ${ENTERPRISE_AUDIT_READ_MAX_BYTES} byte(s) and skip lines above ${ENTERPRISE_AUDIT_LINE_MAX_BYTES} byte(s) before JSON parsing. ${enterpriseAuditRetentionDetail()}`
      ),
      enterpriseSecurityControl(
        'security-headers',
        'HTTP security headers',
        securityHeadersState,
        securityHeadersSummary,
        DASHBOARD_ENABLE_HSTS
          ? 'HSTS is enabled for HTTPS deployments.'
          : cspOverrideActive
            ? 'Verify DASHBOARD_CONTENT_SECURITY_POLICY preserves frame-ancestors, object-src, base-uri, script-src, and connect-src restrictions. DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES bounds custom response-header size.'
            : 'Enable DASHBOARD_ENABLE_HSTS=true only when HTTPS is terminated by a trusted proxy. DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES bounds custom response-header size.'
      ),
      enterpriseSecurityControl(
        'transport-security',
        'Transport security',
        transportSecurityState,
        !ENTERPRISE_AUTH_ON
          ? 'Enterprise auth is disabled'
          : DASHBOARD_ENABLE_HSTS
            ? 'HSTS is emitted by the dashboard service'
            : enterpriseHostIsLoopback()
              ? `Dashboard service is bound to loopback host ${HOST}`
              : `Dashboard service is bound to ${HOST} without app-level HSTS`,
        'Serve enterprise auth only over HTTPS, a private tunnel, or a verified loopback-only host publish. Set DASHBOARD_ENABLE_HSTS=true when TLS terminates at a trusted proxy that forwards dashboard responses to browsers.'
      ),
      enterpriseSecurityControl(
        'trusted-proxy-boundary',
        'Trusted proxy boundary',
        trustedProxyState,
        trustedProxySummary,
        'Set DASHBOARD_TRUSTED_PROXY_ADDRESSES to the exact socket peer address(es) of the reverse proxy before enabling DASHBOARD_TRUST_PROXY_HEADERS on an exposed deployment. DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES and DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES bound the parser; invalid and over-limit entries are ignored for enforcement and flagged here.'
      ),
      enterpriseSecurityControl(
        'mutating-body-size',
        'Mutating request body cap',
        POLICY_WRITE_TOKEN_CONFIG.maxBytesExceeded ? 'action-required' : 'enabled',
        mutatingBodySummary,
        `DASHBOARD_MUTATING_BODY_MAX_BYTES bounds authenticated write-route memory and parsing work. Existing settings.json reads for policy writes are capped at DASHBOARD_CONFIG_FILE_MAX_BYTES=${CONFIG_FILE_MAX_BYTES} byte(s) before parsing or backup. POLICY_WRITE_TOKEN overrides above ${POLICY_WRITE_TOKEN_MAX_BYTES} byte(s) are ignored before the active token is set, and write-route CSRF/Bearer fallback tokens above the same cap are rejected before token comparison. Keep the defaults unless an approved client legitimately needs larger JSON writes.`
      ),
      enterpriseSecurityControl(
        'raw-file-size',
        'Raw transcript/history read cap',
        'enabled',
        `Raw history and merged transcript reads reject responses above ${DASHBOARD_RAW_FILE_MAX_BYTES} byte(s); merged sessions include at most ${DASHBOARD_RAW_SESSION_MAX_PARTS} transcript part(s)`,
        'DASHBOARD_RAW_FILE_MAX_BYTES bounds memory used by raw transcript and history endpoints. DASHBOARD_RAW_SESSION_MAX_PARTS bounds top-level plus subagent transcript directory discovery and concatenation before one raw project-file request can assemble an unbounded file list. Use the dataset and lazy transcript APIs for normal large-corpus browsing.'
      ),
      enterpriseSecurityControl(
        'sessions-manifest-size',
        'Sessions manifest entry cap',
        'enabled',
        `Sessions manifest responses return at most ${DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES} top-level session file entries`,
        'DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES bounds /sessions-manifest.json project/session enumeration before response assembly. Truncated responses preserve the legacy array body and set X-Dashboard-Manifest-Truncated=true.'
      ),
      enterpriseSecurityControl(
        'lazy-transcript-size',
        'Lazy transcript response cap',
        'enabled',
        `Cached transcript BLOB decompression is capped at ${DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES} byte(s)`,
        'DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES bounds lazy /api/transcript/* responses and server-side transcript reads for audit helpers before compressed BLOBs can inflate without limit.'
      ),
      enterpriseSecurityControl(
        'dataset-response-size',
        'Dataset response cap',
        'enabled',
        `Live dataset JSON responses are capped at ${DATASET_RESPONSE_MAX_BYTES} byte(s) before compression or cache persistence`,
        'DASHBOARD_DATASET_RESPONSE_MAX_BYTES bounds /api/dataset.json serialization, compressed dataset-cache reload decompression, and cold dataset cache persistence before one organization dataset can dominate request or process memory.'
      ),
      enterpriseSecurityControl(
        'ingest-session-size',
        'Ingest session read cap',
        'enabled',
        `Merged session ingest discovers at most ${INGEST_PROJECT_MAX_DIRS} project dir entry(s), ${INGEST_SESSION_DISCOVERY_MAX_ENTRIES} session dir entry(s), and skips sessions above ${INGEST_SESSION_MAX_BYTES} byte(s) or ${INGEST_SESSION_MAX_PARTS} transcript part(s)`,
        'DASHBOARD_INGEST_PROJECT_MAX_DIRS bounds top-level project directory discovery before dataset rebuilds. DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES bounds top-level session directory scans across projects. DASHBOARD_INGEST_SESSION_MAX_BYTES bounds dataset ingest memory for top-level and merged subagent transcript reads. DASHBOARD_INGEST_SESSION_MAX_PARTS bounds top-level plus subagent and nested workflow-agent transcript fanout before dataset rebuilds assemble unbounded file lists. Oversized or over-part sessions are omitted from the live dataset and their stale cached rows are removed.'
      ),
      enterpriseSecurityControl(
        'live-session-size',
        'Live session read cap',
        'enabled',
        `Live-session transcript reads stop at ${LIVE_SESSION_MAX_BYTES} byte(s)`,
        'DASHBOARD_LIVE_SESSION_MAX_BYTES bounds /api/live polling memory for the newest top-level transcript plus subagent text before parser work runs.'
      ),
      enterpriseSecurityControl(
        'config-file-size',
        'Config artifact read cap',
        'enabled',
        `Config artifact reads skip files above ${CONFIG_FILE_MAX_BYTES} byte(s) ` +
          `and enumerate at most ${CONFIG_RESOURCE_MAX_ENTRIES} resource entry(s) ` +
          'per config section',
        'DASHBOARD_CONFIG_FILE_MAX_BYTES bounds liveConfig and repo ' +
          'configuration artifact reads, including settings, CLAUDE.md, ' +
          'skills, plugins, config backups, and repo instruction files. ' +
          'DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES bounds liveConfig resource ' +
          'directory discovery and enumeration for skills, subagents, commands, plugin entries, ' +
          'plugin-bundled resources, and MCP server rows before dataset assembly.'
      ),
      enterpriseSecurityControl(
        'artifact-file-size',
        'Auxiliary artifact read cap',
        'enabled',
        `Auxiliary dataset artifact reads skip files above ${ARTIFACT_FILE_MAX_BYTES} byte(s)`,
        'DASHBOARD_ARTIFACT_FILE_MAX_BYTES bounds dataset reads for task records, team inboxes, saved plans, session registries, telemetry, debug logs, history union, stats/update/MCP caches, shadow-call ledgers, and repo-map artifact JSON.'
      ),
      enterpriseSecurityControl(
        'artifact-directory-entries',
        'Auxiliary artifact directory cap',
        'enabled',
        `Auxiliary dataset artifact parsers inspect at most ${ARTIFACT_DIR_MAX_ENTRIES} directory entry(s) per artifact directory scan`,
        'DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES bounds optional dataset artifact discovery for tasks, team inboxes, session registries, telemetry files, debug logs, file-history snapshots, saved plans, and config backups before per-file reads run.'
      ),
      enterpriseSecurityControl(
        'artifact-cache-size',
        'Auxiliary artifact cache payload cap',
        'enabled',
        `Auxiliary artifact cache rows persist only when serialized JSON is at most ${ARTIFACT_CACHE_JSON_MAX_BYTES} byte(s)`,
        'DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES bounds per-artifact SQLite cache rows for parsed optional artifacts. Oversized parsed artifacts still contribute to the current dataset response but are not persisted to artifact_cache, avoiding durable oversized cache rows.'
      ),
      enterpriseSecurityControl(
        'artifact-signature-bounds',
        'Auxiliary artifact signature bounds',
        'enabled',
        `Dataset cache signatures inspect at most ${SIGNATURE_TREE_MAX_ENTRIES} tree entry(s) per optional artifact tree and ${REPO_MAP_ARTIFACT_MAX_ENTRIES} repo-map directory entry(s)`,
        'DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES bounds stat-only cache invalidation walks for usage-data, skills, agents, commands, plugin caches, repo-map artifacts, and per-artifact cache signatures before dataset rebuilds. DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES bounds repo-map root discovery before per-repository config files are statted.'
      ),
      enterpriseSecurityControl(
        'adoption-receipt-read-size',
        'Adoption receipt read cap',
        'enabled',
        `Admin adoption receipt reads tail at most ${DASHBOARD_ADOPTION_RECEIPT_READ_MAX_BYTES} byte(s)`,
        `DASHBOARD_ADOPTION_RECEIPT_READ_MAX_BYTES bounds admin replay memory for the append-only adoption receipt log. The reader discards a partial leading line from the tail window, skips JSONL lines above ${ADOPTION_RECEIPT_LINE_MAX_BYTES} byte(s) before JSON parsing, and re-sanitizes every returned receipt through the canonical allowlist.`
      ),
      enterpriseSecurityControl(
        'memory-read-size',
        'Memory read bounds',
        'enabled',
        `Memory reads cap each markdown file at ${DASHBOARD_MEMORY_FILE_MAX_BYTES} byte(s), each response at ${DASHBOARD_MEMORY_RESPONSE_MAX_BYTES} byte(s), each response at most ${DASHBOARD_MEMORY_MAX_FILES} file(s), and each directory scan at ${DASHBOARD_MEMORY_DIR_MAX_ENTRIES} entry(s)`,
        'DASHBOARD_MEMORY_FILE_MAX_BYTES, DASHBOARD_MEMORY_RESPONSE_MAX_BYTES, DASHBOARD_MEMORY_MAX_FILES, and DASHBOARD_MEMORY_DIR_MAX_ENTRIES bound on-demand memory-file API reads and project/memory directory discovery. Oversized files and capped file lists or directory scans are reported in the response metadata.'
      ),
      enterpriseSecurityControl(
        'workflow-manifest-size',
        'Workflow ledger read cap',
        'enabled',
        `Workflow manifest reads skip files above ${WORKFLOW_MANIFEST_MAX_BYTES} byte(s), return at most ${WORKFLOW_RUN_MAX_ENTRIES} run(s), cap phases at ${WORKFLOW_PHASE_MAX_ENTRIES} per run, cap progress entries at ${WORKFLOW_PROGRESS_MAX_ENTRIES} per run, and cap projected strings at ${WORKFLOW_FIELD_MAX_CHARS} char(s)`,
        'DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES bounds workflow ledger reads for both /api/workflows and dataset ingest. DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES bounds projected run entries and project/session/manifest directory discovery before response or dataset assembly. DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES, DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES, and DASHBOARD_WORKFLOW_FIELD_MAX_CHARS bound projected per-run arrays and manifest-derived strings. Oversized manifests are skipped and capped run lists are reported in response metadata.'
      ),
      enterpriseSecurityControl(
        'recommendations-cache',
        'Recommendations response cache',
        'enabled',
        `${recommendationCacheEntries} cached recommendation response(s), ` +
          `${recommendationCacheBuilds} active build(s), max ` +
          `${DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES} response(s) per dataset state`,
        'DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES bounds ' +
          '/api/recommendations.json response cache cardinality per global or ' +
          'scoped dataset state. Source-signature checks preserve freshness, ' +
          'and per-key single-flight builds prevent concurrent org/admin ' +
          'traffic from rerunning ingest and recommendation assembly for the same dataset.'
      ),
      enterpriseSecurityControl(
        'recommendations-response-size',
        'Recommendations response cap',
        'enabled',
        `Recommendation responses are capped at ${DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES} byte(s) before cache insertion`,
        'DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES bounds serialized /api/recommendations.json payloads per global or project-scoped dataset response. Oversized recommendation bodies return 413 and are not inserted into the in-memory response cache.'
      ),
      enterpriseSecurityControl(
        'write-origin-allowlist',
        'Write origin allowlist',
        writeOriginState,
        writeOriginSummary,
        'Set DASHBOARD_ALLOWED_ORIGINS to exact HTTPS origins, such as https://dashboard.example.com, when the server build is accessed through a reverse proxy or private tunnel hostname. DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES and DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES bound the parser; invalid and over-limit entries are ignored for enforcement and flagged here.'
      ),
      enterpriseSecurityControl(
        'authenticated-cache',
        'Authenticated cache policy',
        ENTERPRISE_AUTH_ON ? 'enabled' : 'disabled',
        ENTERPRISE_AUTH_ON
          ? 'Auth/session and protected enterprise data routes are served with Cache-Control: no-store'
          : 'Single-user mode keeps local revalidation semantics',
        'This prevents shared caches from retaining principal metadata, organization data, or protected misses in enterprise mode.'
      ),
      enterpriseSecurityControl(
        'server-llm-audits',
        'Server LLM audit egress',
        serverLlmAuditState,
        DASHBOARD_ENABLE_SERVER_LLM_AUDITS
          ? serverLlmAuditKeyConfigured
            ? 'Judge/audit calls are enabled with a configured Console API key'
            : 'Judge/audit calls are enabled but ANTHROPIC_API_KEY is missing'
          : 'Judge/audit calls are disabled by default',
        'Set DASHBOARD_ENABLE_SERVER_LLM_AUDITS=true only when operators have approved sending scrubbed transcript-derived audit prompts through the server-side Console API key.'
      ),
      enterpriseSecurityControl(
        'audit-response-size',
        'Audit response cap',
        'enabled',
        `Server audit responses are capped at ${DASHBOARD_AUDIT_RESPONSE_MAX_BYTES} byte(s) before compression`,
        'DASHBOARD_AUDIT_RESPONSE_MAX_BYTES bounds serialized /api/audit.json payloads, including optional judge findings and disabled-reason responses. Oversized audit payloads return 413 instead of being compressed or served.'
      ),
      enterpriseSecurityControl(
        'audit-judge-budget',
        'Audit judge call budget',
        'enabled',
        `Server audit runs attempt at most ${DASHBOARD_AUDIT_MAX_JUDGE_CALLS} judge call(s) per request`,
        'DASHBOARD_AUDIT_MAX_JUDGE_CALLS bounds external LLM judge fanout across /api/audit.json reference, workflow, regression, MCP, skill-draft, and deceit audits. Candidate-level failures preserve already-collected findings while the shared budget prevents one large tenant corpus from triggering unbounded egress.'
      ),
      enterpriseSecurityControl(
        'audit-output-tokens',
        'Audit judge output token cap',
        'enabled',
        `Server audit judge calls request at most ${DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS} output token(s) per call`,
        'DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS bounds max_tokens for every registered server.audit-judge Anthropic message call. The server clamps judge and draft-judge requests before egress, and the LLM chokepoint rejects Rule B calls whose cap receipt does not cover the requested output tokens.'
      ),
      enterpriseSecurityControl(
        'audit-input-rows',
        'Audit input row cap',
        'enabled',
        `Server audit input mapping reads at most ${DASHBOARD_AUDIT_INPUT_MAX_ROWS} row(s) from each dataset array`,
        'DASHBOARD_AUDIT_INPUT_MAX_ROWS bounds /api/audit.json pre-judge transforms for sessions, token rows, tool rows, timelines, API errors, file-history rows, deceit signals, and MCP config rows before candidate detection, ranking, or outcome computation runs.'
      ),
      enterpriseSecurityControl(
        'server-usage-gauge',
        'Server usage-gauge egress',
        serverUsageGaugeState,
        DASHBOARD_ENABLE_SERVER_USAGE_GAUGE
          ? 'Usage gauge may call Anthropic with the server Claude OAuth credential'
          : ENTERPRISE_AUTH_ON
            ? 'Usage gauge server egress is disabled in enterprise mode'
            : 'Usage gauge remains available in single-user mode',
        'Set DASHBOARD_ENABLE_SERVER_USAGE_GAUGE=true only when operators approve server-side plan-limit checks using the deployment host Claude OAuth credential.'
      ),
      githubReviewSyncPostureControl(),
      enterpriseSecurityControl(
        'usage-credential-size',
        'Usage credential read cap',
        'enabled',
        `Claude OAuth credential reads stop at ${DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES} byte(s)`,
        'DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES bounds .credentials.json parsing before the optional server usage gauge looks for an access token.'
      ),
      enterpriseSecurityControl(
        'browser-llm-egress',
        'Browser LLM egress',
        browserLlmEgressState,
        ENTERPRISE_AUTH_ON &&
          cspOverrideActive &&
          !DASHBOARD_ENABLE_BROWSER_LLM_EGRESS
          ? 'Custom CSP override controls browser egress; verify connect-src'
          : DASHBOARD_ENABLE_BROWSER_LLM_EGRESS
          ? 'Browser-side Ask Claude calls to api.anthropic.com are allowed by CSP'
          : ENTERPRISE_AUTH_ON
            ? 'Enterprise CSP blocks browser-side calls to api.anthropic.com by default'
            : 'Browser-side Ask Claude calls remain available in single-user mode',
        'Set DASHBOARD_ENABLE_BROWSER_LLM_EGRESS=true only when operators approve each browser using its own Anthropic API key directly from the dashboard origin.'
      ),
      enterpriseSecurityControl(
        'rate-limits',
        'In-process rate limits',
        rateLimitState,
        disabledRateLimitBuckets.length > 0
          ? `Disabled enterprise rate-limit bucket(s): ${disabledRateLimitBuckets.join(', ')}; window ${ENTERPRISE_RATE_LIMIT_WINDOW_MS}ms, max ${ENTERPRISE_RATE_LIMIT_MAX_BUCKETS} buckets, address source ${proxyAddressSource}`
          : `Auth/session and invalid-token attempts ${ENTERPRISE_AUTH_RATE_LIMIT}/window by address, authenticated API ${ENTERPRISE_API_RATE_LIMIT}/window by token and address, window ${ENTERPRISE_RATE_LIMIT_WINDOW_MS}ms, max ${ENTERPRISE_RATE_LIMIT_MAX_BUCKETS} buckets, address source ${proxyAddressSource}`,
        'Use distributed proxy or gateway rate limits in front of multi-node deployments. Set ENTERPRISE_AUTH_RATE_LIMIT=0 or ENTERPRISE_API_RATE_LIMIT=0 only for an approved maintenance window. Set DASHBOARD_TRUST_PROXY_HEADERS=true only when a trusted reverse proxy strips client-supplied forwarding headers and injects its own.'
      ),
      enterpriseSecurityControl(
        'scoped-cache',
        'Scoped ingest state cap',
        'enabled',
        `${scopedDatasetStates.size} active scoped state(s), max ${ENTERPRISE_SCOPED_DATASET_MAX_STATES}`,
        'Per-tenant in-process dataset state is evicted least-recently-used; persistent SQLite caches remain keyed by data-root hash.'
      ),
    ],
    deploymentNotes: [
      'Run enterprise deployments behind HTTPS or a private tunnel.',
      'Prefer tokenSha256 fingerprints in app config; keep raw bearer tokens in the user credential channel.',
      'Keep distributed rate limits in front of multi-node deployments.',
      'Enable DASHBOARD_TRUST_PROXY_HEADERS only behind a trusted proxy that sanitizes forwarded headers.',
      'Keep every configured principal in DASHBOARD_ORG_ID; cross-org static principal config makes enterprise auth fail closed.',
      'Set DASHBOARD_AUTH_DATA_ROOT_BASE before enabling member/viewer scoped roots in production.',
      'Tune enterprise audit retention for your compliance window and external log pipeline.',
      'Per-principal data roots unlock scoped datasets and file-backed reads; realpath containment rejects symlink escapes.',
      'Keep server usage-gauge egress disabled unless the deployment host Claude OAuth credential is approved for organization admins.',
      'Set an Anthropic Console workspace spend limit before enabling server LLM audits with ANTHROPIC_API_KEY.',
      'Keep browser LLM egress disabled unless browser-held Anthropic API keys are approved for the organization.',
      'Admins retain the global organization view.',
    ],
  };
}

function enterpriseSessionPayload(principal) {
  if (!ENTERPRISE_AUTH_ON) {
    return {
      mode: 'single-user',
      authRequired: false,
      authenticated: true,
      configured: true,
      principal: {
        userId: 'local-user',
        name: 'Local user',
        role: 'admin',
        orgId: ENTERPRISE_ORG_ID,
        orgName: ENTERPRISE_ORG_NAME,
        scopes: [],
      },
      organization: { id: ENTERPRISE_ORG_ID, name: ENTERPRISE_ORG_NAME },
      capabilities: {
        ...enterpriseCapabilities('admin'),
        canImportLocalData: true,
      },
    };
  }
  return {
    mode: 'enterprise',
    authRequired: true,
    authenticated: Boolean(principal),
    configured: ENTERPRISE_AUTH_CONFIGURED,
    configError: ENTERPRISE_AUTH_CONFIG_ERROR || undefined,
    principal: principal ? enterprisePublicPrincipal(principal) : null,
    organization: { id: ENTERPRISE_ORG_ID, name: ENTERPRISE_ORG_NAME },
    capabilities: principal ? enterpriseCapabilitiesForPrincipal(principal) : {},
  };
}

function enterpriseRequestClaudeRoot(req) {
  const principal = req.enterprisePrincipal;
  if (ENTERPRISE_AUTH_ON && principal?.role !== 'admin' && principal?.dataRoot) {
    return principal.dataRoot;
  }
  return CLAUDE;
}

function enterpriseRequestProjectsRoot(req) {
  return join(enterpriseRequestClaudeRoot(req), 'projects');
}

function enterpriseRequestProjectsRoots(req) {
  const principal = req.enterprisePrincipal;
  if (ENTERPRISE_AUTH_ON && principal?.role !== 'admin' && principal?.dataRoot) {
    return [join(principal.dataRoot, 'projects')];
  }
  return PROJECT_ROOTS;
}

function enterpriseRequestDataSource(req, sourceId) {
  const source = DATA_SOURCE_BY_ID.get(sourceId);
  if (!source) return null;
  const principal = req.enterprisePrincipal;
  if (ENTERPRISE_AUTH_ON && principal?.role !== 'admin' && principal?.dataRoot) {
    if (sourceId !== DEFAULT_SOURCE.id) return null;
    return {
      ...DEFAULT_SOURCE,
      historyDir: join(principal.dataRoot, 'projects'),
      configFile: join(dirname(principal.dataRoot), '.claude.json'),
    };
  }
  return source;
}

function enterpriseRequestSourceClaudeRoot(req, sourceId) {
  const source = enterpriseRequestDataSource(req, sourceId);
  return source ? dirname(source.historyDir) : null;
}

function enterpriseRequestSourceProjectsRoot(req, sourceId) {
  const source = enterpriseRequestDataSource(req, sourceId);
  return source ? source.historyDir : null;
}

function isEnterpriseProtectedPath(pathname) {
  if (!ENTERPRISE_AUTH_ON) return false;
  if (pathname === '/api/auth/session') return false;
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/sessions-manifest.json' || pathname === '/history.jsonl') {
    return true;
  }
  if (pathname.startsWith('/projects/')) return true;
  return false;
}

function isBasicAuthSensitivePath(pathname) {
  if (pathname === '/api/auth/session') return true;
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/sessions-manifest.json' || pathname === '/history.jsonl') {
    return true;
  }
  if (pathname.startsWith('/projects/')) return true;
  return false;
}

function rejectEnterpriseAuth(res, status, payload) {
  if (status === 401) {
    res.setHeader(
      'WWW-Authenticate',
      'Bearer realm="Claude History Dashboard", error="invalid_token"'
    );
  }
  return sendJson(res, status, payload);
}

async function requireEnterpriseAuth(req, res, pathname) {
  if (!isEnterpriseProtectedPath(pathname)) return true;
  appendVary(res, 'Authorization');
  appendVary(res, 'Cookie');
  res.setHeader('Cache-Control', 'no-store');
  if (!ENTERPRISE_AUTH_CONFIGURED) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.denied',
      outcome: 'denied',
      status: 503,
      path: pathname,
      reason: ENTERPRISE_AUTH_CONFIG_ERROR ? 'config_error' : 'not_configured',
    });
    rejectEnterpriseAuth(res, 503, {
      ok: false,
      authRequired: true,
      authenticated: false,
      configured: false,
      error:
        ENTERPRISE_AUTH_CONFIG_ERROR ||
        'Enterprise auth is enabled but no dashboard tokens are configured',
    });
    return false;
  }
  const bearerToken = extractBearerToken(req);
  const staticPrincipal = bearerToken
    ? findEnterpriseStaticPrincipal(bearerToken)
    : null;
  const sessionPrincipal = bearerToken
    ? null
    : findEnterprisePrincipalFromSessionCookie(req);
  if (
    !staticPrincipal &&
    !sessionPrincipal &&
    !checkEnterpriseRateLimitHeadroom(req, res, {
      group: 'auth',
      limit: ENTERPRISE_AUTH_RATE_LIMIT,
      path: pathname,
    })
  ) {
    return false;
  }
  const principal =
    staticPrincipal ||
    sessionPrincipal ||
    (bearerToken ? await findEnterpriseJwtPrincipal(bearerToken) : null);
  if (!principal) {
    if (
      !checkEnterpriseRateLimit(req, res, {
        group: 'auth',
        limit: ENTERPRISE_AUTH_RATE_LIMIT,
        path: pathname,
      })
    ) {
      return false;
    }
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.denied',
      outcome: 'denied',
      status: 401,
      path: pathname,
      reason: req.enterpriseAuthFailureReason || 'invalid_token',
    });
    if (hasEnterpriseSessionCookie(req)) clearEnterpriseSessionCookie(res);
    rejectEnterpriseAuth(res, 401, {
      ok: false,
      authRequired: true,
      authenticated: false,
      configured: true,
      error: 'Unauthorized: missing or invalid enterprise credential',
    });
    return false;
  }
  if (
    !checkEnterpriseRateLimit(req, res, {
      group: 'api',
      limit: ENTERPRISE_API_RATE_LIMIT,
      path: pathname,
    })
  ) {
    return false;
  }
  if (!enterprisePrincipalInConfiguredOrg(principal)) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.denied',
      outcome: 'denied',
      status: 403,
      path: pathname,
      reason: 'org_mismatch',
      principal,
    });
    sendJson(res, 403, {
      ok: false,
      authRequired: true,
      authenticated: true,
      configured: true,
      error: 'Forbidden: this principal is outside the configured organization',
    });
    return false;
  }
  if (!(await enterprisePrincipalDataRootAllowed(principal))) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.denied',
      outcome: 'denied',
      status: 403,
      path: pathname,
      reason: 'data_root_boundary',
      principal,
    });
    sendJson(res, 403, {
      ok: false,
      authRequired: true,
      authenticated: true,
      configured: true,
      error: 'Forbidden: this principal data root is outside the configured boundary',
    });
    return false;
  }
  if (!enterpriseRouteAllowed(principal, pathname, req.method || 'GET')) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.denied',
      outcome: 'denied',
      status: 403,
      path: pathname,
      reason: 'forbidden',
      principal,
    });
    sendJson(res, 403, {
      ok: false,
      authRequired: true,
      authenticated: true,
      configured: true,
      error: 'Forbidden: this principal is not allowed to access that route',
    });
    return false;
  }
  if (enterprisePrivilegedRoute(pathname, req.method || 'GET')) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.route.allowed',
      outcome: 'allowed',
      status: 200,
      path: pathname,
      reason: 'privileged_route',
      principal,
    });
  }
  req.enterprisePrincipal = principal;
  return true;
}

function enterpriseReadMethod(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function enterpriseWriteCapabilityPath(pathname) {
  return (
    pathname === '/api/policy/write' ||
    pathname === '/api/csrf-token'
  );
}

function enterprisePrivilegedRoute(pathname, method = 'GET') {
  return (
    pathname === '/api/enterprise/audit-log' ||
    pathname === '/api/enterprise/audit-export.ndjson' ||
    pathname === '/api/enterprise/organization' ||
    pathname === '/api/enterprise/readiness-receipt' ||
    pathname === '/api/organization/rollup.json' ||
    enterpriseWriteCapabilityPath(pathname) ||
    !enterpriseReadMethod(method)
  );
}

function enterpriseOrganizationDataPath(pathname) {
  return (
    pathname === '/api/dataset.json' ||
    pathname === '/api/recommendations.json' ||
    pathname === '/api/adoption/receipts' ||
    pathname === '/api/usage' ||
    pathname === '/api/audit.json' ||
    pathname === '/api/live'
  );
}

function enterpriseScopedDataPath(pathname) {
  return (
    pathname === '/api/dataset.json' ||
    pathname === '/api/recommendations.json' ||
    pathname === '/api/search' ||
    pathname === '/api/digest' ||
    pathname === '/api/live' ||
    pathname === '/sessions-manifest.json' ||
    pathname === '/history.jsonl' ||
    pathname === '/api/memories' ||
    pathname === '/api/workflows' ||
    /^\/api\/session\/[^/]+\/timeline$/.test(pathname) ||
    /^\/api\/session\/[^/]+\/tools$/.test(pathname) ||
    pathname.startsWith('/projects/')
  );
}

function enterpriseRouteAllowed(principal, pathname, method = 'GET') {
  const caps = enterpriseCapabilitiesForPrincipal(principal);
  if (
    pathname === '/api/enterprise/audit-log' ||
    pathname === '/api/enterprise/audit-export.ndjson' ||
    pathname === '/api/enterprise/organization' ||
    pathname === '/api/enterprise/readiness-receipt' ||
    pathname === '/api/organization/rollup.json'
  ) {
    if (
      pathname === '/api/enterprise/audit-log' ||
      pathname === '/api/enterprise/audit-export.ndjson'
    ) {
      return caps.canReadAuditLog;
    }
    return caps.canReadOrganizationRollup;
  }
  if (enterpriseWriteCapabilityPath(pathname)) {
    return caps.canWritePolicy;
  }
  // Session dispatch (#1251): under ENTERPRISE auth this requires admin (canWritePolicy) for ALL
  // methods. In default (non-enterprise) mode the server is localhost-bound and unauthenticated like
  // its other read routes; the mutating POST/DELETE are still gated by passesWriteAuth (same-origin +
  // CSRF) regardless of mode.
  if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
    return caps.canWritePolicy;
  }
  // Session-history push-ingest (#1563): machine-to-machine, gated by its OWN bearer token
  // (passesIngestAuth), not a browser principal. Classified canWritePolicy here so it isn't an
  // anonymous hole under enterprise auth; the shipper presents the ingest token regardless of mode.
  if (/^\/api\/ingest\/[^/]+\/artifacts$/.test(pathname)) {
    return caps.canWritePolicy;
  }
  if (!enterpriseReadMethod(method)) {
    return caps.canWritePolicy;
  }
  if (enterpriseScopedDataPath(pathname)) {
    return principal?.role === 'admin'
      ? caps.canReadOrganizationData
      : caps.canReadOwnSessions;
  }
  if (enterpriseOrganizationDataPath(pathname)) {
    return caps.canReadOrganizationData;
  }
  if (pathname.startsWith('/api/transcript/')) {
    return caps.canReadRawTranscripts;
  }
  if (pathname.startsWith('/api/')) {
    return false;
  }
  return true;
}

function requestPathname(req) {
  try {
    return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

async function handleAuthSession(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method || 'GET')) {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET, POST, or DELETE' });
  }
  appendVary(res, 'Authorization');
  appendVary(res, 'Cookie');
  if (req.method === 'DELETE') {
    const principal = await findEnterprisePrincipal(req);
    clearEnterpriseSessionCookie(res);
    if (ENTERPRISE_AUTH_ON) {
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.auth.session',
        outcome: 'allowed',
        status: 200,
        path: '/api/auth/session',
        reason: 'signed_out',
        principal: principal || undefined,
      });
    }
    return sendJson(res, 200, {
      ok: true,
      ...enterpriseSessionPayload(null),
    });
  }
  if (
    !checkEnterpriseRateLimit(req, res, {
      group: 'auth',
      limit: ENTERPRISE_AUTH_RATE_LIMIT,
      path: '/api/auth/session',
    })
  ) {
    return;
  }
  if (ENTERPRISE_AUTH_ON && !ENTERPRISE_AUTH_CONFIGURED) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'denied',
      status: 503,
      path: '/api/auth/session',
      reason: ENTERPRISE_AUTH_CONFIG_ERROR ? 'config_error' : 'not_configured',
    });
    clearEnterpriseSessionCookie(res);
    return rejectEnterpriseAuth(res, 503, enterpriseSessionPayload(null));
  }
  if (req.method === 'POST') {
    const bearerToken = extractBearerToken(req);
    req.enterpriseCredentialHash = enterpriseCredentialHashFromToken(bearerToken);
    const postPrincipal = await findEnterprisePrincipalFromToken(bearerToken);
    if (!postPrincipal) {
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.auth.session',
        outcome: 'denied',
        status: 401,
        path: '/api/auth/session',
        reason: 'invalid_token',
      });
      clearEnterpriseSessionCookie(res);
      return rejectEnterpriseAuth(res, 401, enterpriseSessionPayload(null));
    }
    if (!enterprisePrincipalInConfiguredOrg(postPrincipal)) {
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.auth.session',
        outcome: 'denied',
        status: 403,
        path: '/api/auth/session',
        reason: 'org_mismatch',
        principal: postPrincipal,
      });
      clearEnterpriseSessionCookie(res);
      return sendJson(res, 403, {
        ...enterpriseSessionPayload(null),
        error: 'Forbidden: this principal is outside the configured organization',
      });
    }
    if (!(await enterprisePrincipalDataRootAllowed(postPrincipal))) {
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.auth.session',
        outcome: 'denied',
        status: 403,
        path: '/api/auth/session',
        reason: 'data_root_boundary',
        principal: postPrincipal,
      });
      clearEnterpriseSessionCookie(res);
      return sendJson(res, 403, {
        ...enterpriseSessionPayload(null),
        error: 'Forbidden: this principal data root is outside the configured boundary',
      });
    }
    if (!setEnterpriseSessionCookie(res, postPrincipal, enterpriseTokenSessionExpiresAt(bearerToken))) {
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.auth.session',
        outcome: 'denied',
        status: 413,
        path: '/api/auth/session',
        reason: 'session_cookie_too_large',
        principal: postPrincipal,
      });
      clearEnterpriseSessionCookie(res);
      return sendJson(res, 413, {
        ok: false,
        authRequired: true,
        authenticated: false,
        configured: true,
        error: 'Enterprise browser session cookie exceeds configured byte limit',
        maxBytes: ENTERPRISE_SESSION_COOKIE_MAX_BYTES,
      });
    }
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'allowed',
      status: 200,
      path: '/api/auth/session',
      reason: 'session_cookie_issued',
      principal: postPrincipal,
    });
    return sendJson(res, 200, enterpriseSessionPayload(postPrincipal));
  }
  const principal = await findEnterprisePrincipal(req);
  if (ENTERPRISE_AUTH_ON && !principal) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'denied',
      status: 401,
      path: '/api/auth/session',
      reason: req.enterpriseAuthFailureReason || 'invalid_token',
    });
    clearEnterpriseSessionCookie(res);
    return rejectEnterpriseAuth(res, 401, enterpriseSessionPayload(null));
  }
  if (ENTERPRISE_AUTH_ON && !enterprisePrincipalInConfiguredOrg(principal)) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'denied',
      status: 403,
      path: '/api/auth/session',
      reason: 'org_mismatch',
      principal,
    });
    return sendJson(res, 403, {
      ...enterpriseSessionPayload(null),
      error: 'Forbidden: this principal is outside the configured organization',
    });
  }
  if (ENTERPRISE_AUTH_ON && !(await enterprisePrincipalDataRootAllowed(principal))) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'denied',
      status: 403,
      path: '/api/auth/session',
      reason: 'data_root_boundary',
      principal,
    });
    return sendJson(res, 403, {
      ...enterpriseSessionPayload(null),
      error: 'Forbidden: this principal data root is outside the configured boundary',
    });
  }
  if (ENTERPRISE_AUTH_ON) {
    appendEnterpriseAuditEvent(req, {
      type: 'enterprise.auth.session',
      outcome: 'allowed',
      status: 200,
      path: '/api/auth/session',
      reason: 'authenticated',
      principal,
    });
  }
  return sendJson(res, 200, enterpriseSessionPayload(principal));
}

async function handleEnterpriseAuditLog(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const limit = parseEnterpriseAuditLimit(req);
  return sendJson(res, 200, {
    events: await readEnterpriseAuditEvents(limit),
    limit,
  });
}

async function handleEnterpriseAuditExport(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const limit = parseEnterpriseAuditLimit(req);
  const events = await readEnterpriseAuditEvents(limit);
  const body = events.map((event) => safeJsonStringify(event)).join('\n');
  const payload = body ? `${body}\n` : '';
  const actualBytes = Buffer.byteLength(payload, 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="enterprise-audit-export.ndjson"'
  );
  res.setHeader('Content-Length', actualBytes);
  res.end(payload);
}

function enterpriseOrganizationPrincipals(req) {
  const principals = ENTERPRISE_PRINCIPALS.filter((record) =>
    enterprisePrincipalInConfiguredOrg(record.principal)
  ).map((record) => enterprisePublicPrincipal(record.principal));
  const current = req.enterprisePrincipal
    ? enterprisePublicPrincipal(req.enterprisePrincipal)
    : null;
  if (!current) return principals;
  const currentKey = `${current.orgId}:${current.userId}`;
  const alreadyListed = principals.some(
    (principal) => `${principal.orgId}:${principal.userId}` === currentKey
  );
  return alreadyListed ? principals : [...principals, current];
}

function enterpriseOrganizationTeams(principals) {
  const teams = new Map();
  for (const principal of principals) {
    const key = principal.teamId || principal.teamName || 'unassigned';
    let team = teams.get(key);
    if (!team) {
      team = {
        teamId: principal.teamId,
        teamName: principal.teamName || principal.teamId || 'Unassigned',
        principalCount: 0,
        adminCount: 0,
        memberCount: 0,
        viewerCount: 0,
        scopedDataRoots: 0,
      };
      teams.set(key, team);
    }
    team.principalCount += 1;
    if (principal.role === 'admin') team.adminCount += 1;
    else if (principal.role === 'viewer') team.viewerCount += 1;
    else team.memberCount += 1;
    if (principal.dataRootConfigured) team.scopedDataRoots += 1;
  }
  return [...teams.values()].sort((a, b) =>
    `${a.teamName}:${a.teamId || ''}`.localeCompare(`${b.teamName}:${b.teamId || ''}`)
  );
}

function enterpriseContributorAliases(principal) {
  const source = 'enterprise principal metadata';
  const aliases = [];
  const add = (kind, value) => {
    const text = boundedEnterpriseText(value);
    if (!text) return;
    if (aliases.some((alias) => alias.kind === kind && alias.value === text)) {
      return;
    }
    aliases.push({ kind, value: text, source });
  };

  // Task owner values are explicit, user-supplied artifact fields. Only map
  // them to principal fields the organization already supplied.
  add('task-owner', principal.userId);
  add('task-owner', principal.email);
  add('username', principal.userId);
  add('session-user', principal.userId);
  add('email', principal.email);
  return aliases;
}

function enterpriseOrganizationIdentityDataset(principals) {
  const contributors = principals
    .map((principal) => {
      const id = boundedEnterpriseText(principal.userId);
      if (!id) return null;
      const teamId = firstNonEmptyString(principal.teamId, principal.teamName);
      const email = boundedEnterpriseText(principal.email);
      return {
        id,
        displayName: firstNonEmptyString(principal.name, principal.userId, principal.email),
        ...(email ? { email } : {}),
        ...(teamId ? { teamIds: [teamId] } : {}),
        aliases: enterpriseContributorAliases(principal),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  const teams = enterpriseOrganizationTeams(principals)
    .map((team) => {
      const id = firstNonEmptyString(team.teamId, team.teamName);
      if (!id) return null;
      return {
        id,
        name: firstNonEmptyString(team.teamName, team.teamId, 'Unassigned'),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    source: 'enterprise principal metadata',
    contributors,
    ...(teams.length ? { teams } : {}),
  };
}

function enterpriseRecommendationIdentity(req) {
  if (!ENTERPRISE_AUTH_ON) return null;
  if (!enterpriseRequestUsesGlobalIngest(req)) return null;
  if (req.enterprisePrincipal?.role !== 'admin') return null;
  return enterpriseOrganizationIdentityDataset(enterpriseOrganizationPrincipals(req));
}

function enterpriseOrganizationIdentityCoverage(principals) {
  const roles = { admin: 0, member: 0, viewer: 0 };
  const teamKeys = new Set();
  const scopedRootTeamKeys = new Set();
  let withEmailAlias = 0;
  let withTeam = 0;
  let withScopedDataRoot = 0;
  let userIdAliases = 0;
  let teamAliases = 0;

  for (const principal of principals) {
    const role = normalizeEnterpriseRole(principal.role);
    roles[role] += 1;
    if (principal.userId) userIdAliases += 1;
    if (principal.email) withEmailAlias += 1;
    const teamKey = principal.teamId || principal.teamName || '';
    if (teamKey) {
      withTeam += 1;
      teamAliases += 1;
      teamKeys.add(teamKey);
      if (principal.dataRootConfigured) scopedRootTeamKeys.add(teamKey);
    }
    if (principal.dataRootConfigured) withScopedDataRoot += 1;
  }

  return {
    source: ENTERPRISE_AUTH_ON
      ? 'enterprise principal metadata'
      : 'single-user local principal',
    contributors: {
      total: principals.length,
      withEmailAlias,
      withTeam,
      withScopedDataRoot,
      roles,
    },
    teams: {
      total: teamKeys.size,
      mappedPrincipals: withTeam,
      unassignedPrincipals: Math.max(0, principals.length - withTeam),
      withScopedDataRoots: scopedRootTeamKeys.size,
    },
    aliases: {
      userId: userIdAliases,
      email: withEmailAlias,
      team: teamAliases,
      total: userIdAliases + withEmailAlias + teamAliases,
    },
    privacy: {
      redacted: true,
      derivedFrom: ['enterprise principal metadata'],
      excludes: [
        'raw bearer tokens',
        'token fingerprints',
        'data roots',
        'raw transcript text',
        'session ids',
        'project paths',
      ],
    },
  };
}

function enterpriseOrganizationPrincipalPage(req, principals) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const limit = parseBoundedSearchInt(
    params,
    'principalLimit',
    ENTERPRISE_ORG_PRINCIPAL_DEFAULT_LIMIT,
    1,
    ENTERPRISE_ORG_PRINCIPAL_MAX_LIMIT
  );
  const offset = parseBoundedSearchInt(
    params,
    'principalOffset',
    0,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const pagePrincipals = principals.slice(offset, offset + limit);
  return {
    principals: pagePrincipals,
    page: {
      total: principals.length,
      limit,
      offset,
      returned: pagePrincipals.length,
    },
  };
}

async function enterpriseOrganizationRollup(req) {
  const ingestState = enterpriseRequestDatasetState(req);
  const ingestApi = await ingestState.apiPromise;
  await refreshReviewEventsForIngest(ingestApi);
  ingestApi.ingest();
  return buildEnterpriseOrganizationRollup(
    ingestApi.assembleDataset(),
    req.enterprisePrincipal ||
      (ENTERPRISE_AUTH_ON ? null : enterpriseSessionPayload(null).principal)
  );
}

function sendEnterpriseOrganizationPayload(res, payload, options = {}) {
  const body = safeJsonStringify(payload);
  const actualBytes = Buffer.byteLength(body, 'utf8');
  if (actualBytes > DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES) {
    return sendJson(res, 413, {
      ok: false,
      error: 'Enterprise organization response exceeds configured byte limit',
      maxBytes: DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES,
      actualBytes,
    });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', actualBytes);
  if (options.downloadFilename) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${options.downloadFilename}"`
    );
  }
  res.end(body);
}

async function handleEnterpriseOrganization(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const principals = enterpriseOrganizationPrincipals(req);
  const principalPage = enterpriseOrganizationPrincipalPage(req, principals);
  const auditEventsForSummary = await readEnterpriseAuditEvents(
    ENTERPRISE_AUDIT_ACTIVITY_SUMMARY_MAX_EVENTS
  );
  const payload = {
    organization: { id: ENTERPRISE_ORG_ID, name: ENTERPRISE_ORG_NAME },
    principals: principalPage.principals,
    principalPage: principalPage.page,
    teams: enterpriseOrganizationTeams(principals),
    identityCoverage: enterpriseOrganizationIdentityCoverage(principals),
    rollup: await enterpriseOrganizationRollup(req),
    securityPosture: enterpriseSecurityPosture(),
    auditActivity: enterpriseAuditActivitySummary(auditEventsForSummary),
    auditEvents: auditEventsForSummary.slice(0, 25),
  };
  return sendEnterpriseOrganizationPayload(res, payload);
}

async function handleEnterpriseReadinessReceipt(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const principals = enterpriseOrganizationPrincipals(req);
  const auditEventsForSummary = await readEnterpriseAuditEvents(
    ENTERPRISE_AUDIT_ACTIVITY_SUMMARY_MAX_EVENTS
  );
  const payload = enterpriseReadinessReceipt({
    rollup: await enterpriseOrganizationRollup(req),
    securityPosture: enterpriseSecurityPosture(),
    identityCoverage: enterpriseOrganizationIdentityCoverage(principals),
    auditActivity: enterpriseAuditActivitySummary(auditEventsForSummary),
    principal: req.enterprisePrincipal,
  });
  return sendEnterpriseOrganizationPayload(res, payload, {
    downloadFilename: 'enterprise-readiness-receipt.json',
  });
}

async function handleEnterpriseOrganizationRollup(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  return sendEnterpriseOrganizationPayload(
    res,
    await enterpriseOrganizationRollup(req)
  );
}

// Route-handler seam for the four dataset-bearing routes (#2076). Each handler
// has the shape (req, res) => Promise<void> and is reached through the
// DATASET_ROUTES map below. The handler bodies are the inlined dispatcher blocks
// verbatim, with the repeated three-line ingest preamble replaced by the shared
// loadIngestedDataset() helper. Behaviour is byte-for-byte unchanged: same
// validation order, same status codes, headers, ETag/compression, and the same
// per-request ingest semantics (search/digest still ingest+assemble per request;
// caching that is issue #1573, layered on top of this seam).

async function handleDatasetJson(req, res) {
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  // Stat-gate (#182): a bounded source signature answers "could anything
  // have changed since the last full ingest?" without re-walking every
  // transcript or touching SQLite. When it matches the signature from
  // the last ingest AND we already hold a built dataset cache, skip ingest()
  // entirely and serve the cache. NOTE: an in-place append to an existing
  // transcript does NOT move this signature (POSIX dir mtime semantics), so
  // it lags until the next structural change — accepted by design; in-flight
  // liveness is the Live Session widget's job (#131). See sourceSignature().
  const sig = ingestApi.sourceSignature();
  if (!ingestState.datasetCache) {
    ingestState.datasetCache = ingestApi.loadLatestDatasetCache();
  }
  const skipped =
    !!ingestState.datasetCache &&
    ingestState.lastSourceSig !== null &&
    sig === ingestState.lastSourceSig;
  let stats = null;
  // On the skip path we reuse the existing compressed dataset, so `cached`
  // (did we reuse the prior compressed build?) is true by construction.
  let cached = true;
  let stale = false;
  let revalidating = false;
  if (!skipped) {
    if (ingestState.datasetCache) {
      // Stale-while-revalidate for the large live dataset: when we have a
      // last-good compressed dataset, return it immediately and refresh the
      // SQLite/content-hash cache after the response. This avoids blocking
      // the UI on a full cold corpus read for every structural source
      // change or process restart. A truly empty install still blocks once
      // because there is no lossless dataset to serve yet.
      stale = true;
      revalidating = !ingestState.datasetRefresh;
      startDatasetRefresh(ingestState, sig);
    } else {
      // Truly cold (no in-memory or disk cache): build once, awaited.
      // Single-flight so concurrent first requests share one async build
      // instead of each kicking off a redundant ingest+compress.
      if (!ingestState.datasetColdBuild) {
        ingestState.datasetColdBuild = rebuildDatasetCache(ingestState, sig).finally(() => {
          ingestState.datasetColdBuild = null;
        });
      }
      try {
        ({ stats, cached } = await ingestState.datasetColdBuild);
      } catch (err) {
        if (isDatasetResponseTooLargeError(err)) {
          return sendDatasetResponseTooLarge(res, err);
        }
        throw err;
      }
    }
  }
  const { etag, json, brBuf, gzBuf } = ingestState.datasetCache;
  res.setHeader('X-Source', 'live');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Conditional revalidation: the client may always re-request, but a
  // matching ETag avoids resending the (large) body. The ETag changes
  // whenever the underlying ~/.claude data changes.
  res.setHeader('Cache-Control', revalidatingLiveCacheControl());
  // X-Ingest is for external verification (perf-probe / curl): `cached`
  // reflects whether we reused the existing compressed dataset (issue
  // #159's contentHash gate), and `skipped` reflects whether the #182
  // stat-gate let us bypass ingest() entirely. On the skip path there is no
  // fresh stats object to report counts from.
  res.setHeader(
    'X-Ingest',
    skipped
      ? 'skipped=true;cached=true'
      : stale
        ? `stale=true;cached=true;revalidating=${revalidating}`
        : `total=${stats.total};reparsed=${stats.reparsed};removed=${stats.removed};transcripts=${stats.transcriptsWritten ?? 0};skippedSessions=${stats.skippedSessions ?? 0};cached=${cached};skipped=false`
  );
  if (etagMatches(req, etag)) {
    res.setHeader('ETag', etag);
    appendVary(res, 'Accept-Encoding');
    res.statusCode = 304;
    res.end();
    return;
  }
  sendBody(req, res, json, {
    etag,
    precompressed: { br: brBuf, gz: gzBuf },
  });
}

async function handleDigest(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const url = new URL(req.url, 'http://localhost');
  const rawDate = url.searchParams.get('date');
  const date = rawDate || todayDigestDate();
  if (!isDailyDigestDate(date)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Invalid date; expected YYYY-MM-DD',
    });
  }
  // useCache:true — this route drives ingest through its own stat-gated cache
  // below (#1573), so the shared preamble must NOT run a per-request ingest().
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  const { value: digest, cache } = await statGatedResponseCache(ingestApi, {
    cacheMap: ingestState.digestCache,
    buildsMap: ingestState.digestBuilds,
    key: digestCacheKey(date),
    max: DASHBOARD_DIGEST_CACHE_MAX_ENTRIES,
    build: (api) => buildDigestPayload(ingestState, api, date),
  });
  res.setHeader('X-Source', 'live');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Digest-Cache', cache);
  return sendJson(res, 200, digest);
}

async function handleSearch(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q') || '';
  const project = url.searchParams.get('project') || undefined;
  const limit = parseBoundedSearchInt(url.searchParams, 'limit', 100, 1, 100);
  if (!q.trim()) {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, {
      mode: 'hybrid',
      semanticAvailable: true,
      results: [],
    });
  }
  // useCache:true — search drives ingest through its own stat-gated per-query
  // cache below (#1573); the shared preamble must NOT run a per-request ingest().
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  const { value: payload, cache } = await statGatedResponseCache(ingestApi, {
    cacheMap: ingestState.searchCache,
    buildsMap: ingestState.searchBuilds,
    key: searchCacheKey(q, project, limit),
    max: DASHBOARD_SEARCH_CACHE_MAX_ENTRIES,
    build: (api) => buildSearchPayload(ingestState, api, q, project, limit),
  });
  res.setHeader('X-Source', 'live');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Search-Cache', cache);
  return sendJson(res, 200, payload);
}

async function handleRecommendationsJson(req, res) {
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  // Server-side mirror of the UI's Recommendations view (#126): the same
  // pure engine (buildRecommendations) over the same assembled dataset, so
  // headless / agent consumers (Aya, P10) get byte-identical recs — stable
  // `id`s and `fix` snippets — without booting a browser. A bounded
  // source-signature cache keeps repeated org/admin traffic from rerunning
  // ingest+assemble work for unchanged data while preserving the old
  // freshness gate for consumers that never call /api/dataset.json.
  const url = new URL(req.url, 'http://localhost');
  const project = url.searchParams.get('project');
  const usesGlobalIngest = enterpriseRequestUsesGlobalIngest(req);
  const emitSuppressionTransitions = usesGlobalIngest && !project;
  const organizationIdentity = enterpriseRecommendationIdentity(req);
  // #2196: only the global ingest path may use the rebuild worker — the worker
  // ingests the main process's global CLAUDE_DIR, not a per-principal scoped
  // dataRoot, so enterprise scoped requests stay on the inline build.
  const allowWorker = usesGlobalIngest;
  let entry;
  let cache;
  let scheduleRefresh = null;
  try {
    ({ entry, cache, scheduleRefresh } = await recommendationsResponseCache(
      ingestState,
      ingestApi,
      project,
      { emitSuppressionTransitions, organizationIdentity, allowWorker }
    ));
  } catch (err) {
    if (isRecommendationsResponseTooLargeError(err)) {
      return sendRecommendationsResponseTooLarge(res, err);
    }
    throw err;
  }
  // Stale-while-revalidate (#2184): kick the (synchronous, multi-second) rebuild
  // only AFTER this response has fully flushed, so serving the stale body stays
  // fast. `finish` fires once res.end()'s bytes are out; if the socket errors
  // first the refresh is skipped (a later request will retry). See
  // recommendationsResponseCache for why setImmediate is insufficient here.
  if (scheduleRefresh) {
    res.once('finish', scheduleRefresh);
    // Backstop: if the client aborts before `finish`, `close` still fires, so
    // the reserved single-flight slot can never leak (its pending promise would
    // otherwise block every future rebuild for this key). The thunk is
    // idempotent, so running on whichever fires first is safe.
    res.once('close', scheduleRefresh);
  }
  // #330: `?project=<path>` narrows recs to that project; absent → global
  // list, byte-identical to pre-#330. The filtered body is a different
  // string per project, so the ETag derived below stays correct per slice.
  // Recs are deterministic in the dataset (no per-request timestamp), so the
  // serialized body is a stable ETag source — If-None-Match 304s work as on
  // the dataset route.
  res.setHeader('X-Source', 'live');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', revalidatingLiveCacheControl());
  res.setHeader('X-Recommendations-Cache', cache);
  if (etagMatches(req, entry.etag)) {
    res.setHeader('ETag', entry.etag);
    appendVary(res, 'Accept-Encoding');
    res.statusCode = 304;
    res.end();
    return;
  }
  // sendBody negotiates brotli/gzip from Accept-Encoding, same as the
  // dataset route (no precompressed buffers — this body is small and live).
  sendBody(req, res, entry.json, { etag: entry.etag });
}

// Pathname -> Handler map for the dataset-bearing routes. The dispatcher does a
// single Map lookup and delegates; each handler resolves its own ingest state
// via loadIngestedDataset() at the same point it did inline, so the validation
// short-circuits in handleDigest/handleSearch still run before any ingest work.
const DATASET_ROUTES = new Map([
  ['/api/dataset.json', handleDatasetJson],
  ['/api/recommendations.json', handleRecommendationsJson],
  ['/api/digest', handleDigest],
  ['/api/search', handleSearch],
]);

const server = createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    res.setHeader('X-Request-Id', enterpriseRequestId(req));
    const pathname = requestPathname(req);
    if (!pathname) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Bad request: malformed request path',
      });
    }

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET or HEAD' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? '' : 'ok\n');
      return;
    }

    const authSessionPath = pathname === '/api/auth/session';
    if (authSessionPath) {
      appendVary(res, 'Authorization');
      appendVary(res, 'Cookie');
      res.setHeader('Cache-Control', 'no-store');
    }
    const enterpriseSensitivePath =
      ENTERPRISE_AUTH_ON && (authSessionPath || isEnterpriseProtectedPath(pathname));
    if (enterpriseSensitivePath) {
      appendVary(res, 'Authorization');
      appendVary(res, 'Cookie');
      res.setHeader('Cache-Control', 'no-store');
    }
    const basicAuthSensitivePath =
      BASIC_AUTH_ON && isBasicAuthSensitivePath(pathname);
    if (BASIC_AUTH_ON) {
      appendVary(res, 'Authorization');
    }
    if (basicAuthSensitivePath) {
      res.setHeader('Cache-Control', 'no-store');
    }

    // Basic-auth gate first, before any route runs (protects every surface when
    // DASHBOARD_USER/DASHBOARD_PASS are configured for a non-loopback bind).
    const allowEnterpriseBearerForBasic =
      enterpriseSensitivePath &&
      (Boolean(extractBearerToken(req)) || Boolean(requestEnterpriseSessionCookie(req)));
    if (!checkBasicAuth(req, { allowEnterpriseBearer: allowEnterpriseBearerForBasic })) {
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Claude Coach", charset="UTF-8"',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('Authentication required.\n');
      return;
    }

    if (pathname === '/api/auth/session') {
      await handleAuthSession(req, res);
      return;
    }

    if (!(await requireEnterpriseAuth(req, res, pathname))) return;

    if (pathname === '/api/enterprise/audit-log') {
      await handleEnterpriseAuditLog(req, res);
      return;
    }

    if (pathname === '/api/enterprise/audit-export.ndjson') {
      await handleEnterpriseAuditExport(req, res);
      return;
    }

    if (pathname === '/api/enterprise/organization') {
      await handleEnterpriseOrganization(req, res);
      return;
    }

    if (pathname === '/api/enterprise/readiness-receipt') {
      await handleEnterpriseReadinessReceipt(req, res);
      return;
    }

    if (pathname === '/api/organization/rollup.json') {
      await handleEnterpriseOrganizationRollup(req, res);
      return;
    }

    // Same-origin CSRF-token bootstrap (#308, #311). The SPA reads this on first
    // load and replays the value as a Bearer/X-CSRF-Token header on the policy
    // write. It's a same-origin GET: a cross-origin attacker page can issue the
    // fetch but the browser won't let it read the JSON body (SOP), so it can't
    // learn the token to forge the mutating request — that, not the peer
    // address, is what protects this. The #311 loopback `remoteAddress` gate was
    // removed here because podman's pasta NAT made the host→container peer the
    // gateway, returning 403 to the legitimate SPA; the host port is bound to
    // loopback instead as the network boundary.
    if (pathname === '/api/csrf-token') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, { token: POLICY_WRITE_TOKEN });
    }

    // Policy write-back (mutating route, #199). POST-only.
    if (pathname === '/api/policy/write') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use POST' });
      }
      return handlePolicyWrite(req, res);
    }

    if (pathname === '/api/adoption/receipts') {
      if (req.method === 'GET') {
        return handleAdoptionReceiptRead(req, res);
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET or POST' });
      }
      return handleAdoptionReceiptWrite(req, res);
    }

    // Session dispatch (#1251, Slice 1): list/create/delete RemoteSession CRs.
    if (pathname === '/api/sessions') {
      if (req.method === 'GET') return handleSessionsList(req, res);
      if (req.method === 'POST') return handleSessionsCreate(req, res);
      return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET or POST' });
    }
    if (pathname.startsWith('/api/sessions/')) {
      // requestPathname() already decoded the URL once; do NOT decodeURIComponent
      // the segment again. A second decode re-expands a double-encoded payload
      // (%252e%252e -> %2e%2e -> ..) and throws on a legit lone '%' (#2065).
      const name = pathname.slice('/api/sessions/'.length);
      if (req.method === 'DELETE') return handleSessionsDelete(req, res, name);
      return sendJson(res, 405, { ok: false, error: 'Method not allowed; use DELETE' });
    }

    // Session-history push-ingest (#1563): the shipper POSTs session artifacts here.
    const ingestMatch = pathname.match(/^\/api\/ingest\/([^/]+)\/artifacts$/);
    if (ingestMatch) {
      if (req.method === 'POST') return handleIngestArtifacts(req, res, ingestMatch[1]);
      return sendJson(res, 405, { ok: false, error: 'Method not allowed; use POST' });
    }

    const datasetRoute = DATASET_ROUTES.get(pathname);
    if (datasetRoute) {
      return datasetRoute(req, res);
    }

    if (pathname === '/api/memories') {
      // Agent memories view (#458). Walk <scoped-root>/projects/<slug>/memory/*.md
      // and return the RAW markdown per file, grouped by project slug, read
      // fresh per request (mirrors the host-coupled, no-ingest routes). The
      // client parser (src/lib/parse-memories.ts) owns the frontmatter parsing.
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      const memories = await readMemories(enterpriseRequestProjectsRoot(req));
      return sendJson(res, 200, memories);
    }

    if (pathname === '/api/workflows') {
      // Workflow Run Ledger (#435). Walk every
      // <scoped-root>/projects/<slug>/<sessionId>/workflows/wf_*.json manifest
      // (written on completion of a Workflow-tool run), project it to the
      // ledger fields, and return runs newest-first. Read fresh per request;
      // the manifest JSON itself is NOT merged into readMergedSession / ingest
      // (those now merge the nested agent-*.jsonl TRANSCRIPTS — #636 — but not
      // this wf_*.json manifest; see REFERENCES.md). Post-hoc ledger, not a
      // live monitor.
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      const workflows = await readWorkflows(enterpriseRequestProjectsRoot(req));
      return sendJson(res, 200, workflows);
    }

    if (pathname === '/api/usage') {
      // Budget Gauge (#130). Server-side OAuth read of the live plan-limit
      // headers. handleUsage degrades to { available:false, reason } and never
      // throws, so the outer try/catch 500 is a belt-and-braces backstop only.
      await handleUsage(req, res);
      return;
    }

    if (pathname === '/api/audit.json') {
      // Tier-3 judge-audit harness (#605/#738), SERVER-ONLY. Degrades exactly
      // like /api/usage: unless explicitly enabled, with no ANTHROPIC_API_KEY,
      // or on ANY error (dataset assembly, judge call), it returns an explicit
      // status with findings at 200, NEVER 500.
      let findings = [];
      const apiKey = process.env.ANTHROPIC_API_KEY || null;
      const disabledReason = !DASHBOARD_ENABLE_SERVER_LLM_AUDITS
        ? 'server_llm_audits_disabled'
        : !SERVER_AUDIT_EGRESS_SCRUB_READY
          ? 'egress_scrub_not_transmission_grade'
          : !apiKey
            ? 'missing_anthropic_api_key'
            : null;
      if (disabledReason) {
        appendEnterpriseAuditEvent(req, {
          type: 'enterprise.llm_audit',
          outcome: 'skipped',
          status: 200,
          path: pathname,
          reason: disabledReason,
          principal: req.enterprisePrincipal,
        });
        sendAuditResponse(req, res, {
          status: 'skipped',
          findings,
          disabled: true,
          reason: disabledReason,
        });
        return;
      }
      appendEnterpriseAuditEvent(req, {
        type: 'enterprise.llm_audit',
        outcome: 'allowed',
        status: 200,
        path: pathname,
        reason: 'server_llm_audits_enabled',
        principal: req.enterprisePrincipal,
      });
      let auditStatus = 'ran';
      let auditReason;
      try {
        const auditChat = ({ model, system, maxTokens, messages }) => {
          const boundedMaxTokens = auditMaxOutputTokens(maxTokens);
          const scrubbed = egressScrub(
            'server.audit-judge',
            {
              model: model || DASHBOARD_AUDIT_MODEL,
              maxTokens: boundedMaxTokens,
              ...(system ? { system } : {}),
              messages,
            },
            {
              logger: (receipt) =>
                appendEnterpriseAuditEvent(req, {
                  type: 'enterprise.llm_egress_scrub',
                  outcome: 'allowed',
                  status: 200,
                  path: pathname,
                  reason: 'egress_scrub_redact',
                  principal: req.enterprisePrincipal,
                  llmUsageId: receipt.registryId,
                  egressScrub: receipt.mode,
                  inputBytes: receipt.inputBytes,
                  outputBytes: receipt.outputBytes,
                }),
            }
          );
          return callAnthropicMessages('server.audit-judge', {
            apiKey,
            model: scrubbed.content.model,
            system: scrubbed.content.system,
            maxTokens: scrubbed.content.maxTokens,
            messages: scrubbed.content.messages,
            scrubReceipt: scrubbed.receipt,
            capChecked: true,
            capReceipt: serverAuditLlmCapReceipt(),
          });
        };
        // Reuse the in-memory uncompressed dataset if a prior /api/dataset.json
        // built it; otherwise assemble once. Cheap relative to the judge calls.
        // The cached `.json` is the SLIMMED wire body (#2107 drops zero-valued
        // tokenData numerics); rehydrate the dropped zeros before the cost
        // mappers run unguarded arithmetic over the entries (else NaN costs). The
        // assembleDataset() fallback is the full in-memory dataset (already full,
        // and rehydrateDataset is a no-op on it).
        const ds = globalDatasetState.datasetCache?.json
          ? rehydrateDataset(JSON.parse(globalDatasetState.datasetCache.json))
          : assembleDataset();
        findings = await runAudits({
          sessions: toAuditSessions(ds),
          agenticSessions: toAgenticSessions(ds),
          skillCandidateSessions: toSkillCandidateSessions(ds),
          boomerangInput: toBoomerangInput(ds),
          naturalExperimentRows: toNaturalExperimentRows(ds),
          startStopRows: toStartStopRows(ds),
          mcpAdoptionInput: toMcpAdoptionInput(ds),
          deceitInput: {
            candidates: toDeceitCandidates(ds),
            getTranscript: getTranscriptText,
          },
          judge: makeClaudeJudge(auditChat, DASHBOARD_AUDIT_MODEL),
          draftJudge: makeClaudeDraftJudge(auditChat, DASHBOARD_AUDIT_MODEL),
          maxJudgeCalls: DASHBOARD_AUDIT_MAX_JUDGE_CALLS,
        });
      } catch (err) {
        console.error('audit compute failed:', err?.message ?? err);
        findings = [];
        auditStatus = 'failed';
        auditReason = 'audit_compute_failed';
        appendEnterpriseAuditEvent(req, {
          type: 'enterprise.llm_audit',
          outcome: 'failed',
          status: 200,
          path: pathname,
          reason: auditReason,
          principal: req.enterprisePrincipal,
        });
      }
      sendAuditResponse(req, res, {
        status: auditStatus,
        ...(auditReason ? { reason: auditReason } : {}),
        findings,
      });
      return;
    }

    if (pathname === '/api/live') {
      // Live Session widget (#131). Reads the active transcript directly off
      // disk (computeLiveSession does the file walk + parse) — deliberately NOT
      // through the dataset's ingest cache, which lags an in-flight session by
      // design (its stat-gate doesn't move on in-place appends; see
      // sourceSignature() in ingest.mjs). The body is tiny and changes every
      // turn, so no ETag/compression bother — just no-store JSON. Returns
      // `{ active: false }` when nothing has an event < 15 min old. The "why"
      // badge (re-read loop / retry storm) is out of scope here, tracked in #196.
      let payload;
      try {
        const ingestApi = await enterpriseRequestIngestApi(req);
        payload = ingestApi.computeLiveSession(Date.now());
      } catch (err) {
        // A malformed/half-written transcript must not 500 the widget poll —
        // degrade to "no active session" so the client just hides the widget.
        console.error('live-session compute failed:', err?.message ?? err);
        payload = { active: false };
      }
      live(res, 'application/json; charset=utf-8');
      sendBody(req, res, JSON.stringify(payload));
      return;
    }

    if (pathname === '/sessions-manifest.json') {
      const manifest = await buildManifest(enterpriseRequestProjectsRoots(req));
      live(res, 'application/json; charset=utf-8');
      res.setHeader('X-Dashboard-Manifest-Limit', String(manifest.limit));
      res.setHeader('X-Dashboard-Manifest-Returned', String(manifest.entries.length));
      if (manifest.truncated) {
        res.setHeader('X-Dashboard-Manifest-Truncated', 'true');
      }
      sendBody(
        req,
        res,
        JSON.stringify(manifest.entries)
      );
      return;
    }

    if (pathname === '/history.jsonl') {
      let body;
      try {
        body = await readTextFileInsideRoot(
          enterpriseRequestClaudeRoot(req),
          'history.jsonl'
        );
      } catch (err) {
        if (isRawFileTooLargeError(err)) {
          return sendRawFileTooLarge(res, err);
        }
        throw err;
      }
      if (body !== null) {
        live(res, 'text/plain; charset=utf-8');
        sendBody(req, res, body);
      } else {
        res.statusCode = 404;
        res.end('');
      }
      return;
    }

    const sourceHistory = pathname.match(/^\/api\/sources\/([^/]+)\/history\.jsonl$/);
    if (sourceHistory) {
      let body;
      const sourceId = sourceHistory[1];
      const sourceRoot = enterpriseRequestSourceClaudeRoot(req, sourceId);
      if (!sourceRoot) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      try {
        body = await readTextFileInsideRoot(sourceRoot, 'history.jsonl');
      } catch (err) {
        if (isRawFileTooLargeError(err)) {
          return sendRawFileTooLarge(res, err);
        }
        throw err;
      }
      if (body !== null) {
        live(res, 'text/plain; charset=utf-8');
        sendBody(req, res, body);
      } else {
        res.statusCode = 404;
        res.end('');
      }
      return;
    }

    const sourceSession = pathname.match(/^\/api\/sources\/([^/]+)\/sessions\/([^/]+)\/([^/]+)$/);
    if (sourceSession) {
      let body;
      const sourceId = sourceSession[1];
      const sourceProjectsRoot = enterpriseRequestSourceProjectsRoot(req, sourceId);
      if (!sourceProjectsRoot) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      try {
        body = await readMergedSession(
          sourceSession[2],
          sourceSession[3],
          sourceProjectsRoot
        );
      } catch (err) {
        if (isRawFileTooLargeError(err)) {
          return sendRawFileTooLarge(res, err);
        }
        if (isRawSessionTooManyPartsError(err)) {
          return sendRawSessionTooManyParts(res, err);
        }
        throw err;
      }
      if (body === null) {
        res.statusCode = 404;
        res.end('');
      } else {
        live(res, 'text/plain; charset=utf-8');
        sendBody(req, res, body);
      }
      return;
    }

    // Lazy transcript endpoints (#205, slice 2 of #181). getTranscript()
    // materializes missing/stale brotli BLOBs on demand, so /api/dataset.json
    // no longer precompresses every transcript during cold ingest. We stream
    // cached BLOBs as-is for `br` clients (precompressed.br) and decompress once
    // for the identity/gzip fallback. ETag is the row's content_hash (a SHA-1
    // over the content + thinking JSON), so any change to either invalidates
    // both endpoints' caches; the thinking ETag carries a `-thinking` suffix so
    // a client can't cross-match a 304 between the two routes.
    // Lazy per-session timeline detail (#1035/#1285). The bulk dataset ships
    // slim timelines (`summary` stripped); this endpoint returns the
    // session's FULL timeline straight from its session_blob row — one SELECT,
    // no re-parse. ETag is the row's content_hash with a `-timeline` suffix so
    // a 304 can't cross-match the transcript endpoints sharing that hash.
    const tTimeline = pathname.match(/^\/api\/session\/([^/]+)\/timeline(?:\.json)?$/);
    if (tTimeline) {
      const ingestApi = await enterpriseRequestIngestApi(req);
      const detail = ingestApi.getSessionTimelineDetail(tTimeline[1]);
      if (!detail) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      const etag = `"${detail.contentHash}-timeline"`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', revalidatingLiveCacheControl());
      if (etagMatches(req, etag)) {
        res.setHeader('ETag', etag);
        appendVary(res, 'Accept-Encoding');
        res.statusCode = 304;
        res.end();
        return;
      }
      sendBody(req, res, detail.json, { etag });
      return;
    }

    // Lazy per-session tool-call detail (#1287). The bulk dataset ships Bash
    // calls with raw `input.command` stripped; this endpoint returns the full
    // session_blob tool row on demand for detail views that need the command
    // body. Same freshness and ETag model as the timeline detail route.
    const tTools = pathname.match(/^\/api\/session\/([^/]+)\/tools(?:\.json)?$/);
    if (tTools) {
      const ingestApi = await enterpriseRequestIngestApi(req);
      const detail = ingestApi.getSessionToolDetail(tTools[1]);
      if (!detail) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      const etag = `"${detail.contentHash}-tools"`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', revalidatingLiveCacheControl());
      if (etagMatches(req, etag)) {
        res.setHeader('ETag', etag);
        appendVary(res, 'Accept-Encoding');
        res.statusCode = 304;
        res.end();
        return;
      }
      sendBody(req, res, detail.json, { etag });
      return;
    }

    const tThinking = pathname.match(/^\/api\/transcript\/([^/]+)\/thinking$/);
    if (tThinking) {
      const ingestApi = await enterpriseRequestIngestApi(req);
      let row;
      try {
        row = ingestApi.getTranscript(tThinking[1]);
      } catch (err) {
        if (isTranscriptTooLargeError(err)) return sendTranscriptTooLarge(res, err);
        throw err;
      }
      if (!row || row.thinkingBr == null) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      const etag = `"${row.contentHash}-thinking"`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', revalidatingLiveCacheControl());
      if (etagMatches(req, etag)) {
        res.setHeader('ETag', etag);
        appendVary(res, 'Accept-Encoding');
        res.statusCode = 304;
        res.end();
        return;
      }
      const br = Buffer.from(row.thinkingBr);
      let body;
      try {
        body = decompressTranscriptBlob(br);
      } catch (err) {
        if (isTranscriptTooLargeError(err)) return sendTranscriptTooLarge(res, err);
        throw err;
      }
      sendBody(req, res, body, { etag, precompressed: { br } });
      return;
    }

    const tContent = pathname.match(/^\/api\/transcript\/([^/]+)$/);
    if (tContent) {
      const ingestApi = await enterpriseRequestIngestApi(req);
      let row;
      try {
        row = ingestApi.getTranscript(tContent[1]);
      } catch (err) {
        if (isTranscriptTooLargeError(err)) return sendTranscriptTooLarge(res, err);
        throw err;
      }
      if (!row || row.contentBr == null) {
        res.statusCode = 404;
        res.end('');
        return;
      }
      const etag = `"${row.contentHash}"`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', revalidatingLiveCacheControl());
      if (etagMatches(req, etag)) {
        res.setHeader('ETag', etag);
        appendVary(res, 'Accept-Encoding');
        res.statusCode = 304;
        res.end();
        return;
      }
      const br = Buffer.from(row.contentBr);
      let body;
      try {
        body = decompressTranscriptContent(row);
      } catch (err) {
        if (isTranscriptTooLargeError(err)) return sendTranscriptTooLarge(res, err);
        throw err;
      }
      sendBody(req, res, body, { etag, precompressed: { br } });
      return;
    }

    const m = pathname.match(/^\/projects\/([^/]+)\/([^/]+)$/);
    if (m) {
      let body;
      try {
        body = await readMergedSession(
          m[1],
          m[2],
          enterpriseRequestProjectsRoots(req)
        );
      } catch (err) {
        if (isRawFileTooLargeError(err)) {
          return sendRawFileTooLarge(res, err);
        }
        if (isRawSessionTooManyPartsError(err)) {
          return sendRawSessionTooManyParts(res, err);
        }
        throw err;
      }
      if (body === null) {
        res.statusCode = 404;
        res.end('');
      } else {
        live(res, 'text/plain; charset=utf-8');
        sendBody(req, res, body);
      }
      return;
    }

    await serveStatic(req, pathname, res);
  } catch (err) {
    res.statusCode = 500;
    res.end('server error');
    console.error(err);
  }
});

server.requestTimeout = DASHBOARD_REQUEST_TIMEOUT_MS;
server.headersTimeout = DASHBOARD_HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = DASHBOARD_KEEP_ALIVE_TIMEOUT_MS;
server.timeout = DASHBOARD_SOCKET_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`Claude History Dashboard live server on http://${HOST}:${PORT}`);
  console.log(`  static: ${DIST}`);
  console.log(`  live data: ${CLAUDE}`);
  console.log(
    `  http timeouts: request=${server.requestTimeout}ms; ` +
      `headers=${server.headersTimeout}ms; ` +
      `keepAlive=${server.keepAliveTimeout}ms; socket=${server.timeout}ms`
  );
  // Flush any adoption receipts the recs hook spooled while we were down (#581).
  // Best-effort and non-blocking — never delay or fail the boot over it.
  drainAdoptionSpoolQuiet(ADOPTION_SPOOL, ADOPTION_RECEIPTS, {
    shadowCallsDir: SHADOW_CALLS_DIR,
  })
    .then((r) => {
      if (r.drained > 0 || r.skipped > 0) {
        console.log(
          `  adoption spool drained: ${r.drained} receipt(s)` +
            (r.skipped > 0 ? `, ${r.skipped} skipped` : '')
        );
      }
    })
    .catch(() => {});
});
