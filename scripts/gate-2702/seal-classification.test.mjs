import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { shellQuote } from "../lib/shell-quote.mjs";
import {
  GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION,
  GATE_2702_SIDEKICK_VERSION,
} from "./behavior-context.mjs";
import {
  GATE_2702_SANDBOX_ENV_KEYS,
  GATE_2702_SRT_INJECTED_ENV_KEYS,
} from "./sandbox-dispatch.mjs";
import { GATE_2702_BROKER_PLACEHOLDER_TOKEN } from "./credential-broker.mjs";
import { validateGate2702ClassificationEvidence } from "./seal-classification.mjs";

const TRIAL_ID = "4f503910-77de-4ac0-b454-3ac913d96288";
const SUBJECT = 2760;
const BASE_SHA = "1".repeat(40);
const TREATMENT_ID = "haiku-solo";
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
};
const CHECKS = [
  {
    id: "checks/gate-2702-vitest",
    argv: ["npx", "vitest", "run"],
    timeoutMs: 720_000,
  },
  {
    id: "checks/gate-2702-typecheck",
    argv: ["npm", "run", "typecheck"],
    timeoutMs: 360_000,
  },
];
const WORKER_ARGV = [
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

function valueDigest(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function withDigest(receipt) {
  const value = { ...receipt };
  delete value.contentDigest;
  return { ...value, contentDigest: valueDigest(value) };
}

function artifact(path, bytes) {
  return {
    path,
    byteLength: bytes.length,
    contentDigest: sha256(bytes),
    capturedBytes: bytes.length,
    truncated: false,
  };
}

function stream(path, bytes) {
  return {
    path,
    byteLength: bytes.length,
    capturedBytes: bytes.length,
    contentDigest: sha256(bytes),
    capturedContentDigest: sha256(bytes),
    truncated: false,
  };
}

function sidekickEnvironment() {
  return {
    SIDEKICK_ENABLE: "0",
    SIDEKICK_MODEL: "claude-sonnet-5",
    SIDEKICK_GATE: "off",
    SIDEKICK_WARMUP_TOKENS: "150000",
    SIDEKICK_BACKOFF_AFTER: "3",
    SIDEKICK_BACKOFF_MAX: "8",
    SIDEKICK_SESSION_BUDGET_USD: "0",
    SIDEKICK_TRIGGER_RESERVE_USD: "0",
    SIDEKICK_CALL_BUDGET_USD: "0",
    SIDEKICK_SIGHTED: "1",
    SIDEKICK_VERIFY_LENS: "1",
    SIDEKICK_SYNC: "0",
    SIDEKICK_TRIGGERS:
      "push-or-pr,merge-conflict,sensitive-file-edit,destructive",
    SIDEKICK_TRIAGE_MODEL: "claude-haiku-4-5",
    SIDEKICK_AUDITS: "file",
    SIDEKICK_SHIP_COOLDOWN: "2",
    SIDEKICK_NEARDUP: "0.5",
    SIDEKICK_NEARDUP_MIN_SHARED: "4",
    SIDEKICK_CONCURRENCY: "1",
    SIDEKICK_MIN_DELTA: "120",
    SIDEKICK_NESTED: "0",
  };
}

function uniqueSortedPaths(values) {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function sandboxedWorkerDispatch(
  registration,
  worktreeIdentity,
  recordedSidekickEnvironment,
) {
  const hostHome = "/fixture/host-home";
  const sandboxRoot = join(registration.runDir, "sandbox");
  const isolatedHome = join(sandboxRoot, "home");
  const settingsPath = join(sandboxRoot, "settings.json");
  const brokerCaCertPath = join(sandboxRoot, "broker-ca.crt");
  const brokerSocketPath = join(hostHome, ".claude", ".g2702-fixture.sock");
  const packageRoot =
    "/fixture/runtime/node_modules/@anthropic-ai/sandbox-runtime";
  const cliPath = join(packageRoot, "dist", "cli.js");
  const toolRoot = "/fixture/runtime/bin";
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
  const workerArgv = [
    claude,
    ...WORKER_ARGV.slice(1),
    "--plugin-dir",
    sidekickPath,
  ];
  const allowedReadRoots = uniqueSortedPaths([
    registration.worktreePath,
    registration.runDir,
    worktreeIdentity.gitDirectory,
    gitCommonDirectory,
    packageRoot,
    rg.resolved,
    workerArgv[0],
    sidekickPath,
  ]);
  const allowedWriteRoots = uniqueSortedPaths([
    registration.worktreePath,
    isolatedHome,
    worktreeIdentity.gitDirectory,
  ]);
  const policy = {
    network: {
      allowedDomains: ["api.anthropic.com"],
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
        dirname(workerArgv[0]),
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
    ...recordedSidekickEnvironment,
  };
  const argv = [
    "/fixture/runtime/bin/node",
    cliPath,
    "-s",
    settingsPath,
    "-c",
    [
      `cd ${shellQuote(registration.worktreePath)}`,
      `exec ${workerArgv.map(shellQuote).join(" ")}`,
    ].join(" && "),
  ];
  return {
    argv,
    environment,
    environmentDigest: valueDigest(environment),
    environmentKeys: [
      ...new Set([
        ...GATE_2702_SANDBOX_ENV_KEYS,
        ...Object.keys(recordedSidekickEnvironment),
      ]),
    ].sort(),
    workerEnvironmentKeys: [
      ...new Set([
        ...GATE_2702_SANDBOX_ENV_KEYS,
        ...Object.keys(recordedSidekickEnvironment),
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
            workerArgv.includes("--model")
              ? workerArgv[workerArgv.indexOf("--model") + 1]
              : "claude-haiku-4-5-20251001",
            ...(recordedSidekickEnvironment.SIDEKICK_ENABLE === "1"
              ? [
                  recordedSidekickEnvironment.SIDEKICK_MODEL,
                  recordedSidekickEnvironment.SIDEKICK_TRIAGE_MODEL,
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
      sidekickSnapshot: {
        path: sidekickPath,
        contentDigest: `sha256:${"3".repeat(64)}`,
      },
      workerArgv,
    },
  };
}

function environmentProbes(environment) {
  const probe = (name, argv) => ({
    program: environment[name].executable,
    argv,
    pid: 900,
    timeoutMs: 60_000,
    maxBufferBytes: 256 * 1024,
    exitCode: 0,
    signal: null,
    processGroupQuiescent: true,
    stdout: environment[name].version,
    stderr: "",
  });
  return {
    npm: probe("npm", ["npm", "--version"]),
    claude: probe("claude", ["claude", "--version"]),
    vitest: probe("vitest", ["npx", "--no-install", "vitest", "--version"]),
    typescript: probe("typescript", [
      "npx",
      "--no-install",
      "tsc",
      "--version",
    ]),
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

function createSuccessfulFixture({
  attempt = 1,
  vitestExit = 0,
  unsandboxedProduction = false,
} = {}) {
  const artifacts = new Map();
  const putReceipt = (path, receipt) => {
    const value = withDigest(receipt);
    artifacts.set(path, Buffer.from(`${JSON.stringify(value)}\n`));
    return value;
  };
  const putJson = (path, value) =>
    artifacts.set(path, Buffer.from(`${JSON.stringify(value)}\n`));
  const putBytes = (path, bytes) => artifacts.set(path, Buffer.from(bytes));
  const prefix = `runs/issue-${SUBJECT}/${TREATMENT_ID}/attempt-${attempt}`;
  const runDir = `/fixture/state/${prefix}`;
  const worktreePath = `/fixture/worktrees/issue-${SUBJECT}.${TREATMENT_ID}.attempt-${attempt}`;
  const snapshot = putReceipt(`subjects/issue-${SUBJECT}.json`, {
    schemaVersion: 1,
    kind: "Gate2702SubjectSnapshot",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    repository: "shpwrck/claude-history-dashboard",
    executionMode: "production",
    subject: SUBJECT,
    baseSha: BASE_SHA,
    title: "Fixture issue",
    body: "Implement the bounded fixture behavior.",
    url: `https://example.invalid/issues/${SUBJECT}`,
  });
  let parentRegistration = null;
  let parentClassification = null;
  if (attempt === 2) {
    const parentPrefix = `runs/issue-${SUBJECT}/${TREATMENT_ID}/attempt-1`;
    parentRegistration = putReceipt(`${parentPrefix}/registration.json`, {
      schemaVersion: 1,
      kind: "Gate2702ArmRegistration",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      subjectRef: `github:shpwrck/claude-history-dashboard#${SUBJECT}`,
      treatmentId: TREATMENT_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      executionMode: "production",
      runDir: `/fixture/state/${parentPrefix}`,
      worktreePath: `/fixture/worktrees/issue-${SUBJECT}.${TREATMENT_ID}.attempt-1`,
    });
    parentClassification = putReceipt(`${parentPrefix}/classification.json`, {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      registrationDigest: parentRegistration.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      status: "failed",
      eligible: false,
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    });
  }
  const registration = putReceipt(`${prefix}/registration.json`, {
    schemaVersion: 1,
    kind: "Gate2702ArmRegistration",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    subjectRef: `github:shpwrck/claude-history-dashboard#${SUBJECT}`,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    executionMode: "production",
    runDir,
    worktreePath,
    ...(attempt === 2
      ? {
          retryOf: {
            attempt: 1,
            registrationDigest: parentRegistration.contentDigest,
            classificationDigest: parentClassification.contentDigest,
          },
        }
      : {}),
  });
  putReceipt("trial.json", {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    repository: "shpwrck/claude-history-dashboard",
    executionMode: "production",
    stateRoot: "/fixture/state",
    worktreeRoot: "/fixture/worktrees",
    baseSha: BASE_SHA,
    registrations: [attempt === 1 ? registration : parentRegistration],
    subjectSnapshots: [
      { subject: SUBJECT, contentDigest: snapshot.contentDigest },
    ],
  });
  const behaviorConfig = {
    enabled: false,
    model: "claude-sonnet-5",
    gate: "off",
    warmupTokens: 150_000,
    backoffAfter: 3,
    backoffMax: 8,
    sessionBudgetUsd: 0,
    triggerReserveUsd: 0,
    callBudgetUsd: 0,
    sighted: true,
    verifyLens: true,
    sync: false,
    triggers: [
      "push-or-pr",
      "merge-conflict",
      "sensitive-file-edit",
      "destructive",
    ],
    triageModel: "claude-haiku-4-5",
    audits: ["file"],
    shipCooldown: 2,
    nearDup: 0.5,
    nearDupMinShared: 4,
    concurrency: 1,
    minDelta: 120,
  };
  const behaviorContext = {
    // Imported, not re-typed -- see seal.test.mjs completeBehaviorContext.
    schemaVersion: GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION,
    observedAt: "2026-07-20T17:50:00.000Z",
    workerModelQualifiedId: "claude-haiku-4-5-20251001",
    sidekickModelQualifiedId: null,
    sidekickVersion: null,
    sidekickImplementationDigest: null,
    sidekickActivation: null,
    resolvedSidekickConfig: behaviorConfig,
    resolvedSidekickConfigDigest: valueDigest(behaviorConfig),
    instructionsDigest: valueDigest([]),
    instructionSources: [],
  };
  const environment = {
    node: { executable: "/usr/bin/node", version: "v24.13.1" },
    npm: { executable: "/usr/bin/npm", version: "11.6.2" },
    claude: { executable: "/usr/bin/claude", version: "2.1.12" },
    vitest: { executable: "/usr/bin/npx", version: "3.2.4" },
    typescript: { executable: "/usr/bin/npx", version: "5.8.3" },
  };
  const installRoot = `${prefix}/preflight-install`;
  const installToken = "99999999-9999-4999-8999-999999999999";
  const installStdoutBytes = Buffer.from("fixture install complete\n");
  const installStderrBytes = Buffer.alloc(0);
  const installPreDispatch = putReceipt(`${installRoot}/pre-dispatch.json`, {
    schemaVersion: 1,
    kind: "Gate2702InstallPreDispatch",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    program: "/usr/bin/npm",
    executable: "/usr/bin/npm",
    argv: ["npm", "ci"],
    timeoutMs: 1_200_000,
    maxBufferBytes: 256 * 1024,
    cwd: worktreePath,
    dispatchToken: installToken,
    ownerPid: 990,
    startedAt: "2026-07-20T17:48:00.000Z",
  });
  const installProcess = putReceipt(`${installRoot}/process.json`, {
    schemaVersion: 1,
    kind: "Gate2702InstallProcess",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: installPreDispatch.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    dispatchToken: installToken,
    pid: 991,
  });
  putBytes(`${installRoot}/dispatch-gate`, Buffer.from(`${installToken}\n`));
  putBytes(`${installRoot}/stdout.log`, installStdoutBytes);
  putBytes(`${installRoot}/stderr.log`, installStderrBytes);
  const installOutcomeStream = (bytes) => ({
    byteLength: bytes.length,
    capturedBytes: bytes.length,
    contentDigest: sha256(bytes),
    capturedContentDigest: sha256(bytes),
    truncated: false,
  });
  putJson(`${installRoot}/outcome.json`, {
    token: installToken,
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    timedOut: false,
    stdout: installOutcomeStream(installStdoutBytes),
    stderr: installOutcomeStream(installStderrBytes),
  });
  const installExecution = putReceipt(`${installRoot}/execution.json`, {
    schemaVersion: 1,
    kind: "Gate2702InstallExecution",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: installPreDispatch.contentDigest,
    processDigest: installProcess.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    program: "/usr/bin/npm",
    executable: "/usr/bin/npm",
    argv: ["npm", "ci"],
    pid: installProcess.pid,
    timeoutMs: 1_200_000,
    maxBufferBytes: 256 * 1024,
    startedAt: installPreDispatch.startedAt,
    durationMs: 1_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    interrupted: false,
    processGroupQuiescent: true,
    truncated: false,
    stdout: installStdoutBytes.toString("utf8").trim(),
    stderr: "",
    stdoutEvidence: {
      path: `${runDir}/preflight-install/stdout.log`,
      ...installOutcomeStream(installStdoutBytes),
    },
    stderrEvidence: {
      path: `${runDir}/preflight-install/stderr.log`,
      ...installOutcomeStream(installStderrBytes),
    },
  });
  const preflightArm = {
    treatmentId: TREATMENT_ID,
    attempt,
    registrationDigest: registration.contentDigest,
    worktreePath,
    lockfileDigest: sha256(Buffer.from("fixture-lockfile")),
    environment,
    environmentDigest: valueDigest(environment),
    install: installExecution,
    behaviorContext,
    sidekick: {
      version: null,
      implementationDigest: null,
      activation: null,
      configuration: {
        enabled: false,
        sessionBudgetUsd: 0,
        perCallBudgetUsd: 0,
      },
    },
  };
  const preflight = putReceipt(
    attempt === 1
      ? `preflight/issue-${SUBJECT}.json`
      : `${prefix}/preflight.json`,
    {
      schemaVersion: 1,
      kind: attempt === 1 ? "Gate2702PairPreflight" : "Gate2702RetryPreflight",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      ...(attempt === 2 ? { treatmentId: TREATMENT_ID, attempt } : {}),
      baseSha: BASE_SHA,
      status: "passed",
      ...(attempt === 1
        ? { arms: { [TREATMENT_ID]: preflightArm } }
        : preflightArm),
      environment,
      environmentDigest: valueDigest(environment),
    },
  );
  const identity = putReceipt(`${prefix}/worktree-identity.json`, {
    schemaVersion: 1,
    kind: "Gate2702WorktreeIdentity",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    executionMode: "production",
    worktreePath,
    gitDirectory: "/fixture/repo/.git/worktrees/fixture",
    identityToken: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-20T17:45:00.000Z",
  });
  const recordedSidekickEnvironment = sidekickEnvironment();
  const workerDispatch = unsandboxedProduction
    ? { argv: WORKER_ARGV }
    : sandboxedWorkerDispatch(
        registration,
        identity,
        recordedSidekickEnvironment,
      );
  const workerPreDispatch = putReceipt(`${prefix}/pre-dispatch.json`, {
    schemaVersion: 1,
    kind: "Gate2702PreDispatch",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    worktreeIdentityDigest: identity.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    executionMode: "production",
    ...workerDispatch,
    sidekickEnvironment: recordedSidekickEnvironment,
    sidekickEnvironmentDigest: valueDigest(recordedSidekickEnvironment),
    cwd: worktreePath,
    promptDigest: sha256(Buffer.from(workerPrompt(snapshot, registration))),
    startedAt: "2026-07-20T18:00:00.000Z",
  });
  const workerProcess = putReceipt(`${prefix}/process.json`, {
    schemaVersion: 1,
    kind: "Gate2702Process",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: workerPreDispatch.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    pid: 501,
    detachedProcessGroup: true,
    startedAt: "2026-07-20T18:00:00.000Z",
  });
  const terminal = putReceipt(`${prefix}/terminal.json`, {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    preDispatchDigest: workerPreDispatch.contentDigest,
    processDigest: workerProcess.contentDigest,
    outcome: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    durationMs: 240_000,
    endedAt: "2026-07-20T18:04:00.000Z",
  });
  const workerStdout = Buffer.from(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      result: "implemented",
    })}\n`,
  );
  const workerStderr = Buffer.alloc(0);
  putBytes(`${prefix}/stdout.log`, workerStdout);
  putBytes(`${prefix}/stderr.log`, workerStderr);
  const checkResults = [];
  const checkReceipts = {};
  for (const [index, check] of CHECKS.entries()) {
    const slug = check.id.replaceAll("/", "_");
    const checkPrefix = `${prefix}/checks/${slug}`;
    const checkEnvironment = environment;
    const dispatchToken = `${index + 2}${String(index + 2).repeat(7)}-${String(index + 2).repeat(4)}-4${String(index + 2).repeat(3)}-8${String(index + 2).repeat(3)}-${String(index + 2).repeat(12)}`;
    const preDispatch = putReceipt(`${checkPrefix}.pre-dispatch.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckPreDispatch",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt,
      baseSha: BASE_SHA,
      checkId: check.id,
      argv: check.argv,
      timeoutMs: check.timeoutMs,
      cwd: worktreePath,
      environment: checkEnvironment,
      environmentProbes: environmentProbes(checkEnvironment),
      environmentDigest: valueDigest(checkEnvironment),
      dispatchToken,
      ownerPid: 700 + index,
      startedAt: `2026-07-20T18:04:0${index}.000Z`,
    });
    const processReceipt = putReceipt(`${checkPrefix}.process.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckProcess",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt,
      baseSha: BASE_SHA,
      checkId: check.id,
      dispatchToken,
      pid: 800 + index,
    });
    const exitCode = index === 0 ? vitestExit : 0;
    const stdoutBytes = Buffer.from(
      exitCode === 0 ? "ok\n" : "one test failed\n",
    );
    const stderrBytes = Buffer.alloc(0);
    putBytes(`${checkPrefix}.dispatch-gate`, Buffer.from(`${dispatchToken}\n`));
    putJson(`${checkPrefix}.outcome.json`, {
      token: dispatchToken,
      exitCode,
      signal: null,
    });
    putBytes(`${checkPrefix}.stdout.log`, stdoutBytes);
    putBytes(`${checkPrefix}.stderr.log`, stderrBytes);
    const execution = putReceipt(`${checkPrefix}.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckExecution",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt,
      baseSha: BASE_SHA,
      checkId: check.id,
      argv: check.argv,
      timeoutMs: check.timeoutMs,
      environmentDigest: valueDigest(checkEnvironment),
      environment: checkEnvironment,
      environmentProbes: preDispatch.environmentProbes,
      startedAt: preDispatch.startedAt,
      durationMs: 1_000,
      exitCode,
      signal: null,
      timedOut: false,
      interrupted: false,
      processGroupQuiescent: true,
      truncated: false,
      stdout: stream(`${runDir}/checks/${slug}.stdout.log`, stdoutBytes),
      stderr: stream(`${runDir}/checks/${slug}.stderr.log`, stderrBytes),
    });
    checkReceipts[check.id] = {
      preDispatch,
      processReceipt,
      execution,
    };
    checkResults.push({
      checkId: check.id,
      status: exitCode === 0 ? "passed" : "failed",
      evidenceDigest: execution.contentDigest,
      exitCode,
      signal: null,
      timedOut: false,
      interrupted: false,
      environmentDigest: valueDigest(checkEnvironment),
      processGroupQuiescent: true,
      truncated: false,
    });
  }
  const emptyPatch = Buffer.alloc(0);
  const diff = {
    schemaVersion: 1,
    kind: "Gate2702SealedWorktreeDiff",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    registrationDigest: registration.contentDigest,
    head: BASE_SHA,
    trackedPatch: {
      encoding: "base64",
      sizeBytes: 0,
      contentDigest: sha256(emptyPatch),
      bytes: "",
    },
    untracked: [],
  };
  putJson(
    `generated/diffs/issue-${SUBJECT}.${TREATMENT_ID}.attempt-${attempt}.json`,
    diff,
  );
  const worktreeBody = {
    baseSha: BASE_SHA,
    trackedPatch: { sizeBytes: 0, contentDigest: sha256(emptyPatch) },
    untracked: [],
    aggregateBytes: 0,
  };
  const failedCheck = checkResults.find((result) => result.status === "failed");
  const classification = putReceipt(`${prefix}/classification.json`, {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preflightDigest: preflight.contentDigest,
    terminalDigest: terminal.contentDigest,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt,
    baseSha: BASE_SHA,
    status: failedCheck ? "failed" : "succeeded",
    eligible: !failedCheck,
    retry: {
      authorized: false,
      reason: "genuine-result",
      maximumAttempt: 2,
    },
    behaviorVerification: {
      behaviorContextDigest: valueDigest(behaviorContext),
      verifiedAt: "2026-07-20T18:04:00.000Z",
    },
    workerArtifacts: {
      stdout: artifact(`${runDir}/stdout.log`, workerStdout),
      stderr: artifact(`${runDir}/stderr.log`, workerStderr),
    },
    ...(failedCheck
      ? {
          error: {
            code: "genuine-check-failure",
            checkId: failedCheck.checkId,
            message: "a declared check completed with a failing result",
          },
        }
      : {
          worktreeEvidence: {
            ...worktreeBody,
            contentDigest: valueDigest(worktreeBody),
          },
        }),
    checkResults,
  });
  return {
    artifacts,
    prefix,
    registration,
    preflight,
    terminal,
    classification,
    checkReceipts,
    install: {
      root: installRoot,
      preDispatch: installPreDispatch,
      process: installProcess,
      execution: installExecution,
    },
    putReceipt,
  };
}

test("classification verifier requires retained artifact bytes", () => {
  assert.throws(
    () =>
      validateGate2702ClassificationEvidence({
        artifactBytesByPath: new Map(),
        trialId: "4f503910-77de-4ac0-b454-3ac913d96288",
        baseSha: "1".repeat(40),
        subject: 2760,
        treatmentId: "haiku-solo",
        attempt: 1,
      }),
    /missing retained classification artifact: trial\.json/,
  );
});

test("classification and every declared check rederive from retained bytes", () => {
  const fixture = createSuccessfulFixture();
  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
  });

  assert.equal(
    verified.classification.contentDigest,
    fixture.classification.contentDigest,
  );
  assert.deepEqual(
    verified.checks.map(({ summary }) => ({
      checkId: summary.checkId,
      status: summary.status,
    })),
    [
      { checkId: "checks/gate-2702-vitest", status: "passed" },
      { checkId: "checks/gate-2702-typecheck", status: "passed" },
    ],
  );
});

test("a direct production worker command without sandbox provenance is rejected", () => {
  const fixture = createSuccessfulFixture({ unsandboxedProduction: true });

  assert.throws(
    () =>
      validateGate2702ClassificationEvidence({
        artifactBytesByPath: fixture.artifacts,
        trialId: TRIAL_ID,
        baseSha: BASE_SHA,
        subject: SUBJECT,
        treatmentId: TREATMENT_ID,
        attempt: 1,
      }),
    /worker dispatch does not rederive from its production inputs/,
  );
});

test("a genuine declared-check failure rederives as ineligible", () => {
  const fixture = createSuccessfulFixture({ vitestExit: 1 });
  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
  });

  assert.equal(verified.classification.status, "failed");
  assert.equal(verified.classification.eligible, false);
  assert.equal(
    verified.classification.error.code,
    "genuine-check-failure",
  );
  assert.equal(
    verified.classification.error.checkId,
    "checks/gate-2702-vitest",
  );
  assert.equal(verified.worktree, null);
});

