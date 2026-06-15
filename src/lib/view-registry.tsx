/* eslint-disable react-refresh/only-export-components --
 * This is a registry module, not a fast-refreshable component module: it
 * deliberately exports a render map + helpers alongside the (module-local) lazy
 * view components. Fast-refresh doesn't apply. */
/**
 * View registry (epic #490, #491) — the single declarative source of truth that
 * retires the `App.tsx` routing monolith (architecture-review Candidate C).
 *
 * Before this, adding or moving a view meant editing four places: the `View`
 * union (`types.ts`), the `NAV_ITEMS` catalog (`nav-prefs.ts`), a 22-branch
 * `currentView === 'x' && <X … />` block in `App.tsx`, and the lazy-import list
 * at the top of `App.tsx`. The render/prop wiring lived far from the view's
 * metadata. This module co-locates the **render closure** for every view next
 * to nothing but a shared {@link ViewContext}, so:
 *   - `App.tsx` renders the active view with one lookup: `renderView(view, ctx)`.
 *   - "field a new view" = add a `NAV_ITEMS` entry (metadata + domain) and one
 *     `VIEW_RENDERERS` closure here.
 *
 * Every component is lazy-loaded (as App did), so importing this module is cheap
 * — the closures hold `lazy()` wrappers; a view's code is fetched only when it
 * first renders. App keeps the single `<Suspense>` boundary around the result.
 */
import { lazy } from 'react';
import type { ReactNode } from 'react';
import { isDashboardFilterActive } from './filtered-empty';
import type {
  View,
  HistoryEntry,
  Session,
  ProjectStats,
  SessionTokenData,
  LiveConfig,
  AssistantFeatures,
  PromptAnalysis,
  DeceitSignals,
  ActionDomain,
} from '../types';
import type { ToolUsageData } from './parse-tools';
import type { ToolInventory } from './parse-tool-inventory';
import type { SessionTimeline as SessionTimelineData } from './parse-timeline';
import type { ApiErrorEvent } from './parse-errors';
import type { PermissionChange } from './parse-permissions';
import type { AgentSettingEvent, SessionAttribution } from './parse-agents';
import type { RuntimeEvents } from './parse-runtime-events';
import type { TaskSteering } from './parse-steering';
import type { ChurnGeometrySession } from './parse-churn-geometry';
import type { ValueFlowSession } from './parse-value-flow';
import type { TaskSuccessProxy } from './parse-task-success';
import type { ProjectMemories } from './parse-memories';
import type { WorkflowRun } from './parse-workflows';
// #539 ingest artifacts (server-only; empty on the SPA/upload dataset).
import type { TaskRecord } from './parse-tasks';
import type { TeamSummary } from './parse-teams';
import type { SessionRegistryEntry } from './parse-session-registry';
import type { ModelLatencySample, TelemetryEvent } from './parse-telemetry';
import type { DebugSessionMetrics } from './parse-debug';
import type { StatsCache } from './parse-stats-cache';
import type { FileHistorySession } from './parse-file-history';
import type { PlanSignature } from './parse-plans';
import type { UpdateResult } from './parse-last-update';
import type { McpAuthState } from './parse-mcp-auth';
import type { DriftEvent } from './parse-backups';
import type { AdoptionReceipt } from './adoption-receipts';
import type { ModelEvalSummary } from './model-eval-ingest';
import type { ExternalGuidance } from './external-guidance';
import type { RepoMapDataset } from './parse-repo-map-join';
import type { OrganizationReviewEventsDataset } from './organization-review-events';
import type { ShadowCallAggregate } from './parse-shadow-calls';
import type { EvidenceRef } from './evidence';
import type { EnterpriseSession } from '@api-client';
import { groupByProjects } from './parse-history';
import {
  ALL_PROJECTS,
  presetToRange,
  type DashboardFilter,
  type TimeRange,
} from './routing';

