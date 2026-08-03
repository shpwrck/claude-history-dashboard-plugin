// Isolated memory receipt for the bounded ZIP inflation contract (#3368).

import { readFileSync } from 'node:fs';
import {
  unzipBundleFromChunks,
  UploadTooLargeError,
} from '../../src/lib/unzip-upload.ts';

const MIB = 1024 * 1024;
const archive = new Uint8Array(readFileSync(0));

// The parent supplies the compressed fixture so its 64 MiB source allocation
// cannot pollute this isolated process's incremental high-water receipt.
const baseline = process.resourceUsage().maxRSS * 1024;
let rejected = false;

try {
  await unzipBundleFromChunks(
    [archive],
    archive.byteLength,
    { maxEntryBytes: MIB }
  );
} catch (error) {
  rejected = error instanceof UploadTooLargeError;
}

const peak = process.resourceUsage().maxRSS * 1024;

console.log(
  JSON.stringify({
    rejected,
    rssDelta: Math.max(0, peak - baseline),
  })
);
