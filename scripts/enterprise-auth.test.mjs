// Regression test for enterprise auth bootstrap mode (#1017).
//
// Boots the real server against throwaway dirs and verifies:
// - default local mode remains open/single-user
// - enterprise mode rejects protected data routes without a bearer token
// - enterprise mode accepts a configured principal token
// - enterprise mode fails closed when enabled without any token

import { spawn } from 'node:child_process';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

async function fileMode(path) {
  // Return a sentinel for a missing path so a coverage gap fails the relevant
  // check cleanly instead of throwing an uncaught ENOENT that aborts the whole
  // suite (#1578).
  try {
    return (await stat(path)).mode & 0o777;
  } catch (err) {
    if (err?.code === 'ENOENT') return -1;
    throw err;
  }
}

function scopedCacheDbPath(dataRoot, cacheDir = join(PROJECT_DIR, '.cache')) {
  const key = createHash('sha256').update(dataRoot).digest('hex').slice(0, 24);
  return join(cacheDir, 'enterprise-roots', `${key}.db`);
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

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'enterprise-auth-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'enterprise-auth-dist-'));
  const auditLog = join(distDir, 'enterprise-audit.jsonl');
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div>ok</div>');

  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CLAUDE_DIR: claudeDir,
      DIST_DIR: distDir,
      // Pin the scoped-ingest cache root to PROJECT_DIR/.cache so the
      // scopedCacheDbPath() helper and the cache-dir mode assertions resolve
      // to the same place the server writes. The server default moved to
      // <CLAUDE>/.cache/chd, which is why the test asserted a path the server
      // never created (#1578). PROJECT_DIR/.cache is gitignored.
      CHD_CACHE_DIR: join(PROJECT_DIR, '.cache'),
      DASHBOARD_USER: '',
      DASHBOARD_PASS: '',
      DASHBOARD_BASIC_AUTH_MAX_BYTES: '',
      DASHBOARD_AUTH_MODE: '',
      DASHBOARD_AUTH_TOKENS: '',
      DASHBOARD_AUTH_TOKENS_FILE: '',
      DASHBOARD_AUTH_TOKENS_MAX_BYTES: '',
      DASHBOARD_AUTH_TOKENS_MAX_ENTRIES: '',
      DASHBOARD_AUTH_SESSION_SECRET: '',
      DASHBOARD_AUTH_SESSION_SECRET_FILE: '',
      DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET: '',
      DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: '',
      DASHBOARD_AUTH_SESSION_EPOCH: '',
      DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS: '',
      DASHBOARD_AUTH_SESSION_COOKIE_SECURE: '',
      DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS: '',
      DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES: '',
      DASHBOARD_AUTH_ENFORCE_SCOPES: '',
      DASHBOARD_AUTH_DATA_ROOT_BASE: '',
      DASHBOARD_AUTH_JWT_MIN_RSA_BITS: '',
      DASHBOARD_AUTH_JWT_MAX_LIFETIME_SECONDS: '',
      DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS: '',
      DASHBOARD_AUTH_JWT_HEADER_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_CLAIMS_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_SIGNATURE_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES: '',
      DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES: '',
      DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS: '',
      DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES: '',
      DASHBOARD_AUTH_JWT_ADMIN_ROLES: '',
      DASHBOARD_AUTH_JWT_MEMBER_ROLES: '',
      DASHBOARD_AUTH_JWT_VIEWER_ROLES: '',
      DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES: '',
      DASHBOARD_AUTH_JWKS_URL_MAX_BYTES: '',
      DASHBOARD_AUTH_JWKS_MAX_KEYS: '',
      DASHBOARD_AUTH_SCOPE_MAX_ENTRIES: '',
      DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES: '',
      DASHBOARD_AUTH_SCOPE_MAX_CHARS: '',
      DASHBOARD_ADMIN_TOKEN: '',
      DASHBOARD_ADMIN_TOKEN_SHA256: '',
      DASHBOARD_ADMIN_SCOPES: '',
      ENTERPRISE_AUDIT_LOG_PATH: auditLog,
      DASHBOARD_ENABLE_HSTS: '',
      DASHBOARD_CONTENT_SECURITY_POLICY: '',
      DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES: '',
      DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
      DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
      DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
      DASHBOARD_TRUST_PROXY_HEADERS: '',
      DASHBOARD_TRUSTED_PROXY_ADDRESSES: '',
      DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES: '',
      DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES: '',
      ANTHROPIC_API_KEY: '',
      POLICY_WRITE_TOKEN: '',
      DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES: '',
      DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES: '',
      DASHBOARD_MEMORY_MAX_FILES: '',
      DASHBOARD_MEMORY_DIR_MAX_ENTRIES: '',
      DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES: '',
      DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES: '',
      DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES: '',
      DASHBOARD_WORKFLOW_FIELD_MAX_CHARS: '',
      DASHBOARD_RAW_SESSION_MAX_PARTS: '',
      DASHBOARD_INGEST_PROJECT_MAX_DIRS: '',
      DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES: '',
      DASHBOARD_INGEST_SESSION_MAX_PARTS: '',
      DASHBOARD_DATASET_RESPONSE_MAX_BYTES: '',
      DASHBOARD_RECOMMENDATIONS_CACHE_MAX_ENTRIES: '',
      DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES: '',
      DASHBOARD_REVIEW_EVENTS_SOURCE: '',
      DASHBOARD_GITHUB_REVIEW_TOKEN: '',
      DASHBOARD_GITHUB_REVIEW_REPOS: '',
      DASHBOARD_GITHUB_REVIEW_API_BASE: '',
      DASHBOARD_REVIEW_EVENTS_CACHE_PATH: '',
      DASHBOARD_GITHUB_REVIEW_REPOS_MAX_BYTES: '',
      DASHBOARD_GITHUB_REVIEW_MAX_REPOS: '',
      DASHBOARD_GITHUB_REVIEW_MAX_PULLS_PER_REPO: '',
      DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_REQUESTS: '',
      DASHBOARD_GITHUB_REVIEW_MAX_TIMELINE_EVENTS_PER_PR: '',
      DASHBOARD_GITHUB_REVIEW_MAX_RECORDS: '',
      DASHBOARD_GITHUB_REVIEW_FETCH_TIMEOUT_MS: '',
      DASHBOARD_GITHUB_REVIEW_MAX_RESPONSE_BYTES: '',
      DASHBOARD_GITHUB_REVIEW_CACHE_TTL_MS: '',
      DASHBOARD_AUDIT_RESPONSE_MAX_BYTES: '',
      DASHBOARD_AUDIT_MAX_JUDGE_CALLS: '',
      DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS: '',
      DASHBOARD_AUDIT_INPUT_MAX_ROWS: '',
      DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES: '',
      ENTERPRISE_RATE_LIMIT_WINDOW_MS: '',
      ENTERPRISE_AUTH_RATE_LIMIT: '',
      ENTERPRISE_API_RATE_LIMIT: '',
      ENTERPRISE_AUDIT_ROTATE_MAX_BYTES: '',
      ENTERPRISE_AUDIT_ROTATE_MAX_FILES: '',
      DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES: '',
      DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES: '',
      ...extraEnv,
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  const readinessUrl =
    extraEnv.DASHBOARD_USER && extraEnv.DASHBOARD_PASS
      ? `${base}/api/auth/session`
      : base;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(readinessUrl);
      up = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check('server came up', up);
  return {
    base,
    claudeDir,
    distDir,
    auditLog,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill();
        await exited;
      }
      await rm(claudeDir, { recursive: true, force: true });
      await rm(distDir, { recursive: true, force: true });
    },
  };
}

async function startJwksServer(body) {
  const port = await freePort();
  const requests = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startRedirectServer(location) {
  const port = await freePort();
  const requests = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url);
    res.writeHead(302, { Location: location });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withAuthTokensFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'enterprise-auth-tokens-file-'));
  const file = join(dir, 'tokens.json');
  try {
    await writeFile(file, content);
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withSessionSecretFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'enterprise-session-secret-file-'));
  const file = join(dir, 'session-secret');
  try {
    await writeFile(file, content);
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function populateScopedClaudeRoot(root, projectCwd = '/scoped/project') {
  const projectRoot = join(root, 'projects', 'scoped-project');
  await mkdir(join(projectRoot, 'scoped-session', 'subagents'), { recursive: true });
  await mkdir(join(projectRoot, 'scoped-session', 'workflows'), { recursive: true });
  await mkdir(join(projectRoot, 'memory'), { recursive: true });
  await writeFile(
    join(root, 'history.jsonl'),
    `${JSON.stringify({
      sessionId: 'scoped-session',
      cwd: projectCwd,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'scoped history' },
    })}\n`
  );
  await writeFile(
    join(projectRoot, 'scoped-session.jsonl'),
    `${JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: projectCwd,
      message: { role: 'user', content: 'top scoped' },
    })}\n`
  );
  await writeFile(
    join(projectRoot, 'scoped-session', 'subagents', 'agent.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"sub scoped"}}\n'
  );
  await writeFile(
    join(projectRoot, 'memory', 'note.md'),
    '---\nname: Scoped memory\n---\nscoped note\n'
  );
  await writeFile(
    join(projectRoot, 'scoped-session', 'workflows', 'wf_scoped.json'),
    JSON.stringify({
      runId: 'wf-scoped',
      workflowName: 'Scoped Workflow',
      status: 'completed',
      startTime: 1767225600000,
      durationMs: 1200,
      agentCount: 1,
      totalTokens: 42,
      totalToolCalls: 2,
      defaultModel: 'claude-sonnet-4-5',
      phases: [{ title: 'Scope', detail: 'Read scoped fixtures' }],
      workflowProgress: [],
    })
  );
  return root;
}

async function populateOrganizationRollupFixture(root) {
  const projectRoot = join(root, 'projects', 'enterprise-rollup-project');
  await mkdir(projectRoot, { recursive: true });
  const sessionId = 'enterprise-secret-session';
  const lines = [
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/workspace/acme-secret-app',
      permissionMode: 'default',
      message: {
        role: 'user',
        content: 'SENSITIVE_ENTERPRISE_PROMPT investigate the confidential customer merger',
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01Z',
      version: '2.1.0-enterprise-test',
      entrypoint: 'sdk-cli',
      permissionMode: 'bypassPermissions',
      message: {
        id: 'msg-enterprise-rollup',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 900,
          output_tokens: 120,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
          service_tier: 'standard',
        },
        content: [
          {
            type: 'tool_use',
            id: 'tool-enterprise-rollup',
            name: 'Bash',
            input: { command: 'rm -rf /tmp/secret-merger' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:02Z',
      permissionMode: 'bypassPermissions',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-enterprise-rollup',
            is_error: false,
            content: 'SECRET_TOOL_RESULT',
          },
        ],
      },
    },
  ];
  await writeFile(
    join(projectRoot, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
}

async function createScopedClaudeRoot(projectCwd = '/scoped/project') {
  return populateScopedClaudeRoot(
    await mkdtemp(join(tmpdir(), 'enterprise-scoped-claude-')),
    projectCwd
  );
}

async function writeIdentityRecommendationTasks(
  root,
  primaryOwner,
  primaryEmail,
  secondaryOwner = 'secondary-owner',
  tertiaryOwner = 'tertiary-owner'
) {
  const tasksDir = join(root, 'tasks', 'identity-recommendation-session');
  await mkdir(tasksDir, { recursive: true });
  const owners = [
    primaryOwner,
    primaryOwner,
    primaryOwner,
    primaryEmail,
    secondaryOwner,
    tertiaryOwner,
  ];
  await Promise.all(
    owners.map((owner, index) =>
      writeFile(
        join(tasksDir, `${index + 1}.json`),
        JSON.stringify({
          id: `identity-task-${index + 1}`,
          subject: `Identity recommendation task ${index + 1}`,
          description: '',
          activeForm: '',
          owner,
          status: 'pending',
          blocks: [],
          blockedBy: [],
        })
      )
    )
  );
}

function jwtPathSegmentForTest(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  const cleaned = raw.replace(/[^A-Za-z0-9@._-]+/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
  if (cleaned === raw && cleaned.length <= 160) return cleaned;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const prefixLength = Math.max(1, 160 - hash.length - 1);
  const prefix = cleaned.slice(0, prefixLength);
  if (!prefix || prefix === '.' || prefix === '..') {
    return createHash('sha256').update(raw).digest('hex').slice(0, 24);
  }
  return `${prefix}-${hash}`;
}

async function json(res) {
  return res.json().catch(() => null);
}

function setCookieHeader(res) {
  return String(res.headers.get('set-cookie') || '');
}

function enterpriseSessionCookie(res) {
  const raw = setCookieHeader(res);
  const match = /(?:^|,\s*)chd_enterprise_session=([^;,\s]+)/.exec(raw);
  return match ? `chd_enterprise_session=${match[1]}` : '';
}

function cookieMaxAge(res) {
  const match = /Max-Age=(\d+)/.exec(setCookieHeader(res));
  return match ? Number(match[1]) : null;
}

function enterpriseExpiredSessionCookie(principal, secret) {
  const now = Math.floor(Date.now() / 1000);
  const iv = randomBytes(12);
  const key = createHash('sha256').update(Buffer.from(secret, 'utf8')).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('claude-history-dashboard.enterprise-session.v1'));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({
        v: 1,
        iat: now - 180,
        exp: now - 60,
        principal,
      }),
      'utf8'
    ),
    cipher.final(),
  ]);
  const value = [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
  return `chd_enterprise_session=${value}`;
}

function checkSecurityHeaders(prefix, res) {
  check(
    `${prefix} sends content security policy`,
    res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")
  );
  check(
    `${prefix} denies framing`,
    res.headers.get('x-frame-options') === 'DENY'
  );
  check(
    `${prefix} disables content sniffing`,
    res.headers.get('x-content-type-options') === 'nosniff'
  );
  check(
    `${prefix} uses no-referrer policy`,
    res.headers.get('referrer-policy') === 'no-referrer'
  );
  check(
    `${prefix} disables browser permissions`,
    res.headers.get('permissions-policy')?.includes('camera=()')
  );
}

async function readAuditLog(path, minEvents = 1) {
  for (let i = 0; i < 40; i++) {
    try {
      const raw = await readFile(path, 'utf8');
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (events.length >= minEvents) return { raw, events };
    } catch {
      /* audit writes are async; keep polling */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { raw: '', events: [] };
}

async function readAuditLogUntil(path, predicate) {
  for (let i = 0; i < 40; i++) {
    try {
      const raw = await readFile(path, 'utf8');
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (predicate({ raw, events })) return { raw, events };
    } catch {
      /* audit writes are async; keep polling */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { raw: '', events: [] };
}

async function readTextUntil(path, predicate) {
  for (let i = 0; i < 40; i++) {
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (predicate(raw)) return raw;
    await new Promise((r) => setTimeout(r, 50));
  }
  return '';
}

function auditLine(event) {
  return `${JSON.stringify({
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'enterprise.test.seed',
    outcome: 'allowed',
    status: 200,
    method: 'GET',
    tokenHash: 'seed',
    remoteAddress: '127.0.0.1',
    ...event,
  })}\n`;
}

const token = 'enterprise-admin-token';
const viewerToken = 'enterprise-viewer-token';
const memberToken = 'enterprise-member-token';
const otherOrgToken = 'enterprise-other-org-token';
const hashedToken = 'enterprise-hashed-token';
const hashedTokenSha256 = createHash('sha256').update(hashedToken).digest('hex');
const sessionSecret = 'enterprise-session-cookie-secret-32b';
const rotatedSessionSecret = 'enterprise-rotated-session-secret-32b';
const sessionEpoch = 'pilot-session-epoch-1';
const jwtIssuer = 'https://idp.example.test';
const jwtAudience = 'claude-history-dashboard';
const { privateKey: jwtPrivateKey, publicKey: jwtPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwtJwk = {
  ...jwtPublicKey.export({ format: 'jwk' }),
  kid: 'enterprise-test-key',
  alg: 'RS256',
  use: 'sig',
};
const kidlessJwtJwk = {
  ...jwtPublicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  use: 'sig',
};
const {
  privateKey: weakJwtPrivateKey,
  publicKey: weakJwtPublicKey,
} = generateKeyPairSync('rsa', {
  modulusLength: 1024,
});
const {
  privateKey: collidingJwtPrivateKey,
  publicKey: collidingJwtPublicKey,
} = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const weakJwtJwk = {
  ...weakJwtPublicKey.export({ format: 'jwk' }),
  kid: 'enterprise-weak-test-key',
  alg: 'RS256',
  use: 'sig',
};
const collidingJwtJwk = {
  ...collidingJwtPublicKey.export({ format: 'jwk' }),
  kid: jwtJwk.kid,
  alg: 'RS256',
  use: 'sig',
};
const jwtJwks = JSON.stringify({ keys: [jwtJwk] });
const kidlessJwtJwks = JSON.stringify({ keys: [kidlessJwtJwk] });
const duplicateKidJwtJwks = JSON.stringify({ keys: [jwtJwk, { ...jwtJwk }] });
const mixedJwtJwks = JSON.stringify({ keys: [weakJwtJwk, jwtJwk] });
const weakJwtJwks = JSON.stringify({ keys: [weakJwtJwk] });
const nonSigningJwtJwks = JSON.stringify({
  keys: [{ ...jwtJwk, use: 'enc' }],
});
const tokenConfig = JSON.stringify([
  {
    token,
    userId: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    scopes: ['org:read', 'org:write', 'audit:read'],
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'platform',
    teamName: 'Platform Team',
  },
  {
    token: viewerToken,
    userId: 'u-viewer',
    email: 'viewer@example.com',
    name: 'Viewer User',
    role: 'viewer',
    scope: 'sessions:read audit:read',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'support',
    teamName: 'Support Team',
  },
]);
const hashOnlyTokenConfig = JSON.stringify([
  {
    tokenSha256: hashedTokenSha256,
    userId: 'u-hashed',
    email: 'hashed@example.com',
    name: 'Hashed User',
    role: 'admin',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'research',
    teamName: 'Research Team',
  },
]);
const hashObjectTokenConfig = JSON.stringify({
  [`sha256:${hashedTokenSha256}`]: {
    userId: 'u-hashed-object',
    email: 'hashed-object@example.com',
    name: 'Hashed Object User',
    role: 'viewer',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'support',
    teamName: 'Support Team',
  },
});
const orgBoundaryTokenConfig = JSON.stringify([
  {
    token,
    userId: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    orgId: 'acme',
    orgName: 'Acme',
  },
  {
    token: otherOrgToken,
    userId: 'u-other-org',
    email: 'other-org@example.com',
    name: 'Other Org Admin',
    role: 'admin',
    orgId: 'other-org',
    orgName: 'Other Org',
  },
]);

function scopedCacheTokenConfig(rootA, rootB) {
  return JSON.stringify([
    {
      token,
      userId: 'u-admin',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
      orgId: 'acme',
      orgName: 'Acme',
      teamId: 'platform',
      teamName: 'Platform Team',
    },
    {
      token: 'enterprise-member-a-token',
      userId: 'u-member-a',
      email: 'member-a@example.com',
      name: 'Member A',
      role: 'member',
      orgId: 'acme',
      orgName: 'Acme',
      teamId: 'team-a',
      teamName: 'Team A',
      dataRoot: rootA,
    },
    {
      token: 'enterprise-member-b-token',
      userId: 'u-member-b',
      email: 'member-b@example.com',
      name: 'Member B',
      role: 'member',
      orgId: 'acme',
      orgName: 'Acme',
      teamId: 'team-b',
      teamName: 'Team B',
      dataRoot: rootB,
    },
  ]);
}

function signJwtWithKey(claims, privateKey, jwk, header = {}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header })
  ).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
    'base64url'
  );
  return `${signingInput}.${signature}`;
}

function signJwt(claims, header = {}) {
  return signJwtWithKey(claims, jwtPrivateKey, jwtJwk, header);
}

function enterpriseJwt(overrides = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: jwtIssuer,
      aud: jwtAudience,
      sub: 'jwt-member',
      email: 'jwt-member@example.com',
      name: 'JWT Member',
      role: 'member',
      scope: 'sessions:read audit:read',
      team: 'platform',
      team_name: 'Platform Team',
      exp: now + 300,
      iat: now,
      ...overrides,
    },
    header
  );
}

function weakEnterpriseJwt(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwtWithKey(
    {
      iss: jwtIssuer,
      aud: jwtAudience,
      sub: 'jwt-weak-member',
      email: 'jwt-weak-member@example.com',
      name: 'JWT Weak Member',
      role: 'member',
      scope: 'sessions:read',
      exp: now + 300,
      iat: now,
      ...overrides,
    },
    weakJwtPrivateKey,
    weakJwtJwk
  );
}

let server = await startServer();
try {
  let r = await fetch(`${server.base}/api/auth/session`);
  let body = await json(r);
  check('local auth session -> 200', r.status === 200, `got ${r.status}`);
  check('local auth session is no-store', r.headers.get('cache-control') === 'no-store');
  checkSecurityHeaders('local auth session', r);
  check('hsts is opt-in by default', !r.headers.has('strict-transport-security'));
  check('local mode does not require auth', body?.authRequired === false);
  check('local mode can import local data', body?.capabilities?.canImportLocalData === true);
  check(
    'local mode can use browser LLM egress',
    body?.capabilities?.canUseBrowserLlmEgress === true
  );
  r = await fetch(`${server.base}/`);
  check('local static shell -> 200', r.status === 200, `got ${r.status}`);
  checkSecurityHeaders('local static shell', r);
  const staticSymlinkSecret = join(server.claudeDir, 'static-secret.txt');
  await writeFile(staticSymlinkSecret, 'static symlink secret marker\n');
  await symlink(staticSymlinkSecret, join(server.distDir, 'linked-secret.txt'));
  r = await fetch(`${server.base}/linked-secret.txt`);
  const staticSymlinkBody = await r.text();
  check('local static symlink escape -> 403', r.status === 403, `got ${r.status}`);
  check('local static symlink escape does not serve target', !staticSymlinkBody.includes('static symlink secret'));
  r = await fetch(`${server.base}/sessions-manifest.json`);
  body = await json(r);
  check('local manifest remains open', r.status === 200, `got ${r.status}`);
  check('local manifest returns an array', Array.isArray(body));
  r = await fetch(`${server.base}/api/csrf-token`);
  body = await json(r);
  check('local csrf bootstrap -> 200', r.status === 200, `got ${r.status}`);
  check('local csrf bootstrap is no-store', r.headers.get('cache-control') === 'no-store');
  check('local csrf bootstrap includes token', typeof body?.token === 'string');
  r = await fetch(`${server.base}/%E0%A4%A`);
  body = await json(r);
  check('malformed request path -> 400', r.status === 400, `got ${r.status}`);
  check('malformed request path reports bad request', body?.ok === false);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_SESSIONS_MANIFEST_MAX_ENTRIES: '2',
});
try {
  const projectDir = join(server.claudeDir, 'projects', 'manifest-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'manifest-a.jsonl'), '{}\n');
  await writeFile(join(projectDir, 'manifest-b.jsonl'), '{}\n');
  await writeFile(join(projectDir, 'manifest-c.jsonl'), '{}\n');

  const r = await fetch(`${server.base}/sessions-manifest.json`);
  const body = await json(r);
  check('sessions manifest entry cap -> 200', r.status === 200, `got ${r.status}`);
  check('sessions manifest entry cap preserves array body', Array.isArray(body));
  check('sessions manifest entry cap limits returned rows', body?.length === 2, `got ${body?.length}`);
  check('sessions manifest entry cap reports limit header', r.headers.get('x-dashboard-manifest-limit') === '2');
  check('sessions manifest entry cap reports returned header', r.headers.get('x-dashboard-manifest-returned') === '2');
  check('sessions manifest entry cap reports truncation header', r.headers.get('x-dashboard-manifest-truncated') === 'true');
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_MEMORY_MAX_FILES: '1',
});
try {
  const memoryDir = join(server.claudeDir, 'projects', 'memory-cap-project', 'memory');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'first.md'), 'first memory marker\n');
  await writeFile(join(memoryDir, 'second.md'), 'second memory marker\n');

  const r = await fetch(`${server.base}/api/memories`);
  const body = await json(r);
  const returnedFiles =
    body?.projects?.reduce?.((total, project) => total + (project.files?.length || 0), 0) ?? 0;
  check('memory file entry cap -> 200', r.status === 200, `got ${r.status}`);
  check('memory file entry cap preserves object body', body && typeof body === 'object');
  check('memory file entry cap limits returned files', returnedFiles === 1, `got ${returnedFiles}`);
  check('memory file entry cap reports max files', body?.limits?.maxFiles === 1);
  check('memory file entry cap reports truncation', body?.truncated === true);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_MEMORY_DIR_MAX_ENTRIES: '1',
});
try {
  const firstMemoryDir = join(server.claudeDir, 'projects', 'memory-dir-a', 'memory');
  const secondMemoryDir = join(server.claudeDir, 'projects', 'memory-dir-b', 'memory');
  await mkdir(firstMemoryDir, { recursive: true });
  await mkdir(secondMemoryDir, { recursive: true });
  await writeFile(join(firstMemoryDir, 'first.md'), 'first memory dir marker\n');
  await writeFile(join(secondMemoryDir, 'second.md'), 'second memory dir marker\n');

  const r = await fetch(`${server.base}/api/memories`);
  const body = await json(r);
  check('memory directory entry cap -> 200', r.status === 200, `got ${r.status}`);
  check('memory directory entry cap preserves object body', body && typeof body === 'object');
  check('memory directory entry cap reports directory max', body?.limits?.directoryMaxEntries === 1);
  check('memory directory entry cap reports truncation', body?.truncated === true);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_RAW_SESSION_MAX_PARTS: '2',
});
try {
  const projectDir = join(server.claudeDir, 'projects', 'raw-part-project');
  const subagentDir = join(projectDir, 'raw-session', 'subagents');
  await mkdir(subagentDir, { recursive: true });
  await writeFile(join(projectDir, 'raw-session.jsonl'), 'top raw part\n');
  await writeFile(join(subagentDir, 'agent-a.jsonl'), 'agent raw part a\n');
  await writeFile(join(subagentDir, 'agent-b.jsonl'), 'agent raw part b\n');
  await writeFile(join(subagentDir, 'agent-c.jsonl'), 'agent raw part c\n');

  const r = await fetch(`${server.base}/projects/raw-part-project/raw-session.jsonl`);
  const body = await json(r);
  check('raw merged session part cap -> 413', r.status === 413, `got ${r.status}`);
  check(
    'raw merged session part cap reports max parts',
    body?.maxParts === 2,
    `got ${body?.maxParts}`
  );
  check(
    'raw merged session part cap uses part-limit error',
    body?.error?.includes?.('part limit')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_WORKFLOW_RUN_MAX_ENTRIES: '1',
});
try {
  const workflowDir = join(
    server.claudeDir,
    'projects',
    'workflow-cap-project',
    'workflow-cap-session',
    'workflows'
  );
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, 'wf_first.json'),
    JSON.stringify({
      runId: 'wf-first',
      workflowName: 'First capped workflow',
      status: 'completed',
      startTime: 1767225600000,
    })
  );
  await writeFile(
    join(workflowDir, 'wf_second.json'),
    JSON.stringify({
      runId: 'wf-second',
      workflowName: 'Second capped workflow',
      status: 'completed',
      startTime: 1767225600001,
    })
  );

  const r = await fetch(`${server.base}/api/workflows`);
  const body = await json(r);
  check('workflow run entry cap -> 200', r.status === 200, `got ${r.status}`);
  check('workflow run entry cap preserves object body', body && typeof body === 'object');
  check('workflow run entry cap limits returned runs', body?.runs?.length === 1, `got ${body?.runs?.length}`);
  check('workflow run entry cap reports max runs', body?.limits?.maxRuns === 1);
  check('workflow run entry cap reports truncation', body?.truncated === true);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_DATASET_RESPONSE_MAX_BYTES: '1024',
});
try {
  const r = await fetch(`${server.base}/api/dataset.json`);
  const body = await json(r);
  check('dataset response byte cap -> 413', r.status === 413, `got ${r.status}`);
  check('dataset response byte cap reports max bytes', body?.maxBytes === 1024);
  check('dataset response byte cap reports actual bytes', body?.actualBytes > 1024);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES: '1',
});
try {
  const r = await fetch(`${server.base}/api/recommendations.json`);
  const body = await json(r);
  check('recommendations response byte cap -> 413', r.status === 413, `got ${r.status}`);
  check('recommendations response byte cap reports max bytes', body?.maxBytes === 1);
  check('recommendations response byte cap reports actual bytes', body?.actualBytes > 1);
} finally {
  await server.stop();
}

