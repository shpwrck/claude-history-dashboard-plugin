// Semantic session summaries + multi-window activity rollups (#960, path B).
//
// PURE, deterministic, no-LLM composition of a short "what this session did"
// line per session, plus "what happened in the last hour / day / week / month"
// rollups (total and per-project) that compose those per-session summaries.
//
// Everything derives from materials the dashboard already parses — session
// titles (parse-titles via Session.title), the always-on local session-type
// classifier (session-type-classifier.ts), tool mix + file impact
// (parse-tools), duration, and estimated cost (parse-sessions). No transcript
// fetch, no server call, no Anthropic API egress — so it is always-on and
// works in the SPA/upload build (ADR 0005 free-path rule).
//
// NOTE on `/insights` facets: issue #960 originally named the parsed
// `/insights` facets (underlying_goal / brief_summary / session_type) as a
// composition source, but that feature and its parser were removed with #1056
// (see the note in summary.ts). The always-on heuristic session-type
// classifier (#655) is the documented replacement for the `session_type`
// facet, and this module uses it. Per CLAUDE.md, the output is always surfaced
// as the dashboard's OWN derived summary — it never imitates the CLI
// `/insights` skill's report format.

import type { Session, SessionTokenData } from '../types';
import {
  classifySessionType,
  type HeuristicSessionType,
} from './session-type-classifier';
import { estimateCost } from './parse-sessions';
import { formatUSD } from './format';
import type { ToolUsageData } from './parse-tools';

/** Singular lead label + plural narrative form per heuristic session type. */
const TYPE_LABEL: Record<HeuristicSessionType, [string, string]> = {
  quick_question: ['Quick question', 'quick questions'],
  exploration: ['Exploration', 'exploration'],
  multi_task: ['Multi-task session', 'multi-task work'],
  single_task: ['Focused task', 'focused tasks'],
};

/** Tools whose `file_path` argument mutates the file. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const TITLE_MAX = 80;
const TOP_TOOLS = 3;
const NOTABLE_SESSIONS = 3;

/** Deterministic string tiebreak shared by every sort below. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Compact duration: `<1m`, `42m`, `2h 5m` — mirrors the SessionList style. */
function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ---------------------------------------------------------------------------
// Per-session heuristic summary
// ---------------------------------------------------------------------------

export interface SessionSummaryInput {
  session: Session;
  /** This session's token rollup, when parsed (cost). */
  tokenData?: SessionTokenData | null;
  /** This session's tool calls, when parsed (tool mix / file impact). */
  toolData?: ToolUsageData | null;
}

export interface SessionSummary {
  sessionId: string;
  /**
   * One-line, deterministic natural-language summary. Always non-empty; the
   * dashboard's own derived text (a local heuristic — never an `/insights`
   * imitation). Composes the lead (session type + project + title) with the
   * duration / message / tool-mix (top 3 tools) / file-impact (distinct files
   * edited vs read) / estimated-cost clauses that have data.
   */
  text: string;
  /** Always-on local session-shape classification (#655). */
  sessionType: HeuristicSessionType;
  durationMs: number;
  toolCallCount: number;
  /** Estimated USD cost from the session's token rollup (0 when unparsed). */
  estimatedCost: number;
}

