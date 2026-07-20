#!/usr/bin/env node

/**
 * Deterministic policy evaluator for the one pre-registered #2702 C5 trial.
 *
 * This remains intentionally narrower than a generic experiment evaluator. Its
 * input is the verified #2822 seal, and its output is the exact C5 v1 Verdict.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONTROL = "haiku-solo";
const TREATMENT = "haiku-sonnet-sidekick";
const COST_METRIC = "metrics/gate-2702-all-in-cost";
const QUALITY_METRIC = "metrics/gate-2702-quality-loss";
const ATTRIBUTABLE_METRIC = "metrics/gate-2702-attributable-ships";
const SHIPPED_METRIC = "metrics/gate-2702-sidekick-shipped-interventions";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVALUATION_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function sameValue(left, right) {
  return (
    JSON.stringify(canonicalValue(left)) ===
    JSON.stringify(canonicalValue(right))
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function valueDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function withReceiptDigest(candidate) {
  const body = { ...candidate };
  delete body.contentDigest;
  return { ...candidate, contentDigest: valueDigest(body) };
}

function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function definitionRef(definition) {
  return {
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    contentDigest: definition.contentDigest,
  };
}

function runRef(run) {
  return { runId: run.runId, contentDigest: run.contentDigest };
}

function metric(run, metricId) {
  const observation = run.observations.find(
    (candidate) => candidate.metricId === metricId,
  );
  if (!observation) fail(`Run ${run.runId} omits ${metricId}`);
  return observation.value;
}

function subjectKey(run) {
  return [
    run.subjectRef.harness,
    run.subjectRef.sourceId,
    run.subjectRef.artifactId,
    run.subjectRef.contentDigest,
  ].join("\0");
}

async function loadRuntime() {
  await import("../register-ts.mjs");
  const definitionModule =
    await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
  const contracts =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  return { definitionModule, contracts };
}

function strictRuns(input, runtime) {
  const { contracts } = runtime;
  const selectionReceipts = input.manifest.selectionBindings;
  if (!Array.isArray(selectionReceipts)) {
    fail("verified C5 manifest omits selection bindings");
  }
  if (!Array.isArray(input.runs))
    fail("verified C5 bundle omits canonical Runs");
  const pending = new Map();
  for (const run of input.runs) {
    if (pending.has(run?.runId))
      fail(`C5 bundle repeats Run ${String(run?.runId)}`);
    pending.set(run?.runId, run);
  }
  const decoded = [];
  const decodedIds = new Set();
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((run) => !run.retryOf || decodedIds.has(run.retryOf.runId))
      .sort((left, right) => left.runId.localeCompare(right.runId));
    if (ready.length === 0) {
      fail("C5 retry lineage has a missing parent or cycle");
    }
    const run = ready[0];
    const result = contracts.decodeRunV1(run, {
      definition: input.definition,
      registry: input.registry,
      selectionReceipts,
      triggerReceipts: [],
      operatorSafeguardAuthorizations: [],
      priorRuns: decoded,
    });
    if (!result.ok) {
      fail(
        `Run ${String(run?.runId)} is not strict C5 v1 evidence: ${JSON.stringify(result.issues)}`,
      );
    }
    decoded.push(result.value);
    decodedIds.add(result.value.runId);
    pending.delete(run.runId);
  }
  return decoded.sort((left, right) => left.runId.localeCompare(right.runId));
}

function gate(state, basis, observed) {
  return { state, basis, observed };
}

function defaultStateRoot() {
  return resolve(
    process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
}

function normalizeOptions(optionsInput) {
  if (!UUID_PATTERN.test(optionsInput?.trial ?? "")) {
    fail("--trial must be an RFC 4122 UUID");
  }
  return {
    trial: optionsInput.trial,
    stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot()),
  };
}

function evaluationPaths(options, definition) {
  const trialRoot = join(
    options.stateRoot,
    definition.contentDigest.replace(":", "-"),
    options.trial,
  );
  const root = join(trialRoot, "evaluation");
  return {
    root,
    results: join(root, "results"),
    current: join(root, "current.json"),
  };
}

function readRegularText(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular file`);
  }
  if (metadata.size > MAX_EVALUATION_BYTES) {
    fail(`${label} exceeds the evaluation size bound`);
  }
  return readFileSync(path, "utf8");
}

function readRegularJson(path, label) {
  const bytes = readRegularText(path, label);
  try {
    return { value: JSON.parse(bytes), bytes };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeImmutable(path, bytes) {
  const temporary = join(
    dirname(path),
    `.result.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
      fsyncDirectory(dirname(path));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readRegularText(path, "immutable C5 evaluation object");
      if (existing !== bytes) {
        fail(
          `immutable evaluation already exists with different bytes: ${path}`,
        );
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      unlinkSync(temporary);
      fsyncDirectory(dirname(path));
    }
  }
}

function atomicWrite(path, bytes) {
  const temporary = join(
    dirname(path),
    `.current.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor was already closed after its durable write.
    }
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function verifiedTrial(options, dependencies) {
  const loadVerifiedTrial =
    dependencies?.loadVerifiedTrial ??
    (await import("./seal.mjs")).loadVerifiedTrial;
  if (typeof loadVerifiedTrial !== "function") {
    fail("#2822 does not expose loadVerifiedTrial(options)");
  }
  return loadVerifiedTrial(options);
}

function terminalExclusionReason(run) {
  return run.status === "failed" ? "run/status-failed" : "run/status-cancelled";
}

/** Evaluate only fully verified, decoded evidence returned by #2822. */
export async function evaluateTrialEvidence(input) {
  const runtime = await loadRuntime();
  const { definitionModule, contracts } = runtime;
  const projected = definitionModule.projectGate2702C5Definition(
    input.definition,
  );
  if (!projected.ok) {
    fail("evaluator accepts only the exact checked-in C5 Definition");
  }
  if (
    contracts.canonicalJson(input.registry) !==
    contracts.canonicalJson(definitionModule.GATE_2702_C5_CONTRACT_REGISTRY)
  ) {
    fail("evaluator accepts only the exact checked-in C5 contract registry");
  }
  if (
    input.marker?.trialId !== input.manifest?.trialId ||
    input.marker?.bundleDigest !== input.manifest?.contentDigest ||
    !sameValue(input.marker?.definitionRef, definitionRef(input.definition)) ||
    !sameValue(input.manifest?.definitionRef, definitionRef(input.definition))
  ) {
    fail("verified seal marker and bundle do not bind the C5 Definition");
  }
  if (!Number.isFinite(Date.parse(input.marker.sealedAt ?? ""))) {
    fail("verified seal marker has no valid retained seal timestamp");
  }

  const runs = strictRuns(input, runtime);
  if (runs.some((run) => run.trialId !== input.marker.trialId)) {
    fail("C5 bundle mixes trials");
  }
  if (!Array.isArray(input.manifest.canonicalRuns)) {
    fail("C5 manifest omits its canonical Run bindings");
  }
  const manifestRefs = new Map(
    input.manifest.canonicalRuns.map((entry) => [
      entry.runId,
      entry.contentDigest,
    ]),
  );
  if (
    input.manifest.canonicalRuns.length !== runs.length ||
    manifestRefs.size !== runs.length ||
    runs.some((run) => manifestRefs.get(run.runId) !== run.contentDigest)
  ) {
    fail("C5 manifest does not bind every terminal Run exactly once");
  }
  if (!Array.isArray(input.manifest.runCandidates)) {
    fail("C5 manifest omits its exact run candidate dispositions");
  }
  const sealedCandidateExclusions = input.manifest.runCandidates
    .filter((candidate) => typeof candidate.exclusion === "string")
    .map((candidate) => ({
      subject: candidate.subject,
      treatmentId: candidate.treatmentId,
      attempt: candidate.attempt,
      reason: candidate.exclusion,
    }))
    .sort(
      (left, right) =>
        left.subject - right.subject ||
        left.treatmentId.localeCompare(right.treatmentId) ||
        left.attempt - right.attempt ||
        left.reason.localeCompare(right.reason),
    );
  if (runs.length === 0) {
    if (
      input.manifest.runCandidates.length === 0 ||
      sealedCandidateExclusions.length !== input.manifest.runCandidates.length
    ) {
      fail(
        "zero-Run C5 evidence must explain every sealed candidate exclusion",
      );
    }
    return withReceiptDigest({
      schemaVersion: 1,
      kind: "Gate2702InsufficientEvidence",
      contentDigest: `sha256:${"0".repeat(64)}`,
      trialId: input.marker.trialId,
      definitionRef: definitionRef(input.definition),
      bundleDigest: input.manifest.contentDigest,
      state: "insufficient-evidence",
      reason: "evidence/no-canonical-runs",
      sampleCounts: [
        { treatmentId: CONTROL, n: 0 },
        { treatmentId: TREATMENT, n: 0 },
      ],
      candidateExclusions: sealedCandidateExclusions,
      evaluatedAt: input.marker.sealedAt,
    });
  }

  const supersededRunIds = new Set(
    runs.flatMap((run) => (run.retryOf ? [run.retryOf.runId] : [])),
  );
  const activeRuns = runs.filter((run) => !supersededRunIds.has(run.runId));
  const disposition = new Map(
    runs.map((run) => [
      run.runId,
      supersededRunIds.has(run.runId)
        ? "run/retry-superseded"
        : run.status === "succeeded"
          ? null
          : terminalExclusionReason(run),
    ]),
  );
  const pairs = new Map();
  for (const run of activeRuns) {
    const key = subjectKey(run);
    const pair = pairs.get(key) ?? new Map();
    const arms = pair.get(run.treatmentId) ?? [];
    arms.push(run);
    pair.set(run.treatmentId, arms);
    pairs.set(key, pair);
  }
  let invalidEvidence = false;
  for (const pair of pairs.values()) {
    for (const treatmentId of [CONTROL, TREATMENT]) {
      const arms = pair.get(treatmentId) ?? [];
      if (arms.length <= 1) continue;
      invalidEvidence = true;
      const expected = arms.filter((run) => {
        const subject = run.subjectRef.artifactId.split("/").at(-1);
        return (
          run.selectionRef.planSlotId === `issue-${subject}.${treatmentId}` ||
          run.selectionRef.planSlotId ===
            `issue-${subject}.${treatmentId}.retry-2`
        );
      });
      if (expected.length !== 1) {
        fail(`C5 evidence has no unique pre-registered ${treatmentId} Run`);
      }
      for (const run of arms) {
        if (run.runId !== expected[0].runId) {
          disposition.set(run.runId, "run/duplicate-slot");
        }
      }
    }
    const eligibleControl = (pair.get(CONTROL) ?? []).filter(
      (run) => disposition.get(run.runId) === null,
    );
    const eligibleTreatment = (pair.get(TREATMENT) ?? []).filter(
      (run) => disposition.get(run.runId) === null,
    );
    const hasControl = eligibleControl.length === 1;
    const hasTreatment = eligibleTreatment.length === 1;
    if (hasControl && hasTreatment) continue;
    for (const arms of pair.values()) {
      for (const run of arms) {
        if (disposition.get(run.runId) === null) {
          disposition.set(run.runId, "run/pair-incomplete");
        }
      }
    }
  }
  const includedRuns = runs.filter(
    (run) => disposition.get(run.runId) === null,
  );
  const includedIds = new Set(includedRuns.map((run) => run.runId));
  const excludedRuns = runs
    .filter((run) => disposition.get(run.runId) !== null)
    .map((run) => ({
      run: runRef(run),
      reason: disposition.get(run.runId),
    }));

  const byTreatment = Object.fromEntries(
    [CONTROL, TREATMENT].map((treatmentId) => [
      treatmentId,
      includedRuns.filter((run) => run.treatmentId === treatmentId),
    ]),
  );
  const sampleCounts = [CONTROL, TREATMENT].map((treatmentId) => ({
    treatmentId,
    n: byTreatment[treatmentId].length,
  }));
  const controlCost = byTreatment[CONTROL].reduce(
    (total, run) => total + metric(run, COST_METRIC),
    0,
  );
  const treatmentCost = byTreatment[TREATMENT].reduce(
    (total, run) => total + metric(run, COST_METRIC),
    0,
  );
  const treatmentLosses = byTreatment[TREATMENT].reduce(
    (total, run) => total + metric(run, QUALITY_METRIC),
    0,
  );
  let treatmentWins = 0;
  let attributableWins = 0;
  let treatmentWinsWithShippedIntervention = 0;
  for (const pair of pairs.values()) {
    const control = (pair.get(CONTROL) ?? []).find((run) =>
      includedIds.has(run.runId),
    );
    const treatment = (pair.get(TREATMENT) ?? []).find((run) =>
      includedIds.has(run.runId),
    );
    if (
      !control ||
      !treatment ||
      !includedIds.has(control.runId) ||
      !includedIds.has(treatment.runId)
    ) {
      continue;
    }
    if (metric(treatment, QUALITY_METRIC) < metric(control, QUALITY_METRIC)) {
      treatmentWins += 1;
      if (metric(treatment, ATTRIBUTABLE_METRIC) > 0) attributableWins += 1;
      if (metric(treatment, SHIPPED_METRIC) > 0) {
        treatmentWinsWithShippedIntervention += 1;
      }
    }
  }
  const minimumSamplePassed = sampleCounts.every(({ n }) => n >= 6);
  const parityPassed = treatmentLosses <= 0;
  const costPassed = treatmentCost < controlCost;
  const attributablePassed =
    attributableWins >= 1 &&
    treatmentWinsWithShippedIntervention === treatmentWins;
  const gateState = (passed) =>
    invalidEvidence ? "not-evaluable" : passed ? "passed" : "failed";
  const gates = {
    parityFloor: gate(
      gateState(parityPassed),
      "maximum zero heavy-task losses for the Sidekick treatment",
      { maximumHeavyTaskLosses: 0, treatmentHeavyTaskLosses: treatmentLosses },
    ),
    netPositiveCost: gate(
      gateState(costPassed),
      "Sidekick treatment all-in cost must be less than control all-in cost",
      {
        controlAllInCostUsd: controlCost,
        treatmentAllInCostUsd: treatmentCost,
        savingsUsd: controlCost - treatmentCost,
      },
    ),
    attributableShips: gate(
      gateState(attributablePassed),
      "at least one Sidekick win must be attributable and every win must ship an intervention",
      {
        treatmentWins,
        attributableTreatmentWins: attributableWins,
        treatmentWinsWithShippedIntervention,
      },
    ),
    minimumSample: gate(
      gateState(minimumSamplePassed),
      "each treatment must contribute six eligible terminal Runs",
      {
        requiredRunsPerTreatment: 6,
        controlRuns: byTreatment[CONTROL].length,
        treatmentRuns: byTreatment[TREATMENT].length,
        sealedCandidateExclusionCount: sealedCandidateExclusions.length,
      },
    ),
  };
  const allGatesPassed = Object.values(gates).every(
    (result) => result.state === "passed",
  );
  const decision = invalidEvidence
    ? "invalid"
    : minimumSamplePassed
      ? allGatesPassed
        ? "sidekick-clears"
        : "sidekick-does-not-clear"
      : "inconclusive";
  const relativeBaselineZero =
    minimumSamplePassed && !invalidEvidence && controlCost === 0;
  const estimate =
    controlCost === 0 ? null : (controlCost - treatmentCost) / controlCost;
  const outcome = invalidEvidence
    ? { kind: "invalid", reason: "evidence/ambiguous-run-slot" }
    : !minimumSamplePassed
      ? { kind: "inconclusive", reason: "sample/minimum-not-met" }
      : relativeBaselineZero
        ? { kind: "invalid", reason: "effect/relative-baseline-zero" }
        : estimate > 0
          ? { kind: "winner", winningTreatmentId: TREATMENT }
          : estimate < 0
            ? { kind: "winner", winningTreatmentId: CONTROL }
            : { kind: "tie" };
  const { parameters: _parameters, ...policy } = input.definition.verdictPolicy;
  const { direction: _direction, ...primaryEffectDefinition } =
    input.definition.verdictPolicy.parameters.primaryEffect;
  const evidenceTimestamp = runs
    .map((run) => run.finishedAt)
    .sort()
    .at(-1);
  if (!evidenceTimestamp) fail("C5 Verdict requires terminal Run evidence");
  const previousVerdict = input.previousVerdict ?? null;
  if (
    previousVerdict &&
    (previousVerdict.contentDigest !==
      contracts.computeDocumentDigest(previousVerdict) ||
      previousVerdict.trialId !== input.marker.trialId ||
      !sameValue(
        previousVerdict.definitionRef,
        definitionRef(input.definition),
      ))
  ) {
    fail("previous C5 Verdict has invalid identity or canonical digest");
  }
  if (
    previousVerdict &&
    Date.parse(evidenceTimestamp) <= Date.parse(previousVerdict.updatedAt)
  ) {
    fail("corrected C5 evidence must finish after the previous Verdict");
  }
  const createdAt = previousVerdict?.createdAt ?? evidenceTimestamp;
  const updateReason = previousVerdict
    ? "Corrected deterministic #2702 C5 policy evaluation after the sealed Run set changed."
    : "Initial deterministic #2702 C5 policy evaluation.";
  const candidate = contracts.withDocumentDigest({
    schemaVersion: 1,
    kind: "ExperimentVerdict",
    verdictId: deterministicUuid(
      `gate-2702-verdict\0${input.marker.trialId}\0${input.definition.contentDigest}`,
    ),
    trialId: input.marker.trialId,
    contentDigest: `sha256:${"0".repeat(64)}`,
    definitionRef: definitionRef(input.definition),
    policy,
    evidence: {
      includedRuns: includedRuns.map(runRef),
      excludedRuns,
    },
    outcome,
    policyResult: {
      basis: "policies/gate-2702-c5-graduation",
      parameters: { decision, gates },
    },
    evidenceBasis: {
      evidenceHarness: "claude-code",
      satisfiedCapabilitySemantics:
        includedRuns.length === 0
          ? []
          : input.definition.requiredCapabilities.map(
              ({ semanticsRef }) => semanticsRef,
            ),
    },
    primaryEffect:
      minimumSamplePassed && !invalidEvidence && estimate !== null
        ? {
            ...primaryEffectDefinition,
            estimate,
            uncertainty: {
              kind: "not-estimated",
              reason: "statistics/fixed-cohort-no-interval",
            },
            sampleCounts,
          }
        : null,
    judge: {
      harness: "claude-code",
      sessionRef: {
        harness: "claude-code",
        sourceId: "local-gate-2702",
        sessionId: `verdict-${input.marker.trialId}`,
      },
    },
    createdAt,
    updatedAt: evidenceTimestamp,
    updateReason,
    extensions: {
      "gate-2702/bundleDigest": input.manifest.contentDigest,
      "gate-2702/evaluatorVersion": 1,
      "gate-2702/sealedCandidateExclusions": sealedCandidateExclusions,
      ...(previousVerdict
        ? {
            "gate-2702/previousVerdictDigest": previousVerdict.contentDigest,
          }
        : {}),
    },
  });
  const decoded = contracts.decodeVerdictV1(candidate, {
    definition: input.definition,
    registry: input.registry,
    trialRuns: runs,
    previousVerdict,
  });
  if (!decoded.ok) {
    fail(`computed C5 Verdict is invalid: ${JSON.stringify(decoded.issues)}`);
  }
  return decoded.value;
}

