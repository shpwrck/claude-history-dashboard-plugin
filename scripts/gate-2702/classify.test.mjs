import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  captureGate2702BehaviorContext,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLASSIFIER = join(HERE, "classify.mjs");
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_DIRECTORY = DEFINITION_DIGEST.replace(":", "-");
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest: DEFINITION_DIGEST,
};

function fixtureTreatment(treatmentId) {
  return treatmentId === "haiku-sonnet-sidekick"
    ? {
        id: treatmentId,
        configuration: {
          sidekick: {
            enabled: true,
            reviewerTier: "sonnet",
            gate: "checkpoint",
            sessionBudgetUsd: 2,
            perCallBudgetUsd: 1,
          },
        },
      }
    : {
        id: treatmentId,
        configuration: {
          sidekick: {
            enabled: false,
            sessionBudgetUsd: 0,
            perCallBudgetUsd: 0,
          },
        },
      };
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

function withDigest(receipt) {
  return {
    ...receipt,
    contentDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(canonicalValue(receipt)), "utf8")
      .digest("hex")}`,
  };
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  const value = withDigest(receipt);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

function writeExecutable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function createEvidenceFixture({
  vitestExit = 1,
  vitestSignal = null,
  typecheckExit = 0,
  vitestBytes = 0,
  vitestDelayMs = 0,
  pauseVitestBeforeLog = false,
  installDelayMs = 0,
  installDescendant = false,
  slowInstallTreatment = null,
  terminal = {},
  workerStdout = `${JSON.stringify({
    type: "result",
    subtype: "success",
    result: "done",
  })}\n`,
  workerStderr = "",
  includePreflight = true,
  treatmentLockfile = "{}\n",
  executionMode = "test",
  workerArgv = ["claude", "-p", "--model", "fixture-model"],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-classify-"));
  const fixtureHome = join(root, "home");
  const stateRoot = join(root, "state");
  const trialId = randomUUID();
  const trialRoot = join(stateRoot, DEFINITION_DIRECTORY, trialId);
  const tools = join(root, "bin");
  const toolLog = join(root, "tools.log");
  const vitestBeforeLog = join(root, "vitest-before-log");
  const installDescendants = join(root, "install-descendants.log");
  const installInvocations = join(root, "install-invocations.log");
  mkdirSync(tools, { recursive: true });
  mkdirSync(fixtureHome, { recursive: true });
  const vitestCompletion = vitestSignal
    ? `process.kill(process.pid, ${JSON.stringify(vitestSignal)});`
    : `process.stdout.write(${vitestBytes} > 0 ? 'x'.repeat(${vitestBytes}) : 'one fixture test failed\\n', () => process.exit(${vitestExit}));`;
  writeExecutable(
    join(tools, "npx"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst joined = args.join(' ');\nif (${pauseVitestBeforeLog} && joined === 'vitest run') {\n  fs.writeFileSync(${JSON.stringify(vitestBeforeLog)}, 'ready\\n');\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n}\nfs.appendFileSync(${JSON.stringify(toolLog)}, 'npx ' + joined + '\\n');\nif (process.env.GATE2702_BREAK_TREATMENT_TOOLS === '1' && process.cwd().includes('haiku-sonnet-sidekick') && joined.includes('--version')) process.exit(90);\nif (joined === '--no-install vitest --version') { process.stdout.write('vitest/3.2.4 linux-x64 node-v22\\n'); process.exit(0); }\nif (joined === '--no-install tsc --version') { process.stdout.write('Version 5.8.3\\n'); process.exit(0); }\nsetTimeout(() => { ${vitestCompletion} }, ${vitestDelayMs});\n`,
  );
  writeExecutable(
    join(tools, "npm"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawn } = require('node:child_process');\nconst args = process.argv.slice(2);\nconst slowInstallTreatment = ${JSON.stringify(slowInstallTreatment)};\nconst isSlowInstall = slowInstallTreatment === null || process.cwd().includes(slowInstallTreatment);\nfs.appendFileSync(${JSON.stringify(toolLog)}, 'npm ' + args.join(' ') + '\\n');\nif (args.join(' ') === '--version') { process.stdout.write('10.9.2\\n'); process.exit(0); }\nif (args.join(' ') === 'ci') {\n  fs.appendFileSync(${JSON.stringify(installInvocations)}, process.cwd() + '\\n');\n  if (${installDescendant} && isSlowInstall) {\n    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: 'ignore' });\n    fs.appendFileSync(${JSON.stringify(installDescendants)}, String(child.pid) + '\\n');\n  }\n  setTimeout(() => { process.stdout.write('fixture install complete\\n'); process.exit(0); }, isSlowInstall ? ${installDelayMs} : 0);\n} else {\n  process.stdout.write('fixture typecheck complete\\n');\n  process.exit(${typecheckExit});\n}\n`,
  );
  writeExecutable(
    join(tools, "git"),
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2).join(' ');\nconst dirty = process.env.GATE2702_DIRTY_TREATMENT_TREE === '1' && process.cwd().includes('haiku-sonnet-sidekick');\nfs.appendFileSync(${JSON.stringify(toolLog)}, 'git ' + args + '\\n');\nif (dirty && args === 'diff --quiet HEAD -- .') process.exit(1);\nif (dirty && args === 'status --porcelain --untracked-files=normal') { process.stdout.write('?? drift.test.ts\\n'); process.exit(0); }\nif (args === 'rev-parse HEAD') process.stdout.write('${"a".repeat(40)}\\n');\n`,
  );
  writeExecutable(
    join(tools, "claude"),
    `#!/bin/sh\nprintf 'claude %s\\n' "$*" >> '${toolLog}'\nprintf '%s\\n' '2.1.12 (Claude Code)'\n`,
  );

  const baseSha = "a".repeat(40);
  const registrations = [];
  for (const treatmentId of ["haiku-solo", "haiku-sonnet-sidekick"]) {
    const runDir = join(
      trialRoot,
      "runs",
      "issue-2760",
      treatmentId,
      "attempt-1",
    );
    const worktreePath = join(
      trialRoot,
      "worktrees",
      `issue-2760.${treatmentId}.attempt-1`,
    );
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(worktreePath, "package-lock.json"),
      treatmentId === "haiku-sonnet-sidekick" ? treatmentLockfile : "{}\n",
      "utf8",
    );
    const registration = writeReceipt(join(runDir, "registration.json"), {
      schemaVersion: 1,
      kind: "Gate2702ArmRegistration",
      definitionRef: DEFINITION_REF,
      trialId,
      subject: 2760,
      subjectRef: "github:shpwrck/claude-history-dashboard#2760",
      treatmentId,
      attempt: 1,
      baseSha,
      executionMode,
      runDir,
      worktreePath,
    });
    registrations.push(registration);
    const sidekickEnvironment = gate2702SidekickEnvironment(
      fixtureTreatment(treatmentId),
    );
    const preDispatch = writeReceipt(join(runDir, "pre-dispatch.json"), {
      schemaVersion: 1,
      kind: "Gate2702PreDispatch",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      worktreeIdentityDigest: `sha256:${"b".repeat(64)}`,
      trialId,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      executionMode,
      argv: workerArgv,
      sidekickEnvironment,
      sidekickEnvironmentDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(canonicalValue(sidekickEnvironment)), "utf8")
        .digest("hex")}`,
      cwd: worktreePath,
      promptDigest: `sha256:${"c".repeat(64)}`,
      startedAt: "2026-07-20T21:59:00.000Z",
    });
    const processReceipt = writeReceipt(join(runDir, "process.json"), {
      schemaVersion: 1,
      kind: "Gate2702Process",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      pid: 999_999_999,
      detachedProcessGroup: true,
      startedAt: "2026-07-20T21:59:00.000Z",
    });
    writeReceipt(join(runDir, "terminal.json"), {
      schemaVersion: 1,
      kind: "Gate2702Terminal",
      definitionRef: DEFINITION_REF,
      trialId,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      outcome: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      processGroupQuiescent: true,
      durationMs: 1_234.5,
      endedAt: "2026-07-20T22:00:00.000Z",
      ...terminal,
    });
    writeFileSync(join(runDir, "stdout.log"), workerStdout, "utf8");
    writeFileSync(join(runDir, "stderr.log"), workerStderr, "utf8");
  }
  writeReceipt(join(trialRoot, "trial.json"), {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId,
    repository: "shpwrck/claude-history-dashboard",
    executionMode,
    baseSha,
    registrations,
  });
  if (includePreflight) {
    const lockfileDigest = `sha256:${createHash("sha256")
      .update("{}\n", "utf8")
      .digest("hex")}`;
    const environment = {
      node: { executable: process.execPath, version: process.version },
      npm: { executable: join(tools, "npm"), version: "10.9.2" },
      claude: {
        executable: join(tools, "claude"),
        version: "2.1.12 (Claude Code)",
      },
      vitest: {
        executable: join(tools, "npx"),
        version: "vitest/3.2.4 linux-x64 node-v22",
      },
      typescript: {
        executable: join(tools, "npx"),
        version: "Version 5.8.3",
      },
    };
    const environmentProbes = {
      npm: {
        program: join(tools, "npm"),
        argv: ["npm", "--version"],
        timeoutMs: 60_000,
        maxBufferBytes: 256 * 1024,
        processGroupQuiescent: true,
        exitCode: 0,
        signal: null,
        stdout: "10.9.2",
        stderr: "",
      },
      claude: {
        program: join(tools, "claude"),
        argv: ["claude", "--version"],
        timeoutMs: 60_000,
        maxBufferBytes: 256 * 1024,
        processGroupQuiescent: true,
        exitCode: 0,
        signal: null,
        stdout: "2.1.12 (Claude Code)",
        stderr: "",
      },
      vitest: {
        program: join(tools, "npx"),
        argv: ["npx", "--no-install", "vitest", "--version"],
        timeoutMs: 60_000,
        maxBufferBytes: 256 * 1024,
        processGroupQuiescent: true,
        exitCode: 0,
        signal: null,
        stdout: "vitest/3.2.4 linux-x64 node-v22",
        stderr: "",
      },
      typescript: {
        program: join(tools, "npx"),
        argv: ["npx", "--no-install", "tsc", "--version"],
        timeoutMs: 60_000,
        maxBufferBytes: 256 * 1024,
        processGroupQuiescent: true,
        exitCode: 0,
        signal: null,
        stdout: "Version 5.8.3",
        stderr: "",
      },
    };
    const installExecutions = Object.fromEntries(
      registrations.map((registration, index) => {
        const installRoot = join(registration.runDir, "preflight-install");
        const stdoutPath = join(installRoot, "stdout.log");
        const stderrPath = join(installRoot, "stderr.log");
        const stdout = Buffer.from("fixture install complete\n", "utf8");
        const stderr = Buffer.alloc(0);
        const startedAt = "2026-07-20T21:59:00.000Z";
        const dispatchToken = randomUUID();
        const preDispatch = writeReceipt(
          join(installRoot, "pre-dispatch.json"),
          {
            schemaVersion: 1,
            kind: "Gate2702InstallPreDispatch",
            definitionRef: DEFINITION_REF,
            registrationDigest: registration.contentDigest,
            trialId,
            subject: 2760,
            treatmentId: registration.treatmentId,
            attempt: 1,
            baseSha,
            program: join(tools, "npm"),
            executable: join(tools, "npm"),
            argv: ["npm", "ci"],
            timeoutMs: 1_200_000,
            maxBufferBytes: 256 * 1024,
            cwd: registration.worktreePath,
            dispatchToken,
            ownerPid: 90_000 + index,
            startedAt,
          },
        );
        const installProcess = writeReceipt(join(installRoot, "process.json"), {
          schemaVersion: 1,
          kind: "Gate2702InstallProcess",
          definitionRef: DEFINITION_REF,
          registrationDigest: registration.contentDigest,
          preDispatchDigest: preDispatch.contentDigest,
          trialId,
          subject: 2760,
          treatmentId: registration.treatmentId,
          attempt: 1,
          baseSha,
          dispatchToken,
          pid: 91_000 + index,
        });
        writeFileSync(stdoutPath, stdout);
        writeFileSync(stderrPath, stderr);
        const stdoutDigest = `sha256:${createHash("sha256")
          .update(stdout)
          .digest("hex")}`;
        const stderrDigest = `sha256:${createHash("sha256")
          .update(stderr)
          .digest("hex")}`;
        return [
          registration.treatmentId,
          writeReceipt(join(installRoot, "execution.json"), {
            schemaVersion: 1,
            kind: "Gate2702InstallExecution",
            definitionRef: DEFINITION_REF,
            registrationDigest: registration.contentDigest,
            preDispatchDigest: preDispatch.contentDigest,
            processDigest: installProcess.contentDigest,
            trialId,
            subject: 2760,
            treatmentId: registration.treatmentId,
            attempt: 1,
            baseSha,
            program: join(tools, "npm"),
            executable: join(tools, "npm"),
            argv: ["npm", "ci"],
            pid: installProcess.pid,
            timeoutMs: 1_200_000,
            maxBufferBytes: 256 * 1024,
            startedAt,
            durationMs: 1,
            exitCode: 0,
            signal: null,
            timedOut: false,
            interrupted: false,
            processGroupQuiescent: true,
            truncated: false,
            stdout: "fixture install complete",
            stderr: "",
            stdoutEvidence: {
              path: stdoutPath,
              byteLength: stdout.length,
              capturedBytes: stdout.length,
              contentDigest: stdoutDigest,
              capturedContentDigest: stdoutDigest,
              truncated: false,
            },
            stderrEvidence: {
              path: stderrPath,
              byteLength: 0,
              capturedBytes: 0,
              contentDigest: stderrDigest,
              capturedContentDigest: stderrDigest,
              truncated: false,
            },
          }),
        ];
      }),
    );
    const fixtureImplementationDigest = `sha256:${createHash("sha256")
      .update(
        JSON.stringify(
          canonicalValue({
            fixture: "gate-2702-sidekick",
            version: "0.3.3",
          }),
        ),
        "utf8",
      )
      .digest("hex")}`;
    const behaviorContexts = Object.fromEntries(
      registrations.map((registration) => {
        const treatment = fixtureTreatment(registration.treatmentId);
        const enabled = treatment.configuration.sidekick.enabled;
        return [
          registration.treatmentId,
          captureGate2702BehaviorContext({
            cwd: registration.worktreePath,
            treatment,
            sidekickVersion: enabled ? "0.3.3" : null,
            sidekickImplementationDigest: enabled
              ? fixtureImplementationDigest
              : null,
            sidekickActivation: enabled
              ? { pluginEnabled: true, globalPauseAbsent: true }
              : null,
            observedAt: "2026-07-20T21:58:00.000Z",
            env: { ...process.env, HOME: fixtureHome },
          }),
        ];
      }),
    );
    writeReceipt(join(trialRoot, "preflight", "issue-2760.json"), {
      schemaVersion: 1,
      kind: "Gate2702PairPreflight",
      definitionRef: DEFINITION_REF,
      trialId,
      subject: 2760,
      baseSha,
      status: "passed",
      arms: Object.fromEntries(
        registrations.map((registration) => [
          registration.treatmentId,
          {
            treatmentId: registration.treatmentId,
            attempt: 1,
            registrationDigest: registration.contentDigest,
            worktreePath: registration.worktreePath,
            lockfileDigest,
            head: {
              program: join(tools, "git"),
              argv: ["git", "rev-parse", "HEAD"],
              timeoutMs: 60_000,
              maxBufferBytes: 256 * 1024,
              exitCode: 0,
              signal: null,
              processGroupQuiescent: true,
              stdout: baseSha,
              stderr: "",
            },
            lockfileClean: {
              program: join(tools, "git"),
              argv: [
                "git",
                "diff",
                "--quiet",
                "HEAD",
                "--",
                "package-lock.json",
              ],
              timeoutMs: 60_000,
              maxBufferBytes: 256 * 1024,
              exitCode: 0,
              signal: null,
              processGroupQuiescent: true,
              stdout: "",
              stderr: "",
            },
            treeClean: {
              program: join(tools, "git"),
              argv: ["git", "diff", "--quiet", "HEAD", "--", "."],
              timeoutMs: 60_000,
              maxBufferBytes: 256 * 1024,
              exitCode: 0,
              signal: null,
              processGroupQuiescent: true,
              stdout: "",
              stderr: "",
            },
            worktreeStatus: {
              program: join(tools, "git"),
              argv: [
                "git",
                "status",
                "--porcelain",
                "--untracked-files=normal",
              ],
              timeoutMs: 60_000,
              maxBufferBytes: 256 * 1024,
              exitCode: 0,
              signal: null,
              processGroupQuiescent: true,
              stdout: "",
              stderr: "",
            },
            install: installExecutions[registration.treatmentId],
            environment,
            environmentProbes,
            environmentDigest: `sha256:${createHash("sha256")
              .update(JSON.stringify(canonicalValue(environment)), "utf8")
              .digest("hex")}`,
            behaviorContext: behaviorContexts[registration.treatmentId],
            sidekick: {
              version:
                registration.treatmentId === "haiku-sonnet-sidekick"
                  ? "0.3.3"
                  : null,
              implementationDigest:
                registration.treatmentId === "haiku-sonnet-sidekick"
                  ? fixtureImplementationDigest
                  : null,
              activation:
                registration.treatmentId === "haiku-sonnet-sidekick"
                  ? { pluginEnabled: true, globalPauseAbsent: true }
                  : null,
              configuration: fixtureTreatment(registration.treatmentId)
                .configuration.sidekick,
            },
          },
        ]),
      ),
      environment,
      environmentDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(canonicalValue(environment)), "utf8")
        .digest("hex")}`,
    });
  }

  return {
    root,
    stateRoot,
    trialId,
    trialRoot,
    baseSha,
    toolLog,
    vitestBeforeLog,
    installDescendants,
    installInvocations,
    env: {
      ...process.env,
      HOME: fixtureHome,
      PATH: tools,
      CHD_EXPERIMENT_2702: "1",
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runClassifier(fixture, args, env = {}) {
  return spawnSync(process.execPath, [CLASSIFIER, ...args], {
    encoding: "utf8",
    env: { ...fixture.env, ...env },
  });
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function toolCallCount(toolLog, expectedLine) {
  if (!existsSync(toolLog)) return 0;
  return readFileSync(toolLog, "utf8")
    .split("\n")
    .filter((line) => line === expectedLine).length;
}

function processIsActive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pidIsActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("classifier is inert until the C5 bridge is explicitly enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-classify-off-"));
  try {
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const calls = join(root, "tool-called");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["git", "npm", "claude", "npx"]) {
      writeExecutable(
        join(bin, tool),
        `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${calls}'\nexit 97\n`,
      );
    }
    const env = { ...process.env, PATH: bin };
    delete env.CHD_EXPERIMENT_2702;

    for (const command of [
      "preflight",
      "preflight-retry",
      "classify",
      "select",
    ]) {
      const result = spawnSync(process.execPath, [CLASSIFIER, command], {
        encoding: "utf8",
        env,
      });
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

test("a genuine declared-check failure fails and remains ineligible", () => {
  const fixture = createEvidenceFixture({ vitestExit: 1, typecheckExit: 0 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.kind, "Gate2702ArmClassification");
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "genuine-check-failure");
    assert.equal(
      classification.error.checkId,
      "checks/gate-2702-vitest",
    );
    assert.equal(classification.worktreeEvidence, undefined);
    assert.match(
      classification.behaviorVerification.behaviorContextDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      classification.checkResults.map(({ checkId, status }) => ({
        checkId,
        status,
      })),
      [
        { checkId: "checks/gate-2702-vitest", status: "failed" },
        { checkId: "checks/gate-2702-typecheck", status: "passed" },
      ],
    );
    assert.deepEqual(classification.retry, {
      authorized: false,
      reason: "genuine-result",
      maximumAttempt: 2,
    });
    assert.equal(
      existsSync(
        join(
          fixture.trialRoot,
          "runs",
          "issue-2760",
          "haiku-solo",
          "attempt-1",
          "classification.json",
        ),
      ),
      true,
    );
    const toolCalls = readFileSync(fixture.toolLog, "utf8").trim().split("\n");
    assert.equal(
      toolCalls.filter((line) => line === "npx vitest run").length,
      1,
    );
    assert.equal(
      toolCalls.filter((line) => line === "npm run typecheck").length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test("classification excludes a treatment whose behavior context drifted during the arm", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  try {
    const sidekickRoot = join(fixture.env.HOME, ".sidekick");
    mkdirSync(sidekickRoot, { recursive: true });
    writeFileSync(
      join(sidekickRoot, "SIDEKICK.md"),
      "This instruction appeared after dispatch.\n",
      "utf8",
    );
    const result = runClassifier(
      fixture,
      [
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-sonnet-sidekick",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      {
        CHD_EXPERIMENT_2702_TEST_MODE: "1",
        CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "behavior-context-drift");
    assert.match(
      classification.behaviorVerification.behaviorContextDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(classification.checkResults, []);
  } finally {
    fixture.cleanup();
  }
});

test("a missing declared-check tool is excluded and authorizes one manual retry", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 127 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-sonnet-sidekick",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "tooling-artifact");
    assert.equal(classification.error.checkId, "checks/gate-2702-typecheck");
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "tooling-artifact",
      maximumAttempt: 2,
    });
  } finally {
    fixture.cleanup();
  }
});

test("a signalled declared check is excluded as a tooling artifact", () => {
  const fixture = createEvidenceFixture({
    vitestSignal: "SIGTERM",
    typecheckExit: 0,
  });
  try {
    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-solo",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "tooling-artifact");
    assert.equal(classification.error.checkId, "checks/gate-2702-vitest");
    assert.equal(classification.checkResults[0].signal, "SIGTERM");
    assert.equal(classification.retry.authorized, true);
  } finally {
    fixture.cleanup();
  }
});

test("classification resumes from immutable completed check receipts", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  const args = [
    "classify",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--treatment",
    "haiku-solo",
    "--attempt",
    "1",
    "--state-root",
    fixture.stateRoot,
  ];
  try {
    const first = runClassifier(fixture, args);
    assert.equal(first.status, 0, first.stderr);
    const runDir = join(
      fixture.trialRoot,
      "runs",
      "issue-2760",
      "haiku-solo",
      "attempt-1",
    );
    rmSync(join(runDir, "classification.json"));
    const checks = join(runDir, "checks");
    for (const suffix of [
      ".json",
      ".pre-dispatch.json",
      ".process.json",
      ".dispatch-gate",
      ".outcome.json",
      ".stdout.log",
      ".stderr.log",
    ]) {
      rmSync(join(checks, `checks_gate-2702-typecheck${suffix}`));
    }

    const resumed = runClassifier(fixture, args);
    assert.equal(resumed.status, 0, resumed.stderr);
    const calls = readFileSync(fixture.toolLog, "utf8").trim().split("\n");
    assert.equal(calls.filter((line) => line === "npx vitest run").length, 1);
    assert.equal(
      calls.filter((line) => line === "npm run typecheck").length,
      2,
    );
    const classification = JSON.parse(resumed.stdout);
    assert.equal(classification.status, "succeeded");
    assert.equal(classification.eligible, true);
  } finally {
    fixture.cleanup();
  }
});

async function assertOrphanedCheckRecovery({
  pauseVitestBeforeLog,
  expectedVitestCalls,
}) {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    vitestDelayMs: 5_000,
    pauseVitestBeforeLog,
  });
  const args = [
    "classify",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--treatment",
    "haiku-solo",
    "--attempt",
    "1",
    "--state-root",
    fixture.stateRoot,
  ];
  const env = {
    ...fixture.env,
    CHD_EXPERIMENT_2702_TEST_MODE: "1",
    CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS: "5000",
  };
  let child;
  let processReceipt;
  let childStdout = "";
  let childStderr = "";
  try {
    child = spawn(process.execPath, [CLASSIFIER, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      childStdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      childStderr += chunk;
    });
    const processPath = join(
      fixture.trialRoot,
      "runs",
      "issue-2760",
      "haiku-solo",
      "attempt-1",
      "checks",
      "checks_gate-2702-vitest.process.json",
    );
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `classifier exited before the process receipt: ${childStdout}\n${childStderr}`,
        );
      }
      return existsSync(processPath);
    }, "the durable check process receipt");
    processReceipt = JSON.parse(readFileSync(processPath, "utf8"));
    if (pauseVitestBeforeLog) {
      await waitFor(
        () => existsSync(fixture.vitestBeforeLog),
        "the paused vitest process before its tool-log append",
      );
    } else {
      await waitFor(
        () => toolCallCount(fixture.toolLog, "npx vitest run") === 1,
        "the active vitest tool-log append",
      );
    }
    assert.equal(
      toolCallCount(fixture.toolLog, "npx vitest run"),
      expectedVitestCalls,
    );
    child.kill("SIGKILL");
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      "the original classifier to die",
    );

    const resumed = spawnSync(process.execPath, [CLASSIFIER, ...args], {
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const classification = JSON.parse(resumed.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "tooling-artifact");
    assert.equal(classification.checkResults[0].interrupted, true);
    assert.equal(classification.checkResults[0].processGroupQuiescent, true);
    assert.equal(
      toolCallCount(fixture.toolLog, "npx vitest run"),
      expectedVitestCalls,
    );
    assert.equal(processIsActive(processReceipt.pid), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    if (processReceipt && processIsActive(processReceipt.pid)) {
      try {
        process.kill(
          process.platform === "win32"
            ? processReceipt.pid
            : -processReceipt.pid,
          "SIGKILL",
        );
      } catch {
        // Best effort: recovery may have made the exact process group quiescent.
      }
    }
    fixture.cleanup();
  }
}

test("classification recovers a process receipt killed before the tool-log append without dispatching", async () => {
  await assertOrphanedCheckRecovery({
    pauseVitestBeforeLog: true,
    expectedVitestCalls: 0,
  });
});

test("classification recovers an active logged check without dispatching a duplicate", async () => {
  await assertOrphanedCheckRecovery({
    pauseVitestBeforeLog: false,
    expectedVitestCalls: 1,
  });
});

test("a worker timeout is cancelled, excluded, and does not run checks", () => {
  const fixture = createEvidenceFixture({
    terminal: {
      outcome: "timed-out",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
    },
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "cancelled");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "timeout");
    assert.deepEqual(classification.checkResults, []);
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "timeout",
      maximumAttempt: 2,
    });
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("structured worker budget exhaustion is cancelled and never retryable", () => {
  const fixture = createEvidenceFixture({
    terminal: { exitCode: 1 },
    workerStdout: `${JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      total_cost_usd: 15,
    })}\n`,
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "cancelled");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "budget-exhausted");
    assert.deepEqual(classification.checkResults, []);
    assert.deepEqual(classification.retry, {
      authorized: false,
      reason: "budget-exhausted",
      maximumAttempt: 2,
    });
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("a non-budget worker process failure is an excluded tooling artifact", () => {
  const fixture = createEvidenceFixture({
    terminal: { exitCode: 1 },
    workerStdout: `${JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    })}\n`,
  });
  try {
    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-solo",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "worker-process-failure");
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "tooling-artifact",
      maximumAttempt: 2,
    });
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("malformed structured worker output is excluded before declared checks", () => {
  const fixture = createEvidenceFixture({ workerStdout: "{not-json\n" });
  try {
    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-solo",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "failed");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "worker-output-invalid");
    assert.deepEqual(classification.checkResults, []);
    assert.equal(classification.retry.authorized, true);
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("bounded worker evidence truncation is cancelled and retryable", () => {
  const fixture = createEvidenceFixture({
    workerStdout: "x".repeat(2 * 1024 * 1024 + 1),
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "cancelled");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "truncated-evidence");
    assert.equal(classification.workerArtifacts.stdout.truncated, true);
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "truncated-evidence",
      maximumAttempt: 2,
    });
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("declared-check output truncation is explicit, cancelled, and retryable", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    vitestBytes: 3 * 1024 * 1024,
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "cancelled");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "truncated-evidence");
    assert.equal(classification.error.checkId, "checks/gate-2702-vitest");
    assert.equal(classification.checkResults[0].truncated, true);
    const checkReceipt = JSON.parse(
      readFileSync(
        join(
          fixture.trialRoot,
          "runs",
          "issue-2760",
          "haiku-solo",
          "attempt-1",
          "checks",
          "checks_gate-2702-vitest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(checkReceipt.stdout.byteLength, 3 * 1024 * 1024);
    assert.equal(checkReceipt.stdout.capturedBytes, 2 * 1024 * 1024);
    assert.equal(
      checkReceipt.stdout.contentDigest,
      `sha256:${createHash("sha256")
        .update("x".repeat(3 * 1024 * 1024), "utf8")
        .digest("hex")}`,
    );
    assert.equal(statSync(checkReceipt.stdout.path).size, 2 * 1024 * 1024);
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "truncated-evidence",
      maximumAttempt: 2,
    });
  } finally {
    fixture.cleanup();
  }
});

test("declared-check receipts preserve bounded stdout and stderr bytes", () => {
  const fixture = createEvidenceFixture({ vitestExit: 1, typecheckExit: 0 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      { encoding: "utf8", env: fixture.env },
    );

    assert.equal(result.status, 0, result.stderr);
    const checks = join(
      fixture.trialRoot,
      "runs",
      "issue-2760",
      "haiku-solo",
      "attempt-1",
      "checks",
    );
    const stdoutPath = join(checks, "checks_gate-2702-vitest.stdout.log");
    const stderrPath = join(checks, "checks_gate-2702-vitest.stderr.log");
    assert.equal(readFileSync(stdoutPath, "utf8"), "one fixture test failed\n");
    assert.equal(readFileSync(stderrPath, "utf8"), "");
    const receipt = JSON.parse(
      readFileSync(join(checks, "checks_gate-2702-vitest.json"), "utf8"),
    );
    const preDispatch = JSON.parse(
      readFileSync(
        join(checks, "checks_gate-2702-vitest.pre-dispatch.json"),
        "utf8",
      ),
    );
    assert.match(receipt.environmentDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.environmentDigest, preDispatch.environmentDigest);
    assert.equal(receipt.preDispatchDigest, preDispatch.contentDigest);
    assert.equal(receipt.stdout.path, stdoutPath);
    assert.equal(receipt.stdout.capturedBytes, 24);
    assert.equal(receipt.stdout.byteLength, 24);
    assert.equal(receipt.stdout.truncated, false);
    assert.equal(receipt.stderr.path, stderrPath);
  } finally {
    fixture.cleanup();
  }
});

test("a declared-check timeout is cancelled and authorizes one retry", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    vitestDelayMs: 250,
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLASSIFIER,
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ],
      {
        encoding: "utf8",
        env: {
          ...fixture.env,
          CHD_EXPERIMENT_2702_TEST_MODE: "1",
          CHD_EXPERIMENT_2702_TEST_CHECK_TIMEOUT_MS: "25",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const classification = JSON.parse(result.stdout);
    assert.equal(classification.status, "cancelled");
    assert.equal(classification.eligible, false);
    assert.equal(classification.error.code, "timeout");
    assert.equal(classification.error.checkId, "checks/gate-2702-vitest");
    assert.equal(classification.checkResults[0].timedOut, true);
    assert.equal(classification.checkResults[0].processGroupQuiescent, true);
    assert.deepEqual(classification.retry, {
      authorized: true,
      reason: "timeout",
      maximumAttempt: 2,
    });
  } finally {
    fixture.cleanup();
  }
});

test("pair selection freezes the exact eligible registration and classification digests", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  try {
    for (const treatment of ["haiku-solo", "haiku-sonnet-sidekick"]) {
      const classified = runClassifier(fixture, [
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        treatment,
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ]);
      assert.equal(classified.status, 0, classified.stderr);
    }

    const selected = runClassifier(fixture, [
      "select",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    const receipt = JSON.parse(selected.stdout);
    assert.equal(receipt.kind, "Gate2702PairSelection");
    assert.deepEqual(Object.keys(receipt.arms), [
      "haiku-solo",
      "haiku-sonnet-sidekick",
    ]);
    for (const treatment of Object.keys(receipt.arms)) {
      const arm = receipt.arms[treatment];
      assert.equal(arm.treatmentId, treatment);
      assert.equal(arm.attempt, 1);
      const runDir = join(
        fixture.trialRoot,
        "runs",
        "issue-2760",
        treatment,
        "attempt-1",
      );
      assert.equal(
        arm.registrationDigest,
        JSON.parse(readFileSync(join(runDir, "registration.json"), "utf8"))
          .contentDigest,
      );
      assert.equal(
        arm.classificationDigest,
        JSON.parse(readFileSync(join(runDir, "classification.json"), "utf8"))
          .contentDigest,
      );
    }
    const selectionPath = join(
      fixture.trialRoot,
      "pair-selection",
      "issue-2760.json",
    );
    const before = readFileSync(selectionPath);
    const resumed = runClassifier(fixture, [
      "select",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(readFileSync(selectionPath), before);
  } finally {
    fixture.cleanup();
  }
});

test("pair selection rejects a redigested classification that changes eligibility", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 127 });
  try {
    for (const treatment of ["haiku-solo", "haiku-sonnet-sidekick"]) {
      const classified = runClassifier(fixture, [
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        treatment,
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ]);
      assert.equal(classified.status, 0, classified.stderr);
    }
    for (const treatment of ["haiku-solo", "haiku-sonnet-sidekick"]) {
      const classificationPath = join(
        fixture.trialRoot,
        "runs",
        "issue-2760",
        treatment,
        "attempt-1",
        "classification.json",
      );
      const classification = JSON.parse(
        readFileSync(classificationPath, "utf8"),
      );
      delete classification.contentDigest;
      classification.status = "succeeded";
      classification.eligible = true;
      classification.retry = {
        authorized: false,
        reason: "genuine-result",
        maximumAttempt: 2,
      };
      writeFileSync(
        classificationPath,
        `${JSON.stringify(withDigest(classification), null, 2)}\n`,
        "utf8",
      );
    }

    const selected = runClassifier(fixture, [
      "select",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(selected.status, 0);
    assert.match(
      `${selected.stdout}\n${selected.stderr}`,
      /classification|immutable receipt/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("pair selection recovers a stale dead trial lock", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  try {
    for (const treatment of ["haiku-solo", "haiku-sonnet-sidekick"]) {
      const classified = runClassifier(fixture, [
        "classify",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--treatment",
        treatment,
        "--attempt",
        "1",
        "--state-root",
        fixture.stateRoot,
      ]);
      assert.equal(classified.status, 0, classified.stderr);
    }
    const lock = join(fixture.trialRoot, "lock");
    mkdirSync(lock);
    const ownerPath = join(lock, "owner.json");
    writeFileSync(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "Gate2702TrialLock",
        trialId: fixture.trialId,
        token: randomUUID(),
        phase: "preparing",
        pid: process.pid,
        updatedAt: "2026-07-20T22:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const args = [
      "select",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ];
    const raced = runClassifier(fixture, args);
    assert.notEqual(raced.status, 0);
    assert.match(`${raced.stdout}\n${raced.stderr}`, /active|race/i);
    const staleOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
    staleOwner.pid = 999_999_999;
    writeFileSync(ownerPath, `${JSON.stringify(staleOwner)}\n`, "utf8");

    const selected = runClassifier(fixture, args);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(existsSync(lock), false);
  } finally {
    fixture.cleanup();
  }
});

test("pair selection preserves a lock with an existing reclaim owner", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  try {
    const lock = join(fixture.trialRoot, "lock");
    mkdirSync(lock);
    const ownerPath = join(lock, "owner.json");
    const reclaimPath = join(lock, "reclaim.json");
    writeFileSync(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "Gate2702TrialLock",
        trialId: fixture.trialId,
        token: randomUUID(),
        phase: "preparing",
        pid: 999_999_999,
        updatedAt: "2026-07-20T22:00:00.000Z",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      reclaimPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "Gate2702LockReclaim",
        trialId: fixture.trialId,
        token: randomUUID(),
        pid: 999_999_998,
        createdAt: "2026-07-20T22:00:01.000Z",
      })}\n`,
      "utf8",
    );
    const ownerBytes = readFileSync(ownerPath);
    const reclaimBytes = readFileSync(reclaimPath);

    const selected = runClassifier(fixture, [
      "select",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(selected.status, 0);
    assert.match(
      `${selected.stdout}\n${selected.stderr}`,
      /reclamation|unrecoverable lock/i,
    );
    assert.deepEqual(readFileSync(ownerPath), ownerBytes);
    assert.deepEqual(readFileSync(reclaimPath), reclaimBytes);
  } finally {
    fixture.cleanup();
  }
});

test("paired preflight installs and fingerprints both fresh C5 worktrees before dispatch", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
  });
  try {
    const result = runClassifier(
      fixture,
      [
        "preflight",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--state-root",
        fixture.stateRoot,
      ],
      {
        CHD_EXPERIMENT_2702_TEST_MODE: "1",
        CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.kind, "Gate2702PairPreflight");
    assert.equal(receipt.status, "passed");
    assert.deepEqual(Object.keys(receipt.arms), [
      "haiku-solo",
      "haiku-sonnet-sidekick",
    ]);
    assert.equal(receipt.environment.node.version, process.version);
    assert.equal(receipt.environment.npm.version, "10.9.2");
    assert.equal(receipt.environment.claude.version, "2.1.12 (Claude Code)");
    assert.equal(
      receipt.environment.vitest.version,
      "vitest/3.2.4 linux-x64 node-v22",
    );
    assert.equal(receipt.environment.typescript.version, "Version 5.8.3");
    assert.equal(
      receipt.arms["haiku-sonnet-sidekick"].sidekick.version,
      "0.3.3",
    );
    assert.match(
      receipt.arms["haiku-sonnet-sidekick"].sidekick.implementationDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      receipt.arms["haiku-sonnet-sidekick"].sidekick.configuration,
      {
        enabled: true,
        reviewerTier: "sonnet",
        gate: "checkpoint",
        sessionBudgetUsd: 2,
        perCallBudgetUsd: 1,
      },
    );
    const controlContext = receipt.arms["haiku-solo"].behaviorContext;
    const treatmentContext =
      receipt.arms["haiku-sonnet-sidekick"].behaviorContext;
    assert.equal(
      controlContext.workerModelQualifiedId,
      "claude-haiku-4-5-20251001",
    );
    assert.equal(controlContext.sidekickModelQualifiedId, null);
    assert.equal(controlContext.sidekickActivation, null);
    assert.equal(controlContext.resolvedSidekickConfig.enabled, false);
    assert.equal(treatmentContext.sidekickModelQualifiedId, "claude-sonnet-5");
    assert.deepEqual(treatmentContext.sidekickActivation, {
      pluginEnabled: true,
      globalPauseAbsent: true,
    });
    assert.equal(treatmentContext.resolvedSidekickConfig.gate, "checkpoint");
    assert.equal(
      treatmentContext.resolvedSidekickConfig.model,
      "claude-sonnet-5",
    );
    assert.deepEqual(treatmentContext.instructionSources, []);
    for (const context of [controlContext, treatmentContext]) {
      assert.match(
        context.resolvedSidekickConfigDigest,
        /^sha256:[0-9a-f]{64}$/,
      );
      assert.match(context.instructionsDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(
      readFileSync(fixture.toolLog, "utf8")
        .split("\n")
        .filter((line) => line === "npm ci").length,
      2,
    );
  } finally {
    fixture.cleanup();
  }
});

test("resumed pair preflight rejects live per-arm tool, tree, and Sidekick drift", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
  });
  const args = [
    "preflight",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--state-root",
    fixture.stateRoot,
  ];
  try {
    const first = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
    });
    assert.equal(first.status, 0, first.stderr);

    const treatmentToolsDrifted = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      GATE2702_BREAK_TREATMENT_TOOLS: "1",
    });
    assert.notEqual(treatmentToolsDrifted.status, 0);
    assert.match(
      `${treatmentToolsDrifted.stdout}\n${treatmentToolsDrifted.stderr}`,
      /live.*environment.*drift|drifted.*preflight/i,
    );

    const sourceTreeDrifted = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      GATE2702_DIRTY_TREATMENT_TREE: "1",
    });
    assert.notEqual(sourceTreeDrifted.status, 0);
    assert.match(
      `${sourceTreeDrifted.stdout}\n${sourceTreeDrifted.stderr}`,
      /live.*environment.*drift|drifted.*preflight/i,
    );

    const drifted = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.4",
    });
    assert.notEqual(drifted.status, 0);
    assert.match(
      `${drifted.stdout}\n${drifted.stderr}`,
      /sidekick|behavior context|drift/i,
    );

    const modelDrifted = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      CHD_EXPERIMENT_2702_WORKER_MODEL_ID: "claude-haiku-test-drift",
    });
    assert.notEqual(modelDrifted.status, 0);
    assert.match(
      `${modelDrifted.stdout}\n${modelDrifted.stderr}`,
      /behavior context.*(?:invalid|drift)/i,
    );

    const instructionRoot = join(fixture.root, "home", ".sidekick");
    mkdirSync(instructionRoot, { recursive: true });
    const instructionPath = join(instructionRoot, "SIDEKICK.md");
    writeFileSync(
      instructionPath,
      "Review database migrations closely.\n",
      "utf8",
    );
    const instructionsDrifted = runClassifier(fixture, args, {
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
    });
    assert.notEqual(instructionsDrifted.status, 0);
    assert.match(
      `${instructionsDrifted.stdout}\n${instructionsDrifted.stderr}`,
      /behavior context.*(?:invalid|drift)/i,
    );
    rmSync(instructionPath);
    assert.equal(
      readFileSync(fixture.toolLog, "utf8")
        .split("\n")
        .filter((line) => line === "npm ci").length,
      2,
    );
  } finally {
    fixture.cleanup();
  }
});

test("paired preflight fails closed when Sidekick is paused or disabled", () => {
  for (const blockedState of ["paused", "disabled"]) {
    const fixture = createEvidenceFixture({
      vitestExit: 0,
      typecheckExit: 0,
      includePreflight: false,
    });
    try {
      const env = {
        CHD_EXPERIMENT_2702_TEST_MODE: "1",
        CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      };
      if (blockedState === "paused") {
        const sidekickRoot = join(fixture.env.HOME, ".sidekick");
        mkdirSync(sidekickRoot, { recursive: true });
        writeFileSync(join(sidekickRoot, "paused"), "", "utf8");
      } else {
        env.CHD_EXPERIMENT_2702_TEST_SIDEKICK_ENABLED = "0";
      }
      const result = runClassifier(
        fixture,
        [
          "preflight",
          "--trial",
          fixture.trialId,
          "--subject",
          "2760",
          "--state-root",
          fixture.stateRoot,
        ],
        env,
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.status, "failed");
      assert.match(
        JSON.stringify(receipt.errors),
        blockedState === "paused"
          ? /globally paused/i
          : /plugin to be enabled/i,
      );
      assert.equal(receipt.arms["haiku-sonnet-sidekick"].behaviorContext, null);
    } finally {
      fixture.cleanup();
    }
  }
});

test("paired preflight fails closed when the arm lockfiles do not match", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
    treatmentLockfile: '{"drifted":true}\n',
  });
  try {
    const result = runClassifier(
      fixture,
      [
        "preflight",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--state-root",
        fixture.stateRoot,
      ],
      {
        CHD_EXPERIMENT_2702_TEST_MODE: "1",
        CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, "failed");
    assert.ok(
      receipt.errors.some((error) => error.code === "lockfile-mismatch"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("timed-out npm ci descendants are quiescent before preflight fails", () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
    installDelayMs: 5_000,
    installDescendant: true,
  });
  try {
    const result = runClassifier(
      fixture,
      [
        "preflight",
        "--trial",
        fixture.trialId,
        "--subject",
        "2760",
        "--state-root",
        fixture.stateRoot,
      ],
      {
        CHD_EXPERIMENT_2702_TEST_MODE: "1",
        CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
        CHD_EXPERIMENT_2702_TEST_PREFLIGHT_INSTALL_TIMEOUT_MS: "1000",
        CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS: "2000",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, "failed");
    assert.ok(receipt.errors.some((error) => error.code === "npm-ci-failed"));
    const descendantPids = readFileSync(fixture.installDescendants, "utf8")
      .trim()
      .split("\n")
      .map(Number);
    assert.equal(descendantPids.length, 2);
    assert.ok(descendantPids.every((pid) => !pidIsActive(pid)));
    assert.ok(
      Object.values(receipt.arms).every(
        (arm) => arm.install.processGroupQuiescent === true,
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("resumed pair preflight never repeats an interrupted npm ci", async () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
    installDelayMs: 60_000,
    installDescendant: true,
    slowInstallTreatment: "haiku-solo",
  });
  const args = [
    "preflight",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--state-root",
    fixture.stateRoot,
  ];
  const env = {
    ...fixture.env,
    CHD_EXPERIMENT_2702_TEST_MODE: "1",
    CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
    CHD_EXPERIMENT_2702_TEST_PREFLIGHT_INSTALL_TIMEOUT_MS: "120000",
    CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS: "2000",
  };
  const runDir = join(
    fixture.trialRoot,
    "runs",
    "issue-2760",
    "haiku-solo",
    "attempt-1",
  );
  const worktreePath = join(
    fixture.trialRoot,
    "worktrees",
    "issue-2760.haiku-solo.attempt-1",
  );
  const installRoot = join(runDir, "preflight-install");
  const processPath = join(installRoot, "process.json");
  const executionPath = join(installRoot, "execution.json");
  let classifier = null;
  try {
    classifier = spawn(process.execPath, [CLASSIFIER, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let classifierStderr = "";
    classifier.stderr.setEncoding("utf8");
    classifier.stderr.on("data", (chunk) => {
      classifierStderr += chunk;
    });
    const closed = new Promise((resolveClose) =>
      classifier.once("close", (exitCode, signal) =>
        resolveClose({ exitCode, signal }),
      ),
    );

    await waitFor(
      () =>
        classifier.exitCode !== null
          ? (() => {
              throw new Error(
                `classifier exited before npm-ci dispatch: ${classifierStderr}`,
              );
            })()
          : existsSync(processPath) &&
            existsSync(fixture.installDescendants) &&
            readFileSync(fixture.installDescendants, "utf8").trim(),
      "durable npm-ci process and descendant",
    );
    const descendantPid = Number(
      readFileSync(fixture.installDescendants, "utf8").trim(),
    );
    assert.ok(pidIsActive(descendantPid));

    classifier.kill("SIGKILL");
    const interrupted = await closed;
    assert.equal(interrupted.signal, "SIGKILL");
    classifier = null;

    const resumed = spawnSync(process.execPath, [CLASSIFIER, ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const pair = JSON.parse(resumed.stdout);
    assert.equal(pair.status, "failed");
    assert.ok(
      pair.errors.some(
        (error) =>
          error.treatmentId === "haiku-solo" && error.code === "npm-ci-failed",
      ),
    );
    assert.equal(pidIsActive(descendantPid), false);

    const executionBytes = readFileSync(executionPath);
    const execution = JSON.parse(executionBytes);
    assert.equal(execution.kind, "Gate2702InstallExecution");
    assert.equal(execution.interrupted, true);
    assert.equal(execution.processGroupQuiescent, true);
    assert.equal(
      pair.arms["haiku-solo"].install.contentDigest,
      execution.contentDigest,
    );
    assert.equal(
      readFileSync(fixture.installInvocations, "utf8")
        .trim()
        .split("\n")
        .filter((path) => path === worktreePath).length,
      1,
    );

    const replayed = spawnSync(process.execPath, [CLASSIFIER, ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(readFileSync(executionPath), executionBytes);
    assert.equal(
      readFileSync(fixture.installInvocations, "utf8")
        .trim()
        .split("\n")
        .filter((path) => path === worktreePath).length,
      1,
    );
  } finally {
    if (classifier?.pid && pidIsActive(classifier.pid)) {
      classifier.kill("SIGKILL");
    }
    if (existsSync(processPath)) {
      const installProcess = JSON.parse(readFileSync(processPath, "utf8"));
      if (processIsActive(installProcess.pid)) {
        try {
          process.kill(
            process.platform === "win32"
              ? installProcess.pid
              : -installProcess.pid,
            "SIGKILL",
          );
        } catch {
          // The process may exit between the liveness check and the signal.
        }
      }
    }
    fixture.cleanup();
  }
});

test("detached npm ci enforces its timeout after the classifier dies", async () => {
  const fixture = createEvidenceFixture({
    vitestExit: 0,
    typecheckExit: 0,
    includePreflight: false,
    installDelayMs: 60_000,
    installDescendant: true,
    slowInstallTreatment: "haiku-solo",
  });
  const args = [
    "preflight",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--state-root",
    fixture.stateRoot,
  ];
  const env = {
    ...fixture.env,
    CHD_EXPERIMENT_2702_TEST_MODE: "1",
    CHD_EXPERIMENT_2702_TEST_SIDEKICK_VERSION: "0.3.3",
    CHD_EXPERIMENT_2702_TEST_PREFLIGHT_INSTALL_TIMEOUT_MS: "500",
    CHD_EXPERIMENT_2702_TEST_PROCESS_GRACE_MS: "1000",
  };
  const runDir = join(
    fixture.trialRoot,
    "runs",
    "issue-2760",
    "haiku-solo",
    "attempt-1",
  );
  const worktreePath = join(
    fixture.trialRoot,
    "worktrees",
    "issue-2760.haiku-solo.attempt-1",
  );
  const installRoot = join(runDir, "preflight-install");
  const processPath = join(installRoot, "process.json");
  const outcomePath = join(installRoot, "outcome.json");
  const executionPath = join(installRoot, "execution.json");
  let classifier = null;
  try {
    classifier = spawn(process.execPath, [CLASSIFIER, ...args], {
      env,
      stdio: "ignore",
    });
    const closed = new Promise((resolveClose) =>
      classifier.once("close", (exitCode, signal) =>
        resolveClose({ exitCode, signal }),
      ),
    );
    await waitFor(
      () =>
        existsSync(processPath) &&
        existsSync(fixture.installDescendants) &&
        readFileSync(fixture.installDescendants, "utf8").trim(),
      "detached npm-ci process and descendant",
    );
    const installProcess = JSON.parse(readFileSync(processPath, "utf8"));
    const descendantPid = Number(
      readFileSync(fixture.installDescendants, "utf8").trim(),
    );

    classifier.kill("SIGKILL");
    const killed = await closed;
    assert.equal(killed.signal, "SIGKILL");
    classifier = null;

    await waitFor(
      () => existsSync(outcomePath) && !processIsActive(installProcess.pid),
      "detached npm ci to enforce its own timeout",
      5_000,
    );
    assert.equal(pidIsActive(descendantPid), false);
    assert.equal(existsSync(executionPath), false);

    const resumed = spawnSync(process.execPath, [CLASSIFIER, ...args], {
      encoding: "utf8",
      env,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const execution = JSON.parse(readFileSync(executionPath, "utf8"));
    assert.equal(execution.timedOut, true);
    assert.equal(execution.interrupted, false);
    assert.equal(execution.processGroupQuiescent, true);
    assert.equal(execution.error, "install-timeout");
    assert.equal(
      readFileSync(fixture.installInvocations, "utf8")
        .trim()
        .split("\n")
        .filter((path) => path === worktreePath).length,
      1,
    );
  } finally {
    if (classifier?.pid && pidIsActive(classifier.pid)) {
      classifier.kill("SIGKILL");
    }
    if (existsSync(processPath)) {
      const installProcess = JSON.parse(readFileSync(processPath, "utf8"));
      if (processIsActive(installProcess.pid)) {
        try {
          process.kill(
            process.platform === "win32"
              ? installProcess.pid
              : -installProcess.pid,
            "SIGKILL",
          );
        } catch {
          // The process may exit between the liveness check and the signal.
        }
      }
    }
    fixture.cleanup();
  }
});

test("classification rejects a redigested preflight with the wrong Sidekick config", () => {
  const fixture = createEvidenceFixture();
  try {
    const path = join(fixture.trialRoot, "preflight", "issue-2760.json");
    const preflight = JSON.parse(readFileSync(path, "utf8"));
    delete preflight.contentDigest;
    preflight.arms["haiku-sonnet-sidekick"].sidekick.configuration.gate =
      "stop";
    writeFileSync(
      path,
      `${JSON.stringify(withDigest(preflight), null, 2)}\n`,
      "utf8",
    );
    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-sonnet-sidekick",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /sidekick.*config/i);
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("classification rejects a self-consistent dispatch that enables the nested Sidekick bypass", () => {
  const fixture = createEvidenceFixture();
  try {
    const runDir = join(
      fixture.trialRoot,
      "runs",
      "issue-2760",
      "haiku-sonnet-sidekick",
      "attempt-1",
    );
    const preDispatchPath = join(runDir, "pre-dispatch.json");
    const processPath = join(runDir, "process.json");
    const terminalPath = join(runDir, "terminal.json");
    const preDispatch = JSON.parse(readFileSync(preDispatchPath, "utf8"));
    delete preDispatch.contentDigest;
    preDispatch.sidekickEnvironment.SIDEKICK_NESTED = "1";
    preDispatch.sidekickEnvironmentDigest = `sha256:${createHash("sha256")
      .update(
        JSON.stringify(canonicalValue(preDispatch.sidekickEnvironment)),
        "utf8",
      )
      .digest("hex")}`;
    const changedPreDispatch = withDigest(preDispatch);
    writeFileSync(
      preDispatchPath,
      `${JSON.stringify(changedPreDispatch, null, 2)}\n`,
      "utf8",
    );

    const processReceipt = JSON.parse(readFileSync(processPath, "utf8"));
    delete processReceipt.contentDigest;
    processReceipt.preDispatchDigest = changedPreDispatch.contentDigest;
    const changedProcess = withDigest(processReceipt);
    writeFileSync(
      processPath,
      `${JSON.stringify(changedProcess, null, 2)}\n`,
      "utf8",
    );

    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    delete terminal.contentDigest;
    terminal.preDispatchDigest = changedPreDispatch.contentDigest;
    terminal.processDigest = changedProcess.contentDigest;
    writeFileSync(
      terminalPath,
      `${JSON.stringify(withDigest(terminal), null, 2)}\n`,
      "utf8",
    );

    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-sonnet-sidekick",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /fixed C5 environment/i);
  } finally {
    fixture.cleanup();
  }
});

test("classification rejects production-labelled evidence from an arbitrary test worker", () => {
  const fixture = createEvidenceFixture({
    executionMode: "production",
    workerArgv: [process.execPath, "fake-worker.mjs"],
  });
  try {
    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-sonnet-sidekick",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /production C5 dispatch used an unregistered worker invocation/i,
    );
    assert.equal(existsSync(fixture.toolLog), false);
  } finally {
    fixture.cleanup();
  }
});

test("classification requires the worker's monotonic wall-time evidence", () => {
  const fixture = createEvidenceFixture({ vitestExit: 0, typecheckExit: 0 });
  try {
    const terminalPath = join(
      fixture.trialRoot,
      "runs",
      "issue-2760",
      "haiku-solo",
      "attempt-1",
      "terminal.json",
    );
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    delete terminal.contentDigest;
    delete terminal.durationMs;
    writeFileSync(
      terminalPath,
      `${JSON.stringify(withDigest(terminal), null, 2)}\n`,
      "utf8",
    );

    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-solo",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /monotonic duration/i);
  } finally {
    fixture.cleanup();
  }
});

test("classification rejects an embedded npm-ci result not bound to persisted evidence", () => {
  const fixture = createEvidenceFixture();
  try {
    const path = join(fixture.trialRoot, "preflight", "issue-2760.json");
    const preflight = JSON.parse(readFileSync(path, "utf8"));
    delete preflight.contentDigest;
    preflight.arms["haiku-solo"].install.exitCode = 1;
    writeFileSync(
      path,
      `${JSON.stringify(withDigest(preflight), null, 2)}\n`,
      "utf8",
    );

    const result = runClassifier(fixture, [
      "classify",
      "--trial",
      fixture.trialId,
      "--subject",
      "2760",
      "--treatment",
      "haiku-solo",
      "--attempt",
      "1",
      "--state-root",
      fixture.stateRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /embedded npm-ci digest does not match persisted evidence/i,
    );
  } finally {
    fixture.cleanup();
  }
});
