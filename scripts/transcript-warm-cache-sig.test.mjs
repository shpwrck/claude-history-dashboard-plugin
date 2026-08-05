#!/usr/bin/env node
// #3634: getTranscript()'s warm-cache gate must actually HIT. Run under the
// ts-resolver loader with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/transcript-warm-cache-sig.test.mjs
//
// The bug this locks down: the gate compared a signature built by one
// constructor against a signature built by a DIFFERENT one — `parser:<v>|
// path:mtime:size[:ctime]|...` (the session_blob row) versus
// `path:mtime:size|...#<PARSER_SIG_VERSION>` (a local mtime+size builder). Both
// encode "which bytes is this derived from", but they can never be byte-equal,
// so the gate missed unconditionally and every transcript read re-read and
// re-brotli'd the source. Correctness was never at risk (the miss direction is
// always fresh), which is exactly why nothing caught it: the only observable is
// COST. So this suite asserts cost directly, via the byte-read counter
// ingest.mjs exposes for the getTranscript read path.
//
// What it proves:
//   (a) CANONICAL BY CONSTRUCTION. The signature STAMPED on the stored BLOBs is
//       byte-equal to the one recomputed from the session's files by the
//       exported canonical parts — the format drift itself, not just its
//       symptom. It is deliberately NOT the session_blob row's sig (the two
//       caches gate different artifacts and must not be collapsed).
//   (b) WARM HIT AT ZERO COST. A second read of an UNCHANGED transcript opens
//       zero source files and returns byte-identical blobs.
//   (c) STILL MISSES WHEN CHANGED. An edited transcript re-reads exactly once
//       and serves the new content.
//   (d) #3401 REWRITE DETECTION SURVIVES. A same-SIZE, same-MTIME in-place
//       rewrite (mtime restored via utimes; only ctime moves) still MISSES and
//       serves the new content. The predecessor gate hashed only mtime+size, so
//       folding the canonical identity in STRENGTHENS this gate rather than
//       weakening it.
//   (e) THE GATE RE-ARMS. A touch that leaves the extracted transcript
//       byte-identical takes the content_hash "zero BLOB touch" path — and must
//       still advance the stored signature, or the cache would re-read that
//       session's file on every subsequent call forever (the original bug in
//       miniature).
//   (f) EMPTY EXTRACTIONS ARM THE GATE TOO (#3652). A session whose extracted
//       transcript is empty (no assistant turns) used to delete the row and
//       stamp nothing, so readTranscriptSig stayed null and EVERY later call
//       re-read the source in full — the same bug through the empty branch.
//       An empty extraction now stamps a NULL-BLOB tombstone carrying the sig:
//       one source read, then every later call is free and still returns null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

// Fixed epoch second used to pin (and later restore) the transcript mtime. An
// integer keeps mtimeMs exactly reproducible across the two utimes calls, so
// case (d)'s rewrite is genuinely invisible to a size+mtime-only gate.
const PINNED_EPOCH_S = 1_750_000_000;

const SESSION_ID = 'sess-warm';

// The two transcript bodies differ in content but NOT in byte length, so a
// rewrite from one to the other moves neither size nor (once utimes restores
// it) mtime. Asserted in the fixture, not just intended.
const TEXT_ORIGINAL = 'alpha answer AAAA';
const TEXT_REWRITTEN = 'alpha answer BBBB';
const THINKING = 'alpha reasoning about the file';

function sessionJsonl(text, thinking = THINKING) {
  return (
    [
      JSON.stringify({ type: 'user', message: { content: 'please do the thing' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking },
            { type: 'text', text },
          ],
        },
      }),
    ].join('\n') + '\n'
  );
}

// Write the transcript and pin its mtime, so every later comparison is against
// a known-fixed value rather than wall-clock timing.
function writePinned(filePath, body) {
  writeFileSync(filePath, body);
  utimesSync(filePath, PINNED_EPOCH_S, PINNED_EPOCH_S);
}

