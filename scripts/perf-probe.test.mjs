// Tests for perf-probe.mjs (#2069, epic #1474).
// The measurement status contract is exercised against a bounded in-process
// HTTP server; percentile() and evaluateBudget() remain network-free. Run:
//   node --test scripts/perf-probe.test.mjs   (npm run test:perf-probe)
//
// Also asserts the shipped perf-probe-budget.json parses and has the shape the
// evaluator reads, so a malformed edit fails here instead of silently at runtime.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { percentile, round1, evaluateBudget, probe } from './perf-probe.mjs';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PERF_PROBE_PATH = join(PROJECT_DIR, 'scripts', 'perf-probe.mjs');

/** Write a throwaway budget file; caller rms its parent dir. */
function writeTmpBudget(budget) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-probe-budget-'));
  const path = join(dir, 'budget.json');
  writeFileSync(path, JSON.stringify(budget, null, 2));
  return path;
}

async function withTestServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

function runProbeCli(args) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [PERF_PROBE_PATH, ...args],
      { cwd: PROJECT_DIR },
      (error, stdout, stderr) => {
        resolveRun({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test('probe rejects a cold endpoint 404 before reporting a measurement', async () => {
  await withTestServer((_request, response) => {
    response.writeHead(404);
    response.end('missing');
  }, async (base) => {
    await assert.rejects(
      probe(base, { warmSamples: 1, timeoutMs: 1_000 }),
      /\/api\/dataset\.json.*404/
    );
  });
});

test('CLI --enforce exits nonzero and identifies a fast 404 response', async () => {
  await withTestServer((_request, response) => {
    response.writeHead(404);
    response.end('missing');
  }, async (base) => {
    const result = await runProbeCli(['--base', base, '--warm=1', '--enforce']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\/api\/dataset\.json.*404/);
    assert.doesNotMatch(result.stdout, /all metrics within budget/);
  });
});

test('probe rejects a warm endpoint 500 before recording its latency', async () => {
  let datasetRequests = 0;
  await withTestServer((request, response) => {
    if (request.url === '/api/dataset.json') datasetRequests += 1;
    const status = request.url === '/api/dataset.json' && datasetRequests === 2 ? 500 : 200;
    response.writeHead(status);
    response.end(status === 500 ? 'failed' : '{}');
  }, async (base) => {
    await assert.rejects(
      probe(base, { warmSamples: 1, timeoutMs: 1_000 }),
      /\/api\/dataset\.json.*500/
    );
  });
});

test('probe rejects a 401 identity dataset-size response before recording bytes', async () => {
  await withTestServer((request, response) => {
    const isIdentityDataset =
      request.url === '/api/dataset.json' &&
      request.headers['accept-encoding'] === 'identity';
    response.writeHead(isIdentityDataset ? 401 : 200);
    response.end(isIdentityDataset ? 'unauthorized' : '{}');
  }, async (base) => {
    await assert.rejects(
      probe(base, { warmSamples: 1, timeoutMs: 1_000 }),
      /\/api\/dataset\.json.*401/
    );
  });
});

test('probe rejects a 500 compressed dataset-size response before recording bytes', async () => {
  let compressedDatasetRequests = 0;
  await withTestServer((request, response) => {
    const isCompressedDataset =
      request.url === '/api/dataset.json' &&
      request.headers['accept-encoding'] === 'br, gzip';
    if (isCompressedDataset) compressedDatasetRequests += 1;
    const status = isCompressedDataset && compressedDatasetRequests === 3 ? 500 : 200;
    response.writeHead(status);
    response.end(status === 500 ? 'failed' : '{}');
  }, async (base) => {
    await assert.rejects(
      probe(base, { warmSamples: 1, timeoutMs: 1_000 }),
      /\/api\/dataset\.json.*500/
    );
  });
});

test('probe records endpoint latency and dataset bytes for 200 responses', async () => {
  const identityBody = 'uncompressed-dataset';
  const compressedBody = 'zip';
  await withTestServer((request, response) => {
    const identity = request.headers['accept-encoding'] === 'identity';
    response.writeHead(200, identity ? {} : { 'content-encoding': 'gzip' });
    response.end(identity ? identityBody : compressedBody);
  }, async (base) => {
    const result = await probe(base, { warmSamples: 1, timeoutMs: 1_000 });

    assert.deepEqual(Object.keys(result.endpoints), [
      '/api/dataset.json',
      '/api/recommendations.json',
      '/api/digest',
      '/api/sessions',
    ]);
    for (const measurement of Object.values(result.endpoints)) {
      assert.equal(measurement.status, 200);
      assert.equal(measurement.samples, 1);
      assert.ok(Number.isFinite(measurement.firstHitMs));
      assert.ok(Number.isFinite(measurement.p50));
      assert.ok(Number.isFinite(measurement.p95));
    }
    assert.equal(result.dataset.uncompressedBytes, Buffer.byteLength(identityBody));
    assert.equal(result.dataset.compressedBytes, Buffer.byteLength(compressedBody));
    assert.equal(result.dataset.compressedEncoding, 'gzip');
  });
});

test('percentile: empty and single-element', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([42], 95), 42);
});

test('percentile: interpolates between samples', () => {
  const s = [10, 20, 30, 40, 50];
  assert.equal(percentile(s, 50), 30); // exact middle
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile(s, 100), 50);
  // p95 of 5 samples => rank 3.8 => 40 + 0.8*(50-40) = 48
  assert.equal(round1(percentile(s, 95)), 48);
});

