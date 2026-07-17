// Sample #539 ingest artifacts for the marketing SPA (epic #539; follows the
// sample-memories.ts / sample-workflows.ts pattern from #537/#526).
//
// The 11 #539 artifacts (tasks, teams, sessions, telemetry, debug, stats-cache,
// file-history, plans, last-update, mcp-auth, backups) are SERVER-ONLY: they are
// read live from `~/.claude/` and CANNOT ride the upload zip (the uploader keeps
// only `.jsonl`). In the SPA the dataset omits them, so the five new views (Task
// Health, Team Coordination, Task Plans, Pulse, Agent Report Card) and the
// #539 detectors would render empty in demo mode. This module ships representative
// data in the exact shapes those views/parsers consume, so App.tsx can inject it
// when sample mode activates — the same role sample-memories / sample-workflows
// play for their server-only surfaces.
//
// Kept in ONE module (not one-file-per-artifact) because the Agent Report Card
// (#572) JOINS sessions + telemetry + debug on a shared set of session ids; those
// three generators must stay mutually consistent to produce a sensible
// KEEP/FLAG/MOVE spread, so they live together. Lazy-imported (only when demo
// mode turns on). Content is entirely synthetic — no real paths/secrets, no
// `/api/` literals (spa-boundary clean).

import type { TaskRecord } from './parse-tasks';
import type { TeamSummary } from './parse-teams';
import type { PlanSignature } from './parse-plans';
import type { StatsCache } from './parse-stats-cache';
import type { SessionRegistryEntry } from './parse-session-registry';
import type { TelemetryEvent } from './parse-telemetry';
import type { DebugSessionMetrics } from './parse-debug';
import type { FileHistorySession } from './parse-file-history';
import type { UpdateResult } from './parse-last-update';
import type { McpAuthState } from './parse-mcp-auth';
import type { DriftEvent } from './parse-backups';
import type { LiveConfig, LiveResource, DeceitSignals } from '../types';
import type { AdoptionReceipt } from './adoption-receipts';
import type { RepoMapDataset } from './parse-repo-map-join';
import { ingestModelEvalResults, type ModelEvalSummary } from './model-eval-ingest';
import { parseShadowCalls, type ShadowCallAggregate } from './parse-shadow-calls';
// @ts-expect-error - plain ESM build helper, no .d.ts
import { buildSampleAdoptionReceipts as buildRawSampleAdoptionReceipts, buildSampleModelEvalResults, SAMPLE_ADOPTION_CLAUDE_MD_HUNK } from '../../scripts/sample-data/build-corpus.mjs';

const DAY = 24 * 60 * 60 * 1000;

// Env fingerprint shared by the synthetic telemetry events (same box).
const ENV = {
  node_version: 'v22.14.0',
  terminal: 'tmux',
  wsl_version: '2',
  linux_distro_id: 'ubuntu',
  arch: 'x64',
  build_time: '2026-05-20T00:00:00Z',
};

/**
 * Tasks across a few demo sessions, bound to the loaded sample session ids so
 * the Task Health "open session" link resolves (mirrors sample-workflows). One
 * session is intentionally COLD with open tasks (→ workflow.abandoned-tasks) and
 * one carries a blocked DAG pileup (→ workflow.blocked-task-pileup).
 */
