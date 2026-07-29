#!/usr/bin/env node

/**
 * C5-only durable evidence sealer for #2702.
 *
 * `seal` validates live producer evidence, captures every retained byte plus a
 * complete Git diff for every registered attempt, and publishes one atomic
 * content-addressed bundle. `verify` reads only the published bundle, so it
 * remains useful after the disposable worktrees have been removed.
 */

import { spawnSync } from "node:child_process";
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
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GATE_2702_SIDEKICK_VERSION } from "./behavior-context.mjs";
import {
  normalizeGate2702Cost,
  validateGate2702AccountingEvidence,
} from "./seal-accounting.mjs";
import { validateGate2702ClassificationEvidence } from "./seal-classification.mjs";
import { validateGate2702JudgeEvidence } from "./seal-judge.mjs";
import {
  assertGate2702SandboxPreDispatch,
  digestGate2702SidekickSnapshot,
} from "./sandbox-dispatch.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Derived from the shared pin, never re-typed. The sealer re-derives the
// snapshot path the dispatcher attested; a hand-written copy here would keep
// looking for the OLD directory the moment GATE_2702_SIDEKICK_VERSION moves,
// so every otherwise valid production run under the new pin would fail sealing
// with an opaque runtime-binding error instead of a version bump.
const SIDEKICK_SNAPSHOT_DIRECTORY = `claude-sidekick-${GATE_2702_SIDEKICK_VERSION}`;
const SIDEKICK_SNAPSHOT_PREFIX = `sandbox-runtime/${SIDEKICK_SNAPSHOT_DIRECTORY}/`;
const SIDEKICK_SNAPSHOT_PATH_RE = new RegExp(
  `^sandbox-runtime/${SIDEKICK_SNAPSHOT_DIRECTORY.replace(
    /[.*+?^${}()|[\]\\]/g,
    String.raw`\$&`,
  )}/(?:\\.claude-plugin|hooks|scripts)/.+$`,
);
const CLASSIFIER_PATH = join(PROJECT_ROOT, "scripts/gate-2702/classify.mjs");
const ACCOUNTING_PATH = join(PROJECT_ROOT, "scripts/gate-2702/accounting.mjs");
const JUDGE_PATH = join(PROJECT_ROOT, "scripts/gate-2702/judge.mjs");
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_ID = "experiments/gate-2702-c5";
const DEFINITION_VERSION = 1;
const REPOSITORY = "shpwrck/claude-history-dashboard";
const SUBJECTS = [2760, 2719, 2713, 2706, 2710, 2670];
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const CHECK_IDS = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_GIT_BYTES = 256 * 1024 * 1024;
const MAX_WORKTREE_DIFF_ARTIFACTS = 1_024;
const MAX_WORKTREE_DIFF_RAW_BYTES = 64 * 1024 * 1024;
const MAX_TRIAL_DIFF_ARTIFACTS = 4_096;
const MAX_TRIAL_DIFF_RAW_BYTES = 256 * 1024 * 1024;
const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const SIDEKICK_MODEL = "claude-sonnet-5";
const JUDGE_TIMEOUT_MS = 600_000;
const JUDGE_BUDGET_USD = "0.25";
const JUDGE_MAX_STREAM_BYTES = 2 * 1024 * 1024;
const JUDGE_DIMENSIONS = [
  "correctness",
  "design",
  "completeness",
  "clarity",
  "scopeFit",
  "autonomy",
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
      required: JUDGE_DIMENSIONS,
      properties: Object.fromEntries(
        JUDGE_DIMENSIONS.map((key) => [
          key,
          { type: "integer", minimum: 1, maximum: 10 },
        ]),
      ),
    },
  },
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFINITION_REF = Object.freeze({
  definitionId: DEFINITION_ID,
  definitionVersion: DEFINITION_VERSION,
  contentDigest: DEFINITION_DIGEST,
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

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function valueDigest(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function receiptDigest(receipt) {
  const undigested = { ...receipt };
  delete undigested.contentDigest;
  return valueDigest(undigested);
}

function withDigest(receipt) {
  const undigested = { ...receipt };
  delete undigested.contentDigest;
  return { ...undigested, contentDigest: valueDigest(undigested) };
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value;
}

function verifyReceipt(receipt, expectedKind, label = expectedKind) {
  assertPlainObject(receipt, label);
  if (receipt.schemaVersion !== 1 || receipt.kind !== expectedKind) {
    fail(`${label} has the wrong kind or schema version`);
  }
  if (!DIGEST_PATTERN.test(receipt.contentDigest ?? "")) {
    fail(`${label} has no valid content digest`);
  }
  if (receipt.contentDigest !== receiptDigest(receipt)) {
    fail(`${label} content digest does not match its fields`);
  }
  return receipt;
}

function readRegularBytes(
  path,
  maximumBytes = MAX_RECEIPT_BYTES,
  label = path,
) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular file`);
  }
  if (metadata.size > maximumBytes)
    fail(`${label} exceeds its fixed size limit`);
  const bytes = readFileSync(path);
  if (bytes.length !== metadata.size)
    fail(`${label} changed while it was read`);
  return bytes;
}

function readJson(path, maximumBytes = MAX_RECEIPT_BYTES, label = path) {
  try {
    return JSON.parse(
      readRegularBytes(path, maximumBytes, label).toString("utf8"),
    );
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readReceipt(path, kind, label = kind) {
  return verifyReceipt(readJson(path, MAX_RECEIPT_BYTES, label), kind, label);
}

function writeDurableFile(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
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

function atomicWriteJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeDurableFile(temporary, bytes);
  try {
    linkSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readRegularBytes(path, MAX_RECEIPT_BYTES, path).equals(bytes)) {
      fail(
        "immutable verified seal marker already exists with different bytes",
      );
    }
  } finally {
    unlinkSync(temporary);
  }
}

function deterministicUuid(input) {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultStateRoot() {
  return resolve(
    process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["seal", "verify"]).has(command)) {
    fail("usage: seal.mjs <seal|verify> --trial <uuid> [--state-root <path>]");
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${String(key)}`);
    }
    const name = key.slice(2);
    if (!new Set(["trial", "state-root"]).has(name))
      fail(`unknown option ${key}`);
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!UUID_PATTERN.test(options.trial ?? "")) {
    fail("--trial must be an RFC 4122 UUID");
  }
  options.stateRoot = resolve(options["state-root"] || defaultStateRoot());
  return options;
}

function trialPaths(options) {
  const trialRoot = join(
    options.stateRoot,
    DEFINITION_DIGEST.replace(":", "-"),
    options.trial,
  );
  const sealRoot = join(trialRoot, "seal");
  return {
    trialRoot,
    trial: join(trialRoot, "trial.json"),
    sealRoot,
    bundles: join(sealRoot, "bundles"),
    marker: join(sealRoot, "verified.json"),
  };
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

function runDirectory(paths, subject, treatmentId, attempt) {
  return join(
    paths.trialRoot,
    "runs",
    `issue-${subject}`,
    treatmentId,
    `attempt-${attempt}`,
  );
}

function registrationPath(paths, subject, treatmentId, attempt) {
  return join(
    runDirectory(paths, subject, treatmentId, attempt),
    "registration.json",
  );
}

function retryRegistrationManifest(registrations) {
  return [...registrations]
    .sort(
      (left, right) =>
        left.subject - right.subject ||
        left.treatmentId.localeCompare(right.treatmentId),
    )
    .map((registration) => ({
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: registration.attempt,
      registrationDigest: registration.contentDigest,
      retryOf: registration.retryOf,
      worktreePath: registration.worktreePath,
    }));
}

function assertArmIdentity(receipt, registration, label) {
  if (
    !sameValue(receipt.definitionRef, registration.definitionRef) ||
    receipt.trialId !== registration.trialId ||
    receipt.subject !== registration.subject ||
    receipt.treatmentId !== registration.treatmentId ||
    receipt.attempt !== registration.attempt ||
    receipt.baseSha !== registration.baseSha
  ) {
    fail(`${label} identity does not match its registration`);
  }
  return receipt;
}

function currentRetryState(paths, runtime, trial) {
  const registrations = [];
  for (const subject of runtime.plan.subjects) {
    for (const treatment of runtime.plan.treatments) {
      const path = registrationPath(paths, subject, treatment.id, 2);
      if (!existsSync(path)) continue;
      const registration = readReceipt(
        path,
        "Gate2702ArmRegistration",
        "retry registration",
      );
      const parent = trial.registrations.find(
        (entry) =>
          entry.subject === subject && entry.treatmentId === treatment.id,
      );
      if (!parent) fail("retry registration has no attempt-1 parent");
      const parentClassification = readReceipt(
        join(parent.runDir, "classification.json"),
        "Gate2702ArmClassification",
        "retry-authorizing classification",
      );
      const expectedRetryOf = {
        attempt: 1,
        registrationDigest: parent.contentDigest,
        classificationDigest: parentClassification.contentDigest,
      };
      if (
        registration.executionMode !== "production" ||
        registration.subject !== subject ||
        registration.treatmentId !== treatment.id ||
        registration.attempt !== 2 ||
        registration.baseSha !== trial.baseSha ||
        !sameValue(registration.definitionRef, DEFINITION_REF) ||
        !sameValue(registration.retryOf, expectedRetryOf) ||
        parentClassification.registrationDigest !== parent.contentDigest ||
        parentClassification.retry?.authorized !== true
      ) {
        fail(
          `retry registration is not authorized for #${subject}/${treatment.id}`,
        );
      }
      registrations.push(registration);
    }
  }
  const manifest = retryRegistrationManifest(registrations);
  const registrationSetDigest = valueDigest(manifest);
  let currentReceipt = null;
  const setRoot = join(paths.trialRoot, "retries", "sets");
  if (registrations.length > 0) {
    currentReceipt = readReceipt(
      join(setRoot, `${registrationSetDigest.replace(":", "-")}.json`),
      "Gate2702RetryRegistrationSet",
      "current retry registration set",
    );
    if (
      !sameValue(currentReceipt.definitionRef, DEFINITION_REF) ||
      currentReceipt.trialId !== trial.trialId ||
      currentReceipt.baseSha !== trial.baseSha ||
      currentReceipt.registrationSetDigest !== registrationSetDigest ||
      !sameValue(currentReceipt.registrations, manifest)
    ) {
      fail("current retry registration set does not match the exact retry set");
    }
  }
  if (existsSync(setRoot)) {
    for (const name of readdirSync(setRoot)) {
      if (!/^sha256-[0-9a-f]{64}\.json$/.test(name)) {
        fail(`unknown retry-set evidence: ${name}`);
      }
      const receipt = readReceipt(
        join(setRoot, name),
        "Gate2702RetryRegistrationSet",
        `retry-set ${name}`,
      );
      if (
        !sameValue(receipt.definitionRef, DEFINITION_REF) ||
        receipt.trialId !== trial.trialId ||
        receipt.baseSha !== trial.baseSha ||
        name !== `${receipt.registrationSetDigest.replace(":", "-")}.json`
      ) {
        fail(`retry-set ${name} is not bound to this trial`);
      }
    }
  }
  return { registrations, manifest, registrationSetDigest, currentReceipt };
}

function assertExactRunDirectories(paths) {
  const runsRoot = join(paths.trialRoot, "runs");
  const subjectNames = readdirSync(runsRoot).sort();
  const expectedSubjects = SUBJECTS.map((subject) => `issue-${subject}`).sort();
  if (!sameValue(subjectNames, expectedSubjects)) {
    fail("run evidence contains an unknown or missing C5 subject directory");
  }
  for (const subject of SUBJECTS) {
    const subjectRoot = join(runsRoot, `issue-${subject}`);
    if (!sameValue(readdirSync(subjectRoot).sort(), [...TREATMENTS].sort())) {
      fail(`run evidence contains an unknown treatment for #${subject}`);
    }
    for (const treatmentId of TREATMENTS) {
      const attempts = readdirSync(join(subjectRoot, treatmentId)).sort();
      if (
        !sameValue(attempts, ["attempt-1"]) &&
        !sameValue(attempts, ["attempt-1", "attempt-2"])
      ) {
        fail(
          `run evidence contains an unknown attempt for #${subject}/${treatmentId}`,
        );
      }
    }
  }
}

function validateTrial(runtime, options, paths) {
  if (existsSync(join(paths.trialRoot, "lock"))) {
    fail(
      "trial lock still exists; sealing requires a quiescent terminal trial",
    );
  }
  const trial = readReceipt(paths.trial, "Gate2702Trial", "trial receipt");
  if (
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, runtime.plan.definitionRef) ||
    !sameValue(trial.definitionRef, DEFINITION_REF) ||
    trial.repository !== REPOSITORY ||
    trial.executionMode !== "production" ||
    !/^[0-9a-f]{40}$/.test(trial.baseSha ?? "") ||
    resolve(trial.stateRoot) !== resolve(options.stateRoot) ||
    resolve(trial.worktreeRoot) !==
      resolve(join(paths.trialRoot, "worktrees")) ||
    !Array.isArray(trial.registrations) ||
    trial.registrations.length !== 12
  ) {
    fail("trial is not the exact production C5 launcher manifest");
  }
  assertExactRunDirectories(paths);
  const registrations = [];
  for (const subject of runtime.plan.subjects) {
    for (const treatment of runtime.plan.treatments) {
      const embedded = trial.registrations.find(
        (entry) =>
          entry.subject === subject && entry.treatmentId === treatment.id,
      );
      if (!embedded) fail(`trial omits #${subject}/${treatment.id}`);
      verifyReceipt(
        embedded,
        "Gate2702ArmRegistration",
        "embedded registration",
      );
      const registration = readReceipt(
        registrationPath(paths, subject, treatment.id, 1),
        "Gate2702ArmRegistration",
        "attempt-1 registration",
      );
      if (
        !sameValue(registration, embedded) ||
        registration.attempt !== 1 ||
        registration.executionMode !== "production" ||
        registration.baseSha !== trial.baseSha ||
        resolve(registration.runDir) !==
          resolve(runDirectory(paths, subject, treatment.id, 1)) ||
        !isWithin(trial.worktreeRoot, registration.worktreePath)
      ) {
        fail(`attempt-1 registration drifted for #${subject}/${treatment.id}`);
      }
      registrations.push(registration);
    }
    const snapshot = readReceipt(
      join(paths.trialRoot, "subjects", `issue-${subject}.json`),
      "Gate2702SubjectSnapshot",
      `subject snapshot #${subject}`,
    );
    const manifest =
      trial.subjectSnapshots?.filter((entry) => entry.subject === subject) ??
      [];
    if (
      manifest.length !== 1 ||
      manifest[0].contentDigest !== snapshot.contentDigest ||
      snapshot.executionMode !== "production" ||
      snapshot.trialId !== trial.trialId ||
      snapshot.subject !== subject ||
      snapshot.baseSha !== trial.baseSha ||
      !sameValue(snapshot.definitionRef, DEFINITION_REF)
    ) {
      fail(`subject snapshot #${subject} is not launcher-bound`);
    }
  }
  const worktreeManifest = registrations.map((registration) => ({
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    worktreePath: registration.worktreePath,
    registrationDigest: registration.contentDigest,
  }));
  if (trial.worktreeManifestDigest !== valueDigest(worktreeManifest)) {
    fail(
      "launcher worktree manifest digest does not match its 12 registrations",
    );
  }
  const retryState = currentRetryState(paths, runtime, trial);
  return {
    trial,
    registrations: [...registrations, ...retryState.registrations],
    retryState,
  };
}

function producerArgs(script, command, options, registration) {
  const args = [
    script,
    command,
    "--trial",
    options.trial,
    "--subject",
    String(registration.subject),
    "--state-root",
    options.stateRoot,
  ];
  if (script !== JUDGE_PATH) {
    args.push(
      "--treatment",
      registration.treatmentId,
      "--attempt",
      String(registration.attempt),
    );
  }
  return args;
}

function runProducer(args, acceptedStatuses = new Set([0])) {
  const env = { ...process.env, CHD_EXPERIMENT_2702: "1" };
  delete env.CHD_EXPERIMENT_2702_TEST_MODE;
  delete env.CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON;
  delete env.CHD_EXPERIMENT_2702_CLAUDE_BIN;
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || !acceptedStatuses.has(result.status)) {
    fail(
      `producer validation failed (${args.slice(0, 2).join(" ")}): ${result.error?.message || result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(
      `producer validation returned malformed JSON: ${args.slice(0, 2).join(" ")}`,
    );
  }
}

function expectedJudgeArgv() {
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

function assertFixedJudgePreDispatch(
  preDispatch,
  requests,
  request,
  order,
  attempt,
) {
  if (
    !sameValue(preDispatch.definitionRef, DEFINITION_REF) ||
    preDispatch.trialId !== requests.trialId ||
    preDispatch.subject !== requests.subject ||
    preDispatch.baseSha !== requests.baseSha ||
    preDispatch.requestSetDigest !== requests.contentDigest ||
    preDispatch.payloadDigest !== request.payloadDigest ||
    !sameValue(preDispatch.payload, request.payload) ||
    preDispatch.order !== order ||
    preDispatch.attempt !== attempt ||
    preDispatch.executable !== "claude" ||
    !sameValue(preDispatch.argv, expectedJudgeArgv()) ||
    preDispatch.judgeModel !== JUDGE_MODEL ||
    preDispatch.sidekickEnabled !== false ||
    preDispatch.toolAccess !== false ||
    preDispatch.permissionBypass !== false ||
    preDispatch.maxBudgetUsd !== Number(JUDGE_BUDGET_USD) ||
    preDispatch.timeoutMs !== JUDGE_TIMEOUT_MS ||
    preDispatch.maxStdoutBytes !== JUDGE_MAX_STREAM_BYTES ||
    preDispatch.maxStderrBytes !== JUDGE_MAX_STREAM_BYTES ||
    !UUID_PATTERN.test(preDispatch.dispatchToken ?? "") ||
    !Number.isFinite(Date.parse(preDispatch.createdAt ?? ""))
  ) {
    fail(
      `judge pre-dispatch #${requests.subject}/${order}/${attempt} is not the fixed production command`,
    );
  }
}