test('evaluateBudget: passes when every metric is under budget', () => {
  const measurements = {
    endpoints: {
      '/api/dataset.json': { p50: 100, p95: 200 },
      '/api/recommendations.json': { p50: 150, p95: 250 },
    },
    dataset: { uncompressedBytes: 1000, compressedBytes: 100, firstHitMs: 500 },
  };
  const budget = {
    endpoints: {
      '/api/dataset.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
      '/api/recommendations.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
    },
    dataset: { uncompressedMaxBytes: 10000, compressedMaxBytes: 1000, coldBuildMaxMs: 5000 },
  };
  const { ok, breaches } = evaluateBudget(measurements, budget);
  assert.equal(ok, true);
  assert.deepEqual(breaches, []);
});

test('evaluateBudget: reports each breach (latency + bytes + cold build)', () => {
  const measurements = {
    endpoints: {
      '/api/recommendations.json': { p50: 9000, p95: 23000 },
    },
    dataset: { uncompressedBytes: 200000000, compressedBytes: 20000000, firstHitMs: 200000 },
  };
  const budget = {
    endpoints: {
      '/api/recommendations.json': { warmP50MaxMs: 1000, warmP95MaxMs: 2000 },
    },
    dataset: { uncompressedMaxBytes: 160000000, compressedMaxBytes: 18000000, coldBuildMaxMs: 180000 },
  };
  const { ok, breaches } = evaluateBudget(measurements, budget);
  assert.equal(ok, false);
  const metrics = breaches.map((b) => b.metric).sort();
  assert.deepEqual(metrics, [
    '/api/recommendations.json p50',
    '/api/recommendations.json p95',
    'dataset cold-build ms',
    'dataset compressed bytes',
    'dataset uncompressed bytes',
  ]);
  // Each breach carries the offending value and the limit it exceeded.
  const p95 = breaches.find((b) => b.metric === '/api/recommendations.json p95');
  assert.equal(p95.value, 23000);
  assert.equal(p95.limit, 2000);
});

test('evaluateBudget: a budgeted-but-unmeasured metric is a PROBLEM, never a silent skip (#3478)', () => {
  // This inverts what an earlier version of this test ENSHRINED ("only checks
  // metrics present on BOTH sides"): under that contract, renaming an endpoint
  // in the budget — or dropping its measurement — silently evaporated its
  // gate. Anything the budget NAMES must be verified or flagged.
  const measurements = { endpoints: { '/api/digest': { p50: 100 } }, dataset: {} };
  const budget = {
    endpoints: {
      '/api/digest': { warmP95MaxMs: 50 }, // p95 absent from measurement -> problem
      '/api/sessions': { warmP50MaxMs: 1 }, // endpoint absent from measurement -> problem
    },
    dataset: { uncompressedMaxBytes: 1 }, // bytes absent from measurement -> problem
  };
  const { ok, breaches, problems, checkedCount } = evaluateBudget(measurements, budget);
  assert.equal(ok, false);
  assert.deepEqual(breaches, []);
  assert.deepEqual(problems.map((p) => p.metric).sort(), [
    '/api/digest p95',
    '/api/sessions p50',
    'dataset uncompressed bytes',
  ]);
  for (const p of problems) assert.match(p.reason, /never measured/);
  assert.equal(checkedCount, 0);
});

test('evaluateBudget: a set-but-non-finite limit is a PROBLEM, not a disabled check (#3478)', () => {
  const measurements = {
    endpoints: { '/api/digest': { p50: 100, p95: 200 } },
    dataset: {},
  };
  const budget = {
    endpoints: {
      // A typo'd ceiling ("500ms", null) used to make Number.isFinite(limit)
      // false and the check silently vanish.
      '/api/digest': { warmP50MaxMs: '500ms', warmP95MaxMs: null },
    },
  };
  const { ok, problems, checkedCount } = evaluateBudget(measurements, budget);
  assert.equal(ok, false);
  assert.equal(problems.length, 2);
  for (const p of problems) assert.match(p.reason, /not a finite number/);
  assert.equal(checkedCount, 0);
});

