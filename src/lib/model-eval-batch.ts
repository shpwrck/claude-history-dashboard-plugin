import {
  CURRENT_MODEL_IDS,
  MODEL_PRICING,
  buildModelUpdateChecklist,
  resolveModelFamily,
  type ModelFamily,
} from './model-registry';
import {
  OBJECTIVE_GATE_KINDS,
  corpusTaskRef,
  type CorpusTask,
  type CorpusTaskRef,
  type ObjectiveGateKind,
} from './model-eval-corpus';
import { EVAL_SCORING_WEIGHTS } from './model-eval-result';
import { GAP_DIRECTIONS, type GapDirection } from './model-gap-mining';
import {
  GAP_DOMINANT_SIGNALS,
  GAP_SIZE_BANDS,
  type GapDominantSignal,
  type GapSizeBand,
  type TaskShapeCluster,
} from './model-gap-clustering';

export const MODEL_EVAL_CORPUS_SOURCES = [
  'shadow-calls',
  'replay-history',
  'curated-fixtures',
] as const;
export type ModelEvalCorpusSource = (typeof MODEL_EVAL_CORPUS_SOURCES)[number];

/**
 * The settled corpus-addressing order for cluster-driven batch generation
 * (#1084): curated fixtures first (controlled, objective-gated), then replay
 * history, then shadow-calls evidence. All three are addressed through ONE
 * task-ref schema ({@link EvalBatchTaskRef}) discriminated by `source`.
 */
export const CORPUS_ADDRESS_ORDER = [
  'curated-fixtures',
  'replay-history',
  'shadow-calls',
] as const satisfies readonly ModelEvalCorpusSource[];

export interface ModelEvalBatchInput {
  candidates: string[];
  baselines: string[];
  corpus?: ModelEvalCorpusSource;
  limit?: number;
  createdAt?: string;
  outDir?: string;
}

export interface ModelEvalBatchModel {
  id: string;
  role: 'candidate' | 'baseline';
  registered: boolean;
  inferredFamily: ModelFamily | null;
}

/**
 * One addressable task in a batch — the SINGLE schema through which all three
 * corpora are addressed (#1084). `source` is the discriminator:
 *   - `curated-fixtures`: `taskId` is a corpus task id and `gateKind` carries
 *     its deterministic objective gate.
 *   - `replay-history` / `shadow-calls`: `taskId` is a history run id (a
 *     cluster member found in that corpus) and `gateKind` is null — history
 *     tasks have no fixed manifest gate.
 */
export interface EvalBatchTaskRef {
  source: ModelEvalCorpusSource;
  taskId: string;
  gateKind: ObjectiveGateKind | null;
}

/** The task-shape cluster a cluster-driven batch spec is scoped to (#1083/#1084). */
export interface EvalBatchClusterScope {
  /** Stable cluster id from Unit 6, e.g. `gap:haiku-sonnet:failure:small`. */
  clusterId: string;
  direction: GapDirection;
  /** null for the unprofiled fallback bucket. */
  dominantSignal: GapDominantSignal | null;
  /** null for the unprofiled fallback bucket. */
  sizeBand: GapSizeBand | null;
  /** Member runs in the source cluster (not all are addressable in every corpus). */
  runCount: number;
}

export interface ModelEvalBatchSpec {
  schemaVersion: 1;
  kind: 'model-eval-batch';
  createdAt: string;
  models: ModelEvalBatchModel[];
  corpus: {
    source: ModelEvalCorpusSource;
    limit: number;
  };
  scoring: {
    quality: number;
    cost: number;
    latency: number;
    reliability: number;
  };
  updateChecklists: ReturnType<typeof buildModelUpdateChecklist>[];
  /**
   * Corpus task references, present only for a `curated-fixtures` batch (#1080).
   * Each ref names a task whose deterministic objective gate the runner checks.
   * Absent for `shadow-calls` / `replay-history` sources, which draw tasks from
   * history rather than a fixed manifest. Cluster-driven fixture batches keep
   * this mirror of `tasks` so the #1080 runner contract is unchanged.
   */
  corpusTasks?: CorpusTaskRef[];
  /**
   * Cluster scope, present only for a cluster-driven batch (#1084): the Unit 6
   * task-shape cluster this spec compares models against.
   */
  cluster?: EvalBatchClusterScope;
  /**
   * Unified task addressing, present only for a cluster-driven batch (#1084):
   * the tasks of `corpus.source` this batch evaluates, in one schema across
   * all three corpora (see {@link EvalBatchTaskRef}).
   */
  tasks?: EvalBatchTaskRef[];
  output: {
    path: string;
  };
}

function cleanModelIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function timestampForPath(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function modelStatus(id: string, role: ModelEvalBatchModel['role']): ModelEvalBatchModel {
  return {
    id,
    role,
    registered: Object.prototype.hasOwnProperty.call(MODEL_PRICING, id),
    inferredFamily: resolveModelFamily(id),
  };
}

export function buildModelEvalBatchSpec(input: ModelEvalBatchInput): ModelEvalBatchSpec {
  const candidates = cleanModelIds(input.candidates);
  const baselines = cleanModelIds(input.baselines);
  if (candidates.length === 0) {
    throw new Error('At least one candidate model is required.');
  }
  if (baselines.length === 0) {
    throw new Error('At least one baseline model is required.');
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const outDir = input.outDir ?? '.claude/model-evals';
  const outputPath = `${outDir.replace(/\/$/, '')}/model-eval-${timestampForPath(createdAt)}.json`;
  const models = [
    ...candidates.map((id) => modelStatus(id, 'candidate')),
    ...baselines.map((id) => modelStatus(id, 'baseline')),
  ];

  return {
    schemaVersion: 1,
    kind: 'model-eval-batch',
    createdAt,
    models,
    corpus: {
      source: input.corpus ?? 'shadow-calls',
      limit: input.limit ?? 20,
    },
    scoring: { ...EVAL_SCORING_WEIGHTS },
    updateChecklists: candidates.map((id) => buildModelUpdateChecklist(id)),
    output: {
      path: outputPath,
    },
  };
}

/**
 * Build a fixture-backed batch spec: a normal batch spec whose corpus source is
 * forced to `curated-fixtures` and whose `corpusTasks` reference the first
 * `limit` tasks of the supplied curated corpus (#1080). The corpus is the
 * controlled, objective-gated substrate the runner evaluates each model against.
 *
 * Deterministic: same models + same corpus + same `createdAt` → identical spec.
 * Throws (via {@link buildModelEvalBatchSpec}) when no candidate/baseline is
 * given, and when the corpus is empty (no task to prove anything against).
 */
export function buildFixtureBackedBatchSpec(
  input: ModelEvalBatchInput,
  corpus: CorpusTask[]
): ModelEvalBatchSpec {
  if (corpus.length === 0) {
    throw new Error('A fixture-backed batch needs a non-empty curated corpus.');
  }
  const spec = buildModelEvalBatchSpec({ ...input, corpus: 'curated-fixtures' });
  const corpusTasks = corpus.slice(0, spec.corpus.limit).map(corpusTaskRef);
  return { ...spec, corpusTasks };
}

/** The candidate/baseline pair a gap direction implies. */
export interface DirectionModelPair {
  candidate: string;
  baseline: string;
}

/**
 * Derive the candidate/baseline model pair from a cluster's gap direction via
 * the model registry (epic standing rule 1: no unverified model ids — both
 * sides come from {@link CURRENT_MODEL_IDS}). The candidate is the model the
 * gap suggests trying; the baseline is the family the history actually ran.
 */
export function modelPairForDirection(direction: GapDirection): DirectionModelPair {
  return direction === 'haiku->sonnet'
    ? { candidate: CURRENT_MODEL_IDS.sonnet, baseline: CURRENT_MODEL_IDS.haiku }
    : { candidate: CURRENT_MODEL_IDS.opus, baseline: CURRENT_MODEL_IDS.sonnet };
}

/**
 * The material each corpus offers for cluster-driven batch generation (#1084).
 * The curated fixture corpus is a fixed manifest; replay history and the
 * shadow-calls ledger are history-drawn, so the caller supplies the run ids
 * known to exist in each (the generator addresses a cluster there through the
 * intersection with the cluster's member runs).
 */
export interface ClusterEvalCorpora {
  /** The curated fixture corpus (Unit 1). */
  fixtures?: CorpusTask[];
  /** Run ids present in replay history. */
  replayRunIds?: readonly string[];
  /** Run ids present in the shadow-calls ledger. */
  shadowRunIds?: readonly string[];
}

export interface ClusterEvalBatchOptions {
  /** Max tasks addressed per spec. Default 20 (matches the base spec). */
  limit?: number;
  /** Deterministic timestamp; defaults to now, like the sibling builders. */
  createdAt?: string;
  /** Output directory. Default `.claude/model-evals`. */
  outDir?: string;
}

function clusterSlug(clusterId: string): string {
  return clusterId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fixtureTaskRefs(
  fixtures: CorpusTask[] | undefined,
  limit: number
): EvalBatchTaskRef[] {
  if (!fixtures || fixtures.length === 0) return [];
  return fixtures.slice(0, limit).map((task) => ({
    source: 'curated-fixtures' as const,
    taskId: task.id,
    gateKind: task.gate.kind,
  }));
}

function historyTaskRefs(
  source: 'replay-history' | 'shadow-calls',
  clusterRunIds: readonly string[],
  availableRunIds: readonly string[] | undefined,
  limit: number
): EvalBatchTaskRef[] {
  if (!availableRunIds || availableRunIds.length === 0) return [];
  const available = new Set(availableRunIds);
  const seen = new Set<string>();
  const refs: EvalBatchTaskRef[] = [];
  for (const runId of clusterRunIds) {
    if (!available.has(runId) || seen.has(runId)) continue;
    seen.add(runId);
    refs.push({ source, taskId: runId, gateKind: null });
    if (refs.length >= limit) break;
  }
  return refs;
}

/**
 * Generate recommended eval batch SPECS from task-shape clusters across the
 * three corpora (#1084, Unit 7). One spec per cluster x corpus that has
 * matching material, in the settled addressing order
 * ({@link CORPUS_ADDRESS_ORDER}: fixtures, then replay history, then
 * shadow-calls), all under the one batch schema:
 *
 * - The candidate/baseline pair comes from the cluster's gap direction via the
 *   model registry ({@link modelPairForDirection}).
 * - The curated fixture corpus is the controlled substrate, so it matches
 *   every cluster when supplied (first `limit` tasks). Replay/shadow material
 *   is the intersection of the cluster's member runs with the run ids the
 *   caller says exist in that corpus, preserving the cluster's
 *   discovery-score order.
 * - Deterministic: same clusters + corpora + options (incl. `createdAt`) →
 *   identical specs; no Date.now/randomness beyond the sibling builders'
 *   `createdAt` default. Output paths embed the cluster slug + source so
 *   specs generated together never collide.
 *
 * SPEC generation only — nothing here executes a batch or calls a live API
 * (epic standing rules 3 and 7).
 */
export function generateEvalBatchesFromClusters(
  clusters: TaskShapeCluster[],
  corpora: ClusterEvalCorpora,
  options: ClusterEvalBatchOptions = {}
): ModelEvalBatchSpec[] {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const limit = options.limit ?? 20;
  const outDir = (options.outDir ?? '.claude/model-evals').replace(/\/$/, '');

  const specs: ModelEvalBatchSpec[] = [];
  const seenClusterIds = new Set<string>();
  for (const cluster of clusters) {
    if (seenClusterIds.has(cluster.clusterId)) continue;
    seenClusterIds.add(cluster.clusterId);
    const pair = modelPairForDirection(cluster.direction);

    for (const source of CORPUS_ADDRESS_ORDER) {
      const tasks =
        source === 'curated-fixtures'
          ? fixtureTaskRefs(corpora.fixtures, limit)
          : historyTaskRefs(
              source,
              cluster.runIds,
              source === 'replay-history' ? corpora.replayRunIds : corpora.shadowRunIds,
              limit
            );
      if (tasks.length === 0) continue;

      const base = buildModelEvalBatchSpec({
        candidates: [pair.candidate],
        baselines: [pair.baseline],
        corpus: source,
        limit,
        createdAt,
        outDir,
      });
      const spec: ModelEvalBatchSpec = {
        ...base,
        cluster: {
          clusterId: cluster.clusterId,
          direction: cluster.direction,
          dominantSignal: cluster.dominantSignal,
          sizeBand: cluster.sizeBand,
          runCount: cluster.runCount,
        },
        tasks,
        output: {
          path: `${outDir}/model-eval-${clusterSlug(cluster.clusterId)}-${source}-${timestampForPath(createdAt)}.json`,
        },
      };
      if (source === 'curated-fixtures') {
        // Mirror into the #1080 fixtures contract so the runner shape is unchanged.
        spec.corpusTasks = tasks.map((task) => ({
          taskId: task.taskId,
          gateKind: task.gateKind as ObjectiveGateKind,
        }));
      }
      specs.push(spec);
    }
  }
  return specs;
}

function isEnumMember<T extends string>(
  value: unknown,
  members: readonly T[]
): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * Validate a batch spec against the committed schema (#1084). Pure and total;
 * returns the same `{ ok, errors }` shape as `validateCorpus`. Covers the base
 * #1078 spec, the #1080 fixtures extension, and the #1084 cluster extension —
 * every generated spec (any source) must pass this before being written.
 */
export function validateModelEvalBatchSpec(
  spec: ModelEvalBatchSpec
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (spec.kind !== 'model-eval-batch') errors.push(`unexpected kind "${spec.kind}"`);
  if (spec.schemaVersion !== 1) errors.push(`unexpected schemaVersion ${spec.schemaVersion}`);
  if (!Number.isFinite(Date.parse(spec.createdAt))) {
    errors.push('createdAt is not a parseable timestamp');
  }

  const candidates = spec.models.filter((m) => m.role === 'candidate');
  const baselines = spec.models.filter((m) => m.role === 'baseline');
  if (candidates.length === 0) errors.push('no candidate model');
  if (baselines.length === 0) errors.push('no baseline model');
  if (spec.models.some((m) => !m.id.trim())) errors.push('model with empty id');

  if (!isEnumMember(spec.corpus.source, MODEL_EVAL_CORPUS_SOURCES)) {
    errors.push(`unknown corpus source "${spec.corpus.source}"`);
  }
  if (!Number.isInteger(spec.corpus.limit) || spec.corpus.limit <= 0) {
    errors.push('corpus limit must be a positive integer');
  }

  for (const dimension of ['quality', 'cost', 'latency', 'reliability'] as const) {
    if (spec.scoring[dimension] !== EVAL_SCORING_WEIGHTS[dimension]) {
      errors.push(`scoring.${dimension} drifted from the canonical weights`);
    }
  }

  if (!spec.output.path.trim()) errors.push('output path is empty');

  if (spec.corpusTasks) {
    if (spec.corpus.source !== 'curated-fixtures') {
      errors.push('corpusTasks present for a non-fixtures corpus');
    }
    for (const ref of spec.corpusTasks) {
      if (!ref.taskId.trim()) errors.push('corpus task ref with empty taskId');
      if (!isEnumMember(ref.gateKind, OBJECTIVE_GATE_KINDS)) {
        errors.push(`corpus task ref with unknown gateKind "${ref.gateKind}"`);
      }
    }
  }

  // The #1084 extension fields travel together: a cluster-driven spec carries
  // both its cluster scope and its unified task refs, or neither.
  if ((spec.cluster == null) !== (spec.tasks == null)) {
    errors.push('cluster and tasks must be co-present or co-absent');
  }

  if (spec.cluster) {
    if (!spec.cluster.clusterId.trim()) errors.push('cluster with empty clusterId');
    if (!isEnumMember(spec.cluster.direction, GAP_DIRECTIONS)) {
      errors.push(`cluster with unknown direction "${spec.cluster.direction}"`);
    }
    if (
      spec.cluster.dominantSignal !== null &&
      !isEnumMember(spec.cluster.dominantSignal, GAP_DOMINANT_SIGNALS)
    ) {
      errors.push(`cluster with unknown dominantSignal "${spec.cluster.dominantSignal}"`);
    }
    if (spec.cluster.sizeBand !== null && !isEnumMember(spec.cluster.sizeBand, GAP_SIZE_BANDS)) {
      errors.push(`cluster with unknown sizeBand "${spec.cluster.sizeBand}"`);
    }
    if (!Number.isInteger(spec.cluster.runCount) || spec.cluster.runCount <= 0) {
      errors.push('cluster runCount must be a positive integer');
    }
  }

  if (spec.tasks) {
    if (spec.tasks.length === 0) errors.push('tasks is present but empty');
    if (spec.tasks.length > spec.corpus.limit) {
      errors.push('tasks exceed the corpus limit');
    }
    const seen = new Set<string>();
    for (const task of spec.tasks) {
      if (task.source !== spec.corpus.source) {
        errors.push(`task ref source "${task.source}" does not match corpus source`);
      }
      if (!task.taskId.trim()) errors.push('task ref with empty taskId');
      if (seen.has(task.taskId)) errors.push(`duplicate task ref "${task.taskId}"`);
      seen.add(task.taskId);
      if (task.source === 'curated-fixtures') {
        if (!isEnumMember(task.gateKind, OBJECTIVE_GATE_KINDS)) {
          errors.push(`fixture task ref "${task.taskId}" needs a known gateKind`);
        }
      } else if (task.gateKind !== null) {
        errors.push(`history task ref "${task.taskId}" must have a null gateKind`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
