#!/usr/bin/env node
// Production liveness contract (#1203): /healthz is a no-data endpoint for
// container and reverse-proxy health checks, even when HTTP Basic auth
// protects every data route (#3821).

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

const BASIC_USER = 'ops';
const BASIC_PASS = 'healthcheck-basic-secret';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
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
const claudeDir = await mkdtemp(join(tmpdir(), 'server-healthcheck-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'server-healthcheck-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'server-healthcheck-cache-'));
const base = `http://127.0.0.1:${port}`;

await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');

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
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_AUTH_MODE: '',
    DASHBOARD_AUTH_TOKENS: '',
    DASHBOARD_USER: BASIC_USER,
    DASHBOARD_PASS: BASIC_PASS,
    DASHBOARD_ENABLE_HSTS: '',
    DASHBOARD_CONTENT_SECURITY_POLICY: '',
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
  check(
    'server boots for healthcheck contract',
    up,
    [stdout, stderr].filter(Boolean).join('\n').slice(-2000)
  );

  if (up) {
    const response = await fetch(`${base}/healthz`);
    const body = await response.text();
    check('healthcheck returns 200 without credentials', response.status === 200, `got ${response.status}`);
    check('healthcheck body is no-data liveness only', body === 'ok\n', body);
    check('healthcheck is not cacheable', response.headers.get('cache-control') === 'no-store');

    const headResponse = await fetch(`${base}/healthz`, { method: 'HEAD' });
    const headBody = await headResponse.text();
    check('healthcheck supports HEAD probes', headResponse.status === 200, `got ${headResponse.status}`);
    check('HEAD healthcheck returns no body', headBody === '', headBody);

    const protectedResponse = await fetch(`${base}/sessions-manifest.json`);
    check(
      'data routes still require Basic credentials',
      protectedResponse.status === 401,
      `got ${protectedResponse.status}`
    );

    const authedResponse = await fetch(`${base}/sessions-manifest.json`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64')}`,
      },
    });
    check(
      'Basic credentials unlock the data route',
      authedResponse.status === 200,
      `got ${authedResponse.status}`
    );
  }
} finally {
  if (proc.exitCode === null) {
    proc.kill();
    await new Promise((resolve) => proc.once('close', resolve));
  }
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
