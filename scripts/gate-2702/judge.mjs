#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  gate2702ExecutionMode,
  gate2702ModelIds,
  gate2702SidekickEnvironment,
} from "./behavior-context.mjs";
import { captureGate2702WorktreeEvidence } from "./worktree-evidence.mjs";

const SCHEMA_VERSION = 1;
const DEFINITION_REF = Object.freeze({
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
});
const SUBJECTS = new Set([2760, 2719, 2713, 2706, 2710, 2670]);
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

const TREATMENT_CONFIGURATIONS = Object.freeze({
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
});

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

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
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

function withDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return { ...withoutDigest, contentDigest: valueDigest(withoutDigest) };
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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
    fail(`expected ${kind} schema version ${SCHEMA_VERSION}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(receipt.contentDigest ?? "")) {
    fail(`${kind} receipt has no valid content digest`);
  }
  if (receipt.contentDigest !== receiptDigest(receipt)) {
    fail(`${kind} receipt content digest does not match its bytes`);
  }
  return receipt;
}

function readJson(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`receipt is not a regular file: ${path}`);
  }
  if (metadata.size > MAX_SOURCE_BYTES)
    fail(`receipt exceeds size limit: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`could not decode JSON ${path}: ${error.message}`);
  }
}

function readReceipt(path, kind) {
  return verifyReceipt(readJson(path), kind);
}

function writeImmutableReceipt(path, receipt) {
  const value = withDigest(receipt);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== bytes) {
      fail(`immutable receipt already exists with different bytes: ${path}`);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return value;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["run", "resume"]).has(command)) {
    fail(
      "usage: judge.mjs <run|resume> --trial <uuid> --subject <issue> [--state-root <path>]",
    );
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      fail(`invalid argument near ${key}`);
    const name = key.slice(2);
    if (!new Set(["trial", "subject", "state-root"]).has(name)) {
      fail(`unknown option ${key}`);
    }
    if (options[name] !== undefined) fail(`duplicate option ${key}`);
    options[name] = value;
  }
  if (!UUID_PATTERN.test(options.trial ?? ""))
    fail("--trial must be an RFC 4122 UUID");
  options.subject = Number(options.subject);
  if (!SUBJECTS.has(options.subject))
    fail("--subject is not in the checked-in C5 workload");
  return options;
}

function trialPaths(options) {
  const stateRoot = resolve(
    options["state-root"] ||
      process.env.CHD_EXPERIMENT_2702_STATE_ROOT ||
      join(homedir(), ".claude", "shadow-calls", "gate-2702"),
  );
  const trialRoot = join(
    stateRoot,
    DEFINITION_REF.contentDigest.replace(":", "-"),
    options.trial,
  );
  const judgingRoot = join(trialRoot, "judging", `issue-${options.subject}`);
  return {
    stateRoot,
    trialRoot,
    trial: join(trialRoot, "trial.json"),
    snapshot: join(trialRoot, "subjects", `issue-${options.subject}.json`),
    selection: join(
      trialRoot,
      "pair-selection",
      `issue-${options.subject}.json`,
    ),
    judgingRoot,
    input: join(judgingRoot, "input.json"),
    requests: join(judgingRoot, "requests.json"),
    result: join(judgingRoot, "result.json"),
  };
}

function assertIdentity(receipt, identity, label) {
  if (
    !sameValue(receipt.definitionRef, DEFINITION_REF) ||
    receipt.trialId !== identity.trialId ||
    receipt.subject !== identity.subject ||
    receipt.baseSha !== identity.baseSha
  ) {
    fail(`${label} identity does not match the C5 trial`);
  }
  return receipt;
}

function expectedArmPaths(paths, subject, treatmentId, attempt) {
  return {
    runDir: join(
      paths.trialRoot,
      "runs",
      `issue-${subject}`,
      treatmentId,
      `attempt-${attempt}`,
    ),
    worktreePath: join(
      paths.trialRoot,
      "worktrees",
      `issue-${subject}.${treatmentId}.attempt-${attempt}`,
    ),
  };
}

function expectedWorkerArgv() {
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
    "15",
  ];
}

function isTestExecutionMode(executionMode) {
  return executionMode === "test" && gate2702ExecutionMode() === "test";
}

function isWithin(root, candidate) {
  const rel = relative(realpathSync(root), realpathSync(candidate));
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

function freezeDiff(registration) {
  return captureGate2702WorktreeEvidence({
    worktreePath: registration.worktreePath,
    baseSha: registration.baseSha,
    includeBytes: true,
  });
}

function parseWorkerResult(runDir, classification) {
  const path = join(runDir, "stdout.log");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("selected worker output is not a regular file");
  }
  const size = metadata.size;
  if (size > MAX_SOURCE_BYTES) fail("worker output exceeds judge source cap");
  const bytes = readFileSync(path);
  const recorded = classification.workerArtifacts?.stdout;
  if (
    recorded?.path !== path ||
    recorded.byteLength !== size ||
    recorded.capturedBytes !== size ||
    recorded.truncated !== false ||
    recorded.contentDigest !== sha256Bytes(bytes)
  ) {
    fail("selected worker output does not match its classification artifact");
  }
  let wrapper;
  try {
    wrapper = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("selected worker output is not valid Claude JSON");
  }
  if (typeof wrapper.result !== "string" || !wrapper.result.trim()) {
    fail("selected worker output has no final result");
  }
  return wrapper.result;
}

