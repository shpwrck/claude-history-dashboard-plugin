/**
 * Ingest + summarize completed eval-result artifacts (#1085, epic #975).
 *
 * #1079 committed the per-batch eval *result* schema (`model-eval-result.ts`).
 * A meta-runner — which lives OUTSIDE this repo (standing rule 3: repo code
 * defines the artifact contract and parser only, never executes the runner) —
 * drops one `ModelEvalResult` artifact per completed batch. This module folds a
 * set of those artifacts into a single deterministic summary the dashboard data
 * model can carry: per-model rollups of weighted scores, the hard vetoes that
 * fired, and the strongest gap evidence — plus kept/filtered exclusion counts,
 * a deduped routing-recommendation list, and a bounded per-artifact
 * result-history ledger (#1387).
 *
 * Dependency-free on purpose: like its `model-eval-result.ts` sibling, this
 * module is part of the server module graph, which ships zero node_modules
 * (#1013), so it imports only that sibling — no npm package. Every artifact is
 * run back through `sanitizeModelEvalResult` (fail-closed allowlist) before it
 * is summarized, so an untrusted on-disk artifact can never widen the shape.
 *
 * Determinism (acceptance): for a given artifact list and `now`, the summary is
 * byte-stable — every list is totally ordered (no insertion-order leakage), the
 * weighted score is recomputed by the schema sanitizer from the canonical
 * weights, and the veto/evidence rollups iterate the committed enum order.
 */

import {
  EVAL_VETOES,
  EVIDENCE_STRENGTHS,
  EVIDENCE_STRENGTH_RANK,
  sanitizeModelEvalResult,
  type EvalRoutingRecommendation,
  type EvalRunResult,
  type EvalVeto,
  type EvidenceStrength,
  type ModelEvalResult,
} from './model-eval-result';

/**
 * Cap on the per-artifact result-history ledger (#1387). The ledger keeps the
 * `ARTIFACT_LEDGER_CAP` most-recent artifacts (by `createdAt`), so the summary
 * stays bounded no matter how many batches accumulate in
 * `~/.claude/model-evals/results` — 50 entries is generous next to the
 * workbench's history view while keeping the per-entry payload (~4 small
 * fields) negligible in the dataset. `artifactCount` stays the uncapped total,
 * so consumers can tell when the ledger is truncated.
 */
export const ARTIFACT_LEDGER_CAP = 50;

/** One ingested artifact's row in the bounded result-history ledger (#1387). */
export interface ModelEvalArtifactLedgerEntry {
  /** The batch spec the artifact reports on (sanitized `batchPath`). */
  batchPath: string;
  /** Normalized ISO timestamp the artifact carried (sanitizer fallback: now). */
  createdAt: string;
  /** Runs recorded in this artifact. */
  runCount: number;
  /** Runs in this artifact whose `vetoes` were non-empty. */
  vetoedRuns: number;
}

/** Per-model rollup across every ingested run for that `modelId`. */
export interface ModelEvalModelRollup {
  modelId: string;
  runCount: number;
  candidateRuns: number;
  baselineRuns: number;
  /** Runs whose `vetoes` were non-empty (their weightedScore is 0). */
  vetoedRuns: number;
  /** Mean weightedScore over the model's runs (a vetoed run contributes 0). */
  meanWeightedScore: number;
  /** Highest weightedScore among the model's runs. */
  bestWeightedScore: number;
  /** Union of every veto that fired for the model, in committed enum order. */
  vetoes: EvalVeto[];
  /** Strongest (lowest-rank) evidence seen across the model's runs; null if none. */
  strongestEvidence: EvidenceStrength | null;
  /** Total gap-evidence items across the model's runs. */
  evidenceCount: number;
}

