import { describe, it, expect } from 'vitest';
import {
  buildGitOutcomes,
  classifyPullRequestOutcome,
  attributeBranchToPullRequest,
  issueNumberFromBranch,
  gitOutcomesReposFromEnv,
  collectGitOutcomePullRequests,
  linkReworkMutations,
  buildPostShipmentRework,
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

describe('collectGitOutcomePullRequests — the flag gate makes ZERO calls (#3393)', () => {
  /** A fetcher that records every invocation. Never called ⇒ no spawn, no network. */
  function countingFetcher(result: GitOutcomePullRequest[] = []) {
    const repos: string[] = [];
    return {
      repos,
      fetch: (repo: string) => {
        repos.push(repo);
        return result;
      },
    };
  }

  it('never invokes the fetcher when the flag is unset — the zero-external-calls guarantee', () => {
    // The REAL composition the ingest step performs, with the env unset. The
    // fetcher is the only side-effecting thing in the signal (the `gh`
    // shell-out); a call count of zero IS the flag-off guarantee.
    for (const flag of [undefined, '', '   ', 'not-a-slug']) {
      const spy = countingFetcher([
        { number: 1, headRefName: 'feature/1-x', state: 'MERGED', merged: true },
      ]);
      const repos = gitOutcomesReposFromEnv(flag);
      expect(collectGitOutcomePullRequests(repos, spy.fetch)).toEqual([]);
      expect(spy.repos).toEqual([]);
    }
  });

  it('never invokes the fetcher for a non-array repo list either', () => {
    const spy = countingFetcher();
    expect(
      collectGitOutcomePullRequests(
        undefined as unknown as string[],
        spy.fetch
      )
    ).toEqual([]);
    expect(spy.repos).toEqual([]);
  });

  it('fetches once per configured repo when the flag IS set', () => {
    const spy = countingFetcher();
    collectGitOutcomePullRequests(gitOutcomesReposFromEnv('a/b, c/d'), spy.fetch);
    expect(spy.repos).toEqual(['a/b', 'c/d']);
  });

  it('degrades a throwing repo to a skip rather than sinking the signal', () => {
    const seen: string[] = [];
    const pool = collectGitOutcomePullRequests(['a/b', 'c/d'], (repo) => {
      seen.push(repo);
      if (repo === 'a/b') throw new Error('gh: command not found');
      return [{ number: 7, headRefName: 'feature/7-ok', state: 'MERGED', merged: true }];
    });
    expect(seen).toEqual(['a/b', 'c/d']);
    expect(pool.map((p) => p.number)).toEqual([7]);
  });

  it('stamps every pooled record with its repo slug so attribution stays repo-scoped (#3655)', () => {
    const pool = collectGitOutcomePullRequests(['a/b', 'c/d'], (repo) => [
      {
        number: repo === 'a/b' ? 1 : 2,
        headRefName: `feature/${repo === 'a/b' ? 1 : 2}-x`,
        state: 'MERGED',
        merged: true,
      },
    ]);
    expect(pool.map((p) => p.repo)).toEqual(['a/b', 'c/d']);
  });

  it('links rework per repo, so a #42 in one repo cannot be reverted by another repo', () => {
    const shipped: GitOutcomePullRequest = {
      number: 42,
      headRefName: 'feature/42-thing',
      title: 'Thing',
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-01T00:00:00Z',
      files: ['src/thing.ts'],
    };
    const foreignRevert: GitOutcomePullRequest = {
      number: 99,
      title: 'Revert something else',
      body: 'Reverts #42',
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-02T00:00:00Z',
      files: ['src/thing.ts'],
    };
    // Same numbers, different repos: the revert must NOT reach across.
    const pool = collectGitOutcomePullRequests(['a/b', 'c/d'], (repo) =>
      repo === 'a/b' ? [shipped] : [foreignRevert]
    );
    expect(pool.find((p) => p.number === 42)?.revert).toBeUndefined();
    // Pooled together in one repo, the same pair DOES link — proving the
    // isolation above is the repo boundary, not a broken matcher.
    const linked = linkReworkMutations([shipped, foreignRevert]);
    expect(linked.find((p) => p.number === 42)?.revert?.ref).toBe('PR #99');
  });
});

describe('buildGitOutcomes — multi-repo pools attribute within their own repo (#3655)', () => {
  // Two repos, each carrying a PR numbered 42 with its own head branch. The
  // pooled scan used to attach BOTH repos' sessions to whichever #42 pooled
  // first, collapsing two shipments into one downstream.
  const repoA42: GitOutcomePullRequest = {
    number: 42,
    repo: 'a/b',
    headRefName: 'feature/42-alpha',
    title: 'Alpha 42',
    state: 'MERGED',
    merged: true,
  };
  const repoB42: GitOutcomePullRequest = {
    number: 42,
    repo: 'c/d',
    headRefName: 'feature/42-beta',
    title: 'Beta 42',
    state: 'MERGED',
    merged: true,
  };

  it('attaches each session to its own repo\'s PR on an exact head-branch match', () => {
    const outcomes = buildGitOutcomes(
      [
        { sessionId: 's-alpha', gitBranch: 'feature/42-alpha' },
        { sessionId: 's-beta', gitBranch: 'feature/42-beta' },
      ],
      [repoA42, repoB42]
    );
    expect(outcomes).toHaveLength(2);
    expect(
      outcomes.find((o) => o.sessionId === 's-alpha')?.provenance.repo
    ).toBe('a/b');
    expect(
      outcomes.find((o) => o.sessionId === 's-beta')?.provenance.repo
    ).toBe('c/d');
  });

  it('lets a stronger match in one repo beat a weaker one earlier in the pool', () => {
    // a/b only trailer-references #42; c/d's head matches exactly. The old
    // flattened scan returned a/b's PR because it pooled first.
    const trailerOnly: GitOutcomePullRequest = {
      number: 7,
      repo: 'a/b',
      body: 'Closes #42',
      state: 'MERGED',
      merged: true,
    };
    const outcomes = buildGitOutcomes(
      [{ sessionId: 's', gitBranch: 'feature/42-beta' }],
      [trailerOnly, repoB42]
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].provenance.prNumber).toBe(42);
    expect(outcomes[0].provenance.repo).toBe('c/d');
  });

  it('refuses an attribution that is equally grounded in two repos', () => {
    // No exact head match anywhere, and both repos carry a PR on issue 42:
    // nothing says which repo the branch lived in, so no row is invented.
    const outcomes = buildGitOutcomes(
      [{ sessionId: 's-ambiguous', gitBranch: 'feature/42-gamma' }],
      [repoA42, repoB42]
    );
    expect(outcomes).toEqual([]);
  });

  it('names the repo in evidence and leaves single-pool rows unchanged', () => {
    const multi = buildGitOutcomes(
      [{ sessionId: 's-alpha', gitBranch: 'feature/42-alpha' }],
      [repoA42, repoB42]
    );
    expect(multi[0].provenance.evidence).toContain('PR a/b#42 — Alpha 42');
    // A pool with no repo slugs (pre-#3655 shape) keeps the bare-number form.
    const single = buildGitOutcomes(SESSIONS, PULL_REQUESTS);
    expect(
      single.find((o) => o.sessionId === 's-clean')?.provenance.evidence
    ).toContain('PR #1001 — Clean landing');
    expect(
      single.find((o) => o.sessionId === 's-clean')?.provenance.repo
    ).toBeUndefined();
  });
});

