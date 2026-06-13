import type { AssistantFeatures, SessionTokenData } from '../types';
import type { ApiErrorEvent } from './parse-errors';
import type { ToolUsageData } from './parse-tools';
import type { SessionTimeline } from './parse-timeline';
import {
  aggregatePerTaskCost,
  type RuntimeEvents,
} from './parse-runtime-events';
import { estimateCost } from './parse-sessions';
import {
  computeSessionOutcomes,
  type SessionOutcomeAnchor,
} from './parse-timeline-success';
import {
  HIGH_GROWTH_PER_HOUR,
  OVER_WINDOW,
  PEAK_CONTEXT_WARN,
} from './context-health';
import { detectDangerousCommands } from './parse-permissions';

export const SCORECARD_AXIS_IDS = [
  'cost',
  'outcome',
  'speed',
  'security',
  'portability',
  'reliability',
  'focus',
] as const;

export type ScorecardAxisId = (typeof SCORECARD_AXIS_IDS)[number];
export type ScoreConfidence = 'high' | 'medium' | 'low';

export interface SessionScorecardAxis {
  id: ScorecardAxisId;
  label: string;
  score: number;
  confidence: ScoreConfidence;
  evidence: string[];
}

export interface SessionScorecard {
  sessionId: string;
  axes: SessionScorecardAxis[];
}

export interface SessionScorecardInput {
  sessionId: string;
  tokenData?: SessionTokenData;
  toolData?: ToolUsageData;
  timeline?: SessionTimeline;
  runtimeEvents?: RuntimeEvents;
  apiErrors?: ApiErrorEvent[];
  permissionRows?: { mode: string; sessionId: string }[];
  assistantFeatures?: AssistantFeatures;
  sessionOutcome?: {
    good: boolean;
    anchor: SessionOutcomeAnchor;
  };
}

const AXIS_LABELS: Record<ScorecardAxisId, string> = {
  cost: 'Cost efficiency',
  outcome: 'Outcome',
  speed: 'Speed',
  security: 'Security / safety',
  portability: 'Portability',
  reliability: 'Reliability',
  focus: 'Focus / scope',
};

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const NEUTRAL_SCORE = 50;
const MEDIUM_CONFIDENCE_SCORE_FACTOR = 0.4;
const MAX_CACHE_HIT_PENALTY = 12;
const PORTABILITY_HIGH_CONFIDENCE_MIN_CALLS = 2;
const CLAUDE_SPECIFIC_TOOLS = new Set([
  'Skill',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'AskUserQuestion',
]);

function clampScore(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function applyConfidenceFloor(score: number, confidence: ScoreConfidence): number {
  const clamped = clampScore(score);
  if (confidence === 'high' || clamped <= NEUTRAL_SCORE) return clamped;
  const factor = confidence === 'medium' ? MEDIUM_CONFIDENCE_SCORE_FACTOR : 0;
  return NEUTRAL_SCORE + (clamped - NEUTRAL_SCORE) * factor;
}

function axis(
  id: ScorecardAxisId,
  score: number,
  confidence: ScoreConfidence,
  evidence: string[]
): SessionScorecardAxis {
  return {
    id,
    label: AXIS_LABELS[id],
    score: clampScore(score),
    confidence,
    evidence: evidence.length > 0 ? evidence : ['No concrete signal available.'],
  };
}

function contextSize(entry: SessionTokenData['entries'][number]): number {
  return entry.inputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
}

function peakContextSize(data: SessionTokenData): number {
  let peak = 0;
  for (const entry of data.entries) {
    peak = Math.max(peak, contextSize(entry));
  }
  return peak;
}

function hoursBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
  return (end - start) / (1000 * 60 * 60);
}

function contextGrowthPerHour(data: SessionTokenData): number {
  if (data.entries.length < 2) return 0;
  const first = data.entries[0];
  const last = data.entries[data.entries.length - 1];
  const hours = hoursBetween(first.timestamp, last.timestamp);
  if (hours <= 0) return 0;
  return Math.max(0, (contextSize(last) - contextSize(first)) / hours);
}

function sessionDurationMs(timeline?: SessionTimeline): number {
  if (!timeline) return 0;
  const start = Date.parse(timeline.startTime);
  const end = Date.parse(timeline.endTime);
  return isFinite(start) && isFinite(end) && end >= start ? end - start : 0;
}

function userTurnCount(timeline?: SessionTimeline): number {
  if (!timeline) return 0;
  return timeline.entries.filter(
    (entry) =>
      entry.kind === 'user' && (entry.summaryLen ?? entry.summary?.length ?? 0) > 0
  ).length;
}

