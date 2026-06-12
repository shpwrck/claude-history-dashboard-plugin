import { AsyncUnzipInflate, Unzip } from 'fflate';
import type { HistoryEntry } from '../types';
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

// Fail-proof upload guards (#758). A large or pathological archive must fail
// fast and clearly instead of locking the tab while it inflates to memory. These
// caps are deliberately generous — a real `~/.claude` bundle is megabytes of
// well-compressing `.jsonl`, far under them — so they only ever trip on
// genuinely huge input or a decompression bomb (small compressed, vast inflated).
// The per-entry and total caps are enforced inside the fflate `filter` hook, so
// over-budget bytes are NEVER decompressed: memory stays bounded even when the
// guard fires.

/** Compressed-input ceiling, checked before any decompression starts. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Per-entry inflated-size ceiling — a single file this big is pathological. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MiB
/** Total inflated-bytes budget across all admitted entries. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Cap on the number of admitted entries. */
export const MAX_ENTRIES = 200_000;

/**
 * Thrown when an upload trips a {@link MAX_ARCHIVE_BYTES}/{@link MAX_TOTAL_BYTES}/
 * {@link MAX_ENTRIES} guard. Carries a human-readable `message` the upload UI
 * surfaces verbatim so the user knows why it stopped (and that nothing hung).
 */
export class UploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTooLargeError';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
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

/**
 * Inflate a `.zip` of `~/.claude` artifacts into the same `{ name, text,
 * project?, path? }` shape the loose-file path produces. The fflate `filter`
 * hook skips decompressing anything `shouldSkipFile` rejects, so sensitive
 * files bundled into the zip are dropped before they are ever read into memory.
 * Project attribution and the full path are recovered from each entry's in-zip
 * path.
 */
/** Tunable upload guard ceilings; defaults to the module `MAX_*` constants. */
export interface UploadLimits {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: UploadLimits = {
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxEntries: MAX_ENTRIES,
};

export async function unzipBundle(
  data: Uint8Array,
  limits: Partial<UploadLimits> = {}
): Promise<LoadedFile[]> {
  return unzipBundleFromChunks([data], data.byteLength, limits);
}

export async function unzipBundleFromFile(
  file: Blob,
  limits: Partial<UploadLimits> = {}
): Promise<LoadedFile[]> {
  if (typeof file.stream !== 'function') {
    return unzipBundle(new Uint8Array(await file.arrayBuffer()), limits);
  }
  return unzipBundleFromChunks(file.stream(), file.size, limits);
}

export async function unzipBundleFromChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  archiveBytes?: number,
  limits: Partial<UploadLimits> = {}
): Promise<LoadedFile[]> {
  const { maxArchiveBytes, maxEntryBytes, maxTotalBytes, maxEntries } = {
    ...DEFAULT_LIMITS,
    ...limits,
  };

  // Fail fast on an absurdly large compressed input before spending any work
  // inflating it — this is the "immediate" half of fail-proof (#758).
  if (archiveBytes !== undefined && archiveBytes > maxArchiveBytes) {
    throw new UploadTooLargeError(
      `This archive is ${formatBytes(archiveBytes)}, over the ${formatBytes(maxArchiveBytes)} upload limit. ` +
        `For a dataset this large, run the dashboard against your live ~/.claude directory instead of uploading.`
    );
  }

  // The streaming unzip handler enforces the skip rules AND the size/count
  // budget before `start()` is called, so rejected files are never decompressed.
  // Unlike fflate's object-returning `unzip`, this decodes admitted entries
  // directly into `LoadedFile`s and avoids a second full decompressed byte map.
  let admittedCount = 0;
  let admittedBytes = 0;
  let overflow: UploadTooLargeError | null = null;
  let streamError: Error | null = null;
  const loaded: Array<LoadedFile | undefined> = [];
  const pending: Promise<void>[] = [];

  const rejectWithOverflow = (err: UploadTooLargeError): void => {
    overflow = err;
    streamError = err;
  };

  const unzip = new Unzip((file) => {
    if (file.name.endsWith('/') || shouldSkipFile(file.name) || overflow) return;
    const originalSize = file.originalSize;
    if (originalSize !== undefined && originalSize > maxEntryBytes) {
      rejectWithOverflow(
        new UploadTooLargeError(
          `"${file.name}" is ${formatBytes(originalSize)}, over the ${formatBytes(maxEntryBytes)} per-file limit. ` +
            `That file looks corrupt or not a supported agent transcript - remove it and try again.`
        )
      );
      return;
    }
    if (admittedCount + 1 > maxEntries) {
      rejectWithOverflow(
        new UploadTooLargeError(
          `This archive holds more than ${maxEntries.toLocaleString()} files, over the upload limit. ` +
            `For a dataset this large, run the dashboard against your live ~/.claude directory instead.`
        )
      );
      return;
    }
    if (originalSize !== undefined && admittedBytes + originalSize > maxTotalBytes) {
      rejectWithOverflow(
        new UploadTooLargeError(
          `This archive inflates to over ${formatBytes(maxTotalBytes)}, past the upload limit. ` +
            `For a dataset this large, run the dashboard against your live ~/.claude directory instead.`
        )
      );
      return;
    }

    const index = loaded.length;
    loaded.push(undefined);
    admittedCount += 1;
    if (originalSize !== undefined) admittedBytes += originalSize;

    const decoder = new TextDecoder();
    const path = file.name;
    const name = path.split('/').pop() ?? path;
    const lastModified =
      (file as unknown as { mtime?: Date }).mtime instanceof Date
        ? (file as unknown as { mtime: Date }).mtime.getTime()
        : undefined;
    if (isMetadataOnlyPath(path)) {
      loaded[index] = {
        name,
        text: '',
        project: extractProjectName(path),
        path,
        lastModified,
        metadataOnly: true,
      };
      return;
    }
    let text = '';
    let observedBytes = 0;

    pending.push(
      new Promise<void>((resolve, reject) => {
        file.ondata = (err, chunk, final) => {
          if (err) {
            streamError = err;
            reject(err);
            return;
          }
          if (chunk) {
            observedBytes += chunk.byteLength;
            if (originalSize === undefined) {
              if (observedBytes > maxEntryBytes) {
                const tooLarge = new UploadTooLargeError(
                  `"${path}" is over the ${formatBytes(maxEntryBytes)} per-file limit. ` +
                    `That file looks corrupt or not a supported agent transcript - remove it and try again.`
                );
                rejectWithOverflow(tooLarge);
                file.terminate();
                reject(tooLarge);
                return;
              }
              admittedBytes += chunk.byteLength;
              if (admittedBytes > maxTotalBytes) {
                const tooLarge = new UploadTooLargeError(
                  `This archive inflates to over ${formatBytes(maxTotalBytes)}, past the upload limit. ` +
                    `For a dataset this large, run the dashboard against your live ~/.claude directory instead.`
                );
                rejectWithOverflow(tooLarge);
                file.terminate();
                reject(tooLarge);
                return;
              }
            }
            text += decoder.decode(chunk, { stream: !final });
          }
          if (final) {
            text += decoder.decode();
            loaded[index] = { name, text, project: extractProjectName(path), path, lastModified };
            resolve();
          }
        };
        file.start();
      })
    );
  });
  unzip.register(AsyncUnzipInflate);

  try {
    for await (const chunk of chunks) {
      if (overflow) break;
      unzip.push(chunk, false);
    }
    if (!overflow) unzip.push(new Uint8Array(), true);
    await Promise.all(pending);
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  if (overflow) throw overflow;
  if (streamError) throw streamError;

  return loaded.filter((file): file is LoadedFile => file !== undefined);
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
