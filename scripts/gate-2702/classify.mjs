#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  GATE_2702_SIDEKICK_VERSION,
  captureGate2702BehaviorContext,
  gate2702ModelIds,
  gate2702ResolvedSidekickConfig,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";

const SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const PROBE_CAPTURE_BYTES = 256 * 1024;
const CHECK_GATE_WAIT_MS = 30_000;
const INSTALL_GATE_WAIT_MS = 30_000;
const CHECK_WRAPPER_SOURCE = String.raw`
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [gatePath, outcomePath, token, argvJson, waitMs] = process.argv.slice(1);
const writeOutcome = (value) => {
  const bytes = JSON.stringify({ token, ...value }) + "\n";
  try {
    writeFileSync(outcomePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || readFileSync(outcomePath, "utf8") !== bytes) throw error;
  }
};
const deadline = Date.now() + Number(waitMs);
const waitForGate = () => {
  if (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      writeOutcome({ exitCode: null, signal: null, spawnError: "dispatch-gate-timeout" });
      process.exitCode = 1;
      return;
    }
    setTimeout(waitForGate, 10);
    return;
  }
  if (readFileSync(gatePath, "utf8") !== token + "\n") {
    writeOutcome({ exitCode: null, signal: null, spawnError: "dispatch-gate-token-mismatch" });
    process.exitCode = 1;
    return;
  }
  const argv = JSON.parse(argvJson);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    writeOutcome(value);
    process.exitCode = value.exitCode === 0 && !value.signal && !value.spawnError ? 0 : 1;
  };
  child.once("error", (error) =>
    finish({ exitCode: null, signal: null, spawnError: error.message }),
  );
  child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
};
waitForGate();
`;
const INSTALL_WRAPPER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [gatePath, outcomePath, stdoutPath, stderrPath, token, executable, maxBytes, waitMs, timeoutMs, graceMs] = process.argv.slice(1);
const captureLimit = Number(maxBytes);
const immutable = (path, bytes) => {
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || !readFileSync(path).equals(Buffer.from(bytes))) throw error;
  }
};
const digest = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const streamState = () => ({ hash: createHash("sha256"), byteLength: 0, capturedBytes: 0, chunks: [] });
const capture = (state, chunk) => {
  state.hash.update(chunk);
  state.byteLength += chunk.length;
  if (state.capturedBytes >= captureLimit) return;
  const slice = chunk.subarray(0, captureLimit - state.capturedBytes);
  if (slice.length > 0) {
    state.chunks.push(slice);
    state.capturedBytes += slice.length;
  }
};
const finishStream = (path, state) => {
  const bytes = Buffer.concat(state.chunks, state.capturedBytes);
  immutable(path, bytes);
  return {
    byteLength: state.byteLength,
    capturedBytes: bytes.length,
    contentDigest: "sha256:" + state.hash.digest("hex"),
    capturedContentDigest: digest(bytes),
    truncated: state.byteLength > bytes.length,
  };
};
const writeOutcome = (value, stdoutState, stderrState) => {
  const stdout = finishStream(stdoutPath, stdoutState);
  const stderr = finishStream(stderrPath, stderrState);
  const bytes = Buffer.from(JSON.stringify({ token, ...value, stdout, stderr }) + "\n");
  immutable(outcomePath, bytes);
};
const emptyState = () => streamState();
const deadline = Date.now() + Number(waitMs);
const waitForGate = () => {
  if (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      writeOutcome(
        { exitCode: null, signal: null, spawnError: "dispatch-gate-timeout", durationMs: 0, timedOut: false },
        emptyState(),
        emptyState(),
      );
      process.exitCode = 1;
      return;
    }
    setTimeout(waitForGate, 10);
    return;
  }
  if (readFileSync(gatePath, "utf8") !== token + "\n") {
    writeOutcome(
      { exitCode: null, signal: null, spawnError: "dispatch-gate-token-mismatch", durationMs: 0, timedOut: false },
      emptyState(),
      emptyState(),
    );
    process.exitCode = 1;
    return;
  }
  const startedNs = process.hrtime.bigint();
  const stdoutState = streamState();
  const stderrState = streamState();
  const child = spawn(executable, ["ci"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => capture(stdoutState, chunk));
  child.stderr.on("data", (chunk) => capture(stderrState, chunk));
  let settled = false;
  let timedOut = false;
  let killTimer = null;
  const signalInstall = (signal) => {
    try {
      process.kill(process.platform === "win32" ? child.pid : -process.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  process.on("SIGTERM", () => {
    if (process.platform === "win32") signalInstall("SIGTERM");
  });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
    writeOutcome({ ...value, durationMs, timedOut }, stdoutState, stderrState);
    process.exitCode = value.exitCode === 0 && !value.signal && !value.spawnError ? 0 : 1;
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalInstall("SIGTERM");
    killTimer = setTimeout(() => signalInstall("SIGKILL"), Number(graceMs));
  }, Number(timeoutMs));
  child.once("error", (error) =>
    finish({ exitCode: null, signal: null, spawnError: error.message }),
  );
  child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
};
waitForGate();
`;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TREATMENTS = new Set(["haiku-solo", "haiku-sonnet-sidekick"]);

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
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return sha256(Buffer.from(canonicalJson(withoutDigest), "utf8"));
}

function withDigest(receipt) {
  return { ...receipt, contentDigest: receiptDigest(receipt) };
}

function verifyReceipt(receipt, kind) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt)
  ) {
    fail(`${kind} receipt is not an object`);
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.kind !== kind) {
    fail(`expected a ${kind} receipt`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(receipt.contentDigest ?? "")) {
    fail(`${kind} receipt has no content digest`);
  }
  if (receipt.contentDigest !== receiptDigest(receipt)) {
    fail(`${kind} receipt content digest does not match its bytes`);
  }
  return receipt;
}

function readJson(path) {
  if (statSync(path).size > MAX_JSON_BYTES)
    fail(`${path} exceeds the receipt limit`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readReceipt(path, kind) {
  return verifyReceipt(readJson(path), kind);
}

function writeImmutableReceipt(path, undigested) {
  const receipt = withDigest(undigested);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== bytes) {
      fail(`immutable receipt already exists with different bytes: ${path}`);
    }
  }
  return receipt;
}

function writeImmutableBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(bytes)) {
      fail(`immutable evidence already exists with different bytes: ${path}`);
    }
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (
    !["classify", "select", "preflight", "preflight-retry"].includes(command)
  ) {
    fail(
      "usage: classify.mjs <preflight|preflight-retry|classify|select> --trial <uuid> --subject <issue> [--treatment <id> --attempt <1|2>] [--state-root <path>]",
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
    const allowed = ["classify", "preflight-retry"].includes(command)
      ? ["trial", "subject", "treatment", "attempt", "state-root"]
      : ["trial", "subject", "state-root"];
    if (!allowed.includes(name)) {
      fail(`unknown option ${key}`);
    }
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!UUID_PATTERN.test(options.trial ?? ""))
    fail("--trial must be an RFC 4122 UUID");
  const subject = Number(options.subject);
  if (!Number.isSafeInteger(subject) || subject <= 0)
    fail("--subject must be an issue number");
  if (["classify", "preflight-retry"].includes(command)) {
    if (!TREATMENTS.has(options.treatment))
      fail("--treatment is not part of C5");
    const attempt = Number(options.attempt);
    if (![1, 2].includes(attempt)) fail("--attempt must be 1 or 2");
    if (command === "preflight-retry" && attempt !== 2) {
      fail("preflight-retry accepts only attempt 2");
    }
    return { ...options, subject, attempt };
  }
  return { ...options, subject };
}

async function loadPlan() {
  await import("../register-ts.mjs");
  const definition =
    await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
  const projected = definition.projectGate2702C5Definition(
    definition.GATE_2702_C5_DEFINITION,
  );
  if (!projected.ok)
    fail(`checked-in C5 Definition was rejected: ${projected.code}`);
  return projected.plan;
}

function stateRootFor(options) {
  return resolve(
    options["state-root"] ||
      process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
}

function pathsFor(plan, options) {
  const trialRoot = join(
    stateRootFor(options),
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
    preflight: join(trialRoot, "preflight", `issue-${options.subject}.json`),
    retryPreflight: join(runDir, "preflight.json"),
    runDir,
    registration: join(runDir, "registration.json"),
    preDispatch: join(runDir, "pre-dispatch.json"),
    process: join(runDir, "process.json"),
    terminal: join(runDir, "terminal.json"),
    stdout: join(runDir, "stdout.log"),
    stderr: join(runDir, "stderr.log"),
    classification: join(runDir, "classification.json"),
  };
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function resolveExecutable(program) {
  if (isAbsolute(program)) return program;
  for (const directory of String(process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, program);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return resolve(candidate);
    } catch {
      // Keep searching the explicit PATH.
    }
  }
  return null;
}

function probe(program, args, cwd, timeout = 60_000) {
  const executable = resolveExecutable(program);
  if (!executable) {
    return {
      program,
      argv: [program, ...args],
      pid: null,
      timeoutMs: timeout,
      maxBufferBytes: PROBE_CAPTURE_BYTES,
      exitCode: null,
      signal: null,
      processGroupQuiescent: true,
      error: "executable-not-found",
      stdout: "",
      stderr: "",
    };
  }
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: PROBE_CAPTURE_BYTES,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const processGroupQuiescent = Number.isSafeInteger(result.pid)
    ? quiesceManagedProcessGroupSync(result.pid)
    : true;
  return {
    program: executable,
    argv: [program, ...args],
    pid: result.pid ?? null,
    timeoutMs: timeout,
    maxBufferBytes: PROBE_CAPTURE_BYTES,
    exitCode: processGroupQuiescent ? result.status : null,
    signal: result.signal,
    processGroupQuiescent,
    ...(result.error
      ? { error: result.error.code || result.error.message }
      : !processGroupQuiescent
        ? { error: "process-group-not-quiescent" }
        : {}),
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function assertProbeReceipt(receipt, program, args, timeout, label) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !sameValue(receipt.argv, [program, ...args]) ||
    receipt.timeoutMs !== timeout ||
    receipt.maxBufferBytes !== PROBE_CAPTURE_BYTES ||
    receipt.processGroupQuiescent !== true
  ) {
    fail(`${label} probe does not record its exact command and bounds`);
  }
}

function probeEnvironment(cwd) {
  const results = {
    npm: probe("npm", ["--version"], cwd),
    claude: probe("claude", ["--version"], cwd),
    vitest: probe("npx", ["--no-install", "vitest", "--version"], cwd),
    typescript: probe("npx", ["--no-install", "tsc", "--version"], cwd),
  };
  return {
    results,
    environment: {
      node: { executable: process.execPath, version: process.version },
      npm: {
        executable: results.npm.program,
        version: results.npm.stdout,
      },
      claude: {
        executable: results.claude.program,
        version: results.claude.stdout,
      },
      vitest: {
        executable: results.vitest.program,
        version: results.vitest.stdout,
      },
      typescript: {
        executable: results.typescript.program,
        version: results.typescript.stdout,
      },
    },
  };
}

function appendEnvironmentErrors(errors, results) {
  for (const [name, result] of Object.entries(results)) {
    if (result.exitCode !== 0 || !result.stdout) {
      errors.push({ code: "tool-unavailable", tool: name });
    }
  }
}

function assertEnvironmentProbes(results, environment, label) {
  const specs = {
    npm: ["npm", ["--version"]],
    claude: ["claude", ["--version"]],
    vitest: ["npx", ["--no-install", "vitest", "--version"]],
    typescript: ["npx", ["--no-install", "tsc", "--version"]],
  };
  for (const [name, [program, args]] of Object.entries(specs)) {
    const result = results?.[name];
    assertProbeReceipt(result, program, args, 60_000, `${label} ${name}`);
    if (
      environment?.[name]?.executable !== result.program ||
      environment?.[name]?.version !== result.stdout
    ) {
      fail(`${label} ${name} environment does not match its probe`);
    }
  }
  if (
    environment?.node?.executable !== process.execPath ||
    typeof environment?.node?.version !== "string" ||
    !environment.node.version
  ) {
    fail(`${label} node environment is invalid`);
  }
}

function installTimeoutMs() {
  const testTimeout = Number(
    process.env.CHD_EXPERIMENT_2702_TEST_PREFLIGHT_INSTALL_TIMEOUT_MS,
  );
  return process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
    Number.isSafeInteger(testTimeout) &&
    testTimeout > 0
    ? testTimeout
    : 1_200_000;
}

function processGraceMs() {
  const configuredTestGrace = Number(
    process.env.CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS,
  );
  return process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
    Number.isSafeInteger(configuredTestGrace) &&
    configuredTestGrace > 0
    ? configuredTestGrace
    : 5_000;
}

function processTarget(pid) {
  return process.platform === "win32" ? pid : -pid;
}

function waitForManagedProcessExitSync(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (isManagedProcessActive(pid) && Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, 25);
  }
  return !isManagedProcessActive(pid);
}

function quiesceManagedProcessGroupSync(pid) {
  const graceMs = processGraceMs();
  if (!isManagedProcessActive(pid)) return true;
  signalManagedProcess(pid, "SIGTERM");
  if (waitForManagedProcessExitSync(pid, graceMs)) return true;
  signalManagedProcess(pid, "SIGKILL");
  return waitForManagedProcessExitSync(pid, graceMs);
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !isManagedProcessActive(pid);
}

async function quiesceManagedProcessGroup(pid) {
  const graceMs = processGraceMs();
  if (!isManagedProcessActive(pid)) return true;
  signalManagedProcess(pid, "SIGTERM");
  if (await waitForManagedProcessExit(pid, graceMs)) return true;
  signalManagedProcess(pid, "SIGKILL");
  return waitForManagedProcessExit(pid, graceMs);
}

function installPaths(registration) {
  const root = join(registration.runDir, "preflight-install");
  return {
    root,
    preDispatch: join(root, "pre-dispatch.json"),
    process: join(root, "process.json"),
    gate: join(root, "dispatch-gate"),
    outcome: join(root, "outcome.json"),
    stdout: join(root, "stdout.log"),
    stderr: join(root, "stderr.log"),
    execution: join(root, "execution.json"),
  };
}

function assertInstallPreDispatch(receipt, registration) {
  assertIdentity(receipt, registration, "npm-ci pre-dispatch");
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.program !== (receipt.executable ?? "npm") ||
    !(receipt.executable === null || isAbsolute(receipt.executable)) ||
    !sameValue(receipt.argv, ["npm", "ci"]) ||
    receipt.timeoutMs !== installTimeoutMs() ||
    receipt.maxBufferBytes !== PROBE_CAPTURE_BYTES ||
    resolve(receipt.cwd ?? "") !== resolve(registration.worktreePath) ||
    !UUID_PATTERN.test(receipt.dispatchToken ?? "") ||
    !Number.isSafeInteger(receipt.ownerPid) ||
    receipt.ownerPid <= 1 ||
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt))
  ) {
    fail("npm-ci pre-dispatch receipt is invalid");
  }
  return receipt;
}

function assertInstallProcess(receipt, preDispatch, registration) {
  assertIdentity(receipt, registration, "npm-ci process");
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.preDispatchDigest !== preDispatch.contentDigest ||
    receipt.dispatchToken !== preDispatch.dispatchToken ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 1
  ) {
    fail("npm-ci process receipt is invalid");
  }
  return receipt;
}

function validateInstallStream(stream, path, label) {
  if (
    stream === null ||
    typeof stream !== "object" ||
    stream.path !== path ||
    !Number.isSafeInteger(stream.byteLength) ||
    stream.byteLength < 0 ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    stream.capturedBytes < 0 ||
    stream.capturedBytes > PROBE_CAPTURE_BYTES ||
    stream.capturedBytes !== Math.min(stream.byteLength, PROBE_CAPTURE_BYTES) ||
    stream.truncated !== stream.byteLength > stream.capturedBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(stream.contentDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(stream.capturedContentDigest ?? "")
  ) {
    fail(`npm-ci ${label} evidence is malformed`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`npm-ci ${label} evidence is not a regular file`);
  }
  const bytes = readFileSync(path);
  const capturedDigest = sha256(bytes);
  if (
    bytes.length !== stream.capturedBytes ||
    capturedDigest !== stream.capturedContentDigest ||
    (!stream.truncated && stream.contentDigest !== capturedDigest)
  ) {
    fail(`npm-ci ${label} evidence bytes do not match their receipt`);
  }
}

function validateInstallExecution(receipt, registration) {
  assertIdentity(receipt, registration, "npm-ci execution");
  const paths = installPaths(registration);
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.program !== (receipt.executable ?? "npm") ||
    !(receipt.executable === null || isAbsolute(receipt.executable)) ||
    !sameValue(receipt.argv, ["npm", "ci"]) ||
    receipt.timeoutMs !== installTimeoutMs() ||
    receipt.maxBufferBytes !== PROBE_CAPTURE_BYTES ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.preDispatchDigest ?? "") ||
    (receipt.processDigest !== undefined &&
      !/^sha256:[0-9a-f]{64}$/.test(receipt.processDigest)) ||
    !(
      receipt.pid === null ||
      (Number.isSafeInteger(receipt.pid) && receipt.pid > 1)
    ) ||
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !(
      receipt.durationMs === null ||
      (typeof receipt.durationMs === "number" &&
        Number.isFinite(receipt.durationMs) &&
        receipt.durationMs >= 0)
    ) ||
    !(
      receipt.exitCode === null ||
      (Number.isSafeInteger(receipt.exitCode) && receipt.exitCode >= 0)
    ) ||
    !(receipt.signal === null || typeof receipt.signal === "string") ||
    typeof receipt.timedOut !== "boolean" ||
    typeof receipt.interrupted !== "boolean" ||
    receipt.interrupted !== (receipt.durationMs === null) ||
    typeof receipt.processGroupQuiescent !== "boolean" ||
    typeof receipt.truncated !== "boolean" ||
    typeof receipt.stdout !== "string" ||
    typeof receipt.stderr !== "string" ||
    (receipt.error !== undefined &&
      (typeof receipt.error !== "string" || !receipt.error))
  ) {
    fail("npm-ci execution receipt is invalid");
  }
  const preDispatch = assertInstallPreDispatch(
    readReceipt(paths.preDispatch, "Gate2702InstallPreDispatch"),
    registration,
  );
  if (
    receipt.preDispatchDigest !== preDispatch.contentDigest ||
    receipt.program !== preDispatch.program ||
    receipt.executable !== preDispatch.executable ||
    receipt.startedAt !== preDispatch.startedAt
  ) {
    fail("npm-ci execution is not bound to its pre-dispatch receipt");
  }
  if (receipt.processDigest !== undefined) {
    const processReceipt = assertInstallProcess(
      readReceipt(paths.process, "Gate2702InstallProcess"),
      preDispatch,
      registration,
    );
    if (
      receipt.processDigest !== processReceipt.contentDigest ||
      receipt.pid !== processReceipt.pid
    ) {
      fail("npm-ci execution is not bound to its process receipt");
    }
  } else if (existsSync(paths.process) || receipt.pid !== null) {
    fail("npm-ci execution omitted an existing process receipt");
  }
  validateInstallStream(receipt.stdoutEvidence, paths.stdout, "stdout");
  validateInstallStream(receipt.stderrEvidence, paths.stderr, "stderr");
  if (
    receipt.stdout !== readFileSync(paths.stdout, "utf8").trim() ||
    receipt.stderr !== readFileSync(paths.stderr, "utf8").trim() ||
    receipt.truncated !==
      (receipt.stdoutEvidence.truncated || receipt.stderrEvidence.truncated)
  ) {
    fail("npm-ci captured output does not match its execution receipt");
  }
  return receipt;
}

function validateEmbeddedInstall(embedded, registration, label) {
  const paths = installPaths(registration);
  const persisted = readReceipt(paths.execution, "Gate2702InstallExecution");
  if (!sameValue(embedded, persisted)) {
    fail(`${label} embedded npm-ci digest does not match persisted evidence`);
  }
  return validateInstallExecution(persisted, registration);
}

function capturedInstallStream(path) {
  if (!existsSync(path)) writeImmutableBytes(path, Buffer.alloc(0));
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > PROBE_CAPTURE_BYTES
  ) {
    fail(`interrupted npm-ci evidence is invalid: ${path}`);
  }
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  return {
    path,
    byteLength: bytes.length,
    capturedBytes: bytes.length,
    contentDigest: digest,
    capturedContentDigest: digest,
    truncated: false,
  };
}

function readInstallOutcome(paths, dispatchToken) {
  if (!existsSync(paths.outcome)) return null;
  const outcome = readJson(paths.outcome);
  const validStream = (stream) =>
    stream !== null &&
    typeof stream === "object" &&
    Number.isSafeInteger(stream.byteLength) &&
    stream.byteLength >= 0 &&
    Number.isSafeInteger(stream.capturedBytes) &&
    stream.capturedBytes === Math.min(stream.byteLength, PROBE_CAPTURE_BYTES) &&
    stream.truncated === stream.byteLength > stream.capturedBytes &&
    /^sha256:[0-9a-f]{64}$/.test(stream.contentDigest ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(stream.capturedContentDigest ?? "");
  if (
    outcome?.token !== dispatchToken ||
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
    !validStream(outcome.stdout) ||
    !validStream(outcome.stderr)
  ) {
    fail("npm-ci wrapper outcome is invalid");
  }
  return outcome;
}

function installStreamFromOutcome(path, stream, label) {
  const evidence = { path, ...stream };
  validateInstallStream(evidence, path, label);
  return evidence;
}

function finalizeInstallExecution(
  registration,
  preDispatch,
  processReceipt,
  {
    outcome = null,
    durationMs = null,
    wrapperExitCode = null,
    wrapperSignal = null,
    timedOut = false,
    interrupted = false,
    processGroupQuiescent = true,
    error,
  },
) {
  const paths = installPaths(registration);
  const stdoutEvidence = outcome
    ? installStreamFromOutcome(paths.stdout, outcome.stdout, "stdout")
    : capturedInstallStream(paths.stdout);
  const stderrEvidence = outcome
    ? installStreamFromOutcome(paths.stderr, outcome.stderr, "stderr")
    : capturedInstallStream(paths.stderr);
  const effectiveTimedOut = timedOut || outcome?.timedOut === true;
  const resolvedError =
    error ??
    outcome?.spawnError ??
    (interrupted
      ? "classifier-interrupted"
      : effectiveTimedOut
        ? "install-timeout"
        : outcome
          ? undefined
          : "install-wrapper-produced-no-outcome");
  const receipt = writeImmutableReceipt(paths.execution, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702InstallExecution",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    ...(processReceipt ? { processDigest: processReceipt.contentDigest } : {}),
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    program: preDispatch.program,
    executable: preDispatch.executable,
    argv: ["npm", "ci"],
    pid: processReceipt?.pid ?? null,
    timeoutMs: preDispatch.timeoutMs,
    maxBufferBytes: preDispatch.maxBufferBytes,
    startedAt: preDispatch.startedAt,
    durationMs: interrupted ? null : (outcome?.durationMs ?? durationMs),
    exitCode: interrupted ? null : (outcome?.exitCode ?? wrapperExitCode),
    signal: interrupted ? null : (outcome?.signal ?? wrapperSignal),
    timedOut: effectiveTimedOut,
    interrupted,
    processGroupQuiescent,
    truncated: stdoutEvidence.truncated || stderrEvidence.truncated,
    stdout: readFileSync(paths.stdout, "utf8").trim(),
    stderr: readFileSync(paths.stderr, "utf8").trim(),
    stdoutEvidence,
    stderrEvidence,
    ...(resolvedError ? { error: resolvedError } : {}),
  });
  return validateInstallExecution(receipt, registration);
}

async function recoverInterruptedInstall(registration, paths) {
  const preDispatch = assertInstallPreDispatch(
    readReceipt(paths.preDispatch, "Gate2702InstallPreDispatch"),
    registration,
  );
  if (
    preDispatch.ownerPid !== process.pid &&
    processExists(preDispatch.ownerPid)
  ) {
    fail(`npm ci is active under classifier pid ${preDispatch.ownerPid}`);
  }
  let processReceipt = null;
  let processGroupQuiescent = true;
  if (existsSync(paths.process)) {
    processReceipt = assertInstallProcess(
      readReceipt(paths.process, "Gate2702InstallProcess"),
      preDispatch,
      registration,
    );
  }
  const outcomePresentBeforeRecovery = existsSync(paths.outcome);
  if (processReceipt) {
    processGroupQuiescent = await quiesceManagedProcessGroup(
      processReceipt.pid,
    );
  }
  if (!processGroupQuiescent) {
    fail("interrupted npm ci left an active process group");
  }
  const outcome = readInstallOutcome(paths, preDispatch.dispatchToken);
  return finalizeInstallExecution(registration, preDispatch, processReceipt, {
    outcome,
    durationMs: outcome?.durationMs ?? null,
    interrupted: !outcomePresentBeforeRecovery,
    processGroupQuiescent,
  });
}

async function executeInstall(registration) {
  const paths = installPaths(registration);
  if (existsSync(paths.execution)) {
    return validateInstallExecution(
      readReceipt(paths.execution, "Gate2702InstallExecution"),
      registration,
    );
  }
  if (existsSync(paths.preDispatch)) {
    return recoverInterruptedInstall(registration, paths);
  }

  const executable = resolveExecutable("npm");
  const dispatchToken = randomUUID();
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const preDispatch = writeImmutableReceipt(paths.preDispatch, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702InstallPreDispatch",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    program: executable ?? "npm",
    executable,
    argv: ["npm", "ci"],
    timeoutMs: installTimeoutMs(),
    maxBufferBytes: PROBE_CAPTURE_BYTES,
    cwd: registration.worktreePath,
    dispatchToken,
    ownerPid: process.pid,
    startedAt,
  });
  if (!executable) {
    return finalizeInstallExecution(registration, preDispatch, null, {
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      error: "executable-not-found",
    });
  }

  let child = null;
  let spawnError = null;
  try {
    child = spawn(
      process.execPath,
      [
        "-e",
        INSTALL_WRAPPER_SOURCE,
        paths.gate,
        paths.outcome,
        paths.stdout,
        paths.stderr,
        dispatchToken,
        executable,
        String(PROBE_CAPTURE_BYTES),
        String(INSTALL_GATE_WAIT_MS),
        String(installTimeoutMs()),
        String(processGraceMs()),
      ],
      {
        cwd: registration.worktreePath,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch (error) {
    spawnError = error;
  }
  let processReceipt = null;
  if (Number.isSafeInteger(child?.pid) && child.pid > 1) {
    processReceipt = writeImmutableReceipt(paths.process, {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702InstallProcess",
      definitionRef: registration.definitionRef,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: registration.trialId,
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: registration.attempt,
      baseSha: registration.baseSha,
      dispatchToken,
      pid: child.pid,
    });
    writeImmutableBytes(paths.gate, Buffer.from(`${dispatchToken}\n`, "utf8"));
  }

  let timedOut = false;
  let wrapperExitCode = null;
  let wrapperSignal = null;
  let killTimer = null;
  if (child) {
    const result = await new Promise((resolveResult) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        resolveResult(value);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalManagedProcess(child.pid, "SIGTERM");
        killTimer = setTimeout(
          () => signalManagedProcess(child.pid, "SIGKILL"),
          processGraceMs(),
        );
        killTimer.unref?.();
      }, installTimeoutMs());
      child.once("error", (error) => {
        spawnError = error;
        finish({ exitCode: null, signal: null });
      });
      child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
    });
    wrapperExitCode = result.exitCode;
    wrapperSignal = result.signal;
  }
  const processGroupQuiescent = child
    ? await quiesceManagedProcessGroup(child.pid)
    : true;
  if (!processGroupQuiescent) {
    fail("npm ci left an active process group");
  }
  if (killTimer) clearTimeout(killTimer);
  const outcome = readInstallOutcome(paths, dispatchToken);
  return finalizeInstallExecution(registration, preDispatch, processReceipt, {
    outcome,
    durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
    wrapperExitCode,
    wrapperSignal,
    timedOut,
    processGroupQuiescent,
    ...(spawnError ? { error: spawnError.message } : {}),
  });
}

function readTrialLockOwner(ownerPath) {
  try {
    const owner = readJson(ownerPath);
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

function isTrialLockOwnerActive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) {
    return false;
  }
  return owner.phase === "supervising"
    ? isManagedProcessActive(owner.pid)
    : processExists(owner.pid);
}

function sameLockGeneration(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameTrialLockOwner(left, right) {
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

function reclaimStaleTrialLock(
  lockPath,
  ownerPath,
  observedOwner,
  observedGeneration,
  trialId,
) {
  const markerPath = join(lockPath, "reclaim.json");
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
    currentGeneration = statSync(lockPath);
    currentOwner = readTrialLockOwner(ownerPath);
  } catch {
    removeOwnedReclaimMarker(markerPath, token);
    return false;
  }
  if (
    !sameLockGeneration(observedGeneration, currentGeneration) ||
    !sameTrialLockOwner(observedOwner, currentOwner) ||
    (currentOwner !== null && isTrialLockOwnerActive(currentOwner))
  ) {
    removeOwnedReclaimMarker(markerPath, token);
    return false;
  }

  if (existsSync(ownerPath)) unlinkSync(ownerPath);
  const marker = readJson(markerPath);
  if (marker?.kind !== "Gate2702LockReclaim" || marker.token !== token) {
    fail(`trial ${trialId} lock reclamation ownership changed`);
  }
  unlinkSync(markerPath);
  rmdirSync(lockPath);
  return true;
}

function acquireSelectionLock(trialRoot, trialId) {
  const lockPath = join(trialRoot, "lock");
  const ownerPath = join(lockPath, "owner.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      const token = randomUUID();
      try {
        writeFileSync(
          ownerPath,
          `${JSON.stringify(
            {
              schemaVersion: SCHEMA_VERSION,
              kind: "Gate2702TrialLock",
              trialId,
              token,
              phase: "preparing",
              pid: process.pid,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        try {
          removeStaleTrialLock(lockPath, ownerPath);
        } catch {
          // A later supported command can apply the same stale-lock recovery.
        }
        throw error;
      }
      return { lockPath, ownerPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readTrialLockOwner(ownerPath);
      if (owner && isTrialLockOwnerActive(owner)) {
        fail(
          `trial ${trialId} is active; pair selection must not race execution`,
        );
      }
      let generation;
      try {
        generation = statSync(lockPath);
      } catch {
        continue;
      }
      const ageMs = Date.now() - generation.mtimeMs;
      if (!owner && ageMs < 30_000) {
        fail(`trial ${trialId} lock is being prepared`);
      }
      try {
        if (
          !reclaimStaleTrialLock(
            lockPath,
            ownerPath,
            owner,
            generation,
            trialId,
          )
        ) {
          continue;
        }
      } catch (removeError) {
        fail(
          `trial ${trialId} has an unrecoverable lock: ${removeError.message}`,
        );
      }
    }
  }
  fail(`could not acquire trial ${trialId} lock for pair selection`);
}

function releaseSelectionLock(lock) {
  try {
    const owner = readTrialLockOwner(lock.ownerPath);
    if (owner?.token !== lock.token || owner?.pid !== process.pid) return;
    unlinkSync(lock.ownerPath);
    rmdirSync(lock.lockPath);
  } catch (error) {
    process.stderr.write(
      `gate-2702 classifier: could not release trial lock: ${error.message}\n`,
    );
  }
}

function sidekickActivation(cwd) {
  const pausePath = join(process.env.HOME || homedir(), ".sidekick", "paused");
  if (existsSync(pausePath)) {
    fail("the C5 treatment cannot run while Sidekick is globally paused");
  }
  if (process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1") {
    if (process.env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_ENABLED === "0") {
      fail("the C5 treatment requires the Sidekick plugin to be enabled");
    }
    return {
      evidence: { pluginEnabled: true, globalPauseAbsent: true },
      plugin: null,
    };
  }
  const listing = probe("claude", ["plugin", "list", "--json"], cwd);
  if (
    listing.exitCode !== 0 ||
    listing.signal !== null ||
    listing.processGroupQuiescent !== true ||
    listing.error !== undefined
  ) {
    fail("could not resolve the active Claude Code plugin set for C5");
  }
  let plugins;
  try {
    plugins = JSON.parse(listing.stdout);
  } catch {
    fail("Claude Code returned malformed plugin activation evidence");
  }
  const matches = Array.isArray(plugins)
    ? plugins.filter(
        (plugin) => plugin?.id === "claude-sidekick@claude-sidekick",
      )
    : [];
  if (matches.length !== 1 || matches[0].enabled !== true) {
    fail("the C5 treatment requires the Sidekick plugin to be enabled");
  }
  return {
    evidence: { pluginEnabled: true, globalPauseAbsent: true },
    plugin: matches[0],
  };
}

function sidekickInstallation(cwd) {
  const activation = sidekickActivation(cwd);
  if (
    process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
    process.env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION
  ) {
    const version = process.env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION;
    return {
      version,
      implementationDigest: sha256(
        Buffer.from(
          canonicalJson({ fixture: "gate-2702-sidekick", version }),
          "utf8",
        ),
      ),
      activation: activation.evidence,
    };
  }
  const configRoot = resolve(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  );
  const registry = readJson(
    join(configRoot, "plugins", "installed_plugins.json"),
  );
  const installed = registry?.plugins?.["claude-sidekick@claude-sidekick"];
  if (!Array.isArray(installed) || installed.length !== 1) {
    fail(
      "the C5 treatment requires exactly one installed claude-sidekick plugin",
    );
  }
  const version = installed[0]?.version;
  const installPath = installed[0]?.installPath;
  if (
    version !== GATE_2702_SIDEKICK_VERSION ||
    typeof installPath !== "string" ||
    !isAbsolute(installPath) ||
    activation.plugin?.version !== version ||
    resolve(activation.plugin?.installPath ?? "") !== resolve(installPath)
  ) {
    fail(
      `the C5 treatment requires claude-sidekick ${GATE_2702_SIDEKICK_VERSION}`,
    );
  }
  const root = resolve(installPath);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("the installed claude-sidekick path is not a regular directory");
  }
  const relativeFiles = [
    "hooks/hooks.json",
    "scripts/sidekick-hook.mjs",
    "scripts/lib/audit.mjs",
    "scripts/lib/config.mjs",
    "scripts/lib/triggers.mjs",
  ];
  const files = relativeFiles.map((relativePath) => {
    const path = join(root, relativePath);
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 1024 * 1024
    ) {
      fail(`claude-sidekick implementation file is invalid: ${relativePath}`);
    }
    return {
      relativePath,
      contentDigest: sha256(readFileSync(path)),
    };
  });
  return {
    version,
    implementationDigest: sha256(
      Buffer.from(canonicalJson({ version, files }), "utf8"),
    ),
    activation: activation.evidence,
  };
}