function toolErrorCount(toolData?: ToolUsageData): number {
  return toolData?.calls.filter((call) => call.isError === true).length ?? 0;
}

function uniqueFileCount(toolData?: ToolUsageData): number {
  if (!toolData) return 0;
  const files = new Set<string>();
  for (const call of toolData.calls) {
    if (!FILE_TOOLS.has(call.toolName)) continue;
    const file = call.input.file_path;
    if (file) files.add(file);
  }
  return files.size;
}

function repeatedCommandCount(toolData?: ToolUsageData): number {
  if (!toolData) return 0;
  const counts = new Map<string, number>();
  for (const call of toolData.calls) {
    if (call.toolName !== 'Bash') continue;
    const command = call.commandFingerprint ?? call.input.command ?? call.commandPreview;
    if (!command) continue;
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }
  let repeats = 0;
  for (const count of counts.values()) {
    if (count > 1) repeats += count - 1;
  }
  return repeats;
}

function taskSpanCount(input: SessionScorecardInput): number {
  if (!input.runtimeEvents || !input.tokenData) return 0;
  return aggregatePerTaskCost([input.runtimeEvents], [input.tokenData]).taskCount;
}

function cacheHitPenalty(hitRate: number): number {
  if (!isFinite(hitRate)) return 0;
  return Math.max(0, Math.min(MAX_CACHE_HIT_PENALTY, (1 - hitRate) * MAX_CACHE_HIT_PENALTY));
}

function eventAfter(timestamp: string, afterMs: number): boolean {
  const t = Date.parse(timestamp);
  return isFinite(t) && t > afterMs;
}

function hasSessionSignalAfter(input: SessionScorecardInput, timestamp: string): boolean {
  const afterMs = Date.parse(timestamp);
  if (!isFinite(afterMs)) return false;
  if (input.timeline?.endTime && eventAfter(input.timeline.endTime, afterMs)) return true;
  if (input.timeline?.entries.some((entry) => eventAfter(entry.timestamp, afterMs))) return true;
  if (input.tokenData?.entries.some((entry) => eventAfter(entry.timestamp, afterMs))) return true;
  if (input.toolData?.calls.some((call) => eventAfter(call.timestamp, afterMs))) return true;
  const runtime = input.runtimeEvents;
  if (!runtime) return false;
  return (
    runtime.turns.some((event) => eventAfter(event.timestamp, afterMs)) ||
    runtime.stopHooks.some((event) => eventAfter(event.timestamp, afterMs)) ||
    runtime.awaySummaries.some((event) => eventAfter(event.timestamp, afterMs)) ||
    runtime.scheduledFires.some((event) => eventAfter(event.timestamp, afterMs))
  );
}

function recoveredApiError(input: SessionScorecardInput, event: ApiErrorEvent): boolean {
  if (
    typeof event.retryAttempt === 'number' &&
    typeof event.maxRetries === 'number' &&
    event.retryAttempt < event.maxRetries
  ) {
    return true;
  }
  return hasSessionSignalAfter(input, event.timestamp);
}

function scoreCost(input: SessionScorecardInput): SessionScorecardAxis {
  const data = input.tokenData;
  if (!data || data.entries.length === 0) {
    return axis('cost', 50, 'low', ['No token/cost data for this session.']);
  }

  let score = 100;
  const evidence: string[] = [];
  const cost = estimateCost(data);
  const peak = peakContextSize(data);
  const growth = contextGrowthPerHour(data);
  const cacheTotal = data.totalCacheReadTokens + data.totalCacheCreationTokens;
  const hitRate = cacheTotal > 0 ? data.totalCacheReadTokens / cacheTotal : 0;

  if (cost > 10) score -= 35;
  else if (cost > 3) score -= 25;
  else if (cost > 1) score -= 12;
  evidence.push(`Estimated cost ${cost.toFixed(2)} USD.`);

  if (peak > OVER_WINDOW) {
    score -= 30;
    evidence.push(`Peak context ${(peak / 1000).toFixed(0)}k exceeded the usable window.`);
  } else if (peak > PEAK_CONTEXT_WARN) {
    score -= 18;
    evidence.push(`Peak context ${(peak / 1000).toFixed(0)}k crossed the warning threshold.`);
  }

  if (data.compactionEvents.length > 0) {
    score -= Math.min(30, data.compactionEvents.length * 10);
    evidence.push(`${data.compactionEvents.length} compaction event(s) increased context cost risk.`);
  }

  if (growth > HIGH_GROWTH_PER_HOUR) {
    score -= 10;
    evidence.push(`Context grew ${(growth / 1000).toFixed(0)}k tokens/hour.`);
  }

  if (cacheTotal > 0) {
    const penalty = cacheHitPenalty(hitRate);
    evidence.push(`Cache hit rate ${(hitRate * 100).toFixed(0)}%.`);
    score -= penalty;
  }

  if (data.hasUnknownModel) {
    score -= 5;
    evidence.push('Unknown model pricing made cost an estimate.');
  }

  return axis('cost', score, 'high', evidence);
}

