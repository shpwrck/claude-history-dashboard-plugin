import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseJsonRpcLine,
  parseRateLimitsResponse,
  queryCodexRateLimits,
  rateLimitsToHeaders,
} from './check-harness-usage.mjs';

const SCRIPT = fileURLToPath(new URL('./check-harness-usage.mjs', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'chd-audit-usage-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const WEEKLY_ONLY = {
  limitId: 'codex',
  primary: {
    usedPercent: 41,
    windowDurationMins: 10080,
    resetsAt: 1_800_000_000,
  },
  secondary: null,
  spendControlReached: false,
  planType: 'pro',
  rateLimitReachedType: null,
};

test('parseJsonRpcLine accepts an object and rejects malformed/non-object JSON', () => {
  assert.deepEqual(parseJsonRpcLine('{"id":2,"result":{}}'), { id: 2, result: {} });
  assert.throws(() => parseJsonRpcLine('not-json'), /malformed JSON/i);
  assert.throws(() => parseJsonRpcLine('[]'), /JSON object/i);
});

test('parseRateLimitsResponse extracts the live snapshot and rejects RPC errors', () => {
  assert.equal(
    parseRateLimitsResponse({ id: 2, result: { rateLimits: WEEKLY_ONLY } }),
    WEEKLY_ONLY,
  );
  assert.throws(
    () => parseRateLimitsResponse({
      id: 2,
      error: { code: -32603, message: 'account unavailable' },
    }),
    /account unavailable/,
  );
  assert.throws(
    () => parseRateLimitsResponse({ id: 2, result: { rateLimits: null } }),
    /rateLimits snapshot/i,
  );
});

test('rateLimitsToHeaders maps a 10080-minute window to 7d and treats absent 5h as unmetered', () => {
  const headers = rateLimitsToHeaders(WEEKLY_ONLY);

  assert.equal(headers['5h-utilization'], '0');
  assert.equal(headers['5h-status'], 'ok');
  assert.equal(headers['5h-stale'], 'false');
  assert.equal(headers['5h-reset'], '');
  assert.equal(headers['7d-utilization'], '0.41');
  assert.equal(headers['7d-reset'], '1800000000');
  assert.equal(headers['7d-status'], 'ok');
  assert.equal(headers['7d-stale'], 'false');
  assert.equal(headers['representative-claim'], 'seven_day');
  assert.equal(headers['source-harness'], 'codex');
});

test('rateLimitsToHeaders maps both windows by duration, independent of primary/secondary position', () => {
  const headers = rateLimitsToHeaders({
    primary: {
      usedPercent: 70,
      windowDurationMins: 10080,
      resetsAt: 1_800_000_000,
    },
    secondary: {
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: 1_799_600_000,
    },
    planType: 'plus',
    rateLimitReachedType: null,
  });

  assert.equal(headers['5h-utilization'], '0.2');
  assert.equal(headers['5h-reset'], '1799600000');
  assert.equal(headers['7d-utilization'], '0.7');
  assert.equal(headers['plan-type'], 'plus');
});

test('rateLimitsToHeaders rejects malformed, duplicate, or absent weekly windows', () => {
  assert.throws(
    () => rateLimitsToHeaders({
      primary: { usedPercent: 101, windowDurationMins: 10080, resetsAt: 1 },
    }),
    /usedPercent.*\[0, 100\]/,
  );
  assert.throws(
    () => rateLimitsToHeaders({
      primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1 },
      secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 2 },
    }),
    /duplicate 10080-minute/,
  );
  assert.throws(
    () => rateLimitsToHeaders({
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 },
    }),
    /10080-minute/,
  );
  assert.throws(
    () => rateLimitsToHeaders({
      ...WEEKLY_ONLY,
      planType: 'plus',
    }),
    /non-Pro.*no 300-minute/,
  );
});

function writeFakeAppServer(name, source) {
  const path = join(tmp, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

test('queryCodexRateLimits performs initialize then account/rateLimits/read', async () => {
  const fakeServer = writeFakeAppServer('fake-app-server.mjs', `#!/usr/bin/env node
let initialized = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
    } else if (message.method === 'initialized') {
      initialized = true;
    } else if (message.method === 'account/rateLimits/read') {
      if (!initialized) {
        process.stdout.write(JSON.stringify({
          id: message.id,
          error: { code: -1, message: 'read arrived before initialized' },
        }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({
          id: message.id,
          result: { rateLimits: ${JSON.stringify(WEEKLY_ONLY)} },
        }) + '\\n');
      }
    }
  }
});
`);

  const snapshot = await queryCodexRateLimits({
    command: process.execPath,
    commandArgs: [fakeServer],
    timeoutMs: 2_000,
  });
  assert.deepEqual(snapshot, WEEKLY_ONLY);
});

test('queryCodexRateLimits fails closed when the app server times out', async () => {
  await assert.rejects(
    queryCodexRateLimits({
      command: process.execPath,
      commandArgs: ['-e', 'process.stdin.resume()'],
      timeoutMs: 30,
    }),
    /timed out/i,
  );
});

function runCli(args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 5_000, ...options },
      (error, stdout, stderr) => resolvePromise({
        code: error ? error.code : 0,
        signal: error ? error.signal : null,
        stdout,
        stderr,
      }),
    );
  });
}

test('CLI delegates Claude output and exit status unchanged', async () => {
  const fakeHome = join(tmp, 'claude-home');
  const delegate = join(
    fakeHome,
    '.agents',
    'skills',
    'session-usage',
    'scripts',
    'check-usage.mjs',
  );
  mkdirSync(dirname(delegate), { recursive: true });
  writeFileSync(
    delegate,
    "process.stdout.write('delegated stdout\\n'); process.stderr.write('delegated stderr\\n'); process.exit(7);\n",
  );

  const result = await runCli(
    ['--source', 'claude', '--json'],
    { env: { ...process.env, HOME: fakeHome } },
  );
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'delegated stdout\n');
  assert.equal(result.stderr, 'delegated stderr\n');
});
