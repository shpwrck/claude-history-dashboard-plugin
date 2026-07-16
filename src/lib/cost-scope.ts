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
import { sessionProject, textIncludes, timestampMatchesDate } from './route-filtering';
import type { Session, SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { RouteFilter } from './routing';
import type { RecommendationViews } from './recommendations';

// The Reclaim card calls reclaimScopedInput during render. Keep the intentionally
// empty collections referentially stable so useRecommendations can memoize the
// reduced input across unrelated rerenders (for example ResizeObserver updates).
// This restores the module-level EMPTY_ROWS behavior the extraction replaced.
const EMPTY_ROWS: never[] = [];

export function tokenDataMatchesRoute(
  row: SessionTokenData,
  sessions: Session[],
  filter: RouteFilter | undefined
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (
    filter.project &&
    !textIncludes(row.project ?? sessionProject(row.sessionId, sessions), filter.project)
  ) {
    return false;
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
  const filteredTokenData = tokenData.filter((row) =>
    tokenDataMatchesRoute(row, sessions, filter)
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
