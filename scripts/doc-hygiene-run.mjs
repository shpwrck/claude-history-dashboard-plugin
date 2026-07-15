#!/usr/bin/env node
/**
 * Host-side Markdown hygiene producer (#2486, epic #2256).
 *
 * The runner enumerates the committed Markdown surface with `git ls-tree`,
 * invokes optional local Lychee and agents-lint binaries, and persists one
 * normalized Scorecard-shaped artifact per repository under:
 *
 *   ~/.claude/usage-data/doc-hygiene/<collision-safe-root>.json
 *
 * This is an ADR-0007 host producer: the runtime container gains no binary or
 * package dependency. Local file/fragment checks are offline and default-on.
 * Network checks are constructed only when CHD_DOC_HYGIENE_EXTERNAL_LINKS=1;
 * with the flag unset this process makes zero external calls.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_LINT_CHECK,
  AGENTS_LINT_CONTEXT_FILES,
  AGENTS_LINT_VERSION,
  normalizeAgentsLintReports,
  sanitizeAgentsLintContext,
} from "./lib/doc-hygiene-agents-lint.mjs";

export const DOC_HYGIENE_SCHEMA_VERSION = 1;
export const LOCAL_CHECK = "lychee.local-links";
export const EXTERNAL_CHECK = "lychee.external-links";
export const EXTERNAL_LINKS_FLAG = "CHD_DOC_HYGIENE_EXTERNAL_LINKS";

const AGENTS_LINT_CONFIG_FILES = Object.freeze([
  ".agents-lint.json",
  ".agents-lint.config.json",
]);

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const ENABLED_RE = /^(1|true|yes|on)$/i;
const LYCHEE_SUCCESS = 0;
const LYCHEE_LINK_FAILURE = 2;

function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function execute(spawn, command, args, cwd, env) {
  return spawn(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

/** Commit reads must never hydrate a partial clone over the network. */
function executeGit(spawn, args, cwd) {
  return spawn("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
}

function requiredGitOutput(spawn, root, args, label) {
  const result = executeGit(spawn, args, root);
  if (result.error || result.status !== 0) {
    const detail =
      text(result.stderr).trim() || result.error?.message || "unknown error";
    throw new Error(`doc-hygiene: cannot ${label}: ${detail}`);
  }
  return text(result.stdout).trim();
}

/** Git-tracked Markdown files at one immutable tree, including hidden dirs. */
export function trackedMarkdownFiles(
  root,
  spawn = spawnSync,
  treeish = "HEAD",
) {
  const output = requiredGitOutput(
    spawn,
    root,
    ["ls-tree", "-r", "--name-only", treeish],
    "enumerate git-tracked Markdown",
  );
  return output
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => /\.md$/i.test(path))
    .sort();
}

function gitCommit(root, spawn) {
  return requiredGitOutput(spawn, root, ["rev-parse", "HEAD"], "resolve HEAD");
}

function commandFailure(result, fallback) {
  return text(result.stderr).trim() || result.error?.message || fallback;
}

/**
 * Materialize exactly the commit named in the artifact. Lychee resolves every
 * target against this snapshot, so dirty tracked files and untracked files in
 * the caller's checkout cannot create or hide findings. This also removes the
 * precheck-to-scan race inherent in validating and then reading a live tree.
 */