function assertBehaviorContext(context, treatment, sidekick) {
  const enabled = treatment.configuration.sidekick.enabled;
  const models = gate2702ModelIds();
  const resolvedSidekickConfig = gate2702ResolvedSidekickConfig(treatment);
  if (
    context?.schemaVersion !== SCHEMA_VERSION ||
    typeof context.observedAt !== "string" ||
    !Number.isFinite(Date.parse(context.observedAt)) ||
    context.workerModelQualifiedId !== models.worker ||
    context.sidekickModelQualifiedId !== (enabled ? models.sidekick : null) ||
    context.sidekickVersion !== (enabled ? sidekick.version : null) ||
    context.sidekickImplementationDigest !==
      (enabled ? sidekick.implementationDigest : null) ||
    !sameValue(
      context.sidekickActivation,
      enabled ? sidekick.activation : null,
    ) ||
    !sameValue(context.resolvedSidekickConfig, resolvedSidekickConfig) ||
    context.resolvedSidekickConfigDigest !==
      sha256(Buffer.from(canonicalJson(resolvedSidekickConfig), "utf8")) ||
    !Array.isArray(context.instructionSources) ||
    context.instructionsDigest !==
      sha256(Buffer.from(canonicalJson(context.instructionSources), "utf8"))
  ) {
    fail(`C5 behavior context is invalid for ${treatment.id}`);
  }
  const expectedInstructionOrder = ["user", "project"];
  let previousInstructionScope = -1;
  for (const [index, source] of context.instructionSources.entries()) {
    const scopeIndex = expectedInstructionOrder.indexOf(source?.scope);
    if (
      index > 1 ||
      scopeIndex <= previousInstructionScope ||
      !/^sha256:[0-9a-f]{64}$/.test(source?.contentDigest ?? "") ||
      !Number.isSafeInteger(source?.characterLength) ||
      source.characterLength <= 0 ||
      source.characterLength > 6_000 ||
      typeof source.truncated !== "boolean"
    ) {
      fail(`C5 instruction evidence is invalid for ${treatment.id}`);
    }
    previousInstructionScope = scopeIndex;
  }
  return context;
}

