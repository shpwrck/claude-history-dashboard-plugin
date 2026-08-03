import { describe, it, expect } from 'vitest';
import { detector } from './bloated-claude-md';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';

function input(
  global: string,
  perProject?: Record<string, string>
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: {
      claudeMd: { global, ...(perProject ? { perProject } : {}) },
    } as unknown as RecommendationInput['liveConfig'],
  };
}

describe('context.bloated-claude-md (#412)', () => {
  it.each([
    ['newline-terminated', 'x\n'.repeat(200)],
    ['unterminated', Array(200).fill('x').join('\n')],
  ])('stays silent for exactly 200 %s lines', (_description, text) => {
    expect(detector.rule(input(text), 0)).toBeNull();
  });

  it('stays silent for empty input', () => {
    expect(detector.rule(input(''), 0)).toBeNull();
  });

  it.each([
    ['newline-terminated', 'x\n'.repeat(201)],
    ['unterminated', Array(201).fill('x').join('\n')],
  ])('reports exactly 201 affected %s lines', (_description, text) => {
    expect(detector.rule(input(text), 0)?.affected).toBe(201);
  });

  it('warns past 200 lines and escalates to critical past 400', () => {
    const warn = detector.rule(input('x\n'.repeat(250)), 0);
    expect(warn?.id).toBe('context.bloated-claude-md');
    expect(warn?.severity).toBe('warning');
    expect(warn?.fix?.target).toBe('CLAUDE.md');

    const crit = detector.rule(input('x\n'.repeat(450)), 0);
    expect(crit?.severity).toBe('critical');
  });

  // ── Provenance (#3180) ───────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input('x\n'.repeat(250)), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('reproduces the reported line count from the cited text', () => {
      const cited = (lines: number) =>
        detector.rule(input('x\n'.repeat(lines)), 0)!.provenance!.observations[0].value;
      expect(cited(250)).toBe(250);
      expect(cited(300)).toBe(300);
    });

    it('discloses that the count is a MERGE, with how many documents', () => {
      // Without this a reader checks ~/.claude/CLAUDE.md, finds it far shorter
      // than the headline, and concludes the finding is wrong.
      const rec = detector.rule(
        input('x\n'.repeat(180), { '/repo': 'y\n'.repeat(60), '/other': 'z\n'.repeat(30) }),
        0
      );
      const mergeObs = rec!.provenance!.observations.find((o) => o.claim.includes('concatenation'));
      expect(mergeObs, 'expected an observation disclosing the merge').toBeDefined();
      expect(mergeObs!.value).toBe(3); // global + two project files
      expect(mergeObs!.claim).toContain('not the size of any single file');
    });

    it('counts only the documents that actually merge', () => {
      const rec = detector.rule(input('x\n'.repeat(250), { '/repo': '' }), 0);
      const mergeObs = rec!.provenance!.observations.find((o) => o.claim.includes('concatenation'));
      expect(mergeObs!.value).toBe(1); // the empty project file is not merged
    });

    it('attributes the target and the adherence claim to documentation, not measurement', () => {
      const rec = detector.rule(input('x\n'.repeat(250)), 0);
      // `detail` asserts adherence degrades; nothing here measures adherence.
      expect(rec!.provenance!.inference).toMatch(/documented guidance/i);
      expect(rec!.provenance!.inference).toMatch(/no adherence rate/i);
    });
  });
});
