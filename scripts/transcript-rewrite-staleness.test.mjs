#!/usr/bin/env node
// #3401: a transcript rewritten in place to the SAME byte length with its
// mtime RESTORED (utimes) must not keep serving the stale cached parse — and
// closing that hole must not cost the incremental-ingest guarantee (unchanged
// transcripts are never re-read byte-wise; #3394 was carved out for exactly
// that regression). Run under the ts-resolver loader with --test:
//   node --import ./scripts/register-ts.mjs --test scripts/transcript-rewrite-staleness.test.mjs
//
// What it proves:
//   (a) OUTER GATE, REAL SERVER. Against the booted server (the exact
//       handleDatasetJson stat-gate path), a same-length, mtime-restored
//       rewrite of an already-served transcript — which moves neither the
//       parent dir mtime nor the file's size/mtime — causes the session to be
//       reparsed and the served /api/dataset.json to reflect the new content.
//   (b) LEVEL TRIGGER, NOT EDGE (PR #3633 review blocker). The rewrite
//       evidence survives being "consumed" by whichever route ingests first:
//       an interleaved /api/search (whose build runs ingest() and swaps the
//       baseline) must NOT quiesce the signature back to the dataset gate's
//       settled value — the dataset route still converges. And a dataset
//       refresh that FAILS after its ingest committed (real
//       DASHBOARD_DATASET_RESPONSE_MAX_BYTES overflow) must keep retrying on
//       later requests instead of settling on the stale body.
//   (c) INCREMENTAL INGEST. Creating ONE new session reparses and byte-reads
//       exactly ONE session; a warm unchanged re-ingest reads ZERO transcript
//       files (the literal cost assertion that keeps the local-first fast path
//       from silently regressing into a full-corpus scan).
//   (d) DISCRIMINATOR SEMANTICS. The rewrite moves sourceSignature() (via the
//       transcript-rewrites part) and the per-session signature (via ctime);
//       an ordinary append moves NEITHER; repeated observation of the same
//       pending rewrite does not re-move the signature (no thrash); after the
//       triggered ingest the signature stays at the moved level (it must NOT
//       revert, or independent consumers would skip-serve stale forever).
//   (e) BOUNDED PRUNING THAT CANNOT REVERT. The epoch map is pruned only for
//       files that genuinely vanished; a rewritten transcript that left the
//       ingest baseline while still on disk (skip-listed for exceeding
//       INGEST_SESSION_MAX_BYTES) keeps its level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(SCRIPTS_DIR, '..');
const REGISTER = './scripts/register-ts.mjs';
const SERVER = 'scripts/server.mjs';

// Fixed epoch second used to pin (and later restore) transcript mtimes. An
// integer keeps mtimeMs exactly reproducible across the two utimes calls, so
// the fixture proves the rewrite is genuinely invisible to a size+mtime gate.
const PINNED_EPOCH_S = 1_750_000_000;

function userLine(text, ts, cwd) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    ...(cwd ? { cwd } : {}),
    message: { role: 'user', content: text },
  });
}

function assistantLine(text, ts) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'text', text }],
    },
  });
}

function sessionJsonl(prompt, ts, cwd) {
  return [userLine(prompt, ts, cwd), assistantLine('done', ts)].join('\n') + '\n';
}

function writePinnedSession(path, content) {
  writeFileSync(path, content);
  utimesSync(path, PINNED_EPOCH_S, PINNED_EPOCH_S);
}