function evaluationObjectPath(paths, contentDigest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest ?? "")) {
    fail("persisted C5 evaluation has no valid content digest");
  }
  return join(paths.results, `${contentDigest.replace(":", "-")}.json`);
}

function evaluationBundleDigest(evaluation) {
  if (evaluation?.kind === "ExperimentVerdict") {
    return evaluation.extensions?.["gate-2702/bundleDigest"];
  }
  if (evaluation?.kind === "Gate2702InsufficientEvidence") {
    return evaluation.bundleDigest;
  }
  fail("C5 evaluation has an unsupported result kind");
}

function canonicalEvaluationJson(evaluation, contracts) {
  if (evaluation?.kind === "ExperimentVerdict") {
    return contracts.canonicalDocumentJson(evaluation);
  }
  if (evaluation?.kind === "Gate2702InsufficientEvidence") {
    return canonicalJson(evaluation);
  }
  fail("C5 evaluation has an unsupported result kind");
}

function computeEvaluationDigest(evaluation, contracts) {
  if (evaluation?.kind === "ExperimentVerdict") {
    return contracts.computeDocumentDigest(evaluation);
  }
  if (evaluation?.kind === "Gate2702InsufficientEvidence") {
    const body = { ...evaluation };
    delete body.contentDigest;
    return valueDigest(body);
  }
  fail("C5 evaluation has an unsupported result kind");
}

