/**
 * Cost-route scope (#2718) — the React-free, server-safe pure boundary for the
 * Cost / Reclaim Compass ROUTE filter (project/date/mode/entrypoint), extracted
 * verbatim from `CostAttribution.tsx`, plus the reduced engine input the Reclaim
 * card feeds. Kept in its OWN module (separate from the masthead filters in
 * `view-scope.ts`) so this route-only code stays in the lazy Cost chunk instead
 * of being pulled into the eager first-paint shell (ADR 0016 bundle budget): the
 * eager `view-registry` imports only the masthead filters, while this module's
 * only client importer is the lazily-loaded `CostAttribution`.
 *
 * MUST stay React-free — pure `src/lib/*` values + `import type` only.
 */
import {
  buildSessionProjectIndex,
  sessionProject,
  textIncludes,
  timestampMatchesDate,
} from './route-filtering';
import type { Session, SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { RouteFilter } from './routing';
import type { RecommendationViews } from './recommendations';

// The Reclaim card calls reclaimScopedInput during render. Keep the intentionally
// empty collections referentially stable so useRecommendations can memoize the
// reduced input across unrelated rerenders (for example ResizeObserver updates).
// This restores the module-level EMPTY_ROWS behavior the extraction replaced.
const EMPTY_ROWS: never[] = [];

/**
 * Optional pre-built session-id -> project index (#3172).
 *
 * `tokenDataMatchesRoute` is called once per row, and its `sessionProject`
 * fallback is an `Array.find`, so the Cost route filter is O(rows x sessions)
 * exactly like the two filters in `route-filtering.ts` were. #3172's finding
 * only named that file, but the defect is the call SHAPE, not the module.
 * Passing an index built once per filtering call resolves each row in O(1);
 * omitting it keeps the old single-row behavior for direct callers.
 */
export function tokenDataMatchesRoute(
  row: SessionTokenData,
  sessions: Session[],
  filter: RouteFilter | undefined,
  projectBySession?: Map<string, string | undefined>
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (filter.project) {
    // Only consult attribution when the row does not already carry a project —
    // the `??` short-circuit the original expression had.
    const project =
      row.project ??
      (projectBySession
        ? projectBySession.get(row.sessionId)
        : sessionProject(row.sessionId, sessions));
    if (!textIncludes(project, filter.project)) return false;
  }
  if (
    filter.date &&
    !row.entries.some((entry) => timestampMatchesDate(entry.timestamp, filter.date))
  ) {
    return false;
  }
  const mode = filter.mode ?? filter.entrypoint;
  if (
    mode &&
    ![row.entrypoint, row.serviceTier, row.model].some((value) =>
      textIncludes(value, mode)
    )
  ) {
    return false;
  }
  return true;
}

export function filterCostDataByRoute(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  sessions: Session[],
  filter: RouteFilter | undefined
) {
  // Built once per call, not once per row (#3172). Only a `project` filter
  // consults attribution, so anything else pays nothing for the index.
  const projectBySession = filter?.project
    ? buildSessionProjectIndex(sessions)
    : undefined;
  const filteredTokenData = tokenData.filter((row) =>
    tokenDataMatchesRoute(row, sessions, filter, projectBySession)
  );
  if (!filter || Object.keys(filter).length === 0) {
    return { tokenData: filteredTokenData, toolData, sessions };
  }
  const sessionIds = new Set(filteredTokenData.map((row) => row.sessionId));
  return {
    tokenData: filteredTokenData,
    toolData: toolData.filter((row) => sessionIds.has(row.sessionId)),
    sessions: sessions.filter((session) => sessionIds.has(session.sessionId)),
  };
}

export type ScopedCostData = ReturnType<typeof filterCostDataByRoute>;

/**
 * Reduced recommendation engine input for a route-scoped Cost/Reclaim view:
 * the three real Cost collections, the other three REQUIRED base fields empty,
 * every optional signal omitted. Mirrors the object ReclaimCompassComputedCard
 * builds inline (#2718 server-safe boundary).
 */
export function reclaimScopedInput(scoped: ScopedCostData): RecommendationViews {
  return {
    tokenData: scoped.tokenData,
    toolData: scoped.toolData,
    sessions: scoped.sessions,
    projects: EMPTY_ROWS,
    permissionRows: EMPTY_ROWS,
    apiErrors: EMPTY_ROWS,
  };
}