function validateJudgeDispatches(paths, subject, result) {
  const subjectRoot = join(paths.trialRoot, "judging", `issue-${subject}`);
  const requests = readReceipt(
    join(subjectRoot, "requests.json"),
    "Gate2702JudgeRequests",
    `judge requests #${subject}`,
  );
  for (const order of ["forward", "swapped"]) {
    const attempts = result.attempts?.[order];
    if (
      !Array.isArray(attempts) ||
      attempts.length < 1 ||
      attempts.length > 3
    ) {
      fail(`judge result #${subject}/${order} has an invalid attempt set`);
    }
    for (const [index, reference] of attempts.entries()) {
      const attempt = index + 1;
      const preDispatch = readReceipt(
        join(subjectRoot, order, `attempt-${attempt}.pre-dispatch.json`),
        "Gate2702JudgePreDispatch",
        `judge pre-dispatch #${subject}/${order}/${attempt}`,
      );
      if (reference.attempt !== attempt) fail("judge attempts contain a gap");
      assertFixedJudgePreDispatch(
        preDispatch,
        requests,
        requests.requests?.[order],
        order,
        attempt,
      );
    }
  }
}

const productionValidators = {
  classification(options, registration) {
    return runProducer(
      producerArgs(CLASSIFIER_PATH, "classify", options, registration),
    );
  },
  accounting(options, registration) {
    return runProducer(
      producerArgs(ACCOUNTING_PATH, "collect", options, registration),
    );
  },
  judge(options, subject) {
    return runProducer(
      [
        JUDGE_PATH,
        "run",
        "--trial",
        options.trial,
        "--subject",
        String(subject),
        "--state-root",
        options.stateRoot,
      ],
      new Set([0, 2]),
    );
  },
};

function validateTerminalArm(
  runtime,
  paths,
  registration,
  validators,
  options,
) {
  const runDir = registration.runDir;
  const terminal = assertArmIdentity(
    readReceipt(
      join(runDir, "terminal.json"),
      "Gate2702Terminal",
      "terminal receipt",
    ),
    registration,
    "terminal receipt",
  );
  const classification = assertArmIdentity(
    readReceipt(
      join(runDir, "classification.json"),
      "Gate2702ArmClassification",
      "classification receipt",
    ),
    registration,
    "classification receipt",
  );
  if (
    classification.registrationDigest !== registration.contentDigest ||
    classification.terminalDigest !== terminal.contentDigest ||
    !["succeeded", "failed", "cancelled"].includes(classification.status) ||
    typeof classification.eligible !== "boolean"
  ) {
    fail("classification is not bound to a terminal registered arm");
  }
  const preDispatchPath = join(runDir, "pre-dispatch.json");
  let preDispatch = null;
  if (existsSync(preDispatchPath)) {
    preDispatch = assertArmIdentity(
      readReceipt(
        preDispatchPath,
        "Gate2702PreDispatch",
        "worker pre-dispatch",
      ),
      registration,
      "worker pre-dispatch",
    );
    const expectedArgv = [
      "claude",
      "-p",
      "--model",
      "claude-haiku-4-5-20251001",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--max-budget-usd",
      String(runtime.plan.costCaps.workerUsd),
    ];
    const legacyTestDispatch =
      validators !== productionValidators &&
      preDispatch.sandbox === undefined &&
      sameValue(preDispatch.argv, expectedArgv);
    if (!legacyTestDispatch) {
      const worktreeIdentity = readReceipt(
        join(runDir, "worktree-identity.json"),
        "Gate2702WorktreeIdentity",
        "worker worktree identity",
      );
      let sandbox;
      try {
        sandbox = assertGate2702SandboxPreDispatch({
          preDispatch,
          registration,
          worktreeIdentity,
        });
      } catch (error) {
        fail(
          `sealing refuses test-mode or non-registered worker argv: ${error.message}`,
        );
      }
      const expectedSidekickPath = join(
        paths.trialRoot,
        "sandbox-runtime",
        SIDEKICK_SNAPSHOT_DIRECTORY,
      );
      const settingsPath = join(runDir, "sandbox", "settings.json");
      const expectedWorkerArgv = [
        sandbox.workerArgv[0],
        ...expectedArgv.slice(1),
        "--plugin-dir",
        expectedSidekickPath,
      ];
      if (
        !isAbsolute(sandbox.workerArgv[0]) ||
        !sandbox.allowedReadRoots.includes(resolve(sandbox.workerArgv[0])) ||
        !sameValue(sandbox.workerArgv, expectedWorkerArgv) ||
        !sameValue(
          readJson(settingsPath, MAX_RECEIPT_BYTES, "sandbox settings"),
          sandbox.policy,
        ) ||
        sandbox.sidekickSnapshot?.path !== expectedSidekickPath ||
        !DIGEST_PATTERN.test(sandbox.sidekickSnapshot?.contentDigest ?? "") ||
        digestGate2702SidekickSnapshot(expectedSidekickPath) !==
          sandbox.sidekickSnapshot.contentDigest
      ) {
        fail("worker sandbox does not bind the fixed Claude/Sidekick runtime");
      }
      for (const [name, logEvidence] of [
        ["stdout.log", terminal.stdout],
        ["stderr.log", terminal.stderr],
      ]) {
        const bytes = readRegularBytes(
          join(runDir, name),
          MAX_RECEIPT_BYTES,
          `worker ${name}`,
        );
        if (
          logEvidence?.byteLength !== bytes.length ||
          logEvidence?.contentDigest !== sha256Bytes(bytes)
        ) {
          fail("worker terminal does not bind its retained logs");
        }
      }
    }
    if (
      preDispatch.executionMode !== "production" ||
      registration.executionMode !== "production" ||
      preDispatch.registrationDigest !== registration.contentDigest
    ) {
      fail("sealing refuses test-mode or non-registered worker argv");
    }
  } else if (terminal.outcome !== "preflight-failed") {
    fail("terminal worker arm has no production pre-dispatch receipt");
  }
  const reclassified = validators.classification(options, registration);
  if (!sameValue(reclassified, classification)) {
    fail("classification did not rederive from its terminal/check evidence");
  }
  const accounting = assertArmIdentity(
    readReceipt(
      join(runDir, "accounting.json"),
      "Gate2702Accounting",
      "accounting receipt",
    ),
    registration,
    "accounting receipt",
  );
  if (
    accounting.registrationDigest !== registration.contentDigest ||
    accounting.terminalDigest !== terminal.contentDigest ||
    accounting.classificationDigest !== classification.contentDigest
  ) {
    fail("accounting is not bound to the exact terminal classification");
  }
  const reaccounted = validators.accounting(options, registration);
  if (!sameValue(reaccounted, accounting)) {
    fail("accounting did not rederive from worker/Sidekick evidence");
  }
  return { registration, terminal, classification, accounting, preDispatch };
}

function selectedAttempts(paths, trial, armEvidence) {
  const bySubject = new Map();
  for (const subject of SUBJECTS) {
    const selectionPath = join(
      paths.trialRoot,
      "pair-selection",
      `issue-${subject}.json`,
    );
    const arms = armEvidence.filter(
      (entry) => entry.registration.subject === subject,
    );
    const finalByTreatment = Object.fromEntries(
      TREATMENTS.map((treatmentId) => [
        treatmentId,
        arms
          .filter((entry) => entry.registration.treatmentId === treatmentId)
          .sort(
            (left, right) =>
              right.registration.attempt - left.registration.attempt,
          )[0],
      ]),
    );
    const selectable = TREATMENTS.every(
      (treatmentId) =>
        finalByTreatment[treatmentId]?.classification.status === "succeeded" &&
        finalByTreatment[treatmentId]?.classification.eligible === true,
    );
    if (!existsSync(selectionPath)) {
      if (selectable)
        fail(
          `eligible #${subject} pair has no deterministic selection receipt`,
        );
      continue;
    }
    const selection = readReceipt(
      selectionPath,
      "Gate2702PairSelection",
      `pair selection #${subject}`,
    );
    if (
      selection.trialId !== trial.trialId ||
      selection.subject !== subject ||
      selection.baseSha !== trial.baseSha ||
      !sameValue(selection.definitionRef, DEFINITION_REF)
    ) {
      fail(`pair selection #${subject} has the wrong trial identity`);
    }
    const selected = {};
    for (const treatmentId of TREATMENTS) {
      const pointer = selection.arms?.[treatmentId];
      const evidence = arms.find(
        (entry) =>
          entry.registration.treatmentId === treatmentId &&
          entry.registration.attempt === pointer?.attempt,
      );
      if (
        !evidence ||
        pointer.treatmentId !== treatmentId ||
        pointer.registrationDigest !== evidence.registration.contentDigest ||
        pointer.classificationDigest !==
          evidence.classification.contentDigest ||
        evidence.classification.status !== "succeeded" ||
        evidence.classification.eligible !== true
      ) {
        fail(
          `pair selection #${subject} does not name an exact eligible ${treatmentId} arm`,
        );
      }
      selected[treatmentId] = evidence;
    }
    bySubject.set(subject, { selection, selected });
  }
  return bySubject;
}

function validateJudging(paths, options, selected, validators) {
  const judgeBySubject = new Map();
  const judgingRoot = join(paths.trialRoot, "judging");
  for (const subject of SUBJECTS) {
    const pair = selected.get(subject);
    const subjectRoot = join(judgingRoot, `issue-${subject}`);
    if (!pair) {
      if (existsSync(subjectRoot))
        fail(`unselected #${subject} has unknown judge evidence`);
      continue;
    }
    const resultPath = join(subjectRoot, "result.json");
    if (!existsSync(resultPath))
      fail(`selected #${subject} pair has no terminal judge result`);
    const result = readReceipt(
      resultPath,
      "Gate2702JudgeResult",
      `judge result #${subject}`,
    );
    validateJudgeDispatches(paths, subject, result);
    const rejudged = validators.judge(options, subject);
    if (!sameValue(rejudged, result)) {
      fail(
        `judge result #${subject} did not rederive from its frozen attempts`,
      );
    }
    judgeBySubject.set(subject, result);
  }
  return judgeBySubject;
}

function expectedEvidencePaths(paths, armEvidence, selected) {
  const expected = new Set(["trial.json"]);
  for (const subject of SUBJECTS) {
    expected.add(`subjects/issue-${subject}.json`);
    expected.add(`preflight/issue-${subject}.json`);
    const pair = selected.get(subject);
    if (pair) expected.add(`pair-selection/issue-${subject}.json`);
  }
  for (const evidence of armEvidence) {
    const { registration } = evidence;
    const prefix = relative(paths.trialRoot, registration.runDir);
    for (const name of [
      "registration.json",
      "worktree-identity.json",
      "preflight.json",
      "pre-dispatch.json",
      "process.json",
      "stdout.log",
      "stderr.log",
      "terminal.json",
      "classification.json",
      "accounting.json",
    ]) {
      const path = join(registration.runDir, name);
      if (existsSync(path)) expected.add(join(prefix, name));
    }
    const preDispatchPath = join(registration.runDir, "pre-dispatch.json");
    if (
      existsSync(preDispatchPath) &&
      readReceipt(preDispatchPath, "Gate2702PreDispatch", "worker pre-dispatch")
        .sandbox !== undefined
    ) {
      expected.add(join(prefix, "sandbox", "settings.json"));
    }
    for (const name of [
      "pre-dispatch.json",
      "process.json",
      "dispatch-gate",
      "outcome.json",
      "stdout.log",
      "stderr.log",
      "execution.json",
    ]) {
      const path = join(registration.runDir, "preflight-install", name);
      if (existsSync(path))
        expected.add(join(prefix, "preflight-install", name));
    }
    for (const checkId of CHECK_IDS) {
      const slug = checkId.replaceAll("/", "_");
      for (const suffix of [
        ".json",
        ".pre-dispatch.json",
        ".process.json",
        ".dispatch-gate",
        ".outcome.json",
        ".stdout.log",
        ".stderr.log",
      ]) {
        const name = `${slug}${suffix}`;
        const path = join(registration.runDir, "checks", name);
        if (existsSync(path)) expected.add(join(prefix, "checks", name));
      }
    }
  }
  const setRoot = join(paths.trialRoot, "retries", "sets");
  if (existsSync(setRoot)) {
    for (const name of readdirSync(setRoot))
      expected.add(join("retries", "sets", name));
  }
  const judgingRoot = join(paths.trialRoot, "judging");
  if (existsSync(judgingRoot)) {
    for (const subject of SUBJECTS) {
      if (!selected.has(subject)) continue;
      const prefix = join("judging", `issue-${subject}`);
      for (const name of [
        "input.json",
        "requests.json",
        "result.json",
        "evidence/haiku-solo.json",
        "evidence/haiku-sonnet-sidekick.json",
      ]) {
        const path = join(paths.trialRoot, prefix, name);
        if (existsSync(path)) expected.add(join(prefix, name));
      }
      for (const order of ["forward", "swapped"]) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          for (const suffix of [
            ".json",
            ".pre-dispatch.json",
            ".process.json",
            ".gate.json",
            ".outcome.json",
          ]) {
            const name = `${order}/attempt-${attempt}${suffix}`;
            const path = join(paths.trialRoot, prefix, name);
            if (existsSync(path)) expected.add(join(prefix, name));
          }
        }
      }
    }
  }
  const sidekickSnapshotRoot = join(
    paths.trialRoot,
    "sandbox-runtime",
    SIDEKICK_SNAPSHOT_DIRECTORY,
  );
  if (existsSync(sidekickSnapshotRoot)) {
    for (const path of walkEvidenceFiles(sidekickSnapshotRoot)) {
      expected.add(join("sandbox-runtime", SIDEKICK_SNAPSHOT_DIRECTORY, path));
    }
  }
  if (existsSync(join(paths.trialRoot, "supervisor.log")))
    expected.add("supervisor.log");
  return expected;
}

function walkEvidenceFiles(root, current = root, result = []) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const rel = relative(root, path);
    const parts = rel.split(process.platform === "win32" ? "\\" : "/");
    if (
      parts[0] === "runs" &&
      /^issue-\d+$/.test(parts[1] ?? "") &&
      /^attempt-[12]$/.test(parts[3] ?? "") &&
      parts[4] === "sandbox" &&
      parts[5] === "home" &&
      parts[6] === ".sidekick"
    ) {
      const sidekickRoot = lstatSync(path);
      if (!sidekickRoot.isDirectory() || sidekickRoot.isSymbolicLink()) {
        fail(`sandbox Sidekick state is not a real directory: ${rel}`);
      }
      continue;
    }
    if (
      rel === "seal" ||
      rel.startsWith(`seal${process.platform === "win32" ? "\\" : "/"}`)
    )
      continue;
    if (
      rel === "worktrees" ||
      rel.startsWith(`worktrees${process.platform === "win32" ? "\\" : "/"}`)
    )
      continue;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      fail(`trial evidence contains a symlink: ${rel}`);
    if (metadata.isDirectory()) walkEvidenceFiles(root, path, result);
    else if (metadata.isFile()) result.push(rel);
    else fail(`trial evidence contains a special file: ${rel}`);
  }
  return result;
}

function assertNoUnknownEvidence(paths, expected) {
  if (existsSync(join(paths.trialRoot, "cleanup.json"))) {
    fail("a cleaned trial cannot be newly sealed from live workspaces");
  }
  const actual = walkEvidenceFiles(paths.trialRoot);
  for (const path of actual) {
    if (!expected.has(path)) fail(`unknown C5 evidence path: ${path}`);
  }
  for (const path of expected) {
    if (!actual.includes(path))
      fail(`required C5 evidence path is missing: ${path}`);
  }
  return actual.sort();
}

