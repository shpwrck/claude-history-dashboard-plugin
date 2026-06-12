#!/usr/bin/env node
// Lazy per-session timeline route contract (#1285). Boots the real server
// against a throwaway CLAUDE_DIR, primes /api/dataset.json, then proves the
// detail endpoint serves the full session_blob timeline with cache validators.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
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
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'timeline-route-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'timeline-route-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'timeline-route-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects', 'demo'), { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(claudeDir, 'projects', 'demo', 'session-1.jsonl'),
  [
    JSON.stringify({
      type: 'user',
      timestamp: '2024-01-01T00:00:00.000Z',
      cwd: '/tmp/demo',
      message: { role: 'user', content: 'hello timeline' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'timeline answer' }],
      },
    }),
  ].join('\n') + '\n'
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
    const dataset = await fetch(`${base}/api/dataset.json`);
    await check('dataset primes session_blob', () => assert.equal(dataset.status, 200));

    const detail = await fetch(`${base}/api/session/session-1/timeline.json`);
    const etag = detail.headers.get('etag');
    const body = await detail.json();
    await check('known session timeline detail includes full summaries', () => {
      assert.equal(detail.status, 200);
      assert.equal(body.sessionId, 'session-1');
      assert.ok(etag, 'timeline route set an ETag');
      assert.deepEqual(
        body.entries.map((entry) => entry.summary),
        ['hello timeline', 'timeline answer']
      );
    });

    const repeat = await fetch(`${base}/api/session/session-1/timeline.json`, {
      headers: { 'If-None-Match': etag },
    });
    await check('matching ETag returns 304', () => assert.equal(repeat.status, 304));

    const legacy = await fetch(`${base}/api/session/session-1/timeline`);
    await check('legacy timeline route remains compatible', () => assert.equal(legacy.status, 200));

    const missing = await fetch(`${base}/api/session/nope/timeline.json`);
    await check('unknown session returns 404', () => assert.equal(missing.status, 404));
  }
} finally {
  proc.kill('SIGTERM');
  await new Promise((resolve) => proc.once('exit', resolve));
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);

console.log('\nSession timeline route checks passed.');