function buildFixture() {
  const home = join(tmpdir(), `chd-3634-home-${randomUUID()}`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });
  const topPath = join(proj, `${SESSION_ID}.jsonl`);
  writePinned(topPath, sessionJsonl(TEXT_ORIGINAL));
  return { home, proj, topPath };
}

// HOME + CHD_DB_PATH are read at ingest module load, so they must be set before
// the dynamic import; the cache-buster keeps each import a fresh module (and a
// fresh DB binding + a fresh read counter).
async function loadIngest(home, dbPath) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = dbPath;
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

function decode(buf) {
  return JSON.parse(brotliDecompressSync(Buffer.from(buf)).toString('utf8'));
}

function transcriptText(row) {
  return decode(row.contentBr).find((b) => b.type === 'text')?.text ?? null;
}

// Read the gate columns straight from SQLite — the stamped signature is not on
// the public read shape, and case (a) needs the stored bytes themselves.
function storedGate(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare(
          'SELECT sig, content_hash FROM session_transcript WHERE session_id = ?'
        )
        .get(sessionId) ?? null
    );
  } finally {
    db.close();
  }
}

function storedBlobSig(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare('SELECT sig FROM session_blob WHERE session_id = ?').get(sessionId) ??
      null
    );
  } finally {
    db.close();
  }
}

// Run `fn` and report how many transcript source files it opened for byte reads.
function readsDuring(ingest, fn) {
  ingest._resetTranscriptSourceReadCount();
  const value = fn();
  return { value, reads: ingest._getTranscriptSourceReadCount() };
}

