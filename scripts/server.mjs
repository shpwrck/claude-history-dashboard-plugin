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
import { lstat, mkdir, open, opendir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, extname, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  assembleRecommendationDataset,
  assembleRecommendations,
  assembleScopedRecommendationResult,
  loadDatasetCache,
  loadLatestDatasetCache,
  saveDatasetCache,
  sourceSignature,
  stopHookConfigState,
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
  MEMORY_FILE_MAX_BYTES as INGEST_MEMORY_FILE_MAX_BYTES,
  MEMORY_DIR_MAX_ENTRIES as INGEST_MEMORY_DIR_MAX_ENTRIES,
  memoryOpenFlags,
  memoryOpenedPathMatches,
  LIVE_SESSION_MAX_BYTES,
  computeLiveSession,
  recordSuppressionTransitions,
  readRejectedFindingIds,
  readCheckpointAnswerEfficacy,
  refreshReviewEvents,
  refreshDocIssueSnapshotForServer,
  docIssueSnapshotCacheStateForServer,
  docIssueSnapshotCacheStateFromDataset,
  recursiveRemovalSafetyStateForServer,
  recursiveRemovalSafetyStateFromDataset,
  datasetHasTransientDocGraphFailure,
  datasetDocGraphGitWorkingTreeSignature,
  docGraphGitWorkingTreeSignatureForServer,
  docGraphGitWorkingTreeSignatureFromLastSourceGate,
  PROJECT_ROOTS,
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
import {
  resolveStateBoundMemo,
  resolveStatGatedCache,
} from './lib/stat-gated-cache.mjs';
import { readJsonlTailCappedSync } from './lib/host-producer.mjs';

const PROJECT_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const { resolveSources } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'sources.ts')
);
const {
  externalGuidanceCacheValidity,
  externalGuidanceCacheValidityContains,
  externalGuidanceClockTransitions,
} = await import(join(PROJECT_DIR, 'src', 'lib', 'external-guidance.ts'));
const {
  hookOverheadCacheValidity,
  hookOverheadCacheValidityContains,
  hookOverheadConfigState,
} = await import(
  join(PROJECT_DIR, 'src', 'lib', 'detectors', 'speed', 'hook-overhead.ts')
);
const {
  skillHookIntegrityCacheValidity,
  skillHookIntegrityCacheValidityContains,
} = await import(
  join(
    PROJECT_DIR,
    'src',
    'lib',
    'detectors',
    'maintenance',
    'skill-hook-integrity.ts'
  )
);
const {
  editFormatChurnCacheValidity,
  editFormatChurnCacheValidityContains,
} = await import(
  join(PROJECT_DIR, 'src', 'lib', 'detectors', 'cost', 'edit-format-churn.ts')
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
// Experiment-axis evaluator (#2242): the ledger parser + per-axis verdict engine
// live in src/lib/experiments/*.ts so their pure logic is unit-testable without
// booting a server. Imported dynamically (like the .ts parsers) so they resolve
// under the register-ts loader the container launches with.
const { parseEnrollmentLedger } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'experiments', 'enrollment-ledger.ts')
);
const { evaluateExperiments } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'experiments', 'evaluator.ts')
);
// Shadow-calls per-experiment rows (#2152/#2153): the flat ledger read behind
// /api/shadow-experiments.json, pure like the other .ts parsers.
const { parseShadowCallRows } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'shadow-experiments.ts')
);
const { readGate2702ShadowProjection } = await import(
  join(PROJECT_DIR, 'scripts', 'gate-2702', 'shadow-projection.mjs')
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
const { appendRejectSignal } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'reject-signals.ts')
);
const { appendCheckpointAnswer } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'checkpoint-answer-store.ts')
);
const { readSteerTelemetry } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'parse-steer-telemetry.ts')
);
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
// Boot/slice split for the Tier-3 instant-load path (#2443): a tiny boot payload
// (metadata + server-computed aggregates + per-slice counts) and per-heavy-key
// lazy slices, so the client paints from the boot without the ~98 MB monolith.
const { splitDataset, isSliceKey } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'dataset-boot.ts')
);
// Tier-3 instant-load shell (#2444, epic #1852, Layer B): projects the boot payload
// to the above-the-fold shell KPIs and rewrites the served index.html in place so
// deployed users see real numbers at HTML parse. Dependency-free (same
// zero-node_modules class as dataset-boot.ts above), so it is safe under the runtime
// register-ts import guard.
const { deriveBootShell, rewriteServedHtml } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'instant-shell.ts')
);
// Restores the zero-valued tokenData numerics that buildDatasetBody slims out of
// the wire (#2107), for the one server path that re-parses the slimmed cache JSON
// instead of the full in-memory dataset (the LLM-audit route below).
const { rehydrateDataset, slimDataset } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'dataset-slim.ts')
);
// Server LLM calls are registered and enforced through this chokepoint (#931).
const { callAnthropic, callAnthropicMessages, egressScrub } = await import(
  '../src/lib/anthropic-egress.ts'
);
const { getLlmUsageEntry } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'llm-registry.ts')
);
// Tier A "Analyze locally" (#2319, ADR 0018): a LOCAL-model analysis surface over
// the deterministic recommendation call sites. The transport is loopback-pinned
// (local-model-client) so this NEVER egresses to a third-party API, and there is
// no Anthropic fallback wired — an unset/unreachable endpoint degrades to the
// deterministic engine result. NOT the removed "insights" button; never mimics
// the CLI /insights report.
const { callLocalModel, readLocalModelConfig } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'local-model-client.ts')
);
const { runLocalAnalyze, degradedResult, extractRecommendations } =
  await import(join(PROJECT_DIR, 'src', 'lib', 'local-analyze.ts'));
// Tier-3 judge-audit harness (#605/#738) lives in src/lib/audit/judge.ts.
// The route injects a governed chat function rather than letting the audit core
// own network egress, so the SPA bundle and browser client stay decoupled.
const { runAudits, makeClaudeJudge, makeClaudeDraftJudge } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'audit', 'judge.ts')
);
// Single derivation of "when this session's evidence ends", used to date the
// start/stop-oracle rows (#3115, #3392 P2). Lives with the audit that defines
// the contract so the rule has exactly one home and is unit-tested there.
const { deriveObservedAt } = await import(
  join(PROJECT_DIR, 'src', 'lib', 'audit', 'start-stop-oracle.ts')
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
// DIST_DIR lets route tests point at throwaway bundles. CLAUDE_DIR also supports
// those tests. In the ordinary local container neither is set, so these resolve to bundled dist/
// and the bind-mounted ~/.claude.
const DIST = process.env.DIST_DIR || join(PROJECT_DIR, 'dist');
const SHADOW_CALLS_DIR = join(CLAUDE, 'shadow-calls');
// Shadow-calls experiment ledger (#2152): the append-only JSONL the shadow
// engine writes, served row-by-row at /api/shadow-experiments.json. Read live
// per request (like EXPERIMENT_LEDGER below); CLAUDE_SHADOW_CALLS_LEDGER
// overrides the path (tests / custom deploys).
const SHADOW_CALLS_LEDGER =
  process.env.CLAUDE_SHADOW_CALLS_LEDGER || join(SHADOW_CALLS_DIR, 'ledger.jsonl');
const GATE_2702_STATE_ROOT =
  process.env.CHD_EXPERIMENT_2702_STATE_ROOT || join(SHADOW_CALLS_DIR, 'gate-2702');
// Experiment-axis enrollment ledger (#2242): the append-only JSONL the
// `/experiment-enroll` skill writes. Read live like the shadow-calls ledger;
// CLAUDE_EXPERIMENT_LEDGER overrides the path (tests / custom deploys). The
// sibling registry.mjs (read best-effort for axis labels) lives next to it.
const EXPERIMENT_LEDGER =
  process.env.CLAUDE_EXPERIMENT_LEDGER ||
  join(CLAUDE, 'experiments', 'enrollment.jsonl');
const EXPERIMENT_REGISTRY = join(
  dirname(EXPERIMENT_LEDGER),
  'registry.mjs'
);
// All runtime writes below default to CHD_CACHE_DIR so they land outside the
// plugin install dir and survive updates (#1336). Individual *_PATH overrides
// take precedence when explicitly set (test / container / custom-deploy use cases).
const ADOPTION_RECEIPTS =
  process.env.ADOPTION_RECEIPTS_PATH ||
  join(CHD_CACHE_DIR, 'adoption-receipts.jsonl');
// Append-only user reject-signal log (#1294): the capture primitive for the
// recommendation feedback loop. Dashboard-owned data dir; sibling of the
// adoption receipts above.
const REJECT_SIGNALS =
  process.env.REJECT_SIGNALS_PATH ||
  join(CHD_CACHE_DIR, 'reject-signals.jsonl');
// Append-only human checkpoint answer-time instrumentation (#2519). A path
// override supports isolated tests and deployments with a dedicated data mount.
const CHECKPOINT_ANSWERS =
  process.env.CHECKPOINT_ANSWERS_PATH ||
  join(CHD_CACHE_DIR, 'checkpoint-answers.jsonl');
// Read-only PreToolUse-steer delivery/outcome log (#2203). The recs steer hook
// writes ~/.claude/skill-state/recs/pretooluse-steer.jsonl; the pre-#2900 path
// under ~/.claude/skills/recs is read only when the canonical log is absent.
// The dashboard only reads + aggregates it. STEER_TELEMETRY_PATH pins one file.
const STEER_TELEMETRY_LOGS = process.env.STEER_TELEMETRY_PATH
  ? [process.env.STEER_TELEMETRY_PATH]
  : [
      join(CLAUDE, 'skill-state', 'recs', 'pretooluse-steer.jsonl'),
      join(CLAUDE, 'skills', 'recs', '.pretooluse-steer.jsonl'),
    ];
// Dashboard-owned spool the SessionStart recs hook appends to when the server is
// down (#581). Drained into ADOPTION_RECEIPTS on boot. Sibling of the receipts
// log in the same dashboard data dir — NEVER under the install dir.
const ADOPTION_SPOOL =
  process.env.ADOPTION_SPOOL_PATH ||
  join(CHD_CACHE_DIR, 'adoption-spool.jsonl');
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
const DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES = Math.max(
  1,
  Math.min(
    1_000_000,
    parseNonNegativeIntEnv('DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES', 50_000)
  )
);
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
  INGEST_MEMORY_FILE_MAX_BYTES
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
  INGEST_MEMORY_DIR_MAX_ENTRIES
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
    "connect-src 'self'",
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
  return 'no-cache';
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

// Above this many uncompressed bytes, a DYNAMIC (not-precompressed) body is
// compressed through the async zlib path so the brotli/gzip CPU runs on the
// libuv threadpool instead of the request thread (#3103). Below it, a live body
// is small enough that a sync compress is cheaper than the async hop's overhead
// and does not meaningfully stall the loop. 64 KiB: a live-session/manifest
// JSON blob or a small raw file stays sync; a near-limit history/merged-session
// body (up to tens of MiB) no longer blocks the event loop while it compresses.
// The precompressed dataset path is untouched by this — it never compresses at
// request time at all.
const SENDBODY_ASYNC_COMPRESS_BYTES = parseNonNegativeIntEnv(
  'DASHBOARD_SENDBODY_ASYNC_COMPRESS_BYTES',
  65_536
);

// Compress `buf` for `encoding`, using the ASYNC (off-loop) path once the body
// is large enough to be worth moving off the request thread (#3103), and the
// cheap SYNC path for small live bodies. Encoding is already negotiated to
// 'br' | 'gzip'.
async function compressBodyForResponse(buf, encoding, quality) {
  const big = buf.length >= SENDBODY_ASYNC_COMPRESS_BYTES;
  if (encoding === 'br') {
    return big ? await brotliAsync(buf, quality) : brotli(buf, quality);
  }
  return big ? await gzipAsync(buf, { level: 6 }) : gzipSync(buf, { level: 6 });
}

// Send a (possibly large) body, compressing with brotli/gzip when the client
// asks for it. `headers` are applied first so callers can set Content-Type etc.
// Always sets Vary: Accept-Encoding so caches key on the negotiated encoding.
//
// `quality` controls per-request brotli effort (default 5, a cheap level for
// arbitrary live bodies). `precompressed` lets callers hand in already-built
// {br, gz} buffers (e.g. the cached dataset) so we never recompress.
//
// Async (#3103): compressing a large dynamic body synchronously blocked the
// event loop for the whole brotli/gzip pass — a near-limit history or merged
// raw-session body could stall every other in-flight request for hundreds of
// ms. Large dynamic bodies now compress off-loop; the precompressed path stays
// a plain buffer hand-off. Compression never rejects the response: a failed
// compress falls back to sending the body uncompressed (always valid) rather
// than a mislabeled or truncated one, so no caller needs to await or catch.
async function sendBody(req, res, body, { etag, quality = 5, precompressed } = {}) {
  appendVary(res, 'Accept-Encoding');
  if (etag) res.setHeader('ETag', etag);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const encoding = negotiateEncoding(req);
  let out = buf;
  let contentEncoding = null;
  if (encoding === 'br' || encoding === 'gzip') {
    const pre = encoding === 'br' ? precompressed?.br : precompressed?.gz;
    if (pre) {
      out = pre;
      contentEncoding = encoding;
    } else {
      try {
        out = await compressBodyForResponse(buf, encoding, quality);
        contentEncoding = encoding;
      } catch {
        // Serve uncompressed on a compress failure — correctness over ratio.
        out = buf;
        contentEncoding = null;
      }
    }
  }
  // Headers are set AFTER the (possibly awaited) compression so a Content-Encoding
  // is never announced for a body that ended up uncompressed. Nothing has written
  // to the response yet, so late setHeader is safe.
  if (contentEncoding) res.setHeader('Content-Encoding', contentEncoding);
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
  assembleRecommendationDataset,
  assembleRecommendations,
  assembleScopedRecommendationResult,
  loadDatasetCache,
  loadLatestDatasetCache,
  saveDatasetCache,
  sourceSignature,
  stopHookConfigState,
  getTranscript,
  getSessionTimelineDetail,
  getSessionToolDetail,
  computeLiveSession,
  recordSuppressionTransitions,
  readRejectedFindingIds,
  readCheckpointAnswerEfficacy,
  refreshReviewEvents,
  refreshDocIssueSnapshotForServer,
  docIssueSnapshotCacheStateForServer,
  docIssueSnapshotCacheStateFromDataset,
  recursiveRemovalSafetyStateForServer,
  recursiveRemovalSafetyStateFromDataset,
  datasetHasTransientDocGraphFailure,
  datasetDocGraphGitWorkingTreeSignature,
  docGraphGitWorkingTreeSignatureForServer,
  docGraphGitWorkingTreeSignatureFromLastSourceGate,
};

function hasTransientDocGraphFailure(api, dataset) {
  return (
    typeof api.datasetHasTransientDocGraphFailure === 'function' &&
    api.datasetHasTransientDocGraphFailure(dataset)
  );
}

function currentDocGraphGitWorkingTreeSignature(api) {
  return typeof api.docGraphGitWorkingTreeSignatureForServer === 'function'
    ? api.docGraphGitWorkingTreeSignatureForServer()
    : null;
}

function sourceBoundDocGraphGitWorkingTreeSignature(api) {
  return typeof api.docGraphGitWorkingTreeSignatureFromLastSourceGate === 'function'
    ? api.docGraphGitWorkingTreeSignatureFromLastSourceGate()
    : currentDocGraphGitWorkingTreeSignature(api);
}

function builtDocGraphGitWorkingTreeSignature(api, dataset) {
  return typeof api.datasetDocGraphGitWorkingTreeSignature === 'function'
    ? api.datasetDocGraphGitWorkingTreeSignature(dataset)
    : null;
}

function docGraphGitWorkingTreeSignaturesEqual(left, right) {
  return left === null || right === null || left === right;
}

// Cache entries need a stronger contract than compatibility comparisons: when
// the production ingest API can observe Git state, a legacy/unknown token is a
// hard miss and may never flow into stale-while-revalidate.
function datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
  entry,
  api,
  current = currentDocGraphGitWorkingTreeSignature(api)
) {
  if (!entry) return false;
  if (current === null) return true;
  return (
    entry.docGraphGitWorkingTreeSignatureKnown === true &&
    entry.docGraphGitWorkingTreeSignature === current
  );
}

