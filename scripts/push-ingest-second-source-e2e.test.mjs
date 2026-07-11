#!/usr/bin/env node
// Operator-free second-source aggregation e2e (#1647, epic #1563).
//
// The route test (scripts/push-ingest-route.test.mjs) proves the POST -> assembled
// dataset spine for the PUSHED source with an EMPTY local root, and the aggregation
// test (src/lib/artifact-source-ingest.test.ts) proves two POPULATED roots aggregate
// collision-free from DISK (CODING_AGENT_SOURCES + assembleDataset()). Neither alone
// proves the #1563 thesis end-to-end: that a POPULATED first source plus a SECOND
// source whose artifacts arrive over the live POST endpoint coexist in the assembled
// dataset, collision-free (distinct UUIDs), each carrying its own sourceId provenance
// — WITHOUT the operator/sidecar.
//
// This test joins the two halves: it boots the real scripts/server.mjs with a populated
// local CLAUDE_DIR (source `claude-code`) AND a push-ingest root (source `probaitio-ingest`),
// POSTs a SECOND source's fixture session to POST /api/ingest/<sourceId>/artifacts, then
// GETs /api/dataset.json and asserts BOTH sources' distinct sessions appear, collision-free,
// each tagged with its own sourceId + harness. No live cluster, no operator, no network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const INGEST_TOKEN = 'second-source-e2e-token';
const SECOND_SOURCE_ID = 'remote-b';

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

// A complete transcript (user prompt + assistant turn with token usage) for a
// given distinct session UUID, so the session flows through the full parse path.
function transcript(prompt, cwd) {
  return (
    [
      jsonlLine({
        type: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd,
        message: { role: 'user', content: prompt },
      }),
      jsonlLine({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: `${prompt}-assistant`,
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ].join('\n') + '\n'
  );
}

// FIRST source: a populated local claude-code root (NOT empty — this is what the
// route test omits). Distinct UUID `uuid-local-a`.
const localTranscript = transcript('local first-source prompt', '/local/repo');

// SECOND source: artifacts that will arrive over the POST endpoint. Distinct UUID
// `uuid-pushed-b` — collision-free with the local one.
const pushedTranscript = transcript('pushed second-source prompt', '/pushed/repo');
const pushedSignature = createHash('sha1').update(pushedTranscript).digest('hex');

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'second-source-local-'));
const ingestDir = await mkdtemp(join(tmpdir(), 'second-source-remote-'));
const distDir = await mkdtemp(join(tmpdir(), 'second-source-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'second-source-cache-'));
const base = `http://127.0.0.1:${port}`;

// Populate the FIRST (local claude-code) source on disk before boot.
await mkdir(join(claudeDir, 'projects', 'local-project'), { recursive: true });
await writeFile(
  join(claudeDir, 'projects', 'local-project', 'uuid-local-a.jsonl'),
  localTranscript
);
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

async function postSecondSource() {
  const response = await fetch(`${base}/api/ingest/${SECOND_SOURCE_ID}/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INGEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meta: { displayName: 'Remote B' },
      artifacts: [
        {
          relPath: 'projects/pushed-project/uuid-pushed-b.jsonl',
          signature: pushedSignature,
          content: pushedTranscript,
        },
      ],
    }),
  });
  return { status: response.status, body: await response.json() };
}

try {
  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    const post = await postSecondSource();
    await check('POST lands the second source artifacts (operator-free push)', () => {
      assert.equal(post.status, 200);
      assert.equal(post.body.ok, true);
      assert.equal(post.body.written, 1);
      assert.deepEqual(post.body.refused, []);
    });

    const datasetResponse = await fetch(`${base}/api/dataset.json`);
    const ingestHeader = datasetResponse.headers.get('x-ingest') || '';
    const dataset = await datasetResponse.json();

    await check('assembled dataset advertises BOTH sources (local + pushed)', () => {
      // A cold rebuild reparsed both sessions (one per source root).
      assert.match(ingestHeader, /reparsed=2/);
      const ids = (dataset.sources || []).map((s) => s.id).sort();
      assert.deepEqual(ids, ['claude-code', 'probaitio-ingest']);
    });

    await check(
      'both sources aggregate collision-free, each with its own provenance',
      () => {
        const local = dataset.entries.find((e) => e.sessionId === 'uuid-local-a');
        const pushed = dataset.entries.find((e) => e.sessionId === 'uuid-pushed-b');

        // Both distinct-UUID sessions survive (collision-free aggregation).
        assert.ok(local, 'local first-source session missing from assembled dataset');
        assert.ok(pushed, 'pushed second-source session missing from assembled dataset');

        // Each carries the right display from its own root (no cross-contamination).
        assert.equal(local.display, 'local first-source prompt');
        assert.equal(pushed.display, 'pushed second-source prompt');

        // Per-source provenance: the local session is tagged claude-code, the
        // POSTed second source is tagged probaitio-ingest.
        assert.equal(local.sourceId, 'claude-code');
        assert.equal(local.harness, 'claude-code');
        assert.equal(pushed.sourceId, 'probaitio-ingest');
        assert.equal(pushed.harness, 'claude-code');

        // Provenance carries through the token rows too, keyed by sourceId.
        const localToken = dataset.tokenData.find((r) => r.sessionId === 'uuid-local-a');
        const pushedToken = dataset.tokenData.find((r) => r.sessionId === 'uuid-pushed-b');
        assert.ok(localToken, 'local token row missing');
        assert.ok(pushedToken, 'pushed token row missing');
        assert.equal(localToken.sourceId, 'claude-code');
        assert.equal(pushedToken.sourceId, 'probaitio-ingest');

        // Collision-free: the two sessions are distinct rows, not merged.
        assert.notEqual(local.sessionId, pushed.sessionId);
      }
    );
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

console.log('\nSecond-source aggregation e2e checks passed.');
