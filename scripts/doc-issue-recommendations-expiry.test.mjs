#!/usr/bin/env node
// Real-server boundary proof for #2710's recommendation response cache.
//
// A typed envelope built with a usable doc-issue snapshot may be cached only
// through that snapshot's inclusive 24-hour boundary. This test keeps one
// server process alive while a preload-controlled Date.now() crosses from the
// exact boundary to boundary + 1ms. External fetches are intercepted and fail
// before network I/O (loopback remains available to the local-model test), so
// the responses can prove that refresh failure never falls back to stale
// snapshot-backed claims.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';
const REPO = 'acme/widgets';
const REFS = [101];
const GRAPHQL_URL = 'https://api.github.com/graphql';
const DAY_MS = 24 * 60 * 60 * 1000;
const BOUNDARY = Date.parse('2026-07-20T12:00:00.000Z');

function snapshotAtBoundary() {
  return {
    repo: REPO,
    refs: REFS,
    records: [{ number: 101, state: 'open' }],
    asOf: new Date(BOUNDARY - DAY_MS).toISOString(),
    complete: true,
    fingerprint: createHash('sha256')
      .update(`${REPO}\n${REFS.join(',')}`)
      .digest('hex'),
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createNetServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function tail(current, chunk) {
  return `${current}${String(chunk)}`.slice(-20_000);
}

async function stopServer(server) {
  if (!server || server.proc.exitCode !== null) return;
  const closed = once(server.proc, 'close');
  server.proc.kill('SIGTERM');
  const hardStop = setTimeout(() => {
    if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
  }, 2_000);
  hardStop.unref();
  await closed;
  clearTimeout(hardStop);
}

async function stopHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitUntilListening(server) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.proc.exitCode !== null) {
      throw new Error(
        `server exited before listening (${server.proc.exitCode})\n${server.diagnostics()}`
      );
    }
    try {
      const response = await fetch(`${server.base}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not listen within 15s\n${server.diagnostics()}`);
}

async function startServer(fixture, { localModelEndpoint = '' } = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: fixture.home,
    CLAUDE_DIR: fixture.claudeDir,
    CLAUDE_HOME_DIR: fixture.home,
    CODING_AGENT_SOURCES: '',
    PROBAITIO_INGEST_DIR: '',
    CHD_CACHE_DIR: fixture.cacheDir,
    DASHBOARD_CACHE_DIR: fixture.cacheDir,
    CHD_DB_PATH: fixture.dbPath,
    CHD_DOC_GRAPH_ROOT: fixture.docsRoot,
    CHD_DOC_ISSUES: REPO,
    CHD_DOC_ISSUES_TOKEN: 'fixture-token',
    CHD_DOC_ISSUES_TOKEN_FILE: '',
    CHD_INGEST_CODEX: '',
    CHD_GIT_OUTCOMES: '',
    CHD_RECS_WORKER: '0',
    CHD_LOCAL_MODEL_ENDPOINT: localModelEndpoint,
    CHD_LOCAL_MODEL_NAME: localModelEndpoint ? 'fixture-race-model' : '',
    DIST_DIR: fixture.distDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    ADOPTION_RECEIPTS_PATH: join(fixture.cacheDir, 'adoption-receipts.jsonl'),
    REJECT_SIGNALS_PATH: join(fixture.cacheDir, 'reject-signals.jsonl'),
    CHECKPOINT_ANSWERS_PATH: join(fixture.cacheDir, 'checkpoint-answers.jsonl'),
    ENTERPRISE_AUDIT_LOG_PATH: join(fixture.cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(fixture.cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(fixture.cacheDir, 'review-events.json'),
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    DASHBOARD_GITHUB_REVIEW_TOKEN: '',
    DASHBOARD_GITHUB_REVIEW_REPOS: '',
    DASHBOARD_AUTH_MODE: '',
    DASHBOARD_AUTH_TOKENS: '',
    DASHBOARD_AUTH_TOKENS_FILE: '',
    DASHBOARD_USER: '',
    DASHBOARD_PASS: '',
    DASHBOARD_ADMIN_TOKEN: '',
    DASHBOARD_ADMIN_TOKEN_SHA256: '',
    DASHBOARD_AUTH_JWKS: '',
    DASHBOARD_AUTH_JWKS_URL: '',
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
    ANTHROPIC_API_KEY: '',
    CHD_TEST_CLOCK_FILE: fixture.clockFile,
    CHD_TEST_FETCH_MARKER: fixture.fetchMarker,
  };
  delete env.NODE_OPTIONS;

  let stdout = '';
  let stderr = '';
  const proc = spawn(
    process.execPath,
    ['--import', REGISTER, '--import', fixture.preload, SERVER],
    {
      cwd: PROJECT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stdout.on('data', (chunk) => {
    stdout = tail(stdout, chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr = tail(stderr, chunk);
  });
  const server = {
    base: `http://127.0.0.1:${port}`,
    proc,
    diagnostics: () => [stdout, stderr].filter(Boolean).join('\n'),
  };
  try {
    await waitUntilListening(server);
    return server;
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

async function getGlobalRecommendations(server) {
  const response = await fetch(
    `${server.base}/api/recommendations.json?surface=global&dashboardTime=all`,
    {
      headers: {
        'accept-encoding': 'identity',
        connection: 'close',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  const raw = await response.text();
  assert.equal(
    response.status,
    200,
    `recommendations request failed: ${raw.slice(0, 1_000)}\n${server.diagnostics()}`
  );
  return {
    body: JSON.parse(raw),
    raw,
    cache: response.headers.get('x-recommendations-cache'),
    etag: response.headers.get('etag'),
  };
}

async function getDatasetBoot(server) {
  const response = await fetch(`${server.base}/api/dataset/boot`, {
    headers: {
      'accept-encoding': 'identity',
      connection: 'close',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  assert.equal(
    response.status,
    200,
    `dataset boot request failed: ${raw.slice(0, 1_000)}\n${server.diagnostics()}`
  );
  return {
    body: JSON.parse(raw),
    raw,
    etag: response.headers.get('etag'),
    version: response.headers.get('x-dataset-version'),
  };
}

async function postLocalAnalyze(server) {
  const response = await fetch(`${server.base}/api/analyze/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      connection: 'close',
    },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  assert.equal(
    response.status,
    200,
    `local analysis request failed: ${raw.slice(0, 1_000)}\n${server.diagnostics()}`
  );
  return { body: JSON.parse(raw), raw };
}

async function startRaceLocalModel(clockFile) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      requests.push({ method: req.method, url: req.url, body: raw });

      // The deterministic recommendation set was assembled at the exact
      // inclusive boundary. Cross it while the model call is in flight, before
      // returning an otherwise schema-valid completion.
      await writeFile(clockFile, String(BOUNDARY + 1));
      const content = JSON.stringify({
        summary: 'This snapshot-backed model analysis must be discarded.',
        rankedFindingIds: [],
      });
      const body = JSON.stringify({
        id: 'fixture-chat-completion',
        object: 'chat.completion',
        model: 'fixture-race-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      });
      res.end(body);
    } catch (error) {
      const body = JSON.stringify({ error: error?.message || String(error) });
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      });
      res.end(body);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'chd-doc-issue-recs-expiry-'));
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const docsRoot = join(root, 'docs-root');
  const cacheDir = join(root, 'cache');
  const distDir = join(root, 'dist');
  const clockFile = join(root, 'clock.txt');
  const fetchMarker = join(root, 'blocked-fetches.txt');
  const preload = join(root, 'clock-and-fetch-preload.mjs');

  await Promise.all([
    mkdir(join(claudeDir, 'projects'), { recursive: true }),
    mkdir(docsRoot, { recursive: true }),
    mkdir(join(cacheDir, 'doc-issues'), { recursive: true }),
    mkdir(distDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(claudeDir, 'history.jsonl'), ''),
    writeFile(
      join(docsRoot, 'REFERENCES.md'),
      '# References\n\nTracked by #101.\n\n[Missing documentation](docs/missing.md)\n'
    ),
    writeFile(join(distDir, 'index.html'), '<!doctype html><main>fixture</main>\n'),
    writeFile(clockFile, String(BOUNDARY)),
    writeFile(
      join(cacheDir, 'doc-issues', 'acme__widgets.json'),
      JSON.stringify(snapshotAtBoundary())
    ),
    writeFile(
      preload,
      `import { appendFileSync, readFileSync } from 'node:fs';\n` +
        `const realFetch = globalThis.fetch;\n` +
        `const clockFile = process.env.CHD_TEST_CLOCK_FILE;\n` +
        `const fetchMarker = process.env.CHD_TEST_FETCH_MARKER;\n` +
        `Date.now = () => {\n` +
        `  const now = Number(readFileSync(clockFile, 'utf8').trim());\n` +
        `  if (!Number.isFinite(now)) throw new Error('invalid fixture clock');\n` +
        `  return now;\n` +
        `};\n` +
        `globalThis.fetch = async (input, init) => {\n` +
        `  const url = typeof input === 'string' ? input : String(input?.url ?? input);\n` +
        `  let hostname = '';\n` +
        `  try { hostname = new URL(url).hostname.toLowerCase(); } catch {}\n` +
        `  if (hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')) {\n` +
        `    return realFetch(input, init);\n` +
        `  }\n` +
        `  appendFileSync(fetchMarker, url + '\\n');\n` +
        `  throw new Error('fixture blocks external network fetch: ' + url);\n` +
        `};\n`
    ),
  ]);

  return {
    root,
    home,
    claudeDir,
    docsRoot,
    cacheDir,
    distDir,
    clockFile,
    fetchMarker,
    preload,
    dbPath: join(cacheDir, 'dashboard.db'),
  };
}

test(
  'typed recommendation cache hard-expires a doc-issue envelope at boundary +1ms',
  { timeout: 60_000 },
  async () => {
    const fixture = await createFixture();
    let server;
    try {
      server = await startServer(fixture);

      const atBoundary = await getGlobalRecommendations(server);
      assert.equal(atBoundary.cache, 'miss');
      assert.equal(
        atBoundary.body.validThrough,
        new Date(BOUNDARY).toISOString(),
        'the exact 24-hour boundary must be carried as a canonical inclusive instant'
      );
      assert.ok(Array.isArray(atBoundary.body.recommendations));
      assert.ok(
        atBoundary.body.recommendations.length > 0,
        'the cached fixture envelope should contain at least one real recommendation card'
      );
      assert.ok(Array.isArray(atBoundary.body.domainCoverage));

      const bootAtBoundary = await getDatasetBoot(server);
      assert.deepEqual(
        bootAtBoundary.body.meta.docIssueSnapshot?.records,
        [{ number: 101, state: 'open' }],
        'the boot payload carries the raw snapshot only through its inclusive boundary'
      );
      assert.equal(
        bootAtBoundary.body.version,
        bootAtBoundary.version,
        'the boot body and slice-version header identify the same assembled corpus'
      );

      // Do not touch the snapshot file. Only the server clock advances, so the
      // exact same cached snapshot becomes unusable at this next millisecond.
      await writeFile(fixture.clockFile, String(BOUNDARY + 1));
      const expiredBoot = await getDatasetBoot(server);
      assert.equal(
        Object.hasOwn(expiredBoot.body.meta, 'docIssueSnapshot'),
        false,
        'the split-dataset boot cache must hard-expire its raw snapshot too'
      );
      assert.notEqual(expiredBoot.raw, bootAtBoundary.raw);
      assert.notEqual(expiredBoot.etag, bootAtBoundary.etag);
      assert.notEqual(
        expiredBoot.version,
        bootAtBoundary.version,
        'expiry must turn over the boot/slice corpus version'
      );
      const expired = await getGlobalRecommendations(server);

      assert.equal(
        expired.cache,
        'miss',
        `snapshot expiry must cold-build, never ${expired.cache ?? 'an unlabeled response'}`
      );
      assert.ok(
        !['hit', 'hit-content', 'stale'].includes(expired.cache),
        `expired snapshot envelope was improperly retained via ${expired.cache}`
      );
      assert.equal(
        Object.hasOwn(expired.body, 'validThrough'),
        false,
        'the refresh-failed response must omit snapshot validity metadata entirely'
      );
      assert.notEqual(
        expired.raw,
        atBoundary.raw,
        'the refresh failure must not return the old snapshot-bearing card envelope'
      );
      assert.notEqual(
        expired.etag,
        atBoundary.etag,
        'the hard-miss response must not retain the old envelope ETag'
      );
      assert.ok(Array.isArray(expired.body.recommendations));

      // Once this process has observed the snapshot past its hard boundary,
      // correcting the wall clock backward must not resurrect the same cached
      // evidence or any recommendation claims derived from it.
      await writeFile(fixture.clockFile, String(BOUNDARY));
      const rolledBackBoot = await getDatasetBoot(server);
      assert.equal(
        Object.hasOwn(rolledBackBoot.body.meta, 'docIssueSnapshot'),
        false,
        'clock rollback must not revive raw snapshot evidence in the boot cache'
      );
      assert.notEqual(rolledBackBoot.raw, bootAtBoundary.raw);
      const rolledBack = await getGlobalRecommendations(server);
      assert.equal(
        Object.hasOwn(rolledBack.body, 'validThrough'),
        false,
        'clock rollback must not revive a retired snapshot envelope'
      );
      assert.notEqual(rolledBack.raw, atBoundary.raw);
      assert.ok(Array.isArray(rolledBack.body.recommendations));

      const blockedFetches = (await readFile(fixture.fetchMarker, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.deepEqual(
        blockedFetches,
        [GRAPHQL_URL],
        'one boundary refresh is intercepted locally; expiry and rollback remain throttled, with no network escape'
      );
    } finally {
      await stopServer(server);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);

test(
  'local analysis discards a model result when doc-issue evidence expires in flight',
  { timeout: 60_000 },
  async () => {
    const fixture = await createFixture();
    let dashboard;
    let localModel;
    try {
      localModel = await startRaceLocalModel(fixture.clockFile);
      dashboard = await startServer(fixture, {
        localModelEndpoint: localModel.endpoint,
      });

      const result = await postLocalAnalyze(dashboard);
      assert.equal(localModel.requests.length, 1, 'the loopback model should answer once');
      assert.deepEqual(
        {
          method: localModel.requests[0].method,
          url: localModel.requests[0].url,
          model: JSON.parse(localModel.requests[0].body).model,
        },
        {
          method: 'POST',
          url: '/v1/chat/completions',
          model: 'fixture-race-model',
        },
        'the preload must delegate only the configured loopback model request'
      );

      assert.equal(
        result.body.source,
        'deterministic',
        'the model result must be discarded after its evidence expires'
      );
      assert.equal(result.body.analysis, null);
      assert.equal(result.body.model, null);
      assert.equal(result.body.rankedFindingIds, null);
      assert.equal(result.body.schemaValid, false);
      assert.match(result.body.reason, /evidence changed while local analysis was running/i);
      assert.ok(Array.isArray(result.body.recommendations));
      assert.ok(
        result.body.recommendations.length > 0,
        'the route should rebuild and return the deterministic fallback cards'
      );
      assert.equal(
        Object.hasOwn(result.body, 'validThrough'),
        false,
        'the fallback rebuilt after expiry must not retain the old snapshot boundary'
      );
      assert.equal(
        result.raw.includes('This snapshot-backed model analysis must be discarded.'),
        false,
        'the now-untrustworthy model prose must not reach the response'
      );

      const blockedFetches = (await readFile(fixture.fetchMarker, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.deepEqual(
        blockedFetches,
        [GRAPHQL_URL],
        'GitHub is blocked locally, the model stays loopback, and no external fetch escapes'
      );
    } finally {
      await stopServer(dashboard);
      await stopHttpServer(localModel?.server);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
);
