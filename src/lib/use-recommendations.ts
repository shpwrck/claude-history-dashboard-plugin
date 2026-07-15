import { useMemo } from 'react';
import {
  assembleRecommendationInput,
  buildRecommendations,
  type RecommendationViews,
} from './recommendations';
import type { Recommendation, RecommendationInput } from './detectors/types';

/**
 * Shared orchestration of the recommendation engine for view components (#2078).
 *
 * Before this hook the `assembleRecommendationInput -> buildRecommendations` glue
 * was re-wired in three views (DigestSpine, Recommendations, CostAttribution),
 * each with its own `useMemo` and a parallel ~30-line dependency array. This hook
 * is the single seam: a caller passes the view-data fields it has in scope; the
 * field/dependency list lives here ONCE, so a newly-consumed signal is wired in
 * one place instead of three. Returns both the assembled `input` (some callers,
 * e.g. the digest's domain-coverage, need it directly) and the built
 * `recommendations`.
 */
export function useRecommendations(views: RecommendationViews): {
  input: RecommendationInput;
  recommendations: Recommendation[];
} {
  const input = useMemo(
    () => assembleRecommendationInput(views),
    // The dependency list enumerates every RecommendationViews field, so this is
    // the one place the signal set is maintained — callers no longer keep a
    // parallel per-view dep array. Keep in sync with RecommendationInput
    // (src/lib/detectors/types.ts); a field a given caller omits is `undefined`
    // and therefore stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      views.tokenData, views.toolData, views.sessions, views.projects,
      views.permissionRows, views.apiErrors, views.liveConfig, views.workflows,
      views.assistantFeatures, views.deceitSignals, views.secretsAtRest,
      views.timelines, views.attribution,
      views.agentSettings, views.runtimeEvents, views.taskSteering, views.churnGeometry,
      views.taskSuccess, views.toolInventories, views.tasks, views.teams,
      views.reviewEvents, views.sessionRegistry, views.telemetry, views.modelLatency,
      views.debugLogs, views.statsCache, views.fileHistory, views.plans,
      views.modelEvalSummary, views.updateResults, views.mcpAuth, views.configBackups,
      views.repoMap, views.externalGuidance, views.promptAnalysis, views.modelPinSavings,
      views.gitOutcomes, views.memoryStores, views.organizationIdentity, views.shadowCalls,
      views.valueFlow,
    ]
  );
  const recommendations = useMemo(() => buildRecommendations(input), [input]);
  return { input, recommendations };
}
