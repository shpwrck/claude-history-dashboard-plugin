#!/usr/bin/env node
// Daily digest route contract (#1292). Boots the real server against a
// throwaway CLAUDE_DIR and proves /api/digest composes parsed sessions and tools
// into a deterministic day digest.

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
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
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
const claudeDir = await mkdtemp(join(tmpdir(), 'daily-digest-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'daily-digest-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'daily-digest-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects', 'demo'), { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(claudeDir, 'projects', 'demo', 'digest-session.jsonl'),
  [
    JSON.stringify({
      type: 'custom-title',
      sessionId: 'digest-session',
      customTitle: 'Implement the daily digest route',
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2024-01-01T14:00:00.000Z',
      cwd: '/tmp/demo',
      message: { role: 'user', content: 'Implement the daily digest route' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T14:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_digest',
            name: 'Write',
            input: { file_path: 'src/lib/build-daily-digest.ts' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2024-01-01T14:00:02.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_digest',
            is_error: false,
            content: 'ok',
          },
        ],
      },
    }),
  ].join('\n') + '\n'
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
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    const digestResponse = await fetch(`${base}/api/digest?date=2024-01-01`);
    const digest = await digestResponse.json();
    await check('dated digest returns grouped session data', () => {
      assert.equal(digestResponse.status, 200);
      assert.equal(digest.date, '2024-01-01');
      assert.equal(digest.total.sessionCount, 1);
      assert.equal(digest.total.messageCount, 1);
      assert.equal(digest.total.toolCallCount, 1);
      assert.equal(digest.total.categories[0].category, 'implementation');
      assert.equal(digest.projects[0].project, '/tmp/demo');
      assert.equal(
        digest.projects[0].categories[0].sessions[0].fileImpact[0],
        'src/lib/build-daily-digest.ts'
      );
    });

    const emptyResponse = await fetch(`${base}/api/digest?date=2024-01-02`);
    const empty = await emptyResponse.json();
    await check('empty day returns an empty digest', () => {
      assert.equal(emptyResponse.status, 200);
      assert.equal(empty.total.sessionCount, 0);
      assert.deepEqual(empty.projects, []);
    });

    const defaultResponse = await fetch(`${base}/api/digest`);
    const defaultDigest = await defaultResponse.json();
    await check('missing date defaults to a server-local YYYY-MM-DD', () => {
      assert.equal(defaultResponse.status, 200);
      assert.match(defaultDigest.date, /^\d{4}-\d{2}-\d{2}$/);
    });

    const badDate = await fetch(`${base}/api/digest?date=2024-02-31`);
    const badBody = await badDate.json();
    await check('invalid date returns 400 with a clear message', () => {
      assert.equal(badDate.status, 400);
      assert.match(badBody.error, /YYYY-MM-DD/);
    });
  }
} finally {
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);

console.log('\nDaily digest route checks passed.');
