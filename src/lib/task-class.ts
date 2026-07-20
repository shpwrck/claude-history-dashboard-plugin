/**
 * Task-class segmentation (#2139, epic #2138 down-modelling confidence).
 *
 * A COARSE, deterministic 3-bucket classifier that labels an automation
 * session/task as one of `authoring | mechanical | review` from EXISTING
 * per-session signals (`entrypoint` + `opener`). It exists so the raw
 * same-token swap ceiling for `cost.automation-share` ($7,160 of `sdk-*` spend)
 * can be broken down by class — mechanical work (pickers, classify,
 * status-writes, log-only replay) is the lowest-risk segment for later
 * down-model evaluation, whereas authoring (real code writes) carries the most
 * quality risk. This coarse segmentation never proves that any task is safe to
 * down-model.
 *
 * NON-GOALS (deliberately): this is NOT a general/ML task classifier and NOT a
 * new taxonomy. It is a pure keyword-precedence function over the coarse role
 * signals the automation harness already leaves in the opener. The always-on
 * TASK_CATEGORY_TAXONOMY (#655, `src/types.ts`) is a different, user-goal
 * taxonomy and is intentionally unrelated.
 *
 * ### Signals
 * `opener` (the first user message — for `claude -p "<prompt>"` automation this
 * is the driving skill prompt) is the DISCRIMINATING signal: it names the role
 * being run (`coder`, `burn-epic`, `reviewer`, `route-loose`/`groom-pick`
 * picker, status-file write, log-only replay). `entrypoint` only confirms the
 * run is automation (`sdk-*`); `sdk-cli` vs `sdk-py` does NOT distinguish
 * authoring/mechanical/review, so it is accepted as input (and for future use)
 * but never decides the bucket on its own.
 *
 * ### Precedence (and why)
 * Checked in a fixed order; the FIRST matching class wins:
 *   1. authoring  — coder / burn-epic / "implement" code writes.
 *   2. review     — reviewer role (audits/approves, does not write code).
 *   3. mechanical — pickers / classify / status-writes / log-only replay.
 *   4. DEFAULT    — {@link DEFAULT_TASK_CLASS} = `authoring`.
 *
 * Authoring is checked FIRST on purpose: the dangerous misclassification is
 * calling real code-writing "mechanical" (the lower-risk candidate bucket) — or
 * "review" — when it is actually authoring, because down-modelling authoring
 * risks output quality. So on any keyword collision we bias toward authoring:
 * an opener like `coder: implement code-review feedback` is authoring (not
 * review, despite "code-review"), and `burn-epic-pick --dry-run` is authoring
 * (not a mechanical picker). Mechanical is only the lowest-risk candidate
 * bucket, so its patterns are kept SPECIFIC (a named picker / classify /
 * status-write / log-only replay) — a bare "dry-run" is deliberately NOT a
 * mechanical signal, so `add --dry-run support to X` (real code work) falls to
 * authoring rather than being mislabelled as lower-risk. Only work that matches
 * a specific mechanical pattern AND carries no authoring/review signal is
 * bucketed mechanical; the label is not clearance.
 *
 * ### Unknown / no-signal default
 * An unknown entrypoint, an absent opener, or an opener matching none of the
 * patterns falls to {@link DEFAULT_TASK_CLASS} = `authoring` — the
 * most-conservative bucket — and is NEVER dropped. Every session a caller
 * feeds in is assigned exactly one class, so callers can PARTITION a total
 * (e.g. automation spend) across the three classes with nothing lost.
 *
 * Pure by design (matches the repo's `parse-*.ts` convention): no I/O, tolerant
 * of any/partial input.
 */

/** The three coarse task classes. */
export type TaskClass = 'authoring' | 'mechanical' | 'review';

/**
 * Stable, exhaustive class order for iteration/display. Callers that partition
 * a total should iterate this so the output order is deterministic.
 */
export const TASK_CLASSES: readonly TaskClass[] = ['authoring', 'mechanical', 'review'];

/**
 * The documented conservative default for an unknown entrypoint / no-signal
 * opener. `authoring` because misclassifying real code-writing as a lower-risk
 * candidate (`mechanical`) is the dangerous error — an unknown run is assumed
 * to be doing real work until a signal supports a mechanical classification.
 */
export const DEFAULT_TASK_CLASS: TaskClass = 'authoring';

/** Inputs the classifier reads — the existing per-session signals only. */
export interface TaskClassInput {
  /** Session `entrypoint` (e.g. `sdk-cli`); confirms automation, not the role. */
  entrypoint?: string;
  /** Session `opener` — the first user message; the discriminating signal. */
  opener?: string;
}

/**
 * Which signal decided a classification: a matched `opener` pattern, or the
 * conservative no-signal `default`. Single source of truth for the union so the
 * per-class provenance carrier on `TaskClassCostBreakdown.classification`
 * cannot drift from what {@link classifyTaskClassDetailed} actually returns.
 */
export type TaskClassSignal = 'opener' | 'default';

/** A classification plus the evidence that drove it (for auditability). */
export interface TaskClassResult {
  taskClass: TaskClass;
  /** Which signal decided the bucket. */
  signal: TaskClassSignal;
  /** Short, human-readable reason citing the matched pattern. */
  reason: string;
}

interface Pattern {
  re: RegExp;
  /** Human-readable label of what the pattern recognises. */
  label: string;
}

