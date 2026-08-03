// Reproducible loose-directory discovery benchmark (#3261). Timing is reported
// for operator comparison only; deterministic work counts are the regression
// contract exercised by src/lib/upload-directory.test.ts.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { walkUploadEntries } from '../src/lib/upload-directory.ts';

const FILE_COUNT = 10_000;
const MAX_PROGRESS_UPDATES = 100;
let fileReads = 0;
let progressUpdates = 0;
let cursor = 0;

const children = Array.from({ length: FILE_COUNT }, (_, index) => ({
  name: `session-${index}.jsonl`,
  isDirectory: false,
  isFile: true,
  file(success) {
    fileReads += 1;
    success(new File(['{}\n'], this.name, { type: 'application/x-ndjson' }));
  },
}));

const root = {
  name: 'projects',
  isDirectory: true,
  isFile: false,
  createReader() {
    return {
      readEntries(success) {
        const batch = children.slice(cursor, cursor + 100);
        cursor += batch.length;
        success(batch);
      },
    };
  },
};

const startedAt = performance.now();
const result = await walkUploadEntries([root], {
  maxFiles: FILE_COUNT,
  maxEntries: FILE_COUNT + 1,
  maxProgressUpdates: MAX_PROGRESS_UPDATES,
  onProgress() {
    progressUpdates += 1;
  },
});
const elapsedMs = performance.now() - startedAt;

assert.equal(result.files.length, FILE_COUNT);
assert.deepEqual(result.stats, {
  entriesExamined: FILE_COUNT + 1,
  filesAdmitted: FILE_COUNT,
  progressUpdates: MAX_PROGRESS_UPDATES,
});
assert.equal(fileReads, FILE_COUNT);
assert.equal(progressUpdates, MAX_PROGRESS_UPDATES);

console.log('Loose directory upload benchmark (#3261)');
console.log(`files: ${result.files.length.toLocaleString()}`);
console.log(`entries examined: ${result.stats.entriesExamined.toLocaleString()}`);
console.log(`file reads: ${fileReads.toLocaleString()}`);
console.log(`progress callbacks: ${progressUpdates.toLocaleString()}`);
console.log(`elapsed: ${elapsedMs.toFixed(1)} ms (reported, not gated)`);
