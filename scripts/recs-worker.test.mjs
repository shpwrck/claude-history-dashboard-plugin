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
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

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

// One rebuild round-trip against the worker; resolves the worker's reply. `extra`
// carries the optional #2718 surface/filters so a scoped rebuild can be exercised.
// Test-only `options.env` and `options.onLog` expose deterministic source-race
// gates without changing the production request protocol.
function workerRebuild(home, dbPath, extra = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      execArgv: ['--import', REGISTER],
      workerData: { projectDir: PROJECT_DIR },
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_DIR: join(home, '.claude'),
        CHD_DB_PATH: dbPath,
        ...(options.env ?? {}),
      },
    });
    const id = 1;
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('worker timed out'));
    }, 60_000);
    w.on('message', (msg) => {
      if (!msg || msg.type === 'ready') return;
      if (msg.type === 'log') {
        try {
          options.onLog?.(msg);
        } catch (err) {
          clearTimeout(timer);
          w.terminate();
          reject(err);
        }
        return;
      }
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
      ...extra,
    });
  });
}

function workerSuppressionDisposition(home, disposition) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, {
      execArgv: ['--import', REGISTER],
      workerData: { projectDir: PROJECT_DIR },
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_DIR: join(home, '.claude'),
        CHD_DB_PATH: join(
          tmpdir(),
          `chd-2196-worker-disposition-${randomUUID()}.db`
        ),
        CHD_RECS_CACHE_TEST_EVENTS: '1',
      },
    });
    const id = 1;
    const expectedMarker =
      disposition === 'accept'
        ? '[recs-cache-test] worker-suppression-accepted'
        : '[recs-cache-test] worker-suppression-discarded';
    const forbiddenMarker =
      disposition === 'accept'
        ? '[recs-cache-test] worker-suppression-discarded'
        : '[recs-cache-test] worker-suppression-accepted';
    let replied = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`worker ${disposition} acknowledgement timed out`)),
      60_000
    );
    w.on('error', finish);
    w.on('message', (msg) => {
      try {
        if (!msg || msg.type === 'ready') return;
        if (msg.type === 'log') {
          assert.notEqual(msg.message, forbiddenMarker);
          if (msg.message === expectedMarker) {
            assert.equal(replied, true, 'side effect starts only after a result reply');
            finish();
          }
          return;
        }
        assert.equal(msg.id, id);
        assert.equal(msg.ok, true);
        assert.equal(
          msg.suppressionEmissionId,
          id,
          'the stable dataset is staged under the request id'
        );
        assert.equal(replied, false, 'the worker replies exactly once');
        replied = true;
        w.postMessage({
          type:
            disposition === 'accept'
              ? 'accept-suppression-transitions'
              : 'discard-suppression-transitions',
          id: msg.suppressionEmissionId,
        });
      } catch (error) {
        finish(error);
      }
    });
    w.postMessage({
      id,
      project: null,
      organizationIdentity: null,
      emitSuppressionTransitions: true,
      adoptionReceiptsPath: join(
        home,
        '.claude',
        '.cache',
        'chd',
        'adoption-receipts.jsonl'
      ),
      shadowCallsDir: join(home, '.claude', 'shadow-calls'),
    });
  });
}

