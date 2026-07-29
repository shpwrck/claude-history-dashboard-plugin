import { describe, it, expect } from 'vitest';
import { detector } from './plan-missing-verification';
import type { RecommendationInput } from '../types';
import type { PlanSignature } from '../../parse-plans';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';

// ── Helpers ──────────────────────────────────────────────────────────────────

function plan(overrides: Partial<PlanSignature> & { name: string }): PlanSignature {
  return {
    id: overrides.name,
    sections: 4,
    fileRefs: 0,
    words: 300,
    hasVerification: false,
    ...overrides,
  };
}

// Minimum RecommendationInput — the detector only reads `plans`
function input(plans: PlanSignature[]): RecommendationInput & { plans: PlanSignature[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    plans,
  } as unknown as RecommendationInput & { plans: PlanSignature[] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.plan-missing-verification (#565)', () => {
  it('returns null when no plans are provided', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('returns null when all plans have a Verification section', () => {
    const plans = [
      plan({ name: 'a', fileRefs: 8, hasVerification: true }),
      plan({ name: 'b', words: 1500, hasVerification: true }),
    ];
    expect(detector.rule(input(plans), 0)).toBeNull();
  });

  it('returns null when large plans DO have Verification', () => {
    const plans = [
      plan({ name: 'big-verified', fileRefs: 7, words: 1100, hasVerification: true }),
    ];
    expect(detector.rule(input(plans), 0)).toBeNull();
  });

  it('returns null when small plans lack Verification (under threshold)', () => {
    // 5 file refs, 900 words — below both thresholds
    const plans = [
      plan({ name: 'small-no-verify', fileRefs: 5, words: 900, hasVerification: false }),
    ];
    expect(detector.rule(input(plans), 0)).toBeNull();
  });

  it('fires when a plan has 6+ file refs and no Verification', () => {
    const plans = [
      plan({ name: 'many-files', fileRefs: 6, hasVerification: false }),
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.plan-missing-verification');
    expect(rec?.affected).toBe(1);
  });

  it('fires when a plan has 1000+ words and no Verification', () => {
    const plans = [
      plan({ name: 'big-words', words: 1000, hasVerification: false }),
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec).not.toBeNull();
    expect(rec?.affected).toBe(1);
  });

  it('fires when a plan exceeds both thresholds with no Verification', () => {
    const plans = [
      plan({ name: 'over-both', fileRefs: 10, words: 2000, hasVerification: false }),
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec).not.toBeNull();
    expect(rec?.evidence).toContain('over-both');
  });

  it('only flags plans that exceed the threshold without Verification', () => {
    const plans = [
      plan({ name: 'large-no-verify', fileRefs: 8, hasVerification: false }),
      plan({ name: 'small-no-verify', fileRefs: 2, words: 400, hasVerification: false }),
      plan({ name: 'large-verified', fileRefs: 7, hasVerification: true }),
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence).toContain('large-no-verify');
    expect(rec?.evidence).not.toContain('small-no-verify');
    expect(rec?.evidence).not.toContain('large-verified');
  });

  it('emits warning severity when 3+ plans are flagged', () => {
    const plans = [
      plan({ name: 'p1', fileRefs: 6, hasVerification: false }),
      plan({ name: 'p2', fileRefs: 7, hasVerification: false }),
      plan({ name: 'p3', words: 1200, hasVerification: false }),
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec?.severity).toBe('warning');
  });

  it('emits info severity when fewer than 3 plans are flagged', () => {
    const plans = [
      plan({ name: 'p1', fileRefs: 6, hasVerification: false }),
      plan({ name: 'p2', fileRefs: 2, hasVerification: false }),  // under threshold
    ];
    const rec = detector.rule(input(plans), 0);
    expect(rec?.severity).toBe('info');
  });

  it('caps evidence list at 5 entries', () => {
    const plans = Array.from({ length: 10 }, (_, i) =>
      plan({ name: `plan-${i}`, fileRefs: 8, hasVerification: false })
    );
    const rec = detector.rule(input(plans), 0);
    expect(rec?.evidence?.length).toBeLessThanOrEqual(5);
  });

  it('includes a CLAUDE.md fix snippet', () => {
    const plans = [plan({ name: 'x', fileRefs: 8, hasVerification: false })];
    const rec = detector.rule(input(plans), 0);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(rec?.fix?.snippet).toContain('## Plan Verification discipline');
  });

  it('has correct id and category', () => {
    expect(detector.id).toBe('workflow.plan-missing-verification');
    expect(detector.category).toBe('workflow');
  });

  it('cites every flagged plan and the aggregate calculation without inventing freshness', () => {
    const plans = [
      plan({ name: 'many-files', id: 'many-files.md', fileRefs: 8 }),
      plan({ name: 'many-words', id: 'many-words.md', words: 1400 }),
      plan({ name: 'small', id: 'small.md', fileRefs: 2, words: 400 }),
    ];
    const rec = detector.rule(input(plans), Date.parse('2026-06-10T00:00:00Z'))!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.asOf).toBeUndefined();
    expect(rec.provenance?.stale).toBeUndefined();
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'plans[].{id,fileRefs,words,hasVerification}',
          value: expect.stringContaining('many-files.md'),
        }),
        expect.objectContaining({
          field: 'plans[].{id,fileRefs,words,hasVerification}',
          value: expect.stringContaining('many-words.md'),
        }),
        expect.objectContaining({
          field: 'flagged.length / plans.length',
          value: '2/3/67',
        }),
        expect.objectContaining({
          field: 'FILE_REFS_THRESHOLD',
          value: 6,
        }),
        expect.objectContaining({
          field: 'WORDS_THRESHOLD',
          value: 1000,
        }),
      ])
    );
    expect(rec.detail).not.toMatch(/most likely/i);
    expect(rec.provenance?.inference).toMatch(/does not measure|not.*outcome/i);
  });

  it('declares and validates the copy-paste-safe CLAUDE.md fix', () => {
    const rec = detector.rule(
      input([plan({ name: 'x', fileRefs: 8 })]),
      0
    )!;
    expect(rec.fix?.fixKind).toBe('validated');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });
});
