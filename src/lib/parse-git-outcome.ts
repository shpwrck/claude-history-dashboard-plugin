/**
 * Git delivery-outcome signal (#1757, part of epic #1911).
 *
 * The roadmap is mostly judge-plumbing, while the one ground-truth outcome
 * signal we actually possess — merge / revert / PR-churn in git — sits unmined.
 * This parser grounds the success proxy (#1266) in shipped-code reality: it
 * joins each session's `gitBranch` (already on `SessionDimensions`) to its pull
 * request and classifies a per-session delivery-outcome label.
 *
 * Its first consumer is the `reliability.post-shipment-rework` detector
 * (#3393), which answers the question #3110 had to leave unanswered: do changes
 * come back after they ship? That claim needs strictly more than a label — the
 * shipped event, the later mutation, the affected artifact and both timestamps
 * — so this module also links the rework mutation ({@link linkReworkMutations})
 * and gates the evidence ({@link buildPostShipmentRework}), which returns
 * nothing at all when any one of the four facts is missing. The autonomy-proxy
 * validation harness remains deferred to a Future child of #1911.
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
  /**
   * ISO instant this PR was merged — the SHIPPED EVENT (#3393). Only a merged
   * PR has one, and only a PR that carries one can ground a post-shipment
   * claim: "came back after it shipped" is unsayable without the moment it
   * shipped. `gh pr list --json mergedAt`.
   */
  mergedAt?: string;
  /** Merge commit oid, cited as the concrete shipped artifact reference. */
  mergeCommit?: string;
  /**
   * Repo-relative paths this PR touched (`gh pr list --json files`, mapped to
   * `files[].path`). The AFFECTED ARTIFACT half of a post-shipment claim: a
   * mutation only counts as rework of THIS shipment when it re-touched a file
   * this shipment touched.
   */
  files?: string[];
  /** The later revert that undid this merge, with its own timestamp + files. */
  revert?: GitReworkMutation;
  /** The later follow-up fix that patched this merge, without a full revert. */
  fixUp?: GitReworkMutation;
  /**
   * `owner/repo` slug of the pool this PR came from, stamped by
   * {@link collectGitOutcomePullRequests} (#3655). PR numbers are repo-scoped,
   * so this is what keeps a multi-repo pool attributable: records with no slug
   * (single-pool callers, pre-#3655 fixtures) share one implicit pool.
   */
  repo?: string;
}

/**
 * The LATER MUTATION that came back to an already-shipped PR (#3393) — either a
 * revert or a follow-up fix — carrying the facts a post-shipment claim has to
 * cite: what it was, when it landed, and which files it touched.
 *
 * Linked from the same PR pool the outcome labels are classified from
 * ({@link linkReworkMutations}), so establishing it costs no extra fetch.
 */
export interface GitReworkMutation {
  kind: 'revert' | 'fix-up';
  /** Human-readable ref, e.g. `PR #1801`. */
  ref: string;
  /** PR number of the mutation. */
  prNumber: number;
  title?: string;
  /** ISO instant the mutation landed (its own merge time). */
  at?: string;
  /** Repo-relative paths the mutation touched. */
  files?: string[];
}

/**
 * A COMPLETE post-shipment rework event (#3393): the four facts, all present,
 * that let a claim say work came back after it shipped without inferring any of
 * them. Built only by {@link buildPostShipmentRework}, which returns `undefined`
 * the moment any one of them is missing — so a consumer that reads this field
 * can cite every part of its own sentence.
 */