function sessionTitle(session: Session): string | undefined {
  const own = session.title?.trim();
  if (own) return own;
  for (const e of session.entries ?? []) {
    const t = e.title?.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Compose the deterministic per-session summary. Identical inputs always
 * yield an identical result; sparse sessions (no token/tool data, no title)
 * still get a non-empty line.
 */
export function composeSessionSummary(
  input: SessionSummaryInput
): SessionSummary {
  const { session } = input;
  const calls = input.toolData?.calls ?? [];
  const sessionType = classifySessionType(session);

  // Tool mix + file impact in one pass, with deterministic tiebreaks.
  const toolCounts = new Map<string, number>();
  const edited = new Set<string>();
  const read = new Set<string>();
  for (const call of calls) {
    toolCounts.set(call.toolName, (toolCounts.get(call.toolName) ?? 0) + 1);
    const fp = call.input?.file_path;
    if (typeof fp === 'string' && fp.trim()) {
      if (EDIT_TOOLS.has(call.toolName)) edited.add(fp);
      else if (call.toolName === 'Read') read.add(fp);
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]))
    .slice(0, TOP_TOOLS)
    .map(([name]) => name);

  const estimatedCost = input.tokenData ? estimateCost(input.tokenData) : 0;
  const durationMs = Math.max(0, session.duration || 0);
  const title = sessionTitle(session);
  const shortTitle =
    title && title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
  const projectShort = session.projectShort?.trim();

  // --- compose the line --------------------------------------------------
  let lead = TYPE_LABEL[sessionType][0];
  if (projectShort) lead += ` in ${projectShort}`;
  if (shortTitle) lead += ` — “${shortTitle}”`;

  const clauses: string[] = [];
  if (durationMs > 0) clauses.push(formatDuration(durationMs));
  if (session.messageCount > 0) {
    clauses.push(plural(session.messageCount, 'message'));
  }
  if (calls.length > 0) {
    clauses.push(
      `${plural(calls.length, 'tool call')} (top: ${topTools.join(', ')})`
    );
  }
  if (edited.size > 0) clauses.push(`edited ${plural(edited.size, 'file')}`);
  if (read.size > 0) clauses.push(`read ${plural(read.size, 'file')}`);
  if (estimatedCost > 0) clauses.push(`~${formatUSD(estimatedCost)} est.`);

  return {
    sessionId: session.sessionId,
    text: clauses.length
      ? `${lead}: ${clauses.join(', ')}.`
      : `${lead}: no recorded activity.`,
    sessionType,
    durationMs,
    toolCallCount: calls.length,
    estimatedCost,
  };
}

// ---------------------------------------------------------------------------
// Multi-window activity rollups
// ---------------------------------------------------------------------------

export type RollupWindowKey = 'hour' | 'day' | 'week' | 'month';

/**
 * Window semantics: TRAILING rolling windows ending at the caller-supplied
 * `nowMs` — last 60 minutes / 24 hours / 7 days / 30 days. This follows the
 * Usage Pulse precedent (`analyzeActivityTrend` compares the trailing 7 daily
 * rows against the prior 7) rather than weekly-delta.ts's calendar ISO weeks:
 * "what happened in the last day" reads most naturally as the trailing 24
 * hours, and a clock-anchored window has no local-vs-UTC boundary to get
 * wrong — the only clock involved is the `nowMs` the caller passes (explicit
 * for determinism; UI callers pass `Date.now()`). A session belongs to a
 * window when its START time falls inside it, inclusive at both edges (same
 * start-time bucketing as buildDailyDigest), and all of its counts/cost
 * attribute to that window.
 */
export const ROLLUP_WINDOWS: ReadonlyArray<{
  key: RollupWindowKey;
  label: string;
  ms: number;
}> = [
  { key: 'hour', label: 'Last hour', ms: 3_600_000 },
  { key: 'day', label: 'Last 24 hours', ms: 86_400_000 },
  { key: 'week', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: 'month', label: 'Last 30 days', ms: 30 * 86_400_000 },
];

export interface ProjectRollup {
  project: string;
  projectShort: string;
  sessionCount: number;
  toolCallCount: number;
  estimatedCost: number;
}

export interface WindowRollup {
  window: RollupWindowKey;
  label: string;
  /** Inclusive window start (`nowMs - window.ms`). */
  startMs: number;
  /** Inclusive window end (= `nowMs`). */
  endMs: number;
  sessionCount: number;
  messageCount: number;
  toolCallCount: number;
  estimatedCost: number;
  /** Per-project rollups, busiest first (sessions, then cost, then name). */
  projects: ProjectRollup[];
  /** Up to 3 notable sessions (highest cost, then duration), with summaries. */
  notableSessions: SessionSummary[];
  /**
   * Deterministic window-level narrative line: counts, top project, estimated
   * cost, the dominant session type, and the window's top tools.
   */
  text: string;
}

export interface ActivityRollupInput {
  sessions: Session[];
  tokenData?: SessionTokenData[] | null;
  toolData?: ToolUsageData[] | null;
  /** Window anchor — pass explicitly so the rollup is pure/testable. */
  nowMs: number;
}

function windowNarrative(
  r: Omit<WindowRollup, 'text'>,
  topType: HeuristicSessionType | undefined,
  topTools: string[]
): string {
  if (r.sessionCount === 0) return `${r.label}: no recorded sessions.`;
  const top = r.projects[0];
  const where =
    r.projects.length === 1
      ? `in ${top.projectShort}`
      : `across ${plural(r.projects.length, 'project')} (top: ${top.projectShort})`;
  const parts = [`${plural(r.sessionCount, 'session')} ${where}`];
  if (r.messageCount > 0) parts.push(plural(r.messageCount, 'message'));
  if (r.toolCallCount > 0) parts.push(plural(r.toolCallCount, 'tool call'));
  if (r.estimatedCost > 0) parts.push(`~${formatUSD(r.estimatedCost)} est.`);
  let text = `${r.label}: ${parts.join(', ')}`;
  if (topType) text += `; mostly ${TYPE_LABEL[topType][1]}`;
  if (topTools.length > 0) text += `; top tools ${topTools.join(', ')}`;
  return `${text}.`;
}

/**
 * A session's summary + per-session tool-name counts, computed ONCE and reused
 * by every trailing window it falls into (#3174). The windows are nested, so a
 * recent session belongs to several of them; composing its summary and scanning
 * its tool calls once per session — instead of once per (window × session) —
 * removes the repeated recomputation without changing any window's output.
 */
interface PreparedSession {
  session: Session;
  summary: SessionSummary;
  /** Per-session tool-name counts, in first-appearance order (see below). */
  toolCounts: Map<string, number>;
}

/**
 * Compute the four trailing-window rollups from already-parsed data. Pure and
 * deterministic for a fixed `nowMs`; works identically on the server and SPA
 * datasets (no stats-cache dependency).
 */
export function computeActivityRollups(
  input: ActivityRollupInput
): WindowRollup[] {
  const tokenBySession = new Map(
    (input.tokenData ?? []).map((t) => [t.sessionId, t])
  );
  const toolBySession = new Map(
    (input.toolData ?? []).map((t) => [t.sessionId, t])
  );

  // Sessions sorted once (newest first) so every window's lists are stable.
  const ordered = input.sessions
    .filter((s) => Number.isFinite(s.startTime))
    .sort(
      (a, b) => b.startTime - a.startTime || byKey(a.sessionId, b.sessionId)
    );

  // The windows are nested inside the widest (month) window, so a session
  // outside it is in NO window; preparing only the sessions inside it keeps the
  // work an upper bound of the old per-window total (#3174). Compose each
  // session's summary and its per-session tool counts EXACTLY ONCE here, then
  // fold the prepared rows into every window they belong to below.
  const widestMs = ROLLUP_WINDOWS[ROLLUP_WINDOWS.length - 1].ms;
  const widestStart = input.nowMs - widestMs;
  const prepared: PreparedSession[] = ordered
    .filter((s) => s.startTime >= widestStart && s.startTime <= input.nowMs)
    .map((session) => {
      const toolData = toolBySession.get(session.sessionId) ?? null;
      const summary = composeSessionSummary({
        session,
        tokenData: tokenBySession.get(session.sessionId) ?? null,
        toolData,
      });
      // Distinct tool-name counts in first-appearance-by-call order. Folding
      // these into a window's map in `prepared` order reproduces exactly the
      // insertion order the old per-window `for (const call of calls)` scan
      // produced, so `topTools` (and every other derived list) is unchanged.
      const toolCounts = new Map<string, number>();
      for (const call of toolData?.calls ?? []) {
        toolCounts.set(call.toolName, (toolCounts.get(call.toolName) ?? 0) + 1);
      }
      return { session, summary, toolCounts };
    });

  return ROLLUP_WINDOWS.map((w) => {
    const startMs = input.nowMs - w.ms;
    const endMs = input.nowMs;
    const inWindow = prepared.filter(
      (p) => p.session.startTime >= startMs && p.session.startTime <= endMs
    );

    const byProject = new Map<string, ProjectRollup>();
    const toolCounts = new Map<string, number>();
    const typeCounts = new Map<HeuristicSessionType, number>();
    let messageCount = 0;
    let toolCallCount = 0;
    let estimatedCost = 0;

    const summaries = inWindow.map(({ session, summary, toolCounts: sessionTools }) => {
      messageCount += session.messageCount;
      toolCallCount += summary.toolCallCount;
      estimatedCost += summary.estimatedCost;
      typeCounts.set(
        summary.sessionType,
        (typeCounts.get(summary.sessionType) ?? 0) + 1
      );
      for (const [name, n] of sessionTools) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
      }
      const key = session.project || '(unknown project)';
      const row = byProject.get(key) ?? {
        project: key,
        projectShort: session.projectShort || key,
        sessionCount: 0,
        toolCallCount: 0,
        estimatedCost: 0,
      };
      row.sessionCount += 1;
      row.toolCallCount += summary.toolCallCount;
      row.estimatedCost += summary.estimatedCost;
      byProject.set(key, row);
      return summary;
    });

    const partial: Omit<WindowRollup, 'text'> = {
      window: w.key,
      label: w.label,
      startMs,
      endMs,
      sessionCount: inWindow.length,
      messageCount,
      toolCallCount,
      estimatedCost,
      projects: [...byProject.values()].sort(
        (a, b) =>
          b.sessionCount - a.sessionCount ||
          b.estimatedCost - a.estimatedCost ||
          byKey(a.project, b.project)
      ),
      notableSessions: [...summaries]
        .sort(
          (a, b) =>
            b.estimatedCost - a.estimatedCost ||
            b.durationMs - a.durationMs ||
            byKey(a.sessionId, b.sessionId)
        )
        .slice(0, NOTABLE_SESSIONS),
    };
    // Dominant session type + top tools feed only the narrative line.
    const topType = [...typeCounts.entries()].sort(
      (a, b) => b[1] - a[1] || byKey(a[0], b[0])
    )[0]?.[0];
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]))
      .slice(0, TOP_TOOLS)
      .map(([name]) => name);
    return { ...partial, text: windowNarrative(partial, topType, topTools) };
  });
}
