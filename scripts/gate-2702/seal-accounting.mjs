/**
 * Pure accounting rederivation for the sealed #2702 C5 bridge.
 *
 * `deriveGate2702AccountingEvidence` accepts the exact retained worker stdout
 * bytes, the exact retained Sidekick JSONL bytes when one exists, and immutable
 * Definition inputs. It returns only the evidence-derived fields written by
 * `accounting.mjs`; it performs no filesystem or process access.
 *
 * `validateGate2702AccountingEvidence` additionally accepts an already
 * schema/digest-validated `Gate2702Accounting` receipt and rejects any mismatch
 * in its session, numeric, count, usage, observation, or source-evidence fields.
 * The caller remains responsible for validating receipt identity and lineage.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const MAX_WORKER_BYTES = 2 * 1024 * 1024;
const MAX_SIDEKICK_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_SIDEKICK_LEDGER_ROWS = 4_096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ACCOUNTING_EVIDENCE_FIELDS = [
  "workerSessionId",
  "workerCostUsd",
  "sidekickCostUsd",
  "allInCostUsd",
  "sidekickTriggerCount",
  "sidekickPaidCallCount",
  "sidekickShippedInterventionCount",
  "bridgeEvidenceStatus",
  "exclusionReasons",
  "usage",
  "observations",
  "sourceEvidence",
];

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

function retainedBytes(value, maximumBytes, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail(`${label} must be retained bytes`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length > maximumBytes) {
    fail(`${label} exceeds its fixed size limit`);
  }
  return bytes;
}

function workerEvidence(workerStdoutBytes) {
  const bytes = retainedBytes(
    workerStdoutBytes,
    MAX_WORKER_BYTES,
    "worker terminal JSON",
  );
  let result = null;
  const unknownReasons = [];
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      result = parsed;
    }
  } catch {
    // The retained byte digest remains evidence even when fields cannot decode.
  }
  if (result === null) unknownReasons.push("worker-result-malformed");
  const workerSessionId = UUID_PATTERN.test(result?.session_id ?? "")
    ? result.session_id.toLowerCase()
    : null;
  if (workerSessionId === null) {
    unknownReasons.push("worker-session-id-unknown");
  }
  const workerCostUsd =
    typeof result?.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0 &&
    !Object.is(result.total_cost_usd, -0)
      ? result.total_cost_usd
      : null;
  if (workerCostUsd === null) unknownReasons.push("worker-cost-unknown");
  return {
    workerSessionId,
    workerCostUsd,
    unknownReasons,
    evidence: {
      source: "worker-terminal-json",
      byteLength: bytes.length,
      contentDigest: sha256(bytes),
    },
  };
}

function observation(value, evidenceDigests, unknownReasons = []) {
  return { value, evidenceDigests, unknownReasons };
}

function parseLedgerRows(sidekickLedgerBytes) {
  const bytes = retainedBytes(
    sidekickLedgerBytes,
    MAX_SIDEKICK_LEDGER_BYTES,
    "exact Sidekick ledger",
  );
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_SIDEKICK_LEDGER_ROWS) {
    fail("exact Sidekick ledger exceeds its fixed row limit");
  }
  let malformed = false;
  const entries = lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed = true;
      row = null;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      malformed = true;
      row = null;
    }
    return {
      rowNumber: index + 1,
      row,
      contentDigest: sha256(line),
    };
  });
  return { bytes, entries, malformed };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is missing`);
  }
  return value;
}

function requiredTurn(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

function requireZeroCost(row, label) {
  if (row.costUsd !== 0 || Object.is(row.costUsd, -0)) {
    fail(`${label} must have known zero cost`);
  }
}

export function normalizeGate2702Cost(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    return null;
  }
  const normalized = Number(value.toFixed(12));
  return Number.isFinite(normalized) && !Object.is(normalized, -0)
    ? normalized
    : null;
}

function requireNoShippedField(row, label) {
  if (row.shipped !== undefined) {
    fail(`${label} cannot declare a shipped intervention`);
  }
}

function requireShippedBoolean(row, label, expected) {
  if (
    typeof row.shipped !== "boolean" ||
    (expected !== undefined && row.shipped !== expected)
  ) {
    fail(`${label} has an invalid shipped state`);
  }
}

function unknownSidekickValues(reason, rowEvidence) {
  const reasons = [reason];
  return {
    sidekickCostUsd: null,
    sidekickTriggerCount: null,
    sidekickPaidCallCount: null,
    sidekickShippedInterventionCount: null,
    unknownReasons: reasons,
    fieldUnknownReasons: {
      sidekickCostUsd: reasons,
      sidekickTriggerCount: reasons,
      sidekickPaidCallCount: reasons,
      sidekickShippedInterventionCount: reasons,
    },
    rowEvidence,
  };
}

function untrustedSidekickValues(reason, entries) {
  return unknownSidekickValues(
    reason,
    entries.map(({ rowNumber, contentDigest, row }) => ({
      rowNumber,
      contentDigest,
      lifecycle: row === null ? "malformed" : "untrusted",
    })),
  );
}

function collectSidekickRows(rows, workerSessionId, sidekickModel) {
  const asyncJobs = new Map();
  const lifecycleRows = new Map();
  const paidRows = [];
  const shippedRows = [];
  const rowEvidence = [];
  let lifecycleConflict = false;
  let lifecycleUnrecognized = false;
  let directTriggerCount = 0;
  const ignoredModels = new Set(["engage", "budget", "guard"]);

  const acceptLifecycle = (identity, row) => {
    const canonical = canonicalJson(row);
    const existing = lifecycleRows.get(identity);
    if (existing === undefined) {
      lifecycleRows.set(identity, canonical);
      return "unique";
    }
    if (existing !== canonical) {
      lifecycleConflict = true;
      return "conflict";
    }
    return "duplicate";
  };

  for (const evidence of rows) {
    const { row } = evidence;
    let lifecycle = "ignored";
    let identity = null;
    let duplicate = false;
    let conflict = false;
    if (row.model === "queued") {
      const jobId = requiredString(row.jobId, "queued Sidekick jobId");
      const trigger = requiredString(row.trigger, "queued Sidekick trigger");
      requireZeroCost(row, "queued Sidekick row");
      requireNoShippedField(row, "queued Sidekick row");
      lifecycle = "async-queued";
      identity = `async:${workerSessionId}:${jobId}:queued`;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        const job = asyncJobs.get(jobId) ?? {
          trigger,
          queued: false,
          completed: false,
        };
        if (job.trigger !== trigger) {
          lifecycleConflict = true;
          conflict = true;
        } else {
          job.queued = true;
          asyncJobs.set(jobId, job);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === "sync" || row.model === "stop-review") {
      const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
      const trigger = requiredString(
        row.trigger,
        `${row.model} Sidekick trigger`,
      );
      const skipped =
        row.model === "stop-review" && row.skipped === "empty-tail";
      if (row.skipped !== undefined && !skipped) {
        fail(`${row.model} Sidekick skipped state is unrecognized`);
      }
      if (skipped) {
        requireZeroCost(row, "skipped stop-review Sidekick row");
        requireNoShippedField(row, "skipped stop-review Sidekick row");
      } else {
        requireShippedBoolean(row, `${row.model} Sidekick row`);
      }
      identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
      lifecycle = row.model;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        directTriggerCount += 1;
        if (!skipped) {
          paidRows.push(row);
          if (row.shipped === true) shippedRows.push(row);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === "triage") {
      const turn = requiredTurn(row.turn, "triage Sidekick turn");
      if (typeof row.fired !== "boolean") {
        fail("triage Sidekick fired result is invalid");
      }
      requireNoShippedField(row, "triage Sidekick row");
      identity = `probe:${workerSessionId}:triage:${turn}`;
      lifecycle = "triage";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") paidRows.push(row);
      else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (
      row.model === "delivery" ||
      row.model === "pre-act" ||
      row.model === "interrupt"
    ) {
      const reviewedTurn = requiredTurn(
        row.reviewedTurn,
        `${row.model} Sidekick reviewed turn`,
      );
      requireZeroCost(row, `${row.model} Sidekick row`);
      requireShippedBoolean(row, `${row.model} Sidekick row`, true);
      identity = `delivery:${workerSessionId}:${row.model}:${reviewedTurn}`;
      lifecycle = "delivery";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        if (row.shipped === true) shippedRows.push(row);
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (
      row.model === sidekickModel &&
      typeof row.trigger === "string" &&
      typeof row.error === "string" &&
      row.error.length > 0 &&
      row.jobId === undefined
    ) {
      const turn = requiredTurn(row.turn, `${row.model} Sidekick turn`);
      const trigger = requiredString(
        row.trigger,
        `${row.model} Sidekick trigger`,
      );
      requireShippedBoolean(row, `${row.model} Sidekick error row`, false);
      identity = `direct:${workerSessionId}:${row.model}:${turn}:${trigger}`;
      lifecycle = "sync-error";
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        directTriggerCount += 1;
        paidRows.push(row);
        if (row.shipped === true) shippedRows.push(row);
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (row.model === sidekickModel && typeof row.jobId === "string") {
      const jobId = requiredString(row.jobId, "completed Sidekick jobId");
      const trigger = requiredString(row.trigger, "completed Sidekick trigger");
      requireNoShippedField(row, "completed Sidekick row");
      lifecycle = "async-completed";
      identity = `async:${workerSessionId}:${jobId}:completed`;
      const disposition = acceptLifecycle(identity, row);
      if (disposition === "unique") {
        const job = asyncJobs.get(jobId) ?? {
          trigger,
          queued: false,
          completed: false,
        };
        if (job.trigger !== trigger) {
          lifecycleConflict = true;
          conflict = true;
        } else {
          job.completed = true;
          asyncJobs.set(jobId, job);
          paidRows.push(row);
        }
      } else if (disposition === "duplicate") duplicate = true;
      else conflict = true;
    } else if (ignoredModels.has(row.model) && row.costUsd === 0) {
      lifecycle = "administrative";
    } else {
      lifecycle = "unrecognized";
      lifecycleUnrecognized = true;
    }
    rowEvidence.push({
      rowNumber: evidence.rowNumber,
      contentDigest: evidence.contentDigest,
      lifecycle,
      ...(identity ? { identityDigest: sha256(identity) } : {}),
      ...(duplicate ? { duplicate: true } : {}),
      ...(conflict ? { conflict: true } : {}),
    });
  }

  if (lifecycleUnrecognized) {
    return unknownSidekickValues(
      "sidekick-lifecycle-unrecognized",
      rowEvidence,
    );
  }
  if (lifecycleConflict) {
    return unknownSidekickValues("sidekick-lifecycle-conflict", rowEvidence);
  }

  const asyncTriggerCount = [...asyncJobs.values()].filter(
    ({ queued }) => queued,
  ).length;
  const sidekickTriggerCount = asyncTriggerCount + directTriggerCount;
  const lifecycleIncomplete = [...asyncJobs.values()].some(
    ({ queued, completed }) => !queued || !completed,
  );
  if (lifecycleIncomplete) {
    const reasons = ["sidekick-lifecycle-incomplete"];
    return {
      sidekickCostUsd: null,
      sidekickTriggerCount,
      sidekickPaidCallCount: null,
      sidekickShippedInterventionCount: null,
      unknownReasons: reasons,
      fieldUnknownReasons: {
        sidekickCostUsd: reasons,
        sidekickTriggerCount: [],
        sidekickPaidCallCount: reasons,
        sidekickShippedInterventionCount: reasons,
      },
      rowEvidence,
    };
  }

  const costsKnown = paidRows.every(
    (row) =>
      typeof row.costUsd === "number" &&
      Number.isFinite(row.costUsd) &&
      row.costUsd >= 0 &&
      !Object.is(row.costUsd, -0),
  );
  const sidekickCostUsd = costsKnown
    ? normalizeGate2702Cost(
        paidRows.reduce((total, row) => total + row.costUsd, 0),
      )
    : null;
  const costUnknownReasons =
    sidekickCostUsd === null ? ["sidekick-cost-unknown"] : [];
  return {
    sidekickCostUsd,
    sidekickTriggerCount,
    sidekickPaidCallCount: paidRows.length,
    sidekickShippedInterventionCount: shippedRows.length,
    unknownReasons: costUnknownReasons,
    fieldUnknownReasons: {
      sidekickCostUsd: costUnknownReasons,
      sidekickTriggerCount: [],
      sidekickPaidCallCount: [],
      sidekickShippedInterventionCount: [],
    },
    rowEvidence,
  };
}

function unavailableSidekickValues(reason) {
  const reasons = [reason];
  return {
    sidekickCostUsd: null,
    sidekickTriggerCount: null,
    sidekickPaidCallCount: null,
    sidekickShippedInterventionCount: null,
    unknownReasons: reasons,
    fieldUnknownReasons: Object.fromEntries(
      [
        "sidekickCostUsd",
        "sidekickTriggerCount",
        "sidekickPaidCallCount",
        "sidekickShippedInterventionCount",
      ].map((field) => [field, reasons]),
    ),
    rowEvidence: [],
  };
}

function deriveTreatment(worker, sidekickLedgerBytes, sidekickModel) {
  if (typeof sidekickModel !== "string" || sidekickModel.length === 0) {
    fail("sidekickModel must identify the configured Sidekick model");
  }
  if (worker.workerSessionId === null && sidekickLedgerBytes != null) {
    fail("Sidekick ledger bytes cannot bind without a worker session id");
  }
  const relativePath =
    worker.workerSessionId === null
      ? null
      : `${worker.workerSessionId}/__sidekick.jsonl`;
  const ledger =
    worker.workerSessionId === null
      ? { status: "unavailable", relativePath }
      : sidekickLedgerBytes == null
        ? { status: "missing", relativePath }
        : {
            status: "settled",
            relativePath,
            ...parseLedgerRows(sidekickLedgerBytes),
          };
  const values =
    ledger.status !== "settled"
      ? unavailableSidekickValues(
          ledger.status === "missing"
            ? "sidekick-ledger-missing"
            : "worker-session-id-unknown",
        )
      : (() => {
          if (!ledger.malformed) {
            try {
              return collectSidekickRows(
                ledger.entries,
                worker.workerSessionId,
                sidekickModel,
              );
            } catch {
              // Valid JSON may still violate the pinned Sidekick row schema.
            }
          }
          return untrustedSidekickValues(
            "sidekick-ledger-malformed",
            ledger.entries,
          );
        })();
  const allInCostUsd =
    worker.workerCostUsd === null || values.sidekickCostUsd === null
      ? null
      : normalizeGate2702Cost(
          worker.workerCostUsd + values.sidekickCostUsd,
        );
  const workerCostUnknownReasons =
    worker.workerCostUsd === null
      ? worker.unknownReasons.filter(
          (reason) => reason !== "worker-session-id-unknown",
        )
      : [];
  const invalidAllInCost =
    worker.workerCostUsd !== null &&
    values.sidekickCostUsd !== null &&
    allInCostUsd === null;
  const allInUnknownReasons = [
    ...new Set([
      ...workerCostUnknownReasons,
      ...values.fieldUnknownReasons.sidekickCostUsd,
      ...(invalidAllInCost ? ["all-in-cost-invalid"] : []),
    ]),
  ];
  const unknownReasons = [
    ...new Set([...allInUnknownReasons, ...values.unknownReasons]),
  ];
  const ledgerDigest =
    ledger.status === "settled" ? sha256(ledger.bytes) : null;
  const evidenceDigests = [
    worker.evidence.contentDigest,
    ...(ledgerDigest === null ? [] : [ledgerDigest]),
  ];
  return {
    workerSessionId: worker.workerSessionId,
    workerCostUsd: worker.workerCostUsd,
    sidekickCostUsd: values.sidekickCostUsd,
    allInCostUsd,
    sidekickTriggerCount: values.sidekickTriggerCount,
    sidekickPaidCallCount: values.sidekickPaidCallCount,
    sidekickShippedInterventionCount: values.sidekickShippedInterventionCount,
    bridgeEvidenceStatus: allInCostUsd === null ? "excluded" : "eligible",
    exclusionReasons: unknownReasons,
    ...(allInCostUsd === null ? {} : { usage: { costUsd: allInCostUsd } }),
    observations: {
      workerCostUsd: observation(
        worker.workerCostUsd,
        [worker.evidence.contentDigest],
        workerCostUnknownReasons,
      ),
      sidekickCostUsd: observation(
        values.sidekickCostUsd,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickCostUsd,
      ),
      allInCostUsd: observation(
        allInCostUsd,
        evidenceDigests,
        allInUnknownReasons,
      ),
      sidekickTriggerCount: observation(
        values.sidekickTriggerCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickTriggerCount,
      ),
      sidekickPaidCallCount: observation(
        values.sidekickPaidCallCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickPaidCallCount,
      ),
      sidekickShippedInterventionCount: observation(
        values.sidekickShippedInterventionCount,
        evidenceDigests.slice(1),
        values.fieldUnknownReasons.sidekickShippedInterventionCount,
      ),
    },
    sourceEvidence: {
      worker: worker.evidence,
      sidekick: {
        source: "sidekick-session-ledger",
        relativePath: ledger.relativePath,
        status: ledger.status,
        ...(ledger.status === "settled"
          ? {
              byteLength: ledger.bytes.length,
              contentDigest: ledgerDigest,
            }
          : {}),
        rowDigests: values.rowEvidence,
      },
    },
  };
}

function deriveControl(worker, definitionDigest) {
  const costKnown = worker.workerCostUsd !== null;
  const unknownReasons = costKnown
    ? []
    : worker.unknownReasons.filter(
        (reason) => reason !== "worker-session-id-unknown",
      );
  const allInCostUsd = costKnown ? worker.workerCostUsd : null;
  return {
    workerSessionId: worker.workerSessionId,
    workerCostUsd: worker.workerCostUsd,
    sidekickCostUsd: 0,
    allInCostUsd,
    sidekickTriggerCount: 0,
    sidekickPaidCallCount: 0,
    sidekickShippedInterventionCount: 0,
    bridgeEvidenceStatus: costKnown ? "eligible" : "excluded",
    exclusionReasons: unknownReasons,
    ...(costKnown ? { usage: { costUsd: allInCostUsd } } : {}),
    observations: {
      workerCostUsd: observation(
        worker.workerCostUsd,
        [worker.evidence.contentDigest],
        unknownReasons,
      ),
      sidekickCostUsd: observation(0, [definitionDigest]),
      allInCostUsd: observation(
        allInCostUsd,
        [worker.evidence.contentDigest, definitionDigest],
        unknownReasons,
      ),
      sidekickTriggerCount: observation(0, [definitionDigest]),
      sidekickPaidCallCount: observation(0, [definitionDigest]),
      sidekickShippedInterventionCount: observation(0, [definitionDigest]),
    },
    sourceEvidence: {
      worker: worker.evidence,
      sidekick: {
        source: "fixed-disabled-treatment",
        definitionDigest,
      },
    },
  };
}

/**
 * Re-derive the evidence-controlled portion of a Gate2702Accounting receipt.
 *
 * @param {object} input
 * @param {Buffer|Uint8Array} input.workerStdoutBytes Exact retained stdout.
 * @param {Buffer|Uint8Array|null} [input.sidekickLedgerBytes] Exact retained
 *   `__sidekick.jsonl`, or null/undefined when no ledger existed.
 * @param {boolean} input.sidekickEnabled Whether the Definition treatment
 *   enables Sidekick.
 * @param {string} input.definitionDigest Exact Definition content digest.
 * @param {string} input.sidekickModel Pinned Sidekick advisor model id.
 */
