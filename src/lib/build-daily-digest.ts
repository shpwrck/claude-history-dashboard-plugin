import {
  DEFAULT_TASK_CATEGORY,
  TASK_CATEGORY_TAXONOMY,
  type DailyDigest,
  type DailyDigestActivity,
  type DailyDigestCategoryGroup,
  type DailyDigestOutcome,
  type DailyDigestSession,
  type DailyDigestTotal,
  type ProjectDigest,
  type Session,
  type SessionTokenData,
  type TaskCategory,
} from '../types';
import { classifySession } from './classify-session';
import type { ApiErrorEvent } from './parse-errors';
import { shortenProject } from './parse-history';
import type { StatsCache } from './parse-stats-cache';
import type { TaskSuccessProxy } from './parse-task-success';
import type { SessionTimeline } from './parse-timeline';
import { computeSessionOutcomes } from './parse-timeline-success';
import type { ToolCall, ToolUsageData } from './parse-tools';

export interface DailyDigestInput {
  sessions: Session[];
  tokenData?: SessionTokenData[] | null;
  toolData?: ToolUsageData[] | null;
  timelines?: SessionTimeline[] | null;
  apiErrors?: ApiErrorEvent[] | null;
  taskSuccess?: TaskSuccessProxy[] | null;
  statsCache?: StatsCache | null;
  nowMs?: number;
}

const CATEGORY_LABEL = new Map(
  TASK_CATEGORY_TAXONOMY.map((category) => [category.id, category.label])
);
const CATEGORY_ORDER = new Map(
  TASK_CATEGORY_TAXONOMY.map((category, index) => [category.id, index])
);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Server-local calendar day key for digest bucketing.
 *
 * The Diary data layer is intentionally NOT UTC-bucketed: a session belongs to
 * the day the dashboard server would display on its local clock. Tests and
 * callers that need a fixed boundary may pass an IANA `timeZone`.
 */