function runGit(worktree, args, encoding = null, maxBuffer = MAX_GIT_BYTES) {
  const result = spawnSync("git", ["-C", worktree, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    fail(`git ${args.join(" ")} failed while sealing ${worktree}`);
  }
  return result.stdout;
}

function captureWorktreeDiff(registration, trialBounds) {
  const worktree = resolve(registration.worktreePath);
  const metadata = lstatSync(worktree);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`registered worktree is unavailable: ${worktree}`);
  }
  const head = runGit(worktree, ["rev-parse", "HEAD"], "utf8")
    .trim()
    .toLowerCase();
  if (head !== registration.baseSha) {
    const ancestor = spawnSync(
      "git",
      [
        "-C",
        worktree,
        "merge-base",
        "--is-ancestor",
        registration.baseSha,
        "HEAD",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    if (ancestor.status !== 0)
      fail("registered worktree no longer descends from its pinned base");
  }
  const patch = runGit(
    worktree,
    [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      registration.baseSha,
      "--",
    ],
    null,
    MAX_WORKTREE_DIFF_RAW_BYTES,
  );
  const untrackedNames = runGit(worktree, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  if (untrackedNames.length + 1 > MAX_WORKTREE_DIFF_ARTIFACTS) {
    fail("worktree diff exceeds the fixed artifact-count bound");
  }
  const inventory = untrackedNames.map((path) => {
    const absolute = join(worktree, path);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) {
      const bytes = Buffer.from(readlinkSync(absolute), "utf8");
      return { path, absolute, entry, bytes };
    }
    if (!entry.isFile()) fail(`unsupported untracked worktree entry: ${path}`);
    if (entry.size > MAX_OBJECT_BYTES)
      fail(`untracked evidence is too large: ${path}`);
    return { path, absolute, entry, bytes: null };
  });
  const rawBytes =
    patch.length +
    inventory.reduce(
      (total, item) => total + (item.bytes?.length ?? item.entry.size),
      0,
    );
  const artifactCount = inventory.length + 1;
  if (rawBytes > MAX_WORKTREE_DIFF_RAW_BYTES) {
    fail("worktree diff exceeds the fixed aggregate byte bound");
  }
  if (
    trialBounds.rawBytes + rawBytes > MAX_TRIAL_DIFF_RAW_BYTES ||
    trialBounds.artifactCount + artifactCount > MAX_TRIAL_DIFF_ARTIFACTS
  ) {
    fail("trial diffs exceed their fixed aggregate byte/count bounds");
  }
  trialBounds.rawBytes += rawBytes;
  trialBounds.artifactCount += artifactCount;
  const untracked = inventory.map(({ path, absolute, entry, bytes }) => {
    if (entry.isSymbolicLink()) {
      return {
        path,
        kind: "symlink",
        mode: entry.mode,
        sizeBytes: bytes.length,
        contentDigest: sha256Bytes(bytes),
        encoding: "utf8",
        bytes: bytes.toString("utf8"),
      };
    }
    const fileBytes = readFileSync(absolute);
    if (fileBytes.length !== entry.size) {
      fail(`untracked evidence changed while sealing: ${path}`);
    }
    return {
      path,
      kind: "file",
      mode: entry.mode,
      sizeBytes: fileBytes.length,
      contentDigest: sha256Bytes(fileBytes),
      encoding: "base64",
      bytes: fileBytes.toString("base64"),
    };
  });
  return {
    schemaVersion: 1,
    kind: "Gate2702SealedWorktreeDiff",
    definitionRef: registration.definitionRef,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    registrationDigest: registration.contentDigest,
    head,
    trackedPatch: {
      encoding: "base64",
      sizeBytes: patch.length,
      contentDigest: sha256Bytes(patch),
      bytes: patch.toString("base64"),
    },
    untracked,
  };
}

function artifactId(path) {
  return path.replace(/[^A-Za-z0-9._:/@-]/g, "-");
}

function objectEvidenceRef(entry, trialId) {
  return {
    kind: "artifact",
    artifactRef: {
      harness: "claude-code",
      sourceId: `gate-2702:${trialId}`,
      artifactId: artifactId(entry.sourcePath),
      contentDigest: entry.contentDigest,
      mediaType: entry.mediaType,
    },
  };
}

function decodeBase64(value, label) {
  if (typeof value !== "string") fail(`${label} has no bytes`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${label} has malformed base64`);
  return bytes;
}

function validateFrozenDiff(diff, label) {
  const patch = decodeBase64(
    diff?.trackedPatch?.bytes,
    `${label} tracked patch`,
  );
  if (
    diff.trackedPatch.encoding !== "base64" ||
    diff.trackedPatch.sizeBytes !== patch.length ||
    diff.trackedPatch.contentDigest !== sha256Bytes(patch) ||
    !Array.isArray(diff.untracked)
  ) {
    fail(`${label} has invalid tracked diff evidence`);
  }
  const paths = diff.untracked.map((entry) => entry.path);
  if (
    !sameValue(paths, [...paths].sort()) ||
    new Set(paths).size !== paths.length
  ) {
    fail(`${label} untracked evidence is not uniquely sorted`);
  }
  for (const entry of diff.untracked) {
    const bytes =
      entry.encoding === "base64"
        ? decodeBase64(entry.bytes, `${label} ${entry.path}`)
        : Buffer.from(entry.bytes ?? "", "utf8");
    if (
      !["file", "symlink"].includes(entry.kind) ||
      entry.sizeBytes !== bytes.length ||
      entry.contentDigest !== sha256Bytes(bytes)
    ) {
      fail(`${label} has invalid untracked evidence for ${entry.path}`);
    }
  }
}

function judgeArtifactText(workerResultText, diff, registration) {
  const patch = decodeBase64(
    diff.trackedPatch.bytes,
    "frozen judge tracked patch",
  ).toString("utf8");
  const untracked = diff.untracked
    .map(
      (entry) =>
        `[UNTRACKED ${entry.kind} ${entry.path}; ${entry.encoding}]\n${entry.bytes}`,
    )
    .join("\n\n");
  return [workerResultText, "[FINAL TRACKED DIFF]", patch, untracked]
    .filter(Boolean)
    .join("\n\n")
    .replaceAll(registration.worktreePath, "<worktree>")
    .replaceAll(registration.runDir, "<run>")
    .replaceAll(registration.treatmentId, "<arm>")
    .replace(/claude-(?:haiku|sonnet|opus)-[a-z0-9-]+/gi, "<model>");
}

function validateFrozenJudgeArm(
  frozen,
  registration,
  classification,
  selectionDigest,
) {
  validateFrozenDiff(frozen.diff, "frozen judge worktree diff");
  if (
    !sameValue(frozen.definitionRef, DEFINITION_REF) ||
    frozen.trialId !== registration.trialId ||
    frozen.subject !== registration.subject ||
    frozen.treatmentId !== registration.treatmentId ||
    frozen.attempt !== registration.attempt ||
    frozen.baseSha !== registration.baseSha ||
    frozen.registrationDigest !== registration.contentDigest ||
    frozen.classificationDigest !== classification.contentDigest ||
    (selectionDigest !== undefined &&
      frozen.pairSelectionDigest !== selectionDigest) ||
    typeof frozen.workerResult !== "string" ||
    !frozen.workerResult.trim() ||
    frozen.workerResultDigest !==
      sha256Bytes(Buffer.from(frozen.workerResult, "utf8")) ||
    frozen.artifact !==
      judgeArtifactText(frozen.workerResult, frozen.diff, registration)
  ) {
    fail("frozen judge arm evidence does not rederive from retained sources");
  }
  return frozen;
}

function timestampPlus(startedAt, durationMs) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) fail("receipt contains an invalid timestamp");
  const duration =
    typeof durationMs === "number" && Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;
  return new Date(start + Math.ceil(duration)).toISOString();
}

function latestTimestamp(values) {
  const times = values.filter(Boolean).map((value) => Date.parse(value));
  if (times.some((value) => !Number.isFinite(value)))
    fail("evidence contains an invalid timestamp");
  return new Date(Math.max(...times)).toISOString();
}

function preflightFor(paths, registration) {
  if (registration.attempt === 1) {
    const receipt = readReceipt(
      join(paths.trialRoot, "preflight", `issue-${registration.subject}.json`),
      "Gate2702PairPreflight",
      "pair preflight",
    );
    return {
      receipt,
      arm: receipt.arms?.[registration.treatmentId],
      behaviorContext:
        receipt.arms?.[registration.treatmentId]?.behaviorContext ?? null,
      environmentDigest:
        receipt.arms?.[registration.treatmentId]?.environmentDigest,
      environment: receipt.arms?.[registration.treatmentId]?.environment,
    };
  }
  const receipt = readReceipt(
    join(registration.runDir, "preflight.json"),
    "Gate2702RetryPreflight",
    "retry preflight",
  );
  return {
    receipt,
    arm: receipt,
    behaviorContext: receipt.behaviorContext ?? null,
    environmentDigest: receipt.environmentDigest,
    environment: receipt.environment,
  };
}

function factor(id, value, displayValue) {
  return {
    id,
    valueDigest: DIGEST_PATTERN.test(value) ? value : valueDigest(value),
    ...(displayValue ? { displayValue } : {}),
  };
}

function buildFingerprint(
  runtime,
  paths,
  evidence,
  startedAt,
  retainedPreflight = null,
) {
  const { registration, preDispatch } = evidence;
  const treatment = runtime.plan.treatments.find(
    (entry) => entry.id === registration.treatmentId,
  );
  const preflight = retainedPreflight ?? preflightFor(paths, registration);
  const context = preflight.behaviorContext;
  const enabled = treatment.configuration.sidekick.enabled;
  const workerModel =
    context?.workerModelQualifiedId ?? "claude-haiku-4-5-20251001";
  const sidekickModel = context?.sidekickModelQualifiedId ?? null;
  const runtimeVersion =
    preflight.environment?.claude?.version ?? "unavailable";
  const fingerprint = {
    schemaVersion: 1,
    policy: { id: "fingerprints/gate-2702-c5", version: 1 },
    digest: `sha256:${"0".repeat(64)}`,
    observedAt: context?.observedAt ?? startedAt,
    completeness: context ? "complete" : "incomplete",
    runtime: { id: "experiment-runtime/gate-2702-c5", behaviorVersion: "1" },
    adapter: {
      id: "gate-2702-claude-code-adapter",
      behaviorVersion: "1",
      fingerprintSchemaVersion: 1,
    },
    model: { qualifiedId: `anthropic/${workerModel}` },
    factors: [
      factor(
        "runtime/claude-cli-version",
        runtimeVersion,
        String(runtimeVersion).slice(0, 128),
      ),
      factor("model/worker-qualified-id", workerModel, workerModel),
      factor(
        "runtime/worker-invocation-digest",
        preDispatch
          ? valueDigest({ argv: preDispatch.argv })
          : valueDigest("not-dispatched"),
      ),
      factor(
        "sidekick/enabled",
        { enabled, activation: context?.sidekickActivation ?? null },
        enabled ? "enabled" : "disabled",
      ),
      factor(
        "sidekick/model-qualified-id",
        sidekickModel,
        sidekickModel ?? "disabled",
      ),
      factor(
        "sidekick/gate",
        treatment.configuration.sidekick.gate ?? "off",
        treatment.configuration.sidekick.gate ?? "off",
      ),
      factor(
        "sidekick/version",
        {
          version: context?.sidekickVersion ?? null,
          implementationDigest: context?.sidekickImplementationDigest ?? null,
        },
        context?.sidekickVersion ?? "disabled",
      ),
      factor(
        "sidekick/resolved-config-digest",
        context?.resolvedSidekickConfigDigest ??
          valueDigest(treatment.configuration.sidekick),
      ),
      factor(
        "sidekick/instructions-digest",
        context?.instructionsDigest ?? valueDigest([]),
      ),
      factor(
        "budget/worker-usd",
        runtime.plan.costCaps.workerUsd,
        String(runtime.plan.costCaps.workerUsd),
      ),
      factor(
        "budget/sidekick-session-usd",
        treatment.configuration.sidekick.sessionBudgetUsd,
        String(treatment.configuration.sidekick.sessionBudgetUsd),
      ),
      factor(
        "budget/sidekick-per-call-usd",
        treatment.configuration.sidekick.perCallBudgetUsd,
        String(treatment.configuration.sidekick.perCallBudgetUsd),
      ),
      factor(
        "checks/environment-digest",
        preflight.environmentDigest ?? valueDigest("unavailable"),
      ),
      factor(
        "repository/base-sha",
        registration.baseSha,
        registration.baseSha.slice(0, 12),
      ),
    ],
  };
  return runtime.contracts.withBehaviorFingerprintDigest(fingerprint);
}

function selectionBindingFor({
  runtime,
  trialId,
  treatmentId,
  fingerprint,
  planSlots,
  receiptKind,
}) {
  const receiptId = deterministicUuid(
    `gate-2702-selection\0${trialId}\0${treatmentId}\0${receiptKind}`,
  );
  const seed = {
    definitionRef: runtime.plan.definitionRef,
    trialId,
    treatmentId,
    receiptKind,
    planSlots,
    behaviorFingerprintDigest: fingerprint.digest,
  };
  const receiptDigest = valueDigest(seed);
  if (receiptKind === "base") {
    return runtime.definitionModule.createGate2702C5SelectionBinding({
      receiptId,
      receiptDigest,
      trialId,
      behaviorFingerprintDigest: fingerprint.digest,
      treatmentId,
    });
  }
  return Object.freeze({
    receiptId,
    receiptDigest,
    outcome: "selected",
    definitionRef: runtime.plan.definitionRef,
    trialId,
    selectedHarness: "claude-code",
    adapterBinding: {
      adapterId: "gate-2702-claude-code-adapter",
      behaviorFingerprintDigest: fingerprint.digest,
    },
    planSlots,
  });
}

function fingerprintWithoutObservation(fingerprint) {
  const comparable = { ...fingerprint };
  delete comparable.digest;
  delete comparable.observedAt;
  return comparable;
}

function buildSelectionGroups(runtime, paths, armEvidence) {
  const byRegistration = new Map();
  const bindings = [];
  for (const treatmentId of TREATMENTS) {
    for (const attempt of [1, 2]) {
      const members = armEvidence.filter(
        (entry) =>
          entry.registration.treatmentId === treatmentId &&
          entry.registration.attempt === attempt,
      );
      if (members.length === 0) continue;
      const complete = [];
      for (const evidence of members) {
        const startedAt =
          evidence.preDispatch?.startedAt ?? evidence.terminal.endedAt;
        const fingerprint = buildFingerprint(
          runtime,
          paths,
          evidence,
          startedAt,
        );
        if (fingerprint.completeness !== "complete") continue;
        complete.push({ evidence, fingerprint });
      }
      if (complete.length === 0) continue;
      const first = complete[0].fingerprint;
      if (
        complete.some(
          ({ fingerprint }) =>
            !sameValue(
              fingerprintWithoutObservation(fingerprint),
              fingerprintWithoutObservation(first),
            ),
        )
      ) {
        fail(
          `C5 ${treatmentId} attempt-${attempt} behavior factors drifted across registered subjects`,
        );
      }
      const observedAt = complete
        .map(({ fingerprint }) => fingerprint.observedAt)
        .sort()[0];
      const fingerprint = runtime.contracts.withBehaviorFingerprintDigest({
        ...first,
        observedAt,
      });
      const planSlots =
        attempt === 1
          ? SUBJECTS.map((subject) => ({
              planSlotId: `issue-${subject}.${treatmentId}`,
              kind: "treatment-run",
              treatmentId,
            }))
          : complete.map(({ evidence }) => ({
              planSlotId: `issue-${evidence.registration.subject}.${treatmentId}.retry-2`,
              kind: "treatment-run",
              treatmentId,
            }));
      const binding = selectionBindingFor({
        runtime,
        trialId: complete[0].evidence.registration.trialId,
        treatmentId,
        fingerprint,
        planSlots,
        receiptKind: attempt === 1 ? "base" : "retry-2",
      });
      bindings.push(binding);
      for (const { evidence } of complete) {
        byRegistration.set(evidence.registration.contentDigest, {
          fingerprint,
          binding,
          planSlotId:
            attempt === 1
              ? `issue-${evidence.registration.subject}.${treatmentId}`
              : `issue-${evidence.registration.subject}.${treatmentId}.retry-2`,
        });
      }
    }
  }
  return { byRegistration, bindings };
}

function workerResult(accounting, runDir) {
  try {
    const value = JSON.parse(
      readRegularBytes(join(runDir, "stdout.log"), MAX_OBJECT_BYTES).toString(
        "utf8",
      ),
    );
    return value;
  } catch {
    return null;
  }
}

function objectForPath(artifactByPath, path) {
  const entry = artifactByPath.get(path);
  if (!entry) fail(`sealed artifact was not indexed: ${path}`);
  return entry;
}

function evidenceForPath(artifactByPath, path, trialId) {
  return [objectEvidenceRef(objectForPath(artifactByPath, path), trialId)];
}

function buildCheckResults(paths, evidence, artifactByPath, startedAt) {
  const results = [];
  for (const summary of evidence.classification.checkResults ?? []) {
    const slug = summary.checkId.replaceAll("/", "_");
    const rel = join(
      relative(paths.trialRoot, evidence.registration.runDir),
      "checks",
      `${slug}.json`,
    );
    const execution = readReceipt(
      join(paths.trialRoot, rel),
      "Gate2702CheckExecution",
      `check execution ${summary.checkId}`,
    );
    const finishedAt = timestampPlus(execution.startedAt, execution.durationMs);
    if (Date.parse(execution.startedAt) < Date.parse(startedAt)) {
      fail("declared check predates worker dispatch");
    }
    results.push({
      checkId: summary.checkId,
      outcome: summary.status === "passed" ? "passed" : "failed",
      startedAt: execution.startedAt,
      finishedAt,
      evidenceRefs: evidenceForPath(
        artifactByPath,
        rel,
        evidence.registration.trialId,
      ),
    });
  }
  return results;
}

function metricObservation(
  definition,
  metricId,
  value,
  observedAt,
  evidenceRefs,
) {
  const metric = definition.metrics.find((entry) => entry.id === metricId);
  if (!metric) fail(`Definition omits ${metricId}`);
  return {
    metricId,
    value,
    unit: metric.unit,
    scope: metric.scope,
    basis: metric.basis,
    semanticsVersion: metric.semanticsVersion,
    confidence: "high",
    observedAt,
    evidenceRefs,
  };
}

function candidateExclusion(evidence, judge, selectionInfo) {
  const { accounting, classification, terminal } = evidence;
  if (!selectionInfo) return "complete-behavior-fingerprint-unavailable";
  if (classification.error?.code === "behavior-context-drift") {
    return "behavior-context-drift";
  }
  const result = workerResult(accounting, evidence.registration.runDir);
  if (!UUID_PATTERN.test(result?.session_id ?? "")) {
    return "worker-session-id-unknown";
  }
  if (
    accounting.bridgeEvidenceStatus !== "eligible" ||
    typeof accounting.allInCostUsd !== "number" ||
    !Number.isFinite(accounting.allInCostUsd) ||
    accounting.allInCostUsd < 0
  ) {
    return `unknown-all-in-cost:${(accounting.exclusionReasons ?? []).join(",") || "unspecified"}`;
  }
  if (accounting.allInCostUsd > 18)
    return "all-in-cost-exceeds-definition-limit";
  if (classification.status === "succeeded") {
    if (!judge) return "selected-pair-judge-unavailable";
    if (
      judge.effectiveWinner === null &&
      TREATMENTS.every(
        (treatmentId) =>
          judge.objectiveChecks?.[treatmentId]?.state === "passed",
      )
    ) {
      return "judge-quality-not-evaluable";
    }
    if (
      typeof terminal.durationMs !== "number" ||
      !Number.isFinite(terminal.durationMs) ||
      terminal.durationMs < 0
    ) {
      return "worker-wall-time-unknown";
    }
    for (const field of [
      "sidekickTriggerCount",
      "sidekickPaidCallCount",
      "sidekickShippedInterventionCount",
    ]) {
      if (!Number.isSafeInteger(accounting[field]) || accounting[field] < 0) {
        return `accounting-${field}-unknown`;
      }
    }
  }
  return null;
}

function buildRunCandidate(
  runtime,
  paths,
  evidence,
  judge,
  artifactByPath,
  priorByRegistration,
  selectionInfo,
) {
  const { registration, terminal, classification, accounting, preDispatch } =
    evidence;
  const identityRel = join(
    relative(paths.trialRoot, registration.runDir),
    "worktree-identity.json",
  );
  const identity = readReceipt(
    join(paths.trialRoot, identityRel),
    "Gate2702WorktreeIdentity",
    "worktree identity",
  );
  const startedAt = preDispatch?.startedAt ?? terminal.endedAt;
  let createdAt =
    preflightFor(paths, registration).behaviorContext?.observedAt ??
    identity.createdAt ??
    startedAt;
  const checkResults = buildCheckResults(
    paths,
    evidence,
    artifactByPath,
    startedAt,
  );
  const finishedAt = latestTimestamp([
    terminal.endedAt,
    startedAt,
    ...checkResults.map((entry) => entry.finishedAt),
  ]);
  const parent =
    registration.attempt === 2
      ? priorByRegistration.get(registration.retryOf?.registrationDigest)
      : null;
  if (registration.attempt === 2 && !parent) {
    return { exclusion: "retry-parent-not-canonical" };
  }
  if (parent && Date.parse(createdAt) <= Date.parse(parent.finishedAt)) {
    const adjusted = new Date(Date.parse(parent.finishedAt) + 1).toISOString();
    if (Date.parse(adjusted) > Date.parse(startedAt)) {
      return { exclusion: "retry-timing-does-not-follow-parent" };
    }
    createdAt = adjusted;
  }
  const exclusion = candidateExclusion(evidence, judge, selectionInfo);
  if (exclusion) return { exclusion };
  const runId = deterministicUuid(
    `gate-2702-run\0${registration.trialId}\0${registration.contentDigest}`,
  );
  const { fingerprint, binding: selectionBinding, planSlotId } = selectionInfo;
  const snapshotRel = join("subjects", `issue-${registration.subject}.json`);
  const snapshotEntry = objectForPath(artifactByPath, snapshotRel);
  const terminalRel = relative(
    paths.trialRoot,
    join(registration.runDir, "terminal.json"),
  );
  const classificationRel = relative(
    paths.trialRoot,
    join(registration.runDir, "classification.json"),
  );
  const accountingRel = relative(
    paths.trialRoot,
    join(registration.runDir, "accounting.json"),
  );
  const terminalEvidence = evidenceForPath(
    artifactByPath,
    terminalRel,
    registration.trialId,
  );
  const classificationEvidence = evidenceForPath(
    artifactByPath,
    classificationRel,
    registration.trialId,
  );
  const accountingEvidence = evidenceForPath(
    artifactByPath,
    accountingRel,
    registration.trialId,
  );
  const judgeRel = judge
    ? join("judging", `issue-${registration.subject}`, "result.json")
    : null;
  const judgeEvidence = judgeRel
    ? evidenceForPath(artifactByPath, judgeRel, registration.trialId)
    : [];
  const wallTimeMs = Math.min(
    runtime.plan.limits.wallTimeMs,
    Math.max(0, Math.ceil(terminal.durationMs ?? 0)),
  );
  const observations = [];
  if (classification.status === "succeeded") {
    const bothObjectiveFailed = TREATMENTS.every(
      (treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "failed",
    );
    const qualityLoss = bothObjectiveFailed
      ? 1
      : TREATMENTS.includes(judge.effectiveWinner) &&
          judge.effectiveWinner !== registration.treatmentId
        ? 1
        : 0;
    const attributableShips =
      registration.treatmentId === "haiku-sonnet-sidekick" &&
      judge.effectiveWinner === "haiku-sonnet-sidekick" &&
      accounting.sidekickShippedInterventionCount > 0
        ? 1
        : 0;
    observations.push(
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-all-in-cost",
        accounting.allInCostUsd,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-wall-time",
        wallTimeMs,
        finishedAt,
        terminalEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-quality-loss",
        qualityLoss,
        finishedAt,
        judgeEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-triggers",
        accounting.sidekickTriggerCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-paid-calls",
        accounting.sidekickPaidCallCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-shipped-interventions",
        accounting.sidekickShippedInterventionCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-attributable-ships",
        attributableShips,
        finishedAt,
        [...judgeEvidence, ...accountingEvidence],
      ),
    );
  }
  const result = workerResult(accounting, registration.runDir);
  const sessionId = result.session_id;
  const run = {
    schemaVersion: 1,
    kind: "ExperimentRun",
    runId,
    trialId: registration.trialId,
    contentDigest: `sha256:${"0".repeat(64)}`,
    definitionRef: registration.definitionRef,
    treatmentId: registration.treatmentId,
    retryOf: parent
      ? { runId: parent.runId, contentDigest: parent.contentDigest }
      : null,
    status: classification.status,
    createdAt,
    startedAt,
    finishedAt,
    subjectRef: {
      harness: "claude-code",
      sourceId: `github:${REPOSITORY}`,
      artifactId: `github:${REPOSITORY}/issues/${registration.subject}`,
      contentDigest: snapshotEntry.contentDigest,
      mediaType: "application/json",
    },
    assignment: { kind: "explicit" },
    selectedHarness: "claude-code",
    harnessProvenance: {
      origin: "claude-code",
      driver: "claude-code",
      worker: "claude-code",
      judge: "claude-code",
    },
    selectionRef: {
      receiptId: selectionBinding.receiptId,
      receiptDigest: selectionBinding.receiptDigest,
      planSlotId,
    },
    triggerRef: null,
    behaviorFingerprint: fingerprint,
    capabilitySnapshot: runtime.definition.requiredCapabilities.map(
      (entry) => ({
        semanticsRef: entry.semanticsRef,
        state: "available",
        observedAt: fingerprint.observedAt,
      }),
    ),
    effectiveLimits: { ...runtime.definition.limits },
    safeguardAuthorizations: [],
    sessionRef: {
      harness: "claude-code",
      sourceId: "local-gate-2702",
      sessionId,
    },
    observations,
    checkResults,
    usage: { wallTimeMs, costUsd: accounting.allInCostUsd },
    error:
      classification.status === "succeeded"
        ? null
        : {
            code: `gate-2702/${String(classification.error?.code ?? classification.status).replace(/[^a-z0-9._-]/g, "-")}`,
            message: String(
              classification.error?.message ?? `C5 ${classification.status}`,
            ).slice(0, 4096),
            evidenceRefs: classificationEvidence,
          },
    extensions: {
      "gate-2702/registrationDigest": registration.contentDigest,
      "gate-2702/classificationDigest": classification.contentDigest,
      "gate-2702/accountingDigest": accounting.contentDigest,
      "gate-2702/judgeResultDigest": judge?.contentDigest ?? null,
      "gate-2702/actualWallTimeMs": terminal.durationMs ?? null,
    },
  };
  const digested = runtime.contracts.withDocumentDigest(run);
  const decoded = runtime.contracts.decodeRunV1(digested, {
    definition: runtime.definition,
    registry: runtime.registry,
    selectionReceipts: [selectionBinding],
    triggerReceipts: [],
    operatorSafeguardAuthorizations: [],
    priorRuns: [...priorByRegistration.values()],
  });
  if (!decoded.ok) {
    fail(
      `canonical Run ${runId} failed strict v1 decoding: ${JSON.stringify(decoded.issues)}`,
    );
  }
  return { run: decoded.value, selectionBinding };
}

function addObject(
  objectMap,
  sourcePath,
  bytes,
  mediaType = "application/octet-stream",
) {
  const contentDigest = sha256Bytes(bytes);
  const existing = objectMap.objects.get(contentDigest);
  if (existing && !existing.equals(bytes))
    fail(`SHA-256 collision while storing ${sourcePath}`);
  objectMap.objects.set(contentDigest, bytes);
  const entry = {
    sourcePath,
    contentDigest,
    sizeBytes: bytes.length,
    mediaType,
    objectName: contentDigest.replace(":", "-"),
  };
  objectMap.artifacts.push(entry);
  objectMap.byPath.set(sourcePath, entry);
  return entry;
}

function collectExternalAccountingObjects(objectMap, armEvidence) {
  for (const evidence of armEvidence) {
    const source = evidence.accounting.sourceEvidence?.sidekick;
    if (
      source?.source !== "sidekick-session-ledger" ||
      source.status !== "settled"
    )
      continue;
    const sessionId = evidence.accounting.workerSessionId;
    if (
      !UUID_PATTERN.test(sessionId ?? "") ||
      typeof source.relativePath !== "string"
    ) {
      fail("settled Sidekick accounting lacks an exact session path");
    }
    let root = resolve(process.env.HOME || homedir(), ".sidekick");
    if (evidence.preDispatch?.sandbox?.isolatedHome !== undefined) {
      const expectedHome = resolve(
        evidence.registration.runDir,
        "sandbox",
        "home",
      );
      if (resolve(evidence.preDispatch.sandbox.isolatedHome) !== expectedHome) {
        fail("sandbox Sidekick root is not bound to the registered run");
      }
      root = join(expectedHome, ".sidekick");
    }
    const path = resolve(root, source.relativePath);
    if (!isWithin(root, path))
      fail("Sidekick ledger path escapes its fixed root");
    const bytes = readRegularBytes(path, 4 * 1024 * 1024, "Sidekick ledger");
    if (
      bytes.length !== source.byteLength ||
      sha256Bytes(bytes) !== source.contentDigest
    ) {
      fail("Sidekick ledger bytes no longer match accounting evidence");
    }
    addObject(
      objectMap,
      `external/sidekick/${sessionId}/__sidekick.jsonl`,
      bytes,
      "application/x-ndjson",
    );
  }
}

function maybeCrash(stage) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.CHD_EXPERIMENT_2702_SEAL_TEST_CRASH_STAGE === stage
  ) {
    process.exit(86);
  }
}

function sortedRunEvidence(armEvidence) {
  return [...armEvidence].sort(
    (left, right) =>
      left.registration.attempt - right.registration.attempt ||
      left.registration.subject - right.registration.subject ||
      left.registration.treatmentId.localeCompare(
        right.registration.treatmentId,
      ),
  );
}

function parseArtifactJson(objectBytes, entry, expectedKind) {
  if (!entry) fail("sealed JSON artifact is missing");
  let value;
  try {
    value = JSON.parse(objectBytes.get(entry.contentDigest).toString("utf8"));
  } catch {
    fail(`sealed JSON artifact is malformed: ${entry.sourcePath}`);
  }
  return expectedKind
    ? verifyReceipt(value, expectedKind, entry.sourcePath)
    : value;
}

function verifySealedTrialSet(runtime, marker, manifest, objectBytes, byPath) {
  const trial = parseArtifactJson(
    objectBytes,
    byPath.get("trial.json"),
    "Gate2702Trial",
  );
  // A post-seal consumer may see the immutable tree through a different bind
  // mount. Recorded absolute paths remain launcher provenance: validate their
  // relationships against the recorded root, not the consumer mount path.
  const recordedPaths =
    typeof trial.stateRoot === "string" && isAbsolute(trial.stateRoot)
      ? trialPaths({ stateRoot: trial.stateRoot, trial: trial.trialId })
      : null;
  if (
    trial.contentDigest !== marker.trialDigest ||
    trial.contentDigest !== manifest.trialDigest ||
    trial.trialId !== marker.trialId ||
    trial.baseSha !== marker.baseSha ||
    !sameValue(trial.definitionRef, runtime.plan.definitionRef) ||
    !sameValue(trial.definitionRef, DEFINITION_REF) ||
    trial.repository !== REPOSITORY ||
    trial.executionMode !== "production" ||
    recordedPaths === null ||
    typeof trial.worktreeRoot !== "string" ||
    !isAbsolute(trial.worktreeRoot) ||
    resolve(trial.worktreeRoot) !==
      resolve(join(recordedPaths.trialRoot, "worktrees")) ||
    !Array.isArray(trial.registrations) ||
    trial.registrations.length !== SUBJECTS.length * TREATMENTS.length ||
    !Array.isArray(trial.subjectSnapshots) ||
    trial.subjectSnapshots.length !== SUBJECTS.length
  ) {
    fail("sealed trial is not the exact production C5 launcher manifest");
  }

  const baseRegistrations = [];
  for (const subject of SUBJECTS) {
    const snapshots = trial.subjectSnapshots.filter(
      (entry) => entry.subject === subject,
    );
    const snapshot = parseArtifactJson(
      objectBytes,
      byPath.get(`subjects/issue-${subject}.json`),
      "Gate2702SubjectSnapshot",
    );
    if (
      snapshots.length !== 1 ||
      snapshots[0].contentDigest !== snapshot.contentDigest ||
      snapshot.executionMode !== "production" ||
      snapshot.trialId !== trial.trialId ||
      snapshot.subject !== subject ||
      snapshot.baseSha !== trial.baseSha ||
      !sameValue(snapshot.definitionRef, DEFINITION_REF)
    ) {
      fail(`sealed subject snapshot #${subject} is not launcher-bound`);
    }
    const pairPreflight = parseArtifactJson(
      objectBytes,
      byPath.get(`preflight/issue-${subject}.json`),
      "Gate2702PairPreflight",
    );
    if (
      pairPreflight.trialId !== trial.trialId ||
      pairPreflight.subject !== subject ||
      pairPreflight.baseSha !== trial.baseSha ||
      !sameValue(pairPreflight.definitionRef, DEFINITION_REF)
    ) {
      fail(`sealed pair preflight #${subject} has the wrong trial identity`);
    }
    for (const treatmentId of TREATMENTS) {
      const embedded = trial.registrations.filter(
        (entry) =>
          entry.subject === subject && entry.treatmentId === treatmentId,
      );
      const prefix = `runs/issue-${subject}/${treatmentId}/attempt-1`;
      const registration = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/registration.json`),
        "Gate2702ArmRegistration",
      );
      if (
        embedded.length !== 1 ||
        !sameValue(registration, embedded[0]) ||
        registration.attempt !== 1 ||
        registration.executionMode !== "production" ||
        registration.trialId !== trial.trialId ||
        registration.baseSha !== trial.baseSha ||
        typeof registration.runDir !== "string" ||
        !isAbsolute(registration.runDir) ||
        resolve(registration.runDir) !==
          resolve(runDirectory(recordedPaths, subject, treatmentId, 1)) ||
        !isWithin(trial.worktreeRoot, registration.worktreePath)
      ) {
        fail(
          `sealed attempt-1 registration drifted for #${subject}/${treatmentId}`,
        );
      }
      const preflightArm = pairPreflight.arms?.[treatmentId];
      if (
        preflightArm?.treatmentId !== treatmentId ||
        preflightArm?.attempt !== 1 ||
        preflightArm?.registrationDigest !== registration.contentDigest ||
        resolve(preflightArm?.worktreePath ?? "") !==
          resolve(registration.worktreePath)
      ) {
        fail(
          `sealed pair preflight is not bound to #${subject}/${treatmentId}`,
        );
      }
      baseRegistrations.push(registration);
    }
  }
  const worktreeManifest = baseRegistrations.map((registration) => ({
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    worktreePath: registration.worktreePath,
    registrationDigest: registration.contentDigest,
  }));
  if (
    valueDigest(worktreeManifest) !== trial.worktreeManifestDigest ||
    trial.worktreeManifestDigest !== marker.worktreeManifestDigest ||
    trial.worktreeManifestDigest !== manifest.worktreeManifestDigest
  ) {
    fail("sealed worktree manifest does not rederive from its registrations");
  }

  const retryRegistrations = manifest.runCandidates
    .filter((candidate) => candidate.attempt === 2)
    .map((candidate) => {
      const registration = parseArtifactJson(
        objectBytes,
        byPath.get(
          `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-2/registration.json`,
        ),
        "Gate2702ArmRegistration",
      );
      if (
        typeof registration.runDir !== "string" ||
        !isAbsolute(registration.runDir) ||
        resolve(registration.runDir) !==
          resolve(
            runDirectory(
              recordedPaths,
              candidate.subject,
              candidate.treatmentId,
              2,
            ),
          ) ||
        !isWithin(trial.worktreeRoot, registration.worktreePath)
      ) {
        fail(
          `sealed retry registration drifted for #${candidate.subject}/${candidate.treatmentId}`,
        );
      }
      return registration;
    });
  const retryPaths = [...byPath.keys()].filter((path) =>
    path.startsWith("retries/sets/"),
  );
  if (marker.retryRegistrationSetDigest === undefined) {
    if (
      manifest.retryRegistrationSetDigest !== null ||
      retryRegistrations.length !== 0 ||
      retryPaths.length !== 0
    ) {
      fail("sealed trial has an unbound retry registration set");
    }
  } else {
    const retryManifest = retryRegistrationManifest(retryRegistrations);
    const registrationSetDigest = valueDigest(retryManifest);
    const expectedPath = `retries/sets/${registrationSetDigest.replace(":", "-")}.json`;
    const retrySet = parseArtifactJson(
      objectBytes,
      byPath.get(expectedPath),
      "Gate2702RetryRegistrationSet",
    );
    if (
      retryPaths.length !== 1 ||
      retryPaths[0] !== expectedPath ||
      registrationSetDigest !== marker.retryRegistrationSetDigest ||
      registrationSetDigest !== manifest.retryRegistrationSetDigest ||
      retrySet.registrationSetDigest !== registrationSetDigest ||
      retrySet.trialId !== trial.trialId ||
      retrySet.baseSha !== trial.baseSha ||
      !sameValue(retrySet.definitionRef, DEFINITION_REF) ||
      !sameValue(retrySet.registrations, retryManifest)
    ) {
      fail("sealed retry registration set does not rederive exactly");
    }
  }
  const expectedCandidates = [...baseRegistrations, ...retryRegistrations]
    .map((registration) => ({
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: registration.attempt,
      registrationDigest: registration.contentDigest,
    }))
    .sort(
      (left, right) =>
        left.attempt - right.attempt ||
        left.subject - right.subject ||
        left.treatmentId.localeCompare(right.treatmentId),
    );
  const actualCandidates = manifest.runCandidates
    .map((candidate) => ({
      subject: candidate.subject,
      treatmentId: candidate.treatmentId,
      attempt: candidate.attempt,
      registrationDigest: candidate.registrationDigest,
    }))
    .sort(
      (left, right) =>
        left.attempt - right.attempt ||
        left.subject - right.subject ||
        left.treatmentId.localeCompare(right.treatmentId),
    );
  if (!sameValue(actualCandidates, expectedCandidates)) {
    fail("seal manifest does not cover the exact base and retry arm set");
  }
  return trial;
}