function hasLiveSidekickActivation(activation) {
  return sameValue(activation, {
    pluginEnabled: true,
    globalPauseAbsent: true,
  });
}

function assertSidekickPreflightEvidence(sidekick, treatment, status, label) {
  const enabled = treatment.configuration.sidekick.enabled;
  if (!sameValue(sidekick?.configuration, treatment.configuration.sidekick)) {
    fail(`${label} Sidekick config is invalid`);
  }
  if (!enabled) {
    if (
      sidekick?.version !== null ||
      sidekick?.implementationDigest !== null ||
      sidekick?.activation !== null
    ) {
      fail(`${label} control arm contains Sidekick activation evidence`);
    }
    return;
  }
  const complete =
    sidekick?.version === GATE_2702_SIDEKICK_VERSION &&
    /^sha256:[0-9a-f]{64}$/.test(sidekick?.implementationDigest ?? "") &&
    hasLiveSidekickActivation(sidekick?.activation);
  const unavailable =
    sidekick?.version === null &&
    sidekick?.implementationDigest === null &&
    sidekick?.activation === null;
  const incompatible =
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(sidekick?.version ?? "") &&
    /^sha256:[0-9a-f]{64}$/.test(sidekick?.implementationDigest ?? "") &&
    hasLiveSidekickActivation(sidekick?.activation);
  if (
    (status === "passed" && !complete) ||
    (!complete && !unavailable && !incompatible)
  ) {
    fail(`${label} Sidekick activation evidence is invalid`);
  }
}

function captureBehaviorContext(registration, treatment, installation) {
  return captureGate2702BehaviorContext({
    cwd: registration.worktreePath,
    treatment,
    sidekickVersion: installation?.version ?? null,
    sidekickImplementationDigest: installation?.implementationDigest ?? null,
    sidekickActivation: installation?.activation ?? null,
  });
}

function assertLiveBehaviorContext(registration, treatment, recorded) {
  const installation = treatment.configuration.sidekick.enabled
    ? sidekickInstallation(registration.worktreePath)
    : null;
  const live = captureGate2702BehaviorContext({
    cwd: registration.worktreePath,
    treatment,
    sidekickVersion: installation?.version ?? null,
    sidekickImplementationDigest: installation?.implementationDigest ?? null,
    sidekickActivation: installation?.activation ?? null,
    observedAt: recorded.observedAt,
  });
  if (!sameValue(live, recorded)) {
    fail(`live C5 behavior context drifted for ${treatment.id}`);
  }
}

