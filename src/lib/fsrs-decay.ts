/**
 * FSRS-4.5 forgetting-curve decay, ported as a deterministic, pure TS util
 * (issue #2338; epic #2233 memory-lifecycle / #2280 staleness).
 *
 * Gives a continuous per-item `retrievability` in [0, 1] — "how likely is this
 * still true, given its access history" — for the staleness / memory-lifecycle
 * work, rather than a binary fresh/stale flag or an mtime heuristic.
 *
 * Source: mined 2026-07-07 from `nagisanzenin/engram` (`scripts/engram.py`,
 * stdlib-only, self-tested). The forgetting-curve core is the canonical FSRS-4.5
 * power curve; this file is a faithful port of engram.py's
 * retrievability / interval_for / init_stability / init_difficulty /
 * next_stability_recall / next_stability_forget / refit.
 *
 * Purity / determinism contract (matches this repo's `parse-*.ts` convention):
 * no I/O, no clock reads. Every function is pure and total — it takes any
 * "now"/elapsed as a PARAMETER (never `Date.now()`), tolerates partial/corrupt
 * input, and is defensively clamped so a bad value can never produce
 * NaN/Infinity or throw. The "as of <date>" labeling in {@link RefitResult} is a
 * formatting concern of the result object: the caller passes the date in.
 */

// --- Canonical FSRS-4.5 constants (engram.py) ------------------------------

/**
 * Power-curve decay exponent. FSRS-4.5 replaced FSRS-4's exponential curve with
 * this power function; `DECAY = -0.5` and `FACTOR` below are chosen together so
 * that retrievability equals exactly 0.9 when elapsed == stability.
 */
export const DECAY = -0.5;

/**
 * `FACTOR = 19 / 81`. With `DECAY = -0.5` this calibrates the curve to
 * `R(t = stability) = (1 + 19/81) ** -0.5 = (100/81) ** -0.5 = 0.9`.
 */
export const FACTOR = 19 / 81;

/**
 * FSRS-4.5 canonical default 17-weight vector (w0..w16), verbatim from
 * `nagisanzenin/engram` `scripts/engram.py`:
 *
 *   [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
 *    1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755]
 *
 * These are the day-one cold-start parameters; per-user calibration happens via
 * {@link refit}'s single `intervalMultiplier`, not by re-fitting these weights
 * (full FSRS parameter optimization is out of scope, matching engram v1).
 */
export const FSRS_45_DEFAULT_WEIGHTS: readonly number[] = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474,
  0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

/** Default target retention (engram RETENTION_DEFAULT). */
export const RETENTION_DEFAULT = 0.9;
/** Retention clamp bounds so a corrupt `retention` can't divide-by-zero/explode. */
export const RETENTION_MIN = 0.7;
export const RETENTION_MAX = 0.97;
/** Interval-multiplier clamp bounds (engram MULTIPLIER_MIN/MAX; also refit clamp). */
export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 1.5;
/** Max scheduling interval in days (engram INTERVAL_MAX). */
export const INTERVAL_MAX = 365;
/** Stability floor/ceiling (engram clamps stability to this band). */
export const STABILITY_MIN = 0.1;
export const STABILITY_MAX = 36500;
/** Minimum review receipts (with predictions) before {@link refit} will fit. */
export const MIN_REFIT_RECEIPTS = 50;

// --- Review grades ----------------------------------------------------------

/**
 * FSRS review grade. Mirrors engram's `RATINGS`: 1=again (a lapse), 2=hard,
 * 3=good, 4=easy (2..4 are recalls of increasing strength). In our domain a
 * memory note / recommendation is the "item": re-read or re-cited without
 * contradiction is a recall ({@link GOOD} by default, {@link HARD}/{@link EASY}
 * for a weaker/stronger recall); found-stale or overridden is a lapse
 * ({@link AGAIN}).
 */
export type ReviewGrade = 1 | 2 | 3 | 4;
/** Lapse: item was found stale / contradicted / overridden. */
export const AGAIN: ReviewGrade = 1;
/** Weak recall. */
export const HARD: ReviewGrade = 2;
/** Normal recall: re-read / re-cited without contradiction. */
export const GOOD: ReviewGrade = 3;
/** Strong recall. */
export const EASY: ReviewGrade = 4;

/** Per-item memory state carried across reviews. */
export interface ItemMemoryState {
  /** FSRS stability (days): larger = decays slower. */
  stability: number;
  /** FSRS difficulty in [1, 10]: larger = harder to retain. */
  difficulty: number;
}

// --- Small internal helpers -------------------------------------------------