/** The deterministic summary the dashboard data model carries. */
export interface ModelEvalSummary {
  schemaVersion: 1;
  kind: 'model-eval-summary';
  generatedAt: string;
  /** Artifacts that survived the schema sanitizer (malformed ones are dropped). */
  artifactCount: number;
  /** Total runs across all ingested artifacts. */
  runCount: number;
  /**
   * Per-artifact result-history ledger (#1387): one entry per ingested
   * artifact, newest first (`createdAt` desc, `batchPath` asc tiebreak),
   * bounded to the {@link ARTIFACT_LEDGER_CAP} most-recent entries.
   * `artifactCount` above remains the uncapped total.
   */
  artifacts: ModelEvalArtifactLedgerEntry[];
  /** Per-model rollups, sorted by bestWeightedScore desc then modelId asc. */
  models: ModelEvalModelRollup[];
  /** Occurrence count per veto across all runs; every enum key present (0+). */
  vetoTotals: Record<EvalVeto, number>;
  /** Kept/filtered exclusion run counts across all artifacts. */
  exclusions: { kept: number; filtered: number };
  /**
   * Deduped routing recommendations across artifacts, keyed by (modelId, scope),
   * keeping the strongest, sorted by weightedScore desc then modelId/scope asc.
   */
  recommendations: EvalRoutingRecommendation[];
}

interface ModelAccumulator {
  modelId: string;
  runCount: number;
  candidateRuns: number;
  baselineRuns: number;
  vetoedRuns: number;
  weightedScoreSum: number;
  bestWeightedScore: number;
  vetoes: Set<EvalVeto>;
  strongestEvidenceRank: number | null;
  evidenceCount: number;
}

function strongestEvidenceOf(run: EvalRunResult): number | null {
  let best: number | null = null;
  for (const e of run.evidence) {
    const rank = EVIDENCE_STRENGTH_RANK[e.strength];
    if (best === null || rank < best) best = rank;
  }
  return best;
}

/**
 * The evidence strength for a rank, or null. Inverse of EVIDENCE_STRENGTH_RANK:
 * a rank is exactly an index into the committed EVIDENCE_STRENGTHS tuple, so we
 * index that array directly rather than scanning derived object keys (keeps the
 * lookup order-independent of any object-key iteration order).
 */
function evidenceStrengthForRank(rank: number | null): EvidenceStrength | null {
  if (rank === null) return null;
  return EVIDENCE_STRENGTHS[rank] ?? null;
}

/** Rank of a recommendation's evidence strength; lower is stronger. */
function recStrengthRank(rec: EvalRoutingRecommendation): number {
  return EVIDENCE_STRENGTH_RANK[rec.strongestEvidence];
}

/**
 * Ingest completed eval-result artifacts and summarize them deterministically.
 *
 * @param rawArtifacts untrusted artifact records (each re-sanitized via the
 *   committed schema before use); non-conforming entries are dropped.
 * @param now injectable clock for the summary timestamp (tests pin it).
 */
