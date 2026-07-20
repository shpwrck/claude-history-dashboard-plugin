import { describe, it, expect } from 'vitest';
import { detector, DOWN_MODEL_PROOF_FRESHNESS_DAYS } from './automation-share';
import { automationCostShare, MAX_CLASS_SESSION_REFS_PER_REASON } from '../shared';
import { effectiveFixKind, isBlanketModelPinSnippet } from '../fix-validity';
import { validateRecommendationProvenance } from '../provenance';
import { CHEAPEST_MODEL, entryCostAtModel } from '../../pricing';
import { classifyTaskClassDetailed } from '../../task-class';
import type { RecommendationInput } from '../types';
import type { SessionTokenData, TokenEntry } from '../../../types';

const entry = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp = 't'
): TokenEntry => ({
  timestamp,
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model,
});

const session = (
  sessionId: string,
  entrypoint: string | undefined,
  opener: string | undefined,
  entries: TokenEntry[]
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    opener,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

const input = (overrides?: Partial<RecommendationInput>): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  }) as RecommendationInput;

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('cost.automation-share task-class breakdown (#2139, epic #2138)', () => {
  // Three automation sessions, one per class, sized so the rec fires
  // (autoCost >= $1, share >= 15%; all sessions are sdk-* so share = 100%).
  const tokenData = [
    session('author', 'sdk-cli', 'coder: implement issue #2139', [
      entry('claude-opus-4-8', 5_000_000, 1_000_000),
    ]),
    session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
      entry('claude-opus-4-8', 3_000_000, 600_000),
    ]),
    session('rev', 'sdk-py', 'reviewer: review and merge the open PRs', [
      entry('claude-opus-4-8', 2_000_000, 400_000),
    ]),
  ];

  it('emits a three-class breakdown in stable order', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.id).toBe('cost.automation-share');
    expect(rec?.taskClassBreakdown).toBeDefined();
    expect(rec?.taskClassBreakdown?.map((c) => c.taskClass)).toEqual([
      'authoring',
      'mechanical',
      'review',
    ]);
    // Each session landed in its opener-derived class.
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    expect(by.authoring.sessions).toBe(1);
    expect(by.mechanical.sessions).toBe(1);
    expect(by.review.sessions).toBe(1);
  });

  it('per-class actual cost sums to the card autoCost total exactly (the partition invariant)', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const { autoCost } = automationCostShare(tokenData);
    const perClassAutoCost = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.autoCostUsd)
    );
    expect(perClassAutoCost).toBeCloseTo(autoCost, 10);
  });

  it('keeps every task-class swap figure ceiling-only and non-bookable', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const allClassCeilings = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.swapSavingsUsd)
    );

    expect(allClassCeilings).toBeGreaterThan(0);
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim).toBeUndefined();
    expect(rec?.detail).toContain('full swap figure is ceiling-only');
    expect(rec?.detail).toContain('no task class has completion/quality proof');
  });

  it.each([
    ['authoring', 'coder: implement issue #2548'],
    ['mechanical', 'route-loose classify + groom-pick dry-run'],
    ['review', 'reviewer: review and merge the open PRs'],
  ] as const)('keeps a %s-only swap ceiling entirely non-bookable', (taskClass, opener) => {
    const rec = detector.rule(
      input({
        tokenData: [
          session(`${taskClass}-only`, 'sdk-cli', opener, [
            entry('claude-opus-4-8', 5_000_000, 1_000_000),
          ]),
        ],
      }),
      0
    );
    const row = rec?.taskClassBreakdown?.find((c) => c.taskClass === taskClass);

    expect(row?.swapSavingsUsd).toBeGreaterThan(0);
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim).toBeUndefined();
    expect(rec?.detail).toContain('full swap figure is ceiling-only');
    expect(rec?.detail).toContain(taskClass);
    expect(rec?.detail).toContain('excluded from booked savings and reclaim');
  });

  it('per-class sessions sum to affected, so no session is dropped', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const perClassSessions = sum(
      (rec?.taskClassBreakdown ?? []).map((c) => c.sessions)
    );
    expect(perClassSessions).toBe(rec?.affected);
    expect(perClassSessions).toBe(3);
  });

  it('names the per-class split in the human-readable detail', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.detail).toContain('By task class');
    expect(rec?.detail).toMatch(/mechanical/);
    expect(rec?.detail).toMatch(/authoring/);
  });
});

