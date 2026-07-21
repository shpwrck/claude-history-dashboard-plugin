import { describe, it, expect } from 'vitest';
import {
  parseLocalCalibration,
  parseCalibrationClass,
  LOCAL_CALIBRATION_FRESHNESS_DAYS,
} from './parse-local-calibration';
import { DOWN_MODEL_PROOF_FRESHNESS_DAYS } from './detectors/cost/automation-share';

const validClass = {
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
  asOf: '2026-06-15',
  verdict: 'pass',
  reasons: ['quality parity held (delta -0.1)'],
};

const report = (over: Record<string, unknown> = {}) => ({
  version: 1,
  kind: 'tier-b-calibration',
  thresholds: { minSamples: 5, minAgreement: 0.8 },
  asOf: '2026-06-15',
  classes: [validClass],
  ...over,
});

describe('parseLocalCalibration (#2318)', () => {
  it('parses a well-formed report and preserves the class rows', () => {
    const parsed = parseLocalCalibration(JSON.stringify(report()));
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(1);
    expect(parsed?.kind).toBe('tier-b-calibration');
    expect(parsed?.thresholds).toEqual({ minSamples: 5, minAgreement: 0.8 });
    expect(parsed?.classes).toHaveLength(1);
    const c = parsed!.classes[0];
    expect(c.taskClass).toBe('mechanical');
    expect(c.verdict).toBe('pass');
    expect(c.blindJudgeAgreement).toBe(0.9);
    expect(c.savingsUsdPerTask).toBeCloseTo(0.119, 6);
    expect(c.parity.held).toBe(true);
    expect(c.asOf).toBe('2026-06-15');
  });

  it('returns null for a non-tier-b envelope', () => {
    expect(parseLocalCalibration(JSON.stringify(report({ kind: 'something-else' })))).toBeNull();
  });

  it('returns null for a missing/invalid version', () => {
    expect(parseLocalCalibration(JSON.stringify(report({ version: 'x' })))).toBeNull();
  });

  it('returns null for non-JSON, empty, or nullish text', () => {
    expect(parseLocalCalibration('not json {')).toBeNull();
    expect(parseLocalCalibration('')).toBeNull();
    expect(parseLocalCalibration('   ')).toBeNull();
    expect(parseLocalCalibration(null)).toBeNull();
    expect(parseLocalCalibration(undefined)).toBeNull();
  });

  it('drops malformed class rows but keeps the valid ones (never guesses)', () => {
    const parsed = parseLocalCalibration(
      JSON.stringify(
        report({
          classes: [
            validClass,
            { ...validClass, taskClass: '' }, // no class → dropped
            { ...validClass, verdict: 'maybe' }, // bad verdict → dropped
            'garbage',
          ],
        })
      )
    );
    expect(parsed?.classes).toHaveLength(1);
    expect(parsed?.classes[0].taskClass).toBe('mechanical');
  });

  it('coerces non-finite numeric fields to null rather than trusting them', () => {
    const c = parseCalibrationClass({
      ...validClass,
      blindJudgeAgreement: 'high',
      costClaude: null,
      nSamples: NaN,
    });
    expect(c?.blindJudgeAgreement).toBeNull();
    expect(c?.costClaude).toBeNull();
    expect(c?.nSamples).toBe(0);
  });

  it('rejects an invalid asOf, keeping only ISO YYYY-MM-DD', () => {
    const c = parseCalibrationClass({ ...validClass, asOf: '2026/06/15' });
    expect(c?.asOf).toBeNull();
  });

  it('fails closed when the thresholds envelope is absent or malformed', () => {
    // A report that does not STATE its evidence floors cannot be trusted to have
    // applied them — reject the whole envelope rather than default to {0,0}.
    const strip = (over: Record<string, unknown>) => {
      const r = report();
      Object.assign(r, over);
      return JSON.stringify(r);
    };
    expect(parseLocalCalibration(strip({ thresholds: undefined }))).toBeNull();
    expect(parseLocalCalibration(strip({ thresholds: {} }))).toBeNull();
    expect(parseLocalCalibration(strip({ thresholds: { minSamples: 5 } }))).toBeNull();
    expect(
      parseLocalCalibration(strip({ thresholds: { minSamples: 0, minAgreement: 0.8 } }))
    ).toBeNull(); // minSamples < 1
    expect(
      parseLocalCalibration(strip({ thresholds: { minSamples: 5, minAgreement: 1.5 } }))
    ).toBeNull(); // minAgreement out of [0,1]
    expect(
      parseLocalCalibration(strip({ thresholds: { minSamples: 5, minAgreement: 'x' } }))
    ).toBeNull();
  });

  it('exposes a freshness horizon aligned with the hosted down-model proof', () => {
    expect(LOCAL_CALIBRATION_FRESHNESS_DAYS).toBe(DOWN_MODEL_PROOF_FRESHNESS_DAYS);
  });
});
