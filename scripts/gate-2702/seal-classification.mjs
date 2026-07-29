/**
 * Pure classification-evidence verification for the sealed #2702 C5 bridge.
 *
 * The verifier reads exact bytes from a trial-relative artifact map. It never
 * touches a live worktree or launches a process. Callers provide the trusted
 * arm identity; all receipt identity, lifecycle, stream, check-result, and
 * classification claims are rederived from the retained artifacts.
 */

import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import {
  GATE_2702_SIDEKICK_MODEL_ID,
  GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION,
  GATE_2702_SIDEKICK_VERSION,
  GATE_2702_WORKER_MODEL_ID,
  gate2702ResolvedSidekickConfig,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";
import { assertGate2702SandboxPreDispatch } from "./sandbox-dispatch.mjs";

const SCHEMA_VERSION = 1;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFINITION_REF = Object.freeze({
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
});
const TREATMENTS = new Set(["haiku-solo", "haiku-sonnet-sidekick"]);
const SUBJECTS = new Set([2760, 2719, 2713, 2706, 2710, 2670]);
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 4_096;
const INSTALL_TIMEOUT_MS = 1_200_000;
const INSTALL_CAPTURE_BYTES = 256 * 1024;
const CHECKS = Object.freeze([
  Object.freeze({
    id: "checks/gate-2702-vitest",
    argv: Object.freeze(["npx", "vitest", "run"]),
    timeoutMs: 720_000,
  }),
  Object.freeze({
    id: "checks/gate-2702-typecheck",
    argv: Object.freeze(["npm", "run", "typecheck"]),
    timeoutMs: 360_000,
  }),
]);
const WORKER_ARGV = Object.freeze([
  "claude",
  "-p",
  "--model",
  GATE_2702_WORKER_MODEL_ID,
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
  "--strict-mcp-config",
  "--max-budget-usd",
  "15",
]);

const TREATMENT_DEFINITIONS = Object.freeze({
  "haiku-solo": Object.freeze({
    id: "haiku-solo",
    configuration: Object.freeze({
      sidekick: Object.freeze({
        enabled: false,
        sessionBudgetUsd: 0,
        perCallBudgetUsd: 0,
      }),
    }),
  }),
  "haiku-sonnet-sidekick": Object.freeze({
    id: "haiku-sonnet-sidekick",
    configuration: Object.freeze({
      sidekick: Object.freeze({
        enabled: true,
        reviewerTier: "sonnet",
        gate: "checkpoint",
        sessionBudgetUsd: 2,
        perCallBudgetUsd: 1,
      }),
    }),
  }),
});

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

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function valueDigest(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function receiptDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return valueDigest(withoutDigest);
}

function requireArtifactMap(artifactBytesByPath) {
  if (
    artifactBytesByPath === null ||
    typeof artifactBytesByPath !== "object" ||
    typeof artifactBytesByPath.get !== "function" ||
    typeof artifactBytesByPath.has !== "function" ||
    typeof artifactBytesByPath.keys !== "function"
  ) {
    fail("artifactBytesByPath must be a retained-artifact map");
  }
  for (const path of artifactBytesByPath.keys()) {
    if (typeof path !== "string" || !path) {
      fail("retained classification artifact map contains an invalid path");
    }
  }
  return artifactBytesByPath;
}

function retainedBytes(artifacts, path, required = true) {
  if (!artifacts.has(path)) {
    if (!required) return null;
    fail(`missing retained classification artifact: ${path}`);
  }
  const value = artifacts.get(path);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`retained classification artifact is not bytes: ${path}`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    fail(`retained classification artifact exceeds its bound: ${path}`);
  }
  return bytes;
}

function readJson(artifacts, path, required = true) {
  const bytes = retainedBytes(artifacts, path, required);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(
      `could not decode retained classification artifact ${path}: ${error.message}`,
    );
  }
}

function readReceipt(artifacts, path, kind, required = true) {
  const receipt = readJson(artifacts, path, required);
  if (receipt === null) return null;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.schemaVersion !== SCHEMA_VERSION ||
    receipt.kind !== kind ||
    !SHA256_PATTERN.test(receipt.contentDigest ?? "") ||
    receipt.contentDigest !== receiptDigest(receipt)
  ) {
    fail(`retained ${kind} receipt is invalid: ${path}`);
  }
  return receipt;
}

function anchorFor({ trialId, baseSha, subject, treatmentId, attempt }) {
  return { trialId, baseSha, subject, treatmentId, attempt };
}

function assertDefinition(value, label) {
  if (!sameValue(value, DEFINITION_REF)) {
    fail(`${label} does not use the fixed C5 Definition`);
  }
}

function assertAnchor(receipt, anchor, label) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt)
  ) {
    fail(`${label} is not an object`);
  }
  assertDefinition(receipt.definitionRef, label);
  if (
    receipt.trialId !== anchor.trialId ||
    receipt.baseSha !== anchor.baseSha ||
    receipt.subject !== anchor.subject ||
    receipt.treatmentId !== anchor.treatmentId ||
    receipt.attempt !== anchor.attempt
  ) {
    fail(`${label} does not match the trusted arm identity`);
  }
  return receipt;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function expectedRunPrefix(anchor) {
  return `runs/issue-${anchor.subject}/${anchor.treatmentId}/attempt-${anchor.attempt}`;
}

function workerPrompt(snapshot, registration) {
  return [
    `You are executing the pre-registered #2702 C5 arm for issue #${snapshot.subject}.`,
    `Treatment: ${registration.treatmentId}. Attempt: ${registration.attempt}.`,
    `Work only in the provided disposable worktree at pinned commit ${registration.baseSha}.`,
    "Implement the bounded issue and verify the result locally.",
    "Do not push any branch or commit.",
    "Do not open, update, or merge a pull request.",
    "Do not edit the GitHub issue or make any other external durable write.",
    "Leave all result files in the disposable worktree; the bridge will preserve evidence.",
    "",
    `Issue title: ${snapshot.title}`,
    "Issue body:",
    snapshot.body,
    "",
  ].join("\n");
}

function artifactClaim(bytes, path) {
  return {
    path,
    byteLength: bytes.length,
    contentDigest: sha256Bytes(bytes),
    capturedBytes: Math.min(bytes.length, MAX_CAPTURE_BYTES),
    truncated: bytes.length > MAX_CAPTURE_BYTES,
  };
}

function withoutDigest(receipt) {
  const value = { ...receipt };
  delete value.contentDigest;
  return value;
}

function validateSnapshot(artifacts, trial, anchor) {
  const path = `subjects/issue-${anchor.subject}.json`;
  const snapshot = readReceipt(artifacts, path, "Gate2702SubjectSnapshot");
  assertDefinition(snapshot.definitionRef, "subject snapshot");
  const manifest = trial.subjectSnapshots?.find(
    (entry) => entry?.subject === anchor.subject,
  );
  if (
    snapshot.trialId !== anchor.trialId ||
    snapshot.subject !== anchor.subject ||
    snapshot.baseSha !== anchor.baseSha ||
    snapshot.repository !== "shpwrck/claude-history-dashboard" ||
    snapshot.executionMode !== "production" ||
    typeof snapshot.title !== "string" ||
    !snapshot.title ||
    typeof snapshot.body !== "string" ||
    !manifest ||
    manifest.contentDigest !== snapshot.contentDigest
  ) {
    fail("subject snapshot is not bound to the production C5 trial");
  }
  return snapshot;
}

