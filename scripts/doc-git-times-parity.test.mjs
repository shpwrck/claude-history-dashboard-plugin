// Producer/consumer seam parity for the doc git-times manifest (#2707).
//
// The producer (scripts/doc-git-times-generate.mjs, plain .mjs — no TS imports
// so it stays a zero-dep host tool) and the consumer side (src/lib/
// doc-git-times.ts + parse-docs.ts) each carry their OWN copy of the seam
// constants. A drift is a silent-death class: e.g. a moved RELPATH writes the
// manifest where the runtime never looks and every doc quietly degrades to
// filesystem provenance. This fence fails CI instead.
//
// Run: node --import ./scripts/register-ts.mjs --test scripts/doc-git-times-parity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_GIT_PATHSPECS,
  DOC_GIT_TIMES_MAX_FILES,
  DOC_GIT_TIMES_RELPATH as PRODUCER_RELPATH,
  DOC_GIT_TIMES_SCHEMA_VERSION as PRODUCER_SCHEMA_VERSION,
} from './doc-git-times-generate.mjs';
import {
  DOC_GIT_TIMES_MAX_ENTRIES,
  DOC_GIT_TIMES_RELPATH,
  DOC_GIT_TIMES_SCHEMA_VERSION,
} from '../src/lib/doc-git-times.ts';
import {
  DOC_GRAPH_DEFAULT_MAX_FILES,
  DOC_GRAPH_GIT_PATHS,
} from '../src/lib/parse-docs.ts';

test('producer and consumer agree on the manifest location', () => {
  assert.equal(PRODUCER_RELPATH, DOC_GIT_TIMES_RELPATH);
});

test('producer and consumer agree on the manifest schema version', () => {
  assert.equal(PRODUCER_SCHEMA_VERSION, DOC_GIT_TIMES_SCHEMA_VERSION);
});

test('the three file/entry caps stay lock-step', () => {
  // Producer file cap == consumer entry cap == doc-graph walk cap: a manifest
  // the producer will write must always be within what the consumer accepts,
  // and both must cover every doc the walk can surface.
  assert.equal(DOC_GIT_TIMES_MAX_FILES, DOC_GIT_TIMES_MAX_ENTRIES);
  assert.equal(DOC_GIT_TIMES_MAX_ENTRIES, DOC_GRAPH_DEFAULT_MAX_FILES);
});

test('producer queries the SAME doc surface as the doc-graph git walk', () => {
  assert.deepEqual([...DOC_GIT_PATHSPECS], [...DOC_GRAPH_GIT_PATHS]);
});
