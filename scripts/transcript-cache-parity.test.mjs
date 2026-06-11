// Round-trip + incremental-contract harness for the #627 slice-3 session-cache
// extraction (the session_transcript BLOB cache moved into
// src/lib/session-cache.ts). Run under the ts-resolver loader (the .ts parsers
// + session-cache.ts must resolve), and with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/transcript-cache-parity.test.mjs
//
// This is the load-bearing data-integrity gate for the extraction: it proves the
// transcript BLOBs survive a full ingest()->getTranscript() round-trip and that
// the content_hash gate's "zero BLOB touch" incremental contract is preserved
// byte-for-byte after the statements moved behind initTranscriptCache(db).
//
// What it proves:
//   (a) ROUND-TRIP. A full ingest() over a fixture corpus does NOT prewrite
//       transcript BLOBs; reading each back via getTranscript() materializes the
//       BLOB lazily, and brotli-decoding it yields the expected content/thinking
//       blocks, a non-empty content_hash, and non-empty stored BLOBs.
//   (b) INCREMENTAL (zero rewrite). A SECOND ingest() over the UNCHANGED corpus
//       leaves every lazily materialized transcript row byte-identical.
//   (c) TARGETED INVALIDATION. Editing ONE session's transcript on disk removes
//       ONLY that session's stale row; getTranscript() rematerializes it from the
//       current source while every other row stays byte-identical.
//
// The fixture builds a throwaway $HOME/.claude/projects with real session
// .jsonl transcripts (assistant text + tool_use + thinking blocks) so the
// transcript parser produces non-empty content AND thinking. CHD_DB_PATH points
// ingest at a throwaway SQLite DB and HOME at the fixture — both read at ingest
// module-load, so they MUST be set before the dynamic import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Fixture: a throwaway ~/.claude/projects with real session transcripts.
// ---------------------------------------------------------------------------

// One assistant turn carrying a text block, a tool_use block, and a thinking
// block — exercises both the content (text + tool_use) and thinking columns.
function assistantLine({ text, toolName, toolInput, thinking }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text },
        { type: 'tool_use', name: toolName, input: toolInput },
      ],
    },
  });
}

// A user line (no transcript content) so the session file isn't all-assistant.
function userLine(text) {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

function sessionJsonl({ text, toolName, toolInput, thinking }) {
  return (
    [
      userLine('please do the thing'),
      assistantLine({ text, toolName, toolInput, thinking }),
    ].join('\n') + '\n'
  );
}

// Two sessions in one project, each with distinct, non-empty transcripts.
const SESSIONS = {
  'sess-alpha': {
    text: 'Here is the alpha answer.',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/a.txt' },
    thinking: 'alpha reasoning about the file',
  },
  'sess-beta': {
    text: 'Beta result computed.',
    toolName: 'Bash',
    toolInput: { command: 'ls /tmp' },
    thinking: 'beta reasoning about the command',
  },
};

const ESCAPED_SURROGATE_RE = /\\ud[0-9a-f]{3}/i;

function buildFixtureHome() {
  const home = join(tmpdir(), `chd-627-home-${randomUUID()}`);
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
  return join(tmpdir(), `chd-627-db-${randomUUID()}.db`);
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

// Decode a brotli BLOB (as getTranscript returns it) back to the JSON array.
function decodeJson(buf) {
  return brotliDecompressSync(buf).toString('utf8');
}

function decode(buf) {
  return JSON.parse(decodeJson(buf));
}

// Read the raw stored row straight from SQLite — content_br/thinking_br/
// content_hash/byte_len — to assert byte-identity across ingests. The BLOBs are
// returned as Buffers; we fingerprint them with sha1 so a single string compares
// the bytes.
function rawRow(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        'SELECT content_br, thinking_br, content_hash, byte_len FROM session_transcript WHERE session_id = ?'
      )
      .get(sessionId);
    if (!row) return null;
    const fp = (b) =>
      b == null ? null : createHash('sha1').update(Buffer.from(b)).digest('hex');
    return {
      contentFp: fp(row.content_br),
      thinkingFp: fp(row.thinking_br),
      contentHash: row.content_hash,
      byteLen: row.byte_len,
    };
  } finally {
    db.close();
  }
}

