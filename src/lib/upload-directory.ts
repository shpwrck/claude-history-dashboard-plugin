import {
  SKIP_DIRECTORIES,
  isZipPath,
  shouldSkipFile,
} from './unzip-upload';

export const DIRECTORY_UPLOAD_MAX_FILES = 50_000;
export const DIRECTORY_UPLOAD_MAX_ENTRIES = 100_000;
export const DIRECTORY_UPLOAD_MAX_PROGRESS_UPDATES = 100;

export interface ProcessedUploadFile {
  file: File;
  relativePath?: string;
}

export interface UploadDirectoryStats {
  entriesExamined: number;
  filesAdmitted: number;
  progressUpdates: number;
}

export interface UploadDirectoryOptions {
  maxFiles?: number;
  maxEntries?: number;
  maxProgressUpdates?: number;
  onProgress?: (count: number) => void;
}

export class DirectoryUploadLimitError extends Error {
  readonly code:
    | 'ERR_DIRECTORY_UPLOAD_FILE_LIMIT'
    | 'ERR_DIRECTORY_UPLOAD_ENTRY_LIMIT';
  readonly stats: UploadDirectoryStats;

  constructor(
    code: DirectoryUploadLimitError['code'],
    message: string,
    stats: UploadDirectoryStats
  ) {
    super(message);
    this.name = 'DirectoryUploadLimitError';
    this.code = code;
    this.stats = { ...stats };
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/**
 * Walk loose drag-and-drop entries with one global work budget. FileSystem API
 * readers may return at most 100 entries per call, so directories are consumed
 * incrementally rather than first retained in an unbounded per-directory list.
 */
export async function walkUploadEntries(
  entries: FileSystemEntry[],
  options: UploadDirectoryOptions = {}
): Promise<{ files: ProcessedUploadFile[]; stats: UploadDirectoryStats }> {
  const maxFiles = positiveLimit(options.maxFiles, DIRECTORY_UPLOAD_MAX_FILES);
  const maxEntries = positiveLimit(
    options.maxEntries,
    DIRECTORY_UPLOAD_MAX_ENTRIES
  );
  const maxProgressUpdates = positiveLimit(
    options.maxProgressUpdates,
    DIRECTORY_UPLOAD_MAX_PROGRESS_UPDATES
  );
  const progressStride = Math.max(1, Math.ceil(maxFiles / maxProgressUpdates));
  const files: ProcessedUploadFile[] = [];
  const stats: UploadDirectoryStats = {
    entriesExamined: 0,
    filesAdmitted: 0,
    progressUpdates: 0,
  };
  let lastProgress = 0;

  const reportProgress = () => {
    if (!options.onProgress || stats.filesAdmitted === lastProgress) return;
    options.onProgress(stats.filesAdmitted);
    stats.progressUpdates += 1;
    lastProgress = stats.filesAdmitted;
  };

  const walk = async (entry: FileSystemEntry, relativePath: string) => {
    if (stats.entriesExamined >= maxEntries) {
      reportProgress();
      throw new DirectoryUploadLimitError(
        'ERR_DIRECTORY_UPLOAD_ENTRY_LIMIT',
        `This directory selection contains more than ${maxEntries.toLocaleString()} entries, over the discovery limit. Select a smaller folder or run the dashboard against your live ~/.claude directory instead.`,
        stats
      );
    }
    stats.entriesExamined += 1;

    if (entry.isDirectory) {
      if (SKIP_DIRECTORIES.includes(entry.name)) return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readDirectoryBatch(reader);
        if (batch.length === 0) break;
        for (const child of batch) {
          await walk(child, `${relativePath}/${child.name}`);
        }
      }
      return;
    }

    if (!entry.isFile) return;
    if (!isZipPath(relativePath) && shouldSkipFile(relativePath)) return;
    if (stats.filesAdmitted >= maxFiles) {
      reportProgress();
      throw new DirectoryUploadLimitError(
        'ERR_DIRECTORY_UPLOAD_FILE_LIMIT',
        `This directory selection contains more than ${maxFiles.toLocaleString()} usable files, over the upload limit. Select a smaller folder or run the dashboard against your live ~/.claude directory instead.`,
        stats
      );
    }

    const file = await readFileEntry(entry as FileSystemFileEntry);
    files.push({ file, relativePath });
    stats.filesAdmitted += 1;
    if (stats.filesAdmitted % progressStride === 0) reportProgress();
  };

  for (const entry of entries) await walk(entry, entry.name);
  reportProgress();
  return { files, stats };
}
