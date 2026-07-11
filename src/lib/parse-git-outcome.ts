/**
 * Git delivery-outcome signal (#1757, part of epic #1911).
 *
 * The roadmap is mostly judge-plumbing, while the one ground-truth outcome
 * signal we actually possess — merge / revert / PR-churn in git — sits unmined.
 * This parser grounds the success proxy (#1266) in shipped-code reality: it
 * joins each session's `gitBranch` (already on `SessionDimensions`) to its pull
 * request and classifies a per-session delivery-outcome label.
 *
 * SIGNAL ONLY this release. There is NO user-facing detector yet — the
 * delivery-outcome detector and the autonomy-proxy validation harness are
 * deferred to a Future child of #1911. This module only produces the
 * `gitOutcomes` array carried on `RecommendationInput`.
 *
 * ── Network discipline ──────────────────────────────────────────────────────
 * This file is PURE: it takes the PR data as an argument and never touches the
 * network, the filesystem, or `child_process`. That keeps it (a) unit-testable
 * with injected fixtures and no live `gh`, and (b) safe to live under
 * `src/lib/**`, which the zero-deps server runtime boot graph imports — the
 * server-runtime import guard rejects bare package imports there, so this module
 * imports only local types. The live `gh`/GitHub-API call that fetches the PR
 * records belongs in the ingest step (`scripts/ingest.mjs`), which runs
 * host-side WITH network and never reaches the Anthropic API.
 *
 * ── Branch → PR attribution ─────────────────────────────────────────────────
 * Sessions are attributed to a PR two ways, in priority order:
 *   1. The `feature/NNN-*` branch convention — `session.gitBranch` of the form
 *      `feature/1757-git-outcome-signal` carries the issue number `1757`; a PR
 *      whose head branch matches the same `gitBranch`, or whose body references
 *      `#1757` (e.g. `Closes #1757`), is its delivery vehicle.
 *   2. The merge-commit trailer — a squash/merge commit body that names the
 *      branch (`feature/1757-*`) or the issue (`#1757`) links the work to its
 *      PR even when the branch was deleted post-merge.
 * A session whose branch matches no PR (or whose branch is absent / a long-lived
 * trunk like `main`/`master`) is left unattributed and produces NO outcome row,
 * so the signal never invents a label it cannot ground.
 *
 * ── Outcome labels ──────────────────────────────────────────────────────────
 *   - `merged-clean`          — PR merged; no follow-up revert and no follow-up
 *                               fix commit/PR referencing it.
 *   - `merged-then-reverted`  — PR merged, then a later revert undid it.
 *   - `merged-then-fixed`     — PR merged, then a later commit/PR fixed it
 *                               (a hotfix/follow-up that references the merge)
 *                               without a full revert. Churn, not failure.
 *   - `abandoned`             — PR CLOSED without merging, or the branch's work
 *                               never landed.
 * `merged-then-reverted` dominates `merged-then-fixed` when both signals are
 * present: a revert is the stronger statement that the change did not hold.
 *
 * An OPEN, in-flight PR has no delivery outcome yet, so it produces NO row
 * (#2510) — labeling unfinished work `abandoned` would be a false ground-truth
 * label, exactly the invented-label the module's own contract forbids. Only a
 * CLOSED-without-merge PR is `abandoned`. (The ingest fetch pulls `--state all`,
 * so OPEN PRs enter the pool; the classifier drops them.)
 *
 * ── As-of / staleness ───────────────────────────────────────────────────────
 * Each row's provenance carries `asOf` — the ISO `YYYY-MM-DD` fetch date of the
 * PR snapshot it was classified from (supplied by the ingest step). A snapshot
 * ages: an OPEN PR skipped today may since have merged, a `merged-clean` may
 * since have been reverted. So a row older than {@link GIT_OUTCOME_FRESHNESS_DAYS}
 * must be presented "as of <date>", never as the repo's CURRENT state — the same
 * stale-demotion convention as #2142 (`RecommendationSavingsAttribution.stale`)
 * and the generic #1102 `RecProvenance.asOf`/`stale` path. {@link isGitOutcomeStale}
 * and {@link demoteStaleGitOutcome} ship the threshold + demotion here so
 * consumers (#2044) reuse one rule instead of reinventing it.
 */

