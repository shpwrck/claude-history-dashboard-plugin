import { describe, it, expect } from 'vitest';
import { detector } from './post-shipment-rework';
import { validateFixSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { GitOutcome, GitPostShipmentRework } from '../../parse-git-outcome';

/**
 * #3393. The claim this detector makes is the one #3110 caught the old
 * boomerang audit making without evidence, so the tests are weighted toward
 * what it must REFUSE to say: nothing without a git source, nothing from a
 * label alone, and nothing in the present tense off a stale PR snapshot.
 */

const NOW = Date.parse('2026-06-20T00:00:00.000Z');

const REVERT: GitPostShipmentRework = {
  kind: 'revert',
  shippedRef: 'PR #200 (merge deadbeef)',
  shippedAt: '2026-06-10T00:00:00Z',
  mutationRef: 'PR #201',
  mutationAt: '2026-06-14T00:00:00Z',
  artifacts: ['src/thing.ts'],
  daysAfterShipment: 4,
};

const FIX_UP: GitPostShipmentRework = {
  kind: 'fix-up',
  shippedRef: 'PR #300 (merge feedface)',
  shippedAt: '2026-06-11T00:00:00Z',
  mutationRef: 'PR #301',
  mutationAt: '2026-06-13T00:00:00Z',
  artifacts: ['src/other.ts', 'src/other.test.ts'],
  daysAfterShipment: 2,
};

/**
 * The shipped PR number, read off the rework's own `shippedRef`. Rows are keyed
 * by `provenance.prNumber`, so a fixture whose provenance disagreed with its
 * evidence would silently mis-group — deriving it keeps the two in step. A
 * label-only row (no rework) gets a fixed number: nothing groups on it. A
 * rework whose ref does NOT parse throws instead of silently defaulting (#3655)
 * — a default would hide exactly the disagreement this helper exists to prevent.
 */
function shippedPrNumber(rework: GitPostShipmentRework | undefined): number {
  if (!rework) return 200;
  const m = /#(\d+)/.exec(rework.shippedRef);
  if (!m) {
    throw new Error(
      `fixture rework carries no parseable PR number in shippedRef: ${rework.shippedRef}`
    );
  }
  return Number(m[1]);
}

function row(
  sessionId: string,
  rework: GitPostShipmentRework | undefined,
  asOf = '2026-06-18'
): GitOutcome {
  const prNumber = shippedPrNumber(rework);
  return {
    sessionId,
    project: '/repo',
    gitBranch: `feature/${sessionId}-x`,
    label: rework?.kind === 'revert' ? 'merged-then-reverted' : 'merged-then-fixed',
    provenance: {
      gitBranch: `feature/${sessionId}-x`,
      prNumber,
      attribution: 'branch',
      evidence: [`branch feature/${sessionId}-x`, `PR #${prNumber}`],
      asOf,
    },
    ...(rework ? { rework } : {}),
  };
}

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...over,
  } as RecommendationInput;
}

describe('reliability.post-shipment-rework — stays silent', () => {
  it('says nothing without a git source (flag off, SPA/upload dataset)', () => {
    expect(detector.rule(input(), NOW)).toBeNull();
    expect(detector.rule(input({ gitOutcomes: null }), NOW)).toBeNull();
    expect(detector.rule(input({ gitOutcomes: [] }), NOW)).toBeNull();
  });

  it('says nothing from an outcome LABEL alone — the #3110 failure mode', () => {
    // These rows are labeled merged-then-reverted/merged-then-fixed, which is
    // exactly the tempting proxy. Without the four facts, no claim at all.
    const labelsOnly = [row('a', undefined), row('b', undefined)];
    expect(detector.rule(input({ gitOutcomes: labelsOnly }), NOW)).toBeNull();
  });

  it('self-suppresses once its OWN pasted snippet is in CLAUDE.md', () => {
    // Pastes the exact snippet the fix ships rather than a paraphrase. This is
    // the guard for a real defect this detector shipped in draft: `bodyPhrases`
    // are substring matches, so a marker phrase that wrapped across a newline in
    // the snippet matched nothing and the fix could never suppress itself.
    const fired = detector.rule(input({ gitOutcomes: [row('a', REVERT)] }), NOW)!;
    const applied = {
      claudeMd: { global: `# Project rules\n\n${fired.fix!.snippet}\n` },
    } as unknown as RecommendationInput['liveConfig'];
    expect(
      detector.rule(
        input({ gitOutcomes: [row('a', REVERT)], liveConfig: applied }),
        NOW
      )
    ).toBeNull();
  });

  it('is not suppressed by unrelated CLAUDE.md prose', () => {
    const unrelated = {
      claudeMd: {
        global: '## Verification\n\nRe-run the tests before merging anything.\n',
      },
    } as unknown as RecommendationInput['liveConfig'];
    expect(
      detector.rule(
        input({ gitOutcomes: [row('a', REVERT)], liveConfig: unrelated }),
        NOW
      )
    ).not.toBeNull();
  });
});