/** engram `clamp(x, lo, hi) = max(lo, min(hi, x))`. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Coerce to a finite number, falling back when NaN/Infinity/non-number. */
function finite(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/** Round to a valid review grade in [1, 4]. */
function normalizeGrade(g: number): ReviewGrade {
  return clamp(Math.round(finite(g, GOOD)), AGAIN, EASY) as ReviewGrade;
}

// --- Core FSRS-4.5 forgetting curve ----------------------------------------

/**
 * Continuous retrievability in [0, 1] — the decay score. Faithful port of
 * engram `retrievability(elapsed_days, stability)`:
 *   `(1 + FACTOR * elapsed / stability) ** DECAY`.
 *
 * Defensive clamps (this is the query-time staleness score, so corrupt inputs
 * must degrade, never crash):
 *  - `stability <= 0` or non-finite -> 0 (unknown-strength item is not trusted).
 *  - non-finite elapsed -> 0 (an item whose age we can't compute is treated as
 *    fully decayed, the conservative choice for a staleness signal).
 *  - negative elapsed (a "future" last-review) -> clamped to 0 elapsed -> 1.
 *  - result clamped to [0, 1] and any residual non-finite mapped to 0.
 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (!Number.isFinite(stability) || stability <= 0) return 0;
  if (!Number.isFinite(elapsedDays)) return 0;
  const elapsed = Math.max(0, elapsedDays);
  const r = Math.pow(1 + (FACTOR * elapsed) / stability, DECAY);
  if (!Number.isFinite(r)) return 0;
  return clamp(r, 0, 1);
}

/**
 * Invert the forgetting curve to a next-review interval in days. Faithful port
 * of engram `interval_for(stability, retention, multiplier)`:
 *   `stability / FACTOR * (retention ** (1/DECAY) - 1) * multiplier`,
 * rounded and clamped to `[1, INTERVAL_MAX]`.
 *
 * Clamps guarantee a corrupt `retention` (0 would divide-by-zero through
 * `retention ** (1/DECAY) = 1/retention^2`) or a negative/huge `multiplier`
 * can't explode: `retention` is clamped into `[RETENTION_MIN, RETENTION_MAX]`
 * and `multiplier` into `[MULTIPLIER_MIN, MULTIPLIER_MAX]` before use.
 */
export function intervalFor(
  stability: number,
  retention: number = RETENTION_DEFAULT,
  multiplier = 1,
): number {
  const s = Math.max(0, finite(stability, 0));
  const r = clamp(finite(retention, RETENTION_DEFAULT), RETENTION_MIN, RETENTION_MAX);
  const m = clamp(finite(multiplier, 1), MULTIPLIER_MIN, MULTIPLIER_MAX);
  const days = (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1) * m;
  return clamp(Math.round(finite(days, 1)), 1, INTERVAL_MAX);
}

/**
 * Initial stability for a first review of grade `g`. engram
 * `init_stability(g) = clamp(W[g-1], 0.1, 100)`.
 */
export function initStability(grade: ReviewGrade | number): number {
  const g = normalizeGrade(grade);
  return clamp(FSRS_45_DEFAULT_WEIGHTS[g - 1], STABILITY_MIN, 100);
}

/**
 * Initial difficulty for a first review of grade `g`. engram
 * `init_difficulty(g) = clamp(W[4] - (g-3)*W[5], 1, 10)`.
 */
export function initDifficulty(grade: ReviewGrade | number): number {
  const g = normalizeGrade(grade);
  return clamp(
    FSRS_45_DEFAULT_WEIGHTS[4] - (g - 3) * FSRS_45_DEFAULT_WEIGHTS[5],
    1,
    10,
  );
}

/**
 * Stability after a successful recall (grows). Faithful port of engram
 * `next_stability_recall(d, s, r, g)`. A HARD recall applies `W[15]` penalty,
 * an EASY recall applies `W[16]` bonus; GOOD applies neither.
 */
export function nextStabilityRecall(
  difficulty: number,
  stability: number,
  r: number,
  grade: ReviewGrade | number,
): number {
  const W = FSRS_45_DEFAULT_WEIGHTS;
  const d = clamp(finite(difficulty, 5), 1, 10);
  const s = Math.max(STABILITY_MIN, finite(stability, STABILITY_MIN));
  const rr = clamp(finite(r, RETENTION_DEFAULT), 0, 1);
  const g = normalizeGrade(grade);
  const hardPenalty = g === HARD ? W[15] : 1;
  const easyBonus = g === EASY ? W[16] : 1;
  const grow =
    Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp(W[10] * (1 - rr)) - 1) *
    hardPenalty *
    easyBonus;
  const next = s * (1 + grow);
  return clamp(finite(next, s), STABILITY_MIN, STABILITY_MAX);
}