describe('cost.automation-share per-class classification provenance (#2376)', () => {
  it('exposes the matched reason + representative session refs behind each class', () => {
    const tokenData = [
      session('author', 'sdk-cli', 'coder: implement issue #2139', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000),
      ]),
      session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
        entry('claude-opus-4-8', 3_000_000, 600_000),
      ]),
      session('rev', 'sdk-py', 'reviewer: review and merge the open PRs', [
        entry('claude-opus-4-8', 2_000_000, 400_000),
      ]),
    ];
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );

    // Every non-empty class carries at least one classifier-provenance row.
    for (const cls of ['authoring', 'mechanical', 'review'] as const) {
      expect(by[cls].classification).toBeDefined();
      expect(by[cls].classification!.length).toBeGreaterThan(0);
    }

    // Each top reason REPRODUCES `classifyTaskClassDetailed` on the driving
    // opener — the auditability property (open the ref, re-run, confirm).
    expect(by.authoring.classification![0].reason).toBe(
      classifyTaskClassDetailed({ opener: 'coder: implement issue #2139' }).reason
    );
    expect(by.authoring.classification![0].signal).toBe('opener');
    expect(by.mechanical.classification![0].reason).toBe(
      classifyTaskClassDetailed({
        opener: 'route-loose classify + groom-pick dry-run',
      }).reason
    );
    expect(by.review.classification![0].reason).toBe(
      classifyTaskClassDetailed({
        opener: 'reviewer: review and merge the open PRs',
      }).reason
    );

    // Representative refs point at the sessions actually assigned to the class.
    expect(by.authoring.classification![0].sessionRefs).toContain('author');
    expect(by.mechanical.classification![0].sessionRefs).toContain('mech');
    expect(by.review.classification![0].sessionRefs).toContain('rev');
  });

  it('per-class reason sessions sum to the class session count (nothing dropped)', () => {
    const tokenData = [
      session('a1', 'sdk-cli', 'coder: implement x', [
        entry('claude-opus-4-8', 2_000_000, 400_000),
      ]),
      session('a2', 'sdk-cli', 'burn-epic iteration', [
        entry('claude-opus-4-8', 2_000_000, 400_000),
      ]),
      // No opener -> conservative default -> authoring, still recorded.
      session('a3', 'sdk-cli', undefined, [
        entry('claude-opus-4-8', 2_000_000, 400_000),
      ]),
      session('m1', 'sdk-cli', 'pick the next issue', [
        entry('claude-opus-4-8', 1_000_000, 200_000),
      ]),
    ];
    const rec = detector.rule(input({ tokenData }), 0);
    for (const c of rec?.taskClassBreakdown ?? []) {
      const reasonSessions = sum((c.classification ?? []).map((r) => r.sessions));
      expect(reasonSessions).toBe(c.sessions);
    }
  });

  it('aggregates sessions sharing a reason and bounds the representative sample', () => {
    const authors = Array.from({ length: 5 }, (_, i) =>
      session(`author-${i}`, 'sdk-cli', 'coder: implement the feature', [
        entry('claude-opus-4-8', 2_000_000, 400_000),
      ])
    );
    const rec = detector.rule(input({ tokenData: authors }), 0);
    const authoring = rec?.taskClassBreakdown?.find(
      (c) => c.taskClass === 'authoring'
    );
    expect(authoring?.sessions).toBe(5);
    // All five share one reason, so there is a single aggregated row.
    expect(authoring?.classification?.length).toBe(1);
    const row = authoring!.classification![0];
    expect(row.sessions).toBe(5);
    // The ref list is a bounded, representative sample of real ids.
    expect(row.sessionRefs.length).toBeGreaterThan(0);
    expect(row.sessionRefs.length).toBeLessThanOrEqual(
      MAX_CLASS_SESSION_REFS_PER_REASON
    );
    for (const ref of row.sessionRefs) {
      expect(ref).toMatch(/^author-\d$/);
    }
  });

  it('records the conservative default signal for a no-opener automation session', () => {
    const tokenData = [
      session('nosignal', 'sdk-cli', undefined, [
        entry('claude-opus-4-8', 5_000_000, 1_000_000),
      ]),
    ];
    const rec = detector.rule(input({ tokenData }), 0);
    const authoring = rec?.taskClassBreakdown?.find(
      (c) => c.taskClass === 'authoring'
    );
    const row = authoring?.classification?.find((r) => r.signal === 'default');
    expect(row).toBeDefined();
    expect(row?.reason).toBe(classifyTaskClassDetailed({ opener: undefined }).reason);
    expect(row?.sessionRefs).toContain('nosignal');
  });

  it('orders classification rows by session weight, heaviest first, deterministically', () => {
    const tokenData = [
      session('c1', 'sdk-cli', 'coder go', [
        entry('claude-opus-4-8', 1_000_000, 200_000),
      ]),
      session('c2', 'sdk-cli', 'coder go', [
        entry('claude-opus-4-8', 1_000_000, 200_000),
      ]),
      session('i1', 'sdk-cli', 'implement the fix', [
        entry('claude-opus-4-8', 1_000_000, 200_000),
      ]),
    ];
    const rec = detector.rule(input({ tokenData }), 0);
    const authoring = rec?.taskClassBreakdown?.find(
      (c) => c.taskClass === 'authoring'
    );
    const rows = authoring?.classification ?? [];
    // Two distinct authoring reasons: coder role (x2) outranks implement (x1).
    expect(rows.length).toBe(2);
    expect(rows[0].sessions).toBeGreaterThanOrEqual(rows[1].sessions);
    expect(rows[0].reason).toBe(classifyTaskClassDetailed({ opener: 'coder go' }).reason);
    expect(rows[1].reason).toBe(
      classifyTaskClassDetailed({ opener: 'implement the fix' }).reason
    );
  });
});