function validateRegistration(artifacts, trial, anchor) {
  const prefix = expectedRunPrefix(anchor);
  const registration = assertAnchor(
    readReceipt(
      artifacts,
      `${prefix}/registration.json`,
      "Gate2702ArmRegistration",
    ),
    anchor,
    "arm registration",
  );
  if (
    registration.subjectRef !==
      `github:shpwrck/claude-history-dashboard#${anchor.subject}` ||
    registration.executionMode !== "production" ||
    typeof registration.runDir !== "string" ||
    !isAbsolute(registration.runDir) ||
    !registration.runDir.replaceAll("\\", "/").endsWith(`/${prefix}`) ||
    typeof registration.worktreePath !== "string" ||
    !isAbsolute(registration.worktreePath)
  ) {
    fail("arm registration is not the fixed production C5 arm");
  }
  if (anchor.attempt === 1) {
    const embedded = trial.registrations?.find(
      (candidate) =>
        candidate?.subject === anchor.subject &&
        candidate?.treatmentId === anchor.treatmentId &&
        candidate?.attempt === 1,
    );
    if (!embedded || !sameValue(embedded, registration)) {
      fail("attempt-1 registration is not embedded in the trial receipt");
    }
  } else {
    const parentAnchor = { ...anchor, attempt: 1 };
    const parentPrefix = expectedRunPrefix(parentAnchor);
    const parentRegistration = assertAnchor(
      readReceipt(
        artifacts,
        `${parentPrefix}/registration.json`,
        "Gate2702ArmRegistration",
      ),
      parentAnchor,
      "attempt-1 registration",
    );
    const parentClassification = assertAnchor(
      readReceipt(
        artifacts,
        `${parentPrefix}/classification.json`,
        "Gate2702ArmClassification",
      ),
      parentAnchor,
      "attempt-1 classification",
    );
    const retryOf = {
      attempt: 1,
      registrationDigest: parentRegistration.contentDigest,
      classificationDigest: parentClassification.contentDigest,
    };
    if (
      parentClassification.registrationDigest !==
        parentRegistration.contentDigest ||
      parentClassification.retry?.authorized !== true ||
      !sameValue(registration.retryOf, retryOf)
    ) {
      fail("attempt-2 registration is not authorized by attempt 1");
    }
  }
  return registration;
}

function validateBehaviorContext(context, treatmentId) {
  const treatment = TREATMENT_DEFINITIONS[treatmentId];
  const enabled = treatment.configuration.sidekick.enabled;
  const resolvedConfig = gate2702ResolvedSidekickConfig(treatment, {});
  if (
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    context.schemaVersion !== GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION ||
    !validTimestamp(context.observedAt) ||
    context.workerModelQualifiedId !== GATE_2702_WORKER_MODEL_ID ||
    context.sidekickModelQualifiedId !==
      (enabled ? GATE_2702_SIDEKICK_MODEL_ID : null) ||
    context.sidekickVersion !== (enabled ? GATE_2702_SIDEKICK_VERSION : null) ||
    (enabled
      ? !SHA256_PATTERN.test(context.sidekickImplementationDigest ?? "")
      : context.sidekickImplementationDigest !== null) ||
    !sameValue(
      context.sidekickActivation,
      enabled ? { pluginEnabled: true, globalPauseAbsent: true } : null,
    ) ||
    !sameValue(context.resolvedSidekickConfig, resolvedConfig) ||
    context.resolvedSidekickConfigDigest !== valueDigest(resolvedConfig) ||
    !Array.isArray(context.instructionSources) ||
    context.instructionsDigest !== valueDigest(context.instructionSources)
  ) {
    fail("preflight behavior context is not the fixed C5 treatment context");
  }
  const order = ["user", "project"];
  let previous = -1;
  for (const source of context.instructionSources) {
    const index = order.indexOf(source?.scope);
    if (
      index <= previous ||
      !SHA256_PATTERN.test(source?.contentDigest ?? "") ||
      !Number.isSafeInteger(source?.characterLength) ||
      source.characterLength <= 0 ||
      source.characterLength > 6_000 ||
      typeof source.truncated !== "boolean"
    ) {
      fail("preflight instruction evidence is invalid");
    }
    previous = index;
  }
  return context;
}

function validateInstallStream(
  artifacts,
  stream,
  relativePath,
  absolutePath,
  label,
) {
  const bytes = retainedBytes(artifacts, relativePath);
  const capturedDigest = sha256Bytes(bytes);
  if (
    stream === null ||
    typeof stream !== "object" ||
    Array.isArray(stream) ||
    stream.path !== absolutePath ||
    !Number.isSafeInteger(stream.byteLength) ||
    stream.byteLength < 0 ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    stream.capturedBytes !==
      Math.min(stream.byteLength, INSTALL_CAPTURE_BYTES) ||
    stream.capturedBytes !== bytes.length ||
    stream.truncated !== stream.byteLength > stream.capturedBytes ||
    !SHA256_PATTERN.test(stream.contentDigest ?? "") ||
    stream.capturedContentDigest !== capturedDigest ||
    (!stream.truncated && stream.contentDigest !== capturedDigest)
  ) {
    fail(`${label} does not match its retained npm-ci stream bytes`);
  }
  return bytes;
}

function validateInstallOutcome(
  artifacts,
  path,
  dispatchToken,
  stdoutBytes,
  stderrBytes,
  required,
) {
  const outcome = readJson(artifacts, path, required);
  if (outcome === null) return null;
  const validStream = (stream, bytes) =>
    stream !== null &&
    typeof stream === "object" &&
    !Array.isArray(stream) &&
    Number.isSafeInteger(stream.byteLength) &&
    stream.byteLength >= 0 &&
    Number.isSafeInteger(stream.capturedBytes) &&
    stream.capturedBytes ===
      Math.min(stream.byteLength, INSTALL_CAPTURE_BYTES) &&
    stream.capturedBytes === bytes.length &&
    stream.truncated === stream.byteLength > stream.capturedBytes &&
    SHA256_PATTERN.test(stream.contentDigest ?? "") &&
    stream.capturedContentDigest === sha256Bytes(bytes) &&
    (stream.truncated || stream.contentDigest === sha256Bytes(bytes));
  const expectedKeys = [
    "durationMs",
    "exitCode",
    "signal",
    "stderr",
    "stdout",
    "timedOut",
    "token",
  ];
  if (outcome.spawnError !== undefined) expectedKeys.push("spawnError");
  if (
    outcome === null ||
    typeof outcome !== "object" ||
    Array.isArray(outcome) ||
    outcome.token !== dispatchToken ||
    !(
      outcome.exitCode === null ||
      (Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0)
    ) ||
    !(outcome.signal === null || typeof outcome.signal === "string") ||
    (outcome.spawnError !== undefined &&
      (typeof outcome.spawnError !== "string" || !outcome.spawnError)) ||
    typeof outcome.durationMs !== "number" ||
    !Number.isFinite(outcome.durationMs) ||
    outcome.durationMs < 0 ||
    typeof outcome.timedOut !== "boolean" ||
    !validStream(outcome.stdout, stdoutBytes) ||
    !validStream(outcome.stderr, stderrBytes) ||
    !sameValue(Object.keys(outcome).sort(), expectedKeys.sort())
  ) {
    fail("retained npm-ci wrapper outcome is invalid");
  }
  return outcome;
}