function canonicalEvaluationBytes(evaluation, contracts) {
  return `${canonicalEvaluationJson(evaluation, contracts)}\n`;
}

function readEvaluationObject(paths, contentDigest, contracts, label) {
  const path = evaluationObjectPath(paths, contentDigest);
  if (!existsSync(path)) fail("immutable C5 evaluation object is missing");
  const record = readRegularJson(path, label);
  if (
    record.value.contentDigest !== contentDigest ||
    computeEvaluationDigest(record.value, contracts) !== contentDigest
  ) {
    fail(`${label} has an invalid canonical digest`);
  }
  const canonicalBytes = canonicalEvaluationBytes(record.value, contracts);
  if (record.bytes !== canonicalBytes) {
    fail(`${label} bytes are not canonical JSON`);
  }
  return record;
}

function readPublishedCurrent(paths, contracts) {
  const current = readRegularJson(paths.current, "current C5 evaluation");
  if (
    current.value.contentDigest !==
    computeEvaluationDigest(current.value, contracts)
  ) {
    fail("current C5 evaluation has an invalid canonical digest");
  }
  const canonicalBytes = canonicalEvaluationBytes(current.value, contracts);
  if (current.bytes !== canonicalBytes) {
    fail("current C5 evaluation bytes are not canonical JSON");
  }
  const immutable = readEvaluationObject(
    paths,
    current.value.contentDigest,
    contracts,
    "immutable C5 evaluation object",
  );
  if (immutable.bytes !== current.bytes) {
    fail("current C5 evaluation differs from its immutable object");
  }
  return current;
}

