/**
 * Tier-3 audit: skill / slash-command / CLAUDE.md-rule candidates (#605 / #739).
 *
 * Detects a RECURRING SUCCESSFUL trajectory — the same multi-step tool sequence
 * that keeps WORKING across sessions — and asks the judge to draft ONE reusable
 * artifact (a skill, slash-command, or CLAUDE.md rule) so the user stops
 * re-deriving that approach by hand. The finding carries the proposed draft text
 * plus the judge's rationale, surfaced via /api/audit.json.
 *
 * Deterministic seed: tool-name n-grams (length 3-5) that recur across >= 2
 * DISTINCT *successful* sessions (the `good` outcome flag is computed upstream
 * by `parse-timeline-success.computeSessionOutcomes`; bad-outcome sessions are
 * filtered out before mining). Judge step: draft the candidate artifact.
 *
 * PROPOSE-ONLY — MANDATORY human-review gate. This module NEVER writes to
 * `~/.claude` or the filesystem: it imports no `fs`/`node:fs`/writer of any
 * kind and only returns {@link AuditFinding}s that carry draft text. Crystallising
 * a proposal into a real artifact is always a human decision downstream.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness).
 */
import type { AuditFinding, AuditConfidence } from './types';

/** A proposed reusable artifact's kind. */
export type ArtifactType = 'skill' | 'command' | 'claude-md-rule';

/**
 * One session's ordered tool usage plus whether it ended successfully. `good`
 * is the upstream outcome flag (label-first, proxy-fallback); only `good`
 * sessions contribute to the recurring-success mining below.
 */
export interface SkillCandidateSession {
  sessionId: string;
  project: string;
  /** Tool names in call order. */
  tools: string[];
  /** Successful-outcome flag (from computeSessionOutcomes). */
  good: boolean;
}

/** A recurring SUCCESSFUL tool trajectory and the evidence for it. */
export interface TrajectoryCandidate {
  /** Human-readable signature, e.g. "Read -> Edit -> Bash". */
  signature: string;
  length: number;
  /** Distinct good sessions the trajectory appears in. */
  sessions: string[];
  /** Total occurrences across all good sessions (it can repeat within one). */
  occurrences: number;
}

