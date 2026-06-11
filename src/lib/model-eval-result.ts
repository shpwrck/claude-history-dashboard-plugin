/**
 * The committed eval-result schema (#1079) — the "one schema, two consumers"
 * shared substrate that both #975 routing-evals and the #995 workflow proof
 * record run outcomes against. Sibling to `model-eval-batch.ts` (the batch
 * *spec*); this file is the batch *result*.
 *
 * Dependency-free on purpose: this module is part of the server module graph,
 * which ships zero node_modules, so it must not import any npm package. It has
 * no imports at all — the scoring weights are inlined as a local constant.
 *
 * Standing rules folded in:
 * - Rule 4: cost/token signal can never be a quality label — it is
 *   `discovery-only` evidence and a missing/unknown price is a hard veto.
 * - Rule 7: no live Anthropic calls here or in the tests; the sanitizer is a
 *   pure fail-closed allowlist over already-captured records.
 */

const SCORING_WEIGHTS = {
  quality: 0.5,
  cost: 0.25,
  latency: 0.15,
  reliability: 0.1,
} as const;

export type EvalScoringWeights = typeof SCORING_WEIGHTS;

/** The canonical 50/25/15/10 weighting the issue fixes for the weighted score. */
export const EVAL_SCORING_WEIGHTS: EvalScoringWeights = SCORING_WEIGHTS;

/**
 * Gap-evidence strength, strongest first. The ordering is load-bearing:
 * shadow/replay model-axis verdicts outrank objective successful-task history,
 * which outranks proxy detector signals, which outrank token/cost — and
 * token/cost is `discovery-only`, never a quality label (rule 4).
 */
export const EVIDENCE_STRENGTHS = [
  'shadow-replay-verdict',
  'objective-task-history',
  'proxy-detector-signal',
  'token-cost-discovery',
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

/** Rank of an evidence strength; lower is stronger. */
export const EVIDENCE_STRENGTH_RANK: Record<EvidenceStrength, number> =
  Object.fromEntries(
    EVIDENCE_STRENGTHS.map((strength, index) => [strength, index])
  ) as Record<EvidenceStrength, number>;

/** The four scored dimensions, mirroring the batch spec's weighting keys. */
export const EVAL_SCORE_DIMENSIONS = [
  'quality',
  'cost',
  'latency',
  'reliability',
] as const;
export type EvalScoreDimension = (typeof EVAL_SCORE_DIMENSIONS)[number];

/** Why a run was excluded; carries whether it was kept or filtered out. */
export type ExclusionDisposition = 'kept' | 'filtered';

/**
 * Hard vetoes — any one of these zeroes the recommendation regardless of the
 * weighted score. `unknown-pricing-or-api` covers rule 4's missing-price case;
 * `insufficient-evidence` covers a bucket whose evidence never reached the
 * required strength.
 */
export const EVAL_VETOES = [
  'failed-required-gate',
  'materially-worse-correctness',
  'unknown-pricing-or-api',
  'insufficient-evidence',
] as const;
export type EvalVeto = (typeof EVAL_VETOES)[number];

export type EvalCandidateRole = 'candidate' | 'baseline';

/** A single piece of strength-labeled gap evidence for one candidate run. */
export interface EvalGapEvidence {
  strength: EvidenceStrength;
  /** Free-form short note describing the observed gap. */
  detail: string;
  /** Signed magnitude: positive = candidate ahead, negative = candidate behind. */
  delta: number;
}

/** A run that was set aside, with the kept/filtered reason it carries. */
export interface EvalExclusion {
  runId: string;
  disposition: ExclusionDisposition;
  reason: string;
}

/** The per-dimension scores for one run, each in [0, 1]. */
export interface EvalDimensionScores {
  quality: number;
  cost: number;
  latency: number;
  reliability: number;
}

/** One candidate-or-baseline run result within a batch. */
export interface EvalRunResult {
  runId: string;
  modelId: string;
  role: EvalCandidateRole;
  /** The cluster this run was grouped into (gap/task cluster). */
  clusterId: string;
  scores: EvalDimensionScores;
  /** Weighted score per EVAL_SCORING_WEIGHTS; 0 when any veto fires. */
  weightedScore: number;
  evidence: EvalGapEvidence[];
  /** Hard vetoes that fired for this run; non-empty zeroes weightedScore. */
  vetoes: EvalVeto[];
}

/** A scoped routing recommendation distilled from the runs. */
export interface EvalRoutingRecommendation {
  modelId: string;
  /** The scope this recommendation is bounded to (e.g. a cluster id or bucket). */
  scope: string;
  weightedScore: number;
  /** The strongest evidence strength backing the recommendation. */
  strongestEvidence: EvidenceStrength;
  rationale: string;
}

export interface ModelEvalResult {
  schemaVersion: 1;
  kind: 'model-eval-result';
  createdAt: string;
  batchPath: string;
  scoring: EvalScoringWeights;
  runs: EvalRunResult[];
  exclusions: EvalExclusion[];
  recommendations: EvalRoutingRecommendation[];
}

const MAX_ID_LEN = 160;
const MAX_TEXT_LEN = 480;
const MAX_RUNS = 500;
const MAX_EVIDENCE = 50;
const MAX_EXCLUSIONS = 500;
const MAX_RECOMMENDATIONS = 50;

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function cleanTimestamp(value: unknown, now: () => Date): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return now().toISOString();
}

