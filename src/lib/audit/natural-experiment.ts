/**
 * Tier-3 audit: natural-experiment regression (#605 / #744).
 *
 * History is an observational natural experiment: different sessions ran under
 * different models and tool mixes, and they ended in different outcomes. The
 * naive read ("model X has a higher success rate, so model X is better") is
 * confounded — harder tasks self-select heavier models, so a heavier model can
 * LOOK worse simply because it was handed the hard problems. This audit fits a
 * small ordinary-least-squares (OLS) regression of the per-session OUTCOME on the
 * categorical model/tool factors WITH a per-session task-difficulty proxy as a
 * CONTROL COVARIATE, so that selection bias is partialled out. Each factor
 * level's reported coefficient is the ADJUSTED effect — the effect after holding
 * difficulty fixed — and the judge translates the fitted table into plain
 * language.
 *
 * Honesty contract: this is a coarse lens, not a publication-grade causal model.
 * We report adjusted coefficients and a SIMPLE significance flag (a coarse t-like
 * ratio of coefficient to its standard error), never a p-value or a causal claim
 * we cannot defend. When cells are too thin to fit responsibly, we emit ONE
 * low-confidence "insufficient data" finding rather than a spurious fit.
 *
 * Deterministic core (pure, unit-tested without the judge):
 *   - {@link buildDesignMatrix} one-hot encodes the categorical factors (dropping
 *     one reference level per factor to avoid collinearity) and standardizes the
 *     difficulty covariate, producing the design matrix + a column legend.
 *   - {@link fitOls} solves the normal equations via Gaussian elimination with a
 *     singularity guard — it NEVER throws on a rank-deficient matrix, it degrades.
 *   - {@link fitNaturalExperiment} wraps the two with the insufficient-data gate.
 *
 * Judge step ({@link runNaturalExperimentAudit}): one isolated judge call routes
 * the fitted coefficient table through the model for interpretation; on judge
 * failure we still emit the coefficients (low confidence) rather than dropping
 * everything.
 *
 * SERVER-ONLY (runs behind /api/audit.json with the rest of the harness).
 */
import type { AuditFinding, AuditConfidence } from './types';
import type { JudgeFn } from './judge-types';

/**
 * One per-session observation. `outcome` is the regression target (1 = good,
 * 0 = bad, from `parse-timeline-success.computeSessionOutcomes`); `model` and
 * `toolFactor` are the categorical factors; `difficulty` is the raw task-
 * magnitude proxy (e.g. total tokens), standardized internally before the fit.
 */
export interface NaturalExperimentRow {
  sessionId: string;
  /** 0 or 1 — the session's good/bad outcome label. */
  outcome: 0 | 1;
  /** Coarse model family, e.g. "opus" / "sonnet" / "haiku" / "other". */
  model: string;
  /** Coarse tool factor, e.g. the dominant tool name or a tool-count bucket. */
  toolFactor: string;
  /** Raw per-session difficulty proxy (token total or tool-call count). */
  difficulty: number;
}