// Rewrite `path` in place (same inode path, no rename — the parent dir mtime
// must NOT move) and restore the pinned mtime, exactly the maneuver #3401
// describes. Asserts the fixture really is invisible to a size+mtime gate.
function rewriteRestoringMtime(path, content, before = statSync(path)) {
  writeFileSync(path, content);
  utimesSync(path, PINNED_EPOCH_S, PINNED_EPOCH_S);
  const after = statSync(path);
  assert.equal(after.size, before.size, 'rewrite must keep the byte length');
  assert.equal(
    after.mtimeMs,
    before.mtimeMs,
    'utimes must restore the exact mtime the signature reads'
  );
  assert.notEqual(
    after.ctimeMs,
    before.ctimeMs,
    'the rewrite + utimes must advance ctime (the discriminator)'
  );
  return after;
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

async function waitUp(base, proc) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (proc.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.status === 200) return true;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared real-server scaffolding (pattern from config-removal-cache-safety):
// throwaway HOME with a projects tree, dist stub, isolated cache paths, every
// opt-in feature off. `extraEnv` lets a test add knobs (e.g. the dataset
// response byte cap for the failed-refresh reproduction).
function buildFixtureTree(testRoot) {
  const claudeDir = join(testRoot, '.claude');
  const projDir = join(claudeDir, 'projects', 'demo');
  const distDir = join(testRoot, 'dist');
  const cacheDir = join(testRoot, 'cache');
  mkdirSync(projDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  writeFileSync(join(claudeDir, 'history.jsonl'), '');
  writeFileSync(join(testRoot, '.claude.json'), JSON.stringify({ projects: {} }));
  return { claudeDir, projDir, distDir, cacheDir };
}

function spawnFixtureServer({ testRoot, claudeDir, distDir, cacheDir, port, extraEnv = {} }) {
  const logs = { stdout: '', stderr: '' };
  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      HOME: testRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      CLAUDE_DIR: claudeDir,
      CLAUDE_HOME_DIR: testRoot,
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
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (chunk) => {
    logs.stdout += String(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    logs.stderr += String(chunk);
  });
  return { proc, logs };
}

async function stopServer(proc) {
  if (proc.exitCode === null) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
}

async function fetchDataset(base) {
  const response = await fetch(`${base}/api/dataset.json`);
  assert.equal(response.status, 200);
  const text = await response.text();
  return {
    dataset: JSON.parse(text),
    bytes: Buffer.byteLength(text),
    xIngest: response.headers.get('x-ingest'),
  };
}

function datasetHasMarker(dataset, marker) {
  return (dataset.entries ?? []).some((e) => e.display?.includes(marker));
}

// Poll /api/dataset.json until the warm skip path is reached — the exact gate
// state the rewrite has to move.
async function settleWarmSkip(base) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { xIngest } = await fetchDataset(base);
    if (xIngest === 'skipped=true;cached=true') return true;
    await sleep(250);
  }
  return false;
}

