#!/usr/bin/env node
// Static shell/cache contract (#1488): hashed assets are immutable, but missing
// asset URLs must not fall through to the SPA shell and poison the browser cache.

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
const claudeDir = await mkdtemp(join(tmpdir(), 'static-serving-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'static-serving-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'static-serving-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(distDir, 'assets'), { recursive: true });
await writeFile(
  join(distDir, 'index.html'),
  '<!doctype html><main data-testid="spa-shell">ok</main>'
);
await writeFile(join(distDir, 'assets', 'existing.js'), 'export const ok = true;\n');

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
  await check('server boots for static-serving contract', () => {
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000));
  });

  if (up) {
    const shell = await fetch(`${base}/`);
    await check('SPA shell is served without long-lived cache headers', async () => {
      assert.equal(shell.status, 200);
      assert.equal(shell.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(shell.headers.get('cache-control'), 'no-store');
      assert.match(await shell.text(), /data-testid="spa-shell"/);
    });

    const fallback = await fetch(`${base}/deep/link/route`);
    await check('SPA fallback is served without long-lived cache headers', async () => {
      assert.equal(fallback.status, 200);
      assert.equal(fallback.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(fallback.headers.get('cache-control'), 'no-store');
      assert.match(await fallback.text(), /data-testid="spa-shell"/);
    });

    const existingAsset = await fetch(`${base}/assets/existing.js`);
    await check('existing hashed assets stay immutable-cacheable', async () => {
      assert.equal(existingAsset.status, 200);
      assert.equal(existingAsset.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(
        existingAsset.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
      );
      assert.match(await existingAsset.text(), /export const ok = true/);
    });

    const missingAsset = await fetch(`${base}/assets/missing-view.js`);
    await check('missing assets return non-cacheable 404 instead of SPA HTML', async () => {
      assert.equal(missingAsset.status, 404);
      assert.equal(missingAsset.headers.get('cache-control'), 'no-store');
      assert.notEqual(missingAsset.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.doesNotMatch(await missingAsset.text(), /data-testid="spa-shell"/);
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

if (failures > 0) {
  process.exit(1);
}

console.log('\nStatic serving checks passed.');
