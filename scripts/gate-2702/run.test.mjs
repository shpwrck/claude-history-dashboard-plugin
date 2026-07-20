import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "run.mjs");
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_DIRECTORY = DEFINITION_DIGEST.replace(":", "-");
const SUBJECTS = [2760, 2719, 2713, 2706, 2710, 2670];
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const ARM_COUNT = SUBJECTS.length * TREATMENTS.length;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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

function receiptDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(withoutDigest)), "utf8")
    .digest("hex")}`;
}

function withDigest(receipt) {
  return { ...receipt, contentDigest: receiptDigest(receipt) };
}

function assertValidReceipt(receipt, kind) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, kind);
  assert.match(receipt.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.contentDigest, receiptDigest(receipt));
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function filesNamed(root, basename) {
  return walkFiles(root).filter((path) => path.endsWith(`/${basename}`));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (lastError) throw lastError;
  throw new Error(`timed out waiting for ${description}`);
}

function writeExecutable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function processIsActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function createFixture({
  armDelayMs = 20,
  held = false,
  lingeringDescendant = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-runner-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const stateRoot = join(root, "state");
  const tools = join(root, "tools");
  const fakeGh = join(tools, "fake-gh.mjs");
  const fakeArm = join(tools, "fake-arm.mjs");
  const ghLog = join(root, "gh.jsonl");
  const armLog = join(root, "arms.jsonl");
  const armGate = join(root, "release-arms");
  const descendantGate = join(root, "release-descendant");

  mkdirSync(tools, { recursive: true });
  git(root, ["init", "--bare", "--quiet", origin]);
  git(root, ["init", "--quiet", "--initial-branch=master", repo]);
  git(repo, ["config", "user.name", "Gate 2702 Test"]);
  git(repo, ["config", "user.email", "gate-2702@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# gate 2702 fixture\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "--quiet", "-m", "fixture base"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "--quiet", "-u", "origin", "master"]);
  const baseSha = git(repo, ["rev-parse", "origin/master"]);

  writeExecutable(
    fakeGh,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.GATE2702_FAKE_GH_LOG, JSON.stringify(argv) + '\\n');
const issue = Number(argv.find((arg) => /^\\d+$/.test(arg)));
if (!issue) process.exit(2);
process.stdout.write(JSON.stringify({
  number: issue,
  title: 'Fixture issue ' + issue,
  body: 'Implement the bounded fixture for issue ' + issue + '.',
  url: 'https://example.invalid/issues/' + issue,
}));
`,
  );

  writeExecutable(
    fakeArm,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

function filesNamed(root, name) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(path, name));
    else if (entry.isFile() && entry.name === name) found.push(path);
  }
  return found;
}

const runDir = process.env.CHD_EXPERIMENT_2702_RUN_DIR;
const trialRoot = resolve(runDir, '..', '..', '..', '..');
const prompt = await new Promise((resolvePrompt) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => resolvePrompt(input));
});
const head = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).stdout.trim();
const start = {
  event: 'start',
  pid: process.pid,
  trialId: process.env.CHD_EXPERIMENT_2702_TRIAL_ID,
  subject: Number(process.env.CHD_EXPERIMENT_2702_SUBJECT),
  treatment: process.env.CHD_EXPERIMENT_2702_TREATMENT,
  attempt: Number(process.env.CHD_EXPERIMENT_2702_ATTEMPT),
  baseSha: process.env.CHD_EXPERIMENT_2702_BASE_SHA,
  head,
  cwd: process.cwd(),
  runDir,
  registrationCountAtStart: filesNamed(trialRoot, 'registration.json').length,
  preDispatchPresentAtStart: existsSync(join(runDir, 'pre-dispatch.json')),
  sidekick: {
    enable: process.env.SIDEKICK_ENABLE ?? null,
    gate: process.env.SIDEKICK_GATE ?? null,
    model: process.env.SIDEKICK_MODEL ?? null,
    sessionBudgetUsd: process.env.SIDEKICK_SESSION_BUDGET_USD ?? null,
    callBudgetUsd: process.env.SIDEKICK_CALL_BUDGET_USD ?? null,
  },
  prompt,
};
appendFileSync(process.env.GATE2702_FAKE_ARM_LOG, JSON.stringify(start) + '\\n');

