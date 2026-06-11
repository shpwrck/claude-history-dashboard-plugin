/**
 * Per-agent-type effectiveness rollup.
 *
 * Combines four already-parsed shapes — `toolData` (Task tool calls),
 * `attribution` (native `attributionAgent` token cost), `agentSettings`
 * (per-session agent-setting events), and `runtimeEvents` (turn / stop-hook
 * telemetry) — into one row per `subagent_type`. Heuristics noted inline.
 *
 * The "what happens after the agent returns" signals (artifact rate, no-op
 * rate, common follow-ups) reach for the parent session's next tool call(s)
 * in timestamp order after each Task call. Nothing here cross-references
 * subagent-internal transcripts; we only see what the parent did once the
 * agent handed control back.
 */

import type { ToolUsageData, ToolCall } from './parse-tools';
import type { SessionAttribution, AgentSettingEvent } from './parse-agents';
import type { RuntimeEvents } from './parse-runtime-events';
import type { SessionTokenData } from '../types';
import { UNSPECIFIED_BUCKET, AGENT_SPAWN_TOOLS } from './parse-agents';
import { estimateCost } from './parse-sessions';

/** Tools whose presence after a Task call counts as a tangible artifact. */
const ARTIFACT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

/** Window after a Task call within which the parent's next action is "the follow-up". */
const FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;

export interface AgentEffectivenessRow {
  /** The `subagent_type` string from the Task input, or `_unspecified`. */
  agentType: string;
  runs: number;
  medianTimeToResultMs: number;
  /** Fraction (0..1) of runs whose next parent action was an artifact tool. */
  produceArtifactRate: number;
  /** Fraction (0..1) of runs with no parent follow-up within the window. */
  noOpRate: number;
  /** Estimated USD spent on this agent's transcripts, mean per run. */
  meanCostUsd: number;
  /** Top 3 follow-up parent tool names with counts. */
  commonFollowUps: Array<{ toolName: string; count: number }>;
  /** Runs whose Task call itself reported an error (proxy for apiError / agent failure). */
  failureModes: number;
  /** Sessions that ran this agent at least once. */
  sessionCount: number;
}

export interface AgentSuggestion {
  agentType: string;
  /** Free-text rendering. UI marks every entry as a heuristic. */
  message: string;
  /** Optional counts so the UI can sort or filter. */
  weight: number;
}

interface AgentAccumulator {
  runs: number;
  durations: number[];
  artifactRuns: number;
  noOpRuns: number;
  followUps: Map<string, number>;
  failures: number;
  sessions: Set<string>;
}

