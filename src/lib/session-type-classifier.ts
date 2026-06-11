import type { Session } from '../types';

// Always-on, local heuristic session-type classifier (#655). The Summary
// "By session type" breakdown previously only populated from `/insights`
// `session_type` facets (LLM-produced, on-demand). This infers the same
// session SHAPE locally from each session's own signals — turn count, wall
// duration, and the verbs in its prompts — so the breakdown is meaningful
// without running `/insights`. It is BEST-EFFORT and deterministic: it never
// calls an LLM or the network (ADR 0005 / ADR 0008 free-path rule), and never
// impersonates `/insights`. When a real `/insights` facet exists for a session
// it always wins over this heuristic (see spendBySessionType).
//
// The output vocabulary matches the `/insights` `session_type` values so
// heuristic- and facet-derived rows merge into the same buckets.

export type HeuristicSessionType =
  | 'quick_question'
  | 'exploration'
  | 'multi_task'
  | 'single_task';

const QUICK_QUESTION_MAX_TURNS = 1;
const QUICK_QUESTION_MAX_MS = 5 * 60_000; // 5 min
const MULTI_TASK_MIN_TURNS = 6;
const MULTI_TASK_MIN_MS = 45 * 60_000; // 45 min

// Investigation-leaning vs change-leaning prompt verbs. Used only to split the
// middle ground (not quick, not sprawling) into exploration vs focused work.
const EXPLORE_RE =
  /\b(what|why|how|explain|explore|investigate|understand|find|look|show|list|check|analy[sz]e|review|compare|inspect|trace|search|read|describe|summar)/i;
const ACTION_RE =
  /\b(fix|implement|add|build|create|write|refactor|update|change|remove|delete|deploy|run|ship|migrat|rename|merge|commit|install|wire|generate|convert)/i;

/** Real user prompts, dropping the synthetic `init`/`exit` markers. */
function realPrompts(session: Session): string[] {
  return (session.entries ?? [])
    .map((e) => (e.display || '').trim())
    .filter((d) => d && d !== 'init' && d !== 'exit');
}

/**
 * Classify a session's shape into the `/insights` `session_type` vocabulary
 * using only local signals. Returns one of the four canonical values; never
 * "uncategorized" — every session gets a best-effort shape.
 */
export function classifySessionType(session: Session): HeuristicSessionType {
  const prompts = realPrompts(session);
  const turns = prompts.length;
  const durationMs = Math.max(0, (session.endTime ?? 0) - (session.startTime ?? 0));

  // One short, single-turn exchange → a quick question.
  if (turns <= QUICK_QUESTION_MAX_TURNS && durationMs < QUICK_QUESTION_MAX_MS) {
    return 'quick_question';
  }

  // Many turns or a long sitting → sprawling, multi-goal work.
  if (turns >= MULTI_TASK_MIN_TURNS || durationMs >= MULTI_TASK_MIN_MS) {
    return 'multi_task';
  }

  // Middle ground: lean on the prompt verbs to separate read/understand work
  // from focused change work.
  let explore = 0;
  let action = 0;
  for (const p of prompts) {
    if (EXPLORE_RE.test(p)) explore += 1;
    if (ACTION_RE.test(p)) action += 1;
  }
  if (explore > action) return 'exploration';
  return 'single_task';
}

/**
 * Build a `sessionId -> heuristic session_type` lookup for a set of sessions.
 * Returns a function suitable to pass as the `classify` argument of
 * {@link spendBySessionType}.
 */
export function buildSessionTypeClassifier(
  sessions: Session[] | undefined
): (sessionId: string) => HeuristicSessionType | undefined {
  const byId = new Map<string, HeuristicSessionType>();
  for (const s of sessions ?? []) byId.set(s.sessionId, classifySessionType(s));
  return (sessionId: string) => byId.get(sessionId);
}
