/**
 * View-scope filtering (#2718) — the React-free, server-safe pure boundary that
 * owns the dashboard's masthead time/project narrowing. Extracted verbatim from
 * `view-registry.tsx` so the server runtime (which ships ZERO node_modules and
 * cannot import React) can reuse the exact same filtering logic the client
 * renders through. The Cost-route scope lives in the sibling `cost-scope.ts` so
 * that route-only code stays in the lazy Cost chunk rather than the eager shell.
 *
 * IMPORTANT: this module MUST stay React-free — it may only import from other
 * pure `src/lib/*` modules and `import type` from anywhere (types are erased at
 * compile). It imports `ViewData` from `view-registry` TYPE-ONLY: `view-registry`
 * imports VALUES from here, so a runtime import back the other way would be a
 * cycle. The type-only edge is erased, so there is no runtime cycle.
 */
import { groupByProjects } from './parse-history';
import { memoriesMatchProject } from './project-slug';
import { ALL_PROJECTS, presetToRange } from './routing-core';
import type { ViewData } from './view-registry';
import type { Session, SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { SessionTimeline as SessionTimelineData } from './parse-timeline';
import type { RuntimeEvents } from './parse-runtime-events';
import type { FileHistorySession } from './parse-file-history';
import type { ModelLatencySample, TelemetryEvent } from './parse-telemetry';
import type { SessionRegistryEntry } from './parse-session-registry';
import type { DashboardFilter, TimeRange } from './routing';

function timestampMs(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampInRange(
  value: number | string | null | undefined,
  range: TimeRange
): boolean {
  const ms = timestampMs(value);
  if (ms == null) return false;
  return (range.from == null || ms >= range.from) && (range.to == null || ms <= range.to);
}

function maxTimestamp(current: number | null, value: number | string | null | undefined) {
  const ms = timestampMs(value);
  if (ms == null) return current;
  return current == null ? ms : Math.max(current, ms);
}

function datasetNow(data: ViewData): number {
  let latest: number | null = null;
  for (const entry of data.entries) latest = maxTimestamp(latest, entry.timestamp);
  for (const session of data.sessions) {
    latest = maxTimestamp(latest, session.startTime);
    latest = maxTimestamp(latest, session.endTime);
  }
  for (const token of data.tokenData) {
    for (const entry of token.entries) latest = maxTimestamp(latest, entry.timestamp);
  }
  for (const timeline of data.timelines) {
    latest = maxTimestamp(latest, timeline.startTime);
    latest = maxTimestamp(latest, timeline.endTime);
  }
  return latest ?? Date.now();
}

function filterBySessionId<T extends { sessionId: string }>(
  rows: readonly T[],
  sessionIds: ReadonlySet<string>
): T[] {
  return rows.filter((row) => sessionIds.has(row.sessionId));
}

function filterTelemetryBySessionId(
  rows: readonly TelemetryEvent[],
  sessionIds: ReadonlySet<string>
): TelemetryEvent[] {
  return rows.filter((row) => sessionIds.has(row.session_id));
}

function filterModelLatencyBySessionId(
  rows: readonly ModelLatencySample[],
  sessionIds: ReadonlySet<string>
): ModelLatencySample[] {
  return rows.filter((row) => sessionIds.has(row.session_id));
}

function filterTokenDataByTime(
  rows: readonly SessionTokenData[],
  range: TimeRange
): SessionTokenData[] {
  return rows.flatMap((row) => {
    const entries = row.entries.filter((entry) =>
      timestampInRange(entry.timestamp, range)
    );
    const compactionEvents = row.compactionEvents.filter((event) =>
      timestampInRange(event.timestamp, range)
    );
    if (entries.length === 0 && compactionEvents.length === 0) return [];
    return [{
      ...row,
      totalInputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
      totalOutputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
      totalCacheCreationTokens: entries.reduce(
        (sum, entry) => sum + entry.cacheCreationTokens,
        0
      ),
      totalCacheReadTokens: entries.reduce(
        (sum, entry) => sum + entry.cacheReadTokens,
        0
      ),
      messageCount: entries.length,
      entries,
      compactionEvents,
    }];
  });
}

function filterToolDataByTime(
  rows: readonly ToolUsageData[],
  range: TimeRange
): ToolUsageData[] {
  return rows.flatMap((row) => {
    const calls = row.calls.filter((call) => timestampInRange(call.timestamp, range));
    return calls.length > 0 ? [{ ...row, calls }] : [];
  });
}

function filterTimelinesByTime(
  rows: readonly SessionTimelineData[],
  range: TimeRange
): SessionTimelineData[] {
  return rows.flatMap((row) => {
    const entries = row.entries.filter((entry) =>
      timestampInRange(entry.timestamp, range)
    );
    if (entries.length === 0) return [];
    return [{
      ...row,
      startTime: entries[0].timestamp,
      endTime: entries[entries.length - 1].timestamp,
      entries,
    }];
  });
}

function filterRuntimeEventsByTime(
  rows: readonly RuntimeEvents[],
  range: TimeRange
): RuntimeEvents[] {
  return rows.flatMap((row) => {
    const turns = row.turns.filter((event) =>
      timestampInRange(event.timestamp, range)
    );
    const stopHooks = row.stopHooks.filter((event) =>
      timestampInRange(event.timestamp, range)
    );
    const awaySummaries = row.awaySummaries.filter((event) =>
      timestampInRange(event.timestamp, range)
    );
    const scheduledFires = row.scheduledFires.filter((event) =>
      timestampInRange(event.timestamp, range)
    );
    if (
      turns.length === 0 &&
      stopHooks.length === 0 &&
      awaySummaries.length === 0 &&
      scheduledFires.length === 0
    ) {
      return [];
    }
    return [{ ...row, turns, stopHooks, awaySummaries, scheduledFires }];
  });
}

type FilterMode = 'filtered' | 'global';

interface ViewDataFilterPolicy {
  time: FilterMode;
  project: FilterMode;
}

export const VIEW_DATA_FILTER_POLICIES = {
  // Prompt rows drive all timeline and session views and have both timestamp
  // and project.
  entries: { time: 'filtered', project: 'filtered' },
  // Core session rollup is the filter primitive used by most derived page
  // data.
  sessions: { time: 'filtered', project: 'filtered' },
  // Project rollups are derived from filtered sessions and must always stay
  // aligned.
  projects: { time: 'filtered', project: 'filtered' },
  // Session-token data is keyed by timestamps and project metadata for both
  // filters.
  tokenData: { time: 'filtered', project: 'filtered' },
  // Tool calls attach to sessions, and filtering must match the selected
  // project/time window.
  toolData: { time: 'filtered', project: 'filtered' },
  // Tool availability is sampled per session and should follow session-scoped
  // filters.
  toolInventories: { time: 'filtered', project: 'filtered' },
  // Timeline entries have explicit timestamps and a session lineage.
  timelines: { time: 'filtered', project: 'filtered' },
  // API errors are session events with per-row timestamps.
  apiErrors: { time: 'filtered', project: 'filtered' },
  // Permission state is inferred from session IDs and timestamped by event
  // rows.
  permissionRows: { time: 'filtered', project: 'filtered' },
  // Permission changes are per-session events and should match global
  // filtering.
  permissionChanges: { time: 'filtered', project: 'filtered' },
  // Agent settings are session-scoped changes tracked with event timestamps.
  agentSettings: { time: 'filtered', project: 'filtered' },
  // Attribution is a per-session summary used in analysis and should narrow by
  // both filters.
  attribution: { time: 'filtered', project: 'filtered' },
  // Runtime hooks and turns are explicitly timestamped and session-scoped.
  runtimeEvents: { time: 'filtered', project: 'filtered' },
  // Task-steering metrics are per-task session metrics and should be narrowed.
  taskSteering: { time: 'filtered', project: 'filtered' },
  // Churn geometry is tied to session-derived file edit sessions and should
  // narrow.
  churnGeometry: { time: 'filtered', project: 'filtered' },
  // Value-flow edges are produced inside sessions and should match selected
  // context.
  valueFlow: { time: 'filtered', project: 'filtered' },
  // Task-success summaries are derived from session/task timestamps and IDs.
  taskSuccess: { time: 'filtered', project: 'filtered' },
  // Prompt assistant features are emitted per session and must follow
  // project/time.
  assistantFeatures: { time: 'filtered', project: 'filtered' },
  // Prompt analyses carry session and project identity and should be filtered
  // consistently.
  promptAnalysis: { time: 'filtered', project: 'filtered' },
  // Claims and deception checks are tied to session turns and therefore
  // filterable.
  deceitSignals: { time: 'filtered', project: 'filtered' },
  // Secret-at-rest counts and evidence coordinates are emitted per session.
  secretsAtRest: { time: 'filtered', project: 'filtered' },
  // Runtime config is a singleton-like artifact for the workspace.
  liveConfig: { time: 'global', project: 'global' },
  // Repo-map structure is cross-project infrastructure metadata for static
  // analysis.
  repoMap: { time: 'global', project: 'global' },
  // Repository documentation structure is a whole-checkout artifact.
  docGraph: { time: 'global', project: 'global' },
  // Shadow-call aggregate is server-side telemetry, not session-scoped for
  // this picker.
  shadowCalls: { time: 'global', project: 'global' },
  // Memories are grouped by project; time is intentionally unavailable.
  memories: { time: 'global', project: 'filtered' },
  // Workflow runs link to sessions and have start times, so both filters
  // apply.
  workflows: { time: 'filtered', project: 'filtered' },
  // Tasks are an aggregate artifact; kept global for now.
  tasks: { time: 'global', project: 'global' },
  // Team inbox summaries are not partitioned by workspace filter selection.
  teams: { time: 'global', project: 'global' },
  // Review dataset is an org-level aggregate, intentionally global.
  reviewEvents: { time: 'global', project: 'global' },
  // Session registry rows include session IDs and mtime, so they can be
  // narrowed safely.
  sessionRegistry: { time: 'filtered', project: 'filtered' },
  // Telemetry is timestamped and session-linked by session_id.
  telemetry: { time: 'filtered', project: 'filtered' },
  // Latency samples are time/windowed and linked by session_id for both
  // filters.
  modelLatency: { time: 'filtered', project: 'filtered' },
  // Debug metrics are emitted per session and should mirror other session
  // views.
  debugLogs: { time: 'filtered', project: 'filtered' },
  // Cached computed stats are aggregate, non-temporal snapshots.
  statsCache: { time: 'global', project: 'global' },
  // File history rows include session IDs and first/last mtime for window
  // filtering.
  fileHistory: { time: 'filtered', project: 'filtered' },
  // Plan signatures are static structural artifacts across sessions.
  plans: { time: 'global', project: 'global' },
  // Model-eval rollups are a whole-dataset model aggregate.
  modelEvalSummary: { time: 'global', project: 'global' },
  // Update-result records are global infra events consumed by maintenance
  // views.
  updateResults: { time: 'global', project: 'global' },
  // MCP auth snapshots are workspace-level and not window filter inputs.
  mcpAuth: { time: 'global', project: 'global' },
  // Configuration drift backups are historical audit artifacts.
  configBackups: { time: 'global', project: 'global' },
  // Guidance inputs are signed commit artifacts, intentionally global.
  externalGuidance: { time: 'global', project: 'global' },
  // Enterprise sessions are admin-level context, not part of picker slicing.
  enterpriseSession: { time: 'global', project: 'global' },
  // Adoption receipts are synthetic sample/demo aggregates in this build path.
  sampleAdoptionReceipts: { time: 'global', project: 'global' },
  // Source descriptors are static member attribution metadata for the session
  // list.
  sources: { time: 'global', project: 'global' },
} satisfies Record<keyof ViewData, ViewDataFilterPolicy>;

type TimeFilteredViewDataField = {
  [K in keyof typeof VIEW_DATA_FILTER_POLICIES]: (typeof VIEW_DATA_FILTER_POLICIES)[K]['time'] extends 'filtered'
    ? K
    : never;
}[keyof typeof VIEW_DATA_FILTER_POLICIES];

type ProjectFilteredViewDataField = {
  [K in keyof typeof VIEW_DATA_FILTER_POLICIES]: (
    typeof VIEW_DATA_FILTER_POLICIES
  )[K]['project'] extends 'filtered'
    ? K
    : never;
}[keyof typeof VIEW_DATA_FILTER_POLICIES];

type TimeFilterContext = {
  range: TimeRange;
  sessions: Session[];
  sessionIds: ReadonlySet<string>;
};

type ProjectFilterContext = {
  project: string;
  sessions: Session[];
  sessionIds: ReadonlySet<string>;
};

function fileHistoryOverlapsRange(
  row: FileHistorySession,
  range: TimeRange
): boolean {
  const to = range.to ?? Number.POSITIVE_INFINITY;
  const from = range.from ?? Number.NEGATIVE_INFINITY;
  return row.firstMs <= to && row.lastMs >= from;
}

// Combinator factories for the dispatch maps below. They keep each map entry
// tiny (the frozen first-paint shell budget, ADR 0016, is byte-tight) while the
// mapped-type annotations on the maps still force an exhaustive, per-key
// implementation whose return type matches ViewData[K]. The input casts are
// sound for every key used below: each factory filters data[key] without
// changing its element type.
// Fields filtered purely by session membership under BOTH the time and the
// project filter. Key strings live in one list (byte-tight frozen shell,
// ADR 0016); the Exclude<> mapped types on the dispatch maps below force every
// remaining field to have an explicit entry, so exhaustiveness is still
// compile-checked.
const SESSION_SCOPED_FIELDS = [
  'toolInventories',
  'permissionRows',
  'attribution',
  'taskSteering',
  'churnGeometry',
  'valueFlow',
  'taskSuccess',
  'assistantFeatures',
  'promptAnalysis',
  'deceitSignals',
  'secretsAtRest',
  'debugLogs',
] as const;

// Additional fields that are session-scoped for the project filter only
// (their time filtering uses their own timestamps instead).
const PROJECT_SESSION_SCOPED_FIELDS = [
  ...SESSION_SCOPED_FIELDS,
  'toolData',
  'timelines',
  'apiErrors',
  'permissionChanges',
  'agentSettings',
  'runtimeEvents',
  'workflows',
  'fileHistory',
] as const;

function collectSessionIds(
  sessions: readonly Session[],
  tokenData: readonly SessionTokenData[],
  sessionRegistry: readonly SessionRegistryEntry[]
): Set<string> {
  return new Set([
    ...sessions.map((session) => session.sessionId),
    ...tokenData.map((row) => row.sessionId),
    ...sessionRegistry.map((entry) => entry.sessionId),
  ]);
}

function applyFilterMaps<C extends { sessionIds: ReadonlySet<string> }>(
  data: ViewData,
  sessionKeys: readonly (keyof ViewData)[],
  map: { [K in keyof ViewData]?: (d: ViewData, c: C) => ViewData[K] },
  ctx: C
): ViewData {
  const out: Record<string, unknown> = { ...data };
  for (const key of sessionKeys) {
    out[key] = filterBySessionId(
      data[key] as unknown as readonly { sessionId: string }[],
      ctx.sessionIds
    );
  }
  for (const key in map) {
    out[key] = map[key as keyof ViewData]!(data, ctx);
  }
  return out as unknown as ViewData;
}

function byProjectEq<K extends keyof ViewData>(key: K) {
  return (data: ViewData, ctx: ProjectFilterContext): ViewData[K] =>
    (data[key] as unknown as readonly { project?: string }[]).filter(
      (item) => item.project === ctx.project
    ) as unknown as ViewData[K];
}

function byTimestamp<K extends keyof ViewData>(key: K, field = 'timestamp') {
  return (data: ViewData, ctx: TimeFilterContext): ViewData[K] =>
    (data[key] as unknown as readonly Record<string, string>[]).filter((row) =>
      timestampInRange(row[field], ctx.range)
    ) as unknown as ViewData[K];
}

const FILTER_BY_TIME: {
  [K in Exclude<TimeFilteredViewDataField, (typeof SESSION_SCOPED_FIELDS)[number]>]: (
    data: ViewData,
    ctx: TimeFilterContext
  ) => ViewData[K];
} = {
  entries: byTimestamp('entries'),
  sessions: (_, ctx) => ctx.sessions,
  projects: (_data, ctx) => groupByProjects(ctx.sessions),
  tokenData: (data, ctx) => filterTokenDataByTime(data.tokenData, ctx.range),
  toolData: (data, ctx) => filterToolDataByTime(data.toolData, ctx.range),
  timelines: (data, ctx) => filterTimelinesByTime(data.timelines, ctx.range),
  apiErrors: byTimestamp('apiErrors'),
  permissionChanges: byTimestamp('permissionChanges'),
  agentSettings: byTimestamp('agentSettings'),
  runtimeEvents: (data, ctx) => filterRuntimeEventsByTime(data.runtimeEvents, ctx.range),
  // Semantics: a run is kept when its own `startTime` falls in range OR its
  // parent session is in range. Session membership uses the same 3-source
  // `sessionIds` set (sessions + tokenData + sessionRegistry, all pre-filtered
  // to the range) that every other per-session field here uses, so a run whose
  // session is known only via tokenData/registry — and whose own `startTime`
  // is null — is not silently dropped.
  workflows: (data, ctx) =>
    data.workflows.filter((run) => {
      const ms = timestampMs(run.startTime);
      return (
        (ms != null && timestampInRange(ms, ctx.range)) ||
        (run.sessionId != null && ctx.sessionIds.has(run.sessionId))
      );
    }),
  sessionRegistry: byTimestamp('sessionRegistry', 'startedAt'),
  telemetry: byTimestamp('telemetry', 'client_timestamp'),
  modelLatency: byTimestamp('modelLatency', 'client_timestamp'),
  fileHistory: (data, ctx) =>
    data.fileHistory.filter((row) => fileHistoryOverlapsRange(row, ctx.range)),
};

const FILTER_BY_PROJECT: {
  [K in Exclude<
    ProjectFilteredViewDataField,
    (typeof PROJECT_SESSION_SCOPED_FIELDS)[number]
  >]: (data: ViewData, ctx: ProjectFilterContext) => ViewData[K];
} = {
  entries: byProjectEq('entries'),
  sessions: byProjectEq('sessions'),
  projects: byProjectEq('projects'),
  tokenData: byProjectEq('tokenData'),
  // `item.project` is the on-disk slug (e.g. `-home-dev-acme-web`) while
  // `ctx.project` is the cwd path (e.g. `/home/dev/acme-web`); join by slugging
  // the path. See `memoriesMatchProject`.
  memories: (data, ctx) =>
    data.memories.filter((item) => memoriesMatchProject(item.project, ctx.project)),
  sessionRegistry: (data, ctx) =>
    data.sessionRegistry.filter((entry) => entry.cwd === ctx.project),
  telemetry: (data, ctx) => filterTelemetryBySessionId(data.telemetry, ctx.sessionIds),
  modelLatency: (data, ctx) => filterModelLatencyBySessionId(data.modelLatency, ctx.sessionIds),
};

function applyTimeFilteredData(data: ViewData, filter: DashboardFilter): ViewData {
  if (filter.time === 'all') return data;
  const range = presetToRange(filter.time, datasetNow(data));
  const sessions = data.sessions.filter((session) =>
    timestampInRange(session.startTime, range)
  );
  const tokenData = filterTokenDataByTime(data.tokenData, range);
  const sessionRegistry = data.sessionRegistry.filter((entry) =>
    timestampInRange(entry.startedAt, range)
  );
  const sessionIds = collectSessionIds(sessions, tokenData, sessionRegistry);
  const context: TimeFilterContext = {
    range,
    sessions,
    sessionIds,
  };

  return applyFilterMaps(data, SESSION_SCOPED_FIELDS, FILTER_BY_TIME, context);
}

export function filterViewDataByTime(
  data: ViewData,
  filter: DashboardFilter
): ViewData {
  return applyTimeFilteredData(data, filter);
}

export function filterViewDataByProject(
  data: ViewData,
  filter: DashboardFilter
): ViewData {
  if (filter.project === ALL_PROJECTS) return data;

  const project = filter.project;
  const sessions = data.sessions.filter((session) => session.project === project);
  const tokenData = data.tokenData.filter((item) => item.project === project);
  const sessionRegistry = data.sessionRegistry.filter((entry) =>
    entry.cwd === project
  );
  const sessionIds = collectSessionIds(sessions, tokenData, sessionRegistry);
  return applyFilterMaps(data, PROJECT_SESSION_SCOPED_FIELDS, FILTER_BY_PROJECT, {
    project,
    sessions,
    sessionIds,
  });
}
