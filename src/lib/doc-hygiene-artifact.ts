/**
 * Runtime contract for the host-produced doc-hygiene artifact (#2486).
 *
 * The host runner writes this shape under ~/.claude/usage-data/doc-hygiene/;
 * ingest parses it fail-closed before a recommendation detector sees it. Keep
 * this module dependency-free: the zero-node_modules server imports it.
 */

export type DocHygieneSeverity = 'error' | 'warning' | 'info';

export interface DocHygieneCheck {
  name: string;
  tool: string;
  toolVersion: string;
  status: string;
  score: number;
  reason: string;
  findingIds: string[];
}

export interface DocHygieneFinding {
  id: string;
  check: string;
  signal: string;
  severity: DocHygieneSeverity;
  path: string;
  /** One-based line from the checker, or null when the tool supplied no span. */
  line: number | null;
  target: string;
  message: string;
  source: { tool: string; field: string };
}

export interface DocHygieneSkip {
  name: string;
  reason: string;
}

export interface DocHygieneArtifact {
  schemaVersion: 1;
  generatedAt: string;
  repo: {
    /** Stable deploy locator when host and runtime absolute roots differ. */
    identity?: string;
    root: string;
    commit: string;
    markdownFiles: number;
  };
  summary: {
    score: number | null;
    findingCount: number;
    errorCount: number;
    warningCount: number;
  };
  checks: DocHygieneCheck[];
  findings: DocHygieneFinding[];
  skipped: DocHygieneSkip[];
}

export interface ParseDocHygieneArtifactOptions {
  expectedRoot?: string;
  /** Stable deploy locator; when supplied it must be stamped in repo.identity. */
  expectedIdentity?: string;
  /** Full current commit. An artifact from another commit is stale and ignored. */
  expectedCommit?: string | null;
}

/**
 * Stable producer/consumer locator used by the canonical deploy wrapper. The
 * host checkout and the runtime image have different absolute roots, so deploy
 * passes a repo-identity key plus the host commit rather than asking `/app` to
 * reconstruct a host path it cannot see.
 */
export const DOC_HYGIENE_ARTIFACT_KEY_ENV = 'CHD_DOC_HYGIENE_ARTIFACT_KEY';
export const DOC_HYGIENE_EXPECTED_COMMIT_ENV =
  'CHD_DOC_HYGIENE_EXPECTED_COMMIT';

const ARTIFACT_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Return the safe basename for a stable repo key, or null for hostile input. */
export function docHygieneArtifactFilename(key: unknown): string | null {
  return typeof key === 'string' && ARTIFACT_KEY_RE.test(key)
    ? `${key}.json`
    : null;
}

const MAX_CHECKS = 64;
const MAX_FINDINGS = 10_000;
const MAX_SKIPPED = 64;
const MAX_STRING = 16_384;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown, max = MAX_STRING): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function score(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10
    ? value
    : undefined;
}

function list(value: unknown, max: number): unknown[] | null {
  return Array.isArray(value) && value.length <= max ? value : null;
}

function parseCheck(value: unknown): DocHygieneCheck | null {
  const row = record(value);
  if (!row) return null;
  const name = string(row.name, 256);
  const tool = string(row.tool, 256);
  const toolVersion = string(row.toolVersion, 256);
  const status = string(row.status, 256);
  const reason = string(row.reason);
  const parsedScore = score(row.score);
  const ids = list(row.findingIds, MAX_FINDINGS);
  if (!name || !tool || !toolVersion || !status || !reason || parsedScore == null || !ids) {
    return null;
  }
  const findingIds = ids.map((id) => string(id, 1_024));
  if (findingIds.some((id) => id === null)) return null;
  return {
    name,
    tool,
    toolVersion,
    status,
    score: parsedScore,
    reason,
    findingIds: findingIds as string[],
  };
}

function parseFinding(value: unknown): DocHygieneFinding | null {
  const row = record(value);
  const source = record(row?.source);
  if (!row || !source) return null;
  const id = string(row.id, 1_024);
  const check = string(row.check, 256);
  const signal = string(row.signal, 256);
  const severity = row.severity;
  const path = string(row.path, 4_096);
  const target = string(row.target);
  const message = string(row.message);
  const tool = string(source.tool, 256);
  const field = string(source.field, 1_024);
  const line = row.line === null ? null : count(row.line);
  if (
    !id ||
    !check ||
    !signal ||
    !['error', 'warning', 'info'].includes(String(severity)) ||
    !path ||
    line === null && row.line !== null ||
    typeof line === 'number' && line < 1 ||
    !target ||
    !message ||
    !tool ||
    !field
  ) {
    return null;
  }
  return {
    id,
    check,
    signal,
    severity: severity as DocHygieneSeverity,
    path,
    line,
    target,
    message,
    source: { tool, field },
  };
}

