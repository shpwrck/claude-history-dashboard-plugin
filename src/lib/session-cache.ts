// Session-transcript BLOB cache (#627 slice 3).
//
// Extracted verbatim from scripts/ingest.mjs: the `session_transcript` table
// owns the per-session assistant transcript BLOBs (#204, slice 1 of #181) —
// brotli-compressed `content_br` + `thinking_br`, gated on `content_hash` so an
// unchanged transcript skips compression and the write entirely. This is the
// persistence layer ONLY: the schema, its four prepared statements, and the
// `getTranscript` read shape. The brotli/scrub/extract logic and the
// content_hash gate's control flow stay in ingest.mjs (`persistTranscript`);
// that function now routes its four DB operations through the object returned by
// `initTranscriptCache(db)` instead of module-level prepared statements.
//
// Dependency-injected on the existing `db` handle (the module-level
// DatabaseSync ingest.mjs already opened) so this cache shares the same SQLite
// connection as the session_blob / dataset_cache / artifact_cache caches that
// STAY in ingest.mjs. assembleDataset() reads `session_blob`, NOT
// `session_transcript`, so this slice does not touch the dataset read path.
//
// DATA-INTEGRITY contract: the CREATE TABLE SQL and write statements stay
// byte-identical to the pre-extraction code (proven by
// scripts/transcript-cache-parity.test.mjs). The read shape additionally returns
// byte_len so the server can enforce lazy transcript response bounds without
// inflating content BLOBs first.
//
// #627 slice 4: this file ALSO owns the `session_blob` per-session signal cache
// — the deepest persistence layer, woven into BOTH the write (ingestOne) and
// read (assembleDataset) paths. `initSessionBlobCache(db, sessionSignals)` runs
// the generated CREATE TABLE + additive migration loop and prepares the six
// statements (selSig / allIds / del / allContentHashes / upsert / selAll)
// against the SAME shared `db` handle, returning higher-level ops plus the
// canonical `upsertColumns` order so ingestOne builds its upsert args in the
// identical (content_hash-affecting) order. The SQL strings, the migration
// loop's duplicate-column catch, and the column derivation are byte-identical to
// the pre-extraction inline code (proven by
// scripts/session-blob-cache-parity.test.mjs). The dataset-shape logic — the
// SESSION_SIGNALS descriptor, the byColumn build in ingestOne, and the row->
// dataset reconstruction in assembleDataset — STAYS in ingest.mjs; it calls
// these ops. This module must NOT import ingest.mjs (no cycle).

import {
  buildCreateTableSql,
  migrationColumns,
  buildUpsertSql,
  upsertColumns,
} from './signals/schema';
import type { SessionSignal } from './signals/index';

// Minimal structural view of the node:sqlite handle we use — only `exec` (for
// the CREATE TABLE) and `prepare` (which yields a statement with `get`/`run`).
// Typed with `unknown`-guarded structural shapes rather than importing
// node:sqlite types so this file stays a plain server-importable .ts (eslint
// bans `any`). The handle is whatever ingest.mjs passes — a DatabaseSync.
interface Statement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
}

// Stored-transcript read shape (the server streams these as-is with
// `Content-Encoding: br`). `null` when the session has no stored transcript.
export interface TranscriptBlobs {
  contentBr: unknown;
  thinkingBr: unknown;
  contentHash: unknown;
  contentByteLen: unknown;
}

// Row shapes the prepared statements return — open records the original .mjs
// read fields off directly. Guarded casts keep eslint's no-explicit-any happy.
interface BlobRow {
  content_br: unknown;
  thinking_br: unknown;
  content_hash: unknown;
  byte_len: unknown;
}
interface HashRow {
  content_hash: unknown;
}