function materializeCommit(root, commit, spawn) {
  const scratch = mkdtempSync(join(tmpdir(), "chd-doc-hygiene-"));
  const snapshot = join(scratch, "repo");
  const archive = join(scratch, "repo.tar");
  const emptyConfig = join(scratch, "lychee-empty.toml");
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  try {
    const archived = executeGit(
      spawn,
      ["archive", "--format=tar", `--output=${archive}`, commit],
      root,
    );
    if (archived.error || archived.status !== 0) {
      throw new Error(
        `doc-hygiene: cannot archive commit: ${commandFailure(archived, "unknown error")}`,
      );
    }
    const extracted = execute(
      spawn,
      "tar",
      ["-xf", archive, "-C", snapshot],
      scratch,
    );
    if (extracted.error || extracted.status !== 0) {
      throw new Error(
        `doc-hygiene: cannot extract commit snapshot: ${commandFailure(extracted, "unknown error")}`,
      );
    }
    // An explicit empty config prevents Lychee from auto-loading a committed
    // preprocess command. `--offline` blocks Lychee's own network requests;
    // config isolation also prevents an implicit child process from making one.
    writeFileSync(emptyConfig, "", { mode: 0o600 });
    return {
      root: snapshot,
      config: emptyConfig,
      remove: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function normalizeRepoPath(raw, root) {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  let value = raw;
  if (value.startsWith("file:")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return raw;
    }
  }
  if (!isAbsolute(value)) return value.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = relative(root, value);
  // Lychee resolves local targets to absolute file URLs. Keep even targets
  // outside the repo relative to the snapshot root: an absolute path would
  // otherwise persist this run's random temporary directory and destabilize
  // finding IDs/evidence.
  return (rel || ".").replace(/\\/g, "/");
}

function targetScheme(raw) {
  if (typeof raw !== "string") return "";
  try {
    return new URL(raw).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeTarget(raw, root) {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:") return raw;
    const hash = url.hash;
    url.hash = "";
    const path = normalizeRepoPath(fileURLToPath(url), root);
    return `${path}${hash}`;
  } catch {
    return raw.replace(/\\/g, "/");
  }
}

function positiveLine(span) {
  const line = Number(span?.line ?? span?.start?.line);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function stableArtifactText(value, root) {
  let rendered = typeof value === "string" ? value : String(value);
  // Never persist the random snapshot path in otherwise stable evidence.
  rendered = rendered.split(root).join("<repo>");
  const scratch = dirname(root);
  if (
    basename(root) === "repo" &&
    basename(scratch).startsWith("chd-doc-hygiene-")
  ) {
    rendered = rendered.split(scratch).join("<repo>/..");
  }
  return rendered;
}

function statusMessage(row, fallback, root) {
  const message = row?.status?.text ?? row?.status?.details ?? row?.message;
  const selected =
    typeof message === "string" && message.trim() ? message.trim() : fallback;
  return stableArtifactText(selected, root);
}

function rowsFromMap(raw, field) {
  const map = raw?.[field];
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const rows = [];
  for (const [sourcePath, values] of Object.entries(map)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) rows.push({ sourcePath, value, field });
  }
  return rows;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function lycheeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.values(value).every((rows) => Array.isArray(rows))
    ? value
    : null;
}

/**
 * Validate the stable Lychee JSON summary before it can become a completed
 * Scorecard check. In particular, `{}` is not a clean report: all counters and
 * both finding maps must be present and internally possible.
 */
function validatedLycheeSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const total = nonNegativeInteger(raw.total);
  const successful = nonNegativeInteger(raw.successful);
  const errors = nonNegativeInteger(raw.errors);
  const timeouts = nonNegativeInteger(raw.timeouts);
  const errorMap = lycheeMap(raw.error_map);
  const timeoutMap = lycheeMap(raw.timeout_map);
  if (
    total === null ||
    successful === null ||
    errors === null ||
    timeouts === null ||
    !errorMap ||
    !timeoutMap ||
    successful > total ||
    errors > total ||
    timeouts > total ||
    successful + errors + timeouts > total
  ) {
    return null;
  }
  return { total, successful, errors, timeouts };
}

function scoreFor(summary, findingCount) {
  if (summary.total > 0) {
    return Math.max(
      0,
      Math.min(10, Math.round((summary.successful / summary.total) * 10)),
    );
  }
  return findingCount > 0 ? 0 : 10;
}

function assignFindingIds(findings) {
  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.target.localeCompare(b.target) ||
      a.message.localeCompare(b.message),
  );
  const identified = [];
  const used = new Map();
  for (const finding of findings) {
    const semanticKey = JSON.stringify([
      finding.check,
      finding.signal,
      finding.path,
      finding.line,
      finding.target,
    ]);
    const digest = createHash("sha256")
      .update(semanticKey)
      .digest("hex")
      .slice(0, 16);
    const base = `doc-link:${finding.check}:${digest}`;
    const occurrence = (used.get(base) ?? 0) + 1;
    used.set(base, occurrence);
    identified.push({
      ...finding,
      id: occurrence === 1 ? base : `${base}:${occurrence}`,
    });
  }
  return identified;
}

/** Normalize the stable portion of Lychee's JSON status format. */
export function normalizeLycheeJson(raw, { root, check }) {
  if (!validatedLycheeSummary(raw)) {
    throw new Error("lychee output has an incompatible schema");
  }
  const external = check === EXTERNAL_CHECK;
  const acceptedSchemes = external
    ? new Set(["http", "https"])
    : new Set(["file", ""]);
  const signal = external ? "broken-external-link" : "broken-internal-link";
  const fallback = external
    ? "External URL check failed"
    : "Resolved Markdown target is missing or its fragment is invalid";
  const findings = [];

  for (const { sourcePath, value, field } of [
    ...rowsFromMap(raw, "error_map"),
    ...rowsFromMap(raw, "timeout_map"),
  ]) {
    const target = value?.url;
    if (
      typeof target !== "string" ||
      !acceptedSchemes.has(targetScheme(target))
    )
      continue;
    findings.push({
      check,
      signal,
      severity: "warning",
      path: normalizeRepoPath(sourcePath, root),
      line: positiveLine(value?.span),
      target: normalizeTarget(target, root),
      message: statusMessage(value, fallback, root),
      source: { tool: "lychee", field: `${field}[].span` },
    });
  }

  return assignFindingIds(findings);
}

function lycheeVersion(spawn, root) {
  const result = execute(spawn, "lychee", ["--version"], root);
  if (result.error || result.status !== 0) return null;
  const output = `${text(result.stdout)} ${text(result.stderr)}`.trim();
  const match = /(?:^|\s)lychee\s+v?([^\s]+)/i.exec(output);
  return match?.[1] ?? output.split(/\s+/).at(-1) ?? "unknown";
}

function defaultAgentsLintBinary(root) {
  const executable =
    process.platform === "win32" ? "agents-lint.cmd" : "agents-lint";
  const candidate = join(root, "node_modules", ".bin", executable);
  return existsSync(candidate) ? candidate : null;
}

function probeAgentsLint(binary, spawn, root) {
  if (!binary) {
    return {
      skipped: {
        name: AGENTS_LINT_CHECK,
        reason:
          "agents-lint 0.5.0 local binary is not installed at node_modules/.bin/agents-lint",
      },
    };
  }
  const result = execute(spawn, binary, ["--version"], root);
  if (result.error || result.signal || result.status !== 0) {
    return {
      skipped: {
        name: AGENTS_LINT_CHECK,
        reason: `agents-lint check unavailable: ${commandFailure(result, "version probe failed")}`,
      },
    };
  }
  const output = `${text(result.stdout)} ${text(result.stderr)}`.trim();
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1];
  if (version !== AGENTS_LINT_VERSION) {
    return {
      skipped: {
        name: AGENTS_LINT_CHECK,
        reason:
          `agents-lint check unavailable: expected local version ${AGENTS_LINT_VERSION}, ` +
          `found ${version ?? "unknown"}`,
      },
    };
  }
  return { binary, version };
}