function validateInstallLifecycle(
  artifacts,
  registration,
  embedded,
  preflightStatus,
  anchor,
) {
  const root = `${expectedRunPrefix(anchor)}/preflight-install`;
  const preDispatch = assertAnchor(
    readReceipt(
      artifacts,
      `${root}/pre-dispatch.json`,
      "Gate2702InstallPreDispatch",
    ),
    anchor,
    "npm-ci pre-dispatch",
  );
  if (
    preDispatch.registrationDigest !== registration.contentDigest ||
    preDispatch.program !== (preDispatch.executable ?? "npm") ||
    !(preDispatch.executable === null || isAbsolute(preDispatch.executable)) ||
    !sameValue(preDispatch.argv, ["npm", "ci"]) ||
    preDispatch.timeoutMs !== INSTALL_TIMEOUT_MS ||
    preDispatch.maxBufferBytes !== INSTALL_CAPTURE_BYTES ||
    resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) ||
    !UUID_PATTERN.test(preDispatch.dispatchToken ?? "") ||
    !Number.isSafeInteger(preDispatch.ownerPid) ||
    preDispatch.ownerPid <= 1 ||
    !validTimestamp(preDispatch.startedAt)
  ) {
    fail("npm-ci pre-dispatch is not the fixed production invocation");
  }
  const execution = assertAnchor(
    readReceipt(
      artifacts,
      `${root}/execution.json`,
      "Gate2702InstallExecution",
    ),
    anchor,
    "npm-ci execution",
  );
  if (
    execution.registrationDigest !== registration.contentDigest ||
    execution.preDispatchDigest !== preDispatch.contentDigest ||
    execution.program !== preDispatch.program ||
    execution.executable !== preDispatch.executable ||
    !sameValue(execution.argv, ["npm", "ci"]) ||
    execution.timeoutMs !== INSTALL_TIMEOUT_MS ||
    execution.maxBufferBytes !== INSTALL_CAPTURE_BYTES ||
    execution.startedAt !== preDispatch.startedAt ||
    !(
      execution.pid === null ||
      (Number.isSafeInteger(execution.pid) && execution.pid > 1)
    ) ||
    !(
      execution.durationMs === null ||
      (typeof execution.durationMs === "number" &&
        Number.isFinite(execution.durationMs) &&
        execution.durationMs >= 0)
    ) ||
    !(
      execution.exitCode === null ||
      (Number.isSafeInteger(execution.exitCode) && execution.exitCode >= 0)
    ) ||
    !(execution.signal === null || typeof execution.signal === "string") ||
    typeof execution.timedOut !== "boolean" ||
    typeof execution.interrupted !== "boolean" ||
    execution.interrupted !== (execution.durationMs === null) ||
    typeof execution.processGroupQuiescent !== "boolean" ||
    typeof execution.truncated !== "boolean" ||
    typeof execution.stdout !== "string" ||
    typeof execution.stderr !== "string" ||
    (execution.error !== undefined &&
      (typeof execution.error !== "string" || !execution.error))
  ) {
    fail("retained npm-ci execution receipt is invalid");
  }
  let processReceipt = null;
  if (execution.processDigest !== undefined) {
    processReceipt = assertAnchor(
      readReceipt(artifacts, `${root}/process.json`, "Gate2702InstallProcess"),
      anchor,
      "npm-ci process",
    );
    if (
      processReceipt.registrationDigest !== registration.contentDigest ||
      processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
      processReceipt.dispatchToken !== preDispatch.dispatchToken ||
      !Number.isSafeInteger(processReceipt.pid) ||
      processReceipt.pid <= 1 ||
      execution.processDigest !== processReceipt.contentDigest ||
      execution.pid !== processReceipt.pid ||
      !retainedBytes(artifacts, `${root}/dispatch-gate`).equals(
        Buffer.from(`${preDispatch.dispatchToken}\n`, "utf8"),
      )
    ) {
      fail("npm-ci process/gate lineage is invalid");
    }
  } else if (
    artifacts.has(`${root}/process.json`) ||
    artifacts.has(`${root}/dispatch-gate`) ||
    execution.pid !== null
  ) {
    fail("npm-ci execution omits retained process/gate evidence");
  }
  const stdoutBytes = validateInstallStream(
    artifacts,
    execution.stdoutEvidence,
    `${root}/stdout.log`,
    `${registration.runDir}/preflight-install/stdout.log`,
    "npm-ci stdout",
  );
  const stderrBytes = validateInstallStream(
    artifacts,
    execution.stderrEvidence,
    `${root}/stderr.log`,
    `${registration.runDir}/preflight-install/stderr.log`,
    "npm-ci stderr",
  );
  if (
    execution.stdout !== stdoutBytes.toString("utf8").trim() ||
    execution.stderr !== stderrBytes.toString("utf8").trim() ||
    execution.truncated !==
      (execution.stdoutEvidence.truncated || execution.stderrEvidence.truncated)
  ) {
    fail("npm-ci captured output does not match its retained bytes");
  }
  const outcome = validateInstallOutcome(
    artifacts,
    `${root}/outcome.json`,
    preDispatch.dispatchToken,
    stdoutBytes,
    stderrBytes,
    execution.error === undefined && execution.interrupted === false,
  );
  if (processReceipt === null && outcome !== null) {
    fail("npm-ci outcome has no dispatched wrapper process");
  }
  if (outcome !== null) {
    const outcomeStdout = {
      path: execution.stdoutEvidence.path,
      ...outcome.stdout,
    };
    const outcomeStderr = {
      path: execution.stderrEvidence.path,
      ...outcome.stderr,
    };
    const expectedError =
      outcome.spawnError ?? (outcome.timedOut ? "install-timeout" : undefined);
    if (
      execution.interrupted ||
      execution.durationMs !== outcome.durationMs ||
      execution.exitCode !== outcome.exitCode ||
      execution.signal !== outcome.signal ||
      execution.timedOut !== outcome.timedOut ||
      execution.error !== expectedError ||
      !sameValue(execution.stdoutEvidence, outcomeStdout) ||
      !sameValue(execution.stderrEvidence, outcomeStderr) ||
      (outcome.spawnError !== undefined &&
        execution.error !== outcome.spawnError)
    ) {
      fail("npm-ci execution does not rederive from its wrapper outcome");
    }
  }
  if (!sameValue(embedded, execution)) {
    fail("preflight embedded npm-ci execution differs from retained bytes");
  }
  if (
    preflightStatus === "passed" &&
    (execution.exitCode !== 0 ||
      execution.signal !== null ||
      execution.timedOut ||
      execution.interrupted ||
      execution.processGroupQuiescent !== true ||
      execution.error !== undefined)
  ) {
    fail("passed preflight does not contain a successful npm-ci execution");
  }
  return {
    preDispatch,
    process: processReceipt,
    outcome,
    execution,
    stdoutBytes,
    stderrBytes,
  };
}