describe('reliability.post-shipment-rework — one event per shipment, not per session', () => {
  // buildGitOutcomes emits ONE ROW PER SESSION, and every session on a branch
  // attributes to the SAME PR. So three sessions that worked on one reverted PR
  // produce three identical rework rows for a single real event. Counting rows
  // would report "3 merged change(s)... 3 reverted" for one revert.
  const threeSessions = [
    row('s1', REVERT),
    row('s2', REVERT),
    row('s3', REVERT),
  ];
  const rec = detector.rule(input({ gitOutcomes: threeSessions }), NOW)!;

  it('counts the shipment once, however many sessions produced it', () => {
    expect(rec.affected).toBe(1);
    expect(rec.detail).toContain('1 merged change(s)');
    expect(rec.detail).toContain('1 reverted');
    expect(rec.detail).not.toContain('3 merged change(s)');
  });

  it('still reports how many sessions were involved', () => {
    expect(rec.detail).toContain('3 session(s)');
  });

  it('cites the event once rather than once per session', () => {
    expect(rec.evidence!.filter((e) => e.includes('PR #200'))).toHaveLength(1);
  });

  it('counts distinct shipments when the PRs really are different', () => {
    // REVERT ships PR #200, FIX_UP ships PR #300 — two events, not one.
    const two = detector.rule(
      input({ gitOutcomes: [row('s1', REVERT), row('s2', FIX_UP)] }),
      NOW
    )!;
    expect(two.affected).toBe(2);
  });

  it('counts same-numbered PRs from different repos as distinct shipments (#3655)', () => {
    // PR numbers are repo-scoped: a/b#200 and c/d#200 are two shipments, and
    // keying events by the bare number collapsed them into "1 merged change(s)
    // across 2 session(s)".
    const inRepo = (r: GitOutcome, repo: string): GitOutcome => ({
      ...r,
      provenance: { ...r.provenance, repo },
    });
    const twoRepos = detector.rule(
      input({
        gitOutcomes: [
          inRepo(row('sA', REVERT), 'a/b'),
          inRepo(row('sB', REVERT), 'c/d'),
        ],
      }),
      NOW
    )!;
    expect(twoRepos.affected).toBe(2);
    expect(twoRepos.detail).toContain('2 merged change(s)');
  });

  it('caps the cited session ids per evidence line (#3655)', () => {
    const five = ['s1', 's2', 's3', 's4', 's5'].map((id) => row(id, REVERT));
    const capped = detector.rule(input({ gitOutcomes: five }), NOW)!;
    const line = capped.evidence!.find((e) => e.includes('PR #200'))!;
    expect(line).toContain('sessions s1, s2, s3 +2 more');
    expect(line).not.toContain('s4');
  });

  it('states that the shipment count is a lower bound, not a census (#3655)', () => {
    const rec = detector.rule(input({ gitOutcomes: [row('a', REVERT)] }), NOW)!;
    expect(rec.detail).toContain('lower bound on detected rework');
  });
});