export interface FitOptions {
  /**
   * A categorical LEVEL must appear in at least this many rows to be modeled —
   * thinner levels would make a coefficient meaningless. Default 3.
   */
  minPerCell: number;
  /**
   * The whole dataset must clear this many rows before we fit at all. A handful
   * of sessions can't support a multi-factor regression. Default 8.
   */
  minSessions: number;
  /**
   * Coarse |coefficient / standard-error| ratio above which a level is flagged
   * "significant". ~2 is the textbook two-sigma rule of thumb; we keep it as an
   * honest heuristic, NOT a p-value. Default 2.
   */
  significanceThreshold: number;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = {
  minPerCell: 3,
  minSessions: 8,
  significanceThreshold: 2,
};

/** One fitted coefficient: a design-matrix column and its estimate. */
export interface Coefficient {
  /** Column label, e.g. "model:opus", "tool:Bash", "difficulty", "(intercept)". */
  term: string;
  /** The factor this term belongs to ("model" / "tool" / "difficulty" / "intercept"). */
  factor: 'model' | 'tool' | 'difficulty' | 'intercept';
  /** For a categorical dummy, the level it encodes (vs. the reference level). */
  level?: string;
  /** The fitted (adjusted) coefficient. */
  estimate: number;
  /** Coarse standard error of the estimate (NaN if not computable). */
  standardError: number;
  /** |estimate| / standardError — the coarse t-like ratio (NaN if SE unusable). */
  tRatio: number;
  /** Whether |tRatio| cleared the significance threshold (honest heuristic). */
  significant: boolean;
}

/** The reference (dropped) level for one categorical factor. */
export interface ReferenceLevel {
  factor: 'model' | 'tool';
  level: string;
}

/** A successful fit: the adjusted coefficient table plus context. */
export interface FitResult {
  status: 'fit';
  /** Number of sessions the fit ran over (after dropping incomplete rows). */
  n: number;
  /** Coefficients, intercept first, then model dummies, tool dummies, difficulty. */
  coefficients: Coefficient[];
  /** The reference level dropped per categorical factor (the baseline). */
  references: ReferenceLevel[];
  /**
   * Factors that could not be contrasted and were held CONSTANT: the fit ran
   * only over rows at that level, and its coefficients say nothing about the
   * levels excluded (#3113). Empty when both factors were contrasted.
   */
  heldConstant: ReferenceLevel[];
  /** Mean outcome (overall good rate) — context for interpreting the intercept. */
  meanOutcome: number;
}

/** An insufficient-data verdict: we deliberately did NOT fit. */
export interface InsufficientResult {
  status: 'insufficient';
  /** Sessions available. */
  n: number;
  /** Human-readable reason (too few sessions / no varying factor / singular). */
  reason: string;
}

export type ExperimentResult = FitResult | InsufficientResult;

// --- Small self-contained linear algebra (no new dependency) ----------------

/**
 * Solve the linear system `A x = b` (A is square) via Gauss-Jordan elimination
 * with partial pivoting. Returns the solution AND the inverse of A (needed for
 * standard errors). Returns `null` when A is singular / rank-deficient (a tiny
 * pivot), so callers degrade instead of throwing on a degenerate design.
 */
function solveWithInverse(
  A: number[][],
  b: number[]
): { x: number[]; inverse: number[][] } | null {
  const n = A.length;
  // Augment [A | I] so the same elimination yields both the solution and A^-1.
  const M = A.map((row, i) => {
    const ident = new Array(n).fill(0);
    ident[i] = 1;
    return [...row, ...ident];
  });
  const rhs = [...b];

  for (let col = 0; col < n; col++) {
    // Partial pivot: swap in the row with the largest magnitude in this column.
    let pivotRow = col;
    let pivotMag = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const mag = Math.abs(M[r][col]);
      if (mag > pivotMag) {
        pivotMag = mag;
        pivotRow = r;
      }
    }
    // A near-zero pivot means the columns are collinear -> singular. Degrade.
    if (pivotMag < 1e-9) return null;
    if (pivotRow !== col) {
      [M[col], M[pivotRow]] = [M[pivotRow], M[col]];
      [rhs[col], rhs[pivotRow]] = [rhs[pivotRow], rhs[col]];
    }
    // Normalize the pivot row.
    const pivot = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= pivot;
    rhs[col] /= pivot;
    // Eliminate this column from every other row.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= factor * M[col][j];
      rhs[r] -= factor * rhs[col];
    }
  }

  const inverse = M.map((row) => row.slice(n));
  return { x: rhs, inverse };
}

/** Matrix transpose-times-matrix: returns X' X (k x k) given X (m x k). */
function xtx(X: number[][]): number[][] {
  const m = X.length;
  const k = X[0]?.length ?? 0;
  const out = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let sum = 0;
      for (let r = 0; r < m; r++) sum += X[r][i] * X[r][j];
      out[i][j] = sum;
      out[j][i] = sum;
    }
  }
  return out;
}

/** Matrix transpose-times-vector: returns X' y (length k) given X (m x k), y (m). */
function xty(X: number[][], y: number[]): number[] {
  const k = X[0]?.length ?? 0;
  const out = new Array(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    for (let j = 0; j < k; j++) out[j] += X[r][j] * y[r];
  }
  return out;
}