const gate = process.env.GATE2702_FAKE_ARM_GATE;
while (gate && !existsSync(gate)) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}
const descendantGate = process.env.GATE2702_FAKE_DESCENDANT_GATE;
if (
  descendantGate &&
  start.subject === 2760 &&
  start.treatment === 'haiku-solo'
) {
  const descendantCode = [
    "const { existsSync } = require('node:fs');",
    "const gate = process.argv[1];",
    "process.on('SIGTERM', () => {});",
    "const deadline = Date.now() + 120000;",
    "const timer = setInterval(() => {",
    "  if (existsSync(gate)) { clearInterval(timer); process.exit(0); }",
    "  if (Date.now() >= deadline) { clearInterval(timer); process.exit(2); }",
    "}, 20);",
  ].join('\\n');
  const descendant = spawn(process.execPath, ['-e', descendantCode, descendantGate], {
    stdio: 'ignore',
    windowsHide: true,
  });
  descendant.unref();
  appendFileSync(process.env.GATE2702_FAKE_ARM_LOG, JSON.stringify({
    event: 'descendant',
    pid: descendant.pid,
    groupLeaderPid: process.pid,
    trialId: start.trialId,
    subject: start.subject,
    treatment: start.treatment,
    runDir,
  }) + '\\n');
}
await new Promise((resolveWait) =>
  setTimeout(resolveWait, Number(process.env.GATE2702_FAKE_ARM_DELAY_MS || 0)),
);
appendFileSync(process.env.GATE2702_FAKE_ARM_LOG, JSON.stringify({
  event: 'done',
  pid: process.pid,
  trialId: process.env.CHD_EXPERIMENT_2702_TRIAL_ID,
  subject: Number(process.env.CHD_EXPERIMENT_2702_SUBJECT),
  treatment: process.env.CHD_EXPERIMENT_2702_TREATMENT,
  attempt: Number(process.env.CHD_EXPERIMENT_2702_ATTEMPT),
}) + '\\n');
`,
  );

  const env = {
    ...process.env,
    CHD_EXPERIMENT_2702: "1",
    CHD_EXPERIMENT_2702_TEST_MODE: "1",
    CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON: JSON.stringify([
      process.execPath,
      fakeArm,
    ]),
    CHD_EXPERIMENT_2702_GH_BIN: fakeGh,
    GATE2702_FAKE_GH_LOG: ghLog,
    GATE2702_FAKE_ARM_LOG: armLog,
    GATE2702_FAKE_ARM_DELAY_MS: String(armDelayMs),
  };
  if (held) env.GATE2702_FAKE_ARM_GATE = armGate;
  if (lingeringDescendant) {
    env.GATE2702_FAKE_DESCENDANT_GATE = descendantGate;
  }

  return {
    root,
    repo,
    stateRoot,
    baseSha,
    fakeGh,
    fakeArm,
    ghLog,
    armLog,
    armGate,
    descendantGate,
    env,
    trialRoot(trialId) {
      return join(stateRoot, DEFINITION_DIRECTORY, trialId);
    },
    releaseArms() {
      writeFileSync(armGate, "release\n", "utf8");
    },
    releaseDescendant() {
      writeFileSync(descendantGate, "release\n", "utf8");
    },
    cleanup() {
      if (held && !existsSync(armGate)) writeFileSync(armGate, "release\n");
      if (lingeringDescendant && !existsSync(descendantGate)) {
        writeFileSync(descendantGate, "release\n");
      }
      for (const event of readEvents(armLog)) {
        if (event.event !== "descendant" || !processIsActive(event.pid))
          continue;
        try {
          process.kill(event.pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function cliArgs(fixture, command, trialId) {
  return [
    RUNNER,
    command,
    "--trial",
    trialId,
    "--repo",
    fixture.repo,
    "--state-root",
    fixture.stateRoot,
  ];
}

function runCli(fixture, command, trialId, options = {}) {
  return spawnSync(process.execPath, cliArgs(fixture, command, trialId), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...fixture.env, ...options.env },
    timeout: options.timeout ?? 30_000,
  });
}

function spawnCli(fixture, command, trialId, options = {}) {
  const child = spawn(process.execPath, cliArgs(fixture, command, trialId), {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...fixture.env, ...options.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return { child, output: () => ({ stdout, stderr }) };
}

function parseStatus(result) {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(
    lines.length,
    1,
    `status must emit one JSON object: ${result.stdout}`,
  );
  return JSON.parse(lines[0]);
}

async function waitForTerminals(fixture, trialId) {
  const trialRoot = fixture.trialRoot(trialId);
  await waitFor(
    () => filesNamed(trialRoot, "terminal.json").length === ARM_COUNT,
    `all ${ARM_COUNT} terminal receipts for ${trialId}`,
    60_000,
  );
  await waitFor(
    () => !existsSync(join(trialRoot, "lock", "owner.json")),
    `the supervisor lock for ${trialId} to be released`,
  );
}

function registrationMap(trialRoot) {
  return new Map(
    filesNamed(trialRoot, "registration.json").map((path) => [
      path.slice(trialRoot.length + 1),
      readFileSync(path, "utf8"),
    ]),
  );
}

function stableReceiptSnapshot(trialRoot) {
  return new Map(
    walkFiles(trialRoot)
      .filter(
        (path) =>
          path.endsWith(".json") &&
          !path.includes("/lock/") &&
          !path.endsWith("/cleanup.json"),
      )
      .map((path) => [path.slice(trialRoot.length + 1), readFileSync(path)]),
  );
}

function assertMapsEqual(actual, expected) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, value] of expected) {
    assert.deepEqual(actual.get(key), value, `changed bytes at ${key}`);
  }
}

test("all public commands fail closed before tools or state when opt-in is off", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-flag-off-"));
  try {
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const calls = join(root, "tool-called");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["git", "gh", "arm"]) {
      writeExecutable(
        join(bin, tool),
        `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${calls}'\nexit 97\n`,
      );
    }
    const env = {
      ...process.env,
      PATH: bin,
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_ARM_COMMAND_JSON: JSON.stringify([
        join(bin, "arm"),
      ]),
      CHD_EXPERIMENT_2702_GH_BIN: join(bin, "gh"),
    };
    delete env.CHD_EXPERIMENT_2702;

    for (const command of ["launch", "status", "cleanup"]) {
      const result = spawnSync(
        process.execPath,
        [
          RUNNER,
          command,
          "--trial",
          randomUUID(),
          "--repo",
          join(root, "must-not-be-read"),
          "--state-root",
          stateRoot,
        ],
        { encoding: "utf8", env },
      );
      assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /CHD_EXPERIMENT_2702=1/,
      );
      assert.equal(existsSync(stateRoot), false);
      assert.equal(existsSync(calls), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached arms survive the launcher and exact-identity resume never duplicates work", async () => {
  const fixture = createFixture({
    armDelayMs: 80,
    held: true,
    lingeringDescendant: true,
  });
  const trialId = randomUUID();
  try {
    const launch = spawnCli(fixture, "launch", trialId, {
      env: { CHD_EXPERIMENT_2702_TEST_HOLD_LAUNCHER: "1" },
    });
    await waitFor(
      () => readEvents(fixture.armLog).some((event) => event.event === "start"),
      "the first detached fake arm",
    );

    const firstEvents = readEvents(fixture.armLog).filter(
      (event) => event.event === "start",
    );
    assert.ok(
      firstEvents.every(
        (event) => event.registrationCountAtStart === ARM_COUNT,
      ),
      "all registrations must exist before the first model dispatch",
    );
    assert.ok(firstEvents.every((event) => event.preDispatchPresentAtStart));

    assert.equal(launch.child.exitCode, null);
    assert.equal(launch.child.signalCode, null);
    assert.equal(
      launch.child.kill("SIGKILL"),
      true,
      "the test-only launcher hold must make the crash deterministic",
    );
    await waitFor(
      () => launch.child.exitCode !== null || launch.child.signalCode !== null,
      "the foreground launcher to end",
    );
    assert.equal(launch.child.signalCode, "SIGKILL");

    const trialRoot = fixture.trialRoot(trialId);
    await waitFor(
      () => filesNamed(trialRoot, "registration.json").length === ARM_COUNT,
      "all registrations",
    );
    const registrationsBeforeResume = registrationMap(trialRoot);

    const activeStatus = parseStatus(runCli(fixture, "status", trialId));
    assert.equal(activeStatus.state, "active");
    assert.equal(activeStatus.counts.registered, ARM_COUNT);
    assert.ok(activeStatus.counts.active > 0);

    const resumeWhileActive = runCli(fixture, "launch", trialId);
    assert.notEqual(
      resumeWhileActive.status,
      0,
      "same-trial launch must not race the active supervisor",
    );
    assert.match(
      `${resumeWhileActive.stdout}\n${resumeWhileActive.stderr}`,
      /active|lock|already running/i,
    );

    fixture.releaseArms();
    const descendantEvent = await waitFor(
      () =>
        readEvents(fixture.armLog).find(
          (event) => event.event === "descendant" && event.trialId === trialId,
        ),
      "the fake arm's lingering process-group descendant",
    );
    await waitFor(
      () =>
        readEvents(fixture.armLog).some(
          (event) =>
            event.event === "done" &&
            event.trialId === trialId &&
            event.subject === descendantEvent.subject &&
            event.treatment === descendantEvent.treatment,
        ),
      "the direct arm leader to exit",
    );
    assert.equal(processIsActive(descendantEvent.pid), true);
    assert.equal(
      existsSync(join(descendantEvent.runDir, "terminal.json")),
      false,
      "terminal evidence must wait for the whole detached process group",
    );

    const descendantStatus = parseStatus(runCli(fixture, "status", trialId));
    assert.equal(descendantStatus.state, "active");
    assert.ok(descendantStatus.counts.active > 0);

    const activeTrial = readJson(join(trialRoot, "trial.json"));
    const earlySealPath = join(trialRoot, "seal", "verified.json");
    mkdirSync(dirname(earlySealPath), { recursive: true });
    writeFileSync(
      earlySealPath,
      `${JSON.stringify(
        withDigest({
          schemaVersion: 1,
          kind: "Gate2702VerifiedSeal",
          verified: true,
          definitionRef: activeTrial.definitionRef,
          trialId,
          baseSha: activeTrial.baseSha,
          worktreeManifestDigest: activeTrial.worktreeManifestDigest,
          sealedAt: "2026-07-20T21:58:00.000Z",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    const activeCleanup = runCli(fixture, "cleanup", trialId);
    assert.notEqual(activeCleanup.status, 0);
    assert.match(
      `${activeCleanup.stdout}\n${activeCleanup.stderr}`,
      /active|terminal|descendant/i,
    );
    assert.ok(
      activeTrial.registrations.every((registration) =>
        existsSync(registration.worktreePath),
      ),
      "cleanup must retain every worktree while an arm process group is active",
    );

    await waitFor(
      () => !processIsActive(descendantEvent.pid),
      "the SIGTERM-ignoring descendant to be reaped by SIGKILL escalation",
    );
    const quiescentTerminal = await waitFor(() => {
      const path = join(descendantEvent.runDir, "terminal.json");
      return existsSync(path) ? readJson(path) : null;
    }, "terminal evidence after process-group quiescence");
    assert.equal(quiescentTerminal.processGroupQuiescent, true);
    await waitForTerminals(fixture, trialId);
    const doneEvents = readEvents(fixture.armLog);
    const starts = doneEvents.filter((event) => event.event === "start");
    const completions = doneEvents.filter((event) => event.event === "done");
    assert.equal(starts.length, ARM_COUNT);
    assert.equal(completions.length, ARM_COUNT);
    assert.deepEqual(
      new Set(
        starts.map(
          (event) => `${event.subject}/${event.treatment}/${event.attempt}`,
        ),
      ).size,
      ARM_COUNT,
    );

    for (const event of starts) {
      assert.equal(event.trialId, trialId);
      assert.equal(event.attempt, 1);
      assert.equal(event.baseSha, fixture.baseSha);
      assert.equal(event.head, fixture.baseSha);
      assert.equal(event.registrationCountAtStart, ARM_COUNT);
      assert.equal(event.preDispatchPresentAtStart, true);
      assert.match(event.prompt, /(?:do not|never) push/i);
      assert.match(event.prompt, /pull request/i);
      assert.match(event.prompt, /merge/i);
      assert.match(event.prompt, /edit[\s\S]*issue/i);
      if (event.treatment === "haiku-solo") {
        assert.deepEqual(event.sidekick, {
          enable: "0",
          gate: null,
          model: null,
          sessionBudgetUsd: null,
          callBudgetUsd: null,
        });
      } else {
        assert.deepEqual(event.sidekick, {
          enable: "1",
          gate: "checkpoint",
          model: "sonnet",
          sessionBudgetUsd: "2",
          callBudgetUsd: "1",
        });
      }
    }

    const registrations = filesNamed(trialRoot, "registration.json");
    const worktreeIdentities = filesNamed(trialRoot, "worktree-identity.json");
    const preDispatches = filesNamed(trialRoot, "pre-dispatch.json");
    const processes = filesNamed(trialRoot, "process.json");
    const terminals = filesNamed(trialRoot, "terminal.json");
    const subjects = walkFiles(join(trialRoot, "subjects")).filter((path) =>
      path.endsWith(".json"),
    );
    assert.equal(registrations.length, ARM_COUNT);
    assert.equal(worktreeIdentities.length, ARM_COUNT);
    assert.equal(preDispatches.length, ARM_COUNT);
    assert.equal(processes.length, ARM_COUNT);
    assert.equal(terminals.length, ARM_COUNT);
    assert.equal(subjects.length, SUBJECTS.length);
    for (const path of registrations) {
      assertValidReceipt(readJson(path), "Gate2702ArmRegistration");
    }
    for (const path of worktreeIdentities) {
      assertValidReceipt(readJson(path), "Gate2702WorktreeIdentity");
    }
    for (const path of preDispatches) {
      assertValidReceipt(readJson(path), "Gate2702PreDispatch");
    }
    for (const path of processes) {
      assertValidReceipt(readJson(path), "Gate2702Process");
    }
    for (const path of terminals) {
      assertValidReceipt(readJson(path), "Gate2702Terminal");
    }
    for (const path of subjects) {
      assertValidReceipt(readJson(path), "Gate2702SubjectSnapshot");
    }

    const trial = readJson(join(trialRoot, "trial.json"));
    assertValidReceipt(trial, "Gate2702Trial");
    assert.equal(trial.trialId, trialId);
    assert.equal(trial.baseSha, fixture.baseSha);
    assert.equal(trial.definitionRef.contentDigest, DEFINITION_DIGEST);
    assert.equal(trial.registrations.length, ARM_COUNT);

    for (const registration of trial.registrations) {
      assert.ok(existsSync(registration.worktreePath));
      assert.equal(
        git(registration.worktreePath, ["rev-parse", "HEAD"]),
        fixture.baseSha,
      );
      assert.match(
        resolve(registration.worktreePath),
        new RegExp(
          `^${resolve(trial.worktreeRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
        ),
      );
    }

    const terminalStatusBefore = stableReceiptSnapshot(trialRoot);
    const terminalStatus = parseStatus(runCli(fixture, "status", trialId));
    assert.equal(terminalStatus.state, "terminal");
    assert.equal(terminalStatus.counts.terminal, ARM_COUNT);
    assert.equal(terminalStatus.counts.active, 0);
    assertMapsEqual(stableReceiptSnapshot(trialRoot), terminalStatusBefore);

    const copiedReceiptCases = [
      ["subject snapshot", subjects[0], subjects[1]],
      ["registration", registrations[0], registrations[1]],
      ["pre-dispatch", preDispatches[0], preDispatches[1]],
      ["process", processes[0], processes[1]],
      ["terminal", terminals[0], terminals[1]],
    ];
    for (const [label, source, target] of copiedReceiptCases) {
      const originalTarget = readFileSync(target);
      const foreignValidBytes = readFileSync(source);
      assert.notDeepEqual(
        foreignValidBytes,
        originalTarget,
        `${label} fixture identities must differ`,
      );
      writeFileSync(target, foreignValidBytes);
      try {
        const beforeTamperStatus = stableReceiptSnapshot(trialRoot);
        const tamperStatus = parseStatus(runCli(fixture, "status", trialId));
        assert.equal(
          tamperStatus.state,
          "recovery-required",
          `${label} copied from another arm must fail its path/chain identity`,
        );
        assert.ok(tamperStatus.counts.recoveryRequired > 0);
        assertMapsEqual(stableReceiptSnapshot(trialRoot), beforeTamperStatus);
      } finally {
        writeFileSync(target, originalTarget);
      }
      assert.equal(
        parseStatus(runCli(fixture, "status", trialId)).state,
        "terminal",
        `${label} restoration must recover the same immutable chain`,
      );
    }

    // A missing terminal after a persisted process receipt models a supervisor
    // crash between wait() and its final atomic write. Status must expose the
    // exact attempt as recovery-required without repairing it behind our back.
    const missingTerminal = terminals[0];
    const terminalBytes = readFileSync(missingTerminal);
    rmSync(missingTerminal);
    const beforeRecoveryStatus = stableReceiptSnapshot(trialRoot);
    const recoveryStatus = parseStatus(runCli(fixture, "status", trialId));
    assert.equal(recoveryStatus.state, "recovery-required");
    assert.equal(recoveryStatus.counts.recoveryRequired, 1);
    assertMapsEqual(stableReceiptSnapshot(trialRoot), beforeRecoveryStatus);
    writeFileSync(missingTerminal, terminalBytes);

    const resumeAfterTerminal = runCli(fixture, "launch", trialId);
    assert.equal(resumeAfterTerminal.status, 0, resumeAfterTerminal.stderr);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    assert.equal(
      readEvents(fixture.armLog).filter((event) => event.event === "start")
        .length,
      ARM_COUNT,
    );
    assertMapsEqual(registrationMap(trialRoot), registrationsBeforeResume);

    assert.equal(readEvents(fixture.ghLog).length, SUBJECTS.length);
  } finally {
    fixture.cleanup();
  }
});