// ── Role signal patterns (evaluated against the lowercased opener) ────────────
// Each row cites a real automation role/skill in this repo's harness. Patterns
// are intentionally specific so a code-writing opener does not fall into the
// mechanical (lower-risk candidate) bucket by accident. Classification alone
// never establishes that a task can be down-modelled without quality loss.

/** reviewer role — audits/approves, does not write code. */
const REVIEW_PATTERNS: Pattern[] = [
  { re: /\breviewer\b/, label: 'reviewer role' },
  { re: /\/reviewer\b/, label: '/reviewer skill' },
  { re: /\breview (?:the )?(?:open |ready )?prs?\b/, label: 'review PRs' },
  { re: /\breview and merge\b/, label: 'review-and-merge' },
  { re: /\bapprove and merge\b/, label: 'approve-and-merge' },
  { re: /\bin-review\b/, label: 'in-review claim' },
  { re: /\bcode[- ]?review\b/, label: 'code-review' },
  { re: /\breview the diff\b/, label: 'review-the-diff' },
];

/** coder / burn-epic — real code writes. */
const AUTHORING_PATTERNS: Pattern[] = [
  { re: /\bcoder\b/, label: 'coder role' },
  { re: /\/coder\b/, label: '/coder skill' },
  { re: /\bburn[- ]?epic\b/, label: 'burn-epic iteration' },
  { re: /\bburn (?:the |down the )?(?:epic|release|backlog)\b/, label: 'burn the epic/release' },
  { re: /\bimplement(?:s|ed|ing|ation)?\b/, label: 'implement code' },
  { re: /\bcode the next\b/, label: 'code the next issue' },
  { re: /\bwrite (?:the )?code\b/, label: 'write code' },
];

/** Pickers, classify, status-writes, and log-only replay: lower-risk candidates. */
const MECHANICAL_PATTERNS: Pattern[] = [
  { re: /\bpickers?\b/, label: 'picker' },
  { re: /\bpick\.mjs\b/, label: 'pick.mjs picker' },
  { re: /\b(?:route|groom|burn-epic)-pick\b/, label: 'route/groom/burn-epic picker' },
  { re: /\bpick the next\b/, label: 'pick-the-next (picker)' },
  // NB: a BARE "dry-run" / "--dry-run" is deliberately NOT a mechanical signal —
  // it would leak real code work (e.g. "add --dry-run support to X") into the
  // lower-risk bucket. Genuine picker dry-runs are caught by the named-picker
  // patterns above (pick.mjs, route/groom/burn-epic-pick).
  { re: /\bclassif(?:y|ies|ied|ication|ying)\b/, label: 'classify' },
  { re: /\broute-loose\b/, label: 'route-loose classify' },
  { re: /\bstatus[- ]?file\b/, label: 'status-file write' },
  { re: /\bsprint[_-]?status\b/, label: 'SPRINT_STATUS write' },
  { re: /\b(?:write|update)s? (?:the )?status\b/, label: 'status write' },
  { re: /\blog[- ]?only\b/, label: 'log-only replay' },
  { re: /\breplay[- ]?run\b/, label: 'replay-run' },
  { re: /\breplay batch\b/, label: 'replay batch' },
  { re: /\bplanreplaybatch\b/, label: 'planReplayBatch' },
];

function firstMatch(text: string, patterns: Pattern[]): Pattern | null {
  for (const p of patterns) {
    if (p.re.test(text)) return p;
  }
  return null;
}

/**
 * Classify a task/session into one of `authoring | mechanical | review`,
 * returning the evidence that drove the bucket. See the module doc for the
 * precedence and default rationale.
 */
export function classifyTaskClassDetailed(input: TaskClassInput): TaskClassResult {
  const opener = typeof input?.opener === 'string' ? input.opener.toLowerCase() : '';

  // 1. authoring — checked FIRST so any code-writing signal wins on a keyword
  //    collision (conservative direction: never understate code-work risk). An
  //    opener like `coder: implement code-review feedback` is authoring, not
  //    review, even though it mentions "code-review".
  const authoring = firstMatch(opener, AUTHORING_PATTERNS);
  if (authoring) {
    return { taskClass: 'authoring', signal: 'opener', reason: `opener matched ${authoring.label}` };
  }

  // 2. review — reviewer role; reached only when no authoring signal is present.
  const review = firstMatch(opener, REVIEW_PATTERNS);
  if (review) {
    return { taskClass: 'review', signal: 'opener', reason: `opener matched ${review.label}` };
  }

  // 3. mechanical — pickers / classify / status-writes / log-only replay.
  const mechanical = firstMatch(opener, MECHANICAL_PATTERNS);
  if (mechanical) {
    return { taskClass: 'mechanical', signal: 'opener', reason: `opener matched ${mechanical.label}` };
  }

  // 4. Documented conservative default — unknown/absent signal is never dropped.
  return {
    taskClass: DEFAULT_TASK_CLASS,
    signal: 'default',
    reason: 'no role signal in opener — conservative default (authoring)',
  };
}

/**
 * Classify a task/session into one of `authoring | mechanical | review`.
 * Deterministic and pure. Unknown/absent signals fall to
 * {@link DEFAULT_TASK_CLASS} and are never dropped.
 */
export function classifyTaskClass(input: TaskClassInput): TaskClass {
  return classifyTaskClassDetailed(input).taskClass;
}