function fallbackSessionOutcome(
  input: SessionScorecardInput
): { good: boolean; anchor: SessionOutcomeAnchor } | undefined {
  if (!input.timeline) return undefined;
  return computeSessionOutcomes(
    [input.timeline],
    input.tokenData ? [input.tokenData] : [],
    input.toolData ? [input.toolData] : [],
    input.apiErrors ?? [],
    new Map()
  ).get(input.sessionId);
}

function scoreOutcome(input: SessionScorecardInput): SessionScorecardAxis {
  const sessionOutcome = input.sessionOutcome ?? fallbackSessionOutcome(input);
  const toolErrors = toolErrorCount(input.toolData);
  const apiErrors = input.apiErrors?.length ?? 0;
  const totalErrors = toolErrors + apiErrors;
  const compactions = input.tokenData?.compactionEvents.length ?? 0;
  const cost = input.tokenData ? estimateCost(input.tokenData) : undefined;

  if (!sessionOutcome) {
    return axis('outcome', 50, 'low', ['No deterministic outcome signal for this session.']);
  }

  const evidence: string[] = [];
  let proxyPoints = 0;

  if (totalErrors === 0) proxyPoints += 1;
  if (compactions === 0) proxyPoints += 1;
  if (cost == null || cost <= 1) proxyPoints += 1;

  let score = sessionOutcome.good ? 64 : 34;
  score += proxyPoints * 10;

  if (sessionOutcome.anchor === 'label') {
    score += sessionOutcome.good ? 6 : -6;
    evidence.push(
      `Outcome anchored by a ${sessionOutcome.good ? 'good' : 'bad'} session label.`
    );
  } else {
    evidence.push(
      `Outcome inferred from deterministic proxy signals (${proxyPoints}/3 clean points).`
    );
  }

  if (totalErrors > 0) {
    score -= Math.min(12, totalErrors * 3);
    evidence.push(`${totalErrors} tool/API error signal(s).`);
  } else if (input.toolData || input.apiErrors) {
    evidence.push('No tool/API errors observed.');
  }

  if (compactions > 0) {
    score -= Math.min(10, compactions * 5);
    evidence.push(`${compactions} compaction event(s).`);
  } else if (input.tokenData) {
    evidence.push('No compaction event observed.');
  }

  if (cost != null) {
    evidence.push(`Estimated cost ${cost.toFixed(2)} USD.`);
  }

  return axis(
    'outcome',
    score,
    sessionOutcome.anchor === 'label' ? 'high' : 'medium',
    evidence
  );
}

function scoreSpeed(input: SessionScorecardInput): SessionScorecardAxis {
  const duration = sessionDurationMs(input.timeline);
  const turns = userTurnCount(input.timeline);
  const apiRetries = (input.apiErrors ?? []).filter((event) => (event.retryAttempt ?? 0) > 1).length;

  if (!input.timeline) {
    return axis('speed', 50, 'low', ['No timeline data for this session.']);
  }

  const evidence: string[] = [];
  const minutesPerTurn = turns > 0 ? duration / turns / 60_000 : duration / 60_000;

  let score: number;
  if (minutesPerTurn <= 2) score = 95;
  else if (minutesPerTurn <= 10) score = 82;
  else if (minutesPerTurn <= 30) score = 62;
  else score = 42;

  evidence.push(`${minutesPerTurn.toFixed(1)} minute(s) per user turn.`);

  if (apiRetries > 0) {
    score -= Math.min(25, apiRetries * 5);
    evidence.push(`${apiRetries} API retry/backoff event(s).`);
  }

  return axis('speed', score, 'medium', evidence);
}

