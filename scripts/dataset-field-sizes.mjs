#!/usr/bin/env node
// Per-field byte breakdown of /api/dataset.json (#2072, epic #1474 — v0.5.0
// perf gate). The dataset is a monolithic ~128 MB JSON that grows with history;
// this attributes those bytes across its top-level keys so the reduction work
// (#2072 children) targets the fields that actually dominate, and so the win is
// re-measurable after each cut.
//
//   node scripts/dataset-field-sizes.mjs                 # fetch from :5173
//   node scripts/dataset-field-sizes.mjs --file ds.json  # measure a saved body
//   node scripts/dataset-field-sizes.mjs --json          # machine-readable
//
// Complements the latency probe (scripts/perf-probe.mjs): that measures WHEN the
// dataset path is slow, this measures WHY it is large. Pure aggregation
// (fieldSizes) is unit-tested in dataset-field-sizes.test.mjs; the fetch path is
// an on-demand observability harness, not a CI gate.

import http from 'node:http';
import { readFileSync } from 'node:fs';

const DEFAULT_BASE = 'http://127.0.0.1:5173';
const DATASET_PATH = '/api/dataset.json';

// ---------------------------------------------------------------------------
// Pure logic (unit-tested).
// ---------------------------------------------------------------------------

// Serialized byte size of one value (the share it contributes to the body).
export function valueBytes(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

// Count the natural cardinality of a field: array length, else object key count,
// else null (scalars). Helps spot "few rows but huge each" fields.
export function fieldCardinality(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
}

// Break a dataset object into per-top-level-key sizes, sorted largest-first.
// Returns { totalBytes, rows: [{ key, bytes, pct, count }] }.
export function fieldSizes(dataset) {
  const record = dataset && typeof dataset === 'object' ? dataset : {};
  const rows = Object.keys(record).map((key) => ({
    key,
    bytes: valueBytes(record[key]),
    count: fieldCardinality(record[key]),
  }));
  const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);
  rows.sort((a, b) => b.bytes - a.bytes);
  for (const r of rows) {
    r.pct = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
  }
  return { totalBytes, rows };
}

// ---------------------------------------------------------------------------
// Fetch (live server) — fresh socket per request (#2071 socket-hang-up note).
// ---------------------------------------------------------------------------

function fetchDataset(base, { timeoutMs = 300000 } = {}) {
  return new Promise((resolveGet, reject) => {
    const u = new URL(DATASET_PATH, base);
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        agent: false,
        headers: { 'accept-encoding': 'identity', connection: 'close' },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolveGet(Buffer.concat(chunks).toString('utf8')));
        r.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, file: null, json: false, top: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === '--base') opts.base = next();
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg === '--file') opts.file = next();
    else if (arg.startsWith('--file=')) opts.file = arg.slice('--file='.length);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--top') opts.top = Number.parseInt(next(), 10);
    else if (arg.startsWith('--top=')) opts.top = Number.parseInt(arg.slice('--top='.length), 10);
    else {
      console.error(`dataset-field-sizes: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) opts.top = 20;
  return opts;
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(2)}MB`;
}

function printTable(result, top) {
  console.log(`\ndataset.json field sizes — total ${mb(result.totalBytes)} across ${result.rows.length} keys\n`);
  console.log('     bytes    share    count  key');
  for (const r of result.rows.slice(0, top)) {
    console.log(
      `  ${mb(r.bytes).padStart(9)}  ${r.pct.toFixed(1).padStart(5)}%  ${String(r.count ?? '').padStart(7)}  ${r.key}`
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let raw;
  try {
    raw = opts.file ? readFileSync(opts.file, 'utf8') : await fetchDataset(opts.base);
  } catch (err) {
    console.error(
      `dataset-field-sizes: could not read dataset (${opts.file ? opts.file : opts.base}) — ` +
        `${err && err.message ? err.message : err}`
    );
    process.exit(3);
  }
  const result = fieldSizes(JSON.parse(raw));
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result, opts.top);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