test('evaluateBudget: an ABSENT budget key stays unchecked without a problem, and checkedCount reports coverage', () => {
  // Absent means "not budgeted" — allowed. The CLI's inertness rule is what
  // fails an --enforce run whose checkedCount is zero.
  const measurements = {
    endpoints: { '/api/digest': { p50: 100, p95: 200 } },
    dataset: { uncompressedBytes: 1000, compressedBytes: 100, firstHitMs: 500 },
  };
  const budget = { endpoints: { '/api/digest': { warmP50MaxMs: 1000 } } };
  const { ok, breaches, problems, checkedCount } = evaluateBudget(measurements, budget);
  assert.equal(ok, true);
  assert.deepEqual(breaches, []);
  assert.deepEqual(problems, []);
  assert.equal(checkedCount, 1);

  const empty = evaluateBudget(measurements, {});
  assert.equal(empty.ok, true);
  assert.equal(empty.checkedCount, 0);
});

test('shipped perf-probe-budget.json parses and matches the evaluator shape', () => {
  const budget = JSON.parse(readFileSync(join(PROJECT_DIR, 'perf-probe-budget.json'), 'utf8'));
  assert.ok(budget.endpoints && typeof budget.endpoints === 'object');
  assert.ok(budget.dataset && typeof budget.dataset === 'object');
  for (const limits of Object.values(budget.endpoints)) {
    assert.ok(Number.isFinite(limits.warmP50MaxMs));
    assert.ok(Number.isFinite(limits.warmP95MaxMs));
  }
  assert.ok(Number.isFinite(budget.dataset.uncompressedMaxBytes));
  assert.ok(Number.isFinite(budget.dataset.compressedMaxBytes));
  // A real FULL measurement under these generous pre-fix ceilings must pass —
  // covering every endpoint the budget names, since a budgeted-but-unmeasured
  // endpoint is now a problem (#3478), not a silent skip.
  const underBudget = {
    endpoints: Object.fromEntries(
      Object.keys(budget.endpoints).map((path) => [path, { p50: 100, p95: 200 }])
    ),
    dataset: { uncompressedBytes: 1000, compressedBytes: 100, firstHitMs: 500 },
  };
  const verdict = evaluateBudget(underBudget, budget);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
  assert.ok(verdict.checkedCount >= Object.keys(budget.endpoints).length * 2);
});

test('CLI --enforce exits 1 on a REAL budget breach (spawn-level, #3478)', async () => {
  await withTestServer((_request, response) => {
    response.writeHead(200);
    response.end('{}');
  }, async (base) => {
    // Every endpoint measured, one ceiling impossibly tight: any real latency
    // breaches a 0.000001 ms p50 cap.
    const budgetPath = writeTmpBudget({
      endpoints: {
        '/api/dataset.json': { warmP50MaxMs: 0.000001, warmP95MaxMs: 100000 },
        '/api/recommendations.json': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
        '/api/digest': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
        '/api/sessions': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
      },
      dataset: { uncompressedMaxBytes: 100000, compressedMaxBytes: 100000, coldBuildMaxMs: 100000 },
    });
    try {
      const result = await runProbeCli(['--base', base, '--warm=1', '--enforce', '--budget', budgetPath]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /budget breaches/);
      assert.match(result.stderr, /\/api\/dataset\.json p50/);
      assert.doesNotMatch(result.stdout, /all metrics within budget/);
    } finally {
      rmSync(dirname(budgetPath), { recursive: true, force: true });
    }
  });
});

test('CLI --enforce fails an INERT budget that verifies zero checks (spawn-level, #3478)', async () => {
  await withTestServer((_request, response) => {
    response.writeHead(200);
    response.end('{}');
  }, async (base) => {
    const budgetPath = writeTmpBudget({});
    try {
      const result = await runProbeCli(['--base', base, '--warm=1', '--enforce', '--budget', budgetPath]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /verified 0 budgets/);
      assert.match(result.stderr, /enforced NOTHING/);
      assert.doesNotMatch(result.stdout, /all metrics within budget/);
    } finally {
      rmSync(dirname(budgetPath), { recursive: true, force: true });
    }
  });
});

test('CLI --enforce passes a real budget and reports how many checks it verified (spawn-level)', async () => {
  await withTestServer((_request, response) => {
    response.writeHead(200);
    response.end('{}');
  }, async (base) => {
    const budgetPath = writeTmpBudget({
      endpoints: {
        '/api/dataset.json': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
        '/api/recommendations.json': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
        '/api/digest': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
        '/api/sessions': { warmP50MaxMs: 100000, warmP95MaxMs: 100000 },
      },
      dataset: { uncompressedMaxBytes: 100000, compressedMaxBytes: 100000, coldBuildMaxMs: 100000 },
    });
    try {
      const result = await runProbeCli(['--base', base, '--warm=1', '--enforce', '--budget', budgetPath]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /all metrics within budget \(11 budget checks verified\)/);
    } finally {
      rmSync(dirname(budgetPath), { recursive: true, force: true });
    }
  });
});

test('CLI rejects a bogus --warm loudly instead of silently running 5 samples (#3478)', async () => {
  const result = await runProbeCli(['--warm', 'bogus', '--enforce']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /--warm must be a positive integer, got "bogus"/);

  const zero = await runProbeCli(['--warm=0']);
  assert.equal(zero.code, 2, zero.stderr);
  assert.match(zero.stderr, /--warm must be a positive integer/);
});
