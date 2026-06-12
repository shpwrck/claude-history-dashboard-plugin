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
 *     mined from the dashboard's own parsed history, plus a PROPOSED eval
 *     batch spec covering the mined directions. These are derived client-side
 *     from the already-fetched dataset (no new server call — SPA-boundary
 *     safe), and extracted here as pure functions so the view's data wiring is
 *     unit-testable without a DOM.
 *
 * Standing rule 6 (epic #975): everything here is a PROPOSAL surface. The
 * batch spec is a preview the user may choose to run; the recommendations are
 * presented for explicit approval. Nothing mutates any registry/default/route.
 */
import {
  buildGapMiningRuns,
  mineModelGaps,
  type GapDirection,
  type GapMiningDatasetInput,
} from './model-gap-mining';
import { clusterKeptRuns, type TaskShapeCluster } from './model-gap-clustering';
import {
  buildModelEvalBatchSpec,
  type ModelEvalBatchSpec,
} from './model-eval-batch';
import { CURRENT_MODEL_IDS } from './model-registry';
import type { EvidenceStrength } from './model-eval-result';

/** Human-readable labels for the committed evidence-strength enum. */
export const EVIDENCE_STRENGTH_LABELS: Record<EvidenceStrength, string> = {
  'shadow-replay-verdict': 'Shadow/replay verdict',
  'objective-task-history': 'Objective task history',
  'proxy-detector-signal': 'Proxy detector signal',
  'token-cost-discovery': 'Token-cost (discovery-only)',
};

/**
 * Mine routing-gap candidates from the parsed dataset and bucket them into
 * task-shape clusters (#1081 -> #1083). Deterministic in its input. NOTE: the
 * Unit-5 exclusion pass is not on master yet, so every mined candidate is
 * treated as kept; the cluster face says so in copy.
 */
export function buildWorkbenchClusters(
  input: GapMiningDatasetInput
): TaskShapeCluster[] {
  const runs = buildGapMiningRuns(input);
  const candidates = mineModelGaps(runs);
  return clusterKeptRuns(candidates, runs);
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