function artifactText(workerResult, diff, registration) {
  const patch = Buffer.from(diff.trackedPatch.bytes, "base64").toString("utf8");
  const untracked = diff.untracked
    .map((entry) => {
      return `[UNTRACKED ${entry.kind} ${entry.path}; ${entry.encoding}]\n${entry.bytes}`;
    })
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

function validateWorktreeIdentity(registration, preDispatch) {
  const gitResult = spawnSync(
    "git",
    ["-C", registration.worktreePath, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (gitResult.error || gitResult.status !== 0) {
    fail("registered C5 worktree has no live git identity");
  }
  const gitDirectory = resolve(gitResult.stdout.trim());
  const external = readReceipt(
    join(registration.runDir, "worktree-identity.json"),
    "Gate2702WorktreeIdentity",
  );
  const marker = readReceipt(
    join(gitDirectory, "gate-2702-worktree-identity.json"),
    "Gate2702WorktreeIdentity",
  );
  const valid =
    sameValue(external, marker) &&
    sameValue(external.definitionRef, DEFINITION_REF) &&
    external.registrationDigest === registration.contentDigest &&
    external.trialId === registration.trialId &&
    external.subject === registration.subject &&
    external.treatmentId === registration.treatmentId &&
    external.attempt === registration.attempt &&
    external.baseSha === registration.baseSha &&
    external.executionMode === registration.executionMode &&
    resolve(external.worktreePath ?? "") ===
      resolve(registration.worktreePath) &&
    resolve(external.gitDirectory ?? "") === gitDirectory &&
    UUID_PATTERN.test(external.identityToken ?? "") &&
    Number.isFinite(Date.parse(external.createdAt ?? "")) &&
    preDispatch.worktreeIdentityDigest === external.contentDigest;
  if (!valid) {
    fail("registered C5 worktree identity does not match its dispatch");
  }
  return external;
}

function validateSelectionInputs(paths, options) {
  const trial = readReceipt(paths.trial, "Gate2702Trial");
  const executionMode = gate2702ExecutionMode();
  if (
    !sameValue(trial.definitionRef, DEFINITION_REF) ||
    trial.trialId !== options.trial ||
    trial.executionMode !== executionMode ||
    !/^[0-9a-f]{40}$/.test(trial.baseSha ?? "") ||
    typeof trial.worktreeRoot !== "string" ||
    resolve(trial.worktreeRoot) !== resolve(join(paths.trialRoot, "worktrees"))
  ) {
    fail(
      "trial does not identify the checked-in C5 Definition and execution mode",
    );
  }
  const identity = {
    trialId: options.trial,
    subject: options.subject,
    baseSha: trial.baseSha,
  };
  const selection = assertIdentity(
    readReceipt(paths.selection, "Gate2702PairSelection"),
    identity,
    "pair selection",
  );
  const snapshot = assertIdentity(
    readReceipt(paths.snapshot, "Gate2702SubjectSnapshot"),
    identity,
    "subject snapshot",
  );
  const snapshotManifestEntries = Array.isArray(trial.subjectSnapshots)
    ? trial.subjectSnapshots.filter(
        (entry) => entry?.subject === options.subject,
      )
    : [];
  if (
    snapshotManifestEntries.length !== 1 ||
    !sameValue(snapshotManifestEntries[0], {
      subject: options.subject,
      contentDigest: snapshot.contentDigest,
    })
  ) {
    fail("subject snapshot is not bound by the trial manifest");
  }
  if (
    snapshot.executionMode !== executionMode ||
    typeof snapshot.title !== "string" ||
    typeof snapshot.body !== "string"
  ) {
    fail("subject snapshot lacks frozen task text");
  }
  const arms = {};
  for (const treatmentId of TREATMENTS) {
    const selected = selection.arms?.[treatmentId];
    if (
      selected?.treatmentId !== treatmentId ||
      ![1, 2].includes(selected.attempt) ||
      !/^sha256:[0-9a-f]{64}$/.test(selected.registrationDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(selected.classificationDigest ?? "")
    ) {
      fail(`pair selection has no exact ${treatmentId} arm`);
    }
    const { runDir, worktreePath } = expectedArmPaths(
      paths,
      options.subject,
      treatmentId,
      selected.attempt,
    );
    const registration = assertIdentity(
      readReceipt(join(runDir, "registration.json"), "Gate2702ArmRegistration"),
      identity,
      `${treatmentId} registration`,
    );
    if (
      registration.treatmentId !== treatmentId ||
      registration.attempt !== selected.attempt ||
      registration.executionMode !== executionMode ||
      registration.contentDigest !== selected.registrationDigest ||
      resolve(registration.runDir) !== resolve(runDir) ||
      resolve(registration.worktreePath) !== resolve(worktreePath) ||
      !isWithin(trial.worktreeRoot, registration.worktreePath)
    ) {
      fail(`${treatmentId} registration does not match pair selection`);
    }
    if (selected.attempt === 1) {
      const embedded = trial.registrations?.filter(
        (candidate) =>
          candidate?.subject === options.subject &&
          candidate?.treatmentId === treatmentId &&
          candidate?.attempt === 1,
      );
      if (embedded?.length !== 1 || !sameValue(embedded[0], registration)) {
        fail(`${treatmentId} registration is not bound into the trial`);
      }
    } else {
      const firstRunDir = expectedArmPaths(
        paths,
        options.subject,
        treatmentId,
        1,
      ).runDir;
      const firstRegistration = assertIdentity(
        readReceipt(
          join(firstRunDir, "registration.json"),
          "Gate2702ArmRegistration",
        ),
        identity,
        `${treatmentId} first registration`,
      );
      const firstClassification = assertIdentity(
        readReceipt(
          join(firstRunDir, "classification.json"),
          "Gate2702ArmClassification",
        ),
        identity,
        `${treatmentId} first classification`,
      );
      if (
        firstRegistration.executionMode !== executionMode ||
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

    const preflight =
      selected.attempt === 1
        ? readReceipt(
            join(paths.trialRoot, "preflight", `issue-${options.subject}.json`),
            "Gate2702PairPreflight",
          )
        : readReceipt(join(runDir, "preflight.json"), "Gate2702RetryPreflight");
    const preflightArm =
      selected.attempt === 1 ? preflight.arms?.[treatmentId] : preflight;
    if (
      !sameValue(preflight.definitionRef, DEFINITION_REF) ||
      preflight.trialId !== options.trial ||
      preflight.subject !== options.subject ||
      preflight.baseSha !== trial.baseSha ||
      preflight.status !== "passed" ||
      preflightArm?.registrationDigest !== registration.contentDigest ||
      preflightArm?.behaviorContext === null ||
      typeof preflightArm?.behaviorContext !== "object"
    ) {
      fail(
        `${treatmentId} preflight is not bound to eligible behavior evidence`,
      );
    }

    const preDispatch = assertIdentity(
      readReceipt(join(runDir, "pre-dispatch.json"), "Gate2702PreDispatch"),
      identity,
      `${treatmentId} pre-dispatch`,
    );
    const expectedSidekickEnvironment = gate2702SidekickEnvironment(
      TREATMENT_CONFIGURATIONS[treatmentId],
    );
    if (
      preDispatch.treatmentId !== treatmentId ||
      preDispatch.attempt !== selected.attempt ||
      preDispatch.registrationDigest !== registration.contentDigest ||
      preDispatch.executionMode !== executionMode ||
      resolve(preDispatch.cwd ?? "") !== resolve(worktreePath) ||
      !sameValue(
        preDispatch.sidekickEnvironment,
        expectedSidekickEnvironment,
      ) ||
      preDispatch.sidekickEnvironmentDigest !==
        valueDigest(expectedSidekickEnvironment) ||
      preDispatch.promptDigest !==
        sha256Bytes(
          Buffer.from(workerPrompt(snapshot, registration), "utf8"),
        ) ||
      !Array.isArray(preDispatch.argv) ||
      preDispatch.argv.length === 0 ||
      preDispatch.argv.some(
        (argument) => typeof argument !== "string" || !argument,
      ) ||
      (executionMode === "production" &&
        !sameValue(preDispatch.argv, expectedWorkerArgv()))
    ) {
      fail(
        `${treatmentId} worker dispatch is not the registered C5 invocation`,
      );
    }
    validateWorktreeIdentity(registration, preDispatch);

    const processReceipt = assertIdentity(
      readReceipt(join(runDir, "process.json"), "Gate2702Process"),
      identity,
      `${treatmentId} process`,
    );
    if (
      processReceipt.treatmentId !== treatmentId ||
      processReceipt.attempt !== selected.attempt ||
      processReceipt.registrationDigest !== registration.contentDigest ||
      processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
      !Number.isSafeInteger(processReceipt.pid) ||
      processReceipt.pid <= 1
    ) {
      fail(`${treatmentId} process receipt is not bound to its dispatch`);
    }

    const terminal = assertIdentity(
      readReceipt(join(runDir, "terminal.json"), "Gate2702Terminal"),
      identity,
      `${treatmentId} terminal`,
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
      fail(`${treatmentId} terminal receipt is not a completed C5 arm`);
    }
    const classification = assertIdentity(
      readReceipt(
        join(runDir, "classification.json"),
        "Gate2702ArmClassification",
      ),
      identity,
      `${treatmentId} classification`,
    );
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
      )
    ) {
      fail(`${treatmentId} classification is absent, ineligible, or tampered`);
    }
    if (
      !Array.isArray(classification.checkResults) ||
      classification.checkResults.length !== CHECK_IDS.length ||
      !CHECK_IDS.every((checkId) =>
        classification.checkResults.some(
          (check) =>
            check?.checkId === checkId &&
            ["passed", "failed"].includes(check.status),
        ),
      )
    ) {
      fail(`${treatmentId} classification has invalid objective checks`);
    }
    arms[treatmentId] = {
      selected,
      registration,
      preflight,
      preDispatch,
      processReceipt,
      terminal,
      classification,
      runDir,
    };
  }
  return { trial, selection, snapshot, arms, executionMode };
}

function freezeInput(paths, options) {
  if (existsSync(paths.input))
    return readReceipt(paths.input, "Gate2702JudgeInput");
  const source = validateSelectionInputs(paths, options);
  const artifacts = {};
  const armEvidence = {};
  const objectiveChecks = {};
  for (const treatmentId of TREATMENTS) {
    const arm = source.arms[treatmentId];
    const workerResult = parseWorkerResult(arm.runDir, arm.classification);
    const frozenWorktree = freezeDiff(arm.registration);
    if (
      !sameValue(frozenWorktree.evidence, arm.classification.worktreeEvidence)
    ) {
      fail(
        `${treatmentId} worktree changed after its objective classification`,
      );
    }
    const diff = frozenWorktree.diff;
    const artifact = artifactText(workerResult, diff, arm.registration);
    const evidence = writeImmutableReceipt(
      join(paths.judgingRoot, "evidence", `${treatmentId}.json`),
      {
        schemaVersion: SCHEMA_VERSION,
        kind: "Gate2702JudgeArmEvidence",
        definitionRef: DEFINITION_REF,
        trialId: options.trial,
        subject: options.subject,
        treatmentId,
        attempt: arm.registration.attempt,
        baseSha: source.trial.baseSha,
        executionMode: source.executionMode,
        pairSelectionDigest: source.selection.contentDigest,
        registrationDigest: arm.registration.contentDigest,
        classificationDigest: arm.classification.contentDigest,
        workerResult,
        workerResultDigest: sha256Bytes(Buffer.from(workerResult, "utf8")),
        worktreeEvidence: frozenWorktree.evidence,
        diff,
        artifact,
      },
    );
    artifacts[treatmentId] = evidence.artifact;
    armEvidence[treatmentId] = evidence.contentDigest;
    objectiveChecks[treatmentId] = {
      classificationDigest: arm.classification.contentDigest,
      results: arm.classification.checkResults,
      state: arm.classification.checkResults.every(
        (check) => check.status === "passed",
      )
        ? "passed"
        : "failed",
    };
  }
  return writeImmutableReceipt(paths.input, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeInput",
    definitionRef: DEFINITION_REF,
    trialId: options.trial,
    subject: options.subject,
    baseSha: source.trial.baseSha,
    executionMode: source.executionMode,
    pairSelectionDigest: source.selection.contentDigest,
    subjectSnapshotDigest: source.snapshot.contentDigest,
    task: `${source.snapshot.title}\n\n${source.snapshot.body}`,
    armEvidence,
    objectiveChecks,
    artifacts,
  });
}

function decodeEvidenceBytes(value, encoding, label) {
  if (typeof value !== "string") fail(`${label} has no frozen bytes`);
  if (encoding === "utf8") return Buffer.from(value, "utf8");
  if (encoding === "base64") {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value)
      fail(`${label} has invalid base64`);
    return decoded;
  }
  fail(`${label} has an unsupported encoding`);
}

function validateEvidenceContent(paths, evidence) {
  const workerBytes = Buffer.from(evidence.workerResult ?? "", "utf8");
  if (
    typeof evidence.workerResult !== "string" ||
    !evidence.workerResult.trim() ||
    evidence.workerResultDigest !== sha256Bytes(workerBytes) ||
    typeof evidence.artifact !== "string" ||
    !evidence.artifact.trim()
  ) {
    fail(`${evidence.treatmentId} frozen worker evidence is invalid`);
  }
  const patch = evidence.diff?.trackedPatch;
  const patchBytes = decodeEvidenceBytes(
    patch?.bytes,
    patch?.encoding,
    `${evidence.treatmentId} tracked patch`,
  );
  if (
    patch?.sizeBytes !== patchBytes.length ||
    patch?.contentDigest !== sha256Bytes(patchBytes) ||
    patchBytes.length > MAX_SOURCE_BYTES
  ) {
    fail(`${evidence.treatmentId} tracked patch digest is invalid`);
  }
  if (!Array.isArray(evidence.diff?.untracked)) {
    fail(`${evidence.treatmentId} untracked evidence is invalid`);
  }
  const sortedPaths = evidence.diff.untracked.map((entry) => entry.path);
  if (
    evidence.diff.untracked.length > MAX_UNTRACKED_FILES ||
    !sameValue(sortedPaths, [...sortedPaths].sort())
  ) {
    fail(`${evidence.treatmentId} untracked evidence is not sorted`);
  }
  let sourceBytes = patchBytes.length;
  const untrackedEvidence = [];
  for (const entry of evidence.diff.untracked) {
    if (
      typeof entry.path !== "string" ||
      !["file", "symlink"].includes(entry.kind) ||
      !Number.isInteger(entry.mode)
    ) {
      fail(`${evidence.treatmentId} untracked entry identity is invalid`);
    }
    const bytes = decodeEvidenceBytes(
      entry.bytes,
      entry.encoding,
      `${evidence.treatmentId} untracked ${entry.path}`,
    );
    if (
      entry.sizeBytes !== bytes.length ||
      entry.contentDigest !== sha256Bytes(bytes)
    ) {
      fail(`${evidence.treatmentId} untracked ${entry.path} digest is invalid`);
    }
    sourceBytes += bytes.length;
    if (sourceBytes > MAX_SOURCE_BYTES) {
      fail(`${evidence.treatmentId} aggregate source exceeds evidence cap`);
    }
    const { bytes: _bytes, ...metadata } = entry;
    untrackedEvidence.push(metadata);
  }
  const expectedWorktreeBody = {
    baseSha: evidence.baseSha,
    trackedPatch: {
      sizeBytes: patchBytes.length,
      contentDigest: sha256Bytes(patchBytes),
    },
    untracked: untrackedEvidence,
    aggregateBytes: sourceBytes,
  };
  const expectedWorktreeEvidence = {
    ...expectedWorktreeBody,
    contentDigest: valueDigest(expectedWorktreeBody),
  };
  if (!sameValue(evidence.worktreeEvidence, expectedWorktreeEvidence)) {
    fail(
      `${evidence.treatmentId} worktree evidence is not derived from its bytes`,
    );
  }
  const redactions = expectedArmPaths(
    paths,
    evidence.subject,
    evidence.treatmentId,
    evidence.attempt,
  );
  const expectedArtifact = artifactText(evidence.workerResult, evidence.diff, {
    ...redactions,
    treatmentId: evidence.treatmentId,
  });
  if (evidence.artifact !== expectedArtifact) {
    fail(
      `${evidence.treatmentId} frozen artifact is not derived from its bytes`,
    );
  }
  return evidence;
}

function expectedPayloads(input) {
  const forward = {
    task: input.task,
    rubric: RUBRIC,
    artifacts: {
      A: input.artifacts[TREATMENTS[0]],
      B: input.artifacts[TREATMENTS[1]],
    },
  };
  const swapped = {
    task: input.task,
    rubric: RUBRIC,
    artifacts: { A: forward.artifacts.B, B: forward.artifacts.A },
  };
  return { forward, swapped };
}

function validateFrozenInput(paths, input, options) {
  const executionMode = gate2702ExecutionMode();
  if (
    !sameValue(input.definitionRef, DEFINITION_REF) ||
    input.trialId !== options.trial ||
    input.subject !== options.subject ||
    input.executionMode !== executionMode ||
    !/^[0-9a-f]{40}$/.test(input.baseSha ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(input.pairSelectionDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(input.subjectSnapshotDigest ?? "") ||
    typeof input.task !== "string" ||
    !input.task.trim() ||
    !sameValue(
      Object.keys(input.armEvidence ?? {}).sort(),
      [...TREATMENTS].sort(),
    ) ||
    !sameValue(
      Object.keys(input.objectiveChecks ?? {}).sort(),
      [...TREATMENTS].sort(),
    ) ||
    !sameValue(
      Object.keys(input.artifacts ?? {}).sort(),
      [...TREATMENTS].sort(),
    )
  ) {
    fail("frozen judge input does not match the selected C5 pair");
  }
  for (const treatmentId of TREATMENTS) {
    const digest = input.armEvidence?.[treatmentId];
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
      fail(`frozen judge input has no ${treatmentId} evidence digest`);
    }
    const evidence = validateEvidenceContent(
      paths,
      readReceipt(
        join(paths.judgingRoot, "evidence", `${treatmentId}.json`),
        "Gate2702JudgeArmEvidence",
      ),
    );
    const objective = input.objectiveChecks?.[treatmentId];
    const objectiveStatuses = Array.isArray(objective?.results)
      ? objective.results.map((check) => check?.status)
      : [];
    const objectiveCheckIds = Array.isArray(objective?.results)
      ? objective.results.map((check) => check?.checkId)
      : [];
    const expectedObjectiveState =
      objectiveStatuses.length === CHECK_IDS.length &&
      objectiveStatuses.every((status) => status === "passed")
        ? "passed"
        : "failed";
    if (
      evidence.contentDigest !== digest ||
      !sameValue(evidence.definitionRef, DEFINITION_REF) ||
      evidence.trialId !== input.trialId ||
      evidence.subject !== input.subject ||
      evidence.treatmentId !== treatmentId ||
      ![1, 2].includes(evidence.attempt) ||
      evidence.baseSha !== input.baseSha ||
      evidence.executionMode !== input.executionMode ||
      evidence.pairSelectionDigest !== input.pairSelectionDigest ||
      !/^sha256:[0-9a-f]{64}$/.test(evidence.registrationDigest ?? "") ||
      evidence.classificationDigest !== objective?.classificationDigest ||
      input.artifacts?.[treatmentId] !== evidence.artifact ||
      objectiveStatuses.length !== CHECK_IDS.length ||
      !sameValue([...objectiveCheckIds].sort(), [...CHECK_IDS].sort()) ||
      !objectiveStatuses.every((status) =>
        ["passed", "failed"].includes(status),
      ) ||
      objective.state !== expectedObjectiveState
    ) {
      fail(
        `${treatmentId} frozen judge evidence does not match its input receipt`,
      );
    }
  }
  return input;
}

function validateFrozenRequests(requests, input) {
  const payloads = expectedPayloads(input);
  const exact =
    sameValue(requests.definitionRef, DEFINITION_REF) &&
    requests.trialId === input.trialId &&
    requests.subject === input.subject &&
    requests.baseSha === input.baseSha &&
    requests.executionMode === input.executionMode &&
    requests.judgeInputDigest === input.contentDigest &&
    requests.judgeModel === JUDGE_MODEL &&
    requests.timeoutMs === JUDGE_TIMEOUT_MS &&
    requests.maxBudgetUsd === Number(JUDGE_BUDGET_USD) &&
    requests.maxAttemptsPerOrder === MAX_ATTEMPTS &&
    requests.maxPayloadBytes === MAX_PROMPT_BYTES &&
    requests.maxStdoutBytes === MAX_STREAM_BYTES &&
    requests.maxStderrBytes === MAX_STREAM_BYTES &&
    requests.rubric === RUBRIC &&
    sameValue(requests.schema, JUDGE_SCHEMA) &&
    sameValue(requests.requests?.forward?.payload, payloads.forward) &&
    sameValue(requests.requests?.swapped?.payload, payloads.swapped) &&
    requests.requests?.forward?.payloadDigest ===
      valueDigest(payloads.forward) &&
    requests.requests?.swapped?.payloadDigest ===
      valueDigest(payloads.swapped) &&
    sameValue(requests.requests?.forward?.order, {
      A: TREATMENTS[0],
      B: TREATMENTS[1],
    }) &&
    sameValue(requests.requests?.swapped?.order, {
      A: TREATMENTS[1],
      B: TREATMENTS[0],
    });
  if (!exact)
    fail("frozen judge request or arm order differs from the C5 contract");
  for (const payload of Object.values(payloads)) {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PROMPT_BYTES) {
      fail("frozen judge request exceeds the C5 payload bound");
    }
  }
  return requests;
}

function buildRequests(paths, input) {
  if (existsSync(paths.requests)) {
    return validateFrozenRequests(
      readReceipt(paths.requests, "Gate2702JudgeRequests"),
      input,
    );
  }
  const { forward, swapped } = expectedPayloads(input);
  for (const [order, payload] of Object.entries({ forward, swapped })) {
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > MAX_PROMPT_BYTES) {
      fail(
        `${order} judge payload is ${bytes} bytes; maximum is ${MAX_PROMPT_BYTES}`,
      );
    }
  }
  return validateFrozenRequests(
    writeImmutableReceipt(paths.requests, {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702JudgeRequests",
      definitionRef: DEFINITION_REF,
      trialId: input.trialId,
      subject: input.subject,
      baseSha: input.baseSha,
      executionMode: input.executionMode,
      judgeInputDigest: input.contentDigest,
      judgeModel: JUDGE_MODEL,
      timeoutMs: JUDGE_TIMEOUT_MS,
      maxBudgetUsd: Number(JUDGE_BUDGET_USD),
      maxAttemptsPerOrder: MAX_ATTEMPTS,
      maxPayloadBytes: MAX_PROMPT_BYTES,
      maxStdoutBytes: MAX_STREAM_BYTES,
      maxStderrBytes: MAX_STREAM_BYTES,
      schema: JUDGE_SCHEMA,
      rubric: RUBRIC,
      requests: {
        forward: {
          payload: forward,
          payloadDigest: valueDigest(forward),
          order: { A: TREATMENTS[0], B: TREATMENTS[1] },
        },
        swapped: {
          payload: swapped,
          payloadDigest: valueDigest(swapped),
          order: { A: TREATMENTS[1], B: TREATMENTS[0] },
        },
      },
    }),
    input,
  );
}

function validScores(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  if (
    !sameValue(Object.keys(value).sort(), DIMENSIONS.map(([key]) => key).sort())
  )
    return false;
  return Object.values(value).every(
    (score) => Number.isInteger(score) && score >= 1 && score <= 10,
  );
}

function validateResponse(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  if (!sameValue(Object.keys(value).sort(), ["rationale", "scores", "winner"]))
    return false;
  if (!["A", "B", "tie"].includes(value.winner)) return false;
  if (
    typeof value.rationale !== "string" ||
    !value.rationale.trim() ||
    value.rationale.length > 4096
  ) {
    return false;
  }
  if (
    value.scores === null ||
    typeof value.scores !== "object" ||
    Array.isArray(value.scores) ||
    !sameValue(Object.keys(value.scores).sort(), ["A", "B"])
  ) {
    return false;
  }
  return validScores(value.scores.A) && validScores(value.scores.B);
}

function extractResponse(stdoutBytes) {
  let wrapper;
  try {
    wrapper = JSON.parse(stdoutBytes.toString("utf8"));
  } catch {
    return { ok: false, failureClass: "non-json", retryable: true };
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
      ok: false,
      failureClass:
        costUsd > Number(JUDGE_BUDGET_USD)
          ? "budget-exhausted"
          : "schema-invalid",
      retryable: false,
      costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
    };
  }
  if (wrapper?.subtype === "error_max_budget_usd") {
    return {
      ok: false,
      failureClass: "budget-exhausted",
      retryable: false,
      costUsd,
    };
  }
  if (
    wrapper?.is_error === true ||
    (typeof wrapper?.subtype === "string" && wrapper.subtype !== "success")
  ) {
    return {
      ok: false,
      failureClass:
        typeof wrapper?.result === "string" &&
        /budget|max[_ -]?budget/i.test(wrapper.result)
          ? "budget-exhausted"
          : "process-exit",
      retryable: false,
      costUsd,
    };
  }
  if (wrapper?.type !== "result" || wrapper?.subtype !== "success") {
    return {
      ok: false,
      failureClass: "schema-invalid",
      retryable: true,
      costUsd,
    };
  }
  let response = wrapper?.structured_output ?? wrapper?.structuredOutput;
  if (response === undefined && typeof wrapper?.result === "string") {
    try {
      response = JSON.parse(wrapper.result);
    } catch {
      return { ok: false, failureClass: "non-json", retryable: true, costUsd };
    }
  }
  if (!validateResponse(response)) {
    return {
      ok: false,
      failureClass: "schema-invalid",
      retryable: true,
      costUsd,
    };
  }
  return {
    ok: true,
    response,
    costUsd,
  };
}

