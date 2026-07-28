#!/usr/bin/env node
// Experiment-axis evaluator route contract (#2242, loop-closer for #2227). Boots
// the real server against a throwaway CLAUDE_DIR with one enrolled session whose
// transcript carries blocking backgroundable foreground calls, and proves
// GET /api/experiments.json runs the full ingest -> measure -> qualify path:
//   - joins the enrollment ledger (CLAUDE_EXPERIMENT_LEDGER override) to the
//     measured BFC metric,
//   - returns the per-axis verdict shape,
//   - the n=1-ON-0-OFF case qualifies `inconclusive`,
//   - and every verdict carries the provisional counter-metric + observational
//     confidence + control-arm caveat (the auditable-claim honesty contract).
// Also proves a MISSING ledger fails open with { axes: [] }.

import assert from 'node:assert/strict';
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

// One transcript with three blocking, backgroundable foreground Bash calls
// (each > the 10s block floor) so the BFC metric is non-zero. All three resume
// at the same continuation entry, so the metric's parallel-batch dedup reports
// ONE BFC window over three tool calls — see the exact assertion below (#3082).
function transcript(sessionId) {
  const lines = [
    JSON.stringify({ type: 'custom-title', sessionId, customTitle: 'Experiment session' }),
    JSON.stringify({
      type: 'user',
      timestamp: '2024-01-01T14:00:00.000Z',
      cwd: '/tmp/demo',
      message: { role: 'user', content: 'build it' },
    }),
  ];
  let t = Date.parse('2024-01-01T14:00:01.000Z');
  for (let i = 0; i < 3; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(t).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `toolu_${i}`,
              name: 'Bash',
              input: { command: 'npm run build' }, // backgroundable kind, not backgrounded
            },
          ],
        },
      })
    );
    t += 40_000; // 40s block before the next assistant entry -> clears the floor
    lines.push(
      JSON.stringify({
        type: 'user',
        timestamp: new Date(t).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: false, content: 'ok' }],
        },
      })
    );
    t += 1_000;
  }
  // A final assistant entry so the last tool_use has a continuation to size.
  lines.push(
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(t).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })
  );
  return lines.join('\n') + '\n';
}

