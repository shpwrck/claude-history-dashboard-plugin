#!/usr/bin/env node

/** C5-only cost and Sidekick accounting bridge for #2702. */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gate2702ModelIds } from "./behavior-context.mjs";
import { gate2702IsolatedHome } from "./sandbox-dispatch.mjs";

const SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_WORKER_BYTES = 2 * 1024 * 1024;
const MAX_SIDEKICK_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_SIDEKICK_LEDGER_ROWS = 4_096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LEDGER_MUTATION_TEST_PHASE_ENV =
  "CHD_EXPERIMENT_2702_TEST_LEDGER_MUTATION_PHASE";
const LEDGER_MUTATION_TEST_READY_ENV =
  "CHD_EXPERIMENT_2702_TEST_LEDGER_READY_PATH";
const LEDGER_MUTATION_TEST_RELEASE_ENV =
  "CHD_EXPERIMENT_2702_TEST_LEDGER_RELEASE_PATH";

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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function receiptDigest(receipt) {
  const undigested = { ...receipt };
  delete undigested.contentDigest;
  return sha256(canonicalJson(undigested));
}

function withDigest(receipt) {
  return { ...receipt, contentDigest: receiptDigest(receipt) };
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} is not a regular file`);
  }
  return metadata;
}

function waitAtLedgerMutationTestBarrier(phase) {
  if (
    process.env.CHD_EXPERIMENT_2702_TEST_MODE !== "1" ||
    process.env[LEDGER_MUTATION_TEST_PHASE_ENV] !== phase
  ) {
    return;
  }
  const readyPath = process.env[LEDGER_MUTATION_TEST_READY_ENV];
  const releasePath = process.env[LEDGER_MUTATION_TEST_RELEASE_ENV];
  if (!readyPath || !releasePath) {
    fail(`ledger mutation test barrier ${phase} is missing marker paths`);
  }
  writeFileSync(readyPath, "", { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 10_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath) && Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, 5);
  }
  if (!existsSync(releasePath)) {
    fail(`ledger mutation test barrier ${phase} timed out`);
  }
}

function readBounded(path, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} is not a regular file`);
    if (before.size > maximumBytes)
      fail(`${label} exceeds its fixed size limit`);
    const bytes = readFileSync(descriptor);
    if (label === "exact Sidekick ledger") {
      waitAtLedgerMutationTestBarrier("bounded-read");
    }
    const after = fstatSync(descriptor);
    if (
      ledgerFingerprint(before) !== ledgerFingerprint(after) ||
      bytes.length !== after.size
    ) {
      fail(`${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    if (error?.code === "ELOOP") fail(`${label} is not a regular file`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, maximumBytes, label) {
  const bytes = readBounded(path, maximumBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function verifyReceipt(receipt, expectedKind, label = expectedKind) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt)
  ) {
    fail(`${label} is not an object`);
  }
  if (
    receipt.schemaVersion !== SCHEMA_VERSION ||
    receipt.kind !== expectedKind
  ) {
    fail(`${label} has the wrong kind or schema version`);
  }
  if (!SHA256_PATTERN.test(receipt.contentDigest ?? "")) {
    fail(`${label} has no valid content digest`);
  }
  if (receipt.contentDigest !== receiptDigest(receipt)) {
    fail(`${label} content digest does not match`);
  }
  return receipt;
}

function readReceipt(path, kind, label = kind) {
  return verifyReceipt(readJson(path, MAX_RECEIPT_BYTES, label), kind, label);
}

function writeImmutableReceipt(path, undigested) {
  const receipt = withDigest(undigested);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_RECEIPT_BYTES) {
    fail("accounting receipt exceeds its fixed size limit");
  }
  mkdirSync(dirname(path), { recursive: true });
  let created = false;
  try {
    writeFileSync(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readBounded(
      path,
      MAX_RECEIPT_BYTES,
      "existing accounting receipt",
    ).toString("utf8");
    if (existing !== bytes)
      fail("immutable accounting receipt already differs");
  }
  return { receipt, created };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "collect") {
    fail(
      "usage: accounting.mjs collect --trial <uuid> --subject <issue> --treatment <id> --attempt <1|2> [--state-root <path>]",
    );
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument near ${String(key)}`);
    }
    const name = key.slice(2);
    if (
      !["trial", "subject", "treatment", "attempt", "state-root"].includes(name)
    ) {
      fail(`unknown option ${key}`);
    }
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!UUID_PATTERN.test(options.trial ?? ""))
    fail("--trial must be an RFC 4122 UUID");
  options.subject = Number(options.subject);
  options.attempt = Number(options.attempt);
  if (!Number.isSafeInteger(options.subject))
    fail("--subject must be an integer");
  if (![1, 2].includes(options.attempt)) fail("--attempt must be 1 or 2");
  if (typeof options.treatment !== "string") fail("--treatment is required");
  options.stateRoot = resolve(
    options["state-root"] ||
      process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
  return options;
}