function scoreSecurity(input: SessionScorecardInput): SessionScorecardAxis {
  const permissionRows = input.permissionRows?.filter((row) => row.sessionId === input.sessionId) ?? [];
  const dangerous = input.toolData ? detectDangerousCommands([input.toolData]) : [];
  const highCertaintyDangerous = dangerous.filter((d) => d.certainty === 'high');
  const ambiguousDangerous = dangerous.filter((d) => d.certainty === 'medium');

  if (!input.toolData && permissionRows.length === 0) {
    return axis('security', 50, 'low', ['No tool or permission data for this session.']);
  }

  let score = 100;
  const evidence: string[] = [];
  const modes = new Set(permissionRows.map((row) => row.mode));

  if (modes.has('bypassPermissions')) {
    score -= 30;
    evidence.push('Session used bypassPermissions mode.');
  } else if (permissionRows.length > 0) {
    evidence.push(`Permission modes observed: ${Array.from(modes).sort().join(', ')}.`);
  }

  if (highCertaintyDangerous.length > 0) {
    score -= Math.min(60, highCertaintyDangerous.length * 30);
    evidence.push(
      `${highCertaintyDangerous.length} high-certainty dangerous command pattern(s) detected.`
    );
  }
  if (ambiguousDangerous.length > 0) {
    score -= Math.min(30, ambiguousDangerous.length * 10);
    evidence.push(
      `${ambiguousDangerous.length} ambiguous dangerous command pattern(s) detected.`
    );
  }
  if (dangerous.length === 0 && input.toolData) {
    evidence.push('No dangerous Bash command patterns detected.');
  }

  const confidence: ScoreConfidence =
    ambiguousDangerous.length > 0
      ? 'medium'
      : permissionRows.length > 0
        ? 'high'
        : 'medium';
  return axis('security', applyConfidenceFloor(score, confidence), confidence, evidence);
}

function scorePortability(input: SessionScorecardInput): SessionScorecardAxis {
  const toolData = input.toolData;
  if (!toolData || toolData.calls.length === 0) {
    return axis('portability', 50, 'low', ['No tool-use data to estimate harness portability.']);
  }

  let score = 100;
  const evidence: string[] = [];
  let claudeSpecific = 0;
  let mcpCalls = 0;
  let claudePathRefs = 0;

  for (const call of toolData.calls) {
    if (CLAUDE_SPECIFIC_TOOLS.has(call.toolName)) claudeSpecific += 1;
    if (call.toolName.startsWith('mcp__')) mcpCalls += 1;
    const command = call.input.command ?? '';
    const file = call.input.file_path ?? '';
    if (call.commandMentionsClaudePath || command.includes('.claude') || file.includes('.claude')) {
      claudePathRefs += 1;
    }
  }

  if (claudeSpecific > 0) {
    score -= Math.min(40, claudeSpecific * 8);
    evidence.push(`${claudeSpecific} Claude-specific orchestration/tool call(s).`);
  }
  if (mcpCalls > 0) {
    score -= Math.min(30, mcpCalls * 10);
    evidence.push(`${mcpCalls} MCP tool call(s) may need harness-specific setup.`);
  }
  if (claudePathRefs > 0) {
    score -= Math.min(30, claudePathRefs * 15);
    evidence.push(`${claudePathRefs} reference(s) to .claude-specific paths.`);
  }
  if (evidence.length === 0) {
    evidence.push('Tool use stayed within common shell/file/search operations.');
  }

  const confidence =
    toolData.calls.length >= PORTABILITY_HIGH_CONFIDENCE_MIN_CALLS ? 'high' : 'medium';
  return axis('portability', applyConfidenceFloor(score, confidence), confidence, evidence);
}