function datasetState(apiPromise, key = 'global') {
  return {
    key,
    apiPromise,
    lastAccess: Date.now(),
    activeRequests: 0,
    closePromise: null,
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
    // Detached stale-while-revalidate builds remain lifecycle-owned even if
    // their bounded LRU map entry is pruned while the work is still running.
    // Allocate the ownership set only when a detached build actually exists.
    detachedBuilds: null,
    recommendationsBuildGeneration: 0,
    // Receipt writes are outside sourceSignature/contentHash. Every reject bumps
    // this epoch so a build that captured older receipt state cannot be joined or
    // committed after cache invalidation.
    recommendationsInvalidationGeneration: 0,
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
    // Boot payload + per-heavy-key slices for the instant-load data plane (#2443),
    // same stat-gated + single-flight machinery as digest/search. The boot map
    // holds one entry; the slice map holds one per opened heavy key.
    bootCache: new Map(),
    bootBuilds: new Map(),
    sliceCache: new Map(),
    sliceBuilds: new Map(),
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
    assembledMemo: null, // state-bound { key: contentHash, value: dataset, sourceState }
    // #2182: separate memo for the lighter recommendation dataset (recs-input
    // fields only), so the recs route doesn't build the full payload and doesn't
    // evict the full-dataset memo the digest/dataset routes reuse.
    assembledRecoMemo: null, // state-bound { key, value: dataset, sourceState }
  };
}

const globalDatasetState = datasetState(Promise.resolve(GLOBAL_INGEST_API));
async function refreshReviewEventsForIngest(ingestApi) {
  if (typeof ingestApi.refreshReviewEvents !== 'function') return null;
  return ingestApi.refreshReviewEvents();
}

// Opt-in GitHub issue-state snapshot refresh (#2710). The ONLY doc-issue network
// call: runs in the async preamble so the subsequent SYNC assembleDataset() read
// sees a fresh cache. No-op when CHD_DOC_ISSUES is unset (default path) or while
// the snapshot is still fresh (single-flight + 15m reuse gate live in ingest).
async function refreshDocIssueSnapshotForIngest(ingestApi) {
  if (typeof ingestApi.refreshDocIssueSnapshotForServer !== 'function') return null;
  return ingestApi.refreshDocIssueSnapshotForServer();
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
  const ingestState = globalDatasetState;
  const ingestApi = await ingestState.apiPromise;
  await refreshReviewEventsForIngest(ingestApi);
  await refreshDocIssueSnapshotForIngest(ingestApi);
  if (!useCache) ingestApi.ingest();
  return { ingestState, ingestApi };
}

function currentDocIssueCacheState(api) {
  if (typeof api.docIssueSnapshotCacheStateForServer !== 'function') return null;
  return api.docIssueSnapshotCacheStateForServer();
}

function currentDatasetTrustState(api) {
  return {
    docIssueCacheState: currentDocIssueCacheState(api),
    docGraphGitWorkingTreeSignature:
      currentDocGraphGitWorkingTreeSignature(api),
  };
}

function sourceBoundDatasetTrustState(api) {
  return {
    docIssueCacheState: currentDocIssueCacheState(api),
    docGraphGitWorkingTreeSignature:
      sourceBoundDocGraphGitWorkingTreeSignature(api),
  };
}

function builtDatasetTrustState(api, dataset) {
  return {
    docIssueCacheState: api.docIssueSnapshotCacheStateFromDataset(dataset),
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, dataset),
  };
}

function datasetTrustStatesEqual(left, right) {
  return (
    docIssueCacheStatesEqual(
      left?.docIssueCacheState ?? null,
      right?.docIssueCacheState ?? null
    ) &&
    docGraphGitWorkingTreeSignaturesEqual(
      left?.docGraphGitWorkingTreeSignature ?? null,
      right?.docGraphGitWorkingTreeSignature ?? null
    )
  );
}

function docIssueCacheStatesEqual(left, right) {
  if (left === null || left === undefined) {
    return right === null || right === undefined;
  }
  if (right === null || right === undefined) return false;
  return (
    left.identity === right.identity &&
    left.usableThrough === right.usableThrough
  );
}

function docIssueCacheStateIsUsable(state, now = Date.now()) {
  return state === null || state === undefined ||
    (Number.isFinite(state.usableThrough) && now <= state.usableThrough);
}

// A persisted/in-memory dataset body may be served only under the exact usable
// issue-snapshot state that produced it. Unknown legacy metadata is accepted
// solely for a body that visibly omits the snapshot while the current state is
// also null; any possible claim-bearing legacy body hard-misses.
function datasetCacheEntryMatchesDocIssueState(entry, api, now = Date.now()) {
  if (!entry) return false;
  const current = currentDocIssueCacheState(api);
  if (!docIssueCacheStateIsUsable(current, now)) return false;
  if (entry.docIssueCacheStateKnown !== true) {
    return (
      current === null &&
      typeof entry.json === 'string' &&
      !entry.json.includes('"docIssueSnapshot":')
    );
  }
  return (
    docIssueCacheStateIsUsable(entry.docIssueCacheState, now) &&
    docIssueCacheStatesEqual(entry.docIssueCacheState, current)
  );
}

function currentRecursiveRemovalSafetyState(api) {
  if (typeof api.recursiveRemovalSafetyStateForServer !== 'function') return null;
  return api.recursiveRemovalSafetyStateForServer();
}

// Canonical containment is a hard cache boundary: stale-while-revalidate must
// never serve a body whose affirmative recursive-removal verdict no longer
// matches the current filesystem path graph. APIs predating this seam retain
// their test/fallback behavior; every production ingest API exports it.
function datasetCacheEntryMatchesRecursiveRemovalSafetyState(entry, api) {
  if (!entry) return false;
  const current = currentRecursiveRemovalSafetyState(api);
  if (current === null) return true;
  return (
    entry.recursiveRemovalSafetyStateKnown === true &&
    entry.recursiveRemovalSafetyState === current
  );
}

async function buildDatasetCache(api, contentHash) {
  const dataset = api.assembleDataset();
  const docGraphRetryRequired = hasTransientDocGraphFailure(api, dataset);
  const docGraphGitWorkingTreeSignature =
    builtDocGraphGitWorkingTreeSignature(api, dataset);
  const docIssueCacheState =
    api.docIssueSnapshotCacheStateFromDataset(dataset);
  const recursiveRemovalSafetyState =
    typeof api.recursiveRemovalSafetyStateFromDataset === 'function'
      ? api.recursiveRemovalSafetyStateFromDataset(dataset)
      : null;
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
  return {
    etag,
    json,
    brBuf,
    gzBuf,
    contentHash,
    docIssueCacheState,
    docIssueCacheStateKnown: true,
    recursiveRemovalSafetyState,
    recursiveRemovalSafetyStateKnown: recursiveRemovalSafetyState !== null,
    docGraphGitWorkingTreeSignature,
    docGraphGitWorkingTreeSignatureKnown:
      typeof docGraphGitWorkingTreeSignature === 'string',
    docGraphRetryRequired,
  };
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
// throwing, mirroring toAgenticSessions.
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
// from the sessions map + the session's OBSERVATION TIMESTAMP (Session.endTime,
// epoch ms, from parse-history.groupBySessions), which the audit needs to date
// its historical correlation "as of <date>" — an undated dataset suppresses the
// finding instead of reading as current state (#3115).
// Sessions with no opener are skipped (no feature to derive). Defensive: any
// failure degrades to [] (no rows -> audit skipped) rather than throwing,
// mirroring toNaturalExperimentRows.
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
    // When each session's evidence ENDS. Derived in ONE place
    // (deriveObservedAt, which takes the latest of the transcript and
    // prompt-history end marks) so no caller reconciles the two: Session.endTime
    // alone marks the last PROMPT, and a session that keeps working after it (an
    // overnight tool run) would outrun it, dating the cutoff earlier than the
    // evidence it names (#3392 P2).
    const observedAtBySession = deriveObservedAt(sessions, timelines);
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
        observedAt: observedAtBySession.get(t.sessionId),
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
//     -> audit skipped), mirroring toStartStopRows.
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
  let buildSig = sig;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A deferred SWR build may start after the request-time signature moved.
    // Re-sample one coherent source/status pair at the actual build boundary.
    buildSig = api.sourceSignature();
    const buildDocIssueState = currentDocIssueCacheState(api);
    const buildDocGraphGitState =
      sourceBoundDocGraphGitWorkingTreeSignature(api);
    const stats = api.ingest(buildSig);
    let candidate = null;
    let cached = false;
    let persist = false;

    if (
      state.datasetCache?.contentHash === stats.contentHash &&
      state.datasetCache.docGraphRetryRequired !== true &&
      datasetCacheEntryMatchesDocIssueState(state.datasetCache, api) &&
      datasetCacheEntryMatchesRecursiveRemovalSafetyState(state.datasetCache, api) &&
      datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
        state.datasetCache,
        api,
        stats.docGraphGitWorkingTreeSignature ?? null
      )
    ) {
      candidate = state.datasetCache;
      cached = true;
    } else {
      const fromDisk = api.loadDatasetCache(stats.contentHash);
      if (
        fromDisk &&
        datasetCacheEntryMatchesDocIssueState(fromDisk, api) &&
        datasetCacheEntryMatchesRecursiveRemovalSafetyState(fromDisk, api) &&
        datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
          fromDisk,
          api,
          stats.docGraphGitWorkingTreeSignature ?? null
        )
      ) {
        candidate = fromDisk;
        cached = true;
      } else {
        candidate = await buildDatasetCache(api, stats.contentHash);
        persist = true;
      }
    }

    // The source can move while ingest/assemble/compression is running. Prefer a
    // candidate built under one stable source+trust state; if only the coarse
    // signature moved, retry once against the completed state. GitHub snapshot
    // and recursive-removal containment claims are HARD gates and never relaxed.
    const completedSig = api.sourceSignature(buildSig);
    const completedDocIssueState = currentDocIssueCacheState(api);
    const completedDocGraphGitState =
      sourceBoundDocGraphGitWorkingTreeSignature(api);
    const docIssueStable =
      docIssueCacheStatesEqual(buildDocIssueState, completedDocIssueState) &&
      datasetCacheEntryMatchesDocIssueState(candidate, api);
    const recursiveRemovalSafetyStable =
      datasetCacheEntryMatchesRecursiveRemovalSafetyState(candidate, api);
    const sigStable = completedSig === buildSig;
    const docGraphGitStateStable =
      docGraphGitWorkingTreeSignaturesEqual(
        buildDocGraphGitState,
        stats.docGraphGitWorkingTreeSignature ?? null
      ) &&
      datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
        candidate,
        api,
        stats.docGraphGitWorkingTreeSignature ?? null
      ) &&
      docGraphGitWorkingTreeSignaturesEqual(
        stats.docGraphGitWorkingTreeSignature ?? null,
        completedDocGraphGitState
      );
    if (!docGraphGitStateStable) {
      // Unlike an acquisition failure, an identity mismatch can be a healthy
      // authoritative graph assembled under B while the request completed at
      // A. Retry once, then fail hard; never serve it even uncached.
      if (attempt === 0) {
        buildSig = completedSig;
        continue;
      }
      throw new Error(
        'Doc-graph Git state changed across the bounded dataset rebuild retry'
      );
    }
    if (candidate.docGraphRetryRequired === true) {
      // Retry the exact acquisition once even though the filesystem signature
      // is unchanged. A second failure may still be served to a truly cold
      // caller as conservative fallback data, but it is never persisted,
      // memoized, or allowed to settle the request-time stat gate. If a last-good
      // dataset exists, retain it for stale-while-revalidate instead.
      if (!docIssueStable || !recursiveRemovalSafetyStable) {
        buildSig = completedSig;
        continue;
      }
      if (attempt === 0) {
        buildSig = completedSig;
        continue;
      }
      if (!state.datasetCache) state.datasetCache = candidate;
      state.lastSourceSig = null;
      return { stats, cached: false };
    }
    // Commit a fully stable candidate; on the FINAL bounded attempt commit the
    // freshest candidate even when only the coarse source signature moved. On a
    // busy multi-agent host, concurrent writers keep bumping the scanned-dir
    // mtimes every few seconds, so the signature never settles across two builds —
    // throwing here froze /api/dataset.json's stale-while-revalidate cache on a
    // days-old blob (#2882, follow-up to #2874). The candidate still corresponds to
    // `stats.contentHash`, so persisting it stays sound. Mark a racy commit
    // UNSETTLED (`lastSourceSig = null`) so the next request re-refreshes instead
    // of skip-serving it, and let a later quiet build record the settled signature.
    if (
      docIssueStable &&
      recursiveRemovalSafetyStable &&
      (sigStable || attempt === 1)
    ) {
      state.datasetCache = candidate;
      if (persist) api.saveDatasetCache(candidate, Date.now());
      state.lastSourceSig = sigStable ? completedSig : null;
      return { stats, cached };
    }

    buildSig = completedSig;
  }
  // Reached only when a hard trust state failed on the final attempt — the
  // GitHub snapshot or recursive-removal containment state moved under us, so
  // serving or persisting the candidate would ship stale claims. Keep last-good
  // rather than a wrong body.
  throw new Error(
    'Dataset trust state changed across the bounded rebuild retry'
  );
}