function validatePairPreflightReceipt(
  plan,
  trialRoot,
  trial,
  subject,
  receipt,
) {
  if (
    receipt.trialId !== trial.trialId ||
    receipt.subject !== subject ||
    receipt.baseSha !== trial.baseSha ||
    !sameValue(receipt.definitionRef, plan.definitionRef) ||
    !["passed", "failed"].includes(receipt.status)
  ) {
    fail("existing pair preflight has the wrong C5 identity or status");
  }
  const lockfileDigests = [];
  for (const treatment of plan.treatments) {
    const registration = readReceipt(
      join(
        trialRoot,
        "runs",
        `issue-${subject}`,
        treatment.id,
        "attempt-1",
        "registration.json",
      ),
      "Gate2702ArmRegistration",
    );
    const embedded = trial.registrations?.find(
      (candidate) =>
        candidate.subject === subject &&
        candidate.treatmentId === treatment.id &&
        candidate.attempt === 1,
    );
    const arm = receipt.arms?.[treatment.id];
    if (
      !embedded ||
      !sameValue(embedded, registration) ||
      arm?.treatmentId !== treatment.id ||
      arm?.attempt !== 1 ||
      arm?.registrationDigest !== registration.contentDigest ||
      resolve(arm?.worktreePath ?? "") !== resolve(registration.worktreePath) ||
      (arm?.lockfileDigest !== null &&
        !/^sha256:[0-9a-f]{64}$/.test(arm?.lockfileDigest ?? "")) ||
      arm?.environmentDigest !==
        sha256(Buffer.from(canonicalJson(arm?.environment), "utf8"))
    ) {
      fail(`existing pair preflight is invalid for ${treatment.id}`);
    }
    assertSidekickPreflightEvidence(
      arm.sidekick,
      treatment,
      receipt.status,
      `existing pair preflight for ${treatment.id}`,
    );
    if (arm.behaviorContext === null) {
      if (receipt.status === "passed") {
        fail(`passed pair preflight omitted ${treatment.id} behavior context`);
      }
    } else {
      assertBehaviorContext(arm.behaviorContext, treatment, arm.sidekick);
    }
    assertProbeReceipt(
      arm.head,
      "git",
      ["rev-parse", "HEAD"],
      60_000,
      `${treatment.id} HEAD`,
    );
    assertProbeReceipt(
      arm.lockfileClean,
      "git",
      ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
      60_000,
      `${treatment.id} lockfile cleanliness`,
    );
    assertProbeReceipt(
      arm.treeClean,
      "git",
      ["diff", "--quiet", "HEAD", "--", "."],
      60_000,
      `${treatment.id} tree cleanliness`,
    );
    assertProbeReceipt(
      arm.worktreeStatus,
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      60_000,
      `${treatment.id} worktree status`,
    );
    validateEmbeddedInstall(
      arm.install,
      registration,
      `${treatment.id} install`,
    );
    assertEnvironmentProbes(
      arm.environmentProbes,
      arm.environment,
      `${treatment.id} preflight`,
    );
    lockfileDigests.push(arm.lockfileDigest);
  }
  if (receipt.status === "passed") {
    if (
      lockfileDigests.some(
        (digest) => !/^sha256:[0-9a-f]{64}$/.test(digest ?? ""),
      ) ||
      new Set(lockfileDigests).size !== 1
    ) {
      fail("passed pair preflight lockfile digests do not match");
    }
    for (const treatment of plan.treatments) {
      const arm = receipt.arms[treatment.id];
      const sidekick = arm.sidekick;
      if (
        arm.head?.exitCode !== 0 ||
        arm.head?.processGroupQuiescent !== true ||
        arm.head?.stdout?.toLowerCase() !== trial.baseSha.toLowerCase() ||
        arm.lockfileClean?.exitCode !== 0 ||
        arm.lockfileClean?.processGroupQuiescent !== true ||
        arm.treeClean?.exitCode !== 0 ||
        arm.treeClean?.processGroupQuiescent !== true ||
        arm.worktreeStatus?.exitCode !== 0 ||
        arm.worktreeStatus?.processGroupQuiescent !== true ||
        arm.worktreeStatus?.stdout !== "" ||
        arm.install?.exitCode !== 0 ||
        arm.install?.signal !== null ||
        arm.install?.timedOut !== false ||
        arm.install?.interrupted !== false ||
        arm.install?.processGroupQuiescent !== true ||
        arm.install?.error !== undefined ||
        (treatment.configuration.sidekick.enabled &&
          (sidekick.version !== GATE_2702_SIDEKICK_VERSION ||
            !/^sha256:[0-9a-f]{64}$/.test(
              sidekick.implementationDigest ?? "",
            ) ||
            !hasLiveSidekickActivation(sidekick.activation)))
      ) {
        fail(`passed pair preflight did not prove ${treatment.id}`);
      }
      for (const tool of ["node", "npm", "claude", "vitest", "typescript"]) {
        if (
          typeof arm.environment?.[tool]?.executable !== "string" ||
          typeof arm.environment?.[tool]?.version !== "string" ||
          !arm.environment[tool].version
        ) {
          fail(`passed pair preflight is missing ${tool} for ${treatment.id}`);
        }
      }
    }
  } else if (!Array.isArray(receipt.errors) || receipt.errors.length === 0) {
    fail("failed pair preflight is missing structured errors");
  }
  if (
    receipt.environmentDigest !==
    sha256(Buffer.from(canonicalJson(receipt.environment), "utf8"))
  ) {
    fail("pair preflight environment digest does not match");
  }
  if (
    !sameValue(
      receipt.environment,
      receipt.arms[plan.treatments[0].id].environment,
    )
  ) {
    fail("pair preflight summary environment does not match its first arm");
  }
  return receipt;
}

function validateRetryPreflightReceipt(plan, paths, options, receipt) {
  const trial = readReceipt(paths.trial, "Gate2702Trial");
  const registration = readReceipt(
    paths.registration,
    "Gate2702ArmRegistration",
  );
  const treatment = plan.treatments.find(
    (candidate) => candidate.id === options.treatment,
  );
  const attempt1Dir = join(
    paths.trialRoot,
    "runs",
    `issue-${options.subject}`,
    options.treatment,
    "attempt-1",
  );
  const attempt1 = readReceipt(
    join(attempt1Dir, "registration.json"),
    "Gate2702ArmRegistration",
  );
  const classification1 = readReceipt(
    join(attempt1Dir, "classification.json"),
    "Gate2702ArmClassification",
  );
  const retryOf = {
    attempt: 1,
    registrationDigest: attempt1.contentDigest,
    classificationDigest: classification1.contentDigest,
  };
  if (
    !treatment ||
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    !plan.subjects.includes(options.subject) ||
    registration.trialId !== trial.trialId ||
    registration.subject !== options.subject ||
    registration.treatmentId !== options.treatment ||
    registration.attempt !== 2 ||
    registration.baseSha !== trial.baseSha ||
    !sameValue(registration.definitionRef, plan.definitionRef) ||
    !sameValue(registration.retryOf, retryOf) ||
    classification1.registrationDigest !== attempt1.contentDigest ||
    classification1.retry?.authorized !== true ||
    receipt.trialId !== trial.trialId ||
    receipt.subject !== options.subject ||
    receipt.treatmentId !== options.treatment ||
    receipt.attempt !== 2 ||
    receipt.baseSha !== trial.baseSha ||
    receipt.registrationDigest !== registration.contentDigest ||
    !sameValue(receipt.definitionRef, plan.definitionRef) ||
    !["passed", "failed"].includes(receipt.status)
  ) {
    fail("retry preflight has the wrong C5 identity or lineage");
  }
  if (
    (receipt.lockfileDigest !== null &&
      !/^sha256:[0-9a-f]{64}$/.test(receipt.lockfileDigest ?? "")) ||
    receipt.environmentDigest !==
      sha256(Buffer.from(canonicalJson(receipt.environment), "utf8"))
  ) {
    fail("retry preflight does not match the fixed C5 environment");
  }
  assertSidekickPreflightEvidence(
    receipt.sidekick,
    treatment,
    receipt.status,
    "retry preflight",
  );
  if (receipt.behaviorContext === null) {
    if (receipt.status === "passed") {
      fail("passed retry preflight omitted its behavior context");
    }
  } else {
    assertBehaviorContext(receipt.behaviorContext, treatment, receipt.sidekick);
  }
  assertProbeReceipt(
    receipt.head,
    "git",
    ["rev-parse", "HEAD"],
    60_000,
    "retry HEAD",
  );
  assertProbeReceipt(
    receipt.lockfileClean,
    "git",
    ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
    60_000,
    "retry lockfile cleanliness",
  );
  assertProbeReceipt(
    receipt.treeClean,
    "git",
    ["diff", "--quiet", "HEAD", "--", "."],
    60_000,
    "retry tree cleanliness",
  );
  assertProbeReceipt(
    receipt.worktreeStatus,
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    60_000,
    "retry worktree status",
  );
  validateEmbeddedInstall(receipt.install, registration, "retry install");
  assertEnvironmentProbes(
    receipt.environmentProbes,
    receipt.environment,
    "retry preflight",
  );
  if (receipt.status === "passed") {
    if (
      !/^sha256:[0-9a-f]{64}$/.test(receipt.lockfileDigest ?? "") ||
      receipt.head?.exitCode !== 0 ||
      receipt.head?.processGroupQuiescent !== true ||
      receipt.head?.stdout?.toLowerCase() !== trial.baseSha.toLowerCase() ||
      receipt.lockfileClean?.exitCode !== 0 ||
      receipt.lockfileClean?.processGroupQuiescent !== true ||
      receipt.treeClean?.exitCode !== 0 ||
      receipt.treeClean?.processGroupQuiescent !== true ||
      receipt.worktreeStatus?.exitCode !== 0 ||
      receipt.worktreeStatus?.processGroupQuiescent !== true ||
      receipt.worktreeStatus?.stdout !== "" ||
      receipt.install?.exitCode !== 0 ||
      receipt.install?.signal !== null ||
      receipt.install?.timedOut !== false ||
      receipt.install?.interrupted !== false ||
      receipt.install?.processGroupQuiescent !== true ||
      receipt.install?.error !== undefined ||
      (treatment.configuration.sidekick.enabled &&
        (receipt.sidekick?.version !== GATE_2702_SIDEKICK_VERSION ||
          !/^sha256:[0-9a-f]{64}$/.test(
            receipt.sidekick?.implementationDigest ?? "",
          ) ||
          !hasLiveSidekickActivation(receipt.sidekick?.activation)))
    ) {
      fail("passed retry preflight does not prove a fresh pinned worktree");
    }
    for (const tool of ["node", "npm", "claude", "vitest", "typescript"]) {
      if (
        typeof receipt.environment?.[tool]?.executable !== "string" ||
        typeof receipt.environment?.[tool]?.version !== "string" ||
        !receipt.environment[tool].version
      ) {
        fail(`passed retry preflight is missing ${tool} identity`);
      }
    }
  } else if (!Array.isArray(receipt.errors) || receipt.errors.length === 0) {
    fail("failed retry preflight is missing structured errors");
  }
  validateRetryRegistrationSet(plan, trial, paths, registration);
  return receipt;
}

function assertLivePairPreflight(plan, trialRoot, trial, subject, receipt) {
  if (receipt.status !== "passed") return;
  for (const treatment of plan.treatments) {
    const registration = readReceipt(
      join(
        trialRoot,
        "runs",
        `issue-${subject}`,
        treatment.id,
        "attempt-1",
        "registration.json",
      ),
      "Gate2702ArmRegistration",
    );
    const arm = receipt.arms[treatment.id];
    const lockfileDigest = sha256(
      readFileSync(join(registration.worktreePath, "package-lock.json")),
    );
    const head = probe("git", ["rev-parse", "HEAD"], registration.worktreePath);
    const lockfileClean = probe(
      "git",
      ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
      registration.worktreePath,
    );
    const treeClean = probe(
      "git",
      ["diff", "--quiet", "HEAD", "--", "."],
      registration.worktreePath,
    );
    const worktreeStatus = probe(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      registration.worktreePath,
    );
    const { results, environment } = probeEnvironment(
      registration.worktreePath,
    );
    const errors = [];
    appendEnvironmentErrors(errors, results);
    assertLiveBehaviorContext(registration, treatment, arm.behaviorContext);
    if (
      registration.baseSha !== trial.baseSha ||
      lockfileDigest !== arm.lockfileDigest ||
      head.exitCode !== 0 ||
      head.stdout.toLowerCase() !== trial.baseSha.toLowerCase() ||
      lockfileClean.exitCode !== 0 ||
      treeClean.exitCode !== 0 ||
      worktreeStatus.exitCode !== 0 ||
      worktreeStatus.stdout !== "" ||
      errors.length > 0 ||
      !sameValue(environment, arm.environment)
    ) {
      fail(`live C5 environment drifted after preflight for ${treatment.id}`);
    }
  }
}

