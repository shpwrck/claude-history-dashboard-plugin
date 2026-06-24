import type { SessionTokenData, Session, TokenEntry } from '../types';
import type { ToolCall, ToolUsageData } from './parse-tools';
import { estimateCost, estimateEntryCost } from './parse-sessions';
import { shortenProject } from './parse-history';

export interface ToolCostRow {
  toolName: string;
  estimatedCost: number;
  callCount: number;
  sessionCount: number;
}

export interface ProjectCostRow {
  project: string;
  projectShort: string;
  estimatedCost: number;
  sessionCount: number;
}

export interface SessionCost {
  sessionId: string;
  estimatedCost: number;
  toolCalls: number;
  topTool: string | null;
}

/**
 * Synthetic bucket for sessions that have token data but zero tool calls.
 */
export const NO_TOOLS_BUCKET = '_no_tools';

/**
 * Synthetic bucket for sessions whose project isn't known from history.
 */
export const UNKNOWN_PROJECT_BUCKET = '_unknown';

/**
 * Proportional attribution of session cost across tool types.
 *
 * For each session present in BOTH tokenData and toolData, total cost
 * (from `estimateCost`) is split across tool names proportionally to the
 * summed size of each tool's results (`resultBytes`, a char-count proxy for
 * how many tokens the tool's output consumed). This weights a `Read` that
 * returns 50K chars far more heavily than a one-line `Bash`. When a session's
 * results all report zero size (sparse/old data), it falls back to weighting
 * by call count so behavior stays sane. Sessions with token data but no tool
 * calls are assigned to a synthetic `_no_tools` bucket. Sessions without token
 * data are dropped (no cost to attribute).
 */