export function buildSampleTasks(
  sessionIds: string[],
  nowMs: number = Date.now()
): TaskRecord[] {
  const sid = (i: number): string => sessionIds[i % sessionIds.length] ?? `demo-session-${i}`;
  const base = (over: Partial<TaskRecord>): TaskRecord => ({
    id: 't',
    subject: '',
    description: '',
    activeForm: '',
    owner: '',
    status: 'completed',
    blocks: [],
    blockedBy: [],
    sessionId: sid(0),
    mtimeMs: nowMs - DAY,
    ...over,
  });

  return [
    // Session 0 — healthy, mostly completed, one with a PR link.
    base({ id: 's0-1', subject: 'Add cursor pagination to orders', status: 'completed', sessionId: sid(0), pr: 'https://github.com/acme/web/pull/482' }),
    base({ id: 's0-2', subject: 'Backfill order_created_at index', status: 'completed', sessionId: sid(0) }),
    base({ id: 's0-3', subject: 'Wire the new chart lib', status: 'in_progress', sessionId: sid(0), mtimeMs: nowMs - 2 * DAY }),

    // Session 1 — COLD (idle ~11d) with open tasks → abandoned-tasks fires.
    base({ id: 's1-1', subject: 'Migrate auth middleware', status: 'pending', sessionId: sid(1), mtimeMs: nowMs - 11 * DAY }),
    base({ id: 's1-2', subject: 'Add refresh-token rotation', status: 'in_progress', sessionId: sid(1), mtimeMs: nowMs - 11 * DAY }),

    // Session 2 — a blocked pileup behind an unfinished root → pileup fires.
    base({ id: 'root', subject: 'Retrain fraud model v7', status: 'pending', sessionId: sid(2), mtimeMs: nowMs - 3 * DAY }),
    base({ id: 's2-a', subject: 'Build eval harness', status: 'pending', blockedBy: ['root'], sessionId: sid(2), mtimeMs: nowMs - 3 * DAY }),
    base({ id: 's2-b', subject: 'Ship scoring dashboard', status: 'pending', blockedBy: ['root'], sessionId: sid(2), mtimeMs: nowMs - 3 * DAY }),
    base({ id: 's2-c', subject: 'Roll out to staging', status: 'completed', sessionId: sid(2) }),
  ];
}

/**
 * Team inbox health (post-analyze TeamSummary[]). One team has a stalled agent
 * and >50% dropped assignments (→ reliability.dropped-assignments); one healthy.
 */
export function buildSampleTeams(): TeamSummary[] {
  return [
    {
      teamId: 'fraud-ml-sprint',
      totalAssignments: 4,
      droppedCount: 3,
      droppedPct: 75,
      droppedAssignments: [
        { agent: 'worker-eval', taskId: 'a1', subject: 'Build eval harness', ageMinutes: 142 },
        { agent: 'worker-eval', taskId: 'a2', subject: 'Wire scoring metrics', ageMinutes: 138 },
        { agent: 'worker-dash', taskId: 'a3', subject: 'Ship scoring dashboard', ageMinutes: 96 },
      ],
      stalledAgents: [{ agent: 'worker-eval', unreadCount: 2 }],
    },
    {
      teamId: 'docs-refresh',
      totalAssignments: 3,
      droppedCount: 0,
      droppedPct: 0,
      droppedAssignments: [],
      stalledAgents: [],
    },
  ];
}

/**
 * Plan signatures across the three shapes. Several large plans (>=6 file refs or
 * >=1000 words) lack a Verification section (→ workflow.plan-missing-verification)
 * and the spread gives clusterPlans a clean A/B/C separation for the scatter.
 */
export function buildSamplePlans(): PlanSignature[] {
  return [
    // Tight surgical fixes (A)
    { name: 'fix-cart-null-guard', id: 'fix-cart-null-guard', sections: 2, fileRefs: 1, words: 180, hasVerification: true },
    { name: 'bump-axios-cve', id: 'bump-axios-cve', sections: 2, fileRefs: 1, words: 140, hasVerification: true },
    { name: 'rename-feature-flag', id: 'rename-feature-flag', sections: 3, fileRefs: 2, words: 240, hasVerification: false },
    { name: 'add-retry-after-header', id: 'add-retry-after-header', sections: 3, fileRefs: 2, words: 320, hasVerification: true },
    // Verified multi-file builds (B)
    { name: 'cursor-pagination', id: 'cursor-pagination', sections: 5, fileRefs: 6, words: 820, hasVerification: true },
    { name: 'chart-lib-migration', id: 'chart-lib-migration', sections: 6, fileRefs: 7, words: 940, hasVerification: true },
    { name: 'auth-middleware-rework', id: 'auth-middleware-rework', sections: 6, fileRefs: 8, words: 1120, hasVerification: false },
    // Sprawling campaigns (C) — large, mostly missing Verification
    { name: 'fraud-model-v7-rollout', id: 'fraud-model-v7-rollout', sections: 9, fileRefs: 14, words: 2200, hasVerification: false },
    { name: 'multi-tenant-coach', id: 'multi-tenant-coach', sections: 11, fileRefs: 18, words: 3100, hasVerification: false },
    { name: 'observability-overhaul', id: 'observability-overhaul', sections: 8, fileRefs: 12, words: 1850, hasVerification: false },
    { name: 'billing-rework-campaign', id: 'billing-rework-campaign', sections: 10, fileRefs: 11, words: 1600, hasVerification: true },
    { name: 'docs-site-rebuild', id: 'docs-site-rebuild', sections: 7, fileRefs: 9, words: 1300, hasVerification: false },
  ];
}