test("an authorized attempt-2 classification retains exact attempt-1 lineage", () => {
  const fixture = createSuccessfulFixture({ attempt: 2 });
  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 2,
  });

  assert.deepEqual(verified.registration.retryOf, {
    attempt: 1,
    registrationDigest: fixture.registration.retryOf.registrationDigest,
    classificationDigest: fixture.registration.retryOf.classificationDigest,
  });
  assert.equal(verified.classification.status, "succeeded");
});

test("re-digesting a failed check and classification cannot turn it into a pass", () => {
  const fixture = createSuccessfulFixture({ vitestExit: 1 });
  const checkId = "checks/gate-2702-vitest";
  const slug = checkId.replaceAll("/", "_");
  const originalExecution = fixture.checkReceipts[checkId].execution;
  const execution = fixture.putReceipt(
    `${fixture.prefix}/checks/${slug}.json`,
    { ...originalExecution, contentDigest: undefined, exitCode: 0 },
  );
  fixture.putReceipt(`${fixture.prefix}/classification.json`, {
    ...fixture.classification,
    contentDigest: undefined,
    checkResults: fixture.classification.checkResults.map((summary) =>
      summary.checkId === checkId
        ? {
            ...summary,
            status: "passed",
            evidenceDigest: execution.contentDigest,
            exitCode: 0,
          }
        : summary,
    ),
  });

  assert.throws(
    () =>
      validateGate2702ClassificationEvidence({
        artifactBytesByPath: fixture.artifacts,
        trialId: TRIAL_ID,
        baseSha: BASE_SHA,
        subject: SUBJECT,
        treatmentId: TREATMENT_ID,
        attempt: 1,
      }),
    /execution does not rederive from its wrapper outcome/,
  );
});

