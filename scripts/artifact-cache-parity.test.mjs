// Data-integrity + zero-reparse harness for the #624 artifact-ingest caching
// seam. Run under the ts-resolver loader (the .ts parsers must resolve), and
// with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/artifact-cache-parity.test.mjs
//
// What it proves (the two issue acceptance criteria for correctness):
//   (1) ZERO artifact reparse on a warm cache. A second assembleDataset() over
//       an UNCHANGED artifact corpus runs the parsers ZERO times — asserted via
//       the _getArtifactParseCount() instrumentation seam (a parse only happens
//       on a cache MISS). A non-zero first count proves the parsers actually ran
//       (the test isn't vacuously hitting empty dirs).
//   (2) BYTE-IDENTICAL dataset. The artifact-derived fields of assembleDataset()
//       serialize identically across the cold (parse) and warm (cache HIT) calls
//       — and identically to a fresh from-scratch assemble with a brand-new DB
//       (the no-cache baseline). Since the server serializes the dataset with a
//       single JSON.stringify, equality of JSON.stringify over these fields IS
//       the byte-identity the cache must preserve.
//   (3) INVALIDATION. Mutating a file in one artifact dir makes ONLY that dir
//       reparse on the next call (its signature changed); the rest stay cached.
//
// The fixture builds a throwaway $HOME/.claude with non-empty artifact dirs so
// every cached parser produces real output. CHD_DB_PATH points ingest at a
// throwaway SQLite DB, and HOME points it at the fixture — both env vars are
// read at ingest module-load, so they MUST be set before the dynamic import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixture: a throwaway ~/.claude with non-empty #539 artifact dirs.
// ---------------------------------------------------------------------------
function buildFixtureHome() {
  const home = join(tmpdir(), `chd-624-home-${randomUUID()}`);
  const claude = join(home, '.claude');
  const mk = (...p) => {
    const dir = join(claude, ...p);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const wf = (rel, content) => {
    const abs = join(claude, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };

  // tasks/<sessionId>/<n>.json
  mk('tasks', 'sess-a');
  wf('tasks/sess-a/1.json', JSON.stringify({ id: 't1', content: 'do thing', status: 'completed' }));
  wf('tasks/sess-a/2.json', JSON.stringify({ id: 't2', content: 'next thing', status: 'pending' }));

  // teams/<teamId>/inboxes/<agent>.json (array of messages; text is JSON payload)
  mk('teams', 'team-x', 'inboxes');
  wf(
    'teams/team-x/inboxes/agent-1.json',
    JSON.stringify([
      {
        from: 'lead',
        timestamp: '2026-01-01T00:00:00.000Z',
        read: false,
        text: JSON.stringify({
          type: 'task_assignment',
          taskId: 'task-1',
          subject: 'investigate',
        }),
      },
    ])
  );

  // sessions/<pid>.json (live process registry)
  mk('sessions');
  wf('sessions/1234.json', JSON.stringify({ pid: 1234, cwd: '/tmp/proj', startTime: 1700000000000 }));

  // telemetry/1p_failed_events*.json (NDJSON)
  mk('telemetry');
  wf(
    'telemetry/1p_failed_events_1.json',
    [
      JSON.stringify({
        event_data: {
          event_name: 'tengu_api_error',
          client_timestamp: '2026-01-01T00:00:00Z',
          model: 'claude',
          session_id: 'sess-a',
        },
      }),
    ].join('\n') + '\n'
  );

  // debug/*.txt
  mk('debug');
  wf('debug/2026-01-01.txt', '[ERROR] something failed\n[INFO] recovered\n');

  // file-history/<sessionDir>/<name>@v2 (only names + mtimes are read)
  mk('file-history', 'fh-sess');
  wf('file-history/fh-sess/src_app.ts@v2', 'snapshot-body-ignored');

  // plans/*.md
  mk('plans');
  wf('plans/plan-1.md', '# Plan\n\n- step one\n- step two\n');

  // backups/.claude.json.backup.<ts> (full ~/.claude.json dumps; >=2 to diff)
  mk('backups');
  wf(
    'backups/.claude.json.backup.1700000000000',
    JSON.stringify({ mcpServers: { a: {} }, projects: {} })
  );
  wf(
    'backups/.claude.json.backup.1700000100000',
    JSON.stringify({ mcpServers: { a: {}, b: {} }, projects: {} })
  );

  return { home, claude };
}

// Fields of assembleDataset() that are sourced from the #624-cached artifacts.
const ARTIFACT_KEYS = [
  'tasks',
  'teams',
  'sessionRegistry',
  'telemetry',
  'debugLogs',
  'statsCache',
  'fileHistory',
  'plans',
  'updateResults',
  'mcpAuth',
  'configBackups',
];

function artifactSlice(dataset) {
  const out = {};
  for (const k of ARTIFACT_KEYS) out[k] = dataset[k];
  return out;
}

// Import ingest fresh with HOME + CHD_DB_PATH pointed at fixtures. Both are read
// at module load, so set them BEFORE the import. A cache-buster query keeps each
// import a distinct module instance (fresh module state + fresh DB binding).
async function loadIngest({ home, dbPath }) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = dbPath;
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

function newDbPath() {
  return join(tmpdir(), `chd-624-db-${randomUUID()}.db`);
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// (1) + (2): zero reparse on warm cache AND byte-identical artifact output.
// ---------------------------------------------------------------------------
test('(1)(2) warm cache: second assemble does ZERO artifact reparses and is byte-identical', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });

    // Cold call: cache empty -> every present artifact is parsed at least once.
    ingest._resetArtifactParseCount();
    const cold = artifactSlice(ingest.assembleDataset());
    const coldParses = ingest._getArtifactParseCount();
    assert.ok(
      coldParses > 0,
      `cold assemble must actually parse artifacts (got ${coldParses}); ` +
        'a zero here means the fixture dirs were empty and the test is vacuous'
    );

    // Sanity: the parsers produced real, non-empty output (so parity is meaningful).
    assert.ok(cold.tasks.length > 0, 'tasks parsed non-empty');
    assert.ok(cold.teams.length > 0, 'teams parsed non-empty (Map encode/decode path)');
    assert.ok(cold.telemetry.length > 0, 'telemetry parsed non-empty');
    assert.ok(cold.plans.length > 0, 'plans parsed non-empty');

    // Warm call: nothing changed on disk -> ZERO reparses (acceptance #1).
    ingest._resetArtifactParseCount();
    const warm = artifactSlice(ingest.assembleDataset());
    const warmParses = ingest._getArtifactParseCount();
    assert.equal(
      warmParses,
      0,
      `warm assemble must reparse ZERO artifacts; reparsed ${warmParses}`
    );

    // Byte-identical artifact output cold vs warm (acceptance #2, transparency).
    assert.equal(
      JSON.stringify(warm),
      JSON.stringify(cold),
      'warm (cache HIT) artifact output must be byte-identical to the cold parse'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

// ---------------------------------------------------------------------------
// (2-baseline): cached output equals a from-scratch no-cache assemble.
// A brand-new DB over the SAME corpus is the "what re-parsing would produce"
// golden; the warm output above already equals the cold output in the same DB,
// and the cold output equals this independent baseline -> the cache never
// changes the data, only avoids the work.
// ---------------------------------------------------------------------------
test('(2) cached output equals an independent from-scratch (no-cache) assemble of the same corpus', async () => {
  const fx = buildFixtureHome();
  const origHome = process.env.HOME;
  const dbA = newDbPath();
  const dbB = newDbPath();
  try {
    // Instance A: cold then warm in DB-A.
    const a = await loadIngest({ home: fx.home, dbPath: dbA });
    a.assembleDataset(); // populate cache
    const warmA = artifactSlice(a.assembleDataset());

    // Instance B: a brand-new DB over the identical corpus, single cold assemble
    // — this is the no-cache reference output.
    const b = await loadIngest({ home: fx.home, dbPath: dbB });
    b._resetArtifactParseCount();
    const coldB = artifactSlice(b.assembleDataset());
    assert.ok(b._getArtifactParseCount() > 0, 'baseline assemble parsed from scratch');

    assert.equal(
      JSON.stringify(warmA),
      JSON.stringify(coldB),
      'cache HIT output must equal a fresh no-cache parse of the same corpus'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbA, dbB);
  }
});

// ---------------------------------------------------------------------------
// (3): invalidation — changing one dir reparses ONLY that dir.
// ---------------------------------------------------------------------------
test('(3) mutating one artifact dir invalidates ONLY that dir on the next assemble', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });

    ingest.assembleDataset(); // warm everything
    ingest._resetArtifactParseCount();
    assert.equal(ingest._getArtifactParseCount(), 0);

    // Confirm warm baseline is truly zero before the mutation.
    ingest.assembleDataset();
    assert.equal(
      ingest._getArtifactParseCount(),
      0,
      'pre-mutation: a warm assemble still reparses nothing'
    );

    // Mutate ONE file in plans/ — add a new plan. count+mtime change -> the
    // plans signature changes; no other dir's signature does.
    writeFileSync(join(fx.claude, 'plans', 'plan-2.md'), '# Another plan\n- a\n');

    ingest._resetArtifactParseCount();
    const after = artifactSlice(ingest.assembleDataset());
    assert.equal(
      ingest._getArtifactParseCount(),
      1,
      'exactly ONE artifact (plans) reparses after a single-dir change'
    );
    assert.equal(after.plans.length, 2, 'plans now reflects the added file (2 plans)');

    // And it stays warm again afterwards.
    ingest._resetArtifactParseCount();
    ingest.assembleDataset();
    assert.equal(ingest._getArtifactParseCount(), 0, 're-warmed after the change');
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

test('(4) bounded artifact signatures stay stable on a warm cache', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origSigCap = process.env.DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES;
  try {
    process.env.DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES = '1';
    const ingest = await loadIngest({ home: fx.home, dbPath });
    assert.equal(ingest.SIGNATURE_TREE_MAX_ENTRIES, 1);

    ingest.assembleDataset();
    ingest._resetArtifactParseCount();
    ingest.assembleDataset();
    assert.equal(
      ingest._getArtifactParseCount(),
      0,
      'a truncated but unchanged artifact signature remains a cache HIT'
    );
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origSigCap === undefined) delete process.env.DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES;
    else process.env.DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES = origSigCap;
    cleanup(fx.home, dbPath);
  }
});

