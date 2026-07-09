// #2182 (epic #2181): the recs path must assemble ONLY the fields the
// recommendation input consumes, via a lighter `assembleRecommendationDataset()`
// that reuses the SAME per-signal builders as the full `assembleDataset()` — so
// the served recs body is BYTE-IDENTICAL while the rebuild skips the full
// dataset's promptAnalysis parse, its embedded first-pass detector-catalog run, and
// the schema/window metadata that no recs detector reads.
//
// These tests prove:
//   (1) BYTE-IDENTICAL — `assembleRecommendationResult` over the light dataset
//       deep-equals it over the full dataset (and over the internal fallback),
//       so switching the recs path to the lighter assembler changes nothing
//       about the served output. This is the byte-identical guarantee.
//   (2) NO FULL ASSEMBLY — the recs-context build increments the LIGHT
//       assembler's call counter and NEVER the full `assembleDataset()` one,
//       proving the recs path no longer triggers the full dataset build.
//   (3) LIGHTER SHAPE — the light dataset omits the dataset-only fields
//       (`promptAnalysis`, `permissionChanges`, `schemaVersion`, `generatedAt`,
//       `units`, …) the full dataset carries, and its recs-consumed fields are
//       deep-equal to the full dataset's for every key EXCEPT the repoMap
//       file-level `recommendations` cross-link (which no served detector reads).
//
// Fixture mirrors recs-dataset-reuse.test.mjs: a throwaway $HOME/.claude/projects
// with real transcripts so the signal parsers produce non-empty per-session
// rows. HOME + CHD_DB_PATH are read at ingest module load, so they MUST be set
// before the dynamic import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DETECTORS } from '../src/lib/detectors/index.ts';

function assistantLine({ text, toolName, toolInput, ts, model }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, input: toolInput },
      ],
    },
  });
}

function userLine(text, ts) {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
}

function sessionJsonl(spec) {
  return [userLine(spec.prompt, spec.ts), assistantLine(spec)].join('\n') + '\n';
}

const SESSIONS = {
  'sess-alpha': {
    prompt: 'do the alpha thing',
    text: 'Here is the alpha answer.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.txt' },
    ts: '2026-01-01T00:00:00.000Z',
    model: 'claude-opus-4',
  },
  'sess-beta': {
    prompt: 'do the beta thing',
    text: 'Beta result computed.',
    toolName: 'Bash',
    toolInput: { command: 'ls /tmp' },
    ts: '2026-01-02T00:00:00.000Z',
    model: 'claude-sonnet-4',
  },
};

function buildFixtureHome() {
  const home = join(tmpdir(), `chd-2182-home-${randomUUID()}`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });
  for (const [sid, spec] of Object.entries(SESSIONS)) {
    writeFileSync(join(proj, `${sid}.jsonl`), sessionJsonl(spec));
  }
  return home;
}

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-2182-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

function countDetectorInvocationsDuring(fn) {
  let calls = 0;
  // Per-detector-id invocation tally. Asserting each id fires exactly once (not
  // just that the aggregate equals DETECTORS.length) defeats a compensating bug
  // where one detector is skipped and another runs twice — the sum still matches
  // but the per-id map does not.
  const perId = new Map(DETECTORS.map((d) => [d.id, 0]));
  const originals = DETECTORS.map((detector) => ({
    detector,
    rule: detector.rule,
    emitAll: detector.emitAll,
  }));
  const bump = (id) => {
    calls += 1;
    perId.set(id, (perId.get(id) ?? 0) + 1);
  };
  for (const detector of DETECTORS) {
    if (detector.emitAll) {
      const original = detector.emitAll;
      detector.emitAll = (...args) => {
        bump(detector.id);
        return original(...args);
      };
    } else {
      const original = detector.rule;
      detector.rule = (...args) => {
        bump(detector.id);
        return original(...args);
      };
    }
  }
  try {
    const result = fn();
    return { calls, perId, result };
  } finally {
    for (const { detector, rule, emitAll } of originals) {
      detector.rule = rule;
      if (emitAll) detector.emitAll = emitAll;
      else delete detector.emitAll;
    }
  }
}

// Strip the file-level repoMap `recommendations` cross-link — the ONLY field the
// light path intentionally leaves empty (populated in the full path by the
// embedded first-pass recs, but read by NO served detector). Everything else in
// repoMap must match between the two paths.
function stripRepoMapRecIds(repoMap) {
  if (!repoMap || !Array.isArray(repoMap.projects)) return repoMap;
  return {
    ...repoMap,
    projects: repoMap.projects.map((p) => ({
      ...p,
      files: (p.files ?? []).map(({ recommendations, ...rest }) => rest),
    })),
  };
}