/**
 * CLI daily-activity rollup. The last 7 days run materially hotter than the
 * prior 7 (→ activity.activity-trend "hotter"), and the sparkline shows the ramp.
 */
export function buildSampleStatsCache(nowMs: number = Date.now()): StatsCache {
  const dailyActivity = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(nowMs - (13 - i) * DAY);
    const date = d.toISOString().slice(0, 10);
    const hot = i >= 7;
    const toolCallCount = hot ? 900 + (i - 7) * 180 : 220 + i * 12;
    return {
      date,
      messageCount: Math.round(toolCallCount * 0.6),
      sessionCount: hot ? 6 + (i - 7) : 3,
      toolCallCount,
    };
  });
  return {
    version: 3,
    lastComputedDate: new Date(nowMs).toISOString().slice(0, 10),
    dailyActivity,
  };
}

// ── Agent Report Card trio (#572) — sessions + telemetry + debug, joined on a
// shared set of synthetic session ids to yield KEEP×1 / FLAG×1 / MOVE×2. ───────

interface DemoProject {
  cwd: string;
  entrypoints: string[]; // one per session
  ids: string[];
}
const DEMO_PROJECTS: DemoProject[] = [
  // committed cli, clean → KEEP
  { cwd: '/home/dev/acme-web', entrypoints: ['cli', 'cli', 'cli', 'cli', 'cli'], ids: ['acme-1', 'acme-2', 'acme-3', 'acme-4', 'acme-5'] },
  // committed sdk-cli, heavy reliability drag → MOVE
  { cwd: '/home/dev/data-pipeline', entrypoints: ['sdk-cli', 'sdk-cli', 'sdk-cli', 'sdk-cli'], ids: ['dp-1', 'dp-2', 'dp-3', 'dp-4'] },
  // split cli/sdk-cli → FLAG
  { cwd: '/home/dev/mobile-app', entrypoints: ['cli', 'cli', 'sdk-cli', 'sdk-cli'], ids: ['mob-1', 'mob-2', 'mob-3', 'mob-4'] },
  // low-signal (<=2 sessions) → MOVE
  { cwd: '/home/dev/spike-llm-eval', entrypoints: ['cli', 'cli'], ids: ['spk-1', 'spk-2'] },
];

export function buildSampleSessionRegistry(nowMs: number = Date.now()): SessionRegistryEntry[] {
  const out: SessionRegistryEntry[] = [];
  let pid = 41000;
  for (const p of DEMO_PROJECTS) {
    p.ids.forEach((id, i) => {
      const entrypoint = p.entrypoints[i] ?? 'cli';
      out.push({
        pid: pid++,
        sessionId: id,
        cwd: p.cwd,
        startedAt: nowMs - (i + 1) * DAY,
        procStart: '998877',
        version: i % 2 === 0 ? '2.1.161' : '2.1.150',
        peerProtocol: 1,
        // kind reports "interactive" even for sdk-cli — the auditable anomaly the
        // report card surfaces; attribution is on entrypoint, never kind.
        kind: 'interactive',
        entrypoint,
      });
    });
  }
  return out;
}

