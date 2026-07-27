import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_SCOPE_POLICY_VERSION,
  assertExactAuditUniverse,
  classifyAuditEntry,
  resolveAuditUniverse,
} from "./audit-scope.mjs";
import { artifactPaths, defaultStatePath } from "./orchestrate.mjs";

const OIDS = {
  source: "1".repeat(40),
  receipt: "2".repeat(40),
  metadata: "3".repeat(40),
  router: "4".repeat(40),
  state: "5".repeat(40),
  report: "6".repeat(40),
  script: "7".repeat(40),
  arbitraryJson: "8".repeat(40),
  nearMiss: "9".repeat(40),
};

function entry(path, oid, size = 1, overrides = {}) {
  return {
    path,
    mode: "100644",
    type: "blob",
    oid,
    size,
    ...overrides,
  };
}

const STEM = "root-c8b98a29508b-0001-73d870b4e151";

test("resolveAuditUniverse forms an exact tracked = auditable + sealed-evidence partition", () => {
  const entries = [
    entry("package.json", OIDS.source, 10),
    entry(`docs/audits/findings/${STEM}.json`, OIDS.receipt, 20),
    entry(`docs/audits/findings/${STEM}.meta.json`, OIDS.metadata, 30),
    entry(`docs/audits/findings/${STEM}.router.json`, OIDS.router, 40),
    entry(
      "docs/audits/runs/v060-c8b98a29508b.json",
      OIDS.state,
      50,
    ),
    entry("docs/audits/v060-review-phase-audit.md", OIDS.report, 60),
    entry("scripts/audits/orchestrate.mjs", OIDS.script, 70),
    entry("fixtures/arbitrary.json", OIDS.arbitraryJson, 80),
    entry("docs/audits/findings.md", OIDS.nearMiss, 90),
  ];

  const universe = resolveAuditUniverse(entries);

  assert.equal(universe.scope.policyVersion, AUDIT_SCOPE_POLICY_VERSION);
  assert.deepEqual(
    universe.auditableEntries.map(({ path }) => path),
    [
      "package.json",
      "docs/audits/v060-review-phase-audit.md",
      "scripts/audits/orchestrate.mjs",
      "fixtures/arbitrary.json",
      "docs/audits/findings.md",
    ],
  );
  assert.deepEqual(
    universe.excludedEvidenceEntries.map(({ kind }) => kind),
    ["receipt", "receipt-metadata", "router-result", "run-state"],
  );
  assert.deepEqual(
    {
      tracked: universe.scope.tracked.count,
      auditable: universe.scope.auditable.count,
      excluded: universe.scope.excludedEvidence.count,
    },
    { tracked: 9, auditable: 5, excluded: 4 },
  );
  assert.deepEqual(
    {
      tracked: universe.scope.tracked.bytes,
      auditable: universe.scope.auditable.bytes,
      excluded: universe.scope.excludedEvidence.bytes,
    },
    { tracked: 450, auditable: 310, excluded: 140 },
  );
  assert.equal(assertExactAuditUniverse(entries, universe), true);
});

test("classification is strict inside reserved evidence directories and preserves near misses outside them", () => {
  assert.equal(
    classifyAuditEntry(entry("docs/audits/runs.md", OIDS.nearMiss)).disposition,
    "auditable",
  );
  assert.throws(
    () =>
      classifyAuditEntry(
        entry(
          "docs/audits/findings/notes.json",
          OIDS.arbitraryJson,
        ),
      ),
    /unrecognized sealed audit evidence path/,
  );
  assert.throws(
    () =>
      classifyAuditEntry(
        entry(
          `docs/audits/findings/${STEM}.json`,
          OIDS.receipt,
          1,
          { mode: "100755" },
        ),
      ),
    /regular non-executable blob/,
  );
  assert.throws(
    () =>
      classifyAuditEntry(
        entry(
          "docs/audits/runs/v060-c8b98a29508b.json",
          OIDS.state,
          1,
          { mode: "120000" },
        ),
      ),
    /regular non-executable blob/,
  );
});

test("orchestrator-generated artifact and state paths are recognized evidence", () => {
  const baseline = "a".repeat(40);
  const batch = {
    baseline,
    auditDate: "2026-07-26",
    section: "root",
    gates: ["security"],
    auditedFiles: ["package.json"],
  };
  const artifacts = artifactPaths(
    { receiptDir: "docs/audits/findings" },
    {
      baseline,
      sections: [
        {
          section: "root",
          completedFiles: [],
        },
      ],
    },
    batch,
  );

  const generated = [
    [artifacts.receipt, "receipt"],
    [artifacts.metadata, "receipt-metadata"],
    [artifacts.router, "router-result"],
    [defaultStatePath(baseline), "run-state"],
  ];
  for (const [path, kind] of generated) {
    assert.deepEqual(
      classifyAuditEntry(entry(path, OIDS.receipt)),
      { disposition: "excluded-evidence", kind },
    );
  }
});

test("universe validation rejects duplicate paths and any overlap, omission, or manifest drift", () => {
  const entries = [
    entry("package.json", OIDS.source, 10),
    entry(`docs/audits/findings/${STEM}.json`, OIDS.receipt, 20),
  ];
  const universe = resolveAuditUniverse(entries);

  assert.throws(
    () => resolveAuditUniverse([...entries, entries[0]]),
    /duplicate tracked path/,
  );

  const overlap = structuredClone(universe);
  overlap.auditableEntries.push(
    structuredClone(overlap.excludedEvidenceEntries[0]),
  );
  assert.throws(
    () => assertExactAuditUniverse(entries, overlap),
    /overlap|duplicate/,
  );

  const omitted = structuredClone(universe);
  omitted.excludedEvidenceEntries = [];
  assert.throws(
    () => assertExactAuditUniverse(entries, omitted),
    /missing|count/,
  );

  const drifted = structuredClone(universe);
  drifted.scope.tracked.manifestSha256 = "0".repeat(64);
  assert.throws(
    () => assertExactAuditUniverse(entries, drifted),
    /manifest/,
  );
});