export function ingestModelEvalResults(
  rawArtifacts: readonly unknown[],
  now: () => Date = () => new Date()
): ModelEvalSummary {
  // Pin one instant for the whole pass so the summary's generatedAt and every
  // sanitizer createdAt fallback share it (byte-stable output per the contract,
  // even if processing straddles a clock tick under the default `new Date`).
  const generatedAt = now();
  const pinnedNow = () => generatedAt;

  const artifacts: ModelEvalResult[] = [];
  for (const raw of rawArtifacts) {
    const sanitized = sanitizeModelEvalResult(raw, pinnedNow);
    if (sanitized) artifacts.push(sanitized);
  }

  const models = new Map<string, ModelAccumulator>();
  const vetoTotals = Object.fromEntries(
    EVAL_VETOES.map((v) => [v, 0])
  ) as Record<EvalVeto, number>;
  const exclusions = { kept: 0, filtered: 0 };
  // Best recommendation per (modelId, scope) key.
  const recs = new Map<string, EvalRoutingRecommendation>();

  let runCount = 0;
  const ledger: ModelEvalArtifactLedgerEntry[] = [];

  for (const artifact of artifacts) {
    let artifactVetoedRuns = 0;
    for (const run of artifact.runs) {
      runCount += 1;
      if (run.vetoes.length > 0) artifactVetoedRuns += 1;
      let acc = models.get(run.modelId);
      if (!acc) {
        acc = {
          modelId: run.modelId,
          runCount: 0,
          candidateRuns: 0,
          baselineRuns: 0,
          vetoedRuns: 0,
          weightedScoreSum: 0,
          bestWeightedScore: 0,
          vetoes: new Set<EvalVeto>(),
          strongestEvidenceRank: null,
          evidenceCount: 0,
        };
        models.set(run.modelId, acc);
      }
      acc.runCount += 1;
      if (run.role === 'candidate') acc.candidateRuns += 1;
      else acc.baselineRuns += 1;
      if (run.vetoes.length > 0) acc.vetoedRuns += 1;
      acc.weightedScoreSum += run.weightedScore;
      if (run.weightedScore > acc.bestWeightedScore) {
        acc.bestWeightedScore = run.weightedScore;
      }
      for (const veto of run.vetoes) {
        acc.vetoes.add(veto);
        vetoTotals[veto] += 1;
      }
      acc.evidenceCount += run.evidence.length;
      const runRank = strongestEvidenceOf(run);
      if (
        runRank !== null &&
        (acc.strongestEvidenceRank === null || runRank < acc.strongestEvidenceRank)
      ) {
        acc.strongestEvidenceRank = runRank;
      }
    }

    for (const exclusion of artifact.exclusions) {
      if (exclusion.disposition === 'kept') exclusions.kept += 1;
      else exclusions.filtered += 1;
    }

    for (const rec of artifact.recommendations) {
      const key = JSON.stringify([rec.modelId, rec.scope]);
      const existing = recs.get(key);
      if (
        !existing ||
        rec.weightedScore > existing.weightedScore ||
        (rec.weightedScore === existing.weightedScore &&
          recStrengthRank(rec) < recStrengthRank(existing))
      ) {
        recs.set(key, rec);
      }
    }

    ledger.push({
      batchPath: artifact.batchPath,
      createdAt: artifact.createdAt,
      runCount: artifact.runs.length,
      vetoedRuns: artifactVetoedRuns,
    });
  }

  // Result-history ledger (#1387): newest first by the sanitizer-normalized
  // ISO `createdAt` (lexicographic order IS chronological order for ISO
  // strings), tiebroken by batchPath asc — then capped, so the entries that
  // survive the bound are deterministically the most recent ones.
  ledger.sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
      (a.batchPath < b.batchPath ? -1 : a.batchPath > b.batchPath ? 1 : 0)
  );
  const artifactLedger = ledger.slice(0, ARTIFACT_LEDGER_CAP);

  const modelRollups: ModelEvalModelRollup[] = [...models.values()]
    .map((acc) => ({
      modelId: acc.modelId,
      runCount: acc.runCount,
      candidateRuns: acc.candidateRuns,
      baselineRuns: acc.baselineRuns,
      vetoedRuns: acc.vetoedRuns,
      meanWeightedScore:
        acc.runCount > 0 ? acc.weightedScoreSum / acc.runCount : 0,
      bestWeightedScore: acc.bestWeightedScore,
      // Iterate the committed enum so the union is in canonical order.
      vetoes: EVAL_VETOES.filter((v) => acc.vetoes.has(v)),
      strongestEvidence: evidenceStrengthForRank(acc.strongestEvidenceRank),
      evidenceCount: acc.evidenceCount,
    }))
    .sort(
      (a, b) =>
        b.bestWeightedScore - a.bestWeightedScore ||
        (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)
    );

  const recommendations = [...recs.values()].sort(
    (a, b) =>
      b.weightedScore - a.weightedScore ||
      (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0) ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0)
  );

  return {
    schemaVersion: 1,
    kind: 'model-eval-summary',
    generatedAt: generatedAt.toISOString(),
    artifactCount: artifacts.length,
    runCount,
    artifacts: artifactLedger,
    models: modelRollups,
    vetoTotals,
    exclusions,
    recommendations,
  };
}