function pathsFor(plan, options) {
  const trialRoot = join(
    options.stateRoot,
    plan.definitionRef.contentDigest.replace(":", "-"),
    options.trial,
  );
  const runDir = join(
    trialRoot,
    "runs",
    `issue-${options.subject}`,
    options.treatment,
    `attempt-${options.attempt}`,
  );
  return {
    trialRoot,
    trial: join(trialRoot, "trial.json"),
    retrySets: join(trialRoot, "retries", "sets"),
    runDir,
    registration: join(runDir, "registration.json"),
    terminal: join(runDir, "terminal.json"),
    classification: join(runDir, "classification.json"),
    preDispatch: join(runDir, "pre-dispatch.json"),
    stdout: join(runDir, "stdout.log"),
    accounting: join(runDir, "accounting.json"),
  };
}

function armRunDirectory(trialRoot, subject, treatmentId, attempt) {
  return join(
    trialRoot,
    "runs",
    `issue-${subject}`,
    treatmentId,
    `attempt-${attempt}`,
  );
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
    fail(`${label} identity does not match the registration`);
  }
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

function validateRetryRegistrationSet(
  plan,
  trial,
  paths,
  requestedRegistration,
) {
  const registrations = [];
  for (const subject of plan.subjects) {
    for (const treatment of plan.treatments) {
      const attempt2RunDir = armRunDirectory(
        paths.trialRoot,
        subject,
        treatment.id,
        2,
      );
      const attempt2Path = join(attempt2RunDir, "registration.json");
      if (!existsSync(attempt2Path)) continue;
      const attempt2 = readReceipt(
        attempt2Path,
        "Gate2702ArmRegistration",
        "retry registration receipt",
      );
      const attempt1 = trial.registrations?.find(
        (candidate) =>
          candidate.subject === subject &&
          candidate.treatmentId === treatment.id &&
          candidate.attempt === 1,
      );
      if (!attempt1) fail("retry registration has no trial-bound attempt 1");
      verifyReceipt(
        attempt1,
        "Gate2702ArmRegistration",
        "embedded registration",
      );
      const expectedAttempt1RunDir = armRunDirectory(
        paths.trialRoot,
        subject,
        treatment.id,
        1,
      );
      if (
        resolve(attempt1.runDir) !== resolve(expectedAttempt1RunDir) ||
        attempt1.baseSha !== trial.baseSha ||
        !sameValue(attempt1.definitionRef, plan.definitionRef)
      ) {
        fail("retry attempt 1 is not the exact trial registration");
      }
      const classification1 = readReceipt(
        join(expectedAttempt1RunDir, "classification.json"),
        "Gate2702ArmClassification",
        "retry-authorizing classification",
      );
      assertArmIdentity(
        classification1,
        attempt1,
        "retry-authorizing classification",
      );
      const retryOf = {
        attempt: 1,
        registrationDigest: attempt1.contentDigest,
        classificationDigest: classification1.contentDigest,
      };
      const expectedWorktreePath = join(
        paths.trialRoot,
        "worktrees",
        `issue-${subject}.${treatment.id}.attempt-2`,
      );
      if (
        attempt2.trialId !== trial.trialId ||
        attempt2.subject !== subject ||
        attempt2.treatmentId !== treatment.id ||
        attempt2.attempt !== 2 ||
        attempt2.baseSha !== trial.baseSha ||
        resolve(attempt2.runDir) !== resolve(attempt2RunDir) ||
        resolve(attempt2.worktreePath) !== resolve(expectedWorktreePath) ||
        !sameValue(attempt2.definitionRef, plan.definitionRef) ||
        !sameValue(attempt2.retryOf, retryOf) ||
        classification1.registrationDigest !== attempt1.contentDigest ||
        classification1.retry?.authorized !== true
      ) {
        fail("attempt 2 registration is not authorized by attempt 1");
      }
      registrations.push(attempt2);
    }
  }
  if (
    !registrations.some(
      (registration) =>
        registration.contentDigest === requestedRegistration.contentDigest &&
        sameValue(registration, requestedRegistration),
    )
  ) {
    fail("requested retry is absent from the deterministic registration set");
  }
  const manifest = retryRegistrationManifest(registrations);
  const registrationSetDigest = sha256(canonicalJson(manifest));
  const receipt = readReceipt(
    join(paths.retrySets, `${registrationSetDigest.replace(":", "-")}.json`),
    "Gate2702RetryRegistrationSet",
    "retry registration set receipt",
  );
  if (
    !sameValue(receipt.definitionRef, plan.definitionRef) ||
    receipt.trialId !== trial.trialId ||
    receipt.baseSha !== trial.baseSha ||
    receipt.registrationSetDigest !== registrationSetDigest ||
    !sameValue(receipt.registrations, manifest)
  ) {
    fail("retry registration set receipt does not match its registrations");
  }
  return { registrationSetDigest, receipt };
}