// ── Lazy view components (moved verbatim from App.tsx) ─────────────────────
const DigestSpine = lazy(() =>
  import('../components/DigestSpine').then((m) => ({ default: m.DigestSpine }))
);
const FilteredEmptyState = lazy(() =>
  import('../components/FilteredEmptyState').then((m) => ({
    default: m.FilteredEmptyState,
  }))
);
const Recommendations = lazy(() =>
  import('../components/Recommendations').then((m) => ({
    default: m.RecommendationsPf,
  }))
);
const EvaluatorLanding = lazy(() =>
  import('../components/EvaluatorLanding').then((m) => ({
    default: m.EvaluatorLandingPf,
  }))
);
const SessionList = lazy(() =>
  import('../components/SessionList').then((m) => ({ default: m.SessionListPf }))
);
const ProjectBreakdown = lazy(() =>
  import('../components/ProjectBreakdown').then((m) => ({
    default: m.ProjectBreakdownPf,
  }))
);
const SearchView = lazy(() =>
  import('../components/SearchView').then((m) => ({ default: m.SearchViewPf }))
);
const TokenUsage = lazy(() =>
  import('../components/TokenUsage').then((m) => ({ default: m.TokenUsagePf }))
);
const ToolUsage = lazy(() =>
  import('../components/ToolUsage').then((m) => ({ default: m.ToolUsagePf }))
);
const FileImpact = lazy(() =>
  import('../components/FileImpact').then((m) => ({ default: m.FileImpactPf }))
);
const CostAttribution = lazy(() =>
  import('../components/CostAttribution').then((m) => ({
    default: m.CostAttributionPf,
  }))
);
// Token-spend Summary view (epic #730) — consolidating cost surface. Ships as an
// empty shell here (#731); the by-project/by-day/distribution panels fill it in
// (#737, #732-#736). SPA-safe (derives from transcripts; no server call).
const SummaryView = lazy(() =>
  import('../components/SummaryView').then((m) => ({ default: m.SummaryView }))
);
const SessionTimeline = lazy(() =>
  import('../components/SessionTimeline').then((m) => ({
    default: m.SessionTimelinePf,
  }))
);
const ProjectActivity = lazy(() =>
  import('../components/ProjectActivity').then((m) => ({
    default: m.ProjectActivityPf,
  }))
);
const ErrorRetry = lazy(() =>
  import('../components/ErrorRetry').then((m) => ({ default: m.ErrorRetryPf }))
);
const Permissions = lazy(() =>
  import('../components/Permissions').then((m) => ({ default: m.PermissionsPf }))
);
const AutomationView = lazy(() =>
  import('../components/AutomationView').then((m) => ({
    default: m.AutomationViewPf,
  }))
);
const AgentSkill = lazy(() =>
  import('../components/AgentSkill').then((m) => ({ default: m.AgentSkillPf }))
);
const Memories = lazy(() =>
  import('../components/Memories').then((m) => ({ default: m.MemoriesPf }))
);
const WorkflowList = lazy(() =>
  import('../components/WorkflowList').then((m) => ({ default: m.WorkflowListPf }))
);
const PromptAnalyzer = lazy(() =>
  import('../components/PromptAnalyzer').then((m) => ({
    default: m.PromptAnalyzerPf,
  }))
);
const ContextHealth = lazy(() =>
  import('../components/ContextHealth').then((m) => ({
    default: m.ContextHealthPf,
  }))
);
const ConversationPatterns = lazy(() =>
  import('../components/ConversationPatterns').then((m) => ({
    default: m.ConversationPatternsPf,
  }))
);
const SessionPatterns = lazy(() =>
  import('../components/SessionPatterns').then((m) => ({
    default: m.SessionPatternsPf,
  }))
);
// #539 artifact views (#559–#569, #572)
const AgentReportCard = lazy(() =>
  import('../components/AgentReportCardPf').then((m) => ({
    default: m.AgentReportCardPf,
  }))
);
const ReviewQueue = lazy(() =>
  import('../components/ReviewQueuePf').then((m) => ({
    default: m.ReviewQueuePf,
  }))
);
const TaskHealth = lazy(() =>
  import('../components/TaskHealthPf').then((m) => ({ default: m.TaskHealthPf }))
);
const TeamCoordination = lazy(() =>
  import('../components/TeamCoordinationPf').then((m) => ({
    default: m.TeamCoordinationPf,
  }))
);
const PlanShapes = lazy(() =>
  import('../components/PlanShapesPf').then((m) => ({ default: m.PlanShapesPf }))
);
const UsagePulse = lazy(() =>
  import('../components/UsagePulsePf').then((m) => ({ default: m.UsagePulsePf }))
);
const DiaryView = lazy(() =>
  import('../components/DiaryView').then((m) => ({ default: m.DiaryView }))
);
const ShadowCalls = lazy(() =>
  import('../components/ShadowCallsPf').then((m) => ({ default: m.ShadowCallsPf }))
);
// Model Evals workbench (#1086, epic #975). The eval-results face is
// server-only (`modelEvalSummary` is null on the SPA dataset); the mined
// gap-cluster face derives from the already-fetched parsed dataset.
const ModelEvals = lazy(() =>
  import('../components/ModelEvalsPf').then((m) => ({ default: m.ModelEvalsPf }))
);
// Recs Adoption Scorecard (#577, ADR 0005 "Demo artifact"). Server-only: it
// self-fetches the dashboard-owned receipt store; the SPA stub returns [].
const AdoptionScorecard = lazy(() =>
  import('../components/AdoptionScorecard').then((m) => ({
    default: m.AdoptionScorecardPf,
  }))
);
// Server-tier session provisioning (#1251); kept out of the upload-only SPA bundle.
const SessionProvisioning = lazy(() =>
  import('../components/SessionProvisioning').then((m) => ({
    default: m.SessionProvisioningPf,
  }))
);
// Keep the admin-only live-server view out of the upload-only SPA bundle.
const EnterpriseAdminUnavailable = () => null;
const EnterpriseAdmin =
  import.meta.env.MODE === 'spa'
    ? EnterpriseAdminUnavailable
    : lazy(() =>
        import('../components/EnterpriseAdmin').then((m) => ({
          default: m.EnterpriseAdmin,
        }))
      );