/**
 * The PR data this parser needs, supplied by the ingest step (which has
 * network). Deliberately a thin subset of the GitHub PR shape — only the fields
 * the classification reads — so the live fetch can populate it from
 * `gh pr list --json ...` without coupling the pure logic to the wire format.
 */
export interface GitOutcomePullRequest {
  /** PR number, e.g. 2004. */
  number: number;
  /** Head branch name, e.g. `feature/1757-git-outcome-signal`. */
  headRefName?: string;
  /** PR title — surfaced in evidence only. */
  title?: string;
  /** PR body — scanned for `Closes #NNN` / `#NNN` issue references. */
  body?: string;
  /** True once the PR has been merged into its base. */
  merged?: boolean;
  /** PR state, e.g. `OPEN` / `CLOSED` / `MERGED`. */
  state?: string;
  /**
   * Was this merge later reverted? The ingest step sets this when it finds a
   * later revert commit/PR naming this PR's merge (e.g. a `Revert "..."` or a
   * `Reverts #NNN`).
   */
  reverted?: boolean;
  /**
   * Was this merge later patched by a follow-up fix (a hotfix commit/PR that
   * references this PR/issue) WITHOUT a full revert? Set by the ingest step.
   */
  fixedUp?: boolean;
}

export type GitOutcomeLabel =
  | 'merged-clean'
  | 'merged-then-reverted'
  | 'merged-then-fixed'
  | 'abandoned';

/**
 * How a session was attributed to its PR — `branch` (the `feature/NNN-*`
 * convention or an exact head-branch match) or `trailer` (the merge-commit
 * trailer naming the branch/issue). Surfaced in provenance.
 */
export type GitOutcomeAttribution = 'branch' | 'trailer';

export interface GitOutcomeProvenance {
  /** The branch that was joined to a PR. */
  gitBranch: string;
  /** The issue number parsed from a `feature/NNN-*` branch, when present. */
  issueNumber?: number;
  /** The PR number this session was attributed to. */
  prNumber: number;
  /** How the branch → PR link was established. */
  attribution: GitOutcomeAttribution;
  /** Short human-readable evidence rows (branch, PR ref/title). */
  evidence: string[];
  /**
   * ISO `YYYY-MM-DD` fetch date of the PR snapshot this row was classified from
   * (stamped by the ingest step). Drives the stale-demotion below: a label
   * fetched long ago is a snapshot, not a live claim. Optional only for callers
   * that don't supply it; the ingest path always sets it (#2510).
   */
  asOf?: string;
  /**
   * True when {@link asOf} is older than the freshness threshold, so a consumer
   * demotes the label to "as of <date>" rather than the repo's current state.
   * Mirrors {@link RecProvenance.stale}/`RecommendationSavingsAttribution.stale`
   * (#2142): only ever `true` alongside an `asOf`. Set by
   * {@link demoteStaleGitOutcome}, not at build time (staleness is relative to
   * WHEN the row is consumed).
   */
  stale?: boolean;
}

/** One per-session delivery-outcome row. */
export interface GitOutcome {
  sessionId: string;
  /** Project path the session ran in, when known. */
  project?: string;
  gitBranch: string;
  label: GitOutcomeLabel;
  provenance: GitOutcomeProvenance;
}

/** The session fields this parser reads. */
export interface GitOutcomeSession {
  sessionId: string;
  project?: string;
  gitBranch?: string;
}

/** Branches that are long-lived trunks, never a per-task delivery vehicle. */
const TRUNK_BRANCHES = new Set([
  'main',
  'master',
  'develop',
  'development',
  'trunk',
]);

const FEATURE_BRANCH_RE = /^[^/]+\/(\d+)(?:[-/]|$)/;

