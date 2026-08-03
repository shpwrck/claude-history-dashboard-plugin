/**
 * Tests for workflow.rework-signature detector (issue #564).
 */

import { describe, it, expect } from 'vitest';
import { detector } from './rework-signature';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { FileHistorySession } from '../../parse-file-history';

// Helper: build a minimal RecommendationInput with an injected fileHistory field.
function makeInput(sessions: FileHistorySession[]): RecommendationInput & { fileHistory?: FileHistorySession[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    fileHistory: sessions,
  };
}

// Helpers to build FileHistorySession rows without specifying every field.
function fhSession(
  sessionId: string,
  churn: number,
  burstRate: number,
  spanMin = 2
): FileHistorySession {
  const reworkScore = +(churn * (1 + burstRate)).toFixed(1);
  return {
    sessionId,
    churn,
    spanMin,
    burstRate,
    reworkScore,
    firstMs: 1_780_000_000_000,
    lastMs: 1_780_000_000_000 + spanMin * 60_000,
  };
}

// High-rework storm: 12 snapshots, 4/min burst -> score = 12*(1+4) = 60
const storm = fhSession('stormSes00001', 12, 4);
// Medium: 6 snapshots, 1/min -> score = 12
const medium = fhSession('mediumSes0001', 6, 1);
// Calm: 2 snapshots, 0.5/min -> score = 3
const calm = fhSession('calmSessio001', 2, 0.5);

describe('workflow.rework-signature detector (#564)', () => {
  it('fires when enough sessions and top reworkScore exceeds threshold', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), 0);
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.rework-signature');
  });

  it('highlights the highest-reworkScore session in the detail', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), 0);
    // storm session id short prefix is 'stormSes'
    expect(rec?.detail).toContain('stormSes');
    expect(rec?.detail).toContain('60');
  });

  it('stays silent when fewer than MIN_SESSIONS (3) sessions present', () => {
    expect(detector.rule(makeInput([storm, medium]), 0)).toBeNull();
  });

  it('stays silent when all reworkScores are below MIN_REWORK_SCORE (10)', () => {
    const low1 = fhSession('low1Ses00001', 2, 0.2);  // score = 2*1.2 = 2.4
    const low2 = fhSession('low2Ses00001', 3, 0.5);  // score = 3*1.5 = 4.5
    const low3 = fhSession('low3Ses00001', 2, 1.0);  // score = 2*2.0 = 4.0
    expect(detector.rule(makeInput([low1, low2, low3]), 0)).toBeNull();
  });

  it('returns null when fileHistory is absent (undefined)', () => {
    const input = makeInput([]);
    delete input.fileHistory;
    expect(detector.rule(input, 0)).toBeNull();
  });

  it('returns null when fileHistory is empty array', () => {
    expect(detector.rule(makeInput([]), 0)).toBeNull();
  });

  it('escalates to warning severity when burstRate >= 3', () => {
    // storm has burstRate=4 >= 3
    const rec = detector.rule(makeInput([storm, medium, calm]), 0);
    expect(rec?.severity).toBe('warning');
  });

  it('uses info severity when top burstRate < 3', () => {
    // all sessions have burstRate < 3
    const s1 = fhSession('ses1000001', 8, 2.5); // score=28, burst<3
    const s2 = fhSession('ses2000001', 5, 1.5); // score=12.5
    const s3 = fhSession('ses3000001', 4, 1.0); // score=8 (below threshold for top)
    const rec = detector.rule(makeInput([s1, s2, s3]), 0);
    expect(rec?.severity).toBe('info');
  });

  it('includes up to 5 evidence rows', () => {
    const sessions = Array.from({ length: 7 }, (_, i) =>
      fhSession(`ses${String(i).padStart(9, '0')}`, 10 + i, 2 + i * 0.1)
    );
    const rec = detector.rule(makeInput(sessions), 0);
    expect(rec?.evidence?.length).toBeLessThanOrEqual(5);
  });

  it('evidence rows contain session id short prefix, score, churn, burst', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), 0);
    const topEvidence = rec?.evidence?.[0] ?? '';
    expect(topEvidence).toContain('stormSes');
    expect(topEvidence).toContain('score=');
    expect(topEvidence).toContain('churn=');
    expect(topEvidence).toContain('burst=');
  });

  it('detector metadata is correct', () => {
    expect(detector.id).toBe('workflow.rework-signature');
    expect(detector.category).toBe('workflow');
  });
});

// ── Provenance + causal-wording restriction (#3242) ────────────────────────

describe('workflow.rework-signature provenance (#3242)', () => {
  it('emits provenance that passes the contract when it fires', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), 0)!;
    expect(rec.provenance).toBeDefined();
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.claimClass).toBe('accounting');
    expect(rec.proofTier).toBe('accounting');
  });

  it('cites reworkScore, churn, burstRate, and spanMin as the measured operands', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), 0)!;
    const obs = rec.provenance!.observations;
    expect(obs.find((o) => o.field === 'reworkScore')!.value).toBe(60);
    expect(obs.find((o) => o.field === 'churn')!.value).toBe(12);
    expect(obs.find((o) => o.field === 'burstRate')!.value).toBe(4);
    expect(obs.find((o) => o.field === 'spanMin')!.value).toBe(storm.spanMin);
  });

  it('no longer asserts an unproven CAUSE (retry storms / unclear prompts)', () => {
    // The finding: burst geometry is a proxy, not proof of a cause. The copy
    // must restrict itself to the measured churn facts.
    const rec = detector.rule(makeInput([storm, medium, calm]), 0)!;
    const blob = [
      rec.title,
      rec.detail,
      rec.action,
      ...(rec.evidence ?? []),
      ...rec.provenance!.observations.map((observation) => observation.claim),
      rec.provenance!.inference,
    ].join(' ').toLowerCase();
    expect(blob).not.toMatch(/\b(repeated|redone|retried|retries|retry)\b/);
    expect(blob).not.toContain('unclear prompt');
    expect(blob).not.toContain('brittle');
    expect(rec.action).toContain('identifies neither file paths nor edit intent');
  });

  it('dates asOf from the newest snapshot mtime, not from now', () => {
    const rec = detector.rule(makeInput([storm, medium, calm]), Date.parse('2030-01-01T00:00:00Z'))!;
    // Newest lastMs across the shown sessions → a real calendar date, not 2030.
    expect(rec.provenance!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rec.provenance!.asOf).not.toBe('2030-01-01');
    expect(rec.provenance!.asOf).toBe(new Date(storm.lastMs).toISOString().slice(0, 10));
  });
});
