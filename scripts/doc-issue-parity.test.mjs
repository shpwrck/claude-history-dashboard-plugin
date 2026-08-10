// Seam + byte-identical parity for the opt-in doc-issue snapshot (#2710, epic
// #2256) — the docs-map-parity sibling.
//
// The snapshot spans the browser-safe schema, the server fetch/cache, the ingest
// read + serialized-dataset carry, the server refresh preamble, and BASE compose.
// Two silent-death classes this fence guards against: (1) the serialized dataset
// carrying `docIssueSnapshot: null` (instead of OMITTING the key) when the flag
// is unset would break the byte-identical default-path guarantee; (2) dropping
// the server-preamble refresh registration would silently disable the producer
// while every unit test still passes. This fence fails CI instead.
//
// Run: node --import ./scripts/register-ts.mjs --test scripts/doc-issue-parity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-2710-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

// The byte-identical default-path guarantee: with the flag unset (and with a
// valid repo but NO credential), the serialized dataset must not carry the key
// at all — not even as null — and no network call is made (there is no fetch on
// the assembleDataset path; the cache read finds nothing).
for (const [label, env] of [
  ['flag unset', {}],
  ['valid repo, missing credential', { CHD_DOC_ISSUES: 'shpwrck/claude-history-dashboard' }],
  ['invalid repo', { CHD_DOC_ISSUES: 'not-a-slug', CHD_DOC_ISSUES_TOKEN: 'x' }],
]) {
  test(`serialized dataset OMITS docIssueSnapshot when disabled (${label})`, async () => {
    const orig = {
      HOME: process.env.HOME,
      CHD_DB_PATH: process.env.CHD_DB_PATH,
      CHD_DOC_ISSUES: process.env.CHD_DOC_ISSUES,
      CHD_DOC_ISSUES_TOKEN: process.env.CHD_DOC_ISSUES_TOKEN,
    };
    delete process.env.CHD_DOC_ISSUES;
    delete process.env.CHD_DOC_ISSUES_TOKEN;
    Object.assign(process.env, env);
    const home = join(tmpdir(), `chd-2710-home-${randomUUID()}`);
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    try {
      const ingest = await loadIngest(home);
      ingest.ingest();
      const dataset = ingest.assembleDataset();
      assert.ok(
        !('docIssueSnapshot' in dataset),
        'a disabled snapshot must be ABSENT from the serialized dataset, never null'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

test('ingest omits the serialized key rather than emitting null (source fence)', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'ingest.mjs'), 'utf8');
  assert.match(
    src,
    /\.\.\.\(docIssueSnapshot \? \{ docIssueSnapshot \} : \{\}\)/,
    'the serialized dataset must spread the key conditionally, never carry `docIssueSnapshot: null`'
  );
});

test('assembleDataset never fetches: the network refresh is preamble-only', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'ingest.mjs'), 'utf8');
  // readDocIssueSnapshot (the sync ingest read) must use the cache reader, and
  // the ONLY refresh call must be inside the server-preamble export.
  assert.match(
    src,
    /function readDocIssueSnapshot\(graph(?:,|\))/,
    'the synchronous cache reader must remain separate from the network refresh'
  );
  assert.match(src, /export async function refreshDocIssueSnapshotForServer\(\)/);
  const refreshCalls = src.match(/await refreshDocIssueSnapshot\(/g) ?? [];
  assert.equal(refreshCalls.length, 1, 'exactly one network refresh call, in the server-preamble export');
});

test('the server registers + invokes the preamble refresh (#2710)', () => {
  const server = readFileSync(join(ROOT, 'scripts', 'server.mjs'), 'utf8');
  assert.match(server, /refreshDocIssueSnapshotForServer/, 'server must import + register the refresh export');
  assert.match(
    server,
    /await refreshDocIssueSnapshotForIngest\(ingestApi\)/,
    'the request preamble must invoke the doc-issue refresh'
  );
});

