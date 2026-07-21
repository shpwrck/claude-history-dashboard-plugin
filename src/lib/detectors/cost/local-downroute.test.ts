import { describe, it, expect } from 'vitest';
import { detector } from './local-downroute';
import type { RecommendationInput } from '../types';
import {
  validateRecProvenance,
  validateRecommendationProvenance,
} from '../provenance';
import {
  effectiveFixKind,
  isBlanketModelPinSnippet,
  validateFixSnippet,
} from '../fix-validity';
import type {
  LocalCalibrationClass,
  LocalCalibrationReport,
} from '../../parse-local-calibration';

const NOW = Date.parse('2026-07-01T00:00:00Z');
const FRESH = '2026-06-15'; // ~16 days before NOW → fresh
const STALE = '2026-01-01'; // ~181 days before NOW → past the 90-day horizon

function passClass(over: Partial<LocalCalibrationClass> = {}): LocalCalibrationClass {
  return {
    taskClass: 'mechanical',
    localModel: 'local/qwen2.5-coder',
    baselineModel: 'claude-opus-4-8',
    nRecords: 8,
    nSamples: 8,
    blindJudgeAgreement: 0.9,
    costLocal: 0.001,
    costClaude: 0.12,
    savingsUsdPerTask: 0.119,
    latency: { localMeanMs: 1200, claudeMeanMs: 3400 },
    parity: {
      held: true,
      source: 'judge-scores',
      baselineMeanScore: 8.1,
      candidateMeanScore: 8.0,
      delta: -0.1,
      rationale: null,
    },
    asOf: FRESH,
    verdict: 'pass',
    reasons: ['quality parity held (delta -0.1)'],
    ...over,
  };
}

function failClass(over: Partial<LocalCalibrationClass> = {}): LocalCalibrationClass {
  return passClass({
    taskClass: 'authoring',
    verdict: 'fail',
    parity: {
      held: false,
      source: 'judge-scores',
      baselineMeanScore: 8.5,
      candidateMeanScore: 5.0,
      delta: -3.5,
      rationale: null,
    },
    reasons: ['quality parity floor broken (delta -3.5)'],
    ...over,
  });
}

function insufficientClass(over: Partial<LocalCalibrationClass> = {}): LocalCalibrationClass {
  return passClass({
    taskClass: 'review',
    nSamples: 2,
    blindJudgeAgreement: null,
    verdict: 'insufficient',
    parity: { held: null, source: 'no-judge-scores', baselineMeanScore: null, candidateMeanScore: null, delta: null },
    reasons: ['only 2 fully-measured paired runs (need 5)'],
    ...over,
  });
}

function report(classes: LocalCalibrationClass[]): LocalCalibrationReport {
  return {
    version: 1,
    kind: 'tier-b-calibration',
    thresholds: { minSamples: 5, minAgreement: 0.8 },
    asOf: FRESH,
    classes,
  };
}

function input(
  localCalibration: LocalCalibrationReport | null,
  pinnedModel?: string
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig:
      pinnedModel !== undefined
        ? ({ settings: { model: pinnedModel } } as RecommendationInput['liveConfig'])
        : null,
    localCalibration,
  } as RecommendationInput;
}