function parseSkip(value: unknown): DocHygieneSkip | null {
  const row = record(value);
  if (!row) return null;
  const name = string(row.name, 256);
  const reason = string(row.reason);
  return name && reason ? { name, reason } : null;
}

/** Parse/validate a persisted artifact. Any malformed or stale value is null. */
export function parseDocHygieneArtifact(
  value: unknown,
  options: ParseDocHygieneArtifactOptions = {}
): DocHygieneArtifact | null {
  const artifact = record(value);
  const repo = record(artifact?.repo);
  const summary = record(artifact?.summary);
  const checksRaw = list(artifact?.checks, MAX_CHECKS);
  const findingsRaw = list(artifact?.findings, MAX_FINDINGS);
  const skippedRaw = list(artifact?.skipped, MAX_SKIPPED);
  if (
    !artifact ||
    artifact.schemaVersion !== 1 ||
    !repo ||
    !summary ||
    !checksRaw ||
    !findingsRaw ||
    !skippedRaw
  ) {
    return null;
  }

  const generatedAt = string(artifact.generatedAt, 128);
  const root = string(repo.root, 4_096);
  const identity = repo.identity === undefined ? undefined : string(repo.identity, 128);
  const commit = string(repo.commit, 128);
  const markdownFiles = count(repo.markdownFiles);
  const summaryScore = score(summary.score);
  const findingCount = count(summary.findingCount);
  const errorCount = count(summary.errorCount);
  const warningCount = count(summary.warningCount);
  if (
    !generatedAt ||
    Number.isNaN(Date.parse(generatedAt)) ||
    !root ||
    identity === null ||
    !/^(?:\/|[A-Za-z]:[\\/])/.test(root) ||
    !commit ||
    !/^[0-9a-f]{7,64}$/i.test(commit) ||
    markdownFiles === null ||
    summaryScore === undefined ||
    findingCount === null ||
    errorCount === null ||
    warningCount === null
  ) {
    return null;
  }
  if (options.expectedRoot !== undefined && root !== options.expectedRoot) return null;
  if (
    options.expectedIdentity !== undefined &&
    identity !== options.expectedIdentity
  ) {
    return null;
  }
  if (
    options.expectedCommit &&
    !options.expectedCommit.toLowerCase().startsWith(commit.toLowerCase())
  ) {
    return null;
  }

  const checks = checksRaw.map(parseCheck);
  const findings = findingsRaw.map(parseFinding);
  const skipped = skippedRaw.map(parseSkip);
  if (
    checks.some((row) => row === null) ||
    findings.some((row) => row === null) ||
    skipped.some((row) => row === null)
  ) {
    return null;
  }
  if (findingCount !== findings.length) return null;
  if (errorCount !== findings.filter((row) => row?.severity === 'error').length) return null;
  if (warningCount !== findings.filter((row) => row?.severity === 'warning').length) return null;

  const parsedChecks = checks as DocHygieneCheck[];
  const parsedFindings = findings as DocHygieneFinding[];
  const parsedSkipped = skipped as DocHygieneSkip[];

  // IDs are the ownership join key. Reject ambiguous data instead of letting a
  // duplicate id or cross-check claim attach the wrong evidence to a check.
  const checkNames = new Set<string>();
  for (const check of parsedChecks) {
    if (checkNames.has(check.name)) return null;
    checkNames.add(check.name);
    if (new Set(check.findingIds).size !== check.findingIds.length) return null;
  }

  const findingById = new Map<string, DocHygieneFinding>();
  for (const finding of parsedFindings) {
    if (findingById.has(finding.id) || !checkNames.has(finding.check)) return null;
    findingById.set(finding.id, finding);
  }

  const claimedIds = new Set<string>();
  for (const check of parsedChecks) {
    for (const id of check.findingIds) {
      const finding = findingById.get(id);
      if (!finding || finding.check !== check.name || claimedIds.has(id)) return null;
      claimedIds.add(id);
    }
  }
  if (claimedIds.size !== parsedFindings.length) return null;

  return {
    schemaVersion: 1,
    generatedAt,
    repo: { ...(identity ? { identity } : {}), root, commit, markdownFiles },
    summary: { score: summaryScore, findingCount, errorCount, warningCount },
    checks: parsedChecks,
    findings: parsedFindings,
    skipped: parsedSkipped,
  };
}
