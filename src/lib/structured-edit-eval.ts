/**
 * Reproducible TypeScript structured-edit benchmark substrate (#2296).
 *
 * This is a deliberately small adaptation of oh-my-pi's TypeScript edit
 * benchmark. It keeps the useful seams -- Babel-selected, source-range
 * mutations; formatter-equivalent verification; and separate task/tool
 * reliability metrics -- while using CHD-owned fixtures and the three task
 * classes from #2139. The host-only runner lives in
 * `scripts/model-eval-run.mjs`; importing this module never invokes a model or
 * performs network I/O.
 */

import { TASK_CLASSES, type TaskClass } from './task-class';

export const STRUCTURED_EDIT_MUTATIONS = [
  'swap-comparison',
  'swap-equality',
  'swap-logical',
  'flip-boolean',
] as const;
export type StructuredEditMutationKind = (typeof STRUCTURED_EDIT_MUTATIONS)[number];

export interface StructuredEditMutationSpec {
  kind: StructuredEditMutationKind;
  /** Zero-based candidate selected in source order after Babel traversal. */
  candidateIndex: number;
  /** Auditable assertion: the selected token must equal this value. */
  from: string;
  /** Auditable assertion: the mutation must replace it with this value. */
  to: string;
}

export interface StructuredEditTask {
  id: string;
  title: string;
  instruction: string;
  taskClass: TaskClass;
  sourcePath: string;
  inputPath: string;
  expectedPath: string;
  mutation: StructuredEditMutationSpec;
  tags: string[];
}

export interface StructuredEditCorpus {
  schemaVersion: 1;
  kind: 'structured-edit-corpus';
  id: string;
  provenance: {
    method: 'adapted';
    upstream: string;
    upstreamCommit: string;
    license: 'MIT';
    noticePath: string;
  };
  tasks: StructuredEditTask[];
}

export interface AppliedStructuredEditMutation {
  content: string;
  kind: StructuredEditMutationKind;
  candidateIndex: number;
  lineNumber: number;
  originalSnippet: string;
  mutatedSnippet: string;
  from: string;
  to: string;
}

export interface StructuredEditScore {
  /** Literal raw-byte equality, before any normalization. */
  byte_exact_match: boolean;
  /** Equality after line-ending normalization, before formatter fallback. */
  normalized_exact_match: boolean;
  /** Upstream-style Prettier equivalence; this is the objective quality gate. */
  normalized_match: boolean;
  verification_passed: boolean;
  comparison: 'byte-exact' | 'normalized-exact' | 'prettier-equivalent' | 'mismatch';
  /** Formatter distance only; lower is better and it never changes pass/fail. */
  indent_score: number;
  expected_sha256: string;
  actual_sha256: string;
}

export interface StructuredEditRunTelemetry {
  input_tokens: number;
  output_tokens: number;
  read_calls: number;
  edit_calls: number;
  write_calls: number;
  edit_successes: number;
  edit_failures: number;
  write_successes: number;
  write_failures: number;
  /** Attempts that read the task but never invoked an edit or write tool. */
  read_without_edit_attempts: number;
  retries_used: number;
  duration_ms: number | null;
  cost_usd: number | null;
  resolved_model_id: string | null;
  /** False when any paid attempt lacked parseable usage/cost/duration evidence. */
  telemetry_complete: boolean;
  transport_failure: boolean;
  failure_reason: string | null;
}

export type StructuredEditToolEvidence =
  | {
      type: 'tool_use';
      id: string;
      name: string;
      /** Sanitized target marker; no source path or tool payload is retained. */
      input: { task_path: boolean };
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      is_error: boolean;
    };

export interface StructuredEditAttemptEvidence {
  attempt: number;
  phase: 'worker' | 'task-boundary';
  worker_output_sha256: string | null;
  worker_stderr_sha256: string | null;
  output_parsed: boolean;
  parser: {
    format: 'json' | 'stream-json' | null;
    event_count: number | null;
    malformed_lines: number | null;
  } | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  } | null;
  duration_ms: number | null;
  cost_usd: number | null;
  resolved_model_id: string | null;
  tool_events: StructuredEditToolEvidence[];
  launch: {
    launcher: string;
    argv: string[];
    argv_sha256: string;
    env_override_keys: string[];
    /** Exact key names present in the scrubbed worker environment; never values. */
    effective_env_keys: string[];
    settings: Record<string, unknown> | null;
    settings_sha256: string | null;
  } | null;
  exit_code: number | null;
  signal: string | null;
  score: StructuredEditScore;
  telemetry: StructuredEditRunTelemetry;
}

