// Regression coverage for persisted dataset cache invalidation (#1543).
//
// The dataset_cache table stores compressed `/api/dataset.json` bodies across
// deploys. If assembleDataset() changes shape while source artifacts do not,
// a source-only content hash can reuse JSON built by older code. The exported
// schema key must therefore feed both the cheap source signature and the
// contentHash gate returned by ingest().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
      35,
      'enabled datasets reject legacy transient doc-history fallbacks (#3711)'
    );
    // Pin the FLAG-OFF (local-first default) schema version as a LITERAL so a
    // regression that lowers it — e.g. back to v28 — fails here (#2955). The
    // key-equality assertion below rebuilds its expected string FROM this same
    // constant, so it is self-referential and cannot catch such a regression on
    // its own. Bump this literal (and the note) deliberately when FLAG_OFF advances.
    assert.equal(typeof ingest.FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION, 'number');
    assert.equal(
      ingest.FLAG_OFF_DATASET_ASSEMBLY_SCHEMA_VERSION,
      34,
      'flag-off advances to a fresh v34 key to reject transient doc-history fallbacks (#3711)'
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
      'flag-off uses the exact v34 cache key for transient doc-history cache admission'
    );
    assert.notEqual(
      key,
      `dataset-schema:v33:parser-${ingest.PARSER_SIG_VERSION}`,
      'flag-off must not alias the historical enabled v33 cache key'
    );
    // The immediately-preceding flag-off v32 key needs no dedicated notEqual:
    // the literal equal(FLAG_OFF, 34) pin above fixes the version exactly, so
    // any regression (v32 included) fails there (#2709 review item; avoids
    // accumulating one dead assertion per ordinary bump).
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
      'an enabled snapshot turns over persisted v32 flag-off datasets'
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
      {
        contentHash: 'cur-hash',
        etag: '"cur"',
        brBuf,
        gzBuf,
        recursiveRemovalSafetyState:
          ingest.recursiveRemovalSafetyStateForServer(),
      },
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
    assert.equal(current.recursiveRemovalSafetyStateKnown, true);
    assert.equal(
      current.recursiveRemovalSafetyState,
      ingest.recursiveRemovalSafetyStateForServer()
    );

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

test('flag-off cache fencing rejects the historical enabled v33 key (#3711)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origDocIssues = process.env.CHD_DOC_ISSUES;
  const home = join(tmpdir(), `chd-3711-schema-home-${randomUUID()}`);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });

  try {
    delete process.env.CHD_DOC_ISSUES;
    const ingest = await loadIngest(home);
    const body = '{"legacyTransientDocGraph":true}';
    const raw = new DatabaseSync(process.env.CHD_DB_PATH);
    raw
      .prepare(
        'INSERT INTO dataset_cache (content_hash, etag, json_br, json_gz, created_at, schema_key, doc_issue_state, recursive_removal_safety_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'legacy-v33',
        '"legacy-v33"',
        brotliCompressSync(body),
        gzipSync(body),
        9_000,
        `dataset-schema:v33:parser-${ingest.PARSER_SIG_VERSION}`,
        'null',
        ingest.recursiveRemovalSafetyStateForServer()
      );
    raw.close();

    assert.equal(
      ingest.loadLatestDatasetCache(),
      null,
      'disabling document issues must not reinterpret an old enabled v33 row as current flag-off data'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origDocIssues === undefined) delete process.env.CHD_DOC_ISSUES;
    else process.env.CHD_DOC_ISSUES = origDocIssues;
  }
});