// --- Design matrix + OLS fit ------------------------------------------------

/** Distinct levels of a factor in dataset order, with their row counts. */
function levelCounts(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/**
 * How one categorical factor enters the design.
 *
 * `modeled` lists every level with at least `minPerCell` rows — the ONLY levels
 * whose rows may stay in the sample. `contrast` is non-null only when two or more
 * levels qualify, in which case the most common qualifying level is the dropped
 * reference (so coefficients read as "vs. the typical baseline").
 *
 * The split matters (#3113): a factor with a single qualifying level cannot be
 * contrasted, but that is NOT the same as a constant factor. If its thin levels
 * were left in the sample while no column encoded them, their variation would
 * still move the outcome and could load onto whichever factor IS modeled —
 * manufacturing a false "adjusted" edge. So an uncontrastable factor is held
 * CONSTANT at its single qualifying level and every other row is dropped.
 */
interface FactorLevels {
  /** Levels with >= minPerCell rows, descending by count then name. */
  modeled: string[];
  /** Reference + dummy levels, or null when fewer than two levels qualify. */
  contrast: { reference: string; dummies: string[] } | null;
}

function chooseLevels(values: string[], minPerCell: number): FactorLevels {
  const counts = levelCounts(values);
  const qualifying = [...counts.entries()]
    .filter(([, c]) => c >= minPerCell)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([level]) => level);
  if (qualifying.length < 2) return { modeled: qualifying, contrast: null };
  const [reference, ...dummies] = qualifying;
  return { modeled: qualifying, contrast: { reference, dummies } };
}

/** The built design matrix plus the legend needed to label coefficients. */
interface Design {
  X: number[][];
  y: number[];
  /** Column terms, index-aligned with each design-matrix column. */
  terms: Coefficient['term'][];
  factors: Coefficient['factor'][];
  levels: (string | undefined)[];
  references: ReferenceLevel[];
  /**
   * Factors that could NOT be contrasted and were therefore held constant: the
   * fit covers only rows at that level (#3113). Reported so a reader never reads
   * an adjusted effect as spanning levels the sample no longer contains.
   */
  heldConstant: ReferenceLevel[];
  /** Rows actually used (those whose categorical levels were all modeled). */
  usedRows: NaturalExperimentRow[];
  /** Mean/std of difficulty used for standardization (for transparency). */
  difficultyMean: number;
  difficultyStd: number;
}

/**
 * Build the OLS design matrix from the rows: an intercept column, one-hot dummies
 * for the modeled model + tool levels (reference dropped), and the standardized
 * difficulty covariate (z-score; the control). Rows whose model OR tool level
 * fell below `minPerCell` are dropped — keeping them would push their mass onto
 * the reference and bias it.
 *
 * That drop is UNCONDITIONAL, including for a factor that could not be contrasted
 * at all (#3113). A factor with one qualifying level is held constant at it; its
 * thin levels leave the sample rather than sitting in the data unmodeled, where
 * their variation could load onto the factor that IS reported as adjusted.
 *
 * Because dropping rows SHRINKS the cells of the other factor, the level choice
 * is then re-run on what survived, repeatedly, until the sample stops changing.
 * Otherwise a level that qualified only on rows the restriction later removed
 * would keep its dummy, and a coefficient could rest on a single session despite
 * the `minPerCell` floor. At the fixed point every modeled level provably clears
 * `minPerCell` IN THE RETAINED SAMPLE, which is the sample the fit reports on.
 *
 * Returns `null` when neither categorical factor has two qualifying levels (there
 * is nothing to contrast, so no experiment to run), or when a factor has no
 * qualifying level at all (nothing survives to hold it constant at) — the caller
 * turns that into an insufficient-data result.
 */