function nodeOptionPath(path) {
  return /[\s"\\]/u.test(path) ? JSON.stringify(path) : path;
}

function agentsLintPermissionEnv(binary, scanRoot) {
  const toolRoot = resolve(dirname(binary), "..", "agents-lint");
  return {
    ...process.env,
    // The pinned checker uses fs.existsSync on extracted references. Constrain
    // those reads to the immutable snapshot and its own installed package so an
    // absolute or `..` reference cannot probe the surrounding host filesystem.
    NODE_OPTIONS: [
      "--permission",
      `--allow-fs-read=${nodeOptionPath(scanRoot)}`,
      `--allow-fs-read=${nodeOptionPath(binary)}`,
      `--allow-fs-read=${nodeOptionPath(toolRoot)}`,
    ].join(" "),
  };
}

function snapshotContainsSymlink(root) {
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) pending.push(join(dir, entry.name));
    }
  }
  return false;
}

function neutralizeAgentsLintConfigs(root) {
  for (const name of AGENTS_LINT_CONFIG_FILES) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    writeFileSync(path, "{}\n");
  }
}

function runAgentsLintCheck({
  binary,
  toolVersion,
  root,
  markdownFiles,
  spawn,
}) {
  const unavailable = (detail) => ({
    skipped: {
      name: AGENTS_LINT_CHECK,
      reason: stableArtifactText(
        `agents-lint check unavailable: ${detail}`,
        root,
      ),
    },
  });
  const contextFiles = AGENTS_LINT_CONTEXT_FILES.filter((path) =>
    markdownFiles.includes(path),
  );
  if (contextFiles.length === 0) {
    return {
      check: {
        name: AGENTS_LINT_CHECK,
        tool: "agents-lint",
        toolVersion,
        status: "completed-with-adapter",
        score: 10,
        reason: "No tracked governance context files found at HEAD",
        findingIds: [],
      },
      findings: [],
    };
  }

  // agents-lint resolves every extracted path with fs.existsSync. Sanitize the
  // exact pinned parser's disallowed captures before invocation, then retain a
  // Node permission boundary as fail-closed defense if a future capture escapes
  // the adapter. Skip symlink-bearing snapshots because lexical read grants do
  // not stop an allowed in-tree symlink from resolving outside the snapshot.
  // Neutralize only configs that exist in the commit, and only after Lychee has
  // finished against the byte-faithful snapshot, so checker setup cannot create
  // or hide a path that the artifact claims belongs to that commit.
  try {
    if (snapshotContainsSymlink(root)) {
      return unavailable("commit snapshot contains symlinks");
    }
    neutralizeAgentsLintConfigs(root);
    for (const contextFile of contextFiles) {
      const path = join(root, contextFile);
      const sanitized = sanitizeAgentsLintContext(readFileSync(path, "utf8"));
      writeFileSync(path, sanitized);
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }

  const reports = [];
  for (const contextFile of contextFiles) {
    const result = execute(
      spawn,
      binary,
      [
        join(root, contextFile),
        "--root",
        root,
        "--format",
        "json",
        "--no-color",
      ],
      root,
      agentsLintPermissionEnv(binary, root),
    );
    if (
      result.error ||
      result.signal ||
      result.status === null ||
      ![0, 1].includes(result.status)
    ) {
      return unavailable(
        commandFailure(result, `unexpected exit ${result.status ?? "null"}`),
      );
    }
    try {
      const report = JSON.parse(text(result.stdout));
      const reportFile =
        report && typeof report === "object" && typeof report.file === "string"
          ? report.file.replace(/\\/g, "/").replace(/^\.\//, "")
          : null;
      if (reportFile !== null && reportFile !== contextFile) {
        return unavailable(
          `report file does not match invoked context ${contextFile}`,
        );
      }
      reports.push(report);
    } catch {
      return unavailable("malformed JSON output");
    }
  }

  let findings;
  try {
    findings = normalizeAgentsLintReports(reports);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const count = findings.length;
  return {
    check: {
      name: AGENTS_LINT_CHECK,
      tool: "agents-lint",
      toolVersion,
      status: "completed-with-adapter",
      score: Math.max(0, 10 - count),
      reason:
        count === 0
          ? "No governance-doc context reference drift found"
          : `${count} governance-doc context reference${count === 1 ? "" : "s"} failed`,
      findingIds: findings.map((finding) => finding.id),
    },
    findings,
  };
}

/** Command construction is isolated so the flag-off zero-network contract is testable. */
export function lycheeArgs(markdownFiles, check, config) {
  const common = [
    "--config",
    config,
    "--include-fragments",
    "--format",
    "json",
    "--no-progress",
  ];
  if (check === LOCAL_CHECK) {
    return [...common, "--offline", "--scheme", "file", "--", ...markdownFiles];
  }
  if (check === EXTERNAL_CHECK) {
    return [
      ...common,
      "--scheme",
      "http",
      "--scheme",
      "https",
      "--",
      ...markdownFiles,
    ];
  }
  throw new Error(`unknown doc-hygiene check: ${check}`);
}

function runCheck({ check, root, config, markdownFiles, toolVersion, spawn }) {
  const unavailable = (detail) => ({
    skipped: {
      name: check,
      reason: stableArtifactText(`lychee check unavailable: ${detail}`, root),
    },
  });

  if (markdownFiles.length === 0) {
    return {
      check: {
        name: check,
        tool: "lychee",
        toolVersion,
        status: "completed",
        score: 10,
        reason: "No git-tracked Markdown files found at HEAD",
        findingIds: [],
      },
      findings: [],
    };
  }

  const result = execute(
    spawn,
    "lychee",
    lycheeArgs(markdownFiles, check, config),
    root,
  );
  if (result.error || result.signal || result.status === null) {
    const detail =
      text(result.stderr).trim() ||
      result.error?.message ||
      "process did not exit normally";
    return unavailable(detail);
  }
  let raw;
  try {
    raw = JSON.parse(text(result.stdout));
  } catch {
    const detail =
      text(result.stderr).trim() ||
      result.error?.message ||
      "malformed JSON output";
    return unavailable(detail);
  }

  const summary = validatedLycheeSummary(raw);
  if (!summary) {
    return unavailable("incompatible JSON schema");
  }

  let findings;
  try {
    findings = normalizeLycheeJson(raw, { root, check });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }

  // Lychee documents 0 as success, 2 as link-check failures, and 1/3 as
  // runtime/configuration failures. A report is complete only when its exit
  // code agrees with its normalized summary and every reported error can be
  // represented by this scheme-scoped adapter.
  const normalizedErrors = findings.filter(
    (finding) => finding.source.field === "error_map[].span",
  ).length;
  const normalizedTimeouts = findings.filter(
    (finding) => finding.source.field === "timeout_map[].span",
  ).length;
  const reportedFailures = summary.errors + summary.timeouts;
  const clean = reportedFailures === 0 && findings.length === 0;
  const failedLinks = reportedFailures > 0 && findings.length > 0;
  const expectedExit =
    (result.status === LYCHEE_SUCCESS && clean) ||
    (result.status === LYCHEE_LINK_FAILURE && failedLinks);
  const summaryMatchesFindings =
    summary.errors === normalizedErrors &&
    summary.timeouts === normalizedTimeouts;
  if (!expectedExit || !summaryMatchesFindings) {
    const detail = text(result.stderr).trim();
    return unavailable(
      `exit ${result.status} disagrees with JSON summary` +
        (detail ? ` (${detail})` : ""),
    );
  }
  const scope = check === LOCAL_CHECK ? "local Markdown" : "external URL";
  return {
    check: {
      name: check,
      tool: "lychee",
      toolVersion,
      status: "completed",
      score: scoreFor(summary, findings.length),
      reason:
        findings.length === 0
          ? `No broken ${scope} links found`
          : `${findings.length} ${scope} link${findings.length === 1 ? "" : "s"} failed`,
      findingIds: findings.map((finding) => finding.id),
    },
    findings,
  };
}

/** Build a normalized artifact. Tool/check failures are represented, not thrown. */
export function runDocHygiene({
  root = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  now = () => Date.now(),
  agentsLintBinary,
} = {}) {
  const repoRoot = resolve(root);
  const commit = gitCommit(repoRoot, spawn);
  const markdownFiles = trackedMarkdownFiles(repoRoot, spawn, commit);
  const checks = [];
  const findings = [];
  const skipped = [];
  const toolVersion = lycheeVersion(spawn, repoRoot);
  const localAgentsLintBinary =
    agentsLintBinary === undefined
      ? defaultAgentsLintBinary(repoRoot)
      : agentsLintBinary;
  const agentsLint = probeAgentsLint(localAgentsLintBinary, spawn, repoRoot);
  const externalEnabled = ENABLED_RE.test(
    String(env?.[EXTERNAL_LINKS_FLAG] ?? ""),
  );
  const snapshot =
    (toolVersion || agentsLint.binary) && markdownFiles.length > 0
      ? materializeCommit(repoRoot, commit, spawn)
      : null;
  const checkRoot = snapshot?.root ?? repoRoot;

  try {
    if (!toolVersion) {
      skipped.push({
        name: LOCAL_CHECK,
        reason: "lychee binary is not installed or not on PATH",
      });
    } else {
      const local = runCheck({
        check: LOCAL_CHECK,
        root: checkRoot,
        config: snapshot?.config,
        markdownFiles,
        toolVersion,
        spawn,
      });
      if (local.check) checks.push(local.check);
      if (local.findings) findings.push(...local.findings);
      if (local.skipped) skipped.push(local.skipped);
    }

    if (!externalEnabled) {
      skipped.push({
        name: EXTERNAL_CHECK,
        reason: `external URL checks disabled; set ${EXTERNAL_LINKS_FLAG}=1`,
      });
    } else if (!toolVersion) {
      skipped.push({
        name: EXTERNAL_CHECK,
        reason: "lychee binary is not installed or not on PATH",
      });
    } else {
      const external = runCheck({
        check: EXTERNAL_CHECK,
        root: checkRoot,
        config: snapshot?.config,
        markdownFiles,
        toolVersion,
        spawn,
      });
      if (external.check) checks.push(external.check);
      if (external.findings) findings.push(...external.findings);
      if (external.skipped) skipped.push(external.skipped);
    }

    if (!agentsLint.binary) {
      skipped.push(agentsLint.skipped);
    } else {
      const contextRefs = runAgentsLintCheck({
        binary: agentsLint.binary,
        toolVersion: agentsLint.version,
        root: checkRoot,
        markdownFiles,
        spawn,
      });
      if (contextRefs.check) checks.push(contextRefs.check);
      if (contextRefs.findings) findings.push(...contextRefs.findings);
      if (contextRefs.skipped) skipped.push(contextRefs.skipped);
    }
  } finally {
    snapshot?.remove();
  }

  const errorCount = findings.filter(
    (finding) => finding.severity === "error",
  ).length;
  const warningCount = findings.filter(
    (finding) => finding.severity === "warning",
  ).length;
  return {
    schemaVersion: DOC_HYGIENE_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    repo: { root: repoRoot, commit, markdownFiles: markdownFiles.length },
    summary: {
      score:
        checks.length === 0
          ? null
          : Math.round(
              checks.reduce((sum, check) => sum + check.score, 0) /
                checks.length,
            ),
      findingCount: findings.length,
      errorCount,
      warningCount,
    },
    checks,
    findings,
    skipped,
  };
}

export function writeDocHygieneArtifact(path, artifact) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

async function defaultOutputPath(root, artifactKey) {
  // Reuse the producer/consumer's canonical collision-safe root encoder. The
  // loader is registered only on the host CLI path; importing this module in
  // its dependency-free unit test does not load TypeScript or node_modules.
  await import("./register-ts.mjs");
  const { artifactPathFor } = await import("../src/lib/repo-map/cache.ts");
  const { docHygieneArtifactFilename } =
    await import("../src/lib/doc-hygiene-artifact.ts");
  const claudeDir = process.env.CLAUDE_DIR
    ? resolve(process.env.CLAUDE_DIR)
    : resolve(homedir(), ".claude");
  const dir = resolve(claudeDir, "usage-data", "doc-hygiene");
  if (artifactKey) {
    const filename = docHygieneArtifactFilename(artifactKey);
    if (!filename)
      throw new Error(
        "doc-hygiene: artifact key must contain only letters, numbers, dot, underscore, or dash",
      );
    return join(dir, filename);
  }
  return artifactPathFor(dir, root);
}

function parseCli(argv) {
  let root = process.cwd();
  let output = null;
  let artifactKey = null;
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`doc-hygiene: ${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") root = valueAfter(i++, "--root");
    else if (argv[i] === "--output") output = valueAfter(i++, "--output");
    else if (argv[i] === "--artifact-key") {
      artifactKey = valueAfter(i++, "--artifact-key");
    } else throw new Error(`doc-hygiene: unknown argument ${argv[i]}`);
  }
  if (output && artifactKey) {
    throw new Error(
      "doc-hygiene: use either --output or --artifact-key, not both",
    );
  }
  return { root: resolve(root), output, artifactKey };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const artifact = runDocHygiene({ root: options.root });
  if (options.artifactKey) artifact.repo.identity = options.artifactKey;
  const output = options.output
    ? resolve(options.output)
    : await defaultOutputPath(options.root, options.artifactKey);
  writeDocHygieneArtifact(output, artifact);
  process.stdout.write(
    `doc-hygiene: wrote ${output} (${artifact.repo.markdownFiles} Markdown files, ` +
      `${artifact.findings.length} findings, ${artifact.skipped.length} skipped)\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