test("re-digesting a failed npm install cannot turn the preflight into a pass", () => {
  const fixture = createSuccessfulFixture();
  const outcomePath = `${fixture.install.root}/outcome.json`;
  const outcome = JSON.parse(fixture.artifacts.get(outcomePath).toString());
  fixture.artifacts.set(
    outcomePath,
    Buffer.from(
      `${JSON.stringify({
        ...outcome,
        durationMs: 1_250,
        exitCode: 1,
      })}\n`,
    ),
  );
  const execution = fixture.putReceipt(
    `${fixture.install.root}/execution.json`,
    {
      ...fixture.install.execution,
      contentDigest: undefined,
      durationMs: 1_250,
      exitCode: 0,
    },
  );
  const preflight = fixture.putReceipt(`preflight/issue-${SUBJECT}.json`, {
    ...fixture.preflight,
    contentDigest: undefined,
    arms: {
      ...fixture.preflight.arms,
      [TREATMENT_ID]: {
        ...fixture.preflight.arms[TREATMENT_ID],
        install: execution,
      },
    },
  });
  fixture.putReceipt(`${fixture.prefix}/classification.json`, {
    ...fixture.classification,
    contentDigest: undefined,
    preflightDigest: preflight.contentDigest,
  });

  assert.throws(
    () =>
      validateGate2702ClassificationEvidence({
        artifactBytesByPath: fixture.artifacts,
        trialId: TRIAL_ID,
        baseSha: BASE_SHA,
        subject: SUBJECT,
        treatmentId: TREATMENT_ID,
        attempt: 1,
      }),
    /npm-ci execution does not rederive from its wrapper outcome/,
  );
});

