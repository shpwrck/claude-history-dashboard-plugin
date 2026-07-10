#!/usr/bin/env node
// Shadow-experiments route contract (#2152, epic #2147). Boots the real server
// against a throwaway CLAUDE_DIR and proves GET /api/shadow-experiments.json:
//   - serves the flat per-experiment row log straight from the ledger with the
//     #2149 dispositions (counted / synthetic / skipped) on every row,
//   - paginates newest-first with limit/offset,
//   - STALENESS: a record appended after the first fetch is visible on the very
//     next fetch (fresh read per request — no cache to go stale),
//   - fails open on a missing ledger (zero state, not an error), and
//   - rejects non-GET with 405.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const LEDGER_LINES = [
  // counted, live, explicit model-eval source stamp
  JSON.stringify({
    ts: '2024-01-01T10:00:00.000Z',
    mode: 'live',
    axis: 'model',
    source: 'model-eval',
    judge: { winner: 'shadow' },
    main: { tokens: 1000, costUsd: 0.4 },
    shadow: { tokens: 800, costUsd: 0.1 },
  }),
  // counted, replay, unstamped -> source 'replay'
  JSON.stringify({
    ts: '2024-01-02T10:00:00.000Z',
    mode: 'replay',
    axis: 'skills',
    judge: { winner: 'main' },
  }),
  // synthetic seed row — surfaced, never hidden
  JSON.stringify({ mode: 'live', axis: 'model', synthetic: true, judge: { winner: 'shadow' } }),
  // replay-skip row — skipped with reason
  JSON.stringify({ ts: '2024-01-03T10:00:00.000Z', mode: 'replay-skip', axis: 'model' }),
];

async function bootServer({ withLedger }) {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'shadow-exp-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'shadow-exp-dist-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'shadow-exp-cache-'));
  const base = `http://127.0.0.1:${port}`;

  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  await writeFile(join(claudeDir, 'history.jsonl'), '');

  const ledgerPath = join(cacheDir, 'ledger.jsonl');
  if (withLedger) {
    await writeFile(ledgerPath, LEDGER_LINES.join('\n') + '\n');
  }

  const env = {
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
    ANTHROPIC_API_KEY: '',
    POLICY_WRITE_TOKEN: '',
    CLAUDE_SHADOW_CALLS_LEDGER: withLedger
      ? ledgerPath
      : join(cacheDir, 'does-not-exist.jsonl'),
  };

  let stdout = '';
  let stderr = '';
  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => (stdout += String(c)));
  proc.stderr.on('data', (c) => (stderr += String(c)));

  const cleanup = async () => {
    // A server that died before waitUp succeeded has already emitted 'exit' —
    // waiting on the listener then would hang the CI step instead of failing
    // with the captured logs.
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    await rm(claudeDir, { recursive: true, force: true });
    await rm(distDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  };
  return {
    base,
    proc,
    ledgerPath,
    getLogs: () => [stdout, stderr].filter(Boolean).join('\n').slice(-2000),
    cleanup,
  };
}

// 1) Populated ledger: rows, dispositions, pagination, staleness.
{
  const srv = await bootServer({ withLedger: true });
  try {
    const up = await waitUp(srv.base, srv.proc);
    await check('server came up (with ledger)', () => assert.equal(up, true, srv.getLogs()));
    if (up) {
      const res = await fetch(`${srv.base}/api/shadow-experiments.json`);
      const body = await res.json();
      await check('returns 200 with reconciling disposition counts', () => {
        assert.equal(res.status, 200);
        assert.equal(body.total, 4);
        assert.equal(body.counted, 2);
        assert.equal(body.synthetic, 1);
        assert.equal(body.skipped, 1);
        assert.equal(body.counted + body.synthetic + body.skipped, body.total);
        assert.equal(body.ledgerTruncated, false);
        assert.equal(body.rowsDropped, 0);
        assert.equal(body.returned, 4);
      });
      await check('rows are newest-first with per-row disposition + source', () => {
        assert.equal(body.rows[0].skipReason, 'bad-mode'); // the replay-skip line
        assert.equal(body.rows[0].disposition, 'skipped');
        assert.equal(body.rows[1].disposition, 'synthetic');
        const evalRow = body.rows.find((r) => r.source === 'model-eval');
        assert.ok(evalRow);
        assert.equal(evalRow.winner, 'shadow');
        assert.ok(Math.abs(evalRow.costDelta + 0.3) < 1e-9); // 0.1 − 0.4 (float-safe)
        assert.equal(evalRow.ts, '2024-01-01T10:00:00.000Z');
      });

      const page = await fetch(`${srv.base}/api/shadow-experiments.json?limit=2&offset=1`);
      const pageBody = await page.json();
      await check('limit/offset paginate the newest-first order', () => {
        assert.equal(pageBody.returned, 2);
        assert.equal(pageBody.rows[0].disposition, 'synthetic'); // 2nd-newest
        assert.equal(pageBody.total, 4);
      });

      // STALENESS (#2152 acceptance): append a record, the NEXT fetch shows it.
      await appendFile(
        srv.ledgerPath,
        JSON.stringify({
          ts: '2024-01-04T10:00:00.000Z',
          mode: 'live',
          axis: 'prompt',
          judge: { winner: 'tie' },
        }) + '\n'
      );
      const after = await fetch(`${srv.base}/api/shadow-experiments.json`);
      const afterBody = await after.json();
      await check('a record appended between fetches is visible on the next fetch', () => {
        assert.equal(afterBody.total, 5);
        assert.equal(afterBody.counted, 3);
        assert.equal(afterBody.rows[0].axis, 'prompt'); // newest-first
        assert.equal(afterBody.rows[0].winner, 'tie');
      });
    }
  } finally {
    await srv.cleanup();
  }
}

// 2) Missing ledger: fail open with a zero state; non-GET rejected.
{
  const srv = await bootServer({ withLedger: false });
  try {
    const up = await waitUp(srv.base, srv.proc);
    await check('server came up (no ledger)', () => assert.equal(up, true, srv.getLogs()));
    if (up) {
      const res = await fetch(`${srv.base}/api/shadow-experiments.json`);
      const body = await res.json();
      await check('missing ledger fails open with a zero state', () => {
        assert.equal(res.status, 200);
        assert.equal(body.total, 0);
        assert.deepEqual(body.rows, []);
        assert.equal(body.ledgerTruncated, false);
      });
      const post = await fetch(`${srv.base}/api/shadow-experiments.json`, { method: 'POST' });
      await check('non-GET returns 405', () => assert.equal(post.status, 405));
    }
  } finally {
    await srv.cleanup();
  }
}

if (failures > 0) process.exit(1);
console.log('\nShadow-experiments route checks passed.');
