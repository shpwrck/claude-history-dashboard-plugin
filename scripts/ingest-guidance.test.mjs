// Unit tests for the guidance ingestion script (#1303/#1407): per-page
// conditional fetch (a primary-page 304 must not mask fact-page drift),
// redirect allowlist enforcement, HTML entity/comment handling, and the
// drift/staleness report. Inline fixtures only — nothing here couples CI to
// the committed scraped prose.
//
// Run: npm run test:ingest-guidance
//   (node --import ./scripts/register-ts.mjs --test scripts/ingest-guidance.test.mjs)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const {
  buildSnapshot,
  formatGuidanceReport,
  htmlToText,
  ingestGuidance,
  readResponseTextCapped,
  GUIDANCE_PAGE_MAX_BYTES,
  GUIDANCE_PAGE_TOO_LARGE_CODE,
  STALE_AFTER_DAYS,
} = await import('./ingest-guidance.mjs');
const { extractUsageLimitFacts } = await import(
  '../src/lib/external-guidance-registry.ts'
);

const sha256 = (text) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

const PRIMARY = 'https://support.claude.com/en/articles/1-primary';
const FACTS = 'https://support.claude.com/en/articles/2-facts';

const article = {
  id: 'fixture-article',
  source: 'anthropic-support',
  url: PRIMARY,
  factUrls: [FACTS],
  target: { detectorId: 'reliability.rate-limits' },
  suggestion: 'Read the fixture guidance.',
  extractFacts: extractUsageLimitFacts,
};

/** Map of url -> responder; a responder sees the request headers. */
function fakeFetch(routes) {
  return async (url, { headers } = {}) => {
    const responder = routes[url];
    if (!responder) throw new Error(`unexpected fetch: ${url}`);
    const r = typeof responder === 'function' ? responder(headers) : responder;
    return {
      ok: r.status ? r.status >= 200 && r.status < 300 : true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      url: r.finalUrl ?? url,
      headers: { get: (name) => r.headers?.[name.toLowerCase()] ?? null },
      text: async () => r.body ?? '',
    };
  };
}

const page = (html) => ({ body: html, headers: { etag: '"v1"' } });

// A minimal Response double exposing a ReadableStream-like `body` that yields
// `text` in fixed chunks, plus optional headers. `pulled()` reports how many
// bytes were actually read, so a test can prove an oversized body aborts EARLY
// rather than being materialized in full (#3088).
function streamResponse(text, { headers = {}, chunkSize = 8 } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  let pulled = 0;
  let cancelled = false;
  const response = {
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || offset >= bytes.length) return { done: true };
            const end = Math.min(offset + chunkSize, bytes.length);
            const value = Uint8Array.prototype.slice.call(bytes, offset, end);
            offset = end;
            pulled += value.byteLength;
            return { done: false, value };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  };
  return { response, pulled: () => pulled };
}

test('readResponseTextCapped rejects an over-Content-Length page before reading a byte (#3088)', async () => {
  const { response, pulled } = streamResponse('x'.repeat(100), {
    headers: { 'content-length': String(GUIDANCE_PAGE_MAX_BYTES + 1) },
  });
  await assert.rejects(
    () => readResponseTextCapped(response, GUIDANCE_PAGE_MAX_BYTES, PRIMARY),
    (err) => err.code === GUIDANCE_PAGE_TOO_LARGE_CODE
  );
  // The up-front declared-size check fires before the body stream is touched.
  assert.equal(pulled(), 0);
});

test('readResponseTextCapped aborts a streamed body once it passes the cap, without reading it all (#3088)', async () => {
  const cap = 16;
  // 200 bytes in 8-byte chunks; the cap is passed after the 3rd chunk (24 > 16).
  const { response, pulled } = streamResponse('a'.repeat(200), { chunkSize: 8 });
  await assert.rejects(
    () => readResponseTextCapped(response, cap, PRIMARY),
    (err) => err.code === GUIDANCE_PAGE_TOO_LARGE_CODE
  );
  // Aborted early: only enough chunks to cross the cap were pulled, never all 200.
  assert.ok(pulled() <= cap + 8, `pulled ${pulled()} bytes, expected <= ${cap + 8}`);
  assert.ok(pulled() < 200);
});