export function buildSampleTelemetry(): TelemetryEvent[] {
  // Only data-pipeline storms: retry attempts >=8 with long elapsed_ms.
  const dp = DEMO_PROJECTS[1];
  const out: TelemetryEvent[] = [];
  dp.ids.forEach((id) => {
    out.push({
      event_name: 'tengu_api_slow_first_byte',
      client_timestamp: '2026-05-28T00:00:00Z',
      model: 'claude-opus-4-8',
      betas: '',
      session_id: id,
      attempt: 9,
      elapsed_ms: 30001,
      env: ENV,
    });
    out.push({
      event_name: 'tengu_api_error',
      client_timestamp: '2026-05-28T00:01:00Z',
      model: 'claude-opus-4-8',
      betas: '',
      session_id: id,
      attempt: 2,
      elapsed_ms: 1200,
      env: ENV,
    });
  });
  return out;
}

export function buildSampleDebugLogs(): DebugSessionMetrics[] {
  const out: DebugSessionMetrics[] = [];
  // data-pipeline: heavy TTFB tail + fast-mode-lost on the SDK path.
  for (const id of DEMO_PROJECTS[1].ids) {
    out.push({
      sessionId: id,
      ttfbP50: 6200,
      ttfbP90: 13000,
      ttfbMax: 14800,
      ttfbSampleCount: 24,
      maxRetryAttempt: 9,
      slowFirstByteCount: 4,
      fastModeLostCount: 130,
      isSdkCli: true,
    });
  }
  // acme-web: clean, fast (keeps KEEP a clean KEEP).
  for (const id of DEMO_PROJECTS[0].ids.slice(0, 2)) {
    out.push({
      sessionId: id,
      ttfbP50: 700,
      ttfbP90: 1400,
      ttfbMax: 2100,
      ttfbSampleCount: 30,
      maxRetryAttempt: 1,
      slowFirstByteCount: 0,
      fastModeLostCount: 0,
      isSdkCli: false,
    });
  }
  return out;
}

// ── Detector-only artifacts (no dedicated view; surface in Recommendations) ───

/**
 * file-history rework signatures (#564). One high-churn / high-burst session
 * (→ workflow.rework-signature) among calmer ones; >=3 sessions so the detector
 * has a population to rank.
 */
export function buildSampleFileHistory(nowMs: number = Date.now()): FileHistorySession[] {
  const mk = (
    sessionId: string,
    churn: number,
    spanMin: number
  ): FileHistorySession => {
    const burstRate = Math.round((churn / Math.max(1, spanMin)) * 100) / 100;
    return {
      sessionId,
      churn,
      spanMin,
      burstRate,
      reworkScore: Math.round(churn * (1 + burstRate) * 10) / 10,
      firstMs: nowMs - 2 * DAY,
      lastMs: nowMs - 2 * DAY + spanMin * 60 * 1000,
    };
  };
  return [
    mk('dp-1', 12, 2), // retry-storm shape: high churn, tight burst → top reworkScore
    mk('acme-3', 4, 26), // calm: spread-out edits
    mk('mob-2', 3, 18),
    mk('acme-1', 2, 31),
  ];
}

/**
 * CLI self-update outcomes (#566). The live file holds one record; this demo
 * series shows what a captured history looks like — two failures lower the
 * success rate (→ reliability.self-update-health).
 */
export function buildSampleUpdateResults(): UpdateResult[] {
  return [
    { timestamp: '2026-05-10T02:00:00Z', path: 'npm-global', outcome: 'success', version_from: '2.1.140', version_to: '2.1.148' },
    { timestamp: '2026-05-17T02:00:00Z', path: 'npm-global', outcome: 'failure', error_code: 'EACCES', version_from: '2.1.148', version_to: '2.1.148' },
    { timestamp: '2026-05-24T02:00:00Z', path: 'npm-global', outcome: 'success', version_from: '2.1.148', version_to: '2.1.157' },
    { timestamp: '2026-05-31T02:00:00Z', path: 'npm-global', outcome: 'failure', error_code: 'ENETUNREACH', version_from: '2.1.157', version_to: '2.1.157' },
    { timestamp: '2026-06-01T02:00:00Z', path: 'npm-global', outcome: 'success', version_from: '2.1.157', version_to: '2.1.161' },
  ];
}

