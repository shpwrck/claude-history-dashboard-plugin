import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUDIT_SECTIONS,
  applyWorkerReceipt,
  assertAuditState,
  assertExactPartition,
  initializeAuditState,
  partitionAuditFiles,
  parseAuditState,
  renderLedgerTable,
  selectNextPendingBatch,
  serializeAuditState,
  updateLedgerMarkdown,
  validateWorkerReceipt,
} from "./audit-run-state.mjs";

const ALL_SECTION_FILES = [
  "package.json",
  ".gitignore",
  "scripts/audit.mjs",
  "src/lib/parse.ts",
  "src/lib/detectors/performance/slow.ts",
  "src/components/Card.tsx",
  "src/App.tsx",
  "docs/guide.md",
  "fixtures/session.json",
  "e2e/dashboard.spec.ts",
  ".github/workflows/ci.yml",
  "probaitio-operator/main.go",
  "deploy/nginx.conf",
  "data/pricing.json",
  "tools/check.mjs",
  "bin/chd",
  "commands/audit.md",
  ".claude/settings.json",
  ".claude-plugin/plugin.json",
  ".claudeignore",
];

const V2_SCOPE = {
  policyVersion: 1,
  tracked: {
    count: ALL_SECTION_FILES.length + 4,
    bytes: 240,
    manifestSha256: "1".repeat(64),
  },
  auditable: {
    count: ALL_SECTION_FILES.length,
    bytes: 200,
    manifestSha256: "2".repeat(64),
  },
  excludedEvidence: {
    count: 4,
    bytes: 40,
    manifestSha256: "3".repeat(64),
  },
};

function makeState(gates = ["security", "performance"]) {
  return initializeAuditState({
    baseline: "abc123",
    gates,
    auditDate: "2026-07-26",
    sectionFiles: partitionAuditFiles(ALL_SECTION_FILES),
    scope: V2_SCOPE,
  });
}

function finding(overrides = {}) {
  return {
    lens: "security",
    severity: "high",
    title: "Unsafe package script",
    files: ["package.json:1"],
    where: "- `package.json:1`",
    what: "A command can be injected.",
    fix: "Pass arguments without a shell.",
    acceptance: "The injection regression test passes.",
    verified: true,
    verifyNote: "Read from the pinned baseline.",
    ...overrides,
  };
}

function validReceipt(expectedBatch) {
  return {
    baseline: expectedBatch.baseline,
    auditDate: expectedBatch.auditDate,
    section: expectedBatch.section,
    gates: [...expectedBatch.gates],
    auditedFiles: [...expectedBatch.auditedFiles],
    verdicts: expectedBatch.auditedFiles.map((file) => ({
      file,
      gates: expectedBatch.gates.map((gate) => ({
        gate,
        status:
          file === "package.json" && gate === "security"
            ? "finding"
            : gate === "performance"
              ? "n/a"
              : "clean",
        reason:
          file === "package.json" && gate === "security"
            ? "The package script passes untrusted text to a shell."
            : gate === "performance"
              ? "This metadata file does not execute on a performance-sensitive path."
              : "No security-sensitive behavior is present.",
      })),
    })),
    findings: [finding()],
  };
}

test("partitionAuditFiles assigns every tracked file to the ordered 13-section ledger taxonomy", () => {
  const sections = partitionAuditFiles(ALL_SECTION_FILES);

  assert.deepEqual(
    sections.map(({ section }) => section),
    AUDIT_SECTIONS,
  );
  assert.deepEqual(sections.find(({ section }) => section === "root").files, [
    "package.json",
    ".gitignore",
  ]);
  assert.deepEqual(
    sections.find(({ section }) => section === "src/lib (non-detectors)").files,
    ["src/lib/parse.ts"],
  );
  assert.deepEqual(
    sections.find(({ section }) => section === "src (rest)").files,
    ["src/App.tsx"],
  );
  assert.deepEqual(
    sections.find(
      ({ section }) => section === "data/, tools/, bin/, commands/, .claude*",
    ).files,
    [
      "data/pricing.json",
      "tools/check.mjs",
      "bin/chd",
      "commands/audit.md",
      ".claude/settings.json",
      ".claude-plugin/plugin.json",
      ".claudeignore",
    ],
  );
  assert.equal(assertExactPartition(ALL_SECTION_FILES, sections), true);
});