test("a failed preflight proves that no worker or checks were dispatched", () => {
  const fixture = createSuccessfulFixture();
  const outcomePath = `${fixture.install.root}/outcome.json`;
  const installOutcome = JSON.parse(
    fixture.artifacts.get(outcomePath).toString(),
  );
  fixture.artifacts.set(
    outcomePath,
    Buffer.from(`${JSON.stringify({ ...installOutcome, exitCode: 1 })}\n`),
  );
  const failedInstall = fixture.putReceipt(
    `${fixture.install.root}/execution.json`,
    {
      ...fixture.install.execution,
      contentDigest: undefined,
      exitCode: 1,
    },
  );
  const preflight = fixture.putReceipt(`preflight/issue-${SUBJECT}.json`, {
    ...fixture.preflight,
    contentDigest: undefined,
    status: "failed",
    arms: {
      ...fixture.preflight.arms,
      [TREATMENT_ID]: {
        ...fixture.preflight.arms[TREATMENT_ID],
        install: failedInstall,
      },
    },
    errors: [{ treatmentId: TREATMENT_ID, code: "npm-ci-failed" }],
  });
  fixture.artifacts.delete(`${fixture.prefix}/pre-dispatch.json`);
  fixture.artifacts.delete(`${fixture.prefix}/process.json`);
  for (const path of [...fixture.artifacts.keys()]) {
    if (path.startsWith(`${fixture.prefix}/checks/`)) {
      fixture.artifacts.delete(path);
    }
  }
  const empty = Buffer.alloc(0);
  fixture.artifacts.set(`${fixture.prefix}/stdout.log`, empty);
  fixture.artifacts.set(`${fixture.prefix}/stderr.log`, empty);
  const terminal = fixture.putReceipt(`${fixture.prefix}/terminal.json`, {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
    baseSha: BASE_SHA,
    preflightDigest: preflight.contentDigest,
    outcome: "preflight-failed",
    exitCode: null,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    endedAt: "2026-07-20T18:00:00.000Z",
  });
  const classification = fixture.putReceipt(
    `${fixture.prefix}/classification.json`,
    {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      registrationDigest: fixture.registration.contentDigest,
      preflightDigest: preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      status: "failed",
      eligible: false,
      workerArtifacts: {
        stdout: artifact(`${fixture.registration.runDir}/stdout.log`, empty),
        stderr: artifact(`${fixture.registration.runDir}/stderr.log`, empty),
      },
      checkResults: [],
      error: {
        code: "tooling-artifact",
        message: "paired C5 environment preflight failed before model dispatch",
        preflightErrors: preflight.errors,
      },
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    },
  );

  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
  });
  assert.equal(verified.preDispatch, null);
  assert.equal(verified.checks.length, 0);
  assert.equal(verified.install.execution.exitCode, 1);
  assert.equal(
    verified.classification.contentDigest,
    classification.contentDigest,
  );
});

