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
import { recommendationViewsFromViewData } from './recommendation-view-data';
import { enterpriseCapabilityAllowed } from './enterprise-capabilities';
import { navigateDrillThroughWithFilter } from '../components/affordance/DrillThrough';
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
  DataSource,
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
import { memoriesMatchProject } from './project-slug';
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
  type RouteFilter,
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
const LocalAnalyze = lazy(() =>
  import('../components/LocalAnalyze').then((m) => ({
    default: m.LocalAnalyzePf,
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
// Composite tab shell for the consolidated workflow-hygiene destinations (#2351).
const CompositeTabsView = lazy(() =>
  import('../components/CompositeTabsView').then((m) => ({
    default: m.CompositeTabsView,
  }))
);
// Human doc-relationship view over the #2263 neighborhood (#2323, epic #2262).
// SPA-safe: it renders a client-computed SAMPLE neighborhood (no server, no
// ~/.claude), so it demos with real hygiene flags in every build.
const DocRelationshipView = lazy(() =>
  import('../components/DocRelationshipView').then((m) => ({
    default: m.DocRelationshipViewSample,
  }))
);
// Experiment-segment view (#2096, epic #2094): groups tagged sessions by arm and
// reports the trial metric set. SPA-safe — derives from the parsed dataset.
const ExperimentSegment = lazy(() =>
  import('../components/ExperimentSegment').then((m) => ({
    default: m.ExperimentSegment,
  }))
);
// Keep the admin-only live-server view out of the upload-only SPA bundle.
const EnterpriseAdminUnavailable = () => null;
const EnterpriseAdmin =
  import.meta.env.MODE === 'spa' || import.meta.env.MODE === 'sample'
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
  /** Per-source descriptors w/ member attribution (#1563/#1999); used by SessionList. */
  sources?: DataSource[];
}

/** Navigation + session-focus callbacks every view wires its affordances to. */
export interface ViewNav {
  navigateTo: (view: View) => void;
  navigateWithFilter: (view: View, filter?: RouteFilter) => void;
  scrollToAnchor: (signalId: string) => boolean;
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
  /** URL-backed per-view evidence filter (#1614). */
  routeFilter: RouteFilter;
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
  // Runtime config is a singleton-like artifact for the workspace.
  liveConfig: { time: 'global', project: 'global' },
  // Repo-map structure is cross-project infrastructure metadata for static
  // analysis.
  repoMap: { time: 'global', project: 'global' },
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

// ── Render map ─────────────────────────────────────────────────────────────
// One closure per view; the prop wiring is the verbatim move of App.tsx's
// former conditional-JSX block, re-sourced from `ctx`.
// `Partial` because a retired view id can still be in the `View` union for
// deep-link redirects (#14, e.g. `stats` → `activity`) while no longer owning a
// renderer of its own. `renderView` already null-guards a missing entry.
function renderCostAttributionView(
  { data: d, nav: n, filter, routeFilter }: ViewContext,
  focusSignalId?: string
): ReactNode {
  return (
    <CostAttribution
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      activeFilter={filter}
      routeFilter={routeFilter}
      focusSignalId={focusSignalId}
      onOpenSession={n.openSession}
      onNavigate={n.navigateTo}
      navigateWithFilter={n.navigateWithFilter}
    />
  );
}

// ── #2351 composite tab renderers ───────────────────────────────────────────
// The workflow-hygiene consolidation: `capabilities` (Tools / Agents & Skills /
// Prompts / Memories) and `automation` (Runs / Tasks / Teams / Plans /
// Workflows) render one CompositeTabsView each. The per-tab render closures
// are the verbatim prop wiring the absorbed views' standalone renderers used.
// Tab gating mirrors each absorbed view's former NAV_ITEMS `requires`
// (tasks/teams/plans: serverData, `covered` when the upload carries the
// artifact — the composite-tab equivalent of `uploadAvailableViews`).

function renderCapabilitiesView(ctx: ViewContext, forcedTab?: string): ReactNode {
  const { data: d, nav: n, filter, routeFilter, serverAvailable } = ctx;
  return (
    <CompositeTabsView
      title="Capabilities"
      serverAvailable={serverAvailable}
      activeTab={forcedTab ?? routeFilter.tab}
      onTabChange={(tab) =>
        n.navigateWithFilter('capabilities', { ...routeFilter, tab })
      }
      tabs={[
        {
          id: 'tools',
          label: 'Tools',
          render: () => (
            <ToolUsage
              toolData={d.toolData}
              apiErrors={d.apiErrors}
              timelines={d.timelines}
              toolInventories={d.toolInventories}
              sessions={d.sessions}
              liveConfig={d.liveConfig}
              onOpenSession={n.openSession}
              routeFilter={routeFilter}
              activeFilter={filter}
              onNavigateWithFilter={n.navigateWithFilter}
            />
          ),
        },
        {
          id: 'agents',
          label: 'Agents & Skills',
          render: () => (
            <AgentSkill
              toolData={d.toolData}
              agentSettings={d.agentSettings}
              attribution={d.attribution}
              runtimeEvents={d.runtimeEvents}
              tokenData={d.tokenData}
              sessions={d.sessions}
              routeFilter={routeFilter}
              onOpenSession={n.openSession}
              onNavigate={n.navigateWithFilter}
            />
          ),
        },
        {
          id: 'prompts',
          label: 'Prompts',
          render: () => (
            <PromptAnalyzer
              promptAnalysis={d.promptAnalysis}
              timelines={d.timelines}
              apiErrors={d.apiErrors}
              onOpenSession={n.openSession}
              onDrillThrough={(target) =>
                navigateDrillThroughWithFilter(n.navigateWithFilter, target)
              }
            />
          ),
        },
        {
          id: 'memories',
          label: 'Memories',
          render: () => (
            <Memories memories={d.memories} serverAvailable={serverAvailable} />
          ),
        },
      ]}
    />
  );
}

function renderAutomationView(ctx: ViewContext, forcedTab?: string): ReactNode {
  const { data: d, nav: n, filter, routeFilter, serverAvailable } = ctx;
  return (
    <CompositeTabsView
      title="Automation"
      serverAvailable={serverAvailable}
      activeTab={forcedTab ?? routeFilter.tab}
      onTabChange={(tab) =>
        n.navigateWithFilter('automation', { ...routeFilter, tab })
      }
      tabs={[
        {
          id: 'runs',
          label: 'Runs',
          render: () => (
            <AutomationView
              sessions={d.sessions}
              tokenData={d.tokenData}
              toolData={d.toolData}
              timelines={d.timelines}
              apiErrors={d.apiErrors}
              activeFilter={filter}
              routeFilter={routeFilter}
              onActiveSessionChange={n.setActiveSessionId}
              onOpenSession={n.openSession}
              onNavigate={n.navigateWithFilter}
            />
          ),
        },
        {
          id: 'tasks',
          label: 'Tasks',
          requires: 'serverData',
          covered: d.tasks.length > 0,
          render: () => (
            <TaskHealth
              tasks={d.tasks}
              serverAvailable={serverAvailable}
              sessions={d.sessions}
              onOpenSession={n.openSession}
            />
          ),
        },
        {
          id: 'teams',
          label: 'Teams',
          requires: 'serverData',
          covered: d.teams.length > 0,
          render: () => (
            <TeamCoordination
              teams={d.teams}
              tasks={d.tasks}
              sessions={d.sessions}
              serverAvailable={serverAvailable}
              onOpenSession={n.openSession}
            />
          ),
        },
        {
          id: 'plans',
          label: 'Plans',
          requires: 'serverData',
          covered: d.plans.length > 0,
          render: () => (
            <PlanShapes plans={d.plans} serverAvailable={serverAvailable} />
          ),
        },
        {
          id: 'workflows',
          label: 'Workflows',
          render: () => (
            <WorkflowList
              workflows={d.workflows}
              serverAvailable={serverAvailable}
              onOpenSession={n.openSession}
            />
          ),
        },
      ]}
    />
  );
}

export const VIEW_RENDERERS: Partial<
  Record<View, (ctx: ViewContext) => ReactNode>
> = {
  // #2352: both recommendation surfaces spread the ONE canonical engine
  // envelope (recommendationViewsFromViewData) instead of hand-listing fields,
  // so Home Digest and Recommendations cannot drift apart in what they feed
  // the engine. Only non-engine props stay explicit here.
  home: ({ data: d, nav: n, serverAvailable }) => (
    <DigestSpine
      {...recommendationViewsFromViewData(d)}
      serverAvailable={serverAvailable}
      onNavigate={n.navigateWithFilter}
      onOpenSession={n.openSession}
      onActiveDomains={n.onActiveDomains}
    />
  ),
  recommendations: ({ data: d, nav: n, filter, routeFilter, serverAvailable }) => (
    <Recommendations
      {...recommendationViewsFromViewData(d)}
      serverAvailable={serverAvailable}
      activeFilter={filter}
      routeFilter={routeFilter}
      onNavigate={n.navigateWithFilter}
      navigateWithFilter={n.navigateWithFilter}
      onOpenSession={n.openSession}
    />
  ),
  'local-analyze': ({ filter }) => (
    <LocalAnalyze
      project={filter.project === ALL_PROJECTS ? null : filter.project}
    />
  ),
  evaluator: ({ data: d, nav: n }) => (
    <EvaluatorLanding
      runtimeEvents={d.runtimeEvents}
      tokenData={d.tokenData}
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      onNavigate={n.navigateTo}
      onNavigateWithFilter={n.navigateWithFilter}
      onOpenSession={n.openSession}
    />
  ),
  sessions: ({ data: d, nav: n, routeFilter }) => (
    <SessionList
      sessions={d.sessions}
      tokenData={d.tokenData}
      toolData={d.toolData}
      timelines={d.timelines}
      runtimeEvents={d.runtimeEvents}
      apiErrors={d.apiErrors}
      permissionRows={d.permissionRows}
      sources={d.sources}
      focusSessionId={n.focusSessionId}
      focusEvidenceRef={n.focusEvidenceRef}
      onFocusConsumed={n.consumeFocus}
      onActiveSessionChange={n.setActiveSessionId}
      onNavigate={n.navigateWithFilter}
      routeFilter={routeFilter}
    />
  ),
  projects: ({ data: d, nav: n }) => (
    <ProjectBreakdown
      projects={d.projects}
      onOpenSession={n.openSession}
      navigateWithFilter={n.navigateWithFilter}
      onActiveProjectChange={n.setActiveProjectId}
    />
  ),
  'experiment-segment': ({ data: d }) => (
    <ExperimentSegment
      entries={d.entries}
      tokenData={d.tokenData}
      toolData={d.toolData}
      timelines={d.timelines}
      apiErrors={d.apiErrors}
      taskSteering={d.taskSteering}
    />
  ),
  search: ({ data: d, nav: n }) => (
    <SearchView entries={d.entries} onOpenSession={n.openSession} />
  ),
  tokens: ({ data: d, nav: n, filter, routeFilter }) => (
    <TokenUsage
      tokenData={d.tokenData}
      sessions={d.sessions}
      activeFilter={filter}
      routeFilter={routeFilter}
      onOpenSession={n.openSession}
      onNavigate={n.navigateWithFilter}
      liveConfig={d.liveConfig}
    />
  ),
  // #2351: the consolidated workflow-hygiene composites. The absorbed ids keep
  // delegating renderers with their tab forced — normal routing resolves them
  // to the composite via REDIRECTED_VIEWS/REDIRECTED_VIEW_TAB, but any direct
  // render path (belt and braces) still lands on the right tab content.
  capabilities: (ctx) => renderCapabilitiesView(ctx),
  tools: (ctx) => renderCapabilitiesView(ctx, 'tools'),
  agents: (ctx) => renderCapabilitiesView(ctx, 'agents'),
  prompts: (ctx) => renderCapabilitiesView(ctx, 'prompts'),
  memories: (ctx) => renderCapabilitiesView(ctx, 'memories'),
  files: ({ data: d, nav: n }) => (
    <FileImpact
      toolData={d.toolData}
      tokenData={d.tokenData}
      sessions={d.sessions}
      onOpenSession={n.openSession}
    />
  ),
  summary: ({ data: d, nav: n, filter }) => (
    <SummaryView
      tokenData={d.tokenData}
      sessions={d.sessions}
      activeFilter={filter}
      navigateWithFilter={n.navigateWithFilter}
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
      navigateWithFilter={n.navigateWithFilter}
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
      navigateWithFilter={n.navigateWithFilter}
    />
  ),
  automation: (ctx) => renderAutomationView(ctx),
  workflows: (ctx) => renderAutomationView(ctx, 'workflows'),
  tasks: (ctx) => renderAutomationView(ctx, 'tasks'),
  teams: (ctx) => renderAutomationView(ctx, 'teams'),
  plans: (ctx) => renderAutomationView(ctx, 'plans'),
  errors: ({ data: d, nav: n, routeFilter }) => (
    <ErrorRetry
      toolData={d.toolData}
      apiErrors={d.apiErrors}
      sessions={d.sessions}
      routeFilter={routeFilter}
      onOpenSession={n.openSession}
      onNavigateWithFilter={n.navigateWithFilter}
    />
  ),
  permissions: ({ data: d, nav: n, routeFilter }) => (
    <Permissions
      toolData={d.toolData}
      permissionRows={d.permissionRows}
      permissionChanges={d.permissionChanges}
      tokenData={d.tokenData}
      liveConfig={d.liveConfig}
      canWritePolicy={enterpriseCapabilityAllowed(
        d.enterpriseSession,
        'canWritePolicy'
      )}
      configBackups={d.configBackups}
      sessions={d.sessions}
      routeFilter={routeFilter}
      onOpenSession={n.openSession}
      onNavigate={n.navigateWithFilter}
    />
  ),
  context: ({ data: d, nav: n, routeFilter }) => (
    <ContextHealth
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      onOpenSession={n.openSession}
      onNavigateWithFilter={n.navigateWithFilter}
      routeFilter={routeFilter}
    />
  ),
  conversation: ({ data: d, nav: n }) => (
    <ConversationPatterns
      timelines={d.timelines}
      sessions={d.sessions}
      onOpenSession={n.openSession}
      onNavigateWithFilter={n.navigateWithFilter}
    />
  ),
  patterns: ({ data: d, nav: n, filter, routeFilter }) => (
    <SessionPatterns
      timelines={d.timelines}
      tokenData={d.tokenData}
      toolData={d.toolData}
      runtimeEvents={d.runtimeEvents}
      apiErrors={d.apiErrors}
      sessions={d.sessions}
      activeFilter={filter}
      routeFilter={routeFilter}
      onOpenSession={n.openSession}
      onDrillThrough={(target) =>
        navigateDrillThroughWithFilter(n.navigateWithFilter, target)
      }
    />
  ),
  'shadow-calls': ({ data: d, serverAvailable }) => (
    <ShadowCalls shadowCalls={d.shadowCalls} serverAvailable={serverAvailable} />
  ),
  // ── #539 artifact views ────────────────────────────────────────────────
  'report-card': ({ data: d, nav: n, serverAvailable }) => (
    <AgentReportCard
      sessions={d.sessions}
      tokenData={d.tokenData}
      sessionRegistry={d.sessionRegistry}
      telemetry={d.telemetry}
      debugLogs={d.debugLogs}
      serverAvailable={serverAvailable}
      onOpenSession={n.openSession}
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
  // Human doc-relationship view (#2323). Renders a client-computed sample
  // neighborhood; no ViewData wiring yet (the doc graph is a server-only ingest
  // artifact no client dataset carries), so the surface demos the retrieval +
  // view + checkpoint end-to-end from a bundled sample.
  'doc-relationships': () => <DocRelationshipView />,
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
  // Automation is a composite: Runs is session-scoped, Workflows has its own
  // filtered ledger, and Tasks/Teams/Plans are global. Each tab owns its empty
  // state, so a sessions-only guard must not replace the shared tab shell.
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
