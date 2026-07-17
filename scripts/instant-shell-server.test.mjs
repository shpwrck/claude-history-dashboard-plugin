#!/usr/bin/env node
// Instant-shell server-runtime contract (#2444). Exercises the serveStatic
// index.html upgrade end-to-end through the real server:
//   A. auth OFF (single-user/local): after a boot build warms `lastInstantShell`,
//      GET / serves REAL KPIs (ready:true, no skeleton em-dash).
//   B. auth ON (enterprise): even after an ADMIN boot build populates the global
//      shell, the unauthenticated GET / MUST serve the SKELETON — `/` is pre-auth
//      and scoped principals are walled off from global data, so the pre-auth HTML
//      must never carry the global host counts. This guards the security-relevant
//      gate (`ENTERPRISE_AUTH_ON ? null : lastInstantShell`) against regressing to
//      the opt-in scope-enforcement flag.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectShellIntoTemplate } from '../src/lib/instant-shell.ts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

// The built server-flavor index.html: a skeleton shell + __BOOT__ injected.
const BARE =
  '<!doctype html><html><head><title>t</title></head><body>\n' +
  '    <div id="root"></div>\n' +
  '    <script type="module" src="/assets/index.js"></script>\n' +
  '  </body></html>';
const INJECTED = injectShellIntoTemplate(BARE);
assert.ok(INJECTED && INJECTED.includes('data-instant-shell'), 'fixture injection failed');
assert.ok(INJECTED.includes('&mdash;'), 'fixture should start as a skeleton');

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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitUp(base, proc) {
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) return false;
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function startServer(extraEnv) {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'instant-shell-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'instant-shell-dist-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'instant-shell-cache-'));
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), INJECTED);
  await writeFile(join(distDir, 'assets', 'index.js'), 'export const ok = true;\n');
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DIST_DIR: distDir,
      CLAUDE_DIR: claudeDir,
      DASHBOARD_CACHE_DIR: cacheDir,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const up = await waitUp(base, proc);
  assert.ok(up, 'server did not come up');
  return {
    base,
    stop: () => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
  };
}

// A — auth off: the upgrade fires after a boot warms lastInstantShell.
await check('auth off: GET / serves real KPIs after a boot build', async () => {
  const srv = await startServer({});
  try {
    const boot = await fetch(`${srv.base}/api/dataset/boot`);
    assert.equal(boot.status, 200, 'boot build should succeed');
    // The boot fetch populated lastInstantShell (global state). GET / upgrades.
    const html = await (await fetch(`${srv.base}/`)).text();
    assert.ok(html.includes('data-instant-shell'), 'shell wrapper present');
    assert.ok(!html.includes('&mdash;'), 'skeleton em-dash should be gone (upgraded)');
    assert.match(html, /"ready":true/, '__BOOT__ envelope marked ready');
  } finally {
    srv.stop();
  }
});

// B — auth on: the pre-auth GET / stays a skeleton even though an admin boot
// build populated the GLOBAL shell.
await check('auth on: pre-auth GET / stays skeleton despite a warm global shell', async () => {
  const token = 'test-admin-token-0123456789abcdef';
  const srv = await startServer({ DASHBOARD_ADMIN_TOKEN: token });
  try {
    // Admin-authenticated boot build → populates the global lastInstantShell.
    const boot = await fetch(`${srv.base}/api/dataset/boot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(boot.status, 200, 'admin boot build should succeed (warms the global shell)');
    // Unauthenticated landing request: MUST be the skeleton, never global counts.
    const res = await fetch(`${srv.base}/`);
    const html = await res.text();
    assert.ok(html.includes('data-instant-shell'), 'shell wrapper present');
    assert.ok(html.includes('&mdash;'), 'pre-auth shell must stay skeleton under enterprise auth');
    assert.match(html, /"ready":false/, '__BOOT__ envelope must remain the skeleton');
  } finally {
    srv.stop();
  }
});

if (failures > 0) {
  console.error(`\n${failures} instant-shell server check(s) failed.`);
  process.exit(1);
}
console.log('\nInstant-shell server checks passed.');