export interface TranscriptCache {
  // Read the brotli BLOBs for lazy serving (#205) — see getTranscript below.
  getTranscript(sessionId: string): TranscriptBlobs | null;
  // The content_hash gate row (or null) — reads only the hash so an unchanged
  // session skips brotli entirely.
  readTranscriptHash(sessionId: string): HashRow | null;
  // The warm-cache gate (#3634): the signature the stored BLOBs were built
  // from. `null` for no row and for a legacy row predating the column, so
  // either way the caller misses and rebuilds from source.
  readTranscriptSig(sessionId: string): string | null;
  // Upsert the gated BLOBs (positional args match the INSERT column order).
  upsertTranscript(
    sessionId: string,
    contentBr: unknown,
    thinkingBr: unknown,
    contentHash: string,
    byteLen: number,
    sig: string
  ): void;
  // Advance the gate signature alone, for a source change that re-extracted to
  // a byte-identical transcript (the content_hash gate skipped the BLOB write).
  updateTranscriptSig(sessionId: string, sig: string): void;
  // Record an empty extraction (#3652): a row with NULL BLOBs/hash but a live
  // sig, replacing any stale BLOBs. getTranscript reads it back as null, and
  // the armed sig lets the warm gate short-circuit instead of re-reading the
  // source on every call (delTranscript alone left the gate unarmed forever).
  stampTranscriptTombstone(sessionId: string, sig: string): void;
  // Drop a session's transcript row (prune / removed-session cleanup).
  delTranscript(sessionId: string): void;
}

// Prepare the four session_transcript statements against the passed `db` and
// own the schema (CREATE TABLE IF NOT EXISTS runs here). SQL strings and the
// getTranscript field mapping mirrors the original ingest.mjs shape plus
// byte_len for bounded lazy transcript serving.
export function initTranscriptCache(db: Db): TranscriptCache {
  // Assistant-response transcripts (#204, slice 1 of #181). Stored as brotli
  // BLOBs alongside the session_blob rows in the same SQLite cache so no per-file
  // artifacts and no extra deploy infra are introduced. `content_br` holds the
  // scrubbed text + tool_use blocks; `thinking_br` holds thinking blocks in their
  // own column so slice 2 can fetch them lazily (only when a user expands "Show
  // thinking"). `content_hash` gates BLOB rewrites at session granularity:
  // re-ingesting a session whose extracted transcript is byte-identical touches
  // zero BLOBs. `byte_len` is the uncompressed content JSON length, surfaced for
  // slice 3's thinking/size features without inflating it back out of brotli.
  // `sig` (#3634) is the warm-cache gate: the transcript signature the stored
  // BLOBs were built from, stamped on write and re-derived on read from ONE
  // constructor (`transcriptSigOf` in ingest.mjs), so the two sides are
  // comparable by construction rather than by coincidence.
  db.exec(`
  CREATE TABLE IF NOT EXISTS session_transcript (
    session_id   TEXT PRIMARY KEY,
    content_br   BLOB,
    thinking_br  BLOB,
    content_hash TEXT,
    byte_len     INTEGER,
    sig          TEXT
  );
`);

  // Additive migration for DBs created before the gate column existed (the
  // CREATE TABLE above is a no-op on those). Legacy rows read SQL NULL, which
  // never equals a constructed signature, so they miss once and rebuild from
  // source — the same clean-rebuild direction the dataset_cache columns take.
  try {
    db.exec('ALTER TABLE session_transcript ADD COLUMN sig TEXT');
  } catch (e) {
    // Same guard as the session_blob migration below: "duplicate column name"
    // is the benign idempotent case (fresh schema above, or an earlier boot).
    // Anything else — I/O, SQLITE_BUSY — is a real migration failure and must
    // surface HERE, naming the migration, rather than resurfacing later as an
    // inscrutable "no such column: sig" from the gate's SELECT.
    const message = (e as { message?: string } | undefined)?.message ?? '';
    if (!/duplicate column name/i.test(message)) throw e;
  }

  // Transcript gate + upsert + delete. The gate reads only the hash so an
  // unchanged session skips brotli entirely.
  const selTranscriptHash = db.prepare(
    'SELECT content_hash FROM session_transcript WHERE session_id = ?'
  );
  // The read-path gate (#3634): the stored signature alone, so a warm hit is
  // decided without inflating (or even loading) the BLOB columns.
  const selTranscriptSig = db.prepare(
    'SELECT sig FROM session_transcript WHERE session_id = ?'
  );
  const upsertTranscript = db.prepare(`
  INSERT INTO session_transcript
    (session_id, content_br, thinking_br, content_hash, byte_len, sig)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    content_br=excluded.content_br, thinking_br=excluded.thinking_br,
    content_hash=excluded.content_hash, byte_len=excluded.byte_len,
    sig=excluded.sig
`);
  // Re-stamp the gate without touching a BLOB — the source moved but
  // re-extracted to a byte-identical transcript, so the content_hash gate
  // skips the rewrite while the signature still has to advance.
  const updTranscriptSig = db.prepare(
    'UPDATE session_transcript SET sig = ? WHERE session_id = ?'
  );
  const delTranscript = db.prepare(
    'DELETE FROM session_transcript WHERE session_id = ?'
  );
  // Read the brotli BLOBs for lazy serving (#205). Returns the already-compressed
  // buffers as stored (brotli of the content/thinking JSON arrays), the
  // content_hash for the ETag, and the uncompressed content byte length so the
  // server can reject oversized lazy transcript responses before decompressing.
  // `null` when the session has no stored transcript (persistTranscript skips
  // sessions with no assistant turns).
  const selTranscriptBlobs = db.prepare(
    'SELECT content_br, thinking_br, content_hash, byte_len FROM session_transcript WHERE session_id = ?'
  );

  return {
    getTranscript(sessionId) {
      const row = selTranscriptBlobs.get(sessionId) as BlobRow | undefined;
      // An empty-extraction tombstone (#3652) has NULL BLOBs — it exists only
      // to keep the sig gate armed, and reads back as "no stored transcript".
      if (!row || row.content_br == null) return null;
      return {
        contentBr: row.content_br,
        thinkingBr: row.thinking_br,
        contentHash: row.content_hash,
        contentByteLen: row.byte_len,
      };
    },
    readTranscriptHash(sessionId) {
      const row = selTranscriptHash.get(sessionId) as HashRow | undefined;
      return row ?? null;
    },
    readTranscriptSig(sessionId) {
      const row = selTranscriptSig.get(sessionId) as SigRow | undefined;
      return typeof row?.sig === 'string' ? row.sig : null;
    },
    upsertTranscript(sessionId, contentBr, thinkingBr, contentHash, byteLen, sig) {
      upsertTranscript.run(
        sessionId,
        contentBr,
        thinkingBr,
        contentHash,
        byteLen,
        sig
      );
    },
    updateTranscriptSig(sessionId, sig) {
      updTranscriptSig.run(sig, sessionId);
    },
    stampTranscriptTombstone(sessionId, sig) {
      upsertTranscript.run(sessionId, null, null, null, null, sig);
    },
    delTranscript(sessionId) {
      delTranscript.run(sessionId);
    },
  };
}