let epochCookie = '';
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_AUTH_SESSION_EPOCH: sessionEpoch,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  epochCookie = enterpriseSessionCookie(r);
  check('enterprise browser session epoch exchange -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise browser session epoch sets cookie', epochCookie.startsWith('chd_enterprise_session='));

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: epochCookie },
  });
  const body = await json(r);
  check('enterprise browser session epoch authenticates -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise browser session epoch returns principal', body?.principal?.userId === 'u-admin');
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_AUTH_SESSION_EPOCH: `${sessionEpoch}-rotated`,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: epochCookie },
  });
  const body = await json(r);
  check('enterprise stale browser session epoch fails closed -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise stale browser session epoch clears cookie', setCookieHeader(r).includes('Max-Age=0'));
  check('enterprise stale browser session epoch reports unauthenticated', body?.authenticated === false);

  const audit = await readAuditLogUntil(
    server.auditLog,
    ({ raw, events }) =>
      !raw.includes(sessionEpoch) &&
      events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'stale_session')
  );
  check('enterprise stale browser session epoch audit records stale session', audit.events.some((e) => e.reason === 'stale_session'));
  check('enterprise stale browser session epoch audit redacts epoch', !audit.raw.includes(sessionEpoch));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_AUTH_SESSION_EPOCH: 'epoch-secret-leak-'.repeat(80),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized browser session epoch fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized browser session epoch reports byte limit',
    body?.configError?.includes('DASHBOARD_AUTH_SESSION_EPOCH exceeds 1024 byte limit')
  );
  check('enterprise oversized browser session epoch redacts payload', !bodyText.includes('epoch-secret-leak'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ENABLE_SERVER_LLM_AUDITS: 'true',
  DASHBOARD_AUDIT_MAX_JUDGE_CALLS: '0',
  DASHBOARD_AUDIT_INPUT_MAX_ROWS: '1',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ANTHROPIC_API_KEY: 'fake-test-key',
});
try {
  const r = await fetch(`${server.base}/api/audit.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise server LLM audit zero budget -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise server LLM audit zero budget reports ran status', body?.status === 'ran');
  check('enterprise server LLM audit zero budget returns findings array', Array.isArray(body?.findings));
  check('enterprise server LLM audit zero budget is enabled path', body?.disabled !== true);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_AUTH_RATE_LIMIT: '0',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const rateLimitControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'rate-limits'
  );
  check('enterprise disabled rate-limit posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise disabled rate-limit posture is action-required',
    rateLimitControl?.state === 'action-required' &&
      rateLimitControl?.summary?.includes('auth/session') &&
      rateLimitControl?.detail?.includes('ENTERPRISE_AUTH_RATE_LIMIT=0')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_AUDIT_RESPONSE_MAX_BYTES: '1',
});
try {
  const r = await fetch(`${server.base}/api/audit.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('audit response byte cap -> 413', r.status === 413, `got ${r.status}`);
  check('audit response byte cap reports max bytes', body?.maxBytes === 1);
  check('audit response byte cap reports actual bytes', body?.actualBytes > 1);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES: '1',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('organization response byte cap -> 413', r.status === 413, `got ${r.status}`);
  check('organization response byte cap reports max bytes', body?.maxBytes === 1);
  check('organization response byte cap reports actual bytes', body?.actualBytes > 1);
} finally {
  await server.stop();
}

server = await startServer({
  POLICY_WRITE_TOKEN: `oversized-policy-write-token-${'x'.repeat(9000)}`,
});
try {
  const r = await fetch(`${server.base}/api/csrf-token`);
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('local oversized policy write token bootstrap -> 200', r.status === 200, `got ${r.status}`);
  check(
    'local oversized policy write token returns bounded token',
    Buffer.byteLength(body?.token || '', 'utf8') <= 8_192
  );
  check('local oversized policy write token redacts override', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: orgBoundaryTokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${otherOrgToken}` },
  });
  let body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise cross-org token config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check('enterprise cross-org token config marks auth unconfigured', body?.configured === false);
  check(
    'enterprise cross-org token config reports org boundary',
    body?.configError?.includes?.('outside DASHBOARD_ORG_ID')
  );
  check('enterprise cross-org token config redacts token', !bodyText.includes(otherOrgToken));

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check(
    'enterprise cross-org token config blocks same-org route -> 503',
    r.status === 503,
    `got ${r.status}`
  );
  check(
    'enterprise cross-org protected route reports config error',
    body?.error?.includes?.('outside DASHBOARD_ORG_ID')
  );

  const audit = await readAuditLog(server.auditLog, 2);
  check(
    'enterprise cross-org token config audit records config error',
    audit.events.some(
      (e) =>
        e.reason === 'config_error' &&
        e.path === '/sessions-manifest.json'
    )
  );
  check('enterprise cross-org token config audit redacts token', !audit.raw.includes(otherOrgToken));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/not-a-route`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  check('enterprise rejects unclassified protected api route -> 403', r.status === 403, `got ${r.status}`);
  check(
    'enterprise unclassified protected api route reports forbidden',
    body?.error?.includes?.('not allowed to access')
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise same-org admin reads org roster -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise org roster keeps same-org principal',
    body?.principals?.some?.((p) => p.userId === 'u-admin' && p.orgId === 'acme')
  );
} finally {
  await server.stop();
}

const hostProjectRoot = await mkdtemp(join(tmpdir(), 'enterprise-host-project-'));
await writeFile(join(hostProjectRoot, 'AGENTS.md'), 'host project secret marker\n');
const hostSymlinkSecret = join(hostProjectRoot, 'host-symlink-secret.jsonl');
const hostWorkflowSecret = join(hostProjectRoot, 'wf_host_secret.json');
await writeFile(
  hostSymlinkSecret,
  '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"host symlink secret"}}\n'
);
await writeFile(
  hostWorkflowSecret,
  JSON.stringify({
    runId: 'wf-host-secret',
    workflowName: 'Host Secret Workflow',
    status: 'completed',
    startTime: 1767225600000,
    durationMs: 50,
    agentCount: 1,
    totalTokens: 1,
    totalToolCalls: 1,
  })
);
const scopedRoot = await createScopedClaudeRoot(hostProjectRoot);
await writeIdentityRecommendationTasks(
  scopedRoot,
  'u-member',
  'member@example.com',
  'u-admin',
  'u-viewer'
);
await symlink(
  hostSymlinkSecret,
  join(scopedRoot, 'projects', 'scoped-project', 'linked-host.jsonl')
);
await symlink(
  hostSymlinkSecret,
  join(scopedRoot, 'projects', 'scoped-project', 'scoped-session', 'subagents', 'linked-host.jsonl')
);
await symlink(
  join(hostProjectRoot, 'AGENTS.md'),
  join(scopedRoot, 'projects', 'scoped-project', 'memory', 'linked-host.md')
);
await symlink(
  hostWorkflowSecret,
  join(scopedRoot, 'projects', 'scoped-project', 'scoped-session', 'workflows', 'wf_host_secret.json')
);
const scopedTokenConfig = JSON.stringify([
  {
    token,
    userId: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'platform',
    teamName: 'Platform Team',
  },
  {
    token: viewerToken,
    userId: 'u-viewer',
    email: 'viewer@example.com',
    name: 'Viewer User',
    role: 'viewer',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'support',
    teamName: 'Support Team',
  },
  {
    token: memberToken,
    userId: 'u-member',
    email: 'member@example.com',
    name: 'Member User',
    role: 'member',
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'research',
    teamName: 'Research Team',
    dataRoot: scopedRoot,
  },
]);

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: scopedTokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_RAW_FILE_MAX_BYTES: '65536',
  DASHBOARD_TRANSCRIPT_DECOMPRESS_MAX_BYTES: '65536',
  DASHBOARD_INGEST_SESSION_MAX_BYTES: '65536',
  DASHBOARD_LIVE_SESSION_MAX_BYTES: '65536',
  DASHBOARD_CONFIG_FILE_MAX_BYTES: '1024',
  DASHBOARD_ARTIFACT_FILE_MAX_BYTES: '65536',
  DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES: '50000',
  DASHBOARD_MEMORY_FILE_MAX_BYTES: '512',
  DASHBOARD_MEMORY_RESPONSE_MAX_BYTES: '2048',
  DASHBOARD_WORKFLOW_MANIFEST_MAX_BYTES: '1024',
});
try {
  const globalProject = join(server.claudeDir, 'projects', 'global-project');
  await mkdir(globalProject, { recursive: true });
  await writeFile(
    join(globalProject, 'global-session.jsonl'),
    '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"global history"}}\n'
  );
  await writeFile(
    join(globalProject, 'scoped-session.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"global twin"}]}}\n'
  );
  await writeFile(
    join(server.claudeDir, 'history.jsonl'),
    '{"sessionId":"global-session","cwd":"/global/project","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"global history"}}\n'
  );

  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  let body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise scoped member session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member has data root flag', body?.principal?.dataRootConfigured === true);
  check('enterprise scoped member has team id', body?.principal?.teamId === 'research');
  check('enterprise scoped member has team name', body?.principal?.teamName === 'Research Team');
  check('enterprise scoped member can read own sessions', body?.capabilities?.canReadOwnSessions === true);
  check('enterprise scoped member cannot read org data', body?.capabilities?.canReadOrganizationData === false);
  check('enterprise scoped member can read scoped transcript cache', body?.capabilities?.canReadRawTranscripts === true);
  check('enterprise scoped member session redacts data root', !bodyText.includes(scopedRoot));
  check('enterprise scoped member session redacts token', !bodyText.includes(memberToken));

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member manifest -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise scoped member manifest reads scoped session',
    body?.some?.((entry) => entry.project === 'scoped-project' && entry.name === 'scoped-session.jsonl')
  );
  check('enterprise scoped member manifest excludes global session', !bodyText.includes('global-session'));
  check('enterprise scoped member manifest excludes symlinked host file', !bodyText.includes('linked-host.jsonl'));

  r = await fetch(`${server.base}/history.jsonl`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  bodyText = await r.text();
  check('enterprise scoped member history -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member history reads scoped root', bodyText.includes('scoped history'));
  check('enterprise scoped member history excludes global root', !bodyText.includes('global history'));

  r = await fetch(`${server.base}/projects/scoped-project/scoped-session.jsonl`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  bodyText = await r.text();
  check('enterprise scoped member project read -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member project read includes top transcript', bodyText.includes('top scoped'));
  check('enterprise scoped member project read includes subagent transcript', bodyText.includes('sub scoped'));
  check('enterprise scoped member project read excludes symlinked host file', !bodyText.includes('host symlink secret'));

  r = await fetch(`${server.base}/projects/scoped-project/linked-host.jsonl`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  check('enterprise scoped member symlinked project file -> 404', r.status === 404, `got ${r.status}`);
  check('enterprise scoped member protected 404 is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/api/memories`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member memories -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member memories read scoped root', bodyText.includes('scoped note'));
  check('enterprise scoped member memories exclude symlinked host file', !bodyText.includes('host project secret marker'));
  check('enterprise scoped member memories reports file cap', body?.limits?.fileMaxBytes === 512);
  check(
    'enterprise scoped member memories reports response cap',
    body?.limits?.responseMaxBytes === 2048
  );
  check(
    'enterprise scoped member memories reports file entry cap',
    body?.limits?.maxFiles === 50_000
  );

  await writeFile(
    join(scopedRoot, 'projects', 'scoped-project', 'memory', 'huge.md'),
    `${'oversized memory marker '.repeat(40)}\n`
  );
  r = await fetch(`${server.base}/api/memories`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member memories with oversized file -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member memories skip oversized file', !bodyText.includes('oversized memory marker'));
  check('enterprise scoped member memories keep bounded file', bodyText.includes('scoped note'));
  check('enterprise scoped member memories report skipped file', body?.skippedFiles >= 1);
  check('enterprise scoped member memories report truncation', body?.truncated === true);

  r = await fetch(`${server.base}/api/workflows`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member workflows -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member workflows read scoped root', bodyText.includes('wf-scoped'));
  check('enterprise scoped member workflows exclude symlinked host file', !bodyText.includes('wf-host-secret'));
  check(
    'enterprise scoped member workflows reports manifest cap',
    body?.limits?.manifestMaxBytes === 1024
  );
  check(
    'enterprise scoped member workflows reports projection caps',
    body?.limits?.maxPhasesPerRun === 500 &&
      body?.limits?.maxProgressEntriesPerRun === 5000 &&
      body?.limits?.fieldMaxChars === 4096
  );

  await writeFile(
    join(scopedRoot, 'projects', 'scoped-project', 'scoped-session', 'workflows', 'wf_huge.json'),
    JSON.stringify({
      runId: 'wf-huge',
      workflowName: 'Oversized Workflow',
      status: 'completed',
      startTime: 1767225600001,
      workflowProgress: [
        { type: 'workflow_agent', resultPreview: 'oversized workflow marker '.repeat(40) },
      ],
    })
  );
  r = await fetch(`${server.base}/api/workflows`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member workflows with oversized manifest -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member workflows skip oversized manifest', !bodyText.includes('wf-huge'));
  check('enterprise scoped member workflows keep bounded manifest', bodyText.includes('wf-scoped'));
  check('enterprise scoped member workflows report skipped manifest', body?.skippedManifests >= 1);

  await writeFile(
    join(scopedRoot, 'history.jsonl'),
    `${JSON.stringify({
      sessionId: 'oversized-history-session',
      cwd: '/scoped/project',
      timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'user',
        content: 'oversized history marker '.repeat(4000),
      },
    })}\n`
  );
  await writeFile(
    join(scopedRoot, 'projects', 'scoped-project', 'huge-transcript.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'oversized transcript marker '.repeat(3000) },
        ],
      },
    })}\n`
  );
  r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  const scopedDatasetIngestHeader = r.headers.get('x-ingest') || '';
  check('enterprise scoped member dataset -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member dataset reads scoped entries', bodyText.includes('top scoped'));
  check('enterprise scoped member dataset excludes global root', !bodyText.includes('global twin'));
  check('enterprise scoped member dataset excludes global history', !bodyText.includes('global history'));
  check('enterprise scoped member dataset skips oversized history artifact', !bodyText.includes('oversized history marker'));
  check('enterprise scoped member dataset excludes host project config', !bodyText.includes('host project secret marker'));
  check(
    'enterprise scoped member dataset reports skipped oversized session',
    scopedDatasetIngestHeader.includes('skippedSessions=1'),
    scopedDatasetIngestHeader
  );

  r = await fetch(`${server.base}/api/recommendations.json`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  check('enterprise scoped member recommendations -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member recommendations body is array', Array.isArray(body));
  check(
    'enterprise scoped member recommendations omit org identity aliases',
    !body?.some?.((rec) => rec?.id === 'workflow.owner-concentration')
  );
  check(
    'enterprise scoped member recommendations cache miss',
    r.headers.get('x-recommendations-cache') === 'miss',
    r.headers.get('x-recommendations-cache') || ''
  );
  r = await fetch(`${server.base}/api/recommendations.json`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  check('enterprise scoped member cached recommendations -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise scoped member recommendations cache hit',
    r.headers.get('x-recommendations-cache') === 'hit',
    r.headers.get('x-recommendations-cache') || ''
  );

  r = await fetch(`${server.base}/api/live`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  check('enterprise scoped member live state -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member live state is scoped JSON', body && typeof body === 'object');

  r = await fetch(`${server.base}/api/transcript/scoped-session`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member transcript -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member transcript reads scoped root', bodyText.includes('sub scoped'));
  check('enterprise scoped member transcript excludes global root', !bodyText.includes('global twin'));

  r = await fetch(`${server.base}/api/session/scoped-session/timeline`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise scoped member timeline detail -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped member timeline detail reads scoped root', bodyText.includes('top scoped'));
  check('enterprise scoped member timeline detail excludes global root', !bodyText.includes('global twin'));

  r = await fetch(`${server.base}/api/transcript/huge-transcript`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  check('enterprise scoped member oversized lazy transcript -> 413', r.status === 413, `got ${r.status}`);
  check('enterprise scoped member oversized lazy transcript reports cap', body?.maxBytes === 65_536);

  await writeFile(
    join(scopedRoot, 'projects', 'scoped-project', 'huge-session.jsonl'),
    `${'x'.repeat(70_000)}\n`
  );
  r = await fetch(`${server.base}/projects/scoped-project/huge-session.jsonl`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  check('enterprise scoped member oversized project read -> 413', r.status === 413, `got ${r.status}`);
  check('enterprise scoped member oversized project read reports cap', body?.maxBytes === 65_536);

  await writeFile(join(scopedRoot, 'history.jsonl'), `${'h'.repeat(70_000)}\n`);
  r = await fetch(`${server.base}/history.jsonl`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  body = await json(r);
  check('enterprise scoped member oversized history -> 413', r.status === 413, `got ${r.status}`);
  check('enterprise scoped member oversized history reports cap', body?.maxBytes === 65_536);

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise rootless viewer still cannot read manifest', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise rootless viewer cannot read dataset', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  const scopedDataRootBoundary = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'data-root-boundary'
  );
  check('enterprise organization includes scoped principal', body?.principals?.length === 3);
  check(
    'enterprise organization exposes data root flag only',
    body?.principals?.some((p) => p.userId === 'u-member' && p.dataRootConfigured === true)
  );
  check(
    'enterprise organization flags scoped roots without a base',
    scopedDataRootBoundary?.state === 'action-required'
  );
  check(
    'enterprise organization exposes scoped principal team',
    body?.principals?.some(
      (p) => p.userId === 'u-member' && p.teamId === 'research' && p.teamName === 'Research Team'
    )
  );
  check(
    'enterprise organization returns scoped team rollup',
    body?.teams?.some(
      (t) =>
        t.teamId === 'research' &&
        t.principalCount === 1 &&
        t.memberCount === 1 &&
        t.scopedDataRoots === 1
    )
  );
  check(
    'enterprise organization identity coverage counts principals',
    body?.identityCoverage?.contributors?.total === 3
  );
  check(
    'enterprise organization identity coverage counts email aliases',
    body?.identityCoverage?.aliases?.email === 3
  );
  check(
    'enterprise organization identity coverage counts scoped roots',
    body?.identityCoverage?.contributors?.withScopedDataRoot === 1 &&
      body?.identityCoverage?.teams?.withScopedDataRoots === 1
  );
  check(
    'enterprise organization identity coverage is redacted',
    body?.identityCoverage?.privacy?.redacted === true &&
      body?.identityCoverage?.privacy?.excludes?.includes?.('data roots')
  );
  check('enterprise organization redacts scoped data root', !bodyText.includes(scopedRoot));
  check('enterprise organization redacts member token', !bodyText.includes(memberToken));
} finally {
  await server.stop();
  await rm(scopedRoot, { recursive: true, force: true });
  await rm(hostProjectRoot, { recursive: true, force: true });
}

const dataRootBaseAllowed = await createScopedClaudeRoot('/data-root/base/allowed');
const dataRootBaseOutside = await createScopedClaudeRoot('/data-root/base/outside');
const dataRootLinkedOutside = join(dataRootBaseAllowed, 'linked-outside-root');
await symlink(dataRootBaseOutside, dataRootLinkedOutside);
const dataRootBaseMemberToken = 'enterprise-data-root-base-member-token';
const dataRootOutsideMemberToken = 'enterprise-data-root-outside-member-token';
const dataRootSymlinkMemberToken = 'enterprise-data-root-symlink-member-token';
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_DATA_ROOT_BASE: dataRootBaseAllowed,
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token,
      userId: 'u-admin',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
      orgId: 'acme',
      orgName: 'Acme',
    },
    {
      token: dataRootBaseMemberToken,
      userId: 'u-base-member',
      email: 'base-member@example.com',
      name: 'Base Member',
      role: 'member',
      orgId: 'acme',
      orgName: 'Acme',
      dataRoot: dataRootBaseAllowed,
    },
    {
      token: dataRootOutsideMemberToken,
      userId: 'u-outside-member',
      email: 'outside-member@example.com',
      name: 'Outside Member',
      role: 'member',
      orgId: 'acme',
      orgName: 'Acme',
      dataRoot: dataRootBaseOutside,
    },
    {
      token: dataRootSymlinkMemberToken,
      userId: 'u-symlink-member',
      email: 'symlink-member@example.com',
      name: 'Symlink Member',
      role: 'member',
      orgId: 'acme',
      orgName: 'Acme',
      dataRoot: dataRootLinkedOutside,
    },
  ]),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${dataRootBaseMemberToken}` },
  });
  let body = await json(r);
  check('enterprise data-root base member session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise data-root base preserves in-base scoped root',
    body?.principal?.dataRootConfigured === true &&
      body?.capabilities?.canReadOwnSessions === true
  );

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${dataRootBaseMemberToken}` },
  });
  body = await json(r);
  check('enterprise data-root base member can read scoped manifest', r.status === 200, `got ${r.status}`);
  check(
    'enterprise data-root base member sees scoped fixture',
    body?.some?.((entry) => entry.project === 'scoped-project' && entry.name === 'scoped-session.jsonl')
  );

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${dataRootOutsideMemberToken}` },
  });
  body = await json(r);
  check('enterprise outside-root member session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise data-root base strips outside scoped root',
    body?.principal?.dataRootConfigured === false &&
      body?.capabilities?.canReadOwnSessions === false
  );

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${dataRootOutsideMemberToken}` },
  });
  check('enterprise outside-root member cannot read scoped manifest', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${dataRootSymlinkMemberToken}` },
  });
  body = await json(r);
  check('enterprise symlink-root member session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise data-root base strips symlink escape root',
    body?.principal?.dataRootConfigured === false &&
      body?.capabilities?.canReadOwnSessions === false
  );

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${dataRootSymlinkMemberToken}` },
  });
  check('enterprise symlink-root member cannot read scoped manifest', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const dataRootBoundaryControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'data-root-boundary'
  );
  check(
    'enterprise data-root base posture is enabled',
    dataRootBoundaryControl?.state === 'enabled' &&
      dataRootBoundaryControl?.summary?.includes(dataRootBaseAllowed)
  );
} finally {
  await server.stop();
  await rm(dataRootBaseAllowed, { recursive: true, force: true });
  await rm(dataRootBaseOutside, { recursive: true, force: true });
}

const scopeEnforcedRoot = await createScopedClaudeRoot('/scope/enforced');
const scopeSessionToken = 'enterprise-scope-session-token';
const scopeNoScopeToken = 'enterprise-scope-noscope-token';
const scopeReadAdminToken = 'enterprise-scope-read-admin-token';
const scopeFullAdminToken = 'enterprise-scope-full-admin-token';
const scopeEnforcedTokenConfig = JSON.stringify([
  {
    token: scopeSessionToken,
    userId: 'scope-member',
    email: 'scope-member@example.com',
    name: 'Scope Member',
    role: 'member',
    scopes: ['sessions:read'],
    orgId: 'acme',
    orgName: 'Acme',
    teamId: 'research',
    teamName: 'Research Team',
    dataRoot: scopeEnforcedRoot,
  },
  {
    token: scopeNoScopeToken,
    userId: 'scope-noscope',
    email: 'scope-noscope@example.com',
    name: 'No Scope Member',
    role: 'member',
    orgId: 'acme',
    orgName: 'Acme',
    dataRoot: scopeEnforcedRoot,
  },
  {
    token: scopeReadAdminToken,
    userId: 'scope-read-admin',
    email: 'scope-read-admin@example.com',
    name: 'Read Admin',
    role: 'admin',
    scopes: ['org:read'],
    orgId: 'acme',
    orgName: 'Acme',
  },
  {
    token: scopeFullAdminToken,
    userId: 'scope-full-admin',
    email: 'scope-full-admin@example.com',
    name: 'Full Admin',
    role: 'admin',
    scopes: ['org:read', 'org:write', 'audit:read'],
    orgId: 'acme',
    orgName: 'Acme',
  },
]);
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: scopeEnforcedTokenConfig,
  DASHBOARD_AUTH_ENFORCE_SCOPES: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${scopeSessionToken}` },
  });
  let body = await json(r);
  check('enterprise scoped enforcement member session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise scoped enforcement member keeps scoped read capability',
    body?.capabilities?.canReadOwnSessions === true
  );
  check(
    'enterprise scoped enforcement member cannot read org data',
    body?.capabilities?.canReadOrganizationData === false
  );

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${scopeSessionToken}` },
  });
  check('enterprise scoped enforcement member reads scoped manifest', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${scopeSessionToken}` },
  });
  check('enterprise scoped enforcement member cannot read organization', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/readiness-receipt`, {
    headers: { Authorization: `Bearer ${scopeSessionToken}` },
  });
  check('enterprise scoped enforcement member cannot read readiness receipt', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/audit-export.ndjson`, {
    headers: { Authorization: `Bearer ${scopeSessionToken}` },
  });
  check('enterprise scoped enforcement member cannot export audit log', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${scopeNoScopeToken}` },
  });
  body = await json(r);
  check('enterprise scoped enforcement no-scope member session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise scoped enforcement no-scope member loses scoped capability',
    body?.capabilities?.canReadOwnSessions === false
  );

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${scopeNoScopeToken}` },
  });
  check('enterprise scoped enforcement no-scope member cannot read manifest', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${scopeReadAdminToken}` },
  });
  body = await json(r);
  const scopeControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'scope-enforcement'
  );
  check('enterprise scoped enforcement read admin can read organization', r.status === 200, `got ${r.status}`);
  check(
    'enterprise scoped enforcement posture reports enabled',
    scopeControl?.state === 'enabled'
  );

  r = await fetch(`${server.base}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${scopeReadAdminToken}` },
  });
  check('enterprise scoped enforcement read admin cannot write', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/audit-log`, {
    headers: { Authorization: `Bearer ${scopeReadAdminToken}` },
  });
  check('enterprise scoped enforcement org-read admin can read audit log', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${scopeFullAdminToken}` },
  });
  check('enterprise scoped enforcement full admin can fetch csrf', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/audit-log`, {
    headers: { Authorization: `Bearer ${scopeFullAdminToken}` },
  });
  check('enterprise scoped enforcement full admin can read audit log', r.status === 200, `got ${r.status}`);
} finally {
  await server.stop();
  await rm(scopeEnforcedRoot, { recursive: true, force: true });
}

