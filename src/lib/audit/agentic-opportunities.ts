/**
 * Tier-3 audit: agentic-workflow opportunities (#605 / #741).
 *
 * Detects manual, repetitive multi-step tool sequences that recur ACROSS
 * sessions — the signature of work that would pay off as a single agentic
 * workflow / loop instead of being hand-driven every time — then asks the judge
 * whether converting each candidate to autonomy is actually worth it.
 *
 * Deterministic seed: recurring tool-name n-grams across sessions, ranked with
 * the estimated $ those sessions cost as SCALE CONTEXT. That figure is
 * whole-session spend, not a cost attributed to the sequence (#3109): the inputs
 * carry no per-call or per-sequence token attribution, and one session normally
 * contains several candidate sequences plus unrelated work, so the same dollars
 * would otherwise be claimed as "displaced" by each of them.
 * Judge step: interpret whether the candidate is a genuine automation win.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness).
 *
 * NOTE on adapted inputs (#741 spec drift): the issue referenced
 * `cost-attribution.aggregatePerTaskCost` and `parse-timeline` stop_hook spans,
 * neither of which exists. This uses the real surfaces instead — ordered
 * per-session tool names from `parse-tools` (ToolUsageData.calls[].toolName)
 * and per-session estimated cost from `cost-attribution.topExpensiveSessions`
 * (SessionCost.estimatedCost). Same intent, real APIs.
 */
import type { AuditFinding } from './types';
import type { JudgeFn } from './judge-types';

/** One session's ordered tool usage plus the $ the WHOLE session cost. */
export interface ToolSequenceSession {
  sessionId: string;
  project: string;
  /** Tool names in call order. */
  tools: string[];
  /**
   * Estimated USD for the ENTIRE session (`SessionCost.estimatedCost` from
   * `cost-attribution.topExpensiveSessions`) — all work in the session, not the
   * cost of any one sequence inside it.
   */
  cost: number;
}

/** A recurring multi-step tool sequence and the evidence for it. */
export interface SequenceCandidate {
  /** Human-readable signature, e.g. "Read -> Edit -> Bash". */
  signature: string;
  length: number;
  /** Distinct sessions the sequence appears in. */
  sessions: string[];
  /** Total occurrences across all sessions (a sequence can repeat within one). */
  occurrences: number;
  /**
   * Summed WHOLE-SESSION estimated cost of the distinct sessions the sequence
   * appears in — a scale/context metric, NOT a cost attributed to the sequence.
   *
   * A session usually contains substantial unrelated work and several candidate
   * sequences, so the same dollars land in several candidates' context totals.
   * Calling this "displaced cost" (as it was before #3109) asserted that
   * automating one sequence would save the whole session's spend, which the
   * per-session cost field cannot support: there is no per-call or per-sequence
   * token attribution in the inputs. Report it as context, never as savings.
   */
  sessionCostContext: number;
  /** Per-session whole-session cost, so the total is reproducible field-by-field. */
  sessionCosts: { sessionId: string; cost: number }[];
}

export interface DetectOptions {
  /** Shortest sequence worth flagging (a 1-2 step "sequence" is just a tool call). */
  minLen: number;
  /** Longest window considered (bounds the n-gram scan). */
  maxLen: number;
  /** A sequence must recur across at least this many DISTINCT sessions. */
  minSessions: number;
  /** Keep only the top-N candidates after ranking. */
  topN: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minLen: 3,
  maxLen: 5,
  minSessions: 2,
  topN: 5,
};

const ARROW = ' -> ';

/**
 * Find tool-name sequences (length minLen..maxLen) that recur across >= minSessions
 * distinct sessions. PURE and deterministic — unit-tested without the judge.
 *
 * Ranking: more distinct sessions first, then larger session-cost context, then longer
 * sequence (a longer recurring chain is a stronger automation candidate), then
 * signature for stable ordering. Returns at most topN.
 */