test('readResponseTextCapped accepts a body exactly at the limit (#3088 boundary)', async () => {
  const cap = 32;
  const exact = 'b'.repeat(cap);
  const { response } = streamResponse(exact, { chunkSize: 8 });
  const out = await readResponseTextCapped(response, cap, PRIMARY);
  assert.equal(out, exact);
});

test('buildSnapshot rejects with the stable size-limit error when a page is over budget (#3088)', async () => {
  const now = new Date('2026-06-12T00:00:00Z');
  const fetchImpl = async (url) => {
    // Declare a Content-Length past the real default budget; buildSnapshot must
    // reject rather than ingest the page.
    const { response } = streamResponse('<h1>huge</h1>', {
      headers: { 'content-length': String(GUIDANCE_PAGE_MAX_BYTES + 1) },
    });
    return { ...response, ok: true, status: 200, url };
  };
  await assert.rejects(
    () => buildSnapshot(article, null, now, fetchImpl),
    (err) => err.code === GUIDANCE_PAGE_TOO_LARGE_CODE
  );
});

test('htmlToText decodes entities safely', () => {
  // &amp;lt; is the ESCAPED text "&lt;" — it must NOT double-decode into "<".
  assert.equal(htmlToText('<p>a &amp;lt; b</p>'), 'a &lt; b');
  // Same property for the NUMERIC ampersand form: &#38;amp; displays "&amp;".
  assert.equal(htmlToText('<p>a &#38;amp; b</p>'), 'a &amp; b');
  assert.equal(htmlToText('<p>a &#38;lt; b</p>'), 'a &lt; b');
  assert.equal(htmlToText('<p>a &#x26;lt; b</p>'), 'a &lt; b');
  assert.equal(htmlToText('<p>5 &lt; 6 &amp; 7 &gt; 2</p>'), '5 < 6 & 7 > 2');
  // A malformed numeric entity must not abort ingestion (fromCodePoint RangeError).
  assert.equal(htmlToText('<p>bad &#1114112; entity</p>'), 'bad &#1114112; entity');
  assert.equal(htmlToText('<p>ok &#233;</p>'), 'ok é');
});

test('htmlToText strips comments before tags so a ">" inside a comment cannot leak', () => {
  assert.equal(
    htmlToText('<p>before</p><!-- a > b --><p>after</p>'),
    'before after'
  );
  assert.equal(htmlToText('<script>x > 1</script>rest'), 'rest');
});

test('buildSnapshot writes per-page provenance and per-article facts', async () => {
  const fetchImpl = fakeFetch({
    [PRIMARY]: page('<h1>Primary</h1><p>Overview of limits.</p>'),
    [FACTS]: page('<h1>Facts</h1><p>Resets every five hours. Weekly limits apply.</p>'),
  });
  const now = new Date('2026-06-12T00:00:00Z');
  const { changed, snapshot } = await buildSnapshot(article, null, now, fetchImpl);

  assert.equal(changed, true);
  assert.equal(snapshot.pages.length, 2);
  assert.deepEqual(
    snapshot.pages.map((p) => p.url),
    [PRIMARY, FACTS]
  );
  for (const p of snapshot.pages) {
    assert.equal(p.contentHash, sha256(p.content));
  }
  // Facts come from the registered per-article extractor over the combined text.
  assert.deepEqual(snapshot.facts, {
    rollingWindowHours: 5,
    hasWeeklyLimit: true,
  });
});