const boundedScopeToken = 'enterprise-bounded-scope-token';
const sourceBoundedScopeToken = 'enterprise-source-bounded-scope-token';
const oversizedScope = `scope:${'x'.repeat(256)}`;
const oversizedScopeSource = `${'x'.repeat(600)} org:read`;
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token: boundedScopeToken,
      userId: 'bounded-scope-admin',
      role: 'admin',
      scopes: ['sessions:read', oversizedScope, 'org:read'],
      orgId: 'acme',
      orgName: 'Acme',
    },
    {
      token: sourceBoundedScopeToken,
      userId: 'source-bounded-scope-admin',
      role: 'admin',
      scopes: ['sessions:read', oversizedScopeSource],
      orgId: 'acme',
      orgName: 'Acme',
    },
  ]),
  DASHBOARD_AUTH_ENFORCE_SCOPES: 'true',
  DASHBOARD_AUTH_SCOPE_MAX_ENTRIES: '2',
  DASHBOARD_AUTH_SCOPE_SOURCE_MAX_BYTES: '512',
  DASHBOARD_AUTH_SCOPE_MAX_CHARS: '32',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${boundedScopeToken}` },
  });
  let body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise bounded scope admin session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise bounded scope admin keeps scope entry cap', body?.principal?.scopes?.length === 2);
  check(
    'enterprise bounded scope admin caps long scope value',
    body?.principal?.scopes?.[1]?.length === 32 && body?.principal?.scopes?.[1]?.includes('-')
  );
  check('enterprise bounded scope admin redacts long scope payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
  check(
    'enterprise bounded scope admin ignores over-cap org scope',
    body?.capabilities?.canReadOrganizationData === false
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${boundedScopeToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise bounded scope admin cannot read organization', r.status === 403, `got ${r.status}`);
  check('enterprise bounded scope admin denial redacts long scope payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${sourceBoundedScopeToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise source-bounded scope admin session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise source-bounded scope admin drops oversized source', body?.principal?.scopes?.length === 1);
  check('enterprise source-bounded scope admin ignores embedded org scope', body?.capabilities?.canReadOrganizationData === false);
  check('enterprise source-bounded scope admin redacts source payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${sourceBoundedScopeToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise source-bounded scope admin cannot read organization', r.status === 403, `got ${r.status}`);
  check('enterprise source-bounded scope denial redacts source payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

const scopedRootA = await createScopedClaudeRoot('/tenant/a');
const scopedRootB = await createScopedClaudeRoot('/tenant/b');
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: scopedCacheTokenConfig(scopedRootA, scopedRootB),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_SCOPED_DATASET_MAX_STATES: '1',
});
try {
  let r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: 'Bearer enterprise-member-a-token' },
  });
  let bodyText = await r.text();
  check('enterprise scoped cache member A dataset -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped cache member A reads root A', bodyText.includes('/tenant/a'));
  check(
    'enterprise scoped cache directory is private',
    (await fileMode(join(PROJECT_DIR, '.cache', 'enterprise-roots'))) === 0o700
  );
  check(
    'enterprise scoped cache db is private',
    (await fileMode(scopedCacheDbPath(scopedRootA))) === 0o600
  );

  r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: 'Bearer enterprise-member-b-token' },
  });
  bodyText = await r.text();
  check('enterprise scoped cache member B dataset -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped cache member B reads root B', bodyText.includes('/tenant/b'));

  r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: 'Bearer enterprise-member-a-token' },
  });
  bodyText = await r.text();
  check('enterprise scoped cache evicted member A reload -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise scoped cache evicted member A remains isolated', bodyText.includes('/tenant/a') && !bodyText.includes('/tenant/b'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const cacheControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'scoped-cache'
  );
  check('enterprise scoped cache posture reports control', Boolean(cacheControl));
  check(
    'enterprise scoped cache posture reports cap',
    cacheControl?.summary?.includes('max 1')
  );
  check(
    'enterprise scoped cache posture remains bounded',
    cacheControl?.summary?.includes('1 active scoped state')
  );
} finally {
  await server.stop();
}

const relocatedScopedCache = await mkdtemp(join(tmpdir(), 'enterprise-scoped-cache-'));
check(
  'enterprise scoped cache legacy db exists before relocation',
  (await fileMode(scopedCacheDbPath(scopedRootA))) === 0o600
);
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: scopedCacheTokenConfig(scopedRootA, scopedRootB),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  CHD_CACHE_DIR: relocatedScopedCache,
});
try {
  const r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: 'Bearer enterprise-member-a-token' },
  });
  const bodyText = await r.text();
  check('enterprise relocated scoped cache dataset -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise relocated scoped cache reads root A', bodyText.includes('/tenant/a'));
  check(
    'enterprise scoped cache keeps using legacy db fallback',
    (await fileMode(scopedCacheDbPath(scopedRootA))) === 0o600
  );
  check(
    'enterprise scoped cache does not silently rebuild relocated db',
    (await fileMode(scopedCacheDbPath(scopedRootA, relocatedScopedCache))) === -1
  );
} finally {
  await server.stop();
  await rm(relocatedScopedCache, { recursive: true, force: true });
  await rm(scopedRootA, { recursive: true, force: true });
  await rm(scopedRootB, { recursive: true, force: true });
}

const jwtScopedRoot = await createScopedClaudeRoot('/jwt/member');
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE: jwtScopedRoot,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtMemberToken = enterpriseJwt();
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtMemberToken}` },
  });
  let body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise JWT member session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT member resolves principal', body?.principal?.userId === 'jwt-member');
  check('enterprise JWT member maps team id', body?.principal?.teamId === 'platform');
  check('enterprise JWT member maps team name', body?.principal?.teamName === 'Platform Team');
  check(
    'enterprise JWT member maps scopes',
    body?.principal?.scopes?.includes?.('sessions:read') &&
      body?.principal?.scopes?.includes?.('audit:read')
  );
  check('enterprise JWT member has scoped root flag', body?.principal?.dataRootConfigured === true);
  check('enterprise JWT member cannot read org data', body?.capabilities?.canReadOrganizationData === false);
  check('enterprise JWT member session redacts token', !bodyText.includes(jwtMemberToken));
  check('enterprise JWT member session redacts data root', !bodyText.includes(jwtScopedRoot));

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${jwtMemberToken}` },
  });
  body = await json(r);
  bodyText = JSON.stringify(body);
  check('enterprise JWT member manifest -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT member reads scoped manifest', bodyText.includes('scoped-session.jsonl'));

  const jwtAdminToken = enterpriseJwt({
    sub: 'jwt-admin',
    email: 'jwt-admin@example.com',
    name: 'JWT Admin',
    role: 'admin',
  });
  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtAdminToken}` },
  });
  body = await json(r);
  const authControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'auth'
  );
  const jwtClaimControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-claim-pinning'
  );
  const jwtLifetimeControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-token-lifetime'
  );
  const staticJwksBoundsControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwks-network-bounds'
  );
  const bearerSizeControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'bearer-token-size'
  );
  check('enterprise JWT admin can read organization -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT organization includes current admin principal',
    body?.principals?.some((p) => p.userId === 'jwt-admin' && p.role === 'admin')
  );
  check(
    'enterprise JWT posture reports signing key',
    authControl?.summary?.includes('1 static JWT signing key')
  );
  check(
    'enterprise JWT posture reports pinned claims',
    jwtClaimControl?.state === 'enabled'
  );
  check(
    'enterprise JWT posture reports bounded token lifetime',
    jwtLifetimeControl?.state === 'enabled' &&
      jwtLifetimeControl?.summary?.includes?.('86400 seconds')
  );
  check(
    'enterprise JWT posture reports static JWKS byte cap',
    staticJwksBoundsControl?.state === 'enabled' &&
      staticJwksBoundsControl?.summary?.includes('65536 byte') &&
      staticJwksBoundsControl?.summary?.includes('32 key')
  );
  check(
    'enterprise JWT posture reports decoded segment caps',
    bearerSizeControl?.detail?.includes?.('DASHBOARD_AUTH_JWT_HEADER_MAX_BYTES=2048') &&
      bearerSizeControl?.detail?.includes?.('DASHBOARD_AUTH_JWT_CLAIMS_MAX_BYTES=16384') &&
      bearerSizeControl?.detail?.includes?.('DASHBOARD_AUTH_JWT_SIGNATURE_MAX_BYTES=4096')
  );

  const wrongIssuerToken = enterpriseJwt({ iss: 'https://wrong.example.test' });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${wrongIssuerToken}` },
  });
  check('enterprise JWT rejects wrong issuer', r.status === 401, `got ${r.status}`);

  const expiredToken = enterpriseJwt({ exp: Math.floor(Date.now() / 1000) - 500 });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${expiredToken}` },
  });
  check('enterprise JWT rejects expired token', r.status === 401, `got ${r.status}`);

  const missingIssuedAtToken = enterpriseJwt({ iat: undefined });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${missingIssuedAtToken}` },
  });
  check('enterprise JWT rejects token without issued-at', r.status === 401, `got ${r.status}`);

  const issuedAt = Math.floor(Date.now() / 1000);
  const excessiveLifetimeToken = enterpriseJwt({
    iat: issuedAt,
    exp: issuedAt + 86_401,
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${excessiveLifetimeToken}` },
  });
  check('enterprise JWT rejects excessive token lifetime', r.status === 401, `got ${r.status}`);

  const issuedAfterExpirationToken = enterpriseJwt({
    iat: issuedAt + 30,
    exp: issuedAt + 10,
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${issuedAfterExpirationToken}` },
  });
  check('enterprise JWT rejects issued-at after expiration', r.status === 401, `got ${r.status}`);

  const notBeforeAfterExpirationToken = enterpriseJwt({
    iat: issuedAt,
    nbf: issuedAt + 30,
    exp: issuedAt + 10,
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${notBeforeAfterExpirationToken}` },
  });
  check('enterprise JWT rejects not-before after expiration', r.status === 401, `got ${r.status}`);

  const objectSubjectToken = enterpriseJwt({ sub: { id: 'jwt-object-subject' } });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${objectSubjectToken}` },
  });
  check('enterprise JWT rejects non-string subject claim', r.status === 401, `got ${r.status}`);

  const objectEmailToken = enterpriseJwt({
    sub: undefined,
    preferred_username: undefined,
    email: { address: 'jwt-object-email@example.com' },
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${objectEmailToken}` },
  });
  check('enterprise JWT rejects non-string email identity claim', r.status === 401, `got ${r.status}`);

  const objectTeamToken = enterpriseJwt({
    sub: 'jwt-object-team',
    team: { id: 'platform' },
    team_name: { name: 'Platform Team' },
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${objectTeamToken}` },
  });
  body = await json(r);
  check('enterprise JWT ignores non-string team claim', r.status === 200, `got ${r.status}`);
  check('enterprise JWT non-string team claim maps no team id', !body?.principal?.teamId);
  check('enterprise JWT non-string team claim maps no team name', !body?.principal?.teamName);

  const numericKidToken = enterpriseJwt({}, { kid: 123 });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${numericKidToken}` },
  });
  check('enterprise JWT rejects non-string key id', r.status === 401, `got ${r.status}`);

  const blankKidToken = enterpriseJwt({}, { kid: '   ' });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${blankKidToken}` },
  });
  check('enterprise JWT rejects blank key id', r.status === 401, `got ${r.status}`);
} finally {
  await server.stop();
  await rm(jwtScopedRoot, { recursive: true, force: true });
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_CLAIMS_MAX_BYTES: '512',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const oversizedClaimsToken = enterpriseJwt({ padding: 'x'.repeat(2048) });
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${oversizedClaimsToken}` },
  });
  check('enterprise JWT rejects oversized claims segment', r.status === 401, `got ${r.status}`);
} finally {
  await server.stop();
}