/**
 * Stability after a lapse (shrinks). Faithful port of engram
 * `next_stability_forget(d, s, r)`. Hard cap: `min(sf, s)` — a lapse can NEVER
 * increase stability — and an explicit `STABILITY_MAX` ceiling so an incoming
 * stability already above the band can't propagate out of range.
 */
export function nextStabilityForget(
  difficulty: number,
  stability: number,
  r: number,
): number {
  const W = FSRS_45_DEFAULT_WEIGHTS;
  const d = clamp(finite(difficulty, 5), 1, 10);
  const s = Math.max(STABILITY_MIN, finite(stability, STABILITY_MIN));
  const rr = clamp(finite(r, RETENTION_DEFAULT), 0, 1);
  const sf =
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - rr));
  // min(sf, s) is the "lapse never increases stability" cap; clamp keeps it in
  // band without ever raising it above the incoming stability `s`, and the
  // Math.min(s, STABILITY_MAX) upper bound clamps explicitly to the ceiling so
  // an out-of-band incoming stability can't leak through (belt-and-suspenders —
  // a lapse always shrinks, but the clamp guarantees the band).
  const capped = Math.min(finite(sf, s), s);
  return clamp(capped, STABILITY_MIN, Math.min(s, STABILITY_MAX));
}

// --- Domain mapping: memory notes / recommendations as decaying items -------

/**
 * Seed a new item's memory state from its first review grade (default
 * {@link GOOD}). Maps a freshly-written / first-seen memory note or
 * recommendation onto FSRS state.
 */
export function initItemState(grade: ReviewGrade | number = GOOD): ItemMemoryState {
  const g = normalizeGrade(grade);
  return { stability: initStability(g), difficulty: initDifficulty(g) };
}

/**
 * Record a RECALL — the item was re-read / re-cited without contradiction. Grows
 * stability along the FSRS recall path. `grade` selects recall strength
 * (HARD/GOOD/EASY); an {@link AGAIN} is coerced up to {@link HARD} because a
 * recall is by definition not a lapse (use {@link recordLapse} for lapses).
 * Difficulty is carried unchanged (FSRS difficulty re-estimation is out of scope
 * for this decay util — issue #2338 scopes stability + retrievability) aside from
 * a defensive re-clamp into [1, 10] so a caller passing an unclamped difficulty
 * can't propagate it out of range through the returned state.
 *
 * (Target retention is a SCHEDULING input for {@link intervalFor}, not a stability
 * update input — the recall math uses the observed retrievability `r` — so it is
 * intentionally not a parameter here.)
 */
export function recordRecall(
  state: ItemMemoryState,
  elapsedDays: number,
  grade: ReviewGrade | number = GOOD,
): ItemMemoryState {
  const g = clamp(normalizeGrade(grade), HARD, EASY) as ReviewGrade;
  const r = retrievability(elapsedDays, state.stability);
  return {
    stability: nextStabilityRecall(state.difficulty, state.stability, r, g),
    difficulty: clamp(finite(state.difficulty, 5), 1, 10),
  };
}

/**
 * Record a LAPSE — the item was found stale / contradicted / overridden. Shrinks
 * stability along the FSRS forget path, hard-capped so a lapse never increases
 * stability. Difficulty is carried unchanged (see {@link recordRecall}) aside
 * from the same defensive re-clamp into [1, 10].
 */
export function recordLapse(
  state: ItemMemoryState,
  elapsedDays: number,
): ItemMemoryState {
  const r = retrievability(elapsedDays, state.stability);
  return {
    stability: nextStabilityForget(state.difficulty, state.stability, r),
    difficulty: clamp(finite(state.difficulty, 5), 1, 10),
  };
}

// --- Cold-start + evergreen: evidence-gated refit ---------------------------

/**
 * One review receipt with a recorded prediction, the evidence {@link refit}
 * consumes. Mirrors engram's review receipts: a `grade` (the observed rating)
 * plus the `predictedRetrievability` the model expected at review time. A
 * receipt is ignored unless it carries BOTH a finite observed `grade` (no
 * outcome = can't count it as a recall or a lapse) and a finite
 * `predictedRetrievability` in [0, 1] (retrievability is a probability, so an
 * out-of-range prediction is corrupt evidence).
 */
export interface RefitReceipt {
  /** Observed rating for this review (AGAIN = lapse; 2..4 = recall). */
  grade: ReviewGrade | number;
  /** Retrievability the model PREDICTED at review time; null/undefined = none. */
  predictedRetrievability?: number | null;
}

