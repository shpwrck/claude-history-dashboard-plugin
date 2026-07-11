// Data-integrity parity harness for the #524 slice-2 session_blob schema
// generation. Run under the ts-resolver loader (do NOT use bare
// `node --test scripts/` — a pre-existing test boots a server and hangs):
//   node --import ./scripts/register-ts.mjs --test scripts/session-blob-schema-parity.test.mjs
//
// Proves the three DATA-INTEGRITY invariants of slice 2 on REAL temp SQLite DBs
// (node:sqlite DatabaseSync), against verbatim transcriptions of the OLD
// hand-written DDL as the GOLDEN. The goldens below are copied byte-for-byte
// from the pre-slice-2 ingest.mjs (CREATE ~lines 101-118, ALTER ~lines 122-140,
// upsert ~lines 205-221). They are NEVER regenerated to make a test pass; a
// mismatch means the generator drifted and the GENERATOR gets fixed.
//
//   (1) Fresh-DB column-set equivalence: OLD literal DDL vs generated DDL reach
//       the same {name,type,notnull,pk} SET (order-independent).
//   (2) Old-era additive migration: a DB created with only the OLDEST base
//       schema + a row upgrades to the full 20 columns via generated
//       CREATE-IF-NOT-EXISTS + ALTER, without throwing and without data loss.
//   (3) Round-trip col<->arg alignment: a distinct sentinel per column survives
//       the generated upsert + SELECT * unchanged (catches any col-list / arg /
//       SET-clause misalignment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeSessionSignals } from '../src/lib/signals/index.ts';
import {
  buildCreateTableSql,
  buildCreateIndexSql,
  migrationColumns,
  buildUpsertSql,
  upsertColumns,
} from '../src/lib/signals/schema.ts';

// The signal descriptor needs only column metadata for the schema; the parsers
// are never invoked at construction, so a no-op proxy is a safe stand-in.
const SIGNALS = makeSessionSignals(new Proxy({}, { get: () => () => undefined }));

// ---------------------------------------------------------------------------
// GOLDEN: verbatim transcription of the pre-slice-2 ingest.mjs DDL/upsert.
// ---------------------------------------------------------------------------