// Poll /api/dataset.json (stale-while-revalidate) until the marker appears.
async function pollForMarker(base, marker, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { dataset } = await fetchDataset(base);
    if (datasetHasMarker(dataset, marker)) return true;
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------------------
// (a) The real outer gate: booted server, /api/dataset.json, no interleaver.
// ---------------------------------------------------------------------------
test('a same-size, mtime-restored transcript rewrite refreshes the served dataset (#3401)', { timeout: 60_000 }, async () => {
  const testRoot = join(tmpdir(), `chd-3401-server-${randomUUID()}`);
  const tree = buildFixtureTree(testRoot);
  const sessionPath = join(tree.projDir, 'session-rewrite.jsonl');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // Marker swap keeps the byte length identical: 'ONE' -> 'TWO'.
  const beforeBody = sessionJsonl('alpha rewrite probe ONE', '2026-07-20T00:00:00.000Z');
  const afterBody = sessionJsonl('alpha rewrite probe TWO', '2026-07-20T00:00:00.000Z');
  assert.equal(
    Buffer.byteLength(afterBody),
    Buffer.byteLength(beforeBody),
    'fixture rewrite must be same-length'
  );
  writePinnedSession(sessionPath, beforeBody);

  const { proc, logs } = spawnFixtureServer({ testRoot, ...tree, port });
  try {
    assert.equal(
      await waitUp(base, proc),
      true,
      [logs.stdout, logs.stderr].filter(Boolean).join('\n').slice(-4_000)
    );

    const first = await fetchDataset(base);
    assert.ok(
      datasetHasMarker(first.dataset, 'probe ONE'),
      'primed dataset must carry the original transcript content'
    );
    assert.equal(
      await settleWarmSkip(base),
      true,
      'the stat-gate must settle into skip-serving before the rewrite'
    );

    // The maneuver: in-place same-length rewrite, mtime restored. The parent
    // dir mtime must not move — that is the hole the fix closes.
    const dirMtimeBefore = statSync(tree.projDir).mtimeMs;
    await sleep(20); // ensure a distinguishable ctime on coarse clocks
    rewriteRestoringMtime(sessionPath, afterBody);
    assert.equal(
      statSync(tree.projDir).mtimeMs,
      dirMtimeBefore,
      'the in-place rewrite must leave the project dir mtime untouched'
    );

    assert.equal(
      await pollForMarker(base, 'probe TWO'),
      true,
      'the same-size, same-mtime rewrite must be reparsed and served, not skip-served stale'
    );
  } finally {
    await stopServer(proc);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b1) Level trigger, Variant A: an interleaved ingesting route must not
// consume the rewrite evidence out from under the dataset gate.
// ---------------------------------------------------------------------------
test('an interleaved /api/search ingest does not quiesce the rewrite trigger; the dataset still converges and then holds steady (#3401 review Variant A)', { timeout: 60_000 }, async () => {
  const testRoot = join(tmpdir(), `chd-3401-interleave-${randomUUID()}`);
  const tree = buildFixtureTree(testRoot);
  const sessionPath = join(tree.projDir, 'session-rewrite.jsonl');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const beforeBody = sessionJsonl('alpha rewrite probe ONE', '2026-07-20T00:00:00.000Z');
  const afterBody = sessionJsonl('alpha rewrite probe TWO', '2026-07-20T00:00:00.000Z');
  assert.equal(Buffer.byteLength(afterBody), Buffer.byteLength(beforeBody));
  writePinnedSession(sessionPath, beforeBody);

  const { proc, logs } = spawnFixtureServer({ testRoot, ...tree, port });
  try {
    assert.equal(
      await waitUp(base, proc),
      true,
      [logs.stdout, logs.stderr].filter(Boolean).join('\n').slice(-4_000)
    );
    const first = await fetchDataset(base);
    assert.ok(datasetHasMarker(first.dataset, 'probe ONE'));
    assert.equal(await settleWarmSkip(base), true);

    await sleep(20);
    rewriteRestoringMtime(sessionPath, afterBody);

    // The interleaver: search's stat-gated build runs ingest() (it must, to
    // learn contentHash), which swaps the ingest-side baseline BEFORE the
    // dataset route ever sees the rewrite. With an edge-triggered part this
    // consumed the one-shot evidence and the dataset skip-served stale forever.
    let searchSawRewrite = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const searchResponse = await fetch(
        `${base}/api/search?q=${encodeURIComponent('rewrite probe')}`
      );
      assert.equal(searchResponse.status, 200);
      const payload = await searchResponse.json();
      if (
        (payload.results ?? []).some((r) => r.entry?.display?.includes('probe TWO'))
      ) {
        searchSawRewrite = true;
        break;
      }
      await sleep(250);
    }
    assert.equal(
      searchSawRewrite,
      true,
      'the interleaved search must observe the rewritten content (its build ingested)'
    );

    // Level property: the dataset gate still converges even though another
    // consumer's ingest() already ran.
    assert.equal(
      await pollForMarker(base, 'probe TWO'),
      true,
      'the dataset route must converge on the rewrite even after another route ingested first'
    );

    // No-thrash guard: with no further rewrite, the signature must settle at
    // its moved level — repeated requests skip-serve instead of rebuilding.
    assert.equal(
      await settleWarmSkip(base),
      true,
      'the gate must re-settle into skip-serving after convergence'
    );
    for (let i = 0; i < 3; i += 1) {
      const { dataset, xIngest } = await fetchDataset(base);
      assert.equal(
        xIngest,
        'skipped=true;cached=true',
        'repeated requests with no further rewrite must skip-serve (no rebuild loop)'
      );
      assert.ok(datasetHasMarker(dataset, 'probe TWO'));
      await sleep(100);
    }
  } finally {
    await stopServer(proc);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b2) Level trigger, Variant B: a dataset refresh that FAILS after its
// ingest() committed must keep retrying on later requests — never settle on
// the stale body. Failure is real: the rewritten corpus grows the serialized
// dataset past DASHBOARD_DATASET_RESPONSE_MAX_BYTES, so buildDatasetCache
// throws its anticipated too-large error AFTER ingest committed and swapped
// the baseline. A second same-size rewrite then shrinks it back and the gate
// must converge.
// ---------------------------------------------------------------------------
function paddedBodies() {
  const ts = '2026-07-20T00:00:00.000Z';
  // Small bodies: one user entry. Big body: 20 user entries, each with a
  // ~150-char prompt, which grows the served dataset by several KB while the
  // FILE byte length stays identical (assistant-text padding is not served).
  const filler = (i) =>
    `variant-b filler entry ${String(i).padStart(2, '0')} ${'x'.repeat(120)}`;
  const makeSmall = (marker) => (pad) =>
    [userLine(`variant-b ${marker}`, ts), assistantLine(`done${pad}`, ts)].join('\n') + '\n';
  const makeBig = (pad) =>
    [
      ...Array.from({ length: 19 }, (_, i) => userLine(filler(i), ts)),
      userLine('variant-b probe BIG', ts),
      assistantLine(`done${pad}`, ts),
    ].join('\n') + '\n';
  const makers = [makeSmall('probe ONE'), makeSmall('probe THREE'), makeBig];
  const target = Math.max(...makers.map((make) => Buffer.byteLength(make('')))) + 8;
  const pad = (make) => make('x'.repeat(target - Buffer.byteLength(make(''))));
  const bodies = {
    one: pad(makers[0]),
    three: pad(makers[1]),
    big: pad(makers[2]),
  };
  assert.equal(Buffer.byteLength(bodies.one), target);
  assert.equal(Buffer.byteLength(bodies.three), target);
  assert.equal(Buffer.byteLength(bodies.big), target);
  return bodies;
}

test('a failed dataset refresh after a committed ingest keeps retrying and converges later (#3401 review Variant B)', { timeout: 90_000 }, async () => {
  const bodies = paddedBodies();

  // Boot 1 (no cap): measure the serialized dataset size for the small corpus
  // so boot 2 can pin a cap BETWEEN the small and big corpus sizes. The big
  // corpus adds 19 user entries (~150 chars each = several KB above the ~3KB
  // margin used here), so the ordering is robust to run-to-run size jitter.
  const rootA = join(tmpdir(), `chd-3401-vb-measure-${randomUUID()}`);
  const treeA = buildFixtureTree(rootA);
  writePinnedSession(join(treeA.projDir, 'session-vb.jsonl'), bodies.one);
  const portA = await freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  let smallBytes;
  {
    const { proc, logs } = spawnFixtureServer({ testRoot: rootA, ...treeA, port: portA });
    try {
      assert.equal(
        await waitUp(baseA, proc),
        true,
        [logs.stdout, logs.stderr].filter(Boolean).join('\n').slice(-4_000)
      );
      const measured = await fetchDataset(baseA);
      assert.ok(datasetHasMarker(measured.dataset, 'probe ONE'));
      smallBytes = measured.bytes;
    } finally {
      await stopServer(proc);
      rmSync(rootA, { recursive: true, force: true });
    }
  }

  // Boot 2: cap between the small and big corpus serializations.
  const cap = smallBytes + 3_000;
  const testRoot = join(tmpdir(), `chd-3401-vb-${randomUUID()}`);
  const tree = buildFixtureTree(testRoot);
  const sessionPath = join(tree.projDir, 'session-vb.jsonl');
  writePinnedSession(sessionPath, bodies.one);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { proc, logs } = spawnFixtureServer({
    testRoot,
    ...tree,
    port,
    extraEnv: { DASHBOARD_DATASET_RESPONSE_MAX_BYTES: String(cap) },
  });
  try {
    assert.equal(
      await waitUp(base, proc),
      true,
      [logs.stdout, logs.stderr].filter(Boolean).join('\n').slice(-4_000)
    );
    const first = await fetchDataset(base);
    assert.ok(
      datasetHasMarker(first.dataset, 'probe ONE'),
      'the small corpus must fit under the cap and serve (fixture guarantee)'
    );
    assert.equal(await settleWarmSkip(base), true);

    // Rewrite 1: same-size, mtime-restored, but the parsed corpus now yields
    // 20 entries — the background rebuild's ingest() COMMITS, then the
    // dataset serialization exceeds the cap and the refresh FAILS.
    await sleep(20);
    rewriteRestoringMtime(sessionPath, bodies.big);
    const kicked = await fetchDataset(base);
    assert.ok(
      datasetHasMarker(kicked.dataset, 'probe ONE'),
      'SWR still serves the last-good body while the refresh runs'
    );
    assert.notEqual(kicked.xIngest, 'skipped=true;cached=true');

    // Let the failed refresh complete, then probe: every subsequent request
    // must KEEP RETRYING (stale=..., never skipped=true). With the edge
    // trigger, the failed refresh's committed ingest quiesced the signature
    // and these requests settled at skipped=true on the pre-rewrite body.
    await sleep(700);
    for (let i = 0; i < 3; i += 1) {
      const probe = await fetchDataset(base);
      assert.notEqual(
        probe.xIngest,
        'skipped=true;cached=true',
        'a failed refresh after a committed ingest must not settle the stale body'
      );
      assert.ok(
        datasetHasMarker(probe.dataset, 'probe ONE'),
        'until a rebuild succeeds, the last-good body is served (SWR), not a broken one'
      );
      await sleep(300);
    }

    // Rewrite 2: same maneuver back to a small corpus — the next retry's
    // rebuild fits the cap and the gate must converge, then settle.
    await sleep(20);
    rewriteRestoringMtime(sessionPath, bodies.three);
    assert.equal(
      await pollForMarker(base, 'probe THREE'),
      true,
      'once a rebuild can succeed, the retried refresh must converge on the newest content'
    );
    assert.equal(
      await settleWarmSkip(base),
      true,
      'after convergence the gate settles again (no rebuild loop)'
    );
  } finally {
    await stopServer(proc);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) + (d): ingest-level incremental guarantee and discriminator semantics.
// ---------------------------------------------------------------------------
async function loadIngest(home, dbPath) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = dbPath;
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

test('incremental ingest stays byte-read-free for unchanged transcripts; the rewrite is stat-detected and LEVEL-triggered (#3401)', { timeout: 120_000 }, async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const home = join(tmpdir(), `chd-3401-home-${randomUUID()}`);
  const dbPath = join(tmpdir(), `chd-3401-db-${randomUUID()}.db`);
  const proj = join(home, '.claude', 'projects', '-tmp-proj');
  mkdirSync(proj, { recursive: true });

  const sessions = {
    'sess-alpha': 'alpha probe marker ONE',
    'sess-beta': 'beta steady prompt',
    'sess-gamma': 'gamma steady prompt',
  };
  for (const [sid, prompt] of Object.entries(sessions)) {
    writePinnedSession(
      join(proj, `${sid}.jsonl`),
      sessionJsonl(prompt, '2026-01-01T00:00:00.000Z')
    );
  }

  try {
    const ingest = await loadIngest(home, dbPath);
    // No query string: the SAME module instance ingest.mjs itself imports, so
    // the counter observes exactly the byte reads ingest() performs.
    const blobRow = await import('./session-blob-row.mjs');

    // Cold: every session parsed, every top file read once.
    blobRow._resetSessionFileReadCount();
    const cold = ingest.ingest();
    assert.equal(cold.reparsed, 3);
    assert.equal(blobRow._getSessionFileReadCount(), 3);

    // (c) cost assertion: warm unchanged re-ingest reads ZERO transcript files.
    blobRow._resetSessionFileReadCount();
    const warm = ingest.ingest();
    assert.equal(warm.reparsed, 0, 'unchanged corpus must not reparse');
    assert.equal(
      blobRow._getSessionFileReadCount(),
      0,
      'unchanged corpus must not read a single transcript byte'
    );
    assert.equal(warm.contentHash, cold.contentHash);

    // (c) one NEW session in the corpus: exactly one parse, one file read.
    writePinnedSession(
      join(proj, 'sess-delta.jsonl'),
      sessionJsonl('delta new arrival', '2026-01-02T00:00:00.000Z')
    );
    blobRow._resetSessionFileReadCount();
    const oneNew = ingest.ingest();
    assert.equal(oneNew.reparsed, 1, 'only the new session is parsed');
    assert.equal(
      blobRow._getSessionFileReadCount(),
      1,
      'a new session must not trigger byte reads of unchanged transcripts'
    );

    // The settled outer signature is idempotent and rewrite-quiet.
    const settledSig = ingest.sourceSignature();
    assert.equal(settledSig, ingest.sourceSignature());
    assert.match(settledSig, /transcript-rewrites:none/);

    // (d) accepted append-lag is UNCHANGED: an in-place append moves neither
    // the dir mtime nor the rewrite part, so the outer signature holds still.
    await sleep(20);
    appendFileSync(
      join(proj, 'sess-beta.jsonl'),
      userLine('beta appended turn', '2026-01-03T00:00:00.000Z') + '\n'
    );
    assert.equal(
      ingest.sourceSignature(),
      settledSig,
      'an ordinary append must not move the outer signature (#182 append-lag)'
    );
    const afterAppend = ingest.ingest();
    assert.equal(afterAppend.reparsed, 1, 'the append reparses via the per-row sig');
    const appendSettledSig = ingest.sourceSignature();
    assert.equal(
      appendSettledSig,
      settledSig,
      'the outer signature settles back after the append is ingested'
    );

    // (d) the maneuver: same-length rewrite of sess-alpha, mtime restored.
    const alphaPath = join(proj, 'sess-alpha.jsonl');
    const alphaSession = {
      topPath: alphaPath,
      subPaths: [],
      sessionId: 'sess-alpha',
      project: '-tmp-proj',
    };
    const sigBeforeRewrite = ingest.sessionFileSignature(alphaSession);
    await sleep(20);
    const rewritten = sessionJsonl(
      'alpha probe marker TWO',
      '2026-01-01T00:00:00.000Z'
    );
    rewriteRestoringMtime(alphaPath, rewritten);

    // Inner half: the per-session signature moves on ctime alone.
    assert.notEqual(
      ingest.sessionFileSignature(alphaSession),
      sigBeforeRewrite,
      'the per-session signature must discriminate the rewrite via ctime'
    );

    // Outer half: the request-time gate observes it without reading bytes.
    blobRow._resetSessionFileReadCount();
    const rewriteSig = ingest.sourceSignature();
    assert.equal(
      blobRow._getSessionFileReadCount(),
      0,
      'the outer gate is stat-only — detection must cost zero byte reads'
    );
    assert.notEqual(
      rewriteSig,
      appendSettledSig,
      'the rewrite must move the outer signature'
    );
    assert.doesNotMatch(rewriteSig, /transcript-rewrites:none/);

    // (d) no-thrash: re-observing the SAME pending rewrite must not keep
    // moving the signature (no epoch re-bump per request).
    assert.equal(ingest.sourceSignature(), rewriteSig);
    assert.equal(ingest.sourceSignature(), rewriteSig);

    // The triggered ingest reparses EXACTLY the rewritten session and the
    // served content identity moves.
    blobRow._resetSessionFileReadCount();
    const afterRewrite = ingest.ingest();
    assert.equal(afterRewrite.reparsed, 1, 'only the rewritten session reparses');
    assert.equal(
      blobRow._getSessionFileReadCount(),
      1,
      'only the rewritten transcript is re-read'
    );
    assert.notEqual(
      afterRewrite.contentHash,
      afterAppend.contentHash,
      'the rewritten content must reach the dataset content hash'
    );

    // (d) LEVEL, not edge (#3633 review blocker): the signature must NOT
    // revert to its pre-rewrite value just because ingest() committed —
    // otherwise any consumer that had settled on the pre-rewrite signature
    // (the dataset gate, when a search/digest/recs ingest ran first) would
    // match again and skip-serve the stale body forever. It stays at the
    // moved value, stably.
    const postIngestSig = ingest.sourceSignature();
    assert.equal(
      postIngestSig,
      rewriteSig,
      'the moved signature must persist across the ingest (level trigger)'
    );
    assert.notEqual(
      postIngestSig,
      appendSettledSig,
      'the signature must never return to its pre-rewrite settled value'
    );
    assert.equal(postIngestSig, ingest.sourceSignature());
    const settled = ingest.ingest();
    assert.equal(settled.reparsed, 0);
    assert.equal(settled.contentHash, afterRewrite.contentHash);
    assert.equal(
      ingest.sourceSignature(),
      postIngestSig,
      'further unchanged ingests leave the level untouched (no thrash)'
    );

    // (d) a SECOND rewrite of the same file moves the level again (monotonic
    // epoch), so repeated maneuvers cannot hide behind the first acknowledgment.
    await sleep(20);
    rewriteRestoringMtime(
      alphaPath,
      sessionJsonl('alpha probe marker SIX', '2026-01-01T00:00:00.000Z')
    );
    const secondRewriteSig = ingest.sourceSignature();
    assert.notEqual(
      secondRewriteSig,
      postIngestSig,
      'a second rewrite must move the signature to a new level'
    );
    assert.equal(secondRewriteSig, ingest.sourceSignature());
    const afterSecond = ingest.ingest();
    assert.equal(afterSecond.reparsed, 1);
    assert.equal(
      ingest.sourceSignature(),
      secondRewriteSig,
      'the second level persists across its ingest too'
    );
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    rmSync(home, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// (e) Pruning must never walk the level BACK. The epoch map is pruned to stay
// bounded, but a file can leave the ingest baseline while still sitting on
// disk: a session that grows past INGEST_SESSION_MAX_BYTES is skip-listed.
// Dropping ITS epoch would return the signature to the value consumers had
// already settled on — the same skip-serve-stale-forever failure the level
// trigger exists to prevent. Only a genuinely vanished file may be pruned.
// ---------------------------------------------------------------------------
test('a rewritten transcript that leaves the baseline but stays on disk keeps its level; only a vanished file is pruned (#3401 review)', { timeout: 120_000 }, async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origMax = process.env.DASHBOARD_INGEST_SESSION_MAX_BYTES;
  const home = join(tmpdir(), `chd-3401-prune-${randomUUID()}`);
  const dbPath = join(tmpdir(), `chd-3401-prune-${randomUUID()}.db`);
  const proj = join(home, '.claude', 'projects', '-tmp-prune');
  mkdirSync(proj, { recursive: true });

  // 64 KiB is the knob's hard floor, so "oversize" here means >64 KiB.
  const maxBytes = 65_536;
  process.env.DASHBOARD_INGEST_SESSION_MAX_BYTES = String(maxBytes);
  const sessionPath = join(proj, 'sess-grow.jsonl');
  const ts = '2026-01-01T00:00:00.000Z';
  writePinnedSession(sessionPath, sessionJsonl('prune probe ONE', ts));

  try {
    const ingest = await loadIngest(home, dbPath);
    assert.equal(
      ingest.INGEST_SESSION_MAX_BYTES,
      maxBytes,
      'the size knob must be in effect for this fixture'
    );
    assert.equal(ingest.ingest().reparsed, 1);
    const settledSig = ingest.sourceSignature();
    assert.match(settledSig, /transcript-rewrites:none/);

    // In-place rewrite with the mtime restored (the #3401 maneuver), but the
    // new body is past the ingest size limit.
    await sleep(20);
    const before = statSync(sessionPath);
    writeFileSync(
      sessionPath,
      [userLine('prune probe TWO', ts), assistantLine('x'.repeat(maxBytes + 4_096), ts)].join('\n') + '\n'
    );
    utimesSync(sessionPath, PINNED_EPOCH_S, PINNED_EPOCH_S);
    assert.equal(
      statSync(sessionPath).mtimeMs,
      before.mtimeMs,
      'utimes must restore the exact mtime the signature reads'
    );
    assert.ok(statSync(sessionPath).size > maxBytes, 'the rewrite must be oversize');

    const rewriteSig = ingest.sourceSignature();
    assert.notEqual(rewriteSig, settledSig, 'the rewrite must move the signature');

    // ingest() now SKIPS this session, so its path drops out of the baseline
    // while the file is still on disk. The epoch must survive the prune.
    ingest.ingest();
    const afterSig = ingest.sourceSignature();
    assert.notEqual(
      afterSig,
      settledSig,
      'pruning must not return the signature to its pre-rewrite settled value'
    );
    assert.equal(afterSig, rewriteSig, 'the level holds for a still-present path');

    // Boundedness: once the file is genuinely GONE the epoch IS pruned. Safe,
    // because the removal moved the parent dir mtime — consumers refresh on
    // the `projects:` part regardless of what this part says.
    rmSync(sessionPath, { force: true });
    ingest.ingest();
    assert.match(
      ingest.sourceSignature(),
      /transcript-rewrites:none/,
      'a vanished path must be pruned so the map stays bounded'
    );
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origMax === undefined) delete process.env.DASHBOARD_INGEST_SESSION_MAX_BYTES;
    else process.env.DASHBOARD_INGEST_SESSION_MAX_BYTES = origMax;
    rmSync(home, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
  }
});
