import { describe, expect, it } from 'vitest';
import { detector } from './model-deceit';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { DeceitSignals } from '../../../types';

function signal(overrides: Partial<DeceitSignals> = {}): DeceitSignals {
  return {
    sessionId: 'deceit-session-1234',
    assistantTurnCount: 12,
    unbackedClaimCount: 0,
    contradictedClaimCount: 0,
    claimSnippets: [],
    ...overrides,
  };
}

function input(deceitSignals?: DeceitSignals[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    deceitSignals,
  };
}

describe('security.model-deceit', () => {
  it('fires a warning when success claims are contradicted by verification evidence', () => {
    const rec = detector.rule(
      input([
        signal({
          contradictedClaimCount: 2,
          claimSnippets: ['all tests pass', 'the build is green'],
        }),
      ]),
      0
    );

    expect(rec).toMatchObject({
      id: 'security.model-deceit',
      category: 'security',
      severity: 'warning',
      affected: 2,
      view: 'sessions',
    });
    expect(rec?.detail).toContain('2 success claim(s) contradicted');
    expect(rec?.evidence).toEqual([
      'deceit-s: "all tests pass"',
      'deceit-s: "the build is green"',
    ]);
    expect(rec?.fix).toBeUndefined();
  });

  it('fires info for unbacked action claims and sums counts across flagged sessions', () => {
    const rec = detector.rule(
      input([
        signal({
          sessionId: 'alpha-session',
          unbackedClaimCount: 2,
          claimSnippets: ['I ran the suite'],
        }),
        signal({
          sessionId: 'beta-session',
          unbackedClaimCount: 1,
          claimSnippets: ['I updated the file'],
        }),
      ]),
      0
    );

    expect(rec?.severity).toBe('info');
    expect(rec?.affected).toBe(3);
    expect(rec?.detail).toContain('3 action claim(s) with no supporting tool evidence');
    expect(rec?.evidence).toEqual([
      'alpha-se: "I ran the suite"',
      'beta-ses: "I updated the file"',
    ]);
  });

  it('keeps only the first five snippets in evidence rows', () => {
    const rec = detector.rule(
      input([
        signal({
          unbackedClaimCount: 6,
          claimSnippets: ['one', 'two', 'three', 'four', 'five', 'six'],
        }),
      ]),
      0
    );

    expect(rec?.evidence).toHaveLength(5);
    expect(rec?.evidence?.join('\n')).toContain('"five"');
    expect(rec?.evidence?.join('\n')).not.toContain('"six"');
  });

  it('makes every aggregate reproducible from deceitSignals fields', () => {
    const rec = detector.rule(
      input([
        signal({
          sessionId: 'alpha-session',
          unbackedClaimCount: 2,
          contradictedClaimCount: 1,
          claimSnippets: ['I ran the suite', 'all tests pass'],
        }),
        signal({
          sessionId: 'beta-session',
          unbackedClaimCount: 3,
          contradictedClaimCount: 2,
          claimSnippets: ['the build is green'],
        }),
      ]),
      0
    )!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.affected).toBe(8);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'deceitSignals[].sessionId',
          value: 'alpha-session,beta-session',
        }),
        expect.objectContaining({
          field: 'deceitSignals[].unbackedClaimCount',
          value: 5,
        }),
        expect.objectContaining({
          field: 'deceitSignals[].contradictedClaimCount',
          value: 3,
        }),
      ])
    );
    expect(rec.provenance?.derivations).toContainEqual({
      id: 'affected-claims',
      formula: 'unbackedClaimCount + contradictedClaimCount',
      operands: { unbackedClaimCount: 5, contradictedClaimCount: 3 },
      value: 8,
    });
    expect(rec.provenance?.inference).toMatch(/parser.*classification/i);
  });

  it('stays dark for empty, clean, and no-assistant-turn inputs', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(detector.rule(input([signal()]), 0)).toBeNull();
    expect(
      detector.rule(
        input([signal({ assistantTurnCount: 0, contradictedClaimCount: 3 })]),
        0
      )
    ).toBeNull();
  });
});