/**
 * MCP servers needing interactive re-auth (#567) → reliability.mcp-needs-auth.
 * Live `{}` means "clear"; the demo shows the populated (gated) state.
 */
export function buildSampleMcpAuth(): McpAuthState {
  return {
    serversNeedingAuth: ['github', 'cloudflare-api', 'notion'],
    entries: {
      github: { needsAuth: true, reason: 'OAuth token expired', serverType: 'remote', transport: 'sse' },
      'cloudflare-api': { needsAuth: true, reason: 'refresh token revoked', serverType: 'remote', transport: 'http' },
      notion: { needsAuth: true, reason: 'workspace re-consent required', serverType: 'remote', transport: 'sse' },
    },
  };
}

/**
 * Config-drift events from the `~/.claude.json` backup history (#568) →
 * reliability.config-drift. Recent (within the 7-day window) project-scoped
 * events, headlined by a server moving into disabledMcpjsonServers.
 */
export function buildSampleConfigBackups(nowMs: number = Date.now()): DriftEvent[] {
  const proj = '/home/dev/acme-web';
  return [
    { kind: 'server-disabled', project: proj, server: 'postgres', from: true, to: false, timestamp: nowMs - 2 * DAY, severity: 'warning' },
    { kind: 'trust-flip', project: proj, from: true, to: false, timestamp: nowMs - 3 * DAY, severity: 'warning' },
    { kind: 'enable-all-flip', project: '/home/dev/mobile-app', from: false, to: true, timestamp: nowMs - 5 * DAY, severity: 'warning' },
    { kind: 'repo-server-appeared', project: proj, server: 'playwright', from: undefined, to: 'playwright', timestamp: nowMs - 6 * DAY, severity: 'info' },
  ];
}

// Sample liveConfig for the marketing SPA (#669). Real liveConfig is server-only
// (assembled from ~/.claude in ingest.mjs and absent from the upload zip), so in
// demo mode the config-hygiene "unused installed X" detectors are dark. This
// ships a representative installed-resource set: a few resources whose ids match
// the corpus's native attribution (code-review skill; code-explorer +
// general-purpose agents) so they read as USED, plus >=3 unused per family so
// workflow.unused-installed-{skills,subagents,commands} each fire. The sample
// corpus emits no <command-name> markers, so every sample command reads unused.
const res = (id: string, dir: 'skills' | 'agents' | 'commands'): LiveResource => ({
  id,
  scope: 'user',
  path: `/home/dev/.claude/${dir}/${id}${dir === 'skills' ? '/SKILL.md' : '.md'}`,
});

export function buildSampleLiveConfig(): LiveConfig {
  return {
    settings: {},
    settingsHealth: null,
    claudeMd: {
      // The adoption hunk is appended so the Adoption Card's ADOPTED row — which
      // extracts the matching section live by `markerHeading` (#578) — resolves
      // against the same heading the sample SUPPRESSED receipt records.
      global: `# Working agreements\n\nPrefer small PRs; run lint + build before committing.\n\n${SAMPLE_ADOPTION_CLAUDE_MD_HUNK}\n`,
      perProject: {},
    },
    plugins: [],
    mcpServers: [],
    // `code-review` is exercised by the corpus attribution → used; the rest have
    // no invocations → unused (>=3 trips workflow.unused-installed-skills).
    skills: ['code-review', 'pdf-export', 'csv-import', 'changelog-gen', 'translate-docs'].map(
      (id) => res(id, 'skills')
    ),
    // `code-explorer` + `general-purpose` are exercised by the corpus → used;
    // the rest are unused.
    subagents: [
      'code-explorer',
      'general-purpose',
      'security-auditor',
      'perf-profiler',
      'doc-writer',
      'sql-optimizer',
    ].map((id) => res(id, 'agents')),
    // No command invocations in the corpus → all unused.
    commands: ['deploy', 'sync-issues', 'standup', 'release-notes'].map((id) => res(id, 'commands')),
  };
}