function rawAll(dbPath) {
  const out = {};
  for (const sid of Object.keys(SESSIONS)) out[sid] = rawRow(dbPath, sid);
  return out;
}

// ---------------------------------------------------------------------------
// (a) ROUND-TRIP: ingest skips BLOB writes; getTranscript materializes content.
// ---------------------------------------------------------------------------
test('(a) round-trip: getTranscript() lazily stores and returns correct content/thinking/hash', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });
    const res = ingest.ingest();
    assert.equal(res.transcriptsWritten, 0, 'ingest does not prewrite transcripts');
    for (const sid of Object.keys(SESSIONS)) {
      assert.equal(rawRow(dbPath, sid), null, `no row before lazy read: ${sid}`);
    }

    for (const [sid, spec] of Object.entries(SESSIONS)) {
      const t = ingest.getTranscript(sid);
      assert.ok(t, `getTranscript returned a row for ${sid}`);
      assert.ok(t.contentBr && t.contentBr.length > 0, `${sid} content_br non-empty`);
      assert.ok(t.thinkingBr && t.thinkingBr.length > 0, `${sid} thinking_br non-empty`);
      assert.ok(
        typeof t.contentHash === 'string' && t.contentHash.length === 40,
        `${sid} content_hash is a non-empty sha1`
      );

      const content = decode(t.contentBr);
      const thinking = decode(t.thinkingBr);
      assert.equal(
        t.contentByteLen,
        Buffer.byteLength(JSON.stringify(content), 'utf8'),
        `${sid} content byte length matches stored JSON`
      );
      // content = [{type:'text',text}, {type:'tool_use',name,input}]
      assert.deepEqual(
        content,
        [
          { type: 'text', text: spec.text },
          { type: 'tool_use', name: spec.toolName, input: spec.toolInput },
        ],
        `${sid} content round-trips exactly`
      );
      assert.deepEqual(
        thinking,
        [{ type: 'thinking', thinking: spec.thinking }],
        `${sid} thinking round-trips exactly`
      );
      assert.ok(rawRow(dbPath, sid), `lazy read persisted row for ${sid}`);
    }

    // Unknown session -> null (getTranscript surface preserved).
    assert.equal(ingest.getTranscript('nope'), null, 'unknown session -> null');
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

test('(a2) strict JSON: ingest scrubs lone surrogates from per-session timeline/transcript JSON', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  const loneHigh = String.fromCharCode(0xd83d);
  const replacement = String.fromCharCode(0xfffd);
  try {
    writeFileSync(
      join(fx.proj, 'sess-lone.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-10T12:00:00.000Z',
          type: 'user',
          message: { content: `question with truncated emoji ${loneHigh}` },
        }),
        JSON.stringify({
          timestamp: '2026-06-10T12:00:01.000Z',
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: `thinking with truncated emoji ${loneHigh}` },
              { type: 'text', text: `answer with truncated emoji ${loneHigh}` },
              { type: 'tool_use', name: 'Bash', input: { command: 'printf ok' } },
            ],
          },
        }),
      ].join('\n') + '\n'
    );

    const ingest = await loadIngest({ home: fx.home, dbPath });
    ingest.ingest();

    const detail = ingest.getSessionTimelineDetail('sess-lone');
    assert.ok(detail, 'timeline detail row was persisted');
    assert.equal(
      ESCAPED_SURROGATE_RE.test(detail.json),
      false,
      'stored timeline JSON has no lone-surrogate escape'
    );
    const timeline = JSON.parse(detail.json);
    const summaries = timeline.entries.map((entry) => entry.summary).join('\n');
    assert.equal(
      summaries.includes(replacement),
      true,
      'timeline summary replaced the lone surrogate'
    );

    const transcript = ingest.getTranscript('sess-lone');
    assert.ok(transcript, 'transcript row was materialized');
    const contentJson = decodeJson(transcript.contentBr);
    const thinkingJson = decodeJson(transcript.thinkingBr);
    assert.equal(
      ESCAPED_SURROGATE_RE.test(contentJson),
      false,
      'stored transcript content JSON has no lone-surrogate escape'
    );
    assert.equal(
      ESCAPED_SURROGATE_RE.test(thinkingJson),
      false,
      'stored transcript thinking JSON has no lone-surrogate escape'
    );

    const content = JSON.parse(contentJson);
    const thinking = JSON.parse(thinkingJson);
    assert.equal(
      content[0].text.includes(replacement),
      true,
      'transcript content replaced the lone surrogate'
    );
    assert.equal(
      thinking[0].thinking.includes(replacement),
      true,
      'transcript thinking replaced the lone surrogate'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

// ---------------------------------------------------------------------------
// (b) INCREMENTAL: a second unchanged ingest() rewrites ZERO transcript rows.
// ---------------------------------------------------------------------------
test('(b) incremental: a second unchanged ingest() leaves every transcript row byte-identical (content_hash gate)', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });

    const first = ingest.ingest();
    assert.equal(first.transcriptsWritten, 0, 'first ingest skipped transcript writes');
    for (const sid of Object.keys(SESSIONS)) {
      assert.ok(ingest.getTranscript(sid), `lazy read materialized ${sid}`);
    }
    const before = rawAll(dbPath);
    for (const sid of Object.keys(SESSIONS)) {
      assert.ok(before[sid], `row present after first ingest: ${sid}`);
    }

    // Second ingest, nothing changed on disk. The sig gate skips re-ingesting
    // the sessions at all, so the content_hash gate's zero-touch holds and the
    // rows are byte-identical.
    const second = ingest.ingest();
    assert.equal(
      second.transcriptsWritten,
      0,
      `unchanged corpus rewrites ZERO transcripts; rewrote ${second.transcriptsWritten}`
    );
    const after = rawAll(dbPath);
    assert.deepEqual(
      after,
      before,
      'every transcript row (content_br/thinking_br/content_hash/byte_len) is byte-identical after an unchanged re-ingest'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});