test("the trial lock refuses overlap while a different trial remains isolated", async () => {
  const fixture = createFixture({ held: true });
  const firstTrial = randomUUID();
  const otherTrial = randomUUID();
  try {
    const first = runCli(fixture, "launch", firstTrial);
    assert.equal(first.status, 0, first.stderr);
    await waitFor(
      () =>
        readEvents(fixture.armLog).some(
          (event) => event.event === "start" && event.trialId === firstTrial,
        ),
      "first trial to become active",
    );

    const overlapping = runCli(fixture, "launch", firstTrial);
    assert.notEqual(overlapping.status, 0);
    assert.match(
      `${overlapping.stdout}\n${overlapping.stderr}`,
      /active|lock|already running/i,
    );

    const isolated = runCli(fixture, "launch", otherTrial);
    assert.equal(isolated.status, 0, isolated.stderr);
    await waitFor(
      () =>
        readEvents(fixture.armLog).some(
          (event) => event.event === "start" && event.trialId === otherTrial,
        ),
      "unrelated trial to become active independently",
    );

    const firstStatus = parseStatus(runCli(fixture, "status", firstTrial));
    const otherStatus = parseStatus(runCli(fixture, "status", otherTrial));
    assert.equal(firstStatus.state, "active");
    assert.equal(otherStatus.state, "active");
    assert.notEqual(
      fixture.trialRoot(firstTrial),
      fixture.trialRoot(otherTrial),
    );

    const firstTrialRoot = fixture.trialRoot(firstTrial);
    const firstTrialReceipt = readJson(join(firstTrialRoot, "trial.json"));
    const prematureSeal = withDigest({
      schemaVersion: 1,
      kind: "Gate2702VerifiedSeal",
      verified: true,
      definitionRef: firstTrialReceipt.definitionRef,
      trialId: firstTrial,
      baseSha: firstTrialReceipt.baseSha,
      worktreeManifestDigest: firstTrialReceipt.worktreeManifestDigest,
      sealedAt: "2026-07-20T21:59:00.000Z",
    });
    const prematureSealPath = join(firstTrialRoot, "seal", "verified.json");
    mkdirSync(dirname(prematureSealPath), { recursive: true });
    writeFileSync(
      prematureSealPath,
      `${JSON.stringify(prematureSeal, null, 2)}\n`,
      "utf8",
    );
    const prematureCleanup = runCli(fixture, "cleanup", firstTrial);
    assert.notEqual(prematureCleanup.status, 0);
    assert.match(
      `${prematureCleanup.stdout}\n${prematureCleanup.stderr}`,
      /active|terminal/i,
    );
    assert.ok(
      firstTrialReceipt.registrations.every((registration) =>
        existsSync(registration.worktreePath),
      ),
      "a premature but structurally valid seal must not delete active worktrees",
    );

    fixture.releaseArms();
    await Promise.all([
      waitForTerminals(fixture, firstTrial),
      waitForTerminals(fixture, otherTrial),
    ]);

    const starts = readEvents(fixture.armLog).filter(
      (event) => event.event === "start",
    );
    assert.equal(
      starts.filter((event) => event.trialId === firstTrial).length,
      ARM_COUNT,
    );
    assert.equal(
      starts.filter((event) => event.trialId === otherTrial).length,
      ARM_COUNT,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cleanup is seal-gated, exact, registered-only, and idempotent", async () => {
  const fixture = createFixture();
  const trialId = randomUUID();
  try {
    const launch = runCli(fixture, "launch", trialId);
    assert.equal(launch.status, 0, launch.stderr);
    await waitForTerminals(fixture, trialId);

    const trialRoot = fixture.trialRoot(trialId);
    const trial = readJson(join(trialRoot, "trial.json"));
    const registeredWorktrees = trial.registrations.map(
      (registration) => registration.worktreePath,
    );
    assert.equal(registeredWorktrees.length, ARM_COUNT);
    assert.ok(registeredWorktrees.every(existsSync));

    const unrelatedWorktree = join(fixture.root, "unrelated-worktree");
    git(fixture.repo, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      unrelatedWorktree,
      fixture.baseSha,
    ]);

    const sealPath = join(trialRoot, "seal", "verified.json");
    const recoveryCommand =
      `Recovery command: CHD_EXPERIMENT_2702=1 node ` +
      `scripts/gate-2702/run.mjs cleanup --trial ${trialId} ` +
      `--repo '${fixture.repo}' --state-root '${fixture.stateRoot}'`;
    const assertRetained = (result, message) => {
      assert.notEqual(result.status, 0, message);
      assert.ok(registeredWorktrees.every(existsSync), message);
      assert.ok(existsSync(unrelatedWorktree), message);
      assert.match(`${result.stdout}\n${result.stderr}`, /recovery/i);
      assert.ok(
        `${result.stdout}\n${result.stderr}`.includes(recoveryCommand),
        `missing exact recovery command in:\n${result.stdout}\n${result.stderr}`,
      );
    };

    assertRetained(runCli(fixture, "cleanup", trialId), "missing seal");

    mkdirSync(dirname(sealPath), { recursive: true });
    writeFileSync(sealPath, "{ malformed", "utf8");
    assertRetained(runCli(fixture, "cleanup", trialId), "malformed seal");

    const validFields = {
      schemaVersion: 1,
      kind: "Gate2702VerifiedSeal",
      verified: true,
      definitionRef: trial.definitionRef,
      trialId,
      baseSha: trial.baseSha,
      worktreeManifestDigest: trial.worktreeManifestDigest,
      sealedAt: "2026-07-20T22:00:00.000Z",
    };

    const rejectedSeals = [
      { ...validFields, verified: false },
      { ...validFields, trialId: randomUUID() },
      { ...validFields, baseSha: "0".repeat(40) },
      {
        ...validFields,
        definitionRef: {
          ...validFields.definitionRef,
          contentDigest: `sha256:${"0".repeat(64)}`,
        },
      },
      {
        ...validFields,
        worktreeManifestDigest: `sha256:${"0".repeat(64)}`,
      },
    ];
    for (const [index, seal] of rejectedSeals.entries()) {
      writeFileSync(
        sealPath,
        `${JSON.stringify(withDigest(seal), null, 2)}\n`,
        "utf8",
      );
      assertRetained(
        runCli(fixture, "cleanup", trialId),
        `rejected seal ${index}`,
      );
    }

    const badDigestSeal = withDigest(validFields);
    badDigestSeal.contentDigest = `sha256:${"f".repeat(64)}`;
    writeFileSync(
      sealPath,
      `${JSON.stringify(badDigestSeal, null, 2)}\n`,
      "utf8",
    );
    assertRetained(runCli(fixture, "cleanup", trialId), "bad seal digest");

    writeFileSync(
      sealPath,
      `${JSON.stringify(withDigest(validFields), null, 2)}\n`,
      "utf8",
    );

    const identityPaths = trial.registrations.map((registration) =>
      join(registration.runDir, "worktree-identity.json"),
    );
    assert.equal(
      parseStatus(runCli(fixture, "status", trialId)).state,
      "terminal",
    );
    const originalIdentity = readFileSync(identityPaths[1]);
    writeFileSync(identityPaths[1], readFileSync(identityPaths[0]));
    const foreignIdentityCleanup = runCli(fixture, "cleanup", trialId);
    assertRetained(
      foreignIdentityCleanup,
      "foreign valid worktree identity marker",
    );
    writeFileSync(identityPaths[1], originalIdentity);
    assert.equal(
      parseStatus(runCli(fixture, "status", trialId)).state,
      "terminal",
    );

    const reincarnatedRegistration = trial.registrations[0];
    git(fixture.repo, [
      "worktree",
      "remove",
      "--force",
      reincarnatedRegistration.worktreePath,
    ]);
    assert.equal(existsSync(reincarnatedRegistration.worktreePath), false);
    git(fixture.repo, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      reincarnatedRegistration.worktreePath,
      fixture.baseSha,
    ]);
    const reincarnatedCleanup = runCli(fixture, "cleanup", trialId);
    assertRetained(reincarnatedCleanup, "same-path worktree reincarnation");
    git(fixture.repo, [
      "worktree",
      "remove",
      "--force",
      reincarnatedRegistration.worktreePath,
    ]);

    const cleaned = runCli(fixture, "cleanup", trialId);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.ok(registeredWorktrees.every((path) => !existsSync(path)));
    assert.ok(existsSync(unrelatedWorktree));
    assert.ok(existsSync(join(trialRoot, "cleanup.json")));

    const cleanupReceipt = readJson(join(trialRoot, "cleanup.json"));
    assertValidReceipt(cleanupReceipt, "Gate2702Cleanup");

    const cleanupPath = join(trialRoot, "cleanup.json");
    const cleanupBytes = readFileSync(cleanupPath);
    writeFileSync(
      cleanupPath,
      `${JSON.stringify(
        withDigest({
          ...cleanupReceipt,
          trialId: randomUUID(),
          contentDigest: undefined,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    const foreignCleanupReceipt = runCli(fixture, "cleanup", trialId);
    assert.notEqual(foreignCleanupReceipt.status, 0);
    assert.match(
      `${foreignCleanupReceipt.stdout}\n${foreignCleanupReceipt.stderr}`,
      /cleanup receipt identity/i,
    );
    assert.ok(existsSync(unrelatedWorktree));
    assert.ok(registeredWorktrees.every((path) => !existsSync(path)));
    writeFileSync(cleanupPath, cleanupBytes);

    const secondCleanup = runCli(fixture, "cleanup", trialId);
    assert.equal(secondCleanup.status, 0, secondCleanup.stderr);
    assert.ok(existsSync(unrelatedWorktree));
    assert.ok(registeredWorktrees.every((path) => !existsSync(path)));
  } finally {
    fixture.cleanup();
  }
});
