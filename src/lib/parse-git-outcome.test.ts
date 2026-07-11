import { describe, it, expect } from 'vitest';
import {
  buildGitOutcomes,
  classifyPullRequestOutcome,
  attributeBranchToPullRequest,
  issueNumberFromBranch,
  gitOutcomesReposFromEnv,
  isGitOutcomeStale,
  demoteStaleGitOutcome,
  GIT_OUTCOME_FRESHNESS_DAYS,
} from './parse-git-outcome';
import type {
  GitOutcomePullRequest,
  GitOutcomeSession,
} from './parse-git-outcome';

/**
 * Fixture: one PR per delivery-outcome label, plus the sessions whose
 * `gitBranch` joins to them. Injected directly — NO live `gh` / network — which
 * is exactly how the pure classifier is meant to be exercised (the live fetch
 * lives in scripts/ingest.mjs).
 */
const PULL_REQUESTS: GitOutcomePullRequest[] = [
  // merged-clean: merged, no later revert/fix. Attributed by the convention
  // (head branch carries issue 1001).
  {
    number: 1001,
    headRefName: 'feature/1001-clean-landing',
    title: 'Clean landing',
    body: 'Closes #1001',
    state: 'MERGED',
    merged: true,
  },
  // merged-then-reverted: merged but undone by a later revert.
  {
    number: 1002,
    headRefName: 'feature/1002-bad-change',
    title: 'Bad change',
    body: 'Closes #1002',
    state: 'MERGED',
    merged: true,
    reverted: true,
  },
  // merged-then-fixed: merged then patched by a follow-up, no full revert.
  {
    number: 1003,
    headRefName: 'feature/1003-needs-hotfix',
    title: 'Needs hotfix',
    body: 'Closes #1003',
    state: 'MERGED',
    merged: true,
    fixedUp: true,
  },
  // abandoned: closed without merging.
  {
    number: 1004,
    headRefName: 'feature/1004-dropped',
    title: 'Dropped',
    body: 'Closes #1004',
    state: 'CLOSED',
    merged: false,
  },
];

const SESSIONS: GitOutcomeSession[] = [
  { sessionId: 's-clean', project: '/p', gitBranch: 'feature/1001-clean-landing' },
  { sessionId: 's-revert', project: '/p', gitBranch: 'feature/1002-bad-change' },
  { sessionId: 's-fixed', project: '/p', gitBranch: 'feature/1003-needs-hotfix' },
  { sessionId: 's-dropped', project: '/p', gitBranch: 'feature/1004-dropped' },
];

describe('issueNumberFromBranch', () => {
  it('parses the issue number from the feature/NNN-* convention', () => {
    expect(issueNumberFromBranch('feature/1757-git-outcome-signal')).toBe(1757);
    expect(issueNumberFromBranch('fix/42-bug')).toBe(42);
  });
  it('returns undefined for branches without a leading issue number', () => {
    expect(issueNumberFromBranch('main')).toBeUndefined();
    expect(issueNumberFromBranch('feature/no-number')).toBeUndefined();
  });
});

describe('classifyPullRequestOutcome', () => {
  it('classifies each delivery outcome', () => {
    expect(classifyPullRequestOutcome(PULL_REQUESTS[0])).toBe('merged-clean');
    expect(classifyPullRequestOutcome(PULL_REQUESTS[1])).toBe('merged-then-reverted');
    expect(classifyPullRequestOutcome(PULL_REQUESTS[2])).toBe('merged-then-fixed');
    expect(classifyPullRequestOutcome(PULL_REQUESTS[3])).toBe('abandoned');
  });
  it('treats state MERGED as merged even without an explicit merged flag', () => {
    expect(classifyPullRequestOutcome({ number: 9, state: 'MERGED' })).toBe('merged-clean');
  });
  it('lets a revert dominate a follow-up fix when both are present', () => {
    expect(
      classifyPullRequestOutcome({ number: 9, merged: true, reverted: true, fixedUp: true })
    ).toBe('merged-then-reverted');
  });
  it('returns undefined for an OPEN, in-flight PR — no outcome yet (#2510)', () => {
    expect(classifyPullRequestOutcome({ number: 5, state: 'OPEN' })).toBeUndefined();
    expect(
      classifyPullRequestOutcome({ number: 5, state: 'OPEN', merged: false })
    ).toBeUndefined();
    // Case-insensitive on state.
    expect(classifyPullRequestOutcome({ number: 5, state: 'open' })).toBeUndefined();
  });
  it('still classifies a CLOSED-without-merge PR as abandoned (#2510)', () => {
    expect(
      classifyPullRequestOutcome({ number: 6, state: 'CLOSED', merged: false })
    ).toBe('abandoned');
    // A stateless, unmerged record still reads as abandoned (unchanged default).
    expect(classifyPullRequestOutcome({ number: 6 })).toBe('abandoned');
  });
});