const jwtSegmentBase = await mkdtemp(join(tmpdir(), 'enterprise-jwt-segments-'));
const longJwtSubA = `${'a'.repeat(180)}alpha`;
const longJwtSubB = `${'a'.repeat(180)}bravo`;
const jwtSegmentA = jwtPathSegmentForTest(longJwtSubA);
const jwtSegmentB = jwtPathSegmentForTest(longJwtSubB);
await populateScopedClaudeRoot(join(jwtSegmentBase, jwtSegmentA), '/jwt/collision/a');
await populateScopedClaudeRoot(join(jwtSegmentBase, jwtSegmentB), '/jwt/collision/b');
await writeFile(
  join(jwtSegmentBase, jwtSegmentA, 'history.jsonl'),
  `${JSON.stringify({
    sessionId: 'jwt-collision-a',
    cwd: '/jwt/collision/a',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'jwt collision alpha history' },
  })}\n`
);
await writeFile(
  join(jwtSegmentBase, jwtSegmentB, 'history.jsonl'),
  `${JSON.stringify({
    sessionId: 'jwt-collision-b',
    cwd: '/jwt/collision/b',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'jwt collision bravo history' },
  })}\n`
);
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE: join(jwtSegmentBase, '{sub}'),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  check(
    'enterprise JWT long data-root segments keep hash-distinct roots',
    jwtSegmentA !== jwtSegmentB &&
      jwtSegmentA.length <= 160 &&
      jwtSegmentB.length <= 160
  );
  let r = await fetch(`${server.base}/history.jsonl`, {
    headers: { Authorization: `Bearer ${enterpriseJwt({ sub: longJwtSubA })}` },
  });
  let bodyText = await r.text();
  check('enterprise JWT long segment member A history -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT long segment member A reads isolated root',
    bodyText.includes('jwt collision alpha history') &&
      !bodyText.includes('jwt collision bravo history')
  );

  r = await fetch(`${server.base}/history.jsonl`, {
    headers: { Authorization: `Bearer ${enterpriseJwt({ sub: longJwtSubB })}` },
  });
  bodyText = await r.text();
  check('enterprise JWT long segment member B history -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT long segment member B reads isolated root',
    bodyText.includes('jwt collision bravo history') &&
      !bodyText.includes('jwt collision alpha history')
  );
} finally {
  await server.stop();
  await rm(jwtSegmentBase, { recursive: true, force: true });
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE_MAX_BYTES: '128',
  DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE:
    `/srv/claude-history/users/{sub}/${'x'.repeat(2048)}/.claude`,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtOversizedTemplateToken = enterpriseJwt({
    sub: 'jwt-oversized-template-member',
    email: 'jwt-oversized-template-member@example.com',
    name: 'JWT Oversized Template Member',
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtOversizedTemplateToken}` },
  });
  let body = await json(r);
  check('enterprise JWT oversized data-root template session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT oversized data-root template is ignored',
    body?.principal?.dataRootConfigured === false &&
      body?.capabilities?.canReadOwnSessions === false
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const bodyText = JSON.stringify(body);
  const dataRootControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'data-root-boundary'
  );
  check('enterprise JWT oversized data-root template posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT oversized data-root template is action-required',
    dataRootControl?.state === 'action-required' &&
      dataRootControl?.summary?.includes?.('JWT data-root template')
  );
  check(
    'enterprise JWT oversized data-root template reports byte limit',
    dataRootControl?.summary?.includes?.('128 byte limit')
  );
  check('enterprise JWT oversized data-root template redacts payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ADMIN_ROLES: 'owner',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtLiteralAdminToken = enterpriseJwt({
    sub: 'jwt-literal-admin',
    email: 'jwt-literal-admin@example.com',
    name: 'JWT Literal Admin',
    role: 'admin',
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtLiteralAdminToken}` },
  });
  let body = await json(r);
  check('enterprise JWT explicit admin map literal admin session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT explicit admin map does not fallback-promote admin', body?.principal?.role === 'member');
  check('enterprise JWT explicit admin map denies org capability', body?.capabilities?.canReadOrganizationData === false);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtLiteralAdminToken}` },
  });
  check('enterprise JWT explicit admin map denies literal admin org route', r.status === 403, `got ${r.status}`);
} finally {
  await server.stop();
}

const longAdminRole = `administrator-${'x'.repeat(64)}`;
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ROLE_MAP_ENTRY_MAX_CHARS: '16',
  DASHBOARD_AUTH_JWT_ADMIN_ROLES: `owner,${longAdminRole}`,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const longRoleToken = enterpriseJwt({
    sub: 'jwt-long-role',
    email: 'jwt-long-role@example.com',
    name: 'JWT Long Role',
    role: longAdminRole,
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${longRoleToken}` },
  });
  let body = await json(r);
  check('enterprise JWT over-length admin role entry session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT over-length admin role entry is ignored', body?.principal?.role === 'member');
  check(
    'enterprise JWT over-length admin role entry denies org capability',
    body?.capabilities?.canReadOrganizationData === false
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const bodyText = JSON.stringify(body);
  const roleMapControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-role-mapping'
  );
  check(
    'enterprise JWT over-length role map entry is action-required',
    roleMapControl?.state === 'action-required'
  );
  check(
    'enterprise JWT over-length role map entry reports character limit',
    roleMapControl?.summary?.includes?.('16 character limit')
  );
  check('enterprise JWT over-length role map entry redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ADMIN_ROLES: 'owner',
  DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES: '1',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtFirstOwnerToken = enterpriseJwt({
    sub: 'jwt-first-owner',
    email: 'jwt-first-owner@example.com',
    name: 'JWT First Owner',
    role: ['owner', 'member'],
  });
  let r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtFirstOwnerToken}` },
  });
  let body = await json(r);
  const roleMapControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-role-mapping'
  );
  check('enterprise JWT role claim cap keeps first admin value', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT role claim cap is reported',
    roleMapControl?.detail?.includes?.('DASHBOARD_AUTH_JWT_ROLE_CLAIM_MAX_VALUES')
  );

  const jwtLateOwnerToken = enterpriseJwt({
    sub: 'jwt-late-owner',
    email: 'jwt-late-owner@example.com',
    name: 'JWT Late Owner',
    role: ['member', ['owner']],
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtLateOwnerToken}` },
  });
  body = await json(r);
  check('enterprise JWT role claim cap late owner session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT role claim cap ignores late admin role', body?.principal?.role === 'member');
  check(
    'enterprise JWT role claim cap denies late admin capability',
    body?.capabilities?.canReadOrganizationData === false
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtLateOwnerToken}` },
  });
  check('enterprise JWT role claim cap denies late admin route', r.status === 403, `got ${r.status}`);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_BYTES: '128',
  DASHBOARD_AUTH_JWT_ADMIN_ROLES: `owner,${'x'.repeat(2048)}`,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtOwnerToken = enterpriseJwt({
    sub: 'jwt-oversized-owner',
    email: 'jwt-oversized-owner@example.com',
    name: 'JWT Oversized Owner',
    role: 'owner',
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtOwnerToken}` },
  });
  let body = await json(r);
  check('enterprise JWT oversized role map owner session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise JWT oversized role map ignores admin mapping', body?.principal?.role === 'member');
  check('enterprise JWT oversized role map denies org capability', body?.capabilities?.canReadOrganizationData === false);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const bodyText = JSON.stringify(body);
  const roleMapControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-role-mapping'
  );
  check('enterprise JWT oversized role map posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT oversized role map is action-required',
    roleMapControl?.state === 'action-required' &&
      roleMapControl?.summary?.includes?.('DASHBOARD_AUTH_JWT_ADMIN_ROLES')
  );
  check(
    'enterprise JWT oversized role map reports byte limit',
    roleMapControl?.summary?.includes?.('128 byte limit')
  );
  check('enterprise JWT oversized role map redacts payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ROLE_MAP_MAX_ENTRIES: '1',
  DASHBOARD_AUTH_JWT_ADMIN_ROLES: 'owner,administrator',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtOwnerToken = enterpriseJwt({
    sub: 'jwt-capped-owner',
    email: 'jwt-capped-owner@example.com',
    name: 'JWT Capped Owner',
    role: 'owner',
  });
  let r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtOwnerToken}` },
  });
  let body = await json(r);
  const roleMapControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-role-mapping'
  );
  check('enterprise JWT role map entry cap keeps bounded admin role', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT role map entry cap is action-required',
    roleMapControl?.state === 'action-required' &&
      roleMapControl?.summary?.includes?.('1 entry limit')
  );

  const jwtAdministratorToken = enterpriseJwt({
    sub: 'jwt-capped-administrator',
    email: 'jwt-capped-administrator@example.com',
    name: 'JWT Capped Administrator',
    role: 'administrator',
  });
  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${jwtAdministratorToken}` },
  });
  check('enterprise JWT role map entry cap ignores extra admin role', r.status === 403, `got ${r.status}`);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_CLAIM_PATH_MAX_SEGMENTS: '2',
  DASHBOARD_AUTH_JWT_ORG_ID_CLAIM: 'tenant.org.id',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const jwtNestedOrgToken = enterpriseJwt({
    sub: 'jwt-nested-org',
    email: 'jwt-nested-org@example.com',
    name: 'JWT Nested Org',
    role: 'admin',
    tenant: { org: { id: 'acme' } },
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${jwtNestedOrgToken}` },
  });
  check('enterprise JWT over-segment org claim path is rejected', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const claimPathControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-claim-path-bounds'
  );
  check('enterprise JWT over-segment claim path posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT over-segment claim path is action-required',
    claimPathControl?.state === 'action-required' &&
      claimPathControl?.summary?.includes?.('DASHBOARD_AUTH_JWT_ORG_ID_CLAIM')
  );
  check(
    'enterprise JWT over-segment claim path reports segment limit',
    claimPathControl?.summary?.includes?.('2 segment limit')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: kidlessJwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${enterpriseJwt({}, { kid: undefined })}` },
  });
  check('enterprise JWT accepts kidless token with kidless JWKS key', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${enterpriseJwt(
        {
          sub: 'jwt-claimed-kid-member',
          email: 'jwt-claimed-kid-member@example.com',
        },
        { kid: 'claimed-but-unconfigured-key' }
      )}`,
    },
  });
  check('enterprise JWT rejects explicit kid without matching key', r.status === 401, `got ${r.status}`);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: mixedJwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${weakEnterpriseJwt({
        sub: 'jwt-weak-admin',
        email: 'jwt-weak-admin@example.com',
        name: 'JWT Weak Admin',
        role: 'admin',
      })}`,
    },
  });
  check('enterprise JWT rejects weak RSA signing key', r.status === 401, `got ${r.status}`);

  const strongAdminToken = enterpriseJwt({
    sub: 'jwt-strong-admin',
    email: 'jwt-strong-admin@example.com',
    name: 'JWT Strong Admin',
    role: 'admin',
  });
  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${strongAdminToken}` },
  });
  const body = await json(r);
  const keyStrengthControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-key-strength'
  );
  check('enterprise JWT mixed-key admin can read organization -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT key strength posture flags weak key',
    keyStrengthControl?.state === 'action-required' &&
      keyStrengthControl?.summary?.includes?.('1 RSA signing key')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: weakJwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: `Bearer ${weakEnterpriseJwt({
        sub: 'jwt-weak-only-admin',
        email: 'jwt-weak-only-admin@example.com',
        name: 'JWT Weak Only Admin',
        role: 'admin',
      })}`,
    },
  });
  const body = await json(r);
  check('enterprise JWT weak-only JWKS fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise JWT weak-only JWKS reports RSA floor',
    body?.configError?.includes?.('2048 bits')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  // Issuer is mandatory once JWKS signing is configured (server fail-closes
  // otherwise). Audience is left unpinned so this scenario still exercises the
  // jwt-claim-pinning = action-required posture (#1578).
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const unpinnedJwtAdminToken = enterpriseJwt({
    sub: 'jwt-unpinned-admin',
    email: 'jwt-unpinned-admin@example.com',
    name: 'JWT Unpinned Admin',
    role: 'admin',
  });
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${unpinnedJwtAdminToken}` },
  });
  const body = await json(r);
  const jwtClaimControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwt-claim-pinning'
  );
  check('enterprise JWT unpinned claims admin can read organization -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT unpinned claims posture is action-required',
    jwtClaimControl?.state === 'action-required'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_ORG_ID_CLAIM: 'org_id',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const orgClaimAdminToken = enterpriseJwt({
    sub: 'jwt-org-admin',
    email: 'jwt-org-admin@example.com',
    name: 'JWT Org Admin',
    role: 'admin',
    org_id: 'acme',
  });
  let r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${orgClaimAdminToken}` },
  });
  let body = await json(r);
  check('enterprise JWT org claim admin can read organization -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT org claim maps current admin',
    body?.principals?.some((p) => p.userId === 'jwt-org-admin' && p.orgId === 'acme')
  );

  const missingOrgClaimToken = enterpriseJwt({
    sub: 'jwt-missing-org',
    role: 'admin',
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${missingOrgClaimToken}` },
  });
  check('enterprise JWT missing org claim is rejected', r.status === 401, `got ${r.status}`);

  const wrongOrgClaimToken = enterpriseJwt({
    sub: 'jwt-wrong-org',
    role: 'admin',
    org_id: 'other-org',
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${wrongOrgClaimToken}` },
  });
  check('enterprise JWT wrong org claim is rejected', r.status === 401, `got ${r.status}`);
} finally {
  await server.stop();
}

const remoteJwks = await startJwksServer({ keys: [jwtJwk] });
const remoteJwtScopedRoot = await createScopedClaudeRoot('/jwt/remote');
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS_URL: remoteJwks.url,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_JWT_DATA_ROOT_TEMPLATE: remoteJwtScopedRoot,
  DASHBOARD_AUTH_JWKS_CACHE_TTL_MS: '60000',
  DASHBOARD_AUTH_JWKS_MIN_REFRESH_MS: '1000',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const remoteMemberToken = enterpriseJwt({
    sub: 'remote-member',
    email: 'remote-member@example.com',
    name: 'Remote JWT Member',
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${remoteMemberToken}` },
  });
  let body = await json(r);
  check('enterprise remote JWKS member session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise remote JWKS resolves principal', body?.principal?.userId === 'remote-member');

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${remoteMemberToken}` },
  });
  check('enterprise remote JWKS cached session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise remote JWKS cache avoids refetch', remoteJwks.requests.length === 1);

  const remoteAdminToken = enterpriseJwt({
    sub: 'remote-admin',
    email: 'remote-admin@example.com',
    name: 'Remote JWT Admin',
    role: 'admin',
  });
  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${remoteAdminToken}` },
  });
  body = await json(r);
  const authControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'auth'
  );
  const jwksBoundsControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwks-network-bounds'
  );
  check('enterprise remote JWKS admin can read organization -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise remote JWKS organization includes current admin principal',
    body?.principals?.some((p) => p.userId === 'remote-admin' && p.role === 'admin')
  );
  check(
    'enterprise remote JWKS posture reports remote source',
    authControl?.summary?.includes('remote JWKS URL configured')
  );
  check('enterprise remote JWKS posture reports bounded network', jwksBoundsControl?.state === 'enabled');
  check(
    'enterprise remote JWKS posture reports fetch limits',
    jwksBoundsControl?.summary?.includes('5000ms') &&
      jwksBoundsControl?.summary?.includes('65536 byte')
  );
} finally {
  await server.stop();
  await remoteJwks.stop();
  await rm(remoteJwtScopedRoot, { recursive: true, force: true });
}

const collidingRemoteJwks = await startJwksServer({ keys: [collidingJwtJwk] });
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS: jwtJwks,
  DASHBOARD_AUTH_JWKS_URL: collidingRemoteJwks.url,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const now = Math.floor(Date.now() / 1000);
  const collidingRemoteToken = signJwtWithKey(
    {
      iss: jwtIssuer,
      aud: jwtAudience,
      sub: 'colliding-remote-kid',
      email: 'colliding-remote-kid@example.com',
      name: 'Colliding Remote Kid',
      role: 'member',
      exp: now + 300,
      iat: now,
    },
    collidingJwtPrivateKey,
    collidingJwtJwk
  );
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${collidingRemoteToken}` },
  });
  check('enterprise JWT rejects remote key with duplicate static kid', r.status === 401, `got ${r.status}`);

  const collidingStaticToken = enterpriseJwt({
    sub: 'colliding-static-kid',
    email: 'colliding-static-kid@example.com',
    name: 'Colliding Static Kid',
  });
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${collidingStaticToken}` },
  });
  check('enterprise JWT rejects static key with duplicate remote kid', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const jwksBoundsControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwks-network-bounds'
  );
  check('enterprise duplicate cross-source kid static admin can read posture', r.status === 200, `got ${r.status}`);
  check(
    'enterprise duplicate cross-source kid posture is action-required',
    jwksBoundsControl?.state === 'action-required'
  );
  check(
    'enterprise duplicate cross-source kid posture reports ambiguity',
    jwksBoundsControl?.summary?.includes('duplicate key id') &&
      jwksBoundsControl?.summary?.includes('fail closed')
  );
} finally {
  await server.stop();
  await collidingRemoteJwks.stop();
}