function reportedCost(stdoutBytes) {
  try {
    const value = JSON.parse(stdoutBytes.toString("utf8"));
    return typeof value?.total_cost_usd === "number"
      ? value.total_cost_usd
      : null;
  } catch {
    return null;
  }
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

function judgeEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SIDEKICK_")),
  );
  environment.SIDEKICK_ENABLE = "0";
  return environment;
}

function effectiveJudgeTimeoutMs(executionMode) {
  return isTestExecutionMode(executionMode) &&
    process.env.NODE_ENV === "test" &&
    process.env.CHD_EXPERIMENT_2702_TEST_JUDGE_TIMEOUT_MS
    ? Number(process.env.CHD_EXPERIMENT_2702_TEST_JUDGE_TIMEOUT_MS)
    : JUDGE_TIMEOUT_MS;
}

async function executeJudgeCall(preDispatch) {
  const argv = preDispatch.argv;
  const startedAt = new Date().toISOString();
  const startNs = process.hrtime.bigint();
  const startPerformanceMs = performance.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const claude = preDispatch.executable;
  return await new Promise((resolveCall) => {
    let child;
    let spawnError = null;
    try {
      child = spawn(claude, argv, {
        env: judgeEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      spawnError = error;
    }
    if (spawnError) {
      resolveCall({ argv, startedAt, startNs, startPerformanceMs, spawnError });
      return;
    }
    const collect = (chunks, hash, chunk, stream) => {
      hash.update(chunk);
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const room = Math.max(0, MAX_STREAM_BYTES - current);
      if (room) chunks.push(chunk.subarray(0, room));
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STREAM_BYTES) stdoutTruncated = true;
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STREAM_BYTES) stderrTruncated = true;
      }
    };
    child.stdout.on("data", (chunk) =>
      collect(stdout, stdoutHash, chunk, "stdout"),
    );
    child.stderr.on("data", (chunk) =>
      collect(stderr, stderrHash, chunk, "stderr"),
    );
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      spawnError = error;
    });
    let timedOut = false;
    const timeoutMs = effectiveJudgeTimeoutMs(preDispatch.executionMode);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") spawnError = error;
      }
    }, timeoutMs);
    child.stdin.end(JSON.stringify(preDispatch.payload));
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveCall({
        argv,
        startedAt,
        startNs,
        startPerformanceMs,
        exitCode,
        signal,
        timedOut,
        spawnError,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutDigest: `sha256:${stdoutHash.digest("hex")}`,
        stderrDigest: `sha256:${stderrHash.digest("hex")}`,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function capturedStream(call, name) {
  const bytes = call[name];
  if (!Buffer.isBuffer(bytes)) return null;
  return {
    encoding: "base64",
    capturedBytes: bytes.length,
    totalBytes: call[`${name}Bytes`],
    contentDigest: call[`${name}Digest`],
    truncated: call[`${name}Truncated`],
    bytes: bytes.toString("base64"),
  };
}

function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(") ");
    if (closeParen < 0) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    return {
      state: fields[0],
      startTimeTicks: fields[19],
    };
  } catch {
    return null;
  }
}

