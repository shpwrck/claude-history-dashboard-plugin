import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION } from "./behavior-context.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { buildGate2702Runtime } from "../build-gate-2702-runtime.mjs";
import { evaluateTrial } from "./evaluate.mjs";
import { deriveGate2702AccountingEvidence } from "./seal-accounting.mjs";
import { loadVerifiedTrial, sealTrial, verifyTrial } from "./seal.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEALER = join(HERE, "seal.mjs");
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_DIRECTORY = DEFINITION_DIGEST.replace(":", "-");
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest: DEFINITION_DIGEST,
};
const SUBJECTS = [2760, 2719, 2713, 2706, 2710, 2670];
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const CHECK_IDS = ["checks/gate-2702-vitest", "checks/gate-2702-typecheck"];
const CHECK_SPECS = {
  "checks/gate-2702-vitest": {
    argv: ["npx", "vitest", "run"],
    timeoutMs: 720_000,
  },
  "checks/gate-2702-typecheck": {
    argv: ["npm", "run", "typecheck"],
    timeoutMs: 360_000,
  },
};
const FIXED_WORKER_ARGV = [
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
const FIXED_JUDGE_ARGV = [
  "-p",
  "--model",
  "claude-haiku-4-5-20251001",
  "--json-schema",
  JSON.stringify(JUDGE_SCHEMA),
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--tools",
  "",
  "--max-budget-usd",
  "0.25",
];
const JUDGE_RUBRIC = [
  "You are an impartial judge comparing two attempts (A and B) at the same task.",
  "Skeptic first: for each attempt, identify what is missing or wrong before giving credit.",
  "Judge output quality, not length, apparent effort, model, or cost. Return tie only when equivalent.",
  "Score 1-10 on: correctness (Does it achieve the outcome the user would accept as the solution, rather than mere plausibility?); design (Is it well architected under CUPID, KISS, DRY, and GRASP? Score neutral 5 for non-code tasks.); completeness (Does it cover the whole task, including edge cases the task implies?); clarity (Is the result clear, well structured, and easy to act on?); scopeFit (Does it stay in scope, without over-building or unrequested changes?); autonomy (How few user prompts or interventions would it take to reach the result?)",
].join("\n");

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

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function valueDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function withDigest(receipt) {
  const undigested = { ...receipt };
  delete undigested.contentDigest;
  return { ...undigested, contentDigest: valueDigest(undigested) };
}

function writeReceipt(path, receipt) {
  const digested = withDigest(receipt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(digested, null, 2)}\n`, "utf8");
  return digested;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function emptyArtifact(path) {
  return {
    path,
    byteLength: 0,
    contentDigest: sha256(Buffer.alloc(0)),
    capturedBytes: 0,
    truncated: false,
  };
}

function retainedArtifact(path, bytes) {
  return {
    path,
    byteLength: bytes.length,
    contentDigest: sha256(bytes),
    capturedBytes: bytes.length,
    truncated: false,
  };
}

function writeSuccessfulInstallEvidence(registration) {
  const root = join(registration.runDir, "preflight-install");
  const stdoutPath = join(root, "stdout.log");
  const stderrPath = join(root, "stderr.log");
  const stdoutBytes = Buffer.from("fixture install complete\n", "utf8");
  const stderrBytes = Buffer.alloc(0);
  const stream = (bytes) => ({
    byteLength: bytes.length,
    capturedBytes: bytes.length,
    contentDigest: sha256(bytes),
    capturedContentDigest: sha256(bytes),
    truncated: false,
  });
  const stdout = stream(stdoutBytes);
  const stderr = stream(stderrBytes);
  const dispatchToken = randomUUID();
  const startedAt = "2026-07-20T17:58:00.000Z";
  const identityOffset =
    (registration.subject % 1_000) * 10 +
    TREATMENTS.indexOf(registration.treatmentId) * 2 +
    registration.attempt;
  const executable = join(
    registration.worktreePath,
    ".fixture-bin",
    "npm",
  );
  const preDispatch = writeReceipt(join(root, "pre-dispatch.json"), {
    schemaVersion: 1,
    kind: "Gate2702InstallPreDispatch",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    program: executable,
    executable,
    argv: ["npm", "ci"],
    timeoutMs: 1_200_000,
    maxBufferBytes: 256 * 1024,
    cwd: registration.worktreePath,
    dispatchToken,
    ownerPid: 50_000 + identityOffset,
    startedAt,
  });
  const processReceipt = writeReceipt(join(root, "process.json"), {
    schemaVersion: 1,
    kind: "Gate2702InstallProcess",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    dispatchToken,
    pid: 60_000 + identityOffset,
  });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "dispatch-gate"), `${dispatchToken}\n`, "utf8");
  writeFileSync(stdoutPath, stdoutBytes);
  writeFileSync(stderrPath, stderrBytes);
  writeFileSync(
    join(root, "outcome.json"),
    `${JSON.stringify({
      token: dispatchToken,
      exitCode: 0,
      signal: null,
      durationMs: 500,
      timedOut: false,
      stdout,
      stderr,
    })}\n`,
    "utf8",
  );
  const execution = writeReceipt(join(root, "execution.json"), {
    schemaVersion: 1,
    kind: "Gate2702InstallExecution",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    trialId: registration.trialId,
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    baseSha: registration.baseSha,
    program: executable,
    executable,
    argv: ["npm", "ci"],
    pid: processReceipt.pid,
    timeoutMs: 1_200_000,
    maxBufferBytes: 256 * 1024,
    startedAt,
    durationMs: 500,
    exitCode: 0,
    signal: null,
    timedOut: false,
    interrupted: false,
    processGroupQuiescent: true,
    truncated: false,
    stdout: stdoutBytes.toString("utf8").trim(),
    stderr: "",
    stdoutEvidence: { path: stdoutPath, ...stdout },
    stderrEvidence: { path: stderrPath, ...stderr },
  });
  return { preDispatch, process: processReceipt, execution };
}

function accountingFields(treatmentId) {
  const enabled = treatmentId === "haiku-sonnet-sidekick";
  return deriveGate2702AccountingEvidence({
    workerStdoutBytes: Buffer.alloc(0),
    sidekickLedgerBytes: null,
    sidekickEnabled: enabled,
    definitionDigest: DEFINITION_DIGEST,
    sidekickModel: "claude-sonnet-5",
  });
}

function createRepository(root) {
  const repository = join(root, "repository");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "--quiet", "--initial-branch=master"]);
  git(repository, ["config", "user.name", "Gate 2702 Seal Test"]);
  git(repository, ["config", "user.email", "gate-2702@example.invalid"]);
  writeFileSync(join(repository, "README.md"), "# C5 seal fixture\n", "utf8");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "--quiet", "-m", "fixture base"]);
  return {
    repository,
    baseSha: git(repository, ["rev-parse", "HEAD"]),
  };
}

function createWorktree(repository, baseSha, path) {
  mkdirSync(dirname(path), { recursive: true });
  git(repository, ["worktree", "add", "--quiet", "--detach", path, baseSha]);
  return git(path, ["rev-parse", "--absolute-git-dir"]);
}

function armPaths(trialRoot, subject, treatmentId, attempt = 1) {
  const runDir = join(
    trialRoot,
    "runs",
    `issue-${subject}`,
    treatmentId,
    `attempt-${attempt}`,
  );
  return {
    runDir,
    registration: join(runDir, "registration.json"),
    identity: join(runDir, "worktree-identity.json"),
    terminal: join(runDir, "terminal.json"),
    classification: join(runDir, "classification.json"),
    accounting: join(runDir, "accounting.json"),
  };
}

function createFailedArm({
  repository,
  baseSha,
  trialId,
  trialRoot,
  worktreeRoot,
  subject,
  treatmentId,
  attempt,
  preflight,
  retryOf,
}) {
  const paths = armPaths(trialRoot, subject, treatmentId, attempt);
  const worktreePath = join(
    worktreeRoot,
    `issue-${subject}.${treatmentId}.attempt-${attempt}`,
  );
  const gitDirectory = createWorktree(repository, baseSha, worktreePath);
  const registration = writeReceipt(paths.registration, {
    schemaVersion: 1,
    kind: "Gate2702ArmRegistration",
    definitionRef: DEFINITION_REF,
    trialId,
    subject,
    subjectRef: `github:shpwrck/claude-history-dashboard#${subject}`,
    treatmentId,
    attempt,
    baseSha,
    executionMode: "production",
    runDir: paths.runDir,
    worktreePath,
    ...(retryOf ? { retryOf } : {}),
  });
  const identity = writeReceipt(paths.identity, {
    schemaVersion: 1,
    kind: "Gate2702WorktreeIdentity",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId,
    subject,
    treatmentId,
    attempt,
    baseSha,
    executionMode: "production",
    worktreePath,
    gitDirectory,
    identityToken: randomUUID(),
    createdAt: "2026-07-20T18:00:00.000Z",
  });
  const install = writeSuccessfulInstallEvidence(registration);
  writeFileSync(join(paths.runDir, "stdout.log"), "", "utf8");
  writeFileSync(join(paths.runDir, "stderr.log"), "", "utf8");
  const terminal = writeReceipt(paths.terminal, {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId,
    subject,
    treatmentId,
    attempt,
    baseSha,
    preflightDigest: preflight.contentDigest,
    outcome: "preflight-failed",
    exitCode: null,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    endedAt: "2026-07-20T18:01:00.000Z",
  });
  const classification = writeReceipt(paths.classification, {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preflightDigest: preflight.contentDigest,
    terminalDigest: terminal.contentDigest,
    trialId,
    subject,
    treatmentId,
    attempt,
    baseSha,
    status: "failed",
    eligible: false,
    workerArtifacts: {
      stdout: emptyArtifact(join(paths.runDir, "stdout.log")),
      stderr: emptyArtifact(join(paths.runDir, "stderr.log")),
    },
    checkResults: [],
    error: {
      code: "tooling-artifact",
      message: "paired C5 environment preflight failed before model dispatch",
      preflightErrors: preflight.errors ?? [],
    },
    retry: {
      authorized: attempt === 1,
      reason: "tooling-artifact",
      maximumAttempt: 2,
    },
  });
  const accounting = writeReceipt(paths.accounting, {
    schemaVersion: 1,
    kind: "Gate2702Accounting",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    terminalDigest: terminal.contentDigest,
    classificationDigest: classification.contentDigest,
    trialId,
    subject,
    treatmentId,
    attempt,
    baseSha,
    ...(retryOf ? { retryOf } : {}),
    ...accountingFields(treatmentId),
  });
  return {
    paths,
    registration,
    identity,
    install: install.execution,
    terminal,
    classification,
    accounting,
  };
}

