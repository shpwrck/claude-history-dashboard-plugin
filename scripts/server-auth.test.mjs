// Normal (single-user) server authentication safety suite (#3823, epic #3743).
//
// Boots the real server against throwaway dirs and proves the auth behaviour
// that outlives the enterprise product:
// - default loopback mode stays open and reports a neutral single-user session
// - configured HTTP Basic auth protects data routes and the static shell, and
//   rejects missing, wrong, malformed, and oversized credentials
// - /api/auth/session returns the neutral capability response in local and
//   Basic-auth setups
// - baseline security headers, malformed-path rejection, static symlink
//   containment, and opt-in HSTS
//
// Beyond-loopback fail-closed binding lives in server-hardening, and the
// CSRF/same-origin write matrix lives in policy-write; this suite does not copy
// them.

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

// Drop every dashboard/auth knob the caller's shell might carry so each boot
// sees only the configuration this suite sets.
function scrubbedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('DASHBOARD_') ||
      key.startsWith('ENTERPRISE_') ||
      key.startsWith('CLAUDE_HUB') ||
      key === 'POLICY_WRITE_TOKEN' ||
      key === 'ANTHROPIC_API_KEY'
    ) {
      delete env[key];
    }
  }
  return env;
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'server-auth-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'server-auth-dist-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'server-auth-cache-'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><div>ok</div>');

  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env: {
      ...scrubbedEnv(),
      PORT: String(port),
      HOST: '127.0.0.1',
      CLAUDE_DIR: claudeDir,
      DIST_DIR: distDir,
      CHD_CACHE_DIR: cacheDir,
      ...extraEnv,
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/healthz`);
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
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill();
        await exited;
      }
      await rm(claudeDir, { recursive: true, force: true });
      await rm(distDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

async function json(res) {
  return res.json().catch(() => null);
}

function variesByAuthorization(res) {
  return String(res.headers.get('vary') || '').toLowerCase().includes('authorization');
}

function checkSecurityHeaders(prefix, res) {
  check(
    `${prefix} sends content security policy`,
    res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")
  );
  check(`${prefix} denies framing`, res.headers.get('x-frame-options') === 'DENY');
  check(`${prefix} disables content sniffing`, res.headers.get('x-content-type-options') === 'nosniff');
  check(`${prefix} uses no-referrer policy`, res.headers.get('referrer-policy') === 'no-referrer');
  check(
    `${prefix} disables browser permissions`,
    res.headers.get('permissions-policy')?.includes('camera=()')
  );
}

function checkNeutralSession(prefix, body) {
  check(`${prefix} reports no bearer auth requirement`, body?.authRequired === false);
  check(`${prefix} reports a capabilities object`, body?.capabilities && typeof body.capabilities === 'object');
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

// ── Local loopback mode ────────────────────────────────────────────────────
let server = await startServer();
try {
  let r = await fetch(`${server.base}/api/auth/session`);
  let body = await json(r);
  check('local auth session -> 200', r.status === 200, `got ${r.status}`);
  check('local auth session is no-store', r.headers.get('cache-control') === 'no-store');
  checkSecurityHeaders('local auth session', r);
  check('hsts is opt-in by default', !r.headers.has('strict-transport-security'));
  checkNeutralSession('local auth session', body);

  r = await fetch(`${server.base}/`);
  check('local static shell -> 200', r.status === 200, `got ${r.status}`);
  checkSecurityHeaders('local static shell', r);

  const secret = join(server.claudeDir, 'static-secret.txt');
  await writeFile(secret, 'static symlink secret marker\n');
  await symlink(secret, join(server.distDir, 'linked-secret.txt'));
  r = await fetch(`${server.base}/linked-secret.txt`);
  const symlinkBody = await r.text();
  check('local static symlink escape -> 403', r.status === 403, `got ${r.status}`);
  check('local static symlink escape does not serve target', !symlinkBody.includes('static symlink secret'));

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

// ── HTTP Basic auth ────────────────────────────────────────────────────────
server = await startServer({ DASHBOARD_USER: 'basic-user', DASHBOARD_PASS: 'basic-pass' });
try {
  const good = basic('basic-user', 'basic-pass');

  let r = await fetch(`${server.base}/sessions-manifest.json`);
  check('basic auth protects manifest without credentials', r.status === 401, `got ${r.status}`);
  check('basic auth manifest rejection varies by authorization', variesByAuthorization(r));
  check('basic auth manifest rejection is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/sessions-manifest.json`, {
    headers: { Authorization: basic('basic-user', 'wrong-pass') },
  });
  check('basic auth rejects a wrong password', r.status === 401, `got ${r.status}`);

  for (const [label, header] of [
    ['non-base64 credentials', 'Basic !!!not-base64!!!'],
    ['credentials without a colon', `Basic ${Buffer.from('basic-user').toString('base64')}`],
    ['an empty Basic value', 'Basic '],
    ['a non-Basic scheme', 'Bearer basic-pass'],
  ]) {
    r = await fetch(`${server.base}/sessions-manifest.json`, { headers: { Authorization: header } });
    check(`basic auth rejects ${label}`, r.status === 401, `got ${r.status}`);
  }

  r = await fetch(`${server.base}/sessions-manifest.json`, { headers: { Authorization: good } });
  check('basic auth manifest success -> 200', r.status === 200, `got ${r.status}`);
  check('basic auth manifest success varies by authorization', variesByAuthorization(r));
  check('basic auth manifest success is no-store', r.headers.get('cache-control') === 'no-store');

  r = await fetch(`${server.base}/`);
  check('basic auth protects the static shell', r.status === 401, `got ${r.status}`);
  check('basic auth static shell rejection is no-store', r.headers.get('cache-control') === 'no-store');
  r = await fetch(`${server.base}/`, { headers: { Authorization: good } });
  check('basic auth unlocks the static shell', r.status === 200, `got ${r.status}`);
  check('basic auth static shell success varies by authorization', variesByAuthorization(r));

  r = await fetch(`${server.base}/`, {
    headers: { Authorization: basic('u'.repeat(2048), 'basic-pass') },
  });
  check('basic auth rejects an oversized submitted username', r.status === 401, `got ${r.status}`);

  r = await fetch(`${server.base}/api/auth/session`, { headers: { Authorization: good } });
  const body = await json(r);
  check('basic auth session -> 200', r.status === 200, `got ${r.status}`);
  check('basic auth session is no-store', r.headers.get('cache-control') === 'no-store');
  checkNeutralSession('basic auth session', body);
} finally {
  await server.stop();
}

// A configured Basic secret over the byte cap fails closed instead of matching.
const oversizedPass = 'p'.repeat(2048);
server = await startServer({
  DASHBOARD_USER: 'basic-user',
  DASHBOARD_PASS: oversizedPass,
  DASHBOARD_BASIC_AUTH_MAX_BYTES: '1024',
});
try {
  const r = await fetch(`${server.base}/`, { headers: { Authorization: basic('basic-user', oversizedPass) } });
  const text = await r.text();
  check('oversized configured basic auth fails closed', r.status === 401, `got ${r.status}`);
  check('oversized configured basic auth redacts secret', !text.includes('pppppppppppppppp'));
} finally {
  await server.stop();
}

// ── Opt-in HSTS ────────────────────────────────────────────────────────────
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

if (failures > 0) process.exit(1);
