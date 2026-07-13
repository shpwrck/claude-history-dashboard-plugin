/**
 * model-evals-workbench.ts — pure data-prep helpers for the Model Evals
 * workbench view (#1086, epic #975).
 *
 * The view renders two evidence faces:
 *  1. The committed eval-result rollup (`ModelEvalSummary`, #1085/#1242) —
 *     ranked model runs, veto totals, exclusion counts, result history, and
 *     the scoped routing recommendations. That arrives pre-computed on the
 *     dataset; no helper needed here beyond display labels.
 *  2. The hindsight gap-mining substrate (#1081/#1083) — task-shape clusters
 *     mined from the dashboard's own parsed history, plus PROPOSED replay eval
 *     specs scoped to the surviving clusters. These are derived client-side
 *     from the already-fetched dataset (no new server call — SPA-boundary
 *     safe), and extracted here as pure functions so the view's data wiring is
 *     unit-testable without a DOM.
 *
 * Standing rule 6 (epic #975): everything here is a PROPOSAL surface. The
 * batch specs are previews the user may choose to run; recommendations are
 * presented for explicit approval. Nothing mutates any registry/default/route.
 */
import {
  buildGapMiningRuns,
  mineModelGaps,
  type GapDirection,
  type GapMiningDatasetInput,
  type ModelGapCandidate,
} from './model-gap-mining';
import { clusterKeptRuns, type TaskShapeCluster } from './model-gap-clustering';
import {
  buildGapExclusionSignals,
  partitionGapCandidates,
} from './model-gap-exclusions';
import {
  buildModelEvalBatchSpec,
  generateEvalBatchesFromClusters,
  validateModelEvalBatchSpec,
  type ModelEvalBatchSpec,
} from './model-eval-batch';
import { CURRENT_MODEL_IDS } from './model-registry';
import type {
  EvidenceStrength,
  EvalExclusion,
  ExclusionDisposition,
} from './model-eval-result';

/** Human-readable labels for the committed evidence-strength enum. */
export const EVIDENCE_STRENGTH_LABELS: Record<EvidenceStrength, string> = {
  'shadow-replay-verdict': 'Shadow/replay verdict',
  'objective-task-history': 'Objective task history',
  'proxy-detector-signal': 'Proxy detector signal',
  'token-cost-discovery': 'Token-cost (discovery-only)',
};

/** One mined candidate with its auditable exclusion and cluster disposition. */
export interface WorkbenchGapCandidate {
  runId: string;
  modelId: string;
  direction: GapDirection;
  discoveryScore: number;
  disposition: ExclusionDisposition;
  reason: string;
  /** Filtered candidates are deliberately not assigned to a cluster. */
  clusterId: string | null;
}

export interface WorkbenchGapAnalysis {
  /** Kept candidates bucketed for the proposed eval batch. */
  clusters: TaskShapeCluster[];
  /** Every mined candidate, including filtered candidates, in rank order. */
  candidates: WorkbenchGapCandidate[];
  /** Counts of the final audited rows rendered by the workbench. */
  exclusionCounts: Record<ExclusionDisposition, number>;
}

export interface WorkbenchCandidateAuditJoin {
  candidates: Omit<WorkbenchGapCandidate, 'clusterId'>[];
  /** Only unambiguous candidates with an authoritative kept record. */
  kept: ModelGapCandidate[];
}

/**
 * Join candidate dispositions by run id, never by positional coincidence.
 * Exactly one candidate and one exclusion record must exist for a run; a
 * missing or duplicate side is withheld from clustering/handoff with an
 * explicit filtered reason (fail closed).
 */
export function joinWorkbenchCandidateExclusions(
  candidates: ModelGapCandidate[],
  exclusions: EvalExclusion[]
): WorkbenchCandidateAuditJoin {
  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates) {
    candidateCounts.set(
      candidate.runId,
      (candidateCounts.get(candidate.runId) ?? 0) + 1
    );
  }
  const exclusionsByRun = new Map<string, EvalExclusion[]>();
  for (const exclusion of exclusions) {
    const matches = exclusionsByRun.get(exclusion.runId);
    if (matches) matches.push(exclusion);
    else exclusionsByRun.set(exclusion.runId, [exclusion]);
  }

  const kept: ModelGapCandidate[] = [];
  const audited = candidates.map((candidate) => {
    const candidateCount = candidateCounts.get(candidate.runId) ?? 0;
    const matches = exclusionsByRun.get(candidate.runId) ?? [];
    if (candidateCount !== 1 || matches.length !== 1) {
      return {
        runId: candidate.runId,
        modelId: candidate.modelId,
        direction: candidate.direction,
        discoveryScore: candidate.discoveryScore,
        disposition: 'filtered' as const,
        reason:
          `filtered: exclusion audit join is ambiguous ` +
          `(${candidateCount} candidate(s), ${matches.length} record(s)); ` +
          'withheld from clusters and batch handoff',
      };
    }
    const exclusion = matches[0];
    if (exclusion.disposition === 'kept') kept.push(candidate);
    return {
      runId: candidate.runId,
      modelId: candidate.modelId,
      direction: candidate.direction,
      discoveryScore: candidate.discoveryScore,
      disposition: exclusion.disposition,
      reason: exclusion.reason,
    };
  });

  return { candidates: audited, kept };
}

