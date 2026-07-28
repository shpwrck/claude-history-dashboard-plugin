/**
 * Tests for the natural-experiment regression audit (#605 / #744).
 *
 * The judge is injected, so these cover the deterministic OLS fit (on a SYNTHETIC
 * dataset whose answer is known by construction) -> judge-interpret path without
 * the network, plus the insufficient-data gate, the singular-design degrade, and
 * the judge-failure isolation the no-500 route contract relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  fitNaturalExperiment,
  runNaturalExperimentAudit,
  buildDesignMatrix,
  fitOls,
  DEFAULT_FIT_OPTIONS,
  type NaturalExperimentRow,
  type FitResult,
} from './natural-experiment';
import type { JudgeFn } from './judge';

/**
 * Build a confounded dataset whose TRUE outcome is a known linear function:
 *   p(good) = 0.6 + 0.30*(model==='opus') - 0.40*z(difficulty)
 * Difficulty is CORRELATED with the model choice (opus is handed harder tasks on
 * average) but the two OVERLAP — opus also runs some easy tasks and sonnet some
 * hard ones — so model and difficulty are NOT collinear and the regression can
 * separate the adjusted model effect from the difficulty effect. The confound is
 * strong enough that the NAIVE per-model good-rate ranks opus BELOW sonnet, while
 * the difficulty-adjusted opus coefficient is POSITIVE (the audit's whole point).
 *
 * Outcomes are assigned DETERMINISTICALLY by thresholding the true probability at
 * 0.5, so the recovered coefficients are stable run-to-run (no RNG).
 */
function makeRows(): NaturalExperimentRow[] {
  // Difficulty grid (raw token totals) shared by both models so they overlap.
  // opus gets the upper-weighted slice, sonnet the lower-weighted slice, but
  // each spans most of the range.
  const sonnetDiff = [800, 1200, 1600, 2000, 2600, 3200, 4000, 5000, 6500, 8000];
  const opusDiff = [1500, 2500, 3500, 4500, 6000, 7500, 9000, 11000, 13000, 15000];
  const all = [...sonnetDiff, ...opusDiff];
  const mean = all.reduce((a, d) => a + d, 0) / all.length;
  const std = Math.sqrt(
    all.reduce((a, d) => a + (d - mean) ** 2, 0) / all.length
  );
  const trueProb = (model: string, difficulty: number) => {
    const z = (difficulty - mean) / std;
    return 0.6 + (model === 'opus' ? 0.3 : 0) - 0.4 * z;
  };
  const rows: NaturalExperimentRow[] = [];
  sonnetDiff.forEach((d, i) => {
    rows.push({
      sessionId: `sonnet-${i}`,
      outcome: trueProb('sonnet', d) >= 0.5 ? 1 : 0,
      model: 'sonnet',
      toolFactor: i % 2 === 0 ? 'Bash' : 'Edit',
      difficulty: d,
    });
  });
  opusDiff.forEach((d, i) => {
    rows.push({
      sessionId: `opus-${i}`,
      outcome: trueProb('opus', d) >= 0.5 ? 1 : 0,
      model: 'opus',
      toolFactor: i % 2 === 0 ? 'Bash' : 'Edit',
      difficulty: d,
    });
  });
  return rows;
}

/**
 * #3113 fixture: `model` has ONE qualifying level (`sonnet`, 12 rows) plus a
 * THIN second level (`haiku`, 2 rows — below the default minPerCell of 3) that
 * is perfectly correlated with the `tool=Edit` level and always ends badly.
 *
 * The tool factor IS contrastable (Bash 6 / Edit 8), so a fit happens. If the
 * thin haiku rows are left in the sample while the model factor is omitted from
 * the design, their all-bad outcomes load onto `tool:Bash` (Edit, the
 * reference, looks worse than it is) — an "adjusted" edge manufactured by the
 * omitted factor. Both tool levels have an identical 50% good-rate among the
 * sonnet rows, so the honest adjusted tool effect is exactly ZERO.
 */
function confoundedByThinModelLevel(): NaturalExperimentRow[] {
  const rows: NaturalExperimentRow[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push({
      sessionId: `bash-${i}`,
      outcome: (i % 2) as 0 | 1,
      model: 'sonnet',
      toolFactor: 'Bash',
      difficulty: 1000 + i * 100,
    });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({
      sessionId: `edit-${i}`,
      outcome: (i % 2) as 0 | 1,
      model: 'sonnet',
      toolFactor: 'Edit',
      difficulty: 1000 + i * 100,
    });
  }
  for (let i = 0; i < 2; i++) {
    rows.push({
      sessionId: `haiku-${i}`,
      outcome: 0,
      model: 'haiku',
      toolFactor: 'Edit',
      difficulty: 1000 + i * 100,
    });
  }
  return rows;
}