describe('cost.local-downroute (#2318)', () => {
  it('emits nothing when there is no calibration report (suppression-when-no-data)', () => {
    expect(detector.rule(input(null), NOW)).toBeNull();
    expect(detector.emitAll!(input(null), NOW)).toEqual([]);
  });

  it('a fresh pass row renders a PROVEN down-route rec with cited evidence', () => {
    const rec = detector.rule(input(report([passClass()])), NOW);
    expect(rec?.id).toBe('cost.local-downroute');
    expect(rec?.category).toBe('cost');
    expect(rec?.claimClass).toBe('causal');
    // T2 observational — proven by blind-judge shadow/replay agreement, not estimate.
    expect(rec?.proofTier).toBe('observational');
    // Copy states the proven per-task cost saving vs Claude + the agreement.
    expect(rec?.detail).toMatch(/90% blind-judge agreement/);
    expect(rec?.detail).toMatch(/less than Claude/);
    expect(rec?.estSavingsUsd).toBeCloseTo(0.119, 6);
    // savingsAttribution declares tier, sample size, and judge agreement.
    const attr = rec?.savingsAttribution;
    expect(attr?.tier).toBe('tier-2-ablation');
    expect(attr?.sampleSize).toBe(8);
    expect(attr?.judgeAgreement).toBe(0.9);
    expect(attr?.stale).toBeUndefined();
    // provenance cites the artifact/fields and is well-formed.
    expect(rec?.provenance).toBeDefined();
    expect(validateRecProvenance(rec!.provenance!)).toEqual([]);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.provenance?.observations.some((o) => o.field === 'classes[].blindJudgeAgreement')).toBe(true);
    expect(rec?.provenance?.stale).toBe(false);
  });

  it('a pass fix is a non-validated (illustrative) example, never a validated blanket pin', () => {
    const rec = detector.rule(input(report([passClass()])), NOW)!;
    expect(rec.fix).toBeDefined();
    // A top-level "model" pin is blanket → correctly downgraded to illustrative.
    expect(effectiveFixKind(rec.fix!)).toBe('illustrative');
    expect(isBlanketModelPinSnippet(rec.fix!.snippet)).toBe(true);
    // The portability gate passes (illustrative fixes are labelled examples).
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('a fail row renders an HONEST-NULL — not suppressed, not a win', () => {
    const rec = detector.rule(input(report([failClass()])), NOW);
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('cost.local-downroute');
    expect(rec?.detail).toMatch(/tested 8 samples/i);
    expect(rec?.detail).toMatch(/did not hold quality for authoring/i);
    expect(rec?.detail).toMatch(/as of 2026-01-01|as of 2026-06-15/); // dated, never present-tense
    // No positive cost claim and no copy-paste fix — it is not a recommendation to act.
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.fix).toBeUndefined();
    expect(rec?.claimClass).toBe('causal');
    expect(validateRecProvenance(rec!.provenance!)).toEqual([]);
  });

  it('an insufficient row is suppressed (thin evidence is not a claim in either direction)', () => {
    expect(detector.rule(input(report([insufficientClass()])), NOW)).toBeNull();
    expect(detector.emitAll!(input(report([insufficientClass()])), NOW)).toEqual([]);
  });

  it('a fresh pass with no positive per-task saving is not a cost lever (suppressed)', () => {
    const rec = detector.rule(input(report([passClass({ savingsUsdPerTask: 0 })])), NOW);
    expect(rec).toBeNull();
  });

  // ── Corroboration: never trust the verdict string alone (SHOULD-FIX 2) ────────
  it('a pass with UNMEASURED agreement does not publish a proven claim', () => {
    const rec = detector.rule(
      input(report([passClass({ blindJudgeAgreement: null })])),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('a pass with agreement below the stated threshold is suppressed', () => {
    const rec = detector.rule(
      input(report([passClass({ blindJudgeAgreement: 0.5 })])),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('a pass whose parity gate did not actually hold is suppressed (inconsistent row)', () => {
    const rec = detector.rule(
      input(
        report([
          passClass({
            parity: {
              held: false,
              source: 'judge-scores',
              baselineMeanScore: 8,
              candidateMeanScore: 5,
              delta: -3,
              rationale: null,
            },
          }),
        ])
      ),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('a pass below the stated sample floor is suppressed', () => {
    const rec = detector.rule(input(report([passClass({ nSamples: 3 })])), NOW);
    expect(rec).toBeNull();
  });

  // ── asOf:null pass must not publish as fresh (SHOULD-FIX 3) ───────────────────
  it('a pass with no asOf is suppressed (an undatable proof is never a fresh win)', () => {
    const rec = detector.rule(input(report([passClass({ asOf: null })])), NOW);
    expect(rec).toBeNull();
  });

  // ── Self-suppression when already routed to the proven local model (NIT 6) ────
  it('suppresses the proven rec when the local model is already pinned in settings', () => {
    const rec = detector.rule(
      input(report([passClass()]), 'local/qwen2.5-coder'),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('a fail is still surfaced even if the failed model is pinned (not suppressed)', () => {
    const rec = detector.rule(
      input(report([failClass({ localModel: 'local/qwen2.5-coder' })]), 'local/qwen2.5-coder'),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec?.title).toMatch(/did not hold quality/i);
  });

  it('a fail whose parity did not actually break is suppressed (inconsistent row)', () => {
    const rec = detector.rule(
      input(
        report([
          failClass({
            parity: {
              held: true,
              source: 'judge-scores',
              baselineMeanScore: 8,
              candidateMeanScore: 8,
              delta: 0,
              rationale: null,
            },
          }),
        ])
      ),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('provenance observation values are derived from actual row fields, not hard-coded', () => {
    const rec = detector.rule(input(report([passClass()])), NOW)!;
    const parity = rec.provenance?.observations.find((o) => o.field === 'classes[].parity.held');
    expect(parity?.value).toBe('true'); // String(row.parity.held), not a literal 'held'
    const agreement = rec.provenance?.observations.find(
      (o) => o.field === 'classes[].blindJudgeAgreement'
    );
    expect(agreement?.value).toBe(0.9); // the actual measured number
  });

  it('escapes the local model id in the fix snippet so it stays valid JSON', () => {
    const rec = detector.rule(
      input(report([passClass({ localModel: 'local/"weird"\nmodel' })])),
      NOW
    )!;
    // A quote/newline in the model id must not break the JSON snippet.
    expect(() => JSON.parse(rec.fix!.snippet)).not.toThrow();
    expect(JSON.parse(rec.fix!.snippet).model).toBe('local/"weird"\nmodel');
  });

  it('a STALE pass demotes "as of <date>" and is not counted as current confidence', () => {
    const rec = detector.rule(
      input(report([passClass({ asOf: STALE })])),
      NOW
    );
    expect(rec).not.toBeNull();
    // Demoted: no longer a live win — drops to the auditable floor.
    expect(rec?.proofTier).toBe('auditable');
    expect(rec?.title).toMatch(/^As of 2026-01-01/);
    // The measured attribution is demoted via provenance.ts (reused stale path).
    expect(rec?.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(rec?.savingsAttribution?.stale).toBe(true);
    expect(rec?.savingsAttribution?.judgeAgreement).toBeUndefined();
    // Not counted as a current ranking saving.
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.provenance?.stale).toBe(true);
    expect(validateRecProvenance(rec!.provenance!)).toEqual([]);
  });

  it('emitAll returns one rec per reportable class (pass + fail), proven first, suffixed ids', () => {
    const recs = detector.emitAll!(input(report([failClass(), passClass(), insufficientClass()])), NOW);
    expect(recs).toHaveLength(2);
    expect(recs[0].id).toBe('cost.local-downroute:mechanical'); // proven first
    expect(recs[1].id).toBe('cost.local-downroute:authoring'); // honest-null second
    // Every emitted rec is provenance-compliant.
    for (const rec of recs) {
      expect(validateRecommendationProvenance(rec)).toEqual([]);
    }
  });
});