test('the real dataset cache never persists a transient doc-history fallback and recovers unchanged (#3711)', { timeout: 60_000 }, async () => {
  const testRoot = join(tmpdir(), `chd-3711-server-${randomUUID()}`);
  const claudeDir = join(testRoot, '.claude');
  const distDir = join(testRoot, 'dist');
  const cacheDir = join(testRoot, 'cache');
  const gitRoot = join(testRoot, 'repo');
  const fakeBin = join(testRoot, 'bin');
  const failFlag = join(testRoot, 'fail-git-log');
  const callsPath = join(testRoot, 'git-calls');
  const dbPath = join(cacheDir, 'dashboard.db');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  let proc;

  try {
    mkdirSync(join(claudeDir, 'projects'), { recursive: true });
    mkdirSync(distDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(join(gitRoot, 'docs'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(claudeDir, 'history.jsonl'), '');
    writeFileSync(join(testRoot, '.claude.json'), JSON.stringify({ projects: {} }));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
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
    writeFileSync(failFlag, 'fail\n');

    const port = await new Promise((resolve, reject) => {
      const probe = createNetServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(address.port));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    proc = spawn('node', ['--import', './scripts/register-ts.mjs', 'scripts/server.mjs'], {
      cwd: join(HERE, '..'),
      env: {
        ...process.env,
        HOME: testRoot,
        PORT: String(port),
        HOST: '127.0.0.1',
        CLAUDE_DIR: claudeDir,
        CLAUDE_HOME_DIR: testRoot,
        DIST_DIR: distDir,
        CHD_DB_PATH: dbPath,
        CHD_CACHE_DIR: cacheDir,
        CHD_DOC_GRAPH_ROOT: gitRoot,
        CHD_TEST_REAL_GIT: realGit,
        CHD_TEST_GIT_FAIL: failFlag,
        CHD_TEST_GIT_CALLS: callsPath,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        CHD_RECS_WORKER: '0',
        CHD_DOC_ISSUES: '',
        DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
        DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
        DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (proc.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/healthz`);
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `fixture server failed to start: ${stderr}`);

    const firstRepoMapResponse = await fetch(
      `${base}/api/dataset/slice/repoMap`
    );
    assert.equal(firstRepoMapResponse.status, 200);
    await firstRepoMapResponse.arrayBuffer();
    const callsAfterFirstRepoMap = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n').length;
    const secondRepoMapResponse = await fetch(
      `${base}/api/dataset/slice/repoMap`
    );
    assert.equal(secondRepoMapResponse.status, 200);
    await secondRepoMapResponse.arrayBuffer();
    const callsAfterSecondRepoMap = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n').length;
    assert.ok(
      callsAfterSecondRepoMap > callsAfterFirstRepoMap,
      'repoMap recommendations derived from a transient graph must not become a split-cache hit'
    );

    const firstResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.ok(first.docGraph.nodes.length > 0);
    assert.ok(
      first.docGraph.nodes.every((node) => node.gitMtimeProvenance !== 'git'),
      'the failed walk serves its conservative fallback to a cold caller'
    );
    let raw = new DatabaseSync(dbPath);
    assert.equal(
      raw.prepare('SELECT COUNT(*) AS count FROM dataset_cache').get().count,
      0,
      'the transient fallback must not enter the persisted dataset cache'
    );
    raw.close();

    const callsBeforeRecovery = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    rmSync(failFlag, { force: true });
    const recoveredResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json();
    assert.ok(
      recovered.docGraph.nodes.every((node) => node.gitMtimeProvenance === 'git'),
      'the next unchanged request retries and restores live Git provenance'
    );
    const callsAfterRecovery = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    assert.ok(callsAfterRecovery > callsBeforeRecovery);
    raw = new DatabaseSync(dbPath);
    assert.equal(
      raw.prepare('SELECT COUNT(*) AS count FROM dataset_cache').get().count,
      1,
      'only the recovered healthy candidate is persisted'
    );
    raw.close();

    const warmResponse = await fetch(`${base}/api/dataset.json`);
    assert.equal(warmResponse.status, 200);
    assert.equal(warmResponse.headers.get('x-ingest'), 'skipped=true;cached=true');
    assert.equal(
      readFileSync(callsPath, 'utf8').trim().split('\n').length,
      callsAfterRecovery,
      'the admitted healthy candidate resumes the ordinary warm cache hit'
    );
  } finally {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    rmSync(testRoot, { recursive: true, force: true });
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
        recursiveRemovalSafetyState:
          ingest.recursiveRemovalSafetyStateForServer(),
      },
      2_000
    );

    const loaded = ingest.loadDatasetCache('doc-state-hash');
    assert.ok(loaded);
    assert.equal(loaded.docIssueCacheStateKnown, true);
    assert.deepEqual(loaded.docIssueCacheState, state);
    assert.equal(loaded.recursiveRemovalSafetyStateKnown, true);
    assert.equal(
      loaded.recursiveRemovalSafetyState,
      ingest.recursiveRemovalSafetyStateForServer()
    );
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

test('skill and plugin containment transitions move both dataset cache gates (#3377)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-3377-home-${randomUUID()}`);
  const claudeDir = join(home, '.claude');
  const pluginsCache = join(claudeDir, 'plugins', 'cache');
  const pluginComponent = join(pluginsCache, 'marketplace', 'demo');
  const installPath = join(pluginComponent, '1.0.0');
  const outsideComponent = join(home, 'outside', 'demo');
  const skillsRoot = join(claudeDir, 'skills');
  const skillPath = join(skillsRoot, 'risky-skill');
  const outsideSkill = join(home, 'outside', 'risky-skill');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(installPath, { recursive: true });
  mkdirSync(join(outsideComponent, '1.0.0'), { recursive: true });
  mkdirSync(skillPath, { recursive: true });
  mkdirSync(outsideSkill, { recursive: true });
  writeFileSync(
    join(skillPath, 'SKILL.md'),
    '---\ndescription: risky skill\n---\n'
  );
  writeFileSync(
    join(outsideSkill, 'SKILL.md'),
    '---\ndescription: escaped risky skill\n---\n'
  );
  writeFileSync(
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        demo: [{ scope: 'user', version: '1.0.0', installPath }],
      },
    })
  );

  try {
    const ingest = await loadIngest(home);
    const containedState = ingest.recursiveRemovalSafetyStateForServer();
    const containedSourceSignature = ingest.sourceSignature();
    const containedContentHash = ingest.ingest().contentHash;
    const skillsRootStat = statSync(skillsRoot);

    rmSync(skillPath, { recursive: true, force: true });
    symlinkSync(outsideSkill, skillPath, 'dir');
    utimesSync(
      skillsRoot,
      skillsRootStat.atimeMs / 1_000,
      (Math.floor(skillsRootStat.mtimeMs) + 0.5) / 1_000
    );
    assert.equal(
      Math.floor(statSync(skillsRoot).mtimeMs),
      Math.floor(skillsRootStat.mtimeMs),
      'the skill transition must not rely on the skills-root mtime moving'
    );
    const escapedSkillState = ingest.recursiveRemovalSafetyStateForServer();
    const escapedSkillSourceSignature = ingest.sourceSignature();
    const escapedSkillContentHash = ingest.ingest().contentHash;
    assert.notEqual(
      escapedSkillState,
      containedState,
      'the bounded skill realpath probes must observe the containment transition'
    );
    assert.notEqual(
      escapedSkillSourceSignature,
      containedSourceSignature,
      'the request-time stat gate must not skip the changed skill verdict'
    );
    assert.notEqual(
      escapedSkillContentHash,
      containedContentHash,
      'the persisted content gate must bind the changed skill verdict'
    );

    const rootMtime = statSync(pluginsCache).mtimeMs;

    rmSync(pluginComponent, { recursive: true, force: true });
    symlinkSync(outsideComponent, pluginComponent, 'dir');
    assert.equal(
      statSync(pluginsCache).mtimeMs,
      rootMtime,
      'the nested replacement must not rely on the plugin-cache root mtime moving'
    );
    assert.notEqual(
      ingest.recursiveRemovalSafetyStateForServer(),
      escapedSkillState,
      'the bounded plugin realpath probes must observe the containment transition'
    );
    assert.notEqual(
      ingest.sourceSignature(),
      escapedSkillSourceSignature,
      'the request-time stat gate must not skip the changed plugin verdict'
    );
    assert.notEqual(
      ingest.ingest().contentHash,
      escapedSkillContentHash,
      'the persisted content gate and assembled memo must bind the plugin verdict'
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
