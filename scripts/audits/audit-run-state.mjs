import { isDeepStrictEqual } from "node:util";

import { dedupKey, normalizePath, validateFinding } from "./file-findings.mjs";
import { GATES } from "./gates.config.mjs";

export const AUDIT_SECTIONS = Object.freeze([
  "root",
  "scripts/",
  "src/lib (non-detectors)",
  "src/lib/detectors",
  "src/components",
  "src (rest)",
  "docs/",
  "fixtures/",
  "e2e/",
  ".github/",
  "probaitio-operator/",
  "deploy/",
  "data/, tools/, bin/, commands/, .claude*",
]);

const MIXED_SECTION = AUDIT_SECTIONS.at(-1);
const MIXED_PREFIXES = ["data/", "tools/", "bin/", "commands/"];

function requireFileList(files, label = "files") {
  if (!Array.isArray(files)) throw new Error(`${label} must be an array`);
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new Error(`${label} must contain nonempty file-path strings`);
    }
  }
}

function requireNonemptyString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a nonempty string`);
}

function validateGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0)
    throw new Error("gates must be a nonempty array");
  const seen = new Set();
  for (const gate of gates) {
    if (typeof gate !== "string" || !GATES[gate])
      throw new Error(`unknown gate ${JSON.stringify(gate)}`);
    if (seen.has(gate))
      throw new Error(`duplicate gate ${JSON.stringify(gate)}`);
    seen.add(gate);
  }
}

function validateAuditDate(auditDate) {
  requireNonemptyString(auditDate, "auditDate");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(auditDate) ||
    new Date(`${auditDate}T00:00:00Z`).toISOString().slice(0, 10) !== auditDate
  ) {
    throw new Error("auditDate must be a valid YYYY-MM-DD date");
  }
}

function emptyIssueMap(gates) {
  return Object.fromEntries(gates.map((gate) => [gate, []]));
}

function assertExactStringSet(actual, expected, label) {
  requireFileList(actual, label);
  requireFileList(expected, `expected ${label}`);
  if (new Set(actual).size !== actual.length)
    throw new Error(`${label} contains duplicate value(s)`);
  if (new Set(expected).size !== expected.length)
    throw new Error(`expected ${label} contains duplicate value(s)`);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extras = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || extras.length) {
    throw new Error(
      `${label} does not exactly match the dispatched set` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extras.length ? `; unexpected: ${extras.join(", ")}` : ""}`,
    );
  }
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeIssueNumbersByGate(issueNumbersByGate, gates) {
  const input = issueNumbersByGate == null ? {} : issueNumbersByGate;
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("issueNumbersByGate must be an object");
  const unknownGates = Object.keys(input).filter(
    (gate) => !gates.includes(gate),
  );
  if (unknownGates.length)
    throw new Error(
      `issueNumbersByGate contains inactive gate(s): ${unknownGates.join(", ")}`,
    );
  return Object.fromEntries(
    gates.map((gate) => {
      const numbers = input[gate] ?? [];
      if (!Array.isArray(numbers))
        throw new Error(`issueNumbersByGate.${gate} must be an array`);
      for (const number of numbers) {
        if (!Number.isInteger(number) || number < 1) {
          throw new Error(
            `issueNumbersByGate.${gate} must contain positive integer issue numbers`,
          );
        }
      }
      return [gate, [...new Set(numbers)].sort((a, b) => a - b)];
    }),
  );
}

function unionIssueMaps(left, right, gates) {
  return Object.fromEntries(
    gates.map((gate) => [
      gate,
      [...new Set([...(left[gate] || []), ...(right[gate] || [])])].sort(
        (a, b) => a - b,
      ),
    ]),
  );
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
      const byGate = new Map(
        verdict.gates.map((gateVerdict) => [gateVerdict.gate, gateVerdict]),
      );
      return {
        file,
        gates: expectedBatch.gates.map((gate) =>
          cloneSerializable(byGate.get(gate)),
        ),
      };
    }),
    findings: receipt.findings
      .map(cloneSerializable)
      .sort((left, right) => dedupKey(left).localeCompare(dedupKey(right))),
  };
}

