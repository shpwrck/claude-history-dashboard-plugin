// Round-trip + incremental-contract harness for the #627 slice-4 extraction:
// the per-session `session_blob` SIGNAL cache moved behind
// initSessionBlobCache(db, SESSION_SIGNALS) in src/lib/session-cache.ts. Run
// under the ts-resolver loader (the .ts parsers + session-cache.ts must resolve)
// and with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/session-blob-cache-parity.test.mjs
//
// This is the load-bearing data-integrity gate for the slice: session_blob is
// woven into BOTH the write (ingestOne -> blobCache.upsertRow) and the read
// (assembleDataset -> blobCache.readAllRows) paths, plus the sig gate in
// ingest() (blobCache.readSig) and the prune loop (listIds/deleteRow). It proves
// the whole dataset survives a full ingest()->assembleDataset() round-trip
// byte-identically and that the sig gate's incremental contract (zero session_blob
// rewrites on an unchanged corpus) is preserved after the statements moved behind
// the factory.
//
// What it proves:
//   (a) DATASET ROUND-TRIP + SIG GATE. A full ingest() over a fixture corpus then
//       assembleDataset() yields a dataset whose session_blob-derived fields are
//       non-empty. A SECOND ingest()+assembleDataset() over the UNCHANGED corpus
//       (1) produces a byte-identical dataset (modulo the always-moving
//       `generatedAt`, which the server strips before hashing) AND (2) writes ZERO
//       session_blob rows (res.reparsed === 0) — the sig gate short-circuits the
//       parse+upsert exactly as before the extraction.
//   (b) TARGETED INVALIDATION. Editing ONE session's transcript on disk reparses
//       ONLY that session (res.reparsed === 1) and the dataset reflects exactly
//       that change (the edited session's token/timeline data moves; the untouched
//       session's data is byte-identical) — and ONLY one row's content_hash
//       changes in session_blob.
//
// The fixture builds a throwaway $HOME/.claude/projects with real session .jsonl
// transcripts so the signal parsers produce non-empty per-session rows.
// CHD_DB_PATH points ingest at a throwaway SQLite DB and HOME at the fixture —
// both read at ingest module-load, so they MUST be set before the dynamic import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fixture: a throwaway ~/.claude/projects with real session transcripts. The
// lines carry the shapes the per-session signal parsers read — assistant turns
// with usage (token data), tool_use blocks (tool data), and timestamps
// (timeline) — so every session_blob row has non-empty signal columns.
// ---------------------------------------------------------------------------
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
  return (
    [
      userLine(spec.prompt, spec.ts),
      assistantLine(spec),
    ].join('\n') + '\n'
  );
}

// Two sessions in one project, each with distinct, non-empty signal content.
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
  const home = join(tmpdir(), `chd-627s4-home-${randomUUID()}`);
  const claude = join(home, '.claude');
  const proj = join(claude, 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });
  for (const [sid, spec] of Object.entries(SESSIONS)) {
    writeFileSync(join(proj, `${sid}.jsonl`), sessionJsonl(spec));
  }
  return { home, claude, proj };
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
  return join(tmpdir(), `chd-627s4-db-${randomUUID()}.db`);
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

// The dataset's `generatedAt` is Date.now() (always moves); the server drops it
// from the stable view before hashing/comparing. Strip it so byte-comparison of
// the dataset isolates the session_blob-derived (and other deterministic) data.
function stableJson(dataset) {
  const { generatedAt: _drop, ...rest } = dataset;
  return JSON.stringify(rest);
}