function startDatasetRefresh(state, sig) {
  if (state.datasetRefresh) return;
  state.datasetRefresh = new Promise((resolve) => {
    setImmediate(() => {
      rebuildDatasetCache(state, sig)
        .catch((err) => {
          console.error('dataset background refresh failed:', err?.message ?? err);
          // #3401 review (Variant B): the failed rebuild may have already run
          // ingest() (COMMIT landed, source state advanced) before the dataset
          // build threw. Leaving lastSourceSig settled would let the next
          // request skip-serve the last-good body as if it were current, so
          // mark the gate UNSETTLED (same idiom as the racy-commit path in
          // rebuildDatasetCache) — every request keeps retrying the refresh
          // until one succeeds and records a genuinely settled signature.
          state.lastSourceSig = null;
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

function recommendationsCacheKey(project, identityKey = 'none', surfaceKey = null) {
  const base = !project
    ? 'global'
    : `project:${createHash('sha1').update(project).digest('hex')}`;
  const withIdentity =
    identityKey === 'none' ? base : `${base}:identity:${identityKey}`;
  // #2718: the typed surface contract folds `surface` + the normalized full
  // filter tuple into a distinct key namespace so scoped bodies can never alias
  // the legacy raw-array body (or each other). Legacy (surfaceKey null) keeps its
  // exact pre-#2718 key, so existing cache/SWR/ETag identity is byte-unchanged.
  return surfaceKey ? `${withIdentity}:${surfaceKey}` : withIdentity;
}

// Stable cache-key fragment for a typed surface request: `surface:<name>:<hash>`
// over the surface plus its canonicalized filter tuple. Distinct surfaces or
// filter tuples hash differently and therefore cannot cross-serve.
function recommendationsSurfaceKey(surfaceRequest) {
  if (!surfaceRequest) return null;
  const hash = createHash('sha1')
    .update(safeJsonStringify({ filters: surfaceRequest.filters }))
    .digest('hex')
    .slice(0, 16);
  return `surface:${surfaceRequest.surface}:${hash}`;
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
  const resolved = resolveStateBoundMemo({
    memo: state.assembledMemo,
    key: contentHash,
    sourceState: currentDatasetTrustState(api),
    sourceStatesEqual: datasetTrustStatesEqual,
    build: () => api.assembleDataset(),
    // Record what the assembled object ACTUALLY observed. If an A -> B -> A
    // file/clock race leaves B under A's content hash, the outer bounded retry
    // sees the mismatch and this memo refuses to replay B on its second pass.
    builtSourceState: (dataset) => builtDatasetTrustState(api, dataset),
  });
  // A thrown bulk doc-history walk is a retryable acquisition failure, not a
  // stable graph state. Never pin that exact dataset under the otherwise healthy
  // contentHash; the next build must call the parser again after Git recovers.
  state.assembledMemo = hasTransientDocGraphFailure(api, resolved.value)
    ? null
    : resolved.memo;
  return resolved.value;
}

// #2182: the recs route's own memoized assemble. Mirrors memoizedAssembleDataset
// but builds the LIGHTER recommendation dataset (recs-input fields only, no
// dataset-only promptAnalysis/embedded-recs/metadata), keyed on the same
// contentHash. Kept in a SEPARATE memo slot from the full dataset (which the
// /api/digest and /api/dataset.json routes still need) so neither evicts the
// other. Shared within one recs request by the suppression emit + recs build
// (#2071), so a single light assemble serves both.
function memoizedAssembleRecommendationDataset(
  state,
  api,
  contentHash
) {
  const hookConfigState = api.stopHookConfigState();
  const resolved = resolveStateBoundMemo({
    memo: state.assembledRecoMemo,
    // The hook bit is independently probed and result-affecting (#2554), so it
    // remains part of this light-dataset memo key alongside the content hash.
    key: JSON.stringify([contentHash, hookConfigState]),
    sourceState: currentDatasetTrustState(api),
    sourceStatesEqual: datasetTrustStatesEqual,
    build: () => api.assembleRecommendationDataset(),
    // As with the full dataset memo, bind reuse to the snapshot state the light
    // dataset actually observed. Otherwise an A -> B -> A retry can replay B
    // forever while the surrounding content hash and hook bit remain A.
    builtSourceState: (dataset) => builtDatasetTrustState(api, dataset),
  });
  state.assembledRecoMemo = hasTransientDocGraphFailure(api, resolved.value)
    ? null
    : resolved.memo;
  return resolved.value;
}

// ── Off-main-thread recommendations rebuild worker (#2196, epic #2181) ───────
// The recs rebuild is multi-second synchronous CPU; running it inline (even
// finish-deferred, #2184) stalls the event loop, so a request landing during a
// rebuild waits behind it. This long-lived worker runs the rebuild on its own
// thread with its OWN SQLite cache (worker-private CHD_DB_PATH), so the main
// loop never blocks. The cold first-build falls back to the inline path. Set CHD_RECS_WORKER=0 to disable and always build inline.
const RECS_WORKER_ENABLED = process.env.CHD_RECS_WORKER !== '0';
const RECS_CACHE_TEST_EVENTS = process.env.CHD_RECS_CACHE_TEST_EVENTS === '1';
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

function requestRecsRebuildViaWorker(
  project,
  organizationIdentity,
  emitSuppressionTransitions,
  surfaceRequest = null
) {
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
        const suppressionEmissionId = v.suppressionEmissionId;
        let dispositionSent = false;
        const sendSuppressionDisposition = (type) => {
          if (dispositionSent || suppressionEmissionId == null) return;
          dispositionSent = true;
          try {
            // Address the worker that produced this result. A replacement
            // worker must never accept an acknowledgement for an old build id.
            w.postMessage({ type, id: suppressionEmissionId });
          } catch {
            // Best-effort lifecycle telemetry must not fail the response.
          }
        };
        resolve({
          ...v,
          acceptSuppressionTransitions: () =>
            sendSuppressionDisposition('accept-suppression-transitions'),
          discardSuppressionTransitions: () =>
            sendSuppressionDisposition('discard-suppression-transitions'),
        });
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
        // #2718: a typed surface request scopes the worker rebuild; absent -> the
        // legacy raw-array rebuild. Filters travel as plain data.
        surface: surfaceRequest?.surface ?? null,
        filters: surfaceRequest?.filters ?? null,
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

function assertRecommendationsResponseSize(json) {
  const actualBytes = Buffer.byteLength(json, 'utf8');
  if (actualBytes <= DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES) return;
  const err = new Error(
    `Recommendations response exceeds ${DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES} byte limit`
  );
  err.code = 'ERR_DASHBOARD_RECOMMENDATIONS_RESPONSE_TOO_LARGE';
  err.maxBytes = DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES;
  err.actualBytes = actualBytes;
  throw err;
}

// External-guidance staleness changes only reference labels. When the wall
// clock crosses a label boundary (forward OR backward), update the already-small
// cached recommendations JSON and ETag synchronously instead of rerunning the
// multi-second ingest/assemble/detector pipeline. Returns false only for an
// entry without usable clock metadata, which the caller treats as a cold miss
// rather than serving a label it cannot prove current.
function redecorateCachedGuidanceLabels(entry, now) {
  if (!Array.isArray(entry.guidanceTransitions)) return false;
  let parsed;
  try {
    parsed = JSON.parse(entry.json);
  } catch {
    return false;
  }
  // The legacy body is a raw Recommendation[]; the #2718 typed surfaces wrap it in
  // { recommendations, domainCoverage }. Relabel the recommendations array either
  // way (it is a reference into `parsed`, so mutating it re-serializes correctly),
  // preserving whichever shape was cached.
  const recommendations = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.recommendations)
      ? parsed.recommendations
      : null;
  if (!recommendations) return false;

  const transitionsByUrl = new Map();
  for (const transition of entry.guidanceTransitions) {
    const hasDetectorTarget =
      typeof transition?.target?.detectorId === 'string' &&
      transition.target.detectorId.length > 0;
    const hasCategoryTarget =
      typeof transition?.target?.category === 'string' &&
      transition.target.category.length > 0;
    if (
      !transition ||
      typeof transition.guidanceId !== 'string' ||
      !transition.target ||
      typeof transition.target !== 'object' ||
      hasDetectorTarget === hasCategoryTarget ||
      typeof transition.url !== 'string' ||
      typeof transition.currentLabel !== 'string' ||
      typeof transition.staleLabel !== 'string' ||
      !Number.isFinite(transition.staleAfter)
    ) {
      return false;
    }
    const matches = transitionsByUrl.get(transition.url) ?? [];
    matches.push(transition);
    transitionsByUrl.set(transition.url, matches);
  }

  let changed = false;
  for (const recommendation of recommendations) {
    if (!Array.isArray(recommendation?.references)) continue;
    for (const reference of recommendation.references) {
      if (!reference || typeof reference.url !== 'string') continue;
      const transition = (transitionsByUrl.get(reference.url) ?? []).find(
        (candidate) =>
          (candidate.target.detectorId
            ? recommendation.id === candidate.target.detectorId
            : recommendation.category === candidate.target.category) &&
          (reference.label === candidate.currentLabel ||
            reference.label === candidate.staleLabel)
      );
      if (!transition) continue;
      const label =
        now > transition.staleAfter
          ? transition.staleLabel
          : transition.currentLabel;
      if (reference.label !== label) {
        reference.label = label;
        changed = true;
      }
    }
  }

  if (changed) {
    const json = safeJsonStringify(parsed);
    assertRecommendationsResponseSize(json);
    entry.json = json;
    entry.etag = datasetEtagFrom(json);
  }
  entry.guidanceCacheValidity = externalGuidanceCacheValidity(
    entry.guidanceTransitions,
    now
  );
  entry.lastAccess = now;
  return true;
}

function recommendationsCacheEntryIsCurrent(entry, api, now) {
  if (
    !docIssueCacheStateIsUsable(entry.docIssueCacheState, now) ||
    !docIssueCacheStatesEqual(
      entry.docIssueCacheState,
      currentDocIssueCacheState(api)
    )
  ) {
    return false;
  }
  if (!datasetCacheEntryMatchesRecursiveRemovalSafetyState(entry, api)) {
    return false;
  }
  if (
    !docGraphGitWorkingTreeSignaturesEqual(
      entry.docGraphGitWorkingTreeSignature ?? null,
      currentDocGraphGitWorkingTreeSignature(api)
    )
  ) {
    return false;
  }
  if (
    !entry.guidanceCacheValidity ||
    !externalGuidanceCacheValidityContains(entry.guidanceCacheValidity, now)
  ) {
    if (!redecorateCachedGuidanceLabels(entry, now)) return false;
  }
  return (
    entry.hookOverheadConfigState === api.stopHookConfigState() &&
    !!entry.hookOverheadCacheValidity &&
    hookOverheadCacheValidityContains(entry.hookOverheadCacheValidity, now) &&
    !!entry.skillHookIntegrityCacheValidity &&
    skillHookIntegrityCacheValidityContains(
      entry.skillHookIntegrityCacheValidity,
      now
    ) &&
    !!entry.editFormatChurnCacheValidity &&
    editFormatChurnCacheValidityContains(entry.editFormatChurnCacheValidity, now)
  );
}

// Worker-backed twin of buildRecommendationsCacheEntry: the rebuild runs off the
// event loop; the main thread only does the cheap size-gate + ETag construction.
// Reuses the request-time `sourceSig` (like the inline path) so the freshness
// gate stays consistent; the worker's content-derived contentHash matches the
// main process's for the same source state (verified path-independent).
async function buildRecommendationsCacheEntryViaWorker(
  state,
  key,
  parentSourceSig,
  project,
  {
    emitSuppressionTransitions = false,
    organizationIdentity = null,
    surfaceRequest = null,
  } = {}
) {
  const workerResult =
    await requestRecsRebuildViaWorker(
      project,
      organizationIdentity,
      emitSuppressionTransitions,
      surfaceRequest
    );
  const {
    json,
    contentHash,
    guidanceTransitions,
    guidanceCacheValidity,
    hookOverheadCacheValidity: hookCacheValidity,
    hookOverheadConfigState: hookConfigState,
    skillHookIntegrityCacheValidity: skillHookCacheValidity,
    editFormatChurnCacheValidity: editChurnCacheValidity,
    sourceSig: workerSourceSig,
    docIssueCacheState,
    recursiveRemovalSafetyState,
    docGraphRetryRequired,
    buildDocGraphGitWorkingTreeSignature,
    docGraphGitWorkingTreeSignature,
    acceptSuppressionTransitions,
    discardSuppressionTransitions,
  } = workerResult;
  try {
    assertRecommendationsResponseSize(json);
  } catch (error) {
    discardSuppressionTransitions();
    throw error;
  }
  const entry = {
    etag: datasetEtagFrom(json),
    json,
    contentHash,
    // Watcher epochs are process-local. The worker proves its own source was
    // stable around ingest/assembly, then the parent binds that accepted result
    // to the parent token sampled for this build. Parent completion re-samples
    // that same namespace, avoiding false perpetual retries after either process
    // observed a workflow event first (#2706).
    sourceSig: workerSourceSig === null ? null : parentSourceSig,
    docIssueCacheState,
    recursiveRemovalSafetyState,
    recursiveRemovalSafetyStateKnown:
      typeof recursiveRemovalSafetyState === 'string',
    docGraphRetryRequired: docGraphRetryRequired === true,
    buildDocGraphGitWorkingTreeSignature:
      buildDocGraphGitWorkingTreeSignature ?? null,
    docGraphGitWorkingTreeSignature:
      docGraphGitWorkingTreeSignature ?? null,
    docGraphGitWorkingTreeSignatureKnown:
      typeof docGraphGitWorkingTreeSignature === 'string',
    guidanceTransitions,
    guidanceCacheValidity,
    hookOverheadCacheValidity: hookCacheValidity,
    hookOverheadConfigState: hookConfigState,
    skillHookIntegrityCacheValidity: skillHookCacheValidity,
    editFormatChurnCacheValidity: editChurnCacheValidity,
    emitAcceptedSuppressionTransitions: acceptSuppressionTransitions,
    discardSuppressionTransitions,
    lastAccess: Date.now(),
  };
  return entry;
}

async function buildRecommendationsCacheEntry(
  state,
  api,
  key,
  sourceSig,
  project,
  {
    emitSuppressionTransitions = false,
    organizationIdentity = null,
    surfaceRequest = null,
  } = {}
) {
  const buildDocGraphGitWorkingTreeSignature =
    currentDocGraphGitWorkingTreeSignature(api);
  const stats = api.ingest(sourceSig);
  // `ingest()` fingerprints settings by bounded stat metadata. Fold the cheap
  // detector-relevant state into this memo key as well: an equal-length rewrite
  // with restored/coarse mtime can still remove the current Stop hook, and that
  // change must force a fresh liveConfig assembly rather than reuse stale data.
  // Assemble once and thread the same dataset into both the suppression emit
  // and the recs build (#2071) — each previously called assembleDataset()
  // independently, doubling the synchronous event-loop stall per request. #2182:
  // this is the recs path, so build only the recs-input fields (lighter than the
  // full /api/dataset.json payload), not the full dataset.
  const dataset = memoizedAssembleRecommendationDataset(
    state,
    api,
    stats.contentHash
  );
  const docGraphRetryRequired = hasTransientDocGraphFailure(api, dataset);
  const docIssueCacheState =
    api.docIssueSnapshotCacheStateFromDataset(dataset);
  const recursiveRemovalSafetyState =
    typeof api.recursiveRemovalSafetyStateFromDataset === 'function'
      ? api.recursiveRemovalSafetyStateFromDataset(dataset)
      : null;
  // Pin one clock instant across label rendering and its cache metadata. A
  // request that finishes after the interval changes is redecorated before it
  // is returned below, so even a boundary crossed mid-build cannot leak.
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
  // Defer the side effect until the post-build source/clock gates accept this
  // exact entry. A discarded racy attempt must never write lifecycle receipts.
  const emitAcceptedSuppressionTransitions = emitSuppressionTransitions
    ? () => {
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
    : null;
  // User-reject suppression (#2206): read the active REJECTED receipts and drop
  // those findings from output. Best-effort like the rest of the route's receipt
  // I/O — a read failure yields an empty set (no suppression), never a 500.
  const rejectedFindingIds = await api.readRejectedFindingIds(ADOPTION_RECEIPTS);
  // #2718: a typed surface request returns the { recommendations, domainCoverage }
  // envelope scoped by its filters (masthead-then-route), suppressing rejected
  // findings on both surfaces; the legacy path returns the raw Recommendation[].
  const recs = surfaceRequest
    ? api.assembleScopedRecommendationResult(
        surfaceRequest.surface,
        surfaceRequest.filters,
        {
          organizationIdentity,
          dataset,
          rejectedFindingIds,
          now: guidanceBuiltAt,
        }
      )
    : api.assembleRecommendations(project || undefined, {
        organizationIdentity,
        dataset,
        rejectedFindingIds,
        now: guidanceBuiltAt,
      });
  const json = safeJsonStringify(recs); // scrub lone surrogates so the export stays strict-parser-valid (#1104)
  assertRecommendationsResponseSize(json);
  const entry = {
    etag: datasetEtagFrom(json),
    json,
    contentHash: stats.contentHash,
    sourceSig,
    docIssueCacheState,
    recursiveRemovalSafetyState,
    recursiveRemovalSafetyStateKnown: recursiveRemovalSafetyState !== null,
    guidanceTransitions,
    guidanceCacheValidity,
    hookOverheadCacheValidity: hookCacheValidity,
    hookOverheadConfigState: hookConfigState,
    skillHookIntegrityCacheValidity: skillHookCacheValidity,
    editFormatChurnCacheValidity: editChurnCacheValidity,
    docGraphRetryRequired,
    buildDocGraphGitWorkingTreeSignature,
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, dataset),
    docGraphGitWorkingTreeSignatureKnown:
      typeof builtDocGraphGitWorkingTreeSignature(api, dataset) === 'string',
    emitAcceptedSuppressionTransitions,
    lastAccess: Date.now(),
  };
  return entry;
}

function commitRecommendationsCacheEntry(state, key, entry, buildOwner) {
  if (entry.docGraphRetryRequired === true) {
    discardRecommendationsCacheEntry(entry);
    return entry;
  }
  const emitAcceptedSuppressionTransitions =
    entry.emitAcceptedSuppressionTransitions;
  delete entry.emitAcceptedSuppressionTransitions;
  delete entry.discardSuppressionTransitions;
  entry.buildGeneration = buildOwner.generation;
  state.recommendationsCache.set(key, entry);
  pruneRecommendationsCache(state);
  emitAcceptedSuppressionTransitions?.();
  return entry;
}

function discardRecommendationsCacheEntry(entry) {
  if (!entry) return;
  const discardSuppressionTransitions = entry.discardSuppressionTransitions;
  delete entry.emitAcceptedSuppressionTransitions;
  delete entry.discardSuppressionTransitions;
  discardSuppressionTransitions?.();
}

function newerRecommendationsResult(state, key, buildOwner) {
  const currentBuild = state.recommendationsBuilds.get(key);
  if (currentBuild && currentBuild !== buildOwner) {
    return currentBuild.promise;
  }
  const cached = state.recommendationsCache.get(key);
  if (
    !currentBuild &&
    Number.isFinite(cached?.buildGeneration) &&
    cached.buildGeneration > buildOwner.generation
  ) {
    return Promise.resolve(cached);
  }
  return null;
}

async function ensureCurrentRecommendationsCacheEntry(
  state,
  api,
  key,
  buildOwner,
  entry,
  retryBuild
) {
  let clockConfigRetriesRemaining = 1;
  let sourceRetriesRemaining = 1;
  let docGraphRetriesRemaining = 1;
  for (;;) {
    let newer = newerRecommendationsResult(state, key, buildOwner);
    if (newer) {
      if (
        RECS_CACHE_TEST_EVENTS &&
        buildOwner.invalidationGeneration !==
          state.recommendationsInvalidationGeneration
      ) {
        console.log('[recs-cache-test] invalidated-build-superseded');
      }
      discardRecommendationsCacheEntry(entry);
      return newer;
    }

    if (
      buildOwner.invalidationGeneration !==
      state.recommendationsInvalidationGeneration
    ) {
      // A reject receipt landed after this build read suppression state. If a
      // post-invalidation request already owns the key, share that newer result.
      // Otherwise retain this owner and rebuild against the new receipt epoch.
      // Recheck after every await so repeated receipt writes cannot let an old
      // body commit. The cold requester (if any) therefore receives corrected
      // output rather than a transient 500.
      const currentBuild = state.recommendationsBuilds.get(key);
      if (currentBuild && currentBuild !== buildOwner) {
        discardRecommendationsCacheEntry(entry);
        return currentBuild.promise;
      }
      if (!currentBuild) {
        state.recommendationsBuilds.set(key, buildOwner);
        pruneRecommendationsBuilds(state);
      }
      buildOwner.invalidationGeneration =
        state.recommendationsInvalidationGeneration;
      const retrySourceSig = api.sourceSignature();
      buildOwner.sourceSig = retrySourceSig;
      discardRecommendationsCacheEntry(entry);
      entry = await retryBuild(retrySourceSig);
      clockConfigRetriesRemaining = 1;
      sourceRetriesRemaining = 1;
      continue;
    }

    const completedSourceSig = api.sourceSignature(entry.sourceSig);
    const completedDocIssueState = currentDocIssueCacheState(api);
    const completedDocGraphGitWorkingTreeSignature =
      sourceBoundDocGraphGitWorkingTreeSignature(api);
    const sourceSigStable = entry.sourceSig === completedSourceSig;
    const docIssueStateStable = docIssueCacheStatesEqual(
      entry.docIssueCacheState,
      completedDocIssueState
    );
    const recursiveRemovalSafetyStateStable =
      datasetCacheEntryMatchesRecursiveRemovalSafetyState(entry, api);
    const docGraphGitWorkingTreeStateStable =
      docGraphGitWorkingTreeSignaturesEqual(
        entry.buildDocGraphGitWorkingTreeSignature ?? null,
        entry.docGraphGitWorkingTreeSignature ?? null
      ) &&
      docGraphGitWorkingTreeSignaturesEqual(
        entry.docGraphGitWorkingTreeSignature ?? null,
        completedDocGraphGitWorkingTreeSignature
      );
    if (!docGraphGitWorkingTreeStateStable) {
      if (docGraphRetriesRemaining <= 0) {
        discardRecommendationsCacheEntry(entry);
        throw new Error(
          'Doc-graph Git state changed across the bounded recommendation rebuild retry'
        );
      }
      docGraphRetriesRemaining -= 1;
      const currentBuild = state.recommendationsBuilds.get(key);
      if (currentBuild && currentBuild !== buildOwner) {
        discardRecommendationsCacheEntry(entry);
        return currentBuild.promise;
      }
      const retrySourceSig = api.sourceSignature();
      if (currentBuild === buildOwner) buildOwner.sourceSig = retrySourceSig;
      discardRecommendationsCacheEntry(entry);
      entry = await retryBuild(retrySourceSig);
      clockConfigRetriesRemaining = 1;
      sourceRetriesRemaining = 1;
      continue;
    }
    if (
      !sourceSigStable ||
      !docIssueStateStable ||
      !recursiveRemovalSafetyStateStable
    ) {
      if (sourceRetriesRemaining <= 0) {
        if (!docIssueStateStable || !recursiveRemovalSafetyStateStable) {
          discardRecommendationsCacheEntry(entry);
          throw new Error(
            'Recommendation source state changed across the bounded rebuild retry'
          );
        }
        // Only the coarse source signature kept moving. The candidate's exact
        // document-issue and recursive-removal trust states are current, so
        // serve the freshest build instead of freezing the cache on an older
        // body. Mark it unsettled so the next request cannot early-hit a
        // signature the built dataset did not observe; its contentHash gate
        // will restamp an identical value or schedule the ordinary SWR refresh.
        entry.sourceSig = null;
      } else {
        sourceRetriesRemaining -= 1;
        const currentBuild = state.recommendationsBuilds.get(key);
        if (currentBuild && currentBuild !== buildOwner) {
          discardRecommendationsCacheEntry(entry);
          return currentBuild.promise;
        }
        if (currentBuild === buildOwner) {
          buildOwner.sourceSig = completedSourceSig;
        }
        discardRecommendationsCacheEntry(entry);
        entry = await retryBuild(completedSourceSig);
        clockConfigRetriesRemaining = 1;
        continue;
      }
    }

    const entryIsCurrent = recommendationsCacheEntryIsCurrent(
      entry,
      api,
      Date.now()
    );
    if (entryIsCurrent && entry.docGraphRetryRequired === true) {
      if (docGraphRetriesRemaining <= 0) {
        // Serve the second conservative fallback to a cold caller, but do not
        // cache it or emit suppression-transition side effects. All hard trust
        // and clock/config gates above have passed; only the transient doc walk
        // remains unsettled, so the next request retries it under the same stats.
        entry.sourceSig = null;
        discardRecommendationsCacheEntry(entry);
        return entry;
      }
      docGraphRetriesRemaining -= 1;
      const currentBuild = state.recommendationsBuilds.get(key);
      if (currentBuild && currentBuild !== buildOwner) {
        discardRecommendationsCacheEntry(entry);
        return currentBuild.promise;
      }
      const retrySourceSig = api.sourceSignature();
      if (currentBuild === buildOwner) buildOwner.sourceSig = retrySourceSig;
      discardRecommendationsCacheEntry(entry);
      entry = await retryBuild(retrySourceSig);
      clockConfigRetriesRemaining = 1;
      sourceRetriesRemaining = 1;
      continue;
    }

    if (entryIsCurrent) {
      newer = newerRecommendationsResult(state, key, buildOwner);
      if (newer) {
        discardRecommendationsCacheEntry(entry);
        return newer;
      }
      return commitRecommendationsCacheEntry(state, key, entry, buildOwner);
    }

    if (clockConfigRetriesRemaining <= 0) {
      discardRecommendationsCacheEntry(entry);
      throw new Error(
        'Recommendation clock/config metadata changed across the bounded rebuild retry'
      );
    }
    clockConfigRetriesRemaining -= 1;

    // A cold build can span a clock/config boundary. Rebuild once against the
    // completed state instead of returning a stale body. The owner token keeps an
    // overtaken build from deleting/restamping a newer build or cache entry.
    const retrySourceSig = api.sourceSignature();
    const currentBuild = state.recommendationsBuilds.get(key);
    if (currentBuild && currentBuild !== buildOwner) {
      discardRecommendationsCacheEntry(entry);
      return currentBuild.promise;
    }
    if (currentBuild === buildOwner) buildOwner.sourceSig = retrySourceSig;
    discardRecommendationsCacheEntry(entry);
    entry = await retryBuild(retrySourceSig);
  }
}

async function recommendationsResponseCache(
  state,
  api,
  project,
  {
    emitSuppressionTransitions = false,
    organizationIdentity = null,
    allowWorker = false,
    surfaceRequest = null,
  } = {}
) {
  const sourceSig = api.sourceSignature();
  const sourceDocGraphGitWorkingTreeSignature =
    sourceBoundDocGraphGitWorkingTreeSignature(api);
  const identityKey = recommendationIdentityCacheKey(organizationIdentity);
  // #2718: the surface + normalized filter tuple partitions the cache so scoped
  // bodies never alias the legacy raw array (or each other); null keeps the
  // legacy key byte-identical.
  const surfaceKey = recommendationsSurfaceKey(surfaceRequest);
  const key = recommendationsCacheKey(project, identityKey, surfaceKey);
  const inlineBuild = (buildSourceSig) =>
    buildRecommendationsCacheEntry(
      state,
      api,
      key,
      buildSourceSig,
      project,
      { emitSuppressionTransitions, organizationIdentity, surfaceRequest }
    );
  const refreshBuild = (buildSourceSig) => {
    if (!allowWorker || !RECS_WORKER_ENABLED) return inlineBuild(buildSourceSig);
    return buildRecommendationsCacheEntryViaWorker(
      state,
      key,
      buildSourceSig,
      project,
      { emitSuppressionTransitions, organizationIdentity, surfaceRequest }
    ).catch((err) => {
      if (isRecommendationsResponseTooLargeError(err)) throw err;
      console.warn(
        '[recs-worker] rebuild failed, falling back to inline:',
        err?.message || err
      );
      return inlineBuild(buildSourceSig);
    });
  };
  let cached = state.recommendationsCache.get(key);
  const now = Date.now();
  const currentHookConfigState = api.stopHookConfigState();
  let clockRefreshed = false;
  if (
    cached &&
    (!docIssueCacheStateIsUsable(cached.docIssueCacheState, now) ||
      !docIssueCacheStatesEqual(
        cached.docIssueCacheState,
        currentDocIssueCacheState(api)
      ))
  ) {
    // Issue-state mismatch/expiry can add or remove an auditable claim. It is a
    // hard miss: never take content-restamp or stale-while-revalidate paths.
    state.recommendationsCache.delete(key);
    cached = undefined;
  }
  if (
    cached &&
    !datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
      cached,
      api,
      sourceDocGraphGitWorkingTreeSignature
    )
  ) {
    // A clean/dirty or index-flag transition changes whether doc freshness is
    // authoritative. Never serve that recommendation body through SWR.
    state.recommendationsCache.delete(key);
    cached = undefined;
  }
  if (
    cached &&
    !datasetCacheEntryMatchesRecursiveRemovalSafetyState(cached, api)
  ) {
    // A canonical-containment mismatch can turn a safe manual fallback into an
    // unsafe cached rm -rf (or vice versa). It is a hard miss: never content-
    // restamp or SWR-serve a recommendation body under a different path graph.
    state.recommendationsCache.delete(key);
    cached = undefined;
  }
  if (
    cached &&
    (cached.hookOverheadConfigState !== currentHookConfigState ||
      !cached.hookOverheadCacheValidity ||
      !hookOverheadCacheValidityContains(
        cached.hookOverheadCacheValidity,
        now
      ) ||
      !cached.skillHookIntegrityCacheValidity ||
      !skillHookIntegrityCacheValidityContains(
        cached.skillHookIntegrityCacheValidity,
        now
      ) ||
      !cached.editFormatChurnCacheValidity ||
      !editFormatChurnCacheValidityContains(
        cached.editFormatChurnCacheValidity,
        now
      ))
  ) {
    // Unlike a guidance label, current Stop-hook state, an event entering /
    // leaving the four-week window, or hook-path / edit-churn evidence crossing
    // its freshness boundary can add, remove, or rewrite a whole finding. Never
    // serve that cached body stale; force the ordinary cold rebuild even when
    // source/content signatures would otherwise permit SWR.
    state.recommendationsCache.delete(key);
    cached = undefined;
  }
  if (
    cached &&
    (!cached.guidanceCacheValidity ||
      !externalGuidanceCacheValidityContains(
        cached.guidanceCacheValidity,
        now
      ))
  ) {
    if (redecorateCachedGuidanceLabels(cached, now)) {
      clockRefreshed = true;
    } else {
      // Never return an entry whose time-sensitive labels cannot be validated.
      // Dropping it turns this request into the ordinary synchronous cold path.
      state.recommendationsCache.delete(key);
      cached = undefined;
    }
  }
  if (
    cached &&
    cached.sourceSig === sourceSig &&
    docGraphGitWorkingTreeSignaturesEqual(
      cached.docGraphGitWorkingTreeSignature ?? null,
      sourceDocGraphGitWorkingTreeSignature
    )
  ) {
    cached.lastAccess = Date.now();
    return { entry: cached, cache: clockRefreshed ? 'hit-time' : 'hit' };
  }
  // Content-hash gate (parity with the dataset route's #182 stat-gate). The
  // sourceSignature() above is a CHEAP mtime fingerprint that an active agent
  // session trips on nearly every request (each transcript write bumps the
  // project-dir mtime). While the entry's time-sensitive external-guidance
  // labels remain valid, the recommendation BODY only changes when the ingested
  // CONTENT changes. ingest() is incremental (~200ms warm), so when it reports
  // the same contentHash the cached recs are byte-identical: restamp the entry's
  // signature and serve it as a hit, skipping the multi-second assemble+detector
  // rebuild entirely. This is what keeps the dataset route at ~0.4s under the
  // same churn while the un-gated recs route paid the full recompute every
  // request (#2184).
  if (cached) {
    const stats = api.ingest(sourceSig);
    const completedSourceSig = api.sourceSignature(sourceSig);
    const completedDocGraphGitWorkingTreeSignature =
      sourceBoundDocGraphGitWorkingTreeSignature(api);
    if (
      stats.contentHash === cached.contentHash &&
      sourceSig === completedSourceSig &&
      docGraphGitWorkingTreeSignaturesEqual(
        sourceDocGraphGitWorkingTreeSignature,
        stats.docGraphGitWorkingTreeSignature ?? null
      ) &&
      docGraphGitWorkingTreeSignaturesEqual(
        stats.docGraphGitWorkingTreeSignature ?? null,
        completedDocGraphGitWorkingTreeSignature
      )
    ) {
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
    const buildOwner = {
      generation: ++state.recommendationsBuildGeneration,
      invalidationGeneration: state.recommendationsInvalidationGeneration,
      sourceSig,
      promise: null,
      lastAccess: Date.now(),
    };
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }).finally(() => {
      const current = state.recommendationsBuilds.get(key);
      if (current === buildOwner) {
        state.recommendationsBuilds.delete(key);
      }
    });
    buildOwner.promise = promise;
    // perf-index-contract: detached-recommendation-build-ownership always-consumed: every allocation immediately records this build and its settlement callback removes that same promise
    state.detachedBuilds ??= new Set();
    state.detachedBuilds.add(promise);
    promise.then(
      () => state.detachedBuilds.delete(promise),
      () => state.detachedBuilds.delete(promise)
    );
    // Mark the reserved promise handled so a failed background rebuild never
    // becomes an unhandled rejection (the cold path below awaits its own build
    // and still surfaces errors through the route try/catch).
    promise.catch(() => {});
    state.recommendationsBuilds.set(key, buildOwner);
    pruneRecommendationsBuilds(state);
    let fired = false;
    const scheduleRefresh = () => {
      if (fired) return;
      fired = true;
      // #2196: on the global ingest path, run the rebuild on the worker thread
      // so the event loop never blocks (even concurrent requests during the
      // rebuild stay fast). Fall back to the inline finish-deferred build
      // (#2184) when the worker is disabled/unavailable or dies mid-rebuild — a
      // 413 size cap is a real result, not a worker failure, so it is NOT
      // retried inline.
      const rawBuild = refreshBuild(sourceSig);
      // The reserved recommendationsBuilds promise covers both the worker or
      // inline build and this post-build validation/retry. If current config or
      // event-window membership changes while SWR is in flight, a cold waiter
      // therefore shares the corrected result instead of receiving the raw
      // pre-boundary entry.
      const build = rawBuild.then((entry) =>
        ensureCurrentRecommendationsCacheEntry(
          state,
          api,
          key,
          buildOwner,
          entry,
          refreshBuild
        )
      );
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
  // only blocking path, and only on the very first request for a key. #2718: a
  // scoped surface uses the worker here too (refreshBuild -> worker on the global
  // ingest path, inline fallback otherwise) so no scoped cold miss is stuck on a
  // synchronous-only build; the legacy path keeps its exact inline cold build.
  const coldBuild = surfaceRequest ? refreshBuild : inlineBuild;
  let build = state.recommendationsBuilds.get(key);
  if (
    !build ||
    build.sourceSig !== sourceSig ||
    build.invalidationGeneration !== state.recommendationsInvalidationGeneration
  ) {
    const buildOwner = {
      generation: ++state.recommendationsBuildGeneration,
      invalidationGeneration: state.recommendationsInvalidationGeneration,
      sourceSig,
      promise: null,
      lastAccess: Date.now(),
    };
    const promise = coldBuild(sourceSig)
      .then((entry) =>
        ensureCurrentRecommendationsCacheEntry(
          state,
          api,
          key,
          buildOwner,
          entry,
          coldBuild
        )
      )
      .finally(() => {
        const current = state.recommendationsBuilds.get(key);
        if (current === buildOwner) {
          state.recommendationsBuilds.delete(key);
        }
      });
    buildOwner.promise = promise;
    build = buildOwner;
    state.recommendationsBuilds.set(key, buildOwner);
    pruneRecommendationsBuilds(state);
  } else {
    build.lastAccess = Date.now();
    if (RECS_CACHE_TEST_EVENTS) {
      console.log('[recs-cache-test] joined-existing-build');
    }
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
async function statGatedResponseCache(api, { cacheMap, buildsMap, key, max, build }) {
  const resolved = await resolveStatGatedCache({
    sourceSignature: (expectedSourceSig) =>
      api.sourceSignature(expectedSourceSig),
    sourceState: () => sourceBoundDatasetTrustState(api),
    builtSourceState: (built) => ({
      docIssueCacheState: built.docIssueCacheState,
      docGraphGitWorkingTreeSignature:
        built.docGraphGitWorkingTreeSignature ?? null,
    }),
    sourceStatesEqual: datasetTrustStatesEqual,
    cacheable: (built) => built.docGraphRetryRequired !== true,
    cacheMap,
    buildsMap,
    key,
    max,
    build,
    buildArgs: [api],
  });
  return {
    value: resolved.value.value,
    cache: resolved.cache,
    ...(resolved.value.instantShell
      ? { instantShell: resolved.value.instantShell }
      : {}),
  };
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
function buildDigestPayload(state, api, date, sourceSig) {
  const stats = api.ingest(sourceSig);
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  return {
    value: buildDailyDigest(
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
    ),
    docIssueCacheState: api.docIssueSnapshotCacheStateFromDataset(ds),
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, ds),
    docGraphRetryRequired: hasTransientDocGraphFailure(api, ds),
  };
}

// Serialize + precompress a JSON body once per content-change (#2443). Returned
// value is cached by the stat-gate, so the (potentially multi-MB) compression
// runs once per corpus change, not per request. brotli/gzip go async on the
// libuv threadpool — a heavy slice (timelines is multi-MB) must NOT block the
// event loop, exactly as buildDatasetCache does for the monolith (#1015).
// `version` is the dataset contentHash, echoed to the client so boot + slices
// are never mixed across a content change.
async function compressedPayload(value, version) {
  const json = safeJsonStringify(value);
  // Same response-size safety valve buildDatasetCache applies to the monolith:
  // measure the serialized length BEFORE materializing the Buffer / compressing,
  // so a single oversized slice (or a low DASHBOARD_DATASET_RESPONSE_MAX_BYTES)
  // returns 413 instead of dominating request/process memory (#2443 review).
  const responseBytes = Buffer.byteLength(json);
  if (responseBytes > DATASET_RESPONSE_MAX_BYTES) {
    const err = new Error(`Dataset response exceeds ${DATASET_RESPONSE_MAX_BYTES} byte limit`);
    err.code = 'DATASET_RESPONSE_TOO_LARGE';
    err.maxBytes = DATASET_RESPONSE_MAX_BYTES;
    err.actualBytes = responseBytes;
    throw err;
  }
  const buf = Buffer.from(json);
  const [brBuf, gzBuf] = await Promise.all([
    brotliAsync(buf, DATASET_BROTLI_QUALITY),
    gzipAsync(buf, { level: 6 }),
  ]);
  return { json, etag: datasetEtagFrom(json), brBuf, gzBuf, version };
}

// Build the /api/dataset/boot payload: the tiny metadata + aggregates + counts
// half of the split (the ~98 MB heavy slices are dropped). Reuses the assembled
// dataset per contentHash (#2071) so it shares the recs/dataset assembly.
// #2444 (Tier-3 instant-load shell): the above-the-fold shell projection derived
// from the most recent GLOBAL boot build. serveStatic() reads this to upgrade the
// build-time skeleton index.html to real KPIs WITHOUT itself triggering a dataset
// assemble (that work would block the event loop on the HTML critical path). It is
// populated only for globalDatasetState below. null until the first boot build.
let lastInstantShell = null;

async function buildBootPayload(state, api, sourceSig) {
  const stats = api.ingest(sourceSig);
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  const boot = splitDataset(ds).boot;
  boot.version = stats.contentHash;
  return {
    value: await compressedPayload(boot, stats.contentHash),
    docIssueCacheState: api.docIssueSnapshotCacheStateFromDataset(ds),
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, ds),
    docGraphRetryRequired: hasTransientDocGraphFailure(api, ds),
    // Commit this side effect only AFTER the surrounding state-bound cache
    // accepts the build. A discarded A -> B -> A attempt must never leak B's
    // counts through the next static index.html response.
    ...(state === globalDatasetState
      ? { instantShell: deriveBootShell(boot) }
      : {}),
  };
}

// Build one /api/dataset/slice/<key> payload — a single heavy dataset array,
// fetched only when its view is opened. Same per-contentHash assembly reuse.
async function buildSlicePayload(state, api, key, sourceSig) {
  const stats = api.ingest(sourceSig);
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  const raw = ds && typeof ds === 'object' ? ds[key] ?? [] : [];
  // Ship each slice in the SAME wire shape /api/dataset.json uses: slimDataset
  // drops zero-valued TokenEntry numerics from `tokenData` (#2107 — several MB of
  // pure wire overhead) and is a pass-through for every other key. The client
  // restores the dropped zeros via rehydrateDataset at the slice-merge seam, so
  // the lazy tokenData slice is never larger than the monolith's equivalent.
  const slimmed = slimDataset({ [key]: raw });
  const value = slimmed && typeof slimmed === 'object' ? slimmed[key] ?? raw : raw;
  return {
    value: await compressedPayload(value, stats.contentHash),
    docIssueCacheState: api.docIssueSnapshotCacheStateFromDataset(ds),
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, ds),
    // docGraph carries the transient fallback directly; repoMap carries
    // recommendation IDs derived from that graph. Other slices are independent
    // outputs and remain cacheable, while the shared assembled memo above has
    // already refused to pin the degraded dataset object.
    docGraphRetryRequired:
      (key === 'docGraph' || key === 'repoMap') &&
      hasTransientDocGraphFailure(api, ds),
  };
}

// Build the /api/search payload for one (query, project, limit), reusing the
// assembled dataset per contentHash (#2071); the per-query score+embed is the
// expensive part the cache exists to collapse.
function buildSearchPayload(state, api, q, project, limit, sourceSig) {
  const stats = api.ingest(sourceSig);
  const ds = memoizedAssembleDataset(state, api, stats.contentHash);
  const results = hybridSearchEntries(ds.entries || [], q, {
    project,
    limit,
    semanticEnabled: true,
  }).map((result) => ({
    ...result,
    entry: { ...result.entry, pastedContents: {} },
  }));
  return {
    value: { mode: 'hybrid', semanticAvailable: true, results },
    docIssueCacheState: api.docIssueSnapshotCacheStateFromDataset(ds),
    docGraphGitWorkingTreeSignature:
      builtDocGraphGitWorkingTreeSignature(api, ds),
    docGraphRetryRequired: hasTransientDocGraphFailure(api, ds),
  };
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

// Resolve `name` directly beneath the already-real `realParent`, creating it if
// absent, refusing a symlinked (or non-directory) component, and requiring the
// canonical result stay under `realRoot`. Returns the real directory path, or
// null when the path escapes containment (#3102). `realParent`/`realRoot` must
// already be realpath'd, and `name` a single validated path segment.
async function ensureContainedChildDir(realParent, name, realRoot) {
  const candidate = join(realParent, name);
  try {
    await mkdir(candidate);
  } catch (err) {
    if (err?.code !== 'EEXIST') return null;
  }
  let st;
  try {
    st = await lstat(candidate);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  const real = await realpathOrNull(candidate);
  if (!real || !pathInside(realRoot, real)) return null;
  return real;
}

// Write `data` to `dir/name` through an O_NOFOLLOW descriptor with restrictive
// perms, so a symlinked FILE at that path is refused (ELOOP) rather than
// followed outside the ingest root (#3102). `dir` must already be a
// verified-real, contained directory.
async function writeContainedFileNoFollow(dir, name, data) {
  const fh = await open(
    join(dir, name),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
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

async function readSelectedMemoryFileCapped(candidate, maxBytes) {
  let handle;
  try {
    const beforeReal = await realpath(candidate.full);
    if (!pathInside(candidate.realParent, beforeReal)) {
      const error = new Error(
        'Memory file resolves outside its selected directory'
      );
      error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
      throw error;
    }
    if (
      !memoryOpenedPathMatches(
        candidate.realParent,
        candidate.full,
        beforeReal
      )
    ) {
      const error = new Error('Memory file changed canonical path before open');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    const before = await lstat(candidate.full);
    if (!before.isFile()) {
      const error = new Error('Selected memory path is not a regular file');
      error.code = 'ERR_DASHBOARD_MEMORY_NOT_REGULAR';
      throw error;
    }

    // Keep validation and reading bound to one opened identity. Resolving a
    // pathname and reopening it later would let a writer swap in an escaping
    // symlink between the containment check and the actual read.
    handle = await open(candidate.full, memoryOpenFlags());
    const opened = await handle.stat();
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

    let realFull = null;
    for (const fdRoot of ['/proc/self/fd', '/dev/fd']) {
      try {
        const fdPath = join(fdRoot, String(handle.fd));
        const resolved = await realpath(fdPath);
        if (resolved === fdPath || pathInside(fdRoot, resolved)) continue;
        realFull = resolved;
        break;
      } catch {
        /* try the next descriptor filesystem */
      }
    }
    if (realFull && !pathInside(candidate.realParent, realFull)) {
      const error = new Error(
        'Memory file resolves outside its selected directory'
      );
      error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
      throw error;
    }
    if (
      realFull &&
      !memoryOpenedPathMatches(
        candidate.realParent,
        candidate.full,
        realFull
      )
    ) {
      const error = new Error('Memory file changed canonical path during open');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    if (!realFull) {
      // Windows/macOS plugin mode retains support through conservative
      // before/open/after identity checks when no descriptor filesystem exists.
      const afterReal = await realpath(candidate.full);
      if (!pathInside(candidate.realParent, afterReal)) {
        const error = new Error(
          'Memory file resolves outside its selected directory'
        );
        error.code = 'ERR_DASHBOARD_MEMORY_PATH_ESCAPE';
        throw error;
      }
      if (
        !memoryOpenedPathMatches(
          candidate.realParent,
          candidate.full,
          afterReal
        )
      ) {
        const error = new Error('Memory file changed canonical path during open');
        error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
        throw error;
      }
      const linked = await stat(afterReal);
      if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
        const error = new Error('Memory file changed during secure open');
        error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
        throw error;
      }
    }

    const chunks = [];
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1));
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw rawFileTooLargeError(maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      const error = new Error('Memory file changed while it was being read');
      error.code = 'ERR_DASHBOARD_MEMORY_FILE_RACED';
      throw error;
    }
    return {
      text: Buffer.concat(chunks).toString('utf8'),
      bytes,
      stat: opened,
    };
  } finally {
    await handle?.close();
  }
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
    const raw = await readFile(filePath);
    // #2444 (Tier-3 instant-load shell): upgrade the build-time SKELETON in the app
    // shell index.html to REAL KPIs using `lastInstantShell` — the shell the boot
    // builder last derived, populated for free by the client's own /api/dataset/boot
    // fetch (see buildBootPayload). This is a plain module-var read + a cheap string
    // splice: it NEVER triggers a dataset assemble, so the HTML serve stays instant
    // (no event-loop blocking — an earlier inline-assemble attempt added ~180 ms
    // warm / seconds cold and regressed the static ~5 ms serve). Cold, before the
    // first boot build => skeleton; warm => real numbers; the client's boot fetch
    // fills/corrects the masthead regardless. Guarded to the resolved index.html.
    // The served data is the single user's own, and when HTTP Basic auth is
    // configured the dispatcher has already authenticated this request, so the
    // real-count upgrade is safe here. rewriteServedHtml is a no-op when the markers are
    // absent (an spa build served here), so that path stays byte-identical. HEAD is
    // fine: sendBody derives Content-Length from the served body, then ends no payload.
    if (ext === '.html' && basename(filePath) === 'index.html') {
      const shell = lastInstantShell;
      const body = shell
        ? Buffer.from(rewriteServedHtml(raw.toString('utf8'), shell))
        : raw;
      sendBody(req, res, body, { quality: 5 });
      return;
    }
    sendBody(req, res, raw, { quality: 5 });
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

// Agent memories (#458/#2558). Walk each project memory dir at fixed depth:
// root *.md plus direct archive/*.md, including both MEMORY.md indexes. The
// parser keeps canonical root-relative paths and the route reports per-project
// completeness so absence-based hygiene claims fail closed after any bounded
// skip. Nested archive directories are never traversed.
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
    const rootRead = await readDirentsBounded(
      memDir,
      DASHBOARD_MEMORY_DIR_MAX_ENTRIES
    );
    if (rootRead.missing) {
      continue;
    }
    const readCompleteness = {
      facts: true,
      mainIndex: true,
      archiveIndex: true,
    };
    if (rootRead.truncated) {
      truncated = true;
      readCompleteness.facts = false;
      readCompleteness.mainIndex = false;
      readCompleteness.archiveIndex = false;
    }

    const selected = [];
    for (const entry of rootRead.entries) {
      if (!entry.name.endsWith('.md')) continue;
      const component =
        entry.name.toLowerCase() === 'memory.md' ? 'mainIndex' : 'facts';
      if (!entry.isFile()) {
        truncated = true;
        readCompleteness[component] = false;
        continue;
      }
      selected.push({
        name: entry.name,
        full: join(memDir, entry.name),
        realParent: realMemDir,
        component,
      });
    }

    // Exactly one additional tier: memory/archive/*.md. Nested directories are
    // never enumerated. The archive dir itself must resolve inside memory/.
    const archiveEntry = rootRead.entries.find(
      (entry) => entry.name === 'archive'
    );
    if (archiveEntry && !archiveEntry.isDirectory()) {
      truncated = true;
      readCompleteness.facts = false;
      readCompleteness.archiveIndex = false;
    } else if (archiveEntry) {
      const archiveDir = join(memDir, 'archive');
      const realArchiveDir = await realpathOrNull(archiveDir);
      if (!realArchiveDir || !pathInside(realMemDir, realArchiveDir)) {
        truncated = true;
        readCompleteness.facts = false;
        readCompleteness.archiveIndex = false;
      } else {
        const archiveRead = await readDirentsBounded(
          archiveDir,
          DASHBOARD_MEMORY_DIR_MAX_ENTRIES
        );
        if (archiveRead.missing || archiveRead.truncated) {
          truncated = true;
          readCompleteness.facts = false;
          readCompleteness.archiveIndex = false;
        }
        for (const entry of archiveRead.entries) {
          if (!entry.name.endsWith('.md')) continue;
          const component =
            entry.name.toLowerCase() === 'archive.md'
              ? 'archiveIndex'
              : 'facts';
          if (!entry.isFile()) {
            truncated = true;
            readCompleteness[component] = false;
            continue;
          }
          selected.push({
            name: `archive/${entry.name}`,
            full: join(archiveDir, entry.name),
            realParent: realArchiveDir,
            component,
          });
        }
      }
    }

    selected.sort((a, b) => a.name.localeCompare(b.name));
    const files = [];
    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index];
      if (fileLimitReached || responseLimitReached) {
        const remaining = selected.slice(index);
        skippedFiles += remaining.length;
        for (const skipped of remaining) {
          readCompleteness[skipped.component] = false;
        }
        truncated = true;
        fileLimitReached = returnedFiles >= DASHBOARD_MEMORY_MAX_FILES;
        break;
      }
      const { name, full, component } = candidate;
      // Defense in depth: never escape the memory dir via a crafted name.
      if (!pathInside(memDir, full)) continue;
      try {
        const { text, bytes, stat: memStat } = await readSelectedMemoryFileCapped(
          candidate,
          DASHBOARD_MEMORY_FILE_MAX_BYTES
        );
        if (contentBytes + bytes > DASHBOARD_MEMORY_RESPONSE_MAX_BYTES) {
          skippedFiles += 1;
          truncated = true;
          responseLimitReached = true;
          readCompleteness[component] = false;
          continue;
        }
        // Structural metadata only (#2495): the file's last-modified time, so
        // the parser can derive a last-edited-age signal. No new content surface.
        contentBytes += bytes;
        returnedFiles += 1;
        files.push({ name, content: text, mtimeMs: memStat.mtimeMs });
        if (returnedFiles >= DASHBOARD_MEMORY_MAX_FILES) {
          truncated = true;
          fileLimitReached = true;
          const remaining = selected.slice(index + 1);
          skippedFiles += remaining.length;
          for (const skipped of remaining) {
            readCompleteness[skipped.component] = false;
          }
          break;
        }
      } catch {
        skippedFiles += 1;
        truncated = true;
        readCompleteness[component] = false;
        /* unreadable/oversized files degrade completeness without sinking */
      }
    }
    if (files.length > 0) out.push({ slug, files, readCompleteness });
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
  // A Basic-auth server is shared, so reading the host's OAuth credential for
  // other viewers stays opt-in (ADR 0008). The open loopback default is the
  // user's own machine and keeps the gauge on.
  if (BASIC_AUTH_ON && !DASHBOARD_ENABLE_SERVER_USAGE_GAUGE) {
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
// Bearer remains a fallback for older/local callers.
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

// Drop every cached /api/recommendations.json entry
// so the next request rebuilds with fresh receipt state (#2206). The recs cache
// freshness gate is keyed only by source signature / contentHash, neither of
// which covers the receipt log — so a reject/un-reject that leaves transcripts
// unchanged would otherwise serve a stale, un-suppressed body until the source
// churns. Cheap: a rejected click is rare relative to recs requests.
function invalidateRecommendationsCaches() {
  globalDatasetState.recommendationsInvalidationGeneration += 1;
  globalDatasetState.recommendationsCache.clear();
}

// POST /api/recommendations/reject — append-only recommendation reject-signal
// writer (#1294). Same mutating-route auth gate as the adoption writer; the core
// writer drops every non-allowlisted field before append, so only
// {findingId, reason} survive.
async function handleRejectSignalWrite(req, res) {
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

  const result = await appendRejectSignal(REJECT_SIGNALS, parsed);
  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error });
  }
  // #2206: mirror the reject into a REJECTED adoption receipt so the engine's
  // reject-suppression query actually drops the finding — the reject signal
  // alone (for the #2207 judge gold set) never reaches the suppression path.
  // Built from the sanitized signal with NO client ts, so appendAdoptionReceipt
  // server-stamps the write time and append order decides a later un-reject
  // (avoids a client backdating a reversal). Best-effort: the reject signal is
  // already persisted, so a receipt write failure must not fail the request.
  try {
    await appendAdoptionReceipt(ADOPTION_RECEIPTS, {
      kind: 'REJECTED',
      findingId: result.record.findingId,
      reason: result.record.reason,
      active: true,
    });
  } catch (err) {
    console.warn('[reject] REJECTED receipt mirror failed:', err?.message || err);
  }
  // Unconditional (outside the try): clearing an already-consistent cache is a
  // harmless no-op, and busting it is a correctness obligation — not best-effort
  // — so a future fallible change here can never silently serve a stale body.
  invalidateRecommendationsCaches();
  return sendJson(res, 200, result);
}

// POST /api/checkpoint/answers — durable checkpoint answer-time capture
// (#2519). Same-origin + JSON + CSRF are checked before the body is read; the
// store re-sanitizes every field and recomputes elapsedMs before append.
async function handleCheckpointAnswerWrite(req, res) {
  if (!passesWriteAuth(req, res)) return;

  let raw;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    return sendJson(res, 413, {
      ok: false,
      error: error?.message || 'Failed to read request body',
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Body is not valid JSON' });
  }
  const result = await appendCheckpointAnswer(CHECKPOINT_ANSWERS, parsed);
  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error });
  }
  return sendJson(res, 200, result);
}

// GET twin: bounded efficacy aggregate only (no raw log dump).
async function handleCheckpointAnswerRead(req, res) {
  const ingestApi = await globalDatasetState.apiPromise;
  try {
    const efficacy = await ingestApi.readCheckpointAnswerEfficacy(
      CHECKPOINT_ANSWERS
    );
    return sendJson(res, 200, efficacy);
  } catch (error) {
    if (
      error?.code === 'CHECKPOINT_ANSWER_READ_BUDGET_EXCEEDED'
      && error?.provenance
    ) {
      return sendJson(res, 503, {
        ok: false,
        error: 'Checkpoint answer efficacy log exceeds the bounded read budget',
        incomplete: true,
        provenance: error.provenance,
      });
    }
    console.error('checkpoint-answer efficacy read failed:', error?.message || error);
    return sendJson(res, 500, {
      ok: false,
      error: 'Failed to read checkpoint answer efficacy evidence',
    });
  }
}

// POST /api/analyze/local — Tier A "Analyze locally" (#2319, ADR 0018).
//
// Runs a LOCAL model over the SAME deterministic recommendation call sites as
// /api/recommendations.json. This is a user-initiated, seconds-latency surface
// (NOT the session-critical path), and it is explicitly NOT the removed
// "Re-generate insights with Claude" button — it never mimics the CLI /insights
// report.
//
// GOVERNANCE (ADR 0018 hard guardrails, enforced here + in local-model-client):
//  - Egress is LOOPBACK-ONLY. callLocalModel routes through assertLoopbackEndpoint,
//    which refuses any non-loopback host, so this route cannot reach a third-party
//    API. There is NO Anthropic fallback wired in v0.6.0.
//  - The default path makes ZERO network calls: an unset endpoint
//    (CHD_LOCAL_MODEL_ENDPOINT) short-circuits to the deterministic result.
//  - Graceful degradation: an unset/unreachable/refused endpoint — or even a
//    failed deterministic build — returns HTTP 200 with the deterministic engine
//    result (source: 'deterministic'), never a 5xx.
function localAnalyzeBuildIsCurrent(build, now = Date.now()) {
  const currentDocIssueState = currentDocIssueCacheState(build.ingestApi);
  return (
    build.sourceSig === build.ingestApi.sourceSignature() &&
    docGraphGitWorkingTreeSignaturesEqual(
      build.docGraphGitWorkingTreeSignature ?? null,
      sourceBoundDocGraphGitWorkingTreeSignature(build.ingestApi)
    ) &&
    docIssueCacheStateIsUsable(build.docIssueCacheState, now) &&
    docIssueCacheStateIsUsable(currentDocIssueState, now) &&
    docIssueCacheStatesEqual(build.docIssueCacheState, currentDocIssueState)
  );
}

async function buildLocalAnalyzeDeterministic(req, project) {
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  const organizationIdentity = null;
  let expectedSourceSig = ingestApi.sourceSignature();
  let expectedDocGraphGitWorkingTreeSignature =
    sourceBoundDocGraphGitWorkingTreeSignature(ingestApi);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const docIssueCacheState = currentDocIssueCacheState(ingestApi);
    const stats = ingestApi.ingest(expectedSourceSig);
    const dataset = memoizedAssembleRecommendationDataset(
      ingestState,
      ingestApi,
      stats.contentHash
    );
    const docGraphRetryRequired = hasTransientDocGraphFailure(
      ingestApi,
      dataset
    );
    const builtDocGraphGitWorkingTreeState =
      builtDocGraphGitWorkingTreeSignature(ingestApi, dataset);
    const builtDocIssueCacheState =
      ingestApi.docIssueSnapshotCacheStateFromDataset(dataset);
    const rejectedFindingIds = await ingestApi.readRejectedFindingIds(
      ADOPTION_RECEIPTS
    );
    const recs = ingestApi.assembleRecommendations(project || undefined, {
      organizationIdentity,
      dataset,
      rejectedFindingIds,
    });
    const completedSourceSig = ingestApi.sourceSignature(expectedSourceSig);
    const completedDocGraphGitWorkingTreeSignature =
      sourceBoundDocGraphGitWorkingTreeSignature(ingestApi);
    const completedDocIssueState = currentDocIssueCacheState(ingestApi);
    const sourceSigStable = expectedSourceSig === completedSourceSig;
    const docGraphGitWorkingTreeStateStable =
      docGraphGitWorkingTreeSignaturesEqual(
        expectedDocGraphGitWorkingTreeSignature,
        stats.docGraphGitWorkingTreeSignature ?? null
      ) &&
      docGraphGitWorkingTreeSignaturesEqual(
        stats.docGraphGitWorkingTreeSignature ?? null,
        builtDocGraphGitWorkingTreeState
      ) &&
      docGraphGitWorkingTreeSignaturesEqual(
        builtDocGraphGitWorkingTreeState,
        completedDocGraphGitWorkingTreeSignature
      );
    const docIssueStateStable =
      docIssueCacheStatesEqual(
        docIssueCacheState,
        builtDocIssueCacheState
      ) &&
      docIssueCacheStatesEqual(docIssueCacheState, completedDocIssueState) &&
      docIssueCacheStatesEqual(
        builtDocIssueCacheState,
        completedDocIssueState
      ) &&
      docIssueCacheStateIsUsable(completedDocIssueState, Date.now());
    if (
      !docGraphRetryRequired &&
      docGraphGitWorkingTreeStateStable &&
      docIssueStateStable &&
      (sourceSigStable || attempt === 1)
    ) {
      return {
        ingestApi,
        // A deterministic final-attempt candidate remains safe to serve when
        // only the coarse source signature moved. Keep it explicitly
        // unsettled so a later model result cannot be attached as though the
        // evidence were stable; ensureCurrentLocalAnalyzeBuild will recheck it.
        sourceSig: sourceSigStable ? completedSourceSig : null,
        docGraphGitWorkingTreeSignature:
          builtDocGraphGitWorkingTreeState,
        docIssueCacheState: builtDocIssueCacheState,
        recommendations: extractRecommendations(recs),
      };
    }
    if (
      docGraphRetryRequired &&
      docGraphGitWorkingTreeStateStable &&
      docIssueStateStable &&
      attempt === 1
    ) {
      return {
        ingestApi,
        sourceSig: null,
        docGraphGitWorkingTreeSignature:
          builtDocGraphGitWorkingTreeState,
        docIssueCacheState: builtDocIssueCacheState,
        recommendations: extractRecommendations(recs),
      };
    }
    expectedSourceSig = completedSourceSig;
    expectedDocGraphGitWorkingTreeSignature =
      completedDocGraphGitWorkingTreeSignature;
  }
  throw new Error(
    'Recommendation source state changed across the bounded local-analysis retry'
  );
}

async function ensureCurrentLocalAnalyzeBuild(req, project, build) {
  return localAnalyzeBuildIsCurrent(build)
    ? build
    : buildLocalAnalyzeDeterministic(req, project);
}

function localAnalyzeResultWithValidity(result, build) {
  const usableThrough = build.docIssueCacheState?.usableThrough;
  return Number.isFinite(usableThrough)
    ? { ...result, validThrough: new Date(usableThrough).toISOString() }
    : result;
}

// Analyze locally is non-mutating, so it needs no CSRF token, but it starts an
// ingest and a local-model run. Require a same-origin Origin and a JSON body so a
// cross-site form POST (simple request, no preflight) cannot trigger it (#3906).
function passesAnalyzeLocalOriginGate(req, res) {
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
  return true;
}

async function handleAnalyzeLocal(req, res) {
  // Optional JSON body { project?: string }; a missing/invalid body analyzes the
  // global scope. Reading it also drains the request stream before ingest.
  let project = null;
  try {
    const raw = await readRequestBody(req);
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.project === 'string') {
        project = parsed.project;
      }
    }
  } catch {
    // Body is optional; ignore framing/parse errors and analyze the global scope.
  }

  // Deterministic recommendations over the SAME assemble path the recs route uses
  // (#2196/#2182): ingest -> memoized recommendation dataset -> assembleRecommendations.
  // Built directly (not through the recs response cache) so this route never
  // touches that route's single-flight/stale-while-revalidate slots.
  let deterministicBuild;
  try {
    deterministicBuild = await buildLocalAnalyzeDeterministic(req, project);
  } catch (err) {
    // Even the deterministic build failed — still answer (no throw), empty recs.
    return sendJson(
      res,
      200,
      degradedResult(
        [],
        `Recommendation engine unavailable: ${err?.message || err}`
      )
    );
  }

  // Local endpoint unset => operator has not opted in => degrade with zero calls.
  const config = readLocalModelConfig();
  if (!config) {
    try {
      deterministicBuild = await ensureCurrentLocalAnalyzeBuild(
        req,
        project,
        deterministicBuild
      );
      return sendJson(
        res,
        200,
        localAnalyzeResultWithValidity(
          degradedResult(
            deterministicBuild.recommendations,
            'Local model endpoint not configured (set CHD_LOCAL_MODEL_ENDPOINT to a loopback OpenAI-compatible endpoint)'
          ),
          deterministicBuild
        )
      );
    } catch (err) {
      return sendJson(
        res,
        200,
        degradedResult(
          [],
          `Recommendation engine unavailable: ${err?.message || err}`
        )
      );
    }
  }

  // Schema-constrained call (#2682): each chat turn routes through the SAME
  // loopback-guarded transport; runLocalAnalyze validates the {summary,
  // rankedFindingIds} output and repairs against domain-phrased errors in a
  // bounded loop, degrading to the deterministic result on exhaustion.
  const send = (messages) =>
    callLocalModel({
      endpoint: config.endpoint,
      model: config.model,
      messages,
      maxTokens: 512,
    });
  let result;
  try {
    result = await runLocalAnalyze({
      send,
      recommendations: deterministicBuild.recommendations,
      model: config.model,
    });
  } catch (err) {
    // Loopback-guard refusal, unreachable endpoint, timeout, non-OK, bad JSON —
    // all degrade to the deterministic engine result WITHOUT erroring.
    result = degradedResult(
      deterministicBuild.recommendations,
      `Local model unavailable: ${err?.message || err}`
    );
  }

  try {
    const currentBuild = await ensureCurrentLocalAnalyzeBuild(
      req,
      project,
      deterministicBuild
    );
    if (currentBuild !== deterministicBuild) {
      // The model analyzed an older deterministic finding set. Never attach that
      // prose/ranking to newer evidence; return the rebuilt deterministic set.
      result = degradedResult(
        currentBuild.recommendations,
        'Recommendation evidence changed while local analysis was running; run Analyze again for a fresh local summary'
      );
    }
    return sendJson(
      res,
      200,
      localAnalyzeResultWithValidity(result, currentBuild)
    );
  } catch (err) {
    return sendJson(
      res,
      200,
      degradedResult(
        [],
        `Recommendation engine unavailable: ${err?.message || err}`
      )
    );
  }
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
  // #3102: resolve the out-of-band metadata dirs beneath the REAL ingest root,
  // refusing a symlinked `.sources` or `.sources/<sourceId>` up front so the
  // authenticated `_source.json`/`.signatures.json` writes below can never be
  // redirected outside PROBAITIO_INGEST_DIR. `sourceId` is already validated by
  // safeSourceId(), so it is a single safe path segment.
  const realSourcesDir = await ensureContainedChildDir(realIngest, '.sources', realIngest);
  const metaRoot = realSourcesDir
    ? await ensureContainedChildDir(realSourcesDir, sourceId, realIngest)
    : null;
  if (!metaRoot) {
    return sendJson(res, 400, { ok: false, error: 'ingest metadata dir escapes root' });
  }

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
      await writeContainedFileNoFollow(
        metaRoot,
        '_source.json',
        JSON.stringify({ sourceId, ...body.meta })
      );
    } catch {
      /* best-effort provenance (a symlinked target is refused, not followed) */
    }
  }
  try {
    await writeContainedFileNoFollow(metaRoot, '.signatures.json', JSON.stringify(ledger));
  } catch {
    /* ledger persistence is best-effort; a symlinked target is refused, not followed */
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

// GET /api/steer-telemetry — read-only per-rule rollup of the EXISTING
// PreToolUse-steer delivery/outcome log (#2203). Each line is re-sanitized
// through the same fail-closed allowlist on read, and a missing/empty log is an
// empty array (the dashboard renders a "no data" state).
async function handleSteerTelemetryRead(req, res) {
  try {
    const records = await readSteerTelemetry(STEER_TELEMETRY_LOGS);
    return sendJson(res, 200, { ok: true, records });
  } catch (err) {
    return sendJson(res, 500, {
      ok: false,
      error: `Failed to read steer telemetry: ${err.message}`,
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
function checkBasicAuth(req) {
  if (!BASIC_AUTH_ON) return true; // not configured → open (loopback default)
  const auth = singleRequestHeaderValue(req, 'authorization');
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

// Fail-closed bind guard (#2064; the insecure-bind override was removed in
// #3295). The dashboard reads ~/.claude live, so an unauthenticated
// beyond-loopback bind is unrepresentable — there is deliberately NO override
// that lets it start. Inside our container HOST is always 0.0.0.0 (so the
// published port works), so HOST alone can't reveal whether the port is actually
// exposed to the LAN — DASHBOARD_BIND_HOST, which docker-compose forwards from
// BIND_HOST, carries the real host publish interface. When that is explicitly
// non-loopback with no auth configured, refuse to start (fail closed). For a bare
// `node` run that only sets a non-loopback HOST (ambiguous — could be the
// container default), warn loudly instead of breaking the boot.
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
  const anyAuthConfigured = BASIC_AUTH_ON;
  const publishHost = String(process.env.DASHBOARD_BIND_HOST || '').trim();
  const confidentExposure = publishHost !== '' && !isLoopbackHost(publishHost);
  const ambiguousExposure = publishHost === '' && !isLoopbackHost(HOST);
  if (!anyAuthConfigured && (confidentExposure || ambiguousExposure)) {
    const where = confidentExposure
      ? `DASHBOARD_BIND_HOST=${publishHost}`
      : `HOST=${HOST}`;
    const detail =
      `the dashboard is bound beyond loopback (${where}) with no DASHBOARD_USER/DASHBOARD_PASS, ` +
      `so it is reachable UNAUTHENTICATED while reading ~/.claude live`;
    if (confidentExposure) {
      // No override: an unauthenticated beyond-loopback bind cannot start.
      throw new Error(
        `[security] Refusing to start: ${detail}. Set DASHBOARD_USER/DASHBOARD_PASS ` +
          `(and terminate TLS at a trusted reverse proxy for beyond-loopback traffic), ` +
          `or bind to loopback (BIND_HOST=127.0.0.1).`
      );
    }
    console.warn(`[security] WARNING: ${detail}.`);
  }
}
// Retired enterprise auth settings (#3839). The server no longer reads them, so
// a deployment that still sets one expected an auth gate that is gone. Without
// HTTP Basic that deployment would be open, so refuse to start; with Basic the
// settings are only ignored, so warn.
const RETIRED_ENTERPRISE_AUTH_ENV = [
  'DASHBOARD_AUTH_MODE',
  'DASHBOARD_AUTH_TOKENS',
  'DASHBOARD_AUTH_TOKENS_FILE',
  'DASHBOARD_ADMIN_TOKEN',
  'DASHBOARD_ADMIN_TOKEN_SHA256',
  'DASHBOARD_AUTH_JWKS',
  'DASHBOARD_AUTH_JWKS_URL',
];
{
  const retired = RETIRED_ENTERPRISE_AUTH_ENV.filter(
    (name) => String(process.env[name] || '').trim() !== ''
  );
  if (retired.length > 0) {
    const detail =
      `${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} set, but enterprise ` +
      `auth was removed and the server ignores ${retired.length === 1 ? 'it' : 'them'}`;
    if (!BASIC_AUTH_ON) {
      throw new Error(
        `[security] Refusing to start: ${detail}, which would leave the dashboard ` +
          `unauthenticated. Set DASHBOARD_USER/DASHBOARD_PASS for HTTP Basic auth, ` +
          `or unset the retired settings to run the open loopback default.`
      );
    }
    console.warn(`[security] WARNING: ${detail}; HTTP Basic auth still applies.`);
  }
}

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : '';
}

function requestId(req) {
  if (!req.dashboardRequestId) {
    req.dashboardRequestId =
      normalizeRequestId(req.headers?.['x-request-id']) || randomUUID();
  }
  return req.dashboardRequestId;
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

function parseBoundedSearchInt(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function serverSessionPayload() {
  return {
    mode: 'single-user',
    authRequired: false,
    authenticated: true,
    configured: true,
    principal: null,
    organization: null,
    capabilities: {
      canReadOwnSessions: true,
      canReadRawTranscripts: true,
      canWritePolicy: true,
      canImportLocalData: true,
    },
  };
}

function dataSourceClaudeRoot(sourceId) {
  const source = DATA_SOURCE_BY_ID.get(sourceId);
  return source ? dirname(source.historyDir) : null;
}

function dataSourceProjectsRoot(sourceId) {
  const source = DATA_SOURCE_BY_ID.get(sourceId);
  return source ? source.historyDir : null;
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

function requestPathname(req) {
  try {
    return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

// Neutral single-user server session (#3839). The browser reads this for
// readiness and capabilities; HTTP Basic auth, when configured, is enforced by
// the dispatcher before this handler runs.
async function handleAuthSession(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  return sendJson(res, 200, serverSessionPayload());
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
  // have changed since the last full ingest?" without reading transcript
  // bytes or touching SQLite. When it matches the signature from
  // the last ingest AND we already hold a built dataset cache, skip ingest()
  // entirely and serve the cache. NOTE: an in-place append to an existing
  // transcript does NOT move this signature (POSIX dir mtime semantics), so
  // it lags until the next structural change — accepted by design; in-flight
  // liveness is the Live Session widget's job (#131). An in-place REWRITE with
  // a restored mtime is NOT accepted lag: the signature's transcript-rewrites
  // part observes it via ctime and schedules the refresh (#3401). See
  // sourceSignature().
  const sig = ingestApi.sourceSignature();
  if (!ingestState.datasetCache) {
    ingestState.datasetCache = ingestApi.loadLatestDatasetCache();
  }
  if (
    ingestState.datasetCache &&
    (
      ingestState.datasetCache.docGraphRetryRequired === true ||
      !datasetCacheEntryMatchesDocIssueState(
        ingestState.datasetCache,
        ingestApi,
        Date.now()
      ) ||
      !datasetCacheEntryMatchesRecursiveRemovalSafetyState(
        ingestState.datasetCache,
        ingestApi
      ) ||
      !datasetCacheEntryMatchesDocGraphGitWorkingTreeState(
        ingestState.datasetCache,
        ingestApi,
        sourceBoundDocGraphGitWorkingTreeSignature(ingestApi)
      )
    )
  ) {
    // Snapshot mismatch/expiry and canonical-containment drift are hard
    // boundaries: never SWR-serve a body whose GitHub or recursive-removal
    // claims are no longer current. This also rejects legacy persisted bodies
    // without the state needed to prove those claims.
    ingestState.datasetCache = null;
    ingestState.lastSourceSig = null;
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

// Serve a stat-gated, precompressed payload (boot or slice) with the same ETag
// revalidation as /api/dataset.json. `value` is { json, etag, brBuf, gzBuf }.
function sendDatasetSplitPayload(req, res, value) {
  res.setHeader('X-Source', 'live');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', revalidatingLiveCacheControl());
  if (value.version) res.setHeader('X-Dataset-Version', value.version);
  if (etagMatches(req, value.etag)) {
    res.setHeader('ETag', value.etag);
    appendVary(res, 'Accept-Encoding');
    res.statusCode = 304;
    res.end();
    return;
  }
  sendBody(req, res, value.json, {
    etag: value.etag,
    precompressed: { br: value.brBuf, gz: value.gzBuf },
  });
}

// /api/dataset/boot (#2443): the tiny boot half of the split — metadata +
// aggregates + per-slice counts — so the Tier-3 client paints the landing shell
// without the ~98 MB monolith. Same stat-gated cache + ETag revalidation as
// /api/dataset.json; the heavy detail arrives lazily via /api/dataset/slice/<key>.
async function handleDatasetBoot(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET or HEAD' });
  }
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  let value;
  let instantShell;
  try {
    ({ value, instantShell } = await statGatedResponseCache(ingestApi, {
      cacheMap: ingestState.bootCache,
      buildsMap: ingestState.bootBuilds,
      key: 'boot',
      max: 1,
      build: (api, sourceSig) =>
        buildBootPayload(ingestState, api, sourceSig),
    }));
  } catch (err) {
    if (isDatasetResponseTooLargeError(err)) return sendDatasetResponseTooLarge(res, err);
    throw err;
  }
  if (ingestState === globalDatasetState && instantShell) {
    lastInstantShell = instantShell;
  }
  sendDatasetSplitPayload(req, res, value);
}

// /api/dataset/slice/<key> (#2443): one heavy per-view dataset array, fetched
// only when its view is opened. `key` must be a known sliceable key; anything
// else 404s so the surface is a fixed allowlist, not arbitrary dataset access.
async function handleDatasetSlice(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET or HEAD' });
  }
  const pathname = requestPathname(req);
  const key = pathname.slice('/api/dataset/slice/'.length);
  if (!isSliceKey(key)) {
    return sendJson(res, 404, { ok: false, error: `Unknown dataset slice: ${key}` });
  }
  const { ingestState, ingestApi } = await loadIngestedDataset(req, {
    useCache: true,
  });
  let value;
  try {
    ({ value } = await statGatedResponseCache(ingestApi, {
      cacheMap: ingestState.sliceCache,
      buildsMap: ingestState.sliceBuilds,
      key: `slice:${key}`,
      max: 32,
      build: (api, sourceSig) =>
        buildSlicePayload(ingestState, api, key, sourceSig),
    }));
  } catch (err) {
    if (isDatasetResponseTooLargeError(err)) return sendDatasetResponseTooLarge(res, err);
    throw err;
  }
  sendDatasetSplitPayload(req, res, value);
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
    build: (api, sourceSig) =>
      buildDigestPayload(ingestState, api, date, sourceSig),
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
    build: (api, sourceSig) =>
      buildSearchPayload(ingestState, api, q, project, limit, sourceSig),
  });
  res.setHeader('X-Source', 'live');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Search-Cache', cache);
  return sendJson(res, 200, payload);
}

// #2718: the strict v1 typed-surface contract for /api/recommendations.json.
// These sets/constants mirror the client's masthead + route vocabulary
// (TIME_PRESETS, ALL_PROJECTS, routeFilterValue in src/lib/routing.ts); the
// actual filter SEMANTICS are the shared pure code in view-scope.ts, so only the
// param names/validation live here.
const RECOMMENDATION_SURFACES = new Set(['global', 'reclaim-compass']);
const RECOMMENDATION_TIME_PRESETS = new Set(['24h', '7d', '30d', 'all']);
const RECOMMENDATION_ALL_PROJECTS = 'All projects';
const RECOMMENDATION_SURFACE_PARAM_MAX = 512;
const RECOMMENDATION_SURFACE_ALLOWED_PARAMS = {
  global: new Set(['surface', 'dashboardTime', 'dashboardProject']),
  'reclaim-compass': new Set([
    'surface',
    'dashboardTime',
    'dashboardProject',
    'routeProject',
    'routeDate',
    'routeMode',
    'routeEntrypoint',
  ]),
};

function normalizeRecommendationRouteValue(key, value) {
  const normalized = (value ?? '').trim();
  if (!normalized) return undefined;
  if (key === 'project' && normalized === RECOMMENDATION_ALL_PROJECTS) {
    return undefined;
  }
  return normalized;
}

// Parse + strictly validate the typed-surface query. Returns { ok:true, request }
// with a canonicalized filter tuple, or { ok:false, error } (-> 400). Rejects an
// unknown surface, any parameter outside the surface's allow-list (incl. the
// legacy `project`, so the two contracts never overlap), duplicate values, and
// oversized values — never silently widens scope.
function parseRecommendationSurfaceRequest(params) {
  const surface = params.get('surface');
  // Bound the discriminator before membership validation or reflection. Without
  // this early check, an oversized invalid surface bypasses the generic loop
  // below and is copied in full into the error response.
  if (surface != null && surface.length > RECOMMENDATION_SURFACE_PARAM_MAX) {
    return {
      ok: false,
      error: `parameter 'surface' exceeds ${RECOMMENDATION_SURFACE_PARAM_MAX} characters`,
    };
  }
  if (!RECOMMENDATION_SURFACES.has(surface)) {
    return {
      ok: false,
      error: `unsupported surface '${surface ?? ''}'; expected one of global, reclaim-compass`,
    };
  }
  const allowed = RECOMMENDATION_SURFACE_ALLOWED_PARAMS[surface];
  for (const key of params.keys()) {
    if (key.length > RECOMMENDATION_SURFACE_PARAM_MAX) {
      return {
        ok: false,
        error: `parameter name exceeds ${RECOMMENDATION_SURFACE_PARAM_MAX} characters`,
      };
    }
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `unsupported parameter '${key}' for surface '${surface}'`,
      };
    }
    if (params.getAll(key).length > 1) {
      return { ok: false, error: `duplicate parameter '${key}'` };
    }
    const value = params.get(key);
    if (value != null && value.length > RECOMMENDATION_SURFACE_PARAM_MAX) {
      return {
        ok: false,
        error: `parameter '${key}' exceeds ${RECOMMENDATION_SURFACE_PARAM_MAX} characters`,
      };
    }
  }
  const rawTime = params.get('dashboardTime');
  // Empty values are the browser's default masthead state, just like an omitted
  // parameter. Canonicalize them before validation/cache-key construction so
  // `dashboardTime=` cannot become a needless 400 or a distinct cache entry.
  // Keep non-empty values byte-strict: e.g. ` 24h ` remains unsupported instead
  // of silently broadening or rewriting an invalid client request.
  const dashboardTime = rawTime == null || rawTime.trim() === '' ? '24h' : rawTime;
  if (!RECOMMENDATION_TIME_PRESETS.has(dashboardTime)) {
    return {
      ok: false,
      error: `unsupported dashboardTime '${dashboardTime}'; expected one of 24h, 7d, 30d, all`,
    };
  }
  const rawProject = (params.get('dashboardProject') ?? '').trim();
  const dashboardProject =
    rawProject === '' ? RECOMMENDATION_ALL_PROJECTS : rawProject;
  // Insertion order is fixed so the cache-key filter hash is deterministic.
  const filters = { dashboardTime, dashboardProject };
  if (surface === 'reclaim-compass') {
    const routeProject = normalizeRecommendationRouteValue(
      'project',
      params.get('routeProject')
    );
    const routeDate = normalizeRecommendationRouteValue(
      'date',
      params.get('routeDate')
    );
    const routeMode = normalizeRecommendationRouteValue(
      'mode',
      params.get('routeMode')
    );
    const routeEntrypoint = normalizeRecommendationRouteValue(
      'entrypoint',
      params.get('routeEntrypoint')
    );
    if (routeProject) filters.routeProject = routeProject;
    if (routeDate) filters.routeDate = routeDate;
    if (routeMode) filters.routeMode = routeMode;
    if (routeEntrypoint) filters.routeEntrypoint = routeEntrypoint;
  }
  return { ok: true, request: { surface, filters } };
}

function sendRecommendationsBadRequest(res, message) {
  const body = safeJsonStringify({ error: message });
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
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
  // #2718: strict v1 typed-surface contract. `surface` absent -> the legacy raw
  // Recommendation[] (byte-compatible, incl. the optional `?project=` post-hoc
  // attribution filter). Present -> validate strictly and serve the typed
  // { recommendations, domainCoverage } envelope scoped to the exact active view;
  // any unsupported / conflicting / oversized parameter is a 400, never a silent
  // scope widening.
  let surfaceRequest = null;
  if (url.searchParams.has('surface')) {
    const parsed = parseRecommendationSurfaceRequest(url.searchParams);
    if (!parsed.ok) {
      return sendRecommendationsBadRequest(res, parsed.error);
    }
    surfaceRequest = parsed.request;
  }
  // The legacy `?project=` attribution filter is honored ONLY on the legacy
  // contract; the typed contract carries its own exact `dashboardProject` scope
  // and rejects `project` as conflicting (in the parser above).
  const project = surfaceRequest ? null : url.searchParams.get('project');
  // Scoped surfaces never emit suppression-transition side effects (#2718) — that
  // canonical write belongs only to the unfiltered global legacy path. They still
  // READ rejected receipts to suppress findings.
  const emitSuppressionTransitions = !project && !surfaceRequest;
  const organizationIdentity = null;
  // #2196: the rebuild worker ingests the main process's global CLAUDE_DIR.
  const allowWorker = true;
  let entry;
  let cache;
  let scheduleRefresh = null;
  try {
    ({ entry, cache, scheduleRefresh } = await recommendationsResponseCache(
      ingestState,
      ingestApi,
      project,
      { emitSuppressionTransitions, organizationIdentity, allowWorker, surfaceRequest }
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
  // Recs are deterministic within their external-guidance clock interval. A
  // boundary crossing redecorates the cached JSON and recomputes this ETag, so
  // If-None-Match never turns a changed current/as-of label into a false 304.
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

// Best-effort read of the experiment registry's axis metadata (key + label) for
// human-readable axis labels in the verdict. Fail-open: the registry lives in
// ~/.claude/experiments/ and is NOT shipped in the runtime image, so a missing or
// malformed registry simply yields no labels and the evaluator falls back to the
// axis key. Never throws.
async function readExperimentAxisMeta() {
  if (!existsSync(EXPERIMENT_REGISTRY)) return [];
  try {
    const mod = await import(pathToFileURL(EXPERIMENT_REGISTRY).href);
    const axes = typeof mod.listAxes === 'function' ? mod.listAxes() : mod.AXES;
    if (!Array.isArray(axes)) return [];
    return axes
      .filter((a) => a && typeof a.key === 'string')
      .map((a) => ({ key: a.key, label: typeof a.label === 'string' ? a.label : a.key }));
  } catch {
    return [];
  }
}

// GET /api/experiments.json — experiment-axis evaluator (#2242, loop-closer for
// #2227). Joins the live enrollment ledger (arm per session) to the measured
// conversational-availability BFC metric (#2238), aggregates per arm, and
// qualifies each axis success/failure/inconclusive. Server-only (reads ~/.claude
// directly) — there is no client fetch, so the SPA boundary is untouched. Honesty
// contract: every verdict carries observational confidence (menu assignment), a
// provisional `not-auto-measured` counter-metric, and the control-arm-bias caveat,
// so a `success` is never overclaimed (AGENTS.md auditable-claims rule).
async function handleExperimentsJson(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  // Fresh-per-request ingest (like /api/dataset.json): useCache false makes
  // loadIngestedDataset run ingest() so assembleDataset() reflects the live
  // transcripts. (/api/memories and /api/workflows instead do raw file walks
  // with no ingest, so they are not the right analogue for this pattern.) This
  // is a low-traffic dogfood endpoint, so a per-request ingest is acceptable
  // rather than wiring a dedicated dataset cache.
  const { ingestApi } = await loadIngestedDataset(req, { useCache: false });
  const dataset = ingestApi.assembleDataset();
  const timelines = Array.isArray(dataset.timelines) ? dataset.timelines : [];

  // Fail-open ledger read: a missing / empty / unreadable ledger yields zero
  // enrollments (the evaluator then returns []), never an error.
  let ledgerText = '';
  if (existsSync(EXPERIMENT_LEDGER)) {
    try {
      ledgerText = readFileSync(EXPERIMENT_LEDGER, 'utf8');
    } catch {
      ledgerText = '';
    }
  }
  const enrollments = parseEnrollmentLedger(ledgerText);
  const axisMeta = await readExperimentAxisMeta();
  const axes = evaluateExperiments(timelines, enrollments, axisMeta);

  res.setHeader('X-Source', 'live');
  res.setHeader('Cache-Control', 'no-store');
  return sendJson(res, 200, { axes });
}

// GET /api/shadow-experiments.json — per-experiment drill-down feed for the
// Shadow Calls view (#2152, epic #2147). Serves the flat row log straight from
// the shadow-calls ledger (no ingest, no dataset assemble), so experiment data
// is reachable without the multi-MB /api/dataset.json blob. The parse sits
// behind the same stat-gated single-flight cache as /api/digest//api/search: a
// cheap statSync signature gates it, so an APPENDED record moves the signature
// and the very next fetch reparses (the staleness contract), while pagination
// over an unchanged ledger reuses one cached parse instead of re-reading up to
// ARTIFACT_FILE_MAX_BYTES per page. Integrity: every bound is SURFACED, never
// silent — an over-cap ledger reads its newest tail (`ledgerTruncated`), the
// row bound reports `rowsDropped`, and counted/synthetic/skipped are
// WHOLE-LEDGER counts (they reconcile to `total` even when rows are a suffix).
const SHADOW_EXPERIMENTS_ROWS_KEPT = 20_000;
const shadowExperimentsCache = new Map();
const shadowExperimentsBuilds = new Map();

// The shadow-calls ledger and gate-2702 state live under the single user's
// CLAUDE root (CLAUDE_SHADOW_CALLS_LEDGER overrides the ledger for tests and
// custom deploys).
function shadowLedgerPathFor() {
  return SHADOW_CALLS_LEDGER;
}

function gate2702StateRootFor() {
  return GATE_2702_STATE_ROOT;
}

function shadowLedgerSignature(ledgerPath) {
  try {
    const s = statSync(ledgerPath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'absent';
  }
}

async function handleShadowExperimentsJson(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
  }
  const params = new URL(req.url, 'http://localhost').searchParams;
  const limit = parseBoundedSearchInt(params, 'limit', 500, 1, 2000);
  const offset = parseBoundedSearchInt(params, 'offset', 0, 0, 1_000_000);
  const ledgerPath = shadowLedgerPathFor(req);
  const gate2702StateRoot = gate2702StateRootFor(req);

  const { value: parsed, cache } = await resolveStatGatedCache({
    sourceSignature: () => shadowLedgerSignature(ledgerPath),
    cacheMap: shadowExperimentsCache,
    buildsMap: shadowExperimentsBuilds,
    // Keyed by the resolved path so scoped roots never share a cache entry.
    key: ledgerPath,
    max: 8,
    build: () => {
      // Fail-open ledger read (like /api/experiments.json): missing/unreadable
      // ⇒ an empty log, never an error — the view then shows its zero state.
      let ledger = { text: '', truncated: false, totalBytes: 0 };
      if (existsSync(ledgerPath)) {
        try {
          ledger = readJsonlTailCappedSync(ledgerPath, ARTIFACT_FILE_MAX_BYTES);
        } catch {
          ledger = { text: '', truncated: false, totalBytes: 0 };
        }
      }
      return {
        result: parseShadowCallRows(ledger.text, { maxRows: SHADOW_EXPERIMENTS_ROWS_KEPT }),
        ledgerTruncated: ledger.truncated,
      };
    },
  });

  const { result, ledgerTruncated } = parsed;
  // Do not cache a “verified” projection behind marker metadata: #2822's full
  // loader is what detects an in-place artifact tamper. Re-verify on each
  // request so stale bytes can never outlive their validation.
  const gate2702 = await readGate2702ShadowProjection({ stateRoot: gate2702StateRoot });
  // Newest-first pagination without copying/reversing the whole retained
  // array: index the requested page from the tail, then reverse just the page.
  const rows = result.rows;
  const end = Math.max(0, rows.length - offset);
  const pageStart = Math.max(0, end - limit);
  const page = rows.slice(pageStart, end).reverse();

  res.setHeader('X-Source', 'live');
  res.setHeader('X-Shadow-Experiments-Cache', cache);
  res.setHeader('Cache-Control', 'no-store');
  return sendJson(res, 200, {
    total: result.total,
    counted: result.counted,
    synthetic: result.synthetic,
    skipped: result.skipped,
    ledgerTruncated,
    rowsDropped: result.dropped,
    offset,
    limit,
    returned: page.length,
    rows: page,
    ...(gate2702 ? { gate2702 } : {}),
  });
}

// Pathname -> Handler map for the dataset-bearing routes. The dispatcher does a
// single Map lookup and delegates; each handler resolves its own ingest state
// via loadIngestedDataset() at the same point it did inline, so the validation
// short-circuits in handleDigest/handleSearch still run before any ingest work.
const DATASET_ROUTES = new Map([
  ['/api/dataset.json', handleDatasetJson],
  ['/api/dataset/boot', handleDatasetBoot],
  ['/api/recommendations.json', handleRecommendationsJson],
  ['/api/digest', handleDigest],
  ['/api/search', handleSearch],
]);

const server = createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    res.setHeader('X-Request-Id', requestId(req));
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
    if (!checkBasicAuth(req)) {
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

    if (pathname === '/api/steer-telemetry') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      return handleSteerTelemetryRead(req, res);
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

    if (pathname === '/api/recommendations/reject') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use POST' });
      }
      return handleRejectSignalWrite(req, res);
    }

    if (pathname === '/api/checkpoint/answers') {
      if (req.method === 'GET') return handleCheckpointAnswerRead(req, res);
      if (req.method === 'POST') return handleCheckpointAnswerWrite(req, res);
      return sendJson(res, 405, {
        ok: false,
        error: 'Method not allowed; use GET or POST',
      });
    }

    // Tier A "Analyze locally" (#2319): local-model analysis over the recs call
    // sites. POST-only; loopback-only egress; degrades to the deterministic result.
    if (pathname === '/api/analyze/local') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use POST' });
      }
      if (!passesAnalyzeLocalOriginGate(req, res)) return;
      return handleAnalyzeLocal(req, res);
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

    // Lazy per-view dataset slices (#2443): /api/dataset/slice/<key>. The handler
    // allowlists <key> against the known heavy dataset keys.
    if (pathname.startsWith('/api/dataset/slice/')) {
      return handleDatasetSlice(req, res);
    }

    if (pathname === '/api/memories') {
      // Agent memories view (#458/#2558). Read the fixed-depth root + direct
      // archive Markdown surface, with canonical memory-root-relative names
      // and per-component read completeness. Fresh per request, like the other
      // host-coupled routes; parse-memories owns frontmatter/index parsing.
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      const memories = await readMemories(join(CLAUDE, 'projects'));
      return sendJson(res, 200, memories);
    }

    if (pathname === '/api/workflows') {
      // Workflow Run Ledger (#435/#2713). Walk every authorized projects root's
      // <slug>/<sessionId>/workflows/wf_*.json manifest
      // (written on completion of a Workflow-tool run), project it to the
      // ledger fields, and return runs newest-first. Read fresh per request;
      // the manifest JSON itself is NOT merged into readMergedSession / ingest
      // (those now merge the nested agent-*.jsonl TRANSCRIPTS — #636 — but not
      // this wf_*.json manifest; see REFERENCES.md). Post-hoc ledger, not a
      // live monitor.
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Method not allowed; use GET' });
      }
      const workflows = await readWorkflows(
        PROJECT_ROOTS,
        { allowRootSymlinks: true }
      );
      return sendJson(res, 200, workflows);
    }

    if (pathname === '/api/experiments.json') {
      // Experiment-axis evaluator (#2242). Server-only — reads the live
      // enrollment ledger + the measured BFC metric and returns per-axis
      // verdicts. handleExperimentsJson fails open (no ledger -> { axes: [] }).
      await handleExperimentsJson(req, res);
      return;
    }

    if (pathname === '/api/shadow-experiments.json') {
      // Shadow-calls per-experiment drill-down feed (#2152). Fresh tail-capped
      // ledger read per request; every bound surfaced (ledgerTruncated /
      // rowsDropped), newest-first limit/offset pagination.
      await handleShadowExperimentsJson(req, res);
      return;
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
        sendAuditResponse(req, res, {
          status: 'skipped',
          findings,
          disabled: true,
          reason: disabledReason,
        });
        return;
      }
      let auditStatus = 'ran';
      let auditReason;
      try {
        const auditChat = ({ model, system, maxTokens, messages, containsClaudeData }) => {
          const boundedMaxTokens = auditMaxOutputTokens(maxTokens);
          const scrubbed = egressScrub(
            'server.audit-judge',
            {
              model: model || DASHBOARD_AUDIT_MODEL,
              max_tokens: boundedMaxTokens,
              ...(system ? { system } : {}),
              messages,
            },
            {
              // The scrub receipt only fed the retired enterprise audit log
              // (#3839); single-user mode never recorded it.
              logger: () => {},
            }
          );
          return callAnthropicMessages('server.audit-judge', {
            apiKey,
            scrubbedBody: scrubbed,
            // Carry the judge's data classification to the chokepoint (#3111)
            // so ~/.claude-derived prompts can never ride an OAuth credential.
            containsClaudeData: containsClaudeData === true,
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
        const ingestApi = await globalDatasetState.apiPromise;
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
      const manifest = await buildManifest(PROJECT_ROOTS);
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
          CLAUDE,
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
      const sourceRoot = dataSourceClaudeRoot(sourceId);
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
      const sourceProjectsRoot = dataSourceProjectsRoot(sourceId);
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
      const ingestApi = await globalDatasetState.apiPromise;
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
      const ingestApi = await globalDatasetState.apiPromise;
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
      const ingestApi = await globalDatasetState.apiPromise;
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
      const ingestApi = await globalDatasetState.apiPromise;
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
          PROJECT_ROOTS
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