async function rederivePublishedCurrent(verified, paths, contracts, current) {
  if (
    evaluationBundleDigest(current.value) !== verified.manifest.contentDigest
  ) {
    fail(
      "verified C5 seal bundle changed after evaluation; durable corrections are unsupported; start a new trial",
    );
  }
  if (
    current.value.kind === "ExperimentVerdict" &&
    Object.prototype.hasOwnProperty.call(
      current.value.extensions ?? {},
      "gate-2702/previousVerdictDigest",
    )
  ) {
    fail(
      "persisted Verdict correction lineage is unsupported; start a new trial",
    );
  }
  const expected = await evaluateTrialEvidence({
    ...verified,
    previousVerdict: null,
  });
  const expectedBytes = canonicalEvaluationBytes(expected, contracts);
  if (expectedBytes !== current.bytes) {
    fail("current C5 evaluation does not rederive from the verified seal");
  }
  return expected;
}

/** Verify the immutable seal, evaluate it, and atomically publish its result. */
export async function evaluateTrial(optionsInput, dependencies) {
  const options = normalizeOptions(optionsInput);
  const verified = await verifiedTrial(options, dependencies);
  const paths = evaluationPaths(options, verified.definition);
  mkdirSync(paths.results, { recursive: true, mode: 0o700 });
  const { contracts } = await loadRuntime();
  const current = existsSync(paths.current)
    ? readPublishedCurrent(paths, contracts)
    : null;
  if (current) {
    return rederivePublishedCurrent(verified, paths, contracts, current);
  }
  const evaluation = await evaluateTrialEvidence({
    ...verified,
    previousVerdict: null,
  });
  const bytes = canonicalEvaluationBytes(evaluation, contracts);
  const objectPath = evaluationObjectPath(paths, evaluation.contentDigest);
  writeImmutable(objectPath, bytes);
  atomicWrite(paths.current, bytes);
  return evaluation;
}