// A session_blob row read back as a generic record (assembleDataset indexes its
// `_json` columns by name). `sig`/`session_id`/`content_hash` rows are narrower
// shapes the callers read specific fields off.
interface SigRow {
  sig: unknown;
}
interface IdRow {
  session_id: string;
}
interface ContentHashRow {
  session_id: string;
  content_hash: unknown;
}

// Higher-level ops over the `session_blob` per-session signal cache (#627 slice
// 4). Each wraps one of the six prepared statements; `upsertColumns` is the
// canonical ordered column list ingestOne maps its upsert args from, so the
// arg-to-column binding stays content_hash-identical.
export interface SessionBlobCache {
  // Gate read: the stored file signature for a session (or null) — ingest()
  // skips re-parsing a session whose `sig` is unchanged.
  readSig(sessionId: string): SigRow | null;
  // Every session_id currently in the table (prune walk).
  listIds(): IdRow[];
  // Drop a session's row (forgotten/deleted session).
  deleteRow(sessionId: string): void;
  // (session_id, content_hash) for every row, ordered by session_id — the
  // dataset-cache content gate.
  listContentHashes(): ContentHashRow[];
  // Upsert a row; `orderedArgs` MUST be in `upsertColumns` order.
  upsertRow(orderedArgs: unknown[]): void;
  // Every row, all columns (`SELECT *`) — assembleDataset's read source.
  readAllRows(): Record<string, unknown>[];
  // One session's row, all columns — the lazy per-session detail read (#1035).
  readRow(sessionId: string): Record<string, unknown> | null;
  // The canonical INSERT/upsert column order (so ingestOne builds args in the
  // SAME order the upsert SQL was generated from).
  upsertColumns: string[];
}