// ---------------------------------------------------------------------------
// (c) TARGETED INVALIDATION: editing one session invalidates ONLY its row.
// ---------------------------------------------------------------------------
test('(c) editing one session invalidates ONLY that transcript row; others stay byte-identical', async () => {
  const fx = buildFixtureHome();
  const dbPath = newDbPath();
  const origHome = process.env.HOME;
  try {
    const ingest = await loadIngest({ home: fx.home, dbPath });
    ingest.ingest();
    for (const sid of Object.keys(SESSIONS)) {
      assert.ok(ingest.getTranscript(sid), `lazy read materialized ${sid}`);
    }
    const before = rawAll(dbPath);

    // Mutate ONLY sess-alpha's transcript (new assistant text/thinking). Its sig
    // (mtime+size) and content_hash both change; sess-beta is untouched.
    writeFileSync(
      join(fx.proj, 'sess-alpha.jsonl'),
      sessionJsonl({
        text: 'Alpha answer REVISED.',
        toolName: 'Read',
        toolInput: { file_path: '/tmp/a.txt' },
        thinking: 'alpha reasoning, now different',
      })
    );

    const res = ingest.ingest();
    assert.equal(
      res.transcriptsWritten,
      0,
      `ingest invalidates stale transcript rows without prewriting; rewrote ${res.transcriptsWritten}`
    );

    const invalidated = rawAll(dbPath);
    assert.equal(
      invalidated['sess-alpha'],
      null,
      'edited session (sess-alpha) row was invalidated'
    );
    assert.deepEqual(
      invalidated['sess-beta'],
      before['sess-beta'],
      'untouched session (sess-beta) row is byte-identical before lazy reread'
    );

    // The next transcript read rematerializes the edited session from source.
    const t = ingest.getTranscript('sess-alpha');
    assert.deepEqual(decode(t.contentBr)[0], {
      type: 'text',
      text: 'Alpha answer REVISED.',
    });
    const after = rawAll(dbPath);
    assert.notDeepEqual(
      after['sess-alpha'],
      before['sess-alpha'],
      'edited session (sess-alpha) row changed after lazy reread'
    );
    assert.deepEqual(
      after['sess-beta'],
      before['sess-beta'],
      'untouched session (sess-beta) row is byte-identical'
    );
  } finally {
    process.env.HOME = origHome;
    delete process.env.CHD_DB_PATH;
    cleanup(fx.home, dbPath);
  }
});
