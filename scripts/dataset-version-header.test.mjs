#!/usr/bin/env node
// Snapshot-version response contract (#3675). Boots one real server and proves
// the boot payload and one heavy slice identify the same dataset snapshot.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUp(base, proc) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode !== null) return false;
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) return true;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('boot and slice responses identify one dataset snapshot', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'dataset-version-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'dataset-version-dist-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'dataset-version-cache-'));
  const base = `http://127.0.0.1:${port}`;

  await mkdir(join(distDir, 'assets'), { recursive: true });
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
      CHD_CACHE_DIR: cacheDir,
      CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
      ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
      ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
      ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
      DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
      CHD_DOC_ISSUES: '',
      CHD_DOC_ISSUES_TOKEN: '',
      CHD_DOC_ISSUES_TOKEN_FILE: '',
      CHD_DOCS_MAP_REPOSITORY: '',
      CHD_DOC_GRAPH_ROOT: '',
      CHD_EXPERIMENT_2702_STATE_ROOT: '',
      CHD_EXTERNAL_GUIDANCE_DIR: '',
      CHD_GIT_OUTCOMES: '',
      CHD_INGEST_CODEX: '',
      CHD_RECS_WORKER: '',
      CHD_SEMANTIC_INTENT: '',
      DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
      DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
      DASHBOARD_ADMIN_TOKEN: '',
      DASHBOARD_ADMIN_TOKEN_SHA256: '',
      DASHBOARD_AUTH_TOKENS: '',
      DASHBOARD_AUTH_TOKENS_FILE: '',
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
    assert.equal(
      await waitUp(base, proc),
      true,
      [stdout, stderr].filter(Boolean).join('\n').slice(-2_000)
    );

    const bootResponse = await fetch(`${base}/api/dataset/boot`);
    assert.equal(bootResponse.status, 200);
    const boot = await bootResponse.json();
    assert.equal(typeof boot.version, 'string');
    assert.notEqual(boot.version, '');
    assert.equal(bootResponse.headers.get('x-dataset-version'), boot.version);

    const sliceResponse = await fetch(`${base}/api/dataset/slice/entries`);
    assert.equal(sliceResponse.status, 200);
    assert.equal(sliceResponse.headers.get('x-dataset-version'), boot.version);
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    await rm(claudeDir, { recursive: true, force: true });
    await rm(distDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});