describe('attributeBranchToPullRequest', () => {
  it('attributes by exact head-branch match', () => {
    const m = attributeBranchToPullRequest('feature/1001-clean-landing', PULL_REQUESTS);
    expect(m?.pr.number).toBe(1001);
    expect(m?.attribution).toBe('branch');
  });
  it('attributes by the feature/NNN-* convention when the head branch differs', () => {
    const prs: GitOutcomePullRequest[] = [
      { number: 7, headRefName: 'feature/1757-renamed-head', state: 'MERGED', merged: true },
    ];
    const m = attributeBranchToPullRequest('feature/1757-git-outcome-signal', prs);
    expect(m?.pr.number).toBe(7);
    expect(m?.attribution).toBe('branch');
  });
  it('falls back to a body issue reference (trailer) when the branch is gone', () => {
    const prs: GitOutcomePullRequest[] = [
      { number: 8, headRefName: 'some-other-head', body: 'Closes #1757', state: 'MERGED', merged: true },
    ];
    const m = attributeBranchToPullRequest('feature/1757-git-outcome-signal', prs);
    expect(m?.pr.number).toBe(8);
    expect(m?.attribution).toBe('trailer');
  });
  it('does not match a shorter issue number as a substring of a longer one', () => {
    const prs: GitOutcomePullRequest[] = [
      { number: 8, headRefName: 'x', body: 'Closes #17570', state: 'MERGED', merged: true },
    ];
    expect(attributeBranchToPullRequest('feature/1757-x', prs)).toBeUndefined();
  });
  it('returns undefined when no PR grounds the branch', () => {
    expect(attributeBranchToPullRequest('feature/9999-orphan', PULL_REQUESTS)).toBeUndefined();
  });
});

describe('buildGitOutcomes', () => {
  it('emits one row per outcome label with provenance', () => {
    const outcomes = buildGitOutcomes(SESSIONS, PULL_REQUESTS);
    expect(outcomes).toHaveLength(4);
    const byLabel = Object.fromEntries(outcomes.map((o) => [o.label, o]));

    expect(byLabel['merged-clean'].sessionId).toBe('s-clean');
    expect(byLabel['merged-then-reverted'].sessionId).toBe('s-revert');
    expect(byLabel['merged-then-fixed'].sessionId).toBe('s-fixed');
    expect(byLabel['abandoned'].sessionId).toBe('s-dropped');

    const clean = byLabel['merged-clean'];
    expect(clean.provenance.prNumber).toBe(1001);
    expect(clean.provenance.issueNumber).toBe(1001);
    expect(clean.provenance.attribution).toBe('branch');
    expect(clean.provenance.gitBranch).toBe('feature/1001-clean-landing');
    expect(clean.provenance.evidence.length).toBeGreaterThan(0);
  });

  it('skips sessions on trunk branches, with no branch, or with no PR', () => {
    const sessions: GitOutcomeSession[] = [
      { sessionId: 'trunk', gitBranch: 'main' },
      { sessionId: 'no-branch' },
      { sessionId: 'orphan', gitBranch: 'feature/9999-orphan' },
    ];
    expect(buildGitOutcomes(sessions, PULL_REQUESTS)).toHaveLength(0);
  });

  it('emits NO row for a session grounding an OPEN, in-flight PR (#2510)', () => {
    const prs: GitOutcomePullRequest[] = [
      {
        number: 2000,
        headRefName: 'feature/2000-in-flight',
        title: 'WIP',
        state: 'OPEN',
        merged: false,
      },
      { number: 2001, headRefName: 'feature/2001-landed', state: 'MERGED', merged: true },
    ];
    const sessions: GitOutcomeSession[] = [
      { sessionId: 's-open', gitBranch: 'feature/2000-in-flight' },
      { sessionId: 's-merged', gitBranch: 'feature/2001-landed' },
    ];
    const outcomes = buildGitOutcomes(sessions, prs);
    // The open PR is dropped; the merged one still lands. No false `abandoned`.
    expect(outcomes.map((o) => o.sessionId)).toEqual(['s-merged']);
    expect(outcomes.some((o) => o.label === 'abandoned')).toBe(false);
  });

  it('stamps provenance.asOf on every emitted row when supplied (#2510)', () => {
    const outcomes = buildGitOutcomes(SESSIONS, PULL_REQUESTS, { asOf: '2026-07-11' });
    expect(outcomes).toHaveLength(4);
    expect(outcomes.every((o) => o.provenance.asOf === '2026-07-11')).toBe(true);
    // No asOf option ⇒ no asOf field: an undatable row is never stale-flagged.
    const undated = buildGitOutcomes(SESSIONS, PULL_REQUESTS);
    expect(undated.every((o) => o.provenance.asOf === undefined)).toBe(true);
  });
});

