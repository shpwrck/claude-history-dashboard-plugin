import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  GATE_2702_SIDEKICK_VERSION,
  gate2702ModelIds,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";
import {
  GATE_2702_SANDBOX_ENV_KEYS,
  GATE_2702_SRT_INJECTED_ENV_KEYS,
} from "./sandbox-dispatch.mjs";
import { GATE_2702_BROKER_PLACEHOLDER_TOKEN } from "./credential-broker.mjs";
import { captureGate2702WorktreeEvidence } from "./worktree-evidence.mjs";
import { shellQuote } from "../lib/shell-quote.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JUDGE = join(HERE, "judge.mjs");
const TRIAL_ID = "4f503910-77de-4ac0-b454-3ac913d96288";
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest: DEFINITION_DIGEST,
};
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const TREATMENT_CONFIGURATIONS = {
  "haiku-solo": {
    configuration: {
      sidekick: {
        enabled: false,
        sessionBudgetUsd: 0,
        perCallBudgetUsd: 0,
      },
    },
  },
  "haiku-sonnet-sidekick": {
    configuration: {
      sidekick: {
        enabled: true,
        reviewerTier: "sonnet",
        gate: "checkpoint",
        sessionBudgetUsd: 2,
        perCallBudgetUsd: 1,
      },
    },
  },
};

function writeExecutable(path, source) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
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

function valueDigest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex")}`;
}

function bytesDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return {
    ...withoutDigest,
    contentDigest: valueDigest(withoutDigest),
  };
}

