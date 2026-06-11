import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parsePlanMarkdown,
  parsePlansDir,
  clusterPlans,
  type PlanSignature,
} from './parse-plans';

// ── Inline markdown fixtures ─────────────────────────────────────────────────

const PLAN_WITH_VERIFICATION = `
# Fix rate-limit backoff

## Problem

The current retry loop ignores 429 headers.

## Changes

1. src/lib/retry.ts
2. src/lib/fetch.ts

## Implementation

Update the exponential-backoff helper to read Retry-After.

## Verification

Run the unit test suite and check that the 429 fixture passes.
`.trim();

const PLAN_WITH_TEST_SECTION = `
# Refactor parse-sessions

## Motivation

The function is 400 lines; split it.

## Approach

1. src/lib/parse-sessions.ts
2. src/lib/parse-sessions-v2.ts
3. src/lib/parse-sessions-v3.ts

## Test

npx vitest run src/lib/parse-sessions.test.ts
`.trim();

const PLAN_WITHOUT_VERIFICATION = `
# Campaign plan

## Goal

Migrate five services to the new logger.

## Steps

1. services/auth.ts
2. services/billing.ts
3. services/catalog.ts
4. services/notify.ts
5. services/webhook.ts
6. services/worker.ts
7. services/scheduler.ts

## Notes

This is a big campaign. Expect two weeks of work.
`.trim();

const PLAN_LEAN = `
# Quick rename

## Change

1. src/utils/format.ts

Rename helper to formatDate.
`.trim();

// ── parsePlanMarkdown ────────────────────────────────────────────────────────

describe('parsePlanMarkdown', () => {
  it('counts H2 sections correctly', () => {
    const sig = parsePlanMarkdown(PLAN_WITH_VERIFICATION, 'fix-rate-limit');
    // Problem, Changes, Implementation, Verification = 4
    expect(sig.sections).toBe(4);
  });

  it('counts numbered list items as fileRefs', () => {
    const sig = parsePlanMarkdown(PLAN_WITH_VERIFICATION, 'fix-rate-limit');
    // Two numbered items: "1. src/..." "2. src/..."
    expect(sig.fileRefs).toBe(2);
  });

  it('counts words', () => {
    const sig = parsePlanMarkdown(PLAN_LEAN, 'lean');
    expect(sig.words).toBeGreaterThan(0);
    expect(sig.words).toBeLessThan(30);
  });

  it('detects ## Verification section (case-insensitive)', () => {
    const sig = parsePlanMarkdown(PLAN_WITH_VERIFICATION, 'x');
    expect(sig.hasVerification).toBe(true);
  });

  it('detects ## Test section', () => {
    const sig = parsePlanMarkdown(PLAN_WITH_TEST_SECTION, 'x');
    expect(sig.hasVerification).toBe(true);
  });

  it('returns false when no Verification/Test section present', () => {
    const sig = parsePlanMarkdown(PLAN_WITHOUT_VERIFICATION, 'campaign');
    expect(sig.hasVerification).toBe(false);
  });

  it('returns name and id equal to the provided name', () => {
    const sig = parsePlanMarkdown(PLAN_LEAN, 'quick-rename');
    expect(sig.name).toBe('quick-rename');
    expect(sig.id).toBe('quick-rename');
  });

  it('handles an empty string without throwing', () => {
    const sig = parsePlanMarkdown('', 'empty');
    expect(sig.sections).toBe(0);
    expect(sig.fileRefs).toBe(0);
    expect(sig.words).toBe(0);
    expect(sig.hasVerification).toBe(false);
  });

  it('does NOT count H1 (#) lines as sections', () => {
    const sig = parsePlanMarkdown('# Title\n## Section\n', 'x');
    expect(sig.sections).toBe(1);
  });
});

