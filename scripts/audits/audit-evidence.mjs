import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import Ajv from "ajv";

import {
  AUDIT_SECTIONS,
  parseAuditState,
  validateWorkerReceipt,
} from "./audit-run-state.mjs";
import { cleanTitle, dedupKey } from "./file-findings.mjs";

const FINDINGS_ROOT = "docs/audits/findings/";
const RUNS_ROOT = "docs/audits/runs/";
const RECEIPT_FIELDS = [
  "baseline",
  "auditDate",
  "section",
  "gates",
  "auditedFiles",
  "verdicts",
  "findings",
];
const ROUTER_FIELDS = [
  "schemaVersion",
  "findings",
  "section",
  "baseline",
  "auditDate",
  "dryRun",
  "gates",
  "created",
  "existing",
  "skipped",
  "counts",
];
const ROUTER_ENTRY_FIELDS = ["lens", "key", "title", "number"];
const METADATA_FIELDS = [
  "schemaVersion",
  "producerHarness",
  "receiptSha256",
  "baseline",
  "auditDate",
  "section",
  "gates",
  "auditedFilesSha256",
];
const PRODUCER_HARNESSES = new Set(["claude", "codex"]);
const decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function parseEvidenceJson(entry, blobs) {
  if (entry.mode !== "100644" || entry.type !== "blob") {
    throw new Error(
      `sealed audit evidence ${entry.path} must be a regular non-executable blob`,
    );
  }
  const contents = blobs.get(entry.path);
  if (!Buffer.isBuffer(contents) && !(contents instanceof Uint8Array)) {
    throw new Error(`missing baseline blob bytes for ${entry.path}`);
  }
  if (contents.byteLength !== entry.size) {
    throw new Error(
      `baseline blob size for ${entry.path} does not match its tracked entry`,
    );
  }
  let text;
  try {
    text = decoder.decode(contents);
  } catch (error) {
    throw new Error(`sealed audit evidence ${entry.path} is not UTF-8: ${error.message}`);
  }
  try {
    return { contents, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`sealed audit evidence ${entry.path} is invalid JSON: ${error.message}`);
  }
}

function receiptStem(path, kind) {
  if (!path.startsWith(FINDINGS_ROOT)) {
    throw new Error(`unexpected ${kind} path ${path}`);
  }
  const name = path.slice(FINDINGS_ROOT.length);
  if (name.includes("/")) {
    throw new Error(`unrecognized sealed audit evidence path ${path}`);
  }
  const suffix = {
    receipt: ".json",
    "receipt-metadata": ".meta.json",
    "router-result": ".router.json",
  }[kind];
  if (!suffix || !name.endsWith(suffix)) {
    throw new Error(`evidence kind ${kind} does not match path ${path}`);
  }
  return name.slice(0, -suffix.length);
}

function defaultStatePath(baseline) {
  return `${RUNS_ROOT}v060-${baseline.slice(0, 12)}.json`;
}

