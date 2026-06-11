#!/usr/bin/env node
// Guard the production server boot graph against npm package imports.
//
// The runtime Docker image intentionally ships no node_modules. This boots the
// real server with DASHBOARD_RUNTIME_IMPORT_GUARD=1, which makes ts-resolver.mjs
// reject bare package imports from runtime scripts and src/lib/**. A future
// web-tree-sitter-style leak fails before release.

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

async function expectScriptRuntimeImportsBlocked() {
  const probeName = `.runtime-import-guard-probe-${process.pid}.mjs`;
  const probePath = join(SCRIPTS_DIR, probeName);
  await writeFile(probePath, "import 'web-tree-sitter';\n");
  try {
    const result = await new Promise((resolve) => {
      let probeStdout = '';
      let probeStderr = '';
      const probe = spawn('node', ['--import', REGISTER, `scripts/${probeName}`], {
        cwd: PROJECT_DIR,
        env: {
          ...process.env,
          DASHBOARD_RUNTIME_IMPORT_GUARD: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      probe.stdout.on('data', (chunk) => {
        probeStdout += String(chunk);
      });
      probe.stderr.on('data', (chunk) => {
        probeStderr += String(chunk);
      });
      probe.on('close', (code) => {
        resolve({ code, output: `${probeStdout}\n${probeStderr}`.trim() });
      });
    });

    check(
      'runtime script package imports are blocked',
      result.code !== 0 &&
        /Server runtime import guard blocked bare package "web-tree-sitter"/.test(result.output),
      result.output.slice(-2000)
    );
  } finally {
    await rm(probePath, { force: true });
  }
}

await expectScriptRuntimeImportsBlocked();

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'runtime-import-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'runtime-import-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'runtime-import-cache-'));
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
    DASHBOARD_RUNTIME_IMPORT_GUARD: '1',
    DASHBOARD_AUTH_MODE: '',
    DASHBOARD_AUTH_TOKENS: '',
    DASHBOARD_ADMIN_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

proc.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});
proc.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/api/auth/session`);
      if (response.status === 200) return true;
    } catch {
      /* server not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

try {
  const up = await waitUp();
  check(
    'server boots with runtime import guard',
    up,
    [stdout, stderr].filter(Boolean).join('\n').slice(-2000)
  );

  if (up) {
    const response = await fetch(`${base}/api/auth/session`);
    const body = await response.json().catch(() => null);
    check('auth session route responds', response.status === 200, `got ${response.status}`);
    check('local mode remains unauthenticated', body?.authRequired === false);
  }
} finally {
  proc.kill();
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (/Server runtime import guard blocked bare package/.test(stderr)) {
  console.error(stderr);
  failures += 1;
}

if (failures > 0) process.exit(1);
