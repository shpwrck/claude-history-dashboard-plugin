import { describe, it, expect } from 'vitest';
import {
  buildGitOutcomes,
  classifyPullRequestOutcome,
  attributeBranchToPullRequest,
  issueNumberFromBranch,
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
});