function verifyArtifactCoverage(manifest, objectBytes, byPath) {
  const required = new Set([
    "trial.json",
    "generated/definition.json",
    "generated/registry.json",
  ]);
  for (const subject of SUBJECTS) {
    required.add(`subjects/issue-${subject}.json`);
    required.add(`preflight/issue-${subject}.json`);
  }
  for (const candidate of manifest.runCandidates) {
    const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
    const installPrefix = `${prefix}/preflight-install`;
    for (const name of [
      "pre-dispatch.json",
      "stdout.log",
      "stderr.log",
      "execution.json",
    ]) {
      required.add(`${installPrefix}/${name}`);
    }
    const installExecution = parseArtifactJson(
      objectBytes,
      byPath.get(`${installPrefix}/execution.json`),
      "Gate2702InstallExecution",
    );
    if (installExecution.processDigest !== undefined) {
      required.add(`${installPrefix}/process.json`);
      required.add(`${installPrefix}/dispatch-gate`);
    }
    if (
      installExecution.interrupted === false &&
      installExecution.error === undefined
    ) {
      required.add(`${installPrefix}/outcome.json`);
    }
    for (const name of [
      "registration.json",
      "worktree-identity.json",
      "stdout.log",
      "stderr.log",
      "terminal.json",
      "classification.json",
      "accounting.json",
    ]) {
      required.add(`${prefix}/${name}`);
    }
    required.add(
      `generated/diffs/issue-${candidate.subject}.${candidate.treatmentId}.attempt-${candidate.attempt}.json`,
    );
    const terminal = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/terminal.json`),
      "Gate2702Terminal",
    );
    if (terminal.outcome !== "preflight-failed") {
      required.add(`${prefix}/pre-dispatch.json`);
      const preDispatch = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/pre-dispatch.json`),
        "Gate2702PreDispatch",
      );
      if (preDispatch.sandbox !== undefined) {
        required.add(`${prefix}/sandbox/settings.json`);
      }
    }
    if (candidate.attempt === 2) required.add(`${prefix}/preflight.json`);
    if (["exited", "timed-out"].includes(terminal.outcome)) {
      required.add(`${prefix}/process.json`);
    }
    const classification = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/classification.json`),
      "Gate2702ArmClassification",
    );
    for (const check of classification.checkResults ?? []) {
      const checkPrefix = `${prefix}/checks/${check.checkId.replaceAll("/", "_")}`;
      for (const suffix of [
        ".json",
        ".pre-dispatch.json",
        ".stdout.log",
        ".stderr.log",
      ]) {
        required.add(`${checkPrefix}${suffix}`);
      }
      const execution = parseArtifactJson(
        objectBytes,
        byPath.get(`${checkPrefix}.json`),
        "Gate2702CheckExecution",
      );
      if (execution.processDigest !== undefined) {
        required.add(`${checkPrefix}.process.json`);
        required.add(`${checkPrefix}.dispatch-gate`);
      }
      if (
        execution.timedOut === false &&
        execution.spawnError === undefined &&
        execution.exitCode !== null
      ) {
        required.add(`${checkPrefix}.outcome.json`);
      }
    }
    const accounting = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/accounting.json`),
      "Gate2702Accounting",
    );
    if (accounting.sourceEvidence?.sidekick?.status === "settled") {
      required.add(
        `external/sidekick/${accounting.workerSessionId}/__sidekick.jsonl`,
      );
    }
  }
  for (const run of manifest.canonicalRuns) required.add(run.sourcePath);
  for (const judge of manifest.judgeResults) {
    const prefix = `judging/issue-${judge.subject}`;
    required.add(`pair-selection/issue-${judge.subject}.json`);
    for (const name of [
      "input.json",
      "requests.json",
      "result.json",
      "evidence/haiku-solo.json",
      "evidence/haiku-sonnet-sidekick.json",
    ]) {
      required.add(`${prefix}/${name}`);
    }
    const result = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/result.json`),
      "Gate2702JudgeResult",
    );
    for (const order of ["forward", "swapped"]) {
      for (const reference of result.attempts?.[order] ?? []) {
        const attemptPrefix = `${prefix}/${order}/attempt-${reference.attempt}`;
        required.add(`${attemptPrefix}.json`);
        required.add(`${attemptPrefix}.pre-dispatch.json`);
        required.add(`${attemptPrefix}.outcome.json`);
        for (const optional of [".process.json", ".gate.json"]) {
          if (byPath.has(`${attemptPrefix}${optional}`)) {
            required.add(`${attemptPrefix}${optional}`);
          }
        }
      }
    }
  }
  for (const path of byPath.keys()) {
    const knownOperationalPath =
      path === "supervisor.log" ||
      SIDEKICK_SNAPSHOT_PATH_RE.test(path) ||
      /^runs\/issue-[0-9]+\/(?:haiku-solo|haiku-sonnet-sidekick)\/attempt-[12]\/sandbox\/settings\.json$/.test(
        path,
      ) ||
      /^retries\/sets\/sha256-[0-9a-f]{64}\.json$/.test(path) ||
      /^runs\/issue-[0-9]+\/(?:haiku-solo|haiku-sonnet-sidekick)\/attempt-[12]\/(?:preflight\.json|preflight-install\/(?:pre-dispatch\.json|process\.json|dispatch-gate|outcome\.json|stdout\.log|stderr\.log|execution\.json)|checks\/checks_gate-2702-(?:vitest|typecheck)(?:\.pre-dispatch\.json|\.process\.json|\.dispatch-gate|\.outcome\.json|\.stdout\.log|\.stderr\.log))$/.test(
        path,
      );
    if (!required.has(path) && !knownOperationalPath) {
      fail(`seal bundle contains unknown artifact path: ${path}`);
    }
  }
  for (const path of required) {
    if (!byPath.has(path)) {
      fail(`seal bundle omits required artifact path: ${path}`);
    }
  }
}

function sealedPreflightFor(objectBytes, byPath, registration) {
  if (registration.attempt === 1) {
    const receipt = parseArtifactJson(
      objectBytes,
      byPath.get(`preflight/issue-${registration.subject}.json`),
      "Gate2702PairPreflight",
    );
    return {
      receipt,
      arm: receipt.arms?.[registration.treatmentId],
      behaviorContext:
        receipt.arms?.[registration.treatmentId]?.behaviorContext ?? null,
      environmentDigest:
        receipt.arms?.[registration.treatmentId]?.environmentDigest,
      environment: receipt.arms?.[registration.treatmentId]?.environment,
    };
  }
  const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-2`;
  const receipt = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/preflight.json`),
    "Gate2702RetryPreflight",
  );
  return {
    receipt,
    arm: receipt,
    behaviorContext: receipt.behaviorContext ?? null,
    environmentDigest: receipt.environmentDigest,
    environment: receipt.environment,
  };
}

function buildSealedSelectionGroups(runtime, manifest, objectBytes, byPath) {
  const evidence = manifest.runCandidates.map((candidate) => {
    const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
    return {
      registration: parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/registration.json`),
        "Gate2702ArmRegistration",
      ),
      terminal: parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/terminal.json`),
        "Gate2702Terminal",
      ),
      classification: parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/classification.json`),
        "Gate2702ArmClassification",
      ),
      accounting: parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/accounting.json`),
        "Gate2702Accounting",
      ),
      preDispatch: byPath.has(`${prefix}/pre-dispatch.json`)
        ? parseArtifactJson(
            objectBytes,
            byPath.get(`${prefix}/pre-dispatch.json`),
            "Gate2702PreDispatch",
          )
        : null,
    };
  });
  const byRegistration = new Map();
  const bindings = [];
  for (const treatmentId of TREATMENTS) {
    for (const attempt of [1, 2]) {
      const members = evidence.filter(
        (entry) =>
          entry.registration.treatmentId === treatmentId &&
          entry.registration.attempt === attempt,
      );
      if (members.length === 0) continue;
      const complete = [];
      for (const entry of members) {
        const startedAt =
          entry.preDispatch?.startedAt ?? entry.terminal.endedAt;
        const fingerprint = buildFingerprint(
          runtime,
          null,
          entry,
          startedAt,
          sealedPreflightFor(objectBytes, byPath, entry.registration),
        );
        if (fingerprint.completeness === "complete") {
          complete.push({ evidence: entry, fingerprint });
        }
      }
      if (complete.length === 0) continue;
      const first = complete[0].fingerprint;
      if (
        complete.some(
          ({ fingerprint }) =>
            !sameValue(
              fingerprintWithoutObservation(fingerprint),
              fingerprintWithoutObservation(first),
            ),
        )
      ) {
        fail("sealed C5 behavior factors drift across registered subjects");
      }
      const observedAt = complete
        .map(({ fingerprint }) => fingerprint.observedAt)
        .sort()[0];
      const fingerprint = runtime.contracts.withBehaviorFingerprintDigest({
        ...first,
        observedAt,
      });
      const planSlots =
        attempt === 1
          ? SUBJECTS.map((subject) => ({
              planSlotId: `issue-${subject}.${treatmentId}`,
              kind: "treatment-run",
              treatmentId,
            }))
          : complete.map(({ evidence: entry }) => ({
              planSlotId: `issue-${entry.registration.subject}.${treatmentId}.retry-2`,
              kind: "treatment-run",
              treatmentId,
            }));
      const binding = selectionBindingFor({
        runtime,
        trialId: complete[0].evidence.registration.trialId,
        treatmentId,
        fingerprint,
        planSlots,
        receiptKind: attempt === 1 ? "base" : "retry-2",
      });
      bindings.push(binding);
      for (const { evidence: entry } of complete) {
        byRegistration.set(entry.registration.contentDigest, {
          fingerprint,
          binding,
          planSlotId:
            attempt === 1
              ? `issue-${entry.registration.subject}.${treatmentId}`
              : `issue-${entry.registration.subject}.${treatmentId}.retry-2`,
        });
      }
    }
  }
  if (!sameValue(manifest.selectionBindings, bindings)) {
    fail("sealed selection bindings do not rederive from behavior evidence");
  }
  return { byRegistration, evidence };
}

function sealedCandidateExclusion(evidence, judge, selectionInfo, workerBytes) {
  const { accounting, classification, terminal } = evidence;
  if (!selectionInfo) return "complete-behavior-fingerprint-unavailable";
  if (classification.error?.code === "behavior-context-drift") {
    return "behavior-context-drift";
  }
  let result = null;
  try {
    result = JSON.parse(workerBytes.toString("utf8"));
  } catch {
    // The candidate is deterministically excluded below.
  }
  if (!UUID_PATTERN.test(result?.session_id ?? "")) {
    return "worker-session-id-unknown";
  }
  if (
    accounting.bridgeEvidenceStatus !== "eligible" ||
    typeof accounting.allInCostUsd !== "number" ||
    !Number.isFinite(accounting.allInCostUsd) ||
    accounting.allInCostUsd < 0
  ) {
    return `unknown-all-in-cost:${(accounting.exclusionReasons ?? []).join(",") || "unspecified"}`;
  }
  if (accounting.allInCostUsd > 18) {
    return "all-in-cost-exceeds-definition-limit";
  }
  if (classification.status === "succeeded") {
    if (!judge) return "selected-pair-judge-unavailable";
    if (
      judge.effectiveWinner === null &&
      TREATMENTS.every(
        (treatmentId) =>
          judge.objectiveChecks?.[treatmentId]?.state === "passed",
      )
    ) {
      return "judge-quality-not-evaluable";
    }
    if (
      typeof terminal.durationMs !== "number" ||
      !Number.isFinite(terminal.durationMs) ||
      terminal.durationMs < 0
    ) {
      return "worker-wall-time-unknown";
    }
    for (const field of [
      "sidekickTriggerCount",
      "sidekickPaidCallCount",
      "sidekickShippedInterventionCount",
    ]) {
      if (!Number.isSafeInteger(accounting[field]) || accounting[field] < 0) {
        return `accounting-${field}-unknown`;
      }
    }
  }
  return null;
}

function sealedSidekickSnapshotDigest(objectBytes, byPath) {
  const prefix = SIDEKICK_SNAPSHOT_PREFIX;
  const entries = [...byPath.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, entry]) => ({
      relativePath: path.slice(prefix.length),
      bytes: objectBytes.get(entry.contentDigest),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (
    entries.length === 0 ||
    entries.some(
      ({ relativePath, bytes }) =>
        !(
          relativePath.startsWith(".claude-plugin/") ||
          relativePath.startsWith("hooks/") ||
          relativePath.startsWith("scripts/")
        ) || !Buffer.isBuffer(bytes),
    )
  ) {
    fail("sealed Sidekick snapshot is missing or outside its fixed roots");
  }
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertSealedSandboxDispatch({
  preDispatch,
  registration,
  identityReceipt,
  terminal,
  prefix,
  objectBytes,
  byPath,
  expectedArgv,
}) {
  const sandbox = assertGate2702SandboxPreDispatch({
    preDispatch,
    registration,
    worktreeIdentity: identityReceipt,
  });
  const settings = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/sandbox/settings.json`),
  );
  const recordedTrialRoot = resolve(registration.runDir, "../../../..");
  const expectedSidekickPath = join(
    recordedTrialRoot,
    "sandbox-runtime",
    SIDEKICK_SNAPSHOT_DIRECTORY,
  );
  const expectedWorkerArgv = [
    sandbox.workerArgv[0],
    ...expectedArgv.slice(1),
    "--plugin-dir",
    expectedSidekickPath,
  ];
  if (
    !sameValue(settings, sandbox.policy) ||
    !isAbsolute(sandbox.workerArgv[0]) ||
    !sandbox.allowedReadRoots.includes(resolve(sandbox.workerArgv[0])) ||
    !sameValue(sandbox.workerArgv, expectedWorkerArgv) ||
    sandbox.sidekickSnapshot?.path !== expectedSidekickPath ||
    sandbox.sidekickSnapshot?.contentDigest !==
      sealedSidekickSnapshotDigest(objectBytes, byPath)
  ) {
    fail("sealed worker sandbox does not rederive from retained policy inputs");
  }
  for (const [name, evidence] of [
    ["stdout.log", terminal.stdout],
    ["stderr.log", terminal.stderr],
  ]) {
    const entry = byPath.get(`${prefix}/${name}`);
    const bytes = entry && objectBytes.get(entry.contentDigest);
    if (
      !Buffer.isBuffer(bytes) ||
      evidence?.byteLength !== bytes.length ||
      evidence?.contentDigest !== sha256Bytes(bytes)
    ) {
      fail("sealed worker terminal does not bind its retained logs");
    }
  }
}

