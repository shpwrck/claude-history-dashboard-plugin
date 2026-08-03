// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { walkUploadEntries } from './upload-directory';

interface EntryCounters {
  fileReads: number;
}

function fileEntry(name: string, counters: EntryCounters): FileSystemFileEntry {
  return {
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    isDirectory: false,
    isFile: true,
    getParent: () => undefined,
    file(success) {
      counters.fileReads += 1;
      success(new File(['{}\n'], name, { type: 'application/x-ndjson' }));
    },
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  children: FileSystemEntry[],
  batchSize = 100
): FileSystemDirectoryEntry {
  return {
    name,
    fullPath: `/${name}`,
    filesystem: {} as FileSystem,
    isDirectory: true,
    isFile: false,
    getParent: () => undefined,
    createReader() {
      let cursor = 0;
      return {
        readEntries(success) {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          success(batch);
        },
      } as FileSystemDirectoryReader;
    },
  } as unknown as FileSystemDirectoryEntry;
}

describe('walkUploadEntries', () => {
  it('admits 10,000 files with a fixed progress-callback budget (#3261)', async () => {
    const counters = { fileReads: 0 };
    const children = Array.from({ length: 10_000 }, (_, index) =>
      fileEntry(`session-${index}.jsonl`, counters)
    );
    const progress: number[] = [];

    const result = await walkUploadEntries(
      [directoryEntry('projects', children)],
      {
        maxFiles: 10_000,
        maxEntries: 10_001,
        maxProgressUpdates: 100,
        onProgress: (count) => progress.push(count),
      }
    );

    expect(result.files).toHaveLength(10_000);
    expect(result.stats).toEqual({
      entriesExamined: 10_001,
      filesAdmitted: 10_000,
      progressUpdates: 100,
    });
    expect(counters.fileReads).toBe(10_000);
    expect(progress).toHaveLength(100);
    expect(progress.at(-1)).toBe(10_000);
  });

  it('rejects the first file over budget before reading it and reports final progress (#3261)', async () => {
    const counters = { fileReads: 0 };
    const children = Array.from({ length: 4 }, (_, index) =>
      fileEntry(`session-${index}.jsonl`, counters)
    );
    const progress: number[] = [];

    let caught: unknown;
    try {
      await walkUploadEntries([directoryEntry('projects', children)], {
        maxFiles: 3,
        maxEntries: 5,
        maxProgressUpdates: 2,
        onProgress: (count) => progress.push(count),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'DirectoryUploadLimitError',
      code: 'ERR_DIRECTORY_UPLOAD_FILE_LIMIT',
      stats: {
        entriesExamined: 5,
        filesAdmitted: 3,
        progressUpdates: 2,
      },
    });
    expect(String(caught)).toContain('more than 3 usable files');
    expect(counters.fileReads).toBe(3);
    expect(progress).toEqual([2, 3]);
  });

  it('bounds deep entry traversal and reports admitted work before refusing (#3261)', async () => {
    const counters = { fileReads: 0 };
    const deep = directoryEntry('a', [
      directoryEntry('b', [fileEntry('too-deep.jsonl', counters)]),
    ]);
    const root = directoryEntry('projects', [
      fileEntry('admitted.jsonl', counters),
      deep,
    ]);
    const progress: number[] = [];

    let caught: unknown;
    try {
      await walkUploadEntries([root], {
        maxFiles: 10,
        maxEntries: 3,
        maxProgressUpdates: 2,
        onProgress: (count) => progress.push(count),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'ERR_DIRECTORY_UPLOAD_ENTRY_LIMIT',
      stats: {
        entriesExamined: 3,
        filesAdmitted: 1,
        progressUpdates: 1,
      },
    });
    expect(counters.fileReads).toBe(1);
    expect(progress).toEqual([1]);
  });
});