export function buildDesignMatrix(
  rows: NaturalExperimentRow[],
  minPerCell: number
): Design | null {
  // Refine sample and levels together to a fixed point. Each non-final pass
  // strictly shrinks the sample, so this terminates in at most `rows.length`
  // passes; the bound is a defensive guard, not the expected exit.
  let usedRows = rows;
  let modelLevels = chooseLevels([], minPerCell);
  let toolLevels = modelLevels;
  let converged = false;
  for (let pass = 0; pass <= rows.length; pass++) {
    modelLevels = chooseLevels(
      usedRows.map((r) => r.model),
      minPerCell
    );
    toolLevels = chooseLevels(
      usedRows.map((r) => r.toolFactor),
      minPerCell
    );
    // Every level of a factor is thin -> no level to hold it constant at, and any
    // sample we could keep would be entirely unmodeled variation.
    if (modelLevels.modeled.length === 0 || toolLevels.modeled.length === 0) {
      return null;
    }
    // Keep only rows whose levels are all MODELED — for a contrasted factor that
    // means dummy-or-reference, for an uncontrasted one its single qualifying
    // level. Never keep heterogeneous levels of an omitted factor.
    const retained = usedRows.filter(
      (r) =>
        modelLevels.modeled.includes(r.model) &&
        toolLevels.modeled.includes(r.toolFactor)
    );
    if (retained.length === usedRows.length) {
      // Nothing dropped this pass: the levels above were computed on exactly
      // this sample, so they are the final, self-consistent choice.
      converged = true;
      break;
    }
    if (retained.length === 0) return null;
    usedRows = retained;
  }
  if (!converged) return null;

  // Need at least one categorical factor that varies IN THE RETAINED SAMPLE;
  // otherwise the only regressor is difficulty and there's no model/tool
  // contrast to interpret. A factor can lose its contrast during refinement —
  // that is the point: its second level no longer clears the floor.
  if (!modelLevels.contrast && !toolLevels.contrast) return null;

  // Standardize difficulty (z-score). A degenerate (zero-variance) difficulty
  // column collapses to all-zeros, which the singularity guard handles — but we
  // keep std=1 to avoid divide-by-zero NaNs poisoning the matrix.
  const diffs = usedRows.map((r) => r.difficulty);
  const difficultyMean = diffs.reduce((a, d) => a + d, 0) / diffs.length;
  const variance =
    diffs.reduce((a, d) => a + (d - difficultyMean) ** 2, 0) / diffs.length;
  const difficultyStd = Math.sqrt(variance) || 1;

  const terms: Coefficient['term'][] = ['(intercept)'];
  const factors: Coefficient['factor'][] = ['intercept'];
  const levels: (string | undefined)[] = [undefined];
  const references: ReferenceLevel[] = [];
  const heldConstant: ReferenceLevel[] = [];

  if (modelLevels.contrast) {
    references.push({ factor: 'model', level: modelLevels.contrast.reference });
    for (const lvl of modelLevels.contrast.dummies) {
      terms.push(`model:${lvl}`);
      factors.push('model');
      levels.push(lvl);
    }
  } else {
    heldConstant.push({ factor: 'model', level: modelLevels.modeled[0] });
  }
  if (toolLevels.contrast) {
    references.push({ factor: 'tool', level: toolLevels.contrast.reference });
    for (const lvl of toolLevels.contrast.dummies) {
      terms.push(`tool:${lvl}`);
      factors.push('tool');
      levels.push(lvl);
    }
  } else {
    heldConstant.push({ factor: 'tool', level: toolLevels.modeled[0] });
  }
  terms.push('difficulty');
  factors.push('difficulty');
  levels.push(undefined);

  const X: number[][] = [];
  const y: number[] = [];
  for (const r of usedRows) {
    const row: number[] = [1]; // intercept
    if (modelLevels.contrast) {
      for (const lvl of modelLevels.contrast.dummies) {
        row.push(r.model === lvl ? 1 : 0);
      }
    }
    if (toolLevels.contrast) {
      for (const lvl of toolLevels.contrast.dummies) {
        row.push(r.toolFactor === lvl ? 1 : 0);
      }
    }
    row.push((r.difficulty - difficultyMean) / difficultyStd);
    X.push(row);
    y.push(r.outcome);
  }

  return {
    X,
    y,
    terms,
    factors,
    levels,
    references,
    heldConstant,
    usedRows,
    difficultyMean,
    difficultyStd,
  };
}