test('(5) oversized artifact cache payloads are returned but not persisted', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origArtifactCacheCap = process.env.DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES;
  try {
    writeFileSync(
      join(fx.claude, 'tasks', 'sess-a', '3.json'),
      JSON.stringify({
        id: 'large-task',
        subject: 'large task subject '.repeat(512),
        status: 'pending',
      })
    );
    process.env.DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES = '1024';
    const ingest = await loadIngest({ home: fx.home, dbPath });
    assert.equal(ingest.ARTIFACT_CACHE_JSON_MAX_BYTES, 1024);

    ingest._resetArtifactParseCount();
    const cold = artifactSlice(ingest.assembleDataset());
    assert.ok(
      cold.tasks.some((task) => task.id === 'large-task'),
      'oversized artifact payload still contributes to the current dataset'
    );

    ingest._resetArtifactParseCount();
    const warm = artifactSlice(ingest.assembleDataset());
    assert.ok(
      ingest._getArtifactParseCount() > 0,
      'oversized artifact payload is not persisted and must reparse next time'
    );
    assert.equal(
      JSON.stringify(warm.tasks),
      JSON.stringify(cold.tasks),
      'skipping cache persistence must not change returned artifact data'
    );
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origArtifactCacheCap === undefined) {
      delete process.env.DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES;
    } else {
      process.env.DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES = origArtifactCacheCap;
    }
    cleanup(fx.home, dbPath);
  }
});
// ---------------------------------------------------------------------------
// (6): additive migration — the artifact_cache table is created on top of a
// pre-#624 DB (one carrying only the older session_blob/transcript/dataset
// tables) without throwing and without disturbing the existing rows. Proves the
// CREATE TABLE IF NOT EXISTS is purely additive on an existing DB.
// ---------------------------------------------------------------------------
test('(6) artifact_cache is created additively on a pre-#624 DB, leaving existing data intact', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    // Stand up a DB that predates #624: a session_blob row + a dataset_cache row,
    // and NO artifact_cache table. (Minimal shapes — enough to detect data loss.)
    // Oldest-era session_blob base schema (the same golden the #524 schema parity
    // test uses) so ingest's index/migration path applies cleanly on load.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE session_blob (
        session_id    TEXT PRIMARY KEY,
        sig           TEXT NOT NULL,
        project       TEXT,
        token_json    TEXT,
        tool_json     TEXT,
        timeline_json TEXT,
        apierrors_json TEXT,
        perm_json     TEXT,
        agents_json   TEXT,
        entries_json  TEXT
      );
      CREATE TABLE dataset_cache (
        content_hash TEXT PRIMARY KEY, etag TEXT NOT NULL,
        json_br BLOB NOT NULL, json_gz BLOB NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    seed.prepare('INSERT INTO session_blob (session_id, sig) VALUES (?, ?)').run(
      'legacy-sess',
      'legacy-sig'
    );
    // artifact_cache must NOT exist yet.
    const before = seed
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_cache'")
      .get();
    assert.equal(before, undefined, 'pre-#624 DB has no artifact_cache table');
    seed.close();

    // Loading ingest against this DB must add artifact_cache without throwing.
    const ingest = await loadIngest({ home: fx.home, dbPath });
    assert.doesNotThrow(() => ingest.assembleDataset());

    // Re-open and verify: artifact_cache now exists, and the legacy row survived.
    const check = new DatabaseSync(dbPath);
    const tbl = check
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifact_cache'")
      .get();
    assert.ok(tbl, 'artifact_cache table created additively');
    const legacy = check
      .prepare('SELECT sig FROM session_blob WHERE session_id = ?')
      .get('legacy-sess');
    assert.equal(legacy?.sig, 'legacy-sig', 'pre-existing session_blob row intact');
    check.close();
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});
