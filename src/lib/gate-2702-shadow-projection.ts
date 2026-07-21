/**
 * Bounded, display-safe projection of the verified #2702 C5 experiment.
 *
 * This module deliberately accepts only the already-verified output of
 * `scripts/gate-2702/evaluate.mjs#loadCurrentEvaluation`. It never opens the
 * seal's object store and never copies arbitrary strings out of Runs or the
 * Verdict. Every returned field is reconstructed from a small allowlist, so
 * prompts, transcripts, diffs, process streams, raw artifacts, and error prose
 * cannot enter `/api/shadow-experiments.json` by accident.
 */

const C5_DEFINITION_REF = Object.freeze({
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
});

const C5_SUBJECTS = new Set([2760, 2719, 2713, 2706, 2710, 2670]);
const C5_TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"] as const;
const C5_CHECKS = [
  "checks/gate-2702-typecheck",
  "checks/gate-2702-vitest",
] as const;
const C5_GATES = [
  "parityFloor",
  "netPositiveCost",
  "attributableShips",
  "minimumSample",
] as const;
const C5_DECISIONS = new Set([
  "sidekick-clears",
  "sidekick-does-not-clear",
  "inconclusive",
  "invalid",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_REASON_PATTERN = /^[a-z0-9][a-z0-9._:/,-]{0,255}$/;
const ISSUE_ARTIFACT_PATTERN =
  /^github:shpwrck\/claude-history-dashboard\/issues\/([0-9]+)$/;

const QUALITY_METRIC = "metrics/gate-2702-quality-loss";
const SIDEKICK_TRIGGER_METRIC = "metrics/gate-2702-sidekick-triggers";
const SIDEKICK_CALL_METRIC = "metrics/gate-2702-sidekick-paid-calls";
const SIDEKICK_SHIP_METRIC = "metrics/gate-2702-sidekick-shipped-interventions";

export const DEFAULT_GATE_2702_MAX_ROWS = 500;
export const DEFAULT_GATE_2702_MAX_EVALUATIONS = 100;

export type Gate2702TreatmentId = (typeof C5_TREATMENTS)[number];
export type Gate2702CheckId = (typeof C5_CHECKS)[number];
export type Gate2702GateId = (typeof C5_GATES)[number];

export type Gate2702TerminalClassification =
  | "succeeded"
  | "check-failed"
  | "tooling-invalid"
  | "cancelled"
  | "cost-unknown"
  | "failed"
  | "excluded";

export type Gate2702JudgeState =
  | "quality-held"
  | "quality-loss"
  | "exhausted"
  | "unavailable"
  | "sealed-result"
  | "not-evaluated";

export interface Gate2702ObjectiveCheck {
  checkId: Gate2702CheckId;
  outcome: "passed" | "failed";
}

export interface Gate2702RunProjection {
  rowId: string;
  trialId: string;
  runId: string | null;
  subject: number;
  treatmentId: Gate2702TreatmentId;
  attempt: 1 | 2;
  finishedAt: string | null;
  terminalClassification: Gate2702TerminalClassification;
  objectiveChecks: Gate2702ObjectiveCheck[];
  judgeState: Gate2702JudgeState;
  wallTimeMs: number | null;
  allInCostUsd: number | null;
  sidekick: {
    triggerCount: number | null;
    paidCallCount: number | null;
    shippedInterventionCount: number | null;
  };
  exclusionReason: string | null;
}

export type Gate2702EvaluationOutcome =
  | { kind: "winner"; winningTreatmentId: Gate2702TreatmentId }
  | { kind: "tie" }
  | { kind: "inconclusive"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "insufficient-evidence"; reason: string };

export interface Gate2702EvaluationProjection {
  trialId: string;
  evaluatedAt: string;
  outcome: Gate2702EvaluationOutcome;
  decision:
    | "sidekick-clears"
    | "sidekick-does-not-clear"
    | "inconclusive"
    | "invalid"
    | "insufficient-evidence";
  sampleCounts: Array<{ treatmentId: Gate2702TreatmentId; n: number }>;
  gates: Array<{
    gateId: Gate2702GateId;
    state: "passed" | "failed" | "not-evaluable";
  }>;
  includedRunCount: number;
  excludedRunCount: number;
  exclusionCounts: Array<{ reason: string; count: number }>;
}

export interface Gate2702Projection {
  /** Run-candidate summaries before the newest-row bound. */
  total: number;
  returned: number;
  /** Older run summaries omitted by `maxRows`. */
  dropped: number;
  rows: Gate2702RunProjection[];
  evaluationTotal: number;
  evaluationReturned: number;
  evaluationsDropped: number;
  evaluations: Gate2702EvaluationProjection[];
  reconciliation: {
    scanned: number;
    validated: number;
    unsealed: number;
    malformed: number;
  };
}

export type Gate2702ProjectionSource =
  | { state: "unsealed"; trialId?: string; count?: number }
  | { state: "malformed"; trialId?: string; count?: number }
  | {
      state: "verified";
      marker: Record<string, unknown>;
      manifest: Record<string, unknown>;
      runs: unknown[];
      evaluation: Record<string, unknown>;
    };

type UnknownRecord = Record<string, unknown>;

interface CandidateSummary {
  subject: number;
  treatmentId: Gate2702TreatmentId;
  attempt: 1 | 2;
  status: "succeeded" | "failed" | "cancelled";
  runId: string | null;
  runDigest: string | null;
  exclusion: string | null;
}

interface RunSummary {
  runId: string;
  contentDigest: string;
  subject: number;
  treatmentId: Gate2702TreatmentId;
  status: "succeeded" | "failed" | "cancelled";
  finishedAt: string;
  objectiveChecks: Gate2702ObjectiveCheck[];
  errorCode: string | null;
  judgeState: Gate2702JudgeState;
  wallTimeMs: number;
  allInCostUsd: number;
  sidekick: Gate2702RunProjection["sidekick"];
}

interface ProjectionItem {
  row: Gate2702RunProjection;
  sortAt: number;
}

function fail(): never {
  throw new Error("Malformed #2702 C5 projection source");
}

function record(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail();
  return value as UnknownRecord;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail();
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail();
  }
  return value;
}

function safeReason(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REASON_PATTERN.test(value)) fail();
  return value;
}

function finiteNonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail();
  return value;
}

function safeCount(value: unknown): number {
  const count = finiteNonNegative(value);
  if (!Number.isSafeInteger(count)) fail();
  return count;
}

function sameDefinitionRef(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const ref = value as UnknownRecord;
  return (
    ref.definitionId === C5_DEFINITION_REF.definitionId &&
    ref.definitionVersion === C5_DEFINITION_REF.definitionVersion &&
    ref.contentDigest === C5_DEFINITION_REF.contentDigest
  );
}

function treatmentId(value: unknown): Gate2702TreatmentId {
  if (value !== C5_TREATMENTS[0] && value !== C5_TREATMENTS[1]) fail();
  return value;
}

function terminalStatus(value: unknown): "succeeded" | "failed" | "cancelled" {
  if (value !== "succeeded" && value !== "failed" && value !== "cancelled")
    fail();
  return value;
}

function subjectFromArtifact(value: unknown): number {
  if (typeof value !== "string") fail();
  const match = ISSUE_ARTIFACT_PATTERN.exec(value);
  if (!match) fail();
  const subject = Number(match[1]);
  if (!C5_SUBJECTS.has(subject)) fail();
  return subject;
}

function candidateSummary(value: unknown): CandidateSummary {
  const candidate = record(value);
  const subject = safeCount(candidate.subject);
  if (!C5_SUBJECTS.has(subject)) fail();
  const attempt = safeCount(candidate.attempt);
  if (attempt !== 1 && attempt !== 2) fail();
  const runId = candidate.runId === undefined ? null : uuid(candidate.runId);
  const runDigest =
    candidate.runDigest === undefined ? null : digest(candidate.runDigest);
  const exclusion =
    candidate.exclusion === undefined ? null : safeReason(candidate.exclusion);
  if ((runId === null) !== (runDigest === null)) fail();
  if ((runId === null) === (exclusion === null)) fail();
  return {
    subject,
    treatmentId: treatmentId(candidate.treatmentId),
    attempt,
    status: terminalStatus(candidate.status),
    runId,
    runDigest,
    exclusion,
  };
}

function judgeResultSubjects(value: unknown): Set<number> {
  const subjects = new Set<number>();
  for (const candidate of array(value, C5_SUBJECTS.size)) {
    const result = record(candidate);
    const subject = safeCount(result.subject);
    if (!C5_SUBJECTS.has(subject) || subjects.has(subject)) fail();
    digest(result.contentDigest);
    subjects.add(subject);
  }
  return subjects;
}

