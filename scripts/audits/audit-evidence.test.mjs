import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyAuditEntry } from "./audit-scope.mjs";
import { validateAuditEvidenceArchive } from "./audit-evidence.mjs";

const AUDIT_DIR = fileURLToPath(new URL("../../docs/audits/", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));
const RECEIPT_SCHEMA = JSON.parse(
  readFileSync(new URL("./audit-receipt.schema.json", import.meta.url), "utf8"),
);

function gitBlobOid(contents) {
  return createHash("sha1")
    .update(`blob ${contents.length}\0`)
    .update(contents)
    .digest("hex");
}

function committedArchiveFixture() {
  const blobs = new Map();
  const entries = [];
  for (const directory of ["findings", "runs"]) {
    const absoluteDirectory = join(AUDIT_DIR, directory);
    for (const name of readdirSync(absoluteDirectory).sort()) {
      const contents = readFileSync(join(absoluteDirectory, name));
      const path = `docs/audits/${directory}/${name}`;
      const base = {
        path,
        mode: "100644",
        type: "blob",
        oid: gitBlobOid(contents),
        size: contents.length,
      };
      const { disposition, kind } = classifyAuditEntry(base);
      assert.equal(disposition, "excluded-evidence");
      entries.push({ ...base, kind });
      blobs.set(path, contents);
    }
  }
  return { excludedEvidenceEntries: entries, blobs, receiptSchema: RECEIPT_SCHEMA };
}

function rewriteJson(fixture, path, mutate) {
  const value = JSON.parse(fixture.blobs.get(path).toString("utf8"));
  mutate(value);
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fixture.blobs.set(path, contents);
  const entry = fixture.excludedEvidenceEntries.find(
    (candidate) => candidate.path === path,
  );
  entry.size = contents.length;
  entry.oid = gitBlobOid(contents);
}

function replaceBlob(fixture, path, contents) {
  const next = Buffer.from(contents);
  fixture.blobs.set(path, next);
  const entry = fixture.excludedEvidenceEntries.find(
    (candidate) => candidate.path === path,
  );
  entry.size = next.length;
  entry.oid = gitBlobOid(next);
}

function removeEvidence(fixture, path) {
  fixture.excludedEvidenceEntries =
    fixture.excludedEvidenceEntries.filter((entry) => entry.path !== path);
  fixture.blobs.delete(path);
}

function renameEvidence(fixture, from, to) {
  const entry = fixture.excludedEvidenceEntries.find(
    (candidate) => candidate.path === from,
  );
  entry.path = to;
  fixture.blobs.set(to, fixture.blobs.get(from));
  fixture.blobs.delete(from);
}

test("the committed v0.6 archive is a complete sealed evidence set", () => {
  const validated = validateAuditEvidenceArchive(committedArchiveFixture());

  assert.deepEqual(
    {
      files: validated.fileCount,
      runs: validated.runCount,
      triplets: validated.tripletCount,
      findings: validated.findingCount,
    },
    { files: 781, runs: 1, triplets: 260, findings: 280 },
  );
  assert.equal(
    validated.runStates[0].path,
    "docs/audits/runs/v060-c8b98a29508b.json",
  );
});

test("the post-audit tree fixture is exactly 2,273 tracked = 1,492 auditable + 781 excluded", () => {
  const fixture = committedArchiveFixture();
  const state = JSON.parse(
    fixture.blobs
      .get("docs/audits/runs/v060-c8b98a29508b.json")
      .toString("utf8"),
  );
  const baselineAuditable = state.sections.reduce(
    (total, section) => total + section.files.length,
    0,
  );
  const postAuditAuditableAdditions = [
    "scripts/audits/audit-receipt.schema.json",
    "scripts/audits/audit-run-state.mjs",
    "scripts/audits/audit-run-state.test.mjs",
    "scripts/audits/check-harness-usage.mjs",
    "scripts/audits/check-harness-usage.test.mjs",
  ];
  for (const path of postAuditAuditableAdditions) {
    assert.equal(existsSync(join(REPO_DIR, path)), true, path);
  }

  const excluded = fixture.excludedEvidenceEntries.length;
  const auditable = baselineAuditable + postAuditAuditableAdditions.length;
  const tracked = auditable + excluded;
  assert.deepEqual(
    { tracked, auditable, excluded },
    { tracked: 2273, auditable: 1492, excluded: 781 },
  );
});

test("a run-state batch with an unrecognized field is not sealed evidence", () => {
  const fixture = committedArchiveFixture();
  const statePath = "docs/audits/runs/v060-c8b98a29508b.json";
  rewriteJson(fixture, statePath, (state) => {
    state.sections[0].batches[0].unrecognized = true;
  });

  assert.throws(
    () => validateAuditEvidenceArchive(fixture),
    /run-state batch.*exactly/i,
  );
});

