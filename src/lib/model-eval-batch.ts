import {
  MODEL_PRICING,
  buildModelUpdateChecklist,
  resolveModelFamily,
  type ModelFamily,
} from './model-registry';
import { corpusTaskRef, type CorpusTask, type CorpusTaskRef } from './model-eval-corpus';

export type ModelEvalCorpusSource = 'shadow-calls' | 'replay-history' | 'curated-fixtures';

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
   * history rather than a fixed manifest.
   */
  corpusTasks?: CorpusTaskRef[];
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
    scoring: {
      quality: 0.5,
      cost: 0.25,
      latency: 0.15,
      reliability: 0.1,
    },
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