const invalidRemoteJwks = await startJwksServer(`not-json-${'x'.repeat(512)}`);
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS_URL: invalidRemoteJwks.url,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const invalidRemoteToken = enterpriseJwt({
    sub: 'invalid-remote-jwks-member',
    email: 'invalid-remote-jwks-member@example.com',
    name: 'Invalid Remote JWKS Member',
  });
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${invalidRemoteToken}` },
  });
  check('enterprise invalid remote JWKS rejects JWT session', r.status === 401, `got ${r.status}`);
  check('enterprise invalid remote JWKS was fetched', invalidRemoteJwks.requests.length === 1);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const jwksBoundsControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'jwks-network-bounds'
  );
  check('enterprise invalid remote JWKS static admin can read posture', r.status === 200, `got ${r.status}`);
  check(
    'enterprise invalid remote JWKS posture is action-required',
    jwksBoundsControl?.state === 'action-required'
  );
  check(
    'enterprise invalid remote JWKS posture reports bounded fetch error',
    jwksBoundsControl?.summary?.includes?.('Last remote JWKS refresh failed') &&
      jwksBoundsControl?.summary?.includes?.('not valid JSON')
  );
  check('enterprise invalid remote JWKS posture redacts payload', !bodyText.includes('not-json'));
} finally {
  await server.stop();
  await invalidRemoteJwks.stop();
}

const redirectTargetJwks = await startJwksServer({ keys: [jwtJwk] });
const redirectingJwks = await startRedirectServer(redirectTargetJwks.url);
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS_URL: redirectingJwks.url,
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const redirectedToken = enterpriseJwt({
    sub: 'redirected-jwks-member',
    email: 'redirected-jwks-member@example.com',
    name: 'Redirected JWKS Member',
  });
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${redirectedToken}` },
  });
  check('enterprise remote JWKS redirect is rejected', r.status === 401, `got ${r.status}`);
  check('enterprise remote JWKS redirect target is not fetched', redirectTargetJwks.requests.length === 0);
} finally {
  await server.stop();
  await redirectingJwks.stop();
  await redirectTargetJwks.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: JSON.stringify({ keys: [] }),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  check('enterprise invalid JWKS fails closed -> 503', r.status === 503, `got ${r.status}`);
  check('enterprise invalid JWKS reports unconfigured', body?.configured === false);
  check('enterprise invalid JWKS reports config error', body?.configError?.includes('DASHBOARD_AUTH_JWKS'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_TRUST_PROXY_HEADERS: 'true',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_BYTES: '128',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES: `127.0.0.1,${'x'.repeat(2048)}`,
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer oversized-proxy-allowlist-token',
      'X-Forwarded-For': '203.0.113.32',
    },
  });
  check('enterprise oversized proxy allowlist allows first socket-keyed miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer oversized-proxy-allowlist-rotated-token',
      'X-Forwarded-For': '203.0.113.33',
    },
  });
  check('enterprise oversized proxy allowlist ignores spoofed forwarded client', r.status === 429, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const trustedProxyControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'trusted-proxy-boundary'
  );
  check('enterprise oversized proxy allowlist posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise oversized proxy allowlist is ignored',
    trustedProxyControl?.state === 'action-required' &&
      trustedProxyControl?.summary?.includes?.('0 configured proxy peer address')
  );
  check(
    'enterprise oversized proxy allowlist reports byte limit',
    trustedProxyControl?.summary?.includes?.('128 byte limit')
  );
  check('enterprise oversized proxy allowlist redacts payload', !bodyText.includes('xxxxx'));

  const audit = await readAuditLog(server.auditLog, 2);
  check(
    'enterprise oversized proxy allowlist audit does not record spoofed client',
    !audit.events.some((e) => e.remoteAddress === '203.0.113.32' || e.remoteAddress === '203.0.113.33')
  );
  check('enterprise oversized proxy allowlist audit redacts token', !audit.raw.includes('oversized-proxy-allowlist-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_TRUST_PROXY_HEADERS: 'true',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES_MAX_ENTRIES: '1',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES: '127.0.0.1,192.0.2.250',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer capped-proxy-allowlist-token',
      'X-Forwarded-For': '203.0.113.34',
    },
  });
  check('enterprise proxy allowlist entry cap allows first forwarded miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer capped-proxy-allowlist-token',
      'X-Forwarded-For': '203.0.113.35',
    },
  });
  check('enterprise proxy allowlist entry cap keeps bounded proxy peer', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer capped-proxy-allowlist-token',
      'X-Forwarded-For': '203.0.113.34',
    },
  });
  check('enterprise proxy allowlist entry cap blocks repeated forwarded client', r.status === 429, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const trustedProxyControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'trusted-proxy-boundary'
  );
  check('enterprise proxy allowlist entry cap posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise proxy allowlist entry cap keeps bounded addresses',
    trustedProxyControl?.state === 'action-required' &&
      trustedProxyControl?.summary?.includes?.('1 configured proxy peer address')
  );
  check(
    'enterprise proxy allowlist entry cap reports limit',
    trustedProxyControl?.summary?.includes?.('1 entry limit')
  );

  const audit = await readAuditLog(server.auditLog, 3);
  check(
    'enterprise proxy allowlist entry cap audit records forwarded client',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.rate_limited' &&
        e.reason === 'rate_limit:auth' &&
        e.remoteAddress === '203.0.113.34'
    )
  );
  check('enterprise proxy allowlist entry cap audit redacts token', !audit.raw.includes('capped-proxy-allowlist-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_TRUST_PROXY_HEADERS: 'true',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer no-proxy-allowlist-token',
      'X-Forwarded-For': '203.0.113.30',
    },
  });
  check('enterprise proxy without allowlist allows first socket-keyed miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer no-proxy-allowlist-rotated-token',
      'X-Forwarded-For': '203.0.113.31',
    },
  });
  check('enterprise proxy without allowlist ignores spoofed forwarded client', r.status === 429, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const trustedProxyControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'trusted-proxy-boundary'
  );
  check(
    'enterprise proxy without allowlist posture is action-required',
    trustedProxyControl?.state === 'action-required' &&
      trustedProxyControl?.summary?.includes?.('ignored until DASHBOARD_TRUSTED_PROXY_ADDRESSES')
  );

  const audit = await readAuditLog(server.auditLog, 2);
  check(
    'enterprise proxy without allowlist audit does not record spoofed client',
    !audit.events.some((e) => e.remoteAddress === '203.0.113.30' || e.remoteAddress === '203.0.113.31')
  );
  check('enterprise proxy without allowlist audit redacts token', !audit.raw.includes('no-proxy-allowlist-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_CONTENT_SECURITY_POLICY_MAX_BYTES: '1024',
  DASHBOARD_CONTENT_SECURITY_POLICY:
    `default-src 'self'; connect-src 'self' https://api.anthropic.com; ${'x'.repeat(2048)}`,
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const csp = r.headers.get('content-security-policy') || '';
  check('enterprise oversized custom CSP session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise oversized custom CSP falls back to default', !csp.includes('api.anthropic.com'));
  check('enterprise oversized custom CSP redacts payload header', !csp.includes('xxxxx'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const securityHeadersControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'security-headers'
  );
  const browserEgressControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-llm-egress'
  );
  check(
    'enterprise oversized custom CSP marks security headers action-required',
    securityHeadersControl?.state === 'action-required' &&
      securityHeadersControl?.summary?.includes?.('1024 byte limit')
  );
  check(
    'enterprise oversized custom CSP keeps browser egress disabled',
    browserEgressControl?.state === 'disabled'
  );
  check('enterprise oversized custom CSP redacts payload posture', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_ALLOWED_ORIGINS_MAX_BYTES: '1024',
  DASHBOARD_ALLOWED_ORIGINS: `https://dashboard.example.com,${'x'.repeat(2048)}`,
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const writeOriginControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'write-origin-allowlist'
  );
  check('enterprise oversized write origins posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise oversized write origins are ignored',
    writeOriginControl?.state === 'action-required' &&
      writeOriginControl?.summary?.includes?.('0 configured public write origin')
  );
  check(
    'enterprise oversized write origins report byte limit',
    writeOriginControl?.summary?.includes?.('1024 byte limit')
  );
  check('enterprise oversized write origins redact payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_ALLOWED_ORIGINS_MAX_ENTRIES: '1',
  DASHBOARD_ALLOWED_ORIGINS: 'https://one.example.com,https://two.example.com',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const writeOriginControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'write-origin-allowlist'
  );
  check('enterprise write origin entry cap posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise write origin entry cap keeps bounded origins',
    writeOriginControl?.state === 'action-required' &&
      writeOriginControl?.summary?.includes?.('1 configured public write origin')
  );
  check(
    'enterprise write origin entry cap reports limit',
    writeOriginControl?.summary?.includes?.('1 entry limit')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS_MAX_BYTES: '1024',
  DASHBOARD_AUTH_JWKS: `{"keys":[],"padding":"${'x'.repeat(2048)}"}`,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized static JWKS fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized static JWKS reports byte limit',
    body?.configError?.includes('DASHBOARD_AUTH_JWKS exceeds 1024 byte limit')
  );
  check('enterprise oversized static JWKS redacts payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWKS_MAX_KEYS: '1',
  DASHBOARD_AUTH_JWKS: JSON.stringify({
    keys: [
      { ...jwtJwk, kid: 'too-many-key-1' },
      { ...jwtJwk, kid: 'too-many-key-2' },
    ],
  }),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${enterpriseJwt({}, { kid: 'too-many-key-1' })}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized static JWKS key count fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized static JWKS key count reports limit',
    body?.configError?.includes('DASHBOARD_AUTH_JWKS exceeds 1 key limit')
  );
  check('enterprise oversized static JWKS key count redacts payload', !bodyText.includes('too-many-key-2'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS_MAX_BYTES: '1024',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token,
      userId: 'oversized-static-config',
      role: 'admin',
      padding: 'x'.repeat(2048),
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized static token config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized static token config reports byte limit',
    body?.configError?.includes('DASHBOARD_AUTH_TOKENS exceeds 1024 byte limit')
  );
  check('enterprise oversized static token config redacts payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

await withAuthTokensFile(
  JSON.stringify([
    {
      token,
      userId: 'file-backed-admin',
      role: 'admin',
      orgId: 'acme',
    },
  ]),
  async (tokensFile) => {
    server = await startServer({
      DASHBOARD_AUTH_MODE: 'enterprise',
      DASHBOARD_ORG_ID: 'acme',
      DASHBOARD_AUTH_TOKENS_FILE: tokensFile,
    });
    try {
      const r = await fetch(`${server.base}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await json(r);
      check('enterprise file-backed static token config -> 200', r.status === 200, `got ${r.status}`);
      check('enterprise file-backed static token principal is accepted', body?.principal?.userId === 'file-backed-admin');
    } finally {
      await server.stop();
    }
  }
);

await withAuthTokensFile(
  JSON.stringify([{ token, userId: 'ambiguous-file', role: 'admin' }]),
  async (tokensFile) => {
    server = await startServer({
      DASHBOARD_AUTH_MODE: 'enterprise',
      DASHBOARD_AUTH_TOKENS: tokenConfig,
      DASHBOARD_AUTH_TOKENS_FILE: tokensFile,
    });
    try {
      const r = await fetch(`${server.base}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await json(r);
      check('enterprise env plus file token config fails closed -> 503', r.status === 503, `got ${r.status}`);
      check(
        'enterprise env plus file token config reports ambiguity',
        body?.configError?.includes('cannot both be configured')
      );
    } finally {
      await server.stop();
    }
  }
);

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS_FILE: join(tmpdir(), 'missing-enterprise-auth-tokens.json'),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise missing file-backed token config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise missing file-backed token config reports generic read failure',
    body?.configError === 'DASHBOARD_AUTH_TOKENS_FILE could not be read'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS_FILE: 'relative-enterprise-auth-tokens.json',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise relative file-backed token config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise relative file-backed token config reports absolute path requirement',
    body?.configError === 'DASHBOARD_AUTH_TOKENS_FILE must be an absolute path'
  );
} finally {
  await server.stop();
}

{
  const tokensDir = await mkdtemp(join(tmpdir(), 'enterprise-auth-tokens-dir-'));
  try {
    server = await startServer({
      DASHBOARD_AUTH_MODE: 'enterprise',
      DASHBOARD_AUTH_TOKENS_FILE: tokensDir,
    });
    try {
      const r = await fetch(`${server.base}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await json(r);
      check('enterprise directory-backed token config fails closed -> 503', r.status === 503, `got ${r.status}`);
      check(
        'enterprise directory-backed token config reports regular file requirement',
        body?.configError === 'DASHBOARD_AUTH_TOKENS_FILE must point to a regular file'
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(tokensDir, { recursive: true, force: true });
  }
}

await withAuthTokensFile('redactme-file-static-token-config', async (tokensFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS_FILE: tokensFile,
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    const bodyText = JSON.stringify(body);
    check('enterprise invalid file-backed token JSON fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise invalid file-backed token JSON reports generic parse failure',
      body?.configError === 'DASHBOARD_AUTH_TOKENS_FILE is not valid JSON'
    );
    check('enterprise invalid file-backed token JSON redacts parser payload', !bodyText.includes('redactme'));
  } finally {
    await server.stop();
  }
});

await withAuthTokensFile(
  JSON.stringify([
    {
      token,
      userId: 'oversized-file-static-config',
      role: 'admin',
      padding: 'x'.repeat(2048),
    },
  ]),
  async (tokensFile) => {
    server = await startServer({
      DASHBOARD_AUTH_MODE: 'enterprise',
      DASHBOARD_AUTH_TOKENS_MAX_BYTES: '1024',
      DASHBOARD_AUTH_TOKENS_FILE: tokensFile,
    });
    try {
      const r = await fetch(`${server.base}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await json(r);
      const bodyText = JSON.stringify(body);
      check('enterprise oversized file-backed token config fails closed -> 503', r.status === 503, `got ${r.status}`);
      check(
        'enterprise oversized file-backed token config reports byte limit',
        body?.configError?.includes('DASHBOARD_AUTH_TOKENS_FILE exceeds 1024 byte limit')
      );
      check('enterprise oversized file-backed token config redacts payload', !bodyText.includes('xxxxx'));
    } finally {
      await server.stop();
    }
  }
);

await withSessionSecretFile(`${sessionSecret}\n`, async (secretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET_FILE: secretFile,
    DASHBOARD_ORG_ID: 'acme',
    DASHBOARD_ORG_NAME: 'Acme',
  });
  try {
    let r = await fetch(`${server.base}/api/auth/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    let body = await json(r);
    const cookie = enterpriseSessionCookie(r);
    check('enterprise file-backed browser session secret exchange -> 200', r.status === 200, `got ${r.status}`);
    check('enterprise file-backed browser session secret sets cookie', cookie.startsWith('chd_enterprise_session='));
    check('enterprise file-backed browser session secret authenticates principal', body?.principal?.userId === 'u-admin');

    r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Cookie: cookie },
    });
    body = await json(r);
    check('enterprise file-backed browser session secret cookie -> 200', r.status === 200, `got ${r.status}`);
    check('enterprise file-backed browser session secret returns principal', body?.principal?.userId === 'u-admin');
  } finally {
    await server.stop();
  }
});

await withSessionSecretFile(sessionSecret, async (secretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
    DASHBOARD_AUTH_SESSION_SECRET_FILE: secretFile,
    DASHBOARD_ORG_ID: 'acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    check('enterprise env plus file browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise env plus file browser session secret reports ambiguity',
      body?.configError === 'DASHBOARD_AUTH_SESSION_SECRET and DASHBOARD_AUTH_SESSION_SECRET_FILE cannot both be configured'
    );
  } finally {
    await server.stop();
  }
});

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_AUTH_SESSION_SECRET_FILE: join(
    tmpdir(),
    `missing-enterprise-session-secret-${randomBytes(6).toString('hex')}`
  ),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise missing file-backed browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise missing file-backed browser session secret reports generic read failure',
    body?.configError === 'DASHBOARD_AUTH_SESSION_SECRET_FILE could not be read'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET_FILE: 'relative-enterprise-session-secret',
  DASHBOARD_ORG_ID: 'acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise relative file-backed browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise relative file-backed browser session secret reports absolute path requirement',
    body?.configError === 'DASHBOARD_AUTH_SESSION_SECRET_FILE must be an absolute path'
  );
} finally {
  await server.stop();
}

{
  const secretDir = await mkdtemp(join(tmpdir(), 'enterprise-session-secret-dir-'));
  try {
    server = await startServer({
      DASHBOARD_AUTH_MODE: 'enterprise',
      DASHBOARD_AUTH_TOKENS: tokenConfig,
      DASHBOARD_AUTH_SESSION_SECRET_FILE: secretDir,
      DASHBOARD_ORG_ID: 'acme',
    });
    try {
      const r = await fetch(`${server.base}/api/auth/session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await json(r);
      check('enterprise directory-backed browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
      check(
        'enterprise directory-backed browser session secret reports regular file requirement',
        body?.configError === 'DASHBOARD_AUTH_SESSION_SECRET_FILE must point to a regular file'
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
}

await withSessionSecretFile('short-file-session-secret', async (secretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET_FILE: secretFile,
    DASHBOARD_ORG_ID: 'acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    const bodyText = JSON.stringify(body);
    check('enterprise weak file-backed browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise weak file-backed browser session secret reports byte floor',
      body?.configError?.includes('DASHBOARD_AUTH_SESSION_SECRET_FILE must be at least 32 bytes')
    );
    check('enterprise weak file-backed browser session secret redacts payload', !bodyText.includes('short-file-session-secret'));
  } finally {
    await server.stop();
  }
});

await withSessionSecretFile('session-secret-leak-'.repeat(300), async (secretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET_FILE: secretFile,
    DASHBOARD_ORG_ID: 'acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    const bodyText = JSON.stringify(body);
    check('enterprise oversized file-backed browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise oversized file-backed browser session secret reports byte limit',
      body?.configError?.includes('DASHBOARD_AUTH_SESSION_SECRET_FILE exceeds 4096 byte limit')
    );
    check('enterprise oversized file-backed browser session secret redacts payload', !bodyText.includes('session-secret-leak'));
  } finally {
    await server.stop();
  }
});

let rotationOldCookie = '';
let rotationNewCookie = '';
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  rotationOldCookie = enterpriseSessionCookie(r);
  check('enterprise session rotation old secret exchange -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise session rotation old secret sets cookie', rotationOldCookie.startsWith('chd_enterprise_session='));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
  DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET: sessionSecret,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: rotationOldCookie },
  });
  let body = await json(r);
  check('enterprise session rotation previous secret authenticates old cookie -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise session rotation previous secret returns principal', body?.principal?.userId === 'u-admin');

  r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  rotationNewCookie = enterpriseSessionCookie(r);
  body = await json(r);
  check('enterprise session rotation current secret exchange -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise session rotation current secret sets new cookie', rotationNewCookie.startsWith('chd_enterprise_session='));
  check('enterprise session rotation current secret authenticates principal', body?.principal?.userId === 'u-admin');

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const browserCookieControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-session-cookie'
  );
  check(
    'enterprise session rotation posture reports previous key',
    browserCookieControl?.summary?.includes('1 previous decrypt-only key')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: rotationNewCookie },
  });
  let body = await json(r);
  check('enterprise session rotation new cookie uses current secret -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise session rotation new cookie returns principal', body?.principal?.userId === 'u-admin');

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: rotationOldCookie },
  });
  body = await json(r);
  check('enterprise session rotation old cookie expires after previous removal -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise session rotation old cookie removal clears cookie', setCookieHeader(r).includes('Max-Age=0'));
  check('enterprise session rotation old cookie removal reports unauthenticated', body?.authenticated === false);
} finally {
  await server.stop();
}

await withSessionSecretFile(sessionSecret, async (previousSecretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
    DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: previousSecretFile,
    DASHBOARD_ORG_ID: 'acme',
    DASHBOARD_ORG_NAME: 'Acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Cookie: rotationOldCookie },
    });
    const body = await json(r);
    check('enterprise file-backed previous session secret authenticates old cookie -> 200', r.status === 200, `got ${r.status}`);
    check('enterprise file-backed previous session secret returns principal', body?.principal?.userId === 'u-admin');
  } finally {
    await server.stop();
  }
});

await withSessionSecretFile(sessionSecret, async (previousSecretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
    DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET: sessionSecret,
    DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: previousSecretFile,
    DASHBOARD_ORG_ID: 'acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    check('enterprise env plus file previous browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise env plus file previous browser session secret reports ambiguity',
      body?.configError ===
        'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET and DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE cannot both be configured'
    );
  } finally {
    await server.stop();
  }
});

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
  DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: join(
    tmpdir(),
    `missing-enterprise-previous-session-secret-${randomBytes(6).toString('hex')}`
  ),
  DASHBOARD_ORG_ID: 'acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise missing file-backed previous browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise missing file-backed previous browser session secret reports generic read failure',
    body?.configError === 'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE could not be read'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
  DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: 'relative-previous-session-secret',
  DASHBOARD_ORG_ID: 'acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise relative file-backed previous browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise relative file-backed previous browser session secret reports absolute path requirement',
    body?.configError === 'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE must be an absolute path'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
  DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET: 'short-previous-session-secret',
  DASHBOARD_ORG_ID: 'acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise weak previous browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise weak previous browser session secret reports byte floor',
    body?.configError?.includes('DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET must be at least 32 bytes')
  );
  check('enterprise weak previous browser session secret redacts payload', !bodyText.includes('short-previous-session-secret'));
} finally {
  await server.stop();
}