export interface GitPostShipmentRework {
  kind: 'revert' | 'fix-up';
  /** The shipped event: the merged PR (plus its merge commit when known). */
  shippedRef: string;
  /** ISO instant of the merge. */
  shippedAt: string;
  /** The later mutation that came back to it. */
  mutationRef: string;
  /** ISO instant the mutation landed. Always strictly after `shippedAt`. */
  mutationAt: string;
  /** Files touched by BOTH the shipment and the mutation. Never empty. */
  artifacts: string[];
  /** Whole days between the shipment and the mutation. */
  daysAfterShipment: number;
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
  /**
   * `owner/repo` slug the attributed PR belongs to, when the pool carried one
   * (#3655). PR numbers are repo-scoped, so consumers that group events by PR
   * must key on (repo, prNumber), never the bare number.
   */
  repo?: string;
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
  /**
   * Fully-evidenced post-shipment rework for this session's delivery (#3393),
   * present ONLY when the shipped event, the later mutation, the affected
   * artifact and BOTH timestamps are all grounded in the PR snapshot. A
   * `merged-then-reverted`/`merged-then-fixed` LABEL is a weaker statement than
   * this field: the label needs only the link, the claim needs the receipts.
   * Absent ⇒ a consumer must make no post-shipment claim at all.
   */
  rework?: GitPostShipmentRework;
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
 *
 * The linked {@link GitReworkMutation} objects (#3393) are the richer form of
 * the `reverted`/`fixedUp` booleans and are read the same way, so a caller may
 * supply either without changing a single label.
 */
export function classifyPullRequestOutcome(
  pr: GitOutcomePullRequest
): GitOutcomeLabel | undefined {
  const state = pr.state?.toUpperCase();
  const merged = pr.merged === true || state === 'MERGED';
  if (merged) {
    // A revert is the stronger statement than a follow-up fix, so it wins the tie.
    if (pr.reverted || pr.revert) return 'merged-then-reverted';
    if (pr.fixedUp || pr.fixUp) return 'merged-then-fixed';
    return 'merged-clean';
  }
  // OPEN, in-flight PR: not finished, not a delivery outcome — no label.
  if (state === 'OPEN') return undefined;
  // Closed without merging (or a stateless deleted-branch record): did not land.
  return 'abandoned';
}

/** A branch → PR attribution result. */
interface BranchAttribution {
  pr: GitOutcomePullRequest;
  attribution: GitOutcomeAttribution;
}

/**
 * Attribute `branch` across per-repo pools, one priority tier at a time
 * (#3655). PR numbers are repo-scoped, so each tier is resolved against EVERY
 * pool before the next is tried: a stronger match in one repo must not lose to
 * a weaker one that happened to sit earlier in a flattened multi-repo array.
 * A tier that matches in more than one pool identifies no single delivery
 * vehicle, so it attributes nothing — the conservative direction; the signal
 * never invents a link it cannot ground. With a single pool this is
 * byte-identical to the pre-#3655 priority order.
 */
function attributeBranchAcrossPools(
  branch: string,
  pools: readonly (readonly GitOutcomePullRequest[])[]
): BranchAttribution | undefined {
  const trimmed = branch.trim();
  const issueNumber = issueNumberFromBranch(trimmed);

  const tiers: Array<{
    attribution: GitOutcomeAttribution;
    find: (
      pool: readonly GitOutcomePullRequest[]
    ) => GitOutcomePullRequest | undefined;
  }> = [
    {
      // 1a. Exact head-branch match — the branch IS the PR's head.
      attribution: 'branch',
      find: (pool) => pool.find((pr) => pr.headRefName === trimmed),
    },
    ...(issueNumber === undefined
      ? []
      : [
          {
            // 1b. Head branch carries the same issue number under the convention.
            attribution: 'branch' as const,
            find: (pool: readonly GitOutcomePullRequest[]) =>
              pool.find(
                (pr) =>
                  typeof pr.headRefName === 'string' &&
                  issueNumberFromBranch(pr.headRefName) === issueNumber
              ),
          },
          {
            // 2. Trailer: the PR body references the issue (`Closes #NNN`).
            //    This survives a deleted post-merge branch.
            attribution: 'trailer' as const,
            find: (pool: readonly GitOutcomePullRequest[]) =>
              pool.find((pr) => bodyReferencesIssue(pr.body, issueNumber)),
          },
        ]),
  ];

  for (const tier of tiers) {
    const hits = pools
      .map((pool) => tier.find(pool))
      .filter((pr): pr is GitOutcomePullRequest => pr !== undefined);
    if (hits.length === 1) return { pr: hits[0], attribution: tier.attribution };
    // Ambiguous across repos: the same tier grounds a PR in two different
    // pools, and nothing in the local data says which repo the session's
    // branch lived in. Refuse rather than guess.
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

/**
 * Find the PR that delivered `branch`, via the `feature/NNN-*` convention or an
 * exact head-branch match. Returns the PR plus how it was attributed, or
 * `undefined` when the branch grounds no PR. Single-pool form of
 * {@link attributeBranchAcrossPools} — callers holding a multi-repo pool must
 * group it by `repo` first (as {@link buildGitOutcomes} does), because PR
 * numbers are repo-scoped (#3655).
 */
export function attributeBranchToPullRequest(
  branch: string,
  pullRequests: GitOutcomePullRequest[]
): BranchAttribution | undefined {
  return attributeBranchAcrossPools(branch, [pullRequests]);
}

/** GitHub's auto-generated revert PR title is `Revert "<original title>"`. */
const REVERT_TITLE_RE = /^\s*revert\b/i;

/** How many affected artifacts a rework event cites before it truncates. */
const MAX_REWORK_ARTIFACTS = 5;

/**
 * Filler the cue verb may carry before it reaches the number and still be said
 * to GOVERN it. Deliberately a closed set of connectors rather than "any
 * characters": a wildcard gap lets the verb in one clause capture a number in
 * the next, which is how `Reverts the flaky approach; closes #300` read as a
 * revert of #300.
 */
const CUE_CONNECTORS = String.raw`(?:\s+(?:of|the|a|an|for|to|commit|commits|pr|prs|pull\s+request|pull\s+requests))*\s*:?\s*`;

/** The mutation declares it reverts the reference that follows. */
const REVERT_CUE = String.raw`\brevert(?:s|ed|ing)?\b` + CUE_CONNECTORS;

/**
 * The mutation declares it FIXES the reference that follows — either directly
 * (`Fixes #N`) or by naming it as the cause being cleaned up (`a regression
 * from #N`, `broken by #N`). A bare cross-reference is deliberately NOT a cue:
 * `Part of #1911` on two sibling epic slices that touch one shared file is
 * parallel work, not a change coming back.
 */
const FIX_CUES = [
  String.raw`\b(?:fix(?:es|ed)?|hotfix(?:es|ed)?|patch(?:es|ed)?|correct(?:s|ed)?|repair(?:s|ed)?)\b` +
    CUE_CONNECTORS,
  String.raw`\b(?:regression|regressed|regressions|broke|broken|breakage)\b[^\n]{0,24}?\b(?:from|by|in)\s+(?:pr\s+)?`,
];

/**
 * A negation immediately governing the cue, so `This does NOT revert #400` is
 * not read as a revert. Anchored to the end of the text BEFORE the cue, with a
 * two-word tolerance for `does not actually revert`. `n't` is intentionally
 * un-anchored so it matches inside `doesn't`.
 */
const NEGATION_BEFORE_CUE_RE = /(?:\bnot|n't|\bnever|\bwithout|\bno)\s+(?:\w+\s+){0,2}$/i;

/**
 * True when `body` carries `cuePrefix` GOVERNING a reference to `#prNumber`.
 *
 * Two things this refuses, both reproduced as false links in review:
 *  - A cross-repo reference. `Reverts otherorg/other-repo#42` names a DIFFERENT
 *    repository's #42. A qualified reference counts only when the qualifier is
 *    known to be this repo, so an unknown `repo` refuses it rather than
 *    assuming local — the conservative direction for a claim of this weight.
 *  - A negated cue (see {@link NEGATION_BEFORE_CUE_RE}).
 */
function bodyCueGovernsPullRequest(
  body: string | undefined,
  cuePrefix: string,
  prNumber: number,
  repo: string | undefined
): boolean {
  if (!body) return false;
  const re = new RegExp(
    `${cuePrefix}([\\w.-]+\\/[\\w.-]+)?#${prNumber}(?!\\d)`,
    'gi'
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const qualifier = match[1];
    if (
      qualifier !== undefined &&
      (repo === undefined || qualifier.toLowerCase() !== repo.toLowerCase())
    ) {
      continue;
    }
    if (NEGATION_BEFORE_CUE_RE.test(body.slice(0, match.index))) continue;
    return true;
  }
  return false;
}

/** True when `body` says it reverts `#prNumber` (`Reverts owner/repo#1801`). */
function bodyRevertsPullRequest(
  body: string | undefined,
  prNumber: number,
  repo: string | undefined
): boolean {
  return bodyCueGovernsPullRequest(body, REVERT_CUE, prNumber, repo);
}

/** True when `body` says it fixes / cleans up after `#prNumber`. */
function bodyFixesPullRequest(
  body: string | undefined,
  prNumber: number,
  repo: string | undefined
): boolean {
  return FIX_CUES.some((cue) =>
    bodyCueGovernsPullRequest(body, cue, prNumber, repo)
  );
}

/**
 * True when the mutation's title is GitHub's auto-generated revert of exactly
 * this shipment: `Revert "<shipped title>"`, with the quotes.
 *
 * The quotes are load-bearing. A bare `includes(pr.title)` matched any shipment
 * whose title was a substring of the reverted one, so a PR titled `Fix` linked
 * to `Revert "Fix typo in the parser"`.
 */
function titleDeclaresRevertOf(
  mutationTitle: string | undefined,
  shippedTitle: string | undefined
): boolean {
  const shipped = shippedTitle?.trim();
  if (!mutationTitle || !shipped) return false;
  if (!REVERT_TITLE_RE.test(mutationTitle)) return false;
  return mutationTitle.includes(`"${shipped}"`);
}

/** ISO instant → epoch ms, or `undefined` when it is not a readable instant. */
function instantMs(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Paths touched by BOTH sides, de-duplicated and stably ordered. */
function sharedArtifacts(
  shipped: string[] | undefined,
  mutation: string[] | undefined
): string[] {
  if (!Array.isArray(shipped) || !Array.isArray(mutation)) return [];
  // perf-index-contract: git-rework-shipped-paths always-consumed: past the array guards every call probes this shipped-path set once per mutation path
  const shippedSet = new Set(
    shipped.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  );
  const out: string[] = [];
  // perf-index-contract: git-rework-seen-paths always-consumed: every mutation path the loop visits is tested against this de-duplication set before it is kept
  const seen = new Set<string>();
  for (const path of mutation) {
    if (typeof path !== 'string' || seen.has(path)) continue;
    if (!shippedSet.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  // perf-index-contract: git-rework-artifact-order always-consumed: the returned intersection is the cited artifact list and is always read in this deterministic order
  return out.sort();
}

function mutationFrom(
  pr: GitOutcomePullRequest,
  kind: GitReworkMutation['kind']
): GitReworkMutation {
  return {
    kind,
    ref: `PR #${pr.number}`,
    prNumber: pr.number,
    ...(pr.title !== undefined ? { title: pr.title } : {}),
    ...(pr.mergedAt !== undefined ? { at: pr.mergedAt } : {}),
    ...(pr.files !== undefined ? { files: pr.files } : {}),
  };
}

/**
 * Link each merged PR to the LATER merged PR that came back to it (#3393),
 * using only the pool already fetched for the outcome labels — so grounding a
 * post-shipment claim costs ZERO extra network calls.
 *
 * Two links, in priority order, and both require the mutation to have merged
 * STRICTLY LATER than the shipment (a "later mutation" that predates the
 * shipment is not rework, it is unrelated history):
 *
 *  1. `revert` — the mutation's body says it reverts this PR, with the verb
 *     GOVERNING the number and not negated, or its title is GitHub's exact
 *     `Revert "<original title>"` form. An explicit revert is self-declaring,
 *     so it needs no file corroboration to be believed; the title path is
 *     dropped when the title does not identify one shipment.
 *  2. `fix-up` — the mutation's body carries FIX language governing this PR's
 *     number AND it re-touched at least one file this PR shipped. A bare
 *     cross-reference is far too common to mean rework on its own
 *     ("Follow-up to #N", "Part of #N"), so the cue plus the shared file is
 *     what makes the link a claim rather than a guess.
 *
 * `options.repo` is this pool's `owner/repo`. A reference qualified to a
 * different repository never links; see {@link bodyCueGovernsPullRequest}.
 *
 * A revert dominates a fix-up on the same shipment, matching
 * {@link classifyPullRequestOutcome}'s tie-break. Input is never mutated —
 * enriched COPIES are returned, so the caller's pool stays reusable.
 *
 * MUST be called per repository. PR numbers are repo-scoped, so a pooled
 * multi-repo array would link `#42` in one repo to a `Reverts #42` in another;
 * {@link collectGitOutcomePullRequests} is the seam that enforces this.
 */
export function linkReworkMutations(
  pullRequests: GitOutcomePullRequest[],
  options: { repo?: string } = {}
): GitOutcomePullRequest[] {
  const { repo } = options;
  const merged = pullRequests.filter(
    (pr) => pr.merged === true || pr.state?.toUpperCase() === 'MERGED'
  );

  // How many merged PRs share each exact title. A title-only revert link is
  // only usable when the title identifies ONE shipment: `Revert "Bump deps"`
  // against two shipments both titled `Bump deps` cannot say which it undid, so
  // it must link neither rather than both.
  // perf-index-contract: git-rework-title-multiplicity always-consumed: every titled shipment consults this count before it will accept a title-only revert link
  const titleCounts = new Map<string, number>();
  for (const candidate of merged) {
    const title = candidate.title?.trim();
    if (!title) continue;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  return pullRequests.map((pr) => {
    const shippedMs = instantMs(pr.mergedAt);
    if (shippedMs === undefined) return pr;
    const titleIsAmbiguous = (titleCounts.get(pr.title?.trim() ?? '') ?? 0) > 1;

    let revert: GitReworkMutation | undefined;
    let fixUp: GitReworkMutation | undefined;
    for (const other of merged) {
      if (other.number === pr.number) continue;
      const otherMs = instantMs(other.mergedAt);
      if (otherMs === undefined || otherMs <= shippedMs) continue;

      const declaresRevert =
        bodyRevertsPullRequest(other.body, pr.number, repo) ||
        (!titleIsAmbiguous && titleDeclaresRevertOf(other.title, pr.title));
      if (declaresRevert) {
        // Earliest revert wins: the first undo is the one that answers "did it hold".
        if (!revert || (instantMs(revert.at) ?? Infinity) > otherMs) {
          revert = mutationFrom(other, 'revert');
        }
        continue;
      }

      // A fix-up needs BOTH fix language governing this PR's number AND a file
      // the shipment touched. The issue-number path is deliberately gone: it
      // read sibling epic slices (`Part of #1911`) as rework of one another.
      if (!bodyFixesPullRequest(other.body, pr.number, repo)) continue;
      if (sharedArtifacts(pr.files, other.files).length === 0) continue;
      if (!fixUp || (instantMs(fixUp.at) ?? Infinity) > otherMs) {
        fixUp = mutationFrom(other, 'fix-up');
      }
    }

    if (!revert && !fixUp) return pr;
    return {
      ...pr,
      ...(revert ? { revert } : {}),
      ...(fixUp ? { fixUp } : {}),
    };
  });
}

/**
 * The four facts, or nothing (#3393). Returns a complete
 * {@link GitPostShipmentRework} only when the PR grounds ALL of:
 * the shipped event (a merged PR), WHEN it shipped, the later mutation with
 * its OWN timestamp, and at least one artifact both of them touched.
 *
 * Any missing piece returns `undefined` — deliberately, and this is the whole
 * point of the function. #3110 found the previous rework claim asserting
 * post-shipment bounce-back from in-session churn alone; the lesson is that a
 * partially-grounded claim of this shape must not degrade to a weaker sentence,
 * it must not be made. A revert dominates a fix-up, as everywhere else here.
 */
export function buildPostShipmentRework(
  pr: GitOutcomePullRequest
): GitPostShipmentRework | undefined {
  const merged = pr.merged === true || pr.state?.toUpperCase() === 'MERGED';
  if (!merged) return undefined;
  const mutation = pr.revert ?? pr.fixUp;
  if (!mutation) return undefined;

  const shippedAt = pr.mergedAt;
  const mutationAt = mutation.at;
  const shippedMs = instantMs(shippedAt);
  const mutationMs = instantMs(mutationAt);
  if (shippedMs === undefined || mutationMs === undefined) return undefined;
  if (mutationMs <= shippedMs) return undefined;

  const artifacts = sharedArtifacts(pr.files, mutation.files);
  if (artifacts.length === 0) return undefined;

  return {
    kind: mutation.kind,
    shippedRef: `PR #${pr.number}${pr.mergeCommit ? ` (merge ${pr.mergeCommit.slice(0, 8)})` : ''}`,
    shippedAt: shippedAt as string,
    mutationRef: mutation.ref,
    mutationAt: mutationAt as string,
    artifacts: artifacts.slice(0, MAX_REWORK_ARTIFACTS),
    daysAfterShipment: Math.floor((mutationMs - shippedMs) / DAY_MS),
  };
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
  // #3655: PR numbers are repo-scoped, so attribution scans each repo's own
  // pool rather than the flattened multi-repo array — a session row must not
  // attach to another repo's same-numbered PR just because it pooled earlier.
  // Records with no `repo` (single-repo callers, pre-#3655 fixtures) share one
  // implicit pool, which preserves the previous behavior exactly.
  // perf-index-contract: git-outcome-repo-pools always-consumed: built unconditionally and scanned by the attribution call for every non-trunk session branch below
  const poolsByRepo = new Map<string | undefined, GitOutcomePullRequest[]>();
  for (const pr of pullRequests) {
    const pool = poolsByRepo.get(pr.repo);
    if (pool) pool.push(pr);
    else poolsByRepo.set(pr.repo, [pr]);
  }
  const pools = [...poolsByRepo.values()];

  const outcomes: GitOutcome[] = [];
  for (const session of sessions) {
    const branch = session.gitBranch?.trim();
    if (!branch || TRUNK_BRANCHES.has(branch.toLowerCase())) continue;

    const match = attributeBranchAcrossPools(branch, pools);
    if (!match) continue;

    const { pr, attribution } = match;
    const label = classifyPullRequestOutcome(pr);
    // OPEN PR → no outcome yet; emit no row rather than a false `abandoned`.
    if (label === undefined) continue;
    const issueNumber = issueNumberFromBranch(branch);
    const evidence = [
      `branch ${branch}`,
      // Name the repo when the pool carried one — a bare `#42` is ambiguous
      // in a multi-repo config (#3655).
      `PR ${pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`}${pr.title ? ` — ${pr.title}` : ''}`,
    ];
    // Fully-evidenced post-shipment rework (#3393), or nothing. A row can be
    // labeled `merged-then-reverted` and still carry NO `rework` — the label
    // needs only the link, the claim needs all four receipts.
    const rework = buildPostShipmentRework(pr);
    outcomes.push({
      sessionId: session.sessionId,
      project: session.project,
      gitBranch: branch,
      label,
      ...(rework ? { rework } : {}),
      provenance: {
        gitBranch: branch,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        prNumber: pr.number,
        ...(pr.repo !== undefined ? { repo: pr.repo } : {}),
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

/**
 * THE FLAG GATE, as one testable pure function (#3393).
 *
 * `repos` is whatever {@link gitOutcomesReposFromEnv} made of
 * `CHD_GIT_OUTCOMES`, and `fetchRepo` is the ONE side-effecting thing in the
 * whole signal — the `gh` shell-out, injected by the ingest step. An empty
 * `repos` returns `[]` WITHOUT calling `fetchRepo` even once, which is the
 * local-first guarantee (repo AGENTS.md) in executable form: flag unset ⇒ no
 * spawn, no network, no external call, and a `gitOutcomes` array byte-identical
 * to the one the default deployment already ships.
 *
 * Keeping the gate here rather than inline in `scripts/ingest.mjs` is what
 * makes it provable: a unit test can hand in a counting `fetchRepo` and assert
 * the count is zero, which an env read buried in an un-importable ingest module
 * cannot support.
 *
 * Per-repo failures degrade to "skip this repo" rather than sinking the signal
 * (a missing `gh`, no auth, a network blip, a malformed payload), and each
 * repo's pool is rework-linked ON ITS OWN via {@link linkReworkMutations},
 * because PR numbers are repo-scoped.
 */
export function collectGitOutcomePullRequests(
  repos: readonly string[],
  fetchRepo: (repo: string) => GitOutcomePullRequest[]
): GitOutcomePullRequest[] {
  if (!Array.isArray(repos) || repos.length === 0) return [];
  const pool: GitOutcomePullRequest[] = [];
  for (const repo of repos) {
    let fetched: GitOutcomePullRequest[];
    try {
      fetched = fetchRepo(repo);
    } catch {
      continue;
    }
    if (!Array.isArray(fetched) || fetched.length === 0) continue;
    // The repo slug travels with its own pool so a reference qualified to a
    // DIFFERENT repository (`Reverts otherorg/other-repo#42`) cannot link here
    // — and is stamped on every record (#3655) so downstream attribution and
    // event grouping stay repo-scoped after the pools are flattened.
    pool.push(
      ...linkReworkMutations(fetched, { repo }).map((pr) => ({ ...pr, repo }))
    );
  }
  return pool;
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