test('a 304 on the primary page does NOT mask fact-page drift (#1303)', async () => {
  const now = new Date('2026-06-12T00:00:00Z');
  const v1 = await buildSnapshot(
    article,
    null,
    now,
    fakeFetch({
      [PRIMARY]: page('<h1>Primary</h1><p>stable</p>'),
      [FACTS]: page('<h1>Facts</h1><p>old fact</p>'),
    })
  );

  const later = new Date('2026-06-13T00:00:00Z');
  const v2 = await buildSnapshot(
    article,
    v1.snapshot,
    later,
    fakeFetch({
      [PRIMARY]: (headers) => {
        // The primary page revalidates via its stored etag...
        assert.equal(headers['if-none-match'], '"v1"');
        return { status: 304 };
      },
      // ...while the fact page drifted.
      [FACTS]: page('<h1>Facts</h1><p>NEW fact</p>'),
    })
  );

  assert.equal(v2.changed, true);
  assert.deepEqual(v2.changedPages, [FACTS]);
  // The unchanged primary page is reused verbatim; drift localizes to page 2.
  assert.equal(v2.snapshot.pages[0].contentHash, v1.snapshot.pages[0].contentHash);
  assert.notEqual(v2.snapshot.pages[1].contentHash, v1.snapshot.pages[1].contentHash);
});

test('all pages 304 means no drift', async () => {
  const now = new Date('2026-06-12T00:00:00Z');
  const v1 = await buildSnapshot(
    article,
    null,
    now,
    fakeFetch({
      [PRIMARY]: page('<h1>Primary</h1><p>stable</p>'),
      [FACTS]: page('<h1>Facts</h1><p>stable too</p>'),
    })
  );
  const v2 = await buildSnapshot(
    article,
    v1.snapshot,
    new Date('2026-06-13T00:00:00Z'),
    fakeFetch({
      [PRIMARY]: { status: 304 },
      [FACTS]: { status: 304 },
    })
  );
  assert.equal(v2.changed, false);
  assert.equal(v2.snapshot, v1.snapshot);
});

test('a redirect landing off-allowlist is rejected', async () => {
  await assert.rejects(
    buildSnapshot(
      article,
      null,
      new Date(),
      fakeFetch({
        [PRIMARY]: {
          body: '<h1>Moved</h1>',
          finalUrl: 'https://evil.example/landing',
        },
        [FACTS]: page('<h1>Facts</h1>'),
      })
    ),
    /outside anthropic-support's allowlist/
  );
});

test('an off-allowlist registry url is rejected before any fetch', async () => {
  await assert.rejects(
    buildSnapshot(
      { ...article, factUrls: ['https://evil.example/x'] },
      null,
      new Date(),
      fakeFetch({ [PRIMARY]: page('<h1>P</h1>') })
    ),
    /outside anthropic-support's allowlist/
  );
});

test('ingestGuidance writes snapshots, reports drift and staleness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guidance-ingest-'));
  try {
    const now = new Date('2026-06-12T00:00:00Z');
    const first = await ingestGuidance({
      now,
      snapshotDir: dir,
      articles: [article],
      fetchImpl: fakeFetch({
        [PRIMARY]: page('<h1>Primary</h1><p>v1</p>'),
        [FACTS]: page('<h1>Facts</h1><p>v1</p>'),
      }),
    });
    assert.equal(first[0].changed, true);
    const written = JSON.parse(
      await readFile(join(dir, 'fixture-article.json'), 'utf8')
    );
    assert.equal(written.id, 'fixture-article');
    assert.equal(written.pages.length, 2);
    assert.match(formatGuidanceReport(first), /Drift detected in 1 snapshot/);

    // A much later run with unchanged content reports staleness, not drift.
    const muchLater = new Date(
      now.getTime() + (STALE_AFTER_DAYS + 2) * 86_400_000
    );
    const second = await ingestGuidance({
      now: muchLater,
      snapshotDir: dir,
      articles: [article],
      fetchImpl: fakeFetch({
        [PRIMARY]: { status: 304 },
        [FACTS]: { status: 304 },
      }),
    });
    assert.equal(second[0].changed, false);
    assert.equal(second[0].stale, true);
    const report = formatGuidanceReport(second);
    assert.match(report, /No guidance drift/);
    assert.match(report, /Stale snapshots/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
