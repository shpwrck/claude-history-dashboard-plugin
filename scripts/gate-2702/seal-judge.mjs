/**
 * Pure judge-evidence verification for the sealed #2702 C5 bridge.
 *
 * `validateGate2702JudgeEvidence` accepts a map from trial-relative artifact
 * paths to their exact retained bytes. It performs no filesystem, process, or
 * environment access. The caller supplies the independently trusted trial
 * identity; this module verifies receipt digests and rederives the frozen
 * input, both blind requests, every referenced durable attempt lifecycle, and
 * the final `Gate2702JudgeResult` body.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { assertGate2702SandboxPreDispatch } from "./sandbox-dispatch.mjs";

const SCHEMA_VERSION = 1;
const DEFINITION_REF = Object.freeze({
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
});
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const CHECK_IDS = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_TIMEOUT_MS = 600_000;
const JUDGE_BUDGET_USD = "0.25";
const MAX_ATTEMPTS = 3;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 4_096;
const ORIGIN_POLICY = Object.freeze({
  id: "policies/gate-2702-judge-origin",
  version: 1,
});
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DIMENSIONS = [
  [
    "correctness",
    "Does it achieve the outcome the user would accept as the solution, rather than mere plausibility?",
  ],
  [
    "design",
    "Is it well architected under CUPID, KISS, DRY, and GRASP? Score neutral 5 for non-code tasks.",
  ],
  [
    "completeness",
    "Does it cover the whole task, including edge cases the task implies?",
  ],
  ["clarity", "Is the result clear, well structured, and easy to act on?"],
  [
    "scopeFit",
    "Does it stay in scope, without over-building or unrequested changes?",
  ],
  [
    "autonomy",
    "How few user prompts or interventions would it take to reach the result?",
  ],
];

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "scores", "rationale"],
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["A", "B"],
      properties: {
        A: { $ref: "#/$defs/dimensionScores" },
        B: { $ref: "#/$defs/dimensionScores" },
      },
    },
    rationale: { type: "string", minLength: 1, maxLength: 4096 },
  },
  $defs: {
    dimensionScores: {
      type: "object",
      additionalProperties: false,
      required: DIMENSIONS.map(([key]) => key),
      properties: Object.fromEntries(
        DIMENSIONS.map(([key]) => [
          key,
          { type: "integer", minimum: 1, maximum: 10 },
        ]),
      ),
    },
  },
};

const RUBRIC = [
  "You are an impartial judge comparing two attempts (A and B) at the same task.",
  "Skeptic first: for each attempt, identify what is missing or wrong before giving credit.",
  "Judge output quality, not length, apparent effort, model, or cost. Return tie only when equivalent.",
  `Score 1-10 on: ${DIMENSIONS.map(([key, description]) => `${key} (${description})`).join("; ")}`,
].join("\n");

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

function withReceiptDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return { ...withoutDigest, contentDigest: valueDigest(withoutDigest) };
}

function validateSandboxedWorkerDispatch(
  preDispatch,
  registration,
  worktreeIdentity,
) {
  const sandbox = assertGate2702SandboxPreDispatch({
    preDispatch,
    registration,
    worktreeIdentity,
  });
  if (registration.executionMode === "production") {
    const directArgv = expectedWorkerArgv();
    const expectedSandboxedArgv = [
      sandbox.workerArgv[0],
      ...directArgv.slice(1),
      "--plugin-dir",
      sandbox.sidekickSnapshot.path,
    ];
    if (sameValue(sandbox.workerArgv, expectedSandboxedArgv)) {
      return sandbox;
    }
    fail("worker origin provenance does not bind the fixed C5 invocation");
  }
  return sandbox;
}

export function buildGate2702JudgeOriginProvenance({
  registration,
  preDispatch,
  worktreeIdentity,
  classification,
  workerResultDigest,
  worktreeEvidence,
}) {
  const sandbox = validateSandboxedWorkerDispatch(
    preDispatch,
    registration,
    worktreeIdentity,
  );
  const body = {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeOriginProvenance",
    definitionRef: DEFINITION_REF,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    executionMode: registration.executionMode,
    policy: ORIGIN_POLICY,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    worktreeIdentityDigest: worktreeIdentity.contentDigest,
    classificationDigest: classification.contentDigest,
    sandboxPolicyDigest: sandbox.policyDigest,
    sandboxAllowedReadRootsDigest: valueDigest(sandbox.allowedReadRoots),
    sandboxAllowedWriteRootsDigest: valueDigest(sandbox.allowedWriteRoots),
    workerStdoutDigest: classification.workerArtifacts?.stdout?.contentDigest,
    workerResultDigest,
    worktreeEvidenceDigest: worktreeEvidence?.contentDigest,
    assertions: {
      hostHomeDenied: sandbox.hostHomeDenied,
      workerResultSource: "sandboxed-worker-stdout",
      diffSource: "sandbox-confined-disposable-worktree",
      forbiddenSource: "host-home",
    },
  };
  if (
    !["production", "test"].includes(body.executionMode) ||
    !SHA256_PATTERN.test(body.workerStdoutDigest ?? "") ||
    !SHA256_PATTERN.test(body.workerResultDigest ?? "") ||
    !SHA256_PATTERN.test(body.worktreeEvidenceDigest ?? "")
  ) {
    fail("worker origin provenance is not a production evidence chain");
  }
  return withReceiptDigest(body);
}

function validateOriginProvenance(
  provenance,
  sourceArm,
  evidence,
  worktreeEvidence,
) {
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    Array.isArray(provenance) ||
    provenance.schemaVersion !== SCHEMA_VERSION ||
    provenance.kind !== "Gate2702JudgeOriginProvenance" ||
    !SHA256_PATTERN.test(provenance.contentDigest ?? "") ||
    provenance.contentDigest !== receiptDigest(provenance)
  ) {
    fail(`${evidence.treatmentId} origin provenance receipt is absent or invalid`);
  }
  const expected = buildGate2702JudgeOriginProvenance({
    registration: sourceArm.registration,
    preDispatch: sourceArm.preDispatch,
    worktreeIdentity: sourceArm.worktreeIdentity,
    classification: sourceArm.classification,
    workerResultDigest: evidence.workerResultDigest,
    worktreeEvidence,
  });
  if (!sameValue(provenance, expected)) {
    fail(
      `${evidence.treatmentId} origin provenance does not bind its sandboxed sources`,
    );
  }
  return provenance;
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
    if (typeof path !== "string" || path.length === 0) {
      fail("retained artifact map contains an invalid path");
    }
  }
  return artifactBytesByPath;
}

function retainedBytes(artifacts, path, required = true) {
  if (!artifacts.has(path)) {
    if (!required) return null;
    fail(`missing retained judge artifact: ${path}`);
  }
  const value = artifacts.get(path);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`retained judge artifact is not bytes: ${path}`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_SOURCE_BYTES) {
    fail(`retained judge artifact exceeds its fixed size limit: ${path}`);
  }
  return bytes;
}

function readReceipt(artifacts, path, kind, required = true) {
  const bytes = retainedBytes(artifacts, path, required);
  if (bytes === null) return null;
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`could not decode retained ${kind} at ${path}: ${error.message}`);
  }
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.schemaVersion !== SCHEMA_VERSION ||
    receipt.kind !== kind
  ) {
    fail(`expected retained ${kind} schema version ${SCHEMA_VERSION}: ${path}`);
  }
  if (
    !SHA256_PATTERN.test(receipt.contentDigest ?? "") ||
    receipt.contentDigest !== receiptDigest(receipt)
  ) {
    fail(`retained ${kind} content digest does not match: ${path}`);
  }
  return receipt;
}

function assertAnchor(receipt, anchor, label, includeSubject = true) {
  if (
    !sameValue(receipt.definitionRef, DEFINITION_REF) ||
    receipt.trialId !== anchor.trialId ||
    receipt.baseSha !== anchor.baseSha ||
    (includeSubject && receipt.subject !== anchor.subject)
  ) {
    fail(`${label} identity does not match the retained C5 trial`);
  }
  return receipt;
}

function assertProduction(receipt, label) {
  if (receipt.executionMode !== "production") {
    fail(`${label} does not bind production execution mode`);
  }
}

function decodeBase64(value, label) {
  if (typeof value !== "string") fail(`${label} has no retained bytes`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${label} has invalid base64`);
  return bytes;
}

function decodeFrozenEntry(entry, label) {
  if (entry?.encoding === "base64") {
    return decodeBase64(entry.bytes, label);
  }
  if (entry?.encoding === "utf8" && typeof entry.bytes === "string") {
    return Buffer.from(entry.bytes, "utf8");
  }
  fail(`${label} has an unsupported encoding`);
}

function validateFrozenDiff(diff, treatmentId) {
  const patch = diff?.trackedPatch;
  if (patch?.encoding !== "base64") {
    fail(`${treatmentId} tracked patch encoding is invalid`);
  }
  const patchBytes = decodeFrozenEntry(patch, `${treatmentId} tracked patch`);
  if (
    patch.sizeBytes !== patchBytes.length ||
    patch.contentDigest !== sha256Bytes(patchBytes)
  ) {
    fail(`${treatmentId} tracked patch digest is invalid`);
  }
  if (!Array.isArray(diff?.untracked)) {
    fail(`${treatmentId} untracked evidence is invalid`);
  }
  if (diff.untracked.length > MAX_UNTRACKED_FILES) {
    fail(`${treatmentId} untracked evidence exceeds its fixed file limit`);
  }
  const paths = diff.untracked.map((entry) => entry?.path);
  if (
    paths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("/") ||
        path.split("/").includes(".."),
    ) ||
    new Set(paths).size !== paths.length ||
    !sameValue(paths, [...paths].sort())
  ) {
    fail(`${treatmentId} untracked evidence paths are invalid`);
  }
  let aggregateBytes = patchBytes.length;
  const untrackedEvidence = [];
  for (const entry of diff.untracked) {
    if (
      !["file", "symlink"].includes(entry?.kind) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      (entry.kind === "file" && entry.encoding !== "base64") ||
      (entry.kind === "symlink" && entry.encoding !== "utf8")
    ) {
      fail(`${treatmentId} untracked ${entry?.path} identity is invalid`);
    }
    const bytes = decodeFrozenEntry(
      entry,
      `${treatmentId} untracked ${entry.path}`,
    );
    if (
      entry.sizeBytes !== bytes.length ||
      entry.contentDigest !== sha256Bytes(bytes)
    ) {
      fail(`${treatmentId} untracked ${entry.path} digest is invalid`);
    }
    aggregateBytes += bytes.length;
    if (aggregateBytes > MAX_SOURCE_BYTES) {
      fail(`${treatmentId} aggregate source exceeds its evidence cap`);
    }
    const { bytes: _bytes, ...metadata } = entry;
    untrackedEvidence.push(metadata);
  }
  const body = {
    baseSha: null,
    trackedPatch: {
      sizeBytes: patchBytes.length,
      contentDigest: sha256Bytes(patchBytes),
    },
    untracked: untrackedEvidence,
    aggregateBytes,
  };
  return { diff, body };
}

function worktreeEvidenceFromDiff(diffValidation, baseSha) {
  const body = { ...diffValidation.body, baseSha };
  return { ...body, contentDigest: valueDigest(body) };
}

function artifactText(workerResult, diff, registration) {
  const patch = Buffer.from(diff.trackedPatch.bytes, "base64").toString("utf8");
  const untracked = diff.untracked
    .map(
      (entry) =>
        `[UNTRACKED ${entry.kind} ${entry.path}; ${entry.encoding}]\n${entry.bytes}`,
    )
    .join("\n\n");
  return [workerResult, "[FINAL TRACKED DIFF]", patch, untracked]
    .filter(Boolean)
    .join("\n\n")
    .replaceAll(registration.worktreePath, "<worktree>")
    .replaceAll(registration.runDir, "<run>")
    .replaceAll(registration.treatmentId, "<arm>")
    .replace(/claude-(?:haiku|sonnet|opus)-[a-z0-9-]+/gi, "<model>");
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

function expectedWorkerArgv() {
  return [
    "claude",
    "-p",
    "--model",
    "claude-haiku-4-5-20251001",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--max-budget-usd",
    "15",
  ];
}

function exactTreatmentKeys(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    sameValue(Object.keys(value).sort(), [...TREATMENTS].sort())
  );
}

function validateFrozenSource(artifacts, anchor) {
  const trial = assertAnchor(
    readReceipt(artifacts, "trial.json", "Gate2702Trial"),
    anchor,
    "trial",
    false,
  );
  assertProduction(trial, "trial");
  if (
    typeof trial.worktreeRoot !== "string" ||
    !isAbsolute(trial.worktreeRoot)
  ) {
    fail("trial does not retain its production worktree root");
  }
  const snapshotPath = `subjects/issue-${anchor.subject}.json`;
  const snapshot = assertAnchor(
    readReceipt(artifacts, snapshotPath, "Gate2702SubjectSnapshot"),
    anchor,
    "subject snapshot",
  );
  assertProduction(snapshot, "subject snapshot");
  if (typeof snapshot.title !== "string" || typeof snapshot.body !== "string") {
    fail("subject snapshot lacks frozen task text");
  }
  const snapshotManifest = Array.isArray(trial.subjectSnapshots)
    ? trial.subjectSnapshots.filter(
        (entry) => entry?.subject === anchor.subject,
      )
    : [];
  if (
    snapshotManifest.length !== 1 ||
    !sameValue(snapshotManifest[0], {
      subject: anchor.subject,
      contentDigest: snapshot.contentDigest,
    })
  ) {
    fail("subject snapshot is not bound by the trial manifest");
  }
  const selection = assertAnchor(
    readReceipt(
      artifacts,
      `pair-selection/issue-${anchor.subject}.json`,
      "Gate2702PairSelection",
    ),
    anchor,
    "pair selection",
  );
  if (!exactTreatmentKeys(selection.arms)) {
    fail("pair selection does not contain the exact C5 treatments");
  }
  const arms = {};
  for (const treatmentId of TREATMENTS) {
    const selected = selection.arms[treatmentId];
    if (
      selected?.treatmentId !== treatmentId ||
      ![1, 2].includes(selected.attempt) ||
      !SHA256_PATTERN.test(selected.registrationDigest ?? "") ||
      !SHA256_PATTERN.test(selected.classificationDigest ?? "")
    ) {
      fail(`pair selection has no exact ${treatmentId} arm`);
    }
    const prefix = `runs/issue-${anchor.subject}/${treatmentId}/attempt-${selected.attempt}`;
    const registration = assertAnchor(
      readReceipt(
        artifacts,
        `${prefix}/registration.json`,
        "Gate2702ArmRegistration",
      ),
      anchor,
      `${treatmentId} registration`,
    );
    assertProduction(registration, `${treatmentId} registration`);
    const worktreeSuffix = `worktrees/issue-${anchor.subject}.${treatmentId}.attempt-${selected.attempt}`;
    if (
      registration.treatmentId !== treatmentId ||
      registration.attempt !== selected.attempt ||
      registration.contentDigest !== selected.registrationDigest ||
      typeof registration.runDir !== "string" ||
      !absolutePathEndsWith(registration.runDir, prefix) ||
      typeof registration.worktreePath !== "string" ||
      !absolutePathEndsWith(registration.worktreePath, worktreeSuffix) ||
      normalizedPath(registration.worktreePath) !==
        `${normalizedPath(trial.worktreeRoot).replace(/\/$/, "")}/${worktreeSuffix.slice("worktrees/".length)}`
    ) {
      fail(`${treatmentId} registration does not match pair selection`);
    }
    if (selected.attempt === 1) {
      const embedded = Array.isArray(trial.registrations)
        ? trial.registrations.filter(
            (candidate) =>
              candidate?.subject === anchor.subject &&
              candidate?.treatmentId === treatmentId &&
              candidate?.attempt === 1,
          )
        : [];
      if (embedded.length !== 1 || !sameValue(embedded[0], registration)) {
        fail(`${treatmentId} registration is not bound into the trial`);
      }
    } else {
      const firstPrefix = `runs/issue-${anchor.subject}/${treatmentId}/attempt-1`;
      const firstRegistration = assertAnchor(
        readReceipt(
          artifacts,
          `${firstPrefix}/registration.json`,
          "Gate2702ArmRegistration",
        ),
        anchor,
        `${treatmentId} first registration`,
      );
      const firstClassification = assertAnchor(
        readReceipt(
          artifacts,
          `${firstPrefix}/classification.json`,
          "Gate2702ArmClassification",
        ),
        anchor,
        `${treatmentId} first classification`,
      );
      assertProduction(firstRegistration, `${treatmentId} first registration`);
      if (
        firstClassification.registrationDigest !==
          firstRegistration.contentDigest ||
        firstClassification.retry?.authorized !== true ||
        !sameValue(registration.retryOf, {
          attempt: 1,
          registrationDigest: firstRegistration.contentDigest,
          classificationDigest: firstClassification.contentDigest,
        })
      ) {
        fail(`${treatmentId} retry registration has no authorized lineage`);
      }
    }
    const preflightPath =
      selected.attempt === 1
        ? `preflight/issue-${anchor.subject}.json`
        : `${prefix}/preflight.json`;
    const preflightKind =
      selected.attempt === 1
        ? "Gate2702PairPreflight"
        : "Gate2702RetryPreflight";
    const preflight = assertAnchor(
      readReceipt(artifacts, preflightPath, preflightKind),
      anchor,
      `${treatmentId} preflight`,
    );
    const preflightArm =
      selected.attempt === 1 ? preflight.arms?.[treatmentId] : preflight;
    if (
      preflight.status !== "passed" ||
      preflightArm?.registrationDigest !== registration.contentDigest ||
      preflightArm?.behaviorContext === null ||
      typeof preflightArm?.behaviorContext !== "object"
    ) {
      fail(`${treatmentId} preflight is not bound to behavior evidence`);
    }
    const preDispatch = assertAnchor(
      readReceipt(
        artifacts,
        `${prefix}/pre-dispatch.json`,
        "Gate2702PreDispatch",
      ),
      anchor,
      `${treatmentId} worker pre-dispatch`,
    );
    assertProduction(preDispatch, `${treatmentId} worker pre-dispatch`);
    if (
      preDispatch.treatmentId !== treatmentId ||
      preDispatch.attempt !== selected.attempt ||
      preDispatch.registrationDigest !== registration.contentDigest ||
      normalizedPath(preDispatch.cwd) !==
        normalizedPath(registration.worktreePath) ||
      preDispatch.promptDigest !==
        sha256Bytes(
          Buffer.from(workerPrompt(snapshot, registration), "utf8"),
        )
    ) {
      fail(`${treatmentId} worker dispatch prompt or invocation is invalid`);
    }
    const identity = assertAnchor(
      readReceipt(
        artifacts,
        `${prefix}/worktree-identity.json`,
        "Gate2702WorktreeIdentity",
      ),
      anchor,
      `${treatmentId} worktree identity`,
    );
    assertProduction(identity, `${treatmentId} worktree identity`);
    if (
      identity.treatmentId !== treatmentId ||
      identity.attempt !== selected.attempt ||
      identity.registrationDigest !== registration.contentDigest ||
      normalizedPath(identity.worktreePath) !==
        normalizedPath(registration.worktreePath) ||
      typeof identity.gitDirectory !== "string" ||
      !isAbsolute(identity.gitDirectory) ||
      !UUID_PATTERN.test(identity.identityToken ?? "") ||
      !Number.isFinite(Date.parse(identity.createdAt ?? "")) ||
      preDispatch.worktreeIdentityDigest !== identity.contentDigest
    ) {
      fail(`${treatmentId} worktree identity is not bound to its dispatch`);
    }
    validateSandboxedWorkerDispatch(preDispatch, registration, identity);
    const processReceipt = assertAnchor(
      readReceipt(artifacts, `${prefix}/process.json`, "Gate2702Process"),
      anchor,
      `${treatmentId} worker process`,
    );
    if (
      processReceipt.treatmentId !== treatmentId ||
      processReceipt.attempt !== selected.attempt ||
      processReceipt.registrationDigest !== registration.contentDigest ||
      processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
      !Number.isSafeInteger(processReceipt.pid) ||
      processReceipt.pid <= 1
    ) {
      fail(`${treatmentId} worker process is not bound to its dispatch`);
    }
    const terminal = assertAnchor(
      readReceipt(artifacts, `${prefix}/terminal.json`, "Gate2702Terminal"),
      anchor,
      `${treatmentId} worker terminal`,
    );
    if (
      terminal.treatmentId !== treatmentId ||
      terminal.attempt !== selected.attempt ||
      terminal.preDispatchDigest !== preDispatch.contentDigest ||
      terminal.processDigest !== processReceipt.contentDigest ||
      terminal.outcome !== "exited" ||
      terminal.exitCode !== 0 ||
      terminal.timedOut !== false ||
      terminal.processGroupQuiescent !== true
    ) {
      fail(`${treatmentId} worker terminal is not a completed C5 arm`);
    }
    const classification = assertAnchor(
      readReceipt(
        artifacts,
        `${prefix}/classification.json`,
        "Gate2702ArmClassification",
      ),
      anchor,
      `${treatmentId} classification`,
    );
    const statuses = Array.isArray(classification.checkResults)
      ? classification.checkResults.map((check) => check?.status)
      : [];
    const checkIds = Array.isArray(classification.checkResults)
      ? classification.checkResults.map((check) => check?.checkId)
      : [];
    if (
      classification.treatmentId !== treatmentId ||
      classification.attempt !== selected.attempt ||
      classification.registrationDigest !== registration.contentDigest ||
      classification.preflightDigest !== preflight.contentDigest ||
      classification.terminalDigest !== terminal.contentDigest ||
      classification.contentDigest !== selected.classificationDigest ||
      classification.status !== "succeeded" ||
      classification.eligible !== true ||
      classification.behaviorVerification?.behaviorContextDigest !==
        valueDigest(preflightArm.behaviorContext) ||
      !Number.isFinite(
        Date.parse(classification.behaviorVerification?.verifiedAt ?? ""),
      ) ||
      statuses.length !== CHECK_IDS.length ||
      !sameValue([...checkIds].sort(), [...CHECK_IDS].sort()) ||
      !statuses.every((status) => ["passed", "failed"].includes(status))
    ) {
      fail(`${treatmentId} classification is absent, ineligible, or tampered`);
    }
    const stdoutPath = `${prefix}/stdout.log`;
    const stdoutBytes = retainedBytes(artifacts, stdoutPath);
    const recordedStdout = classification.workerArtifacts?.stdout;
    if (
      !absolutePathEndsWith(recordedStdout?.path, stdoutPath) ||
      recordedStdout.byteLength !== stdoutBytes.length ||
      recordedStdout.capturedBytes !== stdoutBytes.length ||
      recordedStdout.truncated !== false ||
      recordedStdout.contentDigest !== sha256Bytes(stdoutBytes)
    ) {
      fail(`${treatmentId} worker stdout is not bound to its classification`);
    }
    let workerWrapper;
    try {
      workerWrapper = JSON.parse(stdoutBytes.toString("utf8"));
    } catch {
      fail(`${treatmentId} worker stdout is not valid Claude JSON`);
    }
    if (
      typeof workerWrapper?.result !== "string" ||
      !workerWrapper.result.trim()
    ) {
      fail(`${treatmentId} worker stdout has no final result`);
    }
    arms[treatmentId] = {
      selected,
      registration,
      preDispatch,
      worktreeIdentity: identity,
      classification,
      workerResult: workerWrapper.result,
    };
  }
  return { trial, snapshot, selection, arms };
}

function validateFrozenInput(artifacts, anchor) {
  const source = validateFrozenSource(artifacts, anchor);
  const prefix = `judging/issue-${anchor.subject}`;
  const input = assertAnchor(
    readReceipt(artifacts, `${prefix}/input.json`, "Gate2702JudgeInput"),
    anchor,
    "frozen judge input",
  );
  assertProduction(input, "frozen judge input");
  if (
    input.pairSelectionDigest !== source.selection.contentDigest ||
    input.subjectSnapshotDigest !== source.snapshot.contentDigest ||
    input.task !== `${source.snapshot.title}\n\n${source.snapshot.body}` ||
    !exactTreatmentKeys(input.armEvidence) ||
    !exactTreatmentKeys(input.originProvenance) ||
    !exactTreatmentKeys(input.objectiveChecks) ||
    !exactTreatmentKeys(input.artifacts)
  ) {
    fail("frozen judge input does not rederive from the selected C5 pair");
  }
  const frozenArms = {};
  for (const treatmentId of TREATMENTS) {
    const evidence = assertAnchor(
      readReceipt(
        artifacts,
        `${prefix}/evidence/${treatmentId}.json`,
        "Gate2702JudgeArmEvidence",
      ),
      anchor,
      `${treatmentId} frozen judge evidence`,
    );
    assertProduction(evidence, `${treatmentId} frozen judge evidence`);
    const arm = source.arms[treatmentId];
    const diffValidation = validateFrozenDiff(evidence.diff, treatmentId);
    const expectedWorktreeEvidence = worktreeEvidenceFromDiff(
      diffValidation,
      anchor.baseSha,
    );
    const workerBytes = Buffer.from(evidence.workerResult ?? "", "utf8");
    const objectiveState = arm.classification.checkResults.every(
      (check) => check.status === "passed",
    )
      ? "passed"
      : "failed";
    const objective = input.objectiveChecks[treatmentId];
    if (
      evidence.treatmentId !== treatmentId ||
      evidence.attempt !== arm.registration.attempt ||
      evidence.pairSelectionDigest !== source.selection.contentDigest ||
      evidence.registrationDigest !== arm.registration.contentDigest ||
      evidence.classificationDigest !== arm.classification.contentDigest ||
      typeof evidence.workerResult !== "string" ||
      !evidence.workerResult.trim() ||
      evidence.workerResult !== arm.workerResult ||
      evidence.workerResultDigest !== sha256Bytes(workerBytes) ||
      !sameValue(evidence.worktreeEvidence, expectedWorktreeEvidence) ||
      !sameValue(
        arm.classification.worktreeEvidence,
        expectedWorktreeEvidence,
      ) ||
      evidence.artifact !==
        artifactText(evidence.workerResult, evidence.diff, arm.registration)
    ) {
      if (
        typeof evidence.artifact === "string" &&
        evidence.artifact !==
          artifactText(
            evidence.workerResult ?? "",
            evidence.diff,
            arm.registration,
          )
      ) {
        fail(`${treatmentId} frozen artifact does not rederive`);
      }
      fail(`${treatmentId} frozen judge evidence is invalid`);
    }
    const originProvenance = validateOriginProvenance(
      evidence.originProvenance,
      arm,
      evidence,
      expectedWorktreeEvidence,
    );
    if (
      input.armEvidence[treatmentId] !== evidence.contentDigest ||
      input.originProvenance[treatmentId] !==
        originProvenance.contentDigest ||
      input.artifacts[treatmentId] !== evidence.artifact ||
      objective?.classificationDigest !== arm.classification.contentDigest ||
      !sameValue(objective?.results, arm.classification.checkResults) ||
      objective?.state !== objectiveState
    ) {
      fail(`${treatmentId} frozen judge evidence does not match its input`);
    }
    frozenArms[treatmentId] = evidence;
  }
  return { source, input, frozenArms };
}

function expectedPayloads(input) {
  const forward = {
    task: input.task,
    rubric: RUBRIC,
    artifacts: {
      A: input.artifacts[TREATMENTS[0]],
      B: input.artifacts[TREATMENTS[1]],
    },
    originProvenance: {
      A: input.originProvenance[TREATMENTS[0]],
      B: input.originProvenance[TREATMENTS[1]],
    },
  };
  const swapped = {
    task: input.task,
    rubric: RUBRIC,
    artifacts: { A: forward.artifacts.B, B: forward.artifacts.A },
    originProvenance: {
      A: forward.originProvenance.B,
      B: forward.originProvenance.A,
    },
  };
  return { forward, swapped };
}

function validateRequests(artifacts, anchor, input) {
  const path = `judging/issue-${anchor.subject}/requests.json`;
  const requests = assertAnchor(
    readReceipt(artifacts, path, "Gate2702JudgeRequests"),
    anchor,
    "frozen judge requests",
  );
  assertProduction(requests, "frozen judge requests");
  const payloads = expectedPayloads(input);
  if (
    requests.judgeInputDigest !== input.contentDigest ||
    requests.judgeModel !== JUDGE_MODEL ||
    requests.timeoutMs !== JUDGE_TIMEOUT_MS ||
    requests.maxBudgetUsd !== Number(JUDGE_BUDGET_USD) ||
    requests.maxAttemptsPerOrder !== MAX_ATTEMPTS ||
    requests.maxPayloadBytes !== MAX_PROMPT_BYTES ||
    requests.maxStdoutBytes !== MAX_STREAM_BYTES ||
    requests.maxStderrBytes !== MAX_STREAM_BYTES ||
    requests.rubric !== RUBRIC ||
    !sameValue(requests.schema, JUDGE_SCHEMA) ||
    !sameValue(requests.requests?.forward?.payload, payloads.forward) ||
    !sameValue(requests.requests?.swapped?.payload, payloads.swapped) ||
    requests.requests?.forward?.payloadDigest !==
      valueDigest(payloads.forward) ||
    requests.requests?.swapped?.payloadDigest !==
      valueDigest(payloads.swapped) ||
    !sameValue(requests.requests?.forward?.order, {
      A: TREATMENTS[0],
      B: TREATMENTS[1],
    }) ||
    !sameValue(requests.requests?.swapped?.order, {
      A: TREATMENTS[1],
      B: TREATMENTS[0],
    })
  ) {
    fail("frozen judge request or arm order differs from the C5 contract");
  }
  for (const payload of Object.values(payloads)) {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PROMPT_BYTES) {
      fail("frozen judge request exceeds the C5 payload bound");
    }
  }
  return requests;
}

function judgeArgv() {
  return [
    "-p",
    "--model",
    JUDGE_MODEL,
    "--json-schema",
    JSON.stringify(JUDGE_SCHEMA),
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--tools",
    "",
    "--max-budget-usd",
    JUDGE_BUDGET_USD,
  ];
}

function validScores(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    sameValue(
      Object.keys(value).sort(),
      DIMENSIONS.map(([key]) => key).sort(),
    ) &&
    Object.values(value).every(
      (score) => Number.isInteger(score) && score >= 1 && score <= 10,
    )
  );
}

function validResponse(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    sameValue(Object.keys(value).sort(), ["rationale", "scores", "winner"]) &&
    ["A", "B", "tie"].includes(value.winner) &&
    typeof value.rationale === "string" &&
    Boolean(value.rationale.trim()) &&
    value.rationale.length <= 4096 &&
    value.scores !== null &&
    typeof value.scores === "object" &&
    !Array.isArray(value.scores) &&
    sameValue(Object.keys(value.scores).sort(), ["A", "B"]) &&
    validScores(value.scores.A) &&
    validScores(value.scores.B)
  );
}

function normalizedPath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

function absolutePathEndsWith(value, suffix) {
  const normalized = normalizedPath(value);
  return isAbsolute(value ?? "") && normalized.endsWith(`/${suffix}`);
}

function rootBeforeSuffix(value, suffix) {
  if (!absolutePathEndsWith(value, suffix)) return null;
  return normalizedPath(value).slice(0, -1 * `/${suffix}`.length);
}

function validatePreDispatch(preDispatch, anchor, requests, request, order, n) {
  if (
    !sameValue(preDispatch.definitionRef, DEFINITION_REF) ||
    preDispatch.trialId !== anchor.trialId ||
    preDispatch.subject !== anchor.subject ||
    preDispatch.baseSha !== anchor.baseSha ||
    preDispatch.executionMode !== "production" ||
    preDispatch.requestSetDigest !== requests.contentDigest ||
    preDispatch.payloadDigest !== request.payloadDigest ||
    !sameValue(preDispatch.payload, request.payload) ||
    preDispatch.order !== order ||
    preDispatch.attempt !== n ||
    preDispatch.executable !== "claude" ||
    !sameValue(preDispatch.argv, judgeArgv()) ||
    preDispatch.judgeModel !== JUDGE_MODEL ||
    preDispatch.sidekickEnabled !== false ||
    preDispatch.toolAccess !== false ||
    preDispatch.permissionBypass !== false ||
    preDispatch.maxBudgetUsd !== Number(JUDGE_BUDGET_USD) ||
    preDispatch.timeoutMs !== JUDGE_TIMEOUT_MS ||
    preDispatch.maxStdoutBytes !== MAX_STREAM_BYTES ||
    preDispatch.maxStderrBytes !== MAX_STREAM_BYTES ||
    !UUID_PATTERN.test(preDispatch.dispatchToken ?? "") ||
    !Number.isFinite(Date.parse(preDispatch.createdAt ?? ""))
  ) {
    fail(`${order} pre-dispatch receipt is not the frozen production call`);
  }
  return preDispatch;
}

function validateProcessReceipt(processReceipt, preDispatch, anchor, order, n) {
  const relativePrefix = `judging/issue-${anchor.subject}/${order}/attempt-${n}`;
  const expectedSuffixes = [
    `${relativePrefix}.pre-dispatch.json`,
    `${relativePrefix}.process.json`,
    `${relativePrefix}.gate.json`,
    `${relativePrefix}.outcome.json`,
  ];
  const argv = processReceipt.argv;
  const wrapperPathsValid =
    Array.isArray(argv) &&
    argv.length === 6 &&
    absolutePathEndsWith(argv[0], "scripts/gate-2702/judge.mjs") &&
    argv[1] === "__dispatch" &&
    expectedSuffixes.every((suffix, index) =>
      absolutePathEndsWith(argv[index + 2], suffix),
    ) &&
    new Set(
      expectedSuffixes.map((suffix, index) =>
        rootBeforeSuffix(argv[index + 2], suffix),
      ),
    ).size === 1;
  if (
    !sameValue(processReceipt.definitionRef, DEFINITION_REF) ||
    processReceipt.trialId !== preDispatch.trialId ||
    processReceipt.subject !== preDispatch.subject ||
    processReceipt.baseSha !== preDispatch.baseSha ||
    processReceipt.executionMode !== "production" ||
    processReceipt.requestSetDigest !== preDispatch.requestSetDigest ||
    processReceipt.payloadDigest !== preDispatch.payloadDigest ||
    processReceipt.order !== order ||
    processReceipt.attempt !== n ||
    processReceipt.dispatchToken !== preDispatch.dispatchToken ||
    processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
    typeof processReceipt.executable !== "string" ||
    !isAbsolute(processReceipt.executable) ||
    !wrapperPathsValid ||
    !Number.isSafeInteger(processReceipt.pid) ||
    processReceipt.pid <= 0 ||
    !(
      processReceipt.processStartTimeTicks === null ||
      /^\d+$/.test(processReceipt.processStartTimeTicks ?? "")
    ) ||
    !Number.isFinite(Date.parse(processReceipt.launchedAt ?? ""))
  ) {
    fail(`${order} judge process receipt is invalid`);
  }
  return processReceipt;
}

function validateGate(gate, preDispatch, processReceipt, order, n) {
  if (
    !sameValue(gate.definitionRef, DEFINITION_REF) ||
    gate.trialId !== preDispatch.trialId ||
    gate.subject !== preDispatch.subject ||
    gate.baseSha !== preDispatch.baseSha ||
    gate.executionMode !== "production" ||
    gate.requestSetDigest !== preDispatch.requestSetDigest ||
    gate.payloadDigest !== preDispatch.payloadDigest ||
    gate.order !== order ||
    gate.attempt !== n ||
    gate.dispatchToken !== preDispatch.dispatchToken ||
    gate.preDispatchDigest !== preDispatch.contentDigest ||
    gate.processDigest !== processReceipt.contentDigest ||
    !Number.isFinite(Date.parse(gate.authorizedAt ?? ""))
  ) {
    fail(`${order} judge gate is invalid`);
  }
  return gate;
}

function capturedStreamBytes(stream, label) {
  if (stream === null) return null;
  if (
    stream?.encoding !== "base64" ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    !Number.isSafeInteger(stream.totalBytes) ||
    stream.capturedBytes < 0 ||
    stream.totalBytes < stream.capturedBytes ||
    stream.capturedBytes > MAX_STREAM_BYTES ||
    !SHA256_PATTERN.test(stream.contentDigest ?? "") ||
    typeof stream.truncated !== "boolean"
  ) {
    fail(`${label} capture metadata is invalid`);
  }
  const bytes = decodeBase64(stream.bytes, label);
  if (
    bytes.length !== stream.capturedBytes ||
    stream.truncated !== stream.totalBytes > stream.capturedBytes ||
    (!stream.truncated && stream.contentDigest !== sha256Bytes(bytes))
  ) {
    fail(`${label} capture digest or bounds are invalid`);
  }
  return bytes;
}

function validateOutcome(outcome, preDispatch, processReceipt, gate, order, n) {
  if (
    !sameValue(outcome.definitionRef, DEFINITION_REF) ||
    outcome.trialId !== preDispatch.trialId ||
    outcome.subject !== preDispatch.subject ||
    outcome.baseSha !== preDispatch.baseSha ||
    outcome.executionMode !== "production" ||
    outcome.requestSetDigest !== preDispatch.requestSetDigest ||
    outcome.payloadDigest !== preDispatch.payloadDigest ||
    outcome.order !== order ||
    outcome.attempt !== n ||
    outcome.dispatchToken !== preDispatch.dispatchToken ||
    outcome.preDispatchDigest !== preDispatch.contentDigest ||
    outcome.processDigest !== (processReceipt?.contentDigest ?? null) ||
    outcome.gateDigest !== (gate?.contentDigest ?? null) ||
    !Number.isFinite(Date.parse(outcome.startedAt ?? "")) ||
    !Number.isFinite(Date.parse(outcome.endedAt ?? "")) ||
    !(
      outcome.startedMonotonicNs === null ||
      /^\d+$/.test(outcome.startedMonotonicNs ?? "")
    ) ||
    !(
      outcome.endedMonotonicNs === null ||
      /^\d+$/.test(outcome.endedMonotonicNs ?? "")
    ) ||
    !(
      outcome.durationMs === null ||
      (typeof outcome.durationMs === "number" &&
        Number.isFinite(outcome.durationMs) &&
        outcome.durationMs >= 0)
    ) ||
    !(
      outcome.exitCode === null ||
      (Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0)
    ) ||
    !(
      outcome.signal === null ||
      (typeof outcome.signal === "string" && outcome.signal.length > 0)
    ) ||
    typeof outcome.timedOut !== "boolean" ||
    !(
      outcome.spawnError === null ||
      (typeof outcome.spawnError === "string" && outcome.spawnError.length > 0)
    )
  ) {
    fail(`${order} judge outcome is invalid`);
  }
  const stdoutBytes = capturedStreamBytes(
    outcome.stdout,
    `${order} outcome stdout`,
  );
  const stderrBytes = capturedStreamBytes(
    outcome.stderr,
    `${order} outcome stderr`,
  );
  if (outcome.spawnError === null && stdoutBytes === null) {
    fail(`${order} judge outcome has no stdout capture`);
  }
  const wallDuration =
    Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt);
  const monotonicPair =
    outcome.startedMonotonicNs !== null && outcome.endedMonotonicNs !== null;
  if (
    wallDuration < 0 ||
    (monotonicPair &&
      BigInt(outcome.endedMonotonicNs) < BigInt(outcome.startedMonotonicNs)) ||
    (monotonicPair && outcome.durationMs === null) ||
    (!monotonicPair &&
      (outcome.startedMonotonicNs !== null ||
        outcome.endedMonotonicNs !== null ||
        outcome.durationMs !== null))
  ) {
    fail(`${order} judge outcome timing is invalid`);
  }
  return { outcome, stdoutBytes, stderrBytes };
}

function reportedCost(stdoutBytes) {
  try {
    const wrapper = JSON.parse(stdoutBytes.toString("utf8"));
    return typeof wrapper?.total_cost_usd === "number"
      ? wrapper.total_cost_usd
      : null;
  } catch {
    return null;
  }
}

function deriveAttempt(outcomeData) {
  const { outcome } = outcomeData;
  const stdout = outcomeData.stdoutBytes ?? Buffer.alloc(0);
  const stderr = outcomeData.stderrBytes ?? Buffer.alloc(0);
  if (outcome.spawnError) {
    return {
      outcome: "failed",
      retryable: false,
      failureClass: "spawn-error",
      response: null,
      costUsd: null,
    };
  }
  if (outcome.stdout?.truncated || outcome.stderr?.truncated) {
    return {
      outcome: "failed",
      retryable: false,
      failureClass: "output-truncated",
      response: null,
      costUsd: null,
    };
  }
  if (outcome.timedOut) {
    return {
      outcome: "failed",
      retryable: true,
      failureClass: "timeout",
      response: null,
      costUsd: null,
    };
  }
  if (outcome.exitCode !== 0 || outcome.signal) {
    const combined = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`;
    return {
      outcome: "failed",
      retryable: false,
      failureClass: /budget|max[_ -]?budget/i.test(combined)
        ? "budget-exhausted"
        : "process-exit",
      response: null,
      costUsd: reportedCost(stdout),
    };
  }
  let wrapper;
  try {
    wrapper = JSON.parse(stdout.toString("utf8"));
  } catch {
    return {
      outcome: "failed",
      retryable: true,
      failureClass: "non-json",
      response: null,
      costUsd: null,
    };
  }
  const costUsd =
    typeof wrapper?.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
  if (
    costUsd !== null &&
    (!Number.isFinite(costUsd) ||
      costUsd < 0 ||
      costUsd > Number(JUDGE_BUDGET_USD))
  ) {
    return {
      outcome: "failed",
      retryable: false,
      failureClass:
        costUsd > Number(JUDGE_BUDGET_USD)
          ? "budget-exhausted"
          : "schema-invalid",
      response: null,
      costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
    };
  }
  let response = wrapper?.structured_output ?? wrapper?.structuredOutput;
  if (response === undefined && typeof wrapper?.result === "string") {
    try {
      response = JSON.parse(wrapper.result);
    } catch {
      return {
        outcome: "failed",
        retryable: true,
        failureClass: "non-json",
        response: null,
        costUsd,
      };
    }
  }
  return validResponse(response)
    ? {
        outcome: "valid",
        retryable: false,
        failureClass: null,
        response,
        costUsd,
      }
    : {
        outcome: "failed",
        retryable: true,
        failureClass: "schema-invalid",
        response: null,
        costUsd,
      };
}

function lifecyclePath(subject, order, attempt, suffix) {
  const prefix = `judging/issue-${subject}/${order}/attempt-${attempt}`;
  return suffix === "attempt" ? `${prefix}.json` : `${prefix}.${suffix}.json`;
}

function validateAttempt(artifacts, anchor, requests, order, attemptNumber) {
  const request = requests.requests[order];
  const preDispatch = validatePreDispatch(
    readReceipt(
      artifacts,
      lifecyclePath(anchor.subject, order, attemptNumber, "pre-dispatch"),
      "Gate2702JudgePreDispatch",
    ),
    anchor,
    requests,
    request,
    order,
    attemptNumber,
  );
  const processReceipt = readReceipt(
    artifacts,
    lifecyclePath(anchor.subject, order, attemptNumber, "process"),
    "Gate2702JudgeProcess",
    false,
  );
  if (processReceipt) {
    validateProcessReceipt(
      processReceipt,
      preDispatch,
      anchor,
      order,
      attemptNumber,
    );
  }
  const gate = readReceipt(
    artifacts,
    lifecyclePath(anchor.subject, order, attemptNumber, "gate"),
    "Gate2702JudgeGate",
    false,
  );
  if (gate && !processReceipt)
    fail(`${order} judge gate has no process receipt`);
  if (gate)
    validateGate(gate, preDispatch, processReceipt, order, attemptNumber);
  const outcomeData = validateOutcome(
    readReceipt(
      artifacts,
      lifecyclePath(anchor.subject, order, attemptNumber, "outcome"),
      "Gate2702JudgeOutcome",
    ),
    preDispatch,
    processReceipt,
    gate,
    order,
    attemptNumber,
  );
  const derived = deriveAttempt(outcomeData);
  const attempt = readReceipt(
    artifacts,
    lifecyclePath(anchor.subject, order, attemptNumber, "attempt"),
    "Gate2702JudgeAttempt",
  );
  const expectedArgv = [preDispatch.executable, ...preDispatch.argv];
  if (
    !sameValue(attempt.definitionRef, DEFINITION_REF) ||
    attempt.trialId !== anchor.trialId ||
    attempt.subject !== anchor.subject ||
    attempt.baseSha !== anchor.baseSha ||
    attempt.executionMode !== "production" ||
    attempt.requestSetDigest !== requests.contentDigest ||
    attempt.payloadDigest !== request.payloadDigest ||
    attempt.order !== order ||
    attempt.attempt !== attemptNumber ||
    attempt.preDispatchDigest !== preDispatch.contentDigest ||
    attempt.processDigest !== (processReceipt?.contentDigest ?? null) ||
    attempt.outcomeDigest !== outcomeData.outcome.contentDigest ||
    !sameValue(attempt.argv, expectedArgv) ||
    attempt.judgeModel !== JUDGE_MODEL ||
    attempt.sidekickEnabled !== false ||
    attempt.startedAt !== outcomeData.outcome.startedAt ||
    attempt.endedAt !== outcomeData.outcome.endedAt ||
    attempt.startedMonotonicNs !== outcomeData.outcome.startedMonotonicNs ||
    attempt.endedMonotonicNs !== outcomeData.outcome.endedMonotonicNs ||
    attempt.durationMs !== outcomeData.outcome.durationMs ||
    attempt.exitCode !== outcomeData.outcome.exitCode ||
    attempt.signal !== outcomeData.outcome.signal ||
    attempt.timedOut !== outcomeData.outcome.timedOut ||
    !sameValue(attempt.stdout, outcomeData.outcome.stdout) ||
    !sameValue(attempt.stderr, outcomeData.outcome.stderr) ||
    attempt.outcome !== derived.outcome ||
    attempt.retryable !== derived.retryable ||
    attempt.failureClass !== derived.failureClass ||
    !sameValue(attempt.response, derived.response) ||
    attempt.costUsd !== derived.costUsd ||
    !(
      attempt.costUsd === null ||
      (typeof attempt.costUsd === "number" &&
        Number.isFinite(attempt.costUsd) &&
        attempt.costUsd >= 0)
    )
  ) {
    fail(`${order} attempt ${attemptNumber} does not rederive`);
  }
  return attempt;
}

function lifecycleExists(artifacts, subject, order, attempt) {
  return ["pre-dispatch", "process", "gate", "outcome", "attempt"].some(
    (suffix) => artifacts.has(lifecyclePath(subject, order, attempt, suffix)),
  );
}

function assertNoOverCapArtifacts(artifacts, subject, order) {
  const pattern = new RegExp(
    `^judging/issue-${subject}/${order}/attempt-(\\d+)(?:\\.(?:pre-dispatch|process|gate|outcome))?\\.json$`,
  );
  for (const path of artifacts.keys()) {
    const match = pattern.exec(path);
    if (match && Number(match[1]) > MAX_ATTEMPTS) {
      fail(`${order} judge call cap was exceeded by ${path}`);
    }
  }
}

function validateAttemptSequence(artifacts, anchor, requests, result, order) {
  const manifest = result.attempts?.[order];
  if (
    !Array.isArray(manifest) ||
    manifest.length < 1 ||
    manifest.length > MAX_ATTEMPTS ||
    manifest.some(
      (entry, index) =>
        !sameValue(Object.keys(entry ?? {}).sort(), [
          "attempt",
          "contentDigest",
        ]) ||
        entry.attempt !== index + 1 ||
        !SHA256_PATTERN.test(entry.contentDigest ?? ""),
    )
  ) {
    fail(`${order} judge result has an invalid attempt manifest`);
  }
  assertNoOverCapArtifacts(artifacts, anchor.subject, order);
  const attempts = manifest.map((reference, index) => {
    const attempt = validateAttempt(
      artifacts,
      anchor,
      requests,
      order,
      index + 1,
    );
    if (attempt.contentDigest !== reference.contentDigest) {
      fail(`${order} judge result references a different attempt`);
    }
    return attempt;
  });
  for (const attempt of attempts.slice(0, -1)) {
    if (attempt.outcome !== "failed" || attempt.retryable !== true) {
      fail(`${order} judge continued after a terminal attempt`);
    }
  }
  const terminal = attempts.at(-1);
  if (
    terminal.outcome !== "valid" &&
    terminal.retryable === true &&
    terminal.attempt < MAX_ATTEMPTS
  ) {
    fail(`${order} judge stopped before its fixed retry cap`);
  }
  for (let future = attempts.length + 1; future <= MAX_ATTEMPTS; future += 1) {
    if (lifecycleExists(artifacts, anchor.subject, order, future)) {
      fail(`${order} judge result omits a later attempt`);
    }
  }
  return attempts;
}

function canonicalWinner(attempt, request) {
  if (attempt.outcome !== "valid") return null;
  if (attempt.response.winner === "tie") return "tie";
  return request.order[attempt.response.winner];
}

function resultBody(input, requests, attempts) {
  const forward = attempts.forward.at(-1);
  const swapped = attempts.swapped.at(-1);
  const bothValid = forward.outcome === "valid" && swapped.outcome === "valid";
  const forwardWinner = canonicalWinner(forward, requests.requests.forward);
  const swappedWinner = canonicalWinner(swapped, requests.requests.swapped);
  let state = "failed";
  let subjectiveWinner = null;
  if (bothValid && forwardWinner === swappedWinner) {
    state = forwardWinner === "tie" ? "tie" : "agreed";
    subjectiveWinner = forwardWinner;
  } else if (bothValid) {
    state = "disagreement";
  }
  const subjectiveState = state;
  const objective = Object.fromEntries(
    TREATMENTS.map((treatmentId) => [
      treatmentId,
      input.objectiveChecks[treatmentId].state,
    ]),
  );
  const passed = TREATMENTS.filter(
    (treatmentId) => objective[treatmentId] === "passed",
  );
  let effectiveWinner = subjectiveWinner;
  let effectiveBasis = "blind-judge";
  if (passed.length === 1) {
    effectiveWinner = passed[0];
    effectiveBasis = "objective-checks";
  } else if (passed.length === 0) {
    state = "failed";
    effectiveWinner = null;
    effectiveBasis = "objective-both-failed";
  } else if (state === "failed" || state === "disagreement") {
    effectiveWinner = null;
    effectiveBasis = state === "failed" ? "judge-failed" : "judge-disagreement";
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeResult",
    definitionRef: DEFINITION_REF,
    trialId: input.trialId,
    subject: input.subject,
    baseSha: input.baseSha,
    executionMode: "production",
    judgeInputDigest: input.contentDigest,
    requestSetDigest: requests.contentDigest,
    attempts: {
      forward: attempts.forward.map((attempt) => ({
        attempt: attempt.attempt,
        contentDigest: attempt.contentDigest,
      })),
      swapped: attempts.swapped.map((attempt) => ({
        attempt: attempt.attempt,
        contentDigest: attempt.contentDigest,
      })),
    },
    state,
    subjectiveState,
    forwardWinner,
    swappedWinner,
    subjectiveWinner,
    objectiveChecks: input.objectiveChecks,
    effectiveWinner,
    effectiveBasis,
  };
}

/**
 * Validate and rederive all retained C5 judge evidence for one selected pair.
 *
 * @param {object} input
 * @param {Map<string, Buffer|Uint8Array>} input.artifactBytesByPath exact bytes,
 *   keyed by path relative to the trial root
 * @param {string} input.trialId independently trusted trial UUID
 * @param {number} input.subject independently trusted C5 subject issue number
 * @param {string} input.baseSha independently trusted pinned Git SHA
 * @returns {{input: object, requests: object, result: object,
 *   attempts: {forward: object[], swapped: object[]}}}
 */