function managedProcessIsActive(processReceipt) {
  if (!Number.isSafeInteger(processReceipt?.pid) || processReceipt.pid <= 0) {
    return false;
  }
  try {
    process.kill(processReceipt.pid, 0);
  } catch {
    return false;
  }
  const current = processIdentity(processReceipt.pid);
  if (current?.state === "Z") return false;
  if (
    processReceipt.processStartTimeTicks !== null &&
    current?.startTimeTicks !== processReceipt.processStartTimeTicks
  ) {
    return false;
  }
  return true;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForFile(path, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(path)) return true;
    await wait(20);
  }
  return existsSync(path);
}

function attemptPaths(paths, order, attempt) {
  const prefix = join(paths.judgingRoot, order, `attempt-${attempt}`);
  return {
    preDispatch: `${prefix}.pre-dispatch.json`,
    process: `${prefix}.process.json`,
    gate: `${prefix}.gate.json`,
    outcome: `${prefix}.outcome.json`,
    attempt: `${prefix}.json`,
  };
}

function maybeCrashJudgeForTest(stage, executionMode) {
  if (
    isTestExecutionMode(executionMode) &&
    process.env.NODE_ENV === "test" &&
    process.env.CHD_EXPERIMENT_2702_TEST_CRASH_STAGE === stage
  ) {
    process.exit(86);
  }
}