test("tampered, incomplete, or unsealed evidence fails closed", async (t) => {
  const stem = "root-c8b98a29508b-0001-b5d9b7436d36";
  const receiptPath = `docs/audits/findings/${stem}.json`;
  const metadataPath = `docs/audits/findings/${stem}.meta.json`;
  const routerPath = `docs/audits/findings/${stem}.router.json`;

  const cases = [
    {
      name: "incomplete triplet",
      mutate(fixture) {
        removeEvidence(fixture, routerPath);
      },
      error: /incomplete.*missing router-result/i,
    },
    {
      name: "receipt outside its JSON schema",
      mutate(fixture) {
        rewriteJson(fixture, receiptPath, (receipt) => {
          receipt.unrecognized = true;
        });
      },
      error: /not schema-valid/i,
    },
    {
      name: "receipt SHA seal mismatch",
      mutate(fixture) {
        rewriteJson(fixture, metadataPath, (metadata) => {
          metadata.receiptSha256 = "0".repeat(64);
        });
      },
      error: /metadata.*does not match/i,
    },
    {
      name: "router accounting drift",
      mutate(fixture) {
        rewriteJson(fixture, routerPath, (router) => {
          router.counts.created += 1;
        });
      },
      error: /created count/i,
    },
    {
      name: "router skipped a validated finding",
      mutate(fixture) {
        rewriteJson(fixture, routerPath, (router) => {
          router.skipped.push({ reason: "not-filed" });
          router.counts.skipped = 1;
        });
      },
      error: /must not contain skipped/i,
    },
    {
      name: "malformed metadata JSON",
      mutate(fixture) {
        replaceBlob(fixture, metadataPath, "{");
      },
      error: /invalid JSON/i,
    },
    {
      name: "executable evidence mode",
      mutate(fixture) {
        fixture.excludedEvidenceEntries.find(
          (entry) => entry.path === receiptPath,
        ).mode = "100755";
      },
      error: /regular non-executable blob/i,
    },
    {
      name: "receipt differs from durable state",
      mutate(fixture) {
        rewriteJson(fixture, receiptPath, (receipt) => {
          receipt.verdicts[0].gates[0].reason = "A different conclusion.";
        });
      },
      error: /does not match its durable run-state batch/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const fixture = committedArchiveFixture();
      scenario.mutate(fixture);
      assert.throws(
        () => validateAuditEvidenceArchive(fixture),
        scenario.error,
      );
    });
  }
});

test("run states are exact manifests, not broad evidence-directory allowlists", async (t) => {
  await t.test("a complete but unmanifested triplet is rejected", () => {
    const fixture = committedArchiveFixture();
    const sourceStem = "root-c8b98a29508b-0001-b5d9b7436d36";
    const extraStem = "root-c8b98a29508b-9999-000000000000";
    for (const [suffix, kind] of [
      [".json", "receipt"],
      [".meta.json", "receipt-metadata"],
      [".router.json", "router-result"],
    ]) {
      const source = `docs/audits/findings/${sourceStem}${suffix}`;
      const target = `docs/audits/findings/${extraStem}${suffix}`;
      const contents = Buffer.from(fixture.blobs.get(source));
      fixture.excludedEvidenceEntries.push({
        path: target,
        mode: "100644",
        type: "blob",
        oid: gitBlobOid(contents),
        size: contents.length,
        kind,
      });
      fixture.blobs.set(target, contents);
    }

    assert.throws(
      () => validateAuditEvidenceArchive(fixture),
      /unmanifested triplet/i,
    );
  });

  await t.test("a state filename must be derived from its full baseline", () => {
    const fixture = committedArchiveFixture();
    renameEvidence(
      fixture,
      "docs/audits/runs/v060-c8b98a29508b.json",
      "docs/audits/runs/v060-aaaaaaaaaaaa.json",
    );

    assert.throws(
      () => validateAuditEvidenceArchive(fixture),
      /run state path.*does not match baseline/i,
    );
  });

  await t.test("state batches must be contiguous in baseline order", () => {
    const fixture = committedArchiveFixture();
    rewriteJson(
      fixture,
      "docs/audits/runs/v060-c8b98a29508b.json",
      (state) => {
        state.sections[0].batches[0].auditedFiles.reverse();
      },
    );

    assert.throws(
      () => validateAuditEvidenceArchive(fixture),
      /non-contiguous batch progress/i,
    );
  });
});