await withSessionSecretFile('previous-session-secret-leak-'.repeat(300), async (previousSecretFile) => {
  server = await startServer({
    DASHBOARD_AUTH_MODE: 'enterprise',
    DASHBOARD_AUTH_TOKENS: tokenConfig,
    DASHBOARD_AUTH_SESSION_SECRET: rotatedSessionSecret,
    DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE: previousSecretFile,
    DASHBOARD_ORG_ID: 'acme',
  });
  try {
    const r = await fetch(`${server.base}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await json(r);
    const bodyText = JSON.stringify(body);
    check('enterprise oversized file-backed previous browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
    check(
      'enterprise oversized file-backed previous browser session secret reports byte limit',
      body?.configError?.includes('DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET_FILE exceeds 4096 byte limit')
    );
    check('enterprise oversized file-backed previous browser session secret redacts payload', !bodyText.includes('previous-session-secret-leak'));
  } finally {
    await server.stop();
  }
});

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET: sessionSecret,
  DASHBOARD_ORG_ID: 'acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise previous browser session secret without current secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise previous browser session secret without current secret reports requirement',
    body?.configError?.includes(
      'DASHBOARD_AUTH_SESSION_PREVIOUS_SECRET requires DASHBOARD_AUTH_SESSION_SECRET or DASHBOARD_AUTH_SESSION_SECRET_FILE'
    )
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  const cookie = enterpriseSessionCookie(r);
  const setCookie = setCookieHeader(r);
  check('enterprise browser session exchange -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise browser session exchange authenticates principal', body?.principal?.userId === 'u-admin');
  check('enterprise browser session sets cookie', cookie.startsWith('chd_enterprise_session='));
  check('enterprise browser session cookie is HttpOnly', setCookie.includes('HttpOnly'));
  check('enterprise browser session cookie is same-site strict', setCookie.includes('SameSite=Strict'));
  check('enterprise browser session cookie is path scoped', setCookie.includes('Path=/'));
  check('enterprise browser session cookie omits raw token', !setCookie.includes(token));

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: cookie },
  });
  body = await json(r);
  check('enterprise browser session cookie authenticates session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise browser session cookie returns principal', body?.principal?.userId === 'u-admin');

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Cookie: cookie },
  });
  body = await json(r);
  check('enterprise browser session cookie reads admin organization -> 200', r.status === 200, `got ${r.status}`);
  const browserCookieControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-session-cookie'
  );
  check(
    'enterprise posture reports browser session cookie',
    browserCookieControl?.state === 'enabled' &&
      browserCookieControl?.summary?.includes('HttpOnly SameSite=Strict')
  );

  const tamperedCookie = cookie.replace(
    /^(chd_enterprise_session=v1\.[^.]+\.)([A-Za-z0-9_-])/,
    (_match, prefix, value) => `${prefix}${value === 'A' ? 'B' : 'A'}`
  );
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: tamperedCookie },
  });
  body = await json(r);
  check('enterprise tampered browser session fails closed -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise tampered browser session clears cookie', setCookieHeader(r).includes('Max-Age=0'));
  check('enterprise tampered browser session reports unauthenticated', body?.authenticated === false);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: `${cookie}; ${cookie}` },
  });
  body = await json(r);
  check('enterprise duplicate browser session fails closed -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise duplicate browser session clears cookie', setCookieHeader(r).includes('Max-Age=0'));
  check('enterprise duplicate browser session reports unauthenticated', body?.authenticated === false);

  const expiredCookie = enterpriseExpiredSessionCookie(
    {
      userId: 'u-admin',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
      orgId: 'acme',
      orgName: 'Acme',
      teamId: 'platform',
      teamName: 'Platform Team',
      scopes: ['org:read', 'org:write', 'audit:read'],
    },
    sessionSecret
  );
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Cookie: expiredCookie },
  });
  check('enterprise expired browser session fails closed -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise expired browser session clears cookie', setCookieHeader(r).includes('Max-Age=0'));

  r = await fetch(`${server.base}/api/auth/session`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  body = await json(r);
  check('enterprise browser sign-out -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise browser sign-out clears cookie', setCookieHeader(r).includes('Max-Age=0'));
  check('enterprise browser sign-out reports unauthenticated', body?.authenticated === false);

  const audit = await readAuditLogUntil(
    server.auditLog,
    ({ raw, events }) =>
      !raw.includes(token) &&
      events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'session_cookie_issued') &&
      events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'invalid_session') &&
      events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'expired_session') &&
      events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'signed_out')
  );
  check('enterprise browser session audit records cookie issue', audit.events.some((e) => e.reason === 'session_cookie_issued'));
  check('enterprise browser session audit records tamper', audit.events.some((e) => e.reason === 'invalid_session'));
  check('enterprise browser session audit records expiry', audit.events.some((e) => e.reason === 'expired_session'));
  check('enterprise browser session audit records sign-out', audit.events.some((e) => e.reason === 'signed_out'));
  check('enterprise browser session audit redacts bearer', !audit.raw.includes(token));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: 'short',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise weak browser session secret fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise weak browser session secret reports byte floor',
    body?.configError?.includes('DASHBOARD_AUTH_SESSION_SECRET must be at least 32 bytes')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: JSON.stringify({ keys: [jwtJwk] }),
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWT_AUDIENCE: jwtAudience,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_AUTH_SESSION_MAX_AGE_SECONDS: '3600',
});
try {
  const now = Math.floor(Date.now() / 1000);
  const shortJwt = enterpriseJwt({ exp: now + 120, iat: now });
  const r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${shortJwt}` },
  });
  const maxAge = cookieMaxAge(r);
  check('enterprise JWT browser session exchange -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise JWT browser session cookie is capped by token exp',
    Number.isFinite(maxAge) && maxAge > 0 && maxAge <= 120,
    `max-age ${maxAge}`
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_SESSION_SECRET: sessionSecret,
  DASHBOARD_AUTH_SESSION_COOKIE_SECURE: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const cookie = enterpriseSessionCookie(r);
  check('enterprise secure browser session exchange -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise secure browser session sets cookie', cookie.startsWith('chd_enterprise_session='));
  check('enterprise secure browser session cookie has Secure flag', setCookieHeader(r).includes('Secure'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: 'redactme-static-token-config',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise invalid static token JSON fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise invalid static token JSON reports generic parse failure',
    body?.configError === 'DASHBOARD_AUTH_TOKENS is not valid JSON'
  );
  check('enterprise invalid static token JSON redacts parser payload', !bodyText.includes('redactme'));
  check('enterprise invalid static token JSON omits parser internals', !bodyText.includes('Unexpected token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_MAX_BEARER_BYTES: '1024',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token: `enterprise-oversized-static-token-${'x'.repeat(2048)}`,
      userId: 'oversized-static-token',
      role: 'admin',
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized static raw token fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized static raw token reports byte limit',
    body?.configError?.includes('raw bearer token') &&
      body?.configError?.includes('1024 byte limit')
  );
  check('enterprise oversized static raw token redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  POLICY_WRITE_TOKEN: `oversized-enterprise-policy-write-token-${'x'.repeat(9000)}`,
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const mutatingControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'mutating-body-size'
  );
  check('enterprise oversized policy write token posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise oversized policy write token marks mutating control action-required',
    mutatingControl?.state === 'action-required'
  );
  check(
    'enterprise oversized policy write token reports byte limit',
    mutatingControl?.summary?.includes?.('POLICY_WRITE_TOKEN exceeds 8192 byte')
  );
  check('enterprise oversized policy write token redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS_MAX_ENTRIES: '1',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token,
      userId: 'static-entry-cap-admin',
      role: 'admin',
    },
    {
      token: 'enterprise-extra-static-token',
      userId: 'static-entry-cap-extra',
      role: 'viewer',
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized static token entries fail closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized static token entries report limit',
    body?.configError?.includes('DASHBOARD_AUTH_TOKENS exceeds 1 entry limit')
  );
  check('enterprise oversized static token entries redact payload', !bodyText.includes('static-entry-cap-extra'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: duplicateKidJwtJwks,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${enterpriseJwt()}` },
  });
  const body = await json(r);
  check('enterprise duplicate JWKS kid fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise duplicate JWKS kid reports config error',
    body?.configError?.includes('duplicate JWT key id')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWKS: nonSigningJwtJwks,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${enterpriseJwt()}` },
  });
  const body = await json(r);
  check('enterprise non-signing JWKS fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise non-signing JWKS reports signing key error',
    body?.configError?.includes('signing keys')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  // Issuer is mandatory once a signing source (JWKS_URL) is present; the server
  // fail-closes at boot otherwise. The URL-validation 503 under test still fires
  // at request time with the issuer set (#1578).
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWKS_URL: 'http://idp.example.test/.well-known/jwks.json',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  check('enterprise insecure remote JWKS URL fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise insecure remote JWKS URL reports config error',
    body?.configError?.includes('DASHBOARD_AUTH_JWKS_URL')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWKS_URL: 'redactme-jwks-url',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise invalid remote JWKS URL fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise invalid remote JWKS URL reports generic config error',
    body?.configError === 'DASHBOARD_AUTH_JWKS_URL is not a valid URL'
  );
  check('enterprise invalid remote JWKS URL redacts payload', !bodyText.includes('redactme'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_JWT_ISSUER: jwtIssuer,
  DASHBOARD_AUTH_JWKS_URL_MAX_BYTES: '128',
  DASHBOARD_AUTH_JWKS_URL: `https://idp.example.test/${'x'.repeat(256)}/jwks.json`,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized remote JWKS URL fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized remote JWKS URL reports byte limit',
    body?.configError?.includes('DASHBOARD_AUTH_JWKS_URL exceeds 128 byte limit')
  );
  check('enterprise oversized remote JWKS URL redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_AUTH_JWT_PINNING_MAX_BYTES: '128',
  DASHBOARD_AUTH_JWT_ISSUER: `https://idp.example.test/${'x'.repeat(256)}`,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized JWT issuer config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized JWT issuer config reports byte limit',
    body?.configError?.includes('DASHBOARD_AUTH_JWT_ISSUER exceeds 128 byte limit')
  );
  check('enterprise oversized JWT issuer config redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

const oversizedPrincipalField = `principal-field-${'x'.repeat(256)}`;
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_PRINCIPAL_FIELD_MAX_CHARS: '64',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token: 'enterprise-oversized-principal-field-token',
      userId: oversizedPrincipalField,
      email: `${oversizedPrincipalField}@example.com`,
      name: oversizedPrincipalField,
      role: 'admin',
      orgId: 'acme',
      orgName: 'Acme',
      teamId: oversizedPrincipalField,
      teamName: oversizedPrincipalField,
    },
  ]),
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer enterprise-oversized-principal-field-token' },
  });
  let body = await json(r);
  check('enterprise caps oversized principal fields -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise caps oversized principal user id with hash suffix',
    body?.principal?.userId?.length <= 64 &&
      /-[0-9a-f]{16}$/.test(body?.principal?.userId || '')
  );
  check(
    'enterprise caps oversized principal display fields',
    body?.principal?.name?.length <= 64 &&
      body?.principal?.teamName?.length <= 64
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: 'Bearer enterprise-oversized-principal-field-token' },
  });
  body = await json(r);
  const bodyText = JSON.stringify(body);
  const principalFieldControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'principal-metadata-size'
  );
  check('enterprise oversized principal field posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise oversized principal field posture reports cap',
    principalFieldControl?.state === 'enabled' &&
      principalFieldControl?.summary?.includes?.('64 character')
  );
  check('enterprise oversized principal field redacts payload', !bodyText.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      tokenSha256: 'not-a-valid-sha256',
      userId: 'bad-hash',
      role: 'admin',
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  check('enterprise invalid token hash fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise invalid token hash reports config error',
    body?.configError?.includes('invalid SHA-256 token fingerprint')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: JSON.stringify({
    'sha256:not-a-valid-sha256': {
      userId: 'bad-object-hash',
      role: 'admin',
    },
  }),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer sha256:not-a-valid-sha256' },
  });
  const body = await json(r);
  check('enterprise invalid sha256 object key fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise invalid sha256 object key is not accepted as raw token',
    body?.configError?.includes('invalid SHA-256 token fingerprint')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_ADMIN_TOKEN_SHA256: 'not-a-valid-sha256',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  check('enterprise invalid admin token hash fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise invalid admin token hash reports config error',
    body?.configError?.includes('DASHBOARD_ADMIN_TOKEN_SHA256')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_MAX_BEARER_BYTES: '1024',
  DASHBOARD_ADMIN_TOKEN: `admin-${'x'.repeat(2048)}`,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise oversized raw admin token fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise oversized raw admin token reports byte limit',
    body?.configError?.includes('DASHBOARD_ADMIN_TOKEN exceeds 1024 byte limit')
  );
  check('enterprise oversized raw admin token redacts payload', !bodyText.includes('xxxxx'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_ORG_ID: ' acme ',
  DASHBOARD_ORG_NAME: ' Acme ',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token: 'enterprise-trimmed-principal-token',
      userId: ' trimmed-user ',
      email: ' trimmed@example.com ',
      name: ' Trimmed User ',
      role: ' admin ',
      orgId: ' acme ',
      orgName: ' Acme ',
      teamId: ' platform ',
      teamName: ' Platform Team ',
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer enterprise-trimmed-principal-token' },
  });
  const body = await json(r);
  check('enterprise trims static principal config -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise trims configured organization id', body?.organization?.id === 'acme');
  check('enterprise trims static principal user id', body?.principal?.userId === 'trimmed-user');
  check('enterprise trims static principal email', body?.principal?.email === 'trimmed@example.com');
  check('enterprise trims static principal role', body?.principal?.role === 'admin');
  check('enterprise trims static principal team', body?.principal?.teamId === 'platform');
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      token: hashedToken,
      userId: 'duplicate-raw',
      role: 'admin',
    },
    {
      tokenSha256: hashedTokenSha256,
      userId: 'duplicate-hash',
      role: 'viewer',
    },
  ]),
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${hashedToken}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise duplicate token config fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise duplicate token config reports duplicate credential',
    body?.configError?.includes('duplicate bearer credential')
  );
  check('enterprise duplicate token config redacts raw token', !bodyText.includes(hashedToken));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: JSON.stringify([
    {
      tokenSha256: hashedTokenSha256,
      userId: 'duplicate-static',
      role: 'viewer',
    },
  ]),
  DASHBOARD_ADMIN_TOKEN: hashedToken,
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${hashedToken}` },
  });
  const body = await json(r);
  check('enterprise duplicate admin credential fails closed -> 503', r.status === 503, `got ${r.status}`);
  check(
    'enterprise duplicate admin credential reports duplicate credential',
    body?.configError?.includes('duplicate bearer credential')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: hashOnlyTokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${hashedToken}` },
  });
  let body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise hash-only token session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise hash-only token resolves principal', body?.principal?.userId === 'u-hashed');
  check('enterprise hash-only token redacts bearer token', !bodyText.includes(hashedToken));
  check('enterprise hash-only token redacts configured hash', !bodyText.includes(hashedTokenSha256));

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer enterprise-hashed-token-wrong' },
  });
  check('enterprise hash-only rejects wrong bearer', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${hashedToken}` },
  });
  body = await json(r);
  const credentialStrengthControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'credential-strength'
  );
  check('enterprise hash-only credential strength posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise hash-only credential strength is clean',
    credentialStrengthControl?.state === 'enabled'
  );

  const audit = await readAuditLog(server.auditLog, 2);
  check('enterprise hash-only audit redacts bearer token', !audit.raw.includes(hashedToken));
  check('enterprise hash-only audit redacts configured hash', !audit.raw.includes(hashedTokenSha256));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: hashObjectTokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${hashedToken}` },
  });
  const body = await json(r);
  check('enterprise sha256 object-key token session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise sha256 object-key resolves principal',
    body?.principal?.userId === 'u-hashed-object'
  );
} finally {
  await server.stop();
}