function expectedReceiptPath(state, batch, offset) {
  const sectionSlug = batch.section
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  const filesDigest = sha256(batch.auditedFiles.join("\0")).slice(0, 12);
  const stem = `${sectionSlug}-${state.baseline.slice(0, 12)}-${String(
    offset + 1,
  ).padStart(4, "0")}-${filesDigest}`;
  return `${FINDINGS_ROOT}${stem}.json`;
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeReceipt(receipt, expectedBatch) {
  const verdictByFile = new Map(
    receipt.verdicts.map((verdict) => [verdict.file, verdict]),
  );
  return {
    baseline: expectedBatch.baseline,
    auditDate: expectedBatch.auditDate,
    section: expectedBatch.section,
    gates: [...expectedBatch.gates],
    auditedFiles: [...expectedBatch.auditedFiles],
    verdicts: expectedBatch.auditedFiles.map((file) => {
      const verdict = verdictByFile.get(file);
      const gateByName = new Map(
        verdict.gates.map((gateVerdict) => [gateVerdict.gate, gateVerdict]),
      );
      return {
        file,
        gates: expectedBatch.gates.map((gate) =>
          cloneSerializable(gateByName.get(gate)),
        ),
      };
    }),
    findings: receipt.findings
      .map(cloneSerializable)
      .sort((left, right) => {
        const leftKey = dedupKey(left);
        const rightKey = dedupKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}

function validateReceiptMetadata(metadata, receiptBytes, batch) {
  assertExactKeys(metadata, METADATA_FIELDS, "receipt metadata");
  if (metadata.schemaVersion !== 1) {
    throw new Error("receipt metadata has an unsupported schemaVersion");
  }
  if (!PRODUCER_HARNESSES.has(metadata.producerHarness)) {
    throw new Error(
      `receipt metadata has invalid producer ${metadata.producerHarness}`,
    );
  }
  const expected = {
    schemaVersion: 1,
    producerHarness: metadata.producerHarness,
    receiptSha256: sha256(receiptBytes),
    baseline: batch.baseline,
    auditDate: batch.auditDate,
    section: batch.section,
    gates: [...batch.gates],
    auditedFilesSha256: sha256(batch.auditedFiles.join("\0")),
  };
  if (!isDeepStrictEqual(metadata, expected)) {
    throw new Error(
      "receipt metadata does not match the receipt bytes or dispatched batch",
    );
  }
}

function validateRouter(router, { receipt, receiptPath, batch, issueNumbersByGate }) {
  assertExactKeys(router, ROUTER_FIELDS, "router result");
  assertExactKeys(router.counts, ["created", "existing", "skipped"], "router counts");
  if (
    router.schemaVersion !== 1 ||
    router.findings !== receiptPath ||
    router.section !== batch.section ||
    router.baseline !== batch.baseline ||
    router.auditDate !== batch.auditDate ||
    router.dryRun !== false ||
    !isDeepStrictEqual(router.gates, batch.gates)
  ) {
    throw new Error("router identity does not match its sealed receipt");
  }
  for (const field of ["created", "existing", "skipped"]) {
    if (!Array.isArray(router[field])) {
      throw new Error(`router ${field} must be an array`);
    }
    if (router.counts[field] !== router[field].length) {
      throw new Error(`router ${field} count does not match its entries`);
    }
  }
  if (router.skipped.length !== 0) {
    throw new Error("sealed router result must not contain skipped findings");
  }

  const findingByKey = new Map(
    receipt.findings.map((finding) => [dedupKey(finding), finding]),
  );
  const entries = [...router.created, ...router.existing];
  if (entries.length !== findingByKey.size) {
    throw new Error("router result does not account for every receipt finding");
  }
  const seenKeys = new Set();
  const seenNumbers = new Set();
  const routedNumbers = Object.fromEntries(batch.gates.map((gate) => [gate, []]));
  for (const [index, entry] of entries.entries()) {
    assertExactKeys(entry, ROUTER_ENTRY_FIELDS, `router entry ${index + 1}`);
    const finding = findingByKey.get(entry.key);
    if (
      !finding ||
      entry.lens !== finding.lens ||
      entry.title !== cleanTitle(finding.title)
    ) {
      throw new Error(`router entry ${index + 1} does not match a receipt finding`);
    }
    if (!Number.isInteger(entry.number) || entry.number < 1) {
      throw new Error(`router entry ${index + 1} has an invalid issue number`);
    }
    if (seenKeys.has(entry.key)) {
      throw new Error(`router result contains duplicate finding key ${entry.key}`);
    }
    if (seenNumbers.has(entry.number)) {
      throw new Error(`router result contains duplicate issue number ${entry.number}`);
    }
    seenKeys.add(entry.key);
    seenNumbers.add(entry.number);
    routedNumbers[entry.lens].push(entry.number);
  }
  for (const gate of batch.gates) {
    routedNumbers[gate].sort((left, right) => left - right);
  }
  if (!isDeepStrictEqual(routedNumbers, issueNumbersByGate)) {
    throw new Error(
      "router issue numbers do not match the durable run-state batch",
    );
  }
}

function validateStateShape(state) {
  const topFields =
    state.version === 1
      ? ["version", "baseline", "auditDate", "gates", "sections", "issueNumbersByGate"]
      : [
          "version",
          "baseline",
          "auditDate",
          "gates",
          "scope",
          "sections",
          "issueNumbersByGate",
        ];
  assertExactKeys(state, topFields, "audit run state");
  if (!/^[0-9a-f]{40}$/.test(state.baseline)) {
    throw new Error("audit run state baseline must be a full lowercase commit SHA");
  }
  for (const [index, section] of state.sections.entries()) {
    assertExactKeys(
      section,
      ["section", "files", "completedFiles", "batches", "issueNumbersByGate"],
      `audit run state section ${index + 1}`,
    );
    for (const [batchIndex, batch] of section.batches.entries()) {
      assertExactKeys(
        batch,
        [...RECEIPT_FIELDS, "issueNumbersByGate"],
        `audit run-state batch ${index + 1}.${batchIndex + 1}`,
      );
    }
  }
}

function compileReceiptSchema(receiptSchema) {
  if (!receiptSchema || typeof receiptSchema !== "object") {
    throw new Error("receiptSchema must be a JSON Schema object");
  }
  return new Ajv({ allErrors: true, strict: true }).compile(receiptSchema);
}

function validateTriplet({
  state,
  stateBatch,
  receiptPath,
  triplet,
  records,
  receiptSchemaValidator,
}) {
  const receiptRecord = records.get(triplet.receipt.path);
  const metadataRecord = records.get(triplet["receipt-metadata"].path);
  const routerRecord = records.get(triplet["router-result"].path);
  const receipt = receiptRecord.value;
  const expectedBatch = {
    baseline: state.baseline,
    auditDate: state.auditDate,
    section: stateBatch.section,
    gates: state.gates,
    auditedFiles: stateBatch.auditedFiles,
  };

  if (!receiptSchemaValidator(receipt)) {
    const detail = receiptSchemaValidator.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`receipt ${receiptPath} is not schema-valid: ${detail}`);
  }
  validateWorkerReceipt(receipt, expectedBatch);
  const { issueNumbersByGate, ...storedReceipt } = stateBatch;
  if (
    !isDeepStrictEqual(
      normalizeReceipt(receipt, expectedBatch),
      normalizeReceipt(storedReceipt, expectedBatch),
    )
  ) {
    throw new Error(
      `receipt ${receiptPath} does not match its durable run-state batch`,
    );
  }
  validateReceiptMetadata(metadataRecord.value, receiptRecord.contents, expectedBatch);
  validateRouter(routerRecord.value, {
    receipt,
    receiptPath,
    batch: expectedBatch,
    issueNumbersByGate,
  });
  return receipt.findings.length;
}

export function validateAuditEvidenceArchive({
  excludedEvidenceEntries,
  blobs,
  receiptSchema,
} = {}) {
  if (!Array.isArray(excludedEvidenceEntries)) {
    throw new Error("excludedEvidenceEntries must be an array");
  }
  if (!(blobs instanceof Map)) {
    throw new Error("blobs must be a Map keyed by evidence path");
  }
  const receiptSchemaValidator = compileReceiptSchema(receiptSchema);
  const records = new Map();
  const triplets = new Map();
  const stateRecords = [];
  for (const entry of excludedEvidenceEntries) {
    if (!entry || typeof entry.path !== "string") {
      throw new Error("every excluded evidence entry needs a path");
    }
    if (records.has(entry.path)) {
      throw new Error(`duplicate sealed audit evidence path ${entry.path}`);
    }
    const record = { entry, ...parseEvidenceJson(entry, blobs) };
    records.set(entry.path, record);
    if (entry.kind === "run-state") {
      if (!entry.path.startsWith(RUNS_ROOT) || entry.path.slice(RUNS_ROOT.length).includes("/")) {
        throw new Error(`evidence kind run-state does not match path ${entry.path}`);
      }
      stateRecords.push(record);
      continue;
    }
    const stem = receiptStem(entry.path, entry.kind);
    const triplet = triplets.get(stem) || {};
    if (triplet[entry.kind]) {
      throw new Error(`duplicate ${entry.kind} artifact for ${stem}`);
    }
    triplet[entry.kind] = entry;
    triplets.set(stem, triplet);
  }
  const extraBlobs = [...blobs.keys()].filter((path) => !records.has(path));
  if (extraBlobs.length) {
    throw new Error(`blob map contains untracked evidence: ${extraBlobs.join(", ")}`);
  }
  for (const [stem, triplet] of triplets) {
    for (const kind of ["receipt", "receipt-metadata", "router-result"]) {
      if (!triplet[kind]) {
        throw new Error(`incomplete sealed audit evidence triplet ${stem}: missing ${kind}`);
      }
    }
  }

  const claimedTriplets = new Set();
  const runStates = [];
  let findingCount = 0;
  for (const record of stateRecords.sort((left, right) =>
    left.entry.path < right.entry.path ? -1 : left.entry.path > right.entry.path ? 1 : 0,
  )) {
    let state;
    try {
      state = parseAuditState(decoder.decode(record.contents));
    } catch (error) {
      throw new Error(`invalid audit run state ${record.entry.path}: ${error.message}`);
    }
    validateStateShape(state);
    if (record.entry.path !== defaultStatePath(state.baseline)) {
      throw new Error(
        `audit run state path ${record.entry.path} does not match baseline ${state.baseline}`,
      );
    }

    let batchCount = 0;
    for (const sectionName of AUDIT_SECTIONS) {
      const section = state.sections.find(({ section }) => section === sectionName);
      if (!isDeepStrictEqual(section.completedFiles, section.files)) {
        throw new Error(
          `audit run state ${record.entry.path} is not sealed: ${sectionName} is incomplete`,
        );
      }
      let offset = 0;
      for (const stateBatch of section.batches) {
        const expectedFiles = section.files.slice(
          offset,
          offset + stateBatch.auditedFiles.length,
        );
        if (!isDeepStrictEqual(stateBatch.auditedFiles, expectedFiles)) {
          throw new Error(
            `audit run state ${record.entry.path} has non-contiguous batch progress in ${sectionName}`,
          );
        }
        const receiptPath = expectedReceiptPath(state, stateBatch, offset);
        const stem = receiptPath
          .slice(FINDINGS_ROOT.length, -".json".length);
        const triplet = triplets.get(stem);
        if (!triplet) {
          throw new Error(
            `audit run state ${record.entry.path} is missing triplet ${stem}`,
          );
        }
        if (claimedTriplets.has(stem)) {
          throw new Error(`sealed evidence triplet ${stem} is claimed more than once`);
        }
        findingCount += validateTriplet({
          state,
          stateBatch,
          receiptPath,
          triplet,
          records,
          receiptSchemaValidator,
        });
        claimedTriplets.add(stem);
        offset += stateBatch.auditedFiles.length;
        batchCount += 1;
      }
      if (offset !== section.files.length) {
        throw new Error(
          `audit run state ${record.entry.path} does not batch every ${sectionName} file`,
        );
      }
    }
    runStates.push({
      path: record.entry.path,
      version: state.version,
      baseline: state.baseline,
      auditDate: state.auditDate,
      batchCount,
    });
  }
  const unclaimed = [...triplets.keys()].filter(
    (stem) => !claimedTriplets.has(stem),
  );
  if (unclaimed.length) {
    throw new Error(
      `sealed evidence contains unmanifested triplet(s): ${unclaimed.join(", ")}`,
    );
  }

  return {
    fileCount: excludedEvidenceEntries.length,
    runCount: runStates.length,
    tripletCount: claimedTriplets.size,
    findingCount,
    runStates,
  };
}
