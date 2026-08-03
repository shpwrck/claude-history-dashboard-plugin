/**
 * Tests for workflow.assistant-refusal-rate (#206), added with its provenance
 * migration (#3232).
 *
 * The detector had no test file at all before this: the rate, both gates, and
 * the claim that the emitted numbers are reproducible from the cited fields
 * were entirely unexercised.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './assistant-refusal-rate';
import { validateRecommendationProvenance } from '../provenance';
import { MIN_ASSISTANT_TURNS, HIGH_REFUSAL_RATE } from '../shared';
import type { RecommendationInput } from '../types';
import type { AssistantFeatures } from '../../../types';

const feature = (
  over: Partial<AssistantFeatures> & { sessionId: string }
): AssistantFeatures => ({
  assistantTurnCount: 0,
  textLength: 0,
  codeBlockCount: 0,
  toolCallCount: 0,
  refusalCount: 0,
  hedgingCount: 0,
  endsWithQuestionCount: 0,
  thinkingByteLen: 0,
  ...over,
});

const input = (assistantFeatures?: AssistantFeatures[]): RecommendationInput =>
  ({
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    assistantFeatures,
  }) as unknown as RecommendationInput;

/** 200 turns, 40 of them refusals across two sessions -> 20%, over the 15% gate. */
const firing = (): AssistantFeatures[] => [
  feature({ sessionId: 's1', assistantTurnCount: 120, refusalCount: 30 }),
  feature({ sessionId: 's2', assistantTurnCount: 80, refusalCount: 10 }),
];

describe('workflow.assistant-refusal-rate (#206)', () => {
  it('stays silent with no assistant features at all', () => {
    expect(detector.rule(input(undefined), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the examined-turn floor even at a high rate', () => {
    // 100% refusals, but only 10 turns — far too few to trust a behaviour rate.
    expect(
      detector.rule(
        input([feature({ sessionId: 's', assistantTurnCount: 10, refusalCount: 10 })]),
        0
      )
    ).toBeNull();
  });

  it('stays silent below the rate gate even with plenty of turns', () => {
    const belowGate = Math.floor(MIN_ASSISTANT_TURNS * 4 * HIGH_REFUSAL_RATE) - 1;
    expect(
      detector.rule(
        input([
          feature({
            sessionId: 's',
            assistantTurnCount: MIN_ASSISTANT_TURNS * 4,
            refusalCount: belowGate,
          }),
        ]),
        0
      )
    ).toBeNull();
  });

  it('fires and sums turns across sessions', () => {
    const rec = detector.rule(input(firing()), 0);
    expect(rec?.id).toBe('workflow.assistant-refusal-rate');
    expect(rec?.affected).toBe(40);
    expect(rec?.detail).toContain('20%');
    expect(rec?.detail).toContain('40 of 200');
  });

  it('scopes the undated signal to retained history without claiming current behavior', () => {
    const rec = detector.rule(input(firing()), 0)!;
    expect(rec.title).toBe('High refusal/concession rate in retained history');
    expect(rec.detail).toBe(
      'Across the retained assistant history, 20% of assistant turns (40 of 200) contained a refusal or concession marker ("I cannot", "I apologize", "you\'re right"). This is an undated historical rate, not evidence of current assistant behavior.'
    );
    expect(rec.action).toBe(
      'Review the retained sessions behind this rate before changing current instructions. If the same pattern still appears, clarify recurring constraints, file locations, and conventions in CLAUDE.md.'
    );
  });

  // ── Provenance (#3232) ────────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input(firing()), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
      expect(rec!.provenance!.observations.length).toBeGreaterThan(0);
    });

    it('reproduces the displayed rate from its cited numerator and denominator', () => {
      const rec = detector.rule(input(firing()), 0);
      const obs = rec!.provenance!.observations;
      const refusals = obs.find((o) => o.field === 'refusalCount');
      const turns = obs.find((o) => o.field === 'assistantTurnCount');
      const rate = obs.find((o) => o.field === 'refusalCount / assistantTurnCount');
      // The claim must not present a rounded percentage as an exact equality.
      expect(rate!.claim).toMatch(/rounds to/);
      expect(rate!.claim).not.toMatch(/= \d+%/);
      expect(refusals!.value).toBe(40);
      expect(turns!.value).toBe(200);
      // The displayed percentage IS the cited operands, not a separate number.
      expect(rate!.value).toBe(Math.round((40 / 200) * 100));
      expect(rec!.detail).toContain(`${rate!.value}%`);
    });

    it('moves the cited operands when the corpus moves', () => {
      const rec = detector.rule(
        input([
          ...firing(),
          feature({ sessionId: 's3', assistantTurnCount: 100, refusalCount: 50 }),
        ]),
        0
      );
      const obs = rec!.provenance!.observations;
      expect(obs.find((o) => o.field === 'refusalCount')!.value).toBe(90);
      expect(obs.find((o) => o.field === 'assistantTurnCount')!.value).toBe(300);
      expect(obs.find((o) => o.field === 'refusalCount / assistantTurnCount')!.value).toBe(30);
    });

    it('says the percentage is ROUNDED when the division is not exact', () => {
      // 10/51 is 19.6%, displayed as 20%. Writing "10 / 51 = 20%" would be a
      // false equality a reader could disprove (Codex review, PR #3472).
      const rec = detector.rule(
        input([feature({ sessionId: 's', assistantTurnCount: 51, refusalCount: 10 })]),
        0
      );
      const rate = rec!.provenance!.observations.find(
        (o) => o.field === 'refusalCount / assistantTurnCount'
      );
      expect(rate!.value).toBe(20);
      expect((10 / 51) * 100).not.toBeCloseTo(20, 1); // genuinely not 20%
      expect(rate!.claim).toContain('rounds to 20%');
      expect(rate!.claim).not.toContain('= 20%');
    });

    it('emits no asOf, because AssistantFeatures carries no timestamp', () => {
      // The honest outcome, not an oversight: the only fields available are a
      // session id and numeric counts, so any date here would be borrowed from
      // an artifact this detector never read. `provenance.asOf` is optional
      // precisely so an undatable claim can say so by omission.
      const rec = detector.rule(input(firing()), Date.parse('2026-06-20T00:00:00.000Z'));
      expect(rec!.provenance!.asOf).toBeUndefined();
      expect(rec!.provenance!.stale).toBeUndefined();
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('keeps the causal reading in the inference, not in an observation', () => {
      const rec = detector.rule(input(firing()), 0);
      const p = rec!.provenance!;
      expect(p.inference).toMatch(/not measured/i);
      // No observation may assert that context caused the refusals.
      for (const o of p.observations) {
        expect(o.claim).not.toMatch(/underspecified|caused|because/i);
      }
    });
  });
});