function writeReceipt(path, receipt) {
  const value = withDigest(receipt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function scores(a, b) {
  const dimensions = {
    correctness: a,
    design: a,
    completeness: a,
    clarity: a,
    scopeFit: a,
    autonomy: a,
  };
  return {
    A: dimensions,
    B: Object.fromEntries(Object.keys(dimensions).map((key) => [key, b])),
  };
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

function uniqueSorted(values) {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function sandboxedWorkerDispatch({
  registration,
  worktreeIdentity,
  sidekickEnvironment,
  root,
  workerArgv,
}) {
  const testMode = registration.executionMode === "test";
  const hostHome = join(root, "simulated-host-home");
  const sandboxRoot = join(registration.runDir, "sandbox");
  const isolatedHome = join(sandboxRoot, "home");
  const settingsPath = join(sandboxRoot, "settings.json");
  const brokerCaCertPath = join(sandboxRoot, "broker-ca.crt");
  const brokerSocketPath = join(hostHome, ".claude", ".g2702-fixture.sock");
  const packageRoot = join(
    root,
    "runtime",
    "node_modules",
    "@anthropic-ai",
    "sandbox-runtime",
  );
  const cliPath = join(packageRoot, "dist", "cli.js");
  const toolRoot = join(root, "runtime", "bin");
  const tools = ["bwrap", "socat", "rg"].map((name) => ({
    name,
    command: join(toolRoot, name),
    resolved: join(toolRoot, name),
    version: `${name} fixture`,
  }));
  const rg = tools.find((tool) => tool.name === "rg");
  const claude = join(toolRoot, "claude");
  const gitCommonDirectory = resolve(worktreeIdentity.gitDirectory, "../..");
  const sidekickPath = resolve(
    registration.runDir,
    "../../../..",
    "sandbox-runtime",
    `claude-sidekick-${GATE_2702_SIDEKICK_VERSION}`,
  );
  const sandboxWorkerArgv = testMode
    ? [...workerArgv]
    : [claude, ...workerArgv.slice(1), "--plugin-dir", sidekickPath];
  const allowedReadRoots = uniqueSorted([
    registration.worktreePath,
    registration.runDir,
    worktreeIdentity.gitDirectory,
    gitCommonDirectory,
    packageRoot,
    rg.resolved,
    sandboxWorkerArgv[0],
    ...(testMode ? [] : [sidekickPath]),
  ]);
  const allowedWriteRoots = uniqueSorted([
    registration.worktreePath,
    isolatedHome,
    worktreeIdentity.gitDirectory,
  ]);
  const policy = {
    network: {
      allowedDomains: testMode ? [] : ["api.anthropic.com"],
      deniedDomains: [],
      mitmProxy: {
        socketPath: brokerSocketPath,
        domains: ["api.anthropic.com"],
      },
    },
    filesystem: {
      denyRead: [hostHome],
      allowRead: allowedReadRoots,
      allowWrite: allowedWriteRoots,
      denyWrite: ["/tmp/claude", "/private/tmp/claude"],
    },
    ripgrep: { command: rg.resolved },
    bwrapPath: tools.find((tool) => tool.name === "bwrap").resolved,
    socatPath: tools.find((tool) => tool.name === "socat").resolved,
  };
  const environment = {
    CHD_EXPERIMENT_2702_ATTEMPT: String(registration.attempt),
    CHD_EXPERIMENT_2702_BASE_SHA: registration.baseSha,
    CHD_EXPERIMENT_2702_RUN_DIR: registration.runDir,
    CHD_EXPERIMENT_2702_SUBJECT: String(registration.subject),
    CHD_EXPERIMENT_2702_TREATMENT: registration.treatmentId,
    CHD_EXPERIMENT_2702_TRIAL_ID: registration.trialId,
    AWS_CA_BUNDLE: brokerCaCertPath,
    CARGO_HTTP_CAINFO: brokerCaCertPath,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_TMPDIR: join(isolatedHome, "tmp"),
    CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
    CLAUDE_CODE_OAUTH_TOKEN: GATE_2702_BROKER_PLACEHOLDER_TOKEN,
    CURL_CA_BUNDLE: brokerCaCertPath,
    DENO_CERT: brokerCaCertPath,
    DISABLE_AUTOUPDATER: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSL_CAINFO: brokerCaCertPath,
    HOME: isolatedHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NPM_CONFIG_CACHE: join(isolatedHome, ".npm"),
    NPM_CONFIG_USERCONFIG: join(isolatedHome, ".npmrc"),
    NODE_EXTRA_CA_CERTS: brokerCaCertPath,
    PATH: [
      ...new Set([
        dirname(rg.resolved),
        dirname(sandboxWorkerArgv[0]),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]),
    ].join(":"),
    PIP_CERT: brokerCaCertPath,
    REQUESTS_CA_BUNDLE: brokerCaCertPath,
    SHELL: "/bin/bash",
    SSL_CERT_FILE: brokerCaCertPath,
    TERM: "dumb",
    TMPDIR: "/tmp",
    TZ: "UTC",
    XDG_CACHE_HOME: join(isolatedHome, ".cache"),
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    ...sidekickEnvironment,
  };
  const argv = [
    process.execPath,
    cliPath,
    "-s",
    settingsPath,
    "-c",
    [
      `cd ${shellQuote(registration.worktreePath)}`,
      `exec ${sandboxWorkerArgv.map(shellQuote).join(" ")}`,
    ].join(" && "),
  ];
  return {
    argv,
    environment,
    environmentDigest: valueDigest(environment),
    environmentKeys: [
      ...new Set([
        ...GATE_2702_SANDBOX_ENV_KEYS,
        ...Object.keys(sidekickEnvironment),
      ]),
    ].sort(),
    workerEnvironmentKeys: [
      ...new Set([
        ...GATE_2702_SANDBOX_ENV_KEYS,
        ...Object.keys(sidekickEnvironment),
        ...GATE_2702_SRT_INJECTED_ENV_KEYS,
      ]),
    ].sort(),
    sandbox: {
      enforcer: "srt",
      package: {
        name: "@anthropic-ai/sandbox-runtime",
        version: "0.0.52",
        root: packageRoot,
        cliPath,
        manifestDigest: `sha256:${"1".repeat(64)}`,
        cliDigest: `sha256:${"2".repeat(64)}`,
      },
      launcherExecutable: argv[0],
      tools,
      policy,
      policyDigest: valueDigest(policy),
      allowedReadRoots,
      allowedWriteRoots,
      gitDirectory: worktreeIdentity.gitDirectory,
      gitCommonDirectory,
      hostHome,
      hostHomeDenied: true,
      isolatedHome,
      credentialMode: "host-proxy-bearer-injection",
      credentialBroker: {
        transport: "srt-mitm-unix",
        socketPath: brokerSocketPath,
        caCertPath: brokerCaCertPath,
        caCertDigest: `sha256:${"4".repeat(64)}`,
        modelDomain: "api.anthropic.com",
        allowedRequests: [
          { method: "GET", path: "/api/hello" },
          { method: "POST", path: "/v1/messages?beta=true" },
        ],
        requestPolicy: {
          allowedModels: [
            sandboxWorkerArgv.includes("--model")
              ? sandboxWorkerArgv[sandboxWorkerArgv.indexOf("--model") + 1]
              : "claude-haiku-4-5-20251001",
            ...(sidekickEnvironment.SIDEKICK_ENABLE === "1"
              ? [
                  sidekickEnvironment.SIDEKICK_MODEL,
                  sidekickEnvironment.SIDEKICK_TRIAGE_MODEL,
                ]
              : []),
          ],
          wallTimeMs: 3_000_000,
          costCapUsd: 18,
          maxRequests: 256,
          maxTokensPerRequest: 65_536,
          maxTotalOutputTokens: 1_800_000,
          maxCostMicroUsd: 18_000_000,
          maxConnections: 8,
          maxActiveRequests: 4,
          maxBufferedRequestBodyBytes: 8 * 1024 * 1024,
          familyRatesMicroUsd: {
            haiku: { input: 2, output: 5 },
            sonnet: { input: 6, output: 15 },
          },
        },
        tokenRefresh: "operator-outside-jail-required",
      },
      sidekickSnapshot: testMode
        ? null
        : {
            path: sidekickPath,
            contentDigest: `sha256:${"3".repeat(64)}`,
          },
      workerArgv: sandboxWorkerArgv,
    },
  };
}

function createFixture({
  responses,
  workerResultBytes = 0,
  failedTreatments = [],
  ineligibleTreatment = null,
  executionMode = "production",
  invalidPromptDigest = false,
  invalidWorktreeIdentityDigest = false,
  protectedCanary = null,
  omitOriginSandbox = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-judge-"));
  const repo = join(root, "repo");
  const stateRoot = join(root, "state");
  const trialRoot = join(
    stateRoot,
    DEFINITION_DIGEST.replace(":", "-"),
    TRIAL_ID,
  );
  const worktrees = join(trialRoot, "worktrees");
  const tools = join(root, "tools");
  const callLog = join(root, "judge-calls.jsonl");
  const responsePath = join(root, "responses.json");
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(tools, { recursive: true });
  if (protectedCanary) {
    const simulatedClaudeRoot = join(root, "simulated-host-home", ".claude");
    mkdirSync(simulatedClaudeRoot, { recursive: true });
    writeFileSync(
      join(simulatedClaudeRoot, "history.jsonl"),
      `${protectedCanary}\n`,
      "utf8",
    );
  }
  git(repo, ["init", "--quiet", "--initial-branch=master"]);
  git(repo, ["config", "user.name", "Gate 2702 Test"]);
  git(repo, ["config", "user.email", "gate-2702@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "--quiet", "-m", "fixture base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  const modelEnv = {
    ...process.env,
    CHD_EXPERIMENT_2702_WORKER_MODEL_ID: "claude-haiku-4-5-20251001",
    CHD_EXPERIMENT_2702_SIDEKICK_MODEL_ID: "claude-sonnet-5",
  };
  const registrations = {};
  const runData = {};
  for (const [index, treatmentId] of TREATMENTS.entries()) {
    const worktreePath = join(worktrees, `issue-2760.${treatmentId}.attempt-1`);
    git(repo, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktreePath,
      baseSha,
    ]);
    writeFileSync(
      join(worktreePath, "tracked.txt"),
      index === 0 ? "control change\n" : "treatment change\n",
      "utf8",
    );
    writeFileSync(
      join(worktreePath, `new-${index}.txt`),
      `untracked ${index}\n`,
      "utf8",
    );
    const runDir = join(
      trialRoot,
      "runs",
      "issue-2760",
      treatmentId,
      "attempt-1",
    );
    const registration = writeReceipt(join(runDir, "registration.json"), {
      schemaVersion: 1,
      kind: "Gate2702ArmRegistration",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: 2760,
      subjectRef: "github:shpwrck/claude-history-dashboard#2760",
      treatmentId,
      attempt: 1,
      baseSha,
      executionMode,
      runDir,
      worktreePath,
    });
    registrations[treatmentId] = registration;
    const gitDirectory = git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const identityBody = {
      schemaVersion: 1,
      kind: "Gate2702WorktreeIdentity",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      trialId: TRIAL_ID,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      executionMode,
      worktreePath,
      gitDirectory,
      identityToken: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-07-20T21:59:59.000Z",
    };
    const worktreeIdentity = writeReceipt(
      join(runDir, "worktree-identity.json"),
      identityBody,
    );
    const marker = writeReceipt(
      join(gitDirectory, "gate-2702-worktree-identity.json"),
      identityBody,
    );
    assert.deepEqual(marker, worktreeIdentity);
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "success",
      result:
        workerResultBytes > 0
          ? `${index}:`.padEnd(workerResultBytes, "x")
          : [`Final result for arm ${index}.`, protectedCanary]
              .filter(Boolean)
              .join("\n"),
    })}\n`;
    const behaviorContext = {
      schemaVersion: 1,
      observedAt: "2026-07-20T22:00:00.000Z",
      workerModelQualifiedId: gate2702ModelIds(modelEnv).worker,
      sidekickModelQualifiedId:
        treatmentId === "haiku-sonnet-sidekick"
          ? gate2702ModelIds(modelEnv).sidekick
          : null,
      resolvedSidekickConfigDigest: valueDigest({ treatmentId }),
      instructionsDigest: bytesDigest("fixture instructions"),
    };
    writeFileSync(join(runDir, "stdout.log"), stdout, "utf8");
    writeFileSync(join(runDir, "stderr.log"), "", "utf8");
    runData[treatmentId] = {
      index,
      runDir,
      worktreePath,
      stdout,
      behaviorContext,
      worktreeIdentity,
    };
  }

  const preflight = writeReceipt(
    join(trialRoot, "preflight", "issue-2760.json"),
    {
      schemaVersion: 1,
      kind: "Gate2702PairPreflight",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: 2760,
      baseSha,
      status: "passed",
      arms: Object.fromEntries(
        TREATMENTS.map((treatmentId) => [
          treatmentId,
          {
            treatmentId,
            attempt: 1,
            registrationDigest: registrations[treatmentId].contentDigest,
            behaviorContext: runData[treatmentId].behaviorContext,
          },
        ]),
      ),
    },
  );

  const classifications = {};
  for (const treatmentId of TREATMENTS) {
    const {
      index,
      runDir,
      worktreePath,
      stdout,
      behaviorContext,
      worktreeIdentity,
    } = runData[treatmentId];
    const registration = registrations[treatmentId];
    const sidekickEnvironment = gate2702SidekickEnvironment(
      TREATMENT_CONFIGURATIONS[treatmentId],
      modelEnv,
    );
    const directWorkerArgv =
      executionMode === "production"
        ? [
            "claude",
            "-p",
            "--model",
            gate2702ModelIds(modelEnv).worker,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
            "--strict-mcp-config",
            "--max-budget-usd",
            "15",
          ]
        : [process.execPath, "fake-worker.mjs"];
    const sandboxedDispatch =
      !omitOriginSandbox
        ? sandboxedWorkerDispatch({
            registration,
            worktreeIdentity,
            sidekickEnvironment,
            root,
            workerArgv: directWorkerArgv,
          })
        : { argv: directWorkerArgv };
    const preDispatch = writeReceipt(join(runDir, "pre-dispatch.json"), {
      schemaVersion: 1,
      kind: "Gate2702PreDispatch",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      worktreeIdentityDigest: invalidWorktreeIdentityDigest
        ? bytesDigest("wrong worktree identity")
        : worktreeIdentity.contentDigest,
      trialId: TRIAL_ID,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      executionMode,
      ...sandboxedDispatch,
      sidekickEnvironment,
      sidekickEnvironmentDigest: valueDigest(sidekickEnvironment),
      cwd: worktreePath,
      promptDigest: bytesDigest(
        invalidPromptDigest
          ? "wrong prompt"
          : workerPrompt(
              {
                subject: 2760,
                title: "Fixture issue",
                body: "Implement the requested behavior without unrelated changes.",
              },
              registration,
            ),
      ),
      startedAt: "2026-07-20T22:00:00.000Z",
    });
    const processReceipt = writeReceipt(join(runDir, "process.json"), {
      schemaVersion: 1,
      kind: "Gate2702Process",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: TRIAL_ID,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      pid: 10_000 + index,
      detachedProcessGroup: true,
      startedAt: "2026-07-20T22:00:00.000Z",
    });
    const terminal = writeReceipt(join(runDir, "terminal.json"), {
      schemaVersion: 1,
      kind: "Gate2702Terminal",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
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
      durationMs: 1_000,
      endedAt: "2026-07-20T22:00:01.000Z",
    });
    const worktreeEvidence = captureGate2702WorktreeEvidence({
      worktreePath,
      baseSha,
    }).evidence;
    const checkResults = [
      {
        checkId: "checks/gate-2702-vitest",
        status: failedTreatments.includes(treatmentId) ? "failed" : "passed",
      },
      { checkId: "checks/gate-2702-typecheck", status: "passed" },
    ];
    const classification = writeReceipt(join(runDir, "classification.json"), {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: 2760,
      treatmentId,
      attempt: 1,
      baseSha,
      registrationDigest: registration.contentDigest,
      preflightDigest: preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      status: treatmentId === ineligibleTreatment ? "failed" : "succeeded",
      eligible: treatmentId !== ineligibleTreatment,
      behaviorVerification: {
        behaviorContextDigest: valueDigest(behaviorContext),
        verifiedAt: "2026-07-20T22:00:02.000Z",
      },
      workerArtifacts: {
        stdout: {
          path: join(runDir, "stdout.log"),
          byteLength: Buffer.byteLength(stdout),
          contentDigest: bytesDigest(stdout),
          capturedBytes: Buffer.byteLength(stdout),
          truncated: false,
        },
        stderr: {
          path: join(runDir, "stderr.log"),
          byteLength: 0,
          contentDigest: bytesDigest(""),
          capturedBytes: 0,
          truncated: false,
        },
      },
      worktreeEvidence,
      checkResults,
      retry: { authorized: false, reason: "genuine-result", maximumAttempt: 2 },
    });
    classifications[treatmentId] = classification;
  }

  const snapshot = writeReceipt(
    join(trialRoot, "subjects", "issue-2760.json"),
    {
      schemaVersion: 1,
      kind: "Gate2702SubjectSnapshot",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      repository: "shpwrck/claude-history-dashboard",
      executionMode,
      subject: 2760,
      baseSha,
      title: "Fixture issue",
      body: "Implement the requested behavior without unrelated changes.",
      url: "https://example.invalid/issues/2760",
    },
  );
  writeReceipt(join(trialRoot, "trial.json"), {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    repository: "shpwrck/claude-history-dashboard",
    executionMode,
    repoPath: repo,
    stateRoot,
    worktreeRoot: worktrees,
    baseSha,
    subjectSnapshots: [
      { subject: 2760, contentDigest: snapshot.contentDigest },
    ],
    registrations: Object.values(registrations),
  });
  const arms = Object.fromEntries(
    TREATMENTS.map((treatmentId) => [
      treatmentId,
      {
        treatmentId,
        attempt: 1,
        registrationDigest: registrations[treatmentId].contentDigest,
        classificationDigest: classifications[treatmentId].contentDigest,
      },
    ]),
  );
  writeReceipt(join(trialRoot, "pair-selection", "issue-2760.json"), {
    schemaVersion: 1,
    kind: "Gate2702PairSelection",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: 2760,
    baseSha,
    arms,
  });

  writeFileSync(
    responsePath,
    JSON.stringify(
      responses ?? [
        { winner: "A", scores: scores(9, 7), rationale: "A is more complete." },
        { winner: "B", scores: scores(7, 9), rationale: "B is more complete." },
      ],
    ),
    "utf8",
  );
  writeExecutable(
    join(tools, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const calls = fs.existsSync(process.env.JUDGE_CALL_LOG)
    ? fs.readFileSync(process.env.JUDGE_CALL_LOG, "utf8").split("\\n").filter(Boolean).length
    : 0;
  fs.appendFileSync(process.env.JUDGE_CALL_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    payload: JSON.parse(input),
    sidekickEnable: process.env.SIDEKICK_ENABLE ?? null,
  }) + "\\n");
  const response = JSON.parse(fs.readFileSync(process.env.JUDGE_RESPONSES, "utf8"))[calls];
  if (response?.behavior === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (response?.behavior === "non-json") {
    process.stdout.write("not json");
    return;
  }
  if (response?.behavior === "schema-invalid") {
    process.stdout.write(JSON.stringify({ structured_output: { winner: "A" } }));
    return;
  }
  if (response?.behavior === "process-exit") {
    process.stderr.write("judge process failed");
    process.exit(7);
  }
  if (response?.behavior === "budget") {
    process.stderr.write("max budget exhausted");
    process.exit(1);
  }
  if (response?.behavior === "structured-budget") {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      result: "Maximum budget reached",
      total_cost_usd: 0.25,
    }));
    return;
  }
  if (response?.behavior === "truncate") {
    process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: response,
    total_cost_usd: 0.0125,
  }));
});
`,
  );

  const env = {
    ...modelEnv,
    CHD_EXPERIMENT_2702: "1",
    PATH: `${tools}:${process.env.PATH}`,
    JUDGE_CALL_LOG: callLog,
    JUDGE_RESPONSES: responsePath,
  };
  if (executionMode === "test") {
    env.CHD_EXPERIMENT_2702_TEST_MODE = "1";
  } else {
    delete env.CHD_EXPERIMENT_2702_TEST_MODE;
  }

  return {
    root,
    stateRoot,
    trialRoot,
    callLog,
    responsePath,
    env,
  };
}

function runJudge(fixture, command = "run") {
  return spawnSync(
    process.execPath,
    [
      JUDGE,
      command,
      "--trial",
      TRIAL_ID,
      "--subject",
      "2760",
      "--state-root",
      fixture.stateRoot,
    ],
    { env: fixture.env, encoding: "utf8", timeout: 15_000 },
  );
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("judge is inert until the C5 experiment is explicitly enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-judge-off-"));
  try {
    const tools = join(root, "tools");
    const stateRoot = join(root, "state");
    const callLog = join(root, "calls.log");
    mkdirSync(tools);
    writeExecutable(
      join(tools, "claude"),
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CALL_LOG, "called\\n");\n`,
    );

    const env = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      CALL_LOG: callLog,
    };
    delete env.CHD_EXPERIMENT_2702;
    const result = spawnSync(
      process.execPath,
      [
        JUDGE,
        "run",
        "--trial",
        TRIAL_ID,
        "--subject",
        "2760",
        "--state-root",
        stateRoot,
      ],
      { env, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHD_EXPERIMENT_2702=1/);
    assert.equal(existsSync(stateRoot), false);
    assert.equal(existsSync(callLog), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("judge freezes a blind position-swapped pair and records an agreed result", () => {
  const fixture = createFixture();
  try {
    const result = runJudge(fixture);
    assert.equal(
      result.status,
      0,
      `${result.stderr}\n${existsSync(fixture.callLog) ? readFileSync(fixture.callLog, "utf8") : "no calls"}`,
    );

    const calls = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.payload).sort(), [
        "artifacts",
        "originProvenance",
        "rubric",
        "task",
      ]);
      assert.deepEqual(Object.keys(call.payload.artifacts).sort(), ["A", "B"]);
      assert.deepEqual(Object.keys(call.payload.originProvenance).sort(), [
        "A",
        "B",
      ]);
      assert.equal(call.sidekickEnable, "0");
      assert.deepEqual(call.argv.slice(0, 2), ["-p", "--model"]);
      assert.ok(call.argv.includes("claude-haiku-4-5-20251001"));
      assert.ok(call.argv.includes("--strict-mcp-config"));
      assert.equal(call.argv.includes("--dangerously-skip-permissions"), false);
      assert.deepEqual(
        call.argv.slice(
          call.argv.indexOf("--tools"),
          call.argv.indexOf("--tools") + 2,
        ),
        ["--tools", ""],
      );
      assert.ok(call.argv.includes("--json-schema"));
      assert.deepEqual(
        call.argv.slice(
          call.argv.indexOf("--max-budget-usd"),
          call.argv.indexOf("--max-budget-usd") + 2,
        ),
        ["--max-budget-usd", "0.25"],
      );
      const serialized = JSON.stringify(call.payload);
      assert.doesNotMatch(
        serialized,
        /haiku-solo|haiku-sonnet-sidekick|total_cost_usd/,
      );
      assert.doesNotMatch(
        serialized,
        new RegExp(fixture.trialRoot.replaceAll("/", "\\/")),
      );
    }
    assert.deepEqual(calls[1].payload.artifacts, {
      A: calls[0].payload.artifacts.B,
      B: calls[0].payload.artifacts.A,
    });
    assert.deepEqual(calls[1].payload.originProvenance, {
      A: calls[0].payload.originProvenance.B,
      B: calls[0].payload.originProvenance.A,
    });

    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const receipt = readJson(join(judgingRoot, "result.json"));
    assert.equal(receipt.kind, "Gate2702JudgeResult");
    assert.equal(receipt.state, "agreed");
    assert.equal(receipt.subjectiveWinner, "haiku-solo");
    assert.equal(receipt.effectiveWinner, "haiku-solo");
    assert.equal(receipt.effectiveBasis, "blind-judge");
    assert.match(receipt.contentDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(existsSync(join(judgingRoot, "input.json")), true);
    assert.equal(existsSync(join(judgingRoot, "requests.json")), true);
    assert.equal(
      existsSync(join(judgingRoot, "forward", "attempt-1.json")),
      true,
    );
    const preDispatch = readJson(
      join(judgingRoot, "forward", "attempt-1.pre-dispatch.json"),
    );
    const processReceipt = readJson(
      join(judgingRoot, "forward", "attempt-1.process.json"),
    );
    const outcome = readJson(
      join(judgingRoot, "forward", "attempt-1.outcome.json"),
    );
    const attempt = readJson(join(judgingRoot, "forward", "attempt-1.json"));
    assert.equal(preDispatch.kind, "Gate2702JudgePreDispatch");
    assert.equal(processReceipt.kind, "Gate2702JudgeProcess");
    assert.equal(outcome.kind, "Gate2702JudgeOutcome");
    assert.equal(preDispatch.executable, "claude");
    assert.equal(preDispatch.executionMode, "production");
    assert.equal(processReceipt.executionMode, "production");
    assert.equal(outcome.executionMode, "production");
    assert.equal(attempt.executionMode, "production");
    assert.equal(receipt.executionMode, "production");
    assert.equal(processReceipt.preDispatchDigest, preDispatch.contentDigest);
    assert.equal(outcome.preDispatchDigest, preDispatch.contentDigest);
    assert.equal(attempt.preDispatchDigest, preDispatch.contentDigest);
    assert.equal(attempt.processDigest, processReceipt.contentDigest);
    assert.equal(attempt.outcomeDigest, outcome.contentDigest);
    assert.equal(
      existsSync(join(judgingRoot, "swapped", "attempt-1.json")),
      true,
    );
    const input = readJson(join(judgingRoot, "input.json"));
    const requests = readJson(join(judgingRoot, "requests.json"));
    const evidence = readJson(join(judgingRoot, "evidence", "haiku-solo.json"));
    assert.equal(input.executionMode, "production");
    assert.equal(requests.executionMode, "production");
    assert.equal(evidence.executionMode, "production");
    assert.equal(input.armEvidence["haiku-solo"], evidence.contentDigest);
    assert.equal(
      input.originProvenance["haiku-solo"],
      evidence.originProvenance.contentDigest,
    );
    assert.equal(evidence.originProvenance.assertions.hostHomeDenied, true);
    assert.match(
      Buffer.from(evidence.diff.trackedPatch.bytes, "base64").toString("utf8"),
      /-base\n\+control change/,
    );
    assert.deepEqual(
      evidence.diff.untracked.map((entry) => entry.path),
      ["new-0.txt"],
    );
    assert.equal(
      Buffer.from(evidence.diff.untracked[0].bytes, "base64").toString("utf8"),
      "untracked 0\n",
    );
    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      2,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production judge rejects test-mode worker evidence before dispatch", () => {
  const fixture = createFixture({ executionMode: "test" });
  delete fixture.env.CHD_EXPERIMENT_2702_TEST_MODE;
  try {
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /execution mode/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("protected worker output without sandbox origin provenance is rejected before judge dispatch", () => {
  const fixture = createFixture({
    protectedCanary: "CLAUDE_HISTORY_CANARY_3086",
    omitOriginSandbox: true,
  });
  try {
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sandbox|origin provenance/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("judge rejects worker stdout changed after classification", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      join(
        fixture.trialRoot,
        "runs",
        "issue-2760",
        "haiku-solo",
        "attempt-1",
        "stdout.log",
      ),
      `${JSON.stringify({ type: "result", subtype: "success", result: "changed" })}\n`,
      "utf8",
    );
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match its classification artifact/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("judge rejects a worktree changed after objective classification", () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      join(
        fixture.trialRoot,
        "worktrees",
        "issue-2760.haiku-solo.attempt-1",
        "tracked.txt",
      ),
      "post-classification edit\n",
      "utf8",
    );
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /worktree changed after.*classification/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, option, message] of [
  ["subject prompt", "invalidPromptDigest", /worker dispatch/i],
  ["worktree identity", "invalidWorktreeIdentityDigest", /worktree identity/i],
]) {
  test(`judge rejects a dispatch with the wrong ${label} binding`, () => {
    const fixture = createFixture({ [option]: true });
    try {
      const result = runJudge(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(existsSync(fixture.callLog), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("existing frozen evidence rejects a rehashed substituted artifact", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const evidencePath = join(judgingRoot, "evidence", "haiku-solo.json");
    const evidence = readJson(evidencePath);
    evidence.artifact = "substituted judge material";
    const substitutedEvidence = withDigest(evidence);
    writeFileSync(
      evidencePath,
      `${JSON.stringify(substitutedEvidence, null, 2)}\n`,
      "utf8",
    );
    const inputPath = join(judgingRoot, "input.json");
    const input = readJson(inputPath);
    input.armEvidence["haiku-solo"] = substitutedEvidence.contentDigest;
    input.artifacts["haiku-solo"] = substitutedEvidence.artifact;
    writeFileSync(
      inputPath,
      `${JSON.stringify(withDigest(input), null, 2)}\n`,
      "utf8",
    );
    const callsBefore = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n").length;

    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /artifact is not derived from its bytes/i);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      callsBefore,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("coherently rehashed origin-provenance tampering is rejected before redispatch", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const evidencePath = join(
      judgingRoot,
      "evidence",
      "haiku-solo.json",
    );
    const evidence = readJson(evidencePath);
    evidence.originProvenance.sandboxPolicyDigest = bytesDigest(
      "forged sandbox policy",
    );
    evidence.originProvenance = withDigest(evidence.originProvenance);
    const tamperedEvidence = withDigest(evidence);
    writeFileSync(
      evidencePath,
      `${JSON.stringify(tamperedEvidence, null, 2)}\n`,
      "utf8",
    );

    const inputPath = join(judgingRoot, "input.json");
    const input = readJson(inputPath);
    input.armEvidence["haiku-solo"] = tamperedEvidence.contentDigest;
    input.originProvenance["haiku-solo"] =
      tamperedEvidence.originProvenance.contentDigest;
    writeFileSync(
      inputPath,
      `${JSON.stringify(withDigest(input), null, 2)}\n`,
      "utf8",
    );
    const callsBefore = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n").length;

    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /origin provenance/i);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      callsBefore,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("aggregate untracked source is bounded before prompt construction", () => {
  const fixture = createFixture();
  try {
    const worktree = join(
      fixture.trialRoot,
      "worktrees",
      "issue-2760.haiku-solo.attempt-1",
    );
    writeFileSync(
      join(worktree, "large-a.bin"),
      Buffer.alloc(17 * 1024 * 1024),
    );
    writeFileSync(
      join(worktree, "large-b.bin"),
      Buffer.alloc(17 * 1024 * 1024),
    );
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /aggregate C5 worktree source.*evidence cap/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("judge rejects a subject snapshot not bound by the trial manifest", () => {
  const fixture = createFixture();
  try {
    const trialPath = join(fixture.trialRoot, "trial.json");
    const trial = readJson(trialPath);
    trial.subjectSnapshots[0].contentDigest = `sha256:${"0".repeat(64)}`;
    writeFileSync(
      trialPath,
      `${JSON.stringify(withDigest(trial), null, 2)}\n`,
      "utf8",
    );

    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /subject snapshot.*trial manifest/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing result fast path rejects a self-consistent but false winner", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const resultPath = join(judgingRoot, "result.json");
    const result = readJson(resultPath);
    result.effectiveWinner = "haiku-sonnet-sidekick";
    writeFileSync(
      resultPath,
      `${JSON.stringify(withDigest(result), null, 2)}\n`,
      "utf8",
    );
    const callCount = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n").length;

    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /existing judge result.*frozen evidence/i);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      callCount,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing result fast path rejects any receipt beyond the paid-call cap", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const forward = join(fixture.trialRoot, "judging", "issue-2760", "forward");
    writeFileSync(join(forward, "attempt-4.pre-dispatch.json"), "{}\n", "utf8");
    const callCount = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n").length;

    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /call cap was exceeded/i);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      callCount,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("judge retries a timed-out order from the same frozen request", () => {
  const fixture = createFixture({
    executionMode: "test",
    responses: [
      { behavior: "hang" },
      { winner: "A", scores: scores(9, 7), rationale: "A is stronger." },
      { winner: "B", scores: scores(7, 9), rationale: "B is stronger." },
    ],
  });
  fixture.env.NODE_ENV = "test";
  fixture.env.CHD_EXPERIMENT_2702_TEST_JUDGE_TIMEOUT_MS = "400";
  try {
    const result = runJudge(fixture);
    assert.equal(
      result.status,
      0,
      `${result.stderr}\n${existsSync(fixture.callLog) ? readFileSync(fixture.callLog, "utf8") : "no calls"}`,
    );
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const first = readJson(join(judgingRoot, "forward", "attempt-1.json"));
    const second = readJson(join(judgingRoot, "forward", "attempt-2.json"));
    assert.equal(first.failureClass, "timeout");
    assert.equal(first.retryable, true);
    assert.equal(first.timedOut, true);
    assert.equal(second.outcome, "valid");
    assert.equal(second.payloadDigest, first.payloadDigest);
    assert.equal(readJson(join(judgingRoot, "result.json")).state, "agreed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const failureClass of ["non-json", "schema-invalid"]) {
  test(`judge retries ${failureClass} output and preserves the failed attempt`, () => {
    const fixture = createFixture({
      responses: [
        { behavior: failureClass },
        { winner: "A", scores: scores(9, 7), rationale: "A is stronger." },
        { winner: "B", scores: scores(7, 9), rationale: "B is stronger." },
      ],
    });
    try {
      const result = runJudge(fixture);
      assert.equal(result.status, 0, result.stderr);
      const root = join(fixture.trialRoot, "judging", "issue-2760", "forward");
      const first = readJson(join(root, "attempt-1.json"));
      const second = readJson(join(root, "attempt-2.json"));
      assert.equal(first.failureClass, failureClass);
      assert.equal(first.retryable, true);
      assert.equal(second.outcome, "valid");
      assert.equal(second.payloadDigest, first.payloadDigest);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("swapped-order disagreement stays disagreement instead of becoming a tie", () => {
  const fixture = createFixture({
    responses: [
      { winner: "A", scores: scores(9, 7), rationale: "Displayed A wins." },
      {
        winner: "A",
        scores: scores(9, 7),
        rationale: "Displayed A wins again.",
      },
    ],
  });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 0, processResult.stderr);
    const result = readJson(
      join(fixture.trialRoot, "judging", "issue-2760", "result.json"),
    );
    assert.equal(result.state, "disagreement");
    assert.equal(result.forwardWinner, "haiku-solo");
    assert.equal(result.swappedWinner, "haiku-sonnet-sidekick");
    assert.equal(result.subjectiveWinner, null);
    assert.equal(result.effectiveWinner, null);
    assert.equal(result.effectiveBasis, "judge-disagreement");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("three transient failures exhaust one order into an explicit failed result", () => {
  const fixture = createFixture({
    responses: [
      { behavior: "non-json" },
      { behavior: "non-json" },
      { behavior: "non-json" },
      { winner: "B", scores: scores(7, 9), rationale: "B wins." },
    ],
  });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 2, processResult.stderr);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const receipt = readJson(
        join(judgingRoot, "forward", `attempt-${attempt}.json`),
      );
      assert.equal(receipt.failureClass, "non-json");
      assert.equal(receipt.retryable, true);
    }
    assert.equal(
      existsSync(join(judgingRoot, "forward", "attempt-4.json")),
      false,
    );
    const result = readJson(join(judgingRoot, "result.json"));
    assert.equal(result.state, "failed");
    assert.equal(result.subjectiveWinner, null);
    assert.equal(result.effectiveBasis, "judge-failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [behavior, failureClass] of [
  ["process-exit", "process-exit"],
  ["budget", "budget-exhausted"],
  ["truncate", "output-truncated"],
]) {
  test(`${failureClass} is terminal and is never retried`, () => {
    const fixture = createFixture({
      responses: [
        { behavior },
        { winner: "B", scores: scores(7, 9), rationale: "B wins." },
      ],
    });
    try {
      const processResult = runJudge(fixture);
      assert.equal(processResult.status, 2, processResult.stderr);
      const forward = join(
        fixture.trialRoot,
        "judging",
        "issue-2760",
        "forward",
      );
      const attempt = readJson(join(forward, "attempt-1.json"));
      assert.equal(attempt.failureClass, failureClass);
      assert.equal(attempt.retryable, false);
      assert.equal(existsSync(join(forward, "attempt-2.json")), false);
      if (failureClass === "output-truncated") {
        assert.equal(attempt.stdout.truncated, true);
        assert.equal(attempt.stdout.capturedBytes, 2 * 1024 * 1024);
        assert.equal(attempt.stdout.totalBytes, 2 * 1024 * 1024 + 1);
        assert.match(attempt.stdout.contentDigest, /^sha256:[0-9a-f]{64}$/);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("structured Claude budget exhaustion is terminal and never retried", () => {
  const fixture = createFixture({
    responses: [
      { behavior: "structured-budget" },
      { winner: "B", scores: scores(7, 9), rationale: "B wins." },
    ],
  });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 2, processResult.stderr);
    const forward = join(fixture.trialRoot, "judging", "issue-2760", "forward");
    const attempt = readJson(join(forward, "attempt-1.json"));
    assert.equal(attempt.failureClass, "budget-exhausted");
    assert.equal(attempt.retryable, false);
    assert.equal(attempt.costUsd, 0.25);
    assert.equal(existsSync(join(forward, "attempt-2.json")), false);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      2,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing outcome cannot exceed the persisted stream capture cap", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const outcomePath = join(
      fixture.trialRoot,
      "judging",
      "issue-2760",
      "forward",
      "attempt-1.outcome.json",
    );
    const outcome = readJson(outcomePath);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, "x");
    outcome.stdout = {
      encoding: "base64",
      capturedBytes: bytes.length,
      totalBytes: bytes.length,
      contentDigest: bytesDigest(bytes),
      truncated: false,
      bytes: bytes.toString("base64"),
    };
    writeFileSync(
      outcomePath,
      `${JSON.stringify(withDigest(outcome), null, 2)}\n`,
      "utf8",
    );

    const repeated = runJudge(fixture);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /capture metadata is invalid/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("oversized frozen evidence is rejected before any judge dispatch", () => {
  const fixture = createFixture({ workerResultBytes: 140 * 1024 });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 1);
    assert.match(processResult.stderr, /payload is .* maximum is 131072/);
    assert.equal(existsSync(fixture.callLog), false);
    const root = join(fixture.trialRoot, "judging", "issue-2760");
    assert.equal(existsSync(join(root, "input.json")), true);
    assert.equal(existsSync(join(root, "requests.json")), false);
    assert.equal(existsSync(join(root, "result.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("objective check failure overrides a subjective preference for that arm", () => {
  const fixture = createFixture({
    failedTreatments: ["haiku-sonnet-sidekick"],
    responses: [
      { winner: "B", scores: scores(7, 9), rationale: "B looks stronger." },
      { winner: "A", scores: scores(9, 7), rationale: "A looks stronger." },
    ],
  });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 0, processResult.stderr);
    const result = readJson(
      join(fixture.trialRoot, "judging", "issue-2760", "result.json"),
    );
    assert.equal(result.state, "agreed");
    assert.equal(result.subjectiveWinner, "haiku-sonnet-sidekick");
    assert.equal(
      result.objectiveChecks["haiku-sonnet-sidekick"].state,
      "failed",
    );
    assert.equal(result.effectiveWinner, "haiku-solo");
    assert.equal(result.effectiveBasis, "objective-checks");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("two objectively failed arms yield failure rather than a judge tie", () => {
  const tie = {
    winner: "tie",
    scores: scores(8, 8),
    rationale: "Equivalent output.",
  };
  const fixture = createFixture({
    failedTreatments: TREATMENTS,
    responses: [tie, tie],
  });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 2, processResult.stderr);
    const result = readJson(
      join(fixture.trialRoot, "judging", "issue-2760", "result.json"),
    );
    assert.equal(result.state, "failed");
    assert.equal(result.subjectiveState, "tie");
    assert.equal(result.subjectiveWinner, "tie");
    assert.equal(result.effectiveWinner, null);
    assert.equal(result.effectiveBasis, "objective-both-failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resume judges only the missing order from frozen inputs without reading workers", () => {
  const fixture = createFixture();
  try {
    const firstRun = runJudge(fixture);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const forwardPath = join(judgingRoot, "forward", "attempt-1.json");
    const forwardBefore = readFileSync(forwardPath, "utf8");
    rmSync(join(judgingRoot, "result.json"));
    rmSync(join(judgingRoot, "swapped"), { recursive: true });
    rmSync(fixture.callLog);
    for (const disposable of [
      "runs",
      "subjects",
      "pair-selection",
      "worktrees",
    ]) {
      rmSync(join(fixture.trialRoot, disposable), {
        recursive: true,
        force: true,
      });
    }
    writeFileSync(
      fixture.responsePath,
      JSON.stringify([
        { winner: "B", scores: scores(7, 9), rationale: "B is stronger." },
      ]),
      "utf8",
    );

    const resumed = runJudge(fixture, "resume");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(readFileSync(forwardPath, "utf8"), forwardBefore);
    const calls = readFileSync(fixture.callLog, "utf8").trim().split("\n");
    assert.equal(calls.length, 1);
    assert.equal(readJson(join(judgingRoot, "result.json")).state, "agreed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resume adopts a paid outcome after the judge launcher crashes", async () => {
  const fixture = createFixture({ executionMode: "test" });
  fixture.env.NODE_ENV = "test";
  fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE = "after-gate";
  try {
    const crashed = runJudge(fixture);
    assert.equal(crashed.status, 86, crashed.stderr);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const forward = join(judgingRoot, "forward");
    assert.equal(
      existsSync(join(forward, "attempt-1.pre-dispatch.json")),
      true,
    );
    assert.equal(existsSync(join(forward, "attempt-1.process.json")), true);
    assert.equal(existsSync(join(forward, "attempt-1.gate.json")), true);
    assert.equal(existsSync(join(forward, "attempt-1.json")), false);
    await waitFor(
      () => existsSync(join(forward, "attempt-1.outcome.json")),
      "detached judge outcome",
    );

    delete fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE;
    const resumed = runJudge(fixture, "resume");
    assert.equal(resumed.status, 0, resumed.stderr);
    const calls = readFileSync(fixture.callLog, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].payload.artifacts, {
      A: calls[1].payload.artifacts.B,
      B: calls[1].payload.artifacts.A,
    });
    assert.equal(readJson(join(judgingRoot, "result.json")).state, "agreed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resume authorizes the same durable wrapper after a pre-call crash", () => {
  const fixture = createFixture({ executionMode: "test" });
  fixture.env.NODE_ENV = "test";
  fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE = "after-process";
  try {
    const crashed = runJudge(fixture);
    assert.equal(crashed.status, 86, crashed.stderr);
    const forward = join(fixture.trialRoot, "judging", "issue-2760", "forward");
    const processPath = join(forward, "attempt-1.process.json");
    const processBefore = readFileSync(processPath, "utf8");
    assert.equal(existsSync(join(forward, "attempt-1.gate.json")), false);
    assert.equal(existsSync(fixture.callLog), false);

    delete fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE;
    const resumed = runJudge(fixture, "resume");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(readFileSync(processPath, "utf8"), processBefore);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      2,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resume never redispatches an ambiguous pre-dispatch slot", () => {
  const fixture = createFixture({ executionMode: "test" });
  fixture.env.NODE_ENV = "test";
  fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE = "after-pre-dispatch";
  try {
    const crashed = runJudge(fixture);
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(existsSync(fixture.callLog), false);
    const forward = join(fixture.trialRoot, "judging", "issue-2760", "forward");
    const preDispatchPath = join(forward, "attempt-1.pre-dispatch.json");
    const preDispatchBefore = readFileSync(preDispatchPath, "utf8");

    delete fixture.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE;
    const resumed = runJudge(fixture, "resume");
    assert.equal(resumed.status, 2, resumed.stderr);
    assert.equal(readFileSync(preDispatchPath, "utf8"), preDispatchBefore);
    assert.equal(existsSync(join(forward, "attempt-1.process.json")), false);
    assert.equal(existsSync(join(forward, "attempt-1.gate.json")), false);
    const outcome = readJson(join(forward, "attempt-1.outcome.json"));
    assert.match(outcome.spawnError, /interrupted before.*registered/i);
    const attempt = readJson(join(forward, "attempt-1.json"));
    assert.equal(attempt.failureClass, "spawn-error");
    assert.equal(attempt.retryable, false);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      1,
    );
    assert.equal(runJudge(fixture, "resume").status, 2);
    assert.equal(
      readFileSync(fixture.callLog, "utf8").trim().split("\n").length,
      1,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an ineligible selected classification prevents freezing and model dispatch", () => {
  const fixture = createFixture({ ineligibleTreatment: "haiku-solo" });
  try {
    const result = runJudge(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ineligible/);
    assert.equal(existsSync(fixture.callLog), false);
    assert.equal(
      existsSync(
        join(fixture.trialRoot, "judging", "issue-2760", "input.json"),
      ),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("two position-stable ties remain an explicit tie", () => {
  const tie = {
    winner: "tie",
    scores: scores(8, 8),
    rationale: "Equivalent quality.",
  };
  const fixture = createFixture({ responses: [tie, tie] });
  try {
    const processResult = runJudge(fixture);
    assert.equal(processResult.status, 0, processResult.stderr);
    const result = readJson(
      join(fixture.trialRoot, "judging", "issue-2760", "result.json"),
    );
    assert.equal(result.state, "tie");
    assert.equal(result.subjectiveWinner, "tie");
    assert.equal(result.effectiveWinner, "tie");
    assert.equal(result.effectiveBasis, "blind-judge");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resume rejects a recomputed request that changes the frozen arm map", () => {
  const fixture = createFixture();
  try {
    assert.equal(runJudge(fixture).status, 0);
    const judgingRoot = join(fixture.trialRoot, "judging", "issue-2760");
    const requestsPath = join(judgingRoot, "requests.json");
    const requests = readJson(requestsPath);
    requests.requests.forward.order = {
      A: "haiku-sonnet-sidekick",
      B: "haiku-solo",
    };
    writeFileSync(
      requestsPath,
      `${JSON.stringify(withDigest(requests), null, 2)}\n`,
      "utf8",
    );
    rmSync(join(judgingRoot, "result.json"));
    rmSync(join(judgingRoot, "forward"), { recursive: true });
    rmSync(join(judgingRoot, "swapped"), { recursive: true });
    rmSync(fixture.callLog);

    const resumed = runJudge(fixture, "resume");
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /frozen.*request|arm order/i);
    assert.equal(existsSync(fixture.callLog), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
