import type { HistoryEntry } from '../types';
import {
  ArchiveTooLargeError,
  formatBytes,
  readArchive,
  readArchiveBlob,
  readArchiveBytes,
  type ArchiveEntry,
  type ArchiveEntryDecision,
  type ArchiveEntryInfo,
  type ArchiveLimitKind,
  type ArchiveLimits,
  type ArchiveTestInstrumentation,
} from './archive-reader';
import { deriveEntriesFromTranscript } from './parse-history';
import type { MemoriesResponse, RawMemoryFile } from './parse-memories';
import type { WorkflowsResponse, RawWorkflowRun } from './parse-workflows';

// Pure, node-testable upload helpers (issue #395). The component layer
// (`src/components/FileUpload.tsx`) imports these so the skip rules,
// project-name extraction, and zip inflation all have one source of truth
// and a vitest suite — DOM/component tests aren't set up here (see
// `vitest.config.ts`).

// Sensitive files to skip. These must never reach the dataset — and with
// the fflate `filter` hook below they are never even decompressed out of a
// zip.
export const SENSITIVE_FILES = ['credentials.json', '.env', 'settings.json', 'statsig_config.json'];
export const SKIP_DIRECTORIES = ['.git', 'node_modules', '__pycache__'];

// The bounded fflate engine and its byte/entry/ZIP-bomb ceilings (#758, #3176,
// #3368) live in the upload-neutral `archive-reader` (#3806). This module is the
// upload compatibility wrapper: it owns the skip rules, project attribution,
// and metadata-only rules, and phrases each ceiling in upload terms.

/**
 * Thrown when an upload trips one of the archive ceilings. Carries a
 * human-readable `message` the upload UI surfaces verbatim so the user knows
 * why it stopped (and that nothing hung); the structured
 * {@link ArchiveTooLargeError} it rephrases is kept as `cause`.
 */
export class UploadTooLargeError extends Error {
  constructor(message: string, cause?: ArchiveTooLargeError) {
    super(message, { cause });
    this.name = 'UploadTooLargeError';
  }
}

export interface LoadedFile {
  name: string;
  text: string;
  project?: string;
  /**
   * Full relative (loose-file) or in-zip path when known, e.g.
   * `projects/<slug>/memory/foo.md`. Drives memory/workflow attribution (#538);
   * `undefined` for a loose top-level file dropped without a directory context.
   */
  path?: string;
  /** Best available file mtime in epoch ms. Present for loose files and some metadata-only entries. */
  lastModified?: number;
  /**
   * True when upload retained only structural metadata and intentionally did not
   * read/decompress the body. Used for file-history snapshots.
   */
  metadataOnly?: boolean;
}

export function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zip');
}

// #538: targeted allowlist beyond `.jsonl` transcripts — a user's own agent
// memory notes and Workflow-tool run manifests, so the SPA/upload path can
// populate the Memories and Workflows views from their own bundle. Kept
// path-scoped (NOT a blanket extension allow) so `SENSITIVE_FILES` stays
// blocked: `settings.json`/`credentials.json` never match these patterns.
const MEMORY_RE = /(^|\/)projects\/[^/]+\/memory\/[^/]+\.md$/;
const WORKFLOW_RE = /(^|\/)projects\/[^/]+\/[^/]+\/workflows\/wf_[^/]*\.json$/;
const TASK_RE = /(^|\/)tasks\/[^/]+\/[^/]+\.json$/;
const TEAM_INBOX_RE = /(^|\/)teams\/[^/]+\/inboxes\/[^/]+\.json$/;
const SESSION_REGISTRY_RE = /(^|\/)sessions\/[^/]+\.json$/;
const TELEMETRY_RE = /(^|\/)telemetry\/1p_failed_events[^/]*\.json$/;
const DEBUG_RE = /(^|\/)debug\/[^/]+\.txt$/;
const FILE_HISTORY_RE = /(^|\/)file-history\/[^/]+\/[^/]+@v2$/;
const PLAN_RE = /(^|\/)plans\/[^/]+\.md$/;
const BACKUP_RE = /(^|\/)backups\/\.claude\.json\.backup\.[0-9]+$/;
const WORKFLOW_JOURNAL_RE = /(^|\/)projects\/[^/]+\/[^/]+\/subagents\/workflows\/[^/]+\/journal\.jsonl$/;

function normalizeUploadPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function hasPathEnding(path: string, ending: string): boolean {
  const p = normalizeUploadPath(path);
  return p === ending || p.endsWith(`/${ending}`);
}