/** Successful per-user calibration. */
export interface RefitOk {
  ok: true;
  /** Fitted interval multiplier, clamped to [MULTIPLIER_MIN, MULTIPLIER_MAX]. */
  intervalMultiplier: number;
  /** Count of usable receipts (finite grade + in-range [0,1] prediction) the fit used. */
  receipts: number;
  /** Observed recall rate (fraction of non-lapse reviews). */
  observedRecall: number;
  /** Mean predicted retrievability across usable receipts. */
  predictedRecall: number;
  /** Optional "as of <date>" label supplied by the caller (never read here). */
  asOf?: string;
}

/**
 * Insufficient-evidence refusal: honest reason, falls back to the cold-start
 * default multiplier of 1 rather than fitting on thin data. Mirrors our
 * "demote to as-of-<date> until enough evidence" rule.
 */
export interface RefitInsufficient {
  ok: false;
  reason: string;
  /** Cold-start default — no per-user adjustment applied. */
  intervalMultiplier: 1;
  usingDefault: true;
  /** Count of usable receipts seen (< MIN_REFIT_RECEIPTS). */
  receipts: number;
  /** Optional "as of <date>" label supplied by the caller (never read here). */
  asOf?: string;
}

export type RefitResult = RefitOk | RefitInsufficient;

/**
 * Fit a single per-user `intervalMultiplier` from review receipts (engram
 * `cmd_refit`, faithful port). Cold-start + evergreen, both halves:
 *  - Cold start: with no fit yet, callers use multiplier 1 (the default curve).
 *  - Evergreen: once `>= MIN_REFIT_RECEIPTS` (50) receipts-with-predictions
 *    accumulate, fit one multiplier clamped to `[0.5, 1.5]` so scheduling
 *    matches THIS user's actual staleness cadence.
 *  - Below threshold: REFUSE with an honest reason and `intervalMultiplier: 1`
 *    rather than fit on thin data.
 *
 * Pure: `asOf` is an optional caller-supplied label for the result; this
 * function never reads a clock.
 *
 * @param receipts review receipts (only those with a finite observed grade AND a
 *                 finite prediction in [0, 1] count).
 * @param asOf     optional "as of <date>" label to stamp on the result.
 */
export function refit(receipts: readonly RefitReceipt[], asOf?: string): RefitResult {
  const usable = (Array.isArray(receipts) ? receipts : []).filter((r) => {
    if (r == null) return false;
    // Reject an out-of-range prediction: retrievability is a probability, so a
    // predicted value outside [0, 1] is corrupt evidence, not a comparison point.
    const pred = r.predictedRetrievability as number;
    if (!Number.isFinite(pred) || pred < 0 || pred > 1) return false;
    // Drop receipts with no observed grade: without an outcome we can't count
    // the review as a recall or a lapse (normalizeGrade would otherwise coerce a
    // missing grade up to GOOD and silently inflate observedRecall).
    if (!Number.isFinite(r.grade as number)) return false;
    return true;
  });
  const n = usable.length;

  if (n < MIN_REFIT_RECEIPTS) {
    return {
      ok: false,
      reason:
        `insufficient evidence: need >= ${MIN_REFIT_RECEIPTS} review receipts ` +
        `with predictions, have ${n}; using default curve` +
        (asOf ? ` (as of ${asOf})` : ''),
      intervalMultiplier: 1,
      usingDefault: true,
      receipts: n,
      ...(asOf ? { asOf } : {}),
    };
  }

  const observed =
    usable.reduce((acc, r) => acc + (normalizeGrade(r.grade) !== AGAIN ? 1 : 0), 0) / n;
  const predicted =
    usable.reduce((acc, r) => acc + (r.predictedRetrievability as number), 0) / n;

  // inv(r): proportional to elapsed/S at recall probability r along the power
  // curve. r is clamped into [0.5, 0.999] so inv is always finite and positive
  // (never a divide-by-zero in the ratio below).
  const inv = (x: number): number => Math.pow(clamp(x, 0.5, 0.999), 1 / DECAY) - 1;
  const invObserved = inv(observed);
  const ratio = invObserved !== 0 ? inv(predicted) / invObserved : 1;
  const intervalMultiplier = clamp(finite(ratio, 1), MULTIPLIER_MIN, MULTIPLIER_MAX);

  return {
    ok: true,
    intervalMultiplier,
    receipts: n,
    observedRecall: observed,
    predictedRecall: predicted,
    ...(asOf ? { asOf } : {}),
  };
}
