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
import type {
  RecommendationSurfaceLoadOptions,
  RecommendationSurfaceState,
} from './use-recommendations';
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
import type { SecretsAtRestSignal } from './parse-secrets-at-rest';
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
import type { DocGraph } from './parse-docs';
import type { DocsMapArtifact } from './parse-docs-map';
import type { DocIssueSnapshot } from './doc-issue-snapshot';
import type { OrganizationReviewEventsDataset } from './organization-review-events';
import type { ShadowCallAggregate } from './parse-shadow-calls';
import type { EvidenceRef } from './evidence';
import type { EnterpriseSession } from '@api-client';
import {
  ALL_PROJECTS,
  type DashboardFilter,
  type RouteFilter,
} from './routing';
// Masthead time/project narrowing + Cost-route scope now live in the React-free,
// server-safe `./view-scope` boundary (#2718). Imported for internal use here
// (renderView) and re-exported below so existing importers (App.tsx, tests) that
// pull these from './view-registry' keep working.
import {
  filterViewDataByProject,
  filterViewDataByTime,
  VIEW_DATA_FILTER_POLICIES,
} from './view-scope';
export { filterViewDataByProject, filterViewDataByTime, VIEW_DATA_FILTER_POLICIES };

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
  secretsAtRest: SecretsAtRestSignal[];
  liveConfig: LiveConfig | null;
  repoMap: RepoMapDataset | null;
  /** Local repository Markdown graph; null on SPA/upload datasets. */
  docGraph: DocGraph | null;
  /** Versioned docs-map contract wrapper (#2709); null on SPA/upload datasets. */
  docsMap: DocsMapArtifact | null;
  /** Opt-in GitHub issue-state snapshot (#2710); null unless CHD_DOC_ISSUES set. */
  docIssueSnapshot: DocIssueSnapshot | null;
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
  /**
   * Viewer-only recommendation analysis (#2719): the server-computed `global`
   * surface state, loaded once at the App level and shared by Home, the
   * Recommendations page, and Ask Claude so they never run the engine or drift.
   */
  analysis: RecommendationSurfaceState;
  /** Source identity shared by every independently scoped analysis loader. */
  analysisLoadOptions: RecommendationSurfaceLoadOptions;
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

// ── Render map ─────────────────────────────────────────────────────────────
// One closure per view; the prop wiring is the verbatim move of App.tsx's
// former conditional-JSX block, re-sourced from `ctx`.
// `Partial` because a retired view id can still be in the `View` union for
// deep-link redirects (#14, e.g. `stats` → `activity`) while no longer owning a
// renderer of its own. `renderView` already null-guards a missing entry.
function renderCostAttributionView(
  { data: d, nav: n, filter, routeFilter, analysisLoadOptions }: ViewContext,
  focusSignalId?: string
): ReactNode {
  return (
    <CostAttribution
      tokenData={d.tokenData}
      toolData={d.toolData}
      sessions={d.sessions}
      activeFilter={filter}
      routeFilter={routeFilter}
      analysisLoadOptions={analysisLoadOptions}
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
  home: ({ data: d, nav: n, serverAvailable, analysis }) => (
    <DigestSpine
      {...recommendationViewsFromViewData(d)}
      analysis={analysis}
      serverAvailable={serverAvailable}
      onNavigate={n.navigateWithFilter}
      onOpenSession={n.openSession}
      onActiveDomains={n.onActiveDomains}
    />
  ),
  recommendations: ({ data: d, nav: n, filter, routeFilter, serverAvailable, analysis }) => (
    <Recommendations
      {...recommendationViewsFromViewData(d)}
      analysis={analysis}
      serverAvailable={serverAvailable}
      activeFilter={filter}
      routeFilter={routeFilter}
      onNavigate={n.navigateWithFilter}
      navigateWithFilter={n.navigateWithFilter}
      onOpenSession={n.openSession}
    />
  ),
  'local-analyze': ({ filter, analysisLoadOptions }) => (
    <LocalAnalyze
      project={filter.project === ALL_PROJECTS ? null : filter.project}
      datasetGeneration={analysisLoadOptions.refreshKey}
      sourceEnabled={analysisLoadOptions.enabled ?? true}
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