/**
 * A per-project agent memory note: `projects/<slug>/memory/<file>.md`. Excludes
 * the `MEMORY.md` index (the server's `/api/memories` walk drops it too), so the
 * uploaded set matches the server build.
 */
export function isMemoryPath(path: string): boolean {
  if (!MEMORY_RE.test(path)) return false;
  const fileName = path.split('/').pop() ?? '';
  return fileName !== 'MEMORY.md';
}

/** A Workflow-tool run manifest: `projects/<slug>/<sessionId>/workflows/wf_*.json`. */
export function isWorkflowPath(path: string): boolean {
  return WORKFLOW_RE.test(path);
}

export function isMetadataOnlyPath(path: string): boolean {
  return FILE_HISTORY_RE.test(normalizeUploadPath(path));
}

export function isUploadArtifactPath(path: string): boolean {
  const p = normalizeUploadPath(path);
  return (
    TASK_RE.test(p) ||
    TEAM_INBOX_RE.test(p) ||
    SESSION_REGISTRY_RE.test(p) ||
    TELEMETRY_RE.test(p) ||
    DEBUG_RE.test(p) ||
    hasPathEnding(p, 'stats-cache.json') ||
    FILE_HISTORY_RE.test(p) ||
    PLAN_RE.test(p) ||
    hasPathEnding(p, '.last-update-result.json') ||
    hasPathEnding(p, 'mcp-needs-auth-cache.json') ||
    BACKUP_RE.test(p)
  );
}

export function shouldSkipFile(path: string): boolean {
  const normalized = normalizeUploadPath(path);
  const parts = normalized.split('/');
  const fileName = parts[parts.length - 1];

  // Hard blocks first — these win over the allowlist below. Sensitive files
  // never decompress; neither does anything under a blocked directory.
  if (SENSITIVE_FILES.includes(fileName)) {
    return true;
  }
  if (parts.some((part) => SKIP_DIRECTORIES.includes(part))) {
    return true;
  }

  // Allowlist: session transcripts (`.jsonl`), plus the targeted #538 patterns
  // for the user's own memories/workflow manifests and #1051 current dashboard
  // artifacts. Everything else is skipped before it is ever read.
  if (WORKFLOW_JOURNAL_RE.test(normalized)) return true;
  if (fileName.endsWith('.jsonl')) return false;
  if (isMemoryPath(normalized)) return false;
  if (isWorkflowPath(normalized)) return false;
  if (isUploadArtifactPath(normalized)) return false;

  return true;
}

