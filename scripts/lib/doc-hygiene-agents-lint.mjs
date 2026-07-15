/**
 * Normalize the pinned agents-lint 0.5.0 JSON contract for doc hygiene (#2487).
 *
 * The spike recorded in docs/doc-hygiene-borrow-stack.md found useful path and
 * npm-script drift checks mixed with repo-specific false positives. This
 * adapter therefore admits only the two checker/rule pairs we can audit and
 * drops whole false-positive classes by pattern: slash commands, `/api` and
 * hash routes, globs, home-relative artifacts, URLs, HTTP-method routes, and
 * template paths. It never carries raw structure/framework/dependency advice
 * into recommendations.
 */

import { createHash } from "node:crypto";

export const AGENTS_LINT_CHECK = "agents-lint.context-refs";
export const AGENTS_LINT_VERSION = "0.5.0";
export const AGENTS_LINT_CONTEXT_FILES = Object.freeze([
  "AGENTS.md",
  "CLAUDE.md",
  "REFERENCES.md",
]);

const MISSING_PATH_MESSAGE = /^Path does not exist: "([^"]+)"$/;
const MISSING_SCRIPT_MESSAGE =
  /^Script "([^"]+)" is mentioned but not found in any package\.json$/;
const PINNED_PATH_PATTERNS = Object.freeze([
  /`([./][^\s`]+)`/g,
  /\*\*([./][^\s*]+)\*\*/g,
  /(?:in|at|to|from|see)\s+`([^`]+\/[^`]+)`/gi,
  /(?:directory|folder|file|path):\s*`([^`]+)`/gi,
]);
const PATH_LOCATOR_PATTERN = /(?:#[^/\s`]+|:\d+(?::\d+)?)$/u;
const REQUIRED_CHECKERS = Object.freeze(["filesystem", "npm-scripts"]);

/** Pattern classes from the #2260 spike, never per-finding suppressions. */
export const AGENTS_LINT_IGNORED_TARGET_PATTERNS = Object.freeze([
  /^\/[A-Za-z0-9][A-Za-z0-9-]*$/u, // harness slash command: /recs
  /^\/api(?:\/|$)/u, // product/server API route
  /^#\//u, // hash route
  /[*?[\]{}]/u, // glob or brace expansion
  /^~(?:[\\/]|$)/u, // home-relative local artifact
  /^[A-Za-z][A-Za-z0-9+.-]*:/u, // URI: https://, mailto:, urn:, git:, ...
  /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?::\d{1,5})?\//iu, // scheme-less web address
  /^[^@\s/]+@[^:\s/]+:[^/\s]+(?:\/|$)/u, // SCP-style Git remote
  /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//u, // documented route
  /<[^>]+>/u, // template path segment such as <sessionId>
  PATH_LOCATOR_PATTERN, // raw checker output that bypassed locator canonicalization
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function positiveLine(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizedSeverity(value) {
  if (value === "error") return "error";
  if (value === "warn") return "warning";
  if (value === "info") return "info";
  return null;
}

function ignoredTarget(value) {
  return AGENTS_LINT_IGNORED_TARGET_PATTERNS.some((pattern) =>
    pattern.test(value),
  );
}

function repoRelativeTarget(value) {
  if (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) return false;
  return !value.split("/").some((segment) => segment === "..");
}

function normalizedPathTarget(value) {
  return value
    .replace(/[,;:.]$/u, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function canonicalizePathLocators(content) {
  let canonicalized = content;
  for (const pattern of PINNED_PATH_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    canonicalized = canonicalized.replace(regex, (whole, candidate) => {
      if (typeof candidate !== "string") return whole;
      const base = candidate.replace(PATH_LOCATOR_PATTERN, "");
      if (base === candidate || base.length === 0) return whole;
      const start = whole.lastIndexOf(candidate);
      if (start < 0) return whole;
      return `${whole.slice(0, start)}${base}${whole.slice(start + candidate.length)}`;
    });
  }
  return canonicalized;
}

/**
 * Canonicalize path locators and mask disallowed paths before the pinned CLI
 * parses them. Every rewrite preserves newlines, so admitted findings keep
 * exact line spans while unsafe refs never reach agents-lint's unrestricted
 * path resolver.
 */
export function sanitizeAgentsLintContext(content) {
  if (typeof content !== "string") {
    throw new TypeError("agents-lint context must be a string");
  }
  const canonicalized = canonicalizePathLocators(content);
  const masked = canonicalized.split("");
  for (const pattern of PINNED_PATH_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of canonicalized.matchAll(regex)) {
      const candidate = match[1];
      if (!candidate) continue;
      const target = normalizedPathTarget(candidate);
      if (repoRelativeTarget(target) && !ignoredTarget(target)) continue;
      const relativeStart = match[0].lastIndexOf(candidate);
      if (relativeStart < 0 || match.index === undefined) continue;
      const start = match.index + relativeStart;
      const end = start + candidate.length;
      for (let index = start; index < end; index += 1) {
        if (masked[index] !== "\n" && masked[index] !== "\r") {
          masked[index] = "x";
        }
      }
    }
  }
  return masked.join("");
}

function identified(findings) {
  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? Number.MAX_SAFE_INTEGER) -
        (b.line ?? Number.MAX_SAFE_INTEGER) ||
      a.target.localeCompare(b.target) ||
      a.signal.localeCompare(b.signal),
  );
  const semanticKeys = new Set();
  const unique = findings.filter((finding) => {
    const key = JSON.stringify([
      finding.check,
      finding.path,
      finding.signal,
      finding.target,
    ]);
    if (semanticKeys.has(key)) return false;
    semanticKeys.add(key);
    return true;
  });
  const occurrences = new Map();
  return unique.map((finding) => {
    const key = JSON.stringify([
      finding.check,
      finding.path,
      finding.signal,
      finding.line,
      finding.target,
    ]);
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const base = `context-ref:${finding.check}:${digest}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      ...finding,
      id: occurrence === 1 ? base : `${base}:${occurrence}`,
    };
  });
}

function normalizedIssue(reportPath, checker, issue) {
  const row = record(issue);
  if (!row || typeof row.rule !== "string" || typeof row.message !== "string") {
    throw new Error("incompatible agents-lint JSON schema");
  }
  const severity = normalizedSeverity(row.severity);
  if (!severity) throw new Error("incompatible agents-lint JSON schema");

  let signal;
  let target;
  if (checker === "filesystem" && row.rule === "no-missing-path") {
    const match = MISSING_PATH_MESSAGE.exec(row.message);
    if (!match) throw new Error("incompatible agents-lint JSON schema");
    signal = "missing-path";
    target = normalizedPathTarget(match[1]);
    // agents-lint resolves target paths before emitting JSON. Only admit paths
    // whose existence can be decided inside the commit snapshot; the runner's
    // Node permission boundary independently prevents the upstream probe.
    if (!repoRelativeTarget(target) || ignoredTarget(target)) return null;
  } else if (checker === "npm-scripts" && row.rule === "no-missing-script") {
    const match = MISSING_SCRIPT_MESSAGE.exec(row.message);
    if (!match) throw new Error("incompatible agents-lint JSON schema");
    signal = "missing-npm-script";
    target = `npm run ${match[1]}`;
  } else {
    return null;
  }

  return {
    check: AGENTS_LINT_CHECK,
    signal,
    severity,
    path: reportPath.replace(/\\/g, "/").replace(/^\.\//, ""),
    line: positiveLine(row.line),
    target,
    message: row.message,
    source: {
      tool: "agents-lint",
      field:
        `reports[].results[checker=${checker}]` + `.issues[rule=${row.rule}]`,
    },
  };
}

/** Convert validated single-file agents-lint JSON reports into artifact rows. */
export function normalizeAgentsLintReports(rawReports) {
  if (!Array.isArray(rawReports) || rawReports.length === 0) {
    throw new Error("incompatible agents-lint JSON schema");
  }
  const findings = [];
  const seenFiles = new Set();
  for (const rawReport of rawReports) {
    const report = record(rawReport);
    const reportPath =
      typeof report?.file === "string"
        ? report.file.replace(/\\/g, "/").replace(/^\.\//, "")
        : "";
    if (
      !report ||
      !AGENTS_LINT_CONTEXT_FILES.includes(reportPath) ||
      seenFiles.has(reportPath) ||
      typeof report.score !== "number" ||
      !Number.isFinite(report.score) ||
      report.score < 0 ||
      report.score > 100 ||
      !Array.isArray(report.results) ||
      !nonNegativeInteger(report.totalIssues) ||
      !nonNegativeInteger(report.errors) ||
      !nonNegativeInteger(report.warnings) ||
      !nonNegativeInteger(report.infos) ||
      typeof report.timestamp !== "string" ||
      Number.isNaN(Date.parse(report.timestamp))
    ) {
      throw new Error("incompatible agents-lint JSON schema");
    }
    seenFiles.add(reportPath);
    let totalIssues = 0;
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    const requiredCheckerCounts = new Map(
      REQUIRED_CHECKERS.map((checker) => [checker, 0]),
    );
    for (const rawResult of report.results) {
      const result = record(rawResult);
      if (
        !result ||
        typeof result.checker !== "string" ||
        !Array.isArray(result.issues) ||
        !nonNegativeInteger(result.passed) ||
        !nonNegativeInteger(result.failed)
      ) {
        throw new Error("incompatible agents-lint JSON schema");
      }
      if (requiredCheckerCounts.has(result.checker)) {
        requiredCheckerCounts.set(
          result.checker,
          requiredCheckerCounts.get(result.checker) + 1,
        );
      }
      for (const issue of result.issues) {
        const row = record(issue);
        const severity = normalizedSeverity(row?.severity);
        if (!severity) throw new Error("incompatible agents-lint JSON schema");
        totalIssues += 1;
        if (severity === "error") errors += 1;
        else if (severity === "warning") warnings += 1;
        else infos += 1;
        const finding = normalizedIssue(reportPath, result.checker, issue);
        if (finding) findings.push(finding);
      }
    }
    if (
      [...requiredCheckerCounts.values()].some((count) => count !== 1) ||
      totalIssues !== report.totalIssues ||
      errors !== report.errors ||
      warnings !== report.warnings ||
      infos !== report.infos
    ) {
      throw new Error("incompatible agents-lint JSON schema");
    }
  }
  return identified(findings);
}