test('worker suppression side effects require parent acceptance', async () => {
  const home = buildFixtureHome();
  try {
    await workerSuppressionDisposition(home, 'discard');
    await workerSuppressionDisposition(home, 'accept');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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
      reply.docIssueCacheState,
      null,
      'flag-off worker result carries no snapshot cache state'
    );
    assert.equal(
      typeof reply.sourceSig,
      'string',
      'worker returns the source signature validated after the build'
    );
    assert.equal(
      reply.recursiveRemovalSafetyState,
      ingest.recursiveRemovalSafetyStateForServer(),
      'worker returns the canonical-containment state bound to its dataset'
    );
    assert.equal(
      reply.json,
      jsonInline,
      'worker recs body must be byte-identical to the inline build'
    );
    // The content-derived contentHash must match across the two independent DBs.
    assert.equal(reply.contentHash, ingest.ingest().contentHash, 'contentHash is DB-path-independent');
    assert.ok(
      Array.isArray(reply.guidanceTransitions) && reply.guidanceTransitions.length > 0,
      'worker returns guidance label transitions for parent-side clock refreshes'
    );
    assert.ok(
      reply.guidanceTransitions.every(
        (transition) =>
          typeof transition.guidanceId === 'string' &&
          transition.target &&
          (typeof transition.target.detectorId === 'string' ||
            typeof transition.target.category === 'string')
      ),
      'worker transition metadata binds each label clock to guidance identity and target'
    );
    assert.equal(
      typeof reply.guidanceCacheValidity,
      'object',
      'worker returns two-sided guidance cache validity metadata'
    );
    assert.ok(
      Object.hasOwn(reply.guidanceCacheValidity, 'after') &&
        Object.hasOwn(reply.guidanceCacheValidity, 'through'),
      'worker validity includes exclusive lower and inclusive upper bounds'
    );
    assert.deepEqual(
      reply.hookOverheadCacheValidity,
      { after: null, through: null },
      'worker returns Stop-hook timing cache validity metadata'
    );
    assert.equal(
      reply.hookOverheadConfigState,
      'inactive',
      'worker returns the current Stop-hook config gate state'
    );
    assert.deepEqual(
      reply.skillHookIntegrityCacheValidity,
      { after: null, through: null },
      'worker returns hook-path evidence cache validity metadata'
    );
  } finally {
    process.env.HOME = origHome;
    process.env.CHD_DB_PATH = origDb;
    if (origClaude === undefined) delete process.env.CLAUDE_DIR;
    else process.env.CLAUDE_DIR = origClaude;
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker returns the validated opt-in snapshot cache identity and expiry boundary', async () => {
  const home = buildFixtureHome();
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'chd-cache');
  const repo = 'acme/widgets';
  const refs = [101, 202];
  const asOf = new Date(Date.now() - 60_000).toISOString();
  const fingerprint = createHash('sha256')
    .update(`${repo}\n${refs.join(',')}`)
    .digest('hex');
  const snapshot = {
    repo,
    refs,
    records: [
      { number: 101, state: 'open' },
      { number: 202, state: 'closed' },
    ],
    asOf,
    complete: true,
    fingerprint,
  };
  try {
    mkdirSync(join(cacheRoot, 'doc-issues'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(
      join(docsRoot, 'REFERENCES.md'),
      'Tracked in #101 and resolved by #202.\n'
    );
    writeFileSync(
      join(cacheRoot, 'doc-issues', 'acme__widgets.json'),
      JSON.stringify(snapshot)
    );

    const reply = await workerRebuild(
      home,
      join(tmpdir(), `chd-2710-worker-${randomUUID()}.db`),
      {},
      {
        env: {
          CHD_CACHE_DIR: cacheRoot,
          CHD_DOC_GRAPH_ROOT: docsRoot,
          CHD_DOC_ISSUES: repo,
          CHD_DOC_ISSUES_TOKEN: 'fixture-token',
        },
      }
    );

    assert.deepEqual(
      JSON.parse(reply.docIssueCacheState.identity),
      {
        repo,
        refs,
        records: [
          [101, 'open'],
          [202, 'closed'],
        ],
        asOf,
        fingerprint,
      },
      'worker exposes the canonical identity of every detector-visible snapshot field'
    );
    assert.equal(
      reply.docIssueCacheState.usableThrough,
      Date.parse(asOf) + 24 * 60 * 60 * 1000,
      'worker exposes the inclusive 24-hour snapshot boundary for parent cache checks'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker discards a result when source state changes mid-build and retries once', async () => {
  const home = buildFixtureHome();
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  const gate = join(home, 'worker-source-race.fifo');
  try {
    const baseline = await workerRebuild(
      home,
      join(tmpdir(), `chd-2196-worker-baseline-${randomUUID()}.db`)
    );
    const fifo = spawnSync('mkfifo', [gate]);
    assert.equal(fifo.status, 0, String(fifo.stderr || ''));

    let retries = 0;
    const raced = await workerRebuild(
      home,
      join(tmpdir(), `chd-2196-worker-race-${randomUUID()}.db`),
      {},
      {
        env: {
          CHD_RECS_CACHE_TEST_EVENTS: '1',
          CHD_RECS_WORKER_TEST_AFTER_RECEIPTS_GATE: gate,
        },
        onLog(msg) {
          if (msg.message === '[recs-cache-test] worker-receipts-read') {
            writeFileSync(
              join(projectDir, 'sess-gamma.jsonl'),
              sessionJsonl({
                prompt: 'do the gamma thing',
                text: 'Gamma result.',
                toolName: 'Read',
                toolInput: { file_path: '/tmp/gamma.txt' },
                ts: '2026-01-03T00:00:00.000Z',
                model: 'claude-opus-4',
              })
            );
            // The worker is blocked reading this FIFO after posting the marker.
            writeFileSync(gate, 'release');
          }
          if (
            msg.message ===
            '[recs-worker] source changed during rebuild; retrying once'
          ) {
            retries += 1;
          }
        },
      }
    );

    assert.equal(retries, 1, 'one mid-build change triggers exactly one retry');
    assert.notEqual(
      raced.contentHash,
      baseline.contentHash,
      'the returned result reflects the source added while the first build was paused'
    );
    assert.notEqual(
      raced.sourceSig,
      baseline.sourceSig,
      'the reply carries the validated post-retry source signature'
    );
    assert.equal(
      raced.docIssueCacheState,
      null,
      'the source-race retry preserves the feature-off metadata shape'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker retries and binds the rebuilt body to changed skill containment state (#3377)', async () => {
  const home = buildFixtureHome();
  const claudeDir = join(home, '.claude');
  const skillsRoot = join(claudeDir, 'skills');
  const riskySkill = join(skillsRoot, 'risky-skill');
  const outsideSkill = join(home, 'outside', 'risky-skill');
  const gate = join(home, 'worker-skill-safety-race.fifo');
  for (const skill of ['safe-a', 'safe-b', 'risky-skill']) {
    mkdirSync(join(skillsRoot, skill), { recursive: true });
    writeFileSync(
      join(skillsRoot, skill, 'SKILL.md'),
      `---\ndescription: ${skill}\n---\n`
    );
  }
  mkdirSync(outsideSkill, { recursive: true });
  writeFileSync(
    join(outsideSkill, 'SKILL.md'),
    '---\ndescription: escaped risky skill\n---\n'
  );

  try {
    const { recursiveRemovalSafetySignature } = await import(
      `../src/lib/config-loader.ts?fixture=${randomUUID()}`
    );
    const containedState = recursiveRemovalSafetySignature({ claudeDir, homeDir: home });
    const skillsRootStat = statSync(skillsRoot);
    const fifo = spawnSync('mkfifo', [gate]);
    assert.equal(fifo.status, 0, String(fifo.stderr || ''));
    let retries = 0;
    const raced = await workerRebuild(
      home,
      join(tmpdir(), `chd-3377-worker-race-${randomUUID()}.db`),
      {},
      {
        env: {
          CHD_RECS_CACHE_TEST_EVENTS: '1',
          CHD_RECS_WORKER_TEST_AFTER_RECEIPTS_GATE: gate,
        },
        onLog(msg) {
          if (msg.message === '[recs-cache-test] worker-receipts-read') {
            rmSync(riskySkill, { recursive: true, force: true });
            symlinkSync(outsideSkill, riskySkill, 'dir');
            utimesSync(
              skillsRoot,
              skillsRootStat.atimeMs / 1_000,
              (Math.floor(skillsRootStat.mtimeMs) + 0.5) / 1_000
            );
            writeFileSync(gate, 'release');
          }
          if (
            msg.message ===
            '[recs-worker] source changed during rebuild; retrying once'
          ) {
            retries += 1;
          }
        },
      }
    );

    const escapedState = recursiveRemovalSafetySignature({ claudeDir, homeDir: home });
    assert.equal(retries, 1, 'the containment transition triggers one bounded retry');
    assert.equal(
      Math.floor(statSync(skillsRoot).mtimeMs),
      Math.floor(skillsRootStat.mtimeMs),
      'the race remains invisible to the skills-root stat mtime gate'
    );
    assert.notEqual(escapedState, containedState);
    assert.equal(
      raced.recursiveRemovalSafetyState,
      escapedState,
      'the accepted worker entry is bound to the rebuilt path graph'
    );
    const recommendations = JSON.parse(raced.json);
    const skillRecommendation = recommendations.find(
      (recommendation) => recommendation.id === 'workflow.unused-installed-skills'
    );
    assert.doesNotMatch(
      skillRecommendation?.fix?.snippet ?? '',
      new RegExp(`rm -rf -- '${riskySkill}'`)
    );
    assert.match(
      skillRecommendation?.fix?.snippet ?? '',
      /Refusing to generate an automatic recursive delete for skill risky-skill/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker serves the freshest result unsettled when only source state changes again during its retry', async () => {
  const home = buildFixtureHome();
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  const gate = join(home, 'worker-double-source-race.fifo');
  try {
    const baseline = await workerRebuild(
      home,
      join(tmpdir(), `chd-2196-worker-double-baseline-${randomUUID()}.db`)
    );
    const fifo = spawnSync('mkfifo', [gate]);
    assert.equal(fifo.status, 0, String(fifo.stderr || ''));

    let retryStarted = false;
    const raced = await workerRebuild(
      home,
      join(tmpdir(), `chd-2196-worker-double-race-${randomUUID()}.db`),
      {},
      {
        env: {
          CHD_RECS_CACHE_TEST_EVENTS: '1',
          CHD_RECS_WORKER_TEST_AFTER_RECEIPTS_GATE: gate,
        },
        onLog(msg) {
          if (msg.message === '[recs-cache-test] worker-receipts-read') {
            writeFileSync(
              join(projectDir, 'sess-gamma.jsonl'),
              sessionJsonl({
                prompt: 'first concurrent change',
                text: 'Gamma result.',
                toolName: 'Read',
                toolInput: { file_path: '/tmp/gamma.txt' },
                ts: '2026-01-03T00:00:00.000Z',
                model: 'claude-opus-4',
              })
            );
            writeFileSync(gate, 'release');
          }
          if (
            msg.message ===
            '[recs-worker] source changed during rebuild; retrying once'
          ) {
            retryStarted = true;
            writeFileSync(
              join(projectDir, 'sess-delta.jsonl'),
              sessionJsonl({
                prompt: 'second concurrent change',
                text: 'Delta result.',
                toolName: 'Read',
                toolInput: { file_path: '/tmp/delta.txt' },
                ts: '2026-01-04T00:00:00.000Z',
                model: 'claude-opus-4',
              })
            );
          }
        },
      }
    );
    assert.equal(retryStarted, true, 'the second mutation lands during the bounded retry');
    assert.notEqual(
      raced.contentHash,
      baseline.contentHash,
      'the final reply serves the fresher retry build rather than the pre-churn build'
    );
    assert.equal(
      raced.sourceSig,
      null,
      'the source-racy reply is explicitly unsettled and cannot become a signature hit'
    );
    assert.equal(raced.docIssueCacheState, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker still fails closed when document-issue trust state changes during the final retry', async () => {
  const home = buildFixtureHome();
  const projectDir = join(home, '.claude', 'projects', '-tmp-proj');
  const docsRoot = join(home, 'docs-root');
  const cacheRoot = join(home, 'chd-cache');
  const snapshotPath = join(cacheRoot, 'doc-issues', 'acme__widgets.json');
  const gate = join(home, 'worker-doc-trust-race.fifo');
  const repo = 'acme/widgets';
  const refs = [101];
  const makeSnapshot = (state, asOf) => ({
    repo,
    refs,
    records: [{ number: 101, state }],
    asOf,
    complete: true,
    fingerprint: createHash('sha256')
      .update(`${repo}\n${refs.join(',')}`)
      .digest('hex'),
  });
  try {
    mkdirSync(join(cacheRoot, 'doc-issues'), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    writeFileSync(join(docsRoot, 'REFERENCES.md'), 'Tracked in #101.\n');
    writeFileSync(
      snapshotPath,
      JSON.stringify(makeSnapshot('open', new Date(Date.now() - 60_000).toISOString()))
    );
    const fifo = spawnSync('mkfifo', [gate]);
    assert.equal(fifo.status, 0, String(fifo.stderr || ''));

    let retryStarted = false;
    await assert.rejects(
      workerRebuild(
        home,
        join(tmpdir(), `chd-2196-worker-doc-trust-race-${randomUUID()}.db`),
        {},
        {
          env: {
            CHD_CACHE_DIR: cacheRoot,
            CHD_DOC_GRAPH_ROOT: docsRoot,
            CHD_DOC_ISSUES: repo,
            CHD_DOC_ISSUES_TOKEN: 'fixture-token',
            CHD_RECS_CACHE_TEST_EVENTS: '1',
            CHD_RECS_WORKER_TEST_AFTER_RECEIPTS_GATE: gate,
          },
          onLog(msg) {
            if (msg.message === '[recs-cache-test] worker-receipts-read') {
              writeFileSync(
                join(projectDir, 'sess-gamma.jsonl'),
                sessionJsonl({
                  prompt: 'trigger the bounded retry',
                  text: 'Gamma result.',
                  toolName: 'Read',
                  toolInput: { file_path: '/tmp/gamma.txt' },
                  ts: '2026-01-03T00:00:00.000Z',
                  model: 'claude-opus-4',
                })
              );
              writeFileSync(gate, 'release');
            }
            if (
              msg.message ===
              '[recs-worker] source changed during rebuild; retrying once'
            ) {
              retryStarted = true;
              writeFileSync(
                snapshotPath,
                JSON.stringify(
                  makeSnapshot(
                    'closed',
                    new Date(Date.now() - 30_000).toISOString()
                  )
                )
              );
            }
          },
        }
      ),
      /source state changed across the bounded rebuild retry/i
    );
    assert.equal(retryStarted, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// #2718: the scoped-surface rebuild must be byte-identical off-thread too, so a
// worker-served { recommendations, domainCoverage } envelope matches the inline
// build — the same auditable-recs guarantee, extended to the typed surfaces.
test('worker scoped-surface rebuilds are byte-identical to inline for both surfaces (#2718)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origClaude = process.env.CLAUDE_DIR;
  const home = buildFixtureHome();
  const cases = [
    {
      surface: 'global',
      filters: { dashboardTime: 'all', dashboardProject: 'All projects' },
      organizationIdentity: {
        source: 'worker-parity-fixture',
        contributors: [
          {
            id: 'u-fixture',
            displayName: 'Fixture User',
            aliases: [{ kind: 'username', value: 'fixture-user' }],
          },
        ],
      },
    },
    {
      surface: 'reclaim-compass',
      filters: {
        dashboardTime: 'all',
        dashboardProject: 'All projects',
        routeMode: 'opus',
      },
    },
  ];
  try {
    process.env.HOME = home;
    process.env.CLAUDE_DIR = join(home, '.claude');
    process.env.CHD_DB_PATH = join(tmpdir(), `chd-2718-inline-${randomUUID()}.db`);
    const ingest = await import(`./ingest.mjs?fixture=${randomUUID()}`);
    const { safeJsonStringify } = await import(`../src/lib/json-safe.ts?fixture=${randomUUID()}`);
    ingest.ingest();
    for (const { surface, filters, organizationIdentity = null } of cases) {
      const result = ingest.assembleScopedRecommendationResult(surface, filters, {
        organizationIdentity,
      });
      const jsonInline = safeJsonStringify(result);
      assert.ok(
        Array.isArray(result.recommendations),
        `${surface} inline result has recommendations[]`
      );
      assert.equal(
        result.domainCoverage.length,
        6,
        `${surface} inline result has 6 coverage domains`
      );

      const reply = await workerRebuild(
        home,
        join(tmpdir(), `chd-2718-worker-${randomUUID()}.db`),
        { surface, filters, organizationIdentity }
      );
      assert.equal(reply.ok, true, `worker replied ok for ${surface}`);
      assert.equal(
        reply.json,
        jsonInline,
        `${surface} worker envelope must be byte-identical to the inline build`
      );
    }
  } finally {
    process.env.HOME = origHome;
    process.env.CHD_DB_PATH = origDb;
    if (origClaude === undefined) delete process.env.CLAUDE_DIR;
    else process.env.CLAUDE_DIR = origClaude;
    rmSync(home, { recursive: true, force: true });
  }
});