async function bootServer({ ledgerPath }) {
  const port = await freePort();
  const claudeDir = await mkdtemp(join(tmpdir(), 'experiments-claude-'));
  const distDir = await mkdtemp(join(tmpdir(), 'experiments-dist-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'experiments-cache-'));
  const base = `http://127.0.0.1:${port}`;
  const sessionId = 'exp-session-1';

  await mkdir(join(claudeDir, 'projects', 'demo'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><main>ok</main>');
  await writeFile(join(claudeDir, 'history.jsonl'), '');
  await writeFile(join(claudeDir, 'projects', 'demo', `${sessionId}.jsonl`), transcript(sessionId));

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    CLAUDE_DIR: claudeDir,
    DIST_DIR: distDir,
    CHD_DB_PATH: join(cacheDir, 'dashboard.db'),
    ADOPTION_RECEIPTS_PATH: join(cacheDir, 'adoption-receipts.jsonl'),
    ENTERPRISE_AUDIT_LOG_PATH: join(cacheDir, 'enterprise-audit.jsonl'),
    ADOPTION_SPOOL_PATH: join(cacheDir, 'adoption-spool.jsonl'),
    DASHBOARD_REVIEW_EVENTS_CACHE_PATH: join(cacheDir, 'review-events.json'),
    DASHBOARD_ENABLE_SERVER_LLM_AUDITS: '',
    DASHBOARD_ENABLE_SERVER_USAGE_GAUGE: '',
    DASHBOARD_ENABLE_BROWSER_LLM_EGRESS: '',
    ANTHROPIC_API_KEY: '',
    POLICY_WRITE_TOKEN: '',
  };
  if (ledgerPath) {
    await writeFile(
      ledgerPath,
      JSON.stringify({
        ts: '2024-01-01T13:00:00.000Z',
        sessionId,
        axis: 'background-first',
        arm: 'on',
        assignment: 'menu',
      }) + '\n'
    );
    env.CLAUDE_EXPERIMENT_LEDGER = ledgerPath;
  } else {
    // Point at a path that does not exist to prove the fail-open path.
    env.CLAUDE_EXPERIMENT_LEDGER = join(cacheDir, 'does-not-exist.jsonl');
  }

  let stdout = '';
  let stderr = '';
  const proc = spawn('node', ['--import', REGISTER, SERVER], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => (stdout += String(c)));
  proc.stderr.on('data', (c) => (stderr += String(c)));

  const cleanup = async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
    await rm(claudeDir, { recursive: true, force: true });
    await rm(distDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  };
  return { base, proc, cacheDir, sessionId, getLogs: () => [stdout, stderr].filter(Boolean).join('\n').slice(-2000), cleanup };
}

// 1) Enrolled session: end-to-end verdict.
{
  const cacheBase = await mkdtemp(join(tmpdir(), 'experiments-ledger-'));
  const ledgerPath = join(cacheBase, 'enrollment.jsonl');
  const srv = await bootServer({ ledgerPath });
  try {
    const up = await waitUp(srv.base, srv.proc);
    await check('server came up (enrolled)', () => assert.equal(up, true, srv.getLogs()));
    if (up) {
      const res = await fetch(`${srv.base}/api/experiments.json`);
      const body = await res.json();
      await check('returns 200 with per-axis verdict shape', () => {
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(body.axes));
        assert.equal(body.axes.length, 1);
      });
      const v = body.axes[0];
      await check('axis joins the enrolled ON session to the measured metric', () => {
        assert.equal(v.key, 'background-first');
        assert.equal(v.assignment, 'menu');
        assert.equal(v.arms.on.n, 1);
        assert.equal(v.arms.off.n, 0);
        assert.equal(v.n_total, 1);
        // Assert the re-derived VALUE, not merely its sign (#3082): a
        // positivity check still passes under a wrong denominator,
        // normalization or scale factor, while this fixture claims to prove the
        // whole ingest -> measure path.
        //
        // The three blocking Bash calls all resume at the SAME continuation
        // entry (the closing assistant turn), so collectSessionBfcs collapses
        // them into ONE deduped BFC window; the session still contributes three
        // `tool_use` entries. The normalized metric is therefore
        // (1 BFC / 3 tool calls) * 100 — computed here exactly as the evaluator
        // does, so the comparison is exact rather than epsilon-fudged.
        assert.equal(v.arms.on.meanMetric, (1 / 3) * 100);
        assert.equal(v.arms.off.meanMetric, null);
      });
      await check('n=1 ON / 0 OFF qualifies inconclusive', () => {
        assert.equal(v.verdict, 'inconclusive');
      });
      await check('verdict carries provisional counter-metric + observational confidence + caveats', () => {
        assert.equal(v.confidence, 'observational');
        assert.equal(v.counterMetric.status, 'not-auto-measured');
        assert.match(v.counterMetric.note, /provisional/i);
        assert.ok(Array.isArray(v.caveats) && v.caveats.length >= 1);
        assert.match(v.caveats.join(' '), /under-count/i);
      });
    }
  } finally {
    await srv.cleanup();
    await rm(cacheBase, { recursive: true, force: true });
  }
}

// 2) Missing ledger: fail open with { axes: [] }.
{
  const srv = await bootServer({ ledgerPath: null });
  try {
    const up = await waitUp(srv.base, srv.proc);
    await check('server came up (no ledger)', () => assert.equal(up, true, srv.getLogs()));
    if (up) {
      const res = await fetch(`${srv.base}/api/experiments.json`);
      const body = await res.json();
      await check('missing ledger fails open with empty axes', () => {
        assert.equal(res.status, 200);
        assert.deepEqual(body.axes, []);
      });
      const post = await fetch(`${srv.base}/api/experiments.json`, { method: 'POST' });
      await check('non-GET returns 405', () => assert.equal(post.status, 405));
    }
  } finally {
    await srv.cleanup();
  }
}

if (failures > 0) process.exit(1);
console.log('\nExperiments route checks passed.');