/**
 * Mine routing-gap candidates, run the deterministic human/process exclusion
 * pass, and bucket only the survivors into task-shape clusters
 * (#1081 -> #1082 -> #1083). Filtered candidates stay in the returned audit
 * trail instead of disappearing. Pure and deterministic in its input.
 */
export function buildWorkbenchGapAnalysis(
  input: GapMiningDatasetInput
): WorkbenchGapAnalysis {
  const runs = buildGapMiningRuns(input);
  const candidates = mineModelGaps(runs);
  const { exclusions } = partitionGapCandidates(
    candidates,
    buildGapExclusionSignals(input)
  );
  const joined = joinWorkbenchCandidateExclusions(candidates, exclusions);
  const clusters = clusterKeptRuns(joined.kept, runs);
  const clusterByRun = new Map(
    clusters.flatMap((cluster) =>
      cluster.runIds.map((runId) => [runId, cluster.clusterId] as const)
    )
  );
  const auditedCandidates = joined.candidates.map((candidate) => {
    return {
      ...candidate,
      clusterId: clusterByRun.get(candidate.runId) ?? null,
    };
  });
  const exclusionCounts: Record<ExclusionDisposition, number> = {
    kept: 0,
    filtered: 0,
  };
  for (const candidate of auditedCandidates) {
    exclusionCounts[candidate.disposition] += 1;
  }

  return { clusters, candidates: auditedCandidates, exclusionCounts };
}

/** Backwards-compatible cluster-only projection for non-UI callers. */
export function buildWorkbenchClusters(
  input: GapMiningDatasetInput
): TaskShapeCluster[] {
  return buildWorkbenchGapAnalysis(input).clusters;
}

/** Candidate/baseline model ids implied by a mined gap direction. */
const DIRECTION_MODELS: Record<
  GapDirection,
  { baseline: string; candidate: string }
> = {
  'haiku->sonnet': {
    baseline: CURRENT_MODEL_IDS.haiku,
    candidate: CURRENT_MODEL_IDS.sonnet,
  },
  'sonnet->opus': {
    baseline: CURRENT_MODEL_IDS.sonnet,
    candidate: CURRENT_MODEL_IDS.opus,
  },
};

/**
 * Build the PROPOSED batch spec covering the mined clusters' gap directions:
 * one candidate/baseline pair per direction, drawn from the current model
 * registry, over the replay-history corpus. Null when there is nothing to
 * propose. `createdAt` is injected so the preview (and its tests) stay
 * deterministic. This is a preview only — the workbench never runs it.
 */
export function buildProposedBatchSpec(
  clusters: TaskShapeCluster[],
  createdAt: string
): ModelEvalBatchSpec | null {
  if (clusters.length === 0) return null;
  const candidates = new Set<string>();
  const baselines = new Set<string>();
  // Committed-order iteration: clusters are already sorted by clusterId.
  for (const cluster of clusters) {
    const models = DIRECTION_MODELS[cluster.direction];
    candidates.add(models.candidate);
    baselines.add(models.baseline);
  }
  return buildModelEvalBatchSpec({
    candidates: [...candidates].sort(),
    baselines: [...baselines].sort(),
    corpus: 'replay-history',
    createdAt,
  });
}

/** Stable, copy-ready JSON representation of a deterministic proposed spec. */
export function serializeProposedBatchSpec(spec: ModelEvalBatchSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/**
 * Build one validated replay-history spec per kept cluster. The available
 * replay ids come only from cluster members, so filtered candidates cannot
 * leak into the copied handoff's task refs.
 */
export function buildProposedReplayBatchSpecs(
  clusters: TaskShapeCluster[],
  createdAt: string
): ModelEvalBatchSpec[] {
  const replayRunIds = [
    ...new Set(clusters.flatMap((cluster) => cluster.runIds)),
  ];
  const specs = generateEvalBatchesFromClusters(
    clusters,
    { replayRunIds },
    { createdAt }
  );
  return specs.every((spec) => validateModelEvalBatchSpec(spec).ok) ? specs : [];
}

/** Same JSON array shape emitted by `eval:model-batch --clusters ... --print`. */
export function serializeProposedBatchSpecs(
  specs: ModelEvalBatchSpec[]
): string {
  return `${JSON.stringify(specs, null, 2)}\n`;
}
