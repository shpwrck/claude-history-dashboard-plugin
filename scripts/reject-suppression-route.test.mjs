#!/usr/bin/env node
// Reject-suppression endpoint contract (#2332, epic #1298). Boots the real server
// and proves the server glue #2206 added to POST /api/recommendations/reject —
// the part unit tests cannot reach:
//
//   1. The reject is MIRRORED into a REJECTED adoption receipt. This is the exact
//      regression Codex caught on #2331: the handler used to append ONLY to the
//      reject-signals log, but suppression reads the adoption-receipt log — so the
//      feature was a silent no-op end-to-end. If the mirror is ever dropped again,
//      assertion (3) fails.
//   2. The reject BUSTS the recs response cache, so suppression takes effect on the
//      next request instead of lagging until the source churns (the cache freshness
//      gate is keyed only by sourceSignature/contentHash, not the receipt log).
//   3. When the fixture actually emits a finding, rejecting it removes it from the
//      /api/recommendations.json body (full end-to-end suppression).
//
// The pure suppression filter (suppressRejectedRecommendations) and the reversible
// active-flag read (readRejectedFindingIds: reject/un-reject/re-reject) are unit-
// tested in recommendations.test.ts / adoption-receipts.test.ts. A full HTTP
// un-reject leg is intentionally out of scope: #1294/#2206 shipped no un-reject
// endpoint (the affordance is one-directional), so reversibility is proven at the
// unit level until such an endpoint exists.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';
const WRITE_TOKEN = 'test-reject-suppression-token';

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

// Connection: close so each request uses a fresh socket (avoids keep-alive races).
async function getRecs(base) {
  const res = await fetch(`${base}/api/recommendations.json`, {
    headers: { connection: 'close' },
  });
  return {
    status: res.status,
    cache: res.headers.get('x-recommendations-cache'),
    body: await res.text(),
  };
}

async function postReject(base, port, findingId, reason) {
  const res = await fetch(`${base}/api/recommendations/reject`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // http://127.0.0.1:<port> is always in DASHBOARD_WRITE_ORIGINS (built-in).
      origin: `http://127.0.0.1:${port}`,
      'x-csrf-token': WRITE_TOKEN,
      connection: 'close',
    },
    body: JSON.stringify({ findingId, reason }),
  });
  return { status: res.status, body: await res.text() };
}

async function readReceipts(path) {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sessionJsonl(id, prompt, ts) {
  return (
    [
      JSON.stringify({ type: 'custom-title', sessionId: id, customTitle: prompt }),
      JSON.stringify({
        type: 'user',
        timestamp: ts,
        cwd: '/tmp/demo',
        message: { role: 'user', content: prompt },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `toolu_${id}`, name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      }),
    ].join('\n') + '\n'
  );
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'reject-route-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'reject-route-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'reject-route-cache-'));
const base = `http://127.0.0.1:${port}`;
const projectDir = join(claudeDir, 'projects', 'demo');
const receiptsPath = join(cacheDir, 'adoption-receipts.jsonl');

await mkdir(projectDir, { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(projectDir, 'one.jsonl'),
  sessionJsonl('one', 'do the first thing', '2024-01-01T14:00:00.000Z')
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
    ADOPTION_RECEIPTS_PATH: receiptsPath,
    REJECT_SIGNALS_PATH: join(cacheDir, 'reject-signals.jsonl'),
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    ANTHROPIC_API_KEY: '',
    // Configure write auth so the reject POST can authenticate deterministically.
    POLICY_WRITE_TOKEN: WRITE_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (c) => { stdout += String(c); });
proc.stderr.on('data', (c) => { stderr += String(c); });

try {
  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    // Reject requires same-origin + application/json + a matching CSRF token. A
    // same-origin request that omits the token is unauthorized (401) — proving the
    // write gate is actually enforced on this route (a cross-origin POST with no
    // Origin is rejected even earlier, 403).
    const noOrigin = await fetch(`${base}/api/recommendations/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ findingId: 'x.y', reason: 'wrong' }),
    });
    await check('reject rejects a cross-origin POST (no Origin) with 403', () =>
      assert.equal(noOrigin.status, 403)
    );
    const noToken = await fetch(`${base}/api/recommendations/reject`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        connection: 'close',
      },
      body: JSON.stringify({ findingId: 'x.y', reason: 'wrong' }),
    });
    await check('reject rejects a same-origin POST with no CSRF token (401)', () =>
      assert.equal(noToken.status, 401)
    );

    // Warm the recs cache: cold miss, then a signature hit.
    const cold = await getRecs(base);
    await check('cold recs request builds and returns 200', () => {
      assert.equal(cold.status, 200);
      assert.equal(cold.cache, 'miss');
    });
    const hit = await getRecs(base);
    await check('unchanged source serves a signature hit', () =>
      assert.equal(hit.cache, 'hit')
    );

    // Target a real emitted finding if the fixture produced one; otherwise a
    // synthetic id (the mirror + cache-bust are id-agnostic).
    let realFinding = null;
    try {
      const arr = JSON.parse(cold.body);
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0].id === 'string') {
        realFinding = arr[0].id;
      }
    } catch {
      /* body not an array */
    }
    const findingId = realFinding || 'cost.reject-route-integration';

    const rej = await postReject(base, port, findingId, 'wrong');
    await check('authenticated reject returns 200', () =>
      assert.equal(rej.status, 200, rej.body)
    );

    // (1) The reject is mirrored into a REJECTED adoption receipt — the #2206 fix.
    await check('reject mirrors a REJECTED adoption receipt', async () => {
      const receipts = await readReceipts(receiptsPath);
      const rec = receipts.find((r) => r.kind === 'REJECTED' && r.findingId === findingId);
      assert.ok(rec, `no REJECTED receipt for ${findingId} in ${receiptsPath}`);
      assert.equal(rec.reason, 'wrong');
      assert.equal(rec.active, true);
    });

    // (2) The reject busts the recs cache, so the next request rebuilds.
    const afterReject = await getRecs(base);
    await check('reject busts the recs cache (next request is a fresh build)', () =>
      assert.equal(afterReject.cache, 'miss')
    );

    // (3) End-to-end suppression when the fixture emitted a real finding.
    if (realFinding) {
      await check('the rejected finding is suppressed from the recs output', () => {
        const ids = JSON.parse(afterReject.body).map((r) => r.id);
        assert.ok(
          !ids.includes(realFinding),
          `${realFinding} should be suppressed but is still present`
        );
      });
    } else {
      console.log('  --  (fixture emitted no findings; end-to-end suppression is unit-covered)');
    }
  }
} finally {
  proc.kill('SIGTERM');
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nReject-suppression route checks FAILED (${failures}).`);
  process.exit(1);
}
console.log('\nReject-suppression route checks passed.');