describe('gitOutcomesReposFromEnv (CHD_GIT_OUTCOMES opt-in gate)', () => {
  it('returns [] when the flag is unset/empty/whitespace/invalid — the flag-OFF path', () => {
    // [] ⇒ readGitOutcomes short-circuits before any `gh` call ⇒ the default
    // dataset is byte-identical and makes zero external calls (#2510).
    expect(gitOutcomesReposFromEnv(undefined)).toEqual([]);
    expect(gitOutcomesReposFromEnv('')).toEqual([]);
    expect(gitOutcomesReposFromEnv('   ')).toEqual([]);
    expect(gitOutcomesReposFromEnv('not-a-slug')).toEqual([]);
  });
  it('parses a single slug or a comma/space list when the flag is set', () => {
    expect(gitOutcomesReposFromEnv('shpwrck/claude-history-dashboard')).toEqual([
      'shpwrck/claude-history-dashboard',
    ]);
    expect(gitOutcomesReposFromEnv('a/b, c/d  e/f')).toEqual(['a/b', 'c/d', 'e/f']);
  });
});

describe('flag-off / empty PR pool is byte-identical + side-effect-free (#2510)', () => {
  it('yields an empty signal for an empty pool (the input the unset flag produces)', () => {
    // With CHD_GIT_OUTCOMES unset, readGitOutcomes returns [] BEFORE any `gh`
    // fetch, so the pure module is never handed a PR. This pins the downstream
    // invariant: an empty pool ⇒ empty, side-effect-free gitOutcomes.
    expect(buildGitOutcomes(SESSIONS, [])).toEqual([]);
    expect(buildGitOutcomes(SESSIONS, [], { asOf: '2026-07-11' })).toEqual([]);
  });
});

describe('git-outcome stale demotion (#2510, mirrors #2142)', () => {
  const NOW = Date.parse('2026-07-11T00:00:00Z');

  it('isGitOutcomeStale: fresh within threshold, stale past it, false for missing/garbage', () => {
    expect(isGitOutcomeStale('2026-07-01', NOW)).toBe(false); // ~10 days < 30
    expect(isGitOutcomeStale('2026-01-01', NOW)).toBe(true); // ~190 days > 30
    expect(isGitOutcomeStale(undefined, NOW)).toBe(false);
    expect(isGitOutcomeStale('not-a-date', NOW)).toBe(false);
    // A full ISO timestamp is intentionally rejected — asOf must be YYYY-MM-DD.
    expect(isGitOutcomeStale('2026-01-01T00:00:00Z', NOW)).toBe(false);
  });

  it('demotes a stale row (stale:true, label + asOf kept) and leaves a fresh one untouched', () => {
    const [row] = buildGitOutcomes(
      [{ sessionId: 's', gitBranch: 'feature/1001-clean-landing' }],
      PULL_REQUESTS,
      { asOf: '2026-01-01' }
    );
    expect(row.provenance.asOf).toBe('2026-01-01');
    expect(row.provenance.stale).toBeUndefined();

    const demoted = demoteStaleGitOutcome(row, NOW);
    expect(demoted.provenance.stale).toBe(true);
    expect(demoted.provenance.asOf).toBe('2026-01-01');
    expect(demoted.label).toBe(row.label); // label preserved; only presentation changes
    expect(demoted).not.toBe(row); // pure — new object
    expect(row.provenance.stale).toBeUndefined(); // input not mutated

    // Consumed the same day ⇒ not stale ⇒ referentially identical, no stale flag.
    const fresh = demoteStaleGitOutcome(row, Date.parse('2026-01-01T12:00:00Z'));
    expect(fresh).toBe(row);
    expect(fresh.provenance.stale).toBeUndefined();
  });

  it('never flags a row that carries no asOf', () => {
    const [undated] = buildGitOutcomes(
      [{ sessionId: 's', gitBranch: 'feature/1001-clean-landing' }],
      PULL_REQUESTS
    );
    expect(undated.provenance.asOf).toBeUndefined();
    expect(demoteStaleGitOutcome(undated, NOW)).toBe(undated);
  });

  it('exposes a positive default freshness threshold', () => {
    expect(GIT_OUTCOME_FRESHNESS_DAYS).toBeGreaterThan(0);
  });
});
