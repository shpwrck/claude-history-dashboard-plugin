// FORWARD FENCE for the parser-output -> cache-invalidation seam (#2075).
//
// Run under the ts-resolver loader (the seam consumers reach into .ts modules)
// and with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/parser-output-versions.fence.test.mjs
//
// The seam (scripts/lib/parser-output-versions.mjs) is the SINGLE place that
// says "bump THIS version when THAT parser's output shape changes". Each entry
// carries (a) a `version` baked into a cache key and (b) a `contract`
// fingerprint of that parser's OUTPUT shape. This test recomputes each contract
// FROM THE LIVE CODE and asserts it matches the registered fingerprint.
//
// The point is forward, not backward: today's parity tests
// (signal-descriptor-parity, session-blob-cache-parity, repo-map cache tests)
// prove the CURRENT shape still behaves; none of them fail when a NEW output
// field is added. This fence does. If a parser's output shape drifts — a signal
// column added/removed/reordered, a repo-map envelope field changed — the
// recomputed contract no longer matches the registered one and this test FAILS,
// telling the author to (1) update the contract here AND (2) deliberately bump
// the paired `version`, which is exactly the cache-invalidation step that
// otherwise gets forgotten and ships the change inert.
//
// It does NOT collapse the two caches into one key: each entry is checked
// independently against the shape of its OWN artifact. The genuinely-distinct
// transcript/dataset knobs (PARSER_SIG_VERSION, DATASET_ASSEMBLY_SCHEMA_VERSION)
// are intentionally NOT folded in here — see the seam's header comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_BLOB_OUTPUT,
  REPO_MAP_OUTPUT,
  RELATED_INVALIDATION_KNOBS,
} from './lib/parser-output-versions.mjs';

import { makeSessionSignals } from '../src/lib/signals/index.ts';
import { enforceSizeLimit } from '../src/lib/repo-map/cache.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Identity stubs: the session-blob output CONTRACT is the column set, which is
// independent of what the parsers return. We only need makeSessionSignals to
// build, so the parsers can be no-ops.
function stubParsers() {
  const noop = () => null;
  return {
    parseSessionJsonl: noop,
    parseToolUsage: noop,
    parseSessionTimeline: noop,
    parseApiErrors: noop,
    parsePermissionData: noop,
    parseAgentSettings: noop,
    parseAttribution: noop,
    parseRuntimeEvents: noop,
    parseChurnGeometry: noop,
    parseValueFlow: noop,
    parseToolInventory: noop,
    parseAssistantFeatures: noop,
    parseDeceitSignals: noop,
    parseTaskSuccess: noop,
    deriveEntries: noop,
  };
}

// ---------------------------------------------------------------------------
// SESSION_BLOB: the output shape is the ORDERED set of signal columns the
// session_blob cache persists (src/lib/signals/index.ts). A column added,
// removed, or reordered is exactly an output-shape change that must move the
// SESSION_BLOB_PARSER_VERSION baked into sessionFileSignature().
// ---------------------------------------------------------------------------
test('session-blob output contract === live signal columns (fence: a column change forces a version bump)', () => {
  const liveColumns = makeSessionSignals(stubParsers()).map((s) => s.column);
  assert.deepEqual(
    SESSION_BLOB_OUTPUT.contract,
    liveColumns,
    'session-blob output shape drifted from the registered contract. If you ' +
      'changed a signal column in src/lib/signals/index.ts, update ' +
      'SESSION_BLOB_OUTPUT.contract in scripts/lib/parser-output-versions.mjs ' +
      'AND bump SESSION_BLOB_OUTPUT.version — otherwise the session_blob cache ' +
      'key does not move and the change ships inert.'
  );
});