/**
 * One synthetic finding's full adoption lifecycle for the marketing SPA (#578,
 * epic #573, ADR 0005). Adoption receipts are server-only (they live in the
 * dashboard data dir and are read via `/api/adoption/receipts`, stubbed `[]` in
 * the SPA), so without this seed the Adoption Card only ever shows its "needs a
 * server" empty state in demo mode. Paired with the adoption hunk folded into
 * `buildSampleLiveConfig()`'s CLAUDE.md, the scorecard derives one card that
 * traverses SURFACED -> ADOPTED (live hunk present) -> SUPPRESSED. The receipts
 * are authored in `build-corpus.mjs` (the sample-data source of truth) and
 * re-exported here typed, mirroring how the corpus feeds the upload path.
 */
export function buildSampleAdoptionReceipts(): AdoptionReceipt[] {
  return buildRawSampleAdoptionReceipts() as AdoptionReceipt[];
}

/**
 * Model-eval summary for the marketing SPA's Model Evals workbench (#1388,
 * epic #975). The real `modelEvalSummary` is server-only: the live build rolls
 * up artifacts an external meta-runner drops into
 * `~/.claude/model-evals/results`, and uploads carry `null` by design (#1242)
 * — so without a seed the demo SPA could never showcase the workbench's
 * eval-results face. The raw completed-batch artifacts are authored in
 * `build-corpus.mjs` (the sample-data source of truth) and folded here through
 * the REAL ingest pipeline (`ingestModelEvalResults`, fail-closed sanitizer
 * included), so the demo summary is exactly what the live server would derive
 * from the same artifacts. `nowMs` pins `generatedAt` (tests inject a fixed
 * clock; App uses the default so the demo summary reads fresh, mirroring
 * buildSampleStatsCache).
 */
export function buildSampleModelEvalSummary(
  nowMs: number = Date.now()
): ModelEvalSummary {
  return ingestModelEvalResults(buildSampleModelEvalResults() as unknown[], () => new Date(nowMs));
}

/**
 * Per-session model-deceit signals (#685, epic #683) for the demo. Like
 * `assistantFeatures` and the #539 artifacts these are derived at ingest from
 * transcripts and so are absent from the upload zip — without an injected
 * sample the free-tier SPA's new `security.model-deceit` finding (#686/#688)
 * would never light up in demo mode. One flagged session carries a contradicted
 * success claim (→ a `security` warning); the rest stay clean so the finding is
 * a single, legible card rather than noise.
 */
export function buildSampleDeceitSignals(sessionIds: string[]): DeceitSignals[] {
  if (sessionIds.length === 0) return [];
  const [flagged, ...rest] = sessionIds;
  return [
    {
      sessionId: flagged,
      assistantTurnCount: 14,
      unbackedClaimCount: 1,
      contradictedClaimCount: 1,
      claimSnippets: [
        'All tests pass — the suite is green.',
        'I ran the migration and verified the rows landed.',
      ],
    },
    // A couple of clean sessions so the detector aggregates over a realistic
    // mix (flagged-vs-total) rather than a single all-bad corpus.
    ...rest.slice(0, 2).map((id) => ({
      sessionId: id,
      assistantTurnCount: 9,
      unbackedClaimCount: 0,
      contradictedClaimCount: 0,
      claimSnippets: [],
    })),
  ];
}

/**
 * Shadow-call ledger aggregate for the demo (epic #1852 / #1889). The ledger is
 * server/local-only — written by the shadow-calls experiment runner under
 * `~/.claude`, never in the upload zip — so the Shadow Calls view (#519) shows
 * only its "no ledger" empty state in demo mode. We ship a handful of synthetic
 * records in the exact ledger JSONL shape and run them through the REAL
 * {@link parseShadowCalls} so the aggregate is byte-identical to what the live
 * parser would produce (mirrors the model-eval seed's parse-the-real-shape
 * approach). Three axes with a realistic win/cost spread: a clear model-downshift
 * win (cheaper, mostly shadow wins), a marginal config-scoping edge, and a
 * plan-first axis the default usually beats.
 */