// Read (session_id, content_hash) straight from session_blob to assert exactly
// which rows' content changed across ingests.
function contentHashes(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const out = {};
    for (const r of db
      .prepare('SELECT session_id, content_hash FROM session_blob ORDER BY session_id')
      .all()) {
      out[r.session_id] = r.content_hash;
    }
    return out;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// (a) DATASET ROUND-TRIP + SIG GATE (the incremental contract).
// ---------------------------------------------------------------------------
test('(a) ingest()+assembleDataset() round-trips; a second unchanged run is byte-identical AND writes ZERO session_blob rows', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });

    // First ingest: both sessions are new -> both reparsed.
    const first = ingest.ingest();
    assert.equal(
      first.reparsed,
      Object.keys(SESSIONS).length,
      `first ingest reparses every session (got ${first.reparsed})`
    );

    const cold = ingest.assembleDataset();
    // The dataset's session_blob-derived fields are non-empty (so the parity
    // comparison below is meaningful, not vacuously empty).
    assert.ok(cold.entries.length > 0, 'entries non-empty (entries signal)');
    assert.ok(cold.tokenData.length > 0, 'tokenData non-empty (token signal)');
    assert.ok(cold.timelines.length > 0, 'timelines non-empty (timeline signal)');
    const bulkTimelineEntries = cold.timelines.flatMap((timeline) => timeline.entries);
    assert.equal(
      bulkTimelineEntries.some((entry) => Object.hasOwn(entry, 'summary')),
      false,
      'bulk timelines strip every entries[].summary key'
    );
    for (const entry of bulkTimelineEntries) {
      assert.equal(typeof entry.summaryLen, 'number', 'bulk entry carries summaryLen');
      assert.equal(typeof entry.hasCode, 'boolean', 'bulk entry carries hasCode');
      assert.equal(typeof entry.isQuestion, 'boolean', 'bulk entry carries isQuestion');
    }
    assert.equal(
      cold.timelines.find((timeline) => timeline.sessionId === 'sess-alpha')
        ?.firstPromptPreview,
      SESSIONS['sess-alpha'].prompt,
      'bulk timeline carries the first prompt preview'
    );
    const alphaDetail = JSON.parse(
      ingest.getSessionTimelineDetail('sess-alpha')?.json ?? '{}'
    );
    assert.equal(
      alphaDetail.entries?.some((entry) => Object.hasOwn(entry, 'summary')),
      true,
      'per-session timeline detail keeps full summaries'
    );
    assert.deepEqual(
      cold.promptAnalysis.map((row) => row.sessionId).sort(),
      Object.keys(SESSIONS).sort(),
      'promptAnalysis has one numeric prompt-trait row per transcript session'
    );
    assert.equal(
      cold.promptAnalysis.some((row) => JSON.stringify(row).includes('alpha thing')),
      false,
      'promptAnalysis does not retain prompt prose'
    );
    const coldStable = stableJson(cold);
    const coldHashes = contentHashes(dbPath);

    // Second ingest over the UNCHANGED corpus: the sig gate short-circuits the
    // parse+upsert entirely -> ZERO session_blob rewrites (the incremental
    // contract preserved by blobCache.readSig + blobCache.upsertRow).
    const second = ingest.ingest();
    assert.equal(
      second.reparsed,
      0,
      `unchanged corpus reparses ZERO sessions (wrote ${second.reparsed} session_blob rows)`
    );
    assert.equal(second.removed, 0, 'unchanged corpus removes nothing');

    const warm = ingest.assembleDataset();
    assert.equal(
      stableJson(warm),
      coldStable,
      'second assembleDataset() is byte-identical (session_blob read path stable)'
    );
    // And the per-row content_hash set is unchanged (no row was rewritten).
    assert.deepEqual(
      contentHashes(dbPath),
      coldHashes,
      'every session_blob content_hash is unchanged after an unchanged re-ingest'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

// ---------------------------------------------------------------------------
// (b) TARGETED INVALIDATION: editing one session reparses ONLY it, and the
//     dataset reflects exactly that change.
// ---------------------------------------------------------------------------
test('(b) editing one session reparses ONLY that session; the dataset reflects exactly that change', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });
    ingest.ingest();
    const before = ingest.assembleDataset();
    const beforeHashes = contentHashes(dbPath);

    // Mutate ONLY sess-alpha (revised user prompt + assistant text). Its sig
    // (mtime+size) and content_hash both change; sess-beta is untouched. The
    // revised prompt lands in the session's `entries[].display`, so the dataset
    // change is observable from the read path.
    writeFileSync(
      join(fx.proj, 'sess-alpha.jsonl'),
      sessionJsonl({
        prompt: 'do the alpha thing REVISED',
        text: 'Alpha answer REVISED with more detail.',
        toolName: 'Read',
        toolInput: { file_path: '/tmp/a.txt' },
        ts: '2026-01-01T00:00:00.000Z',
        model: 'claude-opus-4',
      })
    );

    const res = ingest.ingest();
    assert.equal(
      res.reparsed,
      1,
      `exactly ONE session reparses after a single-session edit (got ${res.reparsed})`
    );

    // Exactly one session_blob content_hash changed — sess-alpha's.
    const afterHashes = contentHashes(dbPath);
    assert.notEqual(
      afterHashes['sess-alpha'],
      beforeHashes['sess-alpha'],
      'edited session (sess-alpha) content_hash changed'
    );
    assert.equal(
      afterHashes['sess-beta'],
      beforeHashes['sess-beta'],
      'untouched session (sess-beta) content_hash is unchanged'
    );

    // The dataset reflects exactly the edit: the new alpha text appears in an
    // entry, and the overall dataset differs from `before`.
    const after = ingest.assembleDataset();
    assert.notEqual(
      stableJson(after),
      stableJson(before),
      'the edit changed the assembled dataset'
    );
    const alphaEntry = after.entries.find(
      (e) => e.sessionId === 'sess-alpha' && /REVISED/.test(e.display ?? '')
    );
    assert.ok(alphaEntry, 'the dataset reflects the revised sess-alpha prompt');

    // The untouched session's per-session data is byte-identical across the edit.
    const tokenBefore = JSON.stringify(
      before.tokenData.filter((t) => t.sessionId === 'sess-beta')
    );
    const tokenAfter = JSON.stringify(
      after.tokenData.filter((t) => t.sessionId === 'sess-beta')
    );
    assert.equal(
      tokenAfter,
      tokenBefore,
      'untouched session (sess-beta) tokenData is byte-identical after the edit'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});