function verifySealedArmsAndLiveDiffs(runtime, manifest, objectBytes, byPath) {
  if (
    !Number.isSafeInteger(manifest.registrationCount) ||
    manifest.registrationCount < 12 ||
    !Array.isArray(manifest.runCandidates) ||
    manifest.runCandidates.length !== manifest.registrationCount
  ) {
    fail("seal manifest does not cover its exact registration count");
  }
  const identities = manifest.runCandidates.map(
    (candidate) =>
      `${candidate.subject}/${candidate.treatmentId}/${candidate.attempt}`,
  );
  if (new Set(identities).size !== identities.length) {
    fail("seal manifest repeats an arm registration");
  }
  const selectionGroups = buildSealedSelectionGroups(
    runtime,
    manifest,
    objectBytes,
    byPath,
  );
  const trialBounds = { rawBytes: 0, artifactCount: 0 };
  const expectedCanonicalRegistrations = new Set();
  for (const candidate of manifest.runCandidates) {
    const identity = `${candidate.subject}/${candidate.treatmentId}/${candidate.attempt}`;
    if (
      !SUBJECTS.includes(candidate.subject) ||
      !TREATMENTS.includes(candidate.treatmentId) ||
      ![1, 2].includes(candidate.attempt)
    ) {
      fail("seal manifest contains an unknown C5 arm");
    }
    const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
    const registration = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/registration.json`),
      "Gate2702ArmRegistration",
    );
    const terminal = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/terminal.json`),
      "Gate2702Terminal",
    );
    const classification = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/classification.json`),
      "Gate2702ArmClassification",
    );
    const accounting = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/accounting.json`),
      "Gate2702Accounting",
    );
    assertArmIdentity(terminal, registration, "sealed terminal");
    assertArmIdentity(classification, registration, "sealed classification");
    assertArmIdentity(accounting, registration, "sealed accounting");
    if (
      registration.subject !== candidate.subject ||
      registration.treatmentId !== candidate.treatmentId ||
      registration.attempt !== candidate.attempt ||
      registration.contentDigest !== candidate.registrationDigest ||
      classification.registrationDigest !== registration.contentDigest ||
      classification.terminalDigest !== terminal.contentDigest ||
      classification.status !== candidate.status ||
      classification.contentDigest !== candidate.classificationDigest ||
      accounting.registrationDigest !== registration.contentDigest ||
      accounting.terminalDigest !== terminal.contentDigest ||
      accounting.classificationDigest !== classification.contentDigest ||
      accounting.contentDigest !== candidate.accountingDigest
    ) {
      fail("sealed arm receipts do not retain their exact lineage");
    }
    const identityReceipt = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/worktree-identity.json`),
      "Gate2702WorktreeIdentity",
    );
    assertArmIdentity(
      identityReceipt,
      registration,
      "sealed worktree identity",
    );
    if (
      identityReceipt.executionMode !== "production" ||
      resolve(identityReceipt.worktreePath) !==
        resolve(registration.worktreePath)
    ) {
      fail("sealed worktree identity is not production registration-bound");
    }
    if (terminal.outcome === "preflight-failed") {
      if (
        byPath.has(`${prefix}/pre-dispatch.json`) ||
        byPath.has(`${prefix}/process.json`) ||
        terminal.preDispatchDigest !== undefined ||
        terminal.processDigest !== undefined
      ) {
        fail(
          "sealed preflight failure unexpectedly has worker dispatch evidence",
        );
      }
    } else {
      const preDispatch = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/pre-dispatch.json`),
        "Gate2702PreDispatch",
      );
      assertArmIdentity(
        preDispatch,
        registration,
        "sealed worker pre-dispatch",
      );
      const expectedArgv = [
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
      if (
        preDispatch.executionMode !== "production" ||
        preDispatch.registrationDigest !== registration.contentDigest ||
        preDispatch.worktreeIdentityDigest !== identityReceipt.contentDigest ||
        resolve(preDispatch.cwd) !== resolve(registration.worktreePath) ||
        terminal.preDispatchDigest !== preDispatch.contentDigest
      ) {
        fail("sealed worker dispatch is not the fixed production invocation");
      }
      if (preDispatch.sandbox === undefined) {
        // Backward-compatible verification for bundles sealed before #3085.
        // New live bundles cannot enter this branch: production sealing above
        // requires the SRT attestation before publishing cleanup authority.
        if (!sameValue(preDispatch.argv, expectedArgv)) {
          fail("sealed worker dispatch is not the fixed production invocation");
        }
      } else {
        assertSealedSandboxDispatch({
          preDispatch,
          registration,
          identityReceipt,
          terminal,
          prefix,
          objectBytes,
          byPath,
          expectedArgv,
        });
      }
      if (["exited", "timed-out"].includes(terminal.outcome)) {
        const processReceipt = parseArtifactJson(
          objectBytes,
          byPath.get(`${prefix}/process.json`),
          "Gate2702Process",
        );
        assertArmIdentity(
          processReceipt,
          registration,
          "sealed worker process",
        );
        if (
          processReceipt.registrationDigest !== registration.contentDigest ||
          processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
          !Number.isSafeInteger(processReceipt.pid) ||
          processReceipt.pid <= 1 ||
          terminal.processDigest !== processReceipt.contentDigest
        ) {
          fail("sealed terminal does not bind its exact worker process");
        }
      } else if (
        terminal.outcome !== "spawn-error" ||
        byPath.has(`${prefix}/process.json`) ||
        terminal.processDigest !== undefined
      ) {
        fail("sealed worker terminal has an invalid process lineage");
      }
    }
    if (candidate.attempt === 2) {
      const retrySet = parseArtifactJson(
        objectBytes,
        byPath.get(
          `retries/sets/${manifest.retryRegistrationSetDigest.replace(":", "-")}.json`,
        ),
        "Gate2702RetryRegistrationSet",
      );
      const parent = manifest.runCandidates.find(
        (entry) =>
          entry.subject === candidate.subject &&
          entry.treatmentId === candidate.treatmentId &&
          entry.attempt === 1,
      );
      if (
        !parent ||
        registration.retryOf?.attempt !== 1 ||
        registration.retryOf?.registrationDigest !==
          parent.registrationDigest ||
        registration.retryOf?.classificationDigest !==
          parent.classificationDigest ||
        !sameValue(accounting.retryOf, registration.retryOf) ||
        accounting.retryRegistrationSetDigest !==
          manifest.retryRegistrationSetDigest ||
        accounting.retryRegistrationSetReceiptDigest !== retrySet.contentDigest
      ) {
        fail("sealed retry arm does not retain its exact attempt-1 lineage");
      }
    }
    for (const streamName of ["stdout", "stderr"]) {
      const streamEntry = byPath.get(`${prefix}/${streamName}.log`);
      const declared = classification.workerArtifacts?.[streamName];
      if (
        !streamEntry ||
        declared?.contentDigest !== streamEntry.contentDigest ||
        declared?.byteLength !== streamEntry.sizeBytes ||
        declared?.capturedBytes !==
          Math.min(streamEntry.sizeBytes, 2 * 1024 * 1024) ||
        declared?.truncated !== streamEntry.sizeBytes > 2 * 1024 * 1024
      ) {
        fail(
          "sealed classification is not bound to its retained worker output",
        );
      }
    }
    const workerSource = accounting.sourceEvidence?.worker;
    const stdoutEntry = byPath.get(`${prefix}/stdout.log`);
    if (
      !stdoutEntry ||
      workerSource?.contentDigest !== stdoutEntry.contentDigest ||
      workerSource?.byteLength !== stdoutEntry.sizeBytes
    ) {
      fail("sealed accounting is not bound to its retained worker output");
    }
    const numericCost = (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      !Object.is(value, -0);
    if (accounting.allInCostUsd !== null) {
      if (
        !numericCost(accounting.workerCostUsd) ||
        !numericCost(accounting.sidekickCostUsd) ||
        !numericCost(accounting.allInCostUsd)
      ) {
        fail("sealed accounting all-in cost does not rederive");
      }
      const expectedAllInCostUsd =
        candidate.treatmentId === "haiku-solo"
          ? accounting.workerCostUsd
          : normalizeGate2702Cost(
              accounting.workerCostUsd + accounting.sidekickCostUsd,
            );
      if (accounting.allInCostUsd !== expectedAllInCostUsd) {
        fail("sealed accounting all-in cost does not rederive");
      }
    }
    if (
      accounting.bridgeEvidenceStatus === "eligible" &&
      !numericCost(accounting.allInCostUsd)
    ) {
      fail("eligible sealed accounting has no finite all-in cost");
    }
    const sidekickSource = accounting.sourceEvidence?.sidekick;
    let ledgerEntry = null;
    if (sidekickSource?.source === "sidekick-session-ledger") {
      if (sidekickSource.status === "settled") {
        ledgerEntry = byPath.get(
          `external/sidekick/${accounting.workerSessionId}/__sidekick.jsonl`,
        );
        if (
          !ledgerEntry ||
          ledgerEntry.contentDigest !== sidekickSource.contentDigest ||
          ledgerEntry.sizeBytes !== sidekickSource.byteLength
        ) {
          fail(
            "sealed accounting is not bound to its retained Sidekick ledger",
          );
        }
      }
    } else if (
      sidekickSource?.source !== "fixed-disabled-treatment" ||
      sidekickSource.definitionDigest !== DEFINITION_DIGEST ||
      accounting.sidekickCostUsd !== 0 ||
      accounting.sidekickTriggerCount !== 0 ||
      accounting.sidekickPaidCallCount !== 0 ||
      accounting.sidekickShippedInterventionCount !== 0
    ) {
      fail("sealed control accounting does not rederive from the Definition");
    }
    validateGate2702AccountingEvidence({
      accounting,
      workerStdoutBytes: objectBytes.get(stdoutEntry.contentDigest),
      sidekickLedgerBytes: ledgerEntry
        ? objectBytes.get(ledgerEntry.contentDigest)
        : null,
      sidekickEnabled: registration.treatmentId === "haiku-sonnet-sidekick",
      definitionDigest: DEFINITION_DIGEST,
      sidekickModel: SIDEKICK_MODEL,
    });
    const judgeEntry = manifest.judgeResults.find(
      (entry) => entry.subject === registration.subject,
    );
    const judge = judgeEntry
      ? parseArtifactJson(
          objectBytes,
          byPath.get(`judging/issue-${registration.subject}/result.json`),
          "Gate2702JudgeResult",
        )
      : null;
    const expectedExclusion =
      registration.attempt === 2 &&
      !expectedCanonicalRegistrations.has(
        registration.retryOf?.registrationDigest,
      )
        ? "retry-parent-not-canonical"
        : sealedCandidateExclusion(
            { registration, terminal, classification, accounting },
            judge,
            selectionGroups.byRegistration.get(registration.contentDigest),
            objectBytes.get(stdoutEntry.contentDigest),
          );
    if ((candidate.exclusion ?? null) !== expectedExclusion) {
      fail(
        `sealed run candidate disposition does not rederive from evidence: ${identity} expected ${String(expectedExclusion)} but found ${String(candidate.exclusion ?? null)}`,
      );
    }
    if (expectedExclusion === null) {
      expectedCanonicalRegistrations.add(registration.contentDigest);
    }
    const diffPath = `generated/diffs/issue-${candidate.subject}.${candidate.treatmentId}.attempt-${candidate.attempt}.json`;
    const diffEntry = byPath.get(diffPath);
    if (!diffEntry || diffEntry.contentDigest !== candidate.diffObjectDigest) {
      fail("sealed arm points at the wrong worktree diff");
    }
    const frozen = parseArtifactJson(objectBytes, diffEntry);
    validateFrozenDiff(frozen, `sealed diff ${identity}`);
    if (
      frozen.registrationDigest !== registration.contentDigest ||
      frozen.trialId !== registration.trialId ||
      frozen.subject !== registration.subject ||
      frozen.treatmentId !== registration.treatmentId ||
      frozen.attempt !== registration.attempt ||
      frozen.baseSha !== registration.baseSha
    ) {
      fail("sealed worktree diff has the wrong arm identity");
    }
    const worktreeEvidenceBody = {
      baseSha: registration.baseSha,
      trackedPatch: {
        sizeBytes: frozen.trackedPatch.sizeBytes,
        contentDigest: frozen.trackedPatch.contentDigest,
      },
      untracked: frozen.untracked.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        sizeBytes: entry.sizeBytes,
        contentDigest: entry.contentDigest,
        encoding: entry.encoding,
      })),
      aggregateBytes:
        frozen.trackedPatch.sizeBytes +
        frozen.untracked.reduce((total, entry) => total + entry.sizeBytes, 0),
    };
    const expectedWorktreeEvidence = {
      ...worktreeEvidenceBody,
      contentDigest: valueDigest(worktreeEvidenceBody),
    };
    if (
      (classification.eligible === true &&
        classification.worktreeEvidence === undefined) ||
      (classification.worktreeEvidence !== undefined &&
        !sameValue(classification.worktreeEvidence, expectedWorktreeEvidence))
    ) {
      fail("sealed classification worktree evidence does not rederive");
    }
    if (existsSync(registration.worktreePath)) {
      const live = captureWorktreeDiff(registration, trialBounds);
      if (!sameValue(live, frozen)) {
        fail("registered worktree changed after evidence sealing");
      }
    }
  }
  return selectionGroups;
}