test('session-blob version is the value the session_blob cache key actually bakes in', () => {
  // The consumer must read the seam, not redefine its own constant. Asserting
  // the literal string is gone from session-blob-row.mjs keeps the seam the
  // single source of truth (a re-introduced literal would silently diverge).
  const src = readFileSync(join(HERE, 'session-blob-row.mjs'), 'utf8');
  assert.match(
    src,
    /SESSION_BLOB_OUTPUT\.version/,
    'session-blob-row.mjs must derive its parser version from the seam ' +
      '(SESSION_BLOB_OUTPUT.version), not a local literal.'
  );
  assert.doesNotMatch(
    src,
    /SESSION_BLOB_PARSER_VERSION\s*=\s*['"]/,
    'session-blob-row.mjs re-introduced a literal SESSION_BLOB_PARSER_VERSION; ' +
      'the value must come from the seam so the forward fence governs it.'
  );
  assert.equal(typeof SESSION_BLOB_OUTPUT.version, 'string');
});

test('session-blob version turns over for the true pre-clip prompt length (#3511)', () => {
  // A CONTENT-shape bump the column fingerprint above cannot force: user
  // timeline_json entries now carry a sparse `summaryRawLen` (the true pre-clip
  // prompt length), with no column added, removed, or renamed — exactly like the
  // v20 entryId bump. Pinning the literal keeps the deliberate bump from being
  // silently reverted.
  assert.equal(
    SESSION_BLOB_OUTPUT.version,
    'timeline-summary-rawlen-v21',
    'user timeline_json entries now carry the true pre-clip summaryRawLen; the uuid-keyed v20 cache key must not remain current'
  );
});

// ---------------------------------------------------------------------------
// REPO_MAP: the output shape is the field set of the persisted envelope that
// enforceSizeLimit() writes and isCacheValid() reads. A field added/removed is
// an output-shape change that must move PERSISTED_REPO_MAP_VERSION.
// ---------------------------------------------------------------------------
test('repo-map output contract === live PersistedRepoMap envelope fields (fence: an envelope change forces a version bump)', () => {
  // Build a minimal persisted envelope through the real producer path so the
  // field set is the LIVE one, not a hand-copied list.
  const map = { root: '/repo', files: [], fileCount: 0, text: '' };
  const cacheKey = {
    root: '/repo',
    gitSha: null,
    maxMtimeMs: 0,
    structureSignature: null,
  };
  const persisted = enforceSizeLimit(
    map,
    cacheKey,
    () => ({ text: '', truncated: false }),
    1_000_000
  );
  const liveFields = Object.keys(persisted);
  assert.deepEqual(
    [...REPO_MAP_OUTPUT.contract].sort(),
    [...liveFields].sort(),
    'repo-map persisted envelope shape drifted from the registered contract. ' +
      'If you changed PersistedRepoMap in src/lib/repo-map/cache.ts, update ' +
      'REPO_MAP_OUTPUT.contract in scripts/lib/parser-output-versions.mjs AND ' +
      'bump REPO_MAP_OUTPUT.version — otherwise stale artifacts are reused.'
  );
});

test('repo-map version is the value the persisted envelope actually stamps', () => {
  const map = { root: '/repo', files: [], fileCount: 0, text: '' };
  const cacheKey = {
    root: '/repo',
    gitSha: null,
    maxMtimeMs: 0,
    structureSignature: null,
  };
  const persisted = enforceSizeLimit(
    map,
    cacheKey,
    () => ({ text: '', truncated: false }),
    1_000_000
  );
  assert.equal(
    persisted.version,
    REPO_MAP_OUTPUT.version,
    'the persisted envelope version must equal REPO_MAP_OUTPUT.version (the ' +
      'seam owns PERSISTED_REPO_MAP_VERSION).'
  );
  assert.equal(typeof REPO_MAP_OUTPUT.version, 'number');
});

// ---------------------------------------------------------------------------
// Guard the "do not conflate" boundary: the transcript/dataset knobs are
// documented as related-but-separate and must NOT be the same as either
// parser-output entry's version (a sign someone collapsed distinct caches).
// ---------------------------------------------------------------------------
test('seam keeps the genuinely-distinct knobs separate, not folded into a parser-output version', () => {
  assert.ok(
    'PARSER_SIG_VERSION' in RELATED_INVALIDATION_KNOBS,
    'PARSER_SIG_VERSION must stay documented as a separate transcript-cache knob'
  );
  assert.ok(
    'DATASET_ASSEMBLY_SCHEMA_VERSION' in RELATED_INVALIDATION_KNOBS,
    'DATASET_ASSEMBLY_SCHEMA_VERSION must stay documented as a separate dataset-contract knob'
  );
  // The two parser-output entries gate different artifacts and have different
  // encodings (string vs number) — they are not interchangeable keys.
  assert.notEqual(
    typeof SESSION_BLOB_OUTPUT.version,
    typeof REPO_MAP_OUTPUT.version,
    'the two parser-output knobs intentionally keep their original encodings'
  );
});
