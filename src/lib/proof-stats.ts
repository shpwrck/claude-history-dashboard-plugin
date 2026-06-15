/**
 * proof-stats.ts — pure, deterministic statistics for the v0.4 proof batch
 * (#1077, epic #995). These helpers implement exactly the analysis plan frozen
 * in `docs/v0.4-proof-preregistration.md` §4–§5: paired-median cost delta, a
 * Wilcoxon signed-rank one-sided test, a *seeded* bootstrap confidence interval,
 * and the §5 decision rule that turns those into a PROVEN / NULL / REFUTED /
 * not-yet-provable verdict.
 *
 * Determinism is a hard requirement: the bootstrap takes an explicit seed and
 * uses a seeded PRNG (mulberry32) — `Math.random()` is never called, both
 * because the proof must be reproducible by a skeptic and because the argless
 * `Math.random` is unavailable in the locked-down environments this runs in.
 *
 * Everything here is pure: same inputs → same outputs, no I/O, no clock.
 */

/** One matched pair's per-arm summary cost (the median of its k runs per arm). */
export interface PairedCost {
  /** Control arm cost (recommendation withheld). */
  control: number;
  /** Treatment arm cost (recommendation injected). */
  treatment: number;
}

/** Median of a numeric array. Returns NaN for an empty array. */
export function median(values: number[]): number {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Paired deltas (treatment − control), one per pair, in input order. A negative
 * delta is a cost *reduction* under treatment (the pre-registered win direction).
 */
export function pairedDeltas(pairs: PairedCost[]): number[] {
  return pairs.map((p) => p.treatment - p.control);
}

/** The median of the paired deltas (treatment − control). */
export function pairedMedianDelta(pairs: PairedCost[]): number {
  return median(pairedDeltas(pairs));
}

/**
 * The paired-median delta expressed as a percentage of the median control cost.
 * Negative = cost reduction. Returns NaN when the median control cost is 0
 * (percentage undefined) or there are no pairs.
 */
export function pairedMedianPctDelta(pairs: PairedCost[]): number {
  if (pairs.length === 0) return NaN;
  const controlMedian = median(pairs.map((p) => p.control));
  if (!Number.isFinite(controlMedian) || controlMedian === 0) return NaN;
  return (pairedMedianDelta(pairs) / controlMedian) * 100;
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Wilcoxon signed-rank test on the paired deltas, one-sided in the
 * pre-registered direction (treatment *reduces* cost, i.e. deltas < 0).
 *
 * Returns `statistic` = W− (sum of ranks of the negative — cost-reducing —
 * deltas) and `pOneSided` = P(observing this much or more cost reduction under
 * H0). Zero deltas are dropped (standard Wilcoxon convention). Ties share the
 * average rank, and the p-value uses the normal approximation with a continuity
 * correction and a tie correction to the variance — appropriate for the small,
 * heavy-tailed paired samples the pre-registration assumes.
 *
 * With no non-zero deltas the test is undefined; `pOneSided` is 1 (no evidence).
 */
export function wilcoxonSignedRank(pairs: PairedCost[]): {
  statistic: number;
  pOneSided: number;
  n: number;
} {
  const deltas = pairedDeltas(pairs).filter((d) => d !== 0 && Number.isFinite(d));
  const n = deltas.length;
  if (n === 0) return { statistic: 0, pOneSided: 1, n: 0 };

  // Rank by absolute magnitude, averaging tied ranks.
  const indexed = deltas.map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }));
  indexed.sort((a, b) => a.abs - b.abs);
  const ranks = new Array(n).fill(0);
  let i = 0;
  const tieGroupSizes: number[] = [];
  while (i < n) {
    let j = i;
    while (j < n - 1 && indexed[j + 1].abs === indexed[i].abs) j++;
    const groupSize = j - i + 1;
    const avgRank = (i + 1 + (j + 1)) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    if (groupSize > 1) tieGroupSizes.push(groupSize);
    i = j + 1;
  }

  let wMinus = 0; // sum of ranks where delta < 0 (cost reduced under treatment)
  for (let k = 0; k < n; k++) {
    if (indexed[k].sign < 0) wMinus += ranks[k];
  }

  // Normal approximation. Under H0, W (either side) has mean n(n+1)/4 and
  // variance n(n+1)(2n+1)/24, reduced by the tie correction. One-sided in the
  // reduction direction: large W− (relative to its mean) is evidence FOR H1.
  const meanW = (n * (n + 1)) / 4;
  let varW = (n * (n + 1) * (2 * n + 1)) / 24;
  const tieCorrection =
    tieGroupSizes.reduce((acc, t) => acc + (t * t * t - t), 0) / 48;
  varW -= tieCorrection;
  if (varW <= 0) return { statistic: wMinus, pOneSided: 1, n };

  // Continuity-corrected z for P(W− >= observed) under H0.
  const z = (wMinus - meanW - 0.5) / Math.sqrt(varW);
  const pOneSided = 1 - normalCdf(z);
  return { statistic: wMinus, pOneSided: Math.min(1, Math.max(0, pOneSided)), n };
}

/** Seeded PRNG (mulberry32). Deterministic uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded bootstrap CI on the *median* of the paired deltas. Resamples the
 * deltas with replacement `iters` times, takes each resample's median, and
 * returns the two-sided `(alpha/2, 1 - alpha/2)` percentile interval. Fully
 * deterministic for a given seed. Returns `{lo: NaN, hi: NaN}` for no deltas.
 *
 * @param deltas paired deltas (treatment − control)
 * @param opts.iters bootstrap resamples (default 10000)
 * @param opts.alpha two-sided alpha (default 0.05 → 95% CI)
 * @param opts.seed PRNG seed (default 1)
 */