// Prepare the six session_blob statements + own the schema (generated CREATE
// TABLE + the additive ALTER migration loop) against the passed `db`. SQL,
// migration loop, and the duplicate-column catch are verbatim from
// scripts/ingest.mjs. `sessionSignals` is the descriptor ingest.mjs builds and
// passes in — it drives both the generated DDL and the upsert column order.
export function initSessionBlobCache(
  db: Db,
  sessionSignals: ReadonlyArray<SessionSignal>
): SessionBlobCache {
  db.exec(buildCreateTableSql(sessionSignals));

  // Additive migrations: upgrade a DB created in ANY earlier era to the full
  // column set. STRICTLY ADDITIVE — only ALTER TABLE ADD COLUMN, with the
  // "duplicate column name" throw caught and ignored. No drop/rename/retype/move.
  // content_hash: SHA-1 of the parsed JSON blobs we write per row, so the server
  // can gate dataset-cache rebuilds on actual content change rather than on `sig`
  // (which moves whenever a live transcript's mtime ticks even when its bytes
  // don't — issue #159). assistant_features_json: per-turn assistant-behaviour
  // features aggregate (#206).
  for (const col of migrationColumns(sessionSignals)) {
    try {
      db.exec(`ALTER TABLE session_blob ADD COLUMN ${col};`);
    } catch (e) {
      // ADD COLUMN throws "duplicate column name" when the column already exists —
      // the benign idempotent case. Anything else is a real migration failure and
      // must surface, not be silently swallowed (would leave the schema short a column).
      const message = (e as { message?: string } | undefined)?.message ?? '';
      if (!/duplicate column name/i.test(message)) throw e;
    }
  }

  const selSig = db.prepare('SELECT sig FROM session_blob WHERE session_id = ?');
  const allIds = db.prepare('SELECT session_id FROM session_blob');
  const del = db.prepare('DELETE FROM session_blob WHERE session_id = ?');
  // Per-row content fingerprints. If two ingest()s end with the same set of
  // (session_id, content_hash) pairs, the JSON blobs that feed assembleDataset()
  // are byte-identical and the cached dataset (with its ETag) is still valid —
  // even when a live transcript's mtime bumped (reparsed > 0) without the
  // parsed content actually changing. See issue #159.
  const allContentHashes = db.prepare(
    'SELECT session_id, content_hash FROM session_blob ORDER BY session_id'
  );
  // Generated INSERT/upsert (#524, slice 2): column list, placeholders, and the
  // ON CONFLICT SET all derive from upsertColumns(sessionSignals) — the same
  // ordered array the upsert.run(...) args are built from, so a value bound
  // for one column can never land in another (invariant #3).
  const upsert = db.prepare(buildUpsertSql(sessionSignals));
  // The canonical column order the upsert.run(...) args MUST follow.
  const UPSERT_COLUMNS = upsertColumns(sessionSignals);
  const selAll = db.prepare('SELECT * FROM session_blob');
  const selRow = db.prepare('SELECT * FROM session_blob WHERE session_id = ?');

  return {
    upsertColumns: UPSERT_COLUMNS,
    readSig(sessionId) {
      const row = selSig.get(sessionId) as SigRow | undefined;
      return row ?? null;
    },
    listIds() {
      return allIds.all() as IdRow[];
    },
    deleteRow(sessionId) {
      del.run(sessionId);
    },
    listContentHashes() {
      return allContentHashes.all() as ContentHashRow[];
    },
    upsertRow(orderedArgs) {
      upsert.run(...orderedArgs);
    },
    readAllRows() {
      return selAll.all() as Record<string, unknown>[];
    },
    readRow(sessionId) {
      const row = selRow.get(sessionId) as Record<string, unknown> | undefined;
      return row ?? null;
    },
  };
}
