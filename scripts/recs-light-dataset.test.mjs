// #2182 (epic #2181): the recs path must assemble ONLY the fields the
// recommendation input consumes, via a lighter `assembleRecommendationDataset()`
// that reuses the SAME per-signal builders as the full `assembleDataset()` — so
// the served recs body is BYTE-IDENTICAL while the rebuild skips the full
// dataset's embedded first-pass detector-catalog run and the schema/window
// metadata that no served recs detector reads. The compact promptAnalysis rows
// ARE included because workflow.prompt-clarity is a served detector.
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
//       (`permissionChanges`, `schemaVersion`, `generatedAt`, `units`, …) the
//       full dataset carries, and its recs-consumed fields are
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
import { delimiter, join } from 'node:path';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  const rows = [userLine(spec.prompt, spec.ts), assistantLine(spec)];
  for (let i = 0; i < (spec.followUpTurns ?? 0); i += 1) {
    rows.push(
      userLine(
        `continue ${i + 1}`,
        new Date(Date.parse(spec.ts) + (i + 1) * 1_000).toISOString()
      )
    );
  }
  return `${rows.join('\n')}\n`;
}

const SESSIONS = {
  'low-alpha': {
    prompt: 'do the thing',
    text: 'Here is the alpha answer.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.txt' },
    ts: '2026-01-01T00:00:00.000Z',
    model: 'claude-opus-4',
    followUpTurns: 4,
  },
  'low-beta': {
    prompt: 'help me with this',
    text: 'Beta result computed.',
    toolName: 'Bash',
    toolInput: { command: 'ls /tmp' },
    ts: '2026-01-02T00:00:00.000Z',
    model: 'claude-sonnet-4',
    followUpTurns: 4,
  },
  'low-gamma': {
    prompt: 'make it better',
    text: 'Gamma result computed.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/g.txt' },
    ts: '2026-01-03T00:00:00.000Z',
    model: 'claude-sonnet-4',
    followUpTurns: 4,
  },
  'specific-alpha': {
    prompt: 'Update src/a.ts; tests must pass.',
    text: 'Specific alpha complete.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.txt' },
    ts: '2026-01-04T00:00:00.000Z',
    model: 'claude-opus-4',
  },
  'specific-beta': {
    prompt: 'Update src/b.ts; tests must pass.',
    text: 'Specific beta complete.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/b.txt' },
    ts: '2026-01-05T00:00:00.000Z',
    model: 'claude-sonnet-4',
  },
  'specific-gamma': {
    prompt: 'Update src/c.ts; tests must pass.',
    text: 'Specific gamma complete.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/c.txt' },
    ts: '2026-01-06T00:00:00.000Z',
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
    const promptClarity = overLight.recommendations.find(
      (rec) => rec.id === 'workflow.prompt-clarity'
    );
    assert.ok(promptClarity, 'light/full parity fixture emits workflow.prompt-clarity');
    assert.ok(
      promptClarity.references?.some(
        (reference) =>
          reference.url === 'https://code.claude.com/docs/en/prompt-library'
      ),
      'served-light prompt-clarity carries the prompt-library reference'
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

test('#2574 semantic intent is carried byte-identically by the light recommendation dataset', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origSemantic = process.env.CHD_SEMANTIC_INTENT;
  const home = buildFixtureHome();
  const artifactDir = join(home, '.claude', 'model-evals', 'semantic-intent');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'receipt.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'semantic-intent-receipts',
      taxonomyVersion: 'v1',
      classifier: { id: 'mmbert-intent', revision: 'r7' },
      rows: [
        {
          evidenceRef: 'prompt-hash-light-parity',
          contentSha256: 'a'.repeat(64),
          intentClass: 'bug-triage',
          confidence: 0.9,
          canonicalTaskClass: 'debug',
          classifiedAt: '2026-07-19T12:00:00.000Z',
        },
      ],
    })
  );

  try {
    process.env.CHD_SEMANTIC_INTENT = '1';
    const ingest = await loadIngest(home);
    ingest.ingest();
    const full = ingest.assembleDataset();
    const light = ingest.assembleRecommendationDataset();

    assert.equal(light.semanticIntent?.rowCount, 1);
    assert.deepEqual(
      light.semanticIntent,
      full.semanticIntent,
      'the served-light path carries the same opt-in semantic artifact'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origSemantic === undefined) delete process.env.CHD_SEMANTIC_INTENT;
    else process.env.CHD_SEMANTIC_INTENT = origSemantic;
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
    assert.ok(
      Array.isArray(light.promptAnalysis) && light.promptAnalysis.length >= 6,
      'light dataset includes compact prompt-analysis rows for served detectors'
    );
    assert.equal(
      JSON.stringify(light.promptAnalysis).includes('do the thing'),
      false,
      'light prompt analysis retains numeric traits, not prompt prose'
    );

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

test('#2380 repo docs reach both datasets and invalidate both cache gates', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origDocRoot = process.env.CHD_DOC_GRAPH_ROOT;
  const home = buildFixtureHome();
  const gitRoot = join(tmpdir(), `chd-2380-docs-${randomUUID()}`);
  // Exercise the production override as a subdirectory of a larger checkout.
  // Git pathspecs and emitted names must stay relative to this selected root.
  const docRoot = join(gitRoot, 'package');
  mkdirSync(join(docRoot, 'docs'), { recursive: true });
  writeFileSync(join(docRoot, 'README.md'), '# First\n');
  const guidePath = join(docRoot, 'docs', 'guide.md');
  writeFileSync(guidePath, '# Guide\n');

  try {
    process.env.CHD_DOC_GRAPH_ROOT = docRoot;
    const ingest = await loadIngest(home);
    ingest.ingest();

    const full = ingest.assembleDataset();
    const light = ingest.assembleRecommendationDataset();
    assert.deepEqual(light.docGraph, full.docGraph);
    assert.equal(
      full.docGraph.root,
      docRoot,
      'the serialized graph carries the exact root used for repo-map identity'
    );
    assert.deepEqual(
      full.docGraph.nodes.map((node) => node.path).sort(),
      ['README.md', 'docs/guide.md'],
      'the serialized client dataset carries the same local doc graph as recommendations'
    );

    const baselineSignature = ingest.sourceSignature();
    const baselineHash = ingest.ingest().contentHash;
    const before = statSync(guidePath);
    writeFileSync(guidePath, '# Other\n');
    assert.equal(statSync(guidePath).size, before.size, 'fixture preserves byte length');
    utimesSync(guidePath, before.atime, before.mtime);

    assert.notEqual(
      ingest.sourceSignature(),
      baselineSignature,
      'a repo-doc edit invalidates the cheap response signature'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      baselineHash,
      'a repo-doc edit invalidates the persisted dataset cache key'
    );

    // Git history is part of docGraph output (`gitMtimeIso`) even when the
    // working-tree bytes and stat metadata stay unchanged. Moving the same
    // files from untracked to committed must therefore invalidate both gates.
    const untrackedSignature = ingest.sourceSignature();
    const untrackedHash = ingest.ingest().contentHash;
    execFileSync('git', ['init'], { cwd: gitRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.name', 'CHD Test'], { cwd: gitRoot });
    execFileSync('git', ['add', 'package/README.md', 'package/docs/guide.md'], {
      cwd: gitRoot,
    });
    execFileSync('git', ['commit', '-m', 'Track docs'], {
      cwd: gitRoot,
      stdio: 'ignore',
    });

    assert.notEqual(
      ingest.sourceSignature(),
      untrackedSignature,
      'committing unchanged repo docs invalidates the cheap response signature'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      untrackedHash,
      'committing unchanged repo docs invalidates the persisted dataset cache key'
    );
    const expectedGuideMtime = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', 'package/docs/guide.md'],
      { cwd: gitRoot, encoding: 'utf8' }
    ).trim();
    assert.equal(
      ingest
        .assembleDataset()
        .docGraph.nodes.find((node) => node.path === 'docs/guide.md')
        ?.gitMtimeIso,
      expectedGuideMtime,
      'a nested doc root keeps git history paths relative to that root'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origDocRoot === undefined) delete process.env.CHD_DOC_GRAPH_ROOT;
    else process.env.CHD_DOC_GRAPH_ROOT = origDocRoot;
  }
});

test('#2746 ingest hashes and joins one pinned doc-git-times snapshot', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origDocRoot = process.env.CHD_DOC_GRAPH_ROOT;
  const origExpectedCommit = process.env.CHD_DOC_GIT_TIMES_EXPECTED_COMMIT;
  const home = buildFixtureHome();
  const docRoot = join(tmpdir(), `chd-2746-docs-${randomUUID()}`);
  const manifestPath = join(docRoot, 'data', 'doc-git-times.json');
  const commit = 'c'.repeat(40);
  const firstTime = '2026-01-05T10:00:00+00:00';
  const secondTime = '2026-02-06T11:00:00+00:00';
  mkdirSync(join(docRoot, 'data'), { recursive: true });
  writeFileSync(join(docRoot, 'README.md'), '# Readme\n');

  const writeManifest = (time) => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        sourceCommit: commit,
        files: { 'README.md': time },
      })
    );
  };

  try {
    process.env.CHD_DOC_GRAPH_ROOT = docRoot;
    process.env.CHD_DOC_GIT_TIMES_EXPECTED_COMMIT = commit;
    writeManifest(firstTime);
    const ingest = await loadIngest(home);
    const parseDocs = await import('../src/lib/parse-docs.ts');
    parseDocs.resetDocGitTimesSnapshotInstrumentation();

    const firstSourceSig = ingest.sourceSignature();
    const first = ingest.ingest(firstSourceSig);
    writeManifest(secondTime);
    const firstGraph = ingest.assembleDataset().docGraph;
    assert.equal(
      firstGraph.nodes.find((node) => node.path === 'README.md')?.gitMtimeIso,
      firstTime,
      'assembly stays pinned to the exact manifest bytes hashed by ingest'
    );
    assert.deepEqual(
      parseDocs.docGitTimesSnapshotInstrumentation(),
      { stats: 1, reads: 1, parses: 1 },
      'source signature, content hash, and graph join share one manifest IO pass'
    );

    const secondSourceSig = ingest.sourceSignature();
    const second = ingest.ingest(secondSourceSig);
    assert.notEqual(second.contentHash, first.contentHash);
    assert.equal(
      ingest
        .assembleDataset()
        .docGraph.nodes.find((node) => node.path === 'README.md')?.gitMtimeIso,
      secondTime,
      'the next ingest captures the replacement as one new snapshot'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(docRoot, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origDocRoot === undefined) delete process.env.CHD_DOC_GRAPH_ROOT;
    else process.env.CHD_DOC_GRAPH_ROOT = origDocRoot;
    if (origExpectedCommit === undefined) {
      delete process.env.CHD_DOC_GIT_TIMES_EXPECTED_COMMIT;
    } else {
      process.env.CHD_DOC_GIT_TIMES_EXPECTED_COMMIT = origExpectedCommit;
    }
  }
});