function validatePreflight(artifacts, registration, anchor) {
  const treatment = TREATMENT_DEFINITIONS[anchor.treatmentId];
  const path =
    anchor.attempt === 1
      ? `preflight/issue-${anchor.subject}.json`
      : `${expectedRunPrefix(anchor)}/preflight.json`;
  const kind =
    anchor.attempt === 1 ? "Gate2702PairPreflight" : "Gate2702RetryPreflight";
  const receipt = readReceipt(artifacts, path, kind);
  assertDefinition(receipt.definitionRef, "arm preflight");
  const arm =
    anchor.attempt === 1 ? receipt.arms?.[anchor.treatmentId] : receipt;
  if (
    receipt.trialId !== anchor.trialId ||
    receipt.subject !== anchor.subject ||
    receipt.baseSha !== anchor.baseSha ||
    !["passed", "failed"].includes(receipt.status) ||
    (anchor.attempt === 2 &&
      (receipt.treatmentId !== anchor.treatmentId || receipt.attempt !== 2)) ||
    arm?.registrationDigest !== registration.contentDigest ||
    (arm.treatmentId !== undefined && arm.treatmentId !== anchor.treatmentId) ||
    (arm.attempt !== undefined && arm.attempt !== anchor.attempt) ||
    (arm.worktreePath !== undefined &&
      resolve(arm.worktreePath) !== resolve(registration.worktreePath)) ||
    (receipt.status === "passed" && arm.environment === undefined) ||
    ((arm.environment !== undefined || arm.environmentDigest !== undefined) &&
      (arm.environment === undefined ||
        arm.environmentDigest !== valueDigest(arm.environment)))
  ) {
    fail("arm preflight is not identity-bound to the registration");
  }
  const expectedSidekick = treatment.configuration.sidekick;
  const enabled = expectedSidekick.enabled;
  const sidekickComplete =
    arm.sidekick?.version === GATE_2702_SIDEKICK_VERSION &&
    SHA256_PATTERN.test(arm.sidekick?.implementationDigest ?? "") &&
    sameValue(arm.sidekick?.activation, {
      pluginEnabled: true,
      globalPauseAbsent: true,
    });
  const sidekickUnavailable =
    arm.sidekick?.version === null &&
    arm.sidekick?.implementationDigest === null &&
    arm.sidekick?.activation === null;
  const sidekickIncompatible =
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
      arm.sidekick?.version ?? "",
    ) &&
    SHA256_PATTERN.test(arm.sidekick?.implementationDigest ?? "") &&
    sameValue(arm.sidekick?.activation, {
      pluginEnabled: true,
      globalPauseAbsent: true,
    });
  const sidekickProvided = arm.sidekick !== undefined;
  if (
    (receipt.status === "passed" || sidekickProvided) &&
    (!sameValue(arm.sidekick?.configuration, expectedSidekick) ||
      (!enabled && !sidekickUnavailable) ||
      (enabled &&
        (receipt.status === "passed"
          ? !sidekickComplete
          : !sidekickComplete &&
            !sidekickUnavailable &&
            !sidekickIncompatible)))
  ) {
    fail("arm preflight Sidekick evidence is not the fixed treatment");
  }
  let behaviorContext = null;
  if (receipt.status === "passed") {
    behaviorContext = validateBehaviorContext(
      arm.behaviorContext,
      anchor.treatmentId,
    );
  } else {
    if (!Array.isArray(receipt.errors) || receipt.errors.length === 0) {
      fail("failed preflight has no structured error evidence");
    }
    if (arm.behaviorContext !== null && arm.behaviorContext !== undefined) {
      behaviorContext = validateBehaviorContext(
        arm.behaviorContext,
        anchor.treatmentId,
      );
    }
  }
  const install = validateInstallLifecycle(
    artifacts,
    registration,
    arm.install,
    receipt.status,
    anchor,
  );
  return { receipt, arm, behaviorContext, install };
}

function validateWorktreeIdentity(artifacts, registration, anchor) {
  const receipt = assertAnchor(
    readReceipt(
      artifacts,
      `${expectedRunPrefix(anchor)}/worktree-identity.json`,
      "Gate2702WorktreeIdentity",
    ),
    anchor,
    "worktree identity",
  );
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.executionMode !== "production" ||
    resolve(receipt.worktreePath ?? "") !==
      resolve(registration.worktreePath) ||
    typeof receipt.gitDirectory !== "string" ||
    !isAbsolute(receipt.gitDirectory) ||
    !UUID_PATTERN.test(receipt.identityToken ?? "") ||
    !validTimestamp(receipt.createdAt)
  ) {
    fail("worktree identity is not bound to its production registration");
  }
  return receipt;
}