test("a timed-out production worker rederives only a cancelled classification", () => {
  const fixture = createSuccessfulFixture();
  for (const path of [...fixture.artifacts.keys()]) {
    if (path.startsWith(`${fixture.prefix}/checks/`)) {
      fixture.artifacts.delete(path);
    }
  }
  const terminal = fixture.putReceipt(`${fixture.prefix}/terminal.json`, {
    ...fixture.terminal,
    contentDigest: undefined,
    outcome: "timed-out",
    exitCode: null,
    signal: "SIGTERM",
    timedOut: true,
  });
  const classification = fixture.putReceipt(
    `${fixture.prefix}/classification.json`,
    {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      registrationDigest: fixture.registration.contentDigest,
      preflightDigest: fixture.preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId: TREATMENT_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      status: "cancelled",
      eligible: false,
      workerArtifacts: fixture.classification.workerArtifacts,
      checkResults: [],
      error: {
        code: "timeout",
        message: "the C5 worker exceeded its fixed wall-time limit",
      },
      retry: { authorized: true, reason: "timeout", maximumAttempt: 2 },
    },
  );

  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
  });
  assert.equal(verified.classification.status, "cancelled");
  assert.equal(
    verified.classification.contentDigest,
    classification.contentDigest,
  );
  assert.equal(verified.checks.length, 0);
});