function assertLiveRetryPreflight(plan, paths, options, receipt) {
  if (receipt.status !== "passed") return;
  const registration = readReceipt(
    paths.registration,
    "Gate2702ArmRegistration",
  );
  const treatment = plan.treatments.find(
    (candidate) => candidate.id === options.treatment,
  );
  if (!treatment) fail("retry treatment is not part of C5");
  const { results, environment } = probeEnvironment(registration.worktreePath);
  const errors = [];
  appendEnvironmentErrors(errors, results);
  const lockfileDigest = sha256(
    readFileSync(join(registration.worktreePath, "package-lock.json")),
  );
  const head = probe("git", ["rev-parse", "HEAD"], registration.worktreePath);
  const lockfileClean = probe(
    "git",
    ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
    registration.worktreePath,
  );
  const treeClean = probe(
    "git",
    ["diff", "--quiet", "HEAD", "--", "."],
    registration.worktreePath,
  );
  const worktreeStatus = probe(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    registration.worktreePath,
  );
  assertLiveBehaviorContext(registration, treatment, receipt.behaviorContext);
  if (
    errors.length > 0 ||
    !sameValue(environment, receipt.environment) ||
    lockfileDigest !== receipt.lockfileDigest ||
    head.exitCode !== 0 ||
    head.stdout.toLowerCase() !== receipt.baseSha.toLowerCase() ||
    lockfileClean.exitCode !== 0 ||
    treeClean.exitCode !== 0 ||
    worktreeStatus.exitCode !== 0 ||
    worktreeStatus.stdout !== ""
  ) {
    fail("live C5 retry environment drifted after preflight");
  }
}

async function preflightPair(plan, options) {
  const stateRoot = stateRootFor(options);
  const trialRoot = join(
    stateRoot,
    plan.definitionRef.contentDigest.replace(":", "-"),
    options.trial,
  );
  const receiptPath = join(
    trialRoot,
    "preflight",
    `issue-${options.subject}.json`,
  );
  const trial = readReceipt(join(trialRoot, "trial.json"), "Gate2702Trial");
  if (
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    !plan.subjects.includes(options.subject)
  ) {
    fail("pair preflight is not for the exact checked-in C5 trial");
  }
  if (existsSync(receiptPath)) {
    const existing = readReceipt(receiptPath, "Gate2702PairPreflight");
    const validated = validatePairPreflightReceipt(
      plan,
      trialRoot,
      trial,
      options.subject,
      existing,
    );
    assertLivePairPreflight(plan, trialRoot, trial, options.subject, validated);
    return validated;
  }
  const errors = [];
  const arms = {};
  const registrations = [];
  for (const treatment of plan.treatments) {
    const registration = readReceipt(
      join(
        trialRoot,
        "runs",
        `issue-${options.subject}`,
        treatment.id,
        "attempt-1",
        "registration.json",
      ),
      "Gate2702ArmRegistration",
    );
    const embedded = trial.registrations?.find(
      (candidate) =>
        candidate.subject === options.subject &&
        candidate.treatmentId === treatment.id &&
        candidate.attempt === 1,
    );
    if (!embedded || !sameValue(embedded, registration)) {
      fail(
        `pair preflight registration is not bound into the trial: ${treatment.id}`,
      );
    }
    registrations.push({ registration, treatment });
  }

  for (const { registration, treatment } of registrations) {
    const lockPath = join(registration.worktreePath, "package-lock.json");
    let lockfileDigest = null;
    try {
      lockfileDigest = sha256(readFileSync(lockPath));
    } catch (error) {
      errors.push({
        treatmentId: treatment.id,
        code: "lockfile-missing",
        message: error.message,
      });
    }
    const head = probe("git", ["rev-parse", "HEAD"], registration.worktreePath);
    if (
      head.exitCode !== 0 ||
      head.stdout.toLowerCase() !== trial.baseSha.toLowerCase()
    ) {
      errors.push({ treatmentId: treatment.id, code: "base-mismatch" });
    }
    const lockfileClean = probe(
      "git",
      ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
      registration.worktreePath,
    );
    if (lockfileClean.exitCode !== 0) {
      errors.push({
        treatmentId: treatment.id,
        code: "lockfile-base-mismatch",
      });
    }
    const install = await executeInstall(registration);
    if (
      install.exitCode !== 0 ||
      install.processGroupQuiescent !== true ||
      install.interrupted ||
      install.timedOut ||
      install.error !== undefined
    ) {
      errors.push({ treatmentId: treatment.id, code: "npm-ci-failed" });
    }
    if (
      lockfileDigest !== null &&
      sha256(readFileSync(lockPath)) !== lockfileDigest
    ) {
      errors.push({ treatmentId: treatment.id, code: "lockfile-mutated" });
    }
    const treeClean = probe(
      "git",
      ["diff", "--quiet", "HEAD", "--", "."],
      registration.worktreePath,
    );
    if (treeClean.exitCode !== 0) {
      errors.push({
        treatmentId: treatment.id,
        code: "tracked-tree-dirty",
      });
    }
    const worktreeStatus = probe(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      registration.worktreePath,
    );
    if (worktreeStatus.exitCode !== 0 || worktreeStatus.stdout !== "") {
      errors.push({
        treatmentId: treatment.id,
        code: "worktree-dirty",
      });
    }
    let resolvedSidekickInstallation = null;
    if (treatment.configuration.sidekick.enabled) {
      try {
        resolvedSidekickInstallation = sidekickInstallation(
          registration.worktreePath,
        );
      } catch (error) {
        errors.push({
          treatmentId: treatment.id,
          code: "sidekick-unavailable",
          message: error.message,
        });
      }
    }
    let behaviorContext = null;
    try {
      behaviorContext = captureBehaviorContext(
        registration,
        treatment,
        resolvedSidekickInstallation,
      );
    } catch (error) {
      errors.push({
        treatmentId: treatment.id,
        code: "behavior-context-unavailable",
        message: error.message,
      });
    }
    const { results, environment } = probeEnvironment(
      registration.worktreePath,
    );
    const environmentErrors = [];
    appendEnvironmentErrors(environmentErrors, results);
    errors.push(
      ...environmentErrors.map((error) => ({
        ...error,
        treatmentId: treatment.id,
      })),
    );
    arms[treatment.id] = {
      treatmentId: treatment.id,
      attempt: 1,
      registrationDigest: registration.contentDigest,
      worktreePath: registration.worktreePath,
      lockfileDigest,
      head,
      lockfileClean,
      treeClean,
      worktreeStatus,
      install,
      environment,
      environmentProbes: results,
      environmentDigest: sha256(
        Buffer.from(canonicalJson(environment), "utf8"),
      ),
      behaviorContext,
      sidekick: {
        version: resolvedSidekickInstallation?.version ?? null,
        implementationDigest:
          resolvedSidekickInstallation?.implementationDigest ?? null,
        activation: resolvedSidekickInstallation?.activation ?? null,
        configuration: treatment.configuration.sidekick,
      },
    };
  }

  const armLockfileDigests = Object.values(arms)
    .map((arm) => arm.lockfileDigest)
    .filter((digest) => digest !== null);
  if (
    armLockfileDigests.length !== plan.treatments.length ||
    new Set(armLockfileDigests).size !== 1
  ) {
    errors.push({ code: "lockfile-mismatch" });
  }

  const environment = arms[plan.treatments[0].id].environment;
  const receipt = writeImmutableReceipt(receiptPath, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702PairPreflight",
    definitionRef: plan.definitionRef,
    trialId: trial.trialId,
    subject: options.subject,
    baseSha: trial.baseSha,
    status: errors.length === 0 ? "passed" : "failed",
    arms,
    environment,
    environmentDigest: sha256(Buffer.from(canonicalJson(environment), "utf8")),
    ...(errors.length === 0 ? {} : { errors }),
  });
  return validatePairPreflightReceipt(
    plan,
    trialRoot,
    trial,
    options.subject,
    receipt,
  );
}

async function preflightRetry(plan, options) {
  const paths = pathsFor(plan, options);
  if (existsSync(paths.retryPreflight)) {
    const existing = readReceipt(
      paths.retryPreflight,
      "Gate2702RetryPreflight",
    );
    const validated = validateRetryPreflightReceipt(
      plan,
      paths,
      options,
      existing,
    );
    assertLiveRetryPreflight(plan, paths, options, validated);
    return validated;
  }
  const trial = readReceipt(paths.trial, "Gate2702Trial");
  const registration = readReceipt(
    paths.registration,
    "Gate2702ArmRegistration",
  );
  if (
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    registration.trialId !== trial.trialId ||
    registration.subject !== options.subject ||
    registration.treatmentId !== options.treatment ||
    registration.attempt !== 2 ||
    registration.baseSha !== trial.baseSha ||
    !sameValue(registration.definitionRef, plan.definitionRef)
  ) {
    fail("retry preflight registration has the wrong C5 identity");
  }
  const attempt1Dir = join(
    paths.trialRoot,
    "runs",
    `issue-${options.subject}`,
    options.treatment,
    "attempt-1",
  );
  const attempt1 = readReceipt(
    join(attempt1Dir, "registration.json"),
    "Gate2702ArmRegistration",
  );
  const classification1 = readReceipt(
    join(attempt1Dir, "classification.json"),
    "Gate2702ArmClassification",
  );
  if (
    classification1.registrationDigest !== attempt1.contentDigest ||
    classification1.retry?.authorized !== true ||
    !sameValue(registration.retryOf, {
      attempt: 1,
      registrationDigest: attempt1.contentDigest,
      classificationDigest: classification1.contentDigest,
    })
  ) {
    fail("retry preflight is not authorized by attempt 1");
  }
  const treatment = plan.treatments.find(
    (candidate) => candidate.id === options.treatment,
  );
  if (!treatment) fail("retry treatment is not part of C5");
  const errors = [];
  let lockfileDigest = null;
  try {
    lockfileDigest = sha256(
      readFileSync(join(registration.worktreePath, "package-lock.json")),
    );
  } catch (error) {
    errors.push({ code: "lockfile-missing", message: error.message });
  }
  const head = probe("git", ["rev-parse", "HEAD"], registration.worktreePath);
  if (
    head.exitCode !== 0 ||
    head.stdout.toLowerCase() !== trial.baseSha.toLowerCase()
  ) {
    errors.push({ code: "base-mismatch" });
  }
  const lockfileClean = probe(
    "git",
    ["diff", "--quiet", "HEAD", "--", "package-lock.json"],
    registration.worktreePath,
  );
  if (lockfileClean.exitCode !== 0) {
    errors.push({ code: "lockfile-base-mismatch" });
  }
  const install = await executeInstall(registration);
  if (
    install.exitCode !== 0 ||
    install.processGroupQuiescent !== true ||
    install.interrupted ||
    install.timedOut ||
    install.error !== undefined
  ) {
    errors.push({ code: "npm-ci-failed" });
  }
  if (
    lockfileDigest !== null &&
    sha256(
      readFileSync(join(registration.worktreePath, "package-lock.json")),
    ) !== lockfileDigest
  ) {
    errors.push({ code: "lockfile-mutated" });
  }
  const treeClean = probe(
    "git",
    ["diff", "--quiet", "HEAD", "--", "."],
    registration.worktreePath,
  );
  if (treeClean.exitCode !== 0) {
    errors.push({ code: "tracked-tree-dirty" });
  }
  const worktreeStatus = probe(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    registration.worktreePath,
  );
  if (worktreeStatus.exitCode !== 0 || worktreeStatus.stdout !== "") {
    errors.push({ code: "worktree-dirty" });
  }
  const { results, environment } = probeEnvironment(registration.worktreePath);
  appendEnvironmentErrors(errors, results);
  let resolvedSidekickInstallation = null;
  if (treatment.configuration.sidekick.enabled) {
    try {
      resolvedSidekickInstallation = sidekickInstallation(
        registration.worktreePath,
      );
    } catch (error) {
      errors.push({ code: "sidekick-unavailable", message: error.message });
    }
  }
  let behaviorContext = null;
  try {
    behaviorContext = captureBehaviorContext(
      registration,
      treatment,
      resolvedSidekickInstallation,
    );
  } catch (error) {
    errors.push({
      code: "behavior-context-unavailable",
      message: error.message,
    });
  }
  const receipt = writeImmutableReceipt(paths.retryPreflight, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702RetryPreflight",
    definitionRef: plan.definitionRef,
    trialId: trial.trialId,
    subject: options.subject,
    treatmentId: options.treatment,
    attempt: 2,
    baseSha: trial.baseSha,
    registrationDigest: registration.contentDigest,
    lockfileDigest,
    head,
    lockfileClean,
    treeClean,
    worktreeStatus,
    install,
    behaviorContext,
    sidekick: {
      version: resolvedSidekickInstallation?.version ?? null,
      implementationDigest:
        resolvedSidekickInstallation?.implementationDigest ?? null,
      activation: resolvedSidekickInstallation?.activation ?? null,
      configuration: treatment.configuration.sidekick,
    },
    environment,
    environmentProbes: results,
    environmentDigest: sha256(Buffer.from(canonicalJson(environment), "utf8")),
    status: errors.length === 0 ? "passed" : "failed",
    ...(errors.length === 0 ? {} : { errors }),
  });
  return validateRetryPreflightReceipt(plan, paths, options, receipt);
}

