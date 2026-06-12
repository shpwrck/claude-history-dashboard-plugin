/**
 * model-gap-clustering.ts — task-shape clustering of KEPT gap runs (#1083,
 * epic #975, Unit 6). Groups the gap candidates that survived the exclusion
 * classifiers (Unit 5) into buckets that are comparable across models, and
 * assigns each bucket a STABLE cluster ID that downstream units write into the
 * committed eval-result schema's `clusterId` field (Unit 2) and the batch
 * generator (Unit 7) scopes eval specs to.
 *
 * "Task shape" is deterministic and observable — no embeddings, no live API
 * (standing rule 7). A bucket is the cross product of:
 *   - gap direction      (haiku->sonnet | sonnet->opus, from the candidate)
 *   - dominant signal    (failure | inefficiency | duration | cost — which
 *                         hindsight signal dominates the run, share-of-max
 *                         normalised across the clustered set, ties broken in
 *                         that fixed precedence order)
 *   - size band          (small | medium | large by total tokens, at FIXED
 *                         thresholds so the band — and therefore the ID — never
 *                         shifts when other runs enter or leave the dataset)
 *
 * Stability contract: the cluster ID is a pure function of the bucket key, so
 * the same run profile always lands in the same-named cluster regardless of
 * input order or dataset composition; only the `dominantSignal` axis is
 * relative to the clustered set, which is exactly the set an eval batch would
 * compare against. Candidates with no run profile available — or whose profile
 * carries zero signal on every axis, so no dominance claim would be honest —
 * fall into a per-direction `unprofiled` bucket instead of being guessed at
 * (auditable, mirrors Unit 5's no-signals kept rule).
 */

import type { GapMiningRun, ModelGapCandidate, GapDirection } from './model-gap-mining';

export const GAP_DOMINANT_SIGNALS = [
  'failure',
  'inefficiency',
  'duration',
  'cost',
] as const;
export type GapDominantSignal = (typeof GAP_DOMINANT_SIGNALS)[number];

export const GAP_SIZE_BANDS = ['small', 'medium', 'large'] as const;
export type GapSizeBand = (typeof GAP_SIZE_BANDS)[number];

/** Fixed token thresholds so size bands (and cluster IDs) are dataset-stable. */
export const SIZE_BAND_MEDIUM_MIN_TOKENS = 200_000;
export const SIZE_BAND_LARGE_MIN_TOKENS = 2_000_000;

/** One task-shape bucket of kept runs, ready for model comparison. */
export interface TaskShapeCluster {
  /** Stable slug, pure function of the bucket key; fits the schema's ID cap. */
  clusterId: string;
  direction: GapDirection;
  /** null for the unprofiled fallback bucket. */
  dominantSignal: GapDominantSignal | null;
  /** null for the unprofiled fallback bucket. */
  sizeBand: GapSizeBand | null;
  /** Member run IDs, ordered by discovery score (desc), then runId. */
  runIds: string[];
  runCount: number;
}

/** Per-run cluster assignment, for stamping `clusterId` onto eval results. */
export interface ClusterAssignment {
  runId: string;
  clusterId: string;
}

function sizeBandOf(totalTokens: number): GapSizeBand {
  if (totalTokens >= SIZE_BAND_LARGE_MIN_TOKENS) return 'large';
  if (totalTokens >= SIZE_BAND_MEDIUM_MIN_TOKENS) return 'medium';
  return 'small';
}