/**
 * Solve OLS for the given design via the normal equations
 * `(X'X) beta = X'y`, then derive a coarse standard error per coefficient from
 * the residual variance and the diagonal of `(X'X)^-1`. Returns `null` on a
 * singular `X'X` (collinear columns) so the caller degrades to insufficient-data
 * — this is the "never throw on a singular matrix" guard.
 */
export function fitOls(
  design: Design,
  significanceThreshold: number
): FitResult | null {
  const { X, y, terms, factors, levels, references, heldConstant } = design;
  const A = xtx(X);
  const b = xty(X, y);
  const solved = solveWithInverse(A, b);
  if (!solved) return null;
  const { x: beta, inverse } = solved;

  // Residuals -> residual variance with a (n - k) degrees-of-freedom correction.
  const n = X.length;
  const k = X[0].length;
  let sse = 0;
  for (let r = 0; r < n; r++) {
    let pred = 0;
    for (let j = 0; j < k; j++) pred += X[r][j] * beta[j];
    const resid = y[r] - pred;
    sse += resid * resid;
  }
  const df = n - k;
  // With no residual degrees of freedom the SE is undefined; flag it as NaN
  // rather than inventing precision (the fit is saturated).
  const sigma2 = df > 0 ? sse / df : NaN;

  const coefficients: Coefficient[] = beta.map((estimate, j) => {
    const varCoef = sigma2 * inverse[j][j];
    const standardError =
      Number.isFinite(varCoef) && varCoef >= 0 ? Math.sqrt(varCoef) : NaN;
    const tRatio =
      Number.isFinite(standardError) && standardError > 0
        ? Math.abs(estimate) / standardError
        : NaN;
    return {
      term: terms[j],
      factor: factors[j],
      level: levels[j],
      estimate,
      standardError,
      tRatio,
      significant:
        Number.isFinite(tRatio) && tRatio >= significanceThreshold,
    };
  });

  const meanOutcome = y.reduce((a, v) => a + v, 0) / n;
  return {
    status: 'fit',
    n,
    coefficients,
    references,
    heldConstant,
    meanOutcome,
  };
}

/**
 * Top-level deterministic fit with the insufficient-data gate. Returns an
 * {@link InsufficientResult} (no spurious fit) when there are too few sessions,
 * when no categorical factor varies enough to contrast, or when the design is
 * singular; otherwise a {@link FitResult} with the adjusted coefficient table.
 * NEVER throws.
 */
export function fitNaturalExperiment(
  rows: NaturalExperimentRow[],
  options: FitOptions = DEFAULT_FIT_OPTIONS
): ExperimentResult {
  const { minPerCell, minSessions, significanceThreshold } = options;
  if (rows.length < minSessions) {
    return {
      status: 'insufficient',
      n: rows.length,
      reason:
        `Only ${rows.length} session(s) with a usable outcome; need at least ` +
        `${minSessions} before a multi-factor regression is meaningful.`,
    };
  }

  const design = buildDesignMatrix(rows, minPerCell);
  if (!design) {
    return {
      status: 'insufficient',
      n: rows.length,
      reason:
        'No model or tool factor has at least two levels with ' +
        `${minPerCell}+ sessions each, so there is no like-for-like contrast ` +
        'to regress (every comparison would rest on a single thin cell).',
    };
  }

  // Holding an uncontrastable factor constant can drop rows (#3113); re-apply the
  // sample-size gate to what actually survived rather than to the raw input.
  if (design.usedRows.length < minSessions) {
    return {
      status: 'insufficient',
      n: design.usedRows.length,
      reason:
        `Only ${design.usedRows.length} of ${rows.length} session(s) sit at a ` +
        `model/tool level with ${minPerCell}+ sessions behind it; the rest were ` +
        'excluded rather than left in the sample as unmodeled variation, which ' +
        `leaves fewer than the ${minSessions} sessions a fit needs.`,
    };
  }

  // A design with as many (or more) columns than rows is saturated / rank-
  // deficient — refuse rather than overfit.
  if (design.X.length <= design.X[0].length) {
    return {
      status: 'insufficient',
      n: design.usedRows.length,
      reason:
        `Design has ${design.X[0].length} terms but only ${design.X.length} ` +
        'usable sessions — too few observations per parameter to fit honestly.',
    };
  }

  const fit = fitOls(design, significanceThreshold);
  if (!fit) {
    return {
      status: 'insufficient',
      n: design.usedRows.length,
      reason:
        'The design matrix is singular (collinear factors), so no unique ' +
        'coefficients exist; refusing a spurious fit.',
    };
  }
  return fit;
}

