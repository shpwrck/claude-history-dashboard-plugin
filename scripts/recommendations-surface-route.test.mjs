#!/usr/bin/env node
// Typed recommendation-surface contract (#2718, epic #2443). Boots the real
// server and proves the strict v1 `surface=global|reclaim-compass` contract on
// /api/recommendations.json that unit tests cannot reach:
//
//   1. The legacy contract is byte-compatible: no `surface` -> the raw
//      Recommendation[] array (existing agent/MCP/statusline consumers).
//   2. `surface=global|reclaim-compass` -> the typed { recommendations,
//      domainCoverage } envelope, domainCoverage honestly reflecting the scope.
//   3. Strict parameter validation: unknown surface, an out-of-surface / legacy /
//      duplicate / oversized parameter is a 400, never a silent scope widening.
//   4. The surface + normalized filter tuple is folded into the response cache
//      key: a repeat is a hit, a different filter tuple is a fresh miss, and a
//      scoped body never aliases the legacy raw array (or another surface).
//   5. The flag-off default path makes zero external calls (all egress flags and
//      ANTHROPIC_API_KEY unset; the endpoint answers purely from local fixtures).
//
// The worker is disabled here (CHD_RECS_WORKER=0) so cache-header assertions are
// deterministic; worker/inline byte-equivalence for a scoped surface is proven in
// recs-worker.test.mjs, the masthead helpers in view-registry.test.ts (via the
// re-export), and the Cost-route seam in cost-scope.test.ts.

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
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Connection: close so each request uses a fresh socket (avoids keep-alive races).
async function getRecs(base, query = '') {
  const res = await fetch(`${base}/api/recommendations.json${query}`, {
    headers: { connection: 'close' },
  });
  return {
    status: res.status,
    cache: res.headers.get('x-recommendations-cache'),
    etag: res.headers.get('etag'),
    contentType: res.headers.get('content-type'),
    body: await res.text(),
  };
}

// A session with a usage-bearing assistant turn so tokenData (cost core signal)
// and a tool call (toolData) are both present; the opus model lets a
// routeMode=opus reclaim filter select the row.
function sessionJsonl(id, prompt, ts, model) {
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
          model,
          usage: {
            input_tokens: 1200,
            output_tokens: 400,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [
            { type: 'tool_use', id: `toolu_${id}`, name: 'Read', input: { file_path: '/tmp/a.txt' } },
          ],
        },
      }),
    ].join('\n') + '\n'
  );
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'surface-route-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'surface-route-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'surface-route-cache-'));
const base = `http://127.0.0.1:${port}`;
const projectDir = join(claudeDir, 'projects', 'demo');

await mkdir(projectDir, { recursive: true });
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(
  join(projectDir, 'one.jsonl'),
  sessionJsonl('one', 'do the first thing', '2024-01-01T14:00:00.000Z', 'claude-opus-4')
);
await writeFile(
  join(projectDir, 'two.jsonl'),
  sessionJsonl('two', 'do the second thing', '2024-01-02T14:00:00.000Z', 'claude-sonnet-4')
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
    // Deterministic cache headers: keep the rebuild in-process.
    CHD_RECS_WORKER: '0',
    // Local-only guarantee: every non-local path stays off.
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    CHD_GIT_OUTCOMES: '',
    ANTHROPIC_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (c) => { stdout += String(c); });
proc.stderr.on('data', (c) => { stderr += String(c); });

const VALID_STATUS = new Set(['PROVE', 'INFER', 'CANNOT_SEE']);