const bootstrapAdminToken = 'enterprise-bootstrap-admin-token';
const bootstrapAdminHashToken = 'enterprise-bootstrap-admin-hash-token';
const bootstrapAdminTokenSha256 = createHash('sha256')
  .update(bootstrapAdminHashToken)
  .digest('hex');
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_ADMIN_TOKEN: bootstrapAdminToken,
  DASHBOARD_AUTH_ENFORCE_SCOPES: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${bootstrapAdminToken}` },
  });
  let body = await json(r);
  check('enterprise bootstrap admin session with scopes -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise bootstrap admin has default org read scope',
    body?.principal?.scopes?.includes?.('org:read')
  );
  check(
    'enterprise bootstrap admin can read org data with scope enforcement',
    body?.capabilities?.canReadOrganizationData === true
  );
  check(
    'enterprise bootstrap admin can write with scope enforcement',
    body?.capabilities?.canWritePolicy === true
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${bootstrapAdminToken}` },
  });
  body = await json(r);
  check('enterprise bootstrap admin can read organization', r.status === 200, `got ${r.status}`);
  check(
    'enterprise bootstrap organization includes scoped admin',
    body?.principals?.some(
      (p) =>
        p.userId === 'admin' &&
        p.role === 'admin' &&
        p.scopes?.includes?.('org:write')
    )
  );

  r = await fetch(`${server.base}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${bootstrapAdminToken}` },
  });
  check('enterprise bootstrap admin can fetch csrf', r.status === 200, `got ${r.status}`);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_ADMIN_TOKEN_SHA256: bootstrapAdminTokenSha256,
  DASHBOARD_AUTH_ENFORCE_SCOPES: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${bootstrapAdminHashToken}` },
  });
  let body = await json(r);
  check('enterprise bootstrap hash admin session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise bootstrap hash admin keeps write scope',
    body?.capabilities?.canWritePolicy === true
  );

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${bootstrapAdminHashToken}` },
  });
  body = await json(r);
  const bodyText = JSON.stringify(body);
  const credentialStorageControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'credential-storage'
  );
  check('enterprise bootstrap hash admin can read organization', r.status === 200, `got ${r.status}`);
  check(
    'enterprise bootstrap hash admin avoids raw credential posture',
    credentialStorageControl?.state === 'enabled'
  );
  check('enterprise bootstrap hash admin redacts bearer', !bodyText.includes(bootstrapAdminHashToken));
  check('enterprise bootstrap hash admin redacts configured hash', !bodyText.includes(bootstrapAdminTokenSha256));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: 'true',
  DASHBOARD_USAGE_CREDENTIAL_MAX_BYTES: '1024',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const oversizedOauthSecret = 'oversized-oauth-token-that-must-not-leak';
  await writeFile(
    join(server.claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: oversizedOauthSecret,
        padding: 'x'.repeat(2_000),
      },
    })
  );

  const r = await fetch(`${server.base}/api/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  check('enterprise usage gauge oversized credential -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise usage gauge oversized credential unavailable', body?.available === false);
  check('enterprise usage gauge oversized credential reports not logged in', body?.reason === 'not-logged-in');
  check('enterprise usage gauge oversized credential redacts token', !bodyText.includes(oversizedOauthSecret));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_ALLOWED_ORIGINS:
    'https://dashboard.example.com,ftp://dashboard.example.com,https://bad.example.com/path?x=1#y',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const writeOriginControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'write-origin-allowlist'
  );
  check('enterprise invalid write origins posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise invalid write origins are action-required',
    writeOriginControl?.state === 'action-required'
  );
  check(
    'enterprise invalid write origins report ignored count',
    writeOriginControl?.summary?.includes?.('1 configured public write origin') &&
      writeOriginControl?.summary?.includes?.('2 invalid origin entries ignored')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_TRUST_PROXY_HEADERS: 'true',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES: '192.0.2.250',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer untrusted-forwarded-token',
      'X-Forwarded-For': '203.0.113.20',
    },
  });
  check('enterprise untrusted proxy allows first socket-keyed miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer untrusted-forwarded-rotated-token',
      'X-Forwarded-For': '203.0.113.21',
    },
  });
  check('enterprise untrusted proxy ignores spoofed forwarded client', r.status === 429, `got ${r.status}`);

  const audit = await readAuditLog(server.auditLog, 2);
  check(
    'enterprise untrusted proxy audit does not record spoofed client',
    !audit.events.some((e) => e.remoteAddress === '203.0.113.20' || e.remoteAddress === '203.0.113.21')
  );
  check('enterprise untrusted proxy audit redacts token', !audit.raw.includes('untrusted-forwarded-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_TRUST_PROXY_HEADERS: 'true',
  DASHBOARD_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer forwarded-rate-token',
      'X-Forwarded-For': '203.0.113.10, 10.0.0.2',
    },
  });
  check('enterprise trusted proxy rate limit allows first forwarded miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer forwarded-rate-token',
      'X-Forwarded-For': '203.0.113.11, 10.0.0.2',
    },
  });
  check('enterprise trusted proxy rate limit keys by forwarded client', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer forwarded-rate-token',
      'X-Forwarded-For': '203.0.113.10, 10.0.0.2',
    },
  });
  check('enterprise trusted proxy rate limit blocks repeated forwarded client', r.status === 429, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer forwarded-ipv6-token',
      'X-Forwarded-For': '2001:db8::1',
    },
  });
  check('enterprise trusted proxy keeps bare IPv6 forwarded address', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const postureBody = await json(r);
  const trustedProxyControl = postureBody?.securityPosture?.controls?.find?.(
    (control) => control.id === 'trusted-proxy-boundary'
  );
  check('enterprise trusted proxy posture reports allowlist', trustedProxyControl?.state === 'enabled');

  const audit = await readAuditLog(server.auditLog, 4);
  check(
    'enterprise trusted proxy audit records forwarded client',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.rate_limited' &&
        e.reason === 'rate_limit:auth' &&
        e.remoteAddress === '203.0.113.10'
    )
  );
  check(
    'enterprise trusted proxy audit records IPv6 client',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.auth.session' &&
        e.reason === 'invalid_token' &&
        e.remoteAddress === '2001:db8::1'
    )
  );
  check('enterprise trusted proxy audit redacts token', !audit.raw.includes('forwarded-rate-token'));
  check('enterprise trusted proxy audit redacts IPv6 token', !audit.raw.includes('forwarded-ipv6-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ANTHROPIC_API_KEY: 'fake-test-key',
});
try {
  let r = await fetch(`${server.base}/api/audit.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  check('enterprise server LLM audit key alone -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise server LLM audit disabled reports skipped status', body?.status === 'skipped');
  check('enterprise server LLM audit disabled without opt-in', body?.disabled === true);
  check('enterprise server LLM audit reports disabled reason', body?.reason === 'server_llm_audits_disabled');

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const llmControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'server-llm-audits'
  );
  check('enterprise posture reports server LLM audit control', Boolean(llmControl));
  check('enterprise posture reports server LLM audit disabled', llmControl?.state === 'disabled');

  const audit = await readAuditLog(server.auditLog, 1);
  check(
    'enterprise server LLM audit disabled event is written',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.llm_audit' &&
        e.outcome === 'skipped' &&
        e.reason === 'server_llm_audits_disabled'
    )
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_CONTENT_SECURITY_POLICY:
    "default-src 'self'; connect-src 'self' https://api.anthropic.com; frame-ancestors 'none'",
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const csp = r.headers.get('content-security-policy') || '';
  check('enterprise custom CSP session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise custom CSP override is applied', csp.includes('api.anthropic.com'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const securityHeadersControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'security-headers'
  );
  const browserEgressControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-llm-egress'
  );
  check(
    'enterprise custom CSP marks security headers operator-managed',
    securityHeadersControl?.state === 'action-required'
  );
  check(
    'enterprise custom CSP marks browser egress operator-managed',
    browserEgressControl?.state === 'action-required'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const hostOauthSecret = 'host-oauth-token-that-must-not-leak';
  await writeFile(
    join(server.claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: hostOauthSecret } })
  );

  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  const csp = r.headers.get('content-security-policy') || '';
  check('enterprise default browser LLM egress session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise default session cannot use browser LLM egress',
    body?.capabilities?.canUseBrowserLlmEgress === false
  );
  check(
    'enterprise CSP blocks browser LLM egress by default',
    csp.includes("connect-src 'self'") && !csp.includes('api.anthropic.com')
  );

  r = await fetch(`${server.base}/api/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  let bodyText = JSON.stringify(body);
  check('enterprise usage gauge disabled by default -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise usage gauge disabled payload unavailable', body?.available === false);
  check(
    'enterprise usage gauge reports disabled reason',
    body?.reason === 'server_usage_gauge_disabled'
  );
  check('enterprise usage gauge redacts host oauth credential', !bodyText.includes(hostOauthSecret));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const usageControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'server-usage-gauge'
  );
  const browserEgressControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-llm-egress'
  );
  check('enterprise posture reports usage gauge control', Boolean(usageControl));
  check('enterprise posture reports usage gauge disabled', usageControl?.state === 'disabled');
  check('enterprise posture reports browser LLM egress control', Boolean(browserEgressControl));
  check(
    'enterprise posture reports browser LLM egress disabled',
    browserEgressControl?.state === 'disabled'
  );

  // Audit writes are queued after the response path. Under parallel CI load an
  // unrelated earlier record can satisfy a minimum-count wait before this
  // usage-gauge record reaches disk (#2442), so wait for the exact claim below.
  const audit = await readAuditLogUntil(server.auditLog, ({ events }) =>
    events.some(
      (e) =>
        e.type === 'enterprise.usage_gauge' &&
        e.outcome === 'skipped' &&
        e.reason === 'server_usage_gauge_disabled'
    )
  );
  check(
    'enterprise usage gauge disabled event is written',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.usage_gauge' &&
        e.outcome === 'skipped' &&
        e.reason === 'server_usage_gauge_disabled'
    )
  );
  check('enterprise usage gauge audit redacts host oauth credential', !audit.raw.includes(hostOauthSecret));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  const csp = r.headers.get('content-security-policy') || '';
  check('enterprise browser LLM egress opt-in session -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise browser LLM egress opt-in session can use browser LLM egress',
    body?.capabilities?.canUseBrowserLlmEgress === true
  );
  check('enterprise CSP allows browser LLM egress when opted in', csp.includes('api.anthropic.com'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const browserEgressControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'browser-llm-egress'
  );
  check(
    'enterprise posture reports browser LLM egress enabled',
    browserEgressControl?.state === 'enabled'
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const control = body?.securityPosture?.controls?.find?.(
    (item) => item.id === 'github-review-sync'
  );
  check('enterprise posture reports GitHub review sync control', Boolean(control));
  check('enterprise GitHub review sync disabled by default', control?.state === 'disabled');
  check(
    'enterprise GitHub review sync disabled summary names opt-in',
    control?.summary?.includes?.('DASHBOARD_REVIEW_EVENTS_SOURCE=github')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
  DASHBOARD_GITHUB_REVIEW_TOKEN: 'github-review-sync-secret-must-not-leak',
  DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app,acme/api',
  DASHBOARD_GITHUB_REVIEW_API_BASE: 'https://github.example.test/api/v3',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const control = body?.securityPosture?.controls?.find?.(
    (item) => item.id === 'github-review-sync'
  );
  check('enterprise GitHub review sync valid posture -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise GitHub review sync valid posture enabled', control?.state === 'enabled');
  check(
    'enterprise GitHub review sync valid posture reports count and caps',
    control?.summary?.includes?.('2 GitHub repo') &&
      control?.summary?.includes?.('5000ms') &&
      control?.summary?.includes?.('1048576 byte') &&
      control?.summary?.includes?.('300000ms')
  );
  check(
    'enterprise GitHub review sync posture redacts token',
    !bodyText.includes('github-review-sync-secret-must-not-leak')
  );
  check(
    'enterprise GitHub review sync posture redacts repo allowlist',
    !bodyText.includes('acme/app') && !bodyText.includes('acme/api')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
  DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const control = body?.securityPosture?.controls?.find?.(
    (item) => item.id === 'github-review-sync'
  );
  check(
    'enterprise GitHub review sync missing token is action-required',
    control?.state === 'action-required' &&
      control?.summary?.includes?.('DASHBOARD_GITHUB_REVIEW_TOKEN')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
  DASHBOARD_GITHUB_REVIEW_TOKEN: 'github-review-sync-secret-must-not-leak',
  DASHBOARD_GITHUB_REVIEW_REPOS: 'acme/app',
  DASHBOARD_GITHUB_REVIEW_API_BASE:
    'https://user:embedded-api-base-secret@github.example.test/api/v3',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const control = body?.securityPosture?.controls?.find?.(
    (item) => item.id === 'github-review-sync'
  );
  check(
    'enterprise GitHub review sync invalid API base is action-required',
    control?.state === 'action-required' && control?.summary?.includes?.('HTTPS URL')
  );
  check(
    'enterprise GitHub review sync invalid posture redacts token',
    !bodyText.includes('github-review-sync-secret-must-not-leak')
  );
  check(
    'enterprise GitHub review sync invalid posture redacts API base credential',
    !bodyText.includes('embedded-api-base-secret')
  );
} finally {
  await server.stop();
}

const oversizedGithubReviewRepos = Array.from(
  { length: 30 },
  (_, i) => `acme/repo${i}`
).join(',');
server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_REVIEW_EVENTS_SOURCE: 'github',
  DASHBOARD_GITHUB_REVIEW_TOKEN: 'github-review-sync-secret-must-not-leak',
  DASHBOARD_GITHUB_REVIEW_REPOS: oversizedGithubReviewRepos,
  DASHBOARD_GITHUB_REVIEW_REPOS_MAX_BYTES: '128',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const control = body?.securityPosture?.controls?.find?.(
    (item) => item.id === 'github-review-sync'
  );
  check(
    'enterprise GitHub review sync oversized repo list is action-required',
    control?.state === 'action-required' && control?.summary?.includes?.('128 byte')
  );
  check(
    'enterprise GitHub review sync oversized posture redacts repo payload',
    !bodyText.includes('acme/repo0')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ENABLE_SERVER_LLM_AUDITS: 'true',
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  let r = await fetch(`${server.base}/api/audit.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = await json(r);
  check('enterprise server LLM audit enabled without key -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise server LLM audit missing key reports skipped status', body?.status === 'skipped');
  check('enterprise server LLM audit reports missing key', body?.reason === 'missing_anthropic_api_key');

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const llmControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'server-llm-audits'
  );
  check('enterprise posture reports server LLM audit action required', llmControl?.state === 'action-required');
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_AUDIT_READ_MAX_BYTES: '131072',
});
try {
  const auditReadSideSecret = 'audit-read-side-secret';
  const oldNoise = 'old audit prefix marker '.repeat(4_000);
  const oldLine = auditLine({ path: '/old-audit-prefix-marker', oldNoise });
  const recentLines = Array.from({ length: 6 }, (_, i) =>
    auditLine({
      timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
      path: `/recent-audit-${i + 1}`,
      ...(i === 5
        ? {
            tokenHash: auditReadSideSecret,
            rawToken: auditReadSideSecret,
            principal: {
              userId: 'u-admin',
              role: 'admin',
              orgId: 'acme',
              teamId: 'platform',
              dataRoot: auditReadSideSecret,
            },
            remoteAddress: `127.0.0.1\n${auditReadSideSecret}`,
          }
        : {}),
    })
  );
  const oversizedAuditLine = auditLine({
    timestamp: '2026-01-01T00:00:07.000Z',
    path: '/oversized-audit-line',
    reason: 'x'.repeat(70_000),
  });
  await writeFile(
    server.auditLog,
    `${oldLine}${recentLines.slice(0, 5).join('')}${oversizedAuditLine}${recentLines[5]}`
  );

  const r = await fetch(`${server.base}/api/enterprise/audit-log?limit=3`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const bodyText = JSON.stringify(body);
  const recentAudit = body?.events?.find?.((e) => e.path === '/recent-audit-6');
  check('enterprise audit API handles large audit log -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise audit API respects limit on large log', body?.events?.length === 3);
  check('enterprise audit API returns tail events', body?.events?.some?.((e) => e.path === '/recent-audit-6'));
  check('enterprise audit API omits old audit prefix', !bodyText.includes('old-audit-prefix-marker'));
  check('enterprise audit API skips over-limit audit line', !bodyText.includes('oversized-audit-line'));
  check('enterprise audit API sanitizes tampered tail fields', !bodyText.includes(auditReadSideSecret));
  check('enterprise audit API drops invalid token hash', recentAudit && !('tokenHash' in recentAudit));
  check('enterprise audit API allowlists principal fields', recentAudit?.principal && !('dataRoot' in recentAudit.principal));
  check('enterprise audit API reports requested limit', body?.limit === 3);
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_AUDIT_ROTATE_MAX_BYTES: '512',
  ENTERPRISE_AUDIT_ROTATE_MAX_FILES: '2',
});
try {
  const oldLine = auditLine({
    path: '/rotated-audit-prefix',
    oldNoise: 'rotation seed '.repeat(80),
  });
  await writeFile(server.auditLog, oldLine);

  const r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer rotation-bad-token' },
  });
  check('enterprise audit rotation request still returns auth status', r.status === 401, `got ${r.status}`);

  const audit = await readAuditLogUntil(server.auditLog, ({ events }) =>
    events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'invalid_token')
  );
  const rotatedRaw = await readTextUntil(`${server.auditLog}.1`, (raw) =>
    raw.includes('/rotated-audit-prefix')
  );
  const rotatedMode = await fileMode(`${server.auditLog}.1`);
  check(
    'enterprise audit rotation keeps newest event in active log',
    audit.events.some((e) => e.type === 'enterprise.auth.session' && e.reason === 'invalid_token')
  );
  check('enterprise audit rotation moves oversized prior log', rotatedRaw.includes('/rotated-audit-prefix'));
  check(
    'enterprise audit rotation tightens backup file mode',
    rotatedMode === 0o600,
    `got ${rotatedMode.toString(8)}`
  );
  check('enterprise audit rotation redacts request token', !audit.raw.includes('rotation-bad-token'));

  await writeFile(
    server.auditLog,
    auditLine({
      path: '/rotated-audit-second',
      oldNoise: 'rotation second seed '.repeat(80),
    })
  );
  await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer rotation-second-bad-token' },
  });
  const secondBackup = await readTextUntil(`${server.auditLog}.2`, (raw) =>
    raw.includes('/rotated-audit-prefix')
  );
  check(
    'enterprise audit rotation retains bounded older backup',
    secondBackup.includes('/rotated-audit-prefix')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer rate-limited-token' },
  });
  check('enterprise auth rate limit allows first miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: 'Bearer rate-limited-rotated-token' },
  });
  const body = await json(r);
  check('enterprise auth rate limit returns 429 across rotated tokens', r.status === 429, `got ${r.status}`);
  check('enterprise auth rate limit reports retry', typeof body?.retryAfterSeconds === 'number');
  check('enterprise auth rate limit sets retry-after', r.headers.has('retry-after'));
  check('enterprise auth rate limit sets remaining zero', r.headers.get('ratelimit-remaining') === '0');

  const audit = await readAuditLog(server.auditLog, 2);
  check('enterprise auth rate limit writes audit', audit.events.some((e) => e.type === 'enterprise.rate_limited' && e.reason === 'rate_limit:auth'));
  check('enterprise auth rate limit redacts token', !audit.raw.includes('rate-limited-token'));
  check('enterprise auth rate limit redacts rotated token', !audit.raw.includes('rate-limited-rotated-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_AUTH_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: 'Bearer protected-route-bad-token' },
  });
  check('enterprise protected route auth rate limit allows first miss', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: 'Bearer protected-route-rotated-bad-token' },
  });
  const body = await json(r);
  check('enterprise protected route auth rate limit blocks rotated invalid token', r.status === 429, `got ${r.status}`);
  check('enterprise protected route auth rate limit reports retry', typeof body?.retryAfterSeconds === 'number');

  const audit = await readAuditLog(server.auditLog, 2);
  check(
    'enterprise protected route auth rate limit writes audit',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.rate_limited' &&
        e.reason === 'rate_limit:auth' &&
        e.path === '/sessions-manifest.json'
    )
  );
  check('enterprise protected route auth rate limit redacts first token', !audit.raw.includes('protected-route-bad-token'));
  check('enterprise protected route auth rate limit redacts rotated token', !audit.raw.includes('protected-route-rotated-bad-token'));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  ENTERPRISE_RATE_LIMIT_WINDOW_MS: '60000',
  ENTERPRISE_API_RATE_LIMIT: '1',
});
try {
  let r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('enterprise API rate limit allows first request', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  check('enterprise API rate limit returns 429', r.status === 429, `got ${r.status}`);
  check('enterprise API rate limit reports retry', typeof body?.retryAfterSeconds === 'number');
  check('enterprise API rate limit sets retry-after', r.headers.has('retry-after'));
  check('enterprise API rate limit sets remaining zero', r.headers.get('ratelimit-remaining') === '0');

  const audit = await readAuditLog(server.auditLog, 1);
  check(
    'enterprise API rate limit writes audit',
    audit.events.some(
      (e) =>
        e.type === 'enterprise.rate_limited' &&
        e.reason === 'rate_limit:api' &&
        e.path === '/sessions-manifest.json'
    )
  );
  check('enterprise API rate limit redacts token', !audit.raw.includes(token));
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
});
try {
  await populateOrganizationRollupFixture(server.claudeDir);
  await writeIdentityRecommendationTasks(
    server.claudeDir,
    'u-admin',
    'admin@example.com',
    'u-viewer',
    'viewer@example.com'
  );

  let r = await fetch(`${server.base}/api/auth/session`);
  let body = await json(r);
  check('enterprise session without token -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise session without token is no-store', r.headers.get('cache-control') === 'no-store');
  check('enterprise unauth body is configured', body?.configured === true);

  r = await fetch(`${server.base}/sessions-manifest.json`);
  check('enterprise manifest without token -> 401', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/history.jsonl`);
  check('enterprise raw history without token -> 401', r.status === 401, `got ${r.status}`);

  const deniedRequestId = 'enterprise-test-request-1';
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: {
      Authorization: 'Bearer wrong-token',
      'X-Request-Id': deniedRequestId,
    },
  });
  check('enterprise session with bad token -> 401', r.status === 401, `got ${r.status}`);
  check(
    'enterprise response echoes request id',
    r.headers.get('x-request-id') === deniedRequestId
  );

  const oversizedBearer = 'x'.repeat(8_193);
  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${oversizedBearer}` },
  });
  check('enterprise oversized bearer token -> 401', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise session with token -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise session with token is no-store', r.headers.get('cache-control') === 'no-store');
  check('enterprise principal is admin', body?.principal?.role === 'admin');
  check('enterprise principal has org', body?.principal?.orgId === 'acme');
  check('enterprise principal has team id', body?.principal?.teamId === 'platform');
  check('enterprise principal has team name', body?.principal?.teamName === 'Platform Team');
  check(
    'enterprise principal has static scopes',
    body?.principal?.scopes?.includes?.('org:read') &&
      body?.principal?.scopes?.includes?.('audit:read')
  );
  check('enterprise admin can read org rollup', body?.capabilities?.canReadOrganizationRollup === true);
  check('enterprise admin can read org data', body?.capabilities?.canReadOrganizationData === true);
  check('enterprise admin cannot import local data by default', body?.capabilities?.canImportLocalData === false);
  check('enterprise admin cannot use browser LLM egress by default', body?.capabilities?.canUseBrowserLlmEgress === false);

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise manifest with token -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise manifest body is array', Array.isArray(body));

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  body = await json(r);
  check('enterprise viewer session -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise viewer has team id', body?.principal?.teamId === 'support');
  check('enterprise viewer parses string scopes', body?.principal?.scopes?.includes?.('sessions:read'));
  check('enterprise viewer cannot read org data capability', body?.capabilities?.canReadOrganizationData === false);
  check('enterprise viewer cannot read raw transcript capability', body?.capabilities?.canReadRawTranscripts === false);
  check('enterprise viewer cannot import local data by default', body?.capabilities?.canImportLocalData === false);
  check('enterprise viewer cannot use browser LLM egress by default', body?.capabilities?.canUseBrowserLlmEgress === false);

  r = await fetch(`${server.base}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise csrf bootstrap with token -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise csrf bootstrap is no-store', r.headers.get('cache-control') === 'no-store');
  check('enterprise csrf body includes token', typeof body?.token === 'string');
  const writeCsrfToken = body?.token;

  r = await fetch(`${server.base}/api/adoption/receipts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-CSRF-Token': String(writeCsrfToken || ''),
      'Content-Type': 'application/json',
      Origin: server.base,
    },
    body: JSON.stringify({
      kind: 'SURFACED',
      sessionHash: 'enterprise-session',
      findingIds: ['demo.finding'],
    }),
  });
  body = await json(r);
  check('enterprise admin can post write route with bearer and csrf', r.status === 200, `got ${r.status} ${JSON.stringify(body)}`);
  check('enterprise admin write route returns ok', body?.ok === true);

  r = await fetch(`${server.base}/api/adoption/receipts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-CSRF-Token': 'x'.repeat(9000),
      'Content-Type': 'application/json',
      Origin: server.base,
    },
    body: JSON.stringify({
      kind: 'SURFACED',
      sessionHash: 'enterprise-oversized-csrf',
      findingIds: ['demo.finding'],
    }),
  });
  body = await json(r);
  check('enterprise oversized write csrf token -> 401', r.status === 401, `got ${r.status}`);
  check('enterprise oversized write csrf token reports unauthorized', body?.error?.includes('CSRF token'));

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read org manifest', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/dataset.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read org dataset', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/recommendations.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read org recommendations', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/adoption/receipts`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read org adoption receipts', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/history.jsonl`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read raw history', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/csrf-token`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot fetch write csrf token', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/adoption/receipts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${viewerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ findingId: 'demo.finding', state: 'SURFACED' }),
  });
  check('enterprise viewer cannot post write routes', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/audit-log`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read audit log', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read organization admin', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/organization/rollup.json`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  check('enterprise viewer cannot read organization rollup', r.status === 403, `got ${r.status}`);

  r = await fetch(`${server.base}/api/enterprise/audit-log?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise admin can read audit log', r.status === 200, `got ${r.status}`);
  check('enterprise audit API returns events', Array.isArray(body?.events));

  r = await fetch(`${server.base}/api/enterprise/audit-export.ndjson?limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const auditExportBody = await r.text();
  const auditExportLines = auditExportBody.split('\n').filter(Boolean);
  const auditExportFirstEvent = auditExportLines[0]
    ? JSON.parse(auditExportLines[0])
    : null;
  check('enterprise admin can export audit NDJSON', r.status === 200, `got ${r.status}`);
  check(
    'enterprise audit export uses NDJSON attachment',
    r.headers.get('content-type')?.includes('application/x-ndjson') &&
      r.headers.get('content-disposition')?.includes('enterprise-audit-export.ndjson')
  );
  check(
    'enterprise audit export returns sanitized event lines',
    auditExportLines.length > 0 &&
      auditExportFirstEvent?.type?.startsWith?.('enterprise.') &&
      !auditExportBody.includes(token) &&
      !auditExportBody.includes(viewerToken)
  );

  r = await fetch(`${server.base}/api/recommendations.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const identityRecommendation = body?.find?.(
    (rec) => rec?.id === 'workflow.owner-concentration'
  );
  check('enterprise recommendations -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise recommendations use org identity aliases',
    identityRecommendation?.detail?.includes('Admin User owns 4 of 6') &&
      identityRecommendation?.evidence?.[0]?.includes('via aliases admin@example.com, u-admin'),
    identityRecommendation?.detail || ''
  );
  check(
    'enterprise recommendations cite matched principal identity',
    identityRecommendation?.provenance?.observations?.some?.(
      (observation) =>
        observation?.source === 'organizationIdentity' &&
        observation?.value === 'u-admin'
    )
  );
  check(
    'enterprise recommendations cache miss',
    r.headers.get('x-recommendations-cache') === 'miss',
    r.headers.get('x-recommendations-cache') || ''
  );
  r = await fetch(`${server.base}/api/recommendations.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('enterprise cached recommendations -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise recommendations cache hit',
    r.headers.get('x-recommendations-cache') === 'hit',
    r.headers.get('x-recommendations-cache') || ''
  );
  check('enterprise live API is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/api/organization/rollup.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const rollupBody = JSON.stringify(body);
  check('enterprise admin can read organization rollup endpoint', r.status === 200, `got ${r.status}`);
  check('enterprise organization rollup is redacted', body?.privacy?.redacted === true);
  check('enterprise organization rollup counts sessions', body?.counts?.sessions === 1);
  check('enterprise organization rollup counts projects', body?.counts?.projects === 1);
  check('enterprise organization rollup counts unattended sessions', body?.counts?.unattendedSessions === 1);
  check('enterprise organization rollup counts bypass sessions', body?.counts?.bypassPermissionSessions === 1);
  check('enterprise organization rollup counts dangerous command sessions', body?.counts?.dangerousCommandSessions === 1);
  check('enterprise organization rollup reports token usage', body?.usage?.tokens?.input === 900);
  check('enterprise organization rollup reports tool aggregate', body?.tools?.topTools?.some?.((tool) => tool.toolName === 'Bash'));
  check('enterprise organization rollup reports danger pattern', body?.safety?.dangerousCommands?.patterns?.some?.((pattern) => pattern.name === 'rm -rf'));
  check('enterprise organization rollup pseudonymizes projects', typeof body?.topProjects?.[0]?.projectKey === 'string' && body?.topProjects?.[0]?.label === 'Project 1');
  check('enterprise organization rollup redacts sensitive prompt', !rollupBody.includes('SENSITIVE_ENTERPRISE_PROMPT'));
  check('enterprise organization rollup redacts session id', !rollupBody.includes('enterprise-secret-session'));
  check('enterprise organization rollup redacts project path', !rollupBody.includes('/workspace/acme-secret-app'));
  check('enterprise organization rollup redacts command body', !rollupBody.includes('/tmp/secret-merger'));
  check('enterprise organization rollup redacts tool result', !rollupBody.includes('SECRET_TOOL_RESULT'));

  r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const organizationBody = JSON.stringify(body);
  check('enterprise admin can read organization admin', r.status === 200, `got ${r.status}`);
  check('enterprise organization returns principals', body?.principals?.length === 2);
  check('enterprise organization returns principal page total', body?.principalPage?.total === 2);
  check('enterprise organization returns teams', body?.teams?.length === 2);
  check('enterprise organization embeds redacted rollup', body?.rollup?.privacy?.redacted === true);
  check(
    'enterprise organization rolls up admin team',
    body?.teams?.some(
      (t) =>
        t.teamId === 'platform' &&
        t.principalCount === 1 &&
        t.adminCount === 1
    )
  );
  check(
    'enterprise organization returns security posture',
    Array.isArray(body?.securityPosture?.controls)
  );
  check(
    'enterprise security posture includes auth control',
    body?.securityPosture?.controls?.some(
      (control) => control.id === 'auth' && control.state === 'enabled'
    )
  );
  check(
    'enterprise security posture includes data authorization control',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'authorization' && control.summary.includes('Admin-only')
    )
  );
  check(
    'enterprise security posture flags disabled scope enforcement',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'scope-enforcement' &&
        control.state === 'action-required' &&
        control.summary.includes('DASHBOARD_AUTH_ENFORCE_SCOPES')
    )
  );
  check(
    'enterprise security posture flags raw static credentials',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'credential-storage' &&
        control.state === 'action-required'
    )
  );
  check(
    'enterprise security posture flags short raw static credentials',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'credential-strength' &&
        control.state === 'action-required' &&
        control.summary.includes('shorter than 32')
    )
  );
  check(
    'enterprise security posture reports bearer size cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'bearer-token-size' &&
        control.state === 'enabled' &&
        control.summary.includes('8192 byte')
    )
  );
  check(
    'enterprise security posture reports static token config cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'static-token-config-size' &&
        control.state === 'enabled' &&
        control.summary.includes('1048576 byte') &&
        control.summary.includes('256 principal')
    )
  );
  check(
    'enterprise security posture reports audit line cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'audit-log' &&
        control.state === 'enabled' &&
        control.detail.includes('65536 byte')
    )
  );
  check(
    'enterprise security posture reports principal scope cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'principal-scope-size' &&
        control.state === 'enabled' &&
        control.summary.includes('8192 byte') &&
        control.summary.includes('64 scope') &&
        control.summary.includes('128 character')
    )
  );
  check(
    'enterprise security posture reports organization response cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'organization-response-size' &&
        control.state === 'enabled' &&
        control.summary.includes('16777216 byte') &&
        control.detail.includes('DASHBOARD_ORGANIZATION_RESPONSE_MAX_BYTES') &&
        control.detail.includes('413')
    )
  );
  check(
    'enterprise security posture reports mutating body cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'mutating-body-size' &&
        control.state === 'enabled' &&
        control.summary.includes('1048576 byte') &&
        control.detail.includes('DASHBOARD_CONFIG_FILE_MAX_BYTES=1048576')
    )
  );
  check(
    'enterprise security posture reports usage credential cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'usage-credential-size' &&
        control.state === 'enabled' &&
        control.summary.includes('65536 byte')
    )
  );
  check(
    'enterprise security posture reports raw file cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'raw-file-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte') &&
        control.summary.includes('10000 transcript part')
    )
  );
  check(
    'enterprise security posture reports sessions manifest cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'sessions-manifest-size' &&
        control.state === 'enabled' &&
        control.summary.includes('50000 top-level session file entries')
    )
  );
  check(
    'enterprise security posture reports lazy transcript cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'lazy-transcript-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte')
    )
  );
  check(
    'enterprise security posture reports dataset response cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'dataset-response-size' &&
        control.state === 'enabled' &&
        control.summary.includes('536870912 byte') &&
        control.detail.includes('DASHBOARD_DATASET_RESPONSE_MAX_BYTES') &&
        control.detail.includes('cache persistence')
    )
  );
  check(
    'enterprise security posture reports ingest session cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'ingest-session-size' &&
        control.state === 'enabled' &&
        control.summary.includes('50000 project dir') &&
        control.summary.includes('250000 session dir') &&
        control.summary.includes('67108864 byte') &&
        control.summary.includes('10000 transcript part') &&
        control.detail.includes('DASHBOARD_INGEST_PROJECT_MAX_DIRS') &&
        control.detail.includes('DASHBOARD_INGEST_SESSION_DISCOVERY_MAX_ENTRIES')
    )
  );
  check(
    'enterprise security posture reports live session cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'live-session-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte')
    )
  );
  check(
    'enterprise security posture reports config file cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'config-file-size' &&
        control.state === 'enabled' &&
        control.summary.includes('1048576 byte') &&
        control.summary.includes('50000 resource') &&
        control.detail.includes('config backups') &&
        control.detail.includes('DASHBOARD_CONFIG_RESOURCE_MAX_ENTRIES')
    )
  );
  check(
    'enterprise security posture reports artifact file cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'artifact-file-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte') &&
        control.detail.includes('team inboxes') &&
        control.detail.includes('debug logs')
    )
  );
  check(
    'enterprise security posture reports artifact directory cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'artifact-directory-entries' &&
        control.state === 'enabled' &&
        control.summary.includes('50000 directory entry') &&
        control.detail.includes('DASHBOARD_ARTIFACT_DIR_MAX_ENTRIES') &&
        control.detail.includes('config backups')
    )
  );
  check(
    'enterprise security posture reports artifact cache cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'artifact-cache-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte') &&
        control.detail.includes('DASHBOARD_ARTIFACT_CACHE_JSON_MAX_BYTES') &&
        control.detail.includes('not persisted')
    )
  );
  check(
    'enterprise security posture reports artifact signature bounds',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'artifact-signature-bounds' &&
        control.state === 'enabled' &&
        control.summary.includes('250000 tree entry') &&
        control.summary.includes('50000 repo-map directory') &&
        control.detail.includes('DASHBOARD_SIGNATURE_TREE_MAX_ENTRIES') &&
        control.detail.includes('DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES')
    )
  );
  check(
    'enterprise security posture reports adoption receipt read cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'adoption-receipt-read-size' &&
        control.state === 'enabled' &&
        control.summary.includes('1048576 byte') &&
        control.detail.includes('65536 byte')
    )
  );
  check(
    'enterprise security posture reports memory read caps',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'memory-read-size' &&
        control.state === 'enabled' &&
        control.summary.includes('262144 byte') &&
        control.summary.includes('4194304 byte') &&
        control.summary.includes('50000 file') &&
        control.summary.includes('50000 entry') &&
        control.detail.includes('DASHBOARD_MEMORY_DIR_MAX_ENTRIES')
    )
  );
  check(
    'enterprise security posture reports workflow manifest cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'workflow-manifest-size' &&
        control.state === 'enabled' &&
        control.summary.includes('1048576 byte') &&
        control.summary.includes('50000 run') &&
        control.summary.includes('500 per run') &&
        control.summary.includes('5000 per run') &&
        control.summary.includes('4096 char') &&
        control.detail.includes('DASHBOARD_WORKFLOW_PHASE_MAX_ENTRIES') &&
        control.detail.includes('DASHBOARD_WORKFLOW_PROGRESS_MAX_ENTRIES') &&
        control.detail.includes('DASHBOARD_WORKFLOW_FIELD_MAX_CHARS')
    )
  );
  check(
    'enterprise security posture reports recommendations cache cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'recommendations-cache' &&
        control.state === 'enabled' &&
        control.summary.includes('max 256 response') &&
        control.detail.includes('single-flight')
    )
  );
  check(
    'enterprise security posture reports recommendations response cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'recommendations-response-size' &&
        control.state === 'enabled' &&
        control.summary.includes('67108864 byte') &&
        control.detail.includes('DASHBOARD_RECOMMENDATIONS_RESPONSE_MAX_BYTES') &&
        control.detail.includes('not inserted')
    )
  );
  check(
    'enterprise security posture reports audit response cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'audit-response-size' &&
        control.state === 'enabled' &&
        control.summary.includes('4194304 byte') &&
        control.detail.includes('DASHBOARD_AUDIT_RESPONSE_MAX_BYTES') &&
        control.detail.includes('/api/audit.json') &&
        control.detail.includes('413')
    )
  );
  check(
    'enterprise security posture reports audit judge budget',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'audit-judge-budget' &&
        control.state === 'enabled' &&
        control.summary.includes('64 judge call') &&
        control.detail.includes('DASHBOARD_AUDIT_MAX_JUDGE_CALLS') &&
        control.detail.includes('unbounded egress')
    )
  );
  check(
    'enterprise security posture reports audit output token cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'audit-output-tokens' &&
        control.state === 'enabled' &&
        control.summary.includes('1024 output token') &&
        control.detail.includes('DASHBOARD_AUDIT_MAX_OUTPUT_TOKENS') &&
        control.detail.includes('cap receipt')
    )
  );
  check(
    'enterprise security posture reports audit input row cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'audit-input-rows' &&
        control.state === 'enabled' &&
        control.summary.includes('50000 row') &&
        control.detail.includes('DASHBOARD_AUDIT_INPUT_MAX_ROWS') &&
        control.detail.includes('pre-judge transforms')
    )
  );
  check(
    'enterprise security posture reports rate-limit bucket cap',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'rate-limits' &&
        control.state === 'enabled' &&
        control.summary.includes('max 50000 buckets')
    )
  );
  check(
    'enterprise security posture reports write origin allowlist',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'write-origin-allowlist' &&
        control.state === 'disabled' &&
        control.summary.includes('loopback origins')
    )
  );
  check(
    'enterprise security posture reports loopback transport',
    body?.securityPosture?.controls?.some(
      (control) =>
        control.id === 'transport-security' &&
        control.state === 'enabled' &&
        control.summary.includes('127.0.0.1')
    )
  );
  check(
    'enterprise security posture includes deployment notes',
    body?.securityPosture?.deploymentNotes?.some((note) =>
      note.includes('Per-principal data roots')
    )
  );
  check('enterprise organization returns audit events', Array.isArray(body?.auditEvents));
  const auditActivityBody = JSON.stringify(body?.auditActivity || {});
  check(
    'enterprise organization returns audit activity summary',
    body?.auditActivity?.privacy?.redacted === true &&
      body?.auditActivity?.events?.total >= body?.auditEvents?.length
  );
  check(
    'enterprise organization audit activity counts allowed and denied events',
    body?.auditActivity?.events?.allowed >= 1 &&
      body?.auditActivity?.events?.denied >= 1
  );
  check(
    'enterprise organization audit activity groups roles and types',
    body?.auditActivity?.principalRoles?.admin >= 1 &&
      body?.auditActivity?.topTypes?.some?.((entry) =>
        entry.name.startsWith('enterprise.')
      )
  );
  check(
    'enterprise organization audit activity is redacted',
    !auditActivityBody.includes(token) &&
      !auditActivityBody.includes(viewerToken) &&
      !auditActivityBody.includes('/api/') &&
      body?.auditActivity?.privacy?.excludes?.includes?.('token fingerprints') &&
      body?.auditActivity?.privacy?.excludes?.includes?.('request paths')
  );
  const organizationAdminBody = body;
  r = await fetch(`${server.base}/api/enterprise/readiness-receipt`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  const readinessBody = JSON.stringify(body || {});
  check('enterprise readiness receipt -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise readiness receipt reports aggregate status',
    body?.schemaVersion === '1' &&
      ['ready', 'review-required'].includes(body?.status) &&
      body?.summary?.configuredPrincipals >= 2 &&
      body?.summary?.auditEvents >= body?.evidence?.auditActivity?.events?.total
  );
  check(
    'enterprise readiness receipt includes posture and route evidence',
    body?.evidence?.posture?.controls?.total > 0 &&
      body?.evidence?.routeAccess?.unclassifiedApiRoutesFailClosed === true &&
      body?.evidence?.routeAccess?.writesRequireAdminAndCsrf === true &&
      body?.evidence?.bounds?.auditActivityMaxEvents === 250
  );
  check(
    'enterprise readiness receipt is redacted',
    body?.privacy?.redacted === true &&
      !readinessBody.includes(token) &&
      !readinessBody.includes(viewerToken) &&
      !readinessBody.includes('/api/') &&
      !readinessBody.includes('tokenHash') &&
      body?.privacy?.excludes?.includes?.('token fingerprints') &&
      body?.privacy?.excludes?.includes?.('security control details')
  );
  body = organizationAdminBody;
  check('enterprise organization redacts admin token', !organizationBody.includes(token));
  check('enterprise organization redacts viewer token', !organizationBody.includes(viewerToken));
  check(
    'enterprise organization includes admin principal',
    body?.principals?.some(
      (p) =>
        p.userId === 'u-admin' &&
        p.role === 'admin' &&
        p.teamId === 'platform' &&
        p.scopes?.includes?.('org:read')
    )
  );
  check(
    'enterprise organization includes viewer team',
    body?.principals?.some(
      (p) =>
        p.userId === 'u-viewer' &&
        p.teamId === 'support' &&
        p.teamName === 'Support Team' &&
        p.scopes?.includes?.('sessions:read')
    )
  );

  r = await fetch(`${server.base}/api/enterprise/organization?principalLimit=1&principalOffset=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  body = await json(r);
  check('enterprise organization paged roster -> 200', r.status === 200, `got ${r.status}`);
  check('enterprise organization pages principals', body?.principals?.length === 1);
  check('enterprise organization page reports total', body?.principalPage?.total === 2);
  check('enterprise organization page reports returned', body?.principalPage?.returned === 1);
  check('enterprise organization page keeps global team rollup', body?.teams?.length === 2);

  const hasBadSessionTokenAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.auth.session' &&
        e.status === 401 &&
        e.reason === 'invalid_token' &&
        e.requestId === deniedRequestId &&
        typeof e.tokenHash === 'string'
    );
  const hasAdminSessionAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.auth.session' &&
        e.status === 200 &&
        e.principal?.userId === 'u-admin' &&
        e.principal?.teamId === 'platform'
    );
  const hasForbiddenRawReadAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.route.denied' &&
        e.status === 403 &&
        e.path === '/history.jsonl' &&
        e.principal?.userId === 'u-viewer' &&
        e.principal?.teamId === 'support'
    );
  const hasForbiddenOrgDataReadAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.route.denied' &&
        e.status === 403 &&
        e.path === '/api/dataset.json' &&
        e.principal?.userId === 'u-viewer' &&
        e.principal?.teamId === 'support'
    );
  const hasForbiddenWriteRouteAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.route.denied' &&
        e.status === 403 &&
        e.path === '/api/adoption/receipts'
    );
  const hasPrivilegedAdminRouteAudit = (events) =>
    events.some(
      (e) =>
        e.type === 'enterprise.route.allowed' &&
        e.status === 200 &&
        e.path === '/api/csrf-token' &&
        e.principal?.userId === 'u-admin' &&
        e.principal?.teamId === 'platform'
    );
  const audit = await readAuditLogUntil(
    server.auditLog,
    ({ events }) =>
      events.length >= 12 &&
      hasBadSessionTokenAudit(events) &&
      hasAdminSessionAudit(events) &&
      hasForbiddenRawReadAudit(events) &&
      hasForbiddenOrgDataReadAudit(events) &&
      hasForbiddenWriteRouteAudit(events) &&
      hasPrivilegedAdminRouteAudit(events)
  );
  const auditMode = await fileMode(server.auditLog);
  check('enterprise audit file is written', audit.events.length >= 12, `got ${audit.events.length}`);
  check('enterprise audit file is private', auditMode === 0o600, `got ${auditMode.toString(8)}`);
  check('enterprise audit redacts admin token', !audit.raw.includes(token));
  check('enterprise audit redacts viewer token', !audit.raw.includes(viewerToken));
  check('enterprise audit redacts invalid token', !audit.raw.includes('wrong-token'));
  check('enterprise audit redacts oversized bearer token', !audit.raw.includes(oversizedBearer));
  check(
    'enterprise audit records bad session token',
    hasBadSessionTokenAudit(audit.events)
  );
  check(
    'enterprise audit records admin session',
    hasAdminSessionAudit(audit.events)
  );
  check(
    'enterprise audit records forbidden raw read',
    hasForbiddenRawReadAudit(audit.events)
  );
  check(
    'enterprise audit records forbidden org data read',
    hasForbiddenOrgDataReadAudit(audit.events)
  );
  check(
    'enterprise audit records forbidden write route',
    hasForbiddenWriteRouteAudit(audit.events)
  );
  check(
    'enterprise audit records privileged admin route',
    hasPrivilegedAdminRouteAudit(audit.events)
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  DASHBOARD_USER: 'basic-user',
  DASHBOARD_PASS: 'basic-pass',
});
try {
  const basicHeader = `Basic ${Buffer.from('basic-user:basic-pass').toString('base64')}`;
  const oversizedBasicHeader = `Basic ${Buffer.from(`${'u'.repeat(2048)}:basic-pass`).toString('base64')}`;
  let r = await fetch(`${server.base}/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('enterprise bearer cannot bypass basic static shell', r.status === 401, `got ${r.status}`);
  check(
    'basic auth static shell rejection varies by authorization',
    String(r.headers.get('vary') || '').toLowerCase().includes('authorization')
  );
  check('basic auth static shell rejection is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/`, {
    headers: { Authorization: basicHeader },
  });
  check('basic auth still unlocks static shell', r.status === 200, `got ${r.status}`);
  check(
    'basic auth static shell success varies by authorization',
    String(r.headers.get('vary') || '').toLowerCase().includes('authorization')
  );

  r = await fetch(`${server.base}/`, {
    headers: { Authorization: oversizedBasicHeader },
  });
  check('basic auth rejects oversized submitted username', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('enterprise bearer bypasses basic for auth API', r.status === 200, `got ${r.status}`);

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('enterprise bearer bypasses basic for protected data', r.status === 200, `got ${r.status}`);
  check('basic auth protected data is no-store', r.headers.get('cache-control') === 'no-store');
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_USER: 'basic-user',
  DASHBOARD_PASS: 'basic-pass',
});
try {
  const basicHeader = `Basic ${Buffer.from('basic-user:basic-pass').toString('base64')}`;
  let r = await fetch(`${server.base}/sessions-manifest.json`);
  check('basic auth protects manifest without enterprise', r.status === 401, `got ${r.status}`);
  check(
    'basic auth manifest rejection varies by authorization',
    String(r.headers.get('vary') || '').toLowerCase().includes('authorization')
  );
  check('basic auth manifest rejection is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: basicHeader },
  });
  check('basic auth manifest success -> 200', r.status === 200, `got ${r.status}`);
  check(
    'basic auth manifest success varies by authorization',
    String(r.headers.get('vary') || '').toLowerCase().includes('authorization')
  );
  check('basic auth manifest success is no-store', r.headers.get('cache-control') === 'no-store');
} finally {
  await server.stop();
}

