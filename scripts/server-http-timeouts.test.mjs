#!/usr/bin/env node
// Server listener timeout contract (#1205): slow-client protections are
// explicit and bounded rather than left to Node-version defaults.

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

async function waitForOutput(proc, predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return true;
    if (proc.exitCode !== null) return predicate();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'server-timeouts-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'server-timeouts-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'server-timeouts-cache-'));
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
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_REQUEST_TIMEOUT_MS: '4321',
    DASHBOARD_HEADERS_TIMEOUT_MS: '2345',
    DASHBOARD_KEEP_ALIVE_TIMEOUT_MS: '3456',
    DASHBOARD_SOCKET_TIMEOUT_MS: '4567',
    DASHBOARD_AUTH_MODE: '',
    DASHBOARD_AUTH_TOKENS: '',
    DASHBOARD_ADMIN_TOKEN: '',
    DASHBOARD_USER: '',
    DASHBOARD_PASS: '',
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
  check(
    'server boots for HTTP timeout contract',
    up,
    [stdout, stderr].filter(Boolean).join('\n').slice(-2000)
  );

  if (up) {
    await waitForOutput(proc, () =>
      /http timeouts:/.test([stdout, stderr].filter(Boolean).join('\n'))
    );
    const output = [stdout, stderr].filter(Boolean).join('\n');
    check(
      'server reports configured request timeout',
      /request=4321ms/.test(output),
      output.slice(-2000)
    );
    check(
      'server reports configured headers timeout',
      /headers=2345ms/.test(output),
      output.slice(-2000)
    );
    check(
      'server reports configured keep-alive timeout',
      /keepAlive=3456ms/.test(output),
      output.slice(-2000)
    );
    check(
      'server reports configured idle socket timeout',
      /socket=4567ms/.test(output),
      output.slice(-2000)
    );

    const response = await fetch(`${base}/healthz`);
    check('server remains reachable after timeout setup', response.status === 200, `got ${response.status}`);
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
