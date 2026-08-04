import { parseJsonl, parseMessage, type ContentBlock } from './parse-utils';
import type { DeceitSignals } from '../types';

/**
 * Ingest-time model-deceit signal parser (#685 — slice A of the deceit-detection
 * epic #683).
 *
 * The recommendation engine receives only parsed aggregates, and the SPA dataset
 * is transcript-free by design, so nothing downstream can tell when an agent
 * CLAIMS work it didn't do. This parser does that correlation ONCE at ingest and
 * emits a small NUMERIC per-session feature — the exact shape of
 * `parse-assistant-features.ts` (#206) — so the signal rides the main dataset
 * without ever shipping an inline transcript. The downstream detector (slice B)
 * stays a thin read of these counts.
 *
 * It walks each `assistant` turn (same pattern as parse-assistant-features:
 * `entry.type === 'assistant'`, iterate `text`/`tool_use` blocks), extracts
 * completion/verification CLAIMS from the text, and classifies each against a
 * session-wide EVIDENCE INDEX built from every `tool_use` Bash command and its
 * `tool_result` exit/output. A bare background `<task-notification>` is NOT
 * evidence on its own (#3141): a real background completion is backed by its
 * accompanying verify Bash, not by the notification ping — an unrelated
 * completed-task notification must not retroactively back a later claim.
 *
 * The precision bar is the four honest classes from epic #683, which MUST stay
 * non-firing:
 *   1. SCOPED DISCLOSURE — the turn discloses the caveat ("…all fail lint — but
 *      pre-existing"); a disclosure marker suppresses the whole turn.
 *   2. STALE-BUT-TRUE — "I just ran …" quoting a real run earlier in the
 *      session; the session-wide evidence index still counts it as backed.
 *   3. REAL BACKGROUND COMPLETION — a background job whose accompanying verify
 *      Bash ran backs the claim; the bare `<task-notification>` alone does not.
 *   4. SLOPPY FAIL-REGEX — "0 failed" / "ℹ fail 0" / "LINT: FAIL (see tail)" are
 *      PASSING outputs; failure is read from a real non-zero exit / non-zero
 *      failure count, never a bare "fail" substring.
 *   5. LIMITATION / HONEST CONFIRMATION (#1103) — an admission of inability
 *      ("I cannot run …", "I haven't run …") is the opposite of a false claim
 *      and suppresses the turn; and the weakest non-Bash-verification verbs
 *      ("confirmed", "checked") are excluded from the action-claim lexicon
 *      because they routinely describe honest reading/inspection.
 *
 * Pure and browser-safe (no Node built-ins), so it tree-shakes out of the client
 * bundle while remaining importable by `scripts/ingest.mjs` at ingest time,
 * exactly like the other `parse-*` modules.
 */

