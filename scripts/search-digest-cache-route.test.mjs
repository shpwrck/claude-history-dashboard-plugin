#!/usr/bin/env node
// /api/search and /api/digest response-cache contract (#1573). Boots the real
// server against a throwaway CLAUDE_DIR and proves both routes now carry the
// stat-gated single-flight response cache the dataset/recommendations routes
// already have: concurrent identical requests share one build, warm requests hit
// the cache, results are unchanged, the validation short-circuits still fire
// BEFORE any cache work, and a source change invalidates.
//
// The deterministic single-flight + invalidation proof lives in
// stat-gated-cache.test.mjs (the route-agnostic core). This test asserts the
// routes are WIRED to it: the X-Search-Cache / X-Digest-Cache tags transition
// miss -> hit on warm traffic and miss/refresh after a source change, and the
// payloads match the pre-cache behaviour.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}: ${err.message}`);
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
  });
}

async function waitUp(base, proc) {
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function sessionJsonl({ sessionId, title, prompt, file, ts }) {
  return (
    [
      JSON.stringify({ type: 'custom-title', sessionId, customTitle: title }),
      JSON.stringify({
        type: 'user',
        timestamp: ts,
        cwd: '/tmp/demo',
        message: { role: 'user', content: prompt },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: ts.replace('00.000Z', '01.000Z'),
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `toolu_${sessionId}`, name: 'Write', input: { file_path: file } },
          ],
        },
      }),
    ].join('\n') + '\n'
  );
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'sd-cache-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'sd-cache-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'sd-cache-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects', 'demo'), { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(claudeDir, 'projects', 'demo', 'alpha.jsonl'),
  sessionJsonl({
    sessionId: 'alpha',
    title: 'Implement the alpha widget',
    prompt: 'Implement the alpha widget pipeline',
    file: 'src/lib/alpha-widget.ts',
    ts: '2024-01-01T14:00:00.000Z',
  })
);

let stdout = '';
let stderr = '';
const proc = spawn('node', ['--import', REGISTER, SERVER], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
    ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    DASHBOARD_GITHUB_REVIEW_TOKEN: '',
    DASHBOARD_GITHUB_REVIEW_REPOS: '',
    ANTHROPIC_API_KEY: '',
    POLICY_WRITE_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

proc.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
proc.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

try {
  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    // --- Short-circuits run BEFORE any cache/ingest work --------------------
    await check('search 405 on non-GET (before cache work)', async () => {
      const r = await fetch(`${base}/api/search?q=alpha`, { method: 'POST' });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('x-search-cache'), null, 'no cache tag on a rejected method');
    });
    await check('digest 405 on non-GET (before cache work)', async () => {
      const r = await fetch(`${base}/api/digest`, { method: 'POST' });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('x-digest-cache'), null);
    });
    await check('digest 400 on bad date (before cache work)', async () => {
      const r = await fetch(`${base}/api/digest?date=2024-02-31`);
      assert.equal(r.status, 400);
      assert.equal(r.headers.get('x-digest-cache'), null);
    });
    await check('empty search query short-circuits with no cache tag', async () => {
      const r = await fetch(`${base}/api/search?q=`);
      const body = await r.json();
      assert.equal(r.status, 200);
      assert.deepEqual(body.results, []);
      assert.equal(r.headers.get('x-search-cache'), null, 'empty query never reaches the cache');
    });

    // --- /api/search: concurrent identical requests share ONE build ---------
    let searchMissBody = null;
    await check('N concurrent identical searches => one miss, rest hits, identical results', async () => {
      const N = 8;
      const responses = await Promise.all(
        Array.from({ length: N }, () => fetch(`${base}/api/search?q=alpha`))
      );
      const bodies = await Promise.all(responses.map((r) => r.text()));
      const tags = responses.map((r) => r.headers.get('x-search-cache'));
      const misses = tags.filter((t) => t === 'miss').length;
      const hits = tags.filter((t) => t === 'hit').length;
      assert.equal(misses, 1, `exactly one build for N concurrent identical searches (tags=${tags})`);
      assert.equal(hits, N - 1, 'the rest were served from the single-flight/cache');
      // Behaviour-preserving: every concurrent response is byte-identical.
      for (const b of bodies) assert.equal(b, bodies[0], 'all concurrent search bodies match');
      searchMissBody = bodies[0];
      const parsed = JSON.parse(bodies[0]);
      assert.equal(parsed.mode, 'hybrid');
      assert.ok(parsed.results.length > 0, 'alpha query returns results');
    });

    await check('a warm repeat search hits the cache with identical body', async () => {
      const r = await fetch(`${base}/api/search?q=alpha`);
      const body = await r.text();
      assert.equal(r.headers.get('x-search-cache'), 'hit');
      assert.equal(body, searchMissBody, 'warm search body is unchanged');
    });

    await check('a different query is a distinct cache key (its own miss)', async () => {
      const r = await fetch(`${base}/api/search?q=nonexistent-term-zzz`);
      assert.equal(r.headers.get('x-search-cache'), 'miss');
    });

    // --- /api/digest: warm hit, identical body ------------------------------
    let digestMissBody = null;
    await check('first digest is a miss with grouped data', async () => {
      const r = await fetch(`${base}/api/digest?date=2024-01-01`);
      digestMissBody = await r.text();
      const d = JSON.parse(digestMissBody);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-digest-cache'), 'miss');
      assert.equal(d.date, '2024-01-01');
      assert.equal(d.total.sessionCount, 1);
      assert.equal(d.projects[0].project, '/tmp/demo');
    });
    await check('a warm repeat digest hits the cache with identical body', async () => {
      const r = await fetch(`${base}/api/digest?date=2024-01-01`);
      const body = await r.text();
      assert.equal(r.headers.get('x-digest-cache'), 'hit');
      assert.equal(body, digestMissBody, 'warm digest body is unchanged');
    });

    // --- A source change invalidates both caches ----------------------------
    await check('adding a transcript invalidates the search + digest caches', async () => {
      // New project dir => its mtime is fresh => sourceSignature() moves. Wait a
      // tick first so the dir mtime is observably newer than the warm builds.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await mkdir(join(claudeDir, 'projects', 'demo2'), { recursive: true });
      await writeFile(
        join(claudeDir, 'projects', 'demo2', 'beta.jsonl'),
        sessionJsonl({
          sessionId: 'beta',
          title: 'Implement the alpha follow-up',
          prompt: 'Refine the alpha widget further',
          file: 'src/lib/alpha-widget-2.ts',
          ts: '2024-01-01T15:00:00.000Z',
        })
      );

      const sr = await fetch(`${base}/api/search?q=alpha`);
      const sBody = await sr.text();
      assert.equal(
        sr.headers.get('x-search-cache'),
        'refresh',
        'source change rebuilds the search cache'
      );
      assert.notEqual(sBody, searchMissBody, 'new transcript changes the search results');

      const dr = await fetch(`${base}/api/digest?date=2024-01-01`);
      const dBody = await dr.text();
      assert.equal(
        dr.headers.get('x-digest-cache'),
        'refresh',
        'source change rebuilds the digest cache'
      );
      const d = JSON.parse(dBody);
      assert.equal(d.total.sessionCount, 2, 'the digest now reflects both sessions');
    });
  }
} finally {
  // A server that died before waitUp succeeded has already emitted 'exit' —
  // waiting on the listener then would hang the CI step instead of failing
  // with the captured logs.
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);

console.log('\nSearch/digest cache route checks passed.');
