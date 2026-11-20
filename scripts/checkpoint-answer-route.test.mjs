#!/usr/bin/env node
// Real-server contract for the CSRF-protected checkpoint answer persistence
// route (#2519): auth before body read, fail-closed sanitization, append-only
// JSONL, and a bounded efficacy GET rather than a raw-log response.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS,
  CHECKPOINT_ANSWER_MAX_DURATION_MS,
  CHECKPOINT_ANSWER_READ_MAX_BYTES,
  CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS,
} from '../src/lib/checkpoint-answer-store.ts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const WRITE_TOKEN = 'checkpoint-route-token';
let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label}: ${error.message}`);
  }
}

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

async function waitUp(base, process) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return true;
    } catch {
      // Server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function checkpointRecord(overrides = {}) {
  return {
    schemaVersion: '1',
    kind: 'CHECKPOINT_ANSWER',
    checkpointId: 'route-cp',
    shownAtIso: '2026-07-11T00:00:00.000Z',
    answeredAtIso: '2026-07-11T00:00:05.000Z',
    elapsedMs: 999_999,
    answer: 'worktrees',
    lateCorrection: false,
    provenance: {
      source: 'doc-neighborhood',
      anchor: { kind: 'doc', slug: 'AGENTS' },
      shownSlugs: ['AGENTS'],
      ambiguityTrigger: true,
      demotedSlugs: [],
    },
    ...overrides,
  };
}

async function post(base, port, body, headers = {}) {
  return fetch(`${base}/api/checkpoint/answers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'x-csrf-token': WRITE_TOKEN,
      connection: 'close',
      ...headers,
    },
    body,
  });
}

const port = await freePort();
const claudeDir = await mkdtemp(join(tmpdir(), 'checkpoint-route-claude-'));
const distDir = await mkdtemp(join(tmpdir(), 'checkpoint-route-dist-'));
const cacheDir = await mkdtemp(join(tmpdir(), 'checkpoint-route-cache-'));
const answersPath = join(cacheDir, 'checkpoint-answers.jsonl');
const base = `http://127.0.0.1:${port}`;

await mkdir(join(claudeDir, 'projects'), { recursive: true });
await writeFile(join(claudeDir, 'history.jsonl'), '');
await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');

