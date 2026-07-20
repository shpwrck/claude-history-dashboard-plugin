#!/usr/bin/env node

/**
 * Narrow, disposable runner for the #2702 C5 experiment bridge.
 *
 * This is deliberately not a general experiment harness. It accepts exactly
 * the checked-in #2818 Definition and does only the operational work needed to
 * launch, resume, inspect, and seal-gate cleanup for that one experiment.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATE_2702_SIDEKICK_ENV_KEYS,
  GATE_2702_SIDEKICK_VERSION,
  gate2702ExecutionMode,
  gate2702ModelIds,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const CLASSIFIER_PATH = join(SCRIPT_DIR, "classify.mjs");
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const REPOSITORY = "shpwrck/claude-history-dashboard";
const SCHEMA_VERSION = 1;
const ATTEMPT = 1;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  throw new Error(message);
}

function assertSidekickLaunchReady(repoPath) {
  const pausePath = join(process.env.HOME || homedir(), ".sidekick", "paused");
  if (existsSync(pausePath)) {
    fail("C5 launch requires Sidekick to be unpaused");
  }
  if (process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1") {
    if (
      process.env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION !==
        GATE_2702_SIDEKICK_VERSION ||
      process.env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_ENABLED === "0"
    ) {
      fail("C5 launch requires the enabled pinned Sidekick plugin");
    }
    return;
  }
  const result = spawnSync("claude", ["plugin", "list", "--json"], {
    cwd: repoPath,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  let plugins;
  try {
    plugins = JSON.parse(String(result.stdout ?? ""));
  } catch {
    plugins = null;
  }
  const matches = Array.isArray(plugins)
    ? plugins.filter(
        (plugin) => plugin?.id === "claude-sidekick@claude-sidekick",
      )
    : [];
  if (
    result.status !== 0 ||
    result.signal !== null ||
    matches.length !== 1 ||
    matches[0].enabled !== true ||
    matches[0].version !== GATE_2702_SIDEKICK_VERSION
  ) {
    fail("C5 launch requires the enabled pinned Sidekick plugin");
  }
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
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function valueDigest(value) {
  return sha256(canonicalJson(value));
}

function receiptDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return valueDigest(withoutDigest);
}

function withDigest(receipt) {
  return { ...receipt, contentDigest: receiptDigest(receipt) };
}

function verifyReceipt(receipt, expectedKind) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt)
  ) {
    fail(`${expectedKind} receipt is not an object`);
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION) {
    fail(`${expectedKind} receipt has an unsupported schemaVersion`);
  }
  if (receipt.kind !== expectedKind) {
    fail(`expected ${expectedKind}, found ${String(receipt.kind)}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(receipt.contentDigest ?? "")) {
    fail(`${expectedKind} receipt has no valid content digest`);
  }
  if (receipt.contentDigest !== receiptDigest(receipt)) {
    fail(`${expectedKind} receipt content digest does not match its bytes`);
  }
  return receipt;
}

function readJson(path) {
  const size = statSync(path).size;
  if (size > MAX_JSON_BYTES) fail(`${path} exceeds the receipt size limit`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readReceipt(path, kind) {
  return verifyReceipt(readJson(path), kind);
}

function receiptBytes(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function writeImmutableReceipt(path, undigested) {
  const receipt = withDigest(undigested);
  const bytes = receiptBytes(receipt);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readFileSync(path, "utf8");
    if (existing !== bytes) {
      fail(`immutable receipt already exists with different bytes: ${path}`);
    }
  }
  return receipt;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${dirname(path) === path ? "state" : path.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (
    ![
      "launch",
      "status",
      "cleanup",
      "retry",
      "__supervise",
      "__retry",
    ].includes(command)
  ) {
    fail(
      "usage: run.mjs <launch|status|cleanup|retry> --trial <uuid> [--subject <issue> --treatment <id> --retry-of 1] [--repo <path>] [--state-root <path>]",
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
    const allowed = ["trial", "repo", "state-root", "lock-token"];
    if (["retry", "__retry"].includes(command)) {
      allowed.push("subject", "treatment", "retry-of");
    }
    if (!allowed.includes(name)) {
      fail(`unknown option ${key}`);
    }
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!UUID_PATTERN.test(options.trial ?? "")) {
    fail("--trial must be an RFC 4122 UUID");
  }
  const internal = ["__supervise", "__retry"].includes(command);
  if (!internal && options["lock-token"] !== undefined) {
    fail("--lock-token is internal-only");
  }
  if (internal && !UUID_PATTERN.test(options["lock-token"] ?? "")) {
    fail("the internal supervisor requires a valid lock token");
  }
  if (["retry", "__retry"].includes(command)) {
    const subject = Number(options.subject);
    if (!Number.isSafeInteger(subject) || subject <= 0) {
      fail("retry requires --subject <issue>");
    }
    if (!["haiku-solo", "haiku-sonnet-sidekick"].includes(options.treatment)) {
      fail("retry requires one C5 --treatment");
    }
    if (options["retry-of"] !== "1") fail("retry requires --retry-of 1");
    options.subject = subject;
  }
  return options;
}

function defaultStateRoot() {
  return resolve(
    process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
}

function stateRootFor(options) {
  return resolve(options["state-root"] || defaultStateRoot());
}

function runSync(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    fail(`${program} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(
      `${program} ${args.join(" ")} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function invokeClassifier(command, paths, trialId, subject, registration) {
  const args = [
    CLASSIFIER_PATH,
    command,
    "--trial",
    trialId,
    "--subject",
    String(subject),
    "--state-root",
    dirname(dirname(paths.trialRoot)),
  ];
  if (["classify", "preflight-retry"].includes(command)) {
    args.push(
      "--treatment",
      registration.treatmentId,
      "--attempt",
      String(registration.attempt),
    );
  }
  const output = runSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    // A pair preflight may legally spend 2 x 20 minutes in sequential npm ci,
    // plus the fixed Git/tool probes. Keep the supervisor outside that sum.
    timeout: command === "preflight" ? 3_000_000 : 2_000_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  try {
    return JSON.parse(output);
  } catch {
    fail(`gate-2702 ${command} returned malformed JSON`);
  }
}

function git(repoPath, args, options = {}) {
  return runSync("git", ["-C", repoPath, ...args], options).trim();
}

function resolveRepo(input) {
  const candidate = resolve(input || process.cwd());
  try {
    return realpathSync(candidate);
  } catch (error) {
    fail(`repository path is unavailable: ${candidate} (${error.message})`);
  }
}

function pinOriginMaster(repoPath) {
  const sha = git(repoPath, [
    "rev-parse",
    "--verify",
    "origin/master^{commit}",
  ]);
  if (!/^[0-9a-f]{40}$/i.test(sha))
    fail("origin/master did not resolve to a commit SHA");
  return sha.toLowerCase();
}

function verifyPinnedCommit(repoPath, baseSha) {
  const resolvedSha = git(repoPath, [
    "rev-parse",
    "--verify",
    `${baseSha}^{commit}`,
  ]);
  if (resolvedSha.toLowerCase() !== baseSha.toLowerCase()) {
    fail(`pinned base commit is unavailable: ${baseSha}`);
  }
}

function safeDigestDirectory(contentDigest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
    fail("Definition has an invalid content digest");
  }
  return contentDigest.replace(":", "-");
}

function pathsFor(stateRoot, definitionRef, trialId) {
  const trialRoot = join(
    stateRoot,
    safeDigestDirectory(definitionRef.contentDigest),
    trialId,
  );
  return {
    trialRoot,
    trial: join(trialRoot, "trial.json"),
    lock: join(trialRoot, "lock"),
    lockOwner: join(trialRoot, "lock", "owner.json"),
    supervisorLog: join(trialRoot, "supervisor.log"),
    subjects: join(trialRoot, "subjects"),
    runs: join(trialRoot, "runs"),
    worktrees: join(trialRoot, "worktrees"),
    seal: join(trialRoot, "seal", "verified.json"),
    cleanup: join(trialRoot, "cleanup.json"),
    retrySets: join(trialRoot, "retries", "sets"),
  };
}

function registrationPath(paths, subject, treatmentId, attempt = ATTEMPT) {
  return join(
    paths.runs,
    `issue-${subject}`,
    treatmentId,
    `attempt-${attempt}`,
    "registration.json",
  );
}

function runDirectory(paths, subject, treatmentId, attempt = ATTEMPT) {
  return dirname(registrationPath(paths, subject, treatmentId, attempt));
}

function worktreePath(paths, subject, treatmentId, attempt = ATTEMPT) {
  return join(
    paths.worktrees,
    `issue-${subject}.${treatmentId}.attempt-${attempt}`,
  );
}

function subjectPath(paths, subject) {
  return join(paths.subjects, `issue-${subject}.json`);
}

function processTarget(pid) {
  return process.platform === "win32" ? pid : -pid;
}

function processExists(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isManagedProcessActive(pid) {
  return (
    Number.isSafeInteger(pid) && pid > 1 && processExists(processTarget(pid))
  );
}

function signalManagedProcess(pid, signal) {
  try {
    process.kill(processTarget(pid), signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForManagedProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isManagedProcessActive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !isManagedProcessActive(pid);
}

async function quiesceManagedProcessGroup(pid) {
  const configuredTestGrace = Number(
    process.env.CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS,
  );
  const graceMs =
    process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
    Number.isSafeInteger(configuredTestGrace) &&
    configuredTestGrace > 0
      ? configuredTestGrace
      : 5_000;
  if (!isManagedProcessActive(pid)) return true;
  signalManagedProcess(pid, "SIGTERM");
  if (await waitForManagedProcessExit(pid, graceMs)) return true;
  signalManagedProcess(pid, "SIGKILL");
  return waitForManagedProcessExit(pid, graceMs);
}

function isOwnerActive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 1)
    return false;
  return owner.phase === "supervising"
    ? isManagedProcessActive(owner.pid)
    : processExists(owner.pid);
}

function readLockOwner(paths) {
  try {
    const owner = readJson(paths.lockOwner);
    if (
      owner?.schemaVersion !== SCHEMA_VERSION ||
      owner?.kind !== "Gate2702TrialLock" ||
      !UUID_PATTERN.test(owner?.token ?? "")
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function sameLockGeneration(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLockOwner(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    left.phase === right.phase &&
    left.updatedAt === right.updatedAt
  );
}

function removeOwnedReclaimMarker(markerPath, token) {
  try {
    const marker = readJson(markerPath);
    if (marker?.kind === "Gate2702LockReclaim" && marker.token === token) {
      unlinkSync(markerPath);
    }
  } catch {
    // Fail closed: never remove a marker whose ownership cannot be proved.
  }
}

function reclaimStaleLock(paths, observedOwner, observedGeneration, trialId) {
  const markerPath = join(paths.lock, "reclaim.json");
  const token = randomUUID();
  try {
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "Gate2702LockReclaim",
        trialId,
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(`trial ${trialId} lock reclamation is already in progress`);
    }
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let currentGeneration;
  let currentOwner;
  try {
    currentGeneration = statSync(paths.lock);
    currentOwner = readLockOwner(paths);
  } catch {
    removeOwnedReclaimMarker(markerPath, token);
    return false;
  }
  if (
    !sameLockGeneration(observedGeneration, currentGeneration) ||
    !sameLockOwner(observedOwner, currentOwner) ||
    (currentOwner !== null && isOwnerActive(currentOwner))
  ) {
    removeOwnedReclaimMarker(markerPath, token);
    return false;
  }

  if (existsSync(paths.lockOwner)) unlinkSync(paths.lockOwner);
  const marker = readJson(markerPath);
  if (marker?.kind !== "Gate2702LockReclaim" || marker.token !== token) {
    fail(`trial ${trialId} lock reclamation ownership changed`);
  }
  unlinkSync(markerPath);
  rmdirSync(paths.lock);
  return true;
}

function acquireLock(paths, trialId) {
  mkdirSync(paths.trialRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(paths.lock);
      const token = randomUUID();
      atomicWriteJson(paths.lockOwner, {
        schemaVersion: SCHEMA_VERSION,
        kind: "Gate2702TrialLock",
        trialId,
        token,
        phase: "preparing",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      });
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readLockOwner(paths);
      if (owner && isOwnerActive(owner)) {
        fail(`trial ${trialId} is already active under pid ${owner.pid}`);
      }
      let generation;
      try {
        generation = statSync(paths.lock);
      } catch {
        continue;
      }
      const ageMs = Date.now() - generation.mtimeMs;
      if (!owner && ageMs < 30_000) {
        fail(`trial ${trialId} lock is being prepared`);
      }
      try {
        if (!reclaimStaleLock(paths, owner, generation, trialId)) continue;
      } catch (removeError) {
        fail(
          `trial ${trialId} has an unrecoverable lock: ${removeError.message}`,
        );
      }
    }
  }
  fail(`could not acquire trial ${trialId} lock`);
}

function updateLock(paths, token, fields) {
  const owner = readLockOwner(paths);
  if (!owner || owner.token !== token) fail("trial lock ownership changed");
  atomicWriteJson(paths.lockOwner, {
    ...owner,
    ...fields,
    updatedAt: new Date().toISOString(),
  });
}

function releaseLock(paths, token) {
  const owner = readLockOwner(paths);
  if (!owner || owner.token !== token) return;
  try {
    unlinkSync(paths.lockOwner);
    rmdirSync(paths.lock);
  } catch (error) {
    process.stderr.write(
      `gate-2702: could not release trial lock: ${error.message}\n`,
    );
  }
}

function buildRegistration({
  definitionRef,
  trialId,
  baseSha,
  paths,
  subject,
  treatmentId,
  attempt = ATTEMPT,
  retryOf,
}) {
  return withDigest({
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702ArmRegistration",
    definitionRef,
    trialId,
    subject,
    subjectRef: `github:${REPOSITORY}#${subject}`,
    treatmentId,
    attempt,
    baseSha,
    executionMode: gate2702ExecutionMode(),
    runDir: runDirectory(paths, subject, treatmentId, attempt),
    worktreePath: worktreePath(paths, subject, treatmentId, attempt),
    ...(retryOf ? { retryOf } : {}),
  });
}

function registrationManifest(registrations) {
  return registrations.map((registration) => ({
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    worktreePath: registration.worktreePath,
    registrationDigest: registration.contentDigest,
  }));
}

function expectedRegistrations(plan, trialId, baseSha, paths) {
  return plan.subjects.flatMap((subject) =>
    plan.treatments.map((treatment) =>
      buildRegistration({
        definitionRef: plan.definitionRef,
        trialId,
        baseSha,
        paths,
        subject,
        treatmentId: treatment.id,
      }),
    ),
  );
}

function verifyTrial(trial, plan, paths, trialId) {
  verifyReceipt(trial, "Gate2702Trial");
  if (trial.trialId !== trialId) fail("trial receipt has the wrong trial ID");
  if (!sameValue(trial.definitionRef, plan.definitionRef)) {
    fail("trial receipt has the wrong Definition identity");
  }
  if (resolve(trial.stateRoot) !== resolve(dirname(dirname(paths.trialRoot)))) {
    fail("trial receipt state root does not match its storage path");
  }
  if (resolve(trial.worktreeRoot) !== resolve(paths.worktrees)) {
    fail("trial receipt worktree root does not match its storage path");
  }
  if (
    trial.repository !== REPOSITORY ||
    trial.executionMode !== gate2702ExecutionMode() ||
    !/^[0-9a-f]{40}$/.test(trial.baseSha ?? "")
  ) {
    fail("trial receipt has an invalid repository or base SHA");
  }
  if (
    !Array.isArray(trial.registrations) ||
    trial.registrations.length !== 12
  ) {
    fail("trial receipt must contain exactly 12 arm registrations");
  }
  const expected = expectedRegistrations(plan, trialId, trial.baseSha, paths);
  for (const [index, registration] of trial.registrations.entries()) {
    verifyReceipt(registration, "Gate2702ArmRegistration");
    if (!sameValue(registration, expected[index])) {
      fail("trial receipt contains a registration outside the fixed C5 plan");
    }
  }
  if (
    !Array.isArray(trial.subjectSnapshots) ||
    trial.subjectSnapshots.length !== plan.subjects.length ||
    trial.subjectSnapshots.some(
      (snapshot, index) =>
        snapshot?.subject !== plan.subjects[index] ||
        !/^sha256:[0-9a-f]{64}$/.test(snapshot?.contentDigest ?? ""),
    )
  ) {
    fail("trial receipt has an invalid subject snapshot manifest");
  }
  const manifestDigest = valueDigest(registrationManifest(trial.registrations));
  if (trial.worktreeManifestDigest !== manifestDigest) {
    fail("trial worktree manifest digest does not match its registrations");
  }
  return trial;
}

function readExistingTrial(plan, paths, trialId) {
  if (!existsSync(paths.trial)) return null;
  return verifyTrial(readJson(paths.trial), plan, paths, trialId);
}

function assertSubjectSnapshotIdentity(snapshot, registration, expectedDigest) {
  if (
    !sameValue(snapshot.definitionRef, registration.definitionRef) ||
    snapshot.trialId !== registration.trialId ||
    snapshot.repository !== REPOSITORY ||
    snapshot.executionMode !==
      (registration.executionMode ?? gate2702ExecutionMode()) ||
    snapshot.subject !== registration.subject ||
    snapshot.baseSha !== registration.baseSha ||
    (expectedDigest !== undefined && snapshot.contentDigest !== expectedDigest)
  ) {
    fail(`subject snapshot identity mismatch for #${registration.subject}`);
  }
  if (
    typeof snapshot.title !== "string" ||
    typeof snapshot.body !== "string" ||
    typeof snapshot.url !== "string"
  ) {
    fail(`subject snapshot content is invalid for #${registration.subject}`);
  }
  return snapshot;
}

function snapshotSubject(
  paths,
  subject,
  repoPath,
  definitionRef,
  trialId,
  baseSha,
) {
  const path = subjectPath(paths, subject);
  if (existsSync(path)) {
    const receipt = readReceipt(path, "Gate2702SubjectSnapshot");
    assertSubjectSnapshotIdentity(receipt, {
      definitionRef,
      trialId,
      subject,
      baseSha,
    });
    return receipt;
  }
  const gh = process.env.CHD_EXPERIMENT_2702_GH_BIN || "gh";
  const output = runSync(
    gh,
    [
      "-R",
      REPOSITORY,
      "issue",
      "view",
      String(subject),
      "--json",
      "number,title,body,url",
    ],
    { cwd: repoPath },
  );
  let issue;
  try {
    issue = JSON.parse(output);
  } catch {
    fail(`GitHub returned malformed JSON for issue #${subject}`);
  }
  if (
    issue?.number !== subject ||
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    typeof issue.url !== "string"
  ) {
    fail(`GitHub returned an invalid snapshot for issue #${subject}`);
  }
  return writeImmutableReceipt(path, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702SubjectSnapshot",
    definitionRef,
    trialId,
    repository: REPOSITORY,
    executionMode: gate2702ExecutionMode(),
    subject,
    baseSha,
    title: issue.title,
    body: issue.body,
    url: issue.url,
  });
}

function prepareTrial({ plan, paths, trialId, repoPath, baseSha }) {
  const snapshots = plan.subjects.map((subject) =>
    snapshotSubject(
      paths,
      subject,
      repoPath,
      plan.definitionRef,
      trialId,
      baseSha,
    ),
  );
  const registrations = expectedRegistrations(plan, trialId, baseSha, paths);
  for (const registration of registrations) {
    const path = registrationPath(
      paths,
      registration.subject,
      registration.treatmentId,
    );
    writeImmutableReceipt(path, {
      ...registration,
      contentDigest: undefined,
    });
  }
  const manifestDigest = valueDigest(registrationManifest(registrations));
  const trial = writeImmutableReceipt(paths.trial, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702Trial",
    definitionRef: plan.definitionRef,
    trialId,
    repository: REPOSITORY,
    executionMode: gate2702ExecutionMode(),
    repoPath,
    stateRoot: dirname(dirname(paths.trialRoot)),
    worktreeRoot: paths.worktrees,
    baseSha,
    worktreeManifestDigest: manifestDigest,
    subjectSnapshots: snapshots.map((snapshot) => ({
      subject: snapshot.subject,
      contentDigest: snapshot.contentDigest,
    })),
    registrations,
  });
  return verifyTrial(trial, plan, paths, trialId);
}

function validateRegistrationFiles(trial, paths) {
  const result = [];
  for (const embedded of trial.registrations) {
    const path = registrationPath(
      paths,
      embedded.subject,
      embedded.treatmentId,
    );
    const receipt = readReceipt(path, "Gate2702ArmRegistration");
    if (!sameValue(receipt, embedded)) {
      fail(`registration receipt does not match trial manifest: ${path}`);
    }
    result.push(receipt);
  }
  return result;
}

function validateSubjectSnapshotFiles(plan, trial, paths) {
  const bySubject = new Map(
    trial.subjectSnapshots.map((snapshot) => [
      snapshot.subject,
      snapshot.contentDigest,
    ]),
  );
  for (const subject of plan.subjects) {
    const registration = trial.registrations.find(
      (candidate) => candidate.subject === subject,
    );
    if (!registration) fail(`missing registration for subject #${subject}`);
    const snapshot = readReceipt(
      subjectPath(paths, subject),
      "Gate2702SubjectSnapshot",
    );
    assertSubjectSnapshotIdentity(
      snapshot,
      registration,
      bySubject.get(subject),
    );
  }
}

function assertArmReceiptIdentity(receipt, registration, label) {
  if (
    !sameValue(receipt.definitionRef, registration.definitionRef) ||
    receipt.trialId !== registration.trialId ||
    receipt.subject !== registration.subject ||
    receipt.treatmentId !== registration.treatmentId ||
    receipt.attempt !== registration.attempt ||
    receipt.baseSha !== registration.baseSha
  ) {
    fail(`${label} identity does not match its arm registration`);
  }
  return receipt;
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

function retrySetPath(paths, registrationSetDigest) {
  if (!/^sha256:[0-9a-f]{64}$/.test(registrationSetDigest)) {
    fail("retry registration set has an invalid digest");
  }
  return join(
    paths.retrySets,
    `${registrationSetDigest.replace(":", "-")}.json`,
  );
}

function persistRetryRegistrationSet(trial, paths, registrations) {
  const manifest = retryRegistrationManifest(registrations);
  const registrationSetDigest = valueDigest(manifest);
  const receipt = writeImmutableReceipt(
    retrySetPath(paths, registrationSetDigest),
    {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702RetryRegistrationSet",
      definitionRef: trial.definitionRef,
      trialId: trial.trialId,
      baseSha: trial.baseSha,
      registrationSetDigest,
      registrations: manifest,
    },
  );
  return { registrations, registrationSetDigest, receipt };
}

function readRetryRegistrationState(plan, trial, paths, requireSet = true) {
  const registrations = [];
  for (const subject of plan.subjects) {
    for (const treatment of plan.treatments) {
      const path = registrationPath(paths, subject, treatment.id, 2);
      if (!existsSync(path)) continue;
      const registration = readReceipt(path, "Gate2702ArmRegistration");
      const attempt1 = trial.registrations.find(
        (candidate) =>
          candidate.subject === subject &&
          candidate.treatmentId === treatment.id,
      );
      if (!attempt1) fail("retry has no registered attempt 1");
      const classification1 = readReceipt(
        join(attempt1.runDir, "classification.json"),
        "Gate2702ArmClassification",
      );
      assertArmReceiptIdentity(
        classification1,
        attempt1,
        "retry-authorizing classification",
      );
      const retryOf = {
        attempt: 1,
        registrationDigest: attempt1.contentDigest,
        classificationDigest: classification1.contentDigest,
      };
      const expected = buildRegistration({
        definitionRef: trial.definitionRef,
        trialId: trial.trialId,
        baseSha: trial.baseSha,
        paths,
        subject,
        treatmentId: treatment.id,
        attempt: 2,
        retryOf,
      });
      if (
        classification1.registrationDigest !== attempt1.contentDigest ||
        classification1.retry?.authorized !== true ||
        !sameValue(registration, expected)
      ) {
        fail("attempt 2 registration is not authorized by attempt 1");
      }
      registrations.push(registration);
    }
  }
  const manifest = retryRegistrationManifest(registrations);
  const registrationSetDigest = valueDigest(manifest);
  let receipt = null;
  if (registrations.length > 0 && requireSet) {
    receipt = readReceipt(
      retrySetPath(paths, registrationSetDigest),
      "Gate2702RetryRegistrationSet",
    );
    if (
      !sameValue(receipt.definitionRef, trial.definitionRef) ||
      receipt.trialId !== trial.trialId ||
      receipt.baseSha !== trial.baseSha ||
      receipt.registrationSetDigest !== registrationSetDigest ||
      !sameValue(receipt.registrations, manifest)
    ) {
      fail("retry registration set receipt does not match its registrations");
    }
  }
  return { registrations, registrationSetDigest, receipt };
}

function assertLogFile(path) {
  if (!existsSync(path)) fail(`required arm log is missing: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`arm log is not a regular file: ${path}`);
  }
}

function ensureEmptyPreflightLog(path) {
  if (!existsSync(path)) {
    writeFileSync(path, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 0) {
    fail(`partial preflight-failure log is not an empty regular file: ${path}`);
  }
}

function readArmClassification(registration, terminal) {
  const path = join(registration.runDir, "classification.json");
  if (!existsSync(path)) return null;
  const classification = assertArmReceiptIdentity(
    readReceipt(path, "Gate2702ArmClassification"),
    registration,
    "classification receipt",
  );
  if (
    classification.registrationDigest !== registration.contentDigest ||
    classification.terminalDigest !== terminal.contentDigest ||
    !["succeeded", "failed", "cancelled"].includes(classification.status) ||
    typeof classification.eligible !== "boolean"
  ) {
    fail("classification receipt is not bound to its terminal arm evidence");
  }
  return classification;
}

function inspectArm(registration) {
  const runDir = registration.runDir;
  const preDispatchPath = join(runDir, "pre-dispatch.json");
  const processPath = join(runDir, "process.json");
  const terminalPath = join(runDir, "terminal.json");
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");

  try {
    if (!existsSync(preDispatchPath)) {
      if (existsSync(terminalPath) && !existsSync(processPath)) {
        const terminal = assertArmReceiptIdentity(
          readReceipt(terminalPath, "Gate2702Terminal"),
          registration,
          "terminal receipt",
        );
        if (
          terminal.outcome !== "preflight-failed" ||
          !/^sha256:[0-9a-f]{64}$/.test(terminal.preflightDigest ?? "")
        ) {
          fail(
            "terminal without pre-dispatch is not a bound preflight failure",
          );
        }
        assertLogFile(stdoutPath);
        assertLogFile(stderrPath);
        return {
          state: "terminal",
          terminal,
          classification: readArmClassification(registration, terminal),
        };
      }
      if (existsSync(processPath) || existsSync(terminalPath)) {
        fail("arm artifacts exist without a pre-dispatch receipt");
      }
      for (const path of [stdoutPath, stderrPath]) {
        if (existsSync(path)) {
          const metadata = lstatSync(path);
          if (
            !metadata.isFile() ||
            metadata.isSymbolicLink() ||
            metadata.size !== 0
          ) {
            fail("arm artifacts exist without a pre-dispatch receipt");
          }
        }
      }
      return { state: "pending" };
    }

    const preDispatch = assertArmReceiptIdentity(
      readReceipt(preDispatchPath, "Gate2702PreDispatch"),
      registration,
      "pre-dispatch receipt",
    );
    const worktreeIdentity = readOperationalWorktreeIdentity(registration);
    if (
      preDispatch.registrationDigest !== registration.contentDigest ||
      preDispatch.worktreeIdentityDigest !== worktreeIdentity.contentDigest ||
      resolve(preDispatch.cwd) !== resolve(registration.worktreePath) ||
      !Array.isArray(preDispatch.argv) ||
      preDispatch.argv.length === 0 ||
      preDispatch.argv.some((value) => typeof value !== "string" || !value) ||
      !/^sha256:[0-9a-f]{64}$/.test(preDispatch.promptDigest ?? "")
    ) {
      fail("pre-dispatch receipt is not bound to its registered invocation");
    }

    let processReceipt = null;
    if (existsSync(processPath)) {
      processReceipt = assertArmReceiptIdentity(
        readReceipt(processPath, "Gate2702Process"),
        registration,
        "process receipt",
      );
      if (
        processReceipt.registrationDigest !== registration.contentDigest ||
        processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
        !Number.isSafeInteger(processReceipt.pid) ||
        processReceipt.pid <= 1
      ) {
        fail("process receipt is not bound to its pre-dispatch receipt");
      }
      assertLogFile(stdoutPath);
      assertLogFile(stderrPath);
    }

    if (!existsSync(terminalPath)) {
      if (!processReceipt) return { state: "recovery-required" };
      return isManagedProcessActive(processReceipt.pid)
        ? { state: "active", processReceipt }
        : { state: "recovery-required" };
    }

    const terminal = assertArmReceiptIdentity(
      readReceipt(terminalPath, "Gate2702Terminal"),
      registration,
      "terminal receipt",
    );
    if (terminal.preDispatchDigest !== preDispatch.contentDigest) {
      fail("terminal receipt is not bound to its pre-dispatch receipt");
    }
    if (
      typeof terminal.durationMs !== "number" ||
      !Number.isFinite(terminal.durationMs) ||
      terminal.durationMs < 0
    ) {
      fail("dispatched terminal receipt has no monotonic duration");
    }
    if (terminal.outcome === "spawn-error") {
      if (processReceipt || terminal.processDigest !== undefined) {
        fail("spawn-error terminal unexpectedly has a process receipt");
      }
      assertLogFile(stdoutPath);
      assertLogFile(stderrPath);
      return {
        state: "terminal",
        terminal,
        classification: readArmClassification(registration, terminal),
      };
    }
    if (
      !["exited", "timed-out"].includes(terminal.outcome) ||
      !processReceipt
    ) {
      fail("terminal receipt has an invalid outcome or no process receipt");
    }
    if (terminal.processDigest !== processReceipt.contentDigest) {
      fail("terminal receipt is not bound to its process receipt");
    }
    if (isManagedProcessActive(processReceipt.pid)) {
      return { state: "active", processReceipt, terminal };
    }
    return {
      state: "terminal",
      terminal,
      processReceipt,
      classification: readArmClassification(registration, terminal),
    };
  } catch (error) {
    return { state: "recovery-required", error };
  }
}

function scanTrial(plan, trial, paths) {
  const counts = {
    registered: 0,
    pending: 0,
    active: 0,
    terminal: 0,
    classified: 0,
    recoveryRequired: 0,
  };
  let registrations;
  try {
    const baseRegistrations = validateRegistrationFiles(trial, paths);
    const retryState = readRetryRegistrationState(plan, trial, paths);
    registrations = [...baseRegistrations, ...retryState.registrations];
    validateSubjectSnapshotFiles(plan, trial, paths);
    counts.registered = registrations.length;
  } catch {
    registrations = trial.registrations;
    counts.recoveryRequired += 1;
  }

  for (const registration of registrations) {
    const arm = inspectArm(registration);
    if (arm.state === "pending") counts.pending += 1;
    else if (arm.state === "active") counts.active += 1;
    else if (arm.state === "terminal") {
      counts.terminal += 1;
      if (arm.classification) counts.classified += 1;
    } else counts.recoveryRequired += 1;
  }

  const owner = readLockOwner(paths);
  const lockActive = owner ? isOwnerActive(owner) : false;
  let state = "pending";
  if (counts.recoveryRequired > 0) state = "recovery-required";
  else if (counts.active > 0 || lockActive) state = "active";
  else if (
    counts.terminal === registrations.length &&
    counts.classified === registrations.length
  ) {
    state = "terminal";
  }
  return { state, counts };
}

function gitWorktreePaths(repoPath) {
  const output = git(repoPath, ["worktree", "list", "--porcelain"]);
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length))),
  );
}

function worktreeIdentityPath(registration) {
  return join(registration.runDir, "worktree-identity.json");
}

function assertWorktreeIdentity(receipt, registration, gitDirectory) {
  assertArmReceiptIdentity(receipt, registration, "worktree identity receipt");
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.executionMode !== registration.executionMode ||
    resolve(receipt.worktreePath) !== resolve(registration.worktreePath) ||
    resolve(receipt.gitDirectory) !== resolve(gitDirectory) ||
    !UUID_PATTERN.test(receipt.identityToken ?? "")
  ) {
    fail("worktree identity receipt is not bound to its registration");
  }
  return receipt;
}

function readOperationalWorktreeIdentity(registration) {
  const path = worktreeIdentityPath(registration);
  assertRegularReceiptFile(path);
  const receipt = readReceipt(path, "Gate2702WorktreeIdentity");
  return assertWorktreeIdentity(receipt, registration, receipt.gitDirectory);
}

function assertRegularReceiptFile(path) {
  if (!existsSync(path)) fail(`required identity receipt is missing: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`identity receipt is not a regular file: ${path}`);
  }
}

function ensureWorktreeIdentity(registration) {
  const gitDirectory = git(registration.worktreePath, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const markerPath = join(gitDirectory, "gate-2702-worktree-identity.json");
  const externalPath = worktreeIdentityPath(registration);
  const markerExists = existsSync(markerPath);
  const externalExists = existsSync(externalPath);

  if (externalExists && !markerExists) {
    fail(
      `worktree identity marker is missing; path may have been reincarnated: ${registration.worktreePath}`,
    );
  }
  if (markerExists) {
    assertRegularReceiptFile(markerPath);
    const marker = assertWorktreeIdentity(
      readReceipt(markerPath, "Gate2702WorktreeIdentity"),
      registration,
      gitDirectory,
    );
    if (externalExists) {
      assertRegularReceiptFile(externalPath);
      const external = assertWorktreeIdentity(
        readReceipt(externalPath, "Gate2702WorktreeIdentity"),
        registration,
        gitDirectory,
      );
      if (!sameValue(marker, external)) {
        fail("worktree identity marker does not match its operational receipt");
      }
    } else {
      writeImmutableReceipt(externalPath, {
        ...marker,
        contentDigest: undefined,
      });
    }
    return marker;
  }

  const undigested = {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702WorktreeIdentity",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    executionMode: gate2702ExecutionMode(),
    worktreePath: registration.worktreePath,
    gitDirectory,
    identityToken: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const marker = writeImmutableReceipt(markerPath, undigested);
  const external = writeImmutableReceipt(externalPath, undigested);
  if (!sameValue(marker, external))
    fail("could not persist one worktree identity");
  return marker;
}

function verifyWorktreeIdentity(registration) {
  const gitDirectory = git(registration.worktreePath, [
    "rev-parse",
    "--absolute-git-dir",
  ]);
  const markerPath = join(gitDirectory, "gate-2702-worktree-identity.json");
  const externalPath = worktreeIdentityPath(registration);
  assertRegularReceiptFile(markerPath);
  assertRegularReceiptFile(externalPath);
  const marker = assertWorktreeIdentity(
    readReceipt(markerPath, "Gate2702WorktreeIdentity"),
    registration,
    gitDirectory,
  );
  const external = assertWorktreeIdentity(
    readReceipt(externalPath, "Gate2702WorktreeIdentity"),
    registration,
    gitDirectory,
  );
  if (!sameValue(marker, external)) {
    fail("registered worktree was replaced after its identity was recorded");
  }
}

function ensureWorktree(repoPath, registration, worktreeRoot) {
  const path = resolve(registration.worktreePath);
  if (!isWithin(worktreeRoot, path))
    fail(`worktree escapes trial root: ${path}`);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink())
      fail(`worktree path is a symlink: ${path}`);
    const registered = gitWorktreePaths(repoPath);
    if (!registered.has(path))
      fail(`existing path is not a registered Git worktree: ${path}`);
    const head = git(path, ["rev-parse", "HEAD"]);
    if (head.toLowerCase() !== registration.baseSha.toLowerCase()) {
      fail(`worktree HEAD drifted from pinned base: ${path}`);
    }
  } else {
    mkdirSync(worktreeRoot, { recursive: true });
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        git(repoPath, [
          "worktree",
          "add",
          "--quiet",
          "--detach",
          path,
          registration.baseSha,
        ]);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!/lock|already exists/i.test(error.message)) throw error;
        const until = Date.now() + 50;
        while (Date.now() < until) {
          // Deliberately short spin: synchronous Git setup happens only before
          // model dispatch and avoids introducing a generic async job system.
        }
      }
    }
    if (lastError) throw lastError;
  }
  const head = git(path, ["rev-parse", "HEAD"]);
  if (head.toLowerCase() !== registration.baseSha.toLowerCase()) {
    fail(`new worktree did not land on pinned base: ${path}`);
  }
  ensureWorktreeIdentity(registration);
}

function armCommand(plan) {
  if (process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1") {
    const encoded = process.env.CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON;
    if (!encoded)
      fail("test mode requires CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON");
    let argv;
    try {
      argv = JSON.parse(encoded);
    } catch {
      fail("test arm command is not valid JSON");
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((arg) => typeof arg !== "string" || !arg)
    ) {
      fail("test arm command must be a non-empty JSON string array");
    }
    return argv;
  }
  return [
    "claude",
    "-p",
    "--model",
    gate2702ModelIds().worker,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--max-budget-usd",
    String(plan.costCaps.workerUsd),
  ];
}

function armEnvironment(registration, sidekickEnvironment) {
  const env = { ...process.env };
  for (const key of GATE_2702_SIDEKICK_ENV_KEYS) {
    delete env[key];
  }
  env.CHD_EXPERIMENT_2702_RUN_DIR = registration.runDir;
  env.CHD_EXPERIMENT_2702_SUBJECT = String(registration.subject);
  env.CHD_EXPERIMENT_2702_TREATMENT = registration.treatmentId;
  env.CHD_EXPERIMENT_2702_ATTEMPT = String(registration.attempt);
  env.CHD_EXPERIMENT_2702_TRIAL_ID = registration.trialId;
  env.CHD_EXPERIMENT_2702_BASE_SHA = registration.baseSha;
  Object.assign(env, sidekickEnvironment);
  return env;
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

function writeTerminal(runDir, registration, fields) {
  return writeImmutableReceipt(join(runDir, "terminal.json"), {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702Terminal",
    definitionRef: registration.definitionRef,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    ...fields,
  });
}

function writePreflightFailureArm(registration, preflight) {
  const existing = inspectArm(registration);
  if (existing.state === "terminal") return existing.terminal;
  if (existing.state !== "pending") {
    fail(
      `cannot record preflight failure over ${existing.state} arm ${registration.subject}/${registration.treatmentId}`,
    );
  }
  for (const name of ["stdout.log", "stderr.log"]) {
    ensureEmptyPreflightLog(join(registration.runDir, name));
  }
  return writeTerminal(registration.runDir, registration, {
    preflightDigest: preflight.contentDigest,
    outcome: "preflight-failed",
    exitCode: null,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    endedAt: new Date().toISOString(),
  });
}

async function executeArm(plan, paths, trial, registration) {
  const runDir = registration.runDir;
  const preDispatchPath = join(runDir, "pre-dispatch.json");
  const processPath = join(runDir, "process.json");
  const existing = inspectArm(registration);
  if (existing.state === "terminal") return;
  if (existing.state === "active") {
    fail(
      `arm ${registration.subject}/${registration.treatmentId} is already active under pid ${existing.processReceipt.pid}`,
    );
  }
  if (existing.state === "recovery-required") {
    fail(
      `arm ${registration.subject}/${registration.treatmentId}/attempt-${registration.attempt} requires recovery`,
    );
  }

  const snapshot = readReceipt(
    subjectPath(paths, registration.subject),
    "Gate2702SubjectSnapshot",
  );
  const snapshotManifest = trial.subjectSnapshots.find(
    (candidate) => candidate.subject === registration.subject,
  );
  assertSubjectSnapshotIdentity(
    snapshot,
    registration,
    snapshotManifest?.contentDigest,
  );
  const treatment = plan.treatments.find(
    (candidate) => candidate.id === registration.treatmentId,
  );
  if (!treatment) fail(`unknown treatment ${registration.treatmentId}`);
  const argv = armCommand(plan);
  const sidekickEnvironment = gate2702SidekickEnvironment(treatment);
  const environment = armEnvironment(registration, sidekickEnvironment);
  const prompt = workerPrompt(snapshot, registration);
  const worktreeIdentity = readOperationalWorktreeIdentity(registration);
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const preDispatch = writeImmutableReceipt(preDispatchPath, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702PreDispatch",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    worktreeIdentityDigest: worktreeIdentity.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    executionMode: gate2702ExecutionMode(),
    argv,
    sidekickEnvironment,
    sidekickEnvironmentDigest: valueDigest(sidekickEnvironment),
    cwd: registration.worktreePath,
    promptDigest: sha256(prompt),
    startedAt,
  });

  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  let stdoutFd;
  let stderrFd;
  try {
    stdoutFd = openSync(
      stdoutPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    stderrFd = openSync(
      stderrPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    throw error;
  }

  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: registration.worktreePath,
      env: environment,
      detached: true,
      windowsHide: true,
      stdio: ["pipe", stdoutFd, stderrFd],
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    writeTerminal(runDir, registration, {
      preDispatchDigest: preDispatch.contentDigest,
      outcome: "spawn-error",
      error: error.message,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      endedAt: new Date().toISOString(),
    });
    return;
  }
  closeSync(stdoutFd);
  closeSync(stderrFd);

  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    const spawnError = await new Promise((resolveError) => {
      child.once("error", resolveError);
    });
    writeTerminal(runDir, registration, {
      preDispatchDigest: preDispatch.contentDigest,
      outcome: "spawn-error",
      error: spawnError.message,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      endedAt: new Date().toISOString(),
    });
    return;
  }

  const processReceipt = writeImmutableReceipt(processPath, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702Process",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    pid: child.pid,
    detachedProcessGroup: process.platform !== "win32",
    startedAt,
  });

  let killTimer;
  const result = await new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      // Do not cancel a pending group SIGKILL merely because the direct child
      // exited. A descendant may still be alive in the detached process group.
      resolveResult({ ...value, timedOut });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        signalManagedProcess(child.pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH")
          finish({ exitCode: null, signal: "SIGTERM" });
      }
      killTimer = setTimeout(() => {
        try {
          signalManagedProcess(child.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH")
            finish({ exitCode: null, signal: "SIGKILL" });
        }
      }, 5_000);
      killTimer.unref?.();
    }, plan.limits.wallTimeMs);
    child.once("error", (error) =>
      finish({ exitCode: null, signal: null, error: error.message }),
    );
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE")
        finish({ exitCode: null, signal: null, error: error.message });
    });
    child.stdin.end(prompt);
  });

  const processGroupQuiescent = await quiesceManagedProcessGroup(child.pid);
  if (killTimer) clearTimeout(killTimer);

  writeTerminal(runDir, registration, {
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    outcome: result.timedOut ? "timed-out" : "exited",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    processGroupQuiescent,
    durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
    ...(result.error ? { error: result.error } : {}),
    endedAt: new Date().toISOString(),
  });
  if (!processGroupQuiescent) {
    fail(
      `arm ${registration.subject}/${registration.treatmentId} left an active process group`,
    );
  }
}

async function supervise(plan, paths, trial, token) {
  const owner = readLockOwner(paths);
  if (!owner || owner.token !== token || owner.trialId !== trial.trialId) {
    fail("supervisor could not prove trial lock ownership");
  }
  updateLock(paths, token, { phase: "supervising", pid: process.pid });
  try {
    verifyPinnedCommit(trial.repoPath, trial.baseSha);
    const status = scanTrial(plan, trial, paths);
    if (status.state === "recovery-required") {
      fail(`trial ${trial.trialId} has an arm requiring recovery`);
    }
    if (status.state === "terminal") return;

    const registrations = validateRegistrationFiles(trial, paths);
    for (const registration of registrations) {
      ensureWorktree(trial.repoPath, registration, trial.worktreeRoot);
    }
    for (const subject of plan.subjects) {
      const pairRegistrations = plan.treatments.map((treatment) => {
        const registration = registrations.find(
          (candidate) =>
            candidate.subject === subject &&
            candidate.treatmentId === treatment.id,
        );
        if (!registration)
          fail(`missing registration for #${subject}/${treatment.id}`);
        return registration;
      });
      const completedPair = pairRegistrations.every(
        (registration) => inspectArm(registration).state === "terminal",
      );
      if (completedPair) {
        for (const registration of pairRegistrations) {
          invokeClassifier(
            "classify",
            paths,
            trial.trialId,
            subject,
            registration,
          );
        }
        continue;
      }
      const preflight = invokeClassifier(
        "preflight",
        paths,
        trial.trialId,
        subject,
      );
      if (preflight.status === "failed") {
        for (const registration of pairRegistrations) {
          writePreflightFailureArm(registration, preflight);
        }
      } else if (preflight.status === "passed") {
        const results = await Promise.allSettled(
          pairRegistrations.map((registration) =>
            executeArm(plan, paths, trial, registration),
          ),
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected) throw rejected.reason;
      } else {
        fail(
          `preflight for #${subject} has invalid status ${String(preflight.status)}`,
        );
      }
      for (const registration of pairRegistrations) {
        invokeClassifier(
          "classify",
          paths,
          trial.trialId,
          subject,
          registration,
        );
      }
    }
  } finally {
    releaseLock(paths, token);
  }
}

async function superviseRetry(plan, paths, trial, registration, token) {
  const owner = readLockOwner(paths);
  if (!owner || owner.token !== token || owner.trialId !== trial.trialId) {
    fail("retry supervisor could not prove trial lock ownership");
  }
  updateLock(paths, token, { phase: "supervising", pid: process.pid });
  try {
    verifyPinnedCommit(trial.repoPath, trial.baseSha);
    ensureWorktree(trial.repoPath, registration, trial.worktreeRoot);
    if (inspectArm(registration).state === "terminal") {
      invokeClassifier(
        "classify",
        paths,
        trial.trialId,
        registration.subject,
        registration,
      );
      return;
    }
    const preflight = invokeClassifier(
      "preflight-retry",
      paths,
      trial.trialId,
      registration.subject,
      registration,
    );
    if (preflight.status === "failed") {
      writePreflightFailureArm(registration, preflight);
    } else if (preflight.status === "passed") {
      await executeArm(plan, paths, trial, registration);
    } else {
      fail(`retry preflight has invalid status ${String(preflight.status)}`);
    }
    invokeClassifier(
      "classify",
      paths,
      trial.trialId,
      registration.subject,
      registration,
    );
  } finally {
    releaseLock(paths, token);
  }
}

function spawnSupervisor(options, paths, token) {
  mkdirSync(dirname(paths.supervisorLog), { recursive: true });
  const logFd = openSync(
    paths.supervisorLog,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND,
    0o600,
  );
  const args = [
    SCRIPT_PATH,
    "__supervise",
    "--trial",
    options.trial,
    "--repo",
    options.repoPath,
    "--state-root",
    options.stateRoot,
    "--lock-token",
    token,
  ];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    fail("failed to start the detached supervisor");
  }
  child.unref();
  updateLock(paths, token, { phase: "supervising", pid: child.pid });
  return child.pid;
}

function spawnRetrySupervisor(options, paths, token) {
  mkdirSync(dirname(paths.supervisorLog), { recursive: true });
  const logFd = openSync(
    paths.supervisorLog,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND,
    0o600,
  );
  const args = [
    SCRIPT_PATH,
    "__retry",
    "--trial",
    options.trial,
    "--subject",
    String(options.subject),
    "--treatment",
    options.treatment,
    "--retry-of",
    "1",
    "--repo",
    options.repoPath,
    "--state-root",
    options.stateRoot,
    "--lock-token",
    token,
  ];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    fail("failed to start the detached retry supervisor");
  }
  child.unref();
  updateLock(paths, token, { phase: "supervising", pid: child.pid });
  return child.pid;
}

async function commandLaunch(plan, options) {
  const stateRoot = stateRootFor(options);
  const paths = pathsFor(stateRoot, plan.definitionRef, options.trial);
  let existing = readExistingTrial(plan, paths, options.trial);
  if (existing) {
    const status = scanTrial(plan, existing, paths);
    if (status.state === "terminal") {
      process.stdout.write(
        `${JSON.stringify({ trialId: options.trial, ...status })}\n`,
      );
      return;
    }
    if (status.state === "active")
      fail(`trial ${options.trial} is already active`);
    if (status.state === "recovery-required") {
      fail(`trial ${options.trial} requires recovery before it can resume`);
    }
  }

  const token = acquireLock(paths, options.trial);
  let handedOff = false;
  try {
    existing = readExistingTrial(plan, paths, options.trial);
    const repoPath = resolveRepo(options.repo || existing?.repoPath);
    if (existing && resolve(existing.repoPath) !== resolve(repoPath)) {
      fail("resume repository does not match the original trial");
    }
    assertSidekickLaunchReady(repoPath);
    const baseSha = existing ? existing.baseSha : pinOriginMaster(repoPath);
    if (existing) verifyPinnedCommit(repoPath, baseSha);
    const trial =
      existing ??
      prepareTrial({
        plan,
        paths,
        trialId: options.trial,
        repoPath,
        baseSha,
      });
    const status = scanTrial(plan, trial, paths);
    if (status.state === "terminal") {
      process.stdout.write(
        `${JSON.stringify({ trialId: options.trial, ...status })}\n`,
      );
      return;
    }
    if (status.state === "recovery-required") {
      fail(`trial ${options.trial} requires recovery before it can resume`);
    }
    const pid = spawnSupervisor(
      { trial: options.trial, repoPath, stateRoot },
      paths,
      token,
    );
    handedOff = true;
    process.stdout.write(
      `${JSON.stringify({ trialId: options.trial, state: "active", supervisorPid: pid })}\n`,
    );
    if (
      process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
      process.env.CHD_EXPERIMENT_2702_TEST_HOLD_LAUNCHER === "1"
    ) {
      await new Promise(() => {
        setInterval(() => {}, 1_000);
      });
    }
  } finally {
    if (!handedOff) releaseLock(paths, token);
  }
}

function commandStatus(plan, options) {
  const stateRoot = stateRootFor(options);
  const paths = pathsFor(stateRoot, plan.definitionRef, options.trial);
  const trial = readExistingTrial(plan, paths, options.trial);
  if (!trial) fail(`trial ${options.trial} does not exist`);
  const status = scanTrial(plan, trial, paths);
  process.stdout.write(
    `${JSON.stringify({ trialId: options.trial, ...status })}\n`,
  );
}

async function commandRetry(plan, options) {
  const stateRoot = stateRootFor(options);
  const paths = pathsFor(stateRoot, plan.definitionRef, options.trial);
  const trial = readExistingTrial(plan, paths, options.trial);
  if (!trial) fail(`trial ${options.trial} does not exist`);
  const repoPath = resolveRepo(options.repo || trial.repoPath);
  if (resolve(repoPath) !== resolve(trial.repoPath)) {
    fail("retry repository does not match the original trial");
  }
  if (options.treatment === "haiku-sonnet-sidekick") {
    assertSidekickLaunchReady(repoPath);
  }
  const token = acquireLock(paths, options.trial);
  let handedOff = false;
  try {
    if (existsSync(paths.seal) || existsSync(paths.cleanup)) {
      fail("cannot retry after the trial has been sealed or cleaned");
    }
    if (
      existsSync(
        join(
          paths.trialRoot,
          "pair-selection",
          `issue-${options.subject}.json`,
        ),
      )
    ) {
      fail("cannot retry after the subject pair has been selected");
    }
    const attempt1 = readReceipt(
      registrationPath(paths, options.subject, options.treatment, 1),
      "Gate2702ArmRegistration",
    );
    const classification1 = assertArmReceiptIdentity(
      invokeClassifier(
        "classify",
        paths,
        trial.trialId,
        options.subject,
        attempt1,
      ),
      attempt1,
      "retry-authorizing classification",
    );
    if (
      classification1.registrationDigest !== attempt1.contentDigest ||
      classification1.retry?.authorized !== true
    ) {
      fail("attempt 1 classification does not authorize a manual retry");
    }
    const retryOf = {
      attempt: 1,
      registrationDigest: attempt1.contentDigest,
      classificationDigest: classification1.contentDigest,
    };
    const expected = buildRegistration({
      definitionRef: trial.definitionRef,
      trialId: trial.trialId,
      baseSha: trial.baseSha,
      paths,
      subject: options.subject,
      treatmentId: options.treatment,
      attempt: 2,
      retryOf,
    });
    const path = registrationPath(paths, options.subject, options.treatment, 2);
    let registration;
    if (existsSync(path)) {
      registration = readReceipt(path, "Gate2702ArmRegistration");
      if (!sameValue(registration, expected)) {
        fail("existing attempt 2 registration has different immutable bytes");
      }
      const existing = inspectArm(registration);
      if (existing.state === "terminal" && existing.classification) {
        fail("attempt 2 has already completed and cannot be allocated twice");
      }
    } else {
      registration = writeImmutableReceipt(path, {
        ...expected,
        contentDigest: undefined,
      });
    }
    const retryState = readRetryRegistrationState(plan, trial, paths, false);
    persistRetryRegistrationSet(trial, paths, retryState.registrations);
    const pid = spawnRetrySupervisor(
      {
        trial: trial.trialId,
        subject: options.subject,
        treatment: options.treatment,
        repoPath,
        stateRoot,
      },
      paths,
      token,
    );
    handedOff = true;
    process.stdout.write(
      `${JSON.stringify({
        trialId: trial.trialId,
        subject: options.subject,
        treatmentId: options.treatment,
        attempt: 2,
        state: "active",
        supervisorPid: pid,
        registrationDigest: registration.contentDigest,
      })}\n`,
    );
  } finally {
    if (!handedOff) releaseLock(paths, token);
  }
}

function recoveryCommand(trialId, repoPath, stateRoot) {
  return (
    `Recovery command: CHD_EXPERIMENT_2702=1 node scripts/gate-2702/run.mjs cleanup ` +
    `--trial ${trialId} --repo ${shellQuote(repoPath)} --state-root ${shellQuote(stateRoot)}`
  );
}

function cleanupFailure(message, trialId, repoPath, stateRoot) {
  process.stderr.write(`gate-2702: recovery required: ${message}\n`);
  process.stderr.write(`${recoveryCommand(trialId, repoPath, stateRoot)}\n`);
  process.exitCode = 1;
}

function validateSeal(seal, trial, retryState) {
  verifyReceipt(seal, "Gate2702VerifiedSeal");
  if (seal.verified !== true) fail("verified seal does not authorize cleanup");
  if (!sameValue(seal.definitionRef, trial.definitionRef)) {
    fail("verified seal Definition does not match the trial");
  }
  if (seal.trialId !== trial.trialId)
    fail("verified seal trial ID does not match");
  if (seal.baseSha !== trial.baseSha)
    fail("verified seal base SHA does not match");
  if (seal.worktreeManifestDigest !== trial.worktreeManifestDigest) {
    fail("verified seal worktree manifest does not match");
  }
  if (
    retryState.registrations.length > 0 &&
    seal.retryRegistrationSetDigest !== retryState.registrationSetDigest
  ) {
    fail("verified seal does not bind the exact retry registration set");
  }
  if (
    typeof seal.sealedAt !== "string" ||
    !Number.isFinite(Date.parse(seal.sealedAt))
  ) {
    fail("verified seal has no valid sealedAt timestamp");
  }
}

function validateCleanupReceipt(receipt, trial, registrations, retryState) {
  verifyReceipt(receipt, "Gate2702Cleanup");
  if (
    !sameValue(receipt.definitionRef, trial.definitionRef) ||
    receipt.trialId !== trial.trialId ||
    receipt.baseSha !== trial.baseSha ||
    receipt.worktreeManifestDigest !== trial.worktreeManifestDigest ||
    (retryState.registrations.length > 0 &&
      receipt.retryRegistrationSetDigest !== retryState.registrationSetDigest)
  ) {
    fail("cleanup receipt identity does not match the trial");
  }
  const recordedPaths = [
    ...(receipt.removedWorktrees ?? []),
    ...(receipt.alreadyAbsentWorktrees ?? []),
  ].map((path) => resolve(path));
  const expectedPaths = registrations.map((registration) =>
    resolve(registration.worktreePath),
  );
  if (
    recordedPaths.length !== expectedPaths.length ||
    new Set(recordedPaths).size !== expectedPaths.length ||
    expectedPaths.some((path) => !recordedPaths.includes(path))
  ) {
    fail("cleanup receipt does not cover the exact registered worktree set");
  }
  return receipt;
}

function commandCleanup(plan, options) {
  const stateRoot = stateRootFor(options);
  const paths = pathsFor(stateRoot, plan.definitionRef, options.trial);
  let trial;
  let retryState;
  let registrations;
  let repoPath = resolve(options.repo || process.cwd());
  try {
    trial = readExistingTrial(plan, paths, options.trial);
    if (!trial) fail(`trial ${options.trial} does not exist`);
    repoPath = resolveRepo(options.repo || trial.repoPath);
    if (resolve(repoPath) !== resolve(trial.repoPath)) {
      fail("cleanup repository does not match the original trial");
    }
    if (!existsSync(paths.seal)) fail("verified seal is missing");
    const baseRegistrations = validateRegistrationFiles(trial, paths);
    retryState = readRetryRegistrationState(plan, trial, paths);
    registrations = [...baseRegistrations, ...retryState.registrations];
    validateSeal(readJson(paths.seal), trial, retryState);
    const status = scanTrial(plan, trial, paths);
    if (status.state !== "terminal") {
      fail(
        `trial is ${status.state}; cleanup requires every registered arm to be terminal and classified`,
      );
    }
  } catch (error) {
    cleanupFailure(error.message, options.trial, repoPath, stateRoot);
    return;
  }

  try {
    const registeredByGit = gitWorktreePaths(repoPath);
    const actions = [];
    for (const registration of registrations) {
      const path = resolve(registration.worktreePath);
      if (!isWithin(trial.worktreeRoot, path)) {
        fail(`registered worktree escapes the trial root: ${path}`);
      }
      const present = existsSync(path);
      const gitRegistered = registeredByGit.has(path);
      if (present && lstatSync(path).isSymbolicLink()) {
        fail(`registered worktree path is a symlink: ${path}`);
      }
      if (present && !gitRegistered) {
        fail(`registered path is not owned by Git worktree metadata: ${path}`);
      }
      if (gitRegistered) verifyWorktreeIdentity(registration);
      actions.push({ path, present, gitRegistered, registration });
    }

    if (existsSync(paths.cleanup)) {
      validateCleanupReceipt(
        readJson(paths.cleanup),
        trial,
        registrations,
        retryState,
      );
      if (actions.some((action) => action.present || action.gitRegistered)) {
        fail("cleanup receipt exists but a registered worktree reappeared");
      }
      process.stdout.write(
        `${JSON.stringify({ trialId: options.trial, state: "cleaned", idempotent: true })}\n`,
      );
      return;
    }

    for (const action of actions) {
      if (!action.gitRegistered) continue;
      git(repoPath, ["worktree", "remove", "--force", action.path]);
      if (existsSync(action.path))
        fail(`Git did not remove worktree ${action.path}`);
    }
    const receipt = writeImmutableReceipt(paths.cleanup, {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702Cleanup",
      definitionRef: trial.definitionRef,
      trialId: trial.trialId,
      baseSha: trial.baseSha,
      worktreeManifestDigest: trial.worktreeManifestDigest,
      ...(retryState.registrations.length > 0
        ? { retryRegistrationSetDigest: retryState.registrationSetDigest }
        : {}),
      removedWorktrees: actions
        .filter((action) => action.gitRegistered)
        .map((action) => action.path),
      alreadyAbsentWorktrees: actions
        .filter((action) => !action.gitRegistered)
        .map((action) => action.path),
      cleanedAt: new Date().toISOString(),
    });
    process.stdout.write(
      `${JSON.stringify({ trialId: options.trial, state: "cleaned", cleanupDigest: receipt.contentDigest })}\n`,
    );
  } catch (error) {
    cleanupFailure(error.message, options.trial, repoPath, stateRoot);
  }
}

async function loadDefinitionPlan() {
  await import("../register-ts.mjs");
  const definitionModule =
    await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
  const projection = definitionModule.projectGate2702C5Definition(
    definitionModule.GATE_2702_C5_DEFINITION,
  );
  if (!projection.ok) {
    fail(`checked-in #2702 Definition was rejected: ${projection.code}`);
  }
  return projection.plan;
}

async function main() {
  // The opt-in check intentionally precedes CLI parsing, Definition loading,
  // filesystem access, and every subprocess boundary.
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    process.stderr.write(
      "gate-2702 is disabled; set CHD_EXPERIMENT_2702=1 for an explicit C5 run.\n",
    );
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const plan = await loadDefinitionPlan();
  if (options.command === "launch") await commandLaunch(plan, options);
  else if (options.command === "status") commandStatus(plan, options);
  else if (options.command === "retry") await commandRetry(plan, options);
  else if (options.command === "cleanup") commandCleanup(plan, options);
  else {
    const stateRoot = stateRootFor(options);
    const paths = pathsFor(stateRoot, plan.definitionRef, options.trial);
    const trial = readExistingTrial(plan, paths, options.trial);
    if (!trial) fail(`trial ${options.trial} does not exist`);
    const repoPath = resolveRepo(options.repo || trial.repoPath);
    if (resolve(repoPath) !== resolve(trial.repoPath)) {
      fail("supervisor repository does not match the trial");
    }
    if (options.command === "__retry") {
      const registration = readReceipt(
        registrationPath(paths, options.subject, options.treatment, 2),
        "Gate2702ArmRegistration",
      );
      const retryState = readRetryRegistrationState(plan, trial, paths);
      if (
        !retryState.registrations.some(
          (candidate) => candidate.contentDigest === registration.contentDigest,
        )
      ) {
        fail("retry supervisor registration is not in the current retry set");
      }
      await superviseRetry(
        plan,
        paths,
        trial,
        registration,
        options["lock-token"],
      );
    } else {
      await supervise(plan, paths, trial, options["lock-token"]);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`gate-2702: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