/** Clamp a finite number into [min, max]; non-finite -> null. */
function cleanBoundedNumber(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function cleanUnit(value: unknown): number | null {
  return cleanBoundedNumber(value, 0, 1);
}

function isEnumMember<T extends string>(
  value: unknown,
  members: readonly T[]
): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * Compute the weighted score from per-dimension unit scores using the canonical
 * 50/25/15/10 weighting. Any veto zeroes the result — a vetoed run can never
 * earn a positive recommendation score regardless of its dimensions.
 */
export function computeWeightedScore(
  scores: EvalDimensionScores,
  vetoes: readonly EvalVeto[] = []
): number {
  if (vetoes.length > 0) return 0;
  return (
    scores.quality * SCORING_WEIGHTS.quality +
    scores.cost * SCORING_WEIGHTS.cost +
    scores.latency * SCORING_WEIGHTS.latency +
    scores.reliability * SCORING_WEIGHTS.reliability
  );
}

function sanitizeEvidence(value: unknown): EvalGapEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isEnumMember(raw.strength, EVIDENCE_STRENGTHS)) return null;
  const detail = cleanString(raw.detail, MAX_TEXT_LEN);
  const delta = cleanBoundedNumber(raw.delta, -1e9, 1e9);
  if (!detail || delta === null) return null;
  return { strength: raw.strength, detail, delta };
}

function sanitizeExclusion(value: unknown): EvalExclusion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const runId = cleanString(raw.runId, MAX_ID_LEN);
  const reason = cleanString(raw.reason, MAX_TEXT_LEN);
  if (!runId || !reason) return null;
  if (raw.disposition !== 'kept' && raw.disposition !== 'filtered') return null;
  return { runId, disposition: raw.disposition, reason };
}

function sanitizeRun(value: unknown): EvalRunResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const runId = cleanString(raw.runId, MAX_ID_LEN);
  const modelId = cleanString(raw.modelId, MAX_ID_LEN);
  const clusterId = cleanString(raw.clusterId, MAX_ID_LEN);
  if (!runId || !modelId || !clusterId) return null;
  if (raw.role !== 'candidate' && raw.role !== 'baseline') return null;

  const scoresRaw =
    raw.scores && typeof raw.scores === 'object' && !Array.isArray(raw.scores)
      ? (raw.scores as Record<string, unknown>)
      : null;
  if (!scoresRaw) return null;
  const quality = cleanUnit(scoresRaw.quality);
  const cost = cleanUnit(scoresRaw.cost);
  const latency = cleanUnit(scoresRaw.latency);
  const reliability = cleanUnit(scoresRaw.reliability);
  if (quality === null || cost === null || latency === null || reliability === null) {
    return null;
  }
  const scores: EvalDimensionScores = { quality, cost, latency, reliability };

  const vetoes = Array.isArray(raw.vetoes)
    ? [
        ...new Set(
          raw.vetoes.filter((v): v is EvalVeto => isEnumMember(v, EVAL_VETOES))
        ),
      ]
    : [];

  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .map(sanitizeEvidence)
        .filter((e): e is EvalGapEvidence => e !== null)
        .slice(0, MAX_EVIDENCE)
    : [];

  return {
    runId,
    modelId,
    role: raw.role,
    clusterId,
    scores,
    weightedScore: computeWeightedScore(scores, vetoes),
    evidence,
    vetoes,
  };
}

function sanitizeRecommendation(
  value: unknown
): EvalRoutingRecommendation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const modelId = cleanString(raw.modelId, MAX_ID_LEN);
  const scope = cleanString(raw.scope, MAX_ID_LEN);
  const rationale = cleanString(raw.rationale, MAX_TEXT_LEN);
  const weightedScore = cleanUnit(raw.weightedScore);
  if (!modelId || !scope || !rationale || weightedScore === null) return null;
  if (!isEnumMember(raw.strongestEvidence, EVIDENCE_STRENGTHS)) return null;
  return {
    modelId,
    scope,
    weightedScore,
    strongestEvidence: raw.strongestEvidence,
    rationale,
  };
}

/**
 * Fail-closed allowlist sanitizer: take an untrusted record, drop anything that
 * does not match the committed schema, and return a normalized result (with the
 * weighted score recomputed from the canonical weights so a stored score can
 * never drift from its dimensions). Returns null when the record is not a
 * recognizable eval result.
 */
export function sanitizeModelEvalResult(
  input: unknown,
  now: () => Date = () => new Date()
): ModelEvalResult | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.kind !== 'model-eval-result') return null;

  const batchPath = cleanString(raw.batchPath, MAX_TEXT_LEN);
  if (!batchPath) return null;

  const runs = Array.isArray(raw.runs)
    ? raw.runs
        .map(sanitizeRun)
        .filter((r): r is EvalRunResult => r !== null)
        .slice(0, MAX_RUNS)
    : [];

  const exclusions = Array.isArray(raw.exclusions)
    ? raw.exclusions
        .map(sanitizeExclusion)
        .filter((e): e is EvalExclusion => e !== null)
        .slice(0, MAX_EXCLUSIONS)
    : [];

  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations
        .map(sanitizeRecommendation)
        .filter((r): r is EvalRoutingRecommendation => r !== null)
        .slice(0, MAX_RECOMMENDATIONS)
    : [];

  return {
    schemaVersion: 1,
    kind: 'model-eval-result',
    createdAt: cleanTimestamp(raw.createdAt, now),
    batchPath,
    scoring: SCORING_WEIGHTS,
    runs,
    exclusions,
    recommendations,
  };
}
