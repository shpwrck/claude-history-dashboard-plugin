#!/usr/bin/env node
// CTO-demo posture gate: boot the real server with hardened enterprise config
// and fail if the admin security posture contains any action-required control.

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

const ADMIN_TOKEN = 'enterprise-posture-admin-token';
const ADMIN_TOKEN_SHA256 = createHash('sha256').update(ADMIN_TOKEN).digest('hex');
const REQUIRED_ENABLED_CONTROLS = [
  'auth',
  'authorization',
  'browser-session-cookie',
  'scope-enforcement',
  'credential-storage',
  'credential-strength',
  'rate-limits',
  'transport-security',
  'security-headers',
  'authenticated-cache',
];

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

async function waitForSession(base, proc, headers) {
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) return null;
    try {
      const response = await fetch(`${base}/api/auth/session`, { headers });
      if (response.status !== 503) return response;
    } catch {
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function postureFailureDetails(controls) {
  return controls
    .map((control) => `${control.id}: ${control.summary || control.label || control.state}`)
    .join('\n');
}

function requiredControlStates(controls) {
  return REQUIRED_ENABLED_CONTROLS.map((id) => {
    const control = controls.find((candidate) => candidate.id === id);
    return {
      id,
      state: control?.state || 'missing',
      summary: control?.summary || control?.label || 'Required posture control is missing',
    };
  });
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'enterprise-posture-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'enterprise-posture-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'enterprise-posture-cache-'));
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };

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
    DASHBOARD_AUTH_ENFORCE_SCOPES: 'true',
    DASHBOARD_AUTH_SESSION_SECRET: 'enterprise-posture-session-secret-32b',
    DASHBOARD_AUTH_TOKENS: JSON.stringify([
      {
        tokenSha256: ADMIN_TOKEN_SHA256,
        userId: 'cto-demo-admin',
        email: 'cto-demo-admin@example.com',
        name: 'CTO Demo Admin',
        role: 'admin',
        orgId: 'acme',
        orgName: 'Acme',
        teamId: 'platform',
        teamName: 'Platform',
        scopes: ['org:read', 'org:write', 'audit:read', 'sessions:read'],
      },
    ]),
    DASHBOARD_ADMIN_TOKEN: '',
    DASHBOARD_ADMIN_TOKEN_SHA256: '',
    DASHBOARD_AUTH_JWKS: '',
    DASHBOARD_AUTH_JWKS_URL: '',
    DASHBOARD_AUTH_JWT_ISSUER: '',
    DASHBOARD_AUTH_JWT_AUDIENCE: '',
    DASHBOARD_AUTH_JWT_ORG_ID_CLAIM: '',
    DASHBOARD_AUTH_DATA_ROOT_BASE: '',
    ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
    ENTERPRISE_AUTH_RATE_LIMIT: '20',
    ENTERPRISE_API_RATE_LIMIT: '100',
    DASHBOARD_USER: '',
    DASHBOARD_PASS: '',
    DASHBOARD_CONTENT_SECURITY_POLICY: '',
    DASHBOARD_ENABLE_HSTS: '',
    DASHBOARD_TRUST_PROXY_HEADERS: '',
    DASHBOARD_TRUSTED_PROXY_ADDRESSES: '',
    DASHBOARD_ALLOWED_ORIGINS: '',
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    DASHBOARD_GITHUB_REVIEW_TOKEN: '',
    DASHBOARD_GITHUB_REVIEW_REPOS: '',
    DASHBOARD_GITHUB_REVIEW_API_BASE: '',
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
  const sessionResponse = await waitForSession(base, proc, headers);
  check(
    'enterprise server boots for posture gate',
    sessionResponse?.status === 200,
    [stdout, stderr].filter(Boolean).join('\n').slice(-2000)
  );

  if (sessionResponse?.status === 200) {
    const session = await sessionResponse.json().catch(() => null);
    check('posture gate admin authenticates', session?.principal?.role === 'admin');
    check(
      'posture gate uses hash-only static token config',
      session?.capabilities?.canReadOrganizationRollup === true
    );

    const response = await fetch(`${base}/api/enterprise/organization`, {
      headers,
    });
    const body = await response.json().catch(() => null);
    const controls = Array.isArray(body?.securityPosture?.controls)
      ? body.securityPosture.controls
      : [];
    check('enterprise organization posture route responds', response.status === 200, `got ${response.status}`);
    check('enterprise posture controls are present', controls.length > 0);

    const actionRequired = controls.filter((control) => control.state === 'action-required');
    check(
      'enterprise posture has zero action-required controls',
      actionRequired.length === 0,
      postureFailureDetails(actionRequired)
    );

    const missingEnabled = requiredControlStates(controls).filter(
      (control) => control.state !== 'enabled'
    );
    check(
      'enterprise posture has required controls enabled',
      missingEnabled.length === 0,
      postureFailureDetails(missingEnabled)
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