async function internalJudgeDispatch(argv) {
  if (argv.length !== 4) fail("internal judge dispatch has invalid paths");
  const [preDispatchPath, processPath, gatePath, outcomePath] = argv.map(
    (path) => resolve(path),
  );
  const preDispatch = readReceipt(preDispatchPath, "Gate2702JudgePreDispatch");
  if (preDispatch.executionMode !== gate2702ExecutionMode()) {
    fail("internal judge dispatch execution mode does not match its receipt");
  }
  if (!(await waitForFile(processPath, 30_000))) return;
  const processReceipt = readReceipt(processPath, "Gate2702JudgeProcess");
  if (
    processReceipt.pid !== process.pid ||
    processReceipt.executionMode !== preDispatch.executionMode ||
    processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
    processReceipt.dispatchToken !== preDispatch.dispatchToken
  ) {
    fail("internal judge process receipt does not authorize this wrapper");
  }
  if (!(await waitForFile(gatePath, 30_000))) return;
  const gate = readReceipt(gatePath, "Gate2702JudgeGate");
  if (
    gate.preDispatchDigest !== preDispatch.contentDigest ||
    gate.executionMode !== preDispatch.executionMode ||
    gate.processDigest !== processReceipt.contentDigest ||
    gate.dispatchToken !== preDispatch.dispatchToken
  ) {
    fail("internal judge gate does not match the durable dispatch chain");
  }
  if (existsSync(outcomePath)) return;
  const call = await executeJudgeCall(preDispatch);
  const endedAt = new Date().toISOString();
  const endNs = process.hrtime.bigint();
  writeImmutableReceipt(outcomePath, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeOutcome",
    definitionRef: preDispatch.definitionRef,
    trialId: preDispatch.trialId,
    subject: preDispatch.subject,
    baseSha: preDispatch.baseSha,
    executionMode: preDispatch.executionMode,
    requestSetDigest: preDispatch.requestSetDigest,
    payloadDigest: preDispatch.payloadDigest,
    order: preDispatch.order,
    attempt: preDispatch.attempt,
    dispatchToken: preDispatch.dispatchToken,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    gateDigest: gate.contentDigest,
    startedAt: call.startedAt,
    endedAt,
    startedMonotonicNs: call.startNs?.toString() ?? null,
    endedMonotonicNs: endNs.toString(),
    durationMs:
      call.startPerformanceMs === undefined
        ? null
        : Math.max(0, performance.now() - call.startPerformanceMs),
    exitCode: call.exitCode ?? null,
    signal: call.signal ?? null,
    timedOut: call.timedOut ?? false,
    spawnError: call.spawnError?.message ?? null,
    stdout: capturedStream(call, "stdout"),
    stderr: capturedStream(call, "stderr"),
  });
}

function attemptResult(call) {
  if (call.spawnError) {
    return { ok: false, failureClass: "spawn-error", retryable: false };
  }
  if (call.stdoutTruncated || call.stderrTruncated) {
    return { ok: false, failureClass: "output-truncated", retryable: false };
  }
  if (call.timedOut)
    return { ok: false, failureClass: "timeout", retryable: true };
  if (call.exitCode !== 0 || call.signal) {
    const combined = `${call.stdout.toString("utf8")}\n${call.stderr.toString("utf8")}`;
    return {
      ok: false,
      failureClass: /budget|max[_ -]?budget/i.test(combined)
        ? "budget-exhausted"
        : "process-exit",
      retryable: false,
      costUsd: reportedCost(call.stdout),
    };
  }
  return extractResponse(call.stdout);
}

function outcomeAsCall(outcome) {
  return {
    spawnError: outcome.spawnError ? new Error(outcome.spawnError) : null,
    stdoutTruncated: outcome.stdout?.truncated ?? false,
    stderrTruncated: outcome.stderr?.truncated ?? false,
    timedOut: outcome.timedOut,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout
      ? Buffer.from(outcome.stdout.bytes, "base64")
      : Buffer.alloc(0),
    stderr: outcome.stderr
      ? Buffer.from(outcome.stderr.bytes, "base64")
      : Buffer.alloc(0),
  };
}

function readAttempt(path) {
  return readReceipt(path, "Gate2702JudgeAttempt");
}

function validateCapturedStream(stream, label) {
  if (stream === null) return;
  if (
    stream?.encoding !== "base64" ||
    typeof stream.bytes !== "string" ||
    !Number.isInteger(stream.capturedBytes) ||
    !Number.isInteger(stream.totalBytes) ||
    stream.capturedBytes < 0 ||
    stream.capturedBytes > MAX_STREAM_BYTES ||
    stream.totalBytes < stream.capturedBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(stream.contentDigest ?? "") ||
    typeof stream.truncated !== "boolean"
  ) {
    fail(`${label} capture metadata is invalid`);
  }
  const bytes = Buffer.from(stream.bytes, "base64");
  if (
    bytes.toString("base64") !== stream.bytes ||
    bytes.length !== stream.capturedBytes ||
    stream.truncated !== stream.totalBytes > stream.capturedBytes ||
    (stream.truncated && stream.capturedBytes !== MAX_STREAM_BYTES) ||
    (!stream.truncated && stream.contentDigest !== sha256Bytes(bytes))
  ) {
    fail(`${label} capture digest or bounds are invalid`);
  }
}

function validatePreDispatch(
  preDispatch,
  requests,
  request,
  order,
  attemptNumber,
) {
  if (
    !sameValue(preDispatch.definitionRef, DEFINITION_REF) ||
    preDispatch.trialId !== requests.trialId ||
    preDispatch.subject !== requests.subject ||
    preDispatch.baseSha !== requests.baseSha ||
    preDispatch.executionMode !== requests.executionMode ||
    preDispatch.requestSetDigest !== requests.contentDigest ||
    preDispatch.payloadDigest !== request.payloadDigest ||
    !sameValue(preDispatch.payload, request.payload) ||
    preDispatch.order !== order ||
    preDispatch.attempt !== attemptNumber ||
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
    fail(`existing ${order} pre-dispatch receipt is not the frozen call`);
  }
  return preDispatch;
}

