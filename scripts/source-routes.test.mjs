#!/usr/bin/env node
// Source/harness route contract (#1281). Boots the real server against a
// throwaway CLAUDE_DIR and proves the generic source aliases are default-source
// aliases for the existing raw routes.

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
const claudeDir = await mkdtemp(join(tmpdir(), 'source-routes-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'source-routes-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'source-routes-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects', 'demo', 'session-1', 'subagents'), {
  recursive: true,
});
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(
  join(claudeDir, 'history.jsonl'),
  JSON.stringify({
    display: 'history-only',
    pastedContents: {},
    timestamp: 1700000000000,
    project: '/tmp/history',
    sessionId: 'history-only',
  }) + '\n'
);
await writeFile(
  join(claudeDir, 'projects', 'demo', 'session-1.jsonl'),
  JSON.stringify({
    type: 'user',
    timestamp: '2024-01-01T00:00:00.000Z',
    cwd: '/tmp/demo',
    message: { role: 'user', content: 'top source turn' },
  }) + '\n'
);
await writeFile(
  join(claudeDir, 'projects', 'demo', 'session-1', 'subagents', 'agent-a.jsonl'),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2024-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: 'sub source turn' },
  }) + '\n'
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
  await check(
    'server came up',
    () => assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    const datasetResponse = await fetch(`${base}/api/dataset.json`);
    const dataset = await datasetResponse.json();
    await check('dataset exposes active source id', () => {
      assert.equal(dataset.sourceId, 'claude-code');
      assert.equal(dataset.harness, 'claude-code');
    });
    await check('dataset exposes source descriptors', () => {
      assert.deepEqual(dataset.sources, [
        {
          id: 'claude-code',
          harness: 'claude-code',
          historyDir: join(claudeDir, 'projects'),
          configFile: join(dirname(claudeDir), '.claude.json'),
        },
      ]);
    });
    await check('dataset entries carry source provenance', () => {
      assert.equal(
        dataset.entries.every(
          (entry) => entry.sourceId === 'claude-code' && entry.harness === 'claude-code'
        ),
        true
      );
    });

    const legacyHistory = await fetch(`${base}/history.jsonl`);
    const sourceHistory = await fetch(`${base}/api/sources/claude-code/history.jsonl`);
    await check('source history alias returns the legacy history bytes', async () => {
      assert.equal(sourceHistory.status, 200);
      assert.equal(await sourceHistory.text(), await legacyHistory.text());
    });

    const legacySession = await fetch(`${base}/projects/demo/session-1.jsonl`);
    const sourceSession = await fetch(
      `${base}/api/sources/claude-code/sessions/demo/session-1.jsonl`
    );
    await check('source session alias returns the merged legacy session bytes', async () => {
      const body = await sourceSession.text();
      assert.equal(sourceSession.status, 200);
      assert.equal(body, await legacySession.text());
      assert.match(body, /top source turn/);
      assert.match(body, /sub source turn/);
    });

    const missing = await fetch(`${base}/api/sources/nope/history.jsonl`);
    await check('unknown source id is not served', () => assert.equal(missing.status, 404));
  }
} finally {
  proc.kill('SIGTERM');
  await new Promise((resolve) => proc.once('exit', resolve));
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) {
  process.exit(1);
}

console.log('\nSource route alias checks passed.');