function judgeStreamBytes(stream, label, required) {
  if (stream === null || stream === undefined) {
    if (required) fail(`${label} is missing`);
    return Buffer.alloc(0);
  }
  const bytes = decodeBase64(stream.bytes, label);
  if (
    stream.encoding !== "base64" ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    !Number.isSafeInteger(stream.totalBytes) ||
    stream.capturedBytes < 0 ||
    stream.totalBytes < stream.capturedBytes ||
    stream.capturedBytes !== bytes.length ||
    stream.capturedBytes > JUDGE_MAX_STREAM_BYTES ||
    stream.truncated !== stream.totalBytes > stream.capturedBytes ||
    !DIGEST_PATTERN.test(stream.contentDigest ?? "") ||
    (!stream.truncated && stream.contentDigest !== sha256Bytes(bytes))
  ) {
    fail(`${label} has invalid retained bytes or bounds`);
  }
  return bytes;
}

function deriveJudgeAttempt(outcome) {
  if (outcome.spawnError)
    return {
      outcome: "failed",
      retryable: false,
      failureClass: "spawn-error",
      response: null,
      costUsd: null,
    };
  const stdout = judgeStreamBytes(outcome.stdout, "judge stdout", true);
  const stderr = judgeStreamBytes(outcome.stderr, "judge stderr", false);
  if (outcome.stdout?.truncated || outcome.stderr?.truncated) {
    return {
      outcome: "failed",
      retryable: false,
      failureClass: "output-truncated",
      response: null,
      costUsd: null,
    };
  }
  if (outcome.timedOut)
    return {
      outcome: "failed",
      retryable: true,
      failureClass: "timeout",
      response: null,
      costUsd: null,
    };
  if (outcome.exitCode !== 0 || outcome.signal) {
    const stdoutText = stdout.toString("utf8");
    const combined = `${stdoutText}\n${stderr.toString("utf8")}`;
    let costUsd = null;
    try {
      const wrapper = JSON.parse(stdoutText);
      costUsd =
        typeof wrapper.total_cost_usd === "number"
          ? wrapper.total_cost_usd
          : null;
    } catch {
      // Process failure remains structurally classified without prose inference.
    }
    return {
      outcome: "failed",
      retryable: false,
      failureClass: /budget|max[_ -]?budget/i.test(combined)
        ? "budget-exhausted"
        : "process-exit",
      response: null,
      costUsd,
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
    typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : null;
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
  let response = wrapper.structured_output ?? wrapper.structuredOutput;
  if (response === undefined && typeof wrapper.result === "string") {
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
  const dimensions = [
    "correctness",
    "design",
    "completeness",
    "clarity",
    "scopeFit",
    "autonomy",
  ];
  const validScores = (scores) =>
    scores &&
    sameValue(Object.keys(scores).sort(), [...dimensions].sort()) &&
    Object.values(scores).every(
      (score) => Number.isInteger(score) && score >= 1 && score <= 10,
    );
  const valid =
    response &&
    sameValue(Object.keys(response).sort(), [
      "rationale",
      "scores",
      "winner",
    ]) &&
    ["A", "B", "tie"].includes(response.winner) &&
    typeof response.rationale === "string" &&
    response.rationale.trim() &&
    response.rationale.length <= 4096 &&
    response.scores &&
    sameValue(Object.keys(response.scores).sort(), ["A", "B"]) &&
    validScores(response.scores.A) &&
    validScores(response.scores.B);
  return valid
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

function rederiveSealedJudge(manifest, objectBytes, subject) {
  const byPath = new Map(
    manifest.artifacts.map((entry) => [entry.sourcePath, entry]),
  );
  const prefix = `judging/issue-${subject}`;
  const input = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/input.json`),
    "Gate2702JudgeInput",
  );
  const requests = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/requests.json`),
    "Gate2702JudgeRequests",
  );
  const result = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/result.json`),
    "Gate2702JudgeResult",
  );
  for (const treatmentId of TREATMENTS) {
    const frozen = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/evidence/${treatmentId}.json`),
      "Gate2702JudgeArmEvidence",
    );
    const armPrefix = `runs/issue-${subject}/${treatmentId}/attempt-${frozen.attempt}`;
    const registration = parseArtifactJson(
      objectBytes,
      byPath.get(`${armPrefix}/registration.json`),
      "Gate2702ArmRegistration",
    );
    const classification = parseArtifactJson(
      objectBytes,
      byPath.get(`${armPrefix}/classification.json`),
      "Gate2702ArmClassification",
    );
    validateFrozenJudgeArm(
      frozen,
      registration,
      classification,
      input.pairSelectionDigest,
    );
    const objective = input.objectiveChecks?.[treatmentId];
    const objectiveState = classification.checkResults?.every(
      (check) => check.status === "passed",
    )
      ? "passed"
      : "failed";
    if (
      input.armEvidence?.[treatmentId] !== frozen.contentDigest ||
      input.artifacts?.[treatmentId] !== frozen.artifact ||
      objective?.classificationDigest !== classification.contentDigest ||
      !sameValue(objective?.results, classification.checkResults) ||
      objective?.state !== objectiveState
    ) {
      fail("sealed judge input does not rederive from frozen arm evidence");
    }
  }
  const terminalByOrder = {};
  for (const order of ["forward", "swapped"]) {
    const attemptRefs = result.attempts?.[order];
    if (
      !Array.isArray(attemptRefs) ||
      attemptRefs.length < 1 ||
      attemptRefs.length > 3
    ) {
      fail(`sealed judge ${subject}/${order} has an invalid attempt set`);
    }
    const attempts = attemptRefs.map((reference, index) => {
      if (reference.attempt !== index + 1)
        fail("sealed judge attempts contain a gap");
      const attempt = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/${order}/attempt-${index + 1}.json`),
        "Gate2702JudgeAttempt",
      );
      const outcome = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/${order}/attempt-${index + 1}.outcome.json`),
        "Gate2702JudgeOutcome",
      );
      const preDispatch = parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/${order}/attempt-${index + 1}.pre-dispatch.json`),
        "Gate2702JudgePreDispatch",
      );
      assertFixedJudgePreDispatch(
        preDispatch,
        requests,
        requests.requests?.[order],
        order,
        index + 1,
      );
      const derived = deriveJudgeAttempt(outcome);
      if (
        attempt.contentDigest !== reference.contentDigest ||
        attempt.outcomeDigest !== outcome.contentDigest ||
        attempt.outcome !== derived.outcome ||
        attempt.retryable !== derived.retryable ||
        attempt.failureClass !== derived.failureClass ||
        !sameValue(attempt.response, derived.response) ||
        attempt.costUsd !== derived.costUsd
      ) {
        fail(
          `sealed judge ${subject}/${order} attempt ${index + 1} does not rederive`,
        );
      }
      if (
        index < attemptRefs.length - 1 &&
        !(attempt.outcome === "failed" && attempt.retryable)
      ) {
        fail("sealed judge continued after a terminal attempt");
      }
      return attempt;
    });
    terminalByOrder[order] = attempts.at(-1);
  }
  const winner = (order) => {
    const attempt = terminalByOrder[order];
    if (attempt.outcome !== "valid") return null;
    if (attempt.response.winner === "tie") return "tie";
    return requests.requests[order].order[attempt.response.winner];
  };
  const forwardWinner = winner("forward");
  const swappedWinner = winner("swapped");
  let state = "failed";
  let subjectiveWinner = null;
  if (
    terminalByOrder.forward.outcome === "valid" &&
    terminalByOrder.swapped.outcome === "valid" &&
    forwardWinner === swappedWinner
  ) {
    state = forwardWinner === "tie" ? "tie" : "agreed";
    subjectiveWinner = forwardWinner;
  } else if (
    terminalByOrder.forward.outcome === "valid" &&
    terminalByOrder.swapped.outcome === "valid"
  ) {
    state = "disagreement";
  }
  const subjectiveState = state;
  const passed = TREATMENTS.filter(
    (treatmentId) => input.objectiveChecks?.[treatmentId]?.state === "passed",
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
  if (
    result.state !== state ||
    result.subjectiveState !== subjectiveState ||
    result.forwardWinner !== forwardWinner ||
    result.swappedWinner !== swappedWinner ||
    result.subjectiveWinner !== subjectiveWinner ||
    result.effectiveWinner !== effectiveWinner ||
    result.effectiveBasis !== effectiveBasis ||
    result.judgeInputDigest !== input.contentDigest ||
    result.requestSetDigest !== requests.contentDigest
  ) {
    fail(
      `sealed judge result #${subject} does not rederive from retained attempts`,
    );
  }
  return result;
}