function scoreReliability(input: SessionScorecardInput): SessionScorecardAxis {
  const toolData = input.toolData;
  const apiErrors = input.apiErrors ?? [];
  const hookEvents = input.runtimeEvents?.stopHooks.length ?? 0;
  const hookErrors = input.runtimeEvents?.stopHooks.filter((hook) => hook.hadErrors).length ?? 0;

  if (!toolData && apiErrors.length === 0 && hookEvents === 0) {
    return axis('reliability', 50, 'low', ['No tool or API error data for this session.']);
  }

  let score = 100;
  const evidence: string[] = [];
  const errors = toolErrorCount(toolData);
  const calls = toolData?.calls.length ?? 0;
  const errorRate = calls > 0 ? errors / calls : 0;
  const retryEvents = apiErrors.filter((event) => (event.retryAttempt ?? 0) > 1).length;
  const recoveredErrors = apiErrors.filter((event) => recoveredApiError(input, event)).length;
  const unrecoveredErrors = apiErrors.length - recoveredErrors;

  if (errors > 0) {
    score -= Math.min(45, Math.round(errorRate * 100));
    evidence.push(`${errors}/${calls} tool call(s) errored.`);
  }
  if (unrecoveredErrors > 0) {
    score -= Math.min(40, unrecoveredErrors * 10);
    evidence.push(`${unrecoveredErrors} unrecovered API error event(s).`);
  }
  if (recoveredErrors > 0) {
    score -= Math.min(20, recoveredErrors * 4);
    evidence.push(`${recoveredErrors} recovered API error event(s).`);
  }
  if (retryEvents > 0) {
    evidence.push(`${retryEvents} retry/backoff event(s) observed.`);
  }
  if (hookErrors > 0) {
    score -= Math.min(24, hookErrors * 8);
    evidence.push(`${hookErrors} stop-hook error event(s).`);
  } else if (hookEvents > 0) {
    evidence.push('No stop-hook errors observed.');
  }
  if (evidence.length === 0) {
    evidence.push('No tool or API errors observed.');
  }

  const confidence = toolData || input.runtimeEvents ? 'high' : 'medium';
  return axis('reliability', applyConfidenceFloor(score, confidence), confidence, evidence);
}

function scoreFocus(input: SessionScorecardInput): SessionScorecardAxis {
  if (!input.tokenData && !input.toolData && !input.timeline) {
    return axis('focus', 50, 'low', ['No context, tool, or timeline data for this session.']);
  }

  let score = 100;
  const evidence: string[] = [];
  const tokenData = input.tokenData;
  const toolData = input.toolData;
  const turns = userTurnCount(input.timeline);
  const toolCalls = toolData?.calls.length ?? 0;
  const files = uniqueFileCount(toolData);
  const repeats = repeatedCommandCount(toolData);
  const taskSpans = taskSpanCount(input);

  if (tokenData) {
    const peak = peakContextSize(tokenData);
    const growth = contextGrowthPerHour(tokenData);
    if (peak > OVER_WINDOW) {
      score -= 30;
      evidence.push(`Peak context ${(peak / 1000).toFixed(0)}k suggests a sprawling session.`);
    } else if (peak > PEAK_CONTEXT_WARN) {
      score -= 15;
      evidence.push(`Peak context ${(peak / 1000).toFixed(0)}k needs scope control.`);
    }
    if (tokenData.compactionEvents.length > 0) {
      score -= Math.min(25, tokenData.compactionEvents.length * 8);
      evidence.push(`${tokenData.compactionEvents.length} compaction event(s).`);
    }
    if (growth > HIGH_GROWTH_PER_HOUR) {
      score -= 10;
      evidence.push(`Context grew ${(growth / 1000).toFixed(0)}k tokens/hour.`);
    }
  }

  if (toolCalls > 0 && turns > 0) {
    const callsPerTurn = toolCalls / turns;
    if (callsPerTurn > 20) {
      score -= 20;
      evidence.push(`${callsPerTurn.toFixed(1)} tool calls per user turn.`);
    }
  }

  if (files > 20) {
    score -= 15;
    evidence.push(`${files} unique files touched/read.`);
  }
  if (repeats > 0) {
    score -= Math.min(20, repeats * 4);
    evidence.push(`${repeats} repeated Bash command(s).`);
  }
  if (taskSpans > 1) {
    score -= Math.min(24, (taskSpans - 1) * 6);
    evidence.push(`${taskSpans} Stop-hook task span(s) split this session.`);
  } else if (taskSpans === 1) {
    evidence.push('1 Stop-hook task span observed.');
  }
  if (evidence.length === 0) {
    evidence.push('No high-context, high-churn, or repeated-command scope signal observed.');
  }

  const confidence = tokenData && toolData ? 'high' : 'medium';
  return axis('focus', applyConfidenceFloor(score, confidence), confidence, evidence);
}

export function computeSessionScorecard(input: SessionScorecardInput): SessionScorecard {
  return {
    sessionId: input.sessionId,
    axes: [
      scoreCost(input),
      scoreOutcome(input),
      scoreSpeed(input),
      scoreSecurity(input),
      scorePortability(input),
      scoreReliability(input),
      scoreFocus(input),
    ],
  };
}

export function scorecardAxis(
  scorecard: SessionScorecard,
  id: ScorecardAxisId
): SessionScorecardAxis {
  const found = scorecard.axes.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`Missing scorecard axis: ${id}`);
  }
  return found;
}
