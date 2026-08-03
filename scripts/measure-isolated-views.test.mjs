// Guards the fail-closed target verification in measure-isolated-views.mjs
// (#3091, plus the #3394 review follow-ups). The benchmark used to treat "the
// port is busy" as "the intended preview is running" and measure whatever
// answered, while the report claimed an isolated SPA run over an 18-session
// sample corpus.
//
// Occupancy is not identity, and neither is shape. These tests prove:
//   - an unrelated responder is REJECTED before any browser launches;
//   - a generic built Vite/React app (a #root div + a hashed /assets/*.js) is
//     NOT accepted as this dashboard — a product-specific marker must match;
//   - a body that is not a real ZIP archive is NOT accepted as the corpus,
//     including the SPA-fallback index.html that `vite preview` returns with
//     HTTP 200 for the absent /sample-data.zip under `npm run build:spa`;
//   - a verified preview yields build + corpus identifiers read from the
//     response;
//   - an unverifiable corpus or build ABORTS the run before any measurement,
//     and the error names `npm run build:sample` — the one mode that emits the
//     archive. Labelling the corpus UNVERIFIED and measuring anyway caveats the
//     problem instead of cutting it: without the archive the SPA renders the
//     EMPTY upload-first UI, so the numbers are not this benchmark at all.
//
// Run: node --test scripts/measure-isolated-views.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyPreviewShell,
  corpusIdentity,
  verifyTarget,
  expectedShellTitle,
  CORPUS_BUILD_COMMAND,
  VIEWS_TO_MEASURE,
  assertViewIdentity,
  runWithCleanup,
  stopPreview,
} from './measure-isolated-views.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');

const TITLE = expectedShellTitle(PROJECT_DIR);
const OPTS = { expectedTitle: TITLE };

const shell = (title) =>
  '<!doctype html><html><head>' +
  (title === null ? '' : `<title>${title}</title>`) +
  '<script type="module" crossorigin src="/assets/index-D1e2F3g4.js"></script>' +
  '</head><body><div id="root"></div></body></html>';

const SPA_SHELL = shell(TITLE);
// The shape EVERY built Vite + React app has: a #root mount and a hashed entry.
const GENERIC_VITE_APP = shell('Some Other Vite App');
// A real (tiny) ZIP body: local file header magic PK\x03\x04.
const ZIP_BODY = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('rest of an archive'),
]);

test('the Context benchmark uses the real route, all-time sample window, and a resize budget', () => {
  const contextView = VIEWS_TO_MEASURE.find((view) => view.name === 'Context Health');
  assert.deepEqual(contextView, {
    name: 'Context Health',
    hash: '#/context?time=all',
    expectedHeading: 'Context Health',
    expectedSessionCount: 18,
    expandControl: 'Session detail',
    resizeBudgetMs: 100,
  });
});

test('assertViewIdentity accepts the expected route and sample workload', () => {
  assert.doesNotThrow(() =>
    assertViewIdentity(
      {
        name: 'Context Health',
        expectedHeading: 'Context Health',
        expectedSessionCount: 18,
      },
      { heading: 'Context Health', sessionCount: 18 }
    )
  );
});

test('assertViewIdentity rejects a route that rendered the wrong h1', () => {
  assert.throws(
    () =>
      assertViewIdentity(
        { name: 'Context Health', expectedHeading: 'Context Health' },
        { heading: 'Overview', sessionCount: 18 }
      ),
    /expected h1.*Context Health.*Overview/
  );
});

test('assertViewIdentity rejects the wrong sample session window', () => {
  assert.throws(
    () =>
      assertViewIdentity(
        {
          name: 'Context Health',
          expectedHeading: 'Context Health',
          expectedSessionCount: 18,
        },
        { heading: 'Context Health', sessionCount: 5 }
      ),
    /expected 18 sessions.*observed 5/
  );
});