export interface StructuredEditTaskResult extends StructuredEditScore {
  task_id: string;
  task_class: TaskClass;
  model_id: string;
  input_sha256: string;
  mutation: StructuredEditMutationKind;
  /** At least one Edit/MultiEdit/Write invocation applied successfully. */
  edit_success: boolean;
  /** Combined mutating-tool attempts (Edit/MultiEdit/Write), retained for consumers. */
  edit_attempts: number;
  /** Combined successful mutating-tool results. Not task quality. */
  edit_successes: number;
  /** Attempt-level history; unlike ghost_run, this survives a successful retry. */
  read_without_edit_attempts: number;
  /** #2296 contract: the worker read input but emitted no edit/write. */
  ghost_run: boolean;
  /** Explicit alias retained so consumers cannot misread ghost semantics. */
  read_without_edit: boolean;
  /** Upstream's distinct ghost definition: failed with zero tokens/tool calls. */
  zero_activity_run: boolean;
  transport_failure: boolean;
  retries_used: number;
  telemetry: StructuredEditRunTelemetry;
  /** Sanitized attempt evidence sufficient to recompute telemetry and retry scoring. */
  attempts: StructuredEditAttemptEvidence[];
}

export interface StructuredEditClassMetrics {
  task_class: TaskClass;
  n: number;
  byte_exact_matches: number;
  normalized_matches: number;
  verification_passes: number;
  verification_rate: number | null;
  edit_attempts: number;
  edit_successes: number;
  edit_success_rate: number | null;
  ghost_runs: number;
  read_without_edit_runs: number;
  read_without_edit_attempts: number;
  zero_activity_runs: number;
  transport_failures: number;
  retries_used: number;
}

/** Merge attempt telemetry without erasing failures that preceded a retry. */
export function mergeStructuredEditTelemetry(
  total: StructuredEditRunTelemetry,
  next: StructuredEditRunTelemetry
): StructuredEditRunTelemetry {
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    read_calls: total.read_calls + next.read_calls,
    edit_calls: total.edit_calls + next.edit_calls,
    write_calls: total.write_calls + next.write_calls,
    edit_successes: total.edit_successes + next.edit_successes,
    edit_failures: total.edit_failures + next.edit_failures,
    write_successes: total.write_successes + next.write_successes,
    write_failures: total.write_failures + next.write_failures,
    read_without_edit_attempts:
      total.read_without_edit_attempts + next.read_without_edit_attempts,
    retries_used: Math.max(total.retries_used, next.retries_used),
    // Null means "unknown paid work", not zero. Once one attempt is
    // unparseable, a later known receipt must not turn the aggregate into an
    // apparently complete subtotal.
    duration_ms:
      total.duration_ms == null || next.duration_ms == null
        ? null
        : total.duration_ms + next.duration_ms,
    cost_usd:
      total.cost_usd == null || next.cost_usd == null
        ? null
        : total.cost_usd + next.cost_usd,
    resolved_model_id: next.resolved_model_id ?? total.resolved_model_id,
    telemetry_complete: total.telemetry_complete && next.telemetry_complete,
    transport_failure: total.transport_failure || next.transport_failure,
    failure_reason: next.failure_reason ?? total.failure_reason,
  };
}

export interface StructuredEditEvalResult {
  schemaVersion: 1;
  kind: 'structured-edit-model-eval';
  source: 'model-eval';
  createdAt: string;
  model_id: string;
  completion: {
    status: 'in-progress' | 'complete';
    selected_tasks: number;
    completed_tasks: number;
  };
  corpus: {
    id: string;
    upstream: string;
    upstream_commit: string;
    license: 'MIT';
    manifest_sha256: string;
  };
  execution: {
    mode: 'offline-score' | 'jailed-model';
    jail: 'none' | 'srt';
    egress: 'none' | 'model-only';
    max_budget_usd: number | null;
  };
  runner: {
    version: 3;
    script_path: 'scripts/model-eval-run.mjs';
    script_sha256: string;
    scorer_path: 'scripts/lib/model-edit-benchmark.ts';
    scorer_sha256: string;
    jail: {
      gate: { ok: boolean; reason: string | null };
      modules: { name: string; path: string; sha256: string }[];
      binaries: {
        name: string;
        path: string | null;
        version: string | null;
        sha256: string | null;
      }[];
    } | null;
  };
  tasks: StructuredEditTaskResult[];
  by_task_class: StructuredEditClassMetrics[];
  totals: Omit<StructuredEditClassMetrics, 'task_class'>;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeRelativePath(value: unknown): string | null {
  const path = cleanText(value);
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) return null;
  return path;
}