export function buildSampleShadowCalls(): ShadowCallAggregate {
  const rec = (o: unknown) => JSON.stringify(o);
  const lines = [
    rec({ mode: 'live', axis: 'model-downshift', judge: { winner: 'shadow' }, main: { tokens: 18200, costUsd: 0.42 }, shadow: { tokens: 19500, costUsd: 0.11 } }),
    rec({ mode: 'replay', axis: 'model-downshift', judge: { winner: 'shadow' }, main: { tokens: 15000, costUsd: 0.35 }, shadow: { tokens: 16100, costUsd: 0.09 } }),
    rec({ mode: 'replay', axis: 'model-downshift', judge: { winner: 'main' }, main: { tokens: 21000, costUsd: 0.50 }, shadow: { tokens: 22500, costUsd: 0.13 } }),
    rec({ mode: 'live', axis: 'model-downshift', judge: { winner: 'tie' }, main: { tokens: 9000, costUsd: 0.20 }, shadow: { tokens: 9800, costUsd: 0.06 } }),
    rec({ mode: 'live', axis: 'config-scoping', judge: { winner: 'shadow', adherenceRegressions: 0 }, main: { tokens: 28000, costUsd: 0.66 }, shadow: { tokens: 26000, costUsd: 0.60 } }),
    rec({ mode: 'replay', axis: 'config-scoping', judge: { winner: 'tie', adherenceRegressions: 0 }, main: { tokens: 25000, costUsd: 0.58 }, shadow: { tokens: 24000, costUsd: 0.56 } }),
    rec({ mode: 'replay', axis: 'plan-first', judge: { winner: 'main' }, main: { tokens: 12000, costUsd: 0.28 }, shadow: { tokens: 15000, costUsd: 0.34 } }),
    rec({ mode: 'replay', axis: 'plan-first', judge: { winner: 'shadow' }, main: { tokens: 14000, costUsd: 0.32 }, shadow: { tokens: 13000, costUsd: 0.30 } }),
  ];
  return parseShadowCalls(lines.join('\n'));
}

/**
 * Bounded structural repo map for the marketing SPA's repo-map context-waste
 * card (#1651, epic #1264; feature epic #871 / detector #890). The `repoMap`
 * join is SERVER-ONLY: the live build generates it host-side with the WASM
 * Tree-sitter parser and the read-only container consumes the JSON artifact
 * (ADR 0007), but the upload zip never carries one — so the demo SPA's
 * `context.repo-map-context-waste` card stays dark and a viewer sees no
 * evidence the repo-map / structural work accomplishes anything.
 *
 * This ships a small, hand-authored `RepoMapDataset` in the exact join shape
 * the detector consumes (NO parser invocation — no `web-tree-sitter` is pulled
 * into the SPA bundle or the server runtime image). Three files are read-only
 * (no churn), re-read across multiple sessions, and structurally pinnable: an
 * exported-API client (`stable-api`, also high-centrality), a config-backed
 * types module (`config-backed`), and a shared formatter (`stable-api`). The
 * remaining files are actively churned importers that lend the candidates their
 * centrality but never become candidates themselves (they carry no re-read
 * waste). The detector then surfaces exactly one card naming the three files,
 * their exported symbols, and the re-paid token cost.
 *
 * Fully synthetic — no real paths or secrets, no `/api/` literals (spa-boundary
 * clean) — and a pure literal, so the drift guard in `sample-artifacts.test.ts`
 * can assert the exact card it produces.
 */