export function localDigestDateKey(ms: number, timeZone?: string): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  if (timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`;
  }
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-');
}

export function todayDigestDate(timeZone?: string, nowMs = Date.now()): string {
  return localDigestDateKey(nowMs, timeZone);
}

export function isDailyDigestDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function inputFrom(
  sessionsOrInput: Session[] | DailyDigestInput,
  date: string,
  timeZone?: string
): DailyDigestInput & { date: string; timeZone?: string } {
  if (Array.isArray(sessionsOrInput)) {
    return { sessions: sessionsOrInput, date, ...(timeZone ? { timeZone } : {}) };
  }
  return { ...sessionsOrInput, date, ...(timeZone ? { timeZone } : {}) };
}

function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

function prompts(session: Session): string[] {
  return session.entries
    .map((entry) => entry.display)
    .filter((value) => value && value !== 'init' && value !== 'exit');
}

function firstPromptTitle(session: Session): string {
  const title = session.title?.trim();
  if (title) return title;
  const entryTitle = session.entries.find((entry) => entry.title)?.title?.trim();
  if (entryTitle) return entryTitle;
  const prompt = prompts(session)[0]?.trim();
  if (prompt) return prompt.length > 96 ? `${prompt.slice(0, 93)}...` : prompt;
  return 'Untitled session';
}

function toolMap(toolData: ToolUsageData[] | null | undefined) {
  return new Map((toolData ?? []).map((row) => [row.sessionId, row.calls ?? []]));
}

function tokenMap(tokenData: SessionTokenData[] | null | undefined) {
  return new Map((tokenData ?? []).map((row) => [row.sessionId, row]));
}

function normalizeFilePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 120) return trimmed;
  return `...${trimmed.slice(-117)}`;
}

function fileImpact(calls: readonly ToolCall[]): string[] {
  const paths = new Set<string>();
  for (const call of calls) {
    const path = call.input?.file_path;
    if (typeof path === 'string' && path.trim()) {
      paths.add(normalizeFilePath(path));
    }
  }
  return [...paths].slice(0, 8);
}

function latestTaskSuccess(
  taskSuccess: TaskSuccessProxy[] | null | undefined
): Map<string, TaskSuccessProxy> {
  const bySession = new Map<string, TaskSuccessProxy>();
  for (const proxy of taskSuccess ?? []) {
    const existing = bySession.get(proxy.sessionId);
    if (!existing || proxy.endTime.localeCompare(existing.endTime) >= 0) {
      bySession.set(proxy.sessionId, proxy);
    }
  }
  return bySession;
}

function taskSuccessOutcome(proxy: TaskSuccessProxy): DailyDigestOutcome {
  if (proxy.verdict === 'accept') return 'accepted';
  if (proxy.verdict === 'correct') return 'corrected';
  if (proxy.agentClaim === 'blocked') return 'blocked';
  if (proxy.successScore >= 0.65) return 'likely_success';
  if (proxy.successScore <= 0.35) return 'needs_attention';
  return 'neutral';
}

function outcomeMap(input: DailyDigestInput): Map<string, DailyDigestOutcome> {
  const out = new Map<string, DailyDigestOutcome>();
  for (const [sessionId, proxy] of latestTaskSuccess(input.taskSuccess)) {
    out.set(sessionId, taskSuccessOutcome(proxy));
  }
  const timelines = input.timelines ?? [];
  const tokenData = input.tokenData ?? [];
  const toolData = input.toolData ?? [];
  if (timelines.length > 0 && tokenData.length > 0) {
    const computed = computeSessionOutcomes(
      timelines,
      tokenData,
      toolData,
      input.apiErrors ?? [],
      new Map()
    );
    for (const [sessionId, result] of computed) {
      if (!out.has(sessionId)) {
        out.set(sessionId, result.good ? 'positive_proxy' : 'negative_proxy');
      }
    }
  }
  return out;
}

function summarizeSession(
  session: Session,
  calls: readonly ToolCall[],
  token: SessionTokenData | undefined,
  outcome: DailyDigestOutcome | undefined
): DailyDigestSession {
  const taskCategory = classifySession({
    title: session.title,
    prompts: prompts(session),
    project: session.project,
    tokenData: token ?? null,
    toolCalls: calls,
  });
  return {
    sessionId: session.sessionId,
    project: session.project,
    projectShort: session.projectShort || shortenProject(session.project),
    title: firstPromptTitle(session),
    startTime: iso(session.startTime),
    endTime: iso(session.endTime),
    durationMs: session.duration,
    messageCount: session.messageCount,
    toolCallCount: calls.length,
    taskCategory,
    fileImpact: fileImpact(calls),
    ...(outcome ? { outcome } : {}),
  };
}

function groupSessions(
  sessions: DailyDigestSession[]
): DailyDigestCategoryGroup[] {
  const byCategory = new Map<TaskCategory, DailyDigestSession[]>();
  for (const session of sessions) {
    const category = session.taskCategory || DEFAULT_TASK_CATEGORY;
    const list = byCategory.get(category) ?? [];
    list.push(session);
    byCategory.set(category, list);
  }
  return [...byCategory.entries()]
    .sort(
      ([a], [b]) =>
        (CATEGORY_ORDER.get(a) ?? 999) - (CATEGORY_ORDER.get(b) ?? 999)
    )
    .map(([category, rows]) => ({
      category,
      label: CATEGORY_LABEL.get(category) ?? category,
      sessionCount: rows.length,
      messageCount: rows.reduce((sum, row) => sum + row.messageCount, 0),
      toolCallCount: rows.reduce((sum, row) => sum + row.toolCallCount, 0),
      sessions: rows,
    }));
}

function statsActivity(
  statsCache: StatsCache | null | undefined,
  date: string
): DailyDigestActivity | undefined {
  const row = statsCache?.dailyActivity.find((activity) => activity.date === date);
  if (!row) return undefined;
  return {
    date: row.date,
    messageCount: row.messageCount,
    sessionCount: row.sessionCount,
    toolCallCount: row.toolCallCount,
  };
}

function buildTotal(
  date: string,
  sessions: DailyDigestSession[],
  activity: DailyDigestActivity | undefined
): DailyDigestTotal {
  return {
    date,
    sessionCount: sessions.length,
    messageCount: sessions.reduce((sum, session) => sum + session.messageCount, 0),
    toolCallCount: sessions.reduce(
      (sum, session) => sum + session.toolCallCount,
      0
    ),
    categories: groupSessions(sessions),
    ...(activity ? { activity } : {}),
  };
}

function buildProjects(sessions: DailyDigestSession[]): ProjectDigest[] {
  const byProject = new Map<string, DailyDigestSession[]>();
  for (const session of sessions) {
    const list = byProject.get(session.project) ?? [];
    list.push(session);
    byProject.set(session.project, list);
  }
  return [...byProject.entries()]
    .map(([project, rows]) => ({
      project,
      projectShort: rows[0]?.projectShort || shortenProject(project),
      sessionCount: rows.length,
      messageCount: rows.reduce((sum, row) => sum + row.messageCount, 0),
      toolCallCount: rows.reduce((sum, row) => sum + row.toolCallCount, 0),
      categories: groupSessions(rows),
    }))
    .sort((a, b) => {
      if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
      if (b.toolCallCount !== a.toolCallCount) return b.toolCallCount - a.toolCallCount;
      return a.projectShort.localeCompare(b.projectShort);
    });
}

export function buildDailyDigest(
  sessionsOrInput: Session[] | DailyDigestInput,
  date: string,
  timeZone?: string
): DailyDigest {
  const input = inputFrom(sessionsOrInput, date, timeZone);
  const toolsBySession = toolMap(input.toolData);
  const tokensBySession = tokenMap(input.tokenData);
  const outcomes = outcomeMap(input);
  const daySessions = input.sessions
    .filter(
      (session) =>
        Number.isFinite(session.startTime) &&
        localDigestDateKey(session.startTime, input.timeZone) === input.date
    )
    .sort((a, b) => a.startTime - b.startTime)
    .map((session) =>
      summarizeSession(
        session,
        toolsBySession.get(session.sessionId) ?? [],
        tokensBySession.get(session.sessionId),
        outcomes.get(session.sessionId)
      )
    );
  const activity = statsActivity(input.statsCache, input.date);
  return {
    schemaVersion: '1',
    date: input.date,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    generatedAt: iso(input.nowMs ?? Date.now()),
    total: buildTotal(input.date, daySessions, activity),
    projects: buildProjects(daySessions),
  };
}