const oversizedBasicPass = `${'p'.repeat(2048)}`;
server = await startServer({
  DASHBOARD_USER: 'basic-user',
  DASHBOARD_PASS: oversizedBasicPass,
  DASHBOARD_BASIC_AUTH_MAX_BYTES: '1024',
});
try {
  const oversizedConfiguredBasicHeader = `Basic ${Buffer.from(`basic-user:${oversizedBasicPass}`).toString('base64')}`;
  const r = await fetch(`${server.base}/`, {
    headers: { Authorization: oversizedConfiguredBasicHeader },
  });
  const bodyText = await r.text();
  check('oversized configured basic auth fails closed', r.status === 401, `got ${r.status}`);
  check('oversized configured basic auth redacts secret', !bodyText.includes('pppppppppppppppp'));
} finally {
  await server.stop();
}

server = await startServer({ DASHBOARD_AUTH_MODE: 'enterprise' });
try {
  let r = await fetch(`${server.base}/api/auth/session`);
  let body = await json(r);
  check('enterprise without configured tokens -> 503', r.status === 503, `got ${r.status}`);
  check('misconfigured body reports configured=false', body?.configured === false);

  r = await fetch(`${server.base}/sessions-manifest.json`);
  body = await json(r);
  check('misconfigured protected route -> 503', r.status === 503, `got ${r.status}`);
  check('misconfigured route reports configured=false', body?.configured === false);
} finally {
  await server.stop();
}

server = await startServer({ DASHBOARD_ENABLE_HSTS: 'true' });
try {
  const r = await fetch(`${server.base}/api/auth/session`);
  check(
    'hsts opt-in sets strict transport security',
    r.headers.get('strict-transport-security')?.includes('max-age=15552000')
  );
} finally {
  await server.stop();
}

server = await startServer({
  DASHBOARD_AUTH_MODE: 'enterprise',
  DASHBOARD_AUTH_TOKENS: tokenConfig,
  DASHBOARD_ORG_ID: 'acme',
  DASHBOARD_ORG_NAME: 'Acme',
  HOST: '0.0.0.0',
});
try {
  const r = await fetch(`${server.base}/api/enterprise/organization`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await json(r);
  const transportControl = body?.securityPosture?.controls?.find?.(
    (control) => control.id === 'transport-security'
  );
  check('enterprise broad bind transport posture -> 200', r.status === 200, `got ${r.status}`);
  check(
    'enterprise broad bind without HSTS is action-required',
    transportControl?.state === 'action-required' &&
      transportControl?.summary?.includes('0.0.0.0')
  );
} finally {
  await server.stop();
}

if (failures > 0) process.exit(1);