test('#3711 transient doc Git failure is candidate-bound and recovers unchanged', async () => {
  const original = {
    HOME: process.env.HOME,
    CHD_DB_PATH: process.env.CHD_DB_PATH,
    CHD_DOC_GRAPH_ROOT: process.env.CHD_DOC_GRAPH_ROOT,
    PATH: process.env.PATH,
    CHD_TEST_REAL_GIT: process.env.CHD_TEST_REAL_GIT,
    CHD_TEST_GIT_FAIL: process.env.CHD_TEST_GIT_FAIL,
    CHD_TEST_GIT_CALLS: process.env.CHD_TEST_GIT_CALLS,
  };
  const home = buildFixtureHome();
  const gitRoot = join(tmpdir(), `chd-3711-docs-${randomUUID()}`);
  const fakeBin = join(tmpdir(), `chd-3711-bin-${randomUUID()}`);
  const failFlag = join(tmpdir(), `chd-3711-fail-${randomUUID()}`);
  const callsPath = join(tmpdir(), `chd-3711-calls-${randomUUID()}`);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  mkdirSync(join(gitRoot, 'docs'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(gitRoot, 'README.md'), '# Readme\n');
  writeFileSync(join(gitRoot, 'docs', 'guide.md'), '# Guide\n');
  execFileSync(realGit, ['init'], { cwd: gitRoot, stdio: 'ignore' });
  execFileSync(realGit, ['config', 'user.email', 'test@example.com'], { cwd: gitRoot });
  execFileSync(realGit, ['config', 'user.name', 'CHD Test'], { cwd: gitRoot });
  execFileSync(realGit, ['add', 'README.md', 'docs/guide.md'], { cwd: gitRoot });
  execFileSync(realGit, ['commit', '-m', 'Track docs'], {
    cwd: gitRoot,
    stdio: 'ignore',
  });
  const fakeGit = join(fakeBin, 'git');
  writeFileSync(
    fakeGit,
    `#!/bin/sh
bulk=0
for arg in "$@"; do
  if [ "$arg" = "--max-count=4096" ]; then bulk=1; fi
done
if [ "$bulk" = "1" ]; then
  printf 'bulk\\n' >> "$CHD_TEST_GIT_CALLS"
  if [ -f "$CHD_TEST_GIT_FAIL" ]; then exit 1; fi
fi
exec "$CHD_TEST_REAL_GIT" "$@"
`
  );
  chmodSync(fakeGit, 0o755);

  try {
    process.env.CHD_DOC_GRAPH_ROOT = gitRoot;
    process.env.CHD_TEST_REAL_GIT = realGit;
    process.env.CHD_TEST_GIT_FAIL = failFlag;
    process.env.CHD_TEST_GIT_CALLS = callsPath;
    process.env.PATH = `${fakeBin}${delimiter}${original.PATH ?? ''}`;
    const ingest = await loadIngest(home);
    const healthyHash = ingest.ingest().contentHash;
    const healthySignature = ingest.sourceSignature();
    const healthy = ingest.assembleRecommendationDataset();
    assert.equal(ingest.datasetHasTransientDocGraphFailure(healthy), false);
    assert.equal(healthy.docGraph.nodes[0]?.gitMtimeProvenance, 'git');

    writeFileSync(failFlag, 'fail\n');
    const failed = ingest.assembleRecommendationDataset();
    assert.equal(ingest.datasetHasTransientDocGraphFailure(failed), true);
    assert.ok(
      failed.docGraph.nodes.every((node) => node.gitMtimeProvenance !== 'git'),
      'the failed bulk walk falls through instead of claiming live Git history'
    );
    assert.equal(
      JSON.stringify(failed.docGraph).includes('transientGitHistoryFailure'),
      false,
      'candidate-bound cache metadata is never serialized'
    );
    assert.equal(ingest.ingest().contentHash, healthyHash);
    assert.equal(ingest.sourceSignature(), healthySignature);

    const bulkCallsBeforeSignatures = readFileSync(callsPath, 'utf8');
    ingest.sourceSignature();
    ingest.sourceSignature();
    assert.equal(
      readFileSync(callsPath, 'utf8'),
      bulkCallsBeforeSignatures,
      'the cheap source signature never runs the bulk Git walk'
    );

    rmSync(failFlag, { force: true });
    const recovered = ingest.assembleRecommendationDataset();
    assert.equal(ingest.datasetHasTransientDocGraphFailure(recovered), false);
    assert.ok(
      recovered.docGraph.nodes.every(
        (node) => node.gitMtimeProvenance === 'git'
      ),
      'the next unchanged assembly restores live Git provenance'
    );
    assert.equal(ingest.ingest().contentHash, healthyHash);
    assert.equal(ingest.sourceSignature(), healthySignature);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(gitRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(failFlag, { force: true });
    rmSync(callsPath, { force: true });
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('#2309 external-guidance cache gates share one bounded top-level JSON surface', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origGuidanceDir = process.env.CHD_EXTERNAL_GUIDANCE_DIR;
  const home = buildFixtureHome();
  const guidanceDir = join(home, 'external-guidance');
  mkdirSync(guidanceDir, { recursive: true });
  for (let index = 0; index < 256; index += 1) {
    writeFileSync(
      join(guidanceDir, `snapshot-${String(index).padStart(3, '0')}.json`),
      JSON.stringify({ value: `included-${String(index).padStart(3, '0')}` })
    );
  }

  try {
    process.env.CHD_EXTERNAL_GUIDANCE_DIR = guidanceDir;
    const ingest = await loadIngest(home);
    const baselineSignature = ingest.sourceSignature();
    const baselineHash = ingest.ingest().contentHash;

    mkdirSync(join(guidanceDir, 'nested'), { recursive: true });
    writeFileSync(join(guidanceDir, 'nested', 'ignored.json'), '{"ignored":true}');
    writeFileSync(join(guidanceDir, 'ignored.txt'), 'ignored');
    writeFileSync(join(guidanceDir, 'snapshot-256.json'), '{"beyond":"cap"}');

    assert.equal(
      ingest.sourceSignature(),
      baselineSignature,
      'deep, non-JSON, and beyond-cap entries do not churn the cheap signature'
    );
    assert.equal(
      ingest.ingest().contentHash,
      baselineHash,
      'deep, non-JSON, and beyond-cap entries do not churn the dataset hash'
    );

    const includedPath = join(guidanceDir, 'snapshot-000.json');
    const before = statSync(includedPath);
    const original = JSON.parse(readFileSync(includedPath, 'utf8'));
    const replacement = JSON.stringify({ value: original.value.replace('included', 'replaced') });
    assert.equal(
      Buffer.byteLength(replacement),
      before.size,
      'fixture replacement preserves byte length'
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(includedPath, replacement);
    utimesSync(includedPath, before.atime, before.mtime);

    assert.notEqual(
      ingest.sourceSignature(),
      baselineSignature,
      'a restored-mtime equal-length rewrite invalidates the cheap signature'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      baselineHash,
      'the dataset hash follows bounded file content, not restorable metadata'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origGuidanceDir === undefined) delete process.env.CHD_EXTERNAL_GUIDANCE_DIR;
    else process.env.CHD_EXTERNAL_GUIDANCE_DIR = origGuidanceDir;
  }
});

test('#2558 fixed-depth archive memory reads feed stores and both cache gates', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2558-home-${randomUUID()}`);
  const memory = join(home, '.claude', 'projects', 'project-a', 'memory');
  const archive = join(memory, 'archive');
  const nested = join(archive, 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '- [Archive](archive/ARCHIVE.md)\n');
  writeFileSync(join(memory, 'current.md'), 'current\n');
  writeFileSync(join(archive, 'ARCHIVE.md'), '- [Old](old.md)\n');
  writeFileSync(join(archive, 'old.md'), 'old v1\n');
  writeFileSync(join(nested, 'ignored.md'), 'ignored v1\n');

  const rewriteWithNewMtime = (path, content, tick) => {
    writeFileSync(path, content);
    const when = new Date(Date.now() + tick * 10_000);
    utimesSync(path, when, when);
  };

  try {
    const ingest = await loadIngest(home);
    assert.deepEqual(ingest.memoryOpenCapabilities({ O_RDONLY: 0 }), {
      noFollow: false,
      nonBlocking: false,
    });
    assert.equal(
      ingest.memoryOpenFlags({ O_RDONLY: 0 }),
      0,
      'platforms without POSIX-only flags retain a read-only fallback'
    );
    assert.equal(
      ingest.memoryOpenFlags({
        O_RDONLY: 0,
        O_NOFOLLOW: 0x10,
        O_NONBLOCK: 0x20,
      }),
      0x30,
      'available no-follow and nonblocking protections are both enabled'
    );
    assert.equal(
      ingest.memoryOpenedPathMatches(
        '/memory',
        '/memory/old.md',
        '/memory/old.md',
        'linux'
      ),
      true
    );
    assert.equal(
      ingest.memoryOpenedPathMatches(
        '/memory',
        '/memory/old.md',
        '/memory/new.md',
        'linux'
      ),
      false,
      'an opened descriptor renamed to another path is treated as raced'
    );
    assert.equal(
      ingest.memoryOpenedPathMatches(
        'C:\\Memory',
        'C:\\Memory\\OLD.md',
        'c:\\memory\\old.md',
        'win32'
      ),
      true,
      'the portable Windows comparison is case-insensitive'
    );
    const stores = ingest.readMemoryStores();
    assert.equal(stores.length, 1);
    assert.deepEqual(
      stores[0].memories.map((memoryFact) => memoryFact.file).sort(),
      ['archive/old.md', 'current.md']
    );
    assert.deepEqual(
      stores[0].archiveIndex.map((entry) => entry.file),
      ['archive/old.md']
    );
    assert.deepEqual(stores[0].readCompleteness, {
      facts: true,
      mainIndex: true,
      archiveIndex: true,
    });

    const sig1 = ingest.sourceSignature();
    const hash1 = ingest.ingest().contentHash;
    const oldPath = join(archive, 'old.md');
    const oldStat = statSync(oldPath);
    writeFileSync(oldPath, 'old v2\n');
    utimesSync(oldPath, oldStat.atime, oldStat.mtime);
    const sig2 = ingest.sourceSignature();
    const hash2 = ingest.ingest().contentHash;
    assert.notEqual(
      sig2,
      sig1,
      'an equal-size, restored-mtime archive rewrite changes the cheap signature'
    );
    assert.notEqual(
      hash2,
      hash1,
      'an equal-size, restored-mtime archive rewrite changes the content hash'
    );

    const invalidPath = join(archive, 'invalid.md');
    writeFileSync(invalidPath, Buffer.from([0x80]));
    const invalidStat = statSync(invalidPath);
    const sigInvalid1 = ingest.sourceSignature();
    const hashInvalid1 = ingest.ingest().contentHash;
    writeFileSync(invalidPath, Buffer.from([0x81]));
    utimesSync(invalidPath, invalidStat.atime, invalidStat.mtime);
    assert.notEqual(
      ingest.sourceSignature(),
      sigInvalid1,
      'same-decoding raw bytes change the cheap signature'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      hashInvalid1,
      'same-decoding raw bytes change the content hash'
    );

    rewriteWithNewMtime(
      join(archive, 'ARCHIVE.md'),
      '- [Old renamed](old.md)\n',
      2
    );
    const sig3 = ingest.sourceSignature();
    const hash3 = ingest.ingest().contentHash;
    assert.notEqual(sig3, sig2, 'archive index changes the cheap source signature');
    assert.notEqual(hash3, hash2, 'archive index changes the dataset content hash');

    rewriteWithNewMtime(join(nested, 'ignored.md'), 'ignored v2\n', 3);
    assert.equal(
      ingest.sourceSignature(),
      sig3,
      'deeper archive files stay outside the fixed-depth signature'
    );
    assert.equal(
      ingest.ingest().contentHash,
      hash3,
      'deeper archive files stay outside the fixed-depth content hash'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2558 memory-store ingest honors a sub-1 KiB memory file cap', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origMemoryCap = process.env.DASHBOARD_MEMORY_FILE_MAX_BYTES;
  const home = join(tmpdir(), `chd-2558-cap-home-${randomUUID()}`);
  const memory = join(home, '.claude', 'projects', 'project-capped', 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '- [Large](large.md)\n');
  writeFileSync(join(memory, 'large.md'), 'x'.repeat(512));

  try {
    process.env.DASHBOARD_MEMORY_FILE_MAX_BYTES = '256';
    const ingest = await loadIngest(home);
    const stores = ingest.readMemoryStores();
    assert.equal(stores.length, 1);
    assert.deepEqual(stores[0].memories, []);
    assert.equal(stores[0].index[0]?.file, 'large.md');
    assert.equal(stores[0].readCompleteness.facts, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origMemoryCap === undefined) {
      delete process.env.DASHBOARD_MEMORY_FILE_MAX_BYTES;
    } else {
      process.env.DASHBOARD_MEMORY_FILE_MAX_BYTES = origMemoryCap;
    }
  }
});

test('#2558 memory-store ingest rejects a memory symlink outside the projects root', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2558-symlink-home-${randomUUID()}`);
  const project = join(home, '.claude', 'projects', 'project-linked');
  const outsideMemory = join(home, 'outside-memory');
  mkdirSync(project, { recursive: true });
  mkdirSync(outsideMemory, { recursive: true });
  writeFileSync(join(outsideMemory, 'MEMORY.md'), '- [Secret](secret.md)\n');
  writeFileSync(join(outsideMemory, 'secret.md'), 'outside v1\n');
  symlinkSync(outsideMemory, join(project, 'memory'), 'dir');

  try {
    const ingest = await loadIngest(home);
    assert.deepEqual(
      ingest.readMemoryStores(),
      [],
      'the recommendation input does not follow the escaping memory directory'
    );
    const sig1 = ingest.sourceSignature();
    const hash1 = ingest.ingest().contentHash;

    writeFileSync(join(outsideMemory, 'secret.md'), 'outside v2\n');
    const when = new Date(Date.now() + 10_000);
    utimesSync(join(outsideMemory, 'secret.md'), when, when);

    assert.equal(
      ingest.sourceSignature(),
      sig1,
      'outside memory changes stay outside the cheap signature'
    );
    assert.equal(
      ingest.ingest().contentHash,
      hash1,
      'outside memory changes stay outside the dataset content hash'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2558 memory-store ingest reads an in-root symlinked memory directory', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2558-in-root-symlink-home-${randomUUID()}`);
  const project = join(home, '.claude', 'projects', 'project-linked');
  const realMemory = join(project, 'memory-real');
  mkdirSync(realMemory, { recursive: true });
  writeFileSync(join(realMemory, 'MEMORY.md'), '- [Fact](fact.md)\n');
  writeFileSync(join(realMemory, 'fact.md'), 'linked memory fact\n');
  symlinkSync(realMemory, join(project, 'memory'), 'dir');

  try {
    const ingest = await loadIngest(home);
    const stores = ingest.readMemoryStores();
    assert.equal(stores.length, 1);
    assert.equal(stores[0].project, 'project-linked');
    assert.deepEqual(
      stores[0].memories.map((memory) => memory.file),
      ['fact.md']
    );
    assert.deepEqual(
      stores[0].index.map((entry) => entry.file),
      ['fact.md']
    );
    assert.deepEqual(stores[0].readCompleteness, {
      facts: true,
      mainIndex: true,
      archiveIndex: true,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('#2709 docs-map contract reaches both datasets, binds checkout identity, and invalidates both cache gates', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origDocRoot = process.env.CHD_DOC_GRAPH_ROOT;
  const origGitSha = process.env.GIT_SHA;
  const origRepoEnv = process.env.CHD_DOCS_MAP_REPOSITORY;
  const home = buildFixtureHome();
  const docRoot = join(tmpdir(), `chd-2709-docs-${randomUUID()}`);
  mkdirSync(join(docRoot, 'docs'), { recursive: true });
  writeFileSync(join(docRoot, 'README.md'), '# First\n');
  const mapPath = join(docRoot, 'docs', 'docs-map.json');
  const declaration = {
    version: 1,
    repository: 'acme/widgets',
    documents: {
      'docs/guide.md': {
        sources: [{ path: 'src/lib/example.ts', symbols: ['buildExample'] }],
      },
    },
  };
  writeFileSync(mapPath, JSON.stringify(declaration));

  try {
    delete process.env.GIT_SHA;
    delete process.env.CHD_DOCS_MAP_REPOSITORY;
    process.env.CHD_DOC_GRAPH_ROOT = docRoot;
    const ingest = await loadIngest(home);
    ingest.ingest();

    // (1) Parity + shape: both assemblies carry the same validated wrapper.
    const full = ingest.assembleDataset();
    const light = ingest.assembleRecommendationDataset();
    assert.deepEqual(light.docsMap, full.docsMap, 'light/full docsMap parity');
    // Compare the SERIALIZED form (what every client surface receives): the
    // in-memory `documents` record is deliberately null-prototype, which
    // strict deepEqual would reject against a plain literal.
    assert.deepEqual(
      JSON.parse(JSON.stringify(full.docsMap.map)),
      declaration,
      'the validated declaration is carried whole'
    );
    assert.equal(
      full.docsMap.repository,
      null,
      'no checkout and no locator env means missing identity (suppression)'
    );
    assert.equal(full.docsMap.commit, null);

    // (2) Gitless-runtime fallback: the deploy locators fill the wrapper the
    // way the container image (no git for this root) relies on. A shaped-but-
    // SHORT stamp (the published image-tag convention) can never match a full
    // repo-map sha, so it must read as unknown rather than silently binding.
    process.env.CHD_DOCS_MAP_REPOSITORY = 'ACME/Widgets';
    process.env.GIT_SHA = 'abc1234';
    const shortStamp = ingest.assembleDataset().docsMap;
    assert.equal(
      shortStamp.repository,
      'acme/widgets',
      'the locator slug is case-folded to the canonical form'
    );
    assert.equal(shortStamp.commit, null, 'a short stamp must not bind a commit');
    process.env.GIT_SHA = 'a'.repeat(40);
    const stamped = ingest.assembleDataset().docsMap;
    assert.equal(stamped.repository, 'acme/widgets');
    assert.equal(stamped.commit, 'a'.repeat(40));
    // Declared-vs-derived reconciliation: an identity naming a DIFFERENT
    // repository than the declaration rejects the whole wrapper — a cross-repo
    // copy must never bind.
    process.env.CHD_DOCS_MAP_REPOSITORY = 'someone-else/fork';
    assert.equal(
      ingest.assembleDataset().docsMap,
      null,
      'a declared/derived repository mismatch suppresses the wrapper'
    );
    delete process.env.CHD_DOCS_MAP_REPOSITORY;
    delete process.env.GIT_SHA;

    // (3) Invalidation: a byte-length-preserving, mtime-restored JSON edit
    // moves BOTH cache gates without touching any Markdown.
    const baselineSignature = ingest.sourceSignature();
    const baselineHash = ingest.ingest().contentHash;
    const before = statSync(mapPath);
    writeFileSync(
      mapPath,
      JSON.stringify({ ...declaration, repository: 'acme/gadgets' })
    );
    assert.equal(statSync(mapPath).size, before.size, 'fixture preserves byte length');
    utimesSync(mapPath, before.atime, before.mtime);
    assert.notEqual(
      ingest.sourceSignature(),
      baselineSignature,
      'a docs-map-only edit invalidates the cheap response signature'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      baselineHash,
      'a docs-map-only edit invalidates the persisted dataset cache key'
    );

    // (4) Whole-map rejection: ONE malformed entry nulls the wrapper — no
    // partially trusted map is ever serialized.
    writeFileSync(
      mapPath,
      JSON.stringify({
        ...declaration,
        documents: {
          ...declaration.documents,
          'docs/bad.md': { sources: [{ path: '../escape.ts', symbols: ['x'] }] },
        },
      })
    );
    assert.equal(
      ingest.assembleDataset().docsMap,
      null,
      'any bad entry rejects the whole map'
    );

    // (5) Git identity binding: a clean committed checkout with an origin
    // remote binds repository+commit; only the docs-map file's OWN tracked
    // dirtiness suppresses the commit.
    writeFileSync(mapPath, JSON.stringify(declaration));
    execFileSync('git', ['init'], { cwd: docRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: docRoot });
    execFileSync('git', ['config', 'user.name', 'CHD Test'], { cwd: docRoot });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'],
      { cwd: docRoot }
    );
    execFileSync('git', ['add', '-A'], { cwd: docRoot });
    execFileSync('git', ['commit', '-m', 'Bind docs map'], {
      cwd: docRoot,
      stdio: 'ignore',
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: docRoot,
      encoding: 'utf8',
    }).trim();
    const bound = ingest.assembleDataset().docsMap;
    assert.equal(bound.repository, 'acme/widgets', 'normalized remote identity');
    assert.equal(bound.commit, head, 'clean HEAD commit binds the wrapper');

    // Tracked dirt ELSEWHERE cannot change the committed map bytes: the dirty
    // probe is scoped to the docs-map file with tracked-only semantics (#2709
    // review — a host checkout perpetually carries scratch, which must not
    // permanently commit-suppress the wrapper).
    writeFileSync(join(docRoot, 'README.md'), '# Dirty\n');
    const scratchDirty = ingest.assembleDataset().docsMap;
    assert.equal(scratchDirty.repository, 'acme/widgets');
    assert.equal(
      scratchDirty.commit,
      head,
      'unrelated tracked dirt must not suppress the commit claim'
    );

    // Dirtying the docs-map file ITSELF is exactly what must suppress: the
    // working bytes no longer match any commit.
    writeFileSync(mapPath, `${JSON.stringify(declaration, null, 2)}\n`);
    const mapDirty = ingest.assembleDataset().docsMap;
    assert.equal(mapDirty.repository, 'acme/widgets');
    assert.equal(
      mapDirty.commit,
      null,
      'a dirty docs-map file suppresses the commit claim'
    );

    // (6) Absence is silent null.
    rmSync(mapPath);
    assert.equal(ingest.assembleDataset().docsMap, null, 'absent map is null');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(docRoot, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origDocRoot === undefined) delete process.env.CHD_DOC_GRAPH_ROOT;
    else process.env.CHD_DOC_GRAPH_ROOT = origDocRoot;
    if (origGitSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = origGitSha;
    if (origRepoEnv === undefined) delete process.env.CHD_DOCS_MAP_REPOSITORY;
    else process.env.CHD_DOCS_MAP_REPOSITORY = origRepoEnv;
  }
});