test('#2182 recs body is byte-identical over the light dataset vs the full dataset', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = buildFixtureHome();
  try {
    const ingest = await loadIngest(home);
    ingest.ingest();

    const full = ingest.assembleDataset();
    const light = ingest.assembleRecommendationDataset();
    assert.ok(full.entries.length > 0, 'fixture produced a non-empty dataset');
    assert.equal(
      light.entries.length,
      full.entries.length,
      'light dataset carries the same entries as the full dataset'
    );

    // (1) BYTE-IDENTICAL: the served recs result is deep-equal whether built over
    // the full dataset or the lighter recs dataset. domainCoverage is the robust
    // observable on a tiny corpus (non-empty even when zero recs fire).
    const overFull = ingest.assembleRecommendationResult(undefined, { dataset: full });
    const overLight = ingest.assembleRecommendationResult(undefined, { dataset: light });
    assert.ok(overFull.domainCoverage.length > 0, 'domainCoverage computed from the dataset');
    assert.deepEqual(
      overLight,
      overFull,
      'recs built over the light dataset are identical to recs over the full dataset'
    );

    // And the internal fallback (no injected dataset -> assembleRecommendationDataset)
    // matches the full-dataset injection, so the default recs path is byte-identical.
    const internal = ingest.assembleRecommendationResult();
    assert.deepEqual(
      internal,
      overFull,
      'the internal recs path (light fallback) matches the full-dataset result'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2182 the recs-context build never triggers the full assembleDataset()', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = buildFixtureHome();
  try {
    const ingest = await loadIngest(home);
    ingest.ingest();

    // (2) NO FULL ASSEMBLY: calling the recs path with NO injected dataset must
    // build the LIGHT dataset once and NEVER the full dataset.
    const before = ingest.assemblyInstrumentation();
    ingest.assembleRecommendationResult();
    const after = ingest.assemblyInstrumentation();
    assert.equal(
      after.full - before.full,
      0,
      'the recs path did NOT call the full assembleDataset()'
    );
    assert.equal(
      after.recommendation - before.recommendation,
      1,
      'the recs path assembled the light recommendation dataset exactly once'
    );

    // Sanity: the full assembleDataset() still bumps only its own counter.
    const b2 = ingest.assemblyInstrumentation();
    ingest.assembleDataset();
    const a2 = ingest.assemblyInstrumentation();
    assert.equal(a2.full - b2.full, 1, 'assembleDataset() bumps the full counter');
    assert.equal(
      a2.recommendation - b2.recommendation,
      0,
      'assembleDataset() does NOT bump the light counter'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2183 the recs path runs the detector catalog exactly one uncached pass', async () => {
  // NOTE on precision: `buildRecommendations` memoizes per input-object identity
  // (a WeakMap keyed on the RecommendationInput), so this test proves exactly one
  // *uncached* catalog pass — a hypothetical duplicate call with the SAME input
  // object would be served from that cache and never touch a detector, so it is
  // invisible to this counter. Defeating the memo would mean threading an explicit
  // `now` (the cache-bypass path in buildRecommendations) through
  // assembleRecommendationResult -> buildRecommendationResult, which is product
  // surgery beyond this test's scope; the single-uncached-pass guarantee is the
  // load-bearing one (no separate dataset-assembly pass + response pass) and is
  // what we assert here.
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = buildFixtureHome();
  try {
    const ingest = await loadIngest(home);
    ingest.ingest();

    const { calls, perId, result } = countDetectorInvocationsDuring(() =>
      ingest.assembleRecommendationResult()
    );

    assert.ok(result.domainCoverage.length > 0, 'result was fully assembled');
    assert.equal(
      calls,
      DETECTORS.length,
      'the recs path invokes each detector once, not once for dataset assembly and again for the response'
    );
    // Per-detector-id: every id fired exactly once. Stronger than the aggregate
    // count above — it rejects a skip-one/double-another compensation that leaves
    // the total unchanged.
    for (const detector of DETECTORS) {
      assert.equal(
        perId.get(detector.id),
        1,
        `detector ${detector.id} was invoked exactly once`
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2182 the light dataset skips dataset-only fields and matches recs-consumed fields', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = buildFixtureHome();
  try {
    const ingest = await loadIngest(home);
    ingest.ingest();

    const full = ingest.assembleDataset();
    const light = ingest.assembleRecommendationDataset();

    // (3a) The light dataset OMITS the dataset-only fields the recs input never
    // reads — proving the heavy/full-only work was skipped, not merely re-shaped.
    for (const skipped of [
      'promptAnalysis',
      'permissionChanges',
      'schemaVersion',
      'generatedAt',
      'windowStart',
      'windowEnd',
      'units',
      'sources',
    ]) {
      assert.ok(skipped in full, `full dataset carries ${skipped}`);
      assert.ok(!(skipped in light), `light dataset omits the dataset-only ${skipped}`);
    }

    // (3b) Every recs-consumed field the light dataset DOES expose is deep-equal
    // to the full dataset's — with the sole, bounded exception of the repoMap
    // file-level `recommendations` cross-link (empty on the light path; no served
    // detector reads it, which is why the served recs above are byte-identical).
    for (const key of Object.keys(light)) {
      if (key === 'repoMap') continue;
      assert.deepEqual(
        light[key],
        full[key],
        `light.${key} matches full.${key}`
      );
    }
    assert.deepEqual(
      stripRepoMapRecIds(light.repoMap),
      stripRepoMapRecIds(full.repoMap),
      'repoMap matches except the unread file-level recommendations cross-link'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});