function validateProcessReceipt(processReceipt, preDispatch, lifecycle) {
  const expectedArgv = [
    fileURLToPath(import.meta.url),
    "__dispatch",
    lifecycle.preDispatch,
    lifecycle.process,
    lifecycle.gate,
    lifecycle.outcome,
  ];
  if (
    !sameValue(processReceipt.definitionRef, DEFINITION_REF) ||
    processReceipt.trialId !== preDispatch.trialId ||
    processReceipt.subject !== preDispatch.subject ||
    processReceipt.baseSha !== preDispatch.baseSha ||
    processReceipt.executionMode !== preDispatch.executionMode ||
    processReceipt.requestSetDigest !== preDispatch.requestSetDigest ||
    processReceipt.payloadDigest !== preDispatch.payloadDigest ||
    processReceipt.order !== preDispatch.order ||
    processReceipt.attempt !== preDispatch.attempt ||
    processReceipt.dispatchToken !== preDispatch.dispatchToken ||
    processReceipt.preDispatchDigest !== preDispatch.contentDigest ||
    processReceipt.executable !== process.execPath ||
    !sameValue(processReceipt.argv, expectedArgv) ||
    !Number.isSafeInteger(processReceipt.pid) ||
    processReceipt.pid <= 0 ||
    (process.platform === "linux"
      ? !/^\d+$/.test(processReceipt.processStartTimeTicks ?? "")
      : !(
          processReceipt.processStartTimeTicks === null ||
          /^\d+$/.test(processReceipt.processStartTimeTicks)
        )) ||
    !Number.isFinite(Date.parse(processReceipt.launchedAt ?? ""))
  ) {
    fail(`existing ${preDispatch.order} judge process receipt is invalid`);
  }
  return processReceipt;
}

function validateGate(gate, preDispatch, processReceipt) {
  if (
    !sameValue(gate.definitionRef, DEFINITION_REF) ||
    gate.trialId !== preDispatch.trialId ||
    gate.subject !== preDispatch.subject ||
    gate.baseSha !== preDispatch.baseSha ||
    gate.executionMode !== preDispatch.executionMode ||
    gate.requestSetDigest !== preDispatch.requestSetDigest ||
    gate.payloadDigest !== preDispatch.payloadDigest ||
    gate.order !== preDispatch.order ||
    gate.attempt !== preDispatch.attempt ||
    gate.dispatchToken !== preDispatch.dispatchToken ||
    gate.preDispatchDigest !== preDispatch.contentDigest ||
    gate.processDigest !== processReceipt.contentDigest ||
    !Number.isFinite(Date.parse(gate.authorizedAt ?? ""))
  ) {
    fail(`existing ${preDispatch.order} judge gate is invalid`);
  }
  return gate;
}

function validateOutcome(outcome, preDispatch, processReceipt, gate) {
  if (
    !sameValue(outcome.definitionRef, DEFINITION_REF) ||
    outcome.trialId !== preDispatch.trialId ||
    outcome.subject !== preDispatch.subject ||
    outcome.baseSha !== preDispatch.baseSha ||
    outcome.executionMode !== preDispatch.executionMode ||
    outcome.requestSetDigest !== preDispatch.requestSetDigest ||
    outcome.payloadDigest !== preDispatch.payloadDigest ||
    outcome.order !== preDispatch.order ||
    outcome.attempt !== preDispatch.attempt ||
    outcome.dispatchToken !== preDispatch.dispatchToken ||
    outcome.preDispatchDigest !== preDispatch.contentDigest ||
    outcome.processDigest !== (processReceipt?.contentDigest ?? null) ||
    outcome.gateDigest !== (gate?.contentDigest ?? null) ||
    !Number.isFinite(Date.parse(outcome.startedAt ?? "")) ||
    !Number.isFinite(Date.parse(outcome.endedAt ?? "")) ||
    !(
      outcome.startedMonotonicNs === null ||
      /^\d+$/.test(outcome.startedMonotonicNs)
    ) ||
    !(
      outcome.endedMonotonicNs === null ||
      /^\d+$/.test(outcome.endedMonotonicNs)
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
    fail(`existing ${preDispatch.order} judge outcome is invalid`);
  }
  validateCapturedStream(outcome.stdout, `${preDispatch.order} outcome stdout`);
  validateCapturedStream(outcome.stderr, `${preDispatch.order} outcome stderr`);
  if (outcome.spawnError === null && outcome.stdout === null) {
    fail(`existing ${preDispatch.order} judge outcome has no stdout capture`);
  }
  const wallDurationMs =
    Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt);
  const monotonicPair =
    outcome.startedMonotonicNs !== null && outcome.endedMonotonicNs !== null;
  if (
    wallDurationMs < 0 ||
    (monotonicPair &&
      BigInt(outcome.endedMonotonicNs) < BigInt(outcome.startedMonotonicNs)) ||
    (monotonicPair && outcome.durationMs === null) ||
    (!monotonicPair &&
      (outcome.startedMonotonicNs !== null ||
        outcome.endedMonotonicNs !== null ||
        outcome.durationMs !== null))
  ) {
    fail(`existing ${preDispatch.order} judge outcome timing is invalid`);
  }
  return outcome;
}