describe('linkReworkMutations (#3393)', () => {
  const shipped: GitOutcomePullRequest = {
    number: 100,
    headRefName: 'feature/100-widget',
    title: 'Add the widget',
    body: 'Closes #100',
    state: 'MERGED',
    merged: true,
    mergedAt: '2026-06-01T12:00:00Z',
    mergeCommit: 'abcdef1234567890',
    files: ['src/widget.ts', 'src/widget.test.ts'],
  };

  it('links an explicit "Reverts #N" body, no file corroboration needed', () => {
    const [linked] = linkReworkMutations([
      shipped,
      {
        number: 101,
        title: 'Revert "Add the widget"',
        body: 'Reverts shpwrck/claude-history-dashboard#100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-03T12:00:00Z',
        files: ['src/widget.ts'],
      },
    ]);
    expect(linked.revert).toMatchObject({ kind: 'revert', ref: 'PR #101', prNumber: 101 });
    expect(classifyPullRequestOutcome(linked)).toBe('merged-then-reverted');
  });

  it('links GitHub’s auto-generated Revert "<title>" form', () => {
    const [linked] = linkReworkMutations([
      shipped,
      {
        number: 102,
        title: 'Revert "Add the widget"',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-04T12:00:00Z',
      },
    ]);
    expect(linked.revert?.prNumber).toBe(102);
  });

  it('requires BOTH a reference and a shared file for a fix-up', () => {
    // References the shipment but touches nothing it shipped -> not rework.
    const [refOnly] = linkReworkMutations([
      shipped,
      {
        number: 103,
        title: 'Unrelated follow-up',
        body: 'Follow-up to #100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-05T12:00:00Z',
        files: ['docs/other.md'],
      },
    ]);
    expect(refOnly.fixUp).toBeUndefined();

    // Touches a shipped file but never references it -> not rework either.
    const [fileOnly] = linkReworkMutations([
      shipped,
      {
        number: 104,
        title: 'Routine edit',
        body: 'no reference here',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-05T12:00:00Z',
        files: ['src/widget.ts'],
      },
    ]);
    expect(fileOnly.fixUp).toBeUndefined();

    // Both -> a fix-up.
    const [both] = linkReworkMutations([
      shipped,
      {
        number: 105,
        title: 'Fix the widget',
        body: 'Fixes a regression from #100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-05T12:00:00Z',
        files: ['src/widget.ts'],
      },
    ]);
    expect(both.fixUp).toMatchObject({ kind: 'fix-up', prNumber: 105 });
    expect(classifyPullRequestOutcome(both)).toBe('merged-then-fixed');
  });

  it('ignores a mutation that landed BEFORE the shipment', () => {
    const [linked] = linkReworkMutations([
      shipped,
      {
        number: 106,
        title: 'Revert "Add the widget"',
        body: 'Reverts #100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-05-01T12:00:00Z', // earlier than the shipment
        files: ['src/widget.ts'],
      },
    ]);
    expect(linked.revert).toBeUndefined();
    expect(linked.fixUp).toBeUndefined();
  });

  it('ignores an unmerged mutation and leaves an undated shipment alone', () => {
    const [openRevert] = linkReworkMutations([
      shipped,
      {
        number: 107,
        title: 'Revert "Add the widget"',
        body: 'Reverts #100',
        state: 'OPEN',
        mergedAt: '2026-06-06T12:00:00Z',
      },
    ]);
    expect(openRevert.revert).toBeUndefined();

    const [undated] = linkReworkMutations([
      { ...shipped, mergedAt: undefined },
      {
        number: 108,
        body: 'Reverts #100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-06T12:00:00Z',
      },
    ]);
    expect(undated.revert).toBeUndefined();
  });

  it('returns enriched copies and never mutates the caller’s pool', () => {
    const pool: GitOutcomePullRequest[] = [
      shipped,
      {
        number: 109,
        body: 'Reverts #100',
        state: 'MERGED',
        merged: true,
        mergedAt: '2026-06-07T12:00:00Z',
      },
    ];
    linkReworkMutations(pool);
    expect(pool[0].revert).toBeUndefined();
  });
});

