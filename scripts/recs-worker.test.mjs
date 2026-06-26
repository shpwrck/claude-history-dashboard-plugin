// recs-worker byte-identity + round-trip contract (#2196, epic #2181).
//
// The off-main-thread rebuild worker (scripts/recs-worker.mjs) must produce a
// recs body BYTE-IDENTICAL to the inline build for the same ~/.claude state —
// otherwise moving the rebuild off-thread would silently change /api/recommendations.json
// (the auditable-recs contract). The worker runs an INDEPENDENT ingest pipeline
// with its OWN SQLite cache (worker-private CHD_DB_PATH), so this also proves the
// content-derived output is DB-path-independent.
//
// Run: node --import ./scripts/register-ts.mjs --test scripts/recs-worker.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = join(SCRIPTS_DIR, 'register-ts.mjs');
const WORKER = join(SCRIPTS_DIR, 'recs-worker.mjs');

function assistantLine({ text, toolName, toolInput, ts, model }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, input: toolInput },
      ],
    },
  });
}
const userLine = (text, ts) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const sessionJsonl = (s) => [userLine(s.prompt, s.ts), assistantLine(s)].join('\n') + '\n';

const SESSIONS = {
  'sess-alpha': { prompt: 'do the alpha thing', text: 'Alpha answer.', toolName: 'Read', toolInput: { file_path: '/tmp/a.txt' }, ts: '2026-01-01T00:00:00.000Z', model: 'claude-opus-4' },
  'sess-beta': { prompt: 'do the beta thing', text: 'Beta result.', toolName: 'Bash', toolInput: { command: 'ls /tmp' }, ts: '2026-01-02T00:00:00.000Z', model: 'claude-sonnet-4' },
};

function buildFixtureHome() {
  const home = join(tmpdir(), `chd-2196-home-${randomUUID()}`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });
  for (const [sid, spec] of Object.entries(SESSIONS)) {
    writeFileSync(join(proj, `${sid}.jsonl`), sessionJsonl(spec));
  }
  writeFileSync(join(home, '.claude', 'history.jsonl'), '');
  return home;
}

// One rebuild round-trip against the worker; resolves the worker's reply.
function workerRebuild(home, dbPath) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      execArgv: ['--import', REGISTER],
      workerData: { projectDir: PROJECT_DIR },
      env: { ...process.env, HOME: home, CLAUDE_DIR: join(home, '.claude'), CHD_DB_PATH: dbPath },
    });
    const id = 1;
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('worker timed out'));
    }, 60_000);
    w.on('message', (msg) => {
      if (!msg || msg.type === 'ready' || msg.type === 'log') return;
      clearTimeout(timer);
      w.terminate();
      if (msg.id === id && msg.ok) resolve(msg);
      else reject(new Error(msg.error || 'worker error'));
    });
    w.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    w.postMessage({
      id,
      project: null,
      organizationIdentity: null,
      emitSuppressionTransitions: false,
      adoptionReceiptsPath: join(home, '.claude', '.cache', 'chd', 'adoption-receipts.jsonl'),
      shadowCallsDir: join(home, '.claude', 'shadow-calls'),
    });
  });
}

test('worker rebuild is byte-identical to the inline build (#2196)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origClaude = process.env.CLAUDE_DIR;
  const home = buildFixtureHome();
  try {
    // Inline build in THIS process (its own DB).
    process.env.HOME = home;
    process.env.CLAUDE_DIR = join(home, '.claude');
    process.env.CHD_DB_PATH = join(tmpdir(), `chd-2196-inline-${randomUUID()}.db`);
    const ingest = await import(`./ingest.mjs?fixture=${randomUUID()}`);
    const { safeJsonStringify } = await import(`../src/lib/json-safe.ts?fixture=${randomUUID()}`);
    ingest.ingest();
    const recs = ingest.assembleRecommendations();
    const jsonInline = safeJsonStringify(recs);
    assert.ok(jsonInline.length > 0, 'inline build produced a body');

    // Worker build in a SEPARATE thread with its OWN db over the same corpus.
    const reply = await workerRebuild(home, join(tmpdir(), `chd-2196-worker-${randomUUID()}.db`));
    assert.equal(reply.ok, true, 'worker replied ok');
    assert.equal(
      reply.json,
      jsonInline,
      'worker recs body must be byte-identical to the inline build'
    );
    // The content-derived contentHash must match across the two independent DBs.
    assert.equal(reply.contentHash, ingest.ingest().contentHash, 'contentHash is DB-path-independent');
  } finally {
    process.env.HOME = origHome;
    process.env.CHD_DB_PATH = origDb;
    if (origClaude === undefined) delete process.env.CLAUDE_DIR;
    else process.env.CLAUDE_DIR = origClaude;
    rmSync(home, { recursive: true, force: true });
  }
});