function objectiveChecks(value: unknown): Gate2702ObjectiveCheck[] {
  const seen = new Set<string>();
  const checks = array(value, C5_CHECKS.length).map((candidate) => {
    const check = record(candidate);
    if (!C5_CHECKS.includes(check.checkId as Gate2702CheckId)) fail();
    if (check.outcome !== "passed" && check.outcome !== "failed") fail();
    if (seen.has(check.checkId as string)) fail();
    seen.add(check.checkId as string);
    return {
      checkId: check.checkId as Gate2702CheckId,
      outcome: check.outcome as Gate2702ObjectiveCheck["outcome"],
    };
  });
  return checks.sort((left, right) =>
    left.checkId.localeCompare(right.checkId),
  );
}

function selectedMetrics(value: unknown): Map<string, number> {
  const selected = new Map<string, number>();
  const allowed = new Set([
    QUALITY_METRIC,
    SIDEKICK_TRIGGER_METRIC,
    SIDEKICK_CALL_METRIC,
    SIDEKICK_SHIP_METRIC,
  ]);
  for (const candidate of array(value, 64)) {
    const observation = record(candidate);
    if (
      typeof observation.metricId !== "string" ||
      !allowed.has(observation.metricId)
    )
      continue;
    if (selected.has(observation.metricId)) fail();
    selected.set(observation.metricId, finiteNonNegative(observation.value));
  }
  return selected;
}

function optionalMetricCount(
  metrics: Map<string, number>,
  id: string,
): number | null {
  const value = metrics.get(id);
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value)) fail();
  return value;
}

function runSummary(value: unknown, trialId: string): RunSummary {
  const run = record(value);
  if (
    run.schemaVersion !== 1 ||
    run.kind !== "ExperimentRun" ||
    uuid(run.trialId) !== trialId ||
    !sameDefinitionRef(run.definitionRef)
  ) {
    fail();
  }
  const runId = uuid(run.runId);
  const contentDigest = digest(run.contentDigest);
  const selectedTreatment = treatmentId(run.treatmentId);
  const status = terminalStatus(run.status);
  const finishedAt = timestamp(run.finishedAt);
  const subjectRef = record(run.subjectRef);
  const subject = subjectFromArtifact(subjectRef.artifactId);
  const checks = objectiveChecks(run.checkResults);
  const usage = record(run.usage);
  const metrics = selectedMetrics(run.observations);
  const extensions = record(run.extensions);
  const judgeDigest = extensions["gate-2702/judgeResultDigest"];
  if (judgeDigest !== null && judgeDigest !== undefined) digest(judgeDigest);
  const errorCode = run.error === null ? null : record(run.error).code;
  if (errorCode !== null && typeof errorCode !== "string") fail();
  const qualityLoss = metrics.get(QUALITY_METRIC);
  let judgeState: Gate2702JudgeState;
  if (errorCode === "gate-2702/judge-exhausted") judgeState = "exhausted";
  else if (status !== "succeeded") judgeState = "not-evaluated";
  else if (judgeDigest === null || judgeDigest === undefined)
    judgeState = "unavailable";
  else if (qualityLoss === 0) judgeState = "quality-held";
  else if (qualityLoss === 1) judgeState = "quality-loss";
  else judgeState = "unavailable";
  return {
    runId,
    contentDigest,
    subject,
    treatmentId: selectedTreatment,
    status,
    finishedAt,
    objectiveChecks: checks,
    errorCode,
    judgeState,
    wallTimeMs: finiteNonNegative(usage.wallTimeMs),
    allInCostUsd: finiteNonNegative(usage.costUsd),
    sidekick: {
      triggerCount: optionalMetricCount(metrics, SIDEKICK_TRIGGER_METRIC),
      paidCallCount: optionalMetricCount(metrics, SIDEKICK_CALL_METRIC),
      shippedInterventionCount: optionalMetricCount(
        metrics,
        SIDEKICK_SHIP_METRIC,
      ),
    },
  };
}

function toolingFailure(
  errorCode: string | null,
  exclusion: string | null,
): boolean {
  return (
    errorCode === "gate-2702/tooling-artifact" ||
    errorCode === "gate-2702/worker-process-failure" ||
    errorCode === "gate-2702/worker-output-invalid" ||
    errorCode === "gate-2702/behavior-context-drift" ||
    exclusion === "behavior-context-drift" ||
    exclusion === "complete-behavior-fingerprint-unavailable" ||
    exclusion?.includes("tooling-artifact") === true
  );
}