function createFixture({ includeRetry = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-seal-"));
  const home = join(root, "home");
  const stateRoot = join(root, "state");
  const trialId = randomUUID();
  const trialRoot = join(stateRoot, DEFINITION_DIRECTORY, trialId);
  const worktreeRoot = join(trialRoot, "worktrees");
  const { repository, baseSha } = createRepository(root);
  mkdirSync(home, { recursive: true });
  const subjectSnapshots = [];
  const preflights = new Map();
  const registrations = [];
  const evidence = [];

  for (const subject of SUBJECTS) {
    const snapshot = writeReceipt(
      join(trialRoot, "subjects", `issue-${subject}.json`),
      {
        schemaVersion: 1,
        kind: "Gate2702SubjectSnapshot",
        definitionRef: DEFINITION_REF,
        trialId,
        repository: "shpwrck/claude-history-dashboard",
        executionMode: "production",
        subject,
        baseSha,
        title: `Fixture issue ${subject}`,
        body: `Bounded C5 fixture for issue ${subject}.`,
        url: `https://example.invalid/issues/${subject}`,
      },
    );
    subjectSnapshots.push({ subject, contentDigest: snapshot.contentDigest });

    const preflightPath = join(trialRoot, "preflight", `issue-${subject}.json`);
    // The registration digests are filled after both arms have been allocated.
    preflights.set(subject, { path: preflightPath, snapshot });
  }

  // Registrations must precede the pair receipt, while terminal receipts need
  // that pair receipt. Allocate worktrees and registrations first.
  const allocated = [];
  for (const subject of SUBJECTS) {
    for (const treatmentId of TREATMENTS) {
      const paths = armPaths(trialRoot, subject, treatmentId, 1);
      const worktreePath = join(
        worktreeRoot,
        `issue-${subject}.${treatmentId}.attempt-1`,
      );
      const gitDirectory = createWorktree(repository, baseSha, worktreePath);
      const registration = writeReceipt(paths.registration, {
        schemaVersion: 1,
        kind: "Gate2702ArmRegistration",
        definitionRef: DEFINITION_REF,
        trialId,
        subject,
        subjectRef: `github:shpwrck/claude-history-dashboard#${subject}`,
        treatmentId,
        attempt: 1,
        baseSha,
        executionMode: "production",
        runDir: paths.runDir,
        worktreePath,
      });
      const identity = writeReceipt(paths.identity, {
        schemaVersion: 1,
        kind: "Gate2702WorktreeIdentity",
        definitionRef: DEFINITION_REF,
        registrationDigest: registration.contentDigest,
        trialId,
        subject,
        treatmentId,
        attempt: 1,
        baseSha,
        executionMode: "production",
        worktreePath,
        gitDirectory,
        identityToken: randomUUID(),
        createdAt: "2026-07-20T18:00:00.000Z",
      });
      const install = writeSuccessfulInstallEvidence(registration);
      registrations.push(registration);
      allocated.push({
        paths,
        registration,
        identity,
        install: install.execution,
      });
    }
  }

  for (const subject of SUBJECTS) {
    const arms = Object.fromEntries(
      allocated
        .filter((entry) => entry.registration.subject === subject)
        .map(({ registration, install }) => [
          registration.treatmentId,
          {
            treatmentId: registration.treatmentId,
            attempt: 1,
            registrationDigest: registration.contentDigest,
            worktreePath: registration.worktreePath,
            install,
          },
        ]),
    );
    const preflight = writeReceipt(preflights.get(subject).path, {
      schemaVersion: 1,
      kind: "Gate2702PairPreflight",
      definitionRef: DEFINITION_REF,
      trialId,
      subject,
      baseSha,
      status: "failed",
      arms,
      environment: {},
      environmentDigest: valueDigest({}),
      errors: [{ code: "fixture-preflight-failure" }],
    });
    preflights.set(subject, preflight);
  }

  for (const allocatedArm of allocated) {
    const { paths, registration } = allocatedArm;
    const preflight = preflights.get(registration.subject);
    writeFileSync(join(paths.runDir, "stdout.log"), "", "utf8");
    writeFileSync(join(paths.runDir, "stderr.log"), "", "utf8");
    const terminal = writeReceipt(paths.terminal, {
      schemaVersion: 1,
      kind: "Gate2702Terminal",
      definitionRef: DEFINITION_REF,
      trialId,
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: 1,
      baseSha,
      preflightDigest: preflight.contentDigest,
      outcome: "preflight-failed",
      exitCode: null,
      signal: null,
      timedOut: false,
      processGroupQuiescent: true,
      endedAt: "2026-07-20T18:01:00.000Z",
    });
    const classification = writeReceipt(paths.classification, {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preflightDigest: preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      trialId,
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: 1,
      baseSha,
      status: "failed",
      eligible: false,
      workerArtifacts: {
        stdout: emptyArtifact(join(paths.runDir, "stdout.log")),
        stderr: emptyArtifact(join(paths.runDir, "stderr.log")),
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
    });
    const accounting = writeReceipt(paths.accounting, {
      schemaVersion: 1,
      kind: "Gate2702Accounting",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      terminalDigest: terminal.contentDigest,
      classificationDigest: classification.contentDigest,
      trialId,
      subject: registration.subject,
      treatmentId: registration.treatmentId,
      attempt: 1,
      baseSha,
      ...accountingFields(registration.treatmentId),
    });
    evidence.push({
      ...allocatedArm,
      terminal,
      classification,
      accounting,
    });
  }

  const worktreeManifest = registrations.map((registration) => ({
    subject: registration.subject,
    treatmentId: registration.treatmentId,
    attempt: registration.attempt,
    worktreePath: registration.worktreePath,
    registrationDigest: registration.contentDigest,
  }));
  const trialPath = join(trialRoot, "trial.json");
  const trial = writeReceipt(trialPath, {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId,
    repository: "shpwrck/claude-history-dashboard",
    executionMode: "production",
    repoPath: repository,
    stateRoot,
    worktreeRoot,
    baseSha,
    worktreeManifestDigest: valueDigest(worktreeManifest),
    subjectSnapshots,
    registrations,
  });

  let retry = null;
  if (includeRetry) {
    const parent = evidence.find(
      (entry) =>
        entry.registration.subject === SUBJECTS[0] &&
        entry.registration.treatmentId === TREATMENTS[0],
    );
    const retryOf = {
      attempt: 1,
      registrationDigest: parent.registration.contentDigest,
      classificationDigest: parent.classification.contentDigest,
    };
    const retryPreflight = writeReceipt(
      join(
        trialRoot,
        "runs",
        `issue-${SUBJECTS[0]}`,
        TREATMENTS[0],
        "attempt-2",
        "preflight.json",
      ),
      {
        schemaVersion: 1,
        kind: "Gate2702RetryPreflight",
        definitionRef: DEFINITION_REF,
        trialId,
        subject: SUBJECTS[0],
        treatmentId: TREATMENTS[0],
        attempt: 2,
        baseSha,
        status: "failed",
        behaviorContext: null,
        environment: {},
        environmentDigest: valueDigest({}),
        errors: [{ code: "fixture-preflight-failure" }],
      },
    );
    retry = createFailedArm({
      repository,
      baseSha,
      trialId,
      trialRoot,
      worktreeRoot,
      subject: SUBJECTS[0],
      treatmentId: TREATMENTS[0],
      attempt: 2,
      preflight: retryPreflight,
      retryOf,
    });
    const boundRetryPreflight = writeReceipt(
      join(retry.paths.runDir, "preflight.json"),
      {
        ...retryPreflight,
        contentDigest: undefined,
        registrationDigest: retry.registration.contentDigest,
        install: retry.install,
      },
    );
    const retryTerminal = writeReceipt(retry.paths.terminal, {
      ...retry.terminal,
      contentDigest: undefined,
      preflightDigest: boundRetryPreflight.contentDigest,
    });
    const retryClassification = writeReceipt(retry.paths.classification, {
      ...retry.classification,
      contentDigest: undefined,
      preflightDigest: boundRetryPreflight.contentDigest,
      terminalDigest: retryTerminal.contentDigest,
    });
    const retryAccountingBase = writeReceipt(retry.paths.accounting, {
      ...retry.accounting,
      contentDigest: undefined,
      terminalDigest: retryTerminal.contentDigest,
      classificationDigest: retryClassification.contentDigest,
    });
    retry = {
      ...retry,
      preflight: boundRetryPreflight,
      terminal: retryTerminal,
      classification: retryClassification,
      accounting: retryAccountingBase,
    };
    const retryManifest = [
      {
        subject: retry.registration.subject,
        treatmentId: retry.registration.treatmentId,
        attempt: 2,
        registrationDigest: retry.registration.contentDigest,
        retryOf,
        worktreePath: retry.registration.worktreePath,
      },
    ];
    const registrationSetDigest = valueDigest(retryManifest);
    const retrySet = writeReceipt(
      join(
        trialRoot,
        "retries",
        "sets",
        `${registrationSetDigest.replace(":", "-")}.json`,
      ),
      {
        schemaVersion: 1,
        kind: "Gate2702RetryRegistrationSet",
        definitionRef: DEFINITION_REF,
        trialId,
        baseSha,
        registrationSetDigest,
        registrations: retryManifest,
      },
    );
    const retryAccounting = writeReceipt(retry.paths.accounting, {
      ...retry.accounting,
      contentDigest: undefined,
      retryOf,
      retryRegistrationSetDigest: registrationSetDigest,
      retryRegistrationSetReceiptDigest: retrySet.contentDigest,
    });
    retry = {
      ...retry,
      accounting: retryAccounting,
      retryOf,
      retrySet,
      registrationSetDigest,
    };
    evidence.push(retry);
  }

  const dependencies = {
    classification(_options, registration) {
      return readJson(join(registration.runDir, "classification.json"));
    },
    accounting(_options, registration) {
      return readJson(join(registration.runDir, "accounting.json"));
    },
    judge(_options, subject) {
      const path = join(
        trialRoot,
        "judging",
        `issue-${subject}`,
        "result.json",
      );
      if (!existsSync(path)) {
        throw new Error("an all-excluded fixture must never invoke the judge");
      }
      return readJson(path);
    },
  };

  return {
    root,
    home,
    stateRoot,
    trialId,
    trialRoot,
    trialPath,
    trial,
    baseSha,
    repository,
    evidence,
    retry,
    dependencies,
    options: { trial: trialId, stateRoot },
    markerPath: join(trialRoot, "seal", "verified.json"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function completeBehaviorContext(treatmentId) {
  const enabled = treatmentId === "haiku-sonnet-sidekick";
  const sidekick = sidekickConfiguration(treatmentId);
  const resolvedSidekickConfig = {
    enabled,
    model: "claude-sonnet-5",
    gate: enabled ? "checkpoint" : "off",
    warmupTokens: 150_000,
    backoffAfter: 3,
    backoffMax: 8,
    sessionBudgetUsd: enabled ? sidekick.sessionBudgetUsd : 0,
    triggerReserveUsd: enabled ? 1 : 0,
    callBudgetUsd: enabled ? sidekick.perCallBudgetUsd : 0,
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
  return {
    // Imported, not re-typed: a hand-written 1 here would silently pin the
    // fixture to a stale capture basis the moment the context is versioned.
    schemaVersion: GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION,
    observedAt: "2026-07-20T18:00:00.000Z",
    workerModelQualifiedId: "claude-haiku-4-5-20251001",
    sidekickModelQualifiedId: enabled ? "claude-sonnet-5" : null,
    sidekickVersion: enabled ? "0.3.3" : null,
    sidekickImplementationDigest: enabled
      ? valueDigest({ package: "claude-sidekick", version: "0.3.3" })
      : null,
    sidekickActivation: enabled
      ? { pluginEnabled: true, globalPauseAbsent: true }
      : null,
    resolvedSidekickConfig,
    resolvedSidekickConfigDigest: valueDigest(resolvedSidekickConfig),
    instructionSources: [],
    instructionsDigest: valueDigest([]),
  };
}

function sidekickConfiguration(treatmentId) {
  return treatmentId === "haiku-sonnet-sidekick"
    ? {
        enabled: true,
        reviewerTier: "sonnet",
        gate: "checkpoint",
        sessionBudgetUsd: 2,
        perCallBudgetUsd: 1,
      }
    : {
        enabled: false,
        sessionBudgetUsd: 0,
        perCallBudgetUsd: 0,
      };
}

function sidekickPreflightEvidence(treatmentId) {
  const enabled = treatmentId === "haiku-sonnet-sidekick";
  const context = completeBehaviorContext(treatmentId);
  return {
    version: context.sidekickVersion,
    implementationDigest: context.sidekickImplementationDigest,
    activation: context.sidekickActivation,
    configuration: sidekickConfiguration(treatmentId),
  };
}

function sidekickEnvironment(treatmentId) {
  const config = completeBehaviorContext(treatmentId).resolvedSidekickConfig;
  return {
    SIDEKICK_ENABLE: config.enabled ? "1" : "0",
    SIDEKICK_MODEL: config.model,
    SIDEKICK_GATE: config.gate,
    SIDEKICK_WARMUP_TOKENS: String(config.warmupTokens),
    SIDEKICK_BACKOFF_AFTER: String(config.backoffAfter),
    SIDEKICK_BACKOFF_MAX: String(config.backoffMax),
    SIDEKICK_SESSION_BUDGET_USD: String(config.sessionBudgetUsd),
    SIDEKICK_TRIGGER_RESERVE_USD: String(config.triggerReserveUsd),
    SIDEKICK_CALL_BUDGET_USD: String(config.callBudgetUsd),
    SIDEKICK_SIGHTED: config.sighted ? "1" : "0",
    SIDEKICK_VERIFY_LENS: config.verifyLens ? "1" : "0",
    SIDEKICK_SYNC: config.sync ? "1" : "0",
    SIDEKICK_TRIGGERS: config.triggers.join(","),
    SIDEKICK_TRIAGE_MODEL: config.triageModel,
    SIDEKICK_AUDITS: config.audits.join(","),
    SIDEKICK_SHIP_COOLDOWN: String(config.shipCooldown),
    SIDEKICK_NEARDUP: String(config.nearDup),
    SIDEKICK_NEARDUP_MIN_SHARED: String(config.nearDupMinShared),
    SIDEKICK_CONCURRENCY: String(config.concurrency),
    SIDEKICK_MIN_DELTA: String(config.minDelta),
    SIDEKICK_NESTED: "0",
  };
}

function completeEnvironment() {
  return {
    node: { executable: process.execPath, version: process.version },
    npm: { executable: "npm", version: "10.9.2" },
    claude: { executable: "claude", version: "2.1.12 (Claude Code)" },
    vitest: { executable: "npx", version: "vitest/3.2.4" },
    typescript: { executable: "npx", version: "Version 5.8.3" },
  };
}

function completeEnvironmentProbes(environment) {
  const specs = {
    npm: ["npm", ["npm", "--version"]],
    claude: ["claude", ["claude", "--version"]],
    vitest: ["npx", ["npx", "--no-install", "vitest", "--version"]],
    typescript: ["npx", ["npx", "--no-install", "tsc", "--version"]],
  };
  return Object.fromEntries(
    Object.entries(specs).map(([name, [program, argv]]) => [
      name,
      {
        program,
        argv,
        pid: null,
        timeoutMs: 60_000,
        maxBufferBytes: 256 * 1024,
        exitCode: 0,
        signal: null,
        processGroupQuiescent: true,
        stdout: environment[name].version,
        stderr: "",
      },
    ]),
  );
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

function successfulAccountingFields(treatmentId, workerBytes, sidekickLedger) {
  const enabled = treatmentId === "haiku-sonnet-sidekick";
  return deriveGate2702AccountingEvidence({
    workerStdoutBytes: workerBytes,
    sidekickLedgerBytes: enabled ? sidekickLedger : null,
    sidekickEnabled: enabled,
    definitionDigest: DEFINITION_DIGEST,
    sidekickModel: "claude-sonnet-5",
  });
}

function writeSuccessfulCheckEvidence(
  arm,
  environment,
  environmentDigest,
  startedHour = "18:03",
) {
  const checkResults = [];
  const environmentProbes = completeEnvironmentProbes(environment);
  for (const [index, checkId] of CHECK_IDS.entries()) {
    const slug = checkId.replaceAll("/", "_");
    const root = join(arm.paths.runDir, "checks", slug);
    const spec = CHECK_SPECS[checkId];
    const dispatchToken = randomUUID();
    const startedAt = `2026-07-20T${startedHour}:0${index}.000Z`;
    const preDispatch = writeReceipt(`${root}.pre-dispatch.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckPreDispatch",
      definitionRef: DEFINITION_REF,
      registrationDigest: arm.registration.contentDigest,
      trialId: arm.registration.trialId,
      subject: arm.registration.subject,
      treatmentId: arm.registration.treatmentId,
      attempt: arm.registration.attempt,
      baseSha: arm.registration.baseSha,
      checkId,
      argv: spec.argv,
      timeoutMs: spec.timeoutMs,
      cwd: arm.registration.worktreePath,
      environment,
      environmentProbes,
      environmentDigest,
      dispatchToken,
      ownerPid: 41_000 + index,
      startedAt,
    });
    const processReceipt = writeReceipt(`${root}.process.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckProcess",
      definitionRef: DEFINITION_REF,
      registrationDigest: arm.registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: arm.registration.trialId,
      subject: arm.registration.subject,
      treatmentId: arm.registration.treatmentId,
      attempt: arm.registration.attempt,
      baseSha: arm.registration.baseSha,
      checkId,
      dispatchToken,
      pid: 43_000 + index,
    });
    writeFileSync(`${root}.dispatch-gate`, `${dispatchToken}\n`, "utf8");
    writeFileSync(
      `${root}.outcome.json`,
      `${JSON.stringify({ token: dispatchToken, exitCode: 0, signal: null })}\n`,
      "utf8",
    );
    writeFileSync(`${root}.stdout.log`, "", "utf8");
    writeFileSync(`${root}.stderr.log`, "", "utf8");
    const stream = (path) => ({
      path,
      byteLength: 0,
      capturedBytes: 0,
      contentDigest: sha256(Buffer.alloc(0)),
      capturedContentDigest: sha256(Buffer.alloc(0)),
      truncated: false,
    });
    const execution = writeReceipt(`${root}.json`, {
      schemaVersion: 1,
      kind: "Gate2702CheckExecution",
      definitionRef: DEFINITION_REF,
      registrationDigest: arm.registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      trialId: arm.registration.trialId,
      subject: arm.registration.subject,
      treatmentId: arm.registration.treatmentId,
      attempt: arm.registration.attempt,
      baseSha: arm.registration.baseSha,
      checkId,
      argv: spec.argv,
      timeoutMs: spec.timeoutMs,
      environmentDigest,
      environment,
      environmentProbes,
      startedAt,
      durationMs: 1_000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      interrupted: false,
      processGroupQuiescent: true,
      truncated: false,
      stdout: stream(`${root}.stdout.log`),
      stderr: stream(`${root}.stderr.log`),
    });
    checkResults.push({
      checkId,
      status: "passed",
      evidenceDigest: execution.contentDigest,
      exitCode: 0,
      signal: null,
      timedOut: false,
      interrupted: false,
      environmentDigest,
      processGroupQuiescent: true,
      truncated: false,
    });
  }
  return checkResults;
}

function writeSuccessfulJudgeEvidence(fixture, selectedByTreatment) {
  const subject = SUBJECTS[0];
  const judgeRoot = join(fixture.trialRoot, "judging", `issue-${subject}`);
  const selection = readJson(
    join(fixture.trialRoot, "pair-selection", `issue-${subject}.json`),
  );
  const snapshot = readJson(
    join(fixture.trialRoot, "subjects", `issue-${subject}.json`),
  );
  const emptyPatch = {
    encoding: "base64",
    sizeBytes: 0,
    contentDigest: sha256(Buffer.alloc(0)),
    bytes: "",
  };
  const armEvidence = {};
  const artifacts = {};
  const objectiveChecks = Object.fromEntries(
    TREATMENTS.map((treatmentId) => [
      treatmentId,
      {
        state: "passed",
        classificationDigest:
          selectedByTreatment[treatmentId].classification.contentDigest,
        results: selectedByTreatment[treatmentId].classification.checkResults,
      },
    ]),
  );
  for (const treatmentId of TREATMENTS) {
    const selected = selectedByTreatment[treatmentId];
    const diff = { trackedPatch: emptyPatch, untracked: [] };
    const artifact = [selected.workerResult, "[FINAL TRACKED DIFF]", "", ""]
      .filter(Boolean)
      .join("\n\n");
    const evidence = writeReceipt(
      join(judgeRoot, "evidence", `${treatmentId}.json`),
      {
        schemaVersion: 1,
        kind: "Gate2702JudgeArmEvidence",
        definitionRef: DEFINITION_REF,
        trialId: fixture.trialId,
        subject,
        treatmentId,
        attempt: selected.registration.attempt,
        baseSha: fixture.baseSha,
        executionMode: "production",
        pairSelectionDigest: selection.contentDigest,
        registrationDigest: selected.registration.contentDigest,
        classificationDigest: selected.classification.contentDigest,
        workerResult: selected.workerResult,
        workerResultDigest: sha256(Buffer.from(selected.workerResult, "utf8")),
        worktreeEvidence: selected.classification.worktreeEvidence,
        diff,
        artifact,
      },
    );
    armEvidence[treatmentId] = evidence.contentDigest;
    artifacts[treatmentId] = artifact;
  }
  const input = writeReceipt(join(judgeRoot, "input.json"), {
    schemaVersion: 1,
    kind: "Gate2702JudgeInput",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject,
    baseSha: fixture.baseSha,
    executionMode: "production",
    pairSelectionDigest: selection.contentDigest,
    subjectSnapshotDigest: snapshot.contentDigest,
    task: `${snapshot.title}\n\n${snapshot.body}`,
    armEvidence,
    objectiveChecks,
    artifacts,
  });
  const payloads = {
    forward: {
      task: input.task,
      rubric: JUDGE_RUBRIC,
      artifacts: {
        A: artifacts["haiku-solo"],
        B: artifacts["haiku-sonnet-sidekick"],
      },
    },
    swapped: {
      task: input.task,
      rubric: JUDGE_RUBRIC,
      artifacts: {
        A: artifacts["haiku-sonnet-sidekick"],
        B: artifacts["haiku-solo"],
      },
    },
  };
  const requestFor = (payload, orderMap) => ({
    order: orderMap,
    payload,
    payloadDigest: valueDigest(payload),
  });
  const requests = writeReceipt(join(judgeRoot, "requests.json"), {
    schemaVersion: 1,
    kind: "Gate2702JudgeRequests",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject,
    baseSha: fixture.baseSha,
    executionMode: "production",
    judgeInputDigest: input.contentDigest,
    judgeModel: "claude-haiku-4-5-20251001",
    timeoutMs: 600_000,
    maxBudgetUsd: 0.25,
    maxAttemptsPerOrder: 3,
    maxPayloadBytes: 128 * 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    schema: JUDGE_SCHEMA,
    rubric: JUDGE_RUBRIC,
    requests: {
      forward: requestFor(payloads.forward, {
        A: "haiku-solo",
        B: "haiku-sonnet-sidekick",
      }),
      swapped: requestFor(payloads.swapped, {
        A: "haiku-sonnet-sidekick",
        B: "haiku-solo",
      }),
    },
  });
  const responseByOrder = {
    forward: judgeResponse("A"),
    swapped: judgeResponse("B"),
  };
  const attempts = {};
  for (const order of ["forward", "swapped"]) {
    const response = responseByOrder[order];
    const lifecyclePrefix = join(judgeRoot, order, "attempt-1");
    const dispatchToken = randomUUID();
    const preDispatch = writeReceipt(`${lifecyclePrefix}.pre-dispatch.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgePreDispatch",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      executionMode: "production",
      requestSetDigest: requests.contentDigest,
      payloadDigest: requests.requests[order].payloadDigest,
      payload: requests.requests[order].payload,
      order,
      attempt: 1,
      executable: "claude",
      argv: FIXED_JUDGE_ARGV,
      judgeModel: "claude-haiku-4-5-20251001",
      sidekickEnabled: false,
      toolAccess: false,
      permissionBypass: false,
      maxBudgetUsd: 0.25,
      timeoutMs: 600_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
      dispatchToken,
      createdAt: "2026-07-20T18:06:00.000Z",
    });
    const processReceipt = writeReceipt(`${lifecyclePrefix}.process.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeProcess",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      executionMode: "production",
      requestSetDigest: requests.contentDigest,
      payloadDigest: requests.requests[order].payloadDigest,
      order,
      attempt: 1,
      dispatchToken,
      preDispatchDigest: preDispatch.contentDigest,
      executable: process.execPath,
      argv: [
        join(HERE, "judge.mjs"),
        "__dispatch",
        `${lifecyclePrefix}.pre-dispatch.json`,
        `${lifecyclePrefix}.process.json`,
        `${lifecyclePrefix}.gate.json`,
        `${lifecyclePrefix}.outcome.json`,
      ],
      pid: order === "forward" ? 42_101 : 42_102,
      processStartTimeTicks: order === "forward" ? "1001" : "1002",
      launchedAt: "2026-07-20T18:06:00.010Z",
    });
    const gate = writeReceipt(`${lifecyclePrefix}.gate.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeGate",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      executionMode: "production",
      requestSetDigest: requests.contentDigest,
      payloadDigest: requests.requests[order].payloadDigest,
      order,
      attempt: 1,
      dispatchToken,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      authorizedAt: "2026-07-20T18:06:00.020Z",
    });
    const outcome = writeReceipt(
      `${lifecyclePrefix}.outcome.json`,
      judgeOutcome({
        trialId: fixture.trialId,
        subject,
        order,
        response,
        baseSha: fixture.baseSha,
        requests,
        preDispatch,
        processReceipt,
        gate,
      }),
    );
    const attempt = writeReceipt(`${lifecyclePrefix}.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeAttempt",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      executionMode: "production",
      requestSetDigest: requests.contentDigest,
      payloadDigest: requests.requests[order].payloadDigest,
      order,
      attempt: 1,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      outcomeDigest: outcome.contentDigest,
      argv: ["claude", ...FIXED_JUDGE_ARGV],
      judgeModel: "claude-haiku-4-5-20251001",
      sidekickEnabled: false,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      startedMonotonicNs: outcome.startedMonotonicNs,
      endedMonotonicNs: outcome.endedMonotonicNs,
      durationMs: outcome.durationMs,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      outcome: "valid",
      retryable: false,
      failureClass: null,
      response,
      costUsd: 0.1,
    });
    attempts[order] = [{ attempt: 1, contentDigest: attempt.contentDigest }];
  }
  const result = writeReceipt(join(judgeRoot, "result.json"), {
    schemaVersion: 1,
    kind: "Gate2702JudgeResult",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject,
    baseSha: fixture.baseSha,
    executionMode: "production",
    judgeInputDigest: input.contentDigest,
    requestSetDigest: requests.contentDigest,
    attempts,
    objectiveChecks,
    state: "agreed",
    subjectiveState: "agreed",
    forwardWinner: "haiku-solo",
    swappedWinner: "haiku-solo",
    subjectiveWinner: "haiku-solo",
    effectiveWinner: "haiku-solo",
    effectiveBasis: "blind-judge",
  });
  return result;
}

function promoteSuccessfulSelectedPair(
  fixture,
  {
    controlWorkerCostUsd = 1.4,
    treatmentWorkerCostUsd = 0.9,
    sidekickCostUsd = 0.2,
  } = {},
) {
  const subject = SUBJECTS[0];
  const snapshot = readJson(
    join(fixture.trialRoot, "subjects", `issue-${subject}.json`),
  );
  const selectedArms = fixture.evidence.filter(
    (entry) => entry.registration.subject === subject,
  );
  assert.equal(selectedArms.length, 2);
  const environment = completeEnvironment();
  const environmentProbes = completeEnvironmentProbes(environment);
  const environmentDigest = valueDigest(environment);
  const preflight = writeReceipt(
    join(fixture.trialRoot, "preflight", `issue-${subject}.json`),
    {
      schemaVersion: 1,
      kind: "Gate2702PairPreflight",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      status: "passed",
      arms: Object.fromEntries(
        selectedArms.map(({ registration, install }) => [
          registration.treatmentId,
          {
            treatmentId: registration.treatmentId,
            attempt: 1,
            registrationDigest: registration.contentDigest,
            worktreePath: registration.worktreePath,
            environment,
            environmentProbes,
            environmentDigest,
            install,
            behaviorContext: completeBehaviorContext(registration.treatmentId),
            sidekick: sidekickPreflightEvidence(registration.treatmentId),
          },
        ]),
      ),
      environment,
      environmentDigest,
    },
  );

  const selectedByTreatment = {};
  for (const arm of selectedArms) {
    const sessionId = randomUUID();
    const workerResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      total_cost_usd:
        arm.registration.treatmentId === "haiku-sonnet-sidekick"
          ? treatmentWorkerCostUsd
          : controlWorkerCostUsd,
      result: "bounded successful fixture result",
    };
    const workerBytes = Buffer.from(
      `${JSON.stringify(workerResult)}\n`,
      "utf8",
    );
    const sidekickLedger =
      arm.registration.treatmentId === "haiku-sonnet-sidekick"
        ? Buffer.from(
            `${JSON.stringify({
              model: "sync",
              trigger: "checkpoint",
              turn: 1,
              costUsd: sidekickCostUsd,
              shipped: true,
            })}\n`,
            "utf8",
          )
        : Buffer.alloc(0);
    if (sidekickLedger.length > 0) {
      const ledgerPath = join(
        fixture.home,
        ".sidekick",
        sessionId,
        "__sidekick.jsonl",
      );
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, sidekickLedger);
    }
    writeFileSync(join(arm.paths.runDir, "stdout.log"), workerBytes);
    writeFileSync(join(arm.paths.runDir, "stderr.log"), "", "utf8");
    const recordedSidekickEnvironment = sidekickEnvironment(
      arm.registration.treatmentId,
    );
    const preDispatch = writeReceipt(
      join(arm.paths.runDir, "pre-dispatch.json"),
      {
        schemaVersion: 1,
        kind: "Gate2702PreDispatch",
        definitionRef: DEFINITION_REF,
        registrationDigest: arm.registration.contentDigest,
        worktreeIdentityDigest: arm.identity.contentDigest,
        trialId: fixture.trialId,
        subject,
        treatmentId: arm.registration.treatmentId,
        attempt: 1,
        baseSha: fixture.baseSha,
        executionMode: "production",
        argv: FIXED_WORKER_ARGV,
        sidekickEnvironment: recordedSidekickEnvironment,
        sidekickEnvironmentDigest: valueDigest(recordedSidekickEnvironment),
        cwd: arm.registration.worktreePath,
        promptDigest: sha256(
          Buffer.from(workerPrompt(snapshot, arm.registration), "utf8"),
        ),
        startedAt: "2026-07-20T18:01:00.000Z",
      },
    );
    const processReceipt = writeReceipt(
      join(arm.paths.runDir, "process.json"),
      {
        schemaVersion: 1,
        kind: "Gate2702Process",
        definitionRef: DEFINITION_REF,
        registrationDigest: arm.registration.contentDigest,
        preDispatchDigest: preDispatch.contentDigest,
        trialId: fixture.trialId,
        subject,
        treatmentId: arm.registration.treatmentId,
        attempt: 1,
        baseSha: fixture.baseSha,
        pid: 42_000 + TREATMENTS.indexOf(arm.registration.treatmentId),
        detachedProcessGroup: true,
        startedAt: "2026-07-20T18:01:00.000Z",
      },
    );
    const terminal = writeReceipt(arm.paths.terminal, {
      ...arm.terminal,
      contentDigest: undefined,
      preflightDigest: preflight.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      outcome: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      processGroupQuiescent: true,
      durationMs: 240_000,
      endedAt: "2026-07-20T18:05:00.000Z",
    });
    const checkResults = writeSuccessfulCheckEvidence(
      arm,
      environment,
      environmentDigest,
    );
    const classification = writeReceipt(arm.paths.classification, {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      registrationDigest: arm.registration.contentDigest,
      preflightDigest: preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      trialId: fixture.trialId,
      subject,
      treatmentId: arm.registration.treatmentId,
      attempt: 1,
      baseSha: fixture.baseSha,
      status: "succeeded",
      eligible: true,
      behaviorVerification: {
        behaviorContextDigest: valueDigest(
          completeBehaviorContext(arm.registration.treatmentId),
        ),
        verifiedAt: "2026-07-20T18:05:00.000Z",
      },
      workerArtifacts: {
        stdout: retainedArtifact(
          join(arm.paths.runDir, "stdout.log"),
          workerBytes,
        ),
        stderr: emptyArtifact(join(arm.paths.runDir, "stderr.log")),
      },
      worktreeEvidence: {
        baseSha: fixture.baseSha,
        trackedPatch: {
          sizeBytes: 0,
          contentDigest: sha256(Buffer.alloc(0)),
        },
        untracked: [],
        aggregateBytes: 0,
        contentDigest: valueDigest({
          baseSha: fixture.baseSha,
          trackedPatch: {
            sizeBytes: 0,
            contentDigest: sha256(Buffer.alloc(0)),
          },
          untracked: [],
          aggregateBytes: 0,
        }),
      },
      checkResults,
      retry: {
        authorized: false,
        reason: "genuine-result",
        maximumAttempt: 2,
      },
    });
    const accounting = writeReceipt(arm.paths.accounting, {
      schemaVersion: 1,
      kind: "Gate2702Accounting",
      definitionRef: DEFINITION_REF,
      registrationDigest: arm.registration.contentDigest,
      terminalDigest: terminal.contentDigest,
      classificationDigest: classification.contentDigest,
      trialId: fixture.trialId,
      subject,
      treatmentId: arm.registration.treatmentId,
      attempt: 1,
      baseSha: fixture.baseSha,
      ...successfulAccountingFields(
        arm.registration.treatmentId,
        workerBytes,
        sidekickLedger,
      ),
    });
    selectedByTreatment[arm.registration.treatmentId] = {
      ...arm,
      workerResult: workerResult.result,
      preDispatch,
      processReceipt,
      terminal,
      classification,
      accounting,
    };
  }

  writeReceipt(
    join(fixture.trialRoot, "pair-selection", `issue-${subject}.json`),
    {
      schemaVersion: 1,
      kind: "Gate2702PairSelection",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      arms: Object.fromEntries(
        TREATMENTS.map((treatmentId) => {
          const selected = selectedByTreatment[treatmentId];
          return [
            treatmentId,
            {
              treatmentId,
              attempt: 1,
              registrationDigest: selected.registration.contentDigest,
              classificationDigest: selected.classification.contentDigest,
            },
          ];
        }),
      ),
    },
  );
  const judge = writeSuccessfulJudgeEvidence(fixture, selectedByTreatment);
  return { subject, preflight, selectedByTreatment, judge };
}

function promoteTerminalFailurePair(fixture) {
  const promoted = promoteSuccessfulSelectedPair(fixture);
  rmSync(
    join(fixture.trialRoot, "pair-selection", `issue-${promoted.subject}.json`),
  );
  rmSync(join(fixture.trialRoot, "judging"), {
    recursive: true,
    force: true,
  });
  const statuses = {
    "haiku-solo": {
      status: "failed",
      terminal: {
        outcome: "exited",
        exitCode: 1,
        signal: null,
        timedOut: false,
      },
      error: {
        code: "worker-process-failure",
        message: "the preflighted worker process did not complete successfully",
        outcome: "exited",
        exitCode: 1,
        signal: null,
      },
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    },
    "haiku-sonnet-sidekick": {
      status: "cancelled",
      terminal: {
        outcome: "timed-out",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
      },
      error: {
        code: "timeout",
        message: "the C5 worker exceeded its fixed wall-time limit",
      },
      retry: {
        authorized: true,
        reason: "timeout",
        maximumAttempt: 2,
      },
    },
  };
  for (const treatmentId of TREATMENTS) {
    const selected = promoted.selectedByTreatment[treatmentId];
    const desired = statuses[treatmentId];
    rmSync(join(selected.paths.runDir, "checks"), {
      recursive: true,
      force: true,
    });
    const terminal = writeReceipt(selected.paths.terminal, {
      ...selected.terminal,
      ...desired.terminal,
      contentDigest: undefined,
    });
    const classificationBody = {
      ...selected.classification,
      contentDigest: undefined,
      terminalDigest: terminal.contentDigest,
      status: desired.status,
      eligible: false,
      checkResults: [],
      error: desired.error,
      retry: desired.retry,
    };
    delete classificationBody.behaviorVerification;
    delete classificationBody.worktreeEvidence;
    const classification = writeReceipt(
      selected.paths.classification,
      classificationBody,
    );
    writeReceipt(selected.paths.accounting, {
      ...selected.accounting,
      contentDigest: undefined,
      terminalDigest: terminal.contentDigest,
      classificationDigest: classification.contentDigest,
    });
  }
}

function promoteEligibleRetryPair(fixture) {
  const promoted = promoteSuccessfulSelectedPair(fixture);
  const subject = promoted.subject;
  const treatmentId = "haiku-solo";
  const parent = promoted.selectedByTreatment[treatmentId];
  rmSync(join(parent.paths.runDir, "checks"), {
    recursive: true,
    force: true,
  });
  const parentTerminal = writeReceipt(parent.paths.terminal, {
    ...parent.terminal,
    contentDigest: undefined,
    outcome: "exited",
    exitCode: 1,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    durationMs: 240_000,
    endedAt: "2026-07-20T18:05:00.000Z",
  });
  const parentClassification = writeReceipt(parent.paths.classification, {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: parent.registration.contentDigest,
    preflightDigest: promoted.preflight.contentDigest,
    terminalDigest: parentTerminal.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 1,
    baseSha: fixture.baseSha,
    status: "failed",
    eligible: false,
    workerArtifacts: parent.classification.workerArtifacts,
    checkResults: [],
    error: {
      code: "worker-process-failure",
      message: "the preflighted worker process did not complete successfully",
      outcome: "exited",
      exitCode: 1,
      signal: null,
    },
    retry: {
      authorized: true,
      reason: "tooling-artifact",
      maximumAttempt: 2,
    },
  });
  const parentAccounting = writeReceipt(parent.paths.accounting, {
    ...parent.accounting,
    contentDigest: undefined,
    terminalDigest: parentTerminal.contentDigest,
    classificationDigest: parentClassification.contentDigest,
  });
  const retryOf = {
    attempt: 1,
    registrationDigest: parent.registration.contentDigest,
    classificationDigest: parentClassification.contentDigest,
  };

  rmSync(join(fixture.trialRoot, "pair-selection", `issue-${subject}.json`), {
    force: true,
  });
  rmSync(join(fixture.trialRoot, "judging"), {
    recursive: true,
    force: true,
  });

  const paths = armPaths(fixture.trialRoot, subject, treatmentId, 2);
  const worktreePath = join(
    fixture.trialRoot,
    "worktrees",
    `issue-${subject}.${treatmentId}.attempt-2`,
  );
  const gitDirectory = createWorktree(
    fixture.repository,
    fixture.baseSha,
    worktreePath,
  );
  const registration = writeReceipt(paths.registration, {
    schemaVersion: 1,
    kind: "Gate2702ArmRegistration",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject,
    subjectRef: `github:shpwrck/claude-history-dashboard#${subject}`,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    executionMode: "production",
    runDir: paths.runDir,
    worktreePath,
    retryOf,
  });
  const identity = writeReceipt(paths.identity, {
    schemaVersion: 1,
    kind: "Gate2702WorktreeIdentity",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    executionMode: "production",
    worktreePath,
    gitDirectory,
    identityToken: randomUUID(),
    createdAt: "2026-07-20T18:06:00.000Z",
  });
  const install = writeSuccessfulInstallEvidence(registration);
  const environment = promoted.preflight.environment;
  const environmentDigest = promoted.preflight.environmentDigest;
  const behaviorContext = {
    ...completeBehaviorContext(treatmentId),
    observedAt: "2026-07-20T18:06:00.000Z",
  };
  const preflight = writeReceipt(join(paths.runDir, "preflight.json"), {
    schemaVersion: 1,
    kind: "Gate2702RetryPreflight",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    status: "passed",
    install: install.execution,
    behaviorContext,
    sidekick: sidekickPreflightEvidence(treatmentId),
    environment,
    environmentProbes: completeEnvironmentProbes(environment),
    environmentDigest,
  });
  const sessionId = randomUUID();
  const workerResult = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    total_cost_usd: 1.2,
    result: "bounded successful retry fixture result",
  };
  const workerBytes = Buffer.from(`${JSON.stringify(workerResult)}\n`, "utf8");
  writeFileSync(join(paths.runDir, "stdout.log"), workerBytes);
  writeFileSync(join(paths.runDir, "stderr.log"), "", "utf8");
  const snapshot = readJson(
    join(fixture.trialRoot, "subjects", `issue-${subject}.json`),
  );
  const preDispatch = writeReceipt(join(paths.runDir, "pre-dispatch.json"), {
    schemaVersion: 1,
    kind: "Gate2702PreDispatch",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    worktreeIdentityDigest: identity.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    executionMode: "production",
    argv: FIXED_WORKER_ARGV,
    sidekickEnvironment: sidekickEnvironment(treatmentId),
    sidekickEnvironmentDigest: valueDigest(sidekickEnvironment(treatmentId)),
    cwd: worktreePath,
    promptDigest: sha256(Buffer.from(workerPrompt(snapshot, registration))),
    startedAt: "2026-07-20T18:07:00.000Z",
  });
  const processReceipt = writeReceipt(join(paths.runDir, "process.json"), {
    schemaVersion: 1,
    kind: "Gate2702Process",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    pid: 44_002,
    detachedProcessGroup: true,
    startedAt: "2026-07-20T18:07:00.000Z",
  });
  const terminal = writeReceipt(paths.terminal, {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    preflightDigest: preflight.contentDigest,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    outcome: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    durationMs: 60_000,
    endedAt: "2026-07-20T18:08:00.000Z",
  });
  const retryArm = { paths, registration };
  const checkResults = writeSuccessfulCheckEvidence(
    retryArm,
    environment,
    environmentDigest,
    "18:09",
  );
  const worktreeEvidenceBody = {
    baseSha: fixture.baseSha,
    trackedPatch: {
      sizeBytes: 0,
      contentDigest: sha256(Buffer.alloc(0)),
    },
    untracked: [],
    aggregateBytes: 0,
  };
  const classification = writeReceipt(paths.classification, {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preflightDigest: preflight.contentDigest,
    terminalDigest: terminal.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    status: "succeeded",
    eligible: true,
    behaviorVerification: {
      behaviorContextDigest: valueDigest(behaviorContext),
      verifiedAt: "2026-07-20T18:08:00.000Z",
    },
    workerArtifacts: {
      stdout: retainedArtifact(join(paths.runDir, "stdout.log"), workerBytes),
      stderr: emptyArtifact(join(paths.runDir, "stderr.log")),
    },
    worktreeEvidence: {
      ...worktreeEvidenceBody,
      contentDigest: valueDigest(worktreeEvidenceBody),
    },
    checkResults,
    retry: {
      authorized: false,
      reason: "genuine-result",
      maximumAttempt: 2,
    },
  });
  const retryManifest = [
    {
      subject,
      treatmentId,
      attempt: 2,
      registrationDigest: registration.contentDigest,
      retryOf,
      worktreePath,
    },
  ];
  const registrationSetDigest = valueDigest(retryManifest);
  const retrySet = writeReceipt(
    join(
      fixture.trialRoot,
      "retries",
      "sets",
      `${registrationSetDigest.replace(":", "-")}.json`,
    ),
    {
      schemaVersion: 1,
      kind: "Gate2702RetryRegistrationSet",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      baseSha: fixture.baseSha,
      registrationSetDigest,
      registrations: retryManifest,
    },
  );
  const accounting = writeReceipt(paths.accounting, {
    schemaVersion: 1,
    kind: "Gate2702Accounting",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    terminalDigest: terminal.contentDigest,
    classificationDigest: classification.contentDigest,
    trialId: fixture.trialId,
    subject,
    treatmentId,
    attempt: 2,
    baseSha: fixture.baseSha,
    retryOf,
    retryRegistrationSetDigest: registrationSetDigest,
    retryRegistrationSetReceiptDigest: retrySet.contentDigest,
    ...successfulAccountingFields(treatmentId, workerBytes, Buffer.alloc(0)),
  });
  const retry = {
    paths,
    registration,
    identity,
    preflight,
    preDispatch,
    processReceipt,
    terminal,
    classification,
    accounting,
    workerResult: workerResult.result,
  };
  fixture.evidence.push(retry);

  writeReceipt(
    join(fixture.trialRoot, "pair-selection", `issue-${subject}.json`),
    {
      schemaVersion: 1,
      kind: "Gate2702PairSelection",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject,
      baseSha: fixture.baseSha,
      arms: {
        "haiku-solo": {
          treatmentId: "haiku-solo",
          attempt: 2,
          registrationDigest: registration.contentDigest,
          classificationDigest: classification.contentDigest,
        },
        "haiku-sonnet-sidekick": {
          treatmentId: "haiku-sonnet-sidekick",
          attempt: 1,
          registrationDigest:
            promoted.selectedByTreatment["haiku-sonnet-sidekick"].registration
              .contentDigest,
          classificationDigest:
            promoted.selectedByTreatment["haiku-sonnet-sidekick"].classification
              .contentDigest,
        },
      },
    },
  );
  const judge = writeSuccessfulJudgeEvidence(fixture, {
    "haiku-solo": retry,
    "haiku-sonnet-sidekick":
      promoted.selectedByTreatment["haiku-sonnet-sidekick"],
  });
  return {
    parent: {
      ...parent,
      terminal: parentTerminal,
      classification: parentClassification,
      accounting: parentAccounting,
    },
    retry,
    judge,
  };
}

function markerAndManifest(fixture) {
  const marker = readJson(fixture.markerPath);
  const bundleRoot = join(fixture.trialRoot, "seal", marker.bundleDirectory);
  const manifestPath = join(bundleRoot, "manifest.json");
  return {
    marker,
    bundleRoot,
    manifestPath,
    manifest: readJson(manifestPath),
  };
}

function bundleBytes(bundleRoot) {
  return new Map(
    [
      "manifest.json",
      ...readdirSync(join(bundleRoot, "objects"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join("objects", entry.name))
        .sort(),
    ].map((path) => [path, readFileSync(join(bundleRoot, path))]),
  );
}

function objectBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function artifactFor(sourcePath, bytes) {
  const contentDigest = sha256(bytes);
  return {
    sourcePath,
    contentDigest,
    sizeBytes: bytes.length,
    mediaType: "application/json",
    objectName: contentDigest.replace(":", "-"),
  };
}

function publishReplacementBundle(
  fixture,
  manifestInput,
  extraObjects,
  markerOverrides = {},
) {
  const current = markerAndManifest(fixture);
  const manifest = withDigest({ ...manifestInput, contentDigest: undefined });
  const bundleRoot = join(
    fixture.trialRoot,
    "seal",
    "bundles",
    manifest.contentDigest.replace(":", "-"),
  );
  rmSync(bundleRoot, { recursive: true, force: true });
  mkdirSync(bundleRoot, { recursive: true });
  cpSync(join(current.bundleRoot, "objects"), join(bundleRoot, "objects"), {
    recursive: true,
  });
  for (const [objectName, bytes] of extraObjects) {
    writeFileSync(join(bundleRoot, "objects", objectName), bytes);
  }
  writeFileSync(
    join(bundleRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const marker = withDigest({
    ...current.marker,
    contentDigest: undefined,
    bundleDigest: manifest.contentDigest,
    bundleManifestDigest: manifest.contentDigest,
    bundleDirectory: join("bundles", manifest.contentDigest.replace(":", "-")),
    ...markerOverrides,
  });
  writeFileSync(
    fixture.markerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  return { marker, manifest, bundleRoot };
}

function tamperRecordedWorktreeRootAndRepublish(fixture) {
  const current = markerAndManifest(fixture);
  const existing = current.manifest.artifacts.find(
    (entry) => entry.sourcePath === "trial.json",
  );
  assert.ok(existing);
  const trial = readJson(
    join(current.bundleRoot, "objects", existing.objectName),
  );
  const tampered = withDigest({
    ...trial,
    contentDigest: undefined,
    worktreeRoot: join(trial.stateRoot, "unbound-worktrees"),
  });
  const bytes = objectBytes(tampered);
  const replacement = artifactFor("trial.json", bytes);
  const artifacts = current.manifest.artifacts
    .map((entry) => (entry.sourcePath === "trial.json" ? replacement : entry))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const published = publishReplacementBundle(
    fixture,
    {
      ...current.manifest,
      contentDigest: undefined,
      trialDigest: tampered.contentDigest,
      artifacts,
    },
    new Map([[replacement.objectName, bytes]]),
    { trialDigest: tampered.contentDigest },
  );
  if (
    existing.objectName !== replacement.objectName &&
    !artifacts.some((entry) => entry.objectName === existing.objectName)
  ) {
    rmSync(join(published.bundleRoot, "objects", existing.objectName));
  }
}

function tamperAccountingAllInAndRepublish(
  fixture,
  treatmentId,
  allInCostUsd,
) {
  const current = markerAndManifest(fixture);
  const sourcePath = `runs/issue-${SUBJECTS[0]}/${treatmentId}/attempt-1/accounting.json`;
  const existing = current.manifest.artifacts.find(
    (entry) => entry.sourcePath === sourcePath,
  );
  assert.ok(existing);
  const accounting = readJson(
    join(current.bundleRoot, "objects", existing.objectName),
  );
  const tampered = withDigest({
    ...accounting,
    contentDigest: undefined,
    allInCostUsd,
  });
  const bytes = objectBytes(tampered);
  const replacement = artifactFor(sourcePath, bytes);
  const artifacts = current.manifest.artifacts
    .map((entry) => (entry.sourcePath === sourcePath ? replacement : entry))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const runCandidates = current.manifest.runCandidates.map((candidate) =>
    candidate.subject === SUBJECTS[0] &&
    candidate.treatmentId === treatmentId &&
    candidate.attempt === 1
      ? { ...candidate, accountingDigest: tampered.contentDigest }
      : candidate,
  );
  const published = publishReplacementBundle(
    fixture,
    {
      ...current.manifest,
      contentDigest: undefined,
      artifacts,
      runCandidates,
    },
    new Map([[replacement.objectName, bytes]]),
  );
  if (
    existing.objectName !== replacement.objectName &&
    !artifacts.some((entry) => entry.objectName === existing.objectName)
  ) {
    rmSync(join(published.bundleRoot, "objects", existing.objectName));
  }
}

function score(value) {
  return {
    correctness: value,
    design: value,
    completeness: value,
    clarity: value,
    scopeFit: value,
    autonomy: value,
  };
}

function judgeResponse(winner) {
  return {
    winner,
    rationale: "The retained fixture response is internally consistent.",
    scores: { A: score(8), B: score(7) },
  };
}

function judgeOutcome({
  trialId,
  subject,
  order,
  response,
  baseSha,
  requests,
  preDispatch,
  processReceipt,
  gate,
}) {
  const stdout = Buffer.from(
    JSON.stringify({ total_cost_usd: 0.1, structured_output: response }),
    "utf8",
  );
  return withDigest({
    schemaVersion: 1,
    kind: "Gate2702JudgeOutcome",
    definitionRef: DEFINITION_REF,
    trialId,
    subject,
    baseSha,
    executionMode: "production",
    requestSetDigest: requests.contentDigest,
    payloadDigest: requests.requests[order].payloadDigest,
    order,
    attempt: 1,
    dispatchToken: preDispatch.dispatchToken,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    gateDigest: gate.contentDigest,
    startedAt: "2026-07-20T18:06:00.030Z",
    endedAt: "2026-07-20T18:06:01.030Z",
    startedMonotonicNs: "1000000",
    endedMonotonicNs: "1001000",
    durationMs: 1,
    spawnError: null,
    timedOut: false,
    exitCode: 0,
    signal: null,
    stdout: {
      encoding: "base64",
      bytes: stdout.toString("base64"),
      capturedBytes: stdout.length,
      totalBytes: stdout.length,
      contentDigest: sha256(stdout),
      truncated: false,
    },
    stderr: {
      encoding: "base64",
      bytes: "",
      capturedBytes: 0,
      totalBytes: 0,
      contentDigest: sha256(Buffer.alloc(0)),
      truncated: false,
    },
  });
}

function tamperJudgeResultAndRepublish(fixture) {
  const current = markerAndManifest(fixture);
  const sourcePath = `judging/issue-${SUBJECTS[0]}/result.json`;
  const existing = current.manifest.artifacts.find(
    (entry) => entry.sourcePath === sourcePath,
  );
  assert.ok(existing);
  const result = readJson(
    join(current.bundleRoot, "objects", existing.objectName),
  );
  const tampered = withDigest({
    ...result,
    contentDigest: undefined,
    effectiveWinner: "haiku-sonnet-sidekick",
  });
  const bytes = objectBytes(tampered);
  const replacement = artifactFor(sourcePath, bytes);
  const artifacts = current.manifest.artifacts
    .map((entry) => (entry.sourcePath === sourcePath ? replacement : entry))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const published = publishReplacementBundle(
    fixture,
    {
      ...current.manifest,
      contentDigest: undefined,
      artifacts,
      judgeResults: [
        {
          subject: SUBJECTS[0],
          contentDigest: tampered.contentDigest,
        },
      ],
    },
    new Map([[replacement.objectName, bytes]]),
  );
  if (existing.objectName !== replacement.objectName) {
    rmSync(join(published.bundleRoot, "objects", existing.objectName));
  }
  return published;
}

function tamperCanonicalRunAndRepublish(fixture) {
  const current = markerAndManifest(fixture);
  const runEntry = current.manifest.canonicalRuns[0];
  assert.ok(runEntry);
  const existing = current.manifest.artifacts.find(
    (entry) => entry.sourcePath === runEntry.sourcePath,
  );
  assert.ok(existing);
  const run = readJson(
    join(current.bundleRoot, "objects", existing.objectName),
  );
  const tampered = withDigest({
    ...run,
    contentDigest: undefined,
    subjectRef: {
      ...run.subjectRef,
      sourceId: "github:coherently-redigested/false-source",
    },
  });
  const bytes = Buffer.from(`${canonicalJson(tampered)}\n`, "utf8");
  const replacement = artifactFor(runEntry.sourcePath, bytes);
  const artifacts = current.manifest.artifacts
    .map((entry) =>
      entry.sourcePath === runEntry.sourcePath ? replacement : entry,
    )
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const canonicalRuns = current.manifest.canonicalRuns.map((entry) =>
    entry.runId === runEntry.runId
      ? {
          ...entry,
          objectDigest: replacement.contentDigest,
          contentDigest: tampered.contentDigest,
        }
      : entry,
  );
  const runCandidates = current.manifest.runCandidates.map((candidate) =>
    candidate.runId === runEntry.runId
      ? { ...candidate, runDigest: tampered.contentDigest }
      : candidate,
  );
  const published = publishReplacementBundle(
    fixture,
    {
      ...current.manifest,
      contentDigest: undefined,
      artifacts,
      canonicalRuns,
      runCandidates,
    },
    new Map([[replacement.objectName, bytes]]),
  );
  if (
    existing.objectName !== replacement.objectName &&
    !artifacts.some((entry) => entry.objectName === existing.objectName)
  ) {
    rmSync(join(published.bundleRoot, "objects", existing.objectName));
  }
  return published;
}

function omitCanonicalRunAndRepublish(fixture) {
  const current = markerAndManifest(fixture);
  const omitted = current.manifest.canonicalRuns[0];
  assert.ok(omitted);
  const omittedArtifact = current.manifest.artifacts.find(
    (entry) => entry.sourcePath === omitted.sourcePath,
  );
  assert.ok(omittedArtifact);
  const runCandidates = current.manifest.runCandidates.map((candidate) => {
    if (candidate.runId !== omitted.runId) return candidate;
    const revised = { ...candidate };
    delete revised.runId;
    delete revised.runDigest;
    revised.exclusion = "selected-pair-judge-unavailable";
    return revised;
  });
  const artifacts = current.manifest.artifacts.filter(
    (entry) => entry.sourcePath !== omitted.sourcePath,
  );
  const published = publishReplacementBundle(
    fixture,
    {
      ...current.manifest,
      contentDigest: undefined,
      artifacts,
      runCandidates,
      canonicalRuns: current.manifest.canonicalRuns.filter(
        (entry) => entry.runId !== omitted.runId,
      ),
    },
    new Map(),
  );
  if (
    !artifacts.some((entry) => entry.objectName === omittedArtifact.objectName)
  ) {
    rmSync(join(published.bundleRoot, "objects", omittedArtifact.objectName));
  }
  return published;
}

test("the C5 sealer is inert until explicitly enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-seal-disabled-"));
  const stateRoot = join(root, "must-not-exist");
  const env = { ...process.env };
  delete env.CHD_EXPERIMENT_2702;
  try {
    const result = spawnSync(
      process.execPath,
      [SEALER, "seal", "--trial", "not-a-trial", "--state-root", stateRoot],
      { env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /opt-in|explicit C5/i);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown C5 arms are excluded and any retained-byte tamper invalidates the seal", async () => {
  const fixture = createFixture();
  try {
    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.deepEqual(sealed, {
      trialId: fixture.trialId,
      state: "verified",
      bundleDigest: sealed.bundleDigest,
      runCount: 0,
      excludedRunCount: 12,
    });
    assert.match(sealed.bundleDigest, /^sha256:[0-9a-f]{64}$/);

    const { bundleRoot, manifest } = markerAndManifest(fixture);
    assert.equal(manifest.registrationCount, 12);
    assert.equal(manifest.runCandidates.length, 12);
    assert.ok(
      manifest.runCandidates.every(
        (candidate) =>
          candidate.exclusion === "complete-behavior-fingerprint-unavailable",
      ),
    );
    const postSealPath = join(
      fixture.evidence[0].registration.worktreePath,
      "post-seal-drift.txt",
    );
    writeFileSync(postSealPath, "must not be deleted without resealing\n");
    await assert.rejects(
      verifyTrial(fixture.options),
      /worktree changed after evidence sealing/i,
    );
    rmSync(postSealPath);
    assert.equal((await verifyTrial(fixture.options)).state, "verified");

    const trialArtifact = manifest.artifacts.find(
      (entry) => entry.sourcePath === "trial.json",
    );
    assert.ok(trialArtifact);
    writeFileSync(
      join(bundleRoot, "objects", trialArtifact.objectName),
      Buffer.concat([
        readFileSync(join(bundleRoot, "objects", trialArtifact.objectName)),
        Buffer.from(" "),
      ]),
    );
    await assert.rejects(
      verifyTrial(fixture.options),
      /content verification|failed content/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cleanup authority requires a self-contained non-symlink object directory", async () => {
  const fixture = createFixture();
  try {
    await sealTrial(fixture.options, fixture.dependencies);
    const { bundleRoot } = markerAndManifest(fixture);
    const objectsRoot = join(bundleRoot, "objects");
    const externalObjects = join(fixture.root, "external-seal-objects");
    renameSync(objectsRoot, externalObjects);
    symlinkSync(externalObjects, objectsRoot, "dir");
    await assert.rejects(
      verifyTrial(fixture.options),
      /self-contained directory/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("relocation support still rejects internally inconsistent recorded launcher paths", async () => {
  const fixture = createFixture();
  try {
    await sealTrial(fixture.options, fixture.dependencies);
    tamperRecordedWorktreeRootAndRepublish(fixture);

    await assert.rejects(
      verifyTrial(fixture.options),
      /exact production C5 launcher manifest/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("the production runtime bundle verifies sealed C5 evidence after state-root relocation", async () => {
  const fixture = createFixture();
  const relocatedStateRoot = join(fixture.root, "consumer-state");
  const runtimeBundle = join(fixture.root, "runtime-verifier.bundle.mjs");
  try {
    await sealTrial(fixture.options, fixture.dependencies);
    await evaluateTrial(fixture.options);
    await buildGate2702Runtime({ outputFile: runtimeBundle });
    renameSync(fixture.stateRoot, relocatedStateRoot);

    const runtime = await import(
      `${pathToFileURL(runtimeBundle).href}?test=${randomUUID()}`
    );
    const loaded = await runtime.loadCurrentEvaluation({
      trial: fixture.trialId,
      stateRoot: relocatedStateRoot,
    });

    assert.equal(loaded.marker.trialId, fixture.trialId);
    assert.equal(loaded.evaluation.kind, "Gate2702InsufficientEvidence");
  } finally {
    fixture.cleanup();
  }
});

test("a successful selected C5 pair emits strict canonical v1 Runs that verify", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    promoteSuccessfulSelectedPair(fixture);
    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.runCount, 2);
    assert.equal(sealed.excludedRunCount, 10);

    const { bundleRoot, manifest } = markerAndManifest(fixture);
    const markerBeforeReseal = readFileSync(fixture.markerPath);
    const bundleBeforeReseal = bundleBytes(bundleRoot);
    assert.deepEqual(
      await sealTrial(fixture.options, fixture.dependencies),
      sealed,
    );
    assert.deepEqual(readFileSync(fixture.markerPath), markerBeforeReseal);
    assert.deepEqual(bundleBytes(bundleRoot), bundleBeforeReseal);
    assert.equal(manifest.canonicalRuns.length, 2);
    assert.equal(manifest.selectionBindings.length, 2);
    assert.equal(
      manifest.runCandidates.filter((candidate) => candidate.runId).length,
      2,
    );
    assert.ok(
      manifest.runCandidates.every((candidate) =>
        ["succeeded", "failed", "cancelled"].includes(candidate.status),
      ),
    );
    const runs = manifest.canonicalRuns.map((entry) => {
      const artifact = manifest.artifacts.find(
        (candidate) => candidate.sourcePath === entry.sourcePath,
      );
      assert.ok(artifact);
      const run = readJson(join(bundleRoot, "objects", artifact.objectName));
      assert.equal(run.kind, "ExperimentRun");
      assert.equal(run.schemaVersion, 1);
      assert.equal(run.status, "succeeded");
      assert.equal(run.contentDigest, entry.contentDigest);
      assert.equal(run.retryOf, null);
      assert.equal(run.assignment.kind, "explicit");
      assert.equal(run.behaviorFingerprint.completeness, "complete");
      assert.equal(run.behaviorFingerprint.factors.length, 14);
      assert.equal(run.checkResults.length, 2);
      assert.equal(run.observations.length, 7);
      assert.match(run.selectionRef.receiptId, /^[0-9a-f-]{36}$/i);
      return run;
    });
    assert.deepEqual(
      runs.map((run) => run.treatmentId).sort(),
      [...TREATMENTS].sort(),
    );

    const loaded = await loadVerifiedTrial(fixture.options);
    assert.equal(loaded.definition.definitionId, DEFINITION_REF.definitionId);
    assert.ok(loaded.registry.semantics.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(loaded.runs)), runs);
    assert.deepEqual(loaded.manifest, manifest);
    assert.equal(loaded.marker.bundleDigest, manifest.contentDigest);
    assert.deepEqual(await verifyTrial(fixture.options), sealed);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("normalized C5 currency seals when raw floating-point addition differs by machine epsilon", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    const promoted = promoteSuccessfulSelectedPair(fixture, {
      treatmentWorkerCostUsd: 0.9544985000000001,
      sidekickCostUsd: 0.617274,
    });
    const accounting =
      promoted.selectedByTreatment["haiku-sonnet-sidekick"].accounting;
    assert.equal(accounting.allInCostUsd, 1.5717725);
    assert.notEqual(
      accounting.allInCostUsd,
      accounting.workerCostUsd + accounting.sidekickCostUsd,
    );

    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.state, "verified");
    assert.deepEqual(await verifyTrial(fixture.options), sealed);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("C5 control currency preserves exact worker decimals while treatment currency normalizes", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    const promoted = promoteSuccessfulSelectedPair(fixture, {
      controlWorkerCostUsd: 0.7123344000000003,
      treatmentWorkerCostUsd: 0.9544985000000001,
      sidekickCostUsd: 0.617274,
    });
    const control = promoted.selectedByTreatment["haiku-solo"].accounting;
    const treatment =
      promoted.selectedByTreatment["haiku-sonnet-sidekick"].accounting;
    assert.equal(control.allInCostUsd, control.workerCostUsd);
    assert.equal(control.allInCostUsd, 0.7123344000000003);
    assert.equal(treatment.allInCostUsd, 1.5717725);
    assert.notEqual(
      treatment.allInCostUsd,
      treatment.workerCostUsd + treatment.sidekickCostUsd,
    );

    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.state, "verified");
    assert.deepEqual(await verifyTrial(fixture.options), sealed);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("C5 sealing rejects coherently re-digested all-in cost derivation drift", async () => {
  const cases = [
    {
      treatmentId: "haiku-solo",
      tamperedAllInCostUsd: 0.7123344,
    },
    {
      treatmentId: "haiku-sonnet-sidekick",
      tamperedAllInCostUsd: 0.9544985000000001 + 0.617274,
    },
  ];
  for (const { treatmentId, tamperedAllInCostUsd } of cases) {
    const fixture = createFixture();
    const previousHome = process.env.HOME;
    process.env.HOME = fixture.home;
    try {
      promoteSuccessfulSelectedPair(fixture, {
        controlWorkerCostUsd: 0.7123344000000003,
        treatmentWorkerCostUsd: 0.9544985000000001,
        sidekickCostUsd: 0.617274,
      });
      await sealTrial(fixture.options, fixture.dependencies);
      tamperAccountingAllInAndRepublish(
        fixture,
        treatmentId,
        tamperedAllInCostUsd,
      );
      await assert.rejects(
        verifyTrial(fixture.options),
        /sealed accounting all-in cost does not rederive/i,
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fixture.cleanup();
    }
  }
});

test("failed and cancelled C5 arms also emit strict canonical v1 Runs", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    promoteTerminalFailurePair(fixture);
    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.runCount, 2);
    assert.equal(sealed.excludedRunCount, 10);

    const { bundleRoot, manifest } = markerAndManifest(fixture);
    const runs = manifest.canonicalRuns.map((entry) => {
      const artifact = manifest.artifacts.find(
        (candidate) => candidate.sourcePath === entry.sourcePath,
      );
      assert.ok(artifact);
      return readJson(join(bundleRoot, "objects", artifact.objectName));
    });
    assert.deepEqual(runs.map((run) => run.status).sort(), [
      "cancelled",
      "failed",
    ]);
    for (const run of runs) {
      assert.equal(run.observations.length, 0);
      assert.equal(run.checkResults.length, 0);
      assert.match(run.error.code, /^gate-2702\//);
      assert.equal(run.error.evidenceRefs.length, 1);
    }
    assert.deepEqual(await verifyTrial(fixture.options), sealed);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("the verifier re-judges retained attempts instead of trusting a re-digested result", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    promoteSuccessfulSelectedPair(fixture);
    await sealTrial(fixture.options, fixture.dependencies);
    for (const arm of fixture.evidence) {
      git(fixture.repository, [
        "worktree",
        "remove",
        "--force",
        arm.registration.worktreePath,
      ]);
    }
    const verified = await verifyTrial(fixture.options);
    assert.equal(verified.state, "verified");

    // This is not a checksum-only mutation: every changed receipt, object,
    // manifest, directory name, and marker is re-digested consistently.
    tamperJudgeResultAndRepublish(fixture);
    await assert.rejects(
      verifyTrial(fixture.options),
      /judge result (?:does not match its frozen evidence|does not rederive from retained attempts)/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("a coherently re-digested canonical Run must exactly rederive from sealed evidence", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    promoteSuccessfulSelectedPair(fixture);
    await sealTrial(fixture.options, fixture.dependencies);
    tamperCanonicalRunAndRepublish(fixture);
    await assert.rejects(
      verifyTrial(fixture.options),
      /canonical Run does not exactly rederive from sealed evidence/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("a re-digested bundle cannot turn an included Run into an exclusion", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    promoteSuccessfulSelectedPair(fixture);
    await sealTrial(fixture.options, fixture.dependencies);
    for (const arm of fixture.evidence) {
      git(fixture.repository, [
        "worktree",
        "remove",
        "--force",
        arm.registration.worktreePath,
      ]);
    }
    omitCanonicalRunAndRepublish(fixture);
    await assert.rejects(
      verifyTrial(fixture.options),
      /candidate disposition does not rederive/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("an eligible retry Run preserves its canonical attempt-1 parent", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    const promoted = promoteEligibleRetryPair(fixture);
    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.runCount, 3);
    assert.equal(sealed.excludedRunCount, 10);
    const loaded = await loadVerifiedTrial(fixture.options);
    const parentCandidate = loaded.manifest.runCandidates.find(
      (candidate) =>
        candidate.registrationDigest ===
        promoted.parent.registration.contentDigest,
    );
    const retryCandidate = loaded.manifest.runCandidates.find(
      (candidate) =>
        candidate.registrationDigest ===
        promoted.retry.registration.contentDigest,
    );
    assert.ok(parentCandidate?.runId);
    assert.ok(retryCandidate?.runId);
    const parentRun = loaded.runs.find(
      (run) => run.runId === parentCandidate.runId,
    );
    const retryRun = loaded.runs.find(
      (run) => run.runId === retryCandidate.runId,
    );
    assert.equal(parentRun.status, "failed");
    assert.equal(retryRun.status, "succeeded");
    assert.deepEqual(JSON.parse(JSON.stringify(retryRun.retryOf)), {
      runId: parentRun.runId,
      contentDigest: parentRun.contentDigest,
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test("a retry is sealed only with its exact attempt-1 lineage and retry-set binding", async () => {
  const fixture = createFixture({ includeRetry: true });
  try {
    const sealed = await sealTrial(fixture.options, fixture.dependencies);
    assert.equal(sealed.runCount, 0);
    assert.equal(sealed.excludedRunCount, 13);
    const { marker, manifest } = markerAndManifest(fixture);
    assert.equal(
      marker.retryRegistrationSetDigest,
      fixture.retry.registrationSetDigest,
    );
    assert.equal(manifest.registrationCount, 13);
    const retryCandidate = manifest.runCandidates.find(
      (candidate) => candidate.attempt === 2,
    );
    assert.deepEqual(
      {
        subject: retryCandidate.subject,
        treatmentId: retryCandidate.treatmentId,
        attempt: retryCandidate.attempt,
        registrationDigest: retryCandidate.registrationDigest,
      },
      {
        subject: SUBJECTS[0],
        treatmentId: TREATMENTS[0],
        attempt: 2,
        registrationDigest: fixture.retry.registration.contentDigest,
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("crashing after bundle publication never publishes cleanup authority", () => {
  const fixture = createFixture();
  const helper = join(fixture.root, "seal-child.mjs");
  writeFileSync(
    helper,
    `import { readFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { sealTrial } from ${JSON.stringify(pathToFileURL(SEALER).href)};\n` +
      `const read = (path) => JSON.parse(readFileSync(path, "utf8"));\n` +
      `const dependencies = {\n` +
      `  classification(_options, registration) { return read(join(registration.runDir, "classification.json")); },\n` +
      `  accounting(_options, registration) { return read(join(registration.runDir, "accounting.json")); },\n` +
      `  judge() { throw new Error("unexpected judge"); },\n` +
      `};\n` +
      `const result = await sealTrial({ trial: process.env.TRIAL_ID, stateRoot: process.env.STATE_ROOT }, dependencies);\n` +
      `process.stdout.write(JSON.stringify(result) + "\\n");\n`,
    "utf8",
  );
  const env = {
    ...process.env,
    TRIAL_ID: fixture.trialId,
    STATE_ROOT: fixture.stateRoot,
    NODE_ENV: "test",
    CHD_EXPERIMENT_2702_SEAL_TEST_CRASH_STAGE: "after-bundle",
  };
  try {
    const crashed = spawnSync(process.execPath, [helper], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(crashed.status, 86, crashed.stderr);
    assert.equal(existsSync(fixture.markerPath), false);
    const bundles = join(fixture.trialRoot, "seal", "bundles");
    assert.equal(existsSync(bundles), true);

    const recovered = spawnSync(process.execPath, [helper], {
      env: {
        ...env,
        CHD_EXPERIMENT_2702_SEAL_TEST_CRASH_STAGE: "",
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).state, "verified");
    assert.equal(existsSync(fixture.markerPath), true);
  } finally {
    fixture.cleanup();
  }
});

test("production sealing rejects test provenance and fake worker or judge commands", async () => {
  const fixture = createFixture();
  try {
    writeReceipt(fixture.trialPath, {
      ...fixture.trial,
      contentDigest: undefined,
      executionMode: "test",
    });
    await assert.rejects(
      sealTrial(fixture.options, fixture.dependencies),
      /exact production C5 launcher manifest/i,
    );
    writeFileSync(
      fixture.trialPath,
      `${JSON.stringify(fixture.trial, null, 2)}\n`,
      "utf8",
    );

    const arm = fixture.evidence[0];
    const preDispatch = writeReceipt(
      join(arm.paths.runDir, "pre-dispatch.json"),
      {
        schemaVersion: 1,
        kind: "Gate2702PreDispatch",
        definitionRef: DEFINITION_REF,
        registrationDigest: arm.registration.contentDigest,
        trialId: fixture.trialId,
        subject: arm.registration.subject,
        treatmentId: arm.registration.treatmentId,
        attempt: 1,
        baseSha: fixture.baseSha,
        executionMode: "production",
        argv: ["node", "fake-worker.mjs"],
        cwd: arm.registration.worktreePath,
        startedAt: "2026-07-20T18:00:30.000Z",
      },
    );
    const terminal = writeReceipt(arm.paths.terminal, {
      ...arm.terminal,
      contentDigest: undefined,
      preDispatchDigest: preDispatch.contentDigest,
      outcome: "exited",
      exitCode: 0,
      durationMs: 1_000,
    });
    const classification = writeReceipt(arm.paths.classification, {
      ...arm.classification,
      contentDigest: undefined,
      terminalDigest: terminal.contentDigest,
    });
    writeReceipt(arm.paths.accounting, {
      ...arm.accounting,
      contentDigest: undefined,
      terminalDigest: terminal.contentDigest,
      classificationDigest: classification.contentDigest,
    });
    await assert.rejects(
      sealTrial(fixture.options, fixture.dependencies),
      /refuses test-mode or non-registered worker argv/i,
    );

    rmSync(join(arm.paths.runDir, "pre-dispatch.json"));
    writeFileSync(
      arm.paths.terminal,
      `${JSON.stringify(arm.terminal, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      arm.paths.classification,
      `${JSON.stringify(arm.classification, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      arm.paths.accounting,
      `${JSON.stringify(arm.accounting, null, 2)}\n`,
      "utf8",
    );

    const tooManyRoot = join(
      arm.registration.worktreePath,
      "too-many-untracked-artifacts",
    );
    mkdirSync(tooManyRoot);
    for (let index = 0; index < 1_024; index += 1) {
      writeFileSync(
        join(tooManyRoot, `${String(index).padStart(4, "0")}.txt`),
        "",
      );
    }
    await assert.rejects(
      sealTrial(fixture.options, fixture.dependencies),
      /artifact-count bound/i,
    );
    rmSync(tooManyRoot, { recursive: true });

    const tooLargePath = join(
      arm.registration.worktreePath,
      "too-large-untracked-artifact.bin",
    );
    writeFileSync(tooLargePath, "");
    truncateSync(tooLargePath, 64 * 1024 * 1024 + 1);
    await assert.rejects(
      sealTrial(fixture.options, fixture.dependencies),
      /aggregate byte bound/i,
    );
    rmSync(tooLargePath);

    const selectedArms = fixture.evidence.filter(
      (entry) => entry.registration.subject === SUBJECTS[0],
    );
    const pointers = {};
    for (const selectedArm of selectedArms) {
      const selectedClassification = writeReceipt(
        selectedArm.paths.classification,
        {
          ...selectedArm.classification,
          contentDigest: undefined,
          status: "succeeded",
          eligible: true,
          error: undefined,
          retry: {
            authorized: false,
            reason: "genuine-result",
            maximumAttempt: 2,
          },
        },
      );
      writeReceipt(selectedArm.paths.accounting, {
        ...selectedArm.accounting,
        contentDigest: undefined,
        classificationDigest: selectedClassification.contentDigest,
      });
      pointers[selectedArm.registration.treatmentId] = {
        treatmentId: selectedArm.registration.treatmentId,
        attempt: 1,
        registrationDigest: selectedArm.registration.contentDigest,
        classificationDigest: selectedClassification.contentDigest,
      };
    }
    writeReceipt(
      join(fixture.trialRoot, "pair-selection", `issue-${SUBJECTS[0]}.json`),
      {
        schemaVersion: 1,
        kind: "Gate2702PairSelection",
        definitionRef: DEFINITION_REF,
        trialId: fixture.trialId,
        subject: SUBJECTS[0],
        baseSha: fixture.baseSha,
        arms: pointers,
      },
    );
    const judgeRoot = join(
      fixture.trialRoot,
      "judging",
      `issue-${SUBJECTS[0]}`,
    );
    const judgeRequests = writeReceipt(join(judgeRoot, "requests.json"), {
      schemaVersion: 1,
      kind: "Gate2702JudgeRequests",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject: SUBJECTS[0],
      baseSha: fixture.baseSha,
      requests: {
        forward: {
          payload: { prompt: "fixed forward fixture" },
          payloadDigest: valueDigest({ prompt: "fixed forward fixture" }),
        },
        swapped: {
          payload: { prompt: "fixed swapped fixture" },
          payloadDigest: valueDigest({ prompt: "fixed swapped fixture" }),
        },
      },
    });
    writeReceipt(join(judgeRoot, "result.json"), {
      schemaVersion: 1,
      kind: "Gate2702JudgeResult",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject: SUBJECTS[0],
      attempts: {
        forward: [{ attempt: 1, contentDigest: valueDigest("forward") }],
        swapped: [{ attempt: 1, contentDigest: valueDigest("swapped") }],
      },
    });
    writeReceipt(join(judgeRoot, "forward", "attempt-1.pre-dispatch.json"), {
      schemaVersion: 1,
      kind: "Gate2702JudgePreDispatch",
      definitionRef: DEFINITION_REF,
      trialId: fixture.trialId,
      subject: SUBJECTS[0],
      baseSha: fixture.baseSha,
      requestSetDigest: judgeRequests.contentDigest,
      payload: judgeRequests.requests.forward.payload,
      payloadDigest: judgeRequests.requests.forward.payloadDigest,
      order: "forward",
      attempt: 1,
      executable: "fake-claude",
      argv: ["-p", "fake-judge"],
      judgeModel: "claude-haiku-4-5-20251001",
      sidekickEnabled: false,
      toolAccess: false,
      permissionBypass: false,
      maxBudgetUsd: 0.25,
      timeoutMs: 600_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
      dispatchToken: randomUUID(),
      createdAt: "2026-07-20T18:02:00.000Z",
    });
    await assert.rejects(
      sealTrial(fixture.options, fixture.dependencies),
      /judge pre-dispatch.*not the fixed production command/i,
    );
  } finally {
    fixture.cleanup();
  }
});