export function buildSampleRepoMap(): RepoMapDataset {
  return {
    projects: [
      {
        root: '/home/dev/acme-web',
        generatedAtGitSha: '9f83a1c7d2e4b6058a1c3f7e9b2d4068c5a7e1f3',
        // Fabricated sample data carries no real remote identity (#2709); null
        // is the honest suppression default.
        repository: null,
        fileCount: 6,
        truncated: false,
        text:
          'src/lib/api-client.ts  interface ApiClient | createClient() | request()\n' +
          'src/types.ts  interface Order | type OrderStatus | interface ApiResponse\n' +
          'src/lib/format.ts  formatCurrency() | formatDate()\n' +
          'src/components/Dashboard.tsx  Dashboard()\n' +
          'src/components/Header.tsx  Header()\n' +
          'src/App.tsx  App()',
        files: [
          // Candidate 1 — exported, read-only API client re-read across 4
          // sessions; also imported by 3 files (stable-api wins over centrality).
          {
            path: 'src/lib/api-client.ts',
            symbols: [
              { name: 'ApiClient', kind: 'interface', exported: true, signature: 'export interface ApiClient', line: 8 },
              { name: 'createClient', kind: 'function', exported: true, signature: 'export function createClient(opts: ClientOptions): ApiClient', line: 24 },
              { name: 'request', kind: 'function', exported: true, signature: 'export function request<T>(path: string): Promise<T>', line: 41 },
            ],
            imports: ['./types', './format'],
            reread: { sessions: 4, totalReads: 9, totalEstimatedTokenWaste: 3200, maxPerSession: 3 },
            configSections: [],
            recommendations: [],
          },
          // Candidate 2 — config-backed types module, read-only, re-read across
          // 3 sessions (config-backed reason).
          {
            path: 'src/types.ts',
            symbols: [
              { name: 'Order', kind: 'interface', exported: true, signature: 'export interface Order', line: 3 },
              { name: 'OrderStatus', kind: 'type', exported: true, signature: "export type OrderStatus = 'open' | 'paid' | 'shipped'", line: 12 },
              { name: 'ApiResponse', kind: 'interface', exported: true, signature: 'export interface ApiResponse<T>', line: 18 },
            ],
            imports: [],
            reread: { sessions: 3, totalReads: 6, totalEstimatedTokenWaste: 2400, maxPerSession: 2 },
            configSections: ['Data model conventions'],
            recommendations: [],
          },
          // Candidate 3 — shared formatter, read-only, re-read across 2 sessions;
          // imported by 2 files (stable-api reason, also central).
          {
            path: 'src/lib/format.ts',
            symbols: [
              { name: 'formatCurrency', kind: 'function', exported: true, signature: 'export function formatCurrency(cents: number): string', line: 1 },
              { name: 'formatDate', kind: 'function', exported: true, signature: 'export function formatDate(ms: number): string', line: 9 },
            ],
            imports: ['./types'],
            reread: { sessions: 2, totalReads: 4, totalEstimatedTokenWaste: 1100, maxPerSession: 2 },
            configSections: [],
            recommendations: [],
          },
          // Importers — actively churned (not read-only) and never re-read, so
          // they only contribute centrality, never become candidates themselves.
          {
            path: 'src/components/Dashboard.tsx',
            symbols: [{ name: 'Dashboard', kind: 'function', exported: true, signature: 'export function Dashboard()', line: 14 }],
            imports: ['./Header', '../lib/api-client', '../lib/format', '../types'],
            churn: { filePath: 'src/components/Dashboard.tsx', churn: 18, edits: 14, writes: 4, sessions: 6, editsPerSession: 3 },
            configSections: [],
            recommendations: [],
          },
          {
            path: 'src/components/Header.tsx',
            symbols: [{ name: 'Header', kind: 'function', exported: true, signature: 'export function Header()', line: 6 }],
            imports: ['../lib/api-client', '../types'],
            churn: { filePath: 'src/components/Header.tsx', churn: 7, edits: 6, writes: 1, sessions: 4, editsPerSession: 1.75 },
            configSections: [],
            recommendations: [],
          },
          {
            path: 'src/App.tsx',
            symbols: [{ name: 'App', kind: 'function', exported: true, signature: 'export function App()', line: 20 }],
            imports: ['./components/Dashboard', './lib/api-client', './types'],
            churn: { filePath: 'src/App.tsx', churn: 31, edits: 22, writes: 9, sessions: 8, editsPerSession: 3.875 },
            configSections: [],
            recommendations: [],
          },
        ],
        configSections: [],
        configAttribution: [],
      },
    ],
  };
}
