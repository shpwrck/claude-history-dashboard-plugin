import type { SessionTokenData, TokenEntry } from '../types';
import type { ToolUsageData } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import type { ApiErrorEvent } from './parse-errors';
import { estimateCost } from './parse-sessions';
import { OVER_WINDOW } from './context-health';

export interface SessionOverviewCount {
  name: string;
  count: number;
}

export interface SessionOverview {
  sessionId: string;
  hasData: boolean;

  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  estimatedCost: number;
  hasUnknownModel: boolean;
  model?: string;

  uniqueTools: number;
  totalToolInvocations: number;
  topTools: SessionOverviewCount[];

  topFiles: SessionOverviewCount[];

  errorCount: number;
  toolErrorCount: number;
  apiErrorCount: number;

  compactionCount: number;
  firstCompactionAt?: string;

  durationMs: number;
  startTime?: string;
  endTime?: string;

  userTurns: number;

  peakContextTokens: number;
  peakContextPercent: number;
}

const FILE_TOOLS = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

function contextSize(entry: TokenEntry): number {
  return entry.inputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
}

function peakContextSize(entries: TokenEntry[]): number {
  let peak = 0;
  for (const e of entries) {
    const c = contextSize(e);
    if (c > peak) peak = c;
  }
  return peak;
}

function topN<T extends { count: number }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => b.count - a.count).slice(0, n);
}

export function computeSessionOverview(
  sessionId: string,
  tokenData: SessionTokenData | undefined,
  toolData: ToolUsageData | undefined,
  timeline: SessionTimeline | undefined,
  apiErrors: ApiErrorEvent[]
): SessionOverview {
  const empty: SessionOverview = {
    sessionId,
    hasData: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    hasUnknownModel: false,
    uniqueTools: 0,
    totalToolInvocations: 0,
    topTools: [],
    topFiles: [],
    errorCount: 0,
    toolErrorCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    durationMs: 0,
    userTurns: 0,
    peakContextTokens: 0,
    peakContextPercent: 0,
  };

  if (!tokenData && !toolData && !timeline && apiErrors.length === 0) {
    return empty;
  }

  const overview: SessionOverview = { ...empty, hasData: true };

  if (tokenData) {
    overview.totalInputTokens = tokenData.totalInputTokens;
    overview.totalOutputTokens = tokenData.totalOutputTokens;
    overview.totalCacheCreationTokens = tokenData.totalCacheCreationTokens;
    overview.totalCacheReadTokens = tokenData.totalCacheReadTokens;
    overview.totalTokens =
      tokenData.totalInputTokens +
      tokenData.totalOutputTokens +
      tokenData.totalCacheCreationTokens +
      tokenData.totalCacheReadTokens;
    overview.estimatedCost = estimateCost(tokenData);
    overview.hasUnknownModel = tokenData.hasUnknownModel;
    overview.model = tokenData.model;
    overview.compactionCount = tokenData.compactionEvents.length;
    overview.firstCompactionAt = tokenData.compactionEvents[0]?.timestamp;
    overview.peakContextTokens = peakContextSize(tokenData.entries);
    overview.peakContextPercent =
      OVER_WINDOW > 0
        ? Math.min(100, (overview.peakContextTokens / OVER_WINDOW) * 100)
        : 0;
  }

  if (toolData) {
    overview.totalToolInvocations = toolData.calls.length;
    const toolCounts = new Map<string, number>();
    const fileCounts = new Map<string, number>();
    let toolErrors = 0;
    for (const call of toolData.calls) {
      toolCounts.set(call.toolName, (toolCounts.get(call.toolName) ?? 0) + 1);
      if (call.isError === true) toolErrors += 1;
      if (FILE_TOOLS.has(call.toolName)) {
        const fp = call.input.file_path;
        if (typeof fp === 'string' && fp.length > 0) {
          fileCounts.set(fp, (fileCounts.get(fp) ?? 0) + 1);
        }
      }
    }
    overview.uniqueTools = toolCounts.size;
    overview.topTools = topN(
      Array.from(toolCounts, ([name, count]) => ({ name, count })),
      5
    );
    overview.topFiles = topN(
      Array.from(fileCounts, ([name, count]) => ({ name, count })),
      5
    );
    overview.toolErrorCount = toolErrors;
  }

  overview.apiErrorCount = apiErrors.length;
  overview.errorCount = overview.toolErrorCount + overview.apiErrorCount;

  if (timeline) {
    overview.startTime = timeline.startTime;
    overview.endTime = timeline.endTime;
    const start = Date.parse(timeline.startTime);
    const end = Date.parse(timeline.endTime);
    overview.durationMs =
      isFinite(start) && isFinite(end) && end >= start ? end - start : 0;
    overview.userTurns = timeline.entries.filter(
      (e) => e.kind === 'user' && (e.summaryLen ?? e.summary?.length ?? 0) > 0
    ).length;
  }

  return overview;
}