async function withFixture(run) {
  const fx = buildFixture();
  const dbPath = join(tmpdir(), `chd-3634-db-${randomUUID()}.db`);
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  try {
    await run({ ...fx, dbPath, ingest: await loadIngest(fx.home, dbPath) });
  } finally {
    process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    rmSync(fx.home, { recursive: true, force: true });
    rmSync(dbPath, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) + (b): one canonical constructor, and the warm read costs nothing.
// ---------------------------------------------------------------------------
test('(a+b) the stamped signature is canonical, and an unchanged second read HITS with zero byte reads (#3634)', async () => {
  await withFixture(({ ingest, dbPath, topPath }) => {
    // Cold: nothing stored yet, so the first read must go to the file.
    const cold = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.ok(cold.value, 'cold read materialized a transcript');
    assert.equal(cold.reads, 1, 'the cold read opens the source exactly once');
    assert.equal(transcriptText(cold.value), TEXT_ORIGINAL);

    // (a) The stored signature is what the canonical constructor produces for
    // this session's files — the assertion the format drift would have failed.
    const gate = storedGate(dbPath, SESSION_ID);
    assert.equal(
      gate.sig,
      `${ingest.sessionFileSignature({ topPath, subPaths: [] })}#${ingest.PARSER_SIG_VERSION}`,
      'stored sig is sessionFileSignature() + the transcript parser knob'
    );
    // Both halves are load-bearing: the per-file identity (with #3401's ctime
    // discriminator) and the transcript-cache invalidation knob.
    assert.match(
      gate.sig,
      new RegExp(`:\\d+:\\d+:\\d+(?:\\.\\d+)?#${ingest.PARSER_SIG_VERSION}$`),
      'sig carries the per-file mtime:size:ctime triple'
    );
    assert.ok(
      gate.sig.endsWith(`#${ingest.PARSER_SIG_VERSION}`),
      'sig folds in PARSER_SIG_VERSION so a transcript-extraction change invalidates'
    );

    // Pin the EXACT relationship to the session_blob row's signature: the
    // transcript sig is that string plus the transcript knob as a suffix. That
    // is what makes the two keys distinct without being independent — and it
    // is the relationship the old gate got wrong by comparing them raw.
    ingest.ingest();
    const blobSig = storedBlobSig(dbPath, SESSION_ID);
    assert.ok(blobSig, 'ingest wrote a session_blob row');
    assert.equal(
      gate.sig,
      `${blobSig.sig}#${ingest.PARSER_SIG_VERSION}`,
      'transcript sig = session_blob sig + the transcript-parser suffix'
    );

    // (b) THE FIX. Re-read the unchanged transcript: zero source files opened.
    // (ingest() above invalidated the lazily built blob, so re-materialize it
    // first and then assert the steady-state read.)
    ingest.getTranscript(SESSION_ID);
    const warm = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(
      warm.reads,
      0,
      'an unchanged transcript must not be re-read on the warm path'
    );
    assert.ok(warm.value, 'the warm read still returns the transcript');
    assert.equal(transcriptText(warm.value), TEXT_ORIGINAL);
    assert.deepEqual(
      Buffer.from(warm.value.contentBr),
      Buffer.from(cold.value.contentBr),
      'the warm read serves the byte-identical stored BLOB'
    );
    assert.equal(warm.value.contentHash, cold.value.contentHash);

    // And it stays hot: a third read is free too (no read-once-then-thrash).
    const third = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(third.reads, 0, 'the warm path stays hot across repeated reads');
  });
});

// ---------------------------------------------------------------------------
// (c): the gate still discriminates — a changed transcript MISSES.
// ---------------------------------------------------------------------------
test('(c) an edited transcript still MISSES and serves the new content (#3634)', async () => {
  await withFixture(({ ingest, topPath }) => {
    assert.ok(ingest.getTranscript(SESSION_ID));
    assert.equal(
      readsDuring(ingest, () => ingest.getTranscript(SESSION_ID)).reads,
      0,
      'baseline: the warm path is hot before the edit'
    );

    // A genuine edit: new text AND a new mtime.
    writeFileSync(topPath, sessionJsonl('alpha answer REVISED, and longer now'));

    const after = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(after.reads, 1, 'a changed transcript is re-read exactly once');
    assert.equal(
      transcriptText(after.value),
      'alpha answer REVISED, and longer now',
      'the miss serves the edited content, not the stale BLOB'
    );

    // ...and the gate re-arms on the new content.
    assert.equal(
      readsDuring(ingest, () => ingest.getTranscript(SESSION_ID)).reads,
      0,
      'the rebuilt transcript is warm again'
    );
  });
});

// ---------------------------------------------------------------------------
// (d): #3401's same-size/same-mtime rewrite detection is preserved.
// ---------------------------------------------------------------------------
test('(d) a same-size, mtime-restored in-place rewrite still MISSES (#3401 detection preserved)', async () => {
  await withFixture(({ ingest, topPath }) => {
    const before = statSync(topPath);
    assert.ok(ingest.getTranscript(SESSION_ID));
    assert.equal(
      readsDuring(ingest, () => ingest.getTranscript(SESSION_ID)).reads,
      0,
      'baseline: the warm path is hot before the rewrite'
    );

    // Rewrite in place to the SAME byte length, then put mtime back exactly
    // where it was. Only ctime moves — no unprivileged syscall can restore it.
    const rewritten = sessionJsonl(TEXT_REWRITTEN);
    assert.equal(
      Buffer.byteLength(rewritten, 'utf8'),
      before.size,
      'the fixture rewrite must be the same byte length to be a real test'
    );
    writeFileSync(topPath, rewritten);
    utimesSync(topPath, PINNED_EPOCH_S, PINNED_EPOCH_S);
    const after = statSync(topPath);
    assert.equal(after.size, before.size, 'size is unchanged by the rewrite');
    assert.equal(after.mtimeMs, before.mtimeMs, 'utimes restored the exact mtime');

    const read = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(
      read.reads,
      1,
      'a same-size, same-mtime rewrite must still invalidate the warm cache'
    );
    assert.equal(
      transcriptText(read.value),
      TEXT_REWRITTEN,
      'the rewritten content is served, never the stale BLOB'
    );
  });
});

// ---------------------------------------------------------------------------
// (e): the "zero BLOB touch" path must still advance the gate.
// ---------------------------------------------------------------------------
test('(e) a touch that re-extracts byte-identically re-arms the gate instead of re-reading forever (#3634)', async () => {
  await withFixture(({ ingest, dbPath, topPath }) => {
    const first = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(first.reads, 1);
    const originalGate = storedGate(dbPath, SESSION_ID);

    // Move the file's identity without changing a byte of its content: the
    // extracted transcript hashes identically, so persistTranscript takes its
    // zero-BLOB-touch short circuit.
    utimesSync(topPath, PINNED_EPOCH_S + 60, PINNED_EPOCH_S + 60);

    const touched = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(touched.reads, 1, 'a moved identity re-reads once');
    const refreshed = storedGate(dbPath, SESSION_ID);
    assert.equal(
      refreshed.content_hash,
      originalGate.content_hash,
      'the BLOBs were not rewritten (content_hash gate held)'
    );
    assert.notEqual(
      refreshed.sig,
      originalGate.sig,
      'the stored signature advanced to the new file identity'
    );

    // The point of (e): without the signature refresh this read would miss
    // again, and keep missing on every call for the life of the process.
    assert.equal(
      readsDuring(ingest, () => ingest.getTranscript(SESSION_ID)).reads,
      0,
      'the gate re-armed — no perpetual re-read after a zero-BLOB-touch persist'
    );
  });
});

// ---------------------------------------------------------------------------
// (f): an empty extraction stamps a tombstone instead of leaving the gate
//      unarmed (#3652).
// ---------------------------------------------------------------------------
test('(f) an empty-extraction session reads the source once, then serves null for free (#3652)', async () => {
  await withFixture(({ ingest, dbPath, topPath }) => {
    // Materialize the non-empty transcript first, then empty it on disk — the
    // emptied-transcript cleanup path must also arm the gate, not just drop
    // the stale BLOBs.
    assert.ok(ingest.getTranscript(SESSION_ID));
    writeFileSync(
      topPath,
      JSON.stringify({ type: 'user', message: { content: 'only a question' } }) + '\n'
    );

    const emptied = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(emptied.reads, 1, 'the emptied transcript is re-read exactly once');
    assert.equal(emptied.value, null, 'an empty extraction serves no transcript');

    // The tombstone: no BLOBs, no hash, but a live signature from the one
    // canonical constructor — the row exists purely to keep the gate armed.
    const gate = storedGate(dbPath, SESSION_ID);
    assert.ok(gate, 'a tombstone row survives the emptied-transcript cleanup');
    assert.equal(gate.content_hash, null, 'the tombstone stores no content hash');
    assert.equal(
      gate.sig,
      `${ingest.sessionFileSignature({ topPath, subPaths: [] })}#${ingest.PARSER_SIG_VERSION}`,
      'the tombstone sig is canonical, same as a real row'
    );

    // The point of (f): three consecutive calls cost exactly the one source
    // read above — the pre-fix behavior re-read on every single call.
    for (const nth of ['second', 'third']) {
      const later = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
      assert.equal(later.reads, 0, `the ${nth} call must not re-read the source`);
      assert.equal(later.value, null, `the ${nth} call still reports no transcript`);
    }

    // And the tombstone still discriminates: content coming back misses once
    // and serves the revived transcript.
    writeFileSync(topPath, sessionJsonl('the answer returned'));
    const revived = readsDuring(ingest, () => ingest.getTranscript(SESSION_ID));
    assert.equal(revived.reads, 1, 'a revived transcript is re-read exactly once');
    assert.equal(transcriptText(revived.value), 'the answer returned');
    assert.equal(
      readsDuring(ingest, () => ingest.getTranscript(SESSION_ID)).reads,
      0,
      'the revived transcript is warm again'
    );
  });
});
