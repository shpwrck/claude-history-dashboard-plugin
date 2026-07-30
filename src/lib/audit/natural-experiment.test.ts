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
    expect(result.diagnostics.refinementPasses).toBe(1);
    expect(result.diagnostics.modelLevelsSeen).toBe(1);
    expect(result.diagnostics.toolLevelsSeen).toBe(1);
    expect(result.diagnostics.modelLevelsModeled).toBe(1);
    expect(result.diagnostics.toolLevelsModeled).toBe(1);
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

  it('reports refinement-budget exhaustion with the consumed trace', () => {
    // The first pass drops the two thin-model rows. A second pass is then needed
    // to discover that Bash no longer clears minPerCell, so a one-pass budget
    // must report exhaustion rather than falsely claiming there was no contrast.
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

    const result = fitNaturalExperiment(rows, {
      ...DEFAULT_FIT_OPTIONS,
      maxRefinementPasses: 1,
    });

    expect(result.status).toBe('insufficient');
    if (result.status !== 'insufficient') return;
    expect(result.reason).toMatch(/refinement.*declared ceiling.*1/i);
    expect(result.diagnostics.rejectionReason).toBe(result.reason);
    expect(result.diagnostics.refinementPasses).toBe(1);
    expect(result.diagnostics.modelLevelsSeen).toBe(2);
    expect(result.diagnostics.toolLevelsSeen).toBe(2);
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
  it('does not claim no fit was attempted after a singular solve', async () => {
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push({
        sessionId: `o-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'opus',
        toolFactor: 'Bash',
        difficulty: 1000 + i * 100,
      });
      rows.push({
        sessionId: `s-${i}`,
        outcome: (i % 2) as 0 | 1,
        model: 'sonnet',
        toolFactor: 'Edit',
        difficulty: 5000 + i * 100,
      });
    }

    const findings = await runNaturalExperimentAudit(rows, accept);
    expect(findings[0].id).toBe('natural-experiment:insufficient-data');
    expect(findings[0].evidenceRefs).not.toContain('augmented-cells:0');
    expect(findings[0].judgeRationale).not.toMatch(/no fit was attempted/i);
  });

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

/**
 * Design-budget contract (#3114).
 *
 * The endpoint's cost is governed by `k`, the design's column count: `X'X` is
 * O(n*k^2), the augmented `[A | I]` matrix is k-by-2k, and Gauss-Jordan inversion
 * is O(k^3). Before the budget existed, `minPerCell` was the ONLY constraint on
 * `k`, so every tool level with three sessions added a column and `k` grew with
 * the corpus.
 *
 * These assertions are calibrated against MEASURED behaviour of the pre-budget
 * implementation, so they can actually fail: on a 900-row/300-tool corpus it
 * produced k=302 and a 182,408-cell augmented matrix (vs. the ceilings below),
 * and on 3,000 rows/1,000 tools k=1,002, a 2,008,008-cell augmented matrix, and
 * a 42-SECOND fit. A regression that removes the ceilings trips these.
 */
describe('#3114 design budget', () => {
  /** Every tool level gets exactly `minPerCell` rows, so all of them qualify. */
  function highCardinalityRows(n: number): NaturalExperimentRow[] {
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        sessionId: `s${i}`,
        outcome: i % 3 === 0 ? 1 : 0,
        model: i % 2 === 0 ? 'opus' : 'sonnet',
        toolFactor: `mcp__plugin_${Math.floor(i / 3)}__run`,
        difficulty: 1000 + (i % 97) * 13,
      });
    }
    return rows;
  }

  /** k can never exceed intercept + model dummies + tool dummies + difficulty. */
  const K_CEILING =
    1 +
    (DEFAULT_FIT_OPTIONS.maxModelLevels - 1) +
    (DEFAULT_FIT_OPTIONS.maxToolLevels - 1) +
    1;

  it('bounds design terms and the augmented matrix on a high-cardinality corpus', () => {
    const result = fitNaturalExperiment(highCardinalityRows(900));
    if (result.status !== 'fit') throw new Error('expected a fit');
    // Pre-budget this was 302 terms / 182,408 augmented cells.
    expect(result.coefficients.length).toBeLessThanOrEqual(K_CEILING);
    expect(result.diagnostics.terms).toBe(result.coefficients.length);
    expect(result.diagnostics.augmentedCells).toBeLessThanOrEqual(
      K_CEILING * 2 * K_CEILING
    );
    expect(result.diagnostics.toolLevelsModeled).toBeLessThanOrEqual(
      DEFAULT_FIT_OPTIONS.maxToolLevels
    );
  });

  it('keeps k bounded as the corpus grows — k must not track session count', () => {
    const small = fitNaturalExperiment(highCardinalityRows(900));
    const large = fitNaturalExperiment(highCardinalityRows(2400));
    if (small.status !== 'fit' || large.status !== 'fit') {
      throw new Error('expected fits');
    }
    // The defect was that k grew linearly with n. Tripling the corpus (and the
    // distinct tool count with it) must not grow the design at all.
    expect(large.diagnostics.terms).toBe(small.diagnostics.terms);
    expect(large.diagnostics.terms).toBeLessThanOrEqual(K_CEILING);
  });

  it('rejects an oversized corpus BEFORE allocating any matrix', () => {
    const rows = highCardinalityRows(DEFAULT_FIT_OPTIONS.maxRows + 1);
    const result = fitNaturalExperiment(rows);
    expect(result.status).toBe('insufficient');
    // The whole point of the row budget: nothing was allocated.
    expect(result.diagnostics.augmentedCells).toBe(0);
    expect(result.diagnostics.terms).toBe(0);
    expect(result.diagnostics.rowsFitted).toBe(0);
    expect(result.diagnostics.rejectionReason).toMatch(/declared ceiling/);
    expect(result.diagnostics.rowsIn).toBe(rows.length);
  });

  it('exposes rows, terms, duration and rejection reason on both paths', () => {
    const fitRes = fitNaturalExperiment(highCardinalityRows(900));
    expect(fitRes.diagnostics.rowsIn).toBe(900);
    expect(fitRes.diagnostics.rowsFitted).toBeGreaterThan(0);
    expect(fitRes.diagnostics.terms).toBeGreaterThan(0);
    expect(Number.isFinite(fitRes.diagnostics.durationMs)).toBe(true);
    expect(fitRes.diagnostics.rejectionReason).toBeNull();

    const rejected = fitNaturalExperiment([]);
    expect(rejected.status).toBe('insufficient');
    expect(typeof rejected.diagnostics.rejectionReason).toBe('string');
    expect(Number.isFinite(rejected.diagnostics.durationMs)).toBe(true);
  });

  it('reports truncation from the INPUT cardinality, not the converged sample', () => {
    const result = fitNaturalExperiment(highCardinalityRows(900));
    if (result.status !== 'fit') throw new Error('expected a fit');
    // 300 distinct tool levels went in; only the budgeted best-supported ones
    // were modeled. Reading `seen` off the converged sample would report 32 and
    // hide the exclusion entirely.
    expect(result.diagnostics.toolLevelsSeen).toBe(300);
    expect(result.diagnostics.levelsTruncated).toBe(true);
  });

  it('discloses a truncated level set in the emitted claim', async () => {
    const findings = await runNaturalExperimentAudit(
      highCardinalityRows(900),
      accept
    );
    // An adjusted effect that silently covered 32 of 300 tool levels would be a
    // false scope claim, so the exclusion has to reach the summary and evidence.
    expect(findings[0].summary).toMatch(/best-supported/);
    expect(findings[0].evidenceRefs.some((r) => r.startsWith('design-terms:'))).toBe(
      true
    );
    expect(
      findings[0].evidenceRefs.some((r) => r.startsWith('levels-truncated:tool='))
    ).toBe(true);
  });

  it('keeps evidence reproducible — no wall-clock leaks into the claim', async () => {
    const rows = highCardinalityRows(900);
    const a = await runNaturalExperimentAudit(rows, accept);
    const b = await runNaturalExperimentAudit(rows, accept);
    // durationMs is telemetry, never evidence: two runs of the same corpus must
    // produce byte-identical evidence.
    expect(a[0].evidenceRefs).toEqual(b[0].evidenceRefs);
    expect(a[0].summary).toBe(b[0].summary);
  });

  it('a malformed budget restores the default — it never disables the refusal', () => {
    // The fail-open shape that made #3076 and #3452 green-but-inert: a budget
    // resolved to NaN makes every comparison false, so the check reports itself
    // as enforced while refusing nothing.
    const rows = highCardinalityRows(900);
    for (const bad of [NaN, -1, Infinity, undefined as unknown as number]) {
      const result = fitNaturalExperiment(rows, {
        ...DEFAULT_FIT_OPTIONS,
        maxToolLevels: bad,
      });
      if (result.status !== 'fit') throw new Error('expected a fit');
      expect(result.diagnostics.terms).toBeLessThanOrEqual(K_CEILING);
    }
    // Same for the row ceiling: an unusable value must still refuse an
    // oversized corpus rather than wave it through.
    const oversized = highCardinalityRows(DEFAULT_FIT_OPTIONS.maxRows + 1);
    for (const bad of [NaN, -5, undefined as unknown as number]) {
      const result = fitNaturalExperiment(oversized, {
        ...DEFAULT_FIT_OPTIONS,
        maxRows: bad,
      });
      expect(result.status).toBe('insufficient');
      expect(result.diagnostics.augmentedCells).toBe(0);
    }
  });

  it('refuses at exactly one over the ceiling and admits exactly at it', () => {
    // A budget that is off by one at its own boundary is the "just-over
    // threshold silently accepted" failure the gate exists to prevent.
    const atCeiling = fitNaturalExperiment(
      highCardinalityRows(120),
      { ...DEFAULT_FIT_OPTIONS, maxRows: 120 }
    );
    // Exactly at the ceiling is ADMITTED: the fit ran, so there is no rejection.
    expect(atCeiling.status).toBe('fit');
    expect(atCeiling.diagnostics.rejectionReason).toBeNull();

    const overCeiling = fitNaturalExperiment(
      highCardinalityRows(121),
      { ...DEFAULT_FIT_OPTIONS, maxRows: 120 }
    );
    expect(overCeiling.status).toBe('insufficient');
    expect(overCeiling.diagnostics.rejectionReason).toMatch(/declared ceiling/);
    expect(overCeiling.diagnostics.augmentedCells).toBe(0);
  });

  it('never reports "cannot evaluate" as within budget', () => {
    // An empty or unfittable input must carry a rejection reason, never a
    // silent zero-cost success.
    for (const rows of [[], highCardinalityRows(3)]) {
      const result = fitNaturalExperiment(rows);
      expect(result.status).toBe('insufficient');
      expect(result.diagnostics.rejectionReason).toBeTruthy();
    }
  });

  it('reports the design it already allocated on a post-build refusal', () => {
    // Codex review: a refusal reached AFTER buildDesignMatrix has really
    // allocated an n-by-k matrix. Falling back to the zero defaults emitted
    // `design-terms:0` as EVIDENCE — a false claim that no design was built,
    // hiding the very cost these diagnostics exist to expose.
    // 30 rows over 10 tool levels of 3: clears minSessions(8) on raw input, but
    // level restriction leaves too few usable rows to fit.
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        sessionId: `s${i}`,
        outcome: i % 2 === 0 ? 1 : 0,
        model: i < 3 ? 'opus' : 'sonnet',
        toolFactor: `t-${Math.floor(i / 3)}`,
        difficulty: 100 + i,
      });
    }
    const result = fitNaturalExperiment(rows, {
      ...DEFAULT_FIT_OPTIONS,
      minSessions: 25,
      maxToolLevels: 2,
    });
    if (result.status !== 'insufficient') throw new Error('expected a refusal');
    // A design WAS built, so terms/rowsFitted must reflect it, not report zero.
    expect(result.diagnostics.terms).toBeGreaterThan(0);
    expect(result.diagnostics.rowsFitted).toBeGreaterThan(0);
    expect(result.diagnostics.rejectionReason).toBeTruthy();
  });

  it('never emits design-terms:0 evidence when a design was allocated', async () => {
    const rows: NaturalExperimentRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        sessionId: `s${i}`,
        outcome: i % 2 === 0 ? 1 : 0,
        model: i < 3 ? 'opus' : 'sonnet',
        toolFactor: `t-${Math.floor(i / 3)}`,
        difficulty: 100 + i,
      });
    }
    const result = fitNaturalExperiment(rows, {
      ...DEFAULT_FIT_OPTIONS,
      minSessions: 25,
      maxToolLevels: 2,
    });
    if (result.status !== 'insufficient') throw new Error('expected a refusal');
    // The emitted claim must not contradict what actually happened.
    const findings = await runNaturalExperimentAudit(rows, accept, {
      ...DEFAULT_FIT_OPTIONS,
      minSessions: 25,
      maxToolLevels: 2,
    });
    expect(findings[0].evidenceRefs).not.toContain('design-terms:0');
    expect(
      findings[0].evidenceRefs.some((r) => r === `design-terms:${result.diagnostics.terms}`)
    ).toBe(true);
  });

  it('times the WHOLE fit, including the design build', () => {
    // Codex review: the clock used to start after buildDesignMatrix, so the
    // reported duration omitted level refinement, row filtering, standardization
    // and the n-by-k allocation — understating cost MOST on exactly the large
    // corpora the budget exists to bound, since the design build is the part
    // that scales with n.
    const result = fitNaturalExperiment(highCardinalityRows(2400));
    if (result.status !== 'fit') throw new Error('expected a fit');
    // fitOls alone sees only 96 retained rows; the design build walks 2,400.
    // A timer covering just the solve cannot see that work at all.
    expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.diagnostics.durationMs)).toBe(true);
    expect(result.diagnostics.rowsIn).toBe(2400);
  });

  it('discloses rows dropped by level restriction in the claim', async () => {
    const findings = await runNaturalExperimentAudit(
      highCardinalityRows(900),
      accept
    );
    // "fitted 96 sessions" alone reads as if 96 were all there was.
    expect(findings[0].evidenceRefs).toContain('rows-in:900');
  });

  it('leaves a realistic low-cardinality fit unchanged', () => {
    // The budget must be inert on data that never approaches it: same
    // coefficients, same n, nothing truncated.
    const rows = makeRows();
    const result = fitNaturalExperiment(rows, DEFAULT_FIT_OPTIONS);
    if (result.status !== 'fit') throw new Error('expected a fit');
    expect(result.diagnostics.levelsTruncated).toBe(false);
    expect(result.diagnostics.rowsFitted).toBe(result.n);
    expect(result.diagnostics.rowsIn).toBe(rows.length);
    expect(result.diagnostics.terms).toBe(result.coefficients.length);
  });
});