test('runWithCleanup always cleans up and preserves the primary failure', async () => {
  const primary = new Error('wrong route');
  const cleanup = new Error('cleanup also failed');
  let cleaned = false;

  await assert.rejects(
    () =>
      runWithCleanup(
        async () => {
          throw primary;
        },
        async () => {
          cleaned = true;
          throw cleanup;
        }
      ),
    (error) => error === primary
  );
  assert.equal(cleaned, true);
});

test('stopPreview terminates and reaps the preview child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise((resolve) => child.once('spawn', resolve));

  await stopPreview(child);

  assert.notEqual(child.signalCode ?? child.exitCode, null);
});

test("expectedShellTitle: reads this repo's own product marker out of index.html", () => {
  assert.equal(typeof TITLE, 'string');
  assert.ok(TITLE.length > 0);
  // It really is the repo's title, not an invented constant.
  const html = readFileSync(join(PROJECT_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes(`<title>${TITLE}</title>`), 'title must come from index.html');
  // An unreadable project dir yields null, which callers must treat as "cannot
  // verify" rather than "verified".
  assert.equal(expectedShellTitle(join(PROJECT_DIR, 'no-such-dir-xyz')), null);
});

test('verifyPreviewShell: accepts the SPA shell and reports the hashed entry as the build id', () => {
  const v = verifyPreviewShell(
    { status: 200, contentType: 'text/html; charset=utf-8', body: SPA_SHELL },
    OPTS
  );
  assert.deepEqual(v, { ok: true, build: '/assets/index-D1e2F3g4.js' });
});

// Review P2: shape alone identifies a bundler, not this product.
test('verifyPreviewShell: a generic built Vite/React app is NOT this dashboard', () => {
  const v = verifyPreviewShell(
    { status: 200, contentType: 'text/html', body: GENERIC_VITE_APP },
    OPTS
  );
  assert.equal(
    v.ok,
    false,
    'a #root div plus a hashed /assets/*.js entry must not pass as this dashboard'
  );
  assert.match(v.reason, /different app/);

  // Same shape, no title at all.
  const untitled = verifyPreviewShell(
    { status: 200, contentType: 'text/html', body: shell(null) },
    OPTS
  );
  assert.equal(untitled.ok, false);
});

test('verifyPreviewShell: refuses when our own marker cannot be established', () => {
  const v = verifyPreviewShell({ status: 200, contentType: 'text/html', body: SPA_SHELL });
  assert.equal(v.ok, false, 'no expected title means we cannot verify, so we refuse');
  assert.match(v.reason, /cannot read this build's own index\.html/);
});

test('verifyPreviewShell: rejects an unrelated responder', () => {
  const plain = verifyPreviewShell(
    { status: 200, contentType: 'text/plain', body: 'not the dashboard' },
    OPTS
  );
  assert.equal(plain.ok, false);

  const otherHtml = verifyPreviewShell(
    {
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1>some other app</h1></body></html>',
    },
    OPTS
  );
  assert.equal(otherHtml.ok, false);

  const unbuilt = verifyPreviewShell(
    {
      status: 200,
      contentType: 'text/html',
      body:
        `<html><head><title>${TITLE}</title></head><body><div id="root"></div>` +
        '<script type="module" src="/src/main.tsx"></script></body></html>',
    },
    OPTS
  );
  assert.equal(unbuilt.ok, false, 'a dev shell is not a built preview');

  assert.equal(
    verifyPreviewShell({ status: 404, contentType: 'text/html', body: SPA_SHELL }, OPTS).ok,
    false
  );
});

test('corpusIdentity: reports UNVERIFIED rather than an assumed session count', () => {
  const missing = corpusIdentity({ status: 404, contentType: null, body: Buffer.alloc(0) });
  assert.equal(missing.verified, false);
  assert.match(missing.id, /^UNVERIFIED /);

  const present = corpusIdentity({
    status: 200,
    contentType: 'application/zip',
    body: ZIP_BODY,
  });
  assert.equal(present.verified, true);
  assert.match(present.id, /^sample-data\.zip \d+ bytes sha256:[0-9a-f]{16}$/);
});

// Review P1: `npm run build:spa` emits NO sample-data.zip (vite.config.ts gates
// sampleDataPlugin on `--mode sample`), and vite preview's SPA fallback answers
// the missing path with index.html — HTTP 200, non-empty body. Hashing that HTML
// and calling it a verified corpus is the same proxy-as-the-real-thing defect
// this file exists to remove.
test('corpusIdentity: SPA-fallback HTML at HTTP 200 is NOT a corpus', () => {
  const fallback = corpusIdentity({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(SPA_SHELL),
  });
  assert.equal(fallback.verified, false, 'index.html must never be reported as the corpus');
  assert.match(fallback.id, /^UNVERIFIED /);
  assert.match(fallback.id, /not an archive/);
});

test('corpusIdentity: a 200 body that is not a ZIP is NOT a corpus', () => {
  // Right content-type, wrong bytes — the magic-byte check still refuses.
  const notZip = corpusIdentity({
    status: 200,
    contentType: 'application/zip',
    body: Buffer.from('this is not a zip archive'),
  });
  assert.equal(notZip.verified, false);
  assert.match(notZip.id, /not a ZIP archive/);

  // Truncated below the 4-byte signature.
  const stub = corpusIdentity({
    status: 200,
    contentType: 'application/octet-stream',
    body: Buffer.from([0x50, 0x4b]),
  });
  assert.equal(stub.verified, false);
});

test('verifyTarget: a verified preview yields build + corpus provenance', async () => {
  const responses = {
    '/': { status: 200, contentType: 'text/html', body: Buffer.from(SPA_SHELL) },
    '/sample-data.zip': { status: 200, contentType: 'application/zip', body: ZIP_BODY },
  };
  const provenance = await verifyTarget(4477, async (_port, path) => responses[path], OPTS);
  assert.equal(provenance.build, '/assets/index-D1e2F3g4.js');
  assert.equal(provenance.corpus.verified, true);
});

// An UNVERIFIED corpus must ABORT, not annotate. Labelling the corpus unsound
// and then measuring anyway caveats the problem instead of cutting it: on a
// preview with no sample-data.zip the SPA renders the EMPTY upload-first UI, so
// the published numbers are not the sample-corpus benchmark at all.
test('verifyTarget: an unverifiable corpus aborts even when the build is verified', async () => {
  // Exactly the `npm run build:spa` + `vite preview` shape: correct shell,
  // SPA-fallback HTML for the absent archive.
  const responses = {
    '/': { status: 200, contentType: 'text/html', body: Buffer.from(SPA_SHELL) },
    '/sample-data.zip': {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(SPA_SHELL),
    },
  };
  await assert.rejects(
    () => verifyTarget(4477, async (_port, path) => responses[path], OPTS),
    (err) => {
      assert.match(err.message, /^UNVERIFIED /, 'names what could not be verified');
      // The operator must not be left guessing which build produces a corpus.
      assert.match(err.message, /npm run build:sample/);
      assert.match(err.message, /build:spa/, 'says why the documented spa build fails');
      return true;
    }
  );
});

test('verifyTarget: a missing archive (404) aborts too', async () => {
  const responses = {
    '/': { status: 200, contentType: 'text/html', body: Buffer.from(SPA_SHELL) },
    '/sample-data.zip': { status: 404, contentType: null, body: Buffer.alloc(0) },
  };
  await assert.rejects(
    () => verifyTarget(4477, async (_port, path) => responses[path], OPTS),
    /npm run build:sample/
  );
});

test('the refusal names the one build mode that actually emits the corpus', () => {
  // vite.config.ts applies sampleDataPlugin() only under `--mode sample`, and
  // package.json maps that to build:sample. If either moves, this fails.
  assert.equal(CORPUS_BUILD_COMMAND, 'npm run build:sample');
  const pkg = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8'));
  const script = CORPUS_BUILD_COMMAND.replace(/^npm run /, '');
  assert.equal(pkg.scripts[script], 'vite build --mode sample');
  const viteConfig = readFileSync(join(PROJECT_DIR, 'vite.config.ts'), 'utf8');
  assert.match(
    viteConfig,
    /mode === 'sample' \? \[sampleDataPlugin\(\)\]/,
    'sampleDataPlugin must still be gated on --mode sample'
  );
});

// The build id has no equivalent hole: verifyPreviewShell returns ok only once
// it has matched a hashed entry, so there is no "build unknown, measure anyway"
// path — one refusal path, not two half-guards.
test('verifyTarget: an unestablished build id aborts (no half-guard)', async () => {
  const noEntry =
    `<!doctype html><html><head><title>${TITLE}</title></head>` +
    '<body><div id="root"></div></body></html>';
  await assert.rejects(
    () =>
      verifyTarget(
        4477,
        async () => ({ status: 200, contentType: 'text/html', body: Buffer.from(noEntry) }),
        OPTS
      ),
    /no hashed \/assets\/\*\.js module entry/
  );
  // And the predicate never reports ok without one.
  const v = verifyPreviewShell({ status: 200, contentType: 'text/html', body: noEntry }, OPTS);
  assert.equal(v.ok, false);
  assert.equal(v.build, undefined);
});

test('verifyTarget: an unrelated responder throws instead of returning a plausible target', async () => {
  await assert.rejects(
    () =>
      verifyTarget(
        4477,
        async () => ({
          status: 200,
          contentType: 'text/plain',
          body: Buffer.from('hello from an unrelated server'),
        }),
        OPTS
      ),
    /not HTML/
  );
});

test('verifyTarget: a generic Vite app on the port throws instead of being measured', async () => {
  await assert.rejects(
    () =>
      verifyTarget(
        4477,
        async () => ({
          status: 200,
          contentType: 'text/html',
          body: Buffer.from(GENERIC_VITE_APP),
        }),
        OPTS
      ),
    /different app/
  );
});

// The end-to-end contract: an unrelated server on the requested port must make
// the script exit nonzero BEFORE any measurement starts.
test('the script exits nonzero when an unrelated server occupies the port', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('unrelated static server');
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['scripts/measure-isolated-views.mjs', '--port', String(port)],
        { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0, `expected a nonzero exit, got ${result.code}\n${result.stdout}`);
    assert.match(result.stderr, /refusing to measure port/);
    // Nothing was measured, so no measurement output may exist.
    assert.equal(
      /Measuring:|Final summary table/.test(result.stdout),
      false,
      `measurements ran against an unverified responder:\n${result.stdout}`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A built Vite/React app that is NOT this dashboard must be refused end-to-end,
// not just by the pure predicate.
test('the script exits nonzero when a generic Vite app occupies the port', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(GENERIC_VITE_APP);
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['scripts/measure-isolated-views.mjs', '--port', String(port)],
        { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0, `expected a nonzero exit, got ${result.code}\n${result.stdout}`);
    assert.match(result.stderr, /refusing to measure port/);
    assert.equal(
      /Measuring:|Final summary table/.test(result.stdout),
      false,
      `measurements ran against another app:\n${result.stdout}`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// End-to-end: the exact `npm run build:spa` + `vite preview` situation — this
// dashboard's real shell, but no sample-data.zip. The script must exit nonzero
// BEFORE measuring and tell the operator which build to run instead.
test('the script exits nonzero when the corpus cannot be verified, naming build:sample', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SPA_SHELL);
      return;
    }
    // vite preview's SPA fallback: unknown paths get index.html at HTTP 200.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SPA_SHELL);
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['scripts/measure-isolated-views.mjs', '--port', String(port)],
        { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0, `expected a nonzero exit, got ${result.code}\n${result.stdout}`);
    assert.match(result.stderr, /refusing to measure port/);
    assert.match(result.stderr, /npm run build:sample/, 'the error must say what to run');
    assert.equal(
      /Measuring:|Final summary table|Verified corpus/.test(result.stdout),
      false,
      `measurements or provenance were published without a corpus:\n${result.stdout}`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
