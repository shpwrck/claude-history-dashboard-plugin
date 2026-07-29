import type { Session, SessionTokenData } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import type { RouteFilter } from './routing';

export function textIncludes(
  value: string | null | undefined,
  query: string | undefined
) {
  if (!query) return true;
  return value?.toLowerCase().includes(query.toLowerCase()) ?? false;
}

export function timestampMatchesDate(
  timestamp: number | string,
  date: string | undefined
) {
  if (!date) return true;
  const iso =
    typeof timestamp === 'number'
      ? Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : ''
      : timestamp;
  return iso.startsWith(date);
}

export function sessionProject(
  sessionId: string,
  sessions: Session[] | undefined
) {
  return sessions?.find((session) => session.sessionId === sessionId)?.project;
}

/**
 * Session-id -> project index for the route filters (#3172).
 *
 * `sessionProject` is an `Array.find`, so calling it once per row makes a
 * filter O(rows x sessions). The attribution it looks up is static for the
 * whole operation, so that scan is rebuilt work rather than needed work: build
 * this once per filtering call and resolve each row in O(1).
 *
 * FIRST WRITE WINS, deliberately. `Array.find` returns the EARLIEST match, so
 * a duplicated session id has to keep resolving to the entry it resolved to
 * before. A plain `set` per session would keep the LAST one and quietly change
 * results on exactly the large corpora this index exists to speed up.
 */
export function buildSessionProjectIndex(
  sessions: Session[] | undefined
): Map<string, string | undefined> {
  const index = new Map<string, string | undefined>();
  if (!sessions) return index;
  for (const session of sessions) {
    if (!index.has(session.sessionId)) index.set(session.sessionId, session.project);
  }
  return index;
}

export function filterToolDataByRoute(
  rows: ToolUsageData[],
  sessions: Session[] | undefined,
  filter: RouteFilter | undefined
): ToolUsageData[] {
  const project = filter?.project;
  const date = filter?.date;
  const tool = filter?.tool;
  const file = filter?.file;
  if (!project && !date && !tool && !file) return rows;

  const projectBySession = project ? buildSessionProjectIndex(sessions) : undefined;

  return rows.flatMap((row) => {
    if (project && !textIncludes(projectBySession!.get(row.sessionId), project)) {
      return [];
    }
    const calls = row.calls.filter(
      (call) =>
        timestampMatchesDate(call.timestamp, date) &&
        textIncludes(call.toolName, tool) &&
        textIncludes(call.input.file_path, file)
    );
    return calls.length > 0 ? [{ ...row, calls }] : [];
  });
}

/**
 * Scope per-session token rows to a route filter's `project` / `date` keys —
 * the same honored keys the Errors view filters by (`filterApiErrorsByRoute`).
 *
 * Context Health derives every panel (compactions, peak-context, cache, health
 * scores) from `tokenData`, so narrowing the rows here is enough to scope the
 * whole view. A row matches `date` when ANY of its token entries carries a
 * timestamp on that day (a session can span midnight). There is intentionally
 * NO `session` key: `ROUTE_FILTER_KEYS` has none, and routing a session id
 * through a key the view ignores lands on an empty view (the #1812 dead-end);
 * project+date is the most-scoped honored target for a per-session drill.
 */
export function filterTokenDataByRoute(
  rows: SessionTokenData[],
  filter: RouteFilter | undefined
): SessionTokenData[] {
  const project = filter?.project;
  const date = filter?.date;
  if (!project && !date) return rows;

  return rows.filter((row) => {
    if (project && !textIncludes(row.project, project)) return false;
    if (date && !row.entries.some((entry) => timestampMatchesDate(entry.timestamp, date))) {
      return false;
    }
    return true;
  });
}

export function filterApiErrorsByRoute(
  rows: ApiErrorEvent[],
  sessions: Session[] | undefined,
  filter: RouteFilter | undefined
): ApiErrorEvent[] {
  const project = filter?.project;
  const date = filter?.date;
  if (!project && !date) return rows;

  const projectBySession = project ? buildSessionProjectIndex(sessions) : undefined;

  return rows.filter(
    (row) =>
      timestampMatchesDate(row.timestamp, date) &&
      (!project || textIncludes(projectBySession!.get(row.sessionId), project))
  );
}