let stdout = '';
let stderr = '';
const process = spawn('node', ['--import', './scripts/register-ts.mjs', 'scripts/server.mjs'], {
  cwd: PROJECT_DIR,
  env: {
    ...globalThis.process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
    CHD_CACHE_DIR: cacheDir,
    CHECKPOINT_ANSWERS_PATH: answersPath,
    ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
    REJECT_SIGNALS_PATH: join(cacheDir, 'reject-signals.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_REVIEW_EVENTS_SOURCE: '',
    ANTHROPIC_API_KEY: '',
    POLICY_WRITE_TOKEN: WRITE_TOKEN,
    DASHBOARD_MUTATING_BODY_MAX_BYTES: '1024',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.on('data', (chunk) => { stdout += String(chunk); });
process.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  const up = await waitUp(base, process);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2_000))
  );
  if (up) {
    const noOrigin = await fetch(`${base}/api/checkpoint/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(checkpointRecord()),
    });
    await check('cross-origin write is rejected before body handling', () =>
      assert.equal(noOrigin.status, 403)
    );

    const noToken = await post(
      base,
      port,
      JSON.stringify(checkpointRecord()),
      { 'x-csrf-token': '' }
    );
    await check('same-origin write without CSRF token is rejected', () =>
      assert.equal(noToken.status, 401)
    );

    const wrongType = await post(
      base,
      port,
      JSON.stringify(checkpointRecord()),
      { 'content-type': 'text/plain' }
    );
    await check('non-JSON content type is rejected', () =>
      assert.equal(wrongType.status, 415)
    );

    const oversized = await post(base, port, JSON.stringify({ payload: 'x'.repeat(2_000) }));
    await check('oversized mutating body is rejected', () =>
      assert.equal(oversized.status, 413)
    );

    const invalid = await post(base, port, JSON.stringify({ kind: 'CHECKPOINT_ANSWER' }));
    await check('malformed checkpoint record fails closed', () =>
      assert.equal(invalid.status, 400)
    );

    const timestampPoisonCases = [
      {
        label: 'Feb 30',
        shownAtIso: '2026-02-30T00:00:00.000Z',
        answeredAtIso: '2026-03-02T00:00:05.000Z',
      },
      {
        label: 'locale timestamp',
        shownAtIso: '07/13/2026 12:00:00',
        answeredAtIso: '07/13/2026 12:00:05',
      },
      {
        label: '2099 future timestamp',
        shownAtIso: '2099-01-01T00:00:00.000Z',
        answeredAtIso: '2099-01-01T00:00:05.000Z',
      },
      {
        label: 'huge reverse interval',
        shownAtIso: '2026-07-10T00:00:00.000Z',
        answeredAtIso: '2000-07-10T00:00:00.000Z',
      },
      {
        label: 'huge positive duration',
        shownAtIso: '1900-01-01T00:00:00.000Z',
        answeredAtIso: '2026-07-10T00:00:00.000Z',
      },
    ];
    for (const timestampCase of timestampPoisonCases) {
      const response = await post(base, port, JSON.stringify(checkpointRecord({
        checkpointId: `poison-${timestampCase.label}`,
        shownAtIso: timestampCase.shownAtIso,
        answeredAtIso: timestampCase.answeredAtIso,
      })));
      await check(`route rejects ${timestampCase.label}`, () =>
        assert.equal(response.status, 400)
      );
    }

    const reverseShownMs = Date.parse('2026-07-11T00:00:00.000Z');
    const durationShownMs = Date.parse('2026-07-10T00:00:00.000Z');
    const futureInsideMs = Date.now()
      + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS
      - 60_000;
    const allowedBoundaryCases = [
      checkpointRecord({
        checkpointId: 'reverse-boundary',
        shownAtIso: new Date(reverseShownMs).toISOString(),
        answeredAtIso: new Date(
          reverseShownMs - CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS
        ).toISOString(),
      }),
      checkpointRecord({
        checkpointId: 'duration-boundary',
        shownAtIso: new Date(durationShownMs).toISOString(),
        answeredAtIso: new Date(
          durationShownMs + CHECKPOINT_ANSWER_MAX_DURATION_MS
        ).toISOString(),
      }),
      checkpointRecord({
        checkpointId: 'future-inside-boundary',
        shownAtIso: new Date(futureInsideMs).toISOString(),
        answeredAtIso: new Date(futureInsideMs).toISOString(),
      }),
    ];
    for (const boundaryRecord of allowedBoundaryCases) {
      const response = await post(base, port, JSON.stringify(boundaryRecord));
      await check(`route accepts ${boundaryRecord.checkpointId}`, () =>
        assert.equal(response.status, 200)
      );
    }

    const futureOutsideMs = Date.now()
      + CHECKPOINT_ANSWER_FUTURE_CLOCK_SKEW_MS
      + 60_000;
    const rejectedBoundaryCases = [
      checkpointRecord({
        checkpointId: 'reverse-outside-boundary',
        shownAtIso: new Date(reverseShownMs).toISOString(),
        answeredAtIso: new Date(
          reverseShownMs - CHECKPOINT_ANSWER_REVERSE_CLOCK_SKEW_MS - 1
        ).toISOString(),
      }),
      checkpointRecord({
        checkpointId: 'duration-outside-boundary',
        shownAtIso: new Date(durationShownMs).toISOString(),
        answeredAtIso: new Date(
          durationShownMs + CHECKPOINT_ANSWER_MAX_DURATION_MS + 1
        ).toISOString(),
      }),
      checkpointRecord({
        checkpointId: 'future-outside-boundary',
        shownAtIso: new Date(futureOutsideMs).toISOString(),
        answeredAtIso: new Date(futureOutsideMs).toISOString(),
      }),
    ];
    for (const boundaryRecord of rejectedBoundaryCases) {
      const response = await post(base, port, JSON.stringify(boundaryRecord));
      await check(`route rejects ${boundaryRecord.checkpointId}`, () =>
        assert.equal(response.status, 400)
      );
    }
    await check('route persists only tolerated timestamp-boundary rows', async () => {
      const rows = (await readFile(answersPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(rows.map((row) => row.checkpointId), [
        'reverse-boundary',
        'duration-boundary',
        'future-inside-boundary',
      ]);
      assert.deepEqual(rows.map((row) => row.elapsedMs), [
        0,
        CHECKPOINT_ANSWER_MAX_DURATION_MS,
        0,
      ]);
    });
    await rm(answersPath, { force: true });

    const valid = await post(
      base,
      port,
      JSON.stringify({ ...checkpointRecord(), secret: 'drop-me' })
    );
    await check('authenticated valid checkpoint answer appends', () =>
      assert.equal(valid.status, 200)
    );
    await check('persisted row is sanitized and elapsed is recomputed', async () => {
      const rows = (await readFile(answersPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].elapsedMs, 5_000);
      assert.equal(rows[0].secret, undefined);
      assert.equal(rows[0].provenance.source, 'doc-neighborhood');
    });

    const summaryResponse = await fetch(`${base}/api/checkpoint/answers`, {
      headers: { connection: 'close' },
    });
    const summary = await summaryResponse.json();
    await check('GET returns bounded efficacy aggregate with provenance', () => {
      assert.equal(summaryResponse.status, 200);
      assert.equal(summary.kind, 'CHECKPOINT_ANSWER_EFFICACY');
      assert.equal(summary.summary.answerCount, 1);
      assert.equal(summary.summary.medianElapsedMs, 5_000);
      assert.equal(summary.summary.resolvedLateCorrectionRate, 0);
      assert.equal(summary.provenance.recordsRead, 1);
      assert.equal(summary.provenance.complete, true);
      assert.equal(summary.provenance.truncated, false);
      assert.equal(summary.provenance.samples.length, 1);
      assert.equal(summary.records, undefined);
    });

    await truncate(answersPath, CHECKPOINT_ANSWER_READ_MAX_BYTES + 1);
    const boundedResponse = await fetch(`${base}/api/checkpoint/answers`, {
      headers: { connection: 'close' },
    });
    const bounded = await boundedResponse.json();
    await check('GET fails closed with explicit provenance beyond the durable-log budget', () => {
      assert.equal(boundedResponse.status, 503);
      assert.equal(bounded.ok, false);
      assert.equal(bounded.incomplete, true);
      assert.equal(bounded.summary, undefined);
      assert.deepEqual(bounded.provenance, {
        source: 'checkpoint-answer-log',
        complete: false,
        truncated: true,
        reason: 'max-bytes',
        limit: CHECKPOINT_ANSWER_READ_MAX_BYTES,
        observed: CHECKPOINT_ANSWER_READ_MAX_BYTES + 1,
        bytesRead: 0,
        rowsScanned: 0,
        recordsRead: 0,
        recordsSkipped: 0,
        logicalAnswers: 0,
      });
    });

    await rm(answersPath, { force: true });
    await mkdir(answersPath);
    const unreadableResponse = await fetch(`${base}/api/checkpoint/answers`, {
      headers: { connection: 'close' },
    });
    await check('GET surfaces a non-file read failure as 5xx instead of empty 200', () =>
      assert.equal(unreadableResponse.status, 500)
    );
  }
} finally {
  process.kill('SIGTERM');
  await rm(claudeDir, { recursive: true, force: true });
  await rm(distDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nCheckpoint answer route checks FAILED (${failures}).`);
  globalThis.process.exit(1);
}
console.log('\nCheckpoint answer route checks passed.');
