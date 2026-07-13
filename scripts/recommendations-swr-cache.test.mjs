#!/usr/bin/env node
// Recommendations response-cache freshness contract (#2184, epic #2181). Boots
// the real server against a throwaway CLAUDE_DIR and proves the two-tier cache
// gate that keeps /api/recommendations.json fast during an active agent session:
//
//   1. sourceSignature() (cheap dir-mtime fingerprint) HIT  -> served instantly.
//   2. external-guidance validity crossed with unchanged inputs -> `hit-time`:
//      the cached JSON is immediately redecorated with the correct current or
//      historical labels, without rerunning the detector catalog.
//   3. an external-guidance snapshot changed -> `stale`, then a rebuilt body
//      with the refreshed reference; sourceSignature must not early-hit it.
//   4. mtime changed but ingest() reports the SAME contentHash -> `hit-content`:
//      the cached body is byte-identical and NO multi-second assemble/detector
//      rebuild runs. This is the core fix — an active session bumps project-dir
//      mtimes on nearly every request, but the recs body only changes when the
//      ingested CONTENT changes.
//   5. content actually changed -> `stale`: the last-good body is served
//      immediately while the rebuild is deferred to the response `finish` event
//      (so serving stale stays fast), and the cache converges to the fresh body
//      on a later request.
//
// Assertions are on the X-Recommendations-Cache header semantics and body
// identity (deterministic), not wall-clock thresholds (which would be flaky).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function processExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcessExit(proc, timeoutMs) {
  if (processExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    // Attach before either signal so a fast exit cannot land between kill()
    // and listener registration.
    proc.once('exit', onExit);
    if (processExited(proc)) {
      done(true);
      return;
    }
    timer = setTimeout(() => done(processExited(proc)), timeoutMs);
  });
}

async function stopProcess(
  proc,
  { termTimeoutMs = 2_000, killTimeoutMs = 2_000 } = {}
) {
  if (processExited(proc)) return;
  const termExit = waitForProcessExit(proc, termTimeoutMs);
  proc.kill('SIGTERM');
  if (await termExit) return;

  const killExit = waitForProcessExit(proc, killTimeoutMs);
  proc.kill('SIGKILL');
  if (await killExit) return;
  throw new Error('child did not exit after SIGTERM then SIGKILL');
}

function waitForChildMessage(proc, expected, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('message', onMessage);
      proc.off('exit', onExit);
      if (err) reject(err);
      else resolve();
    };
    const onMessage = (message) => {
      if (message === expected) done();
    };
    const onExit = () => done(new Error('child exited before ready message'));
    proc.on('message', onMessage);
    proc.once('exit', onExit);
    timer = setTimeout(
      () => done(new Error(`child did not send ${expected} within ${timeoutMs}ms`)),
      timeoutMs
    );
  });
}

async function assertStopProcessEscalates() {
  const stubborn = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1e3)",
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  try {
    await waitForChildMessage(stubborn, 'ready');
    await stopProcess(stubborn, { termTimeoutMs: 50, killTimeoutMs: 2_000 });
    assert.equal(stubborn.signalCode, 'SIGKILL');
  } finally {
    if (!processExited(stubborn)) {
      const killed = waitForProcessExit(stubborn, 2_000);
      stubborn.kill('SIGKILL');
      assert.equal(await killed, true, 'stubborn cleanup child did not exit');
    }
  }
}

// Fetch recs, returning the cache header + body text. Connection: close so each
// request uses a fresh socket (avoids keep-alive reuse races in the test).
async function getRecs(base) {
  const res = await fetch(`${base}/api/recommendations.json`, {
    headers: { connection: 'close' },
  });
  const body = await res.text();
  return {
    status: res.status,
    cache: res.headers.get('x-recommendations-cache'),
    etag: res.headers.get('etag'),
    body,
  };
}

function recommendationsFromBody(body) {
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : parsed.recommendations ?? [];
}

function sessionJsonl(
  id,
  prompt,
  ts,
  { followUpTurns = 0, apiError = false } = {}
) {
  const rows = [
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
        content: [
          { type: 'tool_use', id: `toolu_${id}`, name: 'Read', input: { file_path: '/tmp/a.txt' } },
        ],
      },
    }),
  ];
  for (let i = 0; i < followUpTurns; i += 1) {
    rows.push(
      JSON.stringify({
        type: 'user',
        timestamp: new Date(Date.parse(ts) + (i + 1) * 1_000).toISOString(),
        cwd: '/tmp/demo',
        message: { role: 'user', content: `continue ${i + 1}` },
      })
    );
  }
  if (apiError) {
    rows.push(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        timestamp: ts,
        error: { status: 429 },
      })
    );
  }
  return `${rows.join('\n')}\n`;
}