test("partition assertions reject unknown, missing, duplicate, and misclassified tracked files", () => {
  assert.throws(
    () => partitionAuditFiles([...ALL_SECTION_FILES, "public/logo.svg"]),
    /missing|no section/,
  );
  assert.throws(
    () => partitionAuditFiles([...ALL_SECTION_FILES, "package.json"]),
    /duplicate path/,
  );

  const missingSection = partitionAuditFiles(ALL_SECTION_FILES).slice(0, -1);
  assert.throws(
    () => assertExactPartition(ALL_SECTION_FILES, missingSection),
    /13 ledger sections/,
  );

  const duplicateAssignment = structuredClone(
    partitionAuditFiles(ALL_SECTION_FILES),
  );
  duplicateAssignment[0].files.push("package.json");
  assert.throws(
    () => assertExactPartition(ALL_SECTION_FILES, duplicateAssignment),
    /duplicate/,
  );

  const wrongSection = structuredClone(partitionAuditFiles(ALL_SECTION_FILES));
  wrongSection.find(({ section }) => section === "src (rest)").files = [];
  wrongSection
    .find(({ section }) => section === "root")
    .files.push("src/App.tsx");
  assert.throws(
    () => assertExactPartition(ALL_SECTION_FILES, wrongSection),
    /wrong ledger section/,
  );

  const reordered = structuredClone(partitionAuditFiles(ALL_SECTION_FILES));
  reordered[0].files.reverse();
  assert.throws(
    () => assertExactPartition(ALL_SECTION_FILES, reordered),
    /baseline file order/,
  );
});

test("initializeAuditState creates deterministic serializable progress for every section and active gate", () => {
  const sectionFiles = partitionAuditFiles(ALL_SECTION_FILES);
  const state = initializeAuditState({
    baseline: "abc123",
    gates: ["security", "performance"],
    auditDate: "2026-07-26",
    sectionFiles,
    scope: V2_SCOPE,
  });

  assert.equal(state.version, 2);
  assert.equal(state.baseline, "abc123");
  assert.equal(state.auditDate, "2026-07-26");
  assert.deepEqual(state.gates, ["security", "performance"]);
  assert.deepEqual(state.scope, V2_SCOPE);
  assert.deepEqual(state.issueNumbersByGate, { security: [], performance: [] });
  assert.deepEqual(state.sections[0], {
    section: "root",
    files: ["package.json", ".gitignore"],
    completedFiles: [],
    batches: [],
    issueNumbersByGate: { security: [], performance: [] },
  });
  assert.doesNotThrow(() => JSON.stringify(state));
});

test("initializeAuditState records a validated v2 audit-universe seal when scope is provided", () => {
  const state = initializeAuditState({
    baseline: "abc123",
    gates: ["security", "performance"],
    auditDate: "2026-07-26",
    sectionFiles: partitionAuditFiles(ALL_SECTION_FILES),
    scope: V2_SCOPE,
  });

  assert.equal(state.version, 2);
  assert.deepEqual(state.scope, V2_SCOPE);
  assert.equal(assertAuditState(state), true);
  assert.deepEqual(parseAuditState(serializeAuditState(state)), state);
  assert.equal(selectNextPendingBatch(state, 1).auditedFiles[0], "package.json");
});