function emptyAcc(): AgentAccumulator {
  return {
    runs: 0,
    durations: [],
    artifactRuns: 0,
    noOpRuns: 0,
    followUps: new Map(),
    failures: 0,
    sessions: new Set(),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function taskAgentType(call: ToolCall): string | null {
  // #452: agent spawns appear as 'Task' or 'Agent' — match both (shared set).
  if (!AGENT_SPAWN_TOOLS.has(call.toolName)) return null;
  const raw = call.input?.subagent_type;
  return typeof raw === 'string' && raw.length > 0 ? raw : UNSPECIFIED_BUCKET;
}

/**
 * Scan one session's calls and update accumulators for each Task spawn.
 *
 * For every Task call we find the parent's first non-Task tool call that
 * occurred after it (timestamp-wise) and use that as the "follow-up". If
 * nothing within {@link FOLLOW_UP_WINDOW_MS} follows, the run counts as a no-op.
 */
function recordTaskRuns(
  session: ToolUsageData,
  accs: Map<string, AgentAccumulator>
): void {
  const sorted = session.calls
    .map((call) => ({ call, t: Date.parse(call.timestamp) }))
    .filter((row) => !isNaN(row.t))
    .sort((a, b) => a.t - b.t);

  for (let i = 0; i < sorted.length; i++) {
    const { call, t } = sorted[i];
    const agentType = taskAgentType(call);
    if (agentType === null) continue;

    const acc = accs.get(agentType) ?? emptyAcc();
    acc.runs += 1;
    acc.sessions.add(session.sessionId);
    if (call.isError === true) acc.failures += 1;

    let followUp: ToolCall | null = null;
    let followUpT = 0;
    for (let j = i + 1; j < sorted.length; j++) {
      const next = sorted[j];
      // Skip chained agent-spawn calls (Task/Agent) when looking for the
      // parent's next real follow-up tool (#452).
      if (AGENT_SPAWN_TOOLS.has(next.call.toolName)) continue;
      followUp = next.call;
      followUpT = next.t;
      break;
    }

    if (followUp && followUpT - t <= FOLLOW_UP_WINDOW_MS) {
      acc.durations.push(followUpT - t);
      acc.followUps.set(
        followUp.toolName,
        (acc.followUps.get(followUp.toolName) ?? 0) + 1
      );
      if (ARTIFACT_TOOLS.has(followUp.toolName)) acc.artifactRuns += 1;
    } else {
      acc.noOpRuns += 1;
    }

    accs.set(agentType, acc);
  }
}

/**
 * Build a `agentType → mean cost per run` table from the native attribution
 * output-token tallies and the per-session token data (which carries model
 * pricing). Each session attributes its share of cost to each agent in
 * proportion to that agent's `outputTokens` over the session's total output
 * tokens; the result is divided by `runs` for that agent.
 */
function meanCostByAgent(
  attribution: SessionAttribution[],
  tokenData: SessionTokenData[],
  runsByAgent: Map<string, number>
): Map<string, number> {
  const costByAgent = new Map<string, number>();
  const tokenIndex = new Map<string, SessionTokenData>();
  for (const t of tokenData) tokenIndex.set(t.sessionId, t);

  for (const session of attribution) {
    const tokens = tokenIndex.get(session.sessionId);
    if (!tokens) continue;
    const sessionCost = estimateCost(tokens);
    const sessionOutput = tokens.totalOutputTokens;
    if (sessionCost <= 0 || sessionOutput <= 0) continue;

    for (const [agentName, c] of Object.entries(session.agents)) {
      if (c.outputTokens <= 0) continue;
      const share = (c.outputTokens / sessionOutput) * sessionCost;
      costByAgent.set(agentName, (costByAgent.get(agentName) ?? 0) + share);
    }
  }

  const out = new Map<string, number>();
  for (const [agent, total] of costByAgent.entries()) {
    const runs = runsByAgent.get(agent) ?? 0;
    if (runs <= 0) continue;
    out.set(agent, total / runs);
  }
  return out;
}

/**
 * Compute per-agent effectiveness rows.
 *
 * `agentSettings` is unused by the math today but kept in the signature so
 * future heuristics (e.g. "agent X was reconfigured mid-run") can flow through
 * the same call site without a churn of all callers. `runtimeEvents` is used
 * only as a lightweight signal for total turn count (future expansion);
 * failure-mode counts come from Task `isError`.
 */
export function computeAgentEffectiveness(
  agentSettings: AgentSettingEvent[],
  attribution: SessionAttribution[],
  runtimeEvents: RuntimeEvents[],
  toolData: ToolUsageData[],
  tokenData: SessionTokenData[] = []
): AgentEffectivenessRow[] {
  void agentSettings;
  void runtimeEvents;

  const accs = new Map<string, AgentAccumulator>();
  for (const session of toolData) recordTaskRuns(session, accs);

  const runsByAgent = new Map<string, number>();
  for (const [agent, acc] of accs.entries()) runsByAgent.set(agent, acc.runs);
  const costs = meanCostByAgent(attribution, tokenData, runsByAgent);

  const rows: AgentEffectivenessRow[] = [];
  for (const [agentType, acc] of accs.entries()) {
    const followUps = Array.from(acc.followUps.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    rows.push({
      agentType,
      runs: acc.runs,
      medianTimeToResultMs: median(acc.durations),
      produceArtifactRate: acc.runs === 0 ? 0 : acc.artifactRuns / acc.runs,
      noOpRate: acc.runs === 0 ? 0 : acc.noOpRuns / acc.runs,
      meanCostUsd: costs.get(agentType) ?? 0,
      commonFollowUps: followUps,
      failureModes: acc.failures,
      sessionCount: acc.sessions.size,
    });
  }

  return rows.sort((a, b) => b.runs - a.runs);
}

/**
 * Heuristic workflow suggestions, derived from the same rollup.
 *
 * Every entry is heuristic — callers should label them as such in the UI. We
 * surface three kinds of nudge:
 *   1. An agent that almost always leads to an edit → recommend a sequence
 *      ("X-then-edit" workflow).
 *   2. An agent with a high no-op rate → flag it as "rarely actioned".
 *   3. An agent with repeat failures → flag it.
 */
export function suggestAgentWorkflows(
  rows: AgentEffectivenessRow[]
): AgentSuggestion[] {
  const out: AgentSuggestion[] = [];

  for (const row of rows) {
    if (row.runs < 3) continue;

    if (row.produceArtifactRate >= 0.6 && row.commonFollowUps[0]) {
      const top = row.commonFollowUps[0];
      out.push({
        agentType: row.agentType,
        message: `${row.agentType} was used ${row.runs}× and the parent's next move was ${top.toolName} ${top.count}/${row.runs} times — consider an explorer-first workflow.`,
        weight: row.runs * row.produceArtifactRate,
      });
    }

    if (row.noOpRate >= 0.5) {
      out.push({
        agentType: row.agentType,
        message: `${row.agentType} ran ${row.runs}× but ${Math.round(row.noOpRate * 100)}% of runs had no parent follow-up — output may not be actionable.`,
        weight: row.runs * row.noOpRate,
      });
    }

    if (row.failureModes > 0 && row.failureModes / row.runs >= 0.25) {
      out.push({
        agentType: row.agentType,
        message: `${row.agentType} reported errors in ${row.failureModes}/${row.runs} runs — review prompt or input shape.`,
        weight: row.failureModes,
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Reliable publication gate for the "Suggested agent tasks" card (#1172).
 *
 * `suggestAgentWorkflows` above is the raw heuristic: it will produce a nudge
 * from as few as 3 runs of a single agent in an otherwise empty history, with
 * no signal of how much evidence backs it. That is exactly why the card was
 * pulled in #1054 — it published thin, single-session noise as if it were an
 * actionable recommendation.
 *
 * This wrapper is the contract the card re-renders against. It only publishes a
 * suggestion when the originating agent clears an evidence floor (enough runs
 * across enough distinct sessions that the rates are not a one-session
 * artifact), stamps each surviving suggestion with a confidence drawn from that
 * sample size, and reports an honest status so the UI degrades to a gated empty
 * state instead of implying recommendations are always available. The data path
 * itself is the same client-side parse pipeline that feeds the rest of the view,
 * so it publishes identically in server and SPA mode.
 */
export const SUGGESTION_MIN_RUNS = 5;
export const SUGGESTION_MIN_SESSIONS = 2;
const SUGGESTION_HIGH_RUNS = 12;
const SUGGESTION_HIGH_SESSIONS = 3;

export type SuggestionConfidence = 'medium' | 'high';

export interface PublishedAgentSuggestion extends AgentSuggestion {
  confidence: SuggestionConfidence;
  /** Sample size behind the suggestion, surfaced so readers can weight it. */
  runs: number;
  sessionCount: number;
}

export interface AgentSuggestionPublication {
  /**
   * - `ok` — at least one suggestion cleared the gate.
   * - `insufficient-evidence` — no agent type cleared the run/session floor.
   * - `no-signal` — agents cleared the floor, but no heuristic rule fired.
   */
  status: 'ok' | 'insufficient-evidence' | 'no-signal';
  suggestions: PublishedAgentSuggestion[];
  /** Floor thresholds, exposed so the empty state can explain the gate. */
  minRuns: number;
  minSessions: number;
  /** Agent types that had runs but did not clear the evidence floor. */
  withheld: number;
}

/** Confidence from sample size, or `null` when below the publication floor. */
function suggestionConfidence(
  row: AgentEffectivenessRow
): SuggestionConfidence | null {
  if (row.runs >= SUGGESTION_HIGH_RUNS && row.sessionCount >= SUGGESTION_HIGH_SESSIONS) {
    return 'high';
  }
  if (row.runs >= SUGGESTION_MIN_RUNS && row.sessionCount >= SUGGESTION_MIN_SESSIONS) {
    return 'medium';
  }
  return null;
}

export function publishAgentTaskSuggestions(
  rows: AgentEffectivenessRow[]
): AgentSuggestionPublication {
  const confByAgent = new Map<string, SuggestionConfidence>();
  const eligible: AgentEffectivenessRow[] = [];
  let withheld = 0;

  for (const row of rows) {
    if (row.runs <= 0) continue;
    const confidence = suggestionConfidence(row);
    if (confidence === null) {
      withheld += 1;
      continue;
    }
    confByAgent.set(row.agentType, confidence);
    eligible.push(row);
  }

  const rowByAgent = new Map(eligible.map((row) => [row.agentType, row]));
  const suggestions: PublishedAgentSuggestion[] = suggestAgentWorkflows(eligible).map(
    (s) => {
      const row = rowByAgent.get(s.agentType);
      return {
        ...s,
        confidence: confByAgent.get(s.agentType) ?? 'medium',
        runs: row?.runs ?? 0,
        sessionCount: row?.sessionCount ?? 0,
      };
    }
  );

  let status: AgentSuggestionPublication['status'];
  if (suggestions.length > 0) {
    status = 'ok';
  } else if (eligible.length > 0) {
    status = 'no-signal';
  } else {
    status = 'insufficient-evidence';
  }

  return {
    status,
    suggestions,
    minRuns: SUGGESTION_MIN_RUNS,
    minSessions: SUGGESTION_MIN_SESSIONS,
    withheld,
  };
}