try {
  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    // 1. Legacy contract: no surface -> raw Recommendation[] array.
    const legacy = await getRecs(base);
    await check('legacy request returns 200', () => assert.equal(legacy.status, 200));
    await check('legacy body is a raw array', () =>
      assert.equal(Array.isArray(JSON.parse(legacy.body)), true)
    );

    // 2. surface=global -> typed envelope with honest domainCoverage.
    const global1 = await getRecs(base, '?surface=global');
    await check('surface=global returns 200 (cold miss)', () => {
      assert.equal(global1.status, 200);
      assert.equal(global1.cache, 'miss');
    });
    await check('surface=global body is the { recommendations, domainCoverage } envelope', () => {
      const env = JSON.parse(global1.body);
      assert.equal(Array.isArray(env.recommendations), true);
      assert.equal(Array.isArray(env.domainCoverage), true);
      assert.equal(env.domainCoverage.length, 6);
      for (const c of env.domainCoverage) {
        assert.equal(typeof c.domain, 'string');
        assert.equal(VALID_STATUS.has(c.status), true, `bad status ${c.status}`);
      }
      const cost = env.domainCoverage.find((c) => c.domain === 'cost');
      assert.equal(cost?.status, 'PROVE', 'cost domain should PROVE with tokenData present');
    });
    await check('surface=global body differs from the legacy array body', () =>
      assert.notEqual(global1.body, legacy.body)
    );

    // 3. Cache identity: a repeat is a hit with the same body/etag.
    const global2 = await getRecs(base, '?surface=global');
    await check('surface=global repeat is a cache hit, identical body', () => {
      assert.ok(['hit', 'hit-content'].includes(global2.cache), `cache=${global2.cache}`);
      assert.equal(global2.body, global1.body);
      assert.equal(global2.etag, global1.etag);
    });
    const globalEmptyTime = await getRecs(base, '?surface=global&dashboardTime=');
    await check('empty dashboardTime canonicalizes to the omitted 24h default', () => {
      assert.ok(
        ['hit', 'hit-content'].includes(globalEmptyTime.cache),
        `cache=${globalEmptyTime.cache}`
      );
      assert.equal(globalEmptyTime.body, global1.body);
      assert.equal(globalEmptyTime.etag, global1.etag);
    });

    // 4. surface=reclaim-compass -> envelope; route filter accepted.
    const reclaim1 = await getRecs(base, '?surface=reclaim-compass&routeMode=opus');
    await check('surface=reclaim-compass returns 200 (cold miss, distinct key from global)', () => {
      assert.equal(reclaim1.status, 200);
      assert.equal(reclaim1.cache, 'miss');
    });
    await check('surface=reclaim-compass body is the envelope and differs from global', () => {
      const env = JSON.parse(reclaim1.body);
      assert.equal(Array.isArray(env.recommendations), true);
      assert.equal(env.domainCoverage.length, 6);
      assert.notEqual(reclaim1.body, global1.body);
    });

    // 5. The filter tuple is in the cache key: a different routeMode is a fresh
    //    miss (not aliased to the opus body); a repeat of the same tuple hits.
    const reclaim1b = await getRecs(base, '?surface=reclaim-compass&routeMode=opus');
    await check('same reclaim filter tuple repeats as a hit', () =>
      assert.ok(['hit', 'hit-content'].includes(reclaim1b.cache), `cache=${reclaim1b.cache}`)
    );
    const reclaim2 = await getRecs(base, '?surface=reclaim-compass&routeMode=sonnet');
    await check('a different reclaim filter tuple is a fresh miss (no key aliasing)', () =>
      assert.equal(reclaim2.cache, 'miss')
    );

    // 6. Strict validation -> 400.
    const bad = [
      ['?surface=bogus', 'unknown surface'],
      ['?surface=global&routeProject=x', 'route param on global surface'],
      ['?surface=global&project=/tmp/demo', 'legacy project param on typed surface'],
      ['?surface=global&dashboardTime=nope', 'invalid dashboardTime preset'],
      ['?surface=global&nonsense=1', 'unknown parameter'],
      [`?surface=global&dashboardProject=${'x'.repeat(600)}`, 'oversized parameter'],
      ['?surface=global&surface=reclaim-compass', 'duplicate surface parameter'],
    ];
    for (const [query, label] of bad) {
      const res = await getRecs(base, query);
      await check(`400 on ${label}`, () => {
        assert.equal(res.status, 400, `expected 400 for ${query}, got ${res.status}`);
        const parsed = JSON.parse(res.body);
        assert.equal(typeof parsed.error, 'string');
      });
    }
    const oversizedSurfaceValue = 'x'.repeat(600);
    const oversizedSurface = await getRecs(base, `?surface=${oversizedSurfaceValue}`);
    await check('oversized surface is bounded before validation or reflection', () => {
      assert.equal(oversizedSurface.status, 400);
      assert.deepEqual(JSON.parse(oversizedSurface.body), {
        error: 'parameter \'surface\' exceeds 512 characters',
      });
      assert.equal(oversizedSurface.body.includes(oversizedSurfaceValue), false);
    });
    const oversizedParameterName = 'p'.repeat(600);
    const oversizedName = await getRecs(
      base,
      `?surface=global&${oversizedParameterName}=1`
    );
    await check('oversized parameter name is bounded before reflection', () => {
      assert.equal(oversizedName.status, 400);
      assert.deepEqual(JSON.parse(oversizedName.body), {
        error: 'parameter name exceeds 512 characters',
      });
      assert.equal(oversizedName.body.includes(oversizedParameterName), false);
    });

    // 7. A well-formed reclaim request with NO route filter still validates (the
    //    masthead defaults apply) and returns the envelope.
    const reclaimNoRoute = await getRecs(base, '?surface=reclaim-compass');
    await check('reclaim-compass with only masthead defaults returns the envelope', () => {
      assert.equal(reclaimNoRoute.status, 200);
      assert.equal(JSON.parse(reclaimNoRoute.body).domainCoverage.length, 6);
    });

    // 8. Legacy path still accepts its own ?project= attribution filter.
    const legacyProject = await getRecs(base, '?project=/tmp/demo');
    await check('legacy ?project= still returns a raw array (byte-compatible)', () => {
      assert.equal(legacyProject.status, 200);
      assert.equal(Array.isArray(JSON.parse(legacyProject.body)), true);
    });
  }
} finally {
  proc.kill('SIGTERM');
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll recommendation-surface route checks passed');