// ── Shared render context ──────────────────────────────────────────────────
/** The parsed `~/.claude` dataset every view draws from. Assembled once in App. */
export interface ViewData {
  entries: HistoryEntry[];
  sessions: Session[];
  projects: ProjectStats[];
  tokenData: SessionTokenData[];
  toolData: ToolUsageData[];
  toolInventories: ToolInventory[];
  timelines: SessionTimelineData[];
  apiErrors: ApiErrorEvent[];
  permissionRows: { mode: string; sessionId: string }[];
  permissionChanges: PermissionChange[];
  agentSettings: AgentSettingEvent[];
  attribution: SessionAttribution[];
  runtimeEvents: RuntimeEvents[];
  taskSteering: TaskSteering[];
  churnGeometry: ChurnGeometrySession[];
  valueFlow: ValueFlowSession[];
  taskSuccess: TaskSuccessProxy[];
  assistantFeatures: AssistantFeatures[];
  promptAnalysis: PromptAnalysis[];
  deceitSignals: DeceitSignals[];
  liveConfig: LiveConfig | null;
  repoMap: RepoMapDataset | null;
  shadowCalls: ShadowCallAggregate | null;
  memories: ProjectMemories[];
  workflows: WorkflowRun[];
  // Server aggregate artifacts (empty arrays/null on the SPA dataset).
  tasks: TaskRecord[];
  teams: TeamSummary[];
  reviewEvents: OrganizationReviewEventsDataset | null;
  sessionRegistry: SessionRegistryEntry[];
  telemetry: TelemetryEvent[];
  modelLatency: ModelLatencySample[];
  debugLogs: DebugSessionMetrics[];
  statsCache: StatsCache | null;
  fileHistory: FileHistorySession[];
  plans: PlanSignature[];
  /** Model-eval results rollup (#1085/#1242, epic #975); null on the SPA dataset. */
  modelEvalSummary: ModelEvalSummary | null;
  updateResults: UpdateResult[];
  mcpAuth: McpAuthState | null;
  configBackups: DriftEvent[];
  /** Committed external guidance snapshots (#1302); empty on the SPA dataset. */
  externalGuidance: ExternalGuidance[];
  enterpriseSession: EnterpriseSession | null;
  /**
   * Synthetic adoption-lifecycle receipts injected by the marketing SPA's
   * sample data (#578). Empty on the live server build (which self-fetches the
   * real receipt store) and empty until sample mode activates.
   */
  sampleAdoptionReceipts: AdoptionReceipt[];
}

