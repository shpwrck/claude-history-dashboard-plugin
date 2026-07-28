#!/usr/bin/env node
// Warm hot-path latency probe for the dataset/API surface (#2069, epic #1474).
//
// The keystone measurement for the v0.5.0 performance gate. It fills the one gap
// the existing perf suite does not cover: WARM per-endpoint latency of the heavy
// read routes against an ALREADY-RUNNING server on the operator's REAL local
// ~/.claude corpus. That is where the dataset monolith's event-loop contention
// shows up — `/api/recommendations.json`, `/api/digest`, and `/api/sessions`
// stalling for seconds behind the synchronous ~128 MB assemble/serialize
// (#2070/#2071/#2072). Run it before and after each of those fixes to prove the
// delta:
//
//   podman compose ... up -d            # start the dashboard on :5173
//   node scripts/perf-probe.mjs         # measure; prints a table + (--json) JSON
//
// Boundaries vs the rest of the perf suite (deliberately NON-overlapping):
//   - gate:server-scale (server-scale-budget.mjs) owns the SYNTHETIC cold scale
//     ceiling in CI (boots its own 1200-session corpus; cold ingest/assemble/
//     serialize/bytes budgets). This probe does NOT re-measure that.
//   - cold-load-measure.mjs owns client FCP/TTI/CP against the published build.
//   - This probe owns WARM real-corpus endpoint latency + live dataset byte size.
//
// Because the real corpus (and thus absolute latency/bytes) varies per machine,
// the measurement path is an on-demand observability harness, NOT a CI gate (CI
// has no real running server+corpus). The pure budget logic and HTTP response
// contract are tested with an in-process server — scripts/perf-probe.test.mjs,
// `npm run test:perf-probe`, wired into CI. Budget enforcement here is opt-in:
// pass --enforce (or rely on the shipped perf-probe-budget.json) to exit
// non-zero on a breach; the seed ceilings are the pre-fix baseline, to be
// ratcheted down as #2070/#2071/#2072 land.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUDGET_PATH = join(PROJECT_DIR, 'perf-probe-budget.json');
const DEFAULT_BASE = 'http://127.0.0.1:5173';
const DATASET_PATH = '/api/dataset.json';
// The heavy read routes the gate cares about, dataset first (it is the spine).
const ENDPOINTS = [
  DATASET_PATH,
  '/api/recommendations.json',
  '/api/digest',
  '/api/sessions',
];

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in perf-probe.test.mjs — no network here).
// ---------------------------------------------------------------------------

// Linear-interpolated percentile over an ASCENDING-sorted array of millis.
export function percentile(sortedMs, p) {
  if (!Array.isArray(sortedMs) || sortedMs.length === 0) return 0;
  if (sortedMs.length === 1) return sortedMs[0];
  const rank = (p / 100) * (sortedMs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedMs[lo];
  return sortedMs[lo] + (sortedMs[hi] - sortedMs[lo]) * (rank - lo);
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

// Compare a measurements object against a budget object, returning the list of
// breaches. Shapes:
//   measurements.endpoints[path] = { p50, p95, ... }
//   measurements.dataset = { uncompressedBytes, compressedBytes, firstHitMs }
//   budget.endpoints[path] = { warmP50MaxMs?, warmP95MaxMs? }
//   budget.dataset = { uncompressedMaxBytes?, compressedMaxBytes?, coldBuildMaxMs? }
// Only metrics that are present on BOTH sides are checked, so a partial budget
// (or a partial measurement) never throws — it just checks fewer things.
export function evaluateBudget(measurements, budget) {
  const breaches = [];
  const over = (metric, value, limit) => {
    if (Number.isFinite(limit) && Number.isFinite(value) && value > limit) {
      breaches.push({ metric, value: round1(value), limit });
    }
  };

  const endpointBudgets = (budget && budget.endpoints) || {};
  for (const [path, limits] of Object.entries(endpointBudgets)) {
    const m = measurements && measurements.endpoints && measurements.endpoints[path];
    if (!m) continue;
    over(`${path} p50`, m.p50, limits.warmP50MaxMs);
    over(`${path} p95`, m.p95, limits.warmP95MaxMs);
  }

  const db = (budget && budget.dataset) || {};
  const dm = (measurements && measurements.dataset) || {};
  over('dataset uncompressed bytes', dm.uncompressedBytes, db.uncompressedMaxBytes);
  over('dataset compressed bytes', dm.compressedBytes, db.compressedMaxBytes);
  over('dataset cold-build ms', dm.firstHitMs, db.coldBuildMaxMs);

  return { ok: breaches.length === 0, breaches };
}

// ---------------------------------------------------------------------------
// Measurement (live server).
// ---------------------------------------------------------------------------

// One GET. Counts RAW bytes off the wire (we never decompress), so an
// `accept-encoding: identity` request reports the uncompressed size and a
// `br, gzip` request reports the compressed size — both exactly.
function httpGet(base, path, { acceptEncoding = 'identity', timeoutMs } = {}) {
  return new Promise((resolveGet, reject) => {
    const u = new URL(path, base);
    const t0 = performance.now();
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        // Fresh socket per request: never reuse a keep-alive socket the server
        // may have closed after a large response (the "socket hang up" race on
        // rapid repeats of the 128 MB dataset route).
        agent: false,
        headers: { 'accept-encoding': acceptEncoding, connection: 'close' },
      },
      (r) => {
        let bytes = 0;
        r.on('data', (chunk) => {
          bytes += chunk.length;
        });
        r.on('end', () =>
          resolveGet({
            status: r.statusCode,
            ms: performance.now() - t0,
            bytes,
            encoding: r.headers['content-encoding'] || 'identity',
          })
        );
        r.on('error', reject);
      }
    );
    req.on('error', reject);
    if (Number.isFinite(timeoutMs)) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    }
  });
}