test('BASE compose plumbs the opt-in flag + file-first credential, with no secret', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /CHD_DOC_ISSUES: \$\{CHD_DOC_ISSUES:-\}/);
  assert.match(compose, /CHD_DOC_ISSUES_TOKEN: \$\{CHD_DOC_ISSUES_TOKEN:-\}/);
  assert.match(compose, /CHD_DOC_ISSUES_TOKEN_FILE: \$\{CHD_DOC_ISSUES_TOKEN_FILE:-\}/);
});

test('disabled paths add no doc-issue cache gate and make zero external calls', async () => {
  const original = {
    HOME: process.env.HOME,
    CHD_DB_PATH: process.env.CHD_DB_PATH,
    CHD_CACHE_DIR: process.env.CHD_CACHE_DIR,
    CHD_DOC_GRAPH_ROOT: process.env.CHD_DOC_GRAPH_ROOT,
    CHD_DOC_ISSUES: process.env.CHD_DOC_ISSUES,
    CHD_DOC_ISSUES_TOKEN: process.env.CHD_DOC_ISSUES_TOKEN,
    CHD_DOC_ISSUES_TOKEN_FILE: process.env.CHD_DOC_ISSUES_TOKEN_FILE,
  };
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const home = join(tmpdir(), `chd-2710-parity-home-${randomUUID()}`);
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'cache');
  let fetchCalls = 0;
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Local docs only.\n');
    process.env.HOME = home;
    process.env.CHD_CACHE_DIR = cacheRoot;
    process.env.CHD_DOC_GRAPH_ROOT = docsRoot;
    delete process.env.CHD_DOC_ISSUES_TOKEN;
    delete process.env.CHD_DOC_ISSUES_TOKEN_FILE;
    Date.now = () => Date.parse('2026-07-20T12:00:00.000Z');
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('flag-off path attempted external I/O');
    };

    delete process.env.CHD_DOC_ISSUES;
    process.env.CHD_DB_PATH = join(home, 'flag-off.db');
    const flagOff = await import(`./ingest.mjs?flagOff=${randomUUID()}`);
    assert.equal(await flagOff.refreshDocIssueSnapshotForServer(), null);
    flagOff.ingest();
    const flagOffDataset = flagOff.assembleDataset();
    const flagOffSignature = flagOff.sourceSignature();
    assert.ok(!('docIssueSnapshot' in flagOffDataset));
    assert.doesNotMatch(
      flagOffSignature,
      /doc-issues:/,
      'flag-off must not add a source-signature part'
    );

    process.env.CHD_DOC_ISSUES = 'acme/widgets';
    // Reuse the same ingest DB so the comparison isolates only the opt-in env
    // state (not independent SQLite cache warm-up/order effects).
    process.env.CHD_DB_PATH = join(home, 'flag-off.db');
    const missingToken = await import(`./ingest.mjs?missingToken=${randomUUID()}`);
    assert.equal(await missingToken.refreshDocIssueSnapshotForServer(), null);
    missingToken.ingest();
    const missingDataset = missingToken.assembleDataset();

    assert.equal(fetchCalls, 0, 'neither disabled path may call GitHub');
    assert.equal(missingToken.sourceSignature(), flagOffSignature);
    assert.ok(!('docIssueSnapshot' in missingDataset));
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a supplied v29 dataset keeps omitted snapshot state authoritative after the cache appears', async () => {
  const original = {
    HOME: process.env.HOME,
    CHD_DB_PATH: process.env.CHD_DB_PATH,
    CHD_CACHE_DIR: process.env.CHD_CACHE_DIR,
    CHD_DOC_GRAPH_ROOT: process.env.CHD_DOC_GRAPH_ROOT,
    CHD_DOC_ISSUES: process.env.CHD_DOC_ISSUES,
    CHD_DOC_ISSUES_TOKEN: process.env.CHD_DOC_ISSUES_TOKEN,
  };
  const originalNow = Date.now;
  const home = join(tmpdir(), `chd-2710-authority-home-${randomUUID()}`);
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'cache');
  const repo = 'acme/widgets';
  const now = Date.parse('2026-07-20T12:00:00.000Z');
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Tracked by #101.\n');
    process.env.HOME = home;
    process.env.CHD_DB_PATH = join(home, 'dashboard.db');
    process.env.CHD_CACHE_DIR = cacheRoot;
    process.env.CHD_DOC_GRAPH_ROOT = docsRoot;
    process.env.CHD_DOC_ISSUES = repo;
    process.env.CHD_DOC_ISSUES_TOKEN = 'fixture-token';
    Date.now = () => now;
    const ingest = await import(`./ingest.mjs?authority=${randomUUID()}`);
    ingest.ingest();
    const beforeCache = ingest.assembleRecommendationDataset();
    assert.ok(!('docIssueSnapshot' in beforeCache));

    const refs = [101];
    const snapshot = {
      repo,
      refs,
      records: [{ number: 101, state: 'open' }],
      asOf: new Date(now).toISOString(),
      complete: true,
      fingerprint: createHash('sha256')
        .update(`${repo}\n${refs.join(',')}`)
        .digest('hex'),
    };
    mkdirSync(join(cacheRoot, 'doc-issues'), { recursive: true });
    writeFileSync(
      join(cacheRoot, 'doc-issues', 'acme__widgets.json'),
      JSON.stringify(snapshot)
    );
    assert.ok(
      ingest.docIssueSnapshotCacheStateForServer(),
      'the live cache now contains a usable snapshot'
    );

    const result = ingest.assembleScopedRecommendationResult(
      'global',
      { dashboardTime: 'all', dashboardProject: 'All projects' },
      { dataset: beforeCache, now }
    );
    assert.ok(
      !('validThrough' in result),
      'recommendation assembly must not inject the newer live cache into the supplied dataset'
    );
  } finally {
    Date.now = originalNow;
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('memoized issue refs invalidate immediately when the doc-graph source changes', async () => {
  const original = {
    HOME: process.env.HOME,
    CHD_DB_PATH: process.env.CHD_DB_PATH,
    CHD_CACHE_DIR: process.env.CHD_CACHE_DIR,
    CHD_DOC_GRAPH_ROOT: process.env.CHD_DOC_GRAPH_ROOT,
    CHD_DOC_ISSUES: process.env.CHD_DOC_ISSUES,
    CHD_DOC_ISSUES_TOKEN: process.env.CHD_DOC_ISSUES_TOKEN,
  };
  const originalNow = Date.now;
  const home = join(tmpdir(), `chd-2710-ref-change-home-${randomUUID()}`);
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'cache');
  const repo = 'acme/widgets';
  const now = Date.parse('2026-07-20T12:00:00.000Z');
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(join(cacheRoot, 'doc-issues'), { recursive: true });
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Tracked by #101.\n');
    const refs = [101];
    writeFileSync(
      join(cacheRoot, 'doc-issues', 'acme__widgets.json'),
      JSON.stringify({
        repo,
        refs,
        records: [{ number: 101, state: 'open' }],
        asOf: new Date(now).toISOString(),
        complete: true,
        fingerprint: createHash('sha256')
          .update(`${repo}\n${refs.join(',')}`)
          .digest('hex'),
      })
    );
    process.env.HOME = home;
    process.env.CHD_DB_PATH = join(home, 'dashboard.db');
    process.env.CHD_CACHE_DIR = cacheRoot;
    process.env.CHD_DOC_GRAPH_ROOT = docsRoot;
    process.env.CHD_DOC_ISSUES = repo;
    process.env.CHD_DOC_ISSUES_TOKEN = 'fixture-token';
    Date.now = () => now;
    const ingest = await import(`./ingest.mjs?refChange=${randomUUID()}`);

    assert.ok(ingest.docIssueSnapshotCacheStateForServer());
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Tracked by #202.\n');
    assert.equal(
      ingest.docIssueSnapshotCacheStateForServer(),
      null,
      'the #101 snapshot must not remain current after the graph moves to #202'
    );
  } finally {
    Date.now = originalNow;
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('sourceSignature and contentHash flip at +1ms past the unchanged snapshot boundary', async () => {
  const original = {
    HOME: process.env.HOME,
    CHD_DB_PATH: process.env.CHD_DB_PATH,
    CHD_CACHE_DIR: process.env.CHD_CACHE_DIR,
    CHD_DOC_GRAPH_ROOT: process.env.CHD_DOC_GRAPH_ROOT,
    CHD_DOC_ISSUES: process.env.CHD_DOC_ISSUES,
    CHD_DOC_ISSUES_TOKEN: process.env.CHD_DOC_ISSUES_TOKEN,
  };
  const originalNow = Date.now;
  const home = join(tmpdir(), `chd-2710-expiry-home-${randomUUID()}`);
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'cache');
  const repo = 'acme/widgets';
  const refs = [101];
  const boundary = Date.parse('2026-07-20T12:00:00.000Z');
  const asOf = new Date(boundary - 24 * 60 * 60 * 1000).toISOString();
  const snapshot = {
    repo,
    refs,
    records: [{ number: 101, state: 'open' }],
    asOf,
    complete: true,
    fingerprint: createHash('sha256')
      .update(`${repo}\n${refs.join(',')}`)
      .digest('hex'),
  };
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(join(cacheRoot, 'doc-issues'), { recursive: true });
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Tracked by #101.\n');
    writeFileSync(
      join(cacheRoot, 'doc-issues', 'acme__widgets.json'),
      JSON.stringify(snapshot)
    );
    process.env.HOME = home;
    process.env.CHD_DB_PATH = join(home, 'dashboard.db');
    process.env.CHD_CACHE_DIR = cacheRoot;
    process.env.CHD_DOC_GRAPH_ROOT = docsRoot;
    process.env.CHD_DOC_ISSUES = repo;
    process.env.CHD_DOC_ISSUES_TOKEN = 'fixture-token';
    Date.now = () => boundary;
    const ingest = await import(`./ingest.mjs?expiry=${randomUUID()}`);

    const exactSignature = ingest.sourceSignature();
    const exactHash = ingest.ingest().contentHash;
    assert.ok(
      ingest.docIssueSnapshotCacheStateForServer(),
      'the exact 24-hour boundary remains usable'
    );
    assert.ok(
      'docIssueSnapshot' in ingest.assembleDataset(),
      'the exact boundary still carries the complete snapshot'
    );
    const exactRecommendationDataset = ingest.assembleRecommendationDataset();
    assert.equal(
      ingest.assembleScopedRecommendationResult(
        'global',
        { dashboardTime: 'all', dashboardProject: 'All projects' },
        { dataset: exactRecommendationDataset, now: boundary }
      ).validThrough,
      new Date(boundary).toISOString(),
      'typed recommendation envelopes carry the inclusive snapshot boundary'
    );

    Date.now = () => boundary + 1;
    assert.equal(
      ingest.docIssueSnapshotCacheStateForServer(),
      null,
      'boundary +1ms is unusable without rewriting the cache file'
    );
    assert.notEqual(ingest.sourceSignature(), exactSignature);
    assert.notEqual(ingest.ingest().contentHash, exactHash);
    assert.ok(
      !('docIssueSnapshot' in ingest.assembleDataset()),
      'expired state is removed from a fresh dataset'
    );
    assert.ok(
      !(
        'validThrough' in
        ingest.assembleScopedRecommendationResult(
          'global',
          { dashboardTime: 'all', dashboardProject: 'All projects' },
          { dataset: ingest.assembleRecommendationDataset(), now: boundary + 1 }
        )
      ),
      'typed envelopes omit expiry metadata when no usable snapshot was analyzed'
    );
  } finally {
    Date.now = originalNow;
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
