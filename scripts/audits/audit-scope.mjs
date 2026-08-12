import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const AUDIT_SCOPE_POLICY_VERSION = 1;
export const RELEASE_AUDIT_SCOPE_POLICY_VERSION = 2;

const FINDINGS_ROOT = "docs/audits/findings/";
const RUNS_ROOT = "docs/audits/runs/";
const SECTION_SLUGS = [
  "root",
  "scripts",
  "src-lib-non-detectors",
  "src-lib-detectors",
  "src-components",
  "src-rest",
  "docs",
  "fixtures",
  "e2e",
  "github",
  "probaitio-operator",
  "deploy",
  "data-tools-bin-commands-claude",
];
const RECEIPT_STEM = new RegExp(
  `^(?:v070-)?(?:${SECTION_SLUGS.join("|")})-[0-9a-f]{12}-[0-9]{4,}-[0-9a-f]{12}$`,
);
const RUN_STATE_NAME = /^v[0-9]{3}-[0-9a-f]{12}\.json$/;

function requireTreeEntry(entry, label = "tracked entry") {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    typeof entry.path !== "string" ||
    !entry.path ||
    entry.path.includes("\0")
  ) {
    throw new Error(`${label}.path must be a nonempty NUL-free string`);
  }
  if (typeof entry.mode !== "string" || !/^[0-7]{6}$/.test(entry.mode)) {
    throw new Error(`${label}.mode must be a six-digit git mode`);
  }
  if (typeof entry.type !== "string" || !entry.type) {
    throw new Error(`${label}.type must be a nonempty string`);
  }
  if (
    typeof entry.oid !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)
  ) {
    throw new Error(`${label}.oid must be a lowercase git object id`);
  }
  if (!Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error(`${label}.size must be a nonnegative integer`);
  }
}

function evidenceKind(path) {
  if (path.startsWith(FINDINGS_ROOT)) {
    const name = path.slice(FINDINGS_ROOT.length);
    let kind = "receipt";
    let stem = name;
    if (name.endsWith(".meta.json")) {
      kind = "receipt-metadata";
      stem = name.slice(0, -".meta.json".length);
    } else if (name.endsWith(".router.json")) {
      kind = "router-result";
      stem = name.slice(0, -".router.json".length);
    } else if (name.endsWith(".json")) {
      stem = name.slice(0, -".json".length);
    } else {
      throw new Error(`unrecognized sealed audit evidence path ${path}`);
    }
    if (!RECEIPT_STEM.test(stem)) {
      throw new Error(`unrecognized sealed audit evidence path ${path}`);
    }
    return kind;
  }
  if (path.startsWith(RUNS_ROOT)) {
    const name = path.slice(RUNS_ROOT.length);
    if (!RUN_STATE_NAME.test(name)) {
      throw new Error(`unrecognized sealed audit evidence path ${path}`);
    }
    return "run-state";
  }
  return null;
}

function canonicalEntry(entry, kind) {
  return kind
    ? {
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        oid: entry.oid,
        size: entry.size,
        kind,
      }
    : {
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        oid: entry.oid,
        size: entry.size,
      };
}

export function summarizeAuditEntries(entries) {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const entry of sorted) {
    hash.update(
      `${JSON.stringify([
        entry.path,
        entry.mode,
        entry.type,
        entry.oid,
        entry.size,
        entry.kind ?? null,
      ])}\n`,
    );
  }
  return {
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
    manifestSha256: hash.digest("hex"),
  };
}

export function classifyAuditEntry(entry) {
  requireTreeEntry(entry);
  const kind = evidenceKind(entry.path);
  if (!kind) return { disposition: "auditable" };
  if (entry.mode !== "100644" || entry.type !== "blob") {
    throw new Error(
      `sealed audit evidence ${entry.path} must be a regular non-executable blob`,
    );
  }
  return { disposition: "excluded-evidence", kind };
}

export function resolveAuditUniverse(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("tracked entries must be an array");
  }
  const seen = new Set();
  const trackedEntries = [];
  const auditableEntries = [];
  const excludedEvidenceEntries = [];
  for (const [index, entry] of entries.entries()) {
    requireTreeEntry(entry, `tracked entry ${index + 1}`);
    if (seen.has(entry.path)) {
      throw new Error(`duplicate tracked path ${entry.path}`);
    }
    seen.add(entry.path);
    const tracked = canonicalEntry(entry);
    trackedEntries.push(tracked);
    const classification = classifyAuditEntry(entry);
    if (classification.disposition === "auditable") {
      auditableEntries.push(tracked);
    } else {
      excludedEvidenceEntries.push(
        canonicalEntry(entry, classification.kind),
      );
    }
  }

  return {
    scope: {
      policyVersion: AUDIT_SCOPE_POLICY_VERSION,
      tracked: summarizeAuditEntries(trackedEntries),
      auditable: summarizeAuditEntries(auditableEntries),
      excludedEvidence: summarizeAuditEntries(excludedEvidenceEntries),
    },
    auditableEntries,
    excludedEvidenceEntries,
  };
}

export function assertExactAuditUniverse(entries, universe) {
  if (!universe || typeof universe !== "object" || Array.isArray(universe)) {
    throw new Error("audit universe must be an object");
  }
  if (
    !Array.isArray(universe.auditableEntries) ||
    !Array.isArray(universe.excludedEvidenceEntries)
  ) {
    throw new Error("audit universe must contain both entry lists");
  }

  const trackedPaths = new Set(entries.map((entry) => entry?.path));
  const assigned = [
    ...universe.auditableEntries,
    ...universe.excludedEvidenceEntries,
  ];
  const counts = new Map();
  for (const entry of assigned) {
    counts.set(entry?.path, (counts.get(entry?.path) || 0) + 1);
  }
  const overlap = [...counts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path);
  if (overlap.length) {
    throw new Error(
      `audit universe contains overlap or duplicate path(s): ${overlap.join(", ")}`,
    );
  }
  const missing = [...trackedPaths].filter((path) => !counts.has(path));
  const extras = [...counts.keys()].filter((path) => !trackedPaths.has(path));
  if (missing.length || extras.length) {
    throw new Error(
      `audit universe is not exact${missing.length ? `; missing: ${missing.join(", ")}` : ""}${
        extras.length ? `; unexpected: ${extras.join(", ")}` : ""
      }`,
    );
  }

  const expected = resolveAuditUniverse(entries);
  if (!isDeepStrictEqual(universe, expected)) {
    throw new Error(
      "audit universe count, byte total, classification, or manifest does not match the tracked tree",
    );
  }
  return true;
}
