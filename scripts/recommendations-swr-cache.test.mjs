#!/usr/bin/env node
// Recommendations response-cache freshness contract (#2184, epic #2181). Boots
// the real server against a throwaway CLAUDE_DIR and proves the two-tier cache
// gate that keeps /api/recommendations.json fast during an active agent session:
//
//   1. sourceSignature() (cheap dir-mtime fingerprint) HIT  -> served instantly.
//   2. mtime changed but ingest() reports the SAME contentHash -> `hit-content`:
//      the cached body is byte-identical and NO multi-second assemble/detector
//      rebuild runs. This is the core fix — an active session bumps project-dir
//      mtimes on nearly every request, but the recs body only changes when the
//      ingested CONTENT changes.
//   3. content actually changed -> `stale`: the last-good body is served
//      immediately while the rebuild is deferred to the response `finish` event
//      (so serving stale stays fast), and the cache converges to the fresh body
//      on a later request.
//
// Assertions are on the X-Recommendations-Cache header semantics and body
// identity (deterministic), not wall-clock thresholds (which would be flaky).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
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

// Fetch recs, returning the cache header + body text. Connection: close so each
// request uses a fresh socket (avoids keep-alive reuse races in the test).
async function getRecs(base) {
  const res = await fetch(`${base}/api/recommendations.json`, {
    headers: { connection: 'close' },
  });
  const body = await res.text();
  return { status: res.status, cache: res.headers.get('x-recommendations-cache'), body };
}

function sessionJsonl(id, prompt, ts) {
  return (
    [
      JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: prompt }),
      JSON.stringify({
        type: 'user',
        timestamp: ts,
        cwd: '/tmp/demo',
        message: { role: 'user', content: prompt },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `toolu_${id}`, name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      }),
    ].join('\n') + '\n'
  );
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'recs-swr-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'recs-swr-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'recs-swr-cache-'));
const base = `http://127.0.0.1:${port}`;
const projectDir = join(claudeDir, 'projects', 'demo');

await mkdir(projectDir, { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(projectDir, 'one.jsonl'),
  sessionJsonl('one', 'do the first thing', '2024-01-01T14:00:00.000Z')
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
    DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    ANTHROPIC_API_KEY: '',
    POLICY_WRITE_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (c) => { stdout += String(c); });
proc.stderr.on('data', (c) => { stderr += String(c); });

try {
  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    // 1) Cold build populates the cache.
    const cold = await getRecs(base);
    await check('cold request builds and returns 200', () => {
      assert.equal(cold.status, 200);
      assert.equal(cold.cache, 'miss');
      assert.ok(cold.body.length > 0);
    });

    // 2) Immediate re-hit with no source change -> plain signature hit.
    const hit = await getRecs(base);
    await check('unchanged source serves a signature hit', () => {
      assert.equal(hit.cache, 'hit');
      assert.equal(hit.body, cold.body);
    });

    // 3) Bump the project dir mtime WITHOUT changing content. sourceSignature()
    //    changes (mtime) but ingest()'s contentHash does not, so the gate must
    //    serve the byte-identical cached body as `hit-content` — no rebuild.
    const future = new Date(Date.now() + 60_000);
    await utimes(projectDir, future, future);
    const contentHit = await getRecs(base);
    await check('mtime-only churn serves hit-content with an identical body', () => {
      assert.equal(contentHit.cache, 'hit-content');
      assert.equal(contentHit.body, cold.body);
    });

    // 4) Real content change -> stale-while-revalidate: the previous body is
    //    served immediately as `stale`.
    await writeFile(
      join(projectDir, 'two.jsonl'),
      sessionJsonl('two', 'do the second thing', '2024-01-02T09:00:00.000Z')
    );
    const stale = await getRecs(base);
    await check('content change serves the prior body as stale', () => {
      assert.equal(stale.cache, 'stale');
      assert.equal(stale.body, cold.body);
    });

    // 5) The background rebuild (deferred to response finish) converges the
    //    cache: a later request settles back to a hit (no longer stale).
    let settled = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await getRecs(base);
      if (r.cache === 'hit' || r.cache === 'hit-content') { settled = r; break; }
    }
    await check('cache converges to a fresh hit after the background rebuild', () => {
      assert.ok(settled, 'recs cache never settled to a hit after content change');
      assert.equal(settled.status, 200);
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
console.log('\nRecommendations SWR cache checks passed.');