export function extractProjectName(relativePath: string): string | undefined {
  // Expected format: projects/<project-name>/<sessionId>.jsonl
  const match = relativePath.match(/projects\/([^/]+)\//);
  return match ? match[1] : undefined;
}

/**
 * Parent session id for a workflow manifest path
 * (`projects/<slug>/<sessionId>/workflows/wf_*.json` → `<sessionId>`). The
 * manifest itself does not store this — it's the containing directory — so the
 * run→parent-session join depends on recovering it from the path.
 */
export function extractWorkflowSessionId(path: string): string | undefined {
  const match = path.match(/projects\/[^/]+\/([^/]+)\/workflows\//);
  return match ? match[1] : undefined;
}

interface SessionPathMatch {
  project: string;
  sessionId: string;
}

function topLevelSessionPath(path: string): SessionPathMatch | null {
  const match = normalizeUploadPath(path).match(/(^|\/)projects\/([^/]+)\/([^/]+)\.jsonl$/);
  return match ? { project: match[2], sessionId: match[3] } : null;
}

function subagentSessionPath(path: string): (SessionPathMatch & { nested: boolean }) | null {
  const normalized = normalizeUploadPath(path);
  const direct = normalized.match(/(^|\/)projects\/([^/]+)\/([^/]+)\/subagents\/([^/]+\.jsonl)$/);
  if (direct) return { project: direct[2], sessionId: direct[3], nested: false };
  const nested = normalized.match(
    /(^|\/)projects\/([^/]+)\/([^/]+)\/subagents\/workflows\/[^/]+\/agent-[^/]+\.jsonl$/
  );
  return nested ? { project: nested[2], sessionId: nested[3], nested: true } : null;
}

function appendJsonl(base: string, addition: string): string {
  if (!base) return addition;
  return `${base.endsWith('\n') ? base : `${base}\n`}${addition}`;
}

function topLevelTranscriptInfo(file: LoadedFile): SessionPathMatch | null {
  if (!file.name.endsWith('.jsonl') || file.name === 'history.jsonl') return null;
  if (!file.path) {
    return {
      project: file.project ?? '',
      sessionId: file.name.replace(/\.jsonl$/, ''),
    };
  }
  return topLevelSessionPath(file.path);
}

/**
 * Convert uploaded transcript files into the same logical session blobs the
 * server parses: one top-level `projects/<slug>/<sessionId>.jsonl` plus its
 * immediate `subagents/*.jsonl` and nested workflow-agent transcripts appended.
 * Loose `.jsonl` files without path context are kept as standalone sessions.
 */
export function collectUploadSessions(files: LoadedFile[]): LoadedFile[] {
  const top = new Map<string, LoadedFile>();
  const directSubagents = new Map<string, LoadedFile[]>();
  const nestedSubagents = new Map<string, LoadedFile[]>();
  const loose: LoadedFile[] = [];

  for (const file of files) {
    if (!file.name.endsWith('.jsonl') || file.name === 'history.jsonl') continue;
    const path = file.path;
    if (!path) {
      loose.push(file);
      continue;
    }
    const parent = topLevelSessionPath(path);
    if (parent) {
      top.set(`${parent.project}/${parent.sessionId}`, {
        ...file,
        project: file.project ?? parent.project,
      });
      continue;
    }
    const sub = subagentSessionPath(path);
    if (sub) {
      const key = `${sub.project}/${sub.sessionId}`;
      const bucket = sub.nested
        ? nestedSubagents.get(key) ?? []
        : directSubagents.get(key) ?? [];
      bucket.push(file);
      if (sub.nested) nestedSubagents.set(key, bucket);
      else directSubagents.set(key, bucket);
    }
  }

  const merged = [...top.entries()].map(([key, file]) => {
    let text = file.text;
    const append = (a: LoadedFile, b: LoadedFile) =>
      normalizeUploadPath(a.path ?? a.name).localeCompare(normalizeUploadPath(b.path ?? b.name));
    for (const sub of [...(directSubagents.get(key) ?? [])].sort(append)) {
      text = appendJsonl(text, sub.text);
    }
    for (const sub of [...(nestedSubagents.get(key) ?? [])].sort(append)) {
      text = appendJsonl(text, sub.text);
    }
    return { ...file, text };
  });

  return [...loose, ...merged];
}

/**
 * Derive history/session entries from uploaded top-level transcripts. This is
 * the browser-side mirror of the server's `deriveEntries(topText, ...)` path:
 * subagent transcripts are merged into token/tool parses, but they must not
 * create Sessions/Search/Projects rows because their "user" turns are task
 * prompts rather than the human's top-level prompts.
 */
export function collectUploadTranscriptEntries(files: LoadedFile[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const file of files) {
    const transcript = topLevelTranscriptInfo(file);
    if (!transcript) continue;

    const { sessionId } = transcript;
    const project = file.project ?? transcript.project;
    // parseSessionJsonl returns token data (no title field); titles are derived
    // inside deriveEntriesFromTranscript, so pass null here (#978).
    const title: string | null = null;
    entries.push(
      ...deriveEntriesFromTranscript(file.text, sessionId, project, title)
    );
  }

  return entries;
}

export function collectUploadTranscriptSessionIds(files: LoadedFile[]): string[] {
  const ids = new Set<string>();
  for (const file of files) {
    const transcript = topLevelTranscriptInfo(file);
    if (transcript) ids.add(transcript.sessionId);
  }
  return [...ids];
}

const LIVE_DIRECTORY_HINT =
  'For a dataset this large, run the dashboard against your live ~/.claude directory instead';
const CORRUPT_FILE_HINT =
  'That file looks corrupt or not a supported agent transcript - remove it and try again.';

/**
 * Upload wording for each neutral reader ceiling. This is the copy the upload
 * UI has always surfaced (#758); only the source of the violation moved.
 */
const UPLOAD_LIMIT_MESSAGES: Record<ArchiveLimitKind, (err: ArchiveTooLargeError) => string> = {
  archive: (err) =>
    `This archive is ${formatBytes(err.observed ?? 0)}, over the ${formatBytes(err.limit)} ` +
    `upload limit. ${LIVE_DIRECTORY_HINT} of uploading.`,
  entry: (err) =>
    `"${err.path}" is ${err.observed === undefined ? '' : `${formatBytes(err.observed)}, `}` +
    `over the ${formatBytes(err.limit)} per-file limit. ${CORRUPT_FILE_HINT}`,
  total: (err) =>
    `This archive inflates to over ${formatBytes(err.limit)}, past the upload limit. ` +
    `${LIVE_DIRECTORY_HINT}.`,
  entries: (err) =>
    `This archive holds more than ${err.limit.toLocaleString()} files, over the upload limit. ` +
    `${LIVE_DIRECTORY_HINT}.`,
};

/** Rephrase a neutral reader violation in the upload UI's own words. */
async function withUploadErrors<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof ArchiveTooLargeError) {
      throw new UploadTooLargeError(UPLOAD_LIMIT_MESSAGES[err.kind](err), err);
    }
    throw err;
  }
}