function terminalClassification(
  candidate: CandidateSummary,
  run: RunSummary | null,
): Gate2702TerminalClassification {
  if (candidate.exclusion?.startsWith("unknown-all-in-cost:"))
    return "cost-unknown";
  if (toolingFailure(run?.errorCode ?? null, candidate.exclusion))
    return "tooling-invalid";
  if (candidate.status === "cancelled") return "cancelled";
  if (run?.objectiveChecks.some((check) => check.outcome === "failed"))
    return "check-failed";
  if (candidate.exclusion !== null) return "excluded";
  if (candidate.status === "succeeded") return "succeeded";
  return "failed";
}

function sampleCounts(
  value: unknown,
): Array<{ treatmentId: Gate2702TreatmentId; n: number }> {
  const byTreatment = new Map<Gate2702TreatmentId, number>();
  for (const candidate of array(value, C5_TREATMENTS.length)) {
    const count = record(candidate);
    const treatment = treatmentId(count.treatmentId);
    if (byTreatment.has(treatment)) fail();
    byTreatment.set(treatment, safeCount(count.n));
  }
  if (byTreatment.size !== C5_TREATMENTS.length) fail();
  return C5_TREATMENTS.map((treatment) => ({
    treatmentId: treatment,
    n: byTreatment.get(treatment)!,
  }));
}

function gateProjection(value: unknown): {
  gates: Gate2702EvaluationProjection["gates"];
  fallbackSampleCounts: Gate2702EvaluationProjection["sampleCounts"];
  decision: Gate2702EvaluationProjection["decision"];
} {
  const parameters = record(value);
  if (
    typeof parameters.decision !== "string" ||
    !C5_DECISIONS.has(parameters.decision)
  )
    fail();
  const rawGates = record(parameters.gates);
  const gates = C5_GATES.map((gateId) => {
    const gate = record(rawGates[gateId]);
    if (
      gate.state !== "passed" &&
      gate.state !== "failed" &&
      gate.state !== "not-evaluable"
    ) {
      fail();
    }
    return {
      gateId,
      state:
        gate.state as Gate2702EvaluationProjection["gates"][number]["state"],
    };
  });
  const minimumObserved = record(record(rawGates.minimumSample).observed);
  const fallbackSampleCounts = [
    {
      treatmentId: C5_TREATMENTS[0],
      n: safeCount(minimumObserved.controlRuns),
    },
    {
      treatmentId: C5_TREATMENTS[1],
      n: safeCount(minimumObserved.treatmentRuns),
    },
  ];
  return {
    gates,
    fallbackSampleCounts,
    decision: parameters.decision as Gate2702EvaluationProjection["decision"],
  };
}

function verdictOutcome(value: unknown): Gate2702EvaluationOutcome {
  const outcome = record(value);
  if (outcome.kind === "winner") {
    return {
      kind: "winner",
      winningTreatmentId: treatmentId(outcome.winningTreatmentId),
    };
  }
  if (outcome.kind === "tie") return { kind: "tie" };
  if (outcome.kind === "inconclusive" || outcome.kind === "invalid") {
    return { kind: outcome.kind, reason: safeReason(outcome.reason) };
  }
  fail();
}

function exclusionCounts(
  reasons: string[],
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons)
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