function createPreDispatch(requests, request, order, attemptNumber, path) {
  return writeImmutableReceipt(path, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgePreDispatch",
    definitionRef: DEFINITION_REF,
    trialId: requests.trialId,
    subject: requests.subject,
    baseSha: requests.baseSha,
    executionMode: requests.executionMode,
    requestSetDigest: requests.contentDigest,
    payloadDigest: request.payloadDigest,
    payload: request.payload,
    order,
    attempt: attemptNumber,
    executable: "claude",
    argv: judgeArgv(),
    judgeModel: JUDGE_MODEL,
    sidekickEnabled: false,
    toolAccess: false,
    permissionBypass: false,
    maxBudgetUsd: Number(JUDGE_BUDGET_USD),
    timeoutMs: JUDGE_TIMEOUT_MS,
    maxStdoutBytes: MAX_STREAM_BYTES,
    maxStderrBytes: MAX_STREAM_BYTES,
    dispatchToken: randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

async function launchJudgeWrapper(preDispatch, lifecycle) {
  const argv = [
    fileURLToPath(import.meta.url),
    "__dispatch",
    lifecycle.preDispatch,
    lifecycle.process,
    lifecycle.gate,
    lifecycle.outcome,
  ];
  const child = spawn(process.execPath, argv, {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
  let identity = processIdentity(child.pid);
  const identityDeadline = performance.now() + 1_000;
  while (!identity && performance.now() < identityDeadline) {
    await wait(10);
    identity = processIdentity(child.pid);
  }
  if (process.platform === "linux" && !identity?.startTimeTicks) {
    fail("judge wrapper process generation could not be captured");
  }
  return writeImmutableReceipt(lifecycle.process, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeProcess",
    definitionRef: DEFINITION_REF,
    trialId: preDispatch.trialId,
    subject: preDispatch.subject,
    baseSha: preDispatch.baseSha,
    executionMode: preDispatch.executionMode,
    requestSetDigest: preDispatch.requestSetDigest,
    payloadDigest: preDispatch.payloadDigest,
    order: preDispatch.order,
    attempt: preDispatch.attempt,
    dispatchToken: preDispatch.dispatchToken,
    preDispatchDigest: preDispatch.contentDigest,
    executable: process.execPath,
    argv,
    pid: child.pid,
    processStartTimeTicks: identity?.startTimeTicks ?? null,
    launchedAt: new Date().toISOString(),
  });
}

function authorizeJudgeDispatch(preDispatch, processReceipt, path) {
  return writeImmutableReceipt(path, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeGate",
    definitionRef: DEFINITION_REF,
    trialId: preDispatch.trialId,
    subject: preDispatch.subject,
    baseSha: preDispatch.baseSha,
    executionMode: preDispatch.executionMode,
    requestSetDigest: preDispatch.requestSetDigest,
    payloadDigest: preDispatch.payloadDigest,
    order: preDispatch.order,
    attempt: preDispatch.attempt,
    dispatchToken: preDispatch.dispatchToken,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt.contentDigest,
    authorizedAt: new Date().toISOString(),
  });
}

function writeInterruptedOutcome(
  preDispatch,
  processReceipt,
  gate,
  path,
  reason,
) {
  const now = new Date().toISOString();
  return writeImmutableReceipt(path, {
    schemaVersion: SCHEMA_VERSION,
    kind: "Gate2702JudgeOutcome",
    definitionRef: DEFINITION_REF,
    trialId: preDispatch.trialId,
    subject: preDispatch.subject,
    baseSha: preDispatch.baseSha,
    executionMode: preDispatch.executionMode,
    requestSetDigest: preDispatch.requestSetDigest,
    payloadDigest: preDispatch.payloadDigest,
    order: preDispatch.order,
    attempt: preDispatch.attempt,
    dispatchToken: preDispatch.dispatchToken,
    preDispatchDigest: preDispatch.contentDigest,
    processDigest: processReceipt?.contentDigest ?? null,
    gateDigest: gate?.contentDigest ?? null,
    startedAt: preDispatch.createdAt,
    endedAt: now,
    startedMonotonicNs: null,
    endedMonotonicNs: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: reason,
    stdout: null,
    stderr: null,
  });
}

function readLifecycleChain(
  lifecycle,
  requests,
  request,
  order,
  attemptNumber,
) {
  const preDispatch = validatePreDispatch(
    readReceipt(lifecycle.preDispatch, "Gate2702JudgePreDispatch"),
    requests,
    request,
    order,
    attemptNumber,
  );
  const processReceipt = existsSync(lifecycle.process)
    ? validateProcessReceipt(
        readReceipt(lifecycle.process, "Gate2702JudgeProcess"),
        preDispatch,
        lifecycle,
      )
    : null;
  const gate = existsSync(lifecycle.gate)
    ? (() => {
        if (!processReceipt)
          fail(`${order} judge gate exists without a process receipt`);
        return validateGate(
          readReceipt(lifecycle.gate, "Gate2702JudgeGate"),
          preDispatch,
          processReceipt,
        );
      })()
    : null;
  const outcome = existsSync(lifecycle.outcome)
    ? validateOutcome(
        readReceipt(lifecycle.outcome, "Gate2702JudgeOutcome"),
        preDispatch,
        processReceipt,
        gate,
      )
    : null;
  return { preDispatch, processReceipt, gate, outcome };
}

async function completeDurableCall(
  paths,
  requests,
  request,
  order,
  attemptNumber,
) {
  const lifecycle = attemptPaths(paths, order, attemptNumber);
  const hadPreDispatch = existsSync(lifecycle.preDispatch);
  const preDispatch = hadPreDispatch
    ? validatePreDispatch(
        readReceipt(lifecycle.preDispatch, "Gate2702JudgePreDispatch"),
        requests,
        request,
        order,
        attemptNumber,
      )
    : validatePreDispatch(
        createPreDispatch(
          requests,
          request,
          order,
          attemptNumber,
          lifecycle.preDispatch,
        ),
        requests,
        request,
        order,
        attemptNumber,
      );
  if (!hadPreDispatch) {
    maybeCrashJudgeForTest("after-pre-dispatch", requests.executionMode);
  }

  let chain = readLifecycleChain(
    lifecycle,
    requests,
    request,
    order,
    attemptNumber,
  );
  if (chain.outcome) return chain;

  if (!chain.processReceipt) {
    if (hadPreDispatch) {
      writeInterruptedOutcome(
        preDispatch,
        null,
        null,
        lifecycle.outcome,
        "judge dispatch was interrupted before a wrapper was durably registered",
      );
      return readLifecycleChain(
        lifecycle,
        requests,
        request,
        order,
        attemptNumber,
      );
    }
    await launchJudgeWrapper(preDispatch, lifecycle);
    maybeCrashJudgeForTest("after-process", requests.executionMode);
    chain = readLifecycleChain(
      lifecycle,
      requests,
      request,
      order,
      attemptNumber,
    );
  }

  if (!chain.gate) {
    if (!managedProcessIsActive(chain.processReceipt)) {
      writeInterruptedOutcome(
        preDispatch,
        chain.processReceipt,
        null,
        lifecycle.outcome,
        "judge wrapper exited before dispatch authorization",
      );
      return readLifecycleChain(
        lifecycle,
        requests,
        request,
        order,
        attemptNumber,
      );
    }
    authorizeJudgeDispatch(preDispatch, chain.processReceipt, lifecycle.gate);
    maybeCrashJudgeForTest("after-gate", requests.executionMode);
    chain = readLifecycleChain(
      lifecycle,
      requests,
      request,
      order,
      attemptNumber,
    );
  }

  const deadline =
    performance.now() + effectiveJudgeTimeoutMs(requests.executionMode) + 5_000;
  while (!existsSync(lifecycle.outcome) && performance.now() < deadline) {
    if (!managedProcessIsActive(chain.processReceipt)) {
      await wait(100);
      break;
    }
    await wait(20);
  }
  if (!existsSync(lifecycle.outcome)) {
    if (managedProcessIsActive(chain.processReceipt)) {
      fail(
        `${order} judge wrapper is still active without an outcome; resume later`,
      );
    }
    writeInterruptedOutcome(
      preDispatch,
      chain.processReceipt,
      chain.gate,
      lifecycle.outcome,
      "judge wrapper exited after authorization without a durable outcome",
    );
  }
  maybeCrashJudgeForTest("after-outcome", requests.executionMode);
  return readLifecycleChain(lifecycle, requests, request, order, attemptNumber);
}

function validateAttempt(
  paths,
  attempt,
  requests,
  request,
  order,
  attemptNumber,
) {
  const retryableFailures = new Set(["timeout", "non-json", "schema-invalid"]);
  const chain = readLifecycleChain(
    attemptPaths(paths, order, attemptNumber),
    requests,
    request,
    order,
    attemptNumber,
  );
  if (!chain.outcome) fail(`${order} attempt has no durable process outcome`);
  const derived = attemptResult(outcomeAsCall(chain.outcome));
  const identityMatches =
    sameValue(attempt.definitionRef, DEFINITION_REF) &&
    attempt.trialId === requests.trialId &&
    attempt.subject === requests.subject &&
    attempt.baseSha === requests.baseSha &&
    attempt.executionMode === requests.executionMode &&
    attempt.requestSetDigest === requests.contentDigest &&
    attempt.payloadDigest === request.payloadDigest &&
    attempt.order === order &&
    attempt.attempt === attemptNumber &&
    attempt.preDispatchDigest === chain.preDispatch.contentDigest &&
    attempt.processDigest === (chain.processReceipt?.contentDigest ?? null) &&
    attempt.outcomeDigest === chain.outcome.contentDigest &&
    sameValue(attempt.argv, [
      chain.preDispatch.executable,
      ...chain.preDispatch.argv,
    ]) &&
    attempt.judgeModel === JUDGE_MODEL &&
    attempt.sidekickEnabled === false &&
    attempt.startedAt === chain.outcome.startedAt &&
    attempt.endedAt === chain.outcome.endedAt &&
    attempt.startedMonotonicNs === chain.outcome.startedMonotonicNs &&
    attempt.endedMonotonicNs === chain.outcome.endedMonotonicNs &&
    attempt.durationMs === chain.outcome.durationMs &&
    attempt.exitCode === chain.outcome.exitCode &&
    attempt.signal === chain.outcome.signal &&
    attempt.timedOut === chain.outcome.timedOut &&
    sameValue(attempt.stdout, chain.outcome.stdout) &&
    sameValue(attempt.stderr, chain.outcome.stderr) &&
    attempt.outcome === (derived.ok ? "valid" : "failed") &&
    attempt.retryable === (derived.ok ? false : derived.retryable) &&
    attempt.failureClass === (derived.ok ? null : derived.failureClass) &&
    sameValue(attempt.response, derived.ok ? derived.response : null) &&
    attempt.costUsd === (derived.costUsd ?? null) &&
    (attempt.costUsd === null ||
      (typeof attempt.costUsd === "number" &&
        Number.isFinite(attempt.costUsd) &&
        attempt.costUsd >= 0));
  if (!identityMatches) {
    fail(`existing ${order} attempt is not bound to the frozen request`);
  }
  validateCapturedStream(attempt.stdout, `${order} stdout`);
  validateCapturedStream(attempt.stderr, `${order} stderr`);
  if (attempt.outcome === "valid") {
    if (
      !validateResponse(attempt.response) ||
      attempt.retryable !== false ||
      attempt.failureClass !== null
    ) {
      fail(`existing ${order} valid attempt is malformed`);
    }
    return attempt;
  }
  if (
    attempt.outcome !== "failed" ||
    typeof attempt.failureClass !== "string" ||
    attempt.retryable !== retryableFailures.has(attempt.failureClass)
  ) {
    fail(`existing ${order} failed attempt has an invalid retry policy`);
  }
  return attempt;
}

function lifecycleExists(lifecycle) {
  return Object.values(lifecycle).some((path) => existsSync(path));
}

function assertAttemptCap(paths, order) {
  const root = join(paths.judgingRoot, order);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const match =
      /^attempt-(\d+)(?:\.(?:pre-dispatch|process|gate|outcome))?\.json$/.exec(
        name,
      );
    if (match && Number(match[1]) > MAX_ATTEMPTS) {
      fail(`${order} judge call cap was exceeded by ${name}`);
    }
  }
}

async function completeOrder(paths, requests, order) {
  const request = requests.requests[order];
  assertAttemptCap(paths, order);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const lifecycle = attemptPaths(paths, order, attempt);
    if (existsSync(lifecycle.attempt)) {
      const existing = validateAttempt(
        paths,
        readAttempt(lifecycle.attempt),
        requests,
        request,
        order,
        attempt,
      );
      if (existing.outcome === "valid") return existing;
      if (existing.retryable !== true) return existing;
      continue;
    }
    for (let future = attempt + 1; future <= MAX_ATTEMPTS; future += 1) {
      if (lifecycleExists(attemptPaths(paths, order, future))) {
        fail(`${order} judge attempt receipts contain a gap before ${future}`);
      }
    }
    const chain = await completeDurableCall(
      paths,
      requests,
      request,
      order,
      attempt,
    );
    const outcome = attemptResult(outcomeAsCall(chain.outcome));
    const receipt = writeImmutableReceipt(lifecycle.attempt, {
      schemaVersion: SCHEMA_VERSION,
      kind: "Gate2702JudgeAttempt",
      definitionRef: DEFINITION_REF,
      trialId: requests.trialId,
      subject: requests.subject,
      baseSha: requests.baseSha,
      executionMode: requests.executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      order,
      attempt,
      preDispatchDigest: chain.preDispatch.contentDigest,
      processDigest: chain.processReceipt?.contentDigest ?? null,
      outcomeDigest: chain.outcome.contentDigest,
      argv: [chain.preDispatch.executable, ...chain.preDispatch.argv],
      judgeModel: JUDGE_MODEL,
      sidekickEnabled: false,
      startedAt: chain.outcome.startedAt,
      endedAt: chain.outcome.endedAt,
      startedMonotonicNs: chain.outcome.startedMonotonicNs,
      endedMonotonicNs: chain.outcome.endedMonotonicNs,
      durationMs: chain.outcome.durationMs,
      exitCode: chain.outcome.exitCode,
      signal: chain.outcome.signal,
      timedOut: chain.outcome.timedOut,
      stdout: chain.outcome.stdout,
      stderr: chain.outcome.stderr,
      outcome: outcome.ok ? "valid" : "failed",
      retryable: outcome.ok ? false : outcome.retryable,
      failureClass: outcome.ok ? null : outcome.failureClass,
      response: outcome.ok ? outcome.response : null,
      costUsd: outcome.costUsd ?? null,
    });
    if (outcome.ok || !outcome.retryable) return receipt;
  }
  return validateAttempt(
    paths,
    readAttempt(attemptPaths(paths, order, MAX_ATTEMPTS).attempt),
    requests,
    request,
    order,
    MAX_ATTEMPTS,
  );
}