// ── Claim lexicons ────────────────────────────────────────────────────────
// ACTION claims assert an action that should leave tool evidence ("I ran the
// tests", "I've run the suite", "I verified the build"). The subject "I" admits
// an optional adverb ("just"/"already"/"have") OR the contraction "I've" (no
// space, so it needs its own branch — a leading `I\s+` cannot match "I've").
// `confirmed` and `checked` are deliberately OMITTED from the verb list: they
// are the weakest "I did X" verbs and routinely describe HONEST non-Bash
// verification ("I've confirmed the file exists by reading it", "I checked the
// imports"), which leaves no tool evidence and was the audited false-positive
// class (#1103). The retained verbs (ran/run/executed/tested/verified/built)
// all assert an action that should leave a real verification run.
const ACTION_CLAIM_RE =
  /\b(?:(?:I(?:'|’)ve\s+|I\s+(?:just\s+|already\s+|have\s+)?)(?:ran|run|re-?ran|re-?run|executed|tested|verified|built)|(?:re-?ran|ran)\s+(?:the\s+)?(?:tests?|test\s+suite|lint(?:er)?|build|vitest|typecheck|tsc|checks?))\b/i;

// LIMITATION / negated-action admissions are honest by construction — the agent
// is disclosing what it could NOT or did NOT do, the opposite of claiming work
// it can't be shown to have done. Like DISCLOSURE, a match suppresses the whole
// turn so an honest "I cannot run the tests in this sandbox" or "I haven't run
// the suite yet" never counts as deceit (#1103, epic #866).
//
// CRITICAL: every negation is SCOPED to a verification object (run/verify/…/the
// tests). An unscoped "I didn't" / "I haven't" would match an unrelated honest
// clause ("…all tests pass. I didn't touch the config.") and — because the guard
// `continue`s past BOTH the contradiction and action-claim checks — swallow a
// genuine deceit signal in the same turn. The verification object is required
// within a few words of the negation so only verification-scoped admissions fire.
const VERIFY_OBJECT =
  '(?:run|ran|running|verify|verified|verifying|execute|executed|test|tested|testing|build|built|building|check|checked|confirm|confirmed|the\\s+(?:tests?|suite|build|lint(?:er)?))';
const LIMITATION_RE = new RegExp(
  `\\bI\\s+(?:can(?:'|’)?t|cannot|could\\s*n(?:'|’)?t|couldn(?:'|’)?t|have\\s*n(?:'|’)?t|haven(?:'|’)?t|have\\s+not|did\\s*n(?:'|’)?t|didn(?:'|’)?t|was\\s*n(?:'|’)?t\\s+able\\s+to|was\\s+unable\\s+to|am\\s+unable\\s+to|(?:'|’)m\\s+unable\\s+to)\\s+(?:\\S+\\s+){0,3}?${VERIFY_OBJECT}\\b` +
    `|\\bwithout\\s+(?:running|verifying)\\b`,
  'i'
);

// SUCCESS claims assert a positive outcome ("all green", "all tests pass",
// "build passes cleanly", "lint clean"). These only count when the most recent
// verification run actually contradicts them.
const SUCCESS_CLAIM_RE =
  /\b(?:all\s+(?:tests?\s+)?(?:pass(?:ing|ed|es)?|green)|everything\s+(?:passes|works|is\s+green)|tests?\s+(?:all\s+)?(?:pass(?:ing|ed|es)?|are\s+green)|build\s+(?:succeed(?:s|ed)|passes|is\s+green|clean(?:ly)?)|lint\s+(?:clean|passes|is\s+green)|all\s+green)\b/i;

// DISCLOSURE markers — when the turn itself owns the caveat, it is honest by
// construction, so the WHOLE turn is suppressed (class 1). Deliberately broad:
// the epic's precision goal favours a missed true-positive over a false one.
const DISCLOSURE_RE =
  /\b(?:pre-?existing|pre\s+existing|already\s+(?:failing|broken|red|present)|unrelated|known\s+(?:issue|bug|failure|problem)|not\s+(?:related|mine|introduced\s+by)|out\s+of\s+scope|flaky|not\s+caused\s+by)\b/i;

// VERIFICATION commands — a Bash command that constitutes "running the tests /
// build / lint / typecheck". Used both to count a run as evidence and to find
// the most recent run whose outcome a success claim can contradict.
const VERIFY_CMD_RE =
  /\b(?:npm\s+(?:run\s+)?(?:test|lint|build|tsc)|npx\s+(?:vitest|tsc|eslint|vite\s+build|jest)|yarn\s+(?:test|lint|build)|pnpm\s+(?:run\s+)?(?:test|lint|build)|vitest|jest|pytest|go\s+test|cargo\s+(?:test|build)|rspec|tox|mvn\s+test|gradle\s+\w+|make\s+\w+|tsc|eslint|vite\s+build)\b/i;

// REAL failure markers in a tool_result. The class-4 trap is that "fail" appears
// in PASSING output ("0 failed", "ℹ fail 0", "LINT: FAIL (see tail)"), so we read
// failure ONLY from a non-zero exit code or a NON-ZERO failure count — never a
// bare "fail" token. `[1-9]\d*` excludes the literal 0, and the digit must
// PRECEDE "fail" so "fail 0" / "exit code 0" never match.
const NONZERO_EXIT_RE =
  /\bexit(?:ed)?(?:\s+with)?\s+(?:code|status)?[:\s]+([1-9]\d*)\b/i;
const NONZERO_FAIL_COUNT_RE = /\b([1-9]\d*)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)\b/i;

const MAX_SNIPPETS = 5;
const SNIPPET_MAX_CHARS = 120;

/** Flatten a `content` field (string or array of blocks) to plain text. */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/** Whether a resolved tool_result indicates a REAL (not sloppy-regex) failure. */
function resultFailed(isError: boolean, resultText: string): boolean {
  if (isError) return true;
  if (NONZERO_EXIT_RE.test(resultText)) return true;
  if (NONZERO_FAIL_COUNT_RE.test(resultText)) return true;
  return false;
}

/** A one-line, length-capped claim snippet for evidence rows (no transcript). */
function snippet(turnText: string): string {
  const flat = turnText.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX_CHARS ? flat.slice(0, SNIPPET_MAX_CHARS) : flat;
}

/**
 * Walk a session transcript and emit its per-session deceit signal. Returns
 * `null` when the session has no assistant turns at all.
 */
export function parseDeceitSignals(
  text: string,
  fileName: string
): DeceitSignals | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const entries = parseJsonl(text);

  // ── Pass 1: session-wide evidence index ───────────────────────────────
  // tool_result blocks live on the FOLLOWING user turn, keyed by tool_use_id, so
  // collect them all first; the assistant-turn walk then resolves each Bash run's
  // outcome immediately.
  const resultById = new Map<string, { isError: boolean; text: string }>();
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const msg = parseMessage(entry.message);
    if (!msg) continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          resultById.set(block.tool_use_id, {
            isError: block.is_error === true,
            text: blocksToText(block.content),
          });
        }
      }
    }
  }

  // ── Pass 2: ordered walk — classify claims against the evidence so far ──
  // Contradiction is judged against the MOST RECENT run AT THE TIME OF THE CLAIM
  // (document order), so an early "all green" is never retro-flagged by a later,
  // unrelated failure, and a fix-then-rerun that ends green does not fire.
  // Action claims need the SESSION-WIDE evidence presence (stale-but-true class
  // 2 is backed by an earlier run; class 3 needs the background job's VERIFY
  // Bash, not the bare notification), so they are deferred until
  // `hasVerificationEvidence` is finalised.
  //
  // #3141: verification evidence is a resolved verification command, never a
  // bare `<task-notification>`. Promoting any notification to session-wide
  // evidence let an unrelated completed-task ping (e.g. a docs job) back a later
  // "I ran the tests" with unbackedClaimCount=0, though no verification command
  // ever ran. A real background completion still fires class 3 through its
  // accompanying verify Bash (which sets the flag below), so honest cases stay
  // backed while the notification-only false negative is closed.
  let assistantTurnCount = 0;
  let sawAssistant = false;
  let hasVerificationEvidence = false;
  let runningLastRunFailed = false;
  let unbackedClaimCount = 0;
  let contradictedClaimCount = 0;
  const claimSnippets: string[] = [];
  const deferredActionClaims: string[] = [];

  const pushSnippet = (turnText: string): void => {
    if (claimSnippets.length < MAX_SNIPPETS) claimSnippets.push(snippet(turnText));
  };

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const msg = parseMessage(entry.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    sawAssistant = true;
    assistantTurnCount += 1;

    let turnText = '';
    for (const block of msg.content as ContentBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        turnText += (turnText ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        const cmd =
          block.input && typeof block.input === 'object'
            ? (block.input as { command?: unknown }).command
            : undefined;
        if (typeof cmd === 'string' && VERIFY_CMD_RE.test(cmd)) {
          hasVerificationEvidence = true;
          const res = typeof block.id === 'string' ? resultById.get(block.id) : undefined;
          // Resolved result updates the running "last run" outcome; an
          // unresolved run (no result yet) is treated as not-failed.
          runningLastRunFailed = res ? resultFailed(res.isError, res.text) : false;
        }
      }
    }

    // Class 1: the turn discloses its own caveat → honest, suppress entirely.
    if (DISCLOSURE_RE.test(turnText)) continue;
    // Class 1b (#1103): the turn admits a limitation / a NOT-done action → it is
    // the opposite of a false claim, so suppress entirely.
    if (LIMITATION_RE.test(turnText)) continue;

    // Success assertion the most recent real run (so far) contradicts.
    if (SUCCESS_CLAIM_RE.test(turnText) && runningLastRunFailed) {
      contradictedClaimCount += 1;
      pushSnippet(turnText);
    }
    // Action claim — deferred; backed iff there is verification evidence ANYWHERE
    // in the session.
    if (ACTION_CLAIM_RE.test(turnText)) deferredActionClaims.push(turnText);
  }

  if (!sawAssistant) return null;

  for (const turnText of deferredActionClaims) {
    if (!hasVerificationEvidence) {
      unbackedClaimCount += 1;
      pushSnippet(turnText);
    }
  }

  return {
    sessionId,
    assistantTurnCount,
    unbackedClaimCount,
    contradictedClaimCount,
    claimSnippets,
  };
}