test("v2 state rejects corrupt scope equations, section counts, and unsupported policy versions", () => {
  const makeV2 = () =>
    initializeAuditState({
      baseline: "abc123",
      gates: ["security"],
      auditDate: "2026-07-26",
      sectionFiles: partitionAuditFiles(ALL_SECTION_FILES),
      scope: V2_SCOPE,
    });

  const badEquation = makeV2();
  badEquation.scope.tracked.count += 1;
  assert.throws(() => assertAuditState(badEquation), /count equation/);

  const badAuditableCount = makeV2();
  badAuditableCount.scope.auditable.count -= 1;
  badAuditableCount.scope.excludedEvidence.count += 1;
  assert.throws(
    () => assertAuditState(badAuditableCount),
    /auditable count.*section/i,
  );

  const badByteEquation = makeV2();
  badByteEquation.scope.tracked.bytes += 1;
  assert.throws(() => assertAuditState(badByteEquation), /byte equation/);

  const badPolicy = makeV2();
  badPolicy.scope.policyVersion = 999;
  assert.throws(
    () => assertAuditState(badPolicy),
    /unsupported audit scope policy/,
  );

  const badDigest = makeV2();
  badDigest.scope.tracked.manifestSha256 = "not-a-digest";
  assert.throws(() => assertAuditState(badDigest), /manifestSha256/);

  const unexpectedMetric = makeV2();
  unexpectedMetric.scope.auditable.extra = true;
  assert.throws(
    () => assertAuditState(unexpectedMetric),
    /must contain exactly/,
  );
});

test("initializeAuditState rejects invalid provenance and gate sets", () => {
  const sectionFiles = partitionAuditFiles(ALL_SECTION_FILES);
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "abc",
        gates: ["security"],
        auditDate: "2026-07-26",
        sectionFiles,
      }),
    /state\.scope/,
  );
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "",
        gates: ["security"],
        auditDate: "2026-07-26",
        sectionFiles,
        scope: V2_SCOPE,
      }),
    /baseline/,
  );
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "abc",
        gates: [],
        auditDate: "2026-07-26",
        sectionFiles,
        scope: V2_SCOPE,
      }),
    /gates/,
  );
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "abc",
        gates: ["security", "security"],
        auditDate: "2026-07-26",
        sectionFiles,
        scope: V2_SCOPE,
      }),
    /duplicate gate/,
  );
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "abc",
        gates: ["not-a-gate"],
        auditDate: "2026-07-26",
        sectionFiles,
        scope: V2_SCOPE,
      }),
    /unknown gate/,
  );
  assert.throws(
    () =>
      initializeAuditState({
        baseline: "abc",
        gates: ["security"],
        auditDate: "2026-02-30",
        sectionFiles,
        scope: V2_SCOPE,
      }),
    /valid YYYY-MM-DD/,
  );
});

test("selectNextPendingBatch resumes at the first incomplete file without reselecting completed work", () => {
  const state = initializeAuditState({
    baseline: "abc123",
    gates: ["security", "performance"],
    auditDate: "2026-07-26",
    sectionFiles: partitionAuditFiles(ALL_SECTION_FILES),
    scope: V2_SCOPE,
  });

  assert.deepEqual(selectNextPendingBatch(state, 1), {
    baseline: "abc123",
    auditDate: "2026-07-26",
    section: "root",
    gates: ["security", "performance"],
    auditedFiles: ["package.json"],
  });

  state.sections[0].completedFiles.push("package.json");
  assert.deepEqual(selectNextPendingBatch(state, 5).auditedFiles, [
    ".gitignore",
  ]);
  state.sections[0].completedFiles.push(".gitignore");
  assert.equal(selectNextPendingBatch(state, 5).section, "scripts/");
});

test("validateWorkerReceipt accepts an exact batch echo with one reasoned verdict per file and gate", () => {
  const expectedBatch = selectNextPendingBatch(makeState(), 2);
  const receipt = validReceipt(expectedBatch);

  assert.equal(validateWorkerReceipt(receipt, expectedBatch), true);
});