/** Parse the issue number out of a `feature/NNN-*` (or `fix/NNN-*`) branch. */
export function issueNumberFromBranch(branch: string): number | undefined {
  const m = FEATURE_BRANCH_RE.exec(branch.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** True when a PR body references `#issueNumber` (e.g. `Closes #1757`). */
function bodyReferencesIssue(body: string | undefined, issueNumber: number): boolean {
  if (!body) return false;
  // Word-bounded `#NNN` so `#17` does not match `#1757`.
  return new RegExp(`#${issueNumber}(?!\\d)`).test(body);
}

/**
 * Classify a single PR's delivery outcome. Pure; the revert/fix-up signals are
 * supplied on the PR record by the ingest step.
 *
 * Returns `undefined` for an OPEN, in-flight PR: it has no delivery outcome yet,
 * so the signal emits NO row rather than inventing `abandoned` for unfinished
 * work (#2510). A CLOSED-without-merge PR still classifies as `abandoned`.
 */
export function classifyPullRequestOutcome(
  pr: GitOutcomePullRequest
): GitOutcomeLabel | undefined {
  const state = pr.state?.toUpperCase();
  const merged = pr.merged === true || state === 'MERGED';
  if (merged) {
    // A revert is the stronger statement than a follow-up fix, so it wins the tie.
    if (pr.reverted) return 'merged-then-reverted';
    if (pr.fixedUp) return 'merged-then-fixed';
    return 'merged-clean';
  }
  // OPEN, in-flight PR: not finished, not a delivery outcome — no label.
  if (state === 'OPEN') return undefined;
  // Closed without merging (or a stateless deleted-branch record): did not land.
  return 'abandoned';
}

/**
 * Find the PR that delivered `branch`, via the `feature/NNN-*` convention or an
 * exact head-branch match. Returns the PR plus how it was attributed, or
 * `undefined` when the branch grounds no PR.
 */
export function attributeBranchToPullRequest(
  branch: string,
  pullRequests: GitOutcomePullRequest[]
): { pr: GitOutcomePullRequest; attribution: GitOutcomeAttribution } | undefined {
  const trimmed = branch.trim();
  // 1a. Exact head-branch match — the branch IS the PR's head.
  const byHead = pullRequests.find((pr) => pr.headRefName === trimmed);
  if (byHead) return { pr: byHead, attribution: 'branch' };

  const issueNumber = issueNumberFromBranch(trimmed);
  if (issueNumber === undefined) return undefined;

  // 1b. Head branch carries the same issue number under the convention.
  const byConventionHead = pullRequests.find(
    (pr) =>
      typeof pr.headRefName === 'string' &&
      issueNumberFromBranch(pr.headRefName) === issueNumber
  );
  if (byConventionHead) return { pr: byConventionHead, attribution: 'branch' };

  // 2. Trailer: the PR body references the issue (`Closes #NNN`). This survives
  //    a deleted post-merge branch.
  const byTrailer = pullRequests.find((pr) =>
    bodyReferencesIssue(pr.body, issueNumber)
  );
  if (byTrailer) return { pr: byTrailer, attribution: 'trailer' };

  return undefined;
}

/**
 * Build the `gitOutcomes` signal: one delivery-outcome row per session whose
 * `gitBranch` grounds a PR. Sessions on a trunk branch, with no branch, or whose
 * branch matches no PR are skipped — the signal never invents an ungrounded
 * label. A branch that grounds an OPEN, in-flight PR is likewise skipped
 * (`classifyPullRequestOutcome` returns `undefined`): unfinished work has no
 * outcome yet (#2510).
 *
 * @param sessions     Sessions carrying `gitBranch` (from `SessionDimensions`).
 * @param pullRequests PR records fetched by the ingest step (network-side).
 * @param options.asOf ISO `YYYY-MM-DD` fetch date of the PR snapshot, stamped on
 *                     every emitted row's provenance for stale-demotion (#2510).
 *                     The ingest path always supplies it.
 */
export function buildGitOutcomes(
  sessions: GitOutcomeSession[],
  pullRequests: GitOutcomePullRequest[],
  options: { asOf?: string } = {}
): GitOutcome[] {
  const { asOf } = options;
  const outcomes: GitOutcome[] = [];
  for (const session of sessions) {
    const branch = session.gitBranch?.trim();
    if (!branch || TRUNK_BRANCHES.has(branch.toLowerCase())) continue;

    const match = attributeBranchToPullRequest(branch, pullRequests);
    if (!match) continue;

    const { pr, attribution } = match;
    const label = classifyPullRequestOutcome(pr);
    // OPEN PR → no outcome yet; emit no row rather than a false `abandoned`.
    if (label === undefined) continue;
    const issueNumber = issueNumberFromBranch(branch);
    const evidence = [
      `branch ${branch}`,
      `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`,
    ];
    outcomes.push({
      sessionId: session.sessionId,
      project: session.project,
      gitBranch: branch,
      label,
      provenance: {
        gitBranch: branch,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        prNumber: pr.number,
        attribution,
        evidence,
        ...(asOf !== undefined ? { asOf } : {}),
      },
    });
  }
  return outcomes;
}

/** A GitHub `owner/repo` slug, e.g. `shpwrck/claude-history-dashboard`. */
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parse the `CHD_GIT_OUTCOMES` opt-in env value into the list of `owner/repo`
 * slugs whose PRs the ingest step may fetch. UNSET / empty / whitespace / no
 * valid slug ⇒ `[]`, which IS the flag-OFF contract: `readGitOutcomes` returns
 * `[]` on an empty list without a single `gh` call, so the default dataset is
 * byte-identical and makes zero external calls (#2510, restating the #1757
 * opt-in). Kept here as a pure, unit-testable function so the gate is not buried
 * in an un-testable ingest env read.
 */
export function gitOutcomesReposFromEnv(value: string | undefined): string[] {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => REPO_SLUG_RE.test(part));
}

/** ISO `YYYY-MM-DD`. Strict so a full timestamp or garbage is rejected. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness threshold (days) for a git delivery-outcome row. A row whose `asOf`
 * fetch date is older than this can no longer be asserted as the repo's CURRENT
 * state — an OPEN PR skipped then may since have merged, a `merged-clean` may
 * since have been reverted — so consumers must present it "as of <date>", never
 * as a live claim (the #2142 stale-demotion convention, applied to this signal).
 * 30 days is deliberately tighter than the down-model proof's 90: PR state
 * churns far faster than a model generation.
 */
export const GIT_OUTCOME_FRESHNESS_DAYS = 30;

/**
 * True when a git-outcome `asOf` date is older than `thresholdDays` relative to
 * `now` (ms). Mirrors the generic #1102/#2142 freshness test (`isAsOfStale`): a
 * missing or malformed `asOf` returns `false`, because a row can only be demoted
 * against a date it can read — an undatable row is never silently flagged stale
 * (the same contract as `stale=true` requiring an `asOf`).
 */
export function isGitOutcomeStale(
  asOf: string | undefined,
  now: number,
  thresholdDays: number = GIT_OUTCOME_FRESHNESS_DAYS
): boolean {
  if (asOf === undefined || !ISO_DATE.test(asOf)) return false;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return false;
  return now - asOfMs > thresholdDays * DAY_MS;
}

/**
 * Demote a stale git-outcome row (#2510, reusing the #2142 stale-demotion
 * convention). A row whose `provenance.asOf` is older than `thresholdDays` is
 * flagged `provenance.stale = true` so a consumer (#2044) presents its label
 * "as of <date>" rather than as the repo's current state. Fresh rows, and rows
 * with no readable `asOf`, are returned UNCHANGED (referentially identical), so
 * this is safe to `map` over a whole `gitOutcomes` array. Pure transform —
 * never mutates its input.
 */
export function demoteStaleGitOutcome(
  outcome: GitOutcome,
  now: number,
  thresholdDays: number = GIT_OUTCOME_FRESHNESS_DAYS
): GitOutcome {
  if (!isGitOutcomeStale(outcome.provenance.asOf, now, thresholdDays)) {
    return outcome;
  }
  return {
    ...outcome,
    provenance: { ...outcome.provenance, stale: true },
  };
}