describe('parsePlansDir', () => {
  it('skips plan files above the configured byte cap', () => {
    const dir = join(tmpdir(), `parse-plans-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'small.md'), '# Small\n\n## Verification\n\nDone.\n');
      writeFileSync(join(dir, 'large.md'), `# Large\n\n${'word '.repeat(512)}`);

      const plans = parsePlansDir(dir, { maxFileBytes: 128 });

      expect(plans.map((plan) => plan.id)).toEqual(['small']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── clusterPlans ─────────────────────────────────────────────────────────────

// Prototype mock data, shaped from a real structural extraction of 12 plans.
const MOCK_PLANS: PlanSignature[] = [
  { name: 'istio-scale-campaign',         id: 'istio-scale-campaign',         sections: 8, fileRefs: 3,  words: 1405, hasVerification: true  },
  { name: 'fanout-harness-fix',           id: 'fanout-harness-fix',           sections: 9, fileRefs: 0,  words: 1038, hasVerification: true  },
  { name: 'modular-recs-engine',          id: 'modular-recs-engine',          sections: 7, fileRefs: 6,  words: 1052, hasVerification: true  },
  { name: 'bound-scrape-skew',            id: 'bound-scrape-skew',            sections: 5, fileRefs: 5,  words: 537,  hasVerification: true  },
  { name: 'churn-convergence-split',      id: 'churn-convergence-split',      sections: 4, fileRefs: 0,  words: 534,  hasVerification: false },
  { name: 'probe-fault-tolerance',        id: 'probe-fault-tolerance',        sections: 9, fileRefs: 2,  words: 629,  hasVerification: false },
  { name: 'graded-coverage',              id: 'graded-coverage',              sections: 6, fileRefs: 4,  words: 608,  hasVerification: false },
  { name: 'runtime-opt',                  id: 'runtime-opt',                  sections: 4, fileRefs: 0,  words: 499,  hasVerification: false },
  { name: 'scale-coverage',               id: 'scale-coverage',               sections: 6, fileRefs: 8,  words: 641,  hasVerification: false },
  { name: 'p3-prewarm-backer',            id: 'p3-prewarm-backer',            sections: 4, fileRefs: 7,  words: 526,  hasVerification: true  },
  { name: 'usage-deploy-sprints',         id: 'usage-deploy-sprints',         sections: 5, fileRefs: 3,  words: 849,  hasVerification: false },
  { name: 'digest-nav-shell',             id: 'digest-nav-shell',             sections: 7, fileRefs: 5,  words: 1654, hasVerification: true  },
];

describe('clusterPlans', () => {
  it('returns one assignment per plan', () => {
    const result = clusterPlans(MOCK_PLANS);
    expect(result.assignments).toHaveLength(MOCK_PLANS.length);
  });

  it('returns exactly 3 stats entries (A, B, C)', () => {
    const result = clusterPlans(MOCK_PLANS);
    const shapes = result.stats.map((s) => s.shape).sort();
    expect(shapes).toEqual(['A', 'B', 'C']);
  });

  it('cluster totals match the plan count', () => {
    const result = clusterPlans(MOCK_PLANS);
    const total = result.stats.reduce((n, s) => n + s.count, 0);
    expect(total).toBe(MOCK_PLANS.length);
  });

  it('cluster C (sprawling) has the highest average words', () => {
    const result = clusterPlans(MOCK_PLANS);
    const C = result.stats.find((s) => s.shape === 'C')!;
    const A = result.stats.find((s) => s.shape === 'A')!;
    const B = result.stats.find((s) => s.shape === 'B')!;
    expect(C.avgWords).toBeGreaterThanOrEqual(A.avgWords);
    expect(C.avgWords).toBeGreaterThanOrEqual(B.avgWords);
  });

  it('cluster B (verified multi-file) has higher verifyPct than cluster A (tight surgical)', () => {
    const result = clusterPlans(MOCK_PLANS);
    const B = result.stats.find((s) => s.shape === 'B')!;
    const A = result.stats.find((s) => s.shape === 'A')!;
    // Based on the prototype: B is the "verified multi-file build" cluster —
    // it has the highest Verification rate. A (tight surgical fixes) has the
    // lowest. Sprawling C is in between, which is the P5 insight: even the
    // big plans are only partially covered by Verification.
    expect(B.verifyPct).toBeGreaterThan(A.verifyPct);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const r1 = clusterPlans(MOCK_PLANS);
    const r2 = clusterPlans(MOCK_PLANS);
    expect(r1.assignments.map((a) => a.shape)).toEqual(r2.assignments.map((a) => a.shape));
    expect(r1.stats.map((s) => s.count)).toEqual(r2.stats.map((s) => s.count));
  });

  it('returns empty clusters when input has fewer plans than k', () => {
    const result = clusterPlans(MOCK_PLANS.slice(0, 2));
    // Should not throw; all plans assigned (to A by fallback)
    expect(result.assignments).toHaveLength(2);
  });

  it('each plan assignment shape is one of A, B, C', () => {
    const result = clusterPlans(MOCK_PLANS);
    for (const a of result.assignments) {
      expect(['A', 'B', 'C']).toContain(a.shape);
    }
  });
});