function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as readonly string[]).includes(value);
}

function isMutationKind(value: unknown): value is StructuredEditMutationKind {
  return (
    typeof value === 'string' &&
    (STRUCTURED_EDIT_MUTATIONS as readonly string[]).includes(value)
  );
}

function parseMutation(value: unknown): StructuredEditMutationSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isMutationKind(raw.kind)) return null;
  if (
    typeof raw.candidateIndex !== 'number' ||
    !Number.isInteger(raw.candidateIndex) ||
    raw.candidateIndex < 0
  ) {
    return null;
  }
  const from = cleanText(raw.from);
  const to = cleanText(raw.to);
  if (!from || !to || from === to) return null;
  return { kind: raw.kind, candidateIndex: raw.candidateIndex, from, to };
}

function parseTask(value: unknown): StructuredEditTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id);
  const title = cleanText(raw.title);
  const instruction = cleanText(raw.instruction);
  const sourcePath = safeRelativePath(raw.sourcePath);
  const inputPath = safeRelativePath(raw.inputPath);
  const expectedPath = safeRelativePath(raw.expectedPath);
  const mutation = parseMutation(raw.mutation);
  if (
    !id ||
    !/^[a-z0-9][a-z0-9-]*$/.test(id) ||
    !title ||
    !instruction ||
    !isTaskClass(raw.taskClass) ||
    !sourcePath ||
    !inputPath ||
    !expectedPath ||
    !mutation
  ) {
    return null;
  }
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map(cleanText).filter((tag): tag is string => tag !== null))]
    : [];
  return {
    id,
    title,
    instruction,
    taskClass: raw.taskClass,
    sourcePath,
    inputPath,
    expectedPath,
    mutation,
    tags,
  };
}

/** Fail-closed parser for the committed structured-edit manifest. */
export function parseStructuredEditCorpus(value: unknown): StructuredEditCorpus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.kind !== 'structured-edit-corpus') return null;
  const id = cleanText(raw.id);
  const provenanceRaw =
    raw.provenance && typeof raw.provenance === 'object' && !Array.isArray(raw.provenance)
      ? (raw.provenance as Record<string, unknown>)
      : null;
  if (!id || !provenanceRaw || provenanceRaw.method !== 'adapted') return null;
  const upstream = cleanText(provenanceRaw.upstream);
  const upstreamCommit = cleanText(provenanceRaw.upstreamCommit);
  const noticePath = safeRelativePath(provenanceRaw.noticePath);
  if (
    !upstream ||
    !upstreamCommit ||
    !/^[0-9a-f]{40}$/.test(upstreamCommit) ||
    provenanceRaw.license !== 'MIT' ||
    !noticePath
  ) {
    return null;
  }

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map(parseTask).filter((task): task is StructuredEditTask => task !== null)
    : [];
  if (tasks.length !== (Array.isArray(raw.tasks) ? raw.tasks.length : 0)) return null;
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length || TASK_CLASSES.some((taskClass) => !tasks.some((t) => t.taskClass === taskClass))) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: 'structured-edit-corpus',
    id,
    provenance: {
      method: 'adapted',
      upstream,
      upstreamCommit,
      license: 'MIT',
      noticePath,
    },
    tasks,
  };
}

/** Build one task result while preserving quality vs edit-tool reliability semantics. */
export function buildStructuredEditTaskResult(input: {
  task: StructuredEditTask;
  modelId: string;
  inputSha256: string;
  score: StructuredEditScore;
  telemetry: StructuredEditRunTelemetry;
  attempts?: StructuredEditAttemptEvidence[];
}): StructuredEditTaskResult {
  const { task, modelId, inputSha256, score, telemetry } = input;
  const editAttempts = telemetry.edit_calls + telemetry.write_calls;
  const editSuccesses = Math.min(
    editAttempts,
    Math.max(0, telemetry.edit_successes) + Math.max(0, telemetry.write_successes)
  );
  const activity =
    telemetry.input_tokens +
    telemetry.output_tokens +
    telemetry.read_calls +
    telemetry.edit_calls +
    telemetry.write_calls;
  const readWithoutEdit =
    telemetry.telemetry_complete &&
    telemetry.read_calls > 0 &&
    telemetry.edit_calls === 0 &&
    telemetry.write_calls === 0;
  return {
    task_id: task.id,
    task_class: task.taskClass,
    model_id: modelId,
    input_sha256: inputSha256,
    mutation: task.mutation.kind,
    ...score,
    edit_success: editSuccesses > 0,
    edit_attempts: editAttempts,
    edit_successes: editSuccesses,
    read_without_edit_attempts: telemetry.read_without_edit_attempts,
    ghost_run: readWithoutEdit,
    read_without_edit: readWithoutEdit,
    zero_activity_run:
      !score.verification_passed && telemetry.telemetry_complete && activity === 0,
    transport_failure: telemetry.transport_failure,
    retries_used: telemetry.retries_used,
    telemetry,
    attempts: input.attempts ?? [],
  };
}

