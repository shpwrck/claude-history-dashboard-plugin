// Session-signal SQLite schema generation (#524, slice 2).
//
// Single source of truth for the `session_blob` DDL and upsert SQL. Before
// this, the CREATE TABLE, the additive ALTER migration list, the INSERT/upsert
// statement, and the `upsert.run(...)` positional args lived as four
// hand-maintained literals in `scripts/ingest.mjs` that had to stay in lockstep
// with each other AND with the signal descriptor's column metadata. Drift was
// load-bearing: a misaligned col-list/arg-order would silently write a value
// for one column into another.
//
// This module DERIVES all four from the same `SESSION_SIGNALS` descriptor (for
// the `_json` columns) plus a fixed set of non-signal columns. The ingest
// pipeline imports `buildCreateTableSql`, `migrationColumns`, `buildUpsertSql`,
// and `UPSERT_COLUMNS` and uses them verbatim — no inline literals.
//
// DATA-INTEGRITY contract (proven by `scripts/session-blob-schema-parity.test.mjs`):
//  1. The final column SET (name + declared type) a fresh DB reaches via the
//     generated CREATE, and an old-era DB reaches via CREATE-IF-NOT-EXISTS +
//     the generated ALTER list, equals the frozen historical column set.
//  2. The migration is STRICTLY ADDITIVE: only `CREATE TABLE IF NOT EXISTS` and
//     `ALTER TABLE ADD COLUMN` (duplicate-column ignored). No drop/rename/
//     retype/move. Any existing DB upgrades without data loss.
//  3. The generated INSERT column list, its `?` placeholders, the
//     `ON CONFLICT DO UPDATE SET`, and `UPSERT_COLUMNS` (which the caller maps
//     `upsert.run(...)` args from) share one ordered array, so a value bound for
//     `token_json` can only ever land in `token_json`.

import type { SessionSignal } from './index.js';

const TABLE = 'session_blob';

/**
 * Non-signal columns and their full SQL definitions. `session_id` is the PK;
 * `sig` is NOT NULL; the rest are plain TEXT. These are the columns that are
 * NOT derived from `SESSION_SIGNALS` (the `_json` signal blobs).
 */
export const SESSION_BLOB_FIXED_COLUMNS: ReadonlyArray<{
  name: string;
  def: string;
}> = [
  { name: 'session_id', def: 'session_id TEXT PRIMARY KEY' },
  { name: 'sig', def: 'sig TEXT NOT NULL' },
  { name: 'project', def: 'project TEXT' },
  { name: 'title', def: 'title TEXT' },
  { name: 'content_hash', def: 'content_hash TEXT' },
];

/** Names of the fixed columns, for quick membership checks. */
const FIXED_NAMES = new Set(SESSION_BLOB_FIXED_COLUMNS.map((c) => c.name));

/** Signal columns, in descriptor (content_hash part) order: `${column} TEXT`. */
function signalColumnDefs(
  signals: ReadonlyArray<SessionSignal>
): Array<{ name: string; def: string }> {
  return signals.map((s) => ({ name: s.column, def: `${s.column} TEXT` }));
}

/**
 * The canonical ordered column list that drives the upsert. The INSERT column
 * list, the `?` placeholders, the `ON CONFLICT SET`, and the caller's
 * `upsert.run(...)` arg order are ALL built from this one array, so they cannot
 * drift relative to one another (invariant #3).
 *
 * Order (OWNED here): `session_id, sig, project, <signal cols in descriptor
 * order>, title, content_hash`.
 */
export function upsertColumns(
  signals: ReadonlyArray<SessionSignal>
): string[] {
  return [
    'session_id',
    'sig',
    'project',
    ...signals.map((s) => s.column),
    'title',
    'content_hash',
  ];
}

/**
 * `CREATE TABLE IF NOT EXISTS session_blob (...)` listing the full column set —
 * fixed columns (canonical order) plus every signal column. A fresh DB reaches
 * the complete set from this one statement. Column ORDER in the table is
 * irrelevant (all access is by name / `SELECT *`); only the SET matters.
 */
export function buildCreateTableSql(
  signals: ReadonlyArray<SessionSignal>
): string {
  const defs = [
    ...SESSION_BLOB_FIXED_COLUMNS.map((c) => c.def),
    ...signalColumnDefs(signals).map((c) => c.def),
  ];
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (\n  ${defs.join(',\n  ')}\n);`;
}

/**
 * The `ADD COLUMN` definitions to defensively apply after CREATE-IF-NOT-EXISTS,
 * to upgrade a DB created in ANY earlier era to the full column set. We emit an
 * ALTER for EVERY non-PK column (project/title/content_hash + every signal
 * column). `ALTER TABLE ADD COLUMN` for a column that already exists throws
 * "duplicate column name", which the caller catches and ignores — so applying
 * the full list is safe and idempotent and guarantees the full set regardless
 * of the DB's origin era. The PK (`session_id`) is never ALTERed (it always
 * exists on any DB that has the table, and SQLite cannot ADD a PRIMARY KEY
 * column anyway). This is STRICTLY ADDITIVE: no drop/rename/retype/move.
 */
export function migrationColumns(
  signals: ReadonlyArray<SessionSignal>
): string[] {
  const fixed = SESSION_BLOB_FIXED_COLUMNS.filter(
    (c) => !c.def.includes('PRIMARY KEY')
  ).map((c) =>
    // ADD COLUMN cannot carry a NOT NULL without a default; strip the NOT NULL
    // qualifier so an old-era DB's existing rows aren't rejected. (`sig` is
    // already present on every era that has the table, so its ALTER is a
    // duplicate-column no-op in practice — but keep the def safe regardless.)
    c.name === 'sig' ? `${c.name} TEXT` : c.def
  );
  const sigs = signalColumnDefs(signals).map((c) => c.def);
  return [...fixed, ...sigs];
}

/**
 * `CREATE INDEX IF NOT EXISTS idx_session_project ON session_blob(project)`.
 * Kept verbatim from the original DDL; preserved alongside the table create.
 */
export function buildCreateIndexSql(): string {
  return `CREATE INDEX IF NOT EXISTS idx_session_project ON ${TABLE}(project);`;
}

/**
 * The INSERT/upsert statement, generated from `upsertColumns`. The column list,
 * the `?` placeholders (one per column), and the `ON CONFLICT(session_id) DO
 * UPDATE SET` (every non-PK column = excluded.<col>) are all derived from the
 * same ordered array — so they are mutually consistent by construction
 * (invariant #3). The caller must pass `upsert.run(...)` args in
 * `upsertColumns(signals)` order.
 */
export function buildUpsertSql(signals: ReadonlyArray<SessionSignal>): string {
  const cols = upsertColumns(signals);
  const placeholders = cols.map(() => '?').join(', ');
  const setClause = cols
    .filter((c) => c !== 'session_id')
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${TABLE}
  (${cols.join(', ')})
  VALUES (${placeholders})
  ON CONFLICT(session_id) DO UPDATE SET
    ${setClause}`;
}

export { FIXED_NAMES };