function validateArmEvidence(plan, options, paths) {
  const trial = readReceipt(paths.trial, "Gate2702Trial", "trial receipt");
  if (
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    trial.repository !== "shpwrck/claude-history-dashboard"
  ) {
    fail("trial is not the exact checked-in C5 experiment");
  }
  const registration = readReceipt(
    paths.registration,
    "Gate2702ArmRegistration",
    "registration receipt",
  );
  if (
    registration.trialId !== options.trial ||
    registration.subject !== options.subject ||
    registration.treatmentId !== options.treatment ||
    registration.attempt !== options.attempt ||
    resolve(registration.runDir) !== resolve(paths.runDir) ||
    !sameValue(registration.definitionRef, plan.definitionRef)
  ) {
    fail("requested arm does not match its C5 registration");
  }
  let retryBinding = null;
  if (registration.attempt === 1) {
    const embedded = trial.registrations?.find(
      (candidate) => candidate.contentDigest === registration.contentDigest,
    );
    if (!embedded || !sameValue(embedded, registration)) {
      fail("registration is not bound into the trial receipt");
    }
  } else {
    retryBinding = validateRetryRegistrationSet(
      plan,
      trial,
      paths,
      registration,
    );
  }
  const terminal = readReceipt(
    paths.terminal,
    "Gate2702Terminal",
    "terminal receipt",
  );
  assertArmIdentity(terminal, registration, "terminal receipt");
  const classification = readReceipt(
    paths.classification,
    "Gate2702ArmClassification",
    "classification receipt",
  );
  assertArmIdentity(classification, registration, "classification receipt");
  if (
    classification.registrationDigest !== registration.contentDigest ||
    classification.terminalDigest !== terminal.contentDigest ||
    !SHA256_PATTERN.test(classification.preflightDigest ?? "")
  ) {
    fail("classification is not bound to the registered terminal arm");
  }
  if (
    !["succeeded", "failed", "cancelled"].includes(classification.status) ||
    typeof classification.eligible !== "boolean"
  ) {
    fail("accounting requires a terminal C5 classification");
  }
  return { registration, terminal, classification, retryBinding };
}

function workerEvidence(paths, classification) {
  const bytes = readBounded(
    paths.stdout,
    MAX_WORKER_BYTES,
    "worker terminal JSON",
  );
  const declared = classification.workerArtifacts?.stdout;
  if (
    declared?.truncated !== false ||
    declared.byteLength !== bytes.length ||
    declared.capturedBytes !== bytes.length ||
    declared.contentDigest !== sha256(bytes)
  ) {
    fail("worker terminal JSON does not match classified evidence");
  }
  let result = null;
  const unknownReasons = [];
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      result = parsed;
    }
  } catch {
    // The source digest remains evidence even when fields cannot be decoded.
  }
  if (result === null) unknownReasons.push("worker-result-malformed");
  const workerSessionId = UUID_PATTERN.test(result?.session_id ?? "")
    ? result.session_id.toLowerCase()
    : null;
  if (workerSessionId === null)
    unknownReasons.push("worker-session-id-unknown");
  const workerCostUsd =
    typeof result?.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0 &&
    !Object.is(result.total_cost_usd, -0)
      ? result.total_cost_usd
      : null;
  if (workerCostUsd === null) unknownReasons.push("worker-cost-unknown");
  return {
    workerSessionId,
    workerCostUsd,
    unknownReasons,
    evidence: {
      source: "worker-terminal-json",
      byteLength: bytes.length,
      contentDigest: sha256(bytes),
    },
  };
}

