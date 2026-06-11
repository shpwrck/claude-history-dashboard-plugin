/**
 * Tests for the start/stop-oracle audit (#605 / #743).
 *
 * The judge is injected, so these cover the deterministic opener-feature
 * extraction + risky-feature ranking -> judge-confirm -> single-finding path
 * without the network, plus the judge-failure / judge-reject isolation the
 * no-500 route contract relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  openerFeatures,
  rankRiskyFeatures,
  baselineBadRate,
  runStartStopOracleAudit,
  DEFAULT_RANK_OPTIONS,
  type StartStopRow,
} from './start-stop-oracle';
import type { JudgeFn } from './judge';

const accept: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'These vague broad-scope openers reliably precede churn.',
  confidence: 'high',
});

const reject: JudgeFn = async () => ({
  isFinding: false,
  rationale: 'The margin over baseline is too thin to trust.',
  confidence: 'low',
});

const boom: JudgeFn = async () => {
  throw new Error('judge network failure');
};

/**
 * Build a dataset where the "broad scope" opener trait is strongly predictive of
 * bad outcomes: every broad opener fails, every bounded opener succeeds.
 */
function riskyDataset(): StartStopRow[] {
  const rows: StartStopRow[] = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      sessionId: `broad-${i}`,
      project: 'demo',
      opener: 'Refactor everything in the whole codebase',
      good: false,
    });
  }
  for (let i = 0; i < 5; i++) {
    rows.push({
      sessionId: `bounded-${i}`,
      project: 'demo',
      opener: 'Fix the null check in src/auth/login.ts line 42',
      good: true,
    });
  }
  return rows;
}

describe('openerFeatures', () => {
  it('buckets opener length', () => {
    expect(openerFeatures('short one').lengthBucket).toBe('short');
    expect(openerFeatures('x'.repeat(120)).lengthBucket).toBe('medium');
    expect(openerFeatures('x'.repeat(250)).lengthBucket).toBe('long');
  });

  it('detects a question vs. a directive', () => {
    expect(openerFeatures('Why is this failing?').isQuestion).toBe(true);
    expect(openerFeatures('Fix this bug').isQuestion).toBe(false);
  });

  it('detects broad scope markers', () => {
    expect(openerFeatures('Refactor everything').broadScope).toBe(true);
    expect(openerFeatures('Rewrite the whole module').broadScope).toBe(true);
    expect(openerFeatures('Update one function').broadScope).toBe(false);
  });

  it('flags vague openers but not ones with a concrete anchor', () => {
    expect(openerFeatures('Just clean up and make it better somehow').isVague).toBe(true);
    // Same vague wording but anchored to a concrete file path -> not vague.
    expect(openerFeatures('Clean up src/util/helpers.ts').isVague).toBe(false);
  });
});

describe('baselineBadRate', () => {
  it('computes the overall bad-outcome rate', () => {
    expect(baselineBadRate(riskyDataset())).toBeCloseTo(0.5);
    expect(baselineBadRate([])).toBe(0);
  });
});

describe('rankRiskyFeatures', () => {
  it('flags a feature value whose bad-rate clears support + margin + floor', () => {
    const risky = rankRiskyFeatures(riskyDataset());
    expect(risky.length).toBeGreaterThan(0);
    const broad = risky.find((r) => r.feature === 'broadScope' && r.value === 'true');
    expect(broad).toBeDefined();
    expect(broad!.badRate).toBe(1);
    expect(broad!.support).toBe(5);
    expect(broad!.exampleSessions.length).toBeGreaterThan(0);
  });

  it('stays silent when there are fewer than minSessions', () => {
    const few = riskyDataset().slice(0, 4);
    expect(rankRiskyFeatures(few)).toEqual([]);
  });

  it('stays silent when no value clears the margin over baseline', () => {
    // Every session bad -> baseline 100%, so no value can be a margin ABOVE it.
    const allBad = riskyDataset().map((r) => ({ ...r, good: false }));
    expect(rankRiskyFeatures(allBad)).toEqual([]);
  });

  it('drops thin groups below minSupport', () => {
    const rows = riskyDataset();
    // One extra unique-trait bad session is below minSupport=3 -> excluded.
    rows.push({ sessionId: 'q1', project: 'demo', opener: 'Why broken?', good: false });
    const risky = rankRiskyFeatures(rows);
    expect(risky.some((r) => r.feature === 'isQuestion' && r.value === 'true')).toBe(false);
  });
});

describe('runStartStopOracleAudit', () => {
  it('emits one workflow finding when the judge confirms', async () => {
    const findings = await runStartStopOracleAudit(riskyDataset(), accept);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('start-stop-oracle:risky-openers');
    expect(findings[0].domain).toBe('workflow');
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].judgeRationale).toContain('churn');
    expect(findings[0].evidenceRefs.some((r) => r.startsWith('opener-trait:'))).toBe(true);
    expect(findings[0].evidenceRefs.some((r) => r.startsWith('session:'))).toBe(true);
  });

  it('returns [] when the judge rejects the signal as noise', async () => {
    expect(await runStartStopOracleAudit(riskyDataset(), reject)).toEqual([]);
  });

  it('still emits the deterministic finding (low confidence) on judge failure', async () => {
    const findings = await runStartStopOracleAudit(riskyDataset(), boom);
    expect(findings).toHaveLength(1);
    expect(findings[0].confidence).toBe('low');
    expect(findings[0].judgeRationale).toContain('Judge interpretation was unavailable');
  });

  it('returns [] on insufficient data without calling the judge', async () => {
    let called = false;
    const spy: JudgeFn = async () => {
      called = true;
      return { isFinding: true, rationale: '', confidence: 'high' };
    };
    const out = await runStartStopOracleAudit(riskyDataset().slice(0, 4), spy);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('respects DEFAULT_RANK_OPTIONS shape', () => {
    expect(DEFAULT_RANK_OPTIONS.minSupport).toBeGreaterThan(0);
  });
});
