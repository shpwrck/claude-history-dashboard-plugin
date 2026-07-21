/**
 * Canonical client-side recommendation input envelope (#2352, epic #2345).
 *
 * Canonical mapping from loaded {@link ViewData} to the engine's
 * {@link RecommendationViews} envelope. Since #2719 the browser is a viewer of
 * server-computed analysis; this mapping remains the server typed-surface seam
 * and the compatibility envelope for presentation props, rather than a browser
 * engine invocation.
 *
 * Fields the client dataset does not carry at all — `gitOutcomes`,
 * `modelPinSavings`, `organizationIdentity`, `semanticIntent`, `memoryStores`
 * (server-side ingest artifacts; `ViewData.memories` is a different artifact
 * than the engine's `memoryStores`) — are equally absent for every surface here;
 * `assembleRecommendationInput` normalizes them to explicit nulls. The parity
 * test (`recommendation-view-data.test.ts`) pins this list so a new detector
 * dependency on a client-carried field cannot be silently dropped.
 */
import type { ViewData } from './view-registry';
import type { RecommendationViews } from './recommendations';

/**
 * Engine-consumed fields the client envelope does not supply. `gitOutcomes`,
 * `memoryStores`, `docHygieneArtifact`, and `organizationIdentity` are
 * server-only inputs no client dataset carries. `docGraph` is different: the
 * live dataset carries it while SPA/upload datasets normalize it to null.
 * `modelPinSavings` is different: not supplied here, but
 * `assembleRecommendationInput` derives it from `tokenData`, so its detectors
 * still run on every surface (it is excluded from `listOmittedEngineSignals`
 * for exactly that reason).
 */
export const CLIENT_ABSENT_ENGINE_FIELDS: readonly string[] = [
  'gitOutcomes',
  'memoryStores',
  'docHygieneArtifact',
  'modelPinSavings',
  'organizationIdentity',
  // #2574/#2647: server-only AND opt-in (CHD_SEMANTIC_INTENT=1), so the raw
  // browser ViewData envelope cannot supply it. The #2719 global typed server
  // surface explicitly restores `dataset.semanticIntent` after this mapping;
  // viewer-only Home, Recommendations, and Ask Claude therefore receive the
  // enriched server result when enabled without exposing the artifact client-side.
  'semanticIntent',
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
    secretsAtRest: d.secretsAtRest ?? [],
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
    docGraph: d.docGraph,
    docsMap: d.docsMap,
    docIssueSnapshot: d.docIssueSnapshot,
    externalGuidance: d.externalGuidance,
  };
}
