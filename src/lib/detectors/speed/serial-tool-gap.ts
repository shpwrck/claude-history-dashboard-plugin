import type { Detector, RecProvenance } from '../types';
import type { SessionTimeline } from '../../parse-timeline';
import { aggregateTurnLatency } from '../../parse-runtime-events';
import { short } from '../shared';

/**
 * speed.serial-tool-gap (#1753, epic #1910) — the round-trip-waste lever.
 *
 * Each tool call the agent emits one-per-assistant-message costs one whole model
 * round-trip (a TTFT + an output emission). When two read-only discovery calls
 * are *independent* — the second does not need the first's result — they could
 * have shipped in ONE assistant message, so the second round-trip was avoidable.
 * This is a pure clock lever the `speed` domain owns: fewer inferences, same
 * work.
 *
 * The hard part, and the reason this detector is a clamped LOWER BOUND rather
 * than the eye-catching corpus headline: **independence is undecidable from a
 * flat transcript.** A path-only "different file → parallelizable" heuristic
 * cannot tell a genuinely parallel pair from the dominant Read-then-Read pattern
 * ("read A, then read the path A's *result* just revealed") — a real dependency
 * the detector cannot see directly. So we gate hard (issue #1753 vetting):
 *
 *  1. **Independence gate.** A serialized pair counts toward the lower bound only
 *     when the later call's identifying args (its file_path / path / pattern, or
 *     a path-like token) are textually ABSENT from the earlier call's result. A
 *     pair where the later path appears in the earlier result is exactly the
 *     read-of-a-revealed-path dependency, and is dropped.
 *  2. **Latency credited per-inference, not per-turn.** A batch removes ONE
 *     inference, NOT one `turn_duration` (which also includes tool-execution
 *     wall-clock). We therefore credit each avoided round-trip a conservative
 *     fixed inference floor, and report the measured active per-turn latency only
 *     as context — never as the saving.
 *  3. **Clamped lower-bound band.** The headline is the post-gate count; the
 *     pre-gate "naive" count is shown only as the band's upper end so the reader
 *     sees how much the independence gate discounted.
 *  4. **Metric only.** One `speed` finding summarising the band — never a
 *     high-volume per-finding rec. (The `batch-tool-calls` race axis that would
 *     causally validate it is a separate meta follow-on, not this slice.)
 *
 * Dark on the transcript-free SPA dataset (no `runtimeEvents`), same posture as
 * `speed.hook-overhead` / `speed.time-motion`.
 */

/** Read-only file-discovery tools whose calls can be batched when independent. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
]);

/**
 * A Bash invocation counts as a read-only discovery call only when its command
 * leads with a known read verb AND carries no redirection or mutating verb. Kept
 * deliberately strict: a misclassified write would inflate a number we promise is
 * a lower bound.
 */
const READ_ONLY_BASH_LEAD =
  /^\s*(?:cat|ls|grep|rg|find|head|tail|wc|pwd|echo|stat|file|tree|cut|sort|uniq|column|git\s+(?:status|log|diff|show|branch|remote|ls-files))\b/;
const MUTATING_BASH =
  />>?|\b(?:rm|mv|cp|mkdir|rmdir|touch|tee|chmod|chown|ln|install|npm|npx|pnpm|yarn|pip|curl|wget|apt|brew|podman|docker|kubectl|git\s+(?:commit|push|checkout|add|reset|merge|rebase|stash|switch|restore|clean))\b/;

/** Args-summary keys whose values identify what a read-only call targets. */
const ARG_KEYS = '(?:file_path|path|notebook_path|pattern|glob|query)';
/** Path-like fallback tokens when no known key is present in the args summary. */
const PATHISH = /[\w.@-]*\/[\w./@-]+|\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/g;
/** Below this length a token is too generic to trust as a dependency signal. */
const MIN_TOKEN_LEN = 3;

/** Noise floor — fewer avoidable round-trips than this isn't worth a finding. */
const MIN_INDEPENDENT_PAIRS = 3;
/** At/above this the summary-absence heuristic surfaces enough candidates to warrant a warning. */
const HEAVY_INDEPENDENT_PAIRS = 50;

interface ReadStep {
  tokens: string[];
  /** First identifying token, or the whole args summary when none was found. */
  primary: string;
  /**
   * Result summary of THIS step's tool_result, attached when it arrives. `null`
   * means the result has not been seen yet (cannot test independence); `''`
   * means the result arrived and was empty (provably contains no token).
   */
  resultText: string | null;
  timestamp: string;
}