function shareOfMax(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

function tokensPerTurn(run: GapMiningRun): number {
  return run.totalTokens / Math.max(1, run.turns);
}

function failureCount(run: GapMiningRun): number {
  return run.toolErrors + run.apiErrors;
}

/** Slug a direction for use inside a cluster ID: `haiku->sonnet` → `haiku-sonnet`. */
function directionSlug(direction: GapDirection): string {
  return direction.replace('->', '-');
}

/** The stable cluster ID for a fully-profiled bucket key. */
export function clusterIdFor(
  direction: GapDirection,
  dominantSignal: GapDominantSignal,
  sizeBand: GapSizeBand
): string {
  return `gap:${directionSlug(direction)}:${dominantSignal}:${sizeBand}`;
}

/** The stable cluster ID for candidates with no run profile to shape on. */
export function unprofiledClusterIdFor(direction: GapDirection): string {
  return `gap:${directionSlug(direction)}:unprofiled`;
}

/**
 * Which hindsight signal dominates a run, share-of-max normalised across the
 * clustered set. Ties resolve in the fixed GAP_DOMINANT_SIGNALS precedence
 * order — failure outranks inefficiency outranks duration outranks cost —
 * mirroring the miner's evidence-strength stance that objective failure is the
 * most meaningful signal and cost the least (standing rule 4). A run with zero
 * share on EVERY axis has no honest dominance claim and returns null; the
 * caller routes it to the unprofiled bucket rather than mislabeling it.
 */
function dominantSignalOf(
  run: GapMiningRun,
  maxima: { failure: number; ineff: number; duration: number; cost: number }
): GapDominantSignal | null {
  const shares: Record<GapDominantSignal, number> = {
    failure: shareOfMax(failureCount(run), maxima.failure),
    inefficiency: shareOfMax(tokensPerTurn(run), maxima.ineff),
    duration: shareOfMax(run.durationMs, maxima.duration),
    cost: shareOfMax(run.costProxyUsd, maxima.cost),
  };
  let best: GapDominantSignal | null = null;
  for (const signal of GAP_DOMINANT_SIGNALS) {
    if (shares[signal] <= 0) continue;
    if (best === null || shares[signal] > shares[best]) best = signal;
  }
  return best;
}

/**
 * Cluster kept gap candidates into task-shape buckets.
 *
 * `kept` is the survivor list from the Unit 5 exclusion pass; `runs` is the
 * miner's per-run profile set (any superset works — filtered runs present in
 * `runs` are simply never referenced). Deterministic: output order is by
 * clusterId, member order by discovery score desc then runId, and neither
 * depends on input order.
 */
export function clusterKeptRuns(
  kept: ModelGapCandidate[],
  runs: GapMiningRun[]
): TaskShapeCluster[] {
  const runById = new Map(runs.map((r) => [r.runId, r]));
  const profiled = kept.filter((c) => runById.has(c.runId));

  // Share-of-max maxima are computed over the KEPT, profiled set — the set an
  // eval batch would actually compare — not over all mined runs.
  const profiledRuns = profiled.map((c) => runById.get(c.runId) as GapMiningRun);
  const maxima = {
    failure: Math.max(...profiledRuns.map(failureCount), 0),
    ineff: Math.max(...profiledRuns.map(tokensPerTurn), 0),
    duration: Math.max(...profiledRuns.map((r) => r.durationMs), 0),
    cost: Math.max(...profiledRuns.map((r) => r.costProxyUsd), 0),
  };

  interface Bucket {
    direction: GapDirection;
    dominantSignal: GapDominantSignal | null;
    sizeBand: GapSizeBand | null;
    members: ModelGapCandidate[];
  }
  const buckets = new Map<string, Bucket>();

  for (const candidate of kept) {
    const run = runById.get(candidate.runId);
    const dominantSignal = run ? dominantSignalOf(run, maxima) : null;
    let id: string;
    let bucket: Omit<Bucket, 'members'>;
    if (run && dominantSignal) {
      const sizeBand = sizeBandOf(run.totalTokens);
      id = clusterIdFor(candidate.direction, dominantSignal, sizeBand);
      bucket = { direction: candidate.direction, dominantSignal, sizeBand };
    } else {
      id = unprofiledClusterIdFor(candidate.direction);
      bucket = {
        direction: candidate.direction,
        dominantSignal: null,
        sizeBand: null,
      };
    }
    const existing = buckets.get(id);
    if (existing) existing.members.push(candidate);
    else buckets.set(id, { ...bucket, members: [candidate] });
  }

  return [...buckets.entries()]
    .map(([clusterId, b]) => ({
      clusterId,
      direction: b.direction,
      dominantSignal: b.dominantSignal,
      sizeBand: b.sizeBand,
      runIds: [...b.members]
        .sort(
          (a, z) =>
            z.discoveryScore - a.discoveryScore ||
            (a.runId < z.runId ? -1 : a.runId > z.runId ? 1 : 0)
        )
        .map((m) => m.runId),
      runCount: b.members.length,
    }))
    .sort((a, z) => (a.clusterId < z.clusterId ? -1 : 1));
}

/** Flatten clusters into per-run assignments for stamping eval results. */
export function assignClusterIds(
  clusters: TaskShapeCluster[]
): ClusterAssignment[] {
  return clusters.flatMap((c) =>
    c.runIds.map((runId) => ({ runId, clusterId: c.clusterId }))
  );
}