/** Navigation + session-focus callbacks every view wires its affordances to. */
export interface ViewNav {
  navigateTo: (view: View) => void;
  openSession: (sessionId: string) => void;
  /** Open the session drill-in focused on a specific timeline entry (#1307). */
  openEvidence: (ref: EvidenceRef) => void;
  setActiveSessionId: (id: string | null) => void;
  setActiveProjectId: (id: string | null) => void;
  focusSessionId: string | null;
  focusEvidenceRef: EvidenceRef | null;
  consumeFocus: () => void;
  reloadFromDisk: () => void;
  /** Update the URL-backed global dashboard filter (#832). */
  onFilterChange: (filter: DashboardFilter) => void;
  /** Sink for the digest's active-finding domains (#609); feeds the recs-driven sidebar. */
  onActiveDomains: (domains: ReadonlySet<ActionDomain>) => void;
}

export interface ViewContext {
  /** URL-backed global time + project filter (#832). */
  filter: DashboardFilter;
  data: ViewData;
  nav: ViewNav;
  /** Whether a backend is present (server build) vs. the read-only SPA. */
  serverAvailable: boolean;
}

export interface ViewAnchorTarget {
  /** The parent view that owns the DOM section. */
  parentView: View;
  /** The `data-signal-id` that should be scrolled/focused after render. */
  signalId: string;
}

export const VIEW_ANCHORS: Partial<Record<View, ViewAnchorTarget>> = {
  'reclaim-compass': { parentView: 'cost', signalId: 'reclaim-compass' },
};

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

export function filterViewDataByTime(
  data: ViewData,
  filter: DashboardFilter
): ViewData {
  if (filter.time === 'all') return data;
  const range = presetToRange(filter.time, datasetNow(data));
  const entries = data.entries.filter((entry) =>
    timestampInRange(entry.timestamp, range)
  );
  const sessions = data.sessions.filter((session) =>
    timestampInRange(session.startTime, range)
  );
  const tokenData = filterTokenDataByTime(data.tokenData, range);
  const sessionRegistry = data.sessionRegistry.filter((entry) =>
    timestampInRange(entry.startedAt, range)
  );
  const sessionIds = new Set([
    ...sessions.map((session) => session.sessionId),
    ...tokenData.map((row) => row.sessionId),
    ...sessionRegistry.map((entry) => entry.sessionId),
  ]);
  const toolData = filterToolDataByTime(data.toolData, range);
  const timelines = filterTimelinesByTime(data.timelines, range);
  const apiErrors = data.apiErrors.filter((event) =>
    timestampInRange(event.timestamp, range)
  );
  const permissionChanges = data.permissionChanges.filter((change) =>
    timestampInRange(change.timestamp, range)
  );
  const agentSettings = data.agentSettings.filter((event) =>
    timestampInRange(event.timestamp, range)
  );
  const runtimeEvents = filterRuntimeEventsByTime(data.runtimeEvents, range);

  return {
    ...data,
    entries,
    sessions,
    projects: groupByProjects(sessions),
    tokenData,
    toolData,
    toolInventories: filterBySessionId(data.toolInventories, sessionIds),
    timelines,
    apiErrors,
    permissionRows: filterBySessionId(data.permissionRows, sessionIds),
    permissionChanges,
    agentSettings,
    attribution: filterBySessionId(data.attribution, sessionIds),
    runtimeEvents,
    taskSteering: filterBySessionId(data.taskSteering, sessionIds),
    churnGeometry: filterBySessionId(data.churnGeometry, sessionIds),
    valueFlow: filterBySessionId(data.valueFlow, sessionIds),
    taskSuccess: filterBySessionId(data.taskSuccess, sessionIds),
    assistantFeatures: filterBySessionId(data.assistantFeatures, sessionIds),
    promptAnalysis: filterBySessionId(data.promptAnalysis, sessionIds),
    deceitSignals: filterBySessionId(data.deceitSignals, sessionIds),
    sessionRegistry,
    telemetry: data.telemetry.filter((event) =>
      timestampInRange(event.client_timestamp, range)
    ),
    modelLatency: data.modelLatency.filter((event) =>
      timestampInRange(event.client_timestamp, range)
    ),
    debugLogs: filterBySessionId(data.debugLogs, sessionIds),
  };
}