export function validateGate2702JudgeEvidence({
  artifactBytesByPath,
  trialId,
  subject,
  baseSha,
}) {
  const artifacts = requireArtifactMap(artifactBytesByPath);
  if (!UUID_PATTERN.test(trialId ?? ""))
    fail("trialId is not an RFC 4122 UUID");
  if (!Number.isSafeInteger(subject) || subject <= 0) {
    fail("subject is not a valid issue number");
  }
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) {
    fail("baseSha is not a pinned Git SHA");
  }
  const anchor = { trialId, subject, baseSha };
  const { input } = validateFrozenInput(artifacts, anchor);
  const requests = validateRequests(artifacts, anchor, input);
  const resultPath = `judging/issue-${subject}/result.json`;
  const result = assertAnchor(
    readReceipt(artifacts, resultPath, "Gate2702JudgeResult"),
    anchor,
    "judge result",
  );
  assertProduction(result, "judge result");
  const attempts = {
    forward: validateAttemptSequence(
      artifacts,
      anchor,
      requests,
      result,
      "forward",
    ),
    swapped: validateAttemptSequence(
      artifacts,
      anchor,
      requests,
      result,
      "swapped",
    ),
  };
  const expected = resultBody(input, requests, attempts);
  const actual = { ...result };
  delete actual.contentDigest;
  if (!sameValue(actual, expected)) {
    fail("judge result does not match its frozen evidence");
  }
  return { input, requests, result, attempts };
}