function rebuildSealedCheckResults(
  objectBytes,
  byPath,
  registration,
  classification,
  startedAt,
) {
  const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-${registration.attempt}`;
  return (classification.checkResults ?? []).map((summary) => {
    const path = `${prefix}/checks/${summary.checkId.replaceAll("/", "_")}.json`;
    const execution = parseArtifactJson(
      objectBytes,
      byPath.get(path),
      "Gate2702CheckExecution",
    );
    if (Date.parse(execution.startedAt) < Date.parse(startedAt)) {
      fail("sealed check predates worker dispatch");
    }
    return {
      checkId: summary.checkId,
      outcome: summary.status === "passed" ? "passed" : "failed",
      startedAt: execution.startedAt,
      finishedAt: timestampPlus(execution.startedAt, execution.durationMs),
      evidenceRefs: evidenceForPath(byPath, path, registration.trialId),
    };
  });
}

function rebuildSealedCanonicalRun({
  runtime,
  objectBytes,
  byPath,
  registration,
  terminal,
  classification,
  accounting,
  judge,
  selectionInfo,
  parent,
  priorRuns,
}) {
  const prefix = `runs/issue-${registration.subject}/${registration.treatmentId}/attempt-${registration.attempt}`;
  const preDispatch = byPath.has(`${prefix}/pre-dispatch.json`)
    ? parseArtifactJson(
        objectBytes,
        byPath.get(`${prefix}/pre-dispatch.json`),
        "Gate2702PreDispatch",
      )
    : null;
  const identity = parseArtifactJson(
    objectBytes,
    byPath.get(`${prefix}/worktree-identity.json`),
    "Gate2702WorktreeIdentity",
  );
  const preflight = sealedPreflightFor(objectBytes, byPath, registration);
  const startedAt = preDispatch?.startedAt ?? terminal.endedAt;
  let createdAt =
    preflight.behaviorContext?.observedAt ?? identity.createdAt ?? startedAt;
  const checkResults = rebuildSealedCheckResults(
    objectBytes,
    byPath,
    registration,
    classification,
    startedAt,
  );
  const finishedAt = latestTimestamp([
    terminal.endedAt,
    startedAt,
    ...checkResults.map((entry) => entry.finishedAt),
  ]);
  if (parent && Date.parse(createdAt) <= Date.parse(parent.finishedAt)) {
    const adjusted = new Date(Date.parse(parent.finishedAt) + 1).toISOString();
    if (Date.parse(adjusted) > Date.parse(startedAt)) {
      fail("canonical retry Run timing does not follow its parent");
    }
    createdAt = adjusted;
  }
  const runId = deterministicUuid(
    `gate-2702-run\0${registration.trialId}\0${registration.contentDigest}`,
  );
  const { fingerprint, binding: selectionBinding, planSlotId } = selectionInfo;
  const snapshotPath = `subjects/issue-${registration.subject}.json`;
  const terminalPath = `${prefix}/terminal.json`;
  const classificationPath = `${prefix}/classification.json`;
  const accountingPath = `${prefix}/accounting.json`;
  const terminalEvidence = evidenceForPath(
    byPath,
    terminalPath,
    registration.trialId,
  );
  const classificationEvidence = evidenceForPath(
    byPath,
    classificationPath,
    registration.trialId,
  );
  const accountingEvidence = evidenceForPath(
    byPath,
    accountingPath,
    registration.trialId,
  );
  const judgePath = judge
    ? `judging/issue-${registration.subject}/result.json`
    : null;
  const judgeEvidence = judgePath
    ? evidenceForPath(byPath, judgePath, registration.trialId)
    : [];
  const wallTimeMs = Math.min(
    runtime.plan.limits.wallTimeMs,
    Math.max(0, Math.ceil(terminal.durationMs ?? 0)),
  );
  const observations = [];
  if (classification.status === "succeeded") {
    const bothObjectiveFailed = TREATMENTS.every(
      (treatmentId) => judge.objectiveChecks?.[treatmentId]?.state === "failed",
    );
    const qualityLoss = bothObjectiveFailed
      ? 1
      : TREATMENTS.includes(judge.effectiveWinner) &&
          judge.effectiveWinner !== registration.treatmentId
        ? 1
        : 0;
    const attributableShips =
      registration.treatmentId === "haiku-sonnet-sidekick" &&
      judge.effectiveWinner === "haiku-sonnet-sidekick" &&
      accounting.sidekickShippedInterventionCount > 0
        ? 1
        : 0;
    observations.push(
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-all-in-cost",
        accounting.allInCostUsd,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-wall-time",
        wallTimeMs,
        finishedAt,
        terminalEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-quality-loss",
        qualityLoss,
        finishedAt,
        judgeEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-triggers",
        accounting.sidekickTriggerCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-paid-calls",
        accounting.sidekickPaidCallCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-sidekick-shipped-interventions",
        accounting.sidekickShippedInterventionCount,
        finishedAt,
        accountingEvidence,
      ),
      metricObservation(
        runtime.definition,
        "metrics/gate-2702-attributable-ships",
        attributableShips,
        finishedAt,
        [...judgeEvidence, ...accountingEvidence],
      ),
    );
  }
  let worker;
  try {
    worker = JSON.parse(
      objectBytes.get(byPath.get(`${prefix}/stdout.log`).contentDigest),
    );
  } catch {
    fail("canonical Run worker result is not retained JSON");
  }
  const run = runtime.contracts.withDocumentDigest({
    schemaVersion: 1,
    kind: "ExperimentRun",
    runId,
    trialId: registration.trialId,
    contentDigest: `sha256:${"0".repeat(64)}`,
    definitionRef: registration.definitionRef,
    treatmentId: registration.treatmentId,
    retryOf: parent
      ? { runId: parent.runId, contentDigest: parent.contentDigest }
      : null,
    status: classification.status,
    createdAt,
    startedAt,
    finishedAt,
    subjectRef: {
      harness: "claude-code",
      sourceId: `github:${REPOSITORY}`,
      artifactId: `github:${REPOSITORY}/issues/${registration.subject}`,
      contentDigest: objectForPath(byPath, snapshotPath).contentDigest,
      mediaType: "application/json",
    },
    assignment: { kind: "explicit" },
    selectedHarness: "claude-code",
    harnessProvenance: {
      origin: "claude-code",
      driver: "claude-code",
      worker: "claude-code",
      judge: "claude-code",
    },
    selectionRef: {
      receiptId: selectionBinding.receiptId,
      receiptDigest: selectionBinding.receiptDigest,
      planSlotId,
    },
    triggerRef: null,
    behaviorFingerprint: fingerprint,
    capabilitySnapshot: runtime.definition.requiredCapabilities.map(
      (entry) => ({
        semanticsRef: entry.semanticsRef,
        state: "available",
        observedAt: fingerprint.observedAt,
      }),
    ),
    effectiveLimits: { ...runtime.definition.limits },
    safeguardAuthorizations: [],
    sessionRef: {
      harness: "claude-code",
      sourceId: "local-gate-2702",
      sessionId: worker.session_id,
    },
    observations,
    checkResults,
    usage: { wallTimeMs, costUsd: accounting.allInCostUsd },
    error:
      classification.status === "succeeded"
        ? null
        : {
            code: `gate-2702/${String(classification.error?.code ?? classification.status).replace(/[^a-z0-9._-]/g, "-")}`,
            message: String(
              classification.error?.message ?? `C5 ${classification.status}`,
            ).slice(0, 4096),
            evidenceRefs: classificationEvidence,
          },
    extensions: {
      "gate-2702/registrationDigest": registration.contentDigest,
      "gate-2702/classificationDigest": classification.contentDigest,
      "gate-2702/accountingDigest": accounting.contentDigest,
      "gate-2702/judgeResultDigest": judge?.contentDigest ?? null,
      "gate-2702/actualWallTimeMs": terminal.durationMs ?? null,
    },
  });
  const decoded = runtime.contracts.decodeRunV1(run, {
    definition: runtime.definition,
    registry: runtime.registry,
    selectionReceipts: [selectionBinding],
    triggerReceipts: [],
    operatorSafeguardAuthorizations: [],
    priorRuns,
  });
  if (!decoded.ok) {
    fail(
      `rederived canonical Run ${runId} failed strict v1 decoding: ${JSON.stringify(decoded.issues)}`,
    );
  }
  return decoded.value;
}

async function loadRuntime() {
  await import("../register-ts.mjs");
  const definitionModule =
    await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
  const contracts =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  const projected = definitionModule.projectGate2702C5Definition(
    definitionModule.GATE_2702_C5_DEFINITION,
  );
  if (!projected.ok) fail("checked-in C5 Definition did not project");
  return {
    plan: projected.plan,
    definition: definitionModule.GATE_2702_C5_DEFINITION,
    registry: definitionModule.GATE_2702_C5_CONTRACT_REGISTRY,
    definitionModule,
    contracts,
  };
}

function verifyBundleDirectory(runtime, paths, marker, bundleDirectory) {
  if (!isWithin(paths.bundles, bundleDirectory))
    fail("seal marker bundle path escapes the trial");
  const metadata = lstatSync(bundleDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    fail("seal bundle is not a real directory");
  const names = readdirSync(bundleDirectory).sort();
  if (!sameValue(names, ["manifest.json", "objects"]))
    fail("seal bundle contains unknown top-level evidence");
  const manifest = readReceipt(
    join(bundleDirectory, "manifest.json"),
    "Gate2702SealBundle",
    "seal bundle manifest",
  );
  if (
    manifest.contentDigest !== marker.bundleDigest ||
    marker.bundleManifestDigest !== manifest.contentDigest ||
    manifest.trialId !== marker.trialId ||
    manifest.trialDigest !== marker.trialDigest ||
    manifest.baseSha !== marker.baseSha ||
    manifest.worktreeManifestDigest !== marker.worktreeManifestDigest ||
    !sameValue(manifest.definitionRef, marker.definitionRef) ||
    manifest.retryRegistrationSetDigest !==
      (marker.retryRegistrationSetDigest ?? null)
  ) {
    fail("verified marker does not bind the exact seal bundle");
  }
  const objectsRoot = join(bundleDirectory, "objects");
  const objectsMetadata = lstatSync(objectsRoot);
  if (!objectsMetadata.isDirectory() || objectsMetadata.isSymbolicLink()) {
    fail("seal objects root is not a self-contained directory");
  }
  const objectNames = readdirSync(objectsRoot).sort();
  const expectedNames = [
    ...new Set(manifest.artifacts.map((entry) => entry.objectName)),
  ].sort();
  if (!sameValue(objectNames, expectedNames))
    fail("seal object directory is not exact");
  const objectBytes = new Map();
  for (const entry of manifest.artifacts) {
    if (
      !DIGEST_PATTERN.test(entry.contentDigest ?? "") ||
      entry.objectName !== entry.contentDigest.replace(":", "-") ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      typeof entry.sourcePath !== "string" ||
      !entry.sourcePath
    ) {
      fail("seal manifest contains an invalid artifact entry");
    }
    const bytes = readRegularBytes(
      join(objectsRoot, entry.objectName),
      MAX_OBJECT_BYTES,
      `sealed object ${entry.objectName}`,
    );
    if (
      bytes.length !== entry.sizeBytes ||
      sha256Bytes(bytes) !== entry.contentDigest
    ) {
      fail(`sealed object ${entry.sourcePath} failed content verification`);
    }
    objectBytes.set(entry.contentDigest, bytes);
  }
  const sourcePaths = manifest.artifacts.map((entry) => entry.sourcePath);
  if (
    new Set(sourcePaths).size !== sourcePaths.length ||
    !sameValue(sourcePaths, [...sourcePaths].sort())
  ) {
    fail("seal artifact paths are not uniquely sorted");
  }
  const byPath = new Map(
    manifest.artifacts.map((entry) => [entry.sourcePath, entry]),
  );
  const trialEntry = byPath.get("trial.json");
  if (!trialEntry) {
    fail("verified marker does not bind the exact trial receipt");
  }
  verifySealedTrialSet(runtime, marker, manifest, objectBytes, byPath);
  verifyArtifactCoverage(manifest, objectBytes, byPath);
  const judgeSubjects = manifest.judgeResults.map((entry) => entry.subject);
  if (new Set(judgeSubjects).size !== judgeSubjects.length) {
    fail("seal manifest repeats a judge result");
  }
  const artifactBytesByPath = new Map(
    manifest.artifacts.map((entry) => [
      entry.sourcePath,
      objectBytes.get(entry.contentDigest),
    ]),
  );
  for (const candidate of manifest.runCandidates) {
    const verifiedClassification = validateGate2702ClassificationEvidence({
      artifactBytesByPath,
      trialId: marker.trialId,
      baseSha: marker.baseSha,
      subject: candidate.subject,
      treatmentId: candidate.treatmentId,
      attempt: candidate.attempt,
    });
    if (
      verifiedClassification.registration.contentDigest !==
        candidate.registrationDigest ||
      verifiedClassification.classification.contentDigest !==
        candidate.classificationDigest ||
      verifiedClassification.classification.status !== candidate.status
    ) {
      fail("seal Run candidate does not bind its rederived classification");
    }
  }
  for (const entry of manifest.judgeResults) {
    const verifiedJudge = validateGate2702JudgeEvidence({
      artifactBytesByPath,
      trialId: marker.trialId,
      subject: entry.subject,
      baseSha: marker.baseSha,
    });
    if (verifiedJudge.result.contentDigest !== entry.contentDigest) {
      fail("seal judge-result manifest digest does not match retained result");
    }
    rederiveSealedJudge(manifest, objectBytes, entry.subject);
  }
  const sealedSelectionGroups = verifySealedArmsAndLiveDiffs(
    runtime,
    manifest,
    objectBytes,
    byPath,
  );
  const definitionEntry = byPath.get("generated/definition.json");
  if (!definitionEntry) fail("seal bundle omits its exact Definition");
  const definitionBytes = objectBytes.get(definitionEntry.contentDigest);
  const definitionInput = JSON.parse(definitionBytes.toString("utf8"));
  const decodedDefinition = runtime.contracts.decodeDefinitionV1(
    definitionInput,
    {
      registry: runtime.registry,
    },
  );
  if (
    !decodedDefinition.ok ||
    !sameValue(decodedDefinition.value, runtime.definition) ||
    !definitionBytes.equals(
      Buffer.from(
        `${runtime.contracts.canonicalDocumentJson(runtime.definition)}\n`,
        "utf8",
      ),
    )
  ) {
    fail("sealed Definition is not the checked-in C5 Definition");
  }
  const registryEntry = byPath.get("generated/registry.json");
  if (!registryEntry) fail("seal bundle omits its exact contract registry");
  const sealedRegistry = JSON.parse(
    objectBytes.get(registryEntry.contentDigest).toString("utf8"),
  );
  if (
    !sameValue(sealedRegistry, runtime.registry) ||
    !objectBytes
      .get(registryEntry.contentDigest)
      .equals(Buffer.from(`${canonicalJson(runtime.registry)}\n`, "utf8"))
  ) {
    fail("sealed contract registry differs from the checked-in C5 registry");
  }
  const decodedRuns = [];
  const bindings = manifest.selectionBindings;
  for (const runEntry of manifest.canonicalRuns) {
    const artifact = byPath.get(runEntry.sourcePath);
    if (!artifact || artifact.contentDigest !== runEntry.objectDigest) {
      fail("canonical Run manifest points at the wrong object");
    }
    const bytes = objectBytes.get(artifact.contentDigest);
    const input = JSON.parse(bytes.toString("utf8"));
    const binding = bindings.find(
      (entry) => entry.receiptId === input.selectionRef?.receiptId,
    );
    const decoded = runtime.contracts.decodeRunV1(input, {
      definition: decodedDefinition.value,
      registry: runtime.registry,
      selectionReceipts: binding ? [binding] : [],
      triggerReceipts: [],
      operatorSafeguardAuthorizations: [],
      priorRuns: decodedRuns,
    });
    if (!decoded.ok)
      fail(
        `sealed canonical Run failed v1 decoding: ${JSON.stringify(decoded.issues)}`,
      );
    const expectedBytes = Buffer.from(
      `${runtime.contracts.canonicalDocumentJson(decoded.value)}\n`,
      "utf8",
    );
    if (!bytes.equals(expectedBytes))
      fail("sealed Run bytes are not canonical v1 JSON");
    if (
      decoded.value.runId !== runEntry.runId ||
      decoded.value.contentDigest !== runEntry.contentDigest
    ) {
      fail("canonical Run manifest identity is wrong");
    }
    decodedRuns.push(decoded.value);
  }
  const canonicalRunIds = manifest.canonicalRuns.map((entry) => entry.runId);
  if (new Set(canonicalRunIds).size !== canonicalRunIds.length) {
    fail("seal manifest repeats a canonical Run");
  }
  const includedCandidates = manifest.runCandidates.filter(
    (candidate) => candidate.exclusion === undefined,
  );
  if (
    includedCandidates.length !== decodedRuns.length ||
    manifest.runCandidates.some(
      (candidate) =>
        (candidate.exclusion === undefined) !==
        (typeof candidate.runId === "string" &&
          DIGEST_PATTERN.test(candidate.runDigest ?? "")),
    )
  ) {
    fail("canonical Runs are not a bijection with included run candidates");
  }
  const runById = new Map(decodedRuns.map((run) => [run.runId, run]));
  const expectedPriorByRegistration = new Map();
  for (const candidate of includedCandidates) {
    const run = runById.get(candidate.runId);
    const prefix = `runs/issue-${candidate.subject}/${candidate.treatmentId}/attempt-${candidate.attempt}`;
    const registration = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/registration.json`),
      "Gate2702ArmRegistration",
    );
    const terminal = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/terminal.json`),
      "Gate2702Terminal",
    );
    const classification = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/classification.json`),
      "Gate2702ArmClassification",
    );
    const accounting = parseArtifactJson(
      objectBytes,
      byPath.get(`${prefix}/accounting.json`),
      "Gate2702Accounting",
    );
    const expectedWallTime = Math.min(
      runtime.plan.limits.wallTimeMs,
      Math.max(0, Math.ceil(terminal.durationMs ?? 0)),
    );
    if (
      !run ||
      run.contentDigest !== candidate.runDigest ||
      run.trialId !== registration.trialId ||
      run.treatmentId !== registration.treatmentId ||
      run.status !== classification.status ||
      run.subjectRef?.artifactId !==
        `github:${REPOSITORY}/issues/${registration.subject}` ||
      run.sessionRef?.sessionId !== accounting.workerSessionId ||
      run.usage?.costUsd !== accounting.allInCostUsd ||
      run.usage?.wallTimeMs !== expectedWallTime ||
      run.extensions?.["gate-2702/registrationDigest"] !==
        registration.contentDigest ||
      run.extensions?.["gate-2702/classificationDigest"] !==
        classification.contentDigest ||
      run.extensions?.["gate-2702/accountingDigest"] !==
        accounting.contentDigest
    ) {
      fail("canonical Run does not rederive from its sealed arm receipts");
    }
    const selectionInfo = sealedSelectionGroups.byRegistration.get(
      registration.contentDigest,
    );
    if (!selectionInfo) {
      fail("canonical Run has no complete retained behavior evidence");
    }
    const judgeEntry = manifest.judgeResults.find(
      (entry) => entry.subject === registration.subject,
    );
    const judge = judgeEntry
      ? parseArtifactJson(
          objectBytes,
          byPath.get(`judging/issue-${registration.subject}/result.json`),
          "Gate2702JudgeResult",
        )
      : null;
    const parent =
      registration.attempt === 2
        ? expectedPriorByRegistration.get(
            registration.retryOf?.registrationDigest,
          )
        : null;
    if (registration.attempt === 2 && !parent) {
      fail("canonical retry Run has no rederived prior Run");
    }
    const expectedRun = rebuildSealedCanonicalRun({
      runtime,
      objectBytes,
      byPath,
      registration,
      terminal,
      classification,
      accounting,
      judge,
      selectionInfo,
      parent,
      priorRuns: [...expectedPriorByRegistration.values()],
    });
    if (
      !sameValue(run, expectedRun) ||
      candidate.runId !== expectedRun.runId ||
      candidate.runDigest !== expectedRun.contentDigest
    ) {
      fail("canonical Run does not exactly rederive from sealed evidence");
    }
    expectedPriorByRegistration.set(registration.contentDigest, expectedRun);
    const normalizedExpectedFingerprint = {
      ...selectionInfo.fingerprint,
      factors: [...selectionInfo.fingerprint.factors].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
    if (!sameValue(run.behaviorFingerprint, normalizedExpectedFingerprint)) {
      fail("canonical Run behavior fingerprint does not rederive");
    }
    if (
      run.selectionRef?.receiptId !== selectionInfo.binding.receiptId ||
      run.selectionRef?.receiptDigest !== selectionInfo.binding.receiptDigest ||
      run.selectionRef?.planSlotId !== selectionInfo.planSlotId
    ) {
      fail("canonical Run selection receipt does not rederive");
    }
    if (classification.status === "succeeded") {
      const bothObjectiveFailed = TREATMENTS.every(
        (treatmentId) =>
          judge.objectiveChecks?.[treatmentId]?.state === "failed",
      );
      const qualityLoss = bothObjectiveFailed
        ? 1
        : TREATMENTS.includes(judge.effectiveWinner) &&
            judge.effectiveWinner !== registration.treatmentId
          ? 1
          : 0;
      const expectedMetrics = new Map([
        ["metrics/gate-2702-all-in-cost", accounting.allInCostUsd],
        ["metrics/gate-2702-wall-time", expectedWallTime],
        ["metrics/gate-2702-quality-loss", qualityLoss],
        [
          "metrics/gate-2702-sidekick-triggers",
          accounting.sidekickTriggerCount,
        ],
        [
          "metrics/gate-2702-sidekick-paid-calls",
          accounting.sidekickPaidCallCount,
        ],
        [
          "metrics/gate-2702-sidekick-shipped-interventions",
          accounting.sidekickShippedInterventionCount,
        ],
        [
          "metrics/gate-2702-attributable-ships",
          registration.treatmentId === "haiku-sonnet-sidekick" &&
          judge.effectiveWinner === "haiku-sonnet-sidekick" &&
          accounting.sidekickShippedInterventionCount > 0
            ? 1
            : 0,
        ],
      ]);
      if (
        run.observations.length !== expectedMetrics.size ||
        run.observations.some(
          (observation) =>
            !expectedMetrics.has(observation.metricId) ||
            expectedMetrics.get(observation.metricId) !== observation.value,
        )
      ) {
        fail("canonical Run observations do not rederive from sealed evidence");
      }
    } else if (
      run.observations.length !== 0 ||
      run.error === null ||
      !run.error.code.startsWith("gate-2702/")
    ) {
      fail("non-successful canonical Run has invalid outcome evidence");
    }
    if (candidate.attempt === 2) {
      const parentCandidate = manifest.runCandidates.find(
        (entry) =>
          entry.registrationDigest === registration.retryOf?.registrationDigest,
      );
      if (
        !parentCandidate?.runId ||
        run.retryOf?.runId !== parentCandidate.runId ||
        run.retryOf?.contentDigest !== parentCandidate.runDigest
      ) {
        fail("canonical retry Run does not bind its prior Run");
      }
    } else if (run.retryOf !== null) {
      fail("attempt-1 canonical Run unexpectedly declares a retry parent");
    }
  }
  return {
    definition: decodedDefinition.value,
    registry: sealedRegistry,
    runs: decodedRuns,
    manifest,
    objectBytes,
  };
}