function sectionForFile(file) {
  if (!file.includes("/") && !file.startsWith(".claude")) return "root";
  if (file.startsWith("scripts/")) return "scripts/";
  if (file.startsWith("src/lib/detectors/")) return "src/lib/detectors";
  if (file.startsWith("src/lib/")) return "src/lib (non-detectors)";
  if (file.startsWith("src/components/")) return "src/components";
  if (file.startsWith("src/")) return "src (rest)";
  if (file.startsWith("docs/")) return "docs/";
  if (file.startsWith("fixtures/")) return "fixtures/";
  if (file.startsWith("e2e/")) return "e2e/";
  if (file.startsWith(".github/")) return ".github/";
  if (file.startsWith("probaitio-operator/")) return "probaitio-operator/";
  if (file.startsWith("deploy/")) return "deploy/";
  if (
    file.startsWith(".claude") ||
    MIXED_PREFIXES.some((prefix) => file.startsWith(prefix))
  )
    return MIXED_SECTION;
  return null;
}

export function assertExactPartition(files, sectionFiles) {
  requireFileList(files);
  if (!Array.isArray(sectionFiles))
    throw new Error("sectionFiles must be an array");

  const sourceCounts = new Map();
  for (const file of files)
    sourceCounts.set(file, (sourceCounts.get(file) || 0) + 1);
  const duplicateInputs = [...sourceCounts]
    .filter(([, count]) => count !== 1)
    .map(([file]) => file);
  if (duplicateInputs.length) {
    throw new Error(
      `git file list contains duplicate path(s): ${duplicateInputs.join(", ")}`,
    );
  }

  const sectionCounts = new Map();
  const assignedCounts = new Map();
  const wrongSections = [];
  for (const entry of sectionFiles) {
    if (!entry || typeof entry.section !== "string")
      throw new Error("each sectionFiles entry needs a section");
    requireFileList(entry.files, `files for section ${entry.section}`);
    sectionCounts.set(
      entry.section,
      (sectionCounts.get(entry.section) || 0) + 1,
    );
    for (const file of entry.files) {
      assignedCounts.set(file, (assignedCounts.get(file) || 0) + 1);
      const expectedSection = sectionForFile(file);
      if (expectedSection !== entry.section) {
        wrongSections.push(
          `${file} (expected ${expectedSection || "no section"}, got ${entry.section})`,
        );
      }
    }
  }

  const badSections = [
    ...AUDIT_SECTIONS.filter((section) => sectionCounts.get(section) !== 1),
    ...[...sectionCounts.keys()].filter(
      (section) => !AUDIT_SECTIONS.includes(section),
    ),
  ];
  if (badSections.length) {
    throw new Error(
      `partition must contain each of the 13 ledger sections exactly once: ${[...new Set(badSections)].join(", ")}`,
    );
  }
  if (wrongSections.length)
    throw new Error(
      `file(s) assigned to the wrong ledger section: ${wrongSections.join("; ")}`,
    );

  const missing = files.filter((file) => !assignedCounts.has(file));
  const duplicates = [...assignedCounts]
    .filter(([, count]) => count !== 1)
    .map(([file]) => file);
  const extras = [...assignedCounts.keys()].filter(
    (file) => !sourceCounts.has(file),
  );
  if (missing.length || duplicates.length || extras.length) {
    throw new Error(
      [
        missing.length ? `missing: ${missing.join(", ")}` : "",
        duplicates.length ? `duplicate: ${duplicates.join(", ")}` : "",
        extras.length ? `unexpected: ${extras.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  return true;
}

export function partitionAuditFiles(files) {
  requireFileList(files);
  const bySection = new Map(AUDIT_SECTIONS.map((section) => [section, []]));
  for (const file of files) {
    const section = sectionForFile(file);
    if (section) bySection.get(section).push(file);
  }
  const partition = AUDIT_SECTIONS.map((section) => ({
    section,
    files: bySection.get(section),
  }));
  assertExactPartition(files, partition);
  return partition;
}

export function initializeAuditState({
  baseline,
  gates,
  auditDate,
  sectionFiles,
} = {}) {
  requireNonemptyString(baseline, "baseline");
  validateGates(gates);
  validateAuditDate(auditDate);
  if (!Array.isArray(sectionFiles))
    throw new Error("sectionFiles must be an array");
  const allFiles = sectionFiles.flatMap((entry) =>
    entry && Array.isArray(entry.files) ? entry.files : [],
  );
  assertExactPartition(allFiles, sectionFiles);

  return {
    version: 1,
    baseline,
    auditDate,
    gates: [...gates],
    sections: sectionFiles.map(({ section, files }) => ({
      section,
      files: [...files],
      completedFiles: [],
      batches: [],
      issueNumbersByGate: emptyIssueMap(gates),
    })),
    issueNumbersByGate: emptyIssueMap(gates),
  };
}

export function selectNextPendingBatch(state, maxFiles) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1)
    throw new Error("maxFiles must be a positive integer");
  if (!state || state.version !== 1)
    throw new Error("unsupported or missing audit state");
  requireNonemptyString(state.baseline, "state.baseline");
  validateAuditDate(state.auditDate);
  validateGates(state.gates);
  if (!Array.isArray(state.sections))
    throw new Error("state.sections must be an array");

  for (const section of state.sections) {
    requireFileList(section.files, `state files for ${section.section}`);
    requireFileList(
      section.completedFiles,
      `completedFiles for ${section.section}`,
    );
    const completed = new Set(section.completedFiles);
    if (completed.size !== section.completedFiles.length) {
      throw new Error(
        `completedFiles for ${section.section} contains duplicate progress`,
      );
    }
    const unknown = section.completedFiles.filter(
      (file) => !section.files.includes(file),
    );
    if (unknown.length)
      throw new Error(
        `completedFiles for ${section.section} contains unknown file(s): ${unknown.join(", ")}`,
      );
    const auditedFiles = section.files
      .filter((file) => !completed.has(file))
      .slice(0, maxFiles);
    if (auditedFiles.length) {
      return {
        baseline: state.baseline,
        auditDate: state.auditDate,
        section: section.section,
        gates: [...state.gates],
        auditedFiles,
      };
    }
  }
  return null;
}

export function validateWorkerReceipt(receipt, expectedBatch) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new Error("worker receipt must be an object");
  if (
    !expectedBatch ||
    typeof expectedBatch !== "object" ||
    Array.isArray(expectedBatch)
  ) {
    throw new Error("expectedBatch must be an object");
  }

  requireNonemptyString(expectedBatch.baseline, "expectedBatch.baseline");
  validateAuditDate(expectedBatch.auditDate);
  requireNonemptyString(expectedBatch.section, "expectedBatch.section");
  validateGates(expectedBatch.gates);
  requireFileList(expectedBatch.auditedFiles, "expectedBatch.auditedFiles");
  if (expectedBatch.auditedFiles.length === 0)
    throw new Error("expectedBatch.auditedFiles must not be empty");
  if (
    new Set(expectedBatch.auditedFiles).size !==
    expectedBatch.auditedFiles.length
  ) {
    throw new Error("expectedBatch.auditedFiles contains duplicate value(s)");
  }

  for (const field of ["baseline", "auditDate", "section"]) {
    if (receipt[field] !== expectedBatch[field]) {
      throw new Error(
        `worker receipt ${field} ${JSON.stringify(receipt[field])} does not equal dispatched ${JSON.stringify(expectedBatch[field])}`,
      );
    }
  }
  assertExactStringSet(
    receipt.gates,
    expectedBatch.gates,
    "worker receipt gates",
  );
  assertExactStringSet(
    receipt.auditedFiles,
    expectedBatch.auditedFiles,
    "worker receipt auditedFiles",
  );

  if (!Array.isArray(receipt.verdicts))
    throw new Error("worker receipt verdicts must be an array");
  const verdictFiles = receipt.verdicts.map(
    (verdict) => verdict && verdict.file,
  );
  assertExactStringSet(
    verdictFiles,
    expectedBatch.auditedFiles,
    "worker receipt verdict files",
  );

  const statusByFileGate = new Map();
  for (const verdict of receipt.verdicts) {
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict))
      throw new Error("each verdict must be an object");
    if (!Array.isArray(verdict.gates))
      throw new Error(`verdict for ${verdict.file} must contain gates[]`);
    const verdictGates = verdict.gates.map(
      (gateVerdict) => gateVerdict && gateVerdict.gate,
    );
    assertExactStringSet(
      verdictGates,
      expectedBatch.gates,
      `verdict gates for ${verdict.file}`,
    );
    for (const gateVerdict of verdict.gates) {
      if (
        !gateVerdict ||
        typeof gateVerdict !== "object" ||
        Array.isArray(gateVerdict)
      ) {
        throw new Error(
          `each gate verdict for ${verdict.file} must be an object`,
        );
      }
      if (!["clean", "n/a", "finding"].includes(gateVerdict.status)) {
        throw new Error(
          `invalid status ${JSON.stringify(gateVerdict.status)} for ${verdict.file}/${gateVerdict.gate}`,
        );
      }
      if (
        typeof gateVerdict.reason !== "string" ||
        !gateVerdict.reason.trim()
      ) {
        throw new Error(
          `verdict reason for ${verdict.file}/${gateVerdict.gate} must be nonempty`,
        );
      }
      statusByFileGate.set(
        `${verdict.file}\0${gateVerdict.gate}`,
        gateVerdict.status,
      );
    }
  }

  if (!Array.isArray(receipt.findings))
    throw new Error("worker receipt findings must be an array");
  const findingPairs = new Set();
  const findingKeys = new Set();
  for (const [index, finding] of receipt.findings.entries()) {
    const errors = validateFinding(finding);
    if (errors.length)
      throw new Error(`finding ${index + 1} is invalid: ${errors.join("; ")}`);
    const key = dedupKey(finding);
    if (findingKeys.has(key))
      throw new Error(`finding ${index + 1} duplicates audit finding ${key}`);
    findingKeys.add(key);
    if (!expectedBatch.gates.includes(finding.lens)) {
      throw new Error(
        `finding ${index + 1} uses inactive gate ${JSON.stringify(finding.lens)}`,
      );
    }
    const findingFiles = [...new Set(finding.files.map(normalizePath))];
    const outsideBatch = findingFiles.filter(
      (file) => !expectedBatch.auditedFiles.includes(file),
    );
    if (outsideBatch.length) {
      throw new Error(
        `finding ${index + 1} cites file(s) outside the dispatched batch: ${outsideBatch.join(", ")}`,
      );
    }
    for (const file of findingFiles) {
      const pair = `${file}\0${finding.lens}`;
      if (statusByFileGate.get(pair) !== "finding") {
        throw new Error(
          `finding ${index + 1} has no matching finding verdict for ${file}/${finding.lens}`,
        );
      }
      findingPairs.add(pair);
    }
  }

  for (const [pair, status] of statusByFileGate) {
    if (status === "finding" && !findingPairs.has(pair)) {
      const [file, gate] = pair.split("\0");
      throw new Error(
        `finding verdict for ${file}/${gate} has no validated finding`,
      );
    }
  }
  return true;
}

export function applyWorkerReceipt(
  state,
  expectedBatch,
  receipt,
  { issueNumbersByGate = {} } = {},
) {
  validateWorkerReceipt(receipt, expectedBatch);
  assertAuditState(state);
  if (state.baseline !== expectedBatch.baseline)
    throw new Error("expected batch baseline does not match audit state");
  if (state.auditDate !== expectedBatch.auditDate)
    throw new Error("expected batch auditDate does not match audit state");
  assertExactStringSet(
    expectedBatch.gates,
    state.gates,
    "expected batch gates vs audit state",
  );

  const incomingIssues = normalizeIssueNumbersByGate(
    issueNumbersByGate,
    state.gates,
  );
  const normalizedReceipt = normalizeReceipt(receipt, expectedBatch);
  const sectionIndex = state.sections.findIndex(
    ({ section }) => section === expectedBatch.section,
  );
  if (sectionIndex < 0)
    throw new Error(
      `unknown audit section ${JSON.stringify(expectedBatch.section)}`,
    );
  const currentSection = state.sections[sectionIndex];
  if (!Array.isArray(currentSection.batches))
    throw new Error(
      `state batches for ${currentSection.section} must be an array`,
    );

  const existingBatchIndex = currentSection.batches.findIndex(
    (batch) =>
      batch.section === expectedBatch.section &&
      batch.baseline === expectedBatch.baseline &&
      batch.auditDate === expectedBatch.auditDate &&
      Array.isArray(batch.gates) &&
      Array.isArray(batch.auditedFiles) &&
      batch.gates.length === expectedBatch.gates.length &&
      batch.auditedFiles.length === expectedBatch.auditedFiles.length &&
      batch.gates.every((gate) => expectedBatch.gates.includes(gate)) &&
      batch.auditedFiles.every((file) =>
        expectedBatch.auditedFiles.includes(file),
      ),
  );

  if (existingBatchIndex < 0) {
    const nextBatch = selectNextPendingBatch(
      state,
      expectedBatch.auditedFiles.length,
    );
    if (!nextBatch)
      throw new Error("audit state has no pending batch to apply");
    if (
      nextBatch.baseline !== expectedBatch.baseline ||
      nextBatch.auditDate !== expectedBatch.auditDate ||
      nextBatch.section !== expectedBatch.section
    ) {
      throw new Error("expected batch is not the next pending audit batch");
    }
    assertExactStringSet(
      expectedBatch.gates,
      nextBatch.gates,
      "expected batch gates vs next pending batch",
    );
    assertExactStringSet(
      expectedBatch.auditedFiles,
      nextBatch.auditedFiles,
      "expected batch files vs next pending batch",
    );
  } else {
    const { issueNumbersByGate: _storedIssues, ...storedReceipt } =
      currentSection.batches[existingBatchIndex];
    if (!isDeepStrictEqual(storedReceipt, normalizedReceipt)) {
      throw new Error(
        "conflicting worker receipt for an already-applied audit batch",
      );
    }
  }

  const issuesAvailable =
    existingBatchIndex < 0
      ? incomingIssues
      : unionIssueMaps(
          currentSection.batches[existingBatchIndex].issueNumbersByGate,
          incomingIssues,
          state.gates,
        );
  for (const gate of state.gates) {
    const findingCount = normalizedReceipt.findings.filter(
      (finding) => finding.lens === gate,
    ).length;
    if (issuesAvailable[gate].length !== findingCount) {
      throw new Error(
        `receipt has ${findingCount} ${gate} finding(s) but ${issuesAvailable[gate].length} filed issue number(s)`,
      );
    }
  }

  const nextState = cloneSerializable(state);
  const nextSection = nextState.sections[sectionIndex];
  if (existingBatchIndex < 0) {
    const completed = new Set([
      ...nextSection.completedFiles,
      ...normalizedReceipt.auditedFiles,
    ]);
    nextSection.completedFiles = nextSection.files.filter((file) =>
      completed.has(file),
    );
    nextSection.batches.push({
      ...normalizedReceipt,
      issueNumbersByGate: incomingIssues,
    });
  } else {
    nextSection.batches[existingBatchIndex].issueNumbersByGate =
      issuesAvailable;
  }
  nextSection.issueNumbersByGate = unionIssueMaps(
    nextSection.issueNumbersByGate,
    incomingIssues,
    state.gates,
  );
  nextState.issueNumbersByGate = unionIssueMaps(
    nextState.issueNumbersByGate,
    incomingIssues,
    state.gates,
  );
  assertAuditState(nextState);
  return nextState;
}

function assertStoredIssueMap(issueNumbersByGate, gates, label) {
  if (
    !issueNumbersByGate ||
    typeof issueNumbersByGate !== "object" ||
    Array.isArray(issueNumbersByGate)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(issueNumbersByGate);
  assertExactStringSet(keys, gates, `${label} keys`);
  const normalized = normalizeIssueNumbersByGate(issueNumbersByGate, gates);
  for (const gate of gates) {
    if (
      new Set(issueNumbersByGate[gate]).size !== issueNumbersByGate[gate].length
    ) {
      throw new Error(`${label}.${gate} contains duplicate issue number(s)`);
    }
  }
  return normalized;
}

export function assertAuditState(state) {
  if (!state || state.version !== 1)
    throw new Error("unsupported or missing audit state");
  requireNonemptyString(state.baseline, "state.baseline");
  validateAuditDate(state.auditDate);
  validateGates(state.gates);
  if (!Array.isArray(state.sections))
    throw new Error("state.sections must be an array");
  if (
    !isDeepStrictEqual(
      state.sections.map(({ section }) => section),
      AUDIT_SECTIONS,
    )
  ) {
    throw new Error(
      "state.sections must follow the ordered 13-section ledger taxonomy",
    );
  }
  const allFiles = state.sections.flatMap((section) =>
    Array.isArray(section.files) ? section.files : [],
  );
  assertExactPartition(allFiles, state.sections);
  const globalIssues = assertStoredIssueMap(
    state.issueNumbersByGate,
    state.gates,
    "state.issueNumbersByGate",
  );
  let issuesFromSections = emptyIssueMap(state.gates);

  for (const section of state.sections) {
    requireFileList(
      section.completedFiles,
      `completedFiles for ${section.section}`,
    );
    if (
      new Set(section.completedFiles).size !== section.completedFiles.length
    ) {
      throw new Error(
        `completedFiles for ${section.section} contains duplicate progress`,
      );
    }
    const unknown = section.completedFiles.filter(
      (file) => !section.files.includes(file),
    );
    if (unknown.length)
      throw new Error(
        `completedFiles for ${section.section} contains unknown file(s): ${unknown.join(", ")}`,
      );
    const canonicalCompleted = section.files.filter((file) =>
      section.completedFiles.includes(file),
    );
    if (!isDeepStrictEqual(section.completedFiles, canonicalCompleted)) {
      throw new Error(
        `completedFiles for ${section.section} must retain baseline file order`,
      );
    }
    if (!Array.isArray(section.batches))
      throw new Error(`batches for ${section.section} must be an array`);

    const sectionIssues = assertStoredIssueMap(
      section.issueNumbersByGate,
      state.gates,
      `issueNumbersByGate for ${section.section}`,
    );
    let issuesFromBatches = emptyIssueMap(state.gates);
    const filesFromBatches = new Set();
    for (const [index, batch] of section.batches.entries()) {
      if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
        throw new Error(
          `batch ${index + 1} for ${section.section} must be an object`,
        );
      }
      const expectedBatch = {
        baseline: state.baseline,
        auditDate: state.auditDate,
        section: section.section,
        gates: state.gates,
        auditedFiles: batch.auditedFiles,
      };
      validateWorkerReceipt(batch, expectedBatch);
      const batchIssues = assertStoredIssueMap(
        batch.issueNumbersByGate,
        state.gates,
        `issueNumbersByGate for ${section.section} batch ${index + 1}`,
      );
      for (const gate of state.gates) {
        const findingCount = batch.findings.filter(
          (finding) => finding.lens === gate,
        ).length;
        if (batchIssues[gate].length !== findingCount) {
          throw new Error(
            `batch ${index + 1} for ${section.section} has ${findingCount} ${gate} finding(s) but ${batchIssues[gate].length} filed issue number(s)`,
          );
        }
      }
      for (const file of batch.auditedFiles) {
        if (filesFromBatches.has(file))
          throw new Error(
            `batches for ${section.section} contain duplicate progress for ${file}`,
          );
        filesFromBatches.add(file);
      }
      issuesFromBatches = unionIssueMaps(
        issuesFromBatches,
        batchIssues,
        state.gates,
      );
    }

    const completedSet = new Set(section.completedFiles);
    const missingBatchProgress = section.completedFiles.filter(
      (file) => !filesFromBatches.has(file),
    );
    const extraBatchProgress = [...filesFromBatches].filter(
      (file) => !completedSet.has(file),
    );
    if (missingBatchProgress.length || extraBatchProgress.length) {
      throw new Error(
        `batch progress for ${section.section} does not equal completedFiles` +
          `${missingBatchProgress.length ? `; missing batches: ${missingBatchProgress.join(", ")}` : ""}` +
          `${extraBatchProgress.length ? `; unexpected batch files: ${extraBatchProgress.join(", ")}` : ""}`,
      );
    }
    if (!isDeepStrictEqual(sectionIssues, issuesFromBatches)) {
      throw new Error(
        `issueNumbersByGate for ${section.section} does not equal its batch issue aggregation`,
      );
    }
    issuesFromSections = unionIssueMaps(
      issuesFromSections,
      sectionIssues,
      state.gates,
    );
  }
  if (!isDeepStrictEqual(globalIssues, issuesFromSections)) {
    throw new Error(
      "state.issueNumbersByGate does not equal its section issue aggregation",
    );
  }
  return true;
}

function requireLedgerState(state) {
  assertAuditState(state);
}

function ledgerCell(section, gate) {
  const completed = new Set(section.completedFiles);
  const complete = section.files.every((file) => completed.has(file));
  if (!complete) return completed.size ? "WIP" : "—";
  const issues = [...new Set(section.issueNumbersByGate[gate] || [])].sort(
    (a, b) => a - b,
  );
  return issues.length
    ? `DONE (${issues.map((number) => `#${number}`).join(", ")})`
    : "DONE (clean)";
}

function markdownRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

export function renderLedgerTable(state) {
  requireLedgerState(state);
  const header = [
    "Section",
    "Files",
    ...state.gates.map((gate) => `${gate} → #${GATES[gate].epic}`),
  ];
  const lines = [markdownRow(header), `|${header.map(() => "---").join("|")}|`];
  for (const sectionName of AUDIT_SECTIONS) {
    const section = state.sections.find(
      ({ section }) => section === sectionName,
    );
    lines.push(
      markdownRow([
        sectionName,
        String(section.files.length),
        ...state.gates.map((gate) => ledgerCell(section, gate)),
      ]),
    );
  }
  return lines.join("\n");
}

function parseMarkdownRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function updateLedgerMarkdown(markdown, state) {
  requireLedgerState(state);
  if (typeof markdown !== "string")
    throw new Error("ledger markdown must be a string");
  const lines = markdown.split("\n");
  const headerIndex = lines.findIndex((line) => {
    if (!/^\s*\|/.test(line)) return false;
    const cells = parseMarkdownRow(line);
    return cells[0] === "Section" && cells[1] === "Files";
  });
  if (headerIndex < 0)
    throw new Error("ledger markdown has no Section/Files table");

  const header = parseMarkdownRow(lines[headerIndex]);
  const gateByColumn = new Map();
  for (let index = 2; index < header.length; index++) {
    const matches = Object.keys(GATES).filter((gate) =>
      header[index].includes(gate),
    );
    if (matches.length === 1) gateByColumn.set(index, matches[0]);
  }
  for (const gate of state.gates) {
    if (![...gateByColumn.values()].includes(gate)) {
      throw new Error(`ledger table has no column for active gate ${gate}`);
    }
  }

  let tableEnd = headerIndex + 1;
  while (tableEnd < lines.length && /^\s*\|/.test(lines[tableEnd])) tableEnd++;
  const existingBySection = new Map();
  for (const line of lines.slice(headerIndex + 1, tableEnd)) {
    const cells = parseMarkdownRow(line);
    if (AUDIT_SECTIONS.includes(cells[0]))
      existingBySection.set(cells[0], cells);
  }

  const replacement = [
    markdownRow(header),
    `|${header.map(() => "---").join("|")}|`,
  ];
  for (const sectionName of AUDIT_SECTIONS) {
    const section = state.sections.find(
      ({ section }) => section === sectionName,
    );
    const oldCells = existingBySection.get(sectionName) || [];
    const cells = Array.from(
      { length: header.length },
      (_, index) => oldCells[index] || "—",
    );
    cells[0] = sectionName;
    cells[1] = String(section.files.length);
    for (const [index, gate] of gateByColumn) {
      if (state.gates.includes(gate)) cells[index] = ledgerCell(section, gate);
    }
    replacement.push(markdownRow(cells));
  }
  lines.splice(headerIndex, tableEnd - headerIndex, ...replacement);
  return lines.join("\n");
}

export function serializeAuditState(state) {
  assertAuditState(state);
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseAuditState(json) {
  if (typeof json !== "string")
    throw new Error("audit state must be valid JSON text");
  let state;
  try {
    state = JSON.parse(json);
  } catch (error) {
    throw new Error(`audit state must be valid JSON: ${error.message}`);
  }
  assertAuditState(state);
  return state;
}