export interface DetectOptions {
  /** Shortest trajectory worth flagging (a 1-2 step run is just a tool call). */
  minLen: number;
  /** Longest window considered (bounds the n-gram scan). */
  maxLen: number;
  /** A trajectory must recur across at least this many DISTINCT good sessions. */
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
 * Find tool-name trajectories (length minLen..maxLen) that recur across
 * >= minSessions distinct SUCCESSFUL sessions. PURE and deterministic —
 * unit-tested without the judge.
 *
 * Bad-outcome sessions are dropped first: a trajectory that "keeps working" is
 * only evidence if the sessions it appears in actually succeeded. Single-tool
 * retry windows are skipped (a retry loop, not a reusable approach).
 *
 * Ranking: more distinct sessions first, then longer trajectory (a longer
 * recurring chain is a stronger candidate), then signature for stable ordering.
 * Returns at most topN.
 */
export function detectSuccessfulTrajectories(
  sessions: SkillCandidateSession[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS
): TrajectoryCandidate[] {
  const { minLen, maxLen, minSessions, topN } = options;
  // signature -> { sessionIds:Set, occurrences:number, length:number }
  const agg = new Map<
    string,
    { sessionIds: Set<string>; occurrences: number; length: number }
  >();

  for (const s of sessions) {
    // Only successful trajectories count — a sequence that recurred but failed
    // is not something to crystallize into a reusable artifact.
    if (!s.good) continue;
    const tools = s.tools;
    for (let n = minLen; n <= maxLen; n++) {
      if (tools.length < n) break;
      for (let i = 0; i + n <= tools.length; i++) {
        const window = tools.slice(i, i + n);
        // Skip a window that is a single tool repeated — that's a retry loop,
        // not a multi-step reusable approach.
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

  const candidates: TrajectoryCandidate[] = [];
  for (const [signature, { sessionIds, occurrences, length }] of agg) {
    if (sessionIds.size < minSessions) continue;
    candidates.push({
      signature,
      length,
      sessions: [...sessionIds].sort(),
      occurrences,
    });
  }

  candidates.sort(
    (a, b) =>
      b.sessions.length - a.sessions.length ||
      b.length - a.length ||
      a.signature.localeCompare(b.signature)
  );
  return candidates.slice(0, topN);
}

const VALID_CONFIDENCE: readonly AuditConfidence[] = ['low', 'medium', 'high'];
const VALID_ARTIFACT: readonly ArtifactType[] = [
  'skill',
  'command',
  'claude-md-rule',
];

/** A judge's drafted-artifact verdict over one recurring successful trajectory. */
export interface DraftVerdict {
  isFinding: boolean;
  rationale: string;
  confidence: AuditConfidence;
  artifactType: ArtifactType;
  /** The proposed artifact text (skill body / command body / rule text). */
  draft: string;
}

/**
 * The skill-candidate judge call. Unlike the shared {@link import('./judge').JudgeFn}
 * (which returns only the base verdict shape), this one must also carry the
 * drafted artifact, so it has its own return type. The server builds the real
 * one over `chat()` + {@link parseDraftVerdict}; tests inject a fake.
 */
export type DraftJudgeFn = (prompt: {
  system: string;
  user: string;
}) => Promise<DraftVerdict>;

/**
 * Parse the judge's free-text reply into a {@link DraftVerdict}, defaulting
 * safely. This is the local extension of judge.ts `parseVerdict` — same JSON
 * extraction, plus the `artifactType`/`draft` fields. A reply that omits or
 * malforms them degrades to "not a finding" rather than throwing.
 */
export function parseDraftVerdict(text: string): DraftVerdict {
  const safe: DraftVerdict = {
    isFinding: false,
    rationale: '',
    confidence: 'low',
    artifactType: 'claude-md-rule',
    draft: '',
  };
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return safe;
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const confidence = obj.confidence as AuditConfidence;
    const artifactType = obj.artifactType as ArtifactType;
    return {
      isFinding: obj.isFinding === true,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      confidence: VALID_CONFIDENCE.includes(confidence) ? confidence : 'low',
      artifactType: VALID_ARTIFACT.includes(artifactType)
        ? artifactType
        : 'claude-md-rule',
      draft: typeof obj.draft === 'string' ? obj.draft : '',
    };
  } catch {
    return safe;
  }
}

/** Human label for an artifact type, used in the finding summary. */
function artifactLabel(t: ArtifactType): string {
  return t === 'skill'
    ? 'skill'
    : t === 'command'
      ? 'slash-command'
      : 'CLAUDE.md rule';
}

/**
 * Judge each recurring SUCCESSFUL trajectory: is it worth crystallizing into a
 * reusable artifact, and if so, draft one. Emits a PROPOSE-ONLY finding per
 * confirmed candidate carrying the draft text + artifact type. Per-candidate
 * failures are isolated so one bad judge call can't drop the rest.
 *
 * This NEVER writes the draft anywhere — the finding is the proposal; adopting
 * it is a human decision (the mandatory review gate).
 */
export async function runSkillCandidateAudit(
  candidates: TrajectoryCandidate[],
  judge: DraftJudgeFn
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const c of candidates) {
    let verdict: DraftVerdict;
    try {
      verdict = await judge({
        system:
          'You audit coding-agent history for reusable-artifact opportunities. ' +
          'You are given a multi-step tool sequence that recurred across several ' +
          'sessions that ALL ended successfully — a trajectory that keeps ' +
          'working. Decide whether it is worth crystallizing into ONE reusable ' +
          'artifact so the user stops re-deriving it by hand, and if so draft ' +
          'that artifact. Pick the artifact type that fits: "skill" (a packaged ' +
          'multi-step capability), "command" (a slash-command shortcut), or ' +
          '"claude-md-rule" (a standing instruction). Reply ONLY with JSON: ' +
          '{"isFinding": boolean, "rationale": string, ' +
          '"confidence": "low"|"medium"|"high", ' +
          '"artifactType": "skill"|"command"|"claude-md-rule", ' +
          '"draft": string}. The "draft" is the proposed artifact text. This is ' +
          'a PROPOSAL only — it is never written anywhere automatically.',
        user:
          `Recurring successful trajectory: ${c.signature}. Seen in ` +
          `${c.sessions.length} successful session(s), ${c.occurrences} total ` +
          'occurrence(s). Is this worth turning into a reusable skill, ' +
          'slash-command, or CLAUDE.md rule, and if so, draft it.',
      });
    } catch {
      continue;
    }
    if (verdict.isFinding) {
      const label = artifactLabel(verdict.artifactType);
      findings.push({
        id: `skill-candidate:${c.signature}`,
        domain: 'workflow',
        summary:
          `Recurring successful trajectory "${c.signature}" across ` +
          `${c.sessions.length} session(s) (${c.occurrences} occurrences) is a ` +
          `candidate for a reusable ${label}.`,
        evidenceRefs: [
          `trajectory:${c.signature}`,
          ...c.sessions.map((id) => `session:${id}`),
        ],
        // The proposal IS the rationale + the drafted artifact text, so a
        // reviewer sees both why and the concrete draft to adopt-or-reject.
        judgeRationale:
          `${verdict.rationale}\n\nProposed ${label} (DRAFT - review before ` +
          `adopting):\n${verdict.draft}`,
        confidence: verdict.confidence,
      });
    }
  }
  return findings;
}