test("validateWorkerReceipt treats gates and files as exact duplicate-free sets", () => {
  const expectedBatch = selectNextPendingBatch(makeState(), 2);
  const reordered = validReceipt(expectedBatch);
  reordered.gates.reverse();
  reordered.auditedFiles.reverse();
  reordered.verdicts.reverse();
  for (const verdict of reordered.verdicts) verdict.gates.reverse();
  assert.equal(validateWorkerReceipt(reordered, expectedBatch), true);

  const cases = [
    ["baseline drift", (receipt) => (receipt.baseline = "wrong"), /baseline/],
    [
      "audit-date drift",
      (receipt) => (receipt.auditDate = "2026-07-25"),
      /auditDate/,
    ],
    ["section drift", (receipt) => (receipt.section = "scripts/"), /section/],
    ["missing gate echo", (receipt) => receipt.gates.pop(), /gates/],
    [
      "duplicate gate echo",
      (receipt) => receipt.gates.push("security"),
      /duplicate/,
    ],
    [
      "missing file echo",
      (receipt) => receipt.auditedFiles.pop(),
      /auditedFiles/,
    ],
    [
      "duplicate file echo",
      (receipt) => receipt.auditedFiles.push("package.json"),
      /duplicate/,
    ],
    [
      "missing file verdict",
      (receipt) => receipt.verdicts.pop(),
      /verdict files/,
    ],
    [
      "duplicate file verdict",
      (receipt) => receipt.verdicts.push(structuredClone(receipt.verdicts[0])),
      /duplicate/,
    ],
    [
      "missing gate verdict",
      (receipt) => receipt.verdicts[0].gates.pop(),
      /verdict gates/,
    ],
    [
      "duplicate gate verdict",
      (receipt) =>
        receipt.verdicts[0].gates.push(
          structuredClone(receipt.verdicts[0].gates[0]),
        ),
      /duplicate/,
    ],
    [
      "invalid status",
      (receipt) => (receipt.verdicts[0].gates[0].status = "maybe"),
      /invalid status/,
    ],
    [
      "blank reason",
      (receipt) => (receipt.verdicts[0].gates[0].reason = "  "),
      /reason/,
    ],
    [
      "unverified finding",
      (receipt) => (receipt.findings[0].verified = false),
      /not verified/,
    ],
    [
      "inactive finding gate",
      (receipt) => (receipt.findings[0].lens = "data-integrity"),
      /inactive gate/,
    ],
    [
      "finding outside batch",
      (receipt) => (receipt.findings[0].files = ["scripts/audit.mjs:1"]),
      /outside/,
    ],
    [
      "finding without finding verdict",
      (receipt) => (receipt.verdicts[0].gates[0].status = "clean"),
      /matching finding verdict/,
    ],
    [
      "finding verdict without finding",
      (receipt) => (receipt.findings = []),
      /has no validated finding/,
    ],
    [
      "duplicate finding",
      (receipt) => receipt.findings.push(structuredClone(receipt.findings[0])),
      /duplicates audit finding/,
    ],
  ];
  for (const [name, mutate, pattern] of cases) {
    const receipt = validReceipt(expectedBatch);
    mutate(receipt);
    assert.throws(
      () => validateWorkerReceipt(receipt, expectedBatch),
      pattern,
      name,
    );
  }

  const emptyBatch = { ...expectedBatch, auditedFiles: [] };
  assert.throws(
    () =>
      validateWorkerReceipt(
        {
          ...emptyBatch,
          verdicts: [],
          findings: [],
        },
        emptyBatch,
      ),
    /must not be empty/,
  );
});

test("applyWorkerReceipt records a validated batch and issue numbers immutably and idempotently", () => {
  const state = makeState();
  const expectedBatch = selectNextPendingBatch(state, 2);
  const receipt = validReceipt(expectedBatch);
  const applied = applyWorkerReceipt(state, expectedBatch, receipt, {
    issueNumbersByGate: { security: [3100] },
  });

  assert.deepEqual(state.sections[0].completedFiles, []);
  assert.deepEqual(applied.sections[0].completedFiles, [
    "package.json",
    ".gitignore",
  ]);
  assert.equal(applied.sections[0].batches.length, 1);
  assert.deepEqual(applied.sections[0].issueNumbersByGate, {
    security: [3100],
    performance: [],
  });
  assert.deepEqual(applied.issueNumbersByGate, {
    security: [3100],
    performance: [],
  });
  assert.equal(selectNextPendingBatch(applied, 10).section, "scripts/");

  const reapplied = applyWorkerReceipt(applied, expectedBatch, receipt, {
    issueNumbersByGate: { security: [3100] },
  });
  assert.deepEqual(reapplied, applied);
});