function projectVerified(
  source: Extract<Gate2702ProjectionSource, { state: "verified" }>,
): {
  rows: ProjectionItem[];
  evaluation: Gate2702EvaluationProjection;
} {
  const marker = record(source.marker);
  const manifest = record(source.manifest);
  if (marker.verified !== true || !sameDefinitionRef(marker.definitionRef))
    fail();
  const trialId = uuid(marker.trialId);
  const bundleDigest = digest(marker.bundleDigest);
  timestamp(marker.sealedAt);
  if (
    uuid(manifest.trialId) !== trialId ||
    !sameDefinitionRef(manifest.definitionRef) ||
    digest(manifest.contentDigest) !== bundleDigest
  ) {
    fail();
  }

  const candidates = array(manifest.runCandidates, 4_096).map(candidateSummary);
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.subject}\0${candidate.treatmentId}\0${candidate.attempt}`;
    if (candidateKeys.has(key)) fail();
    candidateKeys.add(key);
  }
  const judgedSubjects = judgeResultSubjects(manifest.judgeResults);
  const candidateSubjects = new Set(
    candidates.map((candidate) => candidate.subject),
  );
  for (const subject of judgedSubjects) {
    if (!candidateSubjects.has(subject)) fail();
  }
  for (const candidate of candidates) {
    if (
      candidate.exclusion === "judge-quality-not-evaluable" &&
      !judgedSubjects.has(candidate.subject)
    ) {
      fail();
    }
    if (
      candidate.exclusion === "selected-pair-judge-unavailable" &&
      judgedSubjects.has(candidate.subject)
    ) {
      fail();
    }
  }

  const runs = array(source.runs, 4_096).map((run) => runSummary(run, trialId));
  const runById = new Map(runs.map((run) => [run.runId, run]));
  if (runById.size !== runs.length) fail();
  const candidateRunIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.runId ? [candidate.runId] : [],
    ),
  );
  if (
    candidateRunIds.size !== runs.length ||
    runs.some((run) => !candidateRunIds.has(run.runId))
  )
    fail();
  for (const candidate of candidates) {
    if (!candidate.runId) continue;
    const run = runById.get(candidate.runId);
    if (
      !run ||
      candidate.runDigest !== run.contentDigest ||
      candidate.subject !== run.subject ||
      candidate.treatmentId !== run.treatmentId ||
      candidate.status !== run.status
    ) {
      fail();
    }
  }

  const evaluation = record(source.evaluation);
  if (
    evaluation.schemaVersion !== 1 ||
    uuid(evaluation.trialId) !== trialId ||
    !sameDefinitionRef(evaluation.definitionRef) ||
    !DIGEST_PATTERN.test(String(evaluation.contentDigest ?? ""))
  ) {
    fail();
  }

  let evaluatedAt: string;
  let projectedOutcome: Gate2702EvaluationOutcome;
  let decision: Gate2702EvaluationProjection["decision"];
  let projectedSampleCounts: Gate2702EvaluationProjection["sampleCounts"];
  let gates: Gate2702EvaluationProjection["gates"];
  let includedRunCount = 0;
  let excludedRunCount = 0;
  const verdictExclusionByRun = new Map<string, string>();
  const allExclusionReasons = candidates.flatMap((candidate) =>
    candidate.exclusion ? [candidate.exclusion] : [],
  );

  if (evaluation.kind === "Gate2702InsufficientEvidence") {
    if (
      runs.length !== 0 ||
      evaluation.bundleDigest !== bundleDigest ||
      evaluation.state !== "insufficient-evidence"
    ) {
      fail();
    }
    evaluatedAt = timestamp(evaluation.evaluatedAt);
    const reason = safeReason(evaluation.reason);
    projectedOutcome = { kind: "insufficient-evidence", reason };
    decision = "insufficient-evidence";
    projectedSampleCounts = sampleCounts(evaluation.sampleCounts);
    gates = [];
    excludedRunCount = candidates.length;
  } else if (evaluation.kind === "ExperimentVerdict") {
    const extensions = record(evaluation.extensions);
    if (extensions["gate-2702/bundleDigest"] !== bundleDigest) fail();
    evaluatedAt = timestamp(evaluation.updatedAt);
    projectedOutcome = verdictOutcome(evaluation.outcome);
    const policyResult = record(evaluation.policyResult);
    const projectedGates = gateProjection(policyResult.parameters);
    decision = projectedGates.decision;
    gates = projectedGates.gates;
    const primaryEffect = evaluation.primaryEffect;
    projectedSampleCounts =
      primaryEffect === null
        ? projectedGates.fallbackSampleCounts
        : sampleCounts(record(primaryEffect).sampleCounts);

    const evidence = record(evaluation.evidence);
    const referenced = new Set<string>();
    for (const candidate of array(evidence.includedRuns, 4_096)) {
      const ref = record(candidate);
      const runId = uuid(ref.runId);
      const run = runById.get(runId);
      if (
        !run ||
        digest(ref.contentDigest) !== run.contentDigest ||
        referenced.has(runId)
      )
        fail();
      referenced.add(runId);
      includedRunCount++;
    }
    for (const candidate of array(evidence.excludedRuns, 4_096)) {
      const excluded = record(candidate);
      const ref = record(excluded.run);
      const runId = uuid(ref.runId);
      const run = runById.get(runId);
      const reason = safeReason(excluded.reason);
      if (
        !run ||
        digest(ref.contentDigest) !== run.contentDigest ||
        referenced.has(runId)
      )
        fail();
      referenced.add(runId);
      verdictExclusionByRun.set(runId, reason);
      allExclusionReasons.push(reason);
      excludedRunCount++;
    }
    if (referenced.size !== runs.length) fail();
  } else {
    fail();
  }

  const rows = candidates.map((candidate): ProjectionItem => {
    const run = candidate.runId ? (runById.get(candidate.runId) ?? null) : null;
    const exclusionReason =
      candidate.exclusion ??
      (candidate.runId
        ? (verdictExclusionByRun.get(candidate.runId) ?? null)
        : null);
    const row: Gate2702RunProjection = {
      rowId: `${trialId}:${candidate.subject}:${candidate.treatmentId}:${candidate.attempt}`,
      trialId,
      runId: run?.runId ?? null,
      subject: candidate.subject,
      treatmentId: candidate.treatmentId,
      attempt: candidate.attempt,
      finishedAt: run?.finishedAt ?? null,
      terminalClassification: terminalClassification(candidate, run),
      objectiveChecks: run?.objectiveChecks ?? [],
      judgeState:
        run?.judgeState ??
        (judgedSubjects.has(candidate.subject)
          ? "sealed-result"
          : candidate.exclusion === "selected-pair-judge-unavailable"
            ? "unavailable"
            : "not-evaluated"),
      wallTimeMs: run?.wallTimeMs ?? null,
      allInCostUsd: run?.allInCostUsd ?? null,
      sidekick: run?.sidekick ?? {
        triggerCount: null,
        paidCallCount: null,
        shippedInterventionCount: null,
      },
      exclusionReason,
    };
    return { row, sortAt: Date.parse(run?.finishedAt ?? evaluatedAt) };
  });

  return {
    rows,
    evaluation: {
      trialId,
      evaluatedAt,
      outcome: projectedOutcome,
      decision,
      sampleCounts: projectedSampleCounts,
      gates,
      includedRunCount,
      excludedRunCount,
      exclusionCounts: exclusionCounts(allExclusionReasons),
    },
  };
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Build the only C5 data allowed onto the Shadow Calls wire response.
 *
 * Callers describe directory-level failures as `unsealed` or `malformed`;
 * verified entries must come directly from `loadCurrentEvaluation`. A bad
 * verified entry is counted as malformed and contributes no fields or rows.
 */
export function projectGate2702C5(
  sources: Gate2702ProjectionSource[],
  options: { maxRows?: number; maxEvaluations?: number } = {},
): Gate2702Projection {
  const maxRows = boundedInteger(options.maxRows, DEFAULT_GATE_2702_MAX_ROWS);
  const maxEvaluations = boundedInteger(
    options.maxEvaluations,
    DEFAULT_GATE_2702_MAX_EVALUATIONS,
  );
  const reconciliation = {
    scanned: 0,
    validated: 0,
    unsealed: 0,
    malformed: 0,
  };
  const rows: ProjectionItem[] = [];
  const evaluations: Gate2702EvaluationProjection[] = [];
  const trialIds = new Set<string>();

  for (const source of sources) {
    const count =
      source.state === "verified"
        ? 1
        : source.count === undefined
          ? 1
          : safeCount(source.count);
    if (count < 1 || !Number.isSafeInteger(reconciliation.scanned + count))
      fail();
    reconciliation.scanned += count;
    if (source.state === "unsealed") {
      reconciliation.unsealed += count;
      continue;
    }
    if (source.state === "malformed") {
      reconciliation.malformed += count;
      continue;
    }
    try {
      const projected = projectVerified(source);
      if (trialIds.has(projected.evaluation.trialId)) fail();
      trialIds.add(projected.evaluation.trialId);
      reconciliation.validated++;
      rows.push(...projected.rows);
      evaluations.push(projected.evaluation);
    } catch {
      reconciliation.malformed++;
    }
  }

  rows.sort(
    (left, right) =>
      right.sortAt - left.sortAt ||
      right.row.rowId.localeCompare(left.row.rowId),
  );
  evaluations.sort(
    (left, right) =>
      Date.parse(right.evaluatedAt) - Date.parse(left.evaluatedAt) ||
      right.trialId.localeCompare(left.trialId),
  );
  const returnedRows = rows.slice(0, maxRows).map(({ row }) => row);
  const returnedEvaluations = evaluations.slice(0, maxEvaluations);
  return {
    total: rows.length,
    returned: returnedRows.length,
    dropped: rows.length - returnedRows.length,
    rows: returnedRows,
    evaluationTotal: evaluations.length,
    evaluationReturned: returnedEvaluations.length,
    evaluationsDropped: evaluations.length - returnedEvaluations.length,
    evaluations: returnedEvaluations,
    reconciliation,
  };
}
