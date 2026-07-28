import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNTING = join(HERE, "accounting.mjs");
const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest: DEFINITION_DIGEST,
};

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function receiptDigest(receipt) {
  const undigested = { ...receipt };
  delete undigested.contentDigest;
  return sha256(JSON.stringify(canonicalValue(undigested)));
}

function writeReceipt(path, receipt) {
  const digested = { ...receipt, contentDigest: receiptDigest(receipt) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(digested, null, 2)}\n`, "utf8");
  return digested;
}

function createEvidenceFixture({
  treatmentId = "haiku-solo",
  workerResult = {
    session_id: "22222222-2222-4222-8222-222222222222",
    total_cost_usd: 0,
    result: "private worker answer that must not enter accounting evidence",
  },
  workerStdout,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-accounting-"));
  const stateRoot = join(root, "state");
  const trialId = randomUUID();
  const baseSha = "a".repeat(40);
  const trialRoot = join(
    stateRoot,
    DEFINITION_DIGEST.replace(":", "-"),
    trialId,
  );
  const runDir = join(
    trialRoot,
    "runs",
    "issue-2760",
    treatmentId,
    "attempt-1",
  );
  const stdout = workerStdout ?? `${JSON.stringify(workerResult)}\n`;
  const stdoutPath = join(runDir, "stdout.log");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(stdoutPath, stdout, "utf8");
  writeFileSync(join(runDir, "stderr.log"), "", "utf8");

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
    runDir,
    worktreePath: join(
      trialRoot,
      "worktrees",
      `issue-2760.${treatmentId}.attempt-1`,
    ),
  });
  const terminal = writeReceipt(join(runDir, "terminal.json"), {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId,
    subject: 2760,
    treatmentId,
    attempt: 1,
    baseSha,
    outcome: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    endedAt: "2026-07-20T22:00:00.000Z",
  });
  const classification = writeReceipt(join(runDir, "classification.json"), {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preflightDigest: sha256("fixture preflight"),
    terminalDigest: terminal.contentDigest,
    trialId,
    subject: 2760,
    treatmentId,
    attempt: 1,
    baseSha,
    status: "succeeded",
    eligible: true,
    workerArtifacts: {
      stdout: {
        byteLength: Buffer.byteLength(stdout),
        contentDigest: sha256(stdout),
        capturedBytes: Buffer.byteLength(stdout),
        truncated: false,
      },
      stderr: {
        byteLength: 0,
        contentDigest: sha256(""),
        capturedBytes: 0,
        truncated: false,
      },
    },
    checkResults: [],
    retry: { authorized: false, reason: "genuine-result", maximumAttempt: 2 },
  });
  writeReceipt(join(trialRoot, "trial.json"), {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId,
    repository: "shpwrck/claude-history-dashboard",
    baseSha,
    registrations: [registration],
  });

  return {
    root,
    stateRoot,
    trialId,
    trialRoot,
    runDir,
    registration,
    terminal,
    classification,
    workerResult,
    env: {
      ...process.env,
      HOME: root,
      CHD_EXPERIMENT_2702: "1",
      CHD_EXPERIMENT_2702_SIDEKICK_MODEL_ID: "claude-sonnet-5",
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rewriteClassification(fixture, overrides) {
  const classification = writeReceipt(
    join(fixture.runDir, "classification.json"),
    {
      ...fixture.classification,
      ...overrides,
      contentDigest: undefined,
    },
  );
  fixture.classification = classification;
  return classification;
}

function collectArgs(
  fixture,
  treatmentId = fixture.registration.treatmentId,
  attempt = 1,
) {
  return [
    ACCOUNTING,
    "collect",
    "--trial",
    fixture.trialId,
    "--subject",
    "2760",
    "--treatment",
    treatmentId,
    "--attempt",
    String(attempt),
    "--state-root",
    fixture.stateRoot,
  ];
}

function collect(
  fixture,
  treatmentId = fixture.registration.treatmentId,
  attempt = 1,
) {
  return spawnSync(
    process.execPath,
    collectArgs(fixture, treatmentId, attempt),
    {
      encoding: "utf8",
      env: fixture.env,
    },
  );
}

function addRetryAttempt(fixture, workerResult) {
  const attempt1Classification = writeReceipt(
    join(fixture.runDir, "classification.json"),
    {
      ...fixture.classification,
      contentDigest: undefined,
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    },
  );
  fixture.classification = attempt1Classification;

  const runDir = join(
    fixture.trialRoot,
    "runs",
    "issue-2760",
    fixture.registration.treatmentId,
    "attempt-2",
  );
  mkdirSync(runDir, { recursive: true });
  const stdout = `${JSON.stringify(workerResult)}\n`;
  writeFileSync(join(runDir, "stdout.log"), stdout);
  writeFileSync(join(runDir, "stderr.log"), "");
  const retryOf = {
    attempt: 1,
    registrationDigest: fixture.registration.contentDigest,
    classificationDigest: attempt1Classification.contentDigest,
  };
  const registration = writeReceipt(join(runDir, "registration.json"), {
    schemaVersion: 1,
    kind: "Gate2702ArmRegistration",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject: 2760,
    subjectRef: "github:shpwrck/claude-history-dashboard#2760",
    treatmentId: fixture.registration.treatmentId,
    attempt: 2,
    baseSha: fixture.registration.baseSha,
    runDir,
    worktreePath: join(
      fixture.trialRoot,
      "worktrees",
      `issue-2760.${fixture.registration.treatmentId}.attempt-2`,
    ),
    retryOf,
  });
  const terminal = writeReceipt(join(runDir, "terminal.json"), {
    schemaVersion: 1,
    kind: "Gate2702Terminal",
    definitionRef: DEFINITION_REF,
    trialId: fixture.trialId,
    subject: 2760,
    treatmentId: fixture.registration.treatmentId,
    attempt: 2,
    baseSha: fixture.registration.baseSha,
    outcome: "exited",
    exitCode: 0,
    signal: null,
    timedOut: false,
    processGroupQuiescent: true,
    endedAt: "2026-07-20T22:01:00.000Z",
  });
  const classification = writeReceipt(join(runDir, "classification.json"), {
    schemaVersion: 1,
    kind: "Gate2702ArmClassification",
    definitionRef: DEFINITION_REF,
    registrationDigest: registration.contentDigest,
    preflightDigest: sha256("fixture preflight"),
    terminalDigest: terminal.contentDigest,
    trialId: fixture.trialId,
    subject: 2760,
    treatmentId: fixture.registration.treatmentId,
    attempt: 2,
    baseSha: fixture.registration.baseSha,
    status: "succeeded",
    eligible: true,
    workerArtifacts: {
      stdout: {
        byteLength: Buffer.byteLength(stdout),
        contentDigest: sha256(stdout),
        capturedBytes: Buffer.byteLength(stdout),
        truncated: false,
      },
      stderr: {
        byteLength: 0,
        contentDigest: sha256(""),
        capturedBytes: 0,
        truncated: false,
      },
    },
    checkResults: [],
    retry: { authorized: false, reason: "genuine-result", maximumAttempt: 2 },
  });
  const registrations = [
    {
      subject: 2760,
      treatmentId: fixture.registration.treatmentId,
      attempt: 2,
      registrationDigest: registration.contentDigest,
      retryOf,
      worktreePath: registration.worktreePath,
    },
  ];
  const registrationSetDigest = sha256(
    JSON.stringify(canonicalValue(registrations)),
  );
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
      baseSha: fixture.registration.baseSha,
      registrationSetDigest,
      registrations,
    },
  );
  return {
    runDir,
    workerResult,
    registration,
    terminal,
    classification,
    retrySet,
  };
}

function writeSidekickLedger(fixture, rows) {
  const sessionDir = join(
    fixture.root,
    ".sidekick",
    fixture.workerResult.session_id,
  );
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, "__sidekick.jsonl");
  writeFileSync(
    path,
    rows.length === 0
      ? ""
      : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return path;
}

test("the C5 accounting collector is inert without its explicit opt-in", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-accounting-off-"));
  const stateRoot = join(root, "state");
  try {
    const result = spawnSync(
      process.execPath,
      [
        ACCOUNTING,
        "collect",
        "--trial",
        "11111111-1111-4111-8111-111111111111",
        "--subject",
        "2760",
        "--treatment",
        "haiku-solo",
        "--attempt",
        "1",
        "--state-root",
        stateRoot,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CHD_EXPERIMENT_2702: "0", HOME: root },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHD_EXPERIMENT_2702=1/);
    assert.equal(existsSync(stateRoot), false);
    assert.equal(existsSync(join(root, ".sidekick")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero-cost control records evidence-backed Sidekick zeros without reading a ledger", () => {
  const fixture = createEvidenceFixture();
  try {
    const sidekickSession = join(
      fixture.root,
      ".sidekick",
      fixture.workerResult.session_id,
    );
    mkdirSync(sidekickSession, { recursive: true });
    symlinkSync(
      join(fixture.root, "must-not-be-read"),
      join(sidekickSession, "__sidekick.jsonl"),
    );

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.kind, "Gate2702Accounting");
    assert.equal(receipt.contentDigest, receiptDigest(receipt));
    assert.equal(
      receipt.registrationDigest,
      fixture.registration.contentDigest,
    );
    assert.equal(receipt.terminalDigest, fixture.terminal.contentDigest);
    assert.equal(
      receipt.classificationDigest,
      fixture.classification.contentDigest,
    );
    assert.equal(receipt.workerSessionId, fixture.workerResult.session_id);
    assert.equal(receipt.workerCostUsd, 0);
    assert.equal(receipt.sidekickCostUsd, 0);
    assert.equal(receipt.allInCostUsd, 0);
    assert.equal(receipt.sidekickTriggerCount, 0);
    assert.equal(receipt.sidekickPaidCallCount, 0);
    assert.equal(receipt.sidekickShippedInterventionCount, 0);
    assert.deepEqual(receipt.usage, { costUsd: 0 });
    assert.equal(receipt.bridgeEvidenceStatus, "eligible");
    assert.deepEqual(receipt.exclusionReasons, []);
    assert.equal(
      JSON.stringify(receipt).includes(fixture.workerResult.result),
      false,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.runDir, "accounting.json"), "utf8")),
      receipt,
    );
  } finally {
    fixture.cleanup();
  }
});

test("known accounting survives a budget-cancelled terminal classification", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      session_id: randomUUID(),
      total_cost_usd: 0.75,
    },
  });
  try {
    const classification = rewriteClassification(fixture, {
      status: "cancelled",
      eligible: false,
      checkResults: [],
      error: {
        code: "budget-exhausted",
        message: "worker reached its pre-registered budget ceiling",
      },
      retry: {
        authorized: false,
        reason: "budget-exhausted",
        maximumAttempt: 2,
      },
    });
    writeSidekickLedger(fixture, []);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(classification.eligible, false);
    assert.equal(receipt.classificationDigest, classification.contentDigest);
    assert.equal(receipt.workerCostUsd, 0.75);
    assert.equal(receipt.sidekickCostUsd, 0);
    assert.equal(receipt.allInCostUsd, 0.75);
    assert.deepEqual(receipt.usage, { costUsd: 0.75 });
    assert.equal(receipt.bridgeEvidenceStatus, "eligible");
  } finally {
    fixture.cleanup();
  }
});

test("known accounting survives an eligible objective-check failure", () => {
  const fixture = createEvidenceFixture({
    workerResult: {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: randomUUID(),
      total_cost_usd: 0.4,
    },
  });
  try {
    const classification = rewriteClassification(fixture, {
      status: "succeeded",
      eligible: true,
      checkResults: [
        {
          checkId: "checks/gate-2702-vitest",
          status: "failed",
          exitCode: 1,
          signal: null,
          timedOut: false,
        },
      ],
      retry: {
        authorized: false,
        reason: "genuine-result",
        maximumAttempt: 2,
      },
    });

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(classification.checkResults[0].status, "failed");
    assert.equal(receipt.classificationDigest, classification.contentDigest);
    assert.equal(receipt.workerCostUsd, 0.4);
    assert.equal(receipt.allInCostUsd, 0.4);
    assert.deepEqual(receipt.usage, { costUsd: 0.4 });
    assert.equal(receipt.bridgeEvidenceStatus, "eligible");
  } finally {
    fixture.cleanup();
  }
});

test("a settled treatment ledger separates triggers, paid calls, and shipped interventions", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "33333333-3333-4333-8333-333333333333",
      total_cost_usd: 0.75,
      result: "private worker output",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      { model: "engage", ts: "2026-07-20T22:00:00.000Z", costUsd: 0 },
      {
        model: "queued",
        trigger: "push-or-pr",
        jobId: "r5-10",
        turn: 5,
        ts: "2026-07-20T22:00:01.000Z",
        costUsd: 0,
      },
      {
        model: "claude-sonnet-5",
        trigger: "push-or-pr",
        jobId: "r5-10",
        turn: 5,
        ts: "2026-07-20T22:00:02.000Z",
        costUsd: 0.25,
        note: "private review note",
      },
      {
        model: "stop-review",
        trigger: "final-review",
        turn: 9,
        skipped: "empty-tail",
        ts: "2026-07-20T22:00:03.000Z",
        costUsd: 0,
      },
      {
        model: "delivery",
        turn: 10,
        reviewedTurn: 5,
        ts: "2026-07-20T22:00:04.000Z",
        shipped: true,
        costUsd: 0,
        note: "private delivered note",
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, 0.75);
    assert.equal(receipt.sidekickCostUsd, 0.25);
    assert.equal(receipt.allInCostUsd, 1);
    assert.equal(receipt.sidekickTriggerCount, 2);
    assert.equal(receipt.sidekickPaidCallCount, 1);
    assert.equal(receipt.sidekickShippedInterventionCount, 1);
    assert.deepEqual(receipt.usage, { costUsd: 1 });
    assert.equal(receipt.sourceEvidence.sidekick.rowDigests.length, 5);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes("private review note"), false);
    assert.equal(serialized.includes("private delivered note"), false);
    assert.equal(receipt.contentDigest, receiptDigest(receipt));
  } finally {
    fixture.cleanup();
  }
});

test("identical Sidekick lifecycle rows count once", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "44444444-4444-4444-8444-444444444444",
      total_cost_usd: 0,
      result: "private",
    },
  });
  try {
    const queued = {
      model: "queued",
      trigger: "push-or-pr",
      jobId: "r4-4",
      turn: 4,
      ts: "2026-07-20T22:00:00.000Z",
      costUsd: 0,
    };
    const completed = {
      model: "claude-sonnet-5",
      trigger: "push-or-pr",
      jobId: "r4-4",
      turn: 4,
      ts: "2026-07-20T22:00:01.000Z",
      costUsd: 0.25,
      note: "private",
    };
    const stopped = {
      model: "stop-review",
      trigger: "final-review",
      turn: 8,
      ts: "2026-07-20T22:00:02.000Z",
      costUsd: 0.1,
      shipped: true,
      note: "private",
    };
    const delivered = {
      model: "delivery",
      turn: 9,
      reviewedTurn: 4,
      ts: "2026-07-20T22:00:03.000Z",
      costUsd: 0,
      shipped: true,
      note: "private",
    };
    writeSidekickLedger(fixture, [
      queued,
      queued,
      completed,
      completed,
      stopped,
      stopped,
      delivered,
      delivered,
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 2);
    assert.equal(receipt.sidekickPaidCallCount, 2);
    assert.equal(receipt.sidekickShippedInterventionCount, 2);
    assert.equal(receipt.sidekickCostUsd, 0.35);
    assert.equal(receipt.allInCostUsd, 0.35);
    assert.equal(receipt.sourceEvidence.sidekick.rowDigests.length, 8);
  } finally {
    fixture.cleanup();
  }
});

test("conflicting rows for one Sidekick lifecycle identity become excluded unknown evidence", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "55555555-5555-4555-8555-555555555555",
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "stop-review",
        trigger: "final-review",
        turn: 12,
        ts: "2026-07-20T22:00:00.000Z",
        costUsd: 0.1,
        shipped: false,
      },
      {
        model: "stop-review",
        trigger: "final-review",
        turn: 12,
        ts: "2026-07-20T22:00:01.000Z",
        costUsd: 0.2,
        shipped: true,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, 0.5);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.deepEqual(receipt.exclusionReasons, ["sidekick-lifecycle-conflict"]);
    assert.equal("usage" in receipt, false);
    assert.equal(existsSync(join(fixture.runDir, "accounting.json")), true);
  } finally {
    fixture.cleanup();
  }
});

test("a missing exact-session ledger stays unknown and a different session is ignored", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "66666666-6666-4666-8666-666666666666",
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    const otherSession = join(
      fixture.root,
      ".sidekick",
      "77777777-7777-4777-8777-777777777777",
    );
    mkdirSync(otherSession, { recursive: true });
    writeFileSync(
      join(otherSession, "__sidekick.jsonl"),
      `${JSON.stringify({
        model: "stop-review",
        trigger: "final-review",
        turn: 1,
        costUsd: 99,
        shipped: true,
      })}\n`,
    );

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, 0.5);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.deepEqual(receipt.exclusionReasons, ["sidekick-ledger-missing"]);
    assert.deepEqual(receipt.observations.workerCostUsd.unknownReasons, []);
    assert.deepEqual(receipt.observations.sidekickCostUsd.unknownReasons, [
      "sidekick-ledger-missing",
    ]);
    assert.equal("usage" in receipt, false);
    assert.equal(
      receipt.sourceEvidence.sidekick.relativePath,
      `${fixture.workerResult.session_id}/__sidekick.jsonl`,
    );
    assert.equal(receipt.sourceEvidence.sidekick.status, "missing");
  } finally {
    fixture.cleanup();
  }
});

test("a malformed worker terminal result becomes excluded bridge evidence without probing Sidekick", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: null,
    workerStdout: "not-json\n",
  });
  try {
    symlinkSync(join(fixture.root, "outside"), join(fixture.root, ".sidekick"));

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerSessionId, null);
    assert.equal(receipt.workerCostUsd, null);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.equal(
      receipt.exclusionReasons.includes("worker-result-malformed"),
      true,
    );
    assert.equal(
      receipt.exclusionReasons.includes("worker-session-id-unknown"),
      true,
    );
    assert.equal("usage" in receipt, false);
  } finally {
    fixture.cleanup();
  }
});

test("a malformed Sidekick ledger row is retained by digest but all Sidekick values stay unknown", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "88888888-8888-4888-8888-888888888888",
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    const sessionDir = join(
      fixture.root,
      ".sidekick",
      fixture.workerResult.session_id,
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "__sidekick.jsonl"),
      `${JSON.stringify({ model: "engage", costUsd: 0 })}\nnot-json\n`,
    );

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, 0.5);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.deepEqual(receipt.exclusionReasons, ["sidekick-ledger-malformed"]);
    assert.equal(receipt.sourceEvidence.sidekick.rowDigests.length, 2);
    assert.equal(
      receipt.sourceEvidence.sidekick.rowDigests[1].lifecycle,
      "malformed",
    );
    assert.equal("usage" in receipt, false);
  } finally {
    fixture.cleanup();
  }
});

test("a semantically malformed Sidekick lifecycle row becomes unknown evidence", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      { model: "stop-review", turn: 1, costUsd: 0 },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.deepEqual(receipt.exclusionReasons, ["sidekick-ledger-malformed"]);
    assert.equal(
      receipt.sourceEvidence.sidekick.rowDigests[0].lifecycle,
      "untrusted",
    );
  } finally {
    fixture.cleanup();
  }
});

test("an unrecognized Sidekick model row makes accounting unknown rather than zero", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.25,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [{ model: "future-review", costUsd: 1 }]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, 0.25);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.deepEqual(receipt.exclusionReasons, [
      "sidekick-lifecycle-unrecognized",
    ]);
    assert.equal("usage" in receipt, false);
    assert.equal(
      receipt.sourceEvidence.sidekick.rowDigests[0].lifecycle,
      "unrecognized",
    );
  } finally {
    fixture.cleanup();
  }
});

test("unknown Sidekick row shapes fail closed instead of disappearing", () => {
  const rows = [
    { costUsd: 1 },
    { model: null, phase: "future", costUsd: 1 },
    { model: "engage", costUsd: 1 },
    {
      model: "stop-review",
      turn: 1,
      trigger: "final-review",
      skipped: "future-skip-mode",
      costUsd: 0,
    },
    {
      model: "claude-sonnet-5",
      jobId: 42,
      turn: 1,
      trigger: "destructive",
      error: "unknown numeric job identity",
      costUsd: 1,
    },
  ];
  for (const row of rows) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0.25,
        result: "private",
      },
    });
    try {
      writeSidekickLedger(fixture, [row]);

      const result = collect(fixture);
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.sidekickCostUsd, null);
      assert.equal(receipt.allInCostUsd, null);
      assert.equal(receipt.sidekickTriggerCount, null);
      assert.equal(receipt.sidekickPaidCallCount, null);
      assert.equal(receipt.sidekickShippedInterventionCount, null);
      assert.equal(receipt.bridgeEvidenceStatus, "excluded");
      assert.equal("usage" in receipt, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("zero-only Sidekick lifecycle rows cannot hide paid cost", () => {
  const ledgers = [
    [
      {
        model: "queued",
        jobId: "r4-20",
        turn: 4,
        trigger: "destructive",
        costUsd: 1,
      },
      {
        model: "claude-sonnet-5",
        jobId: "r4-20",
        turn: 4,
        trigger: "destructive",
        costUsd: 0,
      },
    ],
    [
      {
        model: "delivery",
        turn: 5,
        reviewedTurn: 4,
        shipped: true,
        costUsd: 1,
      },
    ],
    [
      {
        model: "stop-review",
        turn: 5,
        trigger: "final-review",
        skipped: "empty-tail",
        costUsd: 1,
      },
    ],
  ];
  for (const rows of ledgers) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0.25,
        result: "private",
      },
    });
    try {
      writeSidekickLedger(fixture, rows);

      const result = collect(fixture);
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.sidekickCostUsd, null);
      assert.equal(receipt.allInCostUsd, null);
      assert.equal(receipt.bridgeEvidenceStatus, "excluded");
      assert.equal("usage" in receipt, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("a paid-call zero is known while missing, null, and negative call costs exclude all-in cost", () => {
  const scenarios = [
    { label: "zero", cost: { costUsd: 0 }, expectedCost: 0 },
    { label: "missing", cost: {}, expectedCost: null },
    { label: "null", cost: { costUsd: null }, expectedCost: null },
    { label: "negative", cost: { costUsd: -0.1 }, expectedCost: null },
  ];

  for (const scenario of scenarios) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0,
        result: "private",
      },
    });
    try {
      writeSidekickLedger(fixture, [
        {
          model: "stop-review",
          trigger: "final-review",
          turn: 1,
          shipped: false,
          ...scenario.cost,
        },
      ]);

      const result = collect(fixture);
      assert.equal(result.status, 0, `${scenario.label}: ${result.stderr}`);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.sidekickTriggerCount, 1, scenario.label);
      assert.equal(receipt.sidekickPaidCallCount, 1, scenario.label);
      assert.equal(receipt.sidekickShippedInterventionCount, 0, scenario.label);
      assert.equal(
        receipt.sidekickCostUsd,
        scenario.expectedCost,
        scenario.label,
      );
      assert.equal(receipt.allInCostUsd, scenario.expectedCost, scenario.label);
      if (scenario.expectedCost === null) {
        assert.equal(receipt.bridgeEvidenceStatus, "excluded", scenario.label);
        assert.equal("usage" in receipt, false, scenario.label);
        assert.equal(
          receipt.exclusionReasons.includes("sidekick-cost-unknown"),
          true,
          scenario.label,
        );
      } else {
        assert.deepEqual(receipt.usage, { costUsd: 0 }, scenario.label);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test("async queue and completion rows that disagree on one job fail closed", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: "99999999-9999-4999-8999-999999999999",
      total_cost_usd: 0.25,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "queued",
        trigger: "push-or-pr",
        jobId: "r3-9",
        turn: 3,
        costUsd: 0,
      },
      {
        model: "claude-sonnet-5",
        trigger: "destructive",
        jobId: "r3-9",
        turn: 3,
        costUsd: 0.2,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.deepEqual(receipt.exclusionReasons, ["sidekick-lifecycle-conflict"]);
    assert.equal("usage" in receipt, false);
  } finally {
    fixture.cleanup();
  }
});

test("an async queue without a completion keeps the call outcome unknown", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.25,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "queued",
        trigger: "push-or-pr",
        jobId: "r3-9",
        turn: 3,
        costUsd: 0,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 1);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.deepEqual(receipt.exclusionReasons, [
      "sidekick-lifecycle-incomplete",
    ]);
    assert.deepEqual(
      receipt.observations.sidekickTriggerCount.unknownReasons,
      [],
    );
    assert.deepEqual(
      receipt.observations.sidekickPaidCallCount.unknownReasons,
      ["sidekick-lifecycle-incomplete"],
    );
    assert.equal("usage" in receipt, false);
  } finally {
    fixture.cleanup();
  }
});

test("an async completion without a queue cannot become accounting evidence", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.25,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "claude-sonnet-5",
        trigger: "push-or-pr",
        jobId: "orphan-completion",
        turn: 3,
        costUsd: 0.2,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 0);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.deepEqual(receipt.exclusionReasons, [
      "sidekick-lifecycle-incomplete",
    ]);
    assert.equal("usage" in receipt, false);
  } finally {
    fixture.cleanup();
  }
});

test("sanitized historical C5 lifecycles reproduce 2/2/0, 3/3/1, and 2/2/0", () => {
  const historical = [
    {
      expected: [2, 2, 0],
      rows: [
        { model: "engage", costUsd: 0 },
        {
          model: "queued",
          trigger: "push-or-pr",
          jobId: "r46-256",
          turn: 46,
          costUsd: 0,
        },
        {
          model: "claude-sonnet-5",
          trigger: "push-or-pr",
          jobId: "r46-256",
          turn: 46,
          costUsd: 0.8,
        },
        {
          model: "stop-review",
          trigger: "final-review",
          turn: 1,
          shipped: false,
          costUsd: 0.4,
        },
      ],
    },
    {
      expected: [3, 3, 1],
      rows: [
        { model: "engage", costUsd: 0 },
        {
          model: "queued",
          trigger: "push-or-pr",
          jobId: "r99-473",
          turn: 99,
          costUsd: 0,
        },
        {
          model: "stop-review",
          trigger: "final-review",
          turn: 100,
          shipped: true,
          costUsd: 0.5,
        },
        {
          model: "claude-sonnet-5",
          trigger: "push-or-pr",
          jobId: "r99-473",
          turn: 99,
          costUsd: 1.05,
        },
        {
          model: "queued",
          trigger: "push-or-pr",
          jobId: "r134-633",
          turn: 134,
          costUsd: 0,
        },
        {
          model: "claude-sonnet-5",
          trigger: "push-or-pr",
          jobId: "r134-633",
          turn: 134,
          costUsd: 0.69,
        },
      ],
    },
    {
      expected: [2, 2, 0],
      rows: [
        { model: "engage", costUsd: 0 },
        {
          model: "queued",
          trigger: "push-or-pr",
          jobId: "r69-347",
          turn: 69,
          costUsd: 0,
        },
        {
          model: "stop-review",
          trigger: "final-review",
          turn: 1,
          shipped: false,
          costUsd: 0.47,
        },
        {
          model: "claude-sonnet-5",
          trigger: "push-or-pr",
          jobId: "r69-347",
          turn: 69,
          costUsd: 1,
        },
      ],
    },
  ];

  for (const [index, example] of historical.entries()) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0.5,
        result: "sanitized private output",
      },
    });
    try {
      writeSidekickLedger(fixture, example.rows);
      const result = collect(fixture);
      assert.equal(
        result.status,
        0,
        `historical ${index + 1}: ${result.stderr}`,
      );
      const receipt = JSON.parse(result.stdout);
      assert.deepEqual(
        [
          receipt.sidekickTriggerCount,
          receipt.sidekickPaidCallCount,
          receipt.sidekickShippedInterventionCount,
        ],
        example.expected,
      );
      assert.equal("fires" in receipt, false);
      assert.equal("ships" in receipt, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("missing, null, negative, and malformed worker costs never become numeric all-in cost", () => {
  const costs = [
    { label: "missing", value: undefined },
    { label: "null", value: null },
    { label: "negative", value: -0.1 },
    { label: "malformed", value: "0.5" },
  ];
  for (const scenario of costs) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: scenario.value,
        result: "private",
      },
    });
    try {
      writeSidekickLedger(fixture, []);
      const result = collect(fixture);
      assert.equal(result.status, 0, `${scenario.label}: ${result.stderr}`);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.workerCostUsd, null, scenario.label);
      assert.equal(receipt.sidekickCostUsd, 0, scenario.label);
      assert.equal(receipt.allInCostUsd, null, scenario.label);
      assert.equal(receipt.sidekickTriggerCount, 0, scenario.label);
      assert.equal(receipt.sidekickPaidCallCount, 0, scenario.label);
      assert.equal(receipt.sidekickShippedInterventionCount, 0, scenario.label);
      assert.equal(receipt.bridgeEvidenceStatus, "excluded", scenario.label);
      assert.equal("usage" in receipt, false, scenario.label);
      assert.equal(
        receipt.exclusionReasons.includes("worker-cost-unknown"),
        true,
        scenario.label,
      );
      assert.deepEqual(
        receipt.observations.sidekickTriggerCount.unknownReasons,
        [],
        scenario.label,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("overflow and negative-zero costs never become eligible totals", () => {
  const sessionId = randomUUID();
  const negativeWorker = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: sessionId,
      total_cost_usd: 0,
      result: "private",
    },
    workerStdout: `{"session_id":"${sessionId}","total_cost_usd":-0,"result":"private"}\n`,
  });
  try {
    writeSidekickLedger(negativeWorker, []);
    const result = collect(negativeWorker);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.ok(receipt.exclusionReasons.includes("worker-cost-unknown"));
  } finally {
    negativeWorker.cleanup();
  }

  const negativeSidekick = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    const ledger = writeSidekickLedger(negativeSidekick, []);
    writeFileSync(
      ledger,
      '{"model":"sync","turn":1,"trigger":"cadence","costUsd":-0,"shipped":false}\n',
    );
    const result = collect(negativeSidekick);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.ok(receipt.exclusionReasons.includes("sidekick-cost-unknown"));
  } finally {
    negativeSidekick.cleanup();
  }

  const overflow = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: Number.MAX_VALUE,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(overflow, [
      {
        model: "sync",
        turn: 1,
        trigger: "cadence",
        costUsd: Number.MAX_VALUE,
        shipped: false,
      },
    ]);
    const result = collect(overflow);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.workerCostUsd, Number.MAX_VALUE);
    assert.equal(receipt.sidekickCostUsd, Number.MAX_VALUE);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.bridgeEvidenceStatus, "excluded");
    assert.ok(receipt.exclusionReasons.includes("all-in-cost-invalid"));
    assert.equal("usage" in receipt, false);
  } finally {
    overflow.cleanup();
  }
});

test("a bounded ledger cannot amplify past the fixed row limit", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(
      fixture,
      Array.from({ length: 4_097 }, () => ({ model: "engage", costUsd: 0 })),
    );
    const result = collect(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixed row limit/i);
    assert.equal(existsSync(join(fixture.runDir, "accounting.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("active, linked, special, and oversized Sidekick sources write no immutable receipt", () => {
  for (const unsafe of [
    "unsettled-job",
    "symlink",
    "special",
    "oversized",
  ]) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0.5,
        result: "private",
      },
    });
    try {
      const sessionDir = join(
        fixture.root,
        ".sidekick",
        fixture.workerResult.session_id,
      );
      mkdirSync(sessionDir, { recursive: true });
      const ledger = join(sessionDir, "__sidekick.jsonl");
      if (unsafe === "unsettled-job") {
        writeFileSync(ledger, "");
        writeFileSync(join(sessionDir, "review.job.json"), "{}\n");
      } else if (unsafe === "symlink") {
        symlinkSync(join(fixture.root, "outside-ledger"), ledger);
      } else if (unsafe === "special") {
        writeFileSync(ledger, "");
        const fifo = join(sessionDir, "unexpected.fifo");
        const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
      } else {
        writeFileSync(ledger, "x".repeat(4 * 1024 * 1024 + 1));
      }

      const result = collect(fixture);
      assert.notEqual(result.status, 0, unsafe);
      assert.equal(existsSync(join(fixture.runDir, "accounting.json")), false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("a completed pending verdict is known paid work but not a shipped intervention", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      { model: "queued", jobId: "r1", trigger: "cadence", costUsd: 0 },
      {
        model: "claude-sonnet-5",
        jobId: "r1",
        turn: 1,
        trigger: "cadence",
        costUsd: 0.2,
      },
    ]);
    const pending = join(
      fixture.root,
      ".sidekick",
      fixture.workerResult.session_id,
      "pending",
    );
    mkdirSync(pending);
    writeFileSync(
      join(pending, "r1.json"),
      JSON.stringify({ severity: "concern", note: "private", costUsd: 0.2 }),
    );

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, 0.2);
    assert.equal(receipt.allInCostUsd, 0.7);
    assert.equal(receipt.sidekickTriggerCount, 1);
    assert.equal(receipt.sidekickPaidCallCount, 1);
    assert.equal(receipt.sidekickShippedInterventionCount, 0);
    assert.equal(receipt.bridgeEvidenceStatus, "eligible");
  } finally {
    fixture.cleanup();
  }
});

test("lifecycle-specific shipped fields fail closed", () => {
  const scenarios = [
    {
      label: "missing delivery flag",
      rows: [{ model: "delivery", reviewedTurn: 1, costUsd: 0 }],
    },
    {
      label: "non-boolean sync flag",
      rows: [
        {
          model: "sync",
          turn: 1,
          trigger: "cadence",
          costUsd: 0.2,
          shipped: "true",
        },
      ],
    },
    {
      label: "forged async ship",
      rows: [
        { model: "queued", jobId: "r1", trigger: "cadence", costUsd: 0 },
        {
          model: "claude-sonnet-5",
          jobId: "r1",
          turn: 1,
          trigger: "cadence",
          costUsd: 0.2,
          shipped: true,
        },
      ],
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createEvidenceFixture({
      treatmentId: "haiku-sonnet-sidekick",
      workerResult: {
        session_id: randomUUID(),
        total_cost_usd: 0.5,
        result: "private",
      },
    });
    try {
      writeSidekickLedger(fixture, scenario.rows);
      const result = collect(fixture);
      assert.equal(result.status, 0, `${scenario.label}: ${result.stderr}`);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.sidekickCostUsd, null, scenario.label);
      assert.equal(receipt.sidekickTriggerCount, null, scenario.label);
      assert.equal(receipt.sidekickPaidCallCount, null, scenario.label);
      assert.equal(
        receipt.sidekickShippedInterventionCount,
        null,
        scenario.label,
      );
      assert.equal(receipt.allInCostUsd, null, scenario.label);
      assert.equal(receipt.bridgeEvidenceStatus, "excluded", scenario.label);
      assert.equal(
        receipt.exclusionReasons.includes("sidekick-ledger-malformed"),
        true,
        scenario.label,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("an append race during the settle window writes no accounting receipt", async () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.5,
      result: "private",
    },
  });
  try {
    const ledger = writeSidekickLedger(fixture, [
      { model: "engage", costUsd: 0 },
    ]);
    const child = spawn(process.execPath, collectArgs(fixture), {
      env: { ...fixture.env, CHD_EXPERIMENT_2702_TEST_MODE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const appender = setInterval(() => {
      appendFileSync(
        ledger,
        `${JSON.stringify({ model: "engage", costUsd: 0, tick: Date.now() })}\n`,
      );
    }, 10);
    const exit = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rejectExit(new Error("accounting append-race fixture timed out"));
      }, 10_000);
      child.once("error", rejectExit);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    });
    clearInterval(appender);

    assert.notEqual(exit.code, 0, `${stdout}\n${stderr}`);
    assert.match(stderr, /changed while accounting evidence was collected/);
    assert.equal(existsSync(join(fixture.runDir, "accounting.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("recollecting unchanged evidence returns the identical deterministic receipt", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.25,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "sync",
        turn: 1,
        trigger: "cadence",
        costUsd: 0.1,
        shipped: true,
      },
    ]);
    const first = collect(fixture);
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = readFileSync(join(fixture.runDir, "accounting.json"));
    const second = collect(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      readFileSync(join(fixture.runDir, "accounting.json")),
      firstBytes,
    );
    assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  } finally {
    fixture.cleanup();
  }
});

test("attempt 2 accounting binds the authorized retry lineage and immutable retry set", () => {
  const fixture = createEvidenceFixture();
  try {
    const retry = addRetryAttempt(fixture, {
      session_id: randomUUID(),
      total_cost_usd: 0.2,
      result: "private retry output",
    });

    const result = collect(fixture, "haiku-solo", 2);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.attempt, 2);
    assert.deepEqual(receipt.retryOf, retry.registration.retryOf);
    assert.equal(
      receipt.retryRegistrationSetDigest,
      retry.retrySet.registrationSetDigest,
    );
    assert.equal(
      receipt.retryRegistrationSetReceiptDigest,
      retry.retrySet.contentDigest,
    );
    assert.equal(receipt.registrationDigest, retry.registration.contentDigest);
    assert.equal(
      receipt.classificationDigest,
      retry.classification.contentDigest,
    );
    assert.equal(receipt.allInCostUsd, 0.2);
  } finally {
    fixture.cleanup();
  }
});

test("a retry-authorizing parent keeps accounting that its eligible retry can reference", () => {
  const fixture = createEvidenceFixture({
    workerResult: {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: randomUUID(),
      total_cost_usd: 0.3,
    },
  });
  try {
    const parentClassification = rewriteClassification(fixture, {
      status: "failed",
      eligible: false,
      checkResults: [
        {
          checkId: "checks/gate-2702-typecheck",
          status: "failed",
          exitCode: 127,
          signal: null,
          timedOut: false,
        },
      ],
      error: {
        code: "tooling-artifact",
        checkId: "checks/gate-2702-typecheck",
        message: "declared check tool was unavailable",
      },
      retry: {
        authorized: true,
        reason: "tooling-artifact",
        maximumAttempt: 2,
      },
    });

    const parentResult = collect(fixture);
    assert.equal(parentResult.status, 0, parentResult.stderr);
    const parentAccounting = JSON.parse(parentResult.stdout);
    assert.equal(
      parentAccounting.classificationDigest,
      parentClassification.contentDigest,
    );
    assert.equal(parentAccounting.allInCostUsd, 0.3);

    const retry = addRetryAttempt(fixture, {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: randomUUID(),
      total_cost_usd: 0.2,
    });
    assert.equal(
      retry.registration.retryOf.classificationDigest,
      parentAccounting.classificationDigest,
    );

    const retryResult = collect(fixture, "haiku-solo", 2);
    assert.equal(retryResult.status, 0, retryResult.stderr);
    const retryAccounting = JSON.parse(retryResult.stdout);
    assert.equal(retryAccounting.attempt, 2);
    assert.deepEqual(retryAccounting.retryOf, retry.registration.retryOf);
    assert.equal(
      retryAccounting.retryRegistrationSetReceiptDigest,
      retry.retrySet.contentDigest,
    );
    assert.equal(retryAccounting.allInCostUsd, 0.2);
  } finally {
    fixture.cleanup();
  }
});

test("Sidekick v0.3 delivery, pre-act, and interrupt rows count shipped interventions", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "pre-act",
        turn: 31,
        reviewedTurn: 29,
        shipped: true,
        costUsd: 0,
      },
      {
        model: "interrupt",
        turn: 49,
        reviewedTurn: 46,
        shipped: true,
        costUsd: 0,
      },
      {
        model: "delivery",
        turn: 38,
        reviewedTurn: 35,
        shipped: true,
        costUsd: 0,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 0);
    assert.equal(receipt.sidekickPaidCallCount, 0);
    assert.equal(receipt.sidekickShippedInterventionCount, 3);
    assert.equal(receipt.sidekickCostUsd, 0);
    assert.equal(receipt.allInCostUsd, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a skipped final review records a trigger without a paid call", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.1,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "stop-review",
        turn: 12,
        trigger: "final-review",
        skipped: "empty-tail",
        costUsd: 0,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 1);
    assert.equal(receipt.sidekickPaidCallCount, 0);
    assert.equal(receipt.sidekickShippedInterventionCount, 0);
    assert.equal(receipt.sidekickCostUsd, 0);
    assert.equal(receipt.allInCostUsd, 0.1);
  } finally {
    fixture.cleanup();
  }
});

test("a Sidekick triage probe counts as a paid call but not an intervention trigger", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0.1,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "triage",
        turn: 8,
        fired: false,
        costUsd: 0.02,
        durationMs: 123,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 0);
    assert.equal(receipt.sidekickPaidCallCount, 1);
    assert.equal(receipt.sidekickShippedInterventionCount, 0);
    assert.equal(receipt.sidekickCostUsd, 0.02);
    assert.equal(receipt.allInCostUsd, 0.12);
  } finally {
    fixture.cleanup();
  }
});

test("a failed synchronous advisor row using its configured model still counts", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "claude-sonnet-5",
        turn: 9,
        trigger: "destructive",
        error: "advisor call failed",
        costUsd: 0.03,
        shipped: false,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickTriggerCount, 1);
    assert.equal(receipt.sidekickPaidCallCount, 1);
    assert.equal(receipt.sidekickShippedInterventionCount, 0);
    assert.equal(receipt.sidekickCostUsd, 0.03);
    assert.equal(receipt.allInCostUsd, 0.03);
  } finally {
    fixture.cleanup();
  }
});

test("an unconfigured model cannot impersonate a synchronous advisor error", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "future-review",
        turn: 9,
        trigger: "destructive",
        error: "future row shape",
        costUsd: 1,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.deepEqual(receipt.exclusionReasons, [
      "sidekick-lifecycle-unrecognized",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("an unconfigured model cannot impersonate an async advisor completion", () => {
  const fixture = createEvidenceFixture({
    treatmentId: "haiku-sonnet-sidekick",
    workerResult: {
      session_id: randomUUID(),
      total_cost_usd: 0,
      result: "private",
    },
  });
  try {
    writeSidekickLedger(fixture, [
      {
        model: "future-review",
        jobId: "r9-42",
        turn: 9,
        trigger: "destructive",
        costUsd: 1,
      },
    ]);

    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.sidekickCostUsd, null);
    assert.equal(receipt.allInCostUsd, null);
    assert.equal(receipt.sidekickTriggerCount, null);
    assert.equal(receipt.sidekickPaidCallCount, null);
    assert.equal(receipt.sidekickShippedInterventionCount, null);
    assert.deepEqual(receipt.exclusionReasons, [
      "sidekick-lifecycle-unrecognized",
    ]);
  } finally {
    fixture.cleanup();
  }
});