test("applyWorkerReceipt rejects unfiled findings, conflicting replays, and partial-overlap progress", () => {
  const state = makeState();
  const firstFileBatch = selectNextPendingBatch(state, 1);
  const firstReceipt = validReceipt(firstFileBatch);
  assert.throws(
    () => applyWorkerReceipt(state, firstFileBatch, firstReceipt),
    /0 filed issue number/,
  );
  assert.throws(
    () =>
      applyWorkerReceipt(state, firstFileBatch, firstReceipt, {
        issueNumbersByGate: { security: [0] },
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      applyWorkerReceipt(state, firstFileBatch, firstReceipt, {
        issueNumbersByGate: { "data-integrity": [3100] },
      }),
    /inactive gate/,
  );
  assert.throws(
    () =>
      applyWorkerReceipt(state, firstFileBatch, firstReceipt, {
        issueNumbersByGate: { security: [3100], performance: [3101] },
      }),
    /0 performance finding.*1 filed issue number/,
  );

  const firstApplied = applyWorkerReceipt(state, firstFileBatch, firstReceipt, {
    issueNumbersByGate: { security: [3100] },
  });
  const conflicting = structuredClone(firstReceipt);
  conflicting.verdicts[0].gates[0].reason =
    "A different but still nonempty conclusion.";
  assert.throws(
    () =>
      applyWorkerReceipt(firstApplied, firstFileBatch, conflicting, {
        issueNumbersByGate: { security: [3100] },
      }),
    /conflicting worker receipt/,
  );

  const overlappingBatch = selectNextPendingBatch(state, 2);
  assert.throws(
    () =>
      applyWorkerReceipt(
        firstApplied,
        overlappingBatch,
        validReceipt(overlappingBatch),
        {
          issueNumbersByGate: { security: [3100] },
        },
      ),
    /next pending|exactly match/,
  );
});

test("partial section progress renders WIP for every active gate, never DONE", () => {
  const state = makeState();
  const expectedBatch = selectNextPendingBatch(state, 1);
  const applied = applyWorkerReceipt(
    state,
    expectedBatch,
    validReceipt(expectedBatch),
    {
      issueNumbersByGate: { security: [3100] },
    },
  );
  const rootRow = renderLedgerTable(applied)
    .split("\n")
    .find((line) => line.startsWith("| root |"));

  assert.equal(rootRow, "| root | 2 | WIP | WIP |");
  assert.doesNotMatch(rootRow, /DONE/);
});

test("ledger rendering uses baseline counts and withholds DONE until a whole section is complete", () => {
  const state = makeState();
  const expectedBatch = selectNextPendingBatch(state, 2);
  const applied = applyWorkerReceipt(
    state,
    expectedBatch,
    validReceipt(expectedBatch),
    {
      issueNumbersByGate: { security: [3100] },
    },
  );

  const table = renderLedgerTable(applied);
  assert.match(
    table,
    /^\| Section \| Files \| security → #1932 \| performance → #1930 \|/,
  );
  assert.match(table, /\| root \| 2 \| DONE \(#3100\) \| DONE \(clean\) \|/);
  assert.match(table, /\| scripts\/ \| 1 \| — \| — \|/);
  assert.match(
    table,
    /\| data\/, tools\/, bin\/, commands\/, \.claude\* \| 7 \| — \| — \|/,
  );

  const markdown = [
    "# Audit",
    "",
    "Keep this prose.",
    "",
    "| Section | Files | security → #1932 | data-integrity → #2133 | performance → #1930 |",
    "|---|---|---|---|---|",
    "| root | 99 | DONE (wrong) | WIP | DONE (wrong) |",
    "| scripts/ | 99 | — | DONE (#2999) | — |",
    "",
    "Keep this footer.",
    "",
  ].join("\n");
  const updated = updateLedgerMarkdown(markdown, applied);

  assert.match(updated, /Keep this prose\./);
  assert.match(updated, /Keep this footer\./);
  assert.match(
    updated,
    /\| root \| 2 \| DONE \(#3100\) \| WIP \| DONE \(clean\) \|/,
  );
  assert.match(updated, /\| scripts\/ \| 1 \| — \| DONE \(#2999\) \| — \|/);
  assert.equal(
    updated.split("\n").filter((line) => /^\| (?!-)/.test(line)).length,
    14,
  );
});

test("v2 ledger updates insert and replace one idempotent audit-scope equation", () => {
  const state = makeState(["security"]);
  const markdown = [
    "# Audit",
    "",
    "| Section | Files | security → #1932 |",
    "|---|---|---|",
    ...AUDIT_SECTIONS.map((section) => `| ${section} | 0 | — |`),
    "",
  ].join("\n");

  const updated = updateLedgerMarkdown(markdown, state);
  assert.match(
    updated,
    /<!-- audit-scope:start -->\n\*\*Audit scope \(policy v1\):\*\* 24 tracked files \(240 bytes\) = 20 auditable files \(200 bytes\) \+ 4 excluded sealed-evidence files \(40 bytes\)\.\n<!-- audit-scope:end -->\n\n\| Section \| Files \|/,
  );
  assert.equal(updateLedgerMarkdown(updated, state), updated);

  const changed = structuredClone(state);
  changed.scope.tracked.bytes += 5;
  changed.scope.excludedEvidence.bytes += 5;
  const replaced = updateLedgerMarkdown(updated, changed);
  assert.match(replaced, /tracked files \(245 bytes\)/);
  assert.equal(
    (replaced.match(/<!-- audit-scope:start -->/g) || []).length,
    1,
  );
});

test("ledger scope markers fail closed when partial or duplicated", () => {
  const table = renderLedgerTable(makeState(["security"]));
  assert.throws(
    () =>
      updateLedgerMarkdown(
        `<!-- audit-scope:start -->\n${table}\n`,
        makeState(["security"]),
      ),
    /scope marker/i,
  );
  assert.throws(
    () =>
      updateLedgerMarkdown(
        [
          "<!-- audit-scope:start -->",
          "<!-- audit-scope:end -->",
          "<!-- audit-scope:start -->",
          "<!-- audit-scope:end -->",
          table,
          "",
        ].join("\n"),
        makeState(["security"]),
      ),
    /scope marker/i,
  );
});

test("updating the completed v0.6 ledger from its sealed v1 state is byte-stable", () => {
  const state = parseAuditState(
    readFileSync(
      new URL(
        "../../docs/audits/runs/v060-c8b98a29508b.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const markdown = readFileSync(
    new URL(
      "../../docs/audits/v060-review-phase-audit.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(updateLedgerMarkdown(markdown, state), markdown);
});

test("state serialization round-trips only self-consistent durable progress", () => {
  const state = makeState();
  const expectedBatch = selectNextPendingBatch(state, 2);
  const applied = applyWorkerReceipt(
    state,
    expectedBatch,
    validReceipt(expectedBatch),
    {
      issueNumbersByGate: { security: [3100] },
    },
  );

  assert.equal(assertAuditState(applied), true);
  const json = serializeAuditState(applied);
  assert.match(json, /"version": 2/);
  assert.equal(json.endsWith("\n"), true);
  assert.deepEqual(parseAuditState(json), applied);

  const corrupt = structuredClone(applied);
  corrupt.sections[0].completedFiles.push("scripts/audit.mjs");
  assert.throws(() => assertAuditState(corrupt), /unknown|batch progress/i);
  assert.throws(() => parseAuditState("{not json"), /valid JSON/i);
});

test("the sealed v0.6 legacy v1 state remains readable without migration", () => {
  const text = readFileSync(
    new URL(
      "../../docs/audits/runs/v060-c8b98a29508b.json",
      import.meta.url,
    ),
    "utf8",
  );
  const state = parseAuditState(text);

  assert.equal(state.version, 1);
  assert.equal(state.scope, undefined);
  assert.equal(
    state.sections.reduce(
      (total, section) => total + section.completedFiles.length,
      0,
    ),
    1487,
  );
  assert.equal(selectNextPendingBatch(state, 1), null);
  assert.deepEqual(parseAuditState(serializeAuditState(state)), state);
});
