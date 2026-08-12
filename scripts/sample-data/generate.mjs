// Standalone sample-data generator (issue #526) — `npm run generate:sample`.
//
// The sample build generates `sample-data.zip` automatically via the Vite plugin
// in vite.config.ts; this script is the manual escape hatch for inspecting or
// hand-shipping the bundle. It writes `sample-data.zip` to the repo root
// (gitignored) and prints a coverage summary. It is NOT part of any build.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { buildSampleCorpus, corpusZipEntries } from './build-corpus.mjs';

const outPath = fileURLToPath(new URL('../../sample-data.zip', import.meta.url));

const corpus = buildSampleCorpus();
const entries = corpusZipEntries(corpus);
const zipped = zipSync(entries, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
writeFileSync(outPath, zipped);

const historyLines = corpus.historyJsonl.trim().split('\n').length;
const transcriptLines = corpus.sessions.reduce(
  (n, s) => n + s.jsonl.trim().split('\n').length,
  0
);
console.log(`Wrote ${outPath}`);
console.log(
  `  ${corpus.sessions.length} sessions, ${historyLines} history entries, ` +
    `${transcriptLines} transcript lines, ${zipped.length} bytes (zipped)`
);