function canonicalWinner(attempt, request) {
  if (attempt.outcome !== "valid") return null;
  if (attempt.response.winner === "tie") return "tie";
  return request.order[attempt.response.winner];
}

function validatedAttemptSequence(paths, requests, order, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_ATTEMPTS) {
    fail(`${order} judge result has an invalid attempt count`);
  }
  assertAttemptCap(paths, order);
  const request = requests.requests[order];
  const attempts = Array.from({ length: count }, (_, index) => {
    const attemptNumber = index + 1;
    const lifecycle = attemptPaths(paths, order, attemptNumber);
    if (!existsSync(lifecycle.attempt)) {
      fail(`${order} judge result references a missing attempt`);
    }
    return validateAttempt(
      paths,
      readAttempt(lifecycle.attempt),
      requests,
      request,
      order,
      attemptNumber,
    );
  });
  for (const attempt of attempts.slice(0, -1)) {
    if (attempt.outcome !== "failed" || attempt.retryable !== true) {
      fail(`${order} judge result continued after a terminal attempt`);
    }
  }
  const terminal = attempts.at(-1);
  if (
    terminal.outcome !== "valid" &&
    terminal.retryable === true &&
    terminal.attempt < MAX_ATTEMPTS
  ) {
    fail(`${order} judge result stopped before its fixed retry cap`);
  }
  for (let future = count + 1; future <= MAX_ATTEMPTS; future += 1) {
    if (lifecycleExists(attemptPaths(paths, order, future))) {
      fail(`${order} judge result omits a later attempt`);
    }
  }
  return attempts;
}

function resultBody(input, requests, forwardAttempts, swappedAttempts) {
  const forward = forwardAttempts.at(-1);
  const swapped = swappedAttempts.at(-1);
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
    executionMode: input.executionMode,
    judgeInputDigest: input.contentDigest,
    requestSetDigest: requests.contentDigest,
    attempts: {
      forward: forwardAttempts.map((attempt) => ({
        attempt: attempt.attempt,
        contentDigest: attempt.contentDigest,
      })),
      swapped: swappedAttempts.map((attempt) => ({
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

function finalize(paths, input, requests, forward, swapped) {
  if (existsSync(paths.result)) {
    return validateExistingResult(
      paths,
      readReceipt(paths.result, "Gate2702JudgeResult"),
      { trial: input.trialId, subject: input.subject },
      input,
      requests,
    );
  }
  const forwardAttempts = validatedAttemptSequence(
    paths,
    requests,
    "forward",
    forward.attempt,
  );
  const swappedAttempts = validatedAttemptSequence(
    paths,
    requests,
    "swapped",
    swapped.attempt,
  );
  return writeImmutableReceipt(
    paths.result,
    resultBody(input, requests, forwardAttempts, swappedAttempts),
  );
}

function resultExitCode(result) {
  return result.state === "failed" ? 2 : 0;
}

function validateExistingResult(paths, result, options, input, requests) {
  if (
    !sameValue(result.definitionRef, DEFINITION_REF) ||
    result.trialId !== options.trial ||
    result.subject !== options.subject ||
    result.executionMode !== input.executionMode ||
    !["agreed", "tie", "disagreement", "failed"].includes(result.state)
  ) {
    fail("existing judge result does not match the selected C5 pair");
  }
  for (const order of ["forward", "swapped"]) {
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
          !/^sha256:[0-9a-f]{64}$/.test(entry.contentDigest ?? ""),
      )
    ) {
      fail("existing judge result has an invalid attempt manifest");
    }
  }
  const forwardAttempts = validatedAttemptSequence(
    paths,
    requests,
    "forward",
    result.attempts.forward.length,
  );
  const swappedAttempts = validatedAttemptSequence(
    paths,
    requests,
    "swapped",
    result.attempts.swapped.length,
  );
  const expected = resultBody(
    input,
    requests,
    forwardAttempts,
    swappedAttempts,
  );
  const actual = { ...result };
  delete actual.contentDigest;
  if (!sameValue(actual, expected)) {
    fail("existing judge result does not match its frozen evidence");
  }
  return result;
}

async function main() {
  if (process.env.CHD_EXPERIMENT_2702 !== "1") {
    fail("gate-2702 judge is opt-in; set CHD_EXPERIMENT_2702=1 to enable it");
  }
  if (process.argv[2] === "__dispatch") {
    await internalJudgeDispatch(process.argv.slice(3));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const paths = trialPaths(options);
  if (existsSync(paths.result)) {
    const input = validateFrozenInput(
      paths,
      readReceipt(paths.input, "Gate2702JudgeInput"),
      options,
    );
    const requests = validateFrozenRequests(
      readReceipt(paths.requests, "Gate2702JudgeRequests"),
      input,
    );
    const result = validateExistingResult(
      paths,
      readReceipt(paths.result, "Gate2702JudgeResult"),
      options,
      input,
      requests,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = resultExitCode(result);
    return;
  }
  if (options.command === "resume" && !existsSync(paths.requests)) {
    fail("resume requires an existing frozen C5 judge request set");
  }
  const input = validateFrozenInput(
    paths,
    options.command === "resume"
      ? readReceipt(paths.input, "Gate2702JudgeInput")
      : freezeInput(paths, options),
    options,
  );
  const requests =
    options.command === "resume"
      ? readReceipt(paths.requests, "Gate2702JudgeRequests")
      : buildRequests(paths, input);
  validateFrozenRequests(requests, input);
  const forward = await completeOrder(paths, requests, "forward");
  const swapped = await completeOrder(paths, requests, "swapped");
  const result = finalize(paths, input, requests, forward, swapped);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = resultExitCode(result);
}

main().catch((error) => {
  process.stderr.write(`gate-2702 judge: ${error.message}\n`);
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