// --- Judge interpretation + finding emission --------------------------------

/** Render a single coefficient as a compact, judge-readable line. */
function coefLine(c: Coefficient): string {
  const est = c.estimate.toFixed(3);
  const se = Number.isFinite(c.standardError)
    ? c.standardError.toFixed(3)
    : 'n/a';
  const flag = c.significant ? ' [significant]' : '';
  return `${c.term} = ${est} (SE ${se})${flag}`;
}

/** Render the whole fitted table as a compact block for the judge prompt. */
function renderTable(fit: FitResult): string {
  const refs = fit.references
    .map((r) => `${r.factor}=${r.level}`)
    .join(', ');
  const lines = fit.coefficients.map(coefLine).join('\n');
  const held = heldConstantNote(fit);
  return (
    `OLS of session outcome (1=good, 0=bad) on model + tool factors with ` +
    `standardized task-difficulty as a control covariate.\n` +
    `n=${fit.n} sessions; overall good-rate=${(fit.meanOutcome * 100).toFixed(0)}%.\n` +
    `Reference (baseline) levels: ${refs || 'none'}.\n` +
    (held ? `${held}\n` : '') +
    `Coefficients (adjusted for difficulty):\n${lines}`
  );
}

/**
 * Describe any factor held constant because it could not be contrasted (#3113),
 * so neither the judge nor the reader treats the fit as spanning levels that were
 * excluded from the sample. Empty string when both factors were contrasted.
 */
function heldConstantNote(fit: FitResult): string {
  if (fit.heldConstant.length === 0) return '';
  const parts = fit.heldConstant
    .map((h) => `${h.factor}=${h.level}`)
    .join(', ');
  return (
    `Held constant (too few sessions at any other level to contrast, so rows at ` +
    `other levels were excluded): ${parts}. The coefficients below apply only to ` +
    `sessions at those levels.`
  );
}

/**
 * Build the evidence refs for the finding: one anchor per modeled term plus the
 * reference baselines, so a reader can trace each adjusted coefficient.
 */
function evidenceFor(fit: FitResult): string[] {
  const refs = fit.coefficients
    .filter((c) => c.factor !== 'intercept')
    .map((c) => `coef:${c.term}=${c.estimate.toFixed(3)}`);
  for (const r of fit.references) refs.push(`baseline:${r.factor}=${r.level}`);
  // Trace the sample restriction too: an adjusted effect that only covers one
  // level of an omitted factor must say so in its evidence (#3113).
  for (const h of fit.heldConstant) {
    refs.push(`held-constant:${h.factor}=${h.level}`);
  }
  refs.push(`sessions-fitted:${fit.n}`);
  return refs;
}

/**
 * Run the natural-experiment audit. With insufficient data, emit ONE
 * low-confidence finding that says so (no spurious fit). Otherwise fit, then
 * route the coefficient table through the judge for a plain-language
 * interpretation and emit ONE finding carrying the table (summary + evidence) and
 * the judge's reading (judgeRationale). The single judge call is isolated in
 * try/catch: on failure we STILL emit the coefficients (low confidence) rather
 * than dropping the finding. NEVER throws.
 */
