#!/usr/bin/env node
// Push-ingest contract (#1248/#1563): a shipper can POST session artifacts into
// a separate artifact root, and the live dataset consumes that root through the
// normal ingest/cache path with source provenance.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';
const INGEST_TOKEN = 'push-ingest-test-token';

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

function jsonlLine(entry) {
  return JSON.stringify(entry);
}

const remoteTranscript = [
  jsonlLine({
    type: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/remote/repo',
    message: { role: 'user', content: 'remote pushed prompt' },
  }),
  jsonlLine({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      id: 'remote-assistant',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }),
].join('\n') + '\n';
const remoteSignature = createHash('sha1').update(remoteTranscript).digest('hex');
const remoteDebug = [
  '2026-01-01T00:00:00.000Z [API REQUEST] /v1/messages',
  '2026-01-01T00:00:00.250Z Stream started - received first chunk',
].join('\n') + '\n';
const remoteDebugSignature = createHash('sha1').update(remoteDebug).digest('hex');
const remoteStats = JSON.stringify({
  version: 3,
  lastComputedDate: '2026-01-01',
  dailyActivity: [
    {
      date: '2026-01-01',
      messageCount: 4,
      sessionCount: 1,
      toolCallCount: 2,
    },
  ],
}) + '\n';
const remoteStatsSignature = createHash('sha1').update(remoteStats).digest('hex');

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'push-ingest-local-'));
const ingestDir = await mkdtemp(join(tmpdir(), 'push-ingest-remote-'));
const distDir = await mkdtemp(join(tmpdir(), 'push-ingest-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'push-ingest-cache-'));
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects'), { recursive: true });
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
    PROBAITIO_INGEST_DIR: ingestDir,
    PROBAITIO_INGEST_TOKEN: INGEST_TOKEN,
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

async function postArtifacts() {
  const response = await fetch(`${base}/api/ingest/remote-a/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INGEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meta: { displayName: 'Remote A' },
      artifacts: [
        {
          relPath: 'projects/remote-project/remote-session.jsonl',
          signature: remoteSignature,
          content: remoteTranscript,
        },
        {
          relPath: 'debug/remote-session.txt',
          signature: remoteDebugSignature,
          content: remoteDebug,
        },
        {
          relPath: 'stats-cache.json',
          signature: remoteStatsSignature,
          content: remoteStats,
        },
      ],
    }),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

try {
  const up = await waitUp(base, proc);
  await check(
    'server came up',
    () => assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    const firstPost = await postArtifacts();
    await check('first push writes the remote transcript artifact', () => {
      assert.equal(firstPost.status, 200);
      assert.equal(firstPost.body.ok, true);
      assert.equal(firstPost.body.written, 3);
      assert.equal(firstPost.body.skipped, 0);
      assert.deepEqual(firstPost.body.refused, []);
    });

    const datasetResponse = await fetch(`${base}/api/dataset.json`);
    const firstIngestHeader = datasetResponse.headers.get('x-ingest') || '';
    const dataset = await datasetResponse.json();
    await check('dataset advertises the pushed artifact source', () => {
      assert.deepEqual(
        dataset.sources.map(({ id, harness, historyDir }) => ({ id, harness, historyDir })),
        [
          {
            id: 'claude-code',
            harness: 'claude-code',
            historyDir: join(claudeDir, 'projects'),
          },
          {
            id: 'probaitio-ingest',
            harness: 'claude-code',
            historyDir: join(ingestDir, 'projects'),
          },
        ]
      );
    });
    await check('dataset includes the pushed session with source provenance', () => {
      assert.match(firstIngestHeader, /reparsed=1/);
      assert.equal(
        dataset.entries.some(
          (entry) =>
            entry.sessionId === 'remote-session' &&
            entry.display === 'remote pushed prompt' &&
            entry.project === '/remote/repo' &&
            entry.sourceId === 'probaitio-ingest' &&
            entry.harness === 'claude-code'
        ),
        true
      );
      assert.equal(
        dataset.tokenData.some(
          (row) =>
            row.sessionId === 'remote-session' &&
            row.sourceId === 'probaitio-ingest' &&
            row.harness === 'claude-code'
        ),
        true
      );
      assert.equal(
        dataset.debugLogs.some(
          (row) =>
            row.sessionId === 'remote-session' &&
            row.ttfbSampleCount === 1 &&
            row.ttfbP50 === 250
        ),
        true
      );
      assert.deepEqual(dataset.statsCache.dailyActivity, [
        {
          date: '2026-01-01',
          messageCount: 4,
          sessionCount: 1,
          toolCallCount: 2,
        },
      ]);
    });

    const duplicatePost = await postArtifacts();
    await check('second push with the same signature is idempotent', () => {
      assert.equal(duplicatePost.status, 200);
      assert.equal(duplicatePost.body.ok, true);
      assert.equal(duplicatePost.body.written, 0);
      assert.equal(duplicatePost.body.skipped, 3);
      assert.deepEqual(duplicatePost.body.refused, []);
    });

    const cachedResponse = await fetch(`${base}/api/dataset.json`);
    const cachedIngestHeader = cachedResponse.headers.get('x-ingest') || '';
    await cachedResponse.arrayBuffer();
    await check('unchanged pushed artifacts hit the dataset stat gate', () => {
      assert.equal(cachedIngestHeader, 'skipped=true;cached=true');
    });

    // #2065: a pre-planted symlink at the destination must NOT be followed —
    // the write is refused and the outside target is left untouched.
    const outsideTarget = join(distDir, 'symlink-escape-target.txt');
    await writeFile(outsideTarget, 'original');
    await mkdir(join(ingestDir, 'projects'), { recursive: true });
    await symlink(outsideTarget, join(ingestDir, 'projects', 'evil.jsonl'));
    const symlinkPost = await fetch(`${base}/api/ingest/remote-a/artifacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INGEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        artifacts: [
          { relPath: 'projects/evil.jsonl', content: 'PWNED', signature: 'sig-evil' },
        ],
      }),
    });
    const symlinkBody = await symlinkPost.json();
    await check('symlinked artifact dest is refused, not followed', async () => {
      assert.equal(symlinkPost.status, 200);
      assert.equal(symlinkBody.written, 0);
      assert.ok(
        (symlinkBody.refused || []).some((r) => r.relPath === 'projects/evil.jsonl'),
        `expected projects/evil.jsonl in refused, got ${JSON.stringify(symlinkBody.refused)}`
      );
      assert.equal(await readFile(outsideTarget, 'utf8'), 'original');
    });

    // #3102: a symlinked out-of-band metadata dir (.sources/<sourceId> -> outside)
    // must be refused up front — an otherwise-valid authenticated batch is
    // rejected and neither _source.json nor .signatures.json is authored outside
    // the ingest root.
    const metaEscapeTarget = join(distDir, 'meta-escape-target');
    await mkdir(metaEscapeTarget, { recursive: true });
    await mkdir(join(ingestDir, '.sources'), { recursive: true });
    await symlink(metaEscapeTarget, join(ingestDir, '.sources', 'remote-escape'));
    const metaEscapePost = await fetch(`${base}/api/ingest/remote-escape/artifacts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INGEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        meta: { displayName: 'Escape' },
        artifacts: [
          {
            relPath: 'projects/escape-project/escape-session.jsonl',
            signature: 'sig-escape',
            content: 'escape\n',
          },
        ],
      }),
    });
    const metaEscapeBody = await metaEscapePost.json();
    await check('symlinked .sources/<id> metadata dir is refused, not followed', async () => {
      assert.equal(metaEscapePost.status, 400);
      assert.equal(metaEscapeBody.ok, false);
      assert.match(String(metaEscapeBody.error || ''), /escapes root/);
      // No metadata authored into the external target.
      assert.deepEqual(await readdir(metaEscapeTarget), []);
    });

    // The contained happy path still authored real metadata inside the ingest
    // root (proving the containment did not break normal writes).
    await check('normal metadata writes still succeed in a real contained dir', async () => {
      const ledger = JSON.parse(
        await readFile(join(ingestDir, '.sources', 'remote-a', '.signatures.json'), 'utf8')
      );
      assert.equal(typeof ledger, 'object');
      assert.equal(
        ledger['projects/remote-project/remote-session.jsonl'],
        remoteSignature
      );
    });
  }
} finally {
  // A server that died before waitUp succeeded has already emitted 'exit' —
  // waiting on the listener then would hang the CI step instead of failing
  // with the captured logs.
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
  await rm(claudeDir, { recursive: true, force: true });
  await rm(ingestDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) {
  process.exit(1);
}

console.log('\nPush-ingest route checks passed.');