function assertIdentity(receipt, registration, label) {
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
      const attempt2Dir = join(
        paths.trialRoot,
        "runs",
        `issue-${subject}`,
        treatment.id,
        "attempt-2",
      );
      const attempt2Path = join(attempt2Dir, "registration.json");
      if (!existsSync(attempt2Path)) continue;
      const attempt2 = readReceipt(attempt2Path, "Gate2702ArmRegistration");
      const attempt1 = trial.registrations?.find(
        (candidate) =>
          candidate.subject === subject &&
          candidate.treatmentId === treatment.id &&
          candidate.attempt === 1,
      );
      if (!attempt1) fail("retry registration has no trial-bound attempt 1");
      const attempt1Dir = join(
        paths.trialRoot,
        "runs",
        `issue-${subject}`,
        treatment.id,
        "attempt-1",
      );
      const classification1 = readReceipt(
        join(attempt1Dir, "classification.json"),
        "Gate2702ArmClassification",
      );
      const retryOf = {
        attempt: 1,
        registrationDigest: attempt1.contentDigest,
        classificationDigest: classification1.contentDigest,
      };
      if (
        resolve(attempt1.runDir) !== resolve(attempt1Dir) ||
        attempt1.baseSha !== trial.baseSha ||
        !sameValue(attempt1.definitionRef, plan.definitionRef) ||
        attempt2.trialId !== trial.trialId ||
        attempt2.subject !== subject ||
        attempt2.treatmentId !== treatment.id ||
        attempt2.attempt !== 2 ||
        attempt2.baseSha !== trial.baseSha ||
        resolve(attempt2.runDir) !== resolve(attempt2Dir) ||
        resolve(attempt2.worktreePath) !==
          resolve(
            join(
              paths.trialRoot,
              "worktrees",
              `issue-${subject}.${treatment.id}.attempt-2`,
            ),
          ) ||
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
  const registrationSetDigest = sha256(
    Buffer.from(canonicalJson(manifest), "utf8"),
  );
  const receipt = readReceipt(
    join(
      paths.trialRoot,
      "retries",
      "sets",
      `${registrationSetDigest.replace(":", "-")}.json`,
    ),
    "Gate2702RetryRegistrationSet",
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

function validateEvidence(plan, options, paths) {
  const trial = readReceipt(paths.trial, "Gate2702Trial");
  if (
    trial.trialId !== options.trial ||
    !["production", "test"].includes(trial.executionMode) ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    !plan.subjects.includes(options.subject)
  ) {
    fail("trial is not the exact checked-in C5 experiment");
  }
  const registration = readReceipt(
    paths.registration,
    "Gate2702ArmRegistration",
  );
  assertIdentity(registration, registration, "registration");
  if (
    registration.trialId !== options.trial ||
    registration.subject !== options.subject ||
    registration.treatmentId !== options.treatment ||
    registration.attempt !== options.attempt ||
    registration.executionMode !== trial.executionMode ||
    !sameValue(registration.definitionRef, plan.definitionRef)
  ) {
    fail("requested arm does not match its registration");
  }
  const embedded = trial.registrations?.find(
    (candidate) =>
      candidate.subject === options.subject &&
      candidate.treatmentId === options.treatment &&
      candidate.attempt === options.attempt,
  );
  if (options.attempt === 1) {
    if (!embedded || !sameValue(embedded, registration)) {
      fail("registration is not bound into the trial receipt");
    }
  } else {
    const attempt1Dir = join(
      paths.trialRoot,
      "runs",
      `issue-${options.subject}`,
      options.treatment,
      "attempt-1",
    );
    const attempt1 = readReceipt(
      join(attempt1Dir, "registration.json"),
      "Gate2702ArmRegistration",
    );
    const classification1 = readReceipt(
      join(attempt1Dir, "classification.json"),
      "Gate2702ArmClassification",
    );
    if (
      classification1.registrationDigest !== attempt1.contentDigest ||
      classification1.retry?.authorized !== true ||
      !sameValue(registration.retryOf, {
        attempt: 1,
        registrationDigest: attempt1.contentDigest,
        classificationDigest: classification1.contentDigest,
      })
    ) {
      fail(
        "attempt 2 is not authorized by the immutable attempt 1 classification",
      );
    }
  }
  const preflight =
    options.attempt === 1
      ? validatePairPreflightReceipt(
          plan,
          paths.trialRoot,
          trial,
          options.subject,
          readReceipt(paths.preflight, "Gate2702PairPreflight"),
        )
      : validateRetryPreflightReceipt(
          plan,
          paths,
          options,
          readReceipt(paths.retryPreflight, "Gate2702RetryPreflight"),
        );
  if (
    preflight.trialId !== trial.trialId ||
    preflight.subject !== options.subject ||
    preflight.baseSha !== trial.baseSha ||
    !sameValue(preflight.definitionRef, plan.definitionRef) ||
    (options.attempt === 1
      ? preflight.arms?.[options.treatment]?.registrationDigest
      : preflight.registrationDigest) !== registration.contentDigest
  ) {
    fail("pair preflight is not bound to the registered arm");
  }
  const expectedTreatment = plan.treatments.find(
    (candidate) => candidate.id === options.treatment,
  );
  const recordedSidekick =
    options.attempt === 1
      ? preflight.arms?.[options.treatment]?.sidekick
      : preflight.sidekick;
  if (
    !expectedTreatment ||
    !sameValue(
      recordedSidekick?.configuration,
      expectedTreatment.configuration.sidekick,
    ) ||
    (expectedTreatment.configuration.sidekick.enabled &&
      (typeof recordedSidekick?.version !== "string" ||
        !recordedSidekick.version)) ||
    (!expectedTreatment.configuration.sidekick.enabled &&
      recordedSidekick?.version !== null)
  ) {
    fail("preflight Sidekick configuration does not match the C5 Definition");
  }
  const terminal = readReceipt(paths.terminal, "Gate2702Terminal");
  assertIdentity(terminal, registration, "terminal receipt");
  if (preflight.status === "passed") {
    const preDispatch = readReceipt(paths.preDispatch, "Gate2702PreDispatch");
    const expectedSidekickEnvironment =
      gate2702SidekickEnvironment(expectedTreatment);
    if (
      preDispatch.registrationDigest !== registration.contentDigest ||
      preDispatch.executionMode !== trial.executionMode ||
      resolve(preDispatch.cwd ?? "") !== resolve(registration.worktreePath) ||
      !Array.isArray(preDispatch.argv) ||
      preDispatch.argv.length === 0 ||
      preDispatch.argv.some(
        (argument) => typeof argument !== "string" || !argument,
      ) ||
      !sameValue(
        preDispatch.sidekickEnvironment,
        expectedSidekickEnvironment,
      ) ||
      preDispatch.sidekickEnvironmentDigest !==
        sha256(
          Buffer.from(canonicalJson(expectedSidekickEnvironment), "utf8"),
        ) ||
      terminal.preDispatchDigest !== preDispatch.contentDigest
    ) {
      fail("arm dispatch is not bound to the fixed C5 environment");
    }
    if (
      trial.executionMode === "production" &&
      !sameValue(preDispatch.argv, [
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
      ])
    ) {
      fail("production C5 dispatch used an unregistered worker invocation");
    }
    if (terminal.outcome === "spawn-error") {
      if (existsSync(paths.process) || terminal.processDigest !== undefined) {
        fail("spawn-error terminal unexpectedly has process evidence");
      }
    } else {
      const processReceipt = readReceipt(paths.process, "Gate2702Process");
      if (
        processReceipt.registrationDigest !== registration.contentDigest ||
        processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
        terminal.processDigest !== processReceipt.contentDigest ||
        !Number.isSafeInteger(processReceipt.pid) ||
        processReceipt.pid <= 1
      ) {
        fail("arm process evidence is not bound to its C5 dispatch");
      }
    }
  }
  if (
    preflight.status === "passed" &&
    (typeof terminal.durationMs !== "number" ||
      !Number.isFinite(terminal.durationMs) ||
      terminal.durationMs < 0)
  ) {
    fail("dispatched C5 terminal has no monotonic duration");
  }
  const behaviorContext =
    options.attempt === 1
      ? preflight.arms?.[options.treatment]?.behaviorContext
      : preflight.behaviorContext;
  return {
    trial,
    registration,
    preflight,
    terminal,
    treatment: expectedTreatment,
    behaviorContext,
  };
}

function artifact(path) {
  const byteLength = statSync(path).size;
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    path,
    byteLength,
    contentDigest: `sha256:${hash.digest("hex")}`,
    capturedBytes: Math.min(byteLength, MAX_CAPTURE_BYTES),
    truncated: byteLength > MAX_CAPTURE_BYTES,
  };
}

function validateCheckStream(stream, path, label) {
  if (
    stream === null ||
    typeof stream !== "object" ||
    stream.path !== path ||
    !Number.isSafeInteger(stream.byteLength) ||
    stream.byteLength < 0 ||
    !Number.isSafeInteger(stream.capturedBytes) ||
    stream.capturedBytes !== Math.min(stream.byteLength, MAX_CAPTURE_BYTES) ||
    stream.truncated !== stream.byteLength > MAX_CAPTURE_BYTES ||
    !/^sha256:[0-9a-f]{64}$/.test(stream.contentDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(stream.capturedContentDigest ?? "")
  ) {
    fail(`${label} check evidence is malformed`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} check evidence is not a regular file`);
  }
  const bytes = readFileSync(path);
  const capturedDigest = sha256(bytes);
  if (
    bytes.length !== stream.capturedBytes ||
    capturedDigest !== stream.capturedContentDigest ||
    (!stream.truncated && stream.contentDigest !== capturedDigest)
  ) {
    fail(`${label} check evidence bytes do not match their receipt`);
  }
}

function checkResultFromEvidence(evidence) {
  return {
    checkId: evidence.checkId,
    status:
      evidence.exitCode === 0 &&
      evidence.signal === null &&
      evidence.spawnError === undefined &&
      evidence.timedOut === false &&
      evidence.interrupted === false &&
      evidence.processGroupQuiescent === true
        ? "passed"
        : "failed",
    evidenceDigest: evidence.contentDigest,
    exitCode: evidence.exitCode,
    signal: evidence.signal,
    timedOut: evidence.timedOut,
    interrupted: evidence.interrupted,
    environmentDigest: evidence.environmentDigest,
    ...(evidence.environmentErrors
      ? { environmentErrors: evidence.environmentErrors }
      : {}),
    processGroupQuiescent: evidence.processGroupQuiescent,
    truncated: evidence.truncated,
    ...(evidence.spawnError ? { spawnError: evidence.spawnError } : {}),
  };
}

function validateCheckExecution(
  evidence,
  check,
  registration,
  effectiveTimeoutMs,
  stdoutPath,
  stderrPath,
) {
  assertIdentity(evidence, registration, "declared check receipt");
  const expectedTestTimeout =
    effectiveTimeoutMs === check.timeoutMs ? undefined : effectiveTimeoutMs;
  if (
    evidence.registrationDigest !== registration.contentDigest ||
    evidence.checkId !== check.id ||
    !sameValue(evidence.argv, check.argv) ||
    evidence.timeoutMs !== check.timeoutMs ||
    evidence.testEffectiveTimeoutMs !== expectedTestTimeout ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.preDispatchDigest ?? "") ||
    (evidence.processDigest !== undefined &&
      !/^sha256:[0-9a-f]{64}$/.test(evidence.processDigest)) ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.environmentDigest ?? "") ||
    typeof evidence.startedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.startedAt)) ||
    !(
      evidence.durationMs === null ||
      (typeof evidence.durationMs === "number" &&
        Number.isFinite(evidence.durationMs) &&
        evidence.durationMs >= 0)
    ) ||
    !(
      evidence.exitCode === null ||
      (Number.isSafeInteger(evidence.exitCode) && evidence.exitCode >= 0)
    ) ||
    !(evidence.signal === null || typeof evidence.signal === "string") ||
    typeof evidence.timedOut !== "boolean" ||
    typeof evidence.interrupted !== "boolean" ||
    evidence.interrupted !== (evidence.durationMs === null) ||
    typeof evidence.processGroupQuiescent !== "boolean" ||
    typeof evidence.truncated !== "boolean" ||
    (evidence.spawnError !== undefined &&
      (typeof evidence.spawnError !== "string" || !evidence.spawnError))
  ) {
    fail(`declared check receipt is invalid for ${check.id}`);
  }
  const paths = checkPaths(registration, check);
  const preDispatch = assertCheckPreDispatch(
    readReceipt(paths.preDispatch, "Gate2702CheckPreDispatch"),
    check,
    registration,
    effectiveTimeoutMs,
  );
  if (
    evidence.preDispatchDigest !== preDispatch.contentDigest ||
    evidence.environmentDigest !== preDispatch.environmentDigest ||
    !sameValue(evidence.environment, preDispatch.environment) ||
    !sameValue(evidence.environmentProbes, preDispatch.environmentProbes) ||
    !sameValue(evidence.environmentErrors, preDispatch.environmentErrors) ||
    evidence.startedAt !== preDispatch.startedAt
  ) {
    fail(`declared check receipt is not bound to pre-dispatch for ${check.id}`);
  }
  if (evidence.processDigest !== undefined) {
    const processReceipt = assertCheckProcess(
      readReceipt(paths.process, "Gate2702CheckProcess"),
      preDispatch,
      registration,
    );
    if (evidence.processDigest !== processReceipt.contentDigest) {
      fail(
        `declared check receipt is not bound to its process for ${check.id}`,
      );
    }
  }
  validateCheckStream(evidence.stdout, stdoutPath, `${check.id} stdout`);
  validateCheckStream(evidence.stderr, stderrPath, `${check.id} stderr`);
  if (
    evidence.truncated !==
    (evidence.stdout.truncated || evidence.stderr.truncated)
  ) {
    fail(`declared check truncation summary is invalid for ${check.id}`);
  }
  return checkResultFromEvidence(evidence);
}

function checkPaths(registration, check) {
  const slug = check.id.replaceAll("/", "_");
  const root = join(registration.runDir, "checks");
  return {
    receipt: join(root, `${slug}.json`),
    preDispatch: join(root, `${slug}.pre-dispatch.json`),
    process: join(root, `${slug}.process.json`),
    gate: join(root, `${slug}.dispatch-gate`),
    outcome: join(root, `${slug}.outcome.json`),
    stdout: join(root, `${slug}.stdout.log`),
    stderr: join(root, `${slug}.stderr.log`),
  };
}

function assertCheckPreDispatch(
  receipt,
  check,
  registration,
  effectiveTimeoutMs,
) {
  assertIdentity(receipt, registration, "declared check pre-dispatch");
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.checkId !== check.id ||
    !sameValue(receipt.argv, check.argv) ||
    receipt.timeoutMs !== check.timeoutMs ||
    receipt.testEffectiveTimeoutMs !==
      (effectiveTimeoutMs === check.timeoutMs
        ? undefined
        : effectiveTimeoutMs) ||
    resolve(receipt.cwd ?? "") !== resolve(registration.worktreePath) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.environmentDigest ?? "") ||
    receipt.environmentDigest !==
      sha256(Buffer.from(canonicalJson(receipt.environment), "utf8")) ||
    (receipt.environmentErrors !== undefined &&
      !Array.isArray(receipt.environmentErrors)) ||
    !UUID_PATTERN.test(receipt.dispatchToken ?? "") ||
    !Number.isSafeInteger(receipt.ownerPid) ||
    receipt.ownerPid <= 1 ||
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt))
  ) {
    fail(`declared check pre-dispatch is invalid for ${check.id}`);
  }
  assertEnvironmentProbes(
    receipt.environmentProbes,
    receipt.environment,
    `${check.id} dispatch`,
  );
  return receipt;
}

function assertCheckProcess(receipt, preDispatch, registration) {
  assertIdentity(receipt, registration, "declared check process");
  if (
    receipt.registrationDigest !== registration.contentDigest ||
    receipt.preDispatchDigest !== preDispatch.contentDigest ||
    receipt.checkId !== preDispatch.checkId ||
    receipt.dispatchToken !== preDispatch.dispatchToken ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 1
  ) {
    fail(`declared check process is invalid for ${preDispatch.checkId}`);
  }
  return receipt;
}

function capturedStreamEvidence(path) {
  if (!existsSync(path)) writeImmutableBytes(path, Buffer.alloc(0));
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_CAPTURE_BYTES
  ) {
    fail(`interrupted check evidence is invalid: ${path}`);
  }
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  return {
    path,
    byteLength: bytes.length,
    capturedBytes: bytes.length,
    contentDigest: digest,
    capturedContentDigest: digest,
    truncated: false,
  };
}

async function recoverInterruptedCheck(
  check,
  registration,
  effectiveTimeoutMs,
  paths,
) {
  const preDispatch = assertCheckPreDispatch(
    readReceipt(paths.preDispatch, "Gate2702CheckPreDispatch"),
    check,
    registration,
    effectiveTimeoutMs,
  );
  if (
    preDispatch.ownerPid !== process.pid &&
    processExists(preDispatch.ownerPid)
  ) {
    fail(
      `declared check ${check.id} is active under pid ${preDispatch.ownerPid}`,
    );
  }
  let processReceipt = null;
  let processGroupQuiescent = true;
  if (existsSync(paths.process)) {
    processReceipt = assertCheckProcess(
      readReceipt(paths.process, "Gate2702CheckProcess"),
      preDispatch,
      registration,
    );
    processGroupQuiescent = await quiesceManagedProcessGroup(
      processReceipt.pid,
    );
  }
  if (!processGroupQuiescent) {
    fail(`interrupted declared check ${check.id} left an active process group`);
  }
  const stdout = capturedStreamEvidence(paths.stdout);
  const stderr = capturedStreamEvidence(paths.stderr);
  const evidence = writeImmutableReceipt(paths.receipt, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702CheckExecution",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    ...(processReceipt ? { processDigest: processReceipt.contentDigest } : {}),
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    checkId: check.id,
    argv: [...check.argv],
    timeoutMs: check.timeoutMs,
    ...(effectiveTimeoutMs === check.timeoutMs
      ? {}
      : { testEffectiveTimeoutMs: effectiveTimeoutMs }),
    environmentDigest: preDispatch.environmentDigest,
    environment: preDispatch.environment,
    environmentProbes: preDispatch.environmentProbes,
    ...(preDispatch.environmentErrors
      ? { environmentErrors: preDispatch.environmentErrors }
      : {}),
    startedAt: preDispatch.startedAt,
    durationMs: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    interrupted: true,
    processGroupQuiescent,
    truncated: false,
    stdout,
    stderr,
    spawnError: "classifier-interrupted",
  });
  return validateCheckExecution(
    evidence,
    check,
    registration,
    effectiveTimeoutMs,
    paths.stdout,
    paths.stderr,
  );
}

async function executeCheck(check, registration) {
  const testTimeout = Number(
    process.env.CHD_EXPERIMENT_2702_TEST_CHECK_TIMEOUT_MS,
  );
  const effectiveTimeoutMs =
    process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" &&
    Number.isSafeInteger(testTimeout) &&
    testTimeout > 0
      ? testTimeout
      : check.timeoutMs;
  const paths = checkPaths(registration, check);
  if (existsSync(paths.receipt)) {
    return validateCheckExecution(
      readReceipt(paths.receipt, "Gate2702CheckExecution"),
      check,
      registration,
      effectiveTimeoutMs,
      paths.stdout,
      paths.stderr,
    );
  }
  if (existsSync(paths.preDispatch)) {
    return recoverInterruptedCheck(
      check,
      registration,
      effectiveTimeoutMs,
      paths,
    );
  }

  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const dispatchToken = randomUUID();
  const { results: checkEnvironmentProbes, environment: checkEnvironment } =
    probeEnvironment(registration.worktreePath);
  const checkEnvironmentErrors = [];
  appendEnvironmentErrors(checkEnvironmentErrors, checkEnvironmentProbes);
  const checkEnvironmentDigest = sha256(
    Buffer.from(canonicalJson(checkEnvironment), "utf8"),
  );
  const preDispatch = writeImmutableReceipt(paths.preDispatch, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702CheckPreDispatch",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    checkId: check.id,
    argv: [...check.argv],
    timeoutMs: check.timeoutMs,
    ...(effectiveTimeoutMs === check.timeoutMs
      ? {}
      : { testEffectiveTimeoutMs: effectiveTimeoutMs }),
    cwd: registration.worktreePath,
    environment: checkEnvironment,
    environmentProbes: checkEnvironmentProbes,
    environmentDigest: checkEnvironmentDigest,
    ...(checkEnvironmentErrors.length === 0
      ? {}
      : { environmentErrors: checkEnvironmentErrors }),
    dispatchToken,
    ownerPid: process.pid,
    startedAt,
  });

  let child;
  let spawnError;
  try {
    child = spawn(
      process.execPath,
      [
        "-e",
        CHECK_WRAPPER_SOURCE,
        paths.gate,
        paths.outcome,
        dispatchToken,
        JSON.stringify(check.argv),
        String(CHECK_GATE_WAIT_MS),
      ],
      {
        cwd: registration.worktreePath,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch (error) {
    spawnError = error;
  }
  let processReceipt = null;
  if (Number.isSafeInteger(child?.pid) && child.pid > 1) {
    processReceipt = writeImmutableReceipt(paths.process, {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702CheckProcess",
      definitionRef: registration.definitionRef,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: registration.trialId,
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: registration.attempt,
      baseSha: registration.baseSha,
      checkId: check.id,
      dispatchToken,
      pid: child.pid,
    });
    writeImmutableBytes(paths.gate, Buffer.from(`${dispatchToken}\n`, "utf8"));
  }

  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutCaptured = 0;
  let stderrCaptured = 0;
  const capture = (chunk, hash, chunks, captured, setCaptured, addBytes) => {
    hash.update(chunk);
    addBytes(chunk.length);
    if (captured >= MAX_CAPTURE_BYTES) return;
    const remaining = MAX_CAPTURE_BYTES - captured;
    const slice = chunk.subarray(0, remaining);
    if (slice.length > 0) {
      chunks.push(slice);
      setCaptured(captured + slice.length);
    }
  };
  child?.stdout?.on("data", (chunk) =>
    capture(
      chunk,
      stdoutHash,
      stdoutChunks,
      stdoutCaptured,
      (value) => {
        stdoutCaptured = value;
      },
      (value) => {
        stdoutBytes += value;
      },
    ),
  );
  child?.stderr?.on("data", (chunk) =>
    capture(
      chunk,
      stderrHash,
      stderrChunks,
      stderrCaptured,
      (value) => {
        stderrCaptured = value;
      },
      (value) => {
        stderrBytes += value;
      },
    ),
  );
  let timedOut = false;
  let wrapperExitCode = null;
  let wrapperSignal = null;
  let killTimer;
  if (child) {
    const result = await new Promise((resolveResult) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        resolveResult(value);
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalManagedProcess(child.pid, "SIGTERM");
        const testGrace =
          process.env.CHD_EXPERIMENT_2702_TEST_MODE === "1" ? 25 : 5_000;
        killTimer = setTimeout(
          () => signalManagedProcess(child.pid, "SIGKILL"),
          testGrace,
        );
        killTimer.unref?.();
      }, effectiveTimeoutMs);
      child.once("error", (error) => {
        spawnError = error;
        finish({ exitCode: null, signal: null });
      });
      child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
    });
    wrapperExitCode = result.exitCode;
    wrapperSignal = result.signal;
  }
  const processGroupQuiescent = child
    ? await quiesceManagedProcessGroup(child.pid)
    : true;
  if (killTimer) clearTimeout(killTimer);

  let outcome = null;
  if (existsSync(paths.outcome)) {
    outcome = readJson(paths.outcome);
    if (
      outcome?.token !== dispatchToken ||
      !(
        outcome.exitCode === null ||
        (Number.isSafeInteger(outcome.exitCode) && outcome.exitCode >= 0)
      ) ||
      !(outcome.signal === null || typeof outcome.signal === "string") ||
      (outcome.spawnError !== undefined &&
        (typeof outcome.spawnError !== "string" || !outcome.spawnError))
    ) {
      fail(`declared check wrapper outcome is invalid for ${check.id}`);
    }
  }
  const exitCode = timedOut
    ? wrapperExitCode
    : (outcome?.exitCode ?? wrapperExitCode);
  const signal = timedOut ? wrapperSignal : (outcome?.signal ?? wrapperSignal);
  if (!timedOut && !outcome && !spawnError) {
    spawnError = new Error("declared check wrapper produced no outcome");
  } else if (outcome?.spawnError) {
    spawnError = new Error(outcome.spawnError);
  }
  const endedNs = process.hrtime.bigint();
  const stdout = Buffer.concat(stdoutChunks, stdoutCaptured);
  const stderr = Buffer.concat(stderrChunks, stderrCaptured);
  const truncated =
    stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES;
  writeImmutableBytes(paths.stdout, stdout);
  writeImmutableBytes(paths.stderr, stderr);
  const evidence = writeImmutableReceipt(paths.receipt, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702CheckExecution",
    definitionRef: registration.definitionRef,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    ...(processReceipt ? { processDigest: processReceipt.contentDigest } : {}),
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    checkId: check.id,
    argv: [...check.argv],
    timeoutMs: check.timeoutMs,
    ...(effectiveTimeoutMs === check.timeoutMs
      ? {}
      : { testEffectiveTimeoutMs: effectiveTimeoutMs }),
    environmentDigest: checkEnvironmentDigest,
    environment: checkEnvironment,
    environmentProbes: checkEnvironmentProbes,
    ...(checkEnvironmentErrors.length === 0
      ? {}
      : { environmentErrors: checkEnvironmentErrors }),
    startedAt,
    durationMs: Number(endedNs - startedNs) / 1_000_000,
    exitCode,
    signal,
    timedOut,
    interrupted: false,
    processGroupQuiescent,
    truncated,
    stdout: {
      path: paths.stdout,
      byteLength: stdoutBytes,
      capturedBytes: stdout.length,
      contentDigest: `sha256:${stdoutHash.digest("hex")}`,
      capturedContentDigest: sha256(stdout),
      truncated: stdoutBytes > MAX_CAPTURE_BYTES,
    },
    stderr: {
      path: paths.stderr,
      byteLength: stderrBytes,
      capturedBytes: stderr.length,
      contentDigest: `sha256:${stderrHash.digest("hex")}`,
      capturedContentDigest: sha256(stderr),
      truncated: stderrBytes > MAX_CAPTURE_BYTES,
    },
    ...(spawnError ? { spawnError: spawnError.message } : {}),
  });
  return validateCheckExecution(
    evidence,
    check,
    registration,
    effectiveTimeoutMs,
    paths.stdout,
    paths.stderr,
  );
}

async function classify(plan, options) {
  const paths = pathsFor(plan, options);
  const { registration, preflight, terminal, treatment, behaviorContext } =
    validateEvidence(plan, options, paths);
  let existingClassification = null;
  if (existsSync(paths.classification)) {
    existingClassification = readReceipt(
      paths.classification,
      "Gate2702ArmClassification",
    );
    if (
      existingClassification.registrationDigest !==
        registration.contentDigest ||
      existingClassification.preflightDigest !== preflight.contentDigest ||
      existingClassification.terminalDigest !== terminal.contentDigest ||
      existingClassification.trialId !== registration.trialId ||
      existingClassification.subject !== registration.subject ||
      existingClassification.treatmentId !== registration.treatmentId ||
      existingClassification.attempt !== registration.attempt ||
      existingClassification.baseSha !== registration.baseSha ||
      !["succeeded", "failed", "cancelled"].includes(
        existingClassification.status,
      ) ||
      typeof existingClassification.eligible !== "boolean"
    ) {
      fail("existing classification is not bound to its C5 arm evidence");
    }
  }
  const stdout = artifact(paths.stdout);
  const stderr = artifact(paths.stderr);
  if (preflight.status === "failed") {
    if (
      terminal.outcome !== "preflight-failed" ||
      terminal.preflightDigest !== preflight.contentDigest
    ) {
      fail("failed pair preflight is not bound to the arm terminal receipt");
    }
    return writeImmutableReceipt(paths.classification, {
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
      status: "failed",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "tooling-artifact",
        message: "paired C5 environment preflight failed before model dispatch",
        preflightErrors: preflight.errors ?? [],
      },
      retry: {
        authorized: options.attempt === 1,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    });
  }
  if (preflight.status !== "passed")
    fail("pair preflight has an invalid status");
  const behaviorContextDigest = sha256(
    Buffer.from(canonicalJson(behaviorContext), "utf8"),
  );
  if (existingClassification?.error?.code === "behavior-context-drift") {
    if (
      existingClassification.status !== "failed" ||
      existingClassification.eligible !== false ||
      !Array.isArray(existingClassification.checkResults) ||
      existingClassification.checkResults.length !== 0 ||
      existingClassification.behaviorVerification?.behaviorContextDigest !==
        behaviorContextDigest ||
      typeof existingClassification.behaviorVerification?.verifiedAt !==
        "string" ||
      !Number.isFinite(
        Date.parse(existingClassification.behaviorVerification.verifiedAt),
      ) ||
      existingClassification.retry?.authorized !== (options.attempt === 1) ||
      existingClassification.retry?.reason !== "tooling-artifact" ||
      existingClassification.retry?.maximumAttempt !== 2
    ) {
      fail("behavior-drift classification is internally inconsistent");
    }
    return existingClassification;
  }
  const behaviorVerifiedAt =
    existingClassification?.behaviorVerification?.verifiedAt ??
    new Date().toISOString();
  if (existingClassification?.behaviorVerification) {
    if (
      existingClassification.behaviorVerification.behaviorContextDigest !==
        behaviorContextDigest ||
      typeof behaviorVerifiedAt !== "string" ||
      !Number.isFinite(Date.parse(behaviorVerifiedAt))
    ) {
      fail("existing behavior-context verification is invalid");
    }
  } else if (existingClassification?.eligible) {
    fail("eligible classification lacks behavior-context verification");
  } else if (!existingClassification) {
    try {
      assertLiveBehaviorContext(registration, treatment, behaviorContext);
    } catch (error) {
      return writeImmutableReceipt(paths.classification, {
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
        status: "failed",
        eligible: false,
        workerArtifacts: { stdout, stderr },
        checkResults: [],
        behaviorVerification: {
          behaviorContextDigest,
          verifiedAt: behaviorVerifiedAt,
        },
        error: {
          code: "behavior-context-drift",
          message:
            "the C5 behavior context changed after preflight and is excluded",
          detail: error.message,
        },
        retry: {
          authorized: options.attempt === 1,
          reason: "tooling-artifact",
          maximumAttempt: 2,
        },
      });
    }
  }
  let workerResult = null;
  if (!stdout.truncated) {
    try {
      workerResult = JSON.parse(readFileSync(paths.stdout, "utf8"));
    } catch {
      // A malformed worker result is classified below from structured process
      // evidence; prose output is never used to infer a budget stop.
    }
  }
  if (terminal.outcome === "timed-out" || terminal.timedOut === true) {
    return writeImmutableReceipt(paths.classification, {
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
      status: "cancelled",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "timeout",
        message: "the C5 worker exceeded its fixed wall-time limit",
      },
      retry: {
        authorized: options.attempt === 1,
        reason: "timeout",
        maximumAttempt: 2,
      },
    });
  }
  if (workerResult?.subtype === "error_max_budget_usd") {
    return writeImmutableReceipt(paths.classification, {
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
      status: "cancelled",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "budget-exhausted",
        message: "Claude reported the pre-registered worker budget ceiling",
      },
      retry: {
        authorized: false,
        reason: "budget-exhausted",
        maximumAttempt: 2,
      },
    });
  }
  if (stdout.truncated || stderr.truncated) {
    return writeImmutableReceipt(paths.classification, {
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
      status: "cancelled",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "truncated-evidence",
        message:
          "worker stdout or stderr exceeded the fixed 2 MiB evidence bound",
      },
      retry: {
        authorized: options.attempt === 1,
        reason: "truncated-evidence",
        maximumAttempt: 2,
      },
    });
  }
  if (
    terminal.outcome === "spawn-error" ||
    terminal.exitCode !== 0 ||
    terminal.processGroupQuiescent !== true
  ) {
    return writeImmutableReceipt(paths.classification, {
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
      status: "failed",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "worker-process-failure",
        message: "the preflighted worker process did not complete successfully",
        outcome: terminal.outcome,
        exitCode: terminal.exitCode,
        signal: terminal.signal,
      },
      retry: {
        authorized: options.attempt === 1,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    });
  }
  if (
    terminal.outcome !== "exited" ||
    terminal.exitCode !== 0 ||
    terminal.timedOut === true ||
    terminal.processGroupQuiescent !== true
  ) {
    fail("worker is not a completed C5 arm");
  }
  if (
    workerResult?.type !== "result" ||
    workerResult?.subtype !== "success" ||
    typeof workerResult?.result !== "string"
  ) {
    return writeImmutableReceipt(paths.classification, {
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
      status: "failed",
      eligible: false,
      workerArtifacts: { stdout, stderr },
      checkResults: [],
      error: {
        code: "worker-output-invalid",
        message: "Claude did not emit one structured successful result",
      },
      retry: {
        authorized: options.attempt === 1,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    });
  }
  const checkResults = [];
  for (const check of plan.checks) {
    checkResults.push(await executeCheck(check, registration));
  }
  const timedOutCheck = checkResults.find((result) => result.timedOut);
  const truncatedCheck = checkResults.find((result) => result.truncated);
  const toolingFailure = checkResults.find(
    (result) =>
      result.spawnError !== undefined ||
      (result.environmentErrors?.length ?? 0) > 0 ||
      result.exitCode === null ||
      result.exitCode === 127 ||
      result.signal !== null ||
      result.processGroupQuiescent !== true,
  );
  const classification = timedOutCheck
    ? {
        status: "cancelled",
        eligible: false,
        error: {
          code: "timeout",
          checkId: timedOutCheck.checkId,
          message: "a declared check exceeded its pre-registered timeout",
        },
        retry: {
          authorized: options.attempt === 1,
          reason: "timeout",
          maximumAttempt: 2,
        },
      }
    : truncatedCheck
      ? {
          status: "cancelled",
          eligible: false,
          error: {
            code: "truncated-evidence",
            checkId: truncatedCheck.checkId,
            message: "a declared check exceeded its fixed 2 MiB output bound",
          },
          retry: {
            authorized: options.attempt === 1,
            reason: "truncated-evidence",
            maximumAttempt: 2,
          },
        }
      : toolingFailure
        ? {
            status: "failed",
            eligible: false,
            error: {
              code: "tooling-artifact",
              checkId: toolingFailure.checkId,
              message:
                "a declared check could not execute with the preflighted toolchain",
            },
            retry: {
              authorized: options.attempt === 1,
              reason: "tooling-artifact",
              maximumAttempt: 2,
            },
          }
        : {
            status: "succeeded",
            eligible: true,
            retry: {
              authorized: false,
              reason: "genuine-result",
              maximumAttempt: 2,
            },
          };
  const receipt = writeImmutableReceipt(paths.classification, {
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
    ...classification,
    behaviorVerification: {
      behaviorContextDigest,
      verifiedAt: behaviorVerifiedAt,
    },
    workerArtifacts: { stdout, stderr },
    checkResults,
  });
  return receipt;
}

async function selectPairLocked(plan, options, trialRoot) {
  const selectionPath = join(
    trialRoot,
    "pair-selection",
    `issue-${options.subject}.json`,
  );
  if (
    (existsSync(join(trialRoot, "seal", "verified.json")) ||
      existsSync(join(trialRoot, "cleanup.json"))) &&
    !existsSync(selectionPath)
  ) {
    fail("cannot create a new pair selection after sealing or cleanup");
  }
  const trial = readReceipt(join(trialRoot, "trial.json"), "Gate2702Trial");
  if (
    trial.trialId !== options.trial ||
    !sameValue(trial.definitionRef, plan.definitionRef) ||
    !plan.subjects.includes(options.subject)
  ) {
    fail("pair selection is not for the exact checked-in C5 trial");
  }
  const arms = {};
  for (const treatment of plan.treatments) {
    const treatmentRoot = join(
      trialRoot,
      "runs",
      `issue-${options.subject}`,
      treatment.id,
    );
    const attempt = existsSync(
      join(treatmentRoot, "attempt-2", "registration.json"),
    )
      ? 2
      : 1;
    const runDir = join(treatmentRoot, `attempt-${attempt}`);
    const registration = readReceipt(
      join(runDir, "registration.json"),
      "Gate2702ArmRegistration",
    );
    const classification = await classify(plan, {
      ...options,
      treatment: treatment.id,
      attempt,
    });
    if (
      registration.trialId !== trial.trialId ||
      registration.subject !== options.subject ||
      registration.treatmentId !== treatment.id ||
      registration.attempt !== attempt ||
      registration.baseSha !== trial.baseSha ||
      !sameValue(registration.definitionRef, plan.definitionRef)
    ) {
      fail(`selected registration identity is invalid for ${treatment.id}`);
    }
    if (attempt === 2) {
      const attempt1Dir = join(treatmentRoot, "attempt-1");
      const attempt1 = readReceipt(
        join(attempt1Dir, "registration.json"),
        "Gate2702ArmRegistration",
      );
      const classification1 = readReceipt(
        join(attempt1Dir, "classification.json"),
        "Gate2702ArmClassification",
      );
      if (
        classification1.registrationDigest !== attempt1.contentDigest ||
        classification1.retry?.authorized !== true ||
        !sameValue(registration.retryOf, {
          attempt: 1,
          registrationDigest: attempt1.contentDigest,
          classificationDigest: classification1.contentDigest,
        })
      ) {
        fail(`selected retry lineage is invalid for ${treatment.id}`);
      }
    }
    assertIdentity(classification, registration, "selected classification");
    if (
      classification.registrationDigest !== registration.contentDigest ||
      classification.status !== "succeeded" ||
      classification.eligible !== true
    ) {
      fail(`selected classification is not eligible for ${treatment.id}`);
    }
    if (attempt === 1 && classification.retry?.authorized === true) {
      fail(`manual retry remains unresolved for ${treatment.id}`);
    }
    arms[treatment.id] = {
      treatmentId: treatment.id,
      attempt,
      registrationDigest: registration.contentDigest,
      classificationDigest: classification.contentDigest,
    };
  }
  return writeImmutableReceipt(selectionPath, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702PairSelection",
    definitionRef: plan.definitionRef,
    trialId: trial.trialId,
    subject: options.subject,
    baseSha: trial.baseSha,
    arms,
  });
}

async function selectPair(plan, options) {
  const trialRoot = join(
    stateRootFor(options),
    plan.definitionRef.contentDigest.replace(":", "-"),
    options.trial,
  );
  const lock = acquireSelectionLock(trialRoot, options.trial);
  try {
    return await selectPairLocked(plan, options, trialRoot);
  } finally {
    releaseSelectionLock(lock);
  }
}

async function main() {
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    console.error(
      "Refusing to classify C5 evidence without CHD_EXPERIMENT_2702=1",
    );
    process.exitCode = 2;
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const plan = await loadPlan();
  const result =
    options.command === "preflight"
      ? await preflightPair(plan, options)
      : options.command === "preflight-retry"
        ? await preflightRetry(plan, options)
        : options.command === "classify"
          ? await classify(plan, options)
          : await selectPair(plan, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`gate-2702 classifier: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
