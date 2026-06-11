// Single worker-side upload pipeline (#1069, follow-up to #1067/#1068).
//
// The old upload path inflated each `.zip` and read every loose file on the
// browser main thread (FileUpload.handleProcessedFiles), then handed the decoded
// transcript text up to the parser — which itself either crossed a `postMessage`
// boundary (the #1068 structured-clone crash) or ran on the main thread. For a
// large current ~/.claude bundle (180 MB compressed / 634 MB admitted text) that
// froze the tab for the first minute while inflation ran.
//
// `buildUploadDataset` is the whole pipeline in one pass: inflate + read into
// `LoadedFile[]`, then parse history, sessions, and artifacts. It `post`s only
// PARSED results (token/tool/timeline rows, history entries, memories, workflows,
// artifacts) plus `status` progress — never the decoded transcript text. Run it
// inside a Web Worker (upload-pipeline-worker.ts) so a large upload stays jank-
// free, with a yielding main-thread fallback (upload-pipeline-client.ts) when no
// Worker is available. The decoded text lives and dies inside whichever thread
// ran the build; the main thread only ever receives bounded parsed structures.

import {
  type LoadedFile,
  collectUploadMemories,
  collectUploadSessions,
  collectUploadTranscriptEntries,
  collectUploadTranscriptSessionIds,
  collectUploadWorkflows,
  extractProjectName,
  isMetadataOnlyPath,
  isZipPath,
  unzipBundleFromFile,
} from './unzip-upload';
import { runUploadParse, type UploadParseEmit } from './upload-parse';
import { parseHistoryJsonl } from './parse-history';
import { parseMemories, type ProjectMemories } from './parse-memories';
import { parseWorkflows, type WorkflowRun } from './parse-workflows';
import { collectUploadArtifacts, type UploadedArtifacts } from './upload-artifacts';
import type { HistoryEntry } from '../types';

/**
 * One raw upload input: a File/Blob handle plus the path metadata FileUpload
 * already recovered. The handle is passed by reference across the worker
 * boundary (structured clone stores a blob reference, it does not copy the
 * bytes), so even a 180 MB zip is cheap to hand to the worker — the inflation
 * that used to block the main thread now happens worker-side.
 */
export interface UploadInput {
  /** File/Blob handle. Loose files are read via `.text()`; zips via `.stream()`. */
  blob: Blob;
  /** Bare file name (e.g. `abc.jsonl`). */
  name: string;
  /** Full relative / in-archive path when known (drives project attribution). */
  relativePath?: string;
  /**
   * Explicit project attribution, when the caller already knows it (the SPA
   * sample-data path holds decoded files with a project but no in-zip path).
   * Falls back to `relativePath` extraction.
   */
  project?: string;
  /** Best available mtime in epoch ms. */
  lastModified?: number;
}

/** A parsed pipeline result — bounded structures, never raw transcript text. */
export type UploadResult =
  | UploadParseEmit
  // The session ids this upload carried, posted before the parse passes so the
  // main thread can apply the same replace-shaped dedup the inline path used
  // (drop a session's prior rows before concatenating this upload's).
  | { type: 'sessionIndex'; sessionIds: string[] }
  | { type: 'history'; entries: HistoryEntry[] }
  // Entries derived from uploaded top-level transcripts (#1070), unioned onto
  // history entries so uploaded sessions show up in Sessions/Search/Projects
  // even when history.jsonl omits them. sessionIds drives the union's dedup.
  | { type: 'transcriptEntries'; entries: HistoryEntry[]; sessionIds: string[] }
  | { type: 'memories'; data: ProjectMemories[] }
  | { type: 'workflows'; data: WorkflowRun[] }
  | { type: 'artifacts'; data: UploadedArtifacts };

/** Everything the build posts: parsed results plus human-readable progress. */
export type UploadPipelineMessage = UploadResult | { type: 'status'; message: string };

export interface BuildUploadDatasetOptions {
  /**
   * Yield the event loop between file-read batches and parse chunks. Use on the
   * main-thread fallback so the UI stays responsive; leave off in a worker.
   */
  yielding?: boolean;
  /** Injected for deterministic tests; defaults to `Date.now()`. */
  nowMs?: number;
  /**
   * Parse-only mode: run just the session parse passes (sessionIndex + parser
   * emits), skipping history, transcript-entry, and aux artifact collection.
   * The SPA sample-data path uses this to parse its small curated corpus off the
   * main thread (its history/memories/etc. are injected separately), without the
   * full ingest re-deriving Sessions rows or scanning for artifacts.
   */
  parseOnly?: boolean;
}

export interface UploadDatasetSummary {
  /**
   * How many usable files the upload yielded (history + session blobs + aux
   * memory/workflow/artifact files). The caller closes the modal when this is
   * > 0 and shows "no usable files" otherwise — matching the old dispatch test.
   */
  usableFiles: number;
}

const READ_BATCH_SIZE = 50;

/**
 * Inflate, read, and fully parse an upload, posting only parsed results and
 * progress. Resolves with a summary the caller uses for its close decision.
 */
