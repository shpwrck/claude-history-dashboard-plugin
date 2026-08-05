import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assembleRecommendationInput,
  buildRecommendations,
  type RecommendationInput,
} from './recommendations';
import type { GitOutcome } from './parse-git-outcome';

/**
 * Boot-path wiring guard for the flag-gated post-shipment rework claim (#3393),
 * in the same source-level style as `local-calibration-wiring.test.ts`: vitest
 * cannot BOOT the server module graph (the #1013 zero-node_modules hazard), but
 * it CAN pin the two properties the local-first rule (repo AGENTS.md) turns on.
 *
 *  1. The `gh` shell-out is reachable ONLY through the flag gate. The unit proof
 *     that the gate makes zero calls lives in `parse-git-outcome.test.ts`
 *     (a counting fetcher, invoked zero times); what THIS file adds is that
 *     `scripts/ingest.mjs` actually routes its fetch through that gate rather
 *     than looping `gh` itself — a refactor that reinstated the old inline loop
 *     would keep the unit test green while breaking the guarantee.
 *  2. Without `gitOutcomes` the detector is dark, so the flag-off deployment
 *     path emits byte-identical recommendations.
 */

const ROOT = process.cwd();
const src = readFileSync(`${ROOT}/scripts/ingest.mjs`, 'utf8');

function span(marker: string, len = 2000): string {
  const idx = src.indexOf(marker);
  expect(idx, `${marker} found in ingest.mjs`).toBeGreaterThan(-1);
  return src.slice(idx, idx + len);
}

const NOW = Date.parse('2026-06-20T00:00:00.000Z');

function baseViews(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...over,
  };
}

const REWORKED_ROW: GitOutcome = {
  sessionId: 'sess-rework',
  project: '/repo',
  gitBranch: 'feature/200-thing',
  label: 'merged-then-reverted',
  provenance: {
    gitBranch: 'feature/200-thing',
    issueNumber: 200,
    prNumber: 200,
    attribution: 'branch',
    evidence: ['branch feature/200-thing', 'PR #200 — Ship the thing'],
    asOf: '2026-06-18',
  },
  rework: {
    kind: 'revert',
    shippedRef: 'PR #200 (merge deadbeef)',
    shippedAt: '2026-06-10T00:00:00Z',
    mutationRef: 'PR #201',
    mutationAt: '2026-06-14T00:00:00Z',
    artifacts: ['src/thing.ts'],
    daysAfterShipment: 4,
  },
};

function fired(input: Partial<RecommendationInput>): boolean {
  const recs = buildRecommendations(
    assembleRecommendationInput(baseViews(input)),
    NOW
  );
  return recs.some((r) => r.id === 'reliability.post-shipment-rework');
}

describe('git-outcome rework ingest wiring (#3393)', () => {
  it('routes the gh fetch through the flag gate instead of looping it inline', () => {
    const reader = span('function readGitOutcomes(sessions)');
    expect(reader).toContain(
      'collectGitOutcomePullRequests(\n    GIT_OUTCOMES_REPOS,\n    fetchPullRequestsForRepo\n  )'
    );
    // The fetcher is PASSED to the gate, never called by readGitOutcomes — so
    // there is no path from an unset flag to a spawn.
    expect(reader).not.toContain('fetchPullRequestsForRepo(');
    expect(reader).not.toContain('execFileSync');
  });

  it('keeps the gh shell-out confined to the injected fetcher', () => {
    const fetcher = span('function fetchPullRequestsForRepo(repo)');
    expect(fetcher).toContain("execFileSync(\n    'gh',");
    // Exactly one execFileSync in the whole git-outcome path.
    const gitOutcomeSpan = src.slice(
      src.indexOf('function fetchPullRequestsForRepo(repo)'),
      src.indexOf('function readLocalCalibration()')
    );
    expect(gitOutcomeSpan.match(/execFileSync\(/g) ?? []).toHaveLength(1);
  });

  it('fetches the fields the four-fact claim needs, in one call per repo', () => {
    const fetcher = span('function fetchPullRequestsForRepo(repo)');
    expect(fetcher).toContain(
      "'number,headRefName,title,body,state,mergedAt,mergeCommit,files',"
    );
    expect(fetcher).toContain('mergeCommit: pr.mergeCommit?.oid ?? undefined,');
  });

  it('reads the flag through the pure parser, not an inline env test', () => {
    expect(src).toContain(
      'const GIT_OUTCOMES_REPOS = gitOutcomesReposFromEnv(process.env.CHD_GIT_OUTCOMES);'
    );
    expect(src).toContain('collectGitOutcomePullRequests,');
  });
});

describe('post-shipment rework is dark without the git source (#3393)', () => {
  it('emits nothing when gitOutcomes is absent — the flag-off deployment path', () => {
    expect(fired({})).toBe(false);
    expect(fired({ gitOutcomes: null })).toBe(false);
    expect(fired({ gitOutcomes: [] })).toBe(false);
  });

  it('emits nothing from outcome rows that carry no rework receipts', () => {
    // Same `merged-then-reverted` LABEL, no four-fact evidence: the claim is
    // not weakened, it is not made.
    const bare: GitOutcome = { ...REWORKED_ROW };
    delete bare.rework;
    expect(fired({ gitOutcomes: [bare] })).toBe(false);
  });

  it('fires once the git source supplies fully-evidenced rework', () => {
    expect(fired({ gitOutcomes: [REWORKED_ROW] })).toBe(true);
  });
});