/**
 * Load decoded C5 data only after the immutable marker and every retained
 * bundle artifact have passed the full post-cleanup verification path.
 */
export async function loadVerifiedTrial(optionsInput) {
  const options = {
    ...optionsInput,
    stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot()),
  };
  const runtime = await loadRuntime();
  const paths = trialPaths(options);
  const marker = readReceipt(
    paths.marker,
    "Gate2702VerifiedSeal",
    "verified seal marker",
  );
  if (
    marker.verified !== true ||
    marker.trialId !== options.trial ||
    !sameValue(marker.definitionRef, runtime.plan.definitionRef) ||
    !DIGEST_PATTERN.test(marker.trialDigest ?? "") ||
    !/^[0-9a-f]{40}$/.test(marker.baseSha ?? "") ||
    !DIGEST_PATTERN.test(marker.worktreeManifestDigest ?? "") ||
    !DIGEST_PATTERN.test(marker.bundleDigest ?? "") ||
    marker.bundleDirectory !==
      join("bundles", marker.bundleDigest.replace(":", "-")) ||
    !Number.isFinite(Date.parse(marker.sealedAt ?? ""))
  ) {
    fail("verified seal marker is not the exact C5 cleanup authority");
  }
  const bundleDirectory = join(paths.sealRoot, marker.bundleDirectory);
  const verified = verifyBundleDirectory(
    runtime,
    paths,
    marker,
    bundleDirectory,
  );
  return {
    definition: verified.definition,
    registry: verified.registry,
    runs: verified.runs,
    manifest: verified.manifest,
    marker,
  };
}

export async function verifyTrial(optionsInput) {
  const verified = await loadVerifiedTrial(optionsInput);
  return {
    trialId: verified.marker.trialId,
    state: "verified",
    bundleDigest: verified.manifest.contentDigest,
    runCount: verified.runs.length,
    excludedRunCount: verified.manifest.runCandidates.filter(
      (entry) => entry.exclusion,
    ).length,
  };
}

export async function sealTrial(
  optionsInput,
  dependencies = productionValidators,
) {
  const options = {
    ...optionsInput,
    stateRoot: resolve(optionsInput.stateRoot || defaultStateRoot()),
  };
  const runtime = await loadRuntime();
  const paths = trialPaths(options);
  if (existsSync(paths.marker)) return verifyTrial(options);
  const state = validateTrial(runtime, options, paths);
  const armEvidence = state.registrations.map((registration) =>
    validateTerminalArm(runtime, paths, registration, dependencies, options),
  );
  const selected = selectedAttempts(paths, state.trial, armEvidence);
  const judgeBySubject = validateJudging(
    paths,
    options,
    selected,
    dependencies,
  );
  const evidencePaths = assertNoUnknownEvidence(
    paths,
    expectedEvidencePaths(paths, armEvidence, selected),
  );
  const objectMap = { objects: new Map(), artifacts: [], byPath: new Map() };
  for (const path of evidencePaths) {
    const bytes = readRegularBytes(
      join(paths.trialRoot, path),
      MAX_OBJECT_BYTES,
      path,
    );
    addObject(
      objectMap,
      path,
      bytes,
      path.endsWith(".json")
        ? "application/json"
        : path.endsWith(".jsonl")
          ? "application/x-ndjson"
          : "application/octet-stream",
    );
  }
  collectExternalAccountingObjects(objectMap, armEvidence);
  const definitionBytes = Buffer.from(
    `${runtime.contracts.canonicalDocumentJson(runtime.definition)}\n`,
    "utf8",
  );
  addObject(
    objectMap,
    "generated/definition.json",
    definitionBytes,
    "application/json",
  );
  addObject(
    objectMap,
    "generated/registry.json",
    Buffer.from(`${canonicalJson(runtime.registry)}\n`, "utf8"),
    "application/json",
  );
  const diffEntries = new Map();
  const trialDiffBounds = { rawBytes: 0, artifactCount: 0 };
  for (const evidence of armEvidence) {
    const diff = captureWorktreeDiff(evidence.registration, trialDiffBounds);
    validateFrozenDiff(diff, "captured worktree diff");
    const selectedPair = selected.get(evidence.registration.subject);
    if (
      selectedPair?.selected[evidence.registration.treatmentId]?.registration
        .contentDigest === evidence.registration.contentDigest
    ) {
      const frozen = readReceipt(
        join(
          paths.trialRoot,
          "judging",
          `issue-${evidence.registration.subject}`,
          "evidence",
          `${evidence.registration.treatmentId}.json`,
        ),
        "Gate2702JudgeArmEvidence",
        "frozen judge arm evidence",
      );
      const liveWorker = workerResult(
        evidence.accounting,
        evidence.registration.runDir,
      );
      validateFrozenJudgeArm(
        frozen,
        evidence.registration,
        evidence.classification,
        selectedPair.selection.contentDigest,
      );
      if (
        frozen.workerResult !== liveWorker?.result ||
        !sameValue(frozen.diff, {
          trackedPatch: diff.trackedPatch,
          untracked: diff.untracked,
        })
      ) {
        fail("live final worktree differs from its frozen judge diff");
      }
    }
    const sourcePath = `generated/diffs/issue-${evidence.registration.subject}.${evidence.registration.treatmentId}.attempt-${evidence.registration.attempt}.json`;
    const diffBytes = Buffer.from(`${canonicalJson(diff)}\n`, "utf8");
    if (diffBytes.length > MAX_OBJECT_BYTES) {
      fail("encoded worktree diff exceeds the fixed object bound");
    }
    diffEntries.set(
      evidence.registration.contentDigest,
      addObject(objectMap, sourcePath, diffBytes, "application/json"),
    );
  }
  objectMap.artifacts.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  objectMap.byPath = new Map(
    objectMap.artifacts.map((entry) => [entry.sourcePath, entry]),
  );
  const priorByRegistration = new Map();
  const runCandidates = [];
  const canonicalRuns = [];
  const selectionGroups = buildSelectionGroups(runtime, paths, armEvidence);
  const selectionBindings = selectionGroups.bindings;
  for (const evidence of sortedRunEvidence(armEvidence)) {
    const judge = judgeBySubject.get(evidence.registration.subject) ?? null;
    const built = buildRunCandidate(
      runtime,
      paths,
      evidence,
      judge,
      objectMap.byPath,
      priorByRegistration,
      selectionGroups.byRegistration.get(evidence.registration.contentDigest),
    );
    const candidate = {
      subject: evidence.registration.subject,
      treatmentId: evidence.registration.treatmentId,
      attempt: evidence.registration.attempt,
      status: evidence.classification.status,
      registrationDigest: evidence.registration.contentDigest,
      classificationDigest: evidence.classification.contentDigest,
      accountingDigest: evidence.accounting.contentDigest,
      diffObjectDigest: diffEntries.get(evidence.registration.contentDigest)
        .contentDigest,
    };
    if (built.exclusion) {
      runCandidates.push({ ...candidate, exclusion: built.exclusion });
      continue;
    }
    const runBytes = Buffer.from(
      `${runtime.contracts.canonicalDocumentJson(built.run)}\n`,
      "utf8",
    );
    const sourcePath = `generated/runs/${built.run.runId}.json`;
    const entry = addObject(
      objectMap,
      sourcePath,
      runBytes,
      "application/json",
    );
    canonicalRuns.push({
      sourcePath,
      objectDigest: entry.contentDigest,
      runId: built.run.runId,
      contentDigest: built.run.contentDigest,
    });
    priorByRegistration.set(evidence.registration.contentDigest, built.run);
    runCandidates.push({
      ...candidate,
      runId: built.run.runId,
      runDigest: built.run.contentDigest,
    });
  }
  objectMap.artifacts.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  const manifest = withDigest({
    schemaVersion: 1,
    kind: "Gate2702SealBundle",
    definitionRef: state.trial.definitionRef,
    trialId: state.trial.trialId,
    trialDigest: state.trial.contentDigest,
    baseSha: state.trial.baseSha,
    worktreeManifestDigest: state.trial.worktreeManifestDigest,
    retryRegistrationSetDigest:
      state.retryState.registrations.length > 0
        ? state.retryState.registrationSetDigest
        : null,
    registrationCount: state.registrations.length,
    artifacts: objectMap.artifacts,
    runCandidates,
    canonicalRuns,
    selectionBindings,
    judgeResults: [...judgeBySubject.entries()].map(([subject, result]) => ({
      subject,
      contentDigest: result.contentDigest,
    })),
  });
  const staging = join(
    paths.sealRoot,
    `.staging-${process.pid}-${randomUUID()}`,
  );
  const objectsRoot = join(staging, "objects");
  mkdirSync(objectsRoot, { recursive: true });
  for (const [digest, bytes] of objectMap.objects) {
    writeDurableFile(join(objectsRoot, digest.replace(":", "-")), bytes);
  }
  fsyncDirectory(objectsRoot);
  writeDurableFile(
    join(staging, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  fsyncDirectory(staging);
  maybeCrash("after-staging");
  mkdirSync(paths.bundles, { recursive: true });
  const bundleDirectory = join(
    paths.bundles,
    manifest.contentDigest.replace(":", "-"),
  );
  if (existsSync(bundleDirectory)) {
    rmSync(staging, { recursive: true, force: true });
  } else {
    renameSync(staging, bundleDirectory);
    fsyncDirectory(paths.bundles);
  }
  maybeCrash("after-bundle");
  const marker = withDigest({
    schemaVersion: 1,
    kind: "Gate2702VerifiedSeal",
    verified: true,
    definitionRef: state.trial.definitionRef,
    trialId: state.trial.trialId,
    trialDigest: state.trial.contentDigest,
    baseSha: state.trial.baseSha,
    worktreeManifestDigest: state.trial.worktreeManifestDigest,
    ...(state.retryState.registrations.length > 0
      ? { retryRegistrationSetDigest: state.retryState.registrationSetDigest }
      : {}),
    bundleDigest: manifest.contentDigest,
    bundleManifestDigest: manifest.contentDigest,
    bundleDirectory: join("bundles", manifest.contentDigest.replace(":", "-")),
    sealedAt: new Date().toISOString(),
  });
  verifyBundleDirectory(runtime, paths, marker, bundleDirectory);
  maybeCrash("before-marker");
  atomicWriteJson(paths.marker, marker);
  return verifyTrial(options);
}

async function main() {
  // Consent is checked before argument parsing or touching the state root.
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    fail("gate-2702 sealing is opt-in; set CHD_EXPERIMENT_2702=1 to enable it");
  }
  const options = parseArgs(process.argv.slice(2));
  const result =
    options.command === "seal"
      ? await sealTrial(options)
      : await verifyTrial(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`gate-2702 seal: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
