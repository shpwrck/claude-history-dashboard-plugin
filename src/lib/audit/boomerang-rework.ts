/**
 * Tier-3 audit: boomerang / rework rate (#605 / #742).
 *
 * Measures how often shipped work "bounces back" — gets reverted or re-touched
 * shortly after it lands — as an INTERPRETED rate over the EXISTING deterministic
 * rework signals in parsed `~/.claude` history. No `git`/`gh`: the deployed
 * container mounts only `~/.claude` read-only (no project repos, no git binary),
 * so the original revert-commit join was infeasible; this reuses the two signals
 * the server already has.
 *
 * Deterministic seeds (both already computed elsewhere, never re-derived here):
 *   - PRIMARY: per-session rework signal from `parse-file-history`
 *     (FileHistorySession.reworkScore = churn * (1 + burstRate)) — the same
 *     signal the `workflow.rework-signature` detector ranks on. A high score is a
 *     retry storm: many pre-edit checkpoints packed into a tight window.
 *   - CORROBORATOR: high-churn files from `parse-files.topChurnFiles` (the signal
 *     behind `workflow.file-churn`) — when the rework clustered on files that are
 *     ALSO hammered across sessions, the bounce-back is more credible.
 *
 * Judge step: route each high-rework session through the judge to classify
 * GENUINE rework (work bounced back) vs. legitimate iteration, then compute an
 * interpreted rework RATE = genuine / judged. Emit ONE summary finding carrying
 * the rate, the confirmed events, and the judges' combined rationale.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness).
 */
import type { AuditFinding } from './types';
import type { JudgeFn } from './judge-types';

/** One session's deterministic rework metrics (from parse-file-history). */
export interface ReworkSession {
  /** Raw session id (the file-history session directory name). */
  sessionId: string;
  /** Project the session is attributed to (looked up via the sessions map). */
  project: string;
  /** Composite rework score: churn * (1 + burstRate). High = retry storm. */
  reworkScore: number;
  /** Number of pre-edit checkpoints in the session. */
  churn: number;
  /** Edits per minute — the retry-storm proxy. */
  burstRate: number;
}

/** One high-churn file (from parse-files.topChurnFiles), the corroborator. */
export interface ChurnFile {
  filePath: string;
  /** Mutating ops (edits + writes) on the file. */
  churn: number;
  /** Distinct sessions that mutated the file. */
  sessions: number;
}

/** A candidate boomerang event: a high-rework session plus its corroboration. */
export interface BoomerangCandidate {
  sessionId: string;
  project: string;
  reworkScore: number;
  churn: number;
  burstRate: number;
  /** How many high-churn files exist overall (cross-session re-touch context). */
  corroboratingChurnFiles: number;
}

export interface DetectOptions {
  /**
   * A session must clear this rework score to be a candidate. Matches the
   * `workflow.rework-signature` detector's MIN_REWORK_SCORE so the two signals
   * agree on what "high rework" means.
   */
  minReworkScore: number;
  /**
   * Stay quiet on sparse datasets: require at least this many rework sessions
   * present before flagging any (mirrors the detector's MIN_SESSIONS gate).
   */
  minSessions: number;
  /** Keep only the top-N candidates after ranking by reworkScore desc. */
  topN: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  minReworkScore: 10,
  minSessions: 3,
  topN: 10,
};

/**
 * Select high-rework sessions as candidate boomerang events. PURE and
 * deterministic — unit-tested without the judge.
 *
 * Returns [] unless at least `minSessions` rework rows are present (calm/sparse
 * datasets stay silent). Each surviving session must clear `minReworkScore`.
 * Ranked by reworkScore desc (ties broken by sessionId for stable ordering),
 * capped at `topN`. Every candidate carries the COUNT of corroborating
 * high-churn files so the judge sees whether the rework clustered on files that
 * are also hammered across sessions.
 */
export function detectBoomerangCandidates(
  reworkSessions: ReworkSession[],
  churnFiles: ChurnFile[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS
): BoomerangCandidate[] {
  const { minReworkScore, minSessions, topN } = options;
  if (reworkSessions.length < minSessions) return [];

  const corroboratingChurnFiles = churnFiles.length;

  return reworkSessions
    .filter((s) => s.reworkScore >= minReworkScore)
    .map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      reworkScore: s.reworkScore,
      churn: s.churn,
      burstRate: s.burstRate,
      corroboratingChurnFiles,
    }))
    .sort(
      (a, b) =>
        b.reworkScore - a.reworkScore ||
        a.sessionId.localeCompare(b.sessionId)
    )
    .slice(0, topN);
}