describe('linkReworkMutations false-positive guards (#3393 review)', () => {
  /** A merged shipment with the given number/title, touching one known file. */
  function shipment(
    number: number,
    title: string,
    files = ['src/thing.ts']
  ): GitOutcomePullRequest {
    return {
      number,
      headRefName: `feature/${number}-x`,
      title,
      body: `Closes #${number}`,
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-01T00:00:00Z',
      files,
    };
  }
  /** A later merged PR, the candidate mutation. */
  function later(
    number: number,
    over: Partial<GitOutcomePullRequest> = {}
  ): GitOutcomePullRequest {
    return {
      number,
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-05T00:00:00Z',
      files: ['src/thing.ts'],
      ...over,
    };
  }

  it('does not link when the revert verb does not govern the number', () => {
    // "Reverts" is about prose, and #300 belongs to a DIFFERENT clause.
    const [linked] = linkReworkMutations([
      shipment(300, 'Add the thing'),
      later(301, { title: 'Try again', body: 'Reverts the flaky approach; closes #300' }),
    ]);
    expect(linked.revert).toBeUndefined();
  });

  it('does not link a negated revert', () => {
    const [linked] = linkReworkMutations([
      shipment(400, 'Add the thing'),
      later(401, { title: 'Follow-up', body: 'This does NOT revert #400 — it builds on it.' }),
    ]);
    expect(linked.revert).toBeUndefined();
  });

  it('does not link a revert title that merely contains the shipment title', () => {
    // Short titles are substrings of longer ones; only the quoted form counts.
    const [linked] = linkReworkMutations([
      shipment(500, 'Fix'),
      later(501, { title: 'Revert "Fix typo in the parser"', body: 'no refs' }),
    ]);
    expect(linked.revert).toBeUndefined();
  });

  it('does not attach one revert to every identically-titled shipment', () => {
    // Two shipments share a title and the revert names only the title, so which
    // one it undid is unknowable — link neither rather than both.
    const pool = linkReworkMutations([
      { ...shipment(600, 'Bump deps'), mergedAt: '2026-06-01T00:00:00Z' },
      { ...shipment(601, 'Bump deps'), mergedAt: '2026-06-02T00:00:00Z' },
      later(602, { title: 'Revert "Bump deps"', body: 'no refs' }),
    ]);
    expect(pool.find((p) => p.number === 600)?.revert).toBeUndefined();
    expect(pool.find((p) => p.number === 601)?.revert).toBeUndefined();
  });

  it('does not link a revert reference qualified to a DIFFERENT repo', () => {
    const [linked] = linkReworkMutations(
      [
        shipment(42, 'Add the thing'),
        later(43, { title: 'Sync', body: 'Reverts otherorg/other-repo#42' }),
      ],
      { repo: 'shpwrck/claude-history-dashboard' }
    );
    expect(linked.revert).toBeUndefined();
  });

  it('still links a revert reference qualified to THIS repo', () => {
    const [linked] = linkReworkMutations(
      [
        shipment(44, 'Add the thing'),
        later(45, { title: 'Sync', body: 'Reverts shpwrck/claude-history-dashboard#44' }),
      ],
      { repo: 'shpwrck/claude-history-dashboard' }
    );
    expect(linked.revert?.prNumber).toBe(45);
  });

  it('does not read two epic slices sharing a file as rework', () => {
    // The exact #1911 shape: sibling slices reference the same epic and touch
    // the same file. That is parallel work, not a change coming back.
    const sliceA: GitOutcomePullRequest = {
      number: 1912,
      headRefName: 'feature/1911-slice-a',
      title: 'Epic slice A',
      body: 'Part of #1911',
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-01T00:00:00Z',
      files: ['src/shared.ts'],
    };
    const sliceB: GitOutcomePullRequest = {
      number: 1913,
      headRefName: 'feature/1911-slice-b',
      title: 'Epic slice B',
      body: 'Part of #1911',
      state: 'MERGED',
      merged: true,
      mergedAt: '2026-06-05T00:00:00Z',
      files: ['src/shared.ts'],
    };
    const [linkedA] = linkReworkMutations([sliceA, sliceB]);
    expect(linkedA.fixUp).toBeUndefined();
  });

  it('does not read a bare cross-reference to the shipped PR as a fix-up', () => {
    const [linked] = linkReworkMutations([
      shipment(700, 'Add the thing'),
      later(701, { title: 'More work', body: 'Follow-up to #700' }),
    ]);
    expect(linked.fixUp).toBeUndefined();
  });

  it('still links a fix-up whose body carries real fix language', () => {
    const [linked] = linkReworkMutations([
      shipment(800, 'Add the thing'),
      later(801, { title: 'Patch', body: 'Fixes a regression from #800' }),
    ]);
    expect(linked.fixUp?.prNumber).toBe(801);
  });
});

