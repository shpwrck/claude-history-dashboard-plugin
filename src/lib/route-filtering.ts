import type { Session } from '../types';
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

  return rows.flatMap((row) => {
    if (project && !textIncludes(sessionProject(row.sessionId, sessions), project)) {
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

export function filterApiErrorsByRoute(
  rows: ApiErrorEvent[],
  sessions: Session[] | undefined,
  filter: RouteFilter | undefined
): ApiErrorEvent[] {
  const project = filter?.project;
  const date = filter?.date;
  if (!project && !date) return rows;

  return rows.filter(
    (row) =>
      timestampMatchesDate(row.timestamp, date) &&
      textIncludes(sessionProject(row.sessionId, sessions), project)
  );
}