function assertSuccessfulResponse(path, response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
}

async function measureEndpoint(base, path, { warmSamples, timeoutMs }) {
  // First hit is reported separately (it is the cold build when the server's
  // dataset cache was empty); it is NOT folded into the warm percentiles.
  const first = await httpGet(base, path, { acceptEncoding: 'br, gzip', timeoutMs });
  assertSuccessfulResponse(path, first);
  const samples = [];
  for (let i = 0; i < warmSamples; i += 1) {
    const r = await httpGet(base, path, { acceptEncoding: 'br, gzip', timeoutMs });
    assertSuccessfulResponse(path, r);
    samples.push(r.ms);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    status: first.status,
    firstHitMs: round1(first.ms),
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    samples: samples.length,
  };
}

export async function probe(base, { warmSamples = 5, timeoutMs = 300000 } = {}) {
  const endpoints = {};
  for (const path of ENDPOINTS) {
    endpoints[path] = await measureEndpoint(base, path, { warmSamples, timeoutMs });
  }
  // Dataset byte sizes: one identity request (uncompressed) + one br/gzip
  // request (compressed). Reuse the warm-cache state already primed above.
  const ident = await httpGet(base, DATASET_PATH, { acceptEncoding: 'identity', timeoutMs });
  assertSuccessfulResponse(DATASET_PATH, ident);
  const comp = await httpGet(base, DATASET_PATH, { acceptEncoding: 'br, gzip', timeoutMs });
  assertSuccessfulResponse(DATASET_PATH, comp);
  const dataset = {
    uncompressedBytes: ident.bytes,
    compressedBytes: comp.bytes,
    compressedEncoding: comp.encoding,
    firstHitMs: endpoints[DATASET_PATH] ? endpoints[DATASET_PATH].firstHitMs : null,
  };
  return { base, generatedAt: new Date().toISOString(), endpoints, dataset };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    budgetPath: DEFAULT_BUDGET_PATH,
    warmSamples: 5,
    json: false,
    enforce: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    if (arg === '--base') opts.base = next();
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg === '--budget') opts.budgetPath = resolve(next());
    else if (arg.startsWith('--budget=')) opts.budgetPath = resolve(arg.slice('--budget='.length));
    else if (arg === '--warm') opts.warmSamples = Number.parseInt(next(), 10);
    else if (arg.startsWith('--warm=')) opts.warmSamples = Number.parseInt(arg.slice('--warm='.length), 10);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--enforce') opts.enforce = true;
    else {
      console.error(`perf-probe: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.warmSamples) || opts.warmSamples < 1) opts.warmSamples = 5;
  return opts;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
}

function printTable(result) {
  console.log(`\nperf-probe @ ${result.base}  (${result.generatedAt})`);
  console.log('  endpoint                         first      p50      p95');
  for (const [path, m] of Object.entries(result.endpoints)) {
    const label = path.padEnd(30);
    const cells = [m.firstHitMs, m.p50, m.p95]
      .map((v) => `${v}ms`.padStart(8))
      .join(' ');
    console.log(`  ${label} ${cells}`);
  }
  const d = result.dataset;
  console.log(
    `  dataset.json size: ${fmtBytes(d.uncompressedBytes)} uncompressed / ` +
      `${fmtBytes(d.compressedBytes)} ${d.compressedEncoding}`
  );
}

function readBudget(budgetPath) {
  try {
    const parsed = JSON.parse(readFileSync(budgetPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await probe(opts.base, { warmSamples: opts.warmSamples });
  } catch (err) {
    console.error(
      `perf-probe: could not reach ${opts.base} — is the dashboard running? ` +
        `(${err && err.message ? err.message : err})`
    );
    process.exit(3);
  }

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result);

  if (!opts.enforce) return;
  const budget = readBudget(opts.budgetPath);
  if (!budget) {
    console.error(`perf-probe: --enforce given but no readable budget at ${opts.budgetPath}`);
    process.exit(2);
  }
  const { ok, breaches } = evaluateBudget(result, budget);
  if (!ok) {
    console.error('\nperf-probe: budget breaches:');
    for (const b of breaches) console.error(`  - ${b.metric}: ${b.value} > ${b.limit}`);
    process.exit(1);
  }
  console.log('\nperf-probe: all metrics within budget.');
}

// Run only as a CLI; importing for tests must not start a probe.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