export async function runNaturalExperimentAudit(
  rows: NaturalExperimentRow[],
  judge: JudgeFn,
  options: FitOptions = DEFAULT_FIT_OPTIONS
): Promise<AuditFinding[]> {
  const result = fitNaturalExperiment(rows, options);

  if (result.status === 'insufficient') {
    return [
      {
        id: 'natural-experiment:insufficient-data',
        domain: 'quality',
        summary:
          `Not enough comparable sessions to regress outcome on model/tool ` +
          `factors with a difficulty control: ${result.reason}`,
        evidenceRefs: [`sessions:${result.n}`],
        judgeRationale:
          'No fit was attempted — reporting insufficient data is more honest ' +
          'than a coefficient table that rests on one or two sessions per cell.',
        confidence: 'low',
      },
    ];
  }

  const table = renderTable(result);
  const scope =
    result.heldConstant.length > 0
      ? ` The fit covers only sessions with ${result.heldConstant
          .map((h) => `${h.factor}=${h.level}`)
          .join(' and ')} (no other level had enough sessions to contrast).`
      : '';
  const summary =
    `Natural-experiment regression over ${result.n} sessions: after ` +
    `controlling for task difficulty, ` +
    summarizeAdjustedEffects(result) +
    ' (see coefficient table).' +
    scope;

  // The judge call is the only network-touching step; isolate it so a transient
  // failure still yields the deterministic coefficient table (low confidence).
  let rationale = '';
  // Default to the cautious 'low'; a successful judge call overrides it with the
  // model's own confidence, and the catch leaves this safe default in place.
  let confidence: AuditConfidence = 'low';
  try {
    const verdict = await judge({
      system:
        'You interpret a small ordinary-least-squares (OLS) regression run over ' +
        'a coding agent\'s session history as a natural experiment. The outcome ' +
        'is a binary session result (1=good, 0=bad). The regressors are model ' +
        'and tool factors (one-hot, one reference level dropped) plus a ' +
        'STANDARDIZED task-difficulty covariate included as a CONTROL so that ' +
        '"harder tasks self-select heavier models" selection bias is partialled ' +
        'out. So each factor coefficient is the ADJUSTED effect on the good-rate ' +
        'after holding difficulty fixed. Be honest and cautious: this is a coarse ' +
        'lens, not causal proof; do not assert p-values or causality. State in ' +
        'plain language which factors show a real adjusted edge (flagged ' +
        '[significant]) and which do not, and call out when difficulty itself ' +
        'explains most of the variation. Reply ONLY with JSON: ' +
        '{"isFinding": boolean, "rationale": string, "confidence": "low"|"medium"|"high"}.',
      user:
        `${table}\n\nInterpret these adjusted coefficients in plain language ` +
        'for the user. Which model/tool choices show a real edge once difficulty ' +
        'is controlled, and which apparent differences are just the harder tasks?',
    });
    if (verdict.rationale) rationale = verdict.rationale;
    confidence = verdict.confidence;
  } catch {
    rationale =
      'Judge interpretation was unavailable; reporting the fitted coefficients ' +
      'as-is. Coefficients are adjusted for task difficulty, so they reflect ' +
      'each factor\'s effect on the good-rate net of how hard its tasks were.';
    // confidence stays at the cautious default 'low'.
  }

  return [
    {
      id: 'natural-experiment:regression',
      // Outcome quality is the subject; the confound-controlled comparison is a
      // quality judgement about which configurations actually do better.
      domain: 'quality',
      summary,
      evidenceRefs: evidenceFor(result),
      judgeRationale: rationale,
      confidence,
    },
  ];
}

/**
 * One-line deterministic summary of the adjusted effects (used in the finding
 * summary alongside the judge's prose): names the significant factor levels, or
 * says none cleared the bar. Pure — no judge.
 */
function summarizeAdjustedEffects(fit: FitResult): string {
  const sig = fit.coefficients.filter(
    (c) => c.factor !== 'intercept' && c.factor !== 'difficulty' && c.significant
  );
  if (sig.length === 0) {
    return 'no model or tool factor shows a statistically notable adjusted edge';
  }
  const parts = sig.map((c) => {
    const dir = c.estimate > 0 ? 'higher' : 'lower';
    return `${c.term} (${dir} good-rate)`;
  });
  return `${parts.join(', ')} stand out`;
}