/** One verified read for #2834: evaluation result plus its exact sealed evidence. */
export async function loadCurrentEvaluation(optionsInput, dependencies) {
  const options = normalizeOptions(optionsInput);
  const verified = await verifiedTrial(options, dependencies);
  const paths = evaluationPaths(options, verified.definition);
  if (!existsSync(paths.current)) fail("current C5 evaluation does not exist");
  const { contracts } = await loadRuntime();
  const persisted = readPublishedCurrent(paths, contracts);
  const evaluation = await rederivePublishedCurrent(
    verified,
    paths,
    contracts,
    persisted,
  );
  return { evaluation, ...verified };
}

/** Strict compatibility seam for consumers that require a v1 Verdict. */
export async function loadCurrentVerdict(optionsInput, dependencies) {
  const { evaluation, ...verified } = await loadCurrentEvaluation(
    optionsInput,
    dependencies,
  );
  if (evaluation.kind !== "ExperimentVerdict") {
    fail("current C5 evaluation has no v1 Verdict");
  }
  return { verdict: evaluation, ...verified };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "evaluate") {
    fail("usage: evaluate.mjs evaluate --trial <uuid> [--state-root <path>]");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${String(key)}`);
    }
    const name = key.slice(2);
    if (!["trial", "state-root"].includes(name)) {
      fail(`unknown option ${key}`);
    }
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  return normalizeOptions({
    trial: options.trial,
    stateRoot: options["state-root"],
  });
}

async function main() {
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    fail(
      "gate-2702 evaluation is opt-in; set CHD_EXPERIMENT_2702=1 to enable it",
    );
  }
  const options = parseArgs(process.argv.slice(2));
  const evaluation = await evaluateTrial(options);
  const { contracts } = await loadRuntime();
  process.stdout.write(canonicalEvaluationBytes(evaluation, contracts));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`gate-2702 evaluate: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