describe('cost.automation-share per-class down-model confidence (#2141)', () => {
  // Two dated authoring turns and one mechanical turn, so sample size and asOf
  // are per-class distinguishable.
  const tokenData = [
    session('author', 'sdk-cli', 'coder: implement issue #2141', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-06-01T00:00:00.000Z'),
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-06-03T00:00:00.000Z'),
    ]),
    session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
      entry('claude-opus-4-8', 2_000_000, 400_000, '2026-06-02T00:00:00.000Z'),
    ]),
  ];

  it('attaches an estimate-tier attribution to every class, with no fabricated confidence', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const breakdown = rec?.taskClassBreakdown ?? [];
    expect(breakdown.length).toBe(3);
    for (const c of breakdown) {
      const attr = c.savingsAttribution;
      expect(attr).toBeDefined();
      // Pure token accounting: every class is honestly tier-0-estimate.
      expect(attr?.tier).toBe('tier-0-estimate');
      // No before/after or ablation exists per class, so nothing is fabricated.
      expect(attr?.confidence).toBeUndefined();
      expect(attr?.judgeAgreement).toBeUndefined();
      expect(attr?.realizedSavingsUsd).toBeUndefined();
      expect(attr?.interventionKey).toBe('cost.automation-share');
      expect(attr?.signatureId).toBe(`automation-model-pin.${c.taskClass}`);
      expect(attr?.predictedSavingsUsd).toBeCloseTo(c.swapSavingsUsd, 10);
    }
  });

  it('reports the per-class sample size (billable turns) as n', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // authoring saw two billable turns, mechanical one; review saw none.
    expect(by.authoring.savingsAttribution?.sampleSize).toBe(2);
    expect(by.mechanical.savingsAttribution?.sampleSize).toBe(1);
    expect(by.review.savingsAttribution?.sampleSize).toBe(0);
  });

  it('surfaces the freshest billable turn as an ISO asOf date, omitting it for empty classes', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // authoring's freshest turn is 2026-06-03; mechanical's is 2026-06-02.
    expect(by.authoring.savingsAttribution?.asOf).toBe('2026-06-03');
    expect(by.mechanical.savingsAttribution?.asOf).toBe('2026-06-02');
    // A class with no billable turn has no dated data, so asOf is absent.
    expect(by.review.savingsAttribution?.asOf).toBeUndefined();
  });
});

describe('cost.automation-share per-class measured tier-1 before/after (#2140)', () => {
  // Mechanical automation migrated Opus -> Haiku in-window (an early Opus turn,
  // then two Haiku turns) — a real per-class before/after. Authoring stayed on
  // Opus the whole window, so it has no in-window model change to measure. Review
  // has no sessions at all.
  const tokenData = [
    session('mech-before', 'sdk-cli', 'route-loose classify picker', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-05-02T00:00:00.000Z'),
    ]),
    session('mech-after', 'sdk-cli', 'route-loose classify picker', [
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-09T00:00:00.000Z'),
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-10T00:00:00.000Z'),
    ]),
    session('auth-1', 'sdk-cli', 'coder: implement issue #2140', [
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-03T00:00:00.000Z'),
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-11T00:00:00.000Z'),
    ]),
  ];

  it('upgrades a class that migrated model in-window to a measured tier-1 result', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    const mech = by.mechanical.savingsAttribution;
    // The Opus -> Haiku migration is a genuine before/after, so it is measured.
    expect(mech?.tier).toBe('tier-1-before-after');
    expect(mech?.realizedSavingsUsd).toBeGreaterThan(0);
    // confidence is only present because a real before/after produced it.
    expect(mech?.confidence).toBe('medium');
    expect(mech?.signatureId).toBe('automation-model-pin.mechanical');
    expect(mech?.window?.baseline).toBeDefined();
    expect(mech?.window?.comparison).toBeDefined();
    // sampleSize reflects the priced turns behind the measurement (1 + 2).
    expect(mech?.sampleSize).toBe(3);
    // asOf is the class's freshest billable turn.
    expect(mech?.asOf).toBe('2026-05-10');
  });

  it('keeps a class with no in-window model change at tier-0-estimate (no fabricated confidence)', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const by = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    );
    // Authoring ran on Opus throughout — a raw swap ceiling exists, but there is
    // no before/after migration, so it stays an honest estimate and is not booked.
    expect(by.authoring.swapSavingsUsd).toBeGreaterThan(0);
    const auth = by.authoring.savingsAttribution;
    expect(auth?.tier).toBe('tier-0-estimate');
    expect(auth?.realizedSavingsUsd).toBeUndefined();
    expect(auth?.confidence).toBeUndefined();
    expect(auth?.judgeAgreement).toBeUndefined();

    // A class with no automation at all is trivially estimate-only.
    const review = by.review.savingsAttribution;
    expect(review?.tier).toBe('tier-0-estimate');
    expect(review?.sampleSize).toBe(0);
    expect(review?.realizedSavingsUsd).toBeUndefined();
  });
});

