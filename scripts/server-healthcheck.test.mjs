#!/usr/bin/env node
// Production liveness contract (#1203): /healthz is a no-data endpoint for
// container and reverse-proxy health checks, even when enterprise auth is on.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

const ADMIN_TOKEN = 'enterprise-healthcheck-admin-token';
const ADMIN_TOKEN_SHA256 = createHash('sha256').update(ADMIN_TOKEN).digest('hex');

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
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_ORG_ID: 'acme',
    DASHBOARD_ORG_NAME: 'Acme',
    DASHBOARD_AUTH_TOKENS: JSON.stringify([
      {
        tokenSha256: ADMIN_TOKEN_SHA256,
        userId: 'healthcheck-admin',
        email: 'healthcheck-admin@example.com',
        name: 'Healthcheck Admin',
        role: 'admin',
        orgId: 'acme',
        orgName: 'Acme',
        scopes: ['org:read'],
      },
    ]),
    DASHBOARD_USER: 'ops',
    DASHBOARD_PASS: 'enterprise-healthcheck-basic-secret',
    DASHBOARD_ADMIN_TOKEN: '',
    DASHBOARD_ADMIN_TOKEN_SHA256: '',
    DASHBOARD_AUTH_JWKS: '',
    DASHBOARD_AUTH_JWKS_URL: '',
    DASHBOARD_ENABLE_HSTS: '',
    DASHBOARD_CONTENT_SECURITY_POLICY: '',
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

    const protectedResponse = await fetch(`${base}/api/enterprise/organization`);
    check(
      'enterprise data routes still require credentials',
      protectedResponse.status === 401,
      `got ${protectedResponse.status}`
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