export function detectRecurringSequences(
  sessions: ToolSequenceSession[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS
): SequenceCandidate[] {
  const { minLen, maxLen, minSessions, topN } = options;
  // signature -> { sessionIds:Set, occurrences:number }
  const agg = new Map<
    string,
    { sessionIds: Set<string>; occurrences: number; length: number }
  >();
  const costBySession = new Map<string, number>();

  for (const s of sessions) {
    costBySession.set(s.sessionId, s.cost);
    const tools = s.tools;
    for (let n = minLen; n <= maxLen; n++) {
      if (tools.length < n) break;
      for (let i = 0; i + n <= tools.length; i++) {
        const window = tools.slice(i, i + n);
        // Skip a window that is a single tool repeated — that's a retry loop,
        // not a multi-step workflow worth turning into an agent.
        if (window.every((t) => t === window[0])) continue;
        const sig = window.join(ARROW);
        let entry = agg.get(sig);
        if (!entry) {
          // Store the window length `n` directly — deriving it later by
          // splitting the signature would miscount if a tool name contained the
          // separator, and `length` is a sort tiebreaker.
          entry = { sessionIds: new Set(), occurrences: 0, length: n };
          agg.set(sig, entry);
        }
        entry.sessionIds.add(s.sessionId);
        entry.occurrences += 1;
      }
    }
  }

  const candidates: SequenceCandidate[] = [];
  for (const [signature, { sessionIds, occurrences, length }] of agg) {
    if (sessionIds.size < minSessions) continue;
    const sessions = [...sessionIds].sort();
    const sessionCosts = sessions.map((sessionId) => ({
      sessionId,
      cost: costBySession.get(sessionId) ?? 0,
    }));
    const sessionCostContext = sessionCosts.reduce((sum, s) => sum + s.cost, 0);
    candidates.push({
      signature,
      length,
      sessions,
      occurrences,
      sessionCostContext,
      sessionCosts,
    });
  }

  // Cost only breaks ties in RANKING (bigger sessions are worth looking at
  // first); it is never presented as the sequence's own spend.
  candidates.sort(
    (a, b) =>
      b.sessions.length - a.sessions.length ||
      b.sessionCostContext - a.sessionCostContext ||
      b.length - a.length ||
      a.signature.localeCompare(b.signature)
  );
  return candidates.slice(0, topN);
}

const USD = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Judge each recurring-sequence candidate: is converting this manual sequence to
 * an agentic workflow a genuine win? Emits a finding per confirmed candidate.
 * Per-candidate failures are isolated so one bad judge call can't drop the rest.
 */
export async function runAgenticOpportunityAudit(
  candidates: SequenceCandidate[],
  judge: JudgeFn
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const c of candidates) {
    let verdict;
    try {
      verdict = await judge({
        system:
          'You audit coding-agent history for automation opportunities. You are ' +
          'given a multi-step tool sequence that recurs across several sessions, ' +
          'with how many sessions it spans and the estimated cost of that manual ' +
          'work. Decide whether turning it into a single agentic workflow / loop ' +
          'would genuinely pay off (recurring, mechanical, worth the setup) vs. ' +
          'being too varied or rare to automate. Reply ONLY with JSON: ' +
          '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}.',
        user:
          `Recurring sequence: ${c.signature}. Seen in ${c.sessions.length} ` +
          `session(s), ${c.occurrences} total occurrence(s). Those sessions cost ` +
          `${USD(c.sessionCostContext)} in TOTAL (whole-session spend for all ` +
          'work in them; no per-sequence cost attribution exists, so this is ' +
          'scale context only — do NOT treat it as the savings from automating ' +
          'this sequence). Is this a genuine agentic-workflow opportunity?',
      });
    } catch {
      continue;
    }
    if (verdict.isFinding) {
      findings.push({
        id: `agentic-opportunity:${c.signature}`,
        domain: 'workflow',
        summary:
          `Recurring manual sequence "${c.signature}" across ` +
          `${c.sessions.length} sessions (${c.occurrences} occurrences) is a ` +
          `candidate for an agentic workflow. Those sessions cost ` +
          `${USD(c.sessionCostContext)} in total across ALL the work in them — ` +
          'whole-session spend for scale, not a saving attributable to this ' +
          'sequence (per-sequence cost is not measurable from session totals).',
        evidenceRefs: [
          `sequence:${c.signature}`,
          ...c.sessions.map((id) => `session:${id}`),
          // Name the field behind every dollar figure so the total is
          // reproducible and cannot be read as sequence-level attribution.
          'cost-field:SessionCost.estimatedCost (whole session)',
          ...c.sessionCosts.map(
            (s) => `session-cost:${s.sessionId}=${USD(s.cost)}`
          ),
        ],
        judgeRationale: verdict.rationale,
        confidence: verdict.confidence,
      });
    }
  }
  return findings;
}