export function attributeCostByTool(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[]
): ToolCostRow[] {
  const toolBySession = new Map<string, ToolUsageData>();
  for (const t of toolData) toolBySession.set(t.sessionId, t);

  // toolName -> { cost, calls, sessions(Set) }
  const buckets = new Map<
    string,
    { cost: number; calls: number; sessions: Set<string> }
  >();

  const bumpBucket = (
    name: string,
    cost: number,
    calls: number,
    sessionId: string
  ) => {
    const b = buckets.get(name) ?? {
      cost: 0,
      calls: 0,
      sessions: new Set<string>(),
    };
    b.cost += cost;
    b.calls += calls;
    b.sessions.add(sessionId);
    buckets.set(name, b);
  };

  for (const tok of tokenData) {
    const totalCost = estimateCost(tok);
    const tools = toolBySession.get(tok.sessionId);

    if (!tools || tools.calls.length === 0) {
      // No tools used in this session: all cost goes to no-tools bucket.
      bumpBucket(NO_TOOLS_BUCKET, totalCost, 0, tok.sessionId);
      continue;
    }

    // Per tool within this session: call count and summed result size.
    const perTool = new Map<string, { count: number; bytes: number }>();
    let totalBytes = 0;
    for (const call of tools.calls) {
      const e = perTool.get(call.toolName) ?? { count: 0, bytes: 0 };
      e.count += 1;
      const bytes = call.resultBytes > 0 ? call.resultBytes : 0;
      e.bytes += bytes;
      totalBytes += bytes;
      perTool.set(call.toolName, e);
    }

    const totalCalls = tools.calls.length;
    // Weight by summed result size; fall back to call-count weighting when no
    // result sizes are available (all zero) so sparse data stays sane.
    const useBytes = totalBytes > 0;
    for (const [toolName, { count, bytes }] of perTool) {
      let share: number;
      if (useBytes) {
        share = (bytes / totalBytes) * totalCost;
      } else {
        share = totalCalls === 0 ? 0 : (count / totalCalls) * totalCost;
      }
      bumpBucket(toolName, share, count, tok.sessionId);
    }
  }

  return Array.from(buckets.entries())
    .map(([toolName, b]) => ({
      toolName,
      estimatedCost: b.cost,
      callCount: b.calls,
      sessionCount: b.sessions.size,
    }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/**
 * ID-based per-tool cost attribution (#1928).
 *
 * `attributeCostByTool` splits a session's WHOLE cost across tools by each
 * tool's share of the session-wide `resultBytes` — a coarse heuristic that
 * smears every message's cost across every tool the session ever called,
 * regardless of which message actually dispatched which call. The transcript
 * already carries the tighter join: each assistant message's `TokenEntry` now
 * lists the `tool_use` ids it emitted (`toolUseIds`), and each id resolves to a
 * `ToolCall` whose `resultBytes` sizes that call's result payload. So we can
 * attribute a MESSAGE's cost to the exact tools that message billed, weighted by
 * the per-CALL result bytes — a strictly tighter join than the session-wide
 * share where the ids exist.
 *
 * Honest limit retained from the issue: `usage` is per-message (one object
 * covers thinking + text + every tool_use), so this is still not a *billed*
 * per-tool split — but the ID join localizes the cost to the right message and
 * the right calls instead of the whole session.
 *
 * FALLBACK (acceptance #1928 — "keep the timestamp fallback for entries lacking
 * ids"): a `TokenEntry` with no `toolUseIds` (an older row, or a message that
 * dispatched no tools) can't be ID-joined, so its cost falls back to the same
 * session-wide byte-/call-share split `attributeCostByTool` uses, scoped to that
 * one entry's cost. Result: rows with ids get the tight join, rows without keep
 * the legacy behaviour — no row is dropped.
 */
export function attributeCostByToolId(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[]
): ToolCostRow[] {
  const toolBySession = new Map<string, ToolUsageData>();
  for (const t of toolData) toolBySession.set(t.sessionId, t);

  const buckets = new Map<
    string,
    { cost: number; calls: number; sessions: Set<string> }
  >();
  const bumpBucket = (
    name: string,
    cost: number,
    calls: number,
    sessionId: string
  ) => {
    const b = buckets.get(name) ?? {
      cost: 0,
      calls: 0,
      sessions: new Set<string>(),
    };
    b.cost += cost;
    b.calls += calls;
    b.sessions.add(sessionId);
    buckets.set(name, b);
  };

  for (const tok of tokenData) {
    const tools = toolBySession.get(tok.sessionId);
    if (!tools || tools.calls.length === 0) {
      // No tools used: whole session cost to the no-tools bucket.
      bumpBucket(NO_TOOLS_BUCKET, estimateCost(tok), 0, tok.sessionId);
      continue;
    }

    const callById = new Map<string, ToolCall>();
    for (const call of tools.calls) callById.set(call.toolUseId, call);

    // Session-wide per-tool footprint, used for the per-entry FALLBACK split
    // (entries lacking ids) and to count tool calls into the bucket once.
    const sessionPerTool = new Map<string, { count: number; bytes: number }>();
    let sessionBytes = 0;
    for (const call of tools.calls) {
      const e = sessionPerTool.get(call.toolName) ?? { count: 0, bytes: 0 };
      e.count += 1;
      const bytes = call.resultBytes > 0 ? call.resultBytes : 0;
      e.bytes += bytes;
      sessionBytes += bytes;
      sessionPerTool.set(call.toolName, e);
    }
    const sessionCalls = tools.calls.length;

    const fallbackEntries: TokenEntry[] = [];
    for (const entry of tok.entries) {
      const entryCost = estimateEntryCost(entry);
      if (entryCost <= 0) continue;
      const ids = entry.toolUseIds;
      // ID join: resolve this message's tool_use ids to their calls and split the
      // message's cost across those tools weighted by per-call result bytes.
      const matched: ToolCall[] = [];
      if (ids && ids.length > 0) {
        for (const id of ids) {
          const call = callById.get(id);
          if (call) matched.push(call);
        }
      }
      if (matched.length === 0) {
        // No id linkage for this entry -> fall back to the session-wide split.
        fallbackEntries.push(entry);
        continue;
      }
      const perTool = new Map<string, { count: number; bytes: number }>();
      let bytes = 0;
      for (const call of matched) {
        const e = perTool.get(call.toolName) ?? { count: 0, bytes: 0 };
        e.count += 1;
        const b = call.resultBytes > 0 ? call.resultBytes : 0;
        e.bytes += b;
        bytes += b;
        perTool.set(call.toolName, e);
      }
      const useBytes = bytes > 0;
      for (const [toolName, stat] of perTool) {
        const share = useBytes
          ? (stat.bytes / bytes) * entryCost
          : (stat.count / matched.length) * entryCost;
        // calls counted in the no-id-free pass below; pass 0 here to avoid
        // double-counting the same ToolCall across entries that share a session.
        bumpBucket(toolName, share, 0, tok.sessionId);
      }
    }

    // FALLBACK: entries with no id linkage split by the session-wide footprint,
    // scoped to each entry's own cost (the legacy heuristic, per acceptance).
    const fallbackCost = fallbackEntries.reduce(
      (s, e) => s + estimateEntryCost(e),
      0
    );
    if (fallbackCost > 0) {
      const useBytes = sessionBytes > 0;
      for (const [toolName, stat] of sessionPerTool) {
        const share = useBytes
          ? (stat.bytes / sessionBytes) * fallbackCost
          : (stat.count / Math.max(1, sessionCalls)) * fallbackCost;
        bumpBucket(toolName, share, 0, tok.sessionId);
      }
    }

    // Count each tool's call count into the bucket exactly once per session.
    for (const [toolName, stat] of sessionPerTool) {
      bumpBucket(toolName, 0, stat.count, tok.sessionId);
    }
  }

  return Array.from(buckets.entries())
    .map(([toolName, b]) => ({
      toolName,
      estimatedCost: b.cost,
      callCount: b.calls,
      sessionCount: b.sessions.size,
    }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/**
 * Attribute per-session cost to projects, using the sessions index
 * to map sessionId -> project. Sessions whose sessionId is not in the
 * provided sessions list go into an `_unknown` bucket.
 */
export function attributeCostByProject(
  tokenData: SessionTokenData[],
  sessions: Session[]
): ProjectCostRow[] {
  const projectBySession = new Map<string, string>();
  for (const s of sessions) projectBySession.set(s.sessionId, s.project);

  const buckets = new Map<string, { cost: number; sessions: Set<string> }>();

  for (const tok of tokenData) {
    const project =
      projectBySession.get(tok.sessionId) ?? tok.project ?? UNKNOWN_PROJECT_BUCKET;
    const cost = estimateCost(tok);
    const b = buckets.get(project) ?? { cost: 0, sessions: new Set<string>() };
    b.cost += cost;
    b.sessions.add(tok.sessionId);
    buckets.set(project, b);
  }

  return Array.from(buckets.entries())
    .map(([project, b]) => ({
      project,
      projectShort:
        project === UNKNOWN_PROJECT_BUCKET ? project : shortenProject(project),
      estimatedCost: b.cost,
      sessionCount: b.sessions.size,
    }))
    .sort((a, b) => b.estimatedCost - a.estimatedCost);
}

/**
 * Top-N most expensive sessions, with the count of tool calls and the
 * most-used tool in each session (null if no tool calls).
 */
export function topExpensiveSessions(
  tokenData: SessionTokenData[],
  toolData: ToolUsageData[],
  limit = 10
): SessionCost[] {
  const toolBySession = new Map<string, ToolUsageData>();
  for (const t of toolData) toolBySession.set(t.sessionId, t);

  const rows: SessionCost[] = tokenData.map((tok) => {
    const tools = toolBySession.get(tok.sessionId);
    let toolCalls = 0;
    let topTool: string | null = null;

    if (tools && tools.calls.length > 0) {
      toolCalls = tools.calls.length;
      const perTool = new Map<string, number>();
      for (const c of tools.calls) {
        perTool.set(c.toolName, (perTool.get(c.toolName) ?? 0) + 1);
      }
      let bestName: string | null = null;
      let bestCount = -1;
      for (const [name, count] of perTool) {
        if (count > bestCount) {
          bestCount = count;
          bestName = name;
        }
      }
      topTool = bestName;
    }

    return {
      sessionId: tok.sessionId,
      estimatedCost: estimateCost(tok),
      toolCalls,
      topTool,
    };
  });

  return rows
    .sort((a, b) => b.estimatedCost - a.estimatedCost)
    .slice(0, limit);
}
