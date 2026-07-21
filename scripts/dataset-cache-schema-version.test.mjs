// Regression coverage for persisted dataset cache invalidation (#1543).
//
// The dataset_cache table stores compressed `/api/dataset.json` bodies across
// deploys. If assembleDataset() changes shape while source artifacts do not,
// a source-only content hash can reuse JSON built by older code. The exported
// schema key must therefore feed both the cheap source signature and the
// contentHash gate returned by ingest().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-1543-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

test('dataset assembly schema key feeds sourceSignature and ingest content hash (#1543)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origDocIssues = process.env.CHD_DOC_ISSUES;
  const origDocIssuesToken = process.env.CHD_DOC_ISSUES_TOKEN;
  const origDocIssuesTokenFile = process.env.CHD_DOC_ISSUES_TOKEN_FILE;
  const home = join(tmpdir(), `chd-1543-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    delete process.env.CHD_DOC_ISSUES;
    delete process.env.CHD_DOC_ISSUES_TOKEN;
    delete process.env.CHD_DOC_ISSUES_TOKEN_FILE;
    const ingest = await loadIngest(home);
    assert.equal(typeof ingest.DATASET_ASSEMBLY_SCHEMA_VERSION, 'number');
    assert.equal(
      ingest.DATASET_ASSEMBLY_SCHEMA_VERSION,
      29,
      'enabled docIssueSnapshot datasets (#2710) use the next schema version'
    );

    const key = ingest.datasetAssemblySchemaKey();
    // The key folds in BOTH the dataset-assembly schema version AND the per-session
    // PARSER_SIG_VERSION (#2036 follow-up): the parser output is assembled into the
    // dataset, so a parser bump must invalidate the persisted dataset_cache too.
    // Before this, the two gates were decoupled and a parser bump served stale JSON.
    assert.equal(typeof ingest.PARSER_SIG_VERSION, 'string');
    assert.equal(
      key,
      `dataset-schema:v${ingest.FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION}:parser-${ingest.PARSER_SIG_VERSION}`,
      'flag-off retains the exact pre-feature v28 cache key'
    );
    // The immediately-preceding v27 key needs no dedicated notEqual: the exact
    // equal(28) assertion above already excludes every other version (#2709
    // review item; avoids accumulating one dead assertion per bump).
    assert.notEqual(
      key,
      `dataset-schema:v26:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-edit-format-churn (#2507) dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v25:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-provenance (#2707) dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v24:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-plural-mutation dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v23:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-command-analysis-complete dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v22:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-leave-behind-mutation dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v21:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-doc-graph dataset cache key must not remain current'
    );
    assert.notEqual(
      key,
      `dataset-schema:v20:parser-${ingest.PARSER_SIG_VERSION}`,
      'the pre-leave-behind/durable-command dataset cache key must not remain current'
    );
    assert.match(
      ingest.sourceSignature(),
      new RegExp(`(^|\\\\|)${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\\\||$)`)
    );

    const flagOffSourceSignature = ingest.sourceSignature();
    const flagOffContentHash = ingest.ingest().contentHash;
    process.env.CHD_DOC_ISSUES = 'not-a-repo';
    process.env.CHD_DOC_ISSUES_TOKEN_FILE = join(home, 'must-not-be-read');
    assert.equal(
      ingest.sourceSignature(),
      flagOffSourceSignature,
      'an invalid/disabled flag leaves the pre-feature source signature byte-identical'
    );
    assert.equal(
      ingest.ingest().contentHash,
      flagOffContentHash,
      'an invalid/disabled flag leaves the pre-feature content hash byte-identical'
    );

    process.env.CHD_DOC_ISSUES = 'acme/widgets';
    process.env.CHD_DOC_ISSUES_TOKEN = 'fixture-token';
    delete process.env.CHD_DOC_ISSUES_TOKEN_FILE;
    const enabledKey = ingest.datasetAssemblySchemaKey();
    assert.equal(
      enabledKey,
      `dataset-schema:v${ingest.DATASET_ASSEMBLY_SCHEMA_VERSION}:parser-${ingest.PARSER_SIG_VERSION}`,
      'an enabled snapshot turns over persisted v28 datasets'
    );
    assert.notEqual(ingest.sourceSignature(), flagOffSourceSignature);
    assert.notEqual(ingest.ingest().contentHash, flagOffContentHash);

    delete process.env.CHD_DOC_ISSUES;
    delete process.env.CHD_DOC_ISSUES_TOKEN;
    assert.equal(ingest.sourceSignature(), flagOffSourceSignature);
    assert.equal(ingest.ingest().contentHash, flagOffContentHash);

    const src = readFileSync(join(HERE, 'ingest.mjs'), 'utf8');
    assert.match(
      src,
      /hash\.update\(datasetAssemblySchemaKey\(\)\)/,
      'ingest() contentHash must include the dataset schema key'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origDocIssues === undefined) delete process.env.CHD_DOC_ISSUES;
    else process.env.CHD_DOC_ISSUES = origDocIssues;
    if (origDocIssuesToken === undefined) delete process.env.CHD_DOC_ISSUES_TOKEN;
    else process.env.CHD_DOC_ISSUES_TOKEN = origDocIssuesToken;
    if (origDocIssuesTokenFile === undefined) delete process.env.CHD_DOC_ISSUES_TOKEN_FILE;
    else process.env.CHD_DOC_ISSUES_TOKEN_FILE = origDocIssuesTokenFile;
  }
});