describe('cost.automation-share stale down-model evidence decay (#2142)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Same shape as the #2140 fixture: mechanical migrated Opus -> Haiku in-window
  // (asOf = its freshest turn, 2026-05-10), producing a MEASURED tier-1
  // before/after. Authoring stayed on Opus (honest tier-0 estimate).
  const tokenData = [
    session('mech-before', 'sdk-cli', 'route-loose classify picker', [
      entry('claude-opus-4-8', 4_000_000, 800_000, '2026-05-02T00:00:00.000Z'),
    ]),
    session('mech-after', 'sdk-cli', 'route-loose classify picker', [
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-09T00:00:00.000Z'),
      entry(CHEAPEST_MODEL, 4_000_000, 800_000, '2026-05-10T00:00:00.000Z'),
    ]),
    session('auth-1', 'sdk-cli', 'coder: implement issue #2142', [
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-03T00:00:00.000Z'),
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-05-11T00:00:00.000Z'),
    ]),
  ];
  const asOfMs = Date.parse('2026-05-10T00:00:00.000Z');

  it('keeps fresh measured cost evidence at tier-1', () => {
    // now = 10 days after the measurement's asOf — inside the freshness window.
    const now = asOfMs + 10 * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const mech = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).mechanical.savingsAttribution;
    // A fresh before/after stays present-tense directional cost evidence.
    expect(mech?.tier).toBe('tier-1-before-after');
    expect(mech?.confidence).toBe('medium');
    expect(mech?.realizedSavingsUsd).toBeGreaterThan(0);
    expect(mech?.stale).toBeFalsy();
    expect(mech?.asOf).toBe('2026-05-10');
  });

  it('demotes an old measurement to a dated estimate, not current evidence', () => {
    // now = well past the 90-day freshness horizon, so a model generation has
    // shipped since the measurement was observed.
    const now = asOfMs + (DOWN_MODEL_PROOF_FRESHNESS_DAYS + 24) * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const mech = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).mechanical.savingsAttribution;

    // Decayed back to a dated estimate: the measured-confidence fields are gone,
    // so it is NOT counted as current confidence (auditable-claims contract).
    expect(mech?.tier).toBe('tier-0-estimate');
    expect(mech?.stale).toBe(true);
    expect(mech?.confidence).toBeUndefined();
    expect(mech?.realizedSavingsUsd).toBeUndefined();
    expect(mech?.judgeAgreement).toBeUndefined();
    expect(mech?.window).toBeUndefined();
    // ...but the dated, auditable metadata survives so the reader still sees
    // "as of <date>" and the sample it rested on.
    expect(mech?.asOf).toBe('2026-05-10');
    expect(mech?.sampleSize).toBe(3);
    // The predicted figure is preserved (the measured comparison window here is
    // already the cheapest model, so its premium-above-cheapest is 0).
    expect(typeof mech?.predictedSavingsUsd).toBe('number');
    // The identity is preserved so the class still resolves to its intervention.
    expect(mech?.interventionKey).toBe('cost.automation-share');
    expect(mech?.signatureId).toBe('automation-model-pin.mechanical');
  });

  it('leaves an honest tier-0 estimate untouched even when its data is old', () => {
    // Authoring is already a tier-0 estimate (no in-window migration); a stale
    // asOf must not spuriously flag it — there is no measured claim to demote.
    const now = asOfMs + (DOWN_MODEL_PROOF_FRESHNESS_DAYS + 24) * DAY_MS;
    const rec = detector.rule(input({ tokenData }), now);
    const auth = Object.fromEntries(
      (rec?.taskClassBreakdown ?? []).map((c) => [c.taskClass, c])
    ).authoring.savingsAttribution;
    expect(auth?.tier).toBe('tier-0-estimate');
    expect(auth?.stale).toBeFalsy();
  });
});

