/**
 * Tests for the boomerang/rework-rate audit (#605 / #742).
 *
 * The judge is injected, so these cover the deterministic high-rework selection
 * -> judge-interpret -> rate-computation path without the network, plus the
 * per-candidate failure isolation the no-500 route contract relies on (a skipped
 * candidate must drop OUT of the rate denominator).
 */
import { describe, it, expect } from 'vitest';
import {
  detectBoomerangCandidates,
  runBoomerangAudit,
  DEFAULT_DETECT_OPTIONS,
  type ReworkSession,
  type ChurnFile,
  type BoomerangCandidate,
} from './boomerang-rework';
import type { JudgeFn } from './judge';

// Three high-rework sessions (>= the default threshold of 10) plus one calm
// session below it. minSessions defaults to 3, so the four rows clear the gate.
const REWORK: ReworkSession[] = [
  { sessionId: 's1', project: 'demo', reworkScore: 42, churn: 20, burstRate: 1.1 },
  { sessionId: 's2', project: 'demo', reworkScore: 30, churn: 15, burstRate: 1.0 },
  { sessionId: 's3', project: 'demo', reworkScore: 18, churn: 9, burstRate: 1.0 },
  { sessionId: 'calm', project: 'demo', reworkScore: 4, churn: 3, burstRate: 0.3 },
];

const CHURN_FILES: ChurnFile[] = [
  { filePath: '/repo/src/a.ts', churn: 22, sessions: 4 },
  { filePath: '/repo/src/b.ts', churn: 17, sessions: 3 },
];

const accept: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'Just-changed code was reverted next turn.',
  confidence: 'high',
});

describe('detectBoomerangCandidates', () => {
  it('selects high-rework sessions and excludes the calm one', () => {
    const found = detectBoomerangCandidates(REWORK, CHURN_FILES);
    expect(found.map((c) => c.sessionId)).toEqual(['s1', 's2', 's3']);
    // Ranked by reworkScore desc.
    expect(found[0].sessionId).toBe('s1');
    // Each candidate carries the corroborating high-churn file count.
    expect(found[0].corroboratingChurnFiles).toBe(2);
  });

  it('honors the minReworkScore threshold', () => {
    const found = detectBoomerangCandidates(REWORK, CHURN_FILES, {
      ...DEFAULT_DETECT_OPTIONS,
      minReworkScore: 35,
    });
    expect(found.map((c) => c.sessionId)).toEqual(['s1']);
  });

  it('stays quiet when fewer than minSessions rework rows are present', () => {
    // Two rows below the default minSessions of 3 -> nothing flagged even though
    // both clear the score threshold.
    const sparse: ReworkSession[] = [
      { sessionId: 'h1', project: 'demo', reworkScore: 50, churn: 25, burstRate: 1 },
      { sessionId: 'h2', project: 'demo', reworkScore: 50, churn: 25, burstRate: 1 },
    ];
    expect(detectBoomerangCandidates(sparse, CHURN_FILES)).toEqual([]);
  });

  it('respects the topN cap', () => {
    const found = detectBoomerangCandidates(REWORK, CHURN_FILES, {
      ...DEFAULT_DETECT_OPTIONS,
      topN: 2,
    });
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.sessionId)).toEqual(['s1', 's2']);
  });
});

describe('runBoomerangAudit', () => {
  it('computes the rework rate over the judged candidates', async () => {
    // Judge confirms 2 of 3 -> rate 2/3 -> "67%".
    const twoOfThree: JudgeFn = async ({ user }) => {
      const genuine = user.includes('s1') || user.includes('s2');
      return {
        isFinding: genuine,
        rationale: genuine ? 'bounced back' : 'productive iteration',
        confidence: genuine ? 'medium' : 'low',
      };
    };
    const candidates = detectBoomerangCandidates(REWORK, CHURN_FILES);
    const findings = await runBoomerangAudit(candidates, twoOfThree);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe('boomerang-rework:rate');
    expect(f.domain).toBe('workflow');
    expect(f.summary).toContain('67%');
    expect(f.summary).toContain('2 of 3');
    // Only the confirmed events anchor the finding.
    expect(f.evidenceRefs).toEqual(['session:s1', 'session:s2']);
    expect(f.judgeRationale).toContain('s1');
  });

  it('reports a 0% rate when the judge rejects every candidate', async () => {
    const rejectAll: JudgeFn = async () => ({
      isFinding: false,
      rationale: 'Deliberate refinement.',
      confidence: 'low',
    });
    const candidates = detectBoomerangCandidates(REWORK, CHURN_FILES);
    const findings = await runBoomerangAudit(candidates, rejectAll);
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toContain('0%');
    expect(findings[0].summary).toContain('0 of 3');
    expect(findings[0].evidenceRefs).toEqual([]);
    expect(findings[0].confidence).toBe('low');
  });

  it('excludes a per-candidate judge failure from the denominator', async () => {
    // s1's judge call throws (skipped); s2 + s3 judged, both genuine -> rate 2/2
    // = 100%, NOT 2/3. The failed candidate must not inflate the denominator.
    const flaky: JudgeFn = async ({ user }) => {
      if (user.includes('s1')) throw new Error('transient');
      return { isFinding: true, rationale: 'reverted', confidence: 'medium' };
    };
    const candidates = detectBoomerangCandidates(REWORK, CHURN_FILES);
    const findings = await runBoomerangAudit(candidates, flaky);
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toContain('100%');
    expect(findings[0].summary).toContain('2 of 2');
    expect(findings[0].evidenceRefs).toEqual(['session:s2', 'session:s3']);
  });

  it('returns [] when every judge call fails (nothing judged)', async () => {
    const allFail: JudgeFn = async () => {
      throw new Error('down');
    };
    const candidates = detectBoomerangCandidates(REWORK, CHURN_FILES);
    expect(await runBoomerangAudit(candidates, allFail)).toEqual([]);
  });

  it('returns [] for empty input', async () => {
    const none: BoomerangCandidate[] = [];
    expect(await runBoomerangAudit(none, accept)).toEqual([]);
  });

  it('returns [] when the deterministic seed produces no candidates', async () => {
    // Calm dataset -> no candidates -> no judge calls -> no finding.
    const calm: ReworkSession[] = [
      { sessionId: 'c1', project: 'demo', reworkScore: 2, churn: 2, burstRate: 0.1 },
      { sessionId: 'c2', project: 'demo', reworkScore: 3, churn: 3, burstRate: 0.1 },
      { sessionId: 'c3', project: 'demo', reworkScore: 1, churn: 1, burstRate: 0.1 },
    ];
    const candidates = detectBoomerangCandidates(calm, CHURN_FILES);
    expect(candidates).toEqual([]);
    expect(await runBoomerangAudit(candidates, accept)).toEqual([]);
  });
});