// ── Render map ─────────────────────────────────────────────────────────────
// One closure per view; the prop wiring is the verbatim move of App.tsx's
// former conditional-JSX block, re-sourced from `ctx`.
// `Partial` because a retired view id can still be in the `View` union for
// deep-link redirects (#14, e.g. `stats` → `activity`) while no longer owning a
// renderer of its own. `renderView` already null-guards a missing entry.
function renderCostAttributionView(
  { data: d, nav: n, filter }: ViewContext,
  focusSignalId?: string
): ReactNode {
  return (
    <CostAttribution
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      activeFilter={filter}
      focusSignalId={focusSignalId}
      onOpenSession={n.openSession}
      onNavigate={n.navigateTo}
    />
  );
}

export const VIEW_RENDERERS: Partial<
  Record<View, (ctx: ViewContext) => ReactNode>
> = {
  home: ({ data: d, nav: n, serverAvailable }) => (
    <DigestSpine
      serverAvailable={serverAvailable}
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      projects={d.projects}
      permissionRows={d.permissionRows}
      apiErrors={d.apiErrors}
      timelines={d.timelines}
      attribution={d.attribution}
      agentSettings={d.agentSettings}
      runtimeEvents={d.runtimeEvents}
      taskSteering={d.taskSteering}
      churnGeometry={d.churnGeometry}
      taskSuccess={d.taskSuccess}
      toolInventories={d.toolInventories}
      liveConfig={d.liveConfig}
      assistantFeatures={d.assistantFeatures}
      deceitSignals={d.deceitSignals}
      tasks={d.tasks}
      teams={d.teams}
      reviewEvents={d.reviewEvents}
      sessionRegistry={d.sessionRegistry}
      telemetry={d.telemetry}
      modelLatency={d.modelLatency}
      debugLogs={d.debugLogs}
      statsCache={d.statsCache}
      fileHistory={d.fileHistory}
      plans={d.plans}
      updateResults={d.updateResults}
      mcpAuth={d.mcpAuth}
      configBackups={d.configBackups}
      onNavigate={n.navigateTo}
      onOpenSession={n.openSession}
      onActiveDomains={n.onActiveDomains}
    />
  ),
  recommendations: ({ data: d, nav: n, filter, serverAvailable }) => (
    <Recommendations
      serverAvailable={serverAvailable}
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      projects={d.projects}
      permissionRows={d.permissionRows}
      apiErrors={d.apiErrors}
      timelines={d.timelines}
      attribution={d.attribution}
      agentSettings={d.agentSettings}
      runtimeEvents={d.runtimeEvents}
      taskSteering={d.taskSteering}
      churnGeometry={d.churnGeometry}
      taskSuccess={d.taskSuccess}
      toolInventories={d.toolInventories}
      liveConfig={d.liveConfig}
      assistantFeatures={d.assistantFeatures}
      deceitSignals={d.deceitSignals}
      tasks={d.tasks}
      teams={d.teams}
      reviewEvents={d.reviewEvents}
      sessionRegistry={d.sessionRegistry}
      telemetry={d.telemetry}
      modelLatency={d.modelLatency}
      debugLogs={d.debugLogs}
      statsCache={d.statsCache}
      fileHistory={d.fileHistory}
      plans={d.plans}
      modelEvalSummary={d.modelEvalSummary}
      updateResults={d.updateResults}
      mcpAuth={d.mcpAuth}
      configBackups={d.configBackups}
      repoMap={d.repoMap}
      externalGuidance={d.externalGuidance}
      activeFilter={filter}
      onNavigate={n.navigateTo}
      onOpenSession={n.openSession}
    />
  ),
  evaluator: ({ data: d, nav: n }) => (
    <EvaluatorLanding
      runtimeEvents={d.runtimeEvents}
      tokenData={d.tokenData}
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      onNavigate={n.navigateTo}
      onOpenSession={n.openSession}
    />
  ),
  sessions: ({ data: d, nav: n }) => (
    <SessionList
      sessions={d.sessions}
      tokenData={d.tokenData}
      toolData={d.toolData}
      timelines={d.timelines}
      runtimeEvents={d.runtimeEvents}
      apiErrors={d.apiErrors}
      focusSessionId={n.focusSessionId}
      focusEvidenceRef={n.focusEvidenceRef}
      onFocusConsumed={n.consumeFocus}
      onActiveSessionChange={n.setActiveSessionId}
      onNavigate={n.navigateTo}
    />
  ),
  projects: ({ data: d, nav: n }) => (
    <ProjectBreakdown
      projects={d.projects}
      onOpenSession={n.openSession}
      onActiveProjectChange={n.setActiveProjectId}
    />
  ),
  search: ({ data: d, nav: n }) => (
    <SearchView entries={d.entries} onOpenSession={n.openSession} />
  ),
  tokens: ({ data: d, nav: n, filter }) => (
    <TokenUsage
      tokenData={d.tokenData}
      sessions={d.sessions}
      activeFilter={filter}
      onOpenSession={n.openSession}
      onNavigate={n.navigateTo}
    />
  ),
  tools: ({ data: d, nav: n }) => (
    <ToolUsage
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      timelines={d.timelines}
      toolInventories={d.toolInventories}
      sessions={d.sessions}
      liveConfig={d.liveConfig}
      onOpenSession={n.openSession}
    />
  ),
  files: ({ data: d, nav: n }) => (
    <FileImpact
      toolData={d.toolData}
      tokenData={d.tokenData}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  summary: ({ data: d, filter }) => (
    <SummaryView
      tokenData={d.tokenData}
      sessions={d.sessions}
      activeFilter={filter}
    />
  ),
  cost: (ctx) => renderCostAttributionView(ctx),
  'reclaim-compass': (ctx) =>
    renderCostAttributionView(ctx, VIEW_ANCHORS['reclaim-compass']?.signalId),
  timeline: ({ data: d, nav: n }) => (
    <SessionTimeline
      timelines={d.timelines}
      sessions={d.sessions}
      tokenData={d.tokenData}
      valueFlow={d.valueFlow}
      focusSessionId={n.focusSessionId}
      focusEvidenceRef={n.focusEvidenceRef}
      onOpenSession={n.openSession}
      onOpenEvidence={n.openEvidence}
    />
  ),
  // #14: the former standalone "Stats" view (UsageStats) is folded into
  // Activity, so this one page shows both the activity-pulse panels and the
  // usage-stats panels. `entries` is threaded through for the usage-stats
  // panels (daily activity + hour×day heatmap derive from raw history entries).
  activity: ({ data: d, nav: n, filter }) => (
    <ProjectActivity
      sessions={d.sessions}
      projects={d.projects}
      entries={d.entries}
      activeFilter={filter}
      onOpenSession={n.openSession}
    />
  ),
  automation: ({ data: d, nav: n, filter }) => (
    <AutomationView
      sessions={d.sessions}
      tokenData={d.tokenData}
      toolData={d.toolData}
      timelines={d.timelines}
      apiErrors={d.apiErrors}
      activeFilter={filter}
      onActiveSessionChange={n.setActiveSessionId}
      onOpenSession={n.openSession}
    />
  ),
  workflows: ({ data: d, nav: n, serverAvailable }) => (
    <WorkflowList
      workflows={d.workflows}
      serverAvailable={serverAvailable}
      onOpenSession={n.openSession}
    />
  ),
  prompts: ({ data: d }) => (
    <PromptAnalyzer
      promptAnalysis={d.promptAnalysis}
      timelines={d.timelines}
      apiErrors={d.apiErrors}
    />
  ),
  errors: ({ data: d, nav: n }) => (
    <ErrorRetry
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  permissions: ({ data: d, nav: n }) => (
    <Permissions
      toolData={d.toolData}
      permissionRows={d.permissionRows}
      permissionChanges={d.permissionChanges}
      tokenData={d.tokenData}
      liveConfig={d.liveConfig}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  agents: ({ data: d, nav: n }) => (
    <AgentSkill
      toolData={d.toolData}
      agentSettings={d.agentSettings}
      attribution={d.attribution}
      runtimeEvents={d.runtimeEvents}
      tokenData={d.tokenData}
      sessions={d.sessions}
      onOpenSession={n.openSession}
      onNavigate={n.navigateTo}
    />
  ),
  memories: ({ data: d, serverAvailable }) => (
    <Memories memories={d.memories} serverAvailable={serverAvailable} />
  ),
  context: ({ data: d, nav: n }) => (
    <ContextHealth
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  conversation: ({ data: d, nav: n }) => (
    <ConversationPatterns
      timelines={d.timelines}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  patterns: ({ data: d, nav: n, filter }) => (
    <SessionPatterns
      timelines={d.timelines}
      tokenData={d.tokenData}
      toolData={d.toolData}
      runtimeEvents={d.runtimeEvents}
      apiErrors={d.apiErrors}
      sessions={d.sessions}
      activeFilter={filter}
      onOpenSession={n.openSession}
    />
  ),
  'shadow-calls': ({ data: d, serverAvailable }) => (
    <ShadowCalls shadowCalls={d.shadowCalls} serverAvailable={serverAvailable} />
  ),
  // ── #539 artifact views ────────────────────────────────────────────────
  'report-card': ({ data: d, serverAvailable }) => (
    <AgentReportCard
      sessions={d.sessions}
      tokenData={d.tokenData}
      sessionRegistry={d.sessionRegistry}
      telemetry={d.telemetry}
      debugLogs={d.debugLogs}
      serverAvailable={serverAvailable}
    />
  ),
  'review-queue': ({ data: d, nav: n, serverAvailable }) => (
    <ReviewQueue
      sessions={d.sessions}
      tokenData={d.tokenData}
      toolData={d.toolData}
      timelines={d.timelines}
      apiErrors={d.apiErrors}
      debugLogs={d.debugLogs}
      telemetry={d.telemetry}
      serverAvailable={serverAvailable}
      onOpenSession={n.openSession}
      onNavigate={n.navigateTo}
    />
  ),
  tasks: ({ data: d, nav: n, serverAvailable }) => (
    <TaskHealth
      tasks={d.tasks}
      serverAvailable={serverAvailable}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  teams: ({ data: d, serverAvailable }) => (
    <TeamCoordination teams={d.teams} serverAvailable={serverAvailable} />
  ),
  plans: ({ data: d, serverAvailable }) => (
    <PlanShapes plans={d.plans} serverAvailable={serverAvailable} />
  ),
  pulse: ({ data: d, serverAvailable }) => (
    <UsagePulse
      statsCache={d.statsCache}
      serverAvailable={serverAvailable}
      sessions={d.sessions}
      tokenData={d.tokenData}
      toolData={d.toolData}
    />
  ),
  diary: () => <DiaryView />,
  // Model Evals workbench (#1086, epic #975): ranked runs / clusters / batch
  // specs / result history / scoped routing recommendations.
  'model-evals': ({ data: d, serverAvailable }) => (
    <ModelEvals
      modelEvalSummary={d.modelEvalSummary}
      tokenData={d.tokenData}
      timelines={d.timelines}
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      serverAvailable={serverAvailable}
    />
  ),
  adoption: ({ data: d, serverAvailable }) => (
    <AdoptionScorecard
      liveConfig={d.liveConfig}
      serverAvailable={serverAvailable}
      sampleReceipts={d.sampleAdoptionReceipts}
    />
  ),
  provisioning: ({ serverAvailable }) => (
    <SessionProvisioning serverAvailable={serverAvailable} />
  ),
  enterprise: ({ data: d, serverAvailable }) => (
    <EnterpriseAdmin
      serverAvailable={serverAvailable}
      session={d.enterpriseSession}
    />
  ),
};

type FilterableViewDataKey = keyof ViewData;

const VIEW_FILTERABLE_DATA: Partial<Record<View, FilterableViewDataKey[]>> = {
  recommendations: ['sessions', 'tokenData', 'toolData', 'apiErrors'],
  tokens: ['tokenData'],
  summary: ['tokenData'],
  cost: ['tokenData', 'toolData'],
  'reclaim-compass': ['tokenData', 'toolData'],
  activity: ['sessions'],
  automation: ['sessions'],
  prompts: ['promptAnalysis'],
  patterns: ['timelines'],
};

function hasUsableValue(value: ViewData[FilterableViewDataKey]): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value != null;
}

function viewHasFilterableData(view: View, data: ViewData): boolean {
  const keys = VIEW_FILTERABLE_DATA[view];
  if (!keys) return false;
  return keys.some((key) => hasUsableValue(data[key]));
}

export function shouldShowFilteredEmptyState(
  view: View,
  filter: DashboardFilter,
  unfiltered: ViewData,
  filtered: ViewData
): boolean {
  return (
    isDashboardFilterActive(filter) &&
    viewHasFilterableData(view, unfiltered) &&
    !viewHasFilterableData(view, filtered)
  );
}

function keepKnownSession<T extends { sessionId: string }>(
  rows: T[],
  sessionIds: ReadonlySet<string>
): T[] {
  return rows.filter((row) => sessionIds.has(row.sessionId));
}

export function filterViewDataByProject(
  data: ViewData,
  filter: DashboardFilter
): ViewData {
  if (filter.project === ALL_PROJECTS) return data;

  const project = filter.project;
  const sessions = data.sessions.filter((session) => session.project === project);
  const tokenData = data.tokenData.filter((item) => item.project === project);
  const sessionRegistry = data.sessionRegistry.filter((entry) => entry.cwd === project);
  const sessionIds = new Set([
    ...sessions.map((session) => session.sessionId),
    ...tokenData.map((row) => row.sessionId),
    ...sessionRegistry.map((entry) => entry.sessionId),
  ]);

  return {
    ...data,
    entries: data.entries.filter((entry) => entry.project === project),
    sessions,
    projects: data.projects.filter((item) => item.project === project),
    tokenData,
    toolData: keepKnownSession(data.toolData, sessionIds),
    toolInventories: keepKnownSession(data.toolInventories, sessionIds),
    timelines: keepKnownSession(data.timelines, sessionIds),
    apiErrors: keepKnownSession(data.apiErrors, sessionIds),
    permissionRows: keepKnownSession(data.permissionRows, sessionIds),
    permissionChanges: keepKnownSession(data.permissionChanges, sessionIds),
    agentSettings: keepKnownSession(data.agentSettings, sessionIds),
    attribution: keepKnownSession(data.attribution, sessionIds),
    runtimeEvents: keepKnownSession(data.runtimeEvents, sessionIds),
    taskSteering: keepKnownSession(data.taskSteering, sessionIds),
    churnGeometry: keepKnownSession(data.churnGeometry, sessionIds),
    valueFlow: keepKnownSession(data.valueFlow, sessionIds),
    taskSuccess: keepKnownSession(data.taskSuccess, sessionIds),
    assistantFeatures: keepKnownSession(data.assistantFeatures, sessionIds),
    promptAnalysis: keepKnownSession(data.promptAnalysis, sessionIds),
    deceitSignals: keepKnownSession(data.deceitSignals, sessionIds),
    workflows: keepKnownSession(data.workflows, sessionIds),
    sessionRegistry,
    telemetry: filterTelemetryBySessionId(data.telemetry, sessionIds),
    modelLatency: filterModelLatencyBySessionId(data.modelLatency, sessionIds),
    debugLogs: keepKnownSession(data.debugLogs, sessionIds),
  };
}

/** Render the active view. Returns null for an unknown view (defensive). */
export function renderView(view: View, ctx: ViewContext): ReactNode {
  const renderer = VIEW_RENDERERS[view];
  if (!renderer) return null;
  // Compose both global filters: narrow by time first, then by project.
  const data = filterViewDataByProject(
    filterViewDataByTime(ctx.data, ctx.filter),
    ctx.filter
  );
  if (shouldShowFilteredEmptyState(view, ctx.filter, ctx.data, data)) {
    return <FilteredEmptyState filter={ctx.filter} />;
  }
  return renderer({ ...ctx, data });
}
