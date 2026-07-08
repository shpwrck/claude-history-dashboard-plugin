/**
 * Canonical client-side recommendation input envelope (#2352, epic #2345).
 *
 * The three client action surfaces that imply the same recommendation truth —
 * Home Digest, Recommendations, and Ask Claude — used to each hand-list the
 * engine fields they passed, and drifted: the digest missed model-eval and
 * repo-map data, Ask Claude passed only the six required base fields. This
 * module is the ONE mapping from the loaded {@link ViewData} to the engine's
 * {@link RecommendationViews} envelope; every client surface consumes it, so a
 * newly-ingested signal is wired once and reaches all surfaces together.
 *
 * Fields the client dataset does not carry at all — `gitOutcomes`,
 * `modelPinSavings`, `organizationIdentity`, `memoryStores` (server-side
 * ingest artifacts; `ViewData.memories` is a different artifact than the
 * engine's `memoryStores`) — are equally absent for every surface here;
 * `assembleRecommendationInput` normalizes them to explicit nulls. The parity
 * test (`recommendation-view-data.test.ts`) pins this list so a new detector
 * dependency on a client-carried field cannot be silently dropped.
 */
import type { ViewData } from './view-registry';
import type { RecommendationViews } from './recommendations';

/**
 * Engine-consumed fields the client envelope does not supply. `gitOutcomes`,
 * `memoryStores`, and `organizationIdentity` are server-side ingest artifacts
 * no client dataset carries. `modelPinSavings` is different: not supplied
 * here, but `assembleRecommendationInput` derives it from `tokenData`, so its
 * detectors still run on every surface (it is excluded from
 * `listOmittedEngineSignals` for exactly that reason).
 */
export const CLIENT_ABSENT_ENGINE_FIELDS: readonly string[] = [
  'gitOutcomes',
  'memoryStores',
  'modelPinSavings',
  'organizationIdentity',
];

export function recommendationViewsFromViewData(
  d: ViewData
): RecommendationViews {
  return {
    tokenData: d.tokenData,
    toolData: d.toolData,
    sessions: d.sessions,
    projects: d.projects,
    permissionRows: d.permissionRows,
    apiErrors: d.apiErrors,
    liveConfig: d.liveConfig,
    workflows: d.workflows,
    assistantFeatures: d.assistantFeatures,
    deceitSignals: d.deceitSignals,
    timelines: d.timelines,
    attribution: d.attribution,
    agentSettings: d.agentSettings,
    runtimeEvents: d.runtimeEvents,
    taskSteering: d.taskSteering,
    churnGeometry: d.churnGeometry,
    taskSuccess: d.taskSuccess,
    toolInventories: d.toolInventories,
    promptAnalysis: d.promptAnalysis,
    valueFlow: d.valueFlow,
    shadowCalls: d.shadowCalls,
    tasks: d.tasks,
    teams: d.teams,
    reviewEvents: d.reviewEvents,
    sessionRegistry: d.sessionRegistry,
    telemetry: d.telemetry,
    modelLatency: d.modelLatency,
    debugLogs: d.debugLogs,
    statsCache: d.statsCache,
    fileHistory: d.fileHistory,
    plans: d.plans,
    modelEvalSummary: d.modelEvalSummary,
    updateResults: d.updateResults,
    mcpAuth: d.mcpAuth,
    configBackups: d.configBackups,
    repoMap: d.repoMap,
    externalGuidance: d.externalGuidance,
  };
}
