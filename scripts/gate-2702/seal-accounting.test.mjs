import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  deriveGate2702AccountingEvidence,
  validateGate2702AccountingEvidence,
} from "./seal-accounting.mjs";

const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const SIDEKICK_MODEL = "claude-sonnet-5";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function ledgerBytes(rows) {
  return Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function rowEvidence(rows) {
  const identities = [
    null,
    `async:${SESSION_ID}:job-1:queued`,
    `async:${SESSION_ID}:job-1:queued`,
    `async:${SESSION_ID}:job-1:completed`,
    `direct:${SESSION_ID}:sync:4:destructive`,
    `direct:${SESSION_ID}:stop-review:5:final-review`,
    `probe:${SESSION_ID}:triage:6`,
    `delivery:${SESSION_ID}:pre-act:7`,
    `delivery:${SESSION_ID}:interrupt:8`,
    `delivery:${SESSION_ID}:delivery:9`,
    `direct:${SESSION_ID}:${SIDEKICK_MODEL}:10:destructive`,
  ];
  const lifecycles = [
    "administrative",
    "async-queued",
    "async-queued",
    "async-completed",
    "sync",
    "stop-review",
    "triage",
    "delivery",
    "delivery",
    "delivery",
    "sync-error",
  ];
  return rows.map((row, index) => ({
    rowNumber: index + 1,
    contentDigest: sha256(JSON.stringify(row)),
    lifecycle: lifecycles[index],
    ...(identities[index] ? { identityDigest: sha256(identities[index]) } : {}),
    ...(index === 2 ? { duplicate: true } : {}),
  }));
}

function treatmentFixture() {
  const workerStdoutBytes = Buffer.from(
    `${JSON.stringify({
      session_id: SESSION_ID,
      total_cost_usd: 0.6,
      result: "private worker output",
    })}\n`,
  );
  const queued = {
    model: "queued",
    trigger: "push-or-pr",
    jobId: "job-1",
    turn: 2,
    costUsd: 0,
  };
  const rows = [
    { model: "engage", costUsd: 0 },
    queued,
    queued,
    {
      model: SIDEKICK_MODEL,
      trigger: "push-or-pr",
      jobId: "job-1",
      turn: 2,
      costUsd: 0.25,
    },
    {
      model: "sync",
      trigger: "destructive",
      turn: 4,
      costUsd: 0.1,
      shipped: false,
    },
    {
      model: "stop-review",
      trigger: "final-review",
      turn: 5,
      skipped: "empty-tail",
      costUsd: 0,
    },
    { model: "triage", turn: 6, fired: false, costUsd: 0.02 },
    {
      model: "pre-act",
      reviewedTurn: 7,
      shipped: true,
      costUsd: 0,
    },
    {
      model: "interrupt",
      reviewedTurn: 8,
      shipped: true,
      costUsd: 0,
    },
    {
      model: "delivery",
      reviewedTurn: 9,
      shipped: true,
      costUsd: 0,
    },
    {
      model: SIDEKICK_MODEL,
      trigger: "destructive",
      turn: 10,
      error: "advisor failed",
      costUsd: 0.03,
      shipped: false,
    },
  ];
  const sidekickLedgerBytes = ledgerBytes(rows);
  const workerDigest = sha256(workerStdoutBytes);
  const ledgerDigest = sha256(sidekickLedgerBytes);
  const expected = {
    workerSessionId: SESSION_ID,
    workerCostUsd: 0.6,
    sidekickCostUsd: 0.4,
    allInCostUsd: 1,
    sidekickTriggerCount: 4,
    sidekickPaidCallCount: 4,
    sidekickShippedInterventionCount: 3,
    bridgeEvidenceStatus: "eligible",
    exclusionReasons: [],
    usage: { costUsd: 1 },
    observations: {
      workerCostUsd: {
        value: 0.6,
        evidenceDigests: [workerDigest],
        unknownReasons: [],
      },
      sidekickCostUsd: {
        value: 0.4,
        evidenceDigests: [ledgerDigest],
        unknownReasons: [],
      },
      allInCostUsd: {
        value: 1,
        evidenceDigests: [workerDigest, ledgerDigest],
        unknownReasons: [],
      },
      sidekickTriggerCount: {
        value: 4,
        evidenceDigests: [ledgerDigest],
        unknownReasons: [],
      },
      sidekickPaidCallCount: {
        value: 4,
        evidenceDigests: [ledgerDigest],
        unknownReasons: [],
      },
      sidekickShippedInterventionCount: {
        value: 3,
        evidenceDigests: [ledgerDigest],
        unknownReasons: [],
      },
    },
    sourceEvidence: {
      worker: {
        source: "worker-terminal-json",
        byteLength: workerStdoutBytes.length,
        contentDigest: workerDigest,
      },
      sidekick: {
        source: "sidekick-session-ledger",
        relativePath: `${SESSION_ID}/__sidekick.jsonl`,
        status: "settled",
        byteLength: sidekickLedgerBytes.length,
        contentDigest: ledgerDigest,
        rowDigests: rowEvidence(rows),
      },
    },
  };
  return { workerStdoutBytes, sidekickLedgerBytes, expected };
}

test("retained worker and Sidekick bytes rederive every accounting evidence field", () => {
  const fixture = treatmentFixture();

  assert.deepEqual(
    deriveGate2702AccountingEvidence({
      workerStdoutBytes: fixture.workerStdoutBytes,
      sidekickLedgerBytes: fixture.sidekickLedgerBytes,
      sidekickEnabled: true,
      definitionDigest: DEFINITION_DIGEST,
      sidekickModel: SIDEKICK_MODEL,
    }),
    fixture.expected,
  );
});

test("validation rejects re-digested numeric, session, row, and observation claims", () => {
  const fixture = treatmentFixture();
  const input = {
    accounting: fixture.expected,
    workerStdoutBytes: fixture.workerStdoutBytes,
    sidekickLedgerBytes: fixture.sidekickLedgerBytes,
    sidekickEnabled: true,
    definitionDigest: DEFINITION_DIGEST,
    sidekickModel: SIDEKICK_MODEL,
  };
  assert.deepEqual(validateGate2702AccountingEvidence(input), fixture.expected);

  for (const [field, mutate] of [
    [
      "workerSessionId",
      (receipt) => (receipt.workerSessionId = randomSession()),
    ],
    ["workerCostUsd", (receipt) => (receipt.workerCostUsd = -0)],
    ["sidekickPaidCallCount", (receipt) => (receipt.sidekickPaidCallCount = 5)],
    [
      "observations",
      (receipt) => (receipt.observations.allInCostUsd.value = 0.99),
    ],
    [
      "sourceEvidence",
      (receipt) =>
        (receipt.sourceEvidence.sidekick.rowDigests[0].lifecycle = "ignored"),
    ],
  ]) {
    const accounting = structuredClone(fixture.expected);
    mutate(accounting);
    assert.throws(
      () => validateGate2702AccountingEvidence({ ...input, accounting }),
      new RegExp(field),
    );
  }
});

test("control zeros and an enabled treatment without a retained ledger are independent claims", () => {
  const workerStdoutBytes = Buffer.from(
    '{"session_id":"not-a-session","result":"private"}\n',
  );
  const workerDigest = sha256(workerStdoutBytes);

  const missing = deriveGate2702AccountingEvidence({
    workerStdoutBytes,
    sidekickEnabled: true,
    definitionDigest: DEFINITION_DIGEST,
    sidekickModel: SIDEKICK_MODEL,
  });
  assert.equal(missing.workerSessionId, null);
  assert.equal(missing.workerCostUsd, null);
  assert.equal(missing.sidekickCostUsd, null);
  assert.equal(missing.sourceEvidence.sidekick.status, "unavailable");
  assert.deepEqual(missing.exclusionReasons, [
    "worker-cost-unknown",
    "worker-session-id-unknown",
  ]);
  assert.deepEqual(missing.observations.allInCostUsd, {
    value: null,
    evidenceDigests: [workerDigest],
    unknownReasons: ["worker-cost-unknown", "worker-session-id-unknown"],
  });

  const control = deriveGate2702AccountingEvidence({
    workerStdoutBytes: Buffer.from(
      `${JSON.stringify({ session_id: SESSION_ID, total_cost_usd: 0.125 })}\n`,
    ),
    sidekickEnabled: false,
    definitionDigest: DEFINITION_DIGEST,
    sidekickModel: SIDEKICK_MODEL,
  });
  assert.equal(control.sidekickCostUsd, 0);
  assert.equal(control.sidekickTriggerCount, 0);
  assert.equal(
    control.sourceEvidence.sidekick.source,
    "fixed-disabled-treatment",
  );
  assert.deepEqual(control.observations.sidekickCostUsd.evidenceDigests, [
    DEFINITION_DIGEST,
  ]);
});

test("conflicting, incomplete, malformed, and unknown lifecycles fail closed", () => {
  const workerStdoutBytes = Buffer.from(
    `${JSON.stringify({ session_id: SESSION_ID, total_cost_usd: 0.5 })}\n`,
  );
  const derive = (sidekickLedgerBytes) =>
    deriveGate2702AccountingEvidence({
      workerStdoutBytes,
      sidekickLedgerBytes,
      sidekickEnabled: true,
      definitionDigest: DEFINITION_DIGEST,
      sidekickModel: SIDEKICK_MODEL,
    });

  const conflict = derive(
    ledgerBytes([
      {
        model: "sync",
        trigger: "destructive",
        turn: 3,
        costUsd: 0.1,
        shipped: false,
      },
      {
        model: "sync",
        trigger: "destructive",
        turn: 3,
        costUsd: 0.2,
        shipped: true,
      },
    ]),
  );
  assert.deepEqual(conflict.exclusionReasons, ["sidekick-lifecycle-conflict"]);
  assert.equal(conflict.sidekickTriggerCount, null);
  assert.equal(conflict.sourceEvidence.sidekick.rowDigests[1].conflict, true);

  const incomplete = derive(
    ledgerBytes([
      {
        model: "queued",
        trigger: "push-or-pr",
        jobId: "unfinished",
        costUsd: 0,
      },
    ]),
  );
  assert.deepEqual(incomplete.exclusionReasons, [
    "sidekick-lifecycle-incomplete",
  ]);
  assert.equal(incomplete.sidekickTriggerCount, 1);
  assert.equal(incomplete.sidekickPaidCallCount, null);

  const malformed = derive(Buffer.from('{"model":\n'));
  assert.deepEqual(malformed.exclusionReasons, ["sidekick-ledger-malformed"]);
  assert.equal(
    malformed.sourceEvidence.sidekick.rowDigests[0].lifecycle,
    "malformed",
  );

  const unrecognized = derive(
    ledgerBytes([{ model: "future-review", costUsd: 1 }]),
  );
  assert.deepEqual(unrecognized.exclusionReasons, [
    "sidekick-lifecycle-unrecognized",
  ]);
  assert.equal(
    unrecognized.sourceEvidence.sidekick.rowDigests[0].lifecycle,
    "unrecognized",
  );
});

function randomSession() {
  return "33333333-3333-4333-8333-333333333333";
}