function observation(value, evidenceDigests, unknownReasons = []) {
  return { value, evidenceDigests, unknownReasons };
}

function assertDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} is missing`);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} is not a real directory`);
  }
}

function ledgerFingerprint(metadata) {
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":");
}

function findUnsettledJobs(root) {
  const pending = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        fail("Sidekick session contains a symbolic link");
      if (metadata.isDirectory()) walk(path);
      else if (!metadata.isFile())
        fail("Sidekick session contains a special file");
      else if (name.endsWith(".job.json")) pending.push(path);
    }
  };
  walk(root);
  return pending;
}

async function readSettledLedger(workerSessionId, sidekickRoot) {
  const relativePath = `${workerSessionId}/__sidekick.jsonl`;
  if (!existsSync(sidekickRoot)) return { status: "missing", relativePath };
  assertDirectory(sidekickRoot, "Sidekick root");
  const sessionDir = join(sidekickRoot, workerSessionId);
  if (!existsSync(sessionDir)) return { status: "missing", relativePath };
  assertDirectory(sessionDir, "exact Sidekick session directory");
  if (findUnsettledJobs(sessionDir).length > 0) {
    fail("Sidekick session still has unsettled *.job.json work");
  }
  const ledgerPath = join(sessionDir, "__sidekick.jsonl");
  if (!existsSync(ledgerPath)) return { status: "missing", relativePath };
  const bytes = readBounded(
    ledgerPath,
    MAX_SIDEKICK_LEDGER_BYTES,
    "exact Sidekick ledger",
  );
  const before = assertRegularFile(ledgerPath, "exact Sidekick ledger");
  if (before.size !== bytes.length) {
    fail("Sidekick ledger changed while accounting evidence was collected");
  }
  waitAtLedgerMutationTestBarrier("settle-window");
  await new Promise((resolveWait) =>
    setTimeout(
      resolveWait,
      process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" ? 10 : 200,
    ),
  );
  const after = assertRegularFile(ledgerPath, "exact Sidekick ledger");
  if (
    ledgerFingerprint(before) !== ledgerFingerprint(after) ||
    after.size !== bytes.length ||
    findUnsettledJobs(sessionDir).length > 0
  ) {
    fail("Sidekick ledger changed while accounting evidence was collected");
  }
  return {
    status: "settled",
    path: ledgerPath,
    sessionDir,
    relativePath,
    bytes,
    fingerprint: ledgerFingerprint(after),
  };
}

function assertLedgerUnchanged(ledger) {
  const current = assertRegularFile(ledger.path, "exact Sidekick ledger");
  if (
    ledgerFingerprint(current) !== ledger.fingerprint ||
    findUnsettledJobs(ledger.sessionDir).length > 0
  ) {
    fail("Sidekick ledger changed before accounting receipt persistence");
  }
}