const ownedTempDirs = [];
let proc = null;
try {
  await check('stopProcess escalates SIGTERM to SIGKILL and confirms exit', () =>
    assertStopProcessEscalates()
  );

  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'recs-swr-claude-'));
  ownedTempDirs.push(claudeDir);
  const distDir = await mkdtemp(join(tmpdir(), 'recs-swr-dist-'));
  ownedTempDirs.push(distDir);
  const cacheDir = await mkdtemp(join(tmpdir(), 'recs-swr-cache-'));
  ownedTempDirs.push(cacheDir);
  const base = `http://127.0.0.1:${port}`;
  const projectDir = join(claudeDir, 'projects', 'demo');
  const committedGuidanceDir = join(PROJECT_DIR, 'data', 'external-guidance');
  const guidanceDir = join(cacheDir, 'external-guidance');
  const promptGuidancePath = join(
    guidanceDir,
    'anthropic-claude-code-prompt-library.json'
  );
  const usageGuidance = JSON.parse(
    await readFile(
      join(committedGuidanceDir, 'anthropic-usage-limits.json'),
      'utf8'
    )
  );
  const staleBoundary =
    Date.parse(usageGuidance.fetchedAt) + 30 * 24 * 60 * 60 * 1000;
  const expectedUsageStaleLabel =
    `${usageGuidance.title} (as of ${usageGuidance.fetchedAt.slice(0, 10)})`;
  const clockFile = join(cacheDir, 'now.txt');
  const clockShim = join(cacheDir, 'clock.mjs');
  const duplicateGuidancePath = join(
    guidanceDir,
    `000-recs-swr-duplicate-${process.pid}.json`
  );

  await mkdir(projectDir, { recursive: true });
  // Copy every committed snapshot into an isolated fixture root, then add the
  // adversarial duplicate there. The real repo data tree is never mutated.
  await cp(committedGuidanceDir, guidanceDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  await writeFile(join(claudeDir, 'history.jsonl'), '');
  await writeFile(clockFile, String(staleBoundary));
  await writeFile(
    clockShim,
    [
      "import { readFileSync } from 'node:fs';",
      `const clockFile = ${JSON.stringify(clockFile)};`,
      "Date.now = () => Number(readFileSync(clockFile, 'utf8'));",
    ].join('\n')
  );
  // Sorts before the committed usage snapshot and deliberately shares its
  // URL/title while carrying a DIFFERENT target and fetchedAt. A URL+label-only
  // redecoration would grab this transition first and put the wrong as-of date on
  // reliability.rate-limits.
  await writeFile(
    duplicateGuidancePath,
    JSON.stringify({
      id: 'recs-swr-duplicate-other-target',
      source: usageGuidance.source,
      url: usageGuidance.url,
      fetchedAt: '2026-05-01T00:00:00.000Z',
      contentHash: 'sha256:duplicate-other-target',
      title: usageGuidance.title,
      suggestion: usageGuidance.suggestion,
      target: { detectorId: 'workflow.prompt-clarity' },
    })
  );
  const promptClaritySessions = [
    ['low-a', 'do the first thing', '2024-01-01T14:00:00.000Z', { followUpTurns: 4, apiError: true }],
    ['low-b', 'help me with this', '2024-01-02T14:00:00.000Z', { followUpTurns: 4 }],
    ['low-c', 'make it better', '2024-01-03T14:00:00.000Z', { followUpTurns: 4 }],
    ['specific-a', 'Update src/a.ts; tests must pass.', '2024-01-04T14:00:00.000Z'],
    ['specific-b', 'Update src/b.ts; tests must pass.', '2024-01-05T14:00:00.000Z'],
    ['specific-c', 'Update src/c.ts; tests must pass.', '2024-01-06T14:00:00.000Z'],
  ];
  await Promise.all(
    promptClaritySessions.map(([id, prompt, ts, options]) =>
      writeFile(
        join(projectDir, `${id}.jsonl`),
        sessionJsonl(id, prompt, ts, options)
      )
    )
  );

  let stdout = '';
  let stderr = '';
  proc = spawn(
    'node',
    ['--import', REGISTER, '--import', pathToFileURL(clockShim).href, SERVER],
    {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        CLAUDE_DIR: claudeDir,
        DIST_DIR: distDir,
        CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
        CHD_EXTERNAL_GUIDANCE_DIR: guidanceDir,
        ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
        ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
        ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
        DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
        DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
        DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
        DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
        DASHBOARD_REVIEW_EVENTS_SOURCE: '',
        ANTHROPIC_API_KEY: '',
        POLICY_WRITE_TOKEN: '',
        // Keep the rebuild in this process so the controllable test clock applies
        // to both cache freshness and recommendation rendering.
        CHD_RECS_WORKER: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stdout.on('data', (c) => { stdout += String(c); });
  proc.stderr.on('data', (c) => { stderr += String(c); });

  const up = await waitUp(base, proc);
  await check('server came up', () =>
    assert.equal(up, true, [stdout, stderr].filter(Boolean).join('\n').slice(-2000))
  );

  if (up) {
    // 1) Cold build populates the cache.
    const cold = await getRecs(base);
    await check('cold request builds and returns 200', () => {
      assert.equal(cold.status, 200);
      assert.equal(cold.cache, 'miss');
      assert.ok(cold.body.length > 0);
    });

    // 2) Immediate re-hit with no source change -> plain signature hit.
    const hit = await getRecs(base);
    await check('unchanged source serves a signature hit', () => {
      assert.equal(hit.cache, 'hit');
      assert.equal(hit.body, cold.body);
    });

    const currentRateLimit = recommendationsFromBody(cold.body).find(
      (rec) => rec.id === 'reliability.rate-limits'
    );
    await check('guidance is undated at the exact 30-day boundary', () => {
      assert.ok(currentRateLimit, 'fixture did not emit reliability.rate-limits');
      assert.equal(
        currentRateLimit.references?.[0]?.label.includes('(as of '),
        false
      );
    });

    const promptClarity = recommendationsFromBody(cold.body).find(
      (rec) => rec.id === 'workflow.prompt-clarity'
    );
    await check('served prompt-clarity carries the committed prompt-library reference', () => {
      assert.ok(promptClarity, 'served path did not emit workflow.prompt-clarity');
      assert.deepEqual(
        promptClarity.references?.find(
          (reference) =>
            reference.url === 'https://code.claude.com/docs/en/prompt-library'
        ),
        {
          label: 'Prompt library',
          url: 'https://code.claude.com/docs/en/prompt-library',
          source: 'Anthropic Claude Code Docs',
          trustTier: 'first-party',
        }
      );
    });

    // Advance only the server clock. The source signature and content hash are
    // unchanged, but the attached guidance label is now historical, so the API
    // response cache must update the first response instead of returning the
    // old undated body to a one-shot consumer.
    await writeFile(clockFile, String(staleBoundary + 1));
    const expired = await getRecs(base);
    await check('first response after a forward crossing has an as-of label', () => {
      assert.equal(expired.cache, 'hit-time');
      assert.notEqual(expired.body, cold.body);
      assert.notEqual(expired.etag, cold.etag);
      const rateLimit = recommendationsFromBody(expired.body).find(
        (rec) => rec.id === 'reliability.rate-limits'
      );
      assert.ok(rateLimit, 'updated response lost reliability.rate-limits');
      assert.equal(rateLimit.references?.[0]?.label, expectedUsageStaleLabel);
    });

    // Now correct the clock backward across the same boundary. The entry built
    // in the stale interval must not be treated as forever-valid: the first
    // response must remove the historical suffix immediately.
    await writeFile(clockFile, String(staleBoundary));
    const rolledBack = await getRecs(base);
    await check('first response after a backward crossing removes the as-of label', () => {
      assert.equal(rolledBack.cache, 'hit-time');
      assert.equal(rolledBack.body, cold.body);
      assert.equal(rolledBack.etag, cold.etag);
      const rateLimit = recommendationsFromBody(rolledBack.body).find(
        (rec) => rec.id === 'reliability.rate-limits'
      );
      assert.ok(rateLimit, 'updated response lost reliability.rate-limits');
      assert.equal(rateLimit.references?.[0]?.label.includes('(as of '), false);
    });
    let freshBody = rolledBack.body;

    // Replace an existing snapshot while this same server process is warm. The
    // cheap source signature must notice the file metadata change before its
    // early-hit return, then the content-hash gate must rebuild from the fresh
    // snapshot rather than serving the old prompt-library reference forever.
    const refreshedPromptLabel = 'Prompt library refreshed fixture';
    const promptGuidance = JSON.parse(
      await readFile(promptGuidancePath, 'utf8')
    );
    await writeFile(
      promptGuidancePath,
      JSON.stringify({
        ...promptGuidance,
        title: refreshedPromptLabel,
        contentHash:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      })
    );
    const guidanceStale = await getRecs(base);
    await check('snapshot replacement invalidates the warm signature hit', () => {
      assert.equal(guidanceStale.cache, 'stale');
      assert.equal(guidanceStale.body, freshBody);
    });

    let guidanceSettled = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const candidate = await getRecs(base);
      const refreshedPrompt = recommendationsFromBody(candidate.body).find(
        (rec) => rec.id === 'workflow.prompt-clarity'
      );
      const refreshedReference = refreshedPrompt?.references?.find(
        (reference) =>
          reference.url === 'https://code.claude.com/docs/en/prompt-library'
      );
      if (
        (candidate.cache === 'hit' || candidate.cache === 'hit-content') &&
        refreshedReference?.label === refreshedPromptLabel
      ) {
        guidanceSettled = candidate;
        break;
      }
    }
    await check('same-process rebuild serves refreshed guidance content', () => {
      assert.ok(guidanceSettled, 'guidance refresh never reached the served route');
      assert.notEqual(guidanceSettled.body, freshBody);
      assert.notEqual(guidanceSettled.etag, rolledBack.etag);
      assert.ok(guidanceSettled.body.includes(refreshedPromptLabel));
    });
    if (guidanceSettled) freshBody = guidanceSettled.body;

    // Rewrite the same snapshot with the same byte length, then restore its
    // original mtime. The cheap gate must still notice non-restorable stat
    // identity, while ingest's content hash must follow the actual bounded file
    // bytes so the background rebuild converges to the new reference.
    const rewrittenPromptLabel = 'Prompt library rewritten fixture';
    const beforeRewrite = await stat(promptGuidancePath);
    const beforeRewriteText = await readFile(promptGuidancePath, 'utf8');
    const beforeRewriteJson = JSON.parse(beforeRewriteText);
    const rewrittenText = JSON.stringify({
      ...beforeRewriteJson,
      title: rewrittenPromptLabel,
      contentHash:
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    });
    await check('restored-mtime fixture preserves exact byte length', () => {
      assert.equal(Buffer.byteLength(rewrittenText), beforeRewrite.size);
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(promptGuidancePath, rewrittenText);
    await utimes(promptGuidancePath, beforeRewrite.atime, beforeRewrite.mtime);

    const rewrittenStale = await getRecs(base);
    await check('equal-length restored-mtime rewrite invalidates immediately', () => {
      assert.equal(rewrittenStale.cache, 'stale');
      assert.equal(rewrittenStale.body, freshBody);
    });

    let rewrittenSettled = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const candidate = await getRecs(base);
      const rewrittenPrompt = recommendationsFromBody(candidate.body).find(
        (rec) => rec.id === 'workflow.prompt-clarity'
      );
      if (
        (candidate.cache === 'hit' || candidate.cache === 'hit-content')
        && rewrittenPrompt?.references?.some(
          (reference) => reference.label === rewrittenPromptLabel
        )
      ) {
        rewrittenSettled = candidate;
        break;
      }
    }
    await check('restored-mtime rewrite converges to the new bounded content hash', () => {
      assert.ok(rewrittenSettled, 'restored-mtime rewrite never reached the served route');
      assert.notEqual(rewrittenSettled.body, freshBody);
      assert.ok(rewrittenSettled.body.includes(rewrittenPromptLabel));
    });
    if (rewrittenSettled) freshBody = rewrittenSettled.body;

    await mkdir(join(guidanceDir, 'ignored-deep'), { recursive: true });
    await writeFile(join(guidanceDir, 'ignored-deep', 'snapshot.json'), '{"ignored":true}');
    await writeFile(join(guidanceDir, 'ignored.txt'), 'ignored');
    const ignoredGuidance = await getRecs(base);
    await check('deep and non-JSON guidance entries do not churn the route cache', () => {
      assert.equal(ignoredGuidance.cache, 'hit');
      assert.equal(ignoredGuidance.body, freshBody);
    });

    // 5) Bump the project dir mtime WITHOUT changing content. sourceSignature()
    //    changes (mtime) but ingest()'s contentHash does not, so the gate must
    //    serve the byte-identical cached body as `hit-content` — no rebuild.
    const future = new Date(Date.now() + 60_000);
    await utimes(projectDir, future, future);
    const contentHit = await getRecs(base);
    await check('mtime-only churn serves hit-content with an identical body', () => {
      assert.equal(contentHit.cache, 'hit-content');
      assert.equal(contentHit.body, freshBody);
    });

    // 6) Real content change -> stale-while-revalidate: the previous body is
    //    served immediately as `stale`.
    await writeFile(
      join(projectDir, 'two.jsonl'),
      sessionJsonl('two', 'do the second thing', '2024-01-02T09:00:00.000Z')
    );
    const stale = await getRecs(base);
    await check('content change serves the prior body as stale', () => {
      assert.equal(stale.cache, 'stale');
      assert.equal(stale.body, freshBody);
    });

    // 7) The background rebuild (deferred to response finish) converges the
    //    cache: a later request settles back to a hit (no longer stale).
    let settled = null;
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await getRecs(base);
      if (r.cache === 'hit' || r.cache === 'hit-content') { settled = r; break; }
    }
    await check('cache converges to a fresh hit after the background rebuild', () => {
      assert.ok(settled, 'recs cache never settled to a hit after content change');
      assert.equal(settled.status, 200);
    });
  }
} finally {
  try {
    if (proc) await stopProcess(proc);
  } finally {
    await Promise.all(
      ownedTempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
  }
}

if (failures > 0) process.exit(1);
console.log('\nRecommendations SWR cache checks passed.');