export async function buildUploadDataset(
  inputs: UploadInput[],
  post: (msg: UploadPipelineMessage) => void,
  opts: BuildUploadDatasetOptions = {}
): Promise<UploadDatasetSummary> {
  const yielding = opts.yielding ?? false;
  const nowMs = opts.nowMs ?? Date.now();
  const parseOnly = opts.parseOnly ?? false;

  const zipInputs = inputs.filter((input) => isZipPath(input.name));
  const nonZipInputs = inputs.filter((input) => !isZipPath(input.name));
  const loaded: LoadedFile[] = [];

  // Metadata-only files (file-history snapshots): keep structure, never read the
  // body — mirrors FileUpload's old metadata branch.
  for (const input of nonZipInputs) {
    const path = input.relativePath || input.name;
    if (!isMetadataOnlyPath(path)) continue;
    loaded.push({
      name: input.name,
      text: '',
      project: extractProjectName(path),
      path,
      lastModified: input.lastModified || undefined,
      metadataOnly: true,
    });
  }

  // Read loose files in bounded batches so memory stays capped.
  const readableInputs = nonZipInputs.filter(
    (input) => !isMetadataOnlyPath(input.relativePath || input.name)
  );
  for (let i = 0; i < readableInputs.length; i += READ_BATCH_SIZE) {
    const batch = readableInputs.slice(i, i + READ_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (input): Promise<LoadedFile | null> => {
        try {
          return {
            name: input.name,
            text: await input.blob.text(),
            project:
              input.project ??
              (input.relativePath ? extractProjectName(input.relativePath) : undefined),
            path: input.relativePath,
            lastModified: input.lastModified || undefined,
          };
        } catch (err) {
          // Drop an unreadable file but leave a trace — a silently-incomplete
          // upload is otherwise impossible to explain.
          console.error(`Failed to read ${input.name}:`, err);
          return null;
        }
      })
    );
    for (const result of batchResults) if (result) loaded.push(result);
    if (readableInputs.length > 0) {
      post({
        type: 'status',
        message: `Reading files... ${Math.min(loaded.length, readableInputs.length)}/${readableInputs.length}`,
      });
    }
  }

  // Inflate each .zip and merge its (already filtered) entries. Errors are
  // surfaced as a status line and the build continues with whatever loaded —
  // identical to the old main-thread behaviour, and crucially NOT thrown, so the
  // worker path never bounces to a redundant main-thread re-run.
  for (const input of zipInputs) {
    try {
      post({ type: 'status', message: `Extracting ${input.name}...` });
      const fromZip = await unzipBundleFromFile(input.blob);
      for (const file of fromZip) loaded.push(file);
      post({ type: 'status', message: `Extracted ${fromZip.length} file(s) from ${input.name}` });
    } catch (err) {
      post({
        type: 'status',
        message: `Error extracting ${input.name}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    }
  }

  // history.jsonl — the global input log. Parse it here and post entries; the
  // main thread groups them. (Bounded and small relative to transcripts.)
  // Skipped in parseOnly mode — the SPA sample path injects history separately.
  const historyFile = parseOnly
    ? undefined
    : loaded.find((file) => file.name === 'history.jsonl');
  if (historyFile) {
    post({ type: 'history', entries: parseHistoryJsonl(historyFile.text) });
  }

  if (!parseOnly) {
    // #1070: derive session rows from uploaded top-level transcripts and union
    // them onto history entries (emitted AFTER history so it lands on top).
    const transcriptSessionIds = collectUploadTranscriptSessionIds(loaded);
    if (transcriptSessionIds.length > 0) {
      post({
        type: 'transcriptEntries',
        entries: collectUploadTranscriptEntries(loaded),
        sessionIds: transcriptSessionIds,
      });
    }
  }

  // Session transcripts: merge into logical session blobs, then run the parse
  // passes. Each pass posts its parsed rows as it finishes (progressive render).
  const sessionFiles = collectUploadSessions(loaded);
  if (sessionFiles.length > 0) {
    post({
      type: 'sessionIndex',
      sessionIds: sessionFiles.map((file) => file.name.replace(/\.jsonl$/, '')),
    });
    await runUploadParse(sessionFiles, post, { yielding });
  }

  // Aux artifacts (#538/#539/#1051): the user's own memories, workflow run
  // manifests, and dashboard artifacts. Parsed here; only the structures cross.
  // Skipped in parseOnly mode (the sample path injects these separately).
  let auxCount = 0;
  if (!parseOnly) {
    const memories = parseMemories(collectUploadMemories(loaded));
    if (memories.length > 0) post({ type: 'memories', data: memories });
    const workflows = parseWorkflows(collectUploadWorkflows(loaded));
    if (workflows.length > 0) post({ type: 'workflows', data: workflows });
    post({ type: 'artifacts', data: collectUploadArtifacts(loaded, { nowMs }) });
    auxCount = loaded.filter((file) => !file.name.endsWith('.jsonl')).length;
  }

  const usableFiles = (historyFile ? 1 : 0) + sessionFiles.length + auxCount;
  return { usableFiles };
}