interface SessionGap {
  sessionId: string;
  naive: number;
  independent: number;
}

function extractArgTokens(argsSummary: string): string[] {
  const out: string[] = [];
  // Fresh regex per call — a module-level /g regex would carry lastIndex across calls.
  const keyRe = new RegExp(`"${ARG_KEYS}"\\s*:\\s*"([^"]+)"`, 'g');
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(argsSummary)) !== null) {
    if (m[1] && m[1].length >= MIN_TOKEN_LEN) out.push(m[1]);
  }
  if (out.length === 0) {
    const pathish = argsSummary.match(PATHISH);
    if (pathish) {
      for (const tok of pathish) {
        if (tok.length >= MIN_TOKEN_LEN) out.push(tok);
      }
    }
  }
  return out;
}

function bashCommand(argsSummary: string): string | null {
  const m = argsSummary.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function isReadOnly(toolName: string | undefined, argsSummary: string): boolean {
  if (!toolName) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName === 'Bash') {
    const cmd = bashCommand(argsSummary);
    if (!cmd) return false;
    return READ_ONLY_BASH_LEAD.test(cmd) && !MUTATING_BASH.test(cmd);
  }
  return false;
}

/**
 * A serialized pair passes the independence gate only when we could actually
 * check it: the later call has at least one identifying token AND none of those
 * tokens appears in the earlier call's result. No tokens, or the earlier result
 * has not arrived yet, means we cannot prove independence — so it stays OUT of
 * the lower bound (it still counts toward the naive upper band). An earlier
 * result that arrived but is EMPTY provably contains no token → independent.
 */
function passesIndependenceGate(cur: ReadStep, prev: ReadStep): boolean {
  if (cur.tokens.length === 0) return false;
  if (prev.resultText === null) return false;
  for (const tok of cur.tokens) {
    if (prev.resultText.includes(tok)) return false;
  }
  return true;
}