describe('reliability.post-shipment-rework — fires and cites', () => {
  const rec = detector.rule(
    input({ gitOutcomes: [row('a', REVERT), row('b', FIX_UP)] }),
    NOW
  )!;

  it('fires on fully-evidenced rework', () => {
    expect(rec).not.toBeNull();
    expect(rec.id).toBe('reliability.post-shipment-rework');
    expect(rec.severity).toBe('warning'); // a revert is present
    expect(rec.affected).toBe(2);
  });

  it('cites the shipped event, the later mutation, the artifact and both timestamps', () => {
    const line = rec.evidence!.find((e) => e.includes('PR #200'))!;
    expect(line).toContain('PR #200 (merge deadbeef)'); // shipped event
    expect(line).toContain('2026-06-10T00:00:00Z'); // shipped timestamp
    expect(line).toContain('PR #201'); // later mutation
    expect(line).toContain('2026-06-14T00:00:00Z'); // mutation timestamp
    expect(line).toContain('src/thing.ts'); // affected artifact
  });

  it('drops to info when only follow-up fixes, never reverts, are grounded', () => {
    const fixOnly = detector.rule(input({ gitOutcomes: [row('b', FIX_UP)] }), NOW)!;
    expect(fixOnly.severity).toBe('info');
    expect(fixOnly.detail).toContain('0 reverted');
  });

  it('carries a valid provenance with the counts it states', () => {
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    const counts = rec.provenance!.observations.find((o) =>
      o.claim.includes('reverted')
    )!;
    expect(counts.value).toBe('revert=1,fix-up=1');
    expect(rec.provenance!.inference).toContain('did not hold');
  });

  it('derives asOf from the newest observed mutation, not from the clock', () => {
    // The fixture's newest mutation is 2026-06-14; `now` is six days later, so
    // a clock-derived date would read 2026-06-20 and fail here.
    expect(rec.provenance!.asOf).toBe('2026-06-14');
    const later = detector.rule(
      input({ gitOutcomes: [row('a', REVERT)] }),
      Date.parse('2027-01-01T00:00:00.000Z')
    )!;
    expect(later.provenance!.asOf).toBe('2026-06-14');
  });

  it('ships a copy-paste-safe CLAUDE.md fix that suppresses itself', () => {
    expect(rec.fix!.fixKind).toBe('validated');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    expect(rec.fix!.appliedMarkers).toBe(detector.appliedMarkers);
  });

  it('declares an accounting claim, not a causal one', () => {
    expect(rec.claimClass).toBe('accounting');
    expect(rec.proofTier).toBe('accounting');
  });
});

describe('reliability.post-shipment-rework — stale snapshots are demoted', () => {
  // A snapshot cannot have observed a mutation that had not happened yet, so a
  // realizable stale fixture needs mutationAt <= asOf <= now - 30d. This one
  // reverts in April and was fetched the next day; `now` is 2026-06-20, ~70
  // days later, so the row is a genuinely stale view of a real event.
  const OLD_REVERT: GitPostShipmentRework = {
    kind: 'revert',
    shippedRef: 'PR #100 (merge cafed00d)',
    shippedAt: '2026-04-01T00:00:00Z',
    mutationRef: 'PR #101',
    mutationAt: '2026-04-10T00:00:00Z',
    artifacts: ['src/old.ts'],
    daysAfterShipment: 9,
  };
  const stale = detector.rule(
    input({ gitOutcomes: [row('a', OLD_REVERT, '2026-04-11')] }),
    NOW
  )!;

  it('demotes wording and severity when every row is a stale snapshot', () => {
    expect(stale.detail.startsWith('As of 2026-04-10,')).toBe(true);
    expect(stale.severity).toBe('info');
    expect(stale.provenance!.stale).toBe(true);
  });

  it('stays present-tense while any contributing row is still fresh', () => {
    const mixed = detector.rule(
      input({
        gitOutcomes: [row('a', OLD_REVERT, '2026-04-11'), row('b', FIX_UP)],
      }),
      NOW
    )!;
    expect(mixed.detail.startsWith('As of')).toBe(false);
    expect(mixed.provenance!.stale).toBeUndefined();
  });
});