export function deriveGate2702AccountingEvidence({
  workerStdoutBytes,
  sidekickLedgerBytes = null,
  sidekickEnabled,
  definitionDigest,
  sidekickModel,
}) {
  if (typeof sidekickEnabled !== "boolean") {
    fail("sidekickEnabled must be a boolean Definition value");
  }
  if (!SHA256_PATTERN.test(definitionDigest ?? "")) {
    fail("definitionDigest must be a sha256 content digest");
  }
  if (!sidekickEnabled && sidekickLedgerBytes != null) {
    fail("a Sidekick-disabled treatment cannot bind Sidekick ledger bytes");
  }
  const worker = workerEvidence(workerStdoutBytes);
  return sidekickEnabled
    ? deriveTreatment(worker, sidekickLedgerBytes, sidekickModel)
    : deriveControl(worker, definitionDigest);
}

/**
 * Validate all evidence-derived accounting claims and return their rederived
 * projection. The input receipt must already have passed schema, digest,
 * identity, and lineage validation.
 *
 * @param {object} input Same inputs as `deriveGate2702AccountingEvidence`.
 * @param {object} input.accounting Parsed Gate2702Accounting receipt.
 */
export function validateGate2702AccountingEvidence({ accounting, ...inputs }) {
  if (
    accounting === null ||
    typeof accounting !== "object" ||
    Array.isArray(accounting)
  ) {
    fail("Gate2702Accounting receipt must be an object");
  }
  const expected = deriveGate2702AccountingEvidence(inputs);
  for (const field of ACCOUNTING_EVIDENCE_FIELDS) {
    const expectedHasField = Object.hasOwn(expected, field);
    const accountingHasField = Object.hasOwn(accounting, field);
    if (
      expectedHasField !== accountingHasField ||
      (expectedHasField &&
        !isDeepStrictEqual(accounting[field], expected[field]))
    ) {
      fail(
        `Gate2702Accounting ${field} does not rederive from retained evidence`,
      );
    }
  }
  return expected;
}
