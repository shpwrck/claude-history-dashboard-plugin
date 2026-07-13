/**
 * Experiment-arm tagging convention (#2096, epic #2094 — agent-team-structure
 * efficacy trial). THIS FILE IS THE SPEC OF RECORD for how a session is
 * attributed to an experiment arm. The dashboard's existing session + git
 * parsing already captures a session's `gitBranch` and its first user prompt
 * (`HistoryEntry.display`, with `SessionTokenData.opener` as a flattened
 * fallback); this module reads only those two fields, so segmenting by arm
 * needs NO new ingest path.
 *
 * ## Arms
 *   c0  control (baseline; no special agent-team structure)
 *   s   specialists
 *   o   owners
 *   os  owners + specialists (combo)
 *
 * ## How to tag a session for its arm
 * Tag it EITHER way. The git-branch prefix is preferred (zero-friction — it is
 * already recorded per session); the kickoff-prompt marker is the fallback for
 * work that cannot rename its branch.
 *
 * 1. BRANCH PREFIX — name the git branch with the arm prefix, WITH the trailing
 *    slash, e.g. `exp-os/2096-per-arm-labeling`. The four prefixes are:
 *
 *      exp-c0/…   exp-s/…   exp-o/…   exp-os/…
 *
 *    Because `exp-os/…` also begins with the characters `exp-o`, matching the
 *    FULL prefix-with-slash disambiguates: `exp-os/x` starts with `exp-os/`
 *    (arm `os`) but NOT with `exp-o/` (arm `o`), and vice-versa.
 *
 * 2. KICKOFF-PROMPT MARKER — put a standalone marker line in the FIRST user
 *    prompt (the session opener) of the form:
 *
 *      exp-arm: os
 *
 *    (case-insensitive; the id is one of c0 | s | o | os). Prose that merely
 *    mentions that text does not enroll a session. The alternation in the
 *    marker regex lists `os` before `o` so the longer id wins.
 *
 * `classifyArm` reads the branch prefix first, then the opener marker, else
 * returns `null` (session is not part of the experiment).
 */

/** The four experiment arms of the agent-team-structure trial (#2094). */
export type ArmId = 'c0' | 's' | 'o' | 'os';

/** Human-readable arm labels, in the canonical display order c0, s, o, os. */
export const ARM_LABELS: Record<ArmId, string> = {
  c0: 'C0 control',
  s: 'S specialists',
  o: 'O owners',
  os: 'O+S combo',
};

/**
 * Full branch prefixes (WITH trailing slash) mapped to their arm. Matched with
 * `branch.startsWith(prefix)`. The trailing slash is what disambiguates `exp-os/`
 * from `exp-o/` — `exp-os/x` does not start with `exp-o/` — so iteration order
 * is not load-bearing, but `os` is listed before `o` for readability.
 */
export const ARM_BRANCH_PREFIXES: Record<string, ArmId> = {
  'exp-c0/': 'c0',
  'exp-s/': 's',
  'exp-os/': 'os',
  'exp-o/': 'o',
};

/**
 * Standalone kickoff-prompt marker: `exp-arm: <id>` (case-insensitive). The
 * multiline anchors prevent prose that merely mentions a marker from silently
 * enrolling an unrelated session. The alternation lists the two-character `os`
 * before `o` so the regex prefers the longer arm id when both could match.
 */
const ARM_MARKER_RE = /^\s*exp-arm:\s*(c0|os|o|s)\s*$/im;

/**
 * Classify a session into its experiment arm from the two locally-parsed
 * signals: the git branch prefix (checked first) then the opener marker. Returns
 * `null` when neither carries an arm tag (i.e. the session is not enrolled).
 */
export function classifyArm(input: {
  gitBranch?: string | null;
  opener?: string | null;
}): ArmId | null {
  const branch = input.gitBranch ?? '';
  for (const [prefix, arm] of Object.entries(ARM_BRANCH_PREFIXES)) {
    if (branch.startsWith(prefix)) return arm;
  }

  const marker = ARM_MARKER_RE.exec(input.opener ?? '');
  if (marker) return marker[1].toLowerCase() as ArmId;

  return null;
}