function validateWorkerLifecycle(
  artifacts,
  registration,
  snapshot,
  preflight,
  identity,
  anchor,
) {
  const prefix = expectedRunPrefix(anchor);
  const terminal = assertAnchor(
    readReceipt(artifacts, `${prefix}/terminal.json`, "Gate2702Terminal"),
    anchor,
    "worker terminal",
  );
  const stdoutBytes = retainedBytes(artifacts, `${prefix}/stdout.log`);
  const stderrBytes = retainedBytes(artifacts, `${prefix}/stderr.log`);
  if (preflight.receipt.status === "failed") {
    if (
      artifacts.has(`${prefix}/pre-dispatch.json`) ||
      artifacts.has(`${prefix}/process.json`) ||
      terminal.preflightDigest !== preflight.receipt.contentDigest ||
      terminal.outcome !== "preflight-failed" ||
      terminal.exitCode !== null ||
      terminal.signal !== null ||
      terminal.timedOut !== false ||
      terminal.processGroupQuiescent !== true ||
      !validTimestamp(terminal.endedAt) ||
      stdoutBytes.length !== 0 ||
      stderrBytes.length !== 0
    ) {
      fail("preflight-failed arm contains a worker dispatch");
    }
    return {
      terminal,
      preDispatch: null,
      process: null,
      stdoutBytes,
      stderrBytes,
    };
  }
  const preDispatch = assertAnchor(
    readReceipt(
      artifacts,
      `${prefix}/pre-dispatch.json`,
      "Gate2702PreDispatch",
    ),
    anchor,
    "worker pre-dispatch",
  );
  const expectedEnvironment = gate2702SidekickEnvironment(
    TREATMENT_DEFINITIONS[anchor.treatmentId],
    {},
  );
  let sandbox = null;
  try {
    sandbox = assertGate2702SandboxPreDispatch({
      preDispatch,
      registration,
      worktreeIdentity: identity,
    });
  } catch {
    fail("worker dispatch does not rederive from its production inputs");
  }
  const workerDispatchValid = sameValue(sandbox.workerArgv, [
    sandbox.workerArgv[0],
    ...WORKER_ARGV.slice(1),
    "--plugin-dir",
    sandbox.sidekickSnapshot.path,
  ]);
  if (
    preDispatch.registrationDigest !== registration.contentDigest ||
    preDispatch.worktreeIdentityDigest !== identity.contentDigest ||
    preDispatch.executionMode !== "production" ||
    !workerDispatchValid ||
    !sameValue(preDispatch.sidekickEnvironment, expectedEnvironment) ||
    preDispatch.sidekickEnvironmentDigest !==
      valueDigest(expectedEnvironment) ||
    resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) ||
    preDispatch.promptDigest !==
      sha256Bytes(Buffer.from(workerPrompt(snapshot, registration), "utf8")) ||
    !validTimestamp(preDispatch.startedAt) ||
    terminal.preDispatchDigest !== preDispatch.contentDigest ||
    typeof terminal.durationMs !== "number" ||
    !Number.isFinite(terminal.durationMs) ||
    terminal.durationMs < 0 ||
    !validTimestamp(terminal.endedAt)
  ) {
    fail("worker dispatch does not rederive from its production inputs");
  }
  let processReceipt = null;
  if (terminal.outcome === "spawn-error") {
    if (
      artifacts.has(`${prefix}/process.json`) ||
      terminal.processDigest !== undefined ||
      typeof terminal.error !== "string" ||
      !terminal.error
    ) {
      fail("spawn-error worker has contradictory process evidence");
    }
  } else {
    processReceipt = assertAnchor(
      readReceipt(artifacts, `${prefix}/process.json`, "Gate2702Process"),
      anchor,
      "worker process",
    );
    if (
      processReceipt.registrationDigest !== registration.contentDigest ||
      processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
      !Number.isSafeInteger(processReceipt.pid) ||
      processReceipt.pid <= 1 ||
      typeof processReceipt.detachedProcessGroup !== "boolean" ||
      !validTimestamp(processReceipt.startedAt) ||
      processReceipt.startedAt !== preDispatch.startedAt ||
      terminal.processDigest !== processReceipt.contentDigest ||
      !["exited", "timed-out"].includes(terminal.outcome) ||
      !(
        terminal.exitCode === null ||
        (Number.isSafeInteger(terminal.exitCode) && terminal.exitCode >= 0)
      ) ||
      !(terminal.signal === null || typeof terminal.signal === "string") ||
      typeof terminal.timedOut !== "boolean" ||
      terminal.timedOut !== (terminal.outcome === "timed-out") ||
      typeof terminal.processGroupQuiescent !== "boolean" ||
      (terminal.error !== undefined &&
        (typeof terminal.error !== "string" || !terminal.error))
    ) {
      fail("worker terminal does not bind its exact process lifecycle");
    }
  }
  return {
    terminal,
    preDispatch,
    process: processReceipt,
    stdoutBytes,
    stderrBytes,
  };
}

function validateProbe(probe, program, args, environmentEntry, label) {
  if (
    probe === null ||
    typeof probe !== "object" ||
    Array.isArray(probe) ||
    !sameValue(probe.argv, [program, ...args]) ||
    probe.timeoutMs !== 60_000 ||
    probe.maxBufferBytes !== 256 * 1024 ||
    probe.processGroupQuiescent !== true ||
    typeof probe.program !== "string" ||
    !probe.program ||
    environmentEntry?.executable !== probe.program ||
    environmentEntry?.version !== probe.stdout
  ) {
    fail(`${label} does not retain its exact environment probe`);
  }
}

function validateCheckEnvironment(probes, environment, label) {
  const specs = {
    npm: ["npm", ["--version"]],
    claude: ["claude", ["--version"]],
    vitest: ["npx", ["--no-install", "vitest", "--version"]],
    typescript: ["npx", ["--no-install", "tsc", "--version"]],
  };
  for (const [name, [program, args]] of Object.entries(specs)) {
    validateProbe(
      probes?.[name],
      program,
      args,
      environment?.[name],
      `${label} ${name}`,
    );
  }
  if (
    typeof environment?.node?.executable !== "string" ||
    !environment.node.executable ||
    typeof environment.node.version !== "string" ||
    !environment.node.version
  ) {
    fail(`${label} node environment is invalid`);
  }
}

function validateCapturedStream(
  artifacts,
  stream,
  relativePath,
  absolutePath,
  label,
) {
  const bytes = retainedBytes(artifacts, relativePath);
  const capturedDigest = sha256Bytes(bytes);
  if (
    stream === null ||
    typeof stream !== "object" ||
    Array.isArray(stream) ||
    stream.path !== absolutePath ||
    !Number.isSafeInteger(stream.byteLength) ||
    stream.byteLength < 0 ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    stream.capturedBytes !== Math.min(stream.byteLength, MAX_CAPTURE_BYTES) ||
    stream.capturedBytes !== bytes.length ||
    stream.truncated !== stream.byteLength > stream.capturedBytes ||
    !SHA256_PATTERN.test(stream.contentDigest ?? "") ||
    stream.capturedContentDigest !== capturedDigest ||
    (!stream.truncated && stream.contentDigest !== capturedDigest)
  ) {
    fail(`${label} does not match its retained stream bytes`);
  }
  return bytes;
}

function checkSummary(execution) {
  return {
    checkId: execution.checkId,
    status:
      execution.exitCode === 0 &&
      execution.signal === null &&
      execution.spawnError === undefined &&
      execution.timedOut === false &&
      execution.interrupted === false &&
      execution.processGroupQuiescent === true
        ? "passed"
        : "failed",
    evidenceDigest: execution.contentDigest,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    interrupted: execution.interrupted,
    environmentDigest: execution.environmentDigest,
    ...(execution.environmentErrors
      ? { environmentErrors: execution.environmentErrors }
      : {}),
    processGroupQuiescent: execution.processGroupQuiescent,
    truncated: execution.truncated,
    ...(execution.spawnError ? { spawnError: execution.spawnError } : {}),
  };
}

function validatePlainOutcome(artifacts, path, dispatchToken, required) {
  const outcome = readJson(artifacts, path, required);
  if (outcome === null) return null;
  const expectedKeys = ["exitCode", "signal", "token"];
  if (outcome.spawnError !== undefined) expectedKeys.push("spawnError");
  if (
    outcome === null ||
    typeof outcome !== "object" ||
    Array.isArray(outcome) ||
    outcome.token !== dispatchToken ||
    !(
      outcome.exitCode === null ||
      (Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0)
    ) ||
    !(outcome.signal === null || typeof outcome.signal === "string") ||
    (outcome.spawnError !== undefined &&
      (typeof outcome.spawnError !== "string" || !outcome.spawnError)) ||
    !sameValue(Object.keys(outcome).sort(), expectedKeys.sort())
  ) {
    fail("declared check wrapper outcome is invalid");
  }
  return outcome;
}