test('loadLatestDatasetCache fences on the schema key: a NEWER row from another schema is skipped (#1577)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-1577-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    const ingest = await loadIngest(home);
    const dbPath = process.env.CHD_DB_PATH;
    const body = '{"ok":true}';
    const gzBuf = gzipSync(body);
    const brBuf = brotliCompressSync(body);

    // A row built under the CURRENT schema, persisted through the real path.
    ingest.saveDatasetCache(
      { contentHash: 'cur-hash', etag: '"cur"', brBuf, gzBuf },
      1_000
    );
    const current = ingest.loadLatestDatasetCache();
    assert.ok(current, 'a current-schema row must be a cache hit');
    assert.equal(current.contentHash, 'cur-hash');
    assert.equal(current.json, body, 'round-trips the gunzipped body');
    assert.equal(
      current.docIssueCacheStateKnown,
      true,
      'new flag-off rows persist an explicit known-null snapshot state'
    );
    assert.equal(current.docIssueCacheState, null);

    // A row built under a DIFFERENT (older) schema, with a NEWER created_at —
    // exactly the persisted-volume-across-a-schema-bump case. Inserted directly
    // (a second connection sees ingest's committed schema; DatabaseSync
    // auto-commits each statement) so it carries a stale schema_key.
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        'INSERT INTO dataset_cache (content_hash, etag, json_br, json_gz, created_at, schema_key) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('stale-hash', '"stale"', brBuf, gzBuf, 9_000, 'dataset-schema:v0:parser-v0');
    raw.close();

    // Despite being the NEWEST row by created_at, the stale-schema row must NOT
    // be served — loadLatestDatasetCache returns the current-schema row.
    const latest = ingest.loadLatestDatasetCache();
    assert.ok(latest, 'still a hit for the current schema');
    assert.equal(
      latest.contentHash,
      'cur-hash',
      'the newer stale-schema row leaked through the fence'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('persisted dataset rows round-trip exact doc-issue identity and expiry metadata', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2710-state-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  try {
    const ingest = await loadIngest(home);
    const body = '{"docIssueSnapshot":{"complete":true}}';
    const state = {
      identity: '{"repo":"acme/widgets","refs":[101]}',
      usableThrough: Date.parse('2026-07-21T12:00:00.000Z'),
    };
    ingest.saveDatasetCache(
      {
        contentHash: 'doc-state-hash',
        etag: '"doc-state"',
        brBuf: brotliCompressSync(body),
        gzBuf: gzipSync(body),
        docIssueCacheState: state,
      },
      2_000
    );

    const loaded = ingest.loadDatasetCache('doc-state-hash');
    assert.ok(loaded);
    assert.equal(loaded.docIssueCacheStateKnown, true);
    assert.deepEqual(loaded.docIssueCacheState, state);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('loadLatestDatasetCache returns null when only a foreign-schema row exists (#1577)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-1577b-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    const ingest = await loadIngest(home);
    const dbPath = process.env.CHD_DB_PATH;
    const body = '{"stale":true}';
    // Only a stale-schema row exists (the cross-deploy cold-start window).
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        'INSERT INTO dataset_cache (content_hash, etag, json_br, json_gz, created_at, schema_key) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('stale-only', '"s"', brotliCompressSync(body), gzipSync(body), 5_000, 'dataset-schema:v0:parser-v0');
    raw.close();

    assert.equal(
      ingest.loadLatestDatasetCache(),
      null,
      'a foreign-schema-only cache must miss cleanly so the server rebuilds'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('v9 session-blob semantics reject a persisted dataset assembled from v8 rows (#2246)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2246-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    const ingest = await loadIngest(home);
    const dbPath = process.env.CHD_DB_PATH;
    // Before #2246 both the base and PR head used this exact dataset key, even
    // after SESSION_BLOB_OUTPUT moved v8 -> v9. A restart could therefore serve
    // this v8-derived body while the signal rows reparsed in the background.
    const oldV8DatasetKey = `dataset-schema:v10:parser-${ingest.PARSER_SIG_VERSION}`;
    assert.notEqual(
      ingest.datasetAssemblySchemaKey(),
      oldV8DatasetKey,
      'the dataset cache key must turn over with the v9 timeline semantics'
    );

    const body = '{"timelineSessionBlobVersion":"timeline-backgroundable-kind-v8"}';
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        'INSERT INTO dataset_cache (content_hash, etag, json_br, json_gz, created_at, schema_key) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'v8-dataset',
        '"v8"',
        brotliCompressSync(body),
        gzipSync(body),
        5_000,
        oldV8DatasetKey
      );
    raw.close();

    assert.equal(
      ingest.loadLatestDatasetCache(),
      null,
      'a v8-derived dataset body must miss so the server rebuilds from v9 rows'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('hook-target existence transition moves sourceSignature with settings untouched (#2539)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-2539-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node ~/.claude/hooks/probe-2539.mjs' }] },
        ],
      },
    })
  );

  try {
    const ingest = await loadIngest(home);
    const target = join(home, '.claude', 'hooks', 'probe-2539.mjs');

    const absent = ingest.sourceSignature();
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    writeFileSync(target, '// hook\n');
    assert.notEqual(
      ingest.sourceSignature(),
      absent,
      'creating the referenced hook script (settings untouched) must move the cheap stat-gate'
    );

    rmSync(target);
    assert.equal(
      ingest.sourceSignature(),
      absent,
      'removing it again must restore the signature exactly (values-free: state only)'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('ingest() contentHash folds the hook-targets probed-state signature (#2539)', () => {
  const src = readFileSync(join(HERE, 'ingest.mjs'), 'utf8');
  assert.match(
    src,
    /hash\.update\('hook-targets\\n'\)/,
    'ingest() contentHash must label the hook-targets section'
  );
  assert.match(
    src,
    /hash\.update\(hookTargetsSignature\(\)\)/,
    'ingest() contentHash must include the hook-targets probed-state signature'
  );
  assert.match(
    src,
    /parts\.push\(`hook-targets:\$\{hookTargetsSignature\(\)\}`\)/,
    'sourceSignature() must include the hook-targets probed-state signature'
  );
});