function countSessionGaps(timeline: SessionTimeline): SessionGap {
  let naive = 0;
  let independent = 0;
  let prev: ReadStep | null = null;
  // toolUseId -> step still awaiting its tool_result, so we can attach result
  // text to the step `prev` already points at (same object reference).
  const awaitingResult = new Map<string, ReadStep>();

  for (const entry of timeline.entries) {
    if (entry.kind === 'user') {
      // A new human turn ends the run of agent-driven reads.
      prev = null;
      awaitingResult.clear();
      continue;
    }
    if (entry.kind === 'tool_result') {
      if (entry.toolUseId) {
        const step = awaitingResult.get(entry.toolUseId);
        if (step) {
          // A stripped/absent result summary is UNVERIFIABLE (bulk timelines
          // strip `summary`), NOT a provably empty result. Leave it `null` so
          // the summary-absence heuristic cannot fire off a summary it never
          // saw; only an explicit '' (an empty result that actually arrived)
          // proves "contains no token" (#3228).
          step.resultText = entry.summary ?? null;
          awaitingResult.delete(entry.toolUseId);
        }
      }
      continue;
    }
    if (entry.kind === 'tool_use') {
      const argsSummary = entry.summary ?? '';
      if (!isReadOnly(entry.toolName, argsSummary)) {
        // An intervening edit / write / non-read tool breaks the run.
        prev = null;
        awaitingResult.clear();
        continue;
      }
      const tokens = extractArgTokens(argsSummary);
      const cur: ReadStep = {
        tokens,
        primary: tokens.length > 0 ? tokens[0] : argsSummary,
        resultText: null,
        timestamp: entry.timestamp,
      };
      // Serialized (different assistant message → different timestamp) and a
      // different target than the call before it (a re-read of the same path is
      // refinement, not parallelizable work).
      if (prev && cur.timestamp !== prev.timestamp && cur.primary !== prev.primary) {
        naive += 1;
        if (passesIndependenceGate(cur, prev)) independent += 1;
      }
      if (entry.toolUseId) awaitingResult.set(entry.toolUseId, cur);
      prev = cur;
      continue;
    }
    // assistant text / thinking / other: part of normal flow between reads — do
    // not break the run.
  }

  return { sessionId: timeline.sessionId, naive, independent };
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface SerialGapSummary {
  naive: number;
  independent: number;
  sessions: SessionGap[];
  sessionsAffected: number;
}

export function summarizeSerialGaps(
  timelines: SessionTimeline[] | undefined
): SerialGapSummary {
  const sessions: SessionGap[] = [];
  let naive = 0;
  let independent = 0;
  for (const timeline of timelines ?? []) {
    const gap = countSessionGaps(timeline);
    if (gap.naive === 0) continue;
    sessions.push(gap);
    naive += gap.naive;
    independent += gap.independent;
  }
  return {
    naive,
    independent,
    sessions,
    sessionsAffected: sessions.filter((s) => s.independent > 0).length,
  };
}

export const detector: Detector = {
  id: 'speed.serial-tool-gap',
  category: 'speed',
  dataDeps: ['timelines', 'runtimeEvents'],
  rule(input) {
    // SPA-dark: no transcript-derived turn latency means no honest per-inference
    // anchor, and no runtimeEvents is the transcript-free SPA sample's signature.
    const runtimeEvents = input.runtimeEvents;
    if (!runtimeEvents || runtimeEvents.length === 0) return null;
    const activeP50Ms = aggregateTurnLatency(runtimeEvents).active.p50DurationMs;
    if (activeP50Ms <= 0) return null;

    const summary = summarizeSerialGaps(input.timelines);
    if (summary.independent < MIN_INDEPENDENT_PAIRS) return null;

    const severity =
      summary.independent >= HEAVY_INDEPENDENT_PAIRS ? 'warning' : 'info';

    const evidence = summary.sessions
      .slice()
      .sort((a, b) => b.independent - a.independent)
      .filter((s) => s.independent > 0)
      .slice(0, 5)
      .map(
        (s) =>
          `${short(s.sessionId)}: ${s.independent} candidate batchable pair(s) (${s.naive} serialized read adjacency)`
      );

    const provenance: RecProvenance = {
      observations: [
        {
          claim: `${summary.independent} of ${summary.naive} serialized read-only call pair(s) across ${summary.sessionsAffected} session(s) had the later call's path/pattern absent from the earlier call's CLIPPED result summary — a summary-based heuristic candidate for batching, not proof of independence`,
          source: 'parse-timeline',
          field: 'entries[].toolName/summary',
          value: summary.independent,
        },
        {
          claim: `${summary.naive} serialized read-only adjacencies were seen before the summary-absence heuristic was applied`,
          source: 'parse-timeline',
          field: 'entries[].timestamp',
          value: summary.naive,
        },
        {
          claim: `active per-turn latency ~${fmtSeconds(activeP50Ms)} (median), which includes tool-execution time`,
          source: 'parse-runtime-events',
          field: 'turns[].durationMs',
          value: Math.round(activeP50Ms),
        },
      ],
      inference: `Tool-result summaries are clipped to ~200 chars and stripped from bulk timelines, so a later call's path being absent from the earlier summary does NOT establish that the later call was independent of the earlier FULL result. These are candidate pairs to review for batching — not a proven lower bound of avoidable round-trips — so no fixed reclaimed-time credit is asserted.`,
    };

    return {
      id: 'speed.serial-tool-gap',
      category: 'speed',
      severity,
      title: 'Review serially-issued file reads for batching opportunities',
      detail:
        `${summary.independent} of ${summary.naive} serialized read-only tool call pair(s) across ${summary.sessionsAffected} session(s) were issued one-per-turn AND had the later call's path/pattern absent from the earlier call's result summary — a summary-based heuristic that flags candidate batchable reads, not proof. ` +
        `Tool-result summaries are clipped to ~200 chars (and stripped from bulk timelines), so absence from the summary cannot establish that the later call was independent of the earlier full result; treat these as candidates to review, not a guaranteed count of avoidable round-trips. ` +
        `For context, active turns ran ~${fmtSeconds(activeP50Ms)} (median), which includes tool-execution time — so no fixed reclaimed-time credit is asserted for these candidates.`,
      action:
        'When the next file/glob/grep is genuinely independent of a read already in flight, issue them together in one assistant message instead of waiting for each result. Batch independent Read/Grep/Glob/LS discovery up front so the agent does not pay a round-trip per file.',
      affected: summary.sessionsAffected,
      view: 'timeline',
      evidence,
      provenance,
    };
  },
};