function validateOneCheck(artifacts, registration, anchor, check) {
  const prefix = expectedRunPrefix(anchor);
  const slug = check.id.replaceAll("/", "_");
  const root = `${prefix}/checks/${slug}`;
  const preDispatch = assertAnchor(
    readReceipt(
      artifacts,
      `${root}.pre-dispatch.json`,
      "Gate2702CheckPreDispatch",
    ),
    anchor,
    `${check.id} pre-dispatch`,
  );
  if (
    preDispatch.registrationDigest !== registration.contentDigest ||
    preDispatch.checkId !== check.id ||
    !sameValue(preDispatch.argv, check.argv) ||
    preDispatch.timeoutMs !== check.timeoutMs ||
    preDispatch.testEffectiveTimeoutMs !== undefined ||
    resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) ||
    preDispatch.environmentDigest !== valueDigest(preDispatch.environment) ||
    (preDispatch.environmentErrors !== undefined &&
      !Array.isArray(preDispatch.environmentErrors)) ||
    !UUID_PATTERN.test(preDispatch.dispatchToken ?? "") ||
    !Number.isSafeInteger(preDispatch.ownerPid) ||
    preDispatch.ownerPid <= 1 ||
    !validTimestamp(preDispatch.startedAt)
  ) {
    fail(`${check.id} pre-dispatch is not the fixed production check`);
  }
  validateCheckEnvironment(
    preDispatch.environmentProbes,
    preDispatch.environment,
    `${check.id} pre-dispatch`,
  );
  const execution = assertAnchor(
    readReceipt(artifacts, `${root}.json`, "Gate2702CheckExecution"),
    anchor,
    `${check.id} execution`,
  );
  if (
    execution.registrationDigest !== registration.contentDigest ||
    execution.preDispatchDigest !== preDispatch.contentDigest ||
    execution.checkId !== check.id ||
    !sameValue(execution.argv, check.argv) ||
    execution.timeoutMs !== check.timeoutMs ||
    execution.testEffectiveTimeoutMs !== undefined ||
    execution.environmentDigest !== preDispatch.environmentDigest ||
    !sameValue(execution.environment, preDispatch.environment) ||
    !sameValue(execution.environmentProbes, preDispatch.environmentProbes) ||
    !sameValue(execution.environmentErrors, preDispatch.environmentErrors) ||
    execution.startedAt !== preDispatch.startedAt ||
    !(
      execution.durationMs === null ||
      (typeof execution.durationMs === "number" &&
        Number.isFinite(execution.durationMs) &&
        execution.durationMs >= 0)
    ) ||
    !(
      execution.exitCode === null ||
      (Number.isSafeInteger(execution.exitCode) && execution.exitCode >= 0)
    ) ||
    !(execution.signal === null || typeof execution.signal === "string") ||
    typeof execution.timedOut !== "boolean" ||
    typeof execution.interrupted !== "boolean" ||
    execution.interrupted !== (execution.durationMs === null) ||
    typeof execution.processGroupQuiescent !== "boolean" ||
    typeof execution.truncated !== "boolean" ||
    (execution.spawnError !== undefined &&
      (typeof execution.spawnError !== "string" || !execution.spawnError))
  ) {
    fail(`${check.id} execution receipt is invalid`);
  }
  let processReceipt = null;
  if (execution.processDigest !== undefined) {
    processReceipt = assertAnchor(
      readReceipt(artifacts, `${root}.process.json`, "Gate2702CheckProcess"),
      anchor,
      `${check.id} process`,
    );
    if (
      processReceipt.registrationDigest !== registration.contentDigest ||
      processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
      processReceipt.checkId !== check.id ||
      processReceipt.dispatchToken !== preDispatch.dispatchToken ||
      !Number.isSafeInteger(processReceipt.pid) ||
      processReceipt.pid <= 1 ||
      execution.processDigest !== processReceipt.contentDigest ||
      !retainedBytes(artifacts, `${root}.dispatch-gate`).equals(
        Buffer.from(`${preDispatch.dispatchToken}\n`, "utf8"),
      )
    ) {
      fail(`${check.id} process/gate lineage is invalid`);
    }
  } else if (
    artifacts.has(`${root}.process.json`) ||
    artifacts.has(`${root}.dispatch-gate`)
  ) {
    fail(`${check.id} execution omits retained process/gate evidence`);
  }
  const successfulWrapper =
    execution.timedOut === false &&
    execution.interrupted === false &&
    execution.spawnError === undefined;
  const outcome = validatePlainOutcome(
    artifacts,
    `${root}.outcome.json`,
    preDispatch.dispatchToken,
    successfulWrapper,
  );
  if (
    (successfulWrapper && processReceipt === null) ||
    (processReceipt === null && outcome !== null) ||
    (execution.interrupted && outcome !== null)
  ) {
    fail(`${check.id} outcome has no valid dispatched wrapper lineage`);
  }
  if (
    outcome &&
    execution.timedOut === false &&
    (execution.exitCode !== outcome.exitCode ||
      execution.signal !== outcome.signal ||
      execution.spawnError !== outcome.spawnError)
  ) {
    fail(`${check.id} execution does not rederive from its wrapper outcome`);
  }
  const stdoutBytes = validateCapturedStream(
    artifacts,
    execution.stdout,
    `${root}.stdout.log`,
    `${registration.runDir}/checks/${slug}.stdout.log`,
    `${check.id} stdout`,
  );
  const stderrBytes = validateCapturedStream(
    artifacts,
    execution.stderr,
    `${root}.stderr.log`,
    `${registration.runDir}/checks/${slug}.stderr.log`,
    `${check.id} stderr`,
  );
  if (
    execution.truncated !==
    (execution.stdout.truncated || execution.stderr.truncated)
  ) {
    fail(`${check.id} truncation summary does not rederive`);
  }
  return {
    preDispatch,
    process: processReceipt,
    outcome,
    execution,
    stdoutBytes,
    stderrBytes,
    summary: checkSummary(execution),
  };
}

function validateChecks(artifacts, registration, anchor) {
  return CHECKS.map((check) =>
    validateOneCheck(artifacts, registration, anchor, check),
  );
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string") fail(`${label} has no base64 bytes`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail(`${label} has malformed base64 bytes`);
  }
  return bytes;
}

