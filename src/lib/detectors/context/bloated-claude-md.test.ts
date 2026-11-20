import { describe, it, expect } from 'vitest';
import { detector, MEMORY_WARNING_FLOOR_CHARS } from './bloated-claude-md';
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

/** `n` characters of text in 80-character lines (newline included). */
function textOf(n: number): string {
  const line = 'x'.repeat(79) + '\n';
  return line.repeat(Math.floor(n / 80)) + 'x'.repeat(n % 80);
}

describe('context.bloated-claude-md (#412, #3404)', () => {
  it('stays silent for empty input', () => {
    expect(detector.rule(input(''), 0)).toBeNull();
  });

  it('stays silent for a 250-line, 8,000-character file', () => {
    const text = ('y'.repeat(31) + '\n').repeat(250);
    expect(text.length).toBe(8_000);
    expect(detector.rule(input(text), 0)).toBeNull();
  });

  it('stays silent exactly at the 40,000-character floor', () => {
    expect(MEMORY_WARNING_FLOOR_CHARS).toBe(40_000);
    expect(detector.rule(input(textOf(40_000)), 0)).toBeNull();
  });

  it('warns above the floor and cites the measured text and the floor', () => {
    const rec = detector.rule(input(textOf(40_001)), 0);
    expect(rec?.id).toBe('context.bloated-claude-md');
    expect(rec?.severity).toBe('warning');
    expect(rec?.affected).toBe(1);
    expect(rec?.provenance?.observations[0].value).toBe(40_001);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(rec?.detail).toContain('40,001 characters');
    expect(rec?.detail).toContain('40,000-character floor');
    expect(rec?.detail).toMatch(/does not know the active model/);
  });

  it('never claims a 200-line limit', () => {
    const rec = detector.rule(input(textOf(50_000)), 0)!;
    const copy = JSON.stringify(rec);
    expect(copy).not.toMatch(/200-line/);
    expect(copy).not.toMatch(/WARN_LINES|CRITICAL_LINES/);
  });

  // ── Provenance (#3180) ───────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input(textOf(45_000)), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('reproduces the reported character count from the cited text', () => {
      const cited = (n: number) =>
        detector.rule(input(textOf(n)), 0)!.provenance!.observations[0].value;
      expect(cited(45_000)).toBe(45_000);
      expect(cited(60_123)).toBe(60_123);
    });

    it('cites the product-anchored floor as the threshold', () => {
      const rec = detector.rule(input(textOf(45_000)), 0)!;
      const floorObs = rec.provenance!.observations.find((o) => o.field === 'MEMORY_WARNING_FLOOR_CHARS');
      expect(floorObs?.value).toBe(40_000);
      expect(floorObs?.claim).toMatch(/getMaxMemoryCharacterCount/);
      expect(floorObs?.claim).toMatch(/context window is unknown/);
    });

    it('adds the global file to one project, never projects to each other', () => {
      // 6k global + ten 4k project files: no session loads more than 10k.
      const projects = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`/p${i}`, textOf(4_000)])
      );
      expect(detector.rule(input(textOf(6_000), projects), 0)).toBeNull();
    });

    it('reports the largest loaded set and discloses that it adds two files', () => {
      const rec = detector.rule(
        input(textOf(30_000), { '/repo': textOf(12_000), '/other': textOf(4_000) }),
        0
      )!;
      expect(rec.affected).toBe(2);
      expect(rec.detail).toContain('/repo');
      expect(rec.detail).not.toContain('/other');
      expect(rec.provenance!.observations[0].value).toBe(42_000);
      const docsObs = rec.provenance!.observations.find((o) => o.claim.includes('loaded together'));
      expect(docsObs!.value).toBe(2);
      expect(docsObs!.claim).toContain('not the size of any single file');
    });

    it('does not count separators between files', () => {
      // 39,998 + 1 characters is under the floor however the files are joined.
      expect(detector.rule(input(textOf(39_998), { '/repo': 'x' }), 0)).toBeNull();
    });

    it('measures a project file alone when there is no global file', () => {
      const rec = detector.rule(input('', { '/repo': textOf(41_000) }), 0)!;
      expect(rec.affected).toBe(1);
      expect(rec.provenance!.observations[0].value).toBe(41_000);
    });

    it('ignores an empty project file', () => {
      const rec = detector.rule(input(textOf(45_000), { '/repo': '' }), 0);
      expect(rec!.affected).toBe(1);
    });

    it('states that adherence and token cost are not measured', () => {
      const rec = detector.rule(input(textOf(45_000)), 0);
      expect(rec!.provenance!.inference).toMatch(/no adherence rate/i);
    });
  });
});