const OLD_CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS session_blob (
    session_id    TEXT PRIMARY KEY,
    sig           TEXT NOT NULL,
    project       TEXT,
    token_json    TEXT,
    tool_json     TEXT,
    timeline_json TEXT,
    apierrors_json TEXT,
    perm_json     TEXT,
    agents_json   TEXT,
    entries_json  TEXT,
    attribution_json TEXT,
    runtime_json  TEXT,
    title         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_session_project ON session_blob(project);
`;

const OLD_ALTER_COLUMNS = [
  'attribution_json TEXT',
  'runtime_json TEXT',
  'title TEXT',
  'inventory_json TEXT',
  'content_hash TEXT',
  'assistant_features_json TEXT',
  // Appended when the deceit signal landed (#685), exactly as
  // assistant_features_json was appended (#206) — a real new signal grows this
  // golden additively.
  'deceit_signals_json TEXT',
  'churn_geometry_json TEXT',
  'task_success_json TEXT',
  'value_flow_json TEXT',
  // Appended when the secrets-at-rest signal landed (#2504) — a real new signal
  // grows this golden additively, exactly like the ones above.
  'secrets_at_rest_json TEXT',
];

const OLD_UPSERT_SQL = `
  INSERT INTO session_blob
    (session_id, sig, project, token_json, tool_json, timeline_json,
     apierrors_json, perm_json, agents_json, entries_json,
     attribution_json, runtime_json, title, inventory_json, content_hash,
     assistant_features_json, deceit_signals_json, churn_geometry_json,
     task_success_json, value_flow_json, secrets_at_rest_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    sig=excluded.sig, project=excluded.project, token_json=excluded.token_json,
    tool_json=excluded.tool_json, timeline_json=excluded.timeline_json,
    apierrors_json=excluded.apierrors_json, perm_json=excluded.perm_json,
    agents_json=excluded.agents_json, entries_json=excluded.entries_json,
    attribution_json=excluded.attribution_json, runtime_json=excluded.runtime_json,
    title=excluded.title, inventory_json=excluded.inventory_json,
    content_hash=excluded.content_hash,
    assistant_features_json=excluded.assistant_features_json,
    deceit_signals_json=excluded.deceit_signals_json,
    churn_geometry_json=excluded.churn_geometry_json,
    task_success_json=excluded.task_success_json,
    value_flow_json=excluded.value_flow_json,
    secrets_at_rest_json=excluded.secrets_at_rest_json
`;

// The OLD positional arg order matching OLD_UPSERT_SQL's col list, in terms of
// logical roles — used only to reason about column identity in test (3).
const OLD_UPSERT_COL_ORDER = [
  'session_id', 'sig', 'project', 'token_json', 'tool_json', 'timeline_json',
  'apierrors_json', 'perm_json', 'agents_json', 'entries_json',
  'attribution_json', 'runtime_json', 'title', 'inventory_json', 'content_hash',
  'assistant_features_json', 'deceit_signals_json', 'churn_geometry_json',
  'task_success_json', 'value_flow_json', 'secrets_at_rest_json',
];

// The complete frozen column set — 21 columns as of #2504 (was 20 pre-#2504;
// the secrets-at-rest signal grows it additively, like every prior new signal).
const FULL_COLUMNS = [
  'session_id', 'sig', 'project', 'token_json', 'tool_json', 'timeline_json',
  'apierrors_json', 'perm_json', 'agents_json', 'entries_json',
  'attribution_json', 'runtime_json', 'title', 'inventory_json', 'content_hash',
  'assistant_features_json', 'deceit_signals_json', 'churn_geometry_json',
  'task_success_json', 'value_flow_json', 'secrets_at_rest_json',
];
const FULL_COUNT = FULL_COLUMNS.length;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb() {
  // Distinct temp file per DB so PRAGMA/state never crosses tests.
  const path = join(tmpdir(), `chd-524-schema-${randomUUID()}.db`);
  const db = new DatabaseSync(path);
  return { db, path };
}

function cleanup(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

// Normalize PRAGMA table_info into a comparable SET of {name,type,notnull,pk}.
function columnSet(db) {
  const rows = db.prepare('PRAGMA table_info(session_blob)').all();
  return rows
    .map((r) => `${r.name}|${r.type}|${r.notnull}|${r.pk}`)
    .sort();
}

function applyGeneratedSchema(db) {
  db.exec(buildCreateTableSql(SIGNALS));
  db.exec(buildCreateIndexSql());
  applyGeneratedMigration(db);
}

// The generated additive migration ONLY (no CREATE), with the SAME narrowed
// catch the production loop uses: re-throw anything that isn't a duplicate
// column. Tests (2c)/(2d) rely on this faithfully surfacing a real failure.
function applyGeneratedMigration(db) {
  for (const col of migrationColumns(SIGNALS)) {
    try {
      db.exec(`ALTER TABLE session_blob ADD COLUMN ${col};`);
    } catch (e) {
      if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// (1) Fresh-DB column-set equivalence: OLD literal vs generated.
// ---------------------------------------------------------------------------
test('(1) fresh DB: generated DDL reaches the SAME column SET as the old literal DDL', () => {
  const a = freshDb(); // OLD literal
  const b = freshDb(); // generated
  try {
    // OLD: literal CREATE then literal ALTER list.
    a.db.exec(OLD_CREATE_SQL);
    for (const col of OLD_ALTER_COLUMNS) {
      try {
        a.db.exec(`ALTER TABLE session_blob ADD COLUMN ${col};`);
      } catch {
        /* duplicate */
      }
    }
    // GENERATED.
    applyGeneratedSchema(b.db);

    const setA = columnSet(a.db);
    const setB = columnSet(b.db);
    assert.deepEqual(setB, setA, 'generated column set must equal old literal set');

    // And both must be exactly the frozen 20 columns by name.
    const names = setA.map((s) => s.split('|')[0]).sort();
    assert.deepEqual(names, [...FULL_COLUMNS].sort());
    assert.equal(names.length, FULL_COUNT);

    // Spot-check the load-bearing constraints survived: session_id is the PK,
    // sig is NOT NULL, in BOTH.
    for (const set of [setA, setB]) {
      assert.ok(set.includes('session_id|TEXT|0|1'), 'session_id PK');
      assert.ok(set.includes('sig|TEXT|1|0'), 'sig NOT NULL');
    }
  } finally {
    a.db.close();
    b.db.close();
    cleanup(a.path);
    cleanup(b.path);
  }
});

// ---------------------------------------------------------------------------
// (2) Old-era additive migration: oldest base schema + row -> full 20, no loss.
// ---------------------------------------------------------------------------
test('(2) old-era DB: additive migration upgrades to full 20 without data loss', () => {
  const { db, path } = freshDb();
  try {
    // OLDEST base schema: session_id/sig/project + token..entries only. NO
    // attribution/runtime/title/inventory/content_hash/assistant_features.
    db.exec(`
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
    `);
    // Representative pre-existing row.
    db.prepare(
      `INSERT INTO session_blob
        (session_id, sig, project, token_json, tool_json, timeline_json,
         apierrors_json, perm_json, agents_json, entries_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'old-session',
      'sig-v0',
      'proj-old',
      '{"t":"token"}',
      '{"t":"tool"}',
      '{"t":"timeline"}',
      '[1]',
      '{"perModeEntries":[]}',
      '[2]',
      '[3]'
    );

    // Generated CREATE-IF-NOT-EXISTS + ALTER migration must not throw.
    assert.doesNotThrow(() => applyGeneratedSchema(db));

    // (ii) column set now equals the full 20.
    const names = columnSet(db)
      .map((s) => s.split('|')[0])
      .sort();
    assert.deepEqual(names, [...FULL_COLUMNS].sort());

    // (iii) the pre-existing row's data is intact; new columns are NULL.
    const row = db
      .prepare('SELECT * FROM session_blob WHERE session_id = ?')
      .get('old-session');
    assert.equal(row.session_id, 'old-session');
    assert.equal(row.sig, 'sig-v0');
    assert.equal(row.project, 'proj-old');
    assert.equal(row.token_json, '{"t":"token"}');
    assert.equal(row.tool_json, '{"t":"tool"}');
    assert.equal(row.timeline_json, '{"t":"timeline"}');
    assert.equal(row.apierrors_json, '[1]');
    assert.equal(row.perm_json, '{"perModeEntries":[]}');
    assert.equal(row.agents_json, '[2]');
    assert.equal(row.entries_json, '[3]');
    // newly-added columns default to NULL.
    assert.equal(row.attribution_json, null);
    assert.equal(row.runtime_json, null);
    assert.equal(row.title, null);
    assert.equal(row.inventory_json, null);
    assert.equal(row.content_hash, null);
    assert.equal(row.assistant_features_json, null);
    assert.equal(row.deceit_signals_json, null);
    assert.equal(row.churn_geometry_json, null);
    assert.equal(row.task_success_json, null);
    assert.equal(row.value_flow_json, null);
    assert.equal(row.secrets_at_rest_json, null);
  } finally {
    db.close();
    cleanup(path);
  }
});