const accept: JudgeFn = async () => ({
  isFinding: true,
  rationale: 'After controlling for difficulty, opus shows a real edge.',
  confidence: 'high',
});

function coef(fit: FitResult, term: string) {
  return fit.coefficients.find((c) => c.term === term);
}

describe('fitNaturalExperiment', () => {
  it('recovers the difficulty control and the adjusted model effect', () => {
    const rows = makeRows();

    // Naive (unadjusted) per-model good-rate: sonnet 0.8, opus 0.7 -> the raw
    // comparison says opus is WORSE by 0.1 (sonnet enjoys a +0.1 raw edge).
    const naiveSonnet =
      rows.filter((r) => r.model === 'sonnet' && r.outcome === 1).length / 10;
    const naiveOpus =
      rows.filter((r) => r.model === 'opus' && r.outcome === 1).length / 10;
    expect(naiveSonnet).toBeCloseTo(0.8, 5);
    expect(naiveOpus).toBeCloseTo(0.7, 5);
    const naiveSonnetEdge = naiveSonnet - naiveOpus; // +0.1 (raw, confounded)

    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('fit');
    if (result.status !== 'fit') return;

    expect(result.n).toBe(20);

    // Difficulty is the standardized control covariate and should carry a strong
    // NEGATIVE coefficient (harder tasks -> lower good-rate), as constructed.
    const diff = coef(result, 'difficulty');
    expect(diff).toBeDefined();
    expect(diff!.estimate).toBeLessThan(0);

    // opus and sonnet tie on count, so opus (alphabetically first) is the dropped
    // reference and the modeled dummy is `model:sonnet`. Its ADJUSTED coefficient
    // (sonnet vs. opus, holding difficulty fixed) should be NEGATIVE: once the
    // "opus got the hard tasks" confound is removed, sonnet's raw +0.1 edge flips
    // to an adjusted DISADVANTAGE -> opus is actually the better model. This sign
    // flip is the whole point of the difficulty control.
    const sonnet = coef(result, 'model:sonnet');
    expect(sonnet).toBeDefined();
    expect(sonnet!.estimate).toBeLessThan(0);
    // The adjusted sonnet effect is below its naive +0.1 raw edge (the control
    // moved the comparison against sonnet).
    expect(sonnet!.estimate).toBeLessThan(naiveSonnetEdge);
  });

  it('drops one reference level per categorical factor (no collinearity)', () => {
    const rows = makeRows();
    const result = fitNaturalExperiment(rows);
    if (result.status !== 'fit') throw new Error('expected fit');
    // Exactly one model reference and one tool reference are dropped.
    expect(result.references).toHaveLength(2);
    const factors = result.references.map((r) => r.factor).sort();
    expect(factors).toEqual(['model', 'tool']);
    // Intercept present; only ONE of the two model levels appears as a dummy
    // (the other is the dropped reference).
    expect(coef(result, '(intercept)')).toBeDefined();
    const modelDummies = result.coefficients.filter(
      (c) => c.factor === 'model'
    );
    expect(modelDummies).toHaveLength(1);
    const toolDummies = result.coefficients.filter((c) => c.factor === 'tool');
    expect(toolDummies).toHaveLength(1);
  });

  it('recovers a known coefficient magnitude on a clean two-level fit', () => {
    // A noiseless construction: outcome = 0 for level A, 1 for level B. Difficulty
    // VARIES (so its column is non-degenerate) but is balanced identically across
    // A and B, so it is orthogonal to both model and outcome and drops out (its
    // coefficient ~0). The B-vs-A jump must come through as ~1.0.
    const grid = [1000, 2000, 3000, 4000, 5000, 6000];
    const rows: NaturalExperimentRow[] = [];
    grid.forEach((d, i) => {
      rows.push({
        sessionId: `a-${i}`,
        outcome: 0,
        model: 'A',
        toolFactor: 'Bash',
        difficulty: d,
      });
      rows.push({
        sessionId: `b-${i}`,
        outcome: 1,
        model: 'B',
        toolFactor: 'Bash',
        difficulty: d,
      });
    });
    // Tool factor is constant -> only model varies; that is allowed (one factor).
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('fit');
    if (result.status !== 'fit') return;
    // A and B tie on count, so A (alphabetically first) is the dropped reference
    // and the B dummy carries the +1.0 jump.
    const b = coef(result, 'model:B');
    expect(b).toBeDefined();
    expect(b!.estimate).toBeCloseTo(1.0, 6);
    // Difficulty is orthogonal here -> its coefficient is ~0.
    const diff = coef(result, 'difficulty');
    expect(diff!.estimate).toBeCloseTo(0, 6);
  });

  it('returns insufficient when there are too few sessions', () => {
    const rows = makeRows().slice(0, 5); // below minSessions (8)
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
    if (result.status !== 'insufficient') return;
    expect(result.n).toBe(5);
    expect(result.reason).toMatch(/at least 8/);
  });

  it('returns insufficient when no factor has two well-populated levels', () => {
    // 8 sessions, all the same model + tool -> nothing to contrast.
    const rows: NaturalExperimentRow[] = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `s-${i}`,
      outcome: (i % 2) as 0 | 1,
      model: 'opus',
      toolFactor: 'Bash',
      difficulty: 1000 + i * 100,
    }));
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
    if (result.status !== 'insufficient') return;
    expect(result.reason).toMatch(/two levels/);
  });

  it('honors minPerCell: a thin second level is not contrasted', () => {
    // 9 opus + 2 haiku: haiku has only 2 rows (< default minPerCell 3), so it is
    // dropped and no model contrast remains -> insufficient.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 9; i++) {
      rows.push({
        sessionId: `o-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'opus',
        toolFactor: 'Bash',
        difficulty: 2000 + i * 100,
      });
    }
    for (let i = 0; i < 2; i++) {
      rows.push({
        sessionId: `h-${i}`,
        outcome: 1,
        model: 'haiku',
        toolFactor: 'Bash',
        difficulty: 2000,
      });
    }
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
  });

  it('excludes the thin levels of an OMITTED factor instead of leaving them in the sample (#3113)', () => {
    const rows = confoundedByThinModelLevel();
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('fit');
    if (result.status !== 'fit') return;

    // The thin-model rows left the sample entirely: 12 sonnet rows, not 14.
    expect(result.n).toBe(12);
    // The model factor could not be contrasted, so it is reported as HELD
    // CONSTANT rather than silently omitted while its variation stays in.
    expect(result.heldConstant).toEqual([{ factor: 'model', level: 'sonnet' }]);
    expect(result.coefficients.some((c) => c.factor === 'model')).toBe(false);

    // The confound is gone: among the retained (sonnet) rows Bash and Edit have
    // the same good-rate, so the adjusted tool effect is exactly 0 and is not
    // flagged as an edge. With the thin haiku rows still in the sample this
    // coefficient is non-zero — an edge created by the omitted factor.
    //
    // The reference level is recomputed on the RETAINED sample (#3392 P1): Edit
    // leads 8-6 on the raw input, but after the 2 haiku rows leave it is a 6-6
    // tie, which breaks alphabetically to Bash. So the modeled dummy is
    // `tool:Edit`, and there is exactly one tool dummy either way.
    const toolDummies = result.coefficients.filter((c) => c.factor === 'tool');
    expect(toolDummies.map((c) => c.term)).toEqual(['tool:Edit']);
    expect(toolDummies[0].estimate).toBeCloseTo(0, 9);
    expect(toolDummies[0].significant).toBe(false);
  });

  it('returns insufficient when excluding an omitted factor’s thin levels leaves too few sessions (#3113)', () => {
    // 6 sonnet rows (the only qualifying model level) + 4 rows split across two
    // thin model levels. Dropping the thin rows leaves 6 < minSessions (8), so
    // the honest answer is insufficient — not a fit over a contaminated sample.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push({
        sessionId: `s-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'sonnet',
        toolFactor: i < 3 ? 'Bash' : 'Edit',
        difficulty: 1000 + i * 100,
      });
    }
    for (let i = 0; i < 2; i++) {
      rows.push({
        sessionId: `h-${i}`,
        outcome: 0,
        model: 'haiku',
        toolFactor: 'Edit',
        difficulty: 1500,
      });
      rows.push({
        sessionId: `o-${i}`,
        outcome: 0,
        model: 'opus',
        toolFactor: 'Bash',
        difficulty: 1500,
      });
    }
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
    if (result.status !== 'insufficient') return;
    expect(result.n).toBe(6);
    expect(result.reason).toMatch(/excluded rather than left in the sample/);
  });

  it('rechecks minPerCell on the RETAINED sample, not the raw input (#3392 P1)', () => {
    // `tool=Bash` qualifies on the raw input by exactly 3 rows — but 2 of those
    // are thin-model (`haiku`) rows that the #3113 restriction removes. After the
    // restriction Bash is backed by ONE session, so a `tool:Bash` coefficient
    // would rest on a single row despite the 3-session floor. Re-running the
    // level choice on the retained sample drops Bash too, which leaves nothing to
    // contrast -> insufficient.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 9; i++) {
      rows.push({
        sessionId: `edit-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'sonnet',
        toolFactor: 'Edit',
        difficulty: 1000 + i * 100,
      });
    }
    rows.push({
      sessionId: 'bash-sonnet',
      outcome: 1,
      model: 'sonnet',
      toolFactor: 'Bash',
      difficulty: 1500,
    });
    for (let i = 0; i < 2; i++) {
      rows.push({
        sessionId: `bash-haiku-${i}`,
        outcome: 0,
        model: 'haiku',
        toolFactor: 'Bash',
        difficulty: 1500,
      });
    }
    // Sanity: on the RAW input both tool levels clear the floor (Edit 9, Bash 3).
    expect(rows.filter((r) => r.toolFactor === 'Bash')).toHaveLength(3);

    const design = buildDesignMatrix(rows, 3);
    expect(design).toBeNull();

    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
    if (result.status !== 'insufficient') return;
    expect(result.reason).toMatch(/two levels/);
  });

  it('keeps a contrast that still clears the floor after the restriction (#3392 P1)', () => {
    // Same shape, but Bash has 5 raw rows and keeps 3 after the 2 thin-model rows
    // leave — the floor is still met, so the fit proceeds. The recount must not
    // be so eager that it kills every restricted design.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push({
        sessionId: `edit-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'sonnet',
        toolFactor: 'Edit',
        difficulty: 1000 + i * 100,
      });
    }
    for (let i = 0; i < 3; i++) {
      rows.push({
        sessionId: `bash-${i}`,
        outcome: 1,
        model: 'sonnet',
        toolFactor: 'Bash',
        difficulty: 1200 + i * 100,
      });
    }
    for (let i = 0; i < 2; i++) {
      rows.push({
        sessionId: `bash-haiku-${i}`,
        outcome: 0,
        model: 'haiku',
        toolFactor: 'Bash',
        difficulty: 1500,
      });
    }
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('fit');
    if (result.status !== 'fit') return;
    expect(result.n).toBe(10);
    expect(result.heldConstant).toEqual([{ factor: 'model', level: 'sonnet' }]);
    expect(coef(result, 'tool:Bash')).toBeDefined();
  });

  it('degrades (does not throw) on a singular/degenerate design', () => {
    // Build a design whose tool factor is PERFECTLY collinear with the model
    // factor (every opus is Bash, every sonnet is Edit) -> the model and tool
    // dummies are identical columns -> X'X is singular. Must NOT throw; must
    // return insufficient.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push({
        sessionId: `o-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'opus',
        toolFactor: 'Bash',
        difficulty: 1000 + i * 100,
      });
    }
    for (let i = 0; i < 6; i++) {
      rows.push({
        sessionId: `s-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'sonnet',
        toolFactor: 'Edit',
        difficulty: 5000 + i * 100,
      });
    }
    let result: ReturnType<typeof fitNaturalExperiment> | undefined;
    expect(() => {
      result = fitNaturalExperiment(rows);
    }).not.toThrow();
    expect(result!.status).toBe('insufficient');
  });

  it('fitOls returns null on a directly singular design', () => {
    // Two identical rows duplicated -> X'X cannot be inverted for the difficulty
    // column (zero variance) and the dummies collapse. Exercises the guard.
    const rows: NaturalExperimentRow[] = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `s-${i}`,
      outcome: 1,
      model: i < 4 ? 'opus' : 'sonnet',
      toolFactor: i < 4 ? 'Bash' : 'Bash',
      difficulty: 1000, // zero variance -> difficulty column is all-zero post-z
    }));
    const design = buildDesignMatrix(rows, 3);
    expect(design).not.toBeNull();
    // With a constant outcome and a zero-variance difficulty column the normal
    // equations are singular -> null, not a throw.
    const fit = fitOls(design!, 2);
    expect(fit).toBeNull();
  });
});