describe('cost.automation-share down-model safety caveat + fix safety (#2548)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Unattended sdk-* automation on the strong model, dated so `asOf` resolves.
  const tokenData = [
    session('author', 'sdk-cli', 'coder: implement issue #2548', [
      entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-06-03T00:00:00.000Z'),
    ]),
    session('mech', 'sdk-cli', 'route-loose classify + groom-pick dry-run', [
      entry('claude-opus-4-8', 3_000_000, 600_000, '2026-06-02T00:00:00.000Z'),
    ]),
  ];
  const asOfMs = Date.parse('2026-06-03T00:00:00.000Z');

  it('states the equal-completion assumption, iteration risk, and class-completability risk in the copy', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const detail = rec?.detail ?? '';
    // equal-completion assumption
    expect(detail).toContain('upper-bound estimate');
    expect(detail).toContain('same number of turns');
    // iteration risk + class-completability risk
    expect(detail).toMatch(/more iterations/);
    expect(detail).toMatch(/fail to complete/);
  });

  it('never describes authoring as proven safe to down-route', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    const text = `${rec?.detail ?? ''} ${rec?.action ?? ''}`;
    // authoring is called out as unproven / kept on the strong model.
    expect(text).toMatch(/authoring[^.]*unproven|code-authoring[^.]*strong model/i);
    // the swap figure is framed as a ceiling, not a guaranteed reduction.
    expect(rec?.action).toContain('ceiling, not a guaranteed reduction');
  });

  it('exposes the blanket Haiku pin as an illustrative example, never a validated copy-paste fix', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.fix).toBeDefined();
    // A top-level "model" pin is a blanket global down-route...
    expect(isBlanketModelPinSnippet(rec!.fix!.snippet)).toBe(true);
    // ...so it must be illustrative, never the copy-paste-safe default.
    expect(rec?.fix?.fixKind).toBe('illustrative');
    expect(effectiveFixKind(rec!.fix!)).not.toBe('validated');
    // T2 is directional cost evidence; only a quality-gated T3 can clear.
    expect(rec?.fix?.note).toContain(
      'A before/after (T2) is directional cost evidence only'
    );
    expect(rec?.fix?.note).toContain(
      'only a class-scoped replay (T3) with explicit completion and quality gates can clear a class'
    );
  });

  it('emits auditable provenance whose inference carries the caveat, passing the contract', () => {
    const rec = detector.rule(input({ tokenData }), 0);
    expect(rec?.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.claimClass).toBe('causal');
    expect(rec?.proofTier).toBe('auditable');
    expect(rec!.provenance!.observations).toEqual([
      {
        claim: '2 unattended sdk-* sessions were observed',
        source: 'parse-sessions',
        field: 'sessionData[].entrypoint',
        value: 2,
      },
      {
        claim:
          'unattended sdk-* sessions incurred $80.00 of billable spend, including token and server-tool fees',
        source: 'parse-sessions',
        field:
          'sessionData[entrypoint sdk-*].entries[].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens,webSearchRequests,webFetchRequests} + pricing[model] + SERVER_TOOL_PRICING',
        value: 80,
      },
      {
        claim:
          'all sessions incurred $80.00 of total billable spend, including token and server-tool fees',
        source: 'parse-sessions',
        field:
          'sessionData[].entries[].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens,webSearchRequests,webFetchRequests} + pricing[model] + SERVER_TOOL_PRICING',
        value: 80,
      },
      {
        claim:
          'same-token repricing at claude-haiku-4-5-20251001 rates yields a $64.00 ceiling across input, output, cacheWrite5m, cacheWrite1h, and cacheRead; server-tool fees are unchanged and excluded',
        source: 'parse-sessions',
        field:
          'sum(max(0, entryCostAtModel(entry, entry.model) - entryCostAtModel(entry, claude-haiku-4-5-20251001))) over sessionData[entrypoint sdk-*].entries[model resolves to priced non-synthetic].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens}; server-tool fees excluded',
        value: 64,
      },
    ]);
    const inference = rec!.provenance!.inference ?? '';
    expect(inference).toMatch(/upper bound/i);
    expect(inference).toMatch(/safe to down-route/i);
    expect(inference).toMatch(/detector's inference/i);
    expect(inference).toMatch(/actual prompts and data/i);
  });

  it('emits atomic, reproducible observations for a configured before/after', () => {
    const measuredTokenData = [
      session('before', 'sdk-cli', 'route-loose classify picker', [
        entry(
          'claude-opus-4-8',
          5_000_000,
          1_000_000,
          '2026-05-02T12:00:00.000Z'
        ),
      ]),
      session('after', 'sdk-cli', 'route-loose classify picker', [
        entry(CHEAPEST_MODEL, 5_000_000, 1_000_000, '2026-05-09T12:00:00.000Z'),
      ]),
    ];
    const rec = detector.rule(
      input({
        tokenData: measuredTokenData,
        liveConfig: {
          settings: { model: 'claude-haiku-4-5' },
        } as unknown as RecommendationInput['liveConfig'],
        modelPinSavings: {
          baseline: {
            start: '2026-05-01T00:00:00.000Z',
            end: '2026-05-08T00:00:00.000Z',
          },
          comparison: {
            start: '2026-05-08T00:00:00.000Z',
            end: '2026-05-15T00:00:00.000Z',
          },
          targetModel: CHEAPEST_MODEL,
        },
      }),
      Date.parse('2026-05-10T00:00:00.000Z')
    );

    expect(rec?.savingsAttribution).toMatchObject({
      tier: 'tier-1-before-after',
      realizedSavingsUsd: 40,
      asOf: '2026-05-09',
    });
    expect(rec?.proofTier).toBe('observational');
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim).toBeUndefined();
    expect(rec?.action).toContain(
      'observed before/after is directional cost evidence only'
    );
    expect(rec?.action).toContain(
      'before/after (T2) can track cost direction, but cannot quality-clear'
    );
    expect(rec?.provenance?.observations.slice(4)).toEqual([
      {
        claim:
          'the configured before/after target model was claude-haiku-4-5-20251001',
        source: 'parse-sessions/model-pin-savings',
        field: 'modelPinSavings.targetModel + pricing[targetModel]',
        value: 'claude-haiku-4-5-20251001',
      },
      {
        claim:
          'the baseline window was [2026-05-01T00:00:00.000Z, 2026-05-08T00:00:00.000Z)',
        source: 'parse-sessions/model-pin-savings',
        field:
          'modelPinSavings.baseline.{start,end} + sessionData[].entries[].timestamp',
        value: '2026-05-01T00:00:00.000Z..<2026-05-08T00:00:00.000Z',
      },
      {
        claim: 'the baseline window contained 1 priced unattended entry',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,model} filtered to modelPinSavings.baseline',
        value: 1,
      },
      {
        claim: 'baseline actual-model token spend was $50.00',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[actual model] within modelPinSavings.baseline',
        value: 50,
      },
      {
        claim:
          'baseline same-token spend at claude-haiku-4-5-20251001 rates was $10.00',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[targetModel] within modelPinSavings.baseline',
        value: 10,
      },
      {
        claim:
          'baseline token-only model premium was $40.00; server-tool fees were excluded',
        source: 'parse-sessions/model-pin-savings',
        field:
          'max(0, sum(entryCostAtModel(entry, actualModel)) - sum(entryCostAtModel(entry, targetModel))) within modelPinSavings.baseline',
        value: 40,
      },
      {
        claim:
          'the comparison window was [2026-05-08T00:00:00.000Z, 2026-05-15T00:00:00.000Z)',
        source: 'parse-sessions/model-pin-savings',
        field:
          'modelPinSavings.comparison.{start,end} + sessionData[].entries[].timestamp',
        value: '2026-05-08T00:00:00.000Z..<2026-05-15T00:00:00.000Z',
      },
      {
        claim: 'the comparison window contained 1 priced unattended entry',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,model} filtered to modelPinSavings.comparison',
        value: 1,
      },
      {
        claim: 'comparison actual-model token spend was $10.00',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[actual model] within modelPinSavings.comparison',
        value: 10,
      },
      {
        claim:
          'comparison same-token spend at claude-haiku-4-5-20251001 rates was $10.00',
        source: 'parse-sessions/model-pin-savings',
        field:
          'sessionData[entrypoint sdk-*].entries[].{timestamp,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens} + pricing[targetModel] within modelPinSavings.comparison',
        value: 10,
      },
      {
        claim:
          'comparison token-only model premium was $0.00; server-tool fees were excluded',
        source: 'parse-sessions/model-pin-savings',
        field:
          'max(0, sum(entryCostAtModel(entry, actualModel)) - sum(entryCostAtModel(entry, targetModel))) within modelPinSavings.comparison',
        value: 0,
      },
      {
        claim:
          'the latest priced unattended comparison entry was observed as of 2026-05-09',
        source: 'parse-sessions/model-pin-savings',
        field:
          'max(sessionData[entrypoint sdk-*].entries[].timestamp within modelPinSavings.comparison after model-pricing gates)',
        value: '2026-05-09',
      },
      {
        claim:
          'baseline minus comparison was a directional $40.00 model-token premium difference; server-tool fees were excluded',
        source: 'parse-sessions/model-pin-savings',
        field: 'max(0, baseline token premium - comparison token premium)',
        value: 40,
      },
    ]);
  });

  it('does not attribute an interactive model migration to unattended automation', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          session('interactive-before', 'cli', 'interactive work', [
            entry(
              'claude-opus-4-8',
              5_000_000,
              1_000_000,
              '2026-05-02T12:00:00.000Z'
            ),
          ]),
          session('interactive-after', 'cli', 'interactive work', [
            entry(
              CHEAPEST_MODEL,
              5_000_000,
              1_000_000,
              '2026-05-09T12:00:00.000Z'
            ),
          ]),
          session('automation-after', 'sdk-cli', 'route-loose classify picker', [
            entry(
              CHEAPEST_MODEL,
              1_000_000,
              200_000,
              '2026-05-10T12:00:00.000Z'
            ),
          ]),
        ],
        liveConfig: {
          settings: { model: 'claude-haiku-4-5' },
        } as unknown as RecommendationInput['liveConfig'],
        modelPinSavings: {
          baseline: {
            start: '2026-05-01T00:00:00.000Z',
            end: '2026-05-08T00:00:00.000Z',
          },
          comparison: {
            start: '2026-05-08T00:00:00.000Z',
            end: '2026-05-15T00:00:00.000Z',
          },
          targetModel: CHEAPEST_MODEL,
        },
      }),
      Date.parse('2026-05-11T00:00:00.000Z')
    );

    // The only actual migration is interactive. With automation already pinned
    // to Haiku, there is no unattended before/after evidence to surface.
    expect(rec).toBeNull();
  });

  it('uses a non-default target and excludes web-search fees from model premium', () => {
    const targetModel = 'claude-sonnet-5';
    const before = {
      ...entry(
        'claude-opus-4-8',
        5_000_001,
        1_000_001,
        '2026-05-02T12:00:00.000Z'
      ),
      webSearchRequests: 100,
    };
    const after = {
      ...entry(targetModel, 5_000_001, 1_000_001, '2026-05-09T12:00:00.000Z'),
      webSearchRequests: 100,
    };
    const rec = detector.rule(
      input({
        tokenData: [
          session('before', 'sdk-cli', 'route-loose classify picker', [before]),
          session('after', 'sdk-cli', 'route-loose classify picker', [after]),
        ],
        modelPinSavings: {
          baseline: {
            start: '2026-05-01T00:00:00.000Z',
            end: '2026-05-08T00:00:00.000Z',
          },
          comparison: {
            start: '2026-05-08T00:00:00.000Z',
            end: '2026-05-15T00:00:00.000Z',
          },
          targetModel,
        },
      }),
      Date.parse('2026-05-10T00:00:00.000Z')
    );

    const expectedPremium =
      entryCostAtModel(before, 'claude-opus-4-8') -
      entryCostAtModel(before, targetModel);
    const expectedBill =
      entryCostAtModel(before, 'claude-opus-4-8') +
      entryCostAtModel(after, targetModel) +
      2;
    expect(rec?.savingsAttribution).toMatchObject({
      tier: 'tier-1-before-after',
      asOf: '2026-05-09',
    });
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeCloseTo(
      expectedPremium,
      12
    );
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.reclaim).toBeUndefined();
    expect(rec?.provenance?.observations).toContainEqual({
      claim: 'the configured before/after target model was claude-sonnet-5',
      source: 'parse-sessions/model-pin-savings',
      field: 'modelPinSavings.targetModel + pricing[targetModel]',
      value: targetModel,
    });
    expect(rec?.provenance?.observations).toContainEqual({
      claim:
        'unattended sdk-* sessions incurred $82.00 of billable spend, including token and server-tool fees',
      source: 'parse-sessions',
      field:
        'sessionData[entrypoint sdk-*].entries[].{model,inputTokens,outputTokens,cacheCreationTokens,cacheCreation1hTokens,cacheReadTokens,webSearchRequests,webFetchRequests} + pricing[model] + SERVER_TOOL_PRICING',
      value: expectedBill,
    });
    expect(rec?.provenance?.observations).toContainEqual({
      claim:
        'baseline token-only model premium was $20.00; server-tool fees were excluded',
      source: 'parse-sessions/model-pin-savings',
      field:
        'max(0, sum(entryCostAtModel(entry, actualModel)) - sum(entryCostAtModel(entry, targetModel))) within modelPinSavings.baseline',
      value: expectedPremium,
    });
  });

  it('dates an old measured window even when unrelated automation is newer', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          session('old-before', 'sdk-cli', 'route-loose classify picker', [
            entry(
              'claude-opus-4-8',
              5_000_000,
              1_000_000,
              '2025-05-02T12:00:00.000Z'
            ),
          ]),
          session('old-after', 'sdk-cli', 'route-loose classify picker', [
            entry(
              CHEAPEST_MODEL,
              5_000_000,
              1_000_000,
              '2025-05-09T12:00:00.000Z'
            ),
          ]),
          session('new-unrelated', 'sdk-cli', 'coder: implement newer work', [
            entry(
              'claude-opus-4-8',
              1_000_000,
              200_000,
              '2026-07-10T12:00:00.000Z'
            ),
          ]),
        ],
        modelPinSavings: {
          baseline: {
            start: '2025-05-01T00:00:00.000Z',
            end: '2025-05-08T00:00:00.000Z',
          },
          comparison: {
            start: '2025-05-08T00:00:00.000Z',
            end: '2025-05-15T00:00:00.000Z',
          },
          targetModel: CHEAPEST_MODEL,
        },
      }),
      Date.parse('2026-07-15T00:00:00.000Z')
    );

    expect(rec?.provenance).toMatchObject({
      asOf: '2026-07-10',
      stale: false,
    });
    expect(rec?.savingsAttribution).toMatchObject({
      tier: 'tier-0-estimate',
      asOf: '2025-05-09',
      stale: true,
    });
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeUndefined();
    expect(rec?.proofTier).toBe('auditable');
    expect(rec?.title).toBe('Automation drives a large share of spend');
    expect(rec?.detail).toMatch(/^Automated/);
    expect(rec?.action).toContain(
      'before/after observation is historical as of 2025-05-09'
    );
  });

  it('carries the freshest automation turn as asOf and demotes present-tense wording when stale', () => {
    // Fresh: `now` just after the freshest turn — inside the freshness window.
    const fresh = detector.rule(input({ tokenData }), asOfMs + 5 * DAY_MS);
    expect(fresh?.provenance?.asOf).toBe('2026-06-03');
    expect(fresh?.provenance?.stale).toBe(false);
    expect(validateRecommendationProvenance(fresh!)).toEqual([]);

    // Stale: `now` past the down-model freshness horizon — a model generation has
    // shipped since, so the snapshot is demoted to "as of <date>".
    const stale = detector.rule(
      input({ tokenData }),
      asOfMs + (DOWN_MODEL_PROOF_FRESHNESS_DAYS + 2) * DAY_MS
    );
    expect(stale?.provenance?.asOf).toBe('2026-06-03');
    expect(stale?.provenance?.stale).toBe(true);
    expect(validateRecommendationProvenance(stale!)).toEqual([]);
    expect(stale?.title).toContain('as of 2026-06-03');
    expect(stale?.detail).toContain('As of 2026-06-03');
    expect(stale?.action).toContain('As of 2026-06-03');
  });

  it('does not let a later unpriced entry freshen the billable-share asOf', () => {
    const rec = detector.rule(
      input({
        tokenData: [
          ...tokenData,
          session('unpriced', 'sdk-cli', 'coder: unknown model run', [
            entry(
              'unknown-provider-model',
              5_000_000,
              1_000_000,
              '2026-06-20T00:00:00.000Z'
            ),
          ]),
        ],
      }),
      Date.parse('2026-06-25T00:00:00.000Z')
    );

    expect(rec?.provenance?.asOf).toBe('2026-06-03');
  });

  it('dates the billable-share from a later unpriced entry when its server-tool fees contribute', () => {
    const serverFeeEntry = {
      ...entry(
        'unknown-provider-model',
        0,
        0,
        '2026-06-20T00:00:00.000Z'
      ),
      webSearchRequests: 100,
    };
    const rec = detector.rule(
      input({
        tokenData: [
          ...tokenData,
          session('unpriced-with-fees', 'sdk-cli', 'coder: unknown model run', [
            serverFeeEntry,
          ]),
        ],
      }),
      Date.parse('2026-06-25T00:00:00.000Z')
    );

    expect(rec?.provenance?.asOf).toBe('2026-06-20');
  });

  it('suppresses the estimate-only finding once Haiku is already pinned (no measured win)', () => {
    const rec = detector.rule(
      input({
        tokenData,
        liveConfig: {
          settings: { model: 'claude-haiku-4-5' },
        } as unknown as RecommendationInput['liveConfig'],
      }),
      0
    );
    expect(rec).toBeNull();
  });
});