/** Format a 0..1 rate as a percent string, e.g. 0.6667 -> "67%". */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Judge each boomerang candidate (genuine rework vs. legitimate iteration), then
 * compute the INTERPRETED rework RATE = (judged-genuine) / (judged-considered)
 * and emit ONE summary finding.
 *
 * Per-candidate judge failures are isolated (try/catch + skip) so a single bad
 * call can't abort the rate computation — but a SKIPPED candidate is excluded
 * from the denominator entirely (only judged candidates count toward the rate),
 * so a flaky run reports the rate over what it could actually evaluate.
 *
 * Returns [] when there are no candidates, or when every candidate's judge call
 * failed (nothing was judged — no honest rate to report).
 */
export async function runBoomerangAudit(
  candidates: BoomerangCandidate[],
  judge: JudgeFn
): Promise<AuditFinding[]> {
  if (candidates.length === 0) return [];

  let judged = 0;
  let genuine = 0;
  const confirmedSessions: string[] = [];
  const rationales: string[] = [];
  // Aggregate confidence: the highest confidence among confirmed events wins
  // (one high-confidence bounce-back makes the overall rate finding more
  // credible than a pile of low-confidence ones).
  let topConfidence: AuditFinding['confidence'] = 'low';
  const rank = { low: 0, medium: 1, high: 2 } as const;

  for (const c of candidates) {
    let verdict;
    // Isolate per-candidate failures: a transient judge error (network, rate
    // limit) skips just this candidate. A skipped candidate must NOT count
    // toward the denominator — only judged candidates inform the rate.
    try {
      verdict = await judge({
        system:
          'You audit coding-agent sessions for rework. You are given one session ' +
          'with a high "rework score" (many pre-edit checkpoints packed into a ' +
          'tight time window — a retry-storm signature) and a count of files that ' +
          'are also churned heavily across sessions. Decide whether this is GENUINE ' +
          'rework — work that bounced back, i.e. just-changed code reverted or ' +
          're-touched because it was wrong — versus legitimate iterative ' +
          'development (deliberate, productive refinement). Reply ONLY with JSON: ' +
          '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}. ' +
          'isFinding = true means GENUINE rework (a boomerang).',
        user:
          `Session ${c.sessionId} in project "${c.project}": rework score ` +
          `${c.reworkScore} (${c.churn} pre-edit checkpoints, ${c.burstRate}/min ` +
          `burst rate). ${c.corroboratingChurnFiles} high-churn file(s) recur ` +
          'across sessions overall. Is this genuine rework (work that bounced ' +
          'back), or legitimate iteration?',
      });
    } catch {
      continue;
    }
    judged += 1;
    if (verdict.isFinding) {
      genuine += 1;
      confirmedSessions.push(c.sessionId);
      if (verdict.rationale) {
        rationales.push(`${c.sessionId}: ${verdict.rationale}`);
      }
      if (rank[verdict.confidence] > rank[topConfidence]) {
        topConfidence = verdict.confidence;
      }
    }
  }

  // Every candidate's judge call failed -> nothing judged -> no honest rate.
  if (judged === 0) return [];

  const rate = genuine / judged;
  const judgeRationale =
    rationales.length > 0
      ? rationales.join(' | ')
      : 'The judge classified none of the high-rework sessions as genuine ' +
        'bounce-back; the elevated churn reflects legitimate iteration.';

  return [
    {
      id: 'boomerang-rework:rate',
      domain: 'workflow',
      summary:
        `Boomerang/rework rate ${pct(rate)}: ${genuine} of ${judged} judged ` +
        `high-rework session(s) were genuine bounce-back (work reverted or ` +
        `re-touched shortly after it shipped).`,
      // Confirmed events anchor the rate; the denominator is the judged set.
      evidenceRefs: confirmedSessions.map((id) => `session:${id}`),
      judgeRationale,
      // Even a 0% rate is a real (reassuring) finding, but with nothing confirmed
      // there is no high-confidence event to lean on, so it stays 'low'.
      confidence: genuine > 0 ? topConfidence : 'low',
    },
  ];
}