export function bootstrapCI(
  deltas: number[],
  opts: { iters?: number; alpha?: number; seed?: number } = {}
): { lo: number; hi: number; iters: number } {
  const iters = opts.iters ?? 10000;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 1;
  const finite = deltas.filter((d) => Number.isFinite(d));
  const n = finite.length;
  if (n === 0) return { lo: NaN, hi: NaN, iters };

  const rand = mulberry32(seed);
  const medians = new Array(iters);
  const sample = new Array(n);
  for (let b = 0; b < iters; b++) {
    for (let k = 0; k < n; k++) {
      sample[k] = finite[Math.floor(rand() * n)];
    }
    medians[b] = median(sample);
  }
  medians.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * iters);
  const hiIdx = Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1);
  return { lo: medians[loIdx], hi: medians[hiIdx], iters };
}

/** The verdict classes of the §5 decision rule. */
export type ProofStatVerdict = 'proven' | 'null' | 'refuted' | 'not-yet-provable';

/** The pre-registered minimum DECIDED-pair N (`v0.4-proof-preregistration.md` §3/§5). */
export const PRE_REGISTERED_MIN_DECIDED = 12;

/** The pre-registered minimum-detectable-effect (a >= 15% median cost reduction). */
export const PRE_REGISTERED_MDE_PCT = 15;

/** One-sided significance threshold (§5). */
export const PRE_REGISTERED_ALPHA = 0.05;

export interface DecideVerdictInput {
  /** Paired-median cost delta as a percentage of median control (negative = reduction). */
  pairedMedianPctDelta: number;
  /** Bootstrap 95% CI on the paired-median *absolute* cost delta. */
  ci: { lo: number; hi: number };
  /** Wilcoxon one-sided p-value (reduction direction). */
  p: number;
  /** Whether the quality-hold non-inferiority check passed. */
  qualityHoldPass: boolean;
  /** Number of DECIDED pairs that entered the effect estimate. */
  nDecided: number;
}

export interface DecideVerdictResult {
  verdict: ProofStatVerdict;
  /** Human-legible reasons each branch fired / failed (for the receipt + table). */
  reasons: string[];
}

/**
 * Implement the pre-registration §5 decision rule EXACTLY. Order matters:
 *
 *  - < 12 DECIDED pairs → NOT a null: "not yet provable" (an engineering bust).
 *  - REFUTED: treatment costs MORE with CI excluding 0, OR quality-hold fails.
 *  - PROVEN: median reduction >= 15% MDE AND CI entirely below 0 AND p < 0.05
 *    one-sided AND quality-hold passes (N>=12 already established).
 *  - NULL: N>=12 DECIDED but PROVEN unmet and not refuted.
 *
 * `ci` is on the absolute paired-median delta; "entirely below zero" = hi < 0,
 * "excludes zero on the positive side" (cost increase) = lo > 0.
 */
export function decideVerdict(input: DecideVerdictInput): DecideVerdictResult {
  const { pairedMedianPctDelta, ci, p, qualityHoldPass, nDecided } = input;
  const reasons: string[] = [];

  if (nDecided < PRE_REGISTERED_MIN_DECIDED) {
    reasons.push(
      `only ${nDecided} DECIDED pair(s) (< ${PRE_REGISTERED_MIN_DECIDED}); reported as "not yet provable", not a null`
    );
    return { verdict: 'not-yet-provable', reasons };
  }

  // REFUTED: treatment costs MORE with CI excluding zero, OR quality-hold fails.
  const costsMore = Number.isFinite(ci.lo) && ci.lo > 0;
  if (costsMore) {
    reasons.push(`treatment costs MORE: CI [${ci.lo}, ${ci.hi}] lies entirely above 0`);
    return { verdict: 'refuted', reasons };
  }
  if (!qualityHoldPass) {
    reasons.push('quality-hold non-inferiority check failed: treatment degraded task success');
    return { verdict: 'refuted', reasons };
  }

  // PROVEN: all four positive conditions (N already established).
  const meetsMde = pairedMedianPctDelta <= -PRE_REGISTERED_MDE_PCT;
  const ciBelowZero = Number.isFinite(ci.hi) && ci.hi < 0;
  const significant = p < PRE_REGISTERED_ALPHA;
  if (meetsMde && ciBelowZero && significant && qualityHoldPass) {
    reasons.push(
      `cost reduction ${(-pairedMedianPctDelta).toFixed(1)}% >= ${PRE_REGISTERED_MDE_PCT}% MDE`,
      `CI [${ci.lo}, ${ci.hi}] entirely below 0`,
      `Wilcoxon p=${p.toExponential(2)} < ${PRE_REGISTERED_ALPHA}`,
      'quality-hold passed'
    );
    return { verdict: 'proven', reasons };
  }

  // NULL: N reached, not refuted, but PROVEN unmet — say which conditions missed.
  if (!meetsMde)
    reasons.push(
      `median delta ${pairedMedianPctDelta.toFixed(1)}% does not reach the -${PRE_REGISTERED_MDE_PCT}% MDE`
    );
  if (!ciBelowZero) reasons.push(`CI [${ci.lo}, ${ci.hi}] does not lie entirely below 0`);
  if (!significant) reasons.push(`Wilcoxon p=${p.toExponential(2)} not < ${PRE_REGISTERED_ALPHA}`);
  return { verdict: 'null', reasons };
}