function summarizeRuns(runs: readonly StructuredEditTaskResult[]): Omit<StructuredEditClassMetrics, 'task_class'> {
  const editAttempts = runs.reduce((sum, run) => sum + run.edit_attempts, 0);
  const editSuccesses = runs.reduce((sum, run) => sum + run.edit_successes, 0);
  const verificationPasses = runs.filter((run) => run.verification_passed).length;
  return {
    n: runs.length,
    byte_exact_matches: runs.filter((run) => run.byte_exact_match).length,
    normalized_matches: runs.filter((run) => run.normalized_match).length,
    verification_passes: verificationPasses,
    verification_rate: runs.length > 0 ? verificationPasses / runs.length : null,
    edit_attempts: editAttempts,
    edit_successes: editSuccesses,
    edit_success_rate: editAttempts > 0 ? editSuccesses / editAttempts : null,
    ghost_runs: runs.filter((run) => run.ghost_run).length,
    read_without_edit_runs: runs.filter((run) => run.read_without_edit).length,
    read_without_edit_attempts: runs.reduce(
      (sum, run) => sum + run.read_without_edit_attempts,
      0
    ),
    zero_activity_runs: runs.filter((run) => run.zero_activity_run).length,
    transport_failures: runs.filter((run) => run.transport_failure).length,
    retries_used: runs.reduce((sum, run) => sum + run.retries_used, 0),
  };
}

/** Stable per-class rollup consumed by the later model-pin savings slice (#2140). */
export function summarizeStructuredEditByTaskClass(
  runs: readonly StructuredEditTaskResult[]
): StructuredEditClassMetrics[] {
  return TASK_CLASSES.map((taskClass) => ({
    task_class: taskClass,
    ...summarizeRuns(runs.filter((run) => run.task_class === taskClass)),
  }));
}

export function buildStructuredEditEvalResult(input: {
  modelId: string;
  corpus: StructuredEditCorpus;
  runs: StructuredEditTaskResult[];
  manifestSha256: string;
  execution: StructuredEditEvalResult['execution'];
  runner: StructuredEditEvalResult['runner'];
  completion?: StructuredEditEvalResult['completion'];
  createdAt?: string;
}): StructuredEditEvalResult {
  const tasks = [...input.runs].sort((a, b) => a.task_id.localeCompare(b.task_id));
  return {
    schemaVersion: 1,
    kind: 'structured-edit-model-eval',
    source: 'model-eval',
    createdAt: input.createdAt ?? new Date().toISOString(),
    model_id: input.modelId,
    completion: input.completion ?? {
      status: 'complete',
      selected_tasks: tasks.length,
      completed_tasks: tasks.length,
    },
    corpus: {
      id: input.corpus.id,
      upstream: input.corpus.provenance.upstream,
      upstream_commit: input.corpus.provenance.upstreamCommit,
      license: input.corpus.provenance.license,
      manifest_sha256: input.manifestSha256,
    },
    execution: input.execution,
    runner: input.runner,
    tasks,
    by_task_class: summarizeStructuredEditByTaskClass(tasks),
    totals: summarizeRuns(tasks),
  };
}

// ── Two-arm schema-constrained repair comparison (#2726) ──────────────────────
// The report half of the structured-edit repair-lever eval. The generation half
// (loopback endpoint, edit-DSL repair loop, deterministic apply) lives in
// structured-edit-arm-eval.ts; the offline quality scoring reuses the existing
// `scoreStructuredEdit` path. This module owns the shared record type + the pure
// fold so a scripted-fixture run cannot be over-read as a live receipt.