/** Upload admission: skip rules first, then metadata-only file-history snapshots. */
function admitUploadEntry(entry: ArchiveEntryInfo): ArchiveEntryDecision {
  if (shouldSkipFile(entry.path)) return 'skip';
  return isMetadataOnlyPath(entry.path) ? 'metadata' : 'read';
}

/**
 * Map an admitted entry into the `{ name, text, project?, path? }` upload shape.
 * ZIP entries carry no `lastModified`; only loose files do.
 */
function toLoadedFile(entry: ArchiveEntry): LoadedFile {
  const file: LoadedFile = {
    name: entry.name,
    text: entry.text,
    project: extractProjectName(entry.path),
    path: entry.path,
  };
  return entry.metadataOnly ? { ...file, metadataOnly: true } : file;
}

const UPLOAD_ARCHIVE_POLICY = { admit: admitUploadEntry, map: toLoadedFile };

/**
 * Inflate a `.zip` of `~/.claude` artifacts into the same `{ name, text,
 * project?, path? }` shape the loose-file path produces. Admission runs before
 * decompression, so anything `shouldSkipFile` rejects — sensitive files
 * included — is dropped before it is ever read into memory. Project
 * attribution and the full path are recovered from each entry's in-zip path.
 * These stay `async` so a bad argument rejects instead of throwing.
 */
export async function unzipBundle(
  data: Uint8Array,
  limits: Partial<ArchiveLimits> = {}
): Promise<LoadedFile[]> {
  return withUploadErrors(readArchiveBytes(data, { ...UPLOAD_ARCHIVE_POLICY, limits }));
}

export async function unzipBundleFromFile(
  file: Blob,
  limits: Partial<ArchiveLimits> = {}
): Promise<LoadedFile[]> {
  return withUploadErrors(readArchiveBlob(file, { ...UPLOAD_ARCHIVE_POLICY, limits }));
}

export async function unzipBundleFromChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  archiveBytes?: number,
  limits: Partial<ArchiveLimits> = {},
  observeForTest?: ArchiveTestInstrumentation
): Promise<LoadedFile[]> {
  return withUploadErrors(
    readArchive(chunks, { ...UPLOAD_ARCHIVE_POLICY, limits, archiveBytes, observeForTest })
  );
}

/**
 * #538: group uploaded memory `.md` files into the shape `parseMemories`
 * consumes (the `/api/memories` response the server build returns). Each file is
 * attributed to a project slug via its path; non-memory files are ignored, and
 * the `MEMORY.md` index is already excluded by `isMemoryPath`.
 */
export function collectUploadMemories(files: LoadedFile[]): MemoriesResponse {
  const bySlug = new Map<string, RawMemoryFile[]>();
  for (const f of files) {
    const path = f.path;
    if (!path || !isMemoryPath(path)) continue;
    const slug = extractProjectName(path);
    if (!slug) continue;
    const list = bySlug.get(slug) ?? [];
    list.push({ name: f.name, content: f.text });
    bySlug.set(slug, list);
  }
  return {
    projects: [...bySlug.entries()].map(([slug, memFiles]) => ({ slug, files: memFiles })),
  };
}

/**
 * #538: parse uploaded workflow manifests (`wf_*.json`) into the shape
 * `parseWorkflows` consumes. Each manifest's own fields pass through unchanged
 * (`parseWorkflows` is tolerant); the parent session id — which the manifest
 * does not store — is recovered from the path and injected so the
 * run→parent-session join still works. Malformed JSON and degenerate
 * (non-object) manifests are skipped, mirroring the server's `trimWorkflowRun`.
 */
export function collectUploadWorkflows(files: LoadedFile[]): WorkflowsResponse {
  const runs: RawWorkflowRun[] = [];
  for (const f of files) {
    const path = f.path;
    if (!path || !isWorkflowPath(path)) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(f.text);
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const sessionId = extractWorkflowSessionId(path);
    runs.push({ ...(manifest as RawWorkflowRun), sessionId: sessionId ?? null });
  }
  return { runs };
}
