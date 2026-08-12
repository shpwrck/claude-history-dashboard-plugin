#!/usr/bin/env node
// Cold-restart safety for #2710's opt-in document issue-state snapshot.
//
// This deliberately exercises the real server process and its persisted SQLite
// dataset cache. A body assembled while the GitHub snapshot is usable must not
// be the stale-while-revalidate response after either (a) an opt-out restart or
// (b) a restart after the snapshot's 24-hour trust boundary. The preload shim
// makes every possible GitHub request fail locally, before any network I/O.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function snapshot(asOf) {
  return {
    repo: REPO,
    refs: REFS,
    records: [{ number: 101, state: 'open' }],
    asOf,
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
      // The fixed loopback listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not listen within 15s\n${server.diagnostics()}`);
}

async function startServer(fixture, { docIssues }) {
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
    CHD_INGEST_CODEX: '',
    CHD_GIT_OUTCOMES: '',
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
    ANTHROPIC_API_KEY: '',
    CHD_TEST_FETCH_MARKER: fixture.fetchMarker,
  };
  delete env.NODE_OPTIONS;
  delete env.CHD_DOC_ISSUES;
  delete env.CHD_DOC_ISSUES_TOKEN;
  delete env.CHD_DOC_ISSUES_TOKEN_FILE;
  if (docIssues) {
    env.CHD_DOC_ISSUES = REPO;
    env.CHD_DOC_ISSUES_TOKEN = 'fixture-token';
  }

  let stdout = '';
  let stderr = '';
  const proc = spawn(
    process.execPath,
    ['--import', REGISTER, '--import', fixture.fetchShim, SERVER],
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

async function requestDataset(server) {
  const response = await fetch(`${server.base}/api/dataset.json`, {
    headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  assert.equal(
    response.status,
    200,
    `dataset request failed: ${raw.slice(0, 1_000)}\n${server.diagnostics()}`
  );
  return {
    body: JSON.parse(raw),
    raw,
    etag: response.headers.get('etag'),
    ingest: response.headers.get('x-ingest') ?? '',
  };
}

async function markerContents(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'chd-doc-issue-restart-'));
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude');
  const docsRoot = join(root, 'docs-root');
  const cacheDir = join(root, 'cache');
  const distDir = join(root, 'dist');
  const fetchMarker = join(root, 'github-fetch-attempts.txt');
  const fetchShim = join(root, 'deny-github-fetch.mjs');

  await Promise.all([
    mkdir(join(claudeDir, 'projects'), { recursive: true }),
    mkdir(docsRoot, { recursive: true }),
    mkdir(join(cacheDir, 'doc-issues'), { recursive: true }),
    mkdir(distDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(docsRoot, 'REFERENCES.md'), 'Tracked by #101.\n'),
    writeFile(join(distDir, 'index.html'), '<!doctype html><main>fixture</main>\n'),
    writeFile(
      fetchShim,
      `import { appendFileSync } from 'node:fs';\n` +
        `const onlyAllowedExternalHost = ${JSON.stringify(GRAPHQL_URL)};\n` +
        `globalThis.fetch = async (input) => {\n` +
        `  const url = typeof input === 'string' ? input : input?.url;\n` +
        `  if (url !== onlyAllowedExternalHost) {\n` +
        `    throw new Error('unexpected external fetch: ' + String(url));\n` +
        `  }\n` +
        `  appendFileSync(process.env.CHD_TEST_FETCH_MARKER, url + '\\n');\n` +
        `  throw new Error('fixture GitHub fetch failure');\n` +
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
    dbPath: join(cacheDir, 'dashboard.db'),
    snapshotPath: join(cacheDir, 'doc-issues', 'acme__widgets.json'),
    fetchMarker,
    fetchShim,
  };
}

async function persistFreshEnabledBody(fixture) {
  await writeFile(
    fixture.snapshotPath,
    JSON.stringify(snapshot(new Date(Date.now() - 1_000).toISOString()))
  );
  const server = await startServer(fixture, { docIssues: true });
  try {
    const dataset = await requestDataset(server);
    assert.deepEqual(dataset.body.docIssueSnapshot?.records, [
      { number: 101, state: 'open' },
    ]);
    assert.doesNotMatch(dataset.ingest, /stale=true|revalidating=true/);
    assert.equal(
      await markerContents(fixture.fetchMarker),
      '',
      'a fresh valid snapshot should be reused without a GitHub attempt'
    );
    return dataset;
  } finally {
    await stopServer(server);
  }
}

function assertColdSnapshotFreeRestart(dataset, priorEtag) {
  assert.equal(
    Object.hasOwn(dataset.body, 'docIssueSnapshot'),
    false,
    'the first restarted response must omit the no-longer-trusted snapshot'
  );
  assert.equal(
    dataset.raw.includes('"docIssueSnapshot"'),
    false,
    'the raw response must not be the persisted snapshot-bearing body'
  );
  assert.doesNotMatch(
    dataset.ingest,
    /stale=true|revalidating=true/,
    `the first restarted response must be a cold rebuild, got X-Ingest: ${dataset.ingest}`
  );
  assert.notEqual(
    dataset.etag,
    priorEtag,
    'the restarted response must not reuse the snapshot-bearing persisted ETag'
  );
}

test('flag-off restart never serves the persisted flag-on dataset body', { timeout: 45_000 }, async () => {
  const fixture = await createFixture();
  let restarted;
  try {
    const enabled = await persistFreshEnabledBody(fixture);
    await access(fixture.dbPath);

    restarted = await startServer(fixture, { docIssues: false });
    const disabled = await requestDataset(restarted);
    assertColdSnapshotFreeRestart(disabled, enabled.etag);
    assert.equal(
      await markerContents(fixture.fetchMarker),
      '',
      'the flag-off restart must make no GitHub request'
    );
  } finally {
    await stopServer(restarted);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('expired flag-on restart never serves the prior snapshot body when refresh fails', { timeout: 45_000 }, async () => {
  const fixture = await createFixture();
  let restarted;
  try {
    const enabled = await persistFreshEnabledBody(fixture);
    await access(fixture.dbPath);
    await writeFile(
      fixture.snapshotPath,
      JSON.stringify(snapshot(new Date(Date.now() - DAY_MS - 60_000).toISOString()))
    );
    await rm(fixture.fetchMarker, { force: true });

    restarted = await startServer(fixture, { docIssues: true });
    const expired = await requestDataset(restarted);
    assertColdSnapshotFreeRestart(expired, enabled.etag);
    assert.equal(
      await markerContents(fixture.fetchMarker),
      `${GRAPHQL_URL}\n`,
      'the stale snapshot should attempt one fixed-host refresh that the shim rejects locally'
    );
  } finally {
    await stopServer(restarted);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