function parseLedgerRows(bytes) {
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_SIDEKICK_LEDGER_ROWS) {
    fail("exact Sidekick ledger exceeds its fixed row limit");
  }
  let malformed = false;
  const entries = lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed = true;
      row = null;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      malformed = true;
      row = null;
    }
    return {
      rowNumber: index + 1,
      row,
      contentDigest: sha256(line),
    };
  });
  return { entries, malformed };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} is missing`);
  return value;
}

function requiredTurn(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

function requireZeroCost(row, label) {
  if (row.costUsd !== 0 || Object.is(row.costUsd, -0)) {
    fail(`${label} must have known zero cost`);
  }
}

function normalizedCost(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    return null;
  }
  const normalized = Number(value.toFixed(12));
  return Number.isFinite(normalized) && !Object.is(normalized, -0)
    ? normalized
    : null;
}

function requireNoShippedField(row, label) {
  if (row.shipped !== undefined) {
    fail(`${label} cannot declare a shipped intervention`);
  }
}

function requireShippedBoolean(row, label, expected) {
  if (
    typeof row.shipped !== "boolean" ||
    (expected !== undefined && row.shipped !== expected)
  ) {
    fail(`${label} has an invalid shipped state`);
  }
}

function unknownSidekickValues(reason, rowEvidence) {
  const reasons = [reason];
  return {
    sidekickCostUsd: null,
    sidekickTriggerCount: null,
    sidekickPaidCallCount: null,
    sidekickShippedInterventionCount: null,
    unknownReasons: reasons,
    fieldUnknownReasons: {
      sidekickCostUsd: reasons,
      sidekickTriggerCount: reasons,
      sidekickPaidCallCount: reasons,
      sidekickShippedInterventionCount: reasons,
    },
    rowEvidence,
  };
}

function untrustedSidekickValues(reason, entries) {
  return unknownSidekickValues(
    reason,
    entries.map(({ rowNumber, contentDigest, row }) => ({
      rowNumber,
      contentDigest,
      lifecycle: row === null ? "malformed" : "untrusted",
    })),
  );
}

function collectSidekickRows(rows, workerSessionId, sidekickModel) {
  const asyncJobs = new Map();
  const lifecycleRows = new Map();
  const paidRows = [];
  const shippedRows = [];
  const rowEvidence = [];
  let lifecycleConflict = false;
  let lifecycleUnrecognized = false;
  let directTriggerCount = 0;
  const ignoredModels = new Set(["engage", "budget", "guard"]);

  const acceptLifecycle = (identity, row) => {
    const canonical = canonicalJson(row);
    const existing = lifecycleRows.get(identity);
    if (existing === undefined) {
      lifecycleRows.set(identity, canonical);
      return "unique";
    }
    if (existing !== canonical) {
      lifecycleConflict = true;
      return "conflict";
    }
    return "duplicate";
  };

  for (const evidence of rows) {
    const { row } = evidence;
    let lifecycle = "ignored";
    let identity = null;
    let duplicate = false;
    let conflict = false;
    if (row.model === "queued") {
      const jobId = requiredString(row.jobId, "queued Sidekick jobId");
      const trigger = requiredString(row.trigger, "queued Sidekick trigger");
      requireZeroCost(row, "queued Sidekick row");
      requireNoShippedField(row, "queued Sidekick row");
      lifecycle = "async-queued";
      identity = `async:${workerSessionId}:${jobId}:queued`;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        const job = asyncJobs.get(jobId) ?? {
          trigger,
          queued: false,
          completed: false,
        };
        if (job.trigger !== trigger) {
          lifecycleConflict = true;
          conflict = true;
        } else {
          job.queued = true;
          asyncJobs.set(jobId, job);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === "sync" || row.model === "stop-review") {
      const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
      const trigger = requiredString(
        row.trigger,
        `${row.model} Sidekick trigger`,
      );
      const skipped =
        row.model === "stop-review" && row.skipped === "empty-tail";
      if (row.skipped !== undefined && !skipped) {
        fail(`${row.model} Sidekick skipped state is unrecognized`);
      }
      if (skipped) {
        requireZeroCost(row, "skipped stop-review Sidekick row");
        requireNoShippedField(row, "skipped stop-review Sidekick row");
      } else {
        requireShippedBoolean(row, `${row.model} Sidekick row`);
      }
      identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
      lifecycle = row.model;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        directTriggerCount += 1;
        if (!skipped) {
          paidRows.push(row);
          if (row.shipped === true) shippedRows.push(row);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === "triage") {
      const turn = requiredTurn(row.turn, "triage Sidekick turn");
      if (typeof row.fired !== "boolean") {
        fail("triage Sidekick fired result is invalid");
      }
      requireNoShippedField(row, "triage Sidekick row");
      identity = `probe:${workerSessionId}:triage:${turn}`;
      lifecycle = "triage";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") paidRows.push(row);
      else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (
      row.model === "delivery" ||
      row.model === "pre-act" ||
      row.model === "interrupt"
    ) {
      const reviewedTurn = requiredTurn(
        row.reviewedTurn,
        `${row.model} Sidekick reviewed turn`,
      );
      requireZeroCost(row, `${row.model} Sidekick row`);
      requireShippedBoolean(row, `${row.model} Sidekick row`, true);
      identity = `delivery:${workerSessionId}:${row.model}:${reviewedTurn}`;
      lifecycle = "delivery";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        if (row.shipped === true) shippedRows.push(row);
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (
      row.model === sidekickModel &&
      typeof row.trigger === "string" &&
      typeof row.error === "string" &&
      row.error.length > 0 &&
      row.jobId === undefined
    ) {
      const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
      const trigger = requiredString(
        row.trigger,
        `${row.model} Sidekick trigger`,
      );
      requireShippedBoolean(row, `${row.model} Sidekick error row`, false);
      identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
      lifecycle = "sync-error";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        directTriggerCount += 1;
        paidRows.push(row);
        if (row.shipped === true) shippedRows.push(row);
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === sidekickModel && typeof row.jobId === "string") {
      const jobId = requiredString(row.jobId, "completed Sidekick jobId");
      const trigger = requiredString(row.trigger, "completed Sidekick trigger");
      requireNoShippedField(row, "completed Sidekick row");
      lifecycle = "async-completed";
      identity = `async:${workerSessionId}:${jobId}:completed`;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        const job = asyncJobs.get(jobId) ?? {
          trigger,
          queued: false,
          completed: false,
        };
        if (job.trigger !== trigger) {
          lifecycleConflict = true;
          conflict = true;
        } else {
          job.completed = true;
          asyncJobs.set(jobId, job);
          paidRows.push(row);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (ignoredModels.has(row.model) && row.costUsd === 0) {
      lifecycle = "administrative";
    } else {
      lifecycle = "unrecognized";
      lifecycleUnrecognized = true;
    }
    rowEvidence.push({
      rowNumber: evidence.rowNumber,
      contentDigest: evidence.contentDigest,
      lifecycle,
      ...(identity ? { identityDigest: sha256(identity) } : {}),
      ...(duplicate ? { duplicate: true } : {}),
      ...(conflict ? { conflict: true } : {}),
    });
  }

  if (lifecycleUnrecognized) {
    return unknownSidekickValues(
      "sidekick-lifecycle-unrecognized",
      rowEvidence,
    );
  }

  if (lifecycleConflict) {
    const reasons = ["sidekick-lifecycle-conflict"];
    return {
      sidekickCostUsd: null,
      sidekickTriggerCount: null,
      sidekickPaidCallCount: null,
      sidekickShippedInterventionCount: null,
      unknownReasons: reasons,
      fieldUnknownReasons: {
        sidekickCostUsd: reasons,
        sidekickTriggerCount: reasons,
        sidekickPaidCallCount: reasons,
        sidekickShippedInterventionCount: reasons,
      },
      rowEvidence,
    };
  }

  const asyncTriggerCount = [...asyncJobs.values()].filter(
    ({ queued }) => queued,
  ).length;
  const sidekickTriggerCount = asyncTriggerCount + directTriggerCount;
  const lifecycleIncomplete = [...asyncJobs.values()].some(
    ({ queued, completed }) => !queued || !completed,
  );
  if (lifecycleIncomplete) {
    const reasons = ["sidekick-lifecycle-incomplete"];
    return {
      sidekickCostUsd: null,
      sidekickTriggerCount,
      sidekickPaidCallCount: null,
      sidekickShippedInterventionCount: null,
      unknownReasons: reasons,
      fieldUnknownReasons: {
        sidekickCostUsd: reasons,
        sidekickTriggerCount: [],
        sidekickPaidCallCount: reasons,
        sidekickShippedInterventionCount: reasons,
      },
      rowEvidence,
    };
  }

  const costsKnown = paidRows.every(
    (row) =>
      typeof row.costUsd === "number" &&
      Number.isFinite(row.costUsd) &&
      row.costUsd >= 0 &&
      !Object.is(row.costUsd, -0),
  );
  const sidekickCostUsd = costsKnown
    ? normalizedCost(paidRows.reduce((total, row) => total + row.costUsd, 0))
    : null;
  const costUnknownReasons =
    sidekickCostUsd === null ? ["sidekick-cost-unknown"] : [];
  return {
    sidekickCostUsd,
    sidekickTriggerCount,
    sidekickPaidCallCount: paidRows.length,
    sidekickShippedInterventionCount: shippedRows.length,
    unknownReasons: costUnknownReasons,
    fieldUnknownReasons: {
      sidekickCostUsd: costUnknownReasons,
      sidekickTriggerCount: [],
      sidekickPaidCallCount: [],
      sidekickShippedInterventionCount: [],
    },
    rowEvidence,
  };
}

async function collectTreatment(worker, sidekickModel, sidekickRoot) {
  const ledger =
    worker.workerSessionId === null
      ? { status: "unavailable", relativePath: null }
      : await readSettledLedger(worker.workerSessionId, sidekickRoot);
  const values =
    ledger.status !== "settled"
      ? {
          sidekickCostUsd: null,
          sidekickTriggerCount: null,
          sidekickPaidCallCount: null,
          sidekickShippedInterventionCount: null,
          unknownReasons: [
            ledger.status === "missing"
              ? "sidekick-ledger-missing"
              : "worker-session-id-unknown",
          ],
          fieldUnknownReasons: Object.fromEntries(
            [
              "sidekickCostUsd",
              "sidekickTriggerCount",
              "sidekickPaidCallCount",
              "sidekickShippedInterventionCount",
            ].map((field) => [
              field,
              [
                ledger.status === "missing"
                  ? "sidekick-ledger-missing"
                  : "worker-session-id-unknown",
              ],
            ]),
          ),
          rowEvidence: [],
        }
      : (() => {
          const parsed = parseLedgerRows(ledger.bytes);
          if (!parsed.malformed) {
            try {
              return collectSidekickRows(
                parsed.entries,
                worker.workerSessionId,
                sidekickModel,
              );
            } catch {
              // A structurally valid JSON row can still violate v0.3.x shape.
            }
          }
          return untrustedSidekickValues(
            "sidekick-ledger-malformed",
            parsed.entries,
          );
        })();
  if (ledger.status === "settled") assertLedgerUnchanged(ledger);
  const allInCostUsd =
    worker.workerCostUsd === null || values.sidekickCostUsd === null
      ? null
      : normalizedCost(worker.workerCostUsd + values.sidekickCostUsd);
  const workerCostUnknownReasons =
    worker.workerCostUsd === null
      ? worker.unknownReasons.filter(
          (reason) => reason !== "worker-session-id-unknown",
        )
      : [];
  const invalidAllInCost =
    worker.workerCostUsd !== null &&
    values.sidekickCostUsd !== null &&
    allInCostUsd === null;
  const allInUnknownReasons = [
    ...new Set([
      ...workerCostUnknownReasons,
      ...values.fieldUnknownReasons.sidekickCostUsd,
      ...(invalidAllInCost ? ["all-in-cost-invalid"] : []),
    ]),
  ];
  const unknownReasons = [
    ...new Set([...allInUnknownReasons, ...values.unknownReasons]),
  ];
  const evidenceDigests = [
    worker.evidence.contentDigest,
    ...(ledger.status === "settled" ? [sha256(ledger.bytes)] : []),
  ];
  const receiptValues = {
    workerSessionId: worker.workerSessionId,
    workerCostUsd: worker.workerCostUsd,
    sidekickCostUsd: values.sidekickCostUsd,
    allInCostUsd,
    sidekickTriggerCount: values.sidekickTriggerCount,
    sidekickPaidCallCount: values.sidekickPaidCallCount,
    sidekickShippedInterventionCount: values.sidekickShippedInterventionCount,
    bridgeEvidenceStatus: allInCostUsd === null ? "excluded" : "eligible",
    exclusionReasons: unknownReasons,
    ...(allInCostUsd === null ? {} : { usage: { costUsd: allInCostUsd } }),
    observations: {
      workerCostUsd: observation(
        worker.workerCostUsd,
        [worker.evidence.contentDigest],
        workerCostUnknownReasons,
      ),
      sidekickCostUsd: observation(
        values.sidekickCostUsd,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickCostUsd,
      ),
      allInCostUsd: observation(
        allInCostUsd,
        evidenceDigests,
        allInUnknownReasons,
      ),
      sidekickTriggerCount: observation(
        values.sidekickTriggerCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickTriggerCount,
      ),
      sidekickPaidCallCount: observation(
        values.sidekickPaidCallCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickPaidCallCount,
      ),
      sidekickShippedInterventionCount: observation(
        values.sidekickShippedInterventionCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickShippedInterventionCount,
      ),
    },
    sourceEvidence: {
      worker: worker.evidence,
      sidekick: {
        source: "sidekick-session-ledger",
        relativePath: ledger.relativePath,
        status: ledger.status,
        ...(ledger.status === "settled"
          ? {
              byteLength: ledger.bytes.length,
              contentDigest: sha256(ledger.bytes),
            }
          : {}),
        rowDigests: values.rowEvidence,
      },
    },
  };
  return {
    receiptValues,
    verifySource:
      ledger.status === "settled" ? () => assertLedgerUnchanged(ledger) : null,
  };
}

function collectControl(plan, evidence, worker) {
  const costKnown = worker.workerCostUsd !== null;
  const unknownReasons = costKnown
    ? []
    : worker.unknownReasons.filter(
        (reason) => reason !== "worker-session-id-unknown",
      );
  const allInCostUsd = costKnown ? worker.workerCostUsd : null;
  const definitionEvidence = plan.definitionRef.contentDigest;
  return {
    workerSessionId: worker.workerSessionId,
    workerCostUsd: worker.workerCostUsd,
    sidekickCostUsd: 0,
    allInCostUsd,
    sidekickTriggerCount: 0,
    sidekickPaidCallCount: 0,
    sidekickShippedInterventionCount: 0,
    bridgeEvidenceStatus: costKnown ? "eligible" : "excluded",
    exclusionReasons: unknownReasons,
    ...(costKnown ? { usage: { costUsd: allInCostUsd } } : {}),
    observations: {
      workerCostUsd: observation(
        worker.workerCostUsd,
        [worker.evidence.contentDigest],
        unknownReasons,
      ),
      sidekickCostUsd: observation(0, [definitionEvidence]),
      allInCostUsd: observation(
        allInCostUsd,
        [worker.evidence.contentDigest, definitionEvidence],
        unknownReasons,
      ),
      sidekickTriggerCount: observation(0, [definitionEvidence]),
      sidekickPaidCallCount: observation(0, [definitionEvidence]),
      sidekickShippedInterventionCount: observation(0, [definitionEvidence]),
    },
    sourceEvidence: {
      worker: worker.evidence,
      sidekick: {
        source: "fixed-disabled-treatment",
        definitionDigest: definitionEvidence,
      },
    },
  };
}

async function loadPlan() {
  await import("../register-ts.mjs");
  const definition =
    await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
  const projected = definition.projectGate2702C5Definition(
    definition.GATE_2702_C5_DEFINITION,
  );
  if (!projected.ok) fail("the checked-in C5 Definition did not project");
  return projected.plan;
}

async function collect(plan, options) {
  if (!plan.subjects.includes(options.subject))
    fail("subject is outside the fixed C5 plan");
  const treatment = plan.treatments.find(({ id }) => id === options.treatment);
  if (!treatment) fail("treatment is outside the fixed C5 plan");
  const paths = pathsFor(plan, options);
  const evidence = validateArmEvidence(plan, options, paths);
  const worker = workerEvidence(paths, evidence.classification);
  const isolatedHome = gate2702IsolatedHome({
    runDir: paths.runDir,
    preDispatch: existsSync(paths.preDispatch)
      ? readReceipt(
          paths.preDispatch,
          "Gate2702PreDispatch",
          "worker pre-dispatch receipt",
        )
      : null,
  });
  const sidekickRoot =
    isolatedHome === null
      ? join(homedir(), ".sidekick")
      : join(isolatedHome, ".sidekick");
  const collected = treatment.configuration.sidekick.enabled
    ? await collectTreatment(worker, gate2702ModelIds().sidekick, sidekickRoot)
    : {
        receiptValues: collectControl(plan, evidence, worker),
        verifySource: null,
      };
  const persisted = writeImmutableReceipt(paths.accounting, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702Accounting",
    definitionRef: evidence.registration.definitionRef,
    registrationDigest: evidence.registration.contentDigest,
    terminalDigest: evidence.terminal.contentDigest,
    classificationDigest: evidence.classification.contentDigest,
    trialId: evidence.registration.trialId,
    subject: evidence.registration.subject,
    treatmentId: evidence.registration.treatmentId,
    attempt: evidence.registration.attempt,
    baseSha: evidence.registration.baseSha,
    ...(evidence.retryBinding
      ? {
          retryOf: evidence.registration.retryOf,
          retryRegistrationSetDigest:
            evidence.retryBinding.registrationSetDigest,
          retryRegistrationSetReceiptDigest:
            evidence.retryBinding.receipt.contentDigest,
        }
      : {}),
    ...collected.receiptValues,
  });
  try {
    collected.verifySource?.();
  } catch (error) {
    if (persisted.created) unlinkSync(paths.accounting);
    throw error;
  }
  return persisted.receipt;
}

async function main() {
  // Consent precedes argument parsing, file access, and every other side effect.
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    process.stderr.write(
      "gate-2702 accounting is disabled; set CHD_EXPERIMENT_2702=1 to collect C5 evidence.\n",
    );
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const plan = await loadPlan();
  const receipt = await collect(plan, options);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gate-2702 accounting: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