/** The two arms this eval compares. */
export const STRUCTURED_EDIT_ARMS = ['free-form', 'constrained'] as const;
export type StructuredEditArm = (typeof STRUCTURED_EDIT_ARMS)[number];

/**
 * Provenance of the endpoint that produced a comparison: `'scripted'` = an
 * in-process synthetic fixture run (NOT a live receipt), `'live'` = a real
 * local-model transport. Stamped into the record so #2138's confidence loop and
 * this repo's publish-only-if-proven posture can never over-read a scripted
 * fixture run as a live-model receipt. The committed/synthetic driver defaults
 * to `'scripted'`.
 */
export type StructuredEditArmEndpointKind = 'scripted' | 'live';

/**
 * One task's two-arm outcome: whether each arm's produced file passed the
 * deterministic quality gate (`verification_passed` from `scoreStructuredEdit`)
 * and how many repair rounds the constrained arm spent (0 = first completion
 * validated). This is the join of the offline quality receipt and the
 * constrained arm's repair telemetry.
 */
export interface StructuredEditArmOutcome {
  task_id: string;
  task_class: TaskClass;
  pass_free_form: boolean;
  pass_constrained: boolean;
  repair_rounds: number;
}

/** Per-class two-arm rollup: pass COUNTS per arm plus the repair-round histogram. */
export interface StructuredEditArmClassComparison {
  task_class: TaskClass;
  n: number;
  pass_free_form: number;
  pass_constrained: number;
  /**
   * Maps a constrained-arm round count (string key) to how many samples in the
   * class spent that many rounds. NOTE: the terminal bucket (`maxRepairRounds`)
   * merges "passed after N repairs" and "failed, exhausted at N"; cross-reference
   * `pass_constrained` to separate them.
   */
  repair_rounds_histogram: Record<string, number>;
}

/**
 * The per-task-class two-arm comparison record consumed by #2138's confidence
 * loop. `by_task_class` always carries all three {@link TASK_CLASSES} (n = 0 for
 * an absent class) so a caller can partition without losing a class.
 */
export interface StructuredEditArmComparison {
  schemaVersion: 1;
  kind: 'structured-edit-arm-comparison';
  source: 'model-eval';
  /** Synthetic-vs-live provenance; see {@link StructuredEditArmEndpointKind}. */
  endpointKind: StructuredEditArmEndpointKind;
  /** The repair-round bound the constrained arm ran under. */
  maxRepairRounds: number;
  asOf: string;
  n: number;
  pass_free_form: number;
  pass_constrained: number;
  by_task_class: StructuredEditArmClassComparison[];
  totals: Omit<StructuredEditArmClassComparison, 'task_class'>;
}

function summarizeArmOutcomes(
  outcomes: readonly StructuredEditArmOutcome[]
): Omit<StructuredEditArmClassComparison, 'task_class'> {
  const repair_rounds_histogram: Record<string, number> = {};
  let pass_free_form = 0;
  let pass_constrained = 0;
  for (const o of outcomes) {
    if (o.pass_free_form) pass_free_form += 1;
    if (o.pass_constrained) pass_constrained += 1;
    const key = String(o.repair_rounds);
    repair_rounds_histogram[key] = (repair_rounds_histogram[key] ?? 0) + 1;
  }
  return { n: outcomes.length, pass_free_form, pass_constrained, repair_rounds_histogram };
}

/**
 * Fold per-task two-arm outcomes into the per-class comparison record. Pure and
 * deterministic — the `asOf` and `endpointKind` are INJECTED (never read from
 * the wall clock or defaulted here), so a fixture run is reproducible and its
 * scripted provenance is explicit.
 */
export function buildStructuredEditArmComparison(
  outcomes: readonly StructuredEditArmOutcome[],
  meta: { asOf: string; maxRepairRounds: number; endpointKind: StructuredEditArmEndpointKind }
): StructuredEditArmComparison {
  const totals = summarizeArmOutcomes(outcomes);
  return {
    schemaVersion: 1,
    kind: 'structured-edit-arm-comparison',
    source: 'model-eval',
    endpointKind: meta.endpointKind,
    maxRepairRounds: meta.maxRepairRounds,
    asOf: meta.asOf,
    n: totals.n,
    pass_free_form: totals.pass_free_form,
    pass_constrained: totals.pass_constrained,
    by_task_class: TASK_CLASSES.map((taskClass) => ({
      task_class: taskClass,
      ...summarizeArmOutcomes(outcomes.filter((o) => o.task_class === taskClass)),
    })),
    totals,
  };
}
