/**
 * doc-git-times.ts — strict contract for the packaged per-document Git-time
 * manifest (#2707, epic #2256).
 *
 * The production image carries no `.git`, so `DocNode.gitMtimeIso` used to
 * silently degrade to the Docker COPY mtime — old documents looked freshly
 * edited. The host/CI producer (`scripts/doc-git-times-generate.mjs`) runs in a
 * NON-SHALLOW checkout and writes a bounded manifest of repo-relative Markdown
 * path -> last-commit ISO time, bound to the exact source commit. This module
 * is the fail-closed consumer side: schema, commit binding, path bounds, and
 * time validity. A missing, over-cap, future-dated, malformed, or
 * commit-mismatched manifest yields NO authoritative time — the caller then
 * carries `filesystem` provenance, which no freshness claim may treat as Git
 * history.
 *
 * PURE + browser-safe: no node imports. The bounded file READ stays server-side
 * (`captureDocGitTimesSnapshot` in parse-docs.ts), mirroring the external-guidance split
 * (`external-guidance.ts` pure vs `parse-external-guidance.ts` node reader).
 * Browser code should only ever need {@link DocTimeProvenance} via `import type`.
 */

/**
 * How a doc node's `gitMtimeIso` was derived, ordered from most to least
 * authoritative:
 *  - `git`         — live batched `git log` history in a NON-shallow checkout.
 *  - `manifest`    — packaged producer manifest, valid and commit-bound.
 *  - `git-dirty`   — tracked content differs from HEAD; the carried clock is
 *                    its filesystem mtime, never the older HEAD commit time.
 *  - `filesystem`  — stat mtime; available for non-claim uses but NEVER
 *                    acceptable as Git history (Docker COPY resets it).
 *  - `unavailable` — no clock at all (`gitMtimeIso` is null).
 * A freshness consumer (#2488) may accept only `git` or `manifest`.
 */
export type DocTimeProvenance =
  | 'git'
  | 'manifest'
  | 'git-dirty'
  | 'filesystem'
  | 'unavailable';

/** On-disk manifest shape written by scripts/doc-git-times-generate.mjs. */
export interface DocGitTimesManifest {
  schemaVersion: 2;
  /** Full commit hash the per-path history was resolved at. */
  sourceCommit: string;
  /** Repo-relative POSIX Markdown path -> last-commit ISO 8601 time. */
  files: Record<string, string>;
}

export const DOC_GIT_TIMES_SCHEMA_VERSION = 2;

/**
 * Conventional manifest location relative to the doc-graph root. Lives under
 * `data/` because the runtime image already packages that directory
 * (`COPY --from=build /app/data ./data`) and `.dockerignore` does not exclude
 * it; the file itself is git-ignored (generated, never committed).
 */
export const DOC_GIT_TIMES_RELPATH = 'data/doc-git-times.json';

/** Entry cap — mirrors the doc-graph walk cap (DEFAULT_MAX_FILES = 5000). */
export const DOC_GIT_TIMES_MAX_ENTRIES = 5000;

/** Bounded read cap for the manifest file (entries are ~100 B each). */
export const DOC_GIT_TIMES_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Committer clocks can be slightly ahead; a bounded skew keeps an honest
 * just-made commit valid while still rejecting genuinely future-dated data.
 */
export const DOC_GIT_TIMES_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Lower plausibility bound (defense in depth): a commit time before this is a
 * broken committer clock or fabricated data, and an "authoritative" epoch-zero
 * time would make every staleness check scream. Long before this repo existed.
 */
export const DOC_GIT_TIMES_MIN_TIME_MS = Date.parse('2000-01-01T00:00:00Z');

/**
 * Explicit expected-commit override for deployments where the baked `GIT_SHA`
 * is not the commit the manifest was generated at (mirrors the
 * CHD_DOC_HYGIENE_EXPECTED_COMMIT seam).
 */
export const DOC_GIT_TIMES_EXPECTED_COMMIT_ENV =
  'CHD_DOC_GIT_TIMES_EXPECTED_COMMIT';

const DOC_PATH_MAX_LENGTH = 1024;
const FULL_COMMIT_RE = /^[0-9a-f]{40,64}$/;
/** `git log --format=%cI` shape: date T time with offset (or Z). */
const ISO_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A manifest key must be a bounded, repo-relative POSIX Markdown path: no
 * absolute/drive prefix, no backslashes, no empty/`.`/`..` segments.
 */
export function isValidManifestDocPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > DOC_PATH_MAX_LENGTH) {
    return false;
  }
  if (!/\.md$/i.test(path)) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export interface ParseDocGitTimesOptions {
  /**
   * Full commit the RUNTIME is serving (baked `GIT_SHA` / explicit override).
   * Without it the manifest cannot be bound and is rejected — an unbound
   * manifest could describe any past checkout.
   */
  expectedCommit?: string | null;
  /** Clock override for deterministic future-dated tests. */
  nowMs?: number;
}

export type ParsedDocGitTimes =
  | { ok: true; sourceCommit: string; times: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Validate a parsed manifest JSON value fail-closed. Every rejection returns a
 * reason (for logs/tests) and yields NO times — a partially trusted manifest
 * does not exist. Mirrors `parseDocHygieneArtifact`'s strictness.
 */
export function parseDocGitTimesManifest(
  value: unknown,
  options: ParseDocGitTimesOptions = {}
): ParsedDocGitTimes {
  const nowMs = options.nowMs ?? Date.now();
  const manifest = record(value);
  if (!manifest) return { ok: false, reason: 'manifest is not an object' };
  if (manifest.schemaVersion !== DOC_GIT_TIMES_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported schemaVersion' };
  }
  const sourceCommit =
    typeof manifest.sourceCommit === 'string'
      ? manifest.sourceCommit.toLowerCase()
      : '';
  if (!FULL_COMMIT_RE.test(sourceCommit)) {
    return { ok: false, reason: 'missing or malformed sourceCommit' };
  }
  const expectedCommit =
    typeof options.expectedCommit === 'string'
      ? options.expectedCommit.trim().toLowerCase()
      : '';
  if (!FULL_COMMIT_RE.test(expectedCommit)) {
    return { ok: false, reason: 'no runtime commit to bind the manifest against' };
  }
  if (expectedCommit !== sourceCommit) {
    return { ok: false, reason: 'sourceCommit does not match the runtime commit' };
  }
  const files = record(manifest.files);
  if (!files) return { ok: false, reason: 'files is not an object' };
  const entries = Object.entries(files);
  if (entries.length > DOC_GIT_TIMES_MAX_ENTRIES) {
    return { ok: false, reason: 'manifest exceeds the entry cap' };
  }
  const times = new Map<string, string>();
  for (const [path, iso] of entries) {
    if (!isValidManifestDocPath(path)) {
      return { ok: false, reason: `invalid doc path in manifest: ${String(path).slice(0, 128)}` };
    }
    if (typeof iso !== 'string' || !ISO_TIME_RE.test(iso)) {
      return { ok: false, reason: `malformed time for ${path}` };
    }
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) {
      return { ok: false, reason: `unparseable time for ${path}` };
    }
    if (parsed > nowMs + DOC_GIT_TIMES_FUTURE_SKEW_MS) {
      return { ok: false, reason: `future-dated time for ${path}` };
    }
    if (parsed < DOC_GIT_TIMES_MIN_TIME_MS) {
      return { ok: false, reason: `implausibly old time for ${path}` };
    }
    times.set(path, iso);
  }
  return { ok: true, sourceCommit, times };
}