test("a missing production check tool rederives a failed tooling classification", () => {
  const fixture = createSuccessfulFixture();
  const checkId = "checks/gate-2702-vitest";
  const slug = checkId.replaceAll("/", "_");
  const original = fixture.checkReceipts[checkId].execution;
  const execution = fixture.putReceipt(
    `${fixture.prefix}/checks/${slug}.json`,
    { ...original, contentDigest: undefined, exitCode: 127 },
  );
  fixture.artifacts.set(
    `${fixture.prefix}/checks/${slug}.outcome.json`,
    Buffer.from(
      `${JSON.stringify({
        token: fixture.checkReceipts[checkId].preDispatch.dispatchToken,
        exitCode: 127,
        signal: null,
      })}\n`,
    ),
  );
  const { worktreeEvidence: _worktreeEvidence, ...classificationBody } =
    fixture.classification;
  const classification = fixture.putReceipt(
    `${fixture.prefix}/classification.json`,
    {
      ...classificationBody,
      contentDigest: undefined,
      status: "failed",
      eligible: false,
      checkResults: fixture.classification.checkResults.map((summary) =>
        summary.checkId === checkId
          ? {
              ...summary,
              status: "failed",
              evidenceDigest: execution.contentDigest,
              exitCode: 127,
            }
          : summary,
      ),
      error: {
        code: "tooling-artifact",
        checkId,
        message:
          "a declared check could not execute with the preflighted toolchain",
      },
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    },
  );

  const verified = validateGate2702ClassificationEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    baseSha: BASE_SHA,
    subject: SUBJECT,
    treatmentId: TREATMENT_ID,
    attempt: 1,
  });
  assert.equal(verified.classification.status, "failed");
  assert.equal(
    verified.classification.contentDigest,
    classification.contentDigest,
  );
});