describe('runNaturalExperimentAudit', () => {
  it('emits a finding carrying the coefficient table + judge interpretation', async () => {
    const rows = makeRows();
    let sawTable = '';
    const capturing: JudgeFn = async ({ user, system }) => {
      sawTable = user;
      expect(system).toMatch(/CONTROL/);
      return {
        isFinding: true,
        rationale: 'Opus keeps its edge once difficulty is held fixed.',
        confidence: 'medium',
      };
    };
    const findings = await runNaturalExperimentAudit(rows, capturing);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe('natural-experiment:regression');
    expect(f.domain).toBe('quality');
    // The judge was shown the fitted coefficient table.
    expect(sawTable).toMatch(/Coefficients \(adjusted for difficulty\)/);
    // opus is the dropped reference (count tie -> alphabetical), so the modeled
    // model dummy is `model:sonnet`.
    expect(sawTable).toMatch(/model:sonnet/);
    // Evidence anchors carry the adjusted coefficients + baselines.
    expect(f.evidenceRefs.some((r) => r.startsWith('coef:model:sonnet'))).toBe(
      true
    );
    expect(f.evidenceRefs.some((r) => r.startsWith('baseline:'))).toBe(true);
    expect(f.judgeRationale).toContain('Opus');
    expect(f.confidence).toBe('medium');
  });

  it('scopes the emitted claim to the levels actually in the sample (#3113)', async () => {
    let sawTable = '';
    const capturing: JudgeFn = async ({ user }) => {
      sawTable = user;
      return { isFinding: true, rationale: 'ok', confidence: 'medium' };
    };
    const findings = await runNaturalExperimentAudit(
      confoundedByThinModelLevel(),
      capturing
    );
    expect(findings).toHaveLength(1);
    const f = findings[0];
    // The fit ran over the 12 retained sessions, and both the summary and the
    // evidence say the result only covers model=sonnet — no unqualified
    // "adjusted effect" over a sample that still held unmodeled variation.
    expect(f.summary).toContain('over 12 sessions');
    expect(f.summary).toContain('covers only sessions with model=sonnet');
    expect(f.evidenceRefs).toContain('held-constant:model=sonnet');
    expect(f.evidenceRefs).toContain('sessions-fitted:12');
    // The judge is told about the restriction too, so its prose cannot
    // generalize past the sample.
    expect(sawTable).toMatch(/Held constant/);
    // No tool level is advertised as an edge (the confound was the only source).
    expect(f.summary).toMatch(/no model or tool factor shows/);
  });

  it('still emits the coefficients when the judge call fails', async () => {
    const rows = makeRows();
    const failing: JudgeFn = async () => {
      throw new Error('judge down');
    };
    const findings = await runNaturalExperimentAudit(rows, failing);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    // Coefficients are still reported; confidence drops to low.
    expect(f.id).toBe('natural-experiment:regression');
    expect(f.confidence).toBe('low');
    expect(f.evidenceRefs.some((r) => r.startsWith('coef:'))).toBe(true);
    expect(f.judgeRationale).toMatch(/adjusted for task difficulty/);
  });

  it('emits ONE low-confidence finding on insufficient data (no fit)', async () => {
    const rows = makeRows().slice(0, 4);
    let judgeCalled = false;
    const watch: JudgeFn = async () => {
      judgeCalled = true;
      return { isFinding: true, rationale: 'x', confidence: 'high' };
    };
    const findings = await runNaturalExperimentAudit(rows, watch);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.id).toBe('natural-experiment:insufficient-data');
    expect(f.confidence).toBe('low');
    expect(f.domain).toBe('quality');
    // No spurious fit -> the judge is never consulted.
    expect(judgeCalled).toBe(false);
  });

  it('flags a significant level via the coarse t-ratio heuristic', async () => {
    const rows = makeRows();
    const result = fitNaturalExperiment(rows, DEFAULT_FIT_OPTIONS);
    if (result.status !== 'fit') throw new Error('expected fit');
    // The difficulty control is a strong, well-estimated effect here, so it
    // should clear the significance threshold (honest heuristic, not a p-value).
    const diff = result.coefficients.find((c) => c.term === 'difficulty');
    expect(diff).toBeDefined();
    expect(Number.isFinite(diff!.tRatio)).toBe(true);
    expect(diff!.significant).toBe(true);
    // A finding still emits regardless of which levels are significant.
    const findings = await runNaturalExperimentAudit(rows, accept);
    expect(findings[0].summary).toMatch(/after controlling for task difficulty/);
  });
});