function validateWorktreeEvidence(artifacts, registration, anchor) {
  const path = `generated/diffs/issue-${anchor.subject}.${anchor.treatmentId}.attempt-${anchor.attempt}.json`;
  const diff = readJson(artifacts, path);
  assertAnchor(diff, anchor, "sealed worktree diff");
  if (
    diff.schemaVersion !== SCHEMA_VERSION ||
    diff.kind !== "Gate2702SealedWorktreeDiff" ||
    diff.registrationDigest !== registration.contentDigest ||
    !/^[0-9a-f]{40}$/.test(diff.head ?? "") ||
    !Array.isArray(diff.untracked)
  ) {
    fail("sealed worktree diff has invalid arm lineage");
  }
  const patchBytes = decodeCanonicalBase64(
    diff.trackedPatch?.bytes,
    "tracked worktree patch",
  );
  if (
    diff.trackedPatch.encoding !== "base64" ||
    diff.trackedPatch.sizeBytes !== patchBytes.length ||
    diff.trackedPatch.contentDigest !== sha256Bytes(patchBytes)
  ) {
    fail("tracked worktree patch does not match its retained bytes");
  }
  if (diff.untracked.length > MAX_UNTRACKED_FILES) {
    fail("sealed worktree diff exceeds its file-count bound");
  }
  const paths = diff.untracked.map((entry) => entry?.path);
  if (
    !sameValue(paths, [...paths].sort()) ||
    new Set(paths).size !== paths.length
  ) {
    fail("sealed untracked paths are not uniquely sorted");
  }
  let aggregateBytes = patchBytes.length;
  const untracked = diff.untracked.map((entry) => {
    const normalizedPath =
      typeof entry?.path === "string" ? normalize(entry.path) : null;
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      isAbsolute(entry.path) ||
      normalizedPath === ".." ||
      normalizedPath.startsWith(`..${sep}`) ||
      entry.path.includes("\0") ||
      !["file", "symlink"].includes(entry.kind) ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0
    ) {
      fail("sealed untracked worktree entry is invalid");
    }
    const bytes =
      entry.encoding === "base64"
        ? decodeCanonicalBase64(entry.bytes, `untracked ${entry.path}`)
        : entry.encoding === "utf8" && typeof entry.bytes === "string"
          ? Buffer.from(entry.bytes, "utf8")
          : null;
    if (
      bytes === null ||
      (entry.kind === "file" && entry.encoding !== "base64") ||
      (entry.kind === "symlink" && entry.encoding !== "utf8") ||
      entry.sizeBytes !== bytes.length ||
      entry.contentDigest !== sha256Bytes(bytes)
    ) {
      fail(`sealed untracked ${entry.path} does not match its bytes`);
    }
    aggregateBytes += bytes.length;
    if (aggregateBytes > MAX_ARTIFACT_BYTES) {
      fail("sealed worktree source exceeds its aggregate byte bound");
    }
    return {
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      sizeBytes: entry.sizeBytes,
      contentDigest: entry.contentDigest,
      encoding: entry.encoding,
    };
  });
  const body = {
    baseSha: anchor.baseSha,
    trackedPatch: {
      sizeBytes: patchBytes.length,
      contentDigest: sha256Bytes(patchBytes),
    },
    untracked,
    aggregateBytes,
  };
  return { diff, evidence: { ...body, contentDigest: valueDigest(body) } };
}

function assertNoCheckArtifacts(artifacts, anchor) {
  const prefix = `${expectedRunPrefix(anchor)}/checks/`;
  for (const path of artifacts.keys()) {
    if (path.startsWith(prefix)) {
      fail("classification contains check evidence for an undispatched check");
    }
  }
}

function classificationBase(registration, preflight, terminal) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702ArmClassification",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    preflightDigest: preflight.contentDigest,
    terminalDigest: terminal.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
  };
}

function retryDisposition(attempt, reason, authorized = attempt === 1) {
  return { authorized, reason, maximumAttempt: 2 };
}

function assertBehaviorVerification(classification, behaviorContext) {
  const verification = classification.behaviorVerification;
  if (
    verification === null ||
    typeof verification !== "object" ||
    Array.isArray(verification) ||
    verification.behaviorContextDigest !== valueDigest(behaviorContext) ||
    !validTimestamp(verification.verifiedAt)
  ) {
    fail(
      "classification behavior verification does not bind its preflight context",
    );
  }
  return verification;
}