describe('buildPostShipmentRework — all four facts, or nothing (#3393)', () => {
  const complete: GitOutcomePullRequest = {
    number: 200,
    headRefName: 'feature/200-thing',
    title: 'Ship the thing',
    state: 'MERGED',
    merged: true,
    mergedAt: '2026-06-01T00:00:00Z',
    mergeCommit: 'deadbeefcafebabe',
    files: ['src/thing.ts', 'src/other.ts'],
    revert: {
      kind: 'revert',
      ref: 'PR #201',
      prNumber: 201,
      at: '2026-06-04T00:00:00Z',
      files: ['src/thing.ts'],
    },
  };

  it('emits every cited fact when all four are grounded', () => {
    expect(buildPostShipmentRework(complete)).toEqual({
      kind: 'revert',
      shippedRef: 'PR #200 (merge deadbeef)',
      shippedAt: '2026-06-01T00:00:00Z',
      mutationRef: 'PR #201',
      mutationAt: '2026-06-04T00:00:00Z',
      artifacts: ['src/thing.ts'],
      daysAfterShipment: 3,
    });
  });

  it('returns undefined when ANY one of the four facts is missing', () => {
    // No shipped event (never merged).
    expect(
      buildPostShipmentRework({ ...complete, merged: false, state: 'CLOSED' })
    ).toBeUndefined();
    // No shipment timestamp.
    expect(
      buildPostShipmentRework({ ...complete, mergedAt: undefined })
    ).toBeUndefined();
    // No later mutation at all.
    expect(
      buildPostShipmentRework({ ...complete, revert: undefined })
    ).toBeUndefined();
    // Mutation with no timestamp of its own.
    expect(
      buildPostShipmentRework({
        ...complete,
        revert: { ...complete.revert!, at: undefined },
      })
    ).toBeUndefined();
    // No artifact both sides touched.
    expect(
      buildPostShipmentRework({
        ...complete,
        revert: { ...complete.revert!, files: ['docs/unrelated.md'] },
      })
    ).toBeUndefined();
    // Shipment files unknown, so no intersection can be computed.
    expect(
      buildPostShipmentRework({ ...complete, files: undefined })
    ).toBeUndefined();
    // Unreadable timestamps are refused rather than coerced.
    expect(
      buildPostShipmentRework({ ...complete, mergedAt: 'last Tuesday' })
    ).toBeUndefined();
  });

  it('refuses a mutation that is not strictly later than the shipment', () => {
    expect(
      buildPostShipmentRework({
        ...complete,
        revert: { ...complete.revert!, at: '2026-06-01T00:00:00Z' },
      })
    ).toBeUndefined();
  });

  it('lets a revert dominate a fix-up on the same shipment', () => {
    const both = buildPostShipmentRework({
      ...complete,
      fixUp: {
        kind: 'fix-up',
        ref: 'PR #202',
        prNumber: 202,
        at: '2026-06-02T00:00:00Z',
        files: ['src/thing.ts'],
      },
    });
    expect(both?.kind).toBe('revert');
    expect(both?.mutationRef).toBe('PR #201');
  });

  it('attaches the evidence to the session row only when it is complete', () => {
    const sessions: GitOutcomeSession[] = [
      { sessionId: 's-complete', gitBranch: 'feature/200-thing' },
    ];
    const [row] = buildGitOutcomes(sessions, [complete]);
    expect(row.label).toBe('merged-then-reverted');
    expect(row.rework?.artifacts).toEqual(['src/thing.ts']);

    // Same label, no receipts -> the label survives, the claim evidence does not.
    const [bare] = buildGitOutcomes(sessions, [
      { ...complete, files: undefined },
    ]);
    expect(bare.label).toBe('merged-then-reverted');
    expect(bare.rework).toBeUndefined();
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