// migrationColumns must be strictly additive: only "<name> TEXT" defs (no
// constraints that could fail on existing rows, no DDL verbs).
test('(2b) migrationColumns are strictly additive ADD COLUMN defs (no NOT NULL / no PK / no DDL verbs)', () => {
  for (const def of migrationColumns(SIGNALS)) {
    assert.match(def, /^[a-z_]+ TEXT$/, `additive plain-TEXT def: ${def}`);
    assert.doesNotMatch(def, /NOT NULL|PRIMARY KEY/i, `no constraint: ${def}`);
    assert.doesNotMatch(
      def,
      /\b(DROP|RENAME|ALTER|DELETE|UPDATE)\b/i,
      `no DDL/DML verb: ${def}`
    );
  }
  // session_id (PK) must NOT appear in the ALTER list.
  assert.ok(
    !migrationColumns(SIGNALS).some((d) => d.startsWith('session_id ')),
    'PK column session_id is never ALTERed'
  );
});

// (2c) Divergent-affinity middle column + an unexpected extra column not in the
// frozen 20. A real-world DB could carry a column with a different declared
// affinity (e.g. an old/foreign build that wrote `project INTEGER`) and/or an
// extra column the current schema doesn't know about. The additive migration
// must converge to the full 20, leave the row's data intact, and TOLERATE the
// extra column (additive never drops).
test('(2c) divergent-affinity + extra-column DB: migration converges to full 20, tolerates extras, no data loss', () => {
  const { db, path } = freshDb();
  try {
    // Middle base column `project` declared INTEGER (divergent affinity), plus
    // an `extra_legacy_col` not in the frozen 20.
    db.exec(`
      CREATE TABLE session_blob (
        session_id    TEXT PRIMARY KEY,
        sig           TEXT NOT NULL,
        project       INTEGER,
        token_json    TEXT,
        tool_json     TEXT,
        timeline_json TEXT,
        apierrors_json TEXT,
        perm_json     TEXT,
        agents_json   TEXT,
        entries_json  TEXT,
        extra_legacy_col TEXT
      );
    `);
    db.prepare(
      `INSERT INTO session_blob
        (session_id, sig, project, token_json, tool_json, timeline_json,
         apierrors_json, perm_json, agents_json, entries_json, extra_legacy_col)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'diverge-session',
      'sig-x',
      42, // INTEGER affinity value
      '{"t":"token"}',
      '{"t":"tool"}',
      '{"t":"timeline"}',
      '[1]',
      '{"perModeEntries":[]}',
      '[2]',
      '[3]',
      'legacy-value'
    );

    // CREATE-IF-NOT-EXISTS is a no-op (table exists); migration adds the missing
    // columns and skips the duplicates via the narrowed catch — must not throw.
    assert.doesNotThrow(() => applyGeneratedSchema(db));

    const present = new Set(
      columnSet(db).map((s) => s.split('|')[0])
    );
    // All 20 frozen columns present.
    for (const c of FULL_COLUMNS) {
      assert.ok(present.has(c), `frozen column present: ${c}`);
    }
    // Extra column tolerated, not dropped.
    assert.ok(
      present.has('extra_legacy_col'),
      'unexpected extra column is tolerated (additive never drops)'
    );

    // Row data intact (the divergent-affinity project value and the extra col).
    const row = db
      .prepare('SELECT * FROM session_blob WHERE session_id = ?')
      .get('diverge-session');
    assert.equal(row.session_id, 'diverge-session');
    assert.equal(row.sig, 'sig-x');
    assert.equal(row.project, 42);
    assert.equal(row.token_json, '{"t":"token"}');
    assert.equal(row.entries_json, '[3]');
    assert.equal(row.extra_legacy_col, 'legacy-value');
    // Newly-added frozen columns are NULL.
    assert.equal(row.attribution_json, null);
    assert.equal(row.content_hash, null);
    assert.equal(row.assistant_features_json, null);
    assert.equal(row.deceit_signals_json, null);
    assert.equal(row.churn_geometry_json, null);
    assert.equal(row.task_success_json, null);
    assert.equal(row.value_flow_json, null);
    assert.equal(row.secrets_at_rest_json, null);
  } finally {
    db.close();
    cleanup(path);
  }
});

// (2d) Partially-migrated DB (a prior migration run crashed midway). Applying
// only a subset of the ALTER list first, then the FULL list, must idempotently
// converge to the full 20 without throwing (the duplicate columns are skipped)
// and leave the row intact.
test('(2d) partially-migrated DB: re-applying the full migration converges idempotently, no throw, row intact', () => {
  const { db, path } = freshDb();
  try {
    // Oldest base schema + a row.
    db.exec(`
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
    `);
    db.prepare(
      `INSERT INTO session_blob
        (session_id, sig, project, token_json, tool_json, timeline_json,
         apierrors_json, perm_json, agents_json, entries_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'partial-session',
      'sig-p',
      'proj-p',
      '{"t":"token"}',
      '{"t":"tool"}',
      '{"t":"timeline"}',
      '[1]',
      '{"perModeEntries":[]}',
      '[2]',
      '[3]'
    );

    // Simulate a crashed prior run: apply only a PARTIAL subset of the migration
    // (the first few ALTER defs), leaving the rest unmigrated.
    const all = migrationColumns(SIGNALS);
    const partial = all.slice(0, Math.ceil(all.length / 2));
    for (const col of partial) {
      try {
        db.exec(`ALTER TABLE session_blob ADD COLUMN ${col};`);
      } catch (e) {
        if (!/duplicate column name/i.test(e?.message ?? '')) throw e;
      }
    }
    // Mid-state: strictly fewer than 20 columns so far (a partial migration).
    assert.ok(
      columnSet(db).length < FULL_COUNT,
      'partial migration left fewer than the full column set'
    );

    // Now re-run the FULL migration — must skip the already-added columns via
    // the narrowed catch and add the rest, converging to 20 without throwing.
    assert.doesNotThrow(() => applyGeneratedMigration(db));

    const names = columnSet(db)
      .map((s) => s.split('|')[0])
      .sort();
    assert.deepEqual(names, [...FULL_COLUMNS].sort());

    // Row intact through the two-phase migration.
    const row = db
      .prepare('SELECT * FROM session_blob WHERE session_id = ?')
      .get('partial-session');
    assert.equal(row.sig, 'sig-p');
    assert.equal(row.project, 'proj-p');
    assert.equal(row.token_json, '{"t":"token"}');
    assert.equal(row.entries_json, '[3]');

    // Fully idempotent: a THIRD application is still a no-op (all duplicates).
    assert.doesNotThrow(() => applyGeneratedMigration(db));
    assert.equal(
      columnSet(db).length,
      FULL_COUNT,
      'still exactly the full column set after re-run'
    );
  } finally {
    db.close();
    cleanup(path);
  }
});

// ---------------------------------------------------------------------------
// (3) Round-trip col<->arg alignment: distinct sentinel per column.
// ---------------------------------------------------------------------------
test('(3) round-trip: every column reads back the distinct sentinel passed FOR THAT column', () => {
  const { db, path } = freshDb();
  try {
    applyGeneratedSchema(db);

    const cols = upsertColumns(SIGNALS);
    assert.equal(cols.length, FULL_COUNT, 'upsert drives all columns');

    // Distinct sentinel per column.
    const sentinel = {};
    for (const c of cols) sentinel[c] = `SENTINEL::${c}`;

    const upsert = db.prepare(buildUpsertSql(SIGNALS));
    upsert.run(...cols.map((c) => sentinel[c]));

    const row = db
      .prepare('SELECT * FROM session_blob WHERE session_id = ?')
      .get(sentinel.session_id);
    assert.ok(row, 'row inserted under the session_id sentinel');
    for (const c of cols) {
      assert.equal(
        row[c],
        sentinel[c],
        `column ${c} must read back ITS OWN sentinel (not another column's)`
      );
    }

    // Upsert path (ON CONFLICT DO UPDATE SET): a second run with new sentinels
    // for the same PK must update every non-PK column to its own new value.
    const sentinel2 = {};
    for (const c of cols) {
      sentinel2[c] = c === 'session_id' ? sentinel.session_id : `UPDATED::${c}`;
    }
    upsert.run(...cols.map((c) => sentinel2[c]));
    const row2 = db
      .prepare('SELECT * FROM session_blob WHERE session_id = ?')
      .get(sentinel.session_id);
    for (const c of cols) {
      assert.equal(
        row2[c],
        sentinel2[c],
        `after upsert, column ${c} holds its own updated sentinel`
      );
    }
    // Exactly one row (upsert, not a second insert).
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM session_blob')
      .get().n;
    assert.equal(count, 1, 'ON CONFLICT updated in place, no duplicate row');
  } finally {
    db.close();
    cleanup(path);
  }
});

// The generated upsert column SET must equal the old upsert column SET (the
// order is intentionally re-chosen in slice 2, but the SET — what gets written —
// must be identical, so no column is dropped or added vs the old write path).
test('(3b) generated upsert column SET equals the old upsert column SET', () => {
  const genCols = [...upsertColumns(SIGNALS)].sort();
  const oldCols = [...OLD_UPSERT_COL_ORDER].sort();
  assert.deepEqual(genCols, oldCols);
});