function parseWorkerResult(bytes) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function validateClassification(
  artifacts,
  registration,
  preflight,
  lifecycle,
  anchor,
) {
  const prefix = expectedRunPrefix(anchor);
  const classification = assertAnchor(
    readReceipt(
      artifacts,
      `${prefix}/classification.json`,
      "Gate2702ArmClassification",
    ),
    anchor,
    "arm classification",
  );
  const base = classificationBase(
    registration,
    preflight.receipt,
    lifecycle.terminal,
  );
  const workerArtifacts = {
    stdout: artifactClaim(
      lifecycle.stdoutBytes,
      `${registration.runDir}/stdout.log`,
    ),
    stderr: artifactClaim(
      lifecycle.stderrBytes,
      `${registration.runDir}/stderr.log`,
    ),
  };
  if (!sameValue(classification.workerArtifacts, workerArtifacts)) {
    fail("classification worker artifacts do not match retained bytes");
  }
  let expected;
  let checks = [];
  let worktree = null;
  if (preflight.receipt.status === "failed") {
    assertNoCheckArtifacts(artifacts, anchor);
    expected = {
      ...base,
      status: "failed",
      eligible: false,
      workerArtifacts,
      checkResults: [],
      error: {
        code: "tooling-artifact",
        message: "paired C5 environment preflight failed before model dispatch",
        preflightErrors: preflight.receipt.errors ?? [],
      },
      retry: retryDisposition(anchor.attempt, "tooling-artifact"),
    };
  } else if (classification.error?.code === "behavior-context-drift") {
    assertNoCheckArtifacts(artifacts, anchor);
    const behaviorVerification = assertBehaviorVerification(
      classification,
      preflight.behaviorContext,
    );
    if (
      typeof classification.error.detail !== "string" ||
      !classification.error.detail
    ) {
      fail("behavior-context drift has no retained failure detail");
    }
    expected = {
      ...base,
      status: "failed",
      eligible: false,
      workerArtifacts,
      checkResults: [],
      behaviorVerification,
      error: {
        code: "behavior-context-drift",
        message:
          "the C5 behavior context changed after preflight and is excluded",
        detail: classification.error.detail,
      },
      retry: retryDisposition(anchor.attempt, "tooling-artifact"),
    };
  } else {
    const stdout = workerArtifacts.stdout;
    const stderr = workerArtifacts.stderr;
    const workerResult = stdout.truncated
      ? null
      : parseWorkerResult(lifecycle.stdoutBytes);
    if (
      lifecycle.terminal.outcome === "timed-out" ||
      lifecycle.terminal.timedOut === true
    ) {
      assertNoCheckArtifacts(artifacts, anchor);
      expected = {
        ...base,
        status: "cancelled",
        eligible: false,
        workerArtifacts,
        checkResults: [],
        error: {
          code: "timeout",
          message: "the C5 worker exceeded its fixed wall-time limit",
        },
        retry: retryDisposition(anchor.attempt, "timeout"),
      };
    } else if (workerResult?.subtype === "error_max_budget_usd") {
      assertNoCheckArtifacts(artifacts, anchor);
      expected = {
        ...base,
        status: "cancelled",
        eligible: false,
        workerArtifacts,
        checkResults: [],
        error: {
          code: "budget-exhausted",
          message: "Claude reported the pre-registered worker budget ceiling",
        },
        retry: retryDisposition(anchor.attempt, "budget-exhausted", false),
      };
    } else if (stdout.truncated || stderr.truncated) {
      assertNoCheckArtifacts(artifacts, anchor);
      expected = {
        ...base,
        status: "cancelled",
        eligible: false,
        workerArtifacts,
        checkResults: [],
        error: {
          code: "truncated-evidence",
          message:
            "worker stdout or stderr exceeded the fixed 2 MiB evidence bound",
        },
        retry: retryDisposition(anchor.attempt, "truncated-evidence"),
      };
    } else if (
      lifecycle.terminal.outcome === "spawn-error" ||
      lifecycle.terminal.exitCode !== 0 ||
      lifecycle.terminal.processGroupQuiescent !== true
    ) {
      assertNoCheckArtifacts(artifacts, anchor);
      expected = {
        ...base,
        status: "failed",
        eligible: false,
        workerArtifacts,
        checkResults: [],
        error: {
          code: "worker-process-failure",
          message:
            "the preflighted worker process did not complete successfully",
          outcome: lifecycle.terminal.outcome,
          exitCode: lifecycle.terminal.exitCode,
          signal: lifecycle.terminal.signal,
        },
        retry: retryDisposition(anchor.attempt, "tooling-artifact"),
      };
    } else if (
      lifecycle.terminal.outcome !== "exited" ||
      lifecycle.terminal.exitCode !== 0 ||
      lifecycle.terminal.timedOut === true ||
      lifecycle.terminal.processGroupQuiescent !== true
    ) {
      fail("worker terminal is not a completed C5 arm");
    } else if (
      workerResult?.type !== "result" ||
      workerResult?.subtype !== "success" ||
      typeof workerResult?.result !== "string"
    ) {
      assertNoCheckArtifacts(artifacts, anchor);
      expected = {
        ...base,
        status: "failed",
        eligible: false,
        workerArtifacts,
        checkResults: [],
        error: {
          code: "worker-output-invalid",
          message: "Claude did not emit one structured successful result",
        },
        retry: retryDisposition(anchor.attempt, "tooling-artifact"),
      };
    } else {
      const behaviorVerification = assertBehaviorVerification(
        classification,
        preflight.behaviorContext,
      );
      checks = validateChecks(artifacts, registration, anchor);
      const summaries = checks.map((check) => check.summary);
      const timedOutCheck = summaries.find((result) => result.timedOut);
      const truncatedCheck = summaries.find((result) => result.truncated);
      const toolingFailure = summaries.find(
        (result) =>
          result.spawnError !== undefined ||
          (result.environmentErrors?.length ?? 0) > 0 ||
          result.exitCode === null ||
          result.exitCode === 127 ||
          result.signal !== null ||
          result.processGroupQuiescent !== true,
      );
      const genuineCheckFailure = summaries.find(
        (result) => result.status === "failed" || result.exitCode !== 0,
      );
      let disposition;
      if (timedOutCheck) {
        disposition = {
          status: "cancelled",
          eligible: false,
          error: {
            code: "timeout",
            checkId: timedOutCheck.checkId,
            message: "a declared check exceeded its pre-registered timeout",
          },
          retry: retryDisposition(anchor.attempt, "timeout"),
        };
      } else if (truncatedCheck) {
        disposition = {
          status: "cancelled",
          eligible: false,
          error: {
            code: "truncated-evidence",
            checkId: truncatedCheck.checkId,
            message: "a declared check exceeded its fixed 2 MiB output bound",
          },
          retry: retryDisposition(anchor.attempt, "truncated-evidence"),
        };
      } else if (toolingFailure) {
        disposition = {
          status: "failed",
          eligible: false,
          error: {
            code: "tooling-artifact",
            checkId: toolingFailure.checkId,
            message:
              "a declared check could not execute with the preflighted toolchain",
          },
          retry: retryDisposition(anchor.attempt, "tooling-artifact"),
        };
      } else if (genuineCheckFailure) {
        disposition = {
          status: "failed",
          eligible: false,
          error: {
            code: "genuine-check-failure",
            checkId: genuineCheckFailure.checkId,
            message: "a declared check completed with a failing result",
          },
          retry: retryDisposition(anchor.attempt, "genuine-result", false),
        };
      } else {
        disposition = {
          status: "succeeded",
          eligible: true,
          retry: retryDisposition(anchor.attempt, "genuine-result", false),
        };
        worktree = validateWorktreeEvidence(artifacts, registration, anchor);
      }
      expected = {
        ...base,
        ...disposition,
        behaviorVerification,
        workerArtifacts,
        ...(worktree ? { worktreeEvidence: worktree.evidence } : {}),
        checkResults: summaries,
      };
    }
  }
  if (!sameValue(withoutDigest(classification), expected)) {
    fail(
      "classification does not rederive from retained worker/check evidence",
    );
  }
  return { classification, checks, worktree };
}

/**
 * Validate and rederive one retained C5 arm classification.
 *
 * @param {object} input
 * @param {Map<string, Buffer|Uint8Array>} input.artifactBytesByPath exact
 *   retained bytes keyed by trial-relative path
 * @param {string} input.trialId trusted trial UUID
 * @param {string} input.baseSha trusted pinned Git commit
 * @param {number} input.subject trusted C5 issue number
 * @param {"haiku-solo"|"haiku-sonnet-sidekick"} input.treatmentId trusted
 *   treatment identity
 * @param {1|2} input.attempt trusted arm attempt
 */
export function validateGate2702ClassificationEvidence({
  artifactBytesByPath,
  trialId,
  baseSha,
  subject,
  treatmentId,
  attempt,
}) {
  const artifacts = requireArtifactMap(artifactBytesByPath);
  if (!UUID_PATTERN.test(trialId ?? "")) {
    fail("trialId is not an RFC 4122 UUID");
  }
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) {
    fail("baseSha is not a pinned Git SHA");
  }
  if (!SUBJECTS.has(subject)) {
    fail("subject is not part of the fixed C5 workload");
  }
  if (!TREATMENTS.has(treatmentId)) {
    fail("treatmentId is not part of C5");
  }
  if (attempt !== 1 && attempt !== 2) {
    fail("attempt must be 1 or 2");
  }
  const trial = readReceipt(artifacts, "trial.json", "Gate2702Trial");
  if (
    trial.trialId !== trialId ||
    trial.baseSha !== baseSha ||
    trial.repository !== "shpwrck/claude-history-dashboard" ||
    trial.executionMode !== "production" ||
    !sameValue(trial.definitionRef, DEFINITION_REF)
  ) {
    fail("retained trial does not match the trusted production C5 identity");
  }
  const anchor = anchorFor({
    trialId,
    baseSha,
    subject,
    treatmentId,
    attempt,
  });
  const snapshot = validateSnapshot(artifacts, trial, anchor);
  const registration = validateRegistration(artifacts, trial, anchor);
  const preflight = validatePreflight(artifacts, registration, anchor);
  const identity = validateWorktreeIdentity(artifacts, registration, anchor);
  const lifecycle = validateWorkerLifecycle(
    artifacts,
    registration,
    snapshot,
    preflight,
    identity,
    anchor,
  );
  const verified = validateClassification(
    artifacts,
    registration,
    preflight,
    lifecycle,
    anchor,
  );
  return {
    trial,
    snapshot,
    registration,
    preflight: preflight.receipt,
    install: preflight.install,
    identity,
    preDispatch: lifecycle.preDispatch,
    process: lifecycle.process,
    terminal: lifecycle.terminal,
    classification: verified.classification,
    checks: verified.checks,
    worktree: verified.worktree,
  };
}
