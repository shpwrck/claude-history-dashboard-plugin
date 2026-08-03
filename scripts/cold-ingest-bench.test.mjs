// Cold-ingest benchmark control-parsing gate (#3076, epic #1930).
//
// The benchmark is the measuring instrument for the v0.6.0 performance gate, so
// its own failure modes matter more than most: at the audit baseline
// `CHD_COLD_INGEST_MIN_SPEEDUP` was read with `Number(...)`, a typo became
// `NaN`, and `speedup < NaN` is false for every speedup — a regression to 0.25x
// printed "Speedup: 0.25x" and exited 0. Nothing downstream could tell that
// green apart from a real pass.
//
// Two halves, matching the two ways that bug could come back:
//   1. unit — the fail-closed parser rejects every value that is not a usable
//      number, instead of returning one that disables the comparison;
//   2. end-to-end — the benchmark process actually exits non-zero on a bad
//      threshold, BEFORE it spends minutes building a fixture, and still fails
//      on a real shortfall when the threshold is valid.
//
// Run: node --test scripts/cold-ingest-bench.test.mjs

import {
  deepStrictEqual,
  match,
  notStrictEqual,
  ok,
  strictEqual,
  throws,
} from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createColdIngestFingerprint } from './lib/cold-ingest-fingerprint.mjs';
import { EnvNumberError, envNumber } from './lib/env-number.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO_ROOT, 'scripts', 'cold-ingest-bench.mjs');
const REGISTER_TS = join(REPO_ROOT, 'scripts', 'register-ts.mjs');

/** Threshold spec the benchmark uses: finite and strictly positive. */
const SPEEDUP_SPEC = { fallback: 2, min: Number.MIN_VALUE };

const FINGERPRINT_SIGNALS = [
  {
    id: 'push',
    column: 'push_json',
    aggregate: 'push-truthy',
    parseGuard: 'guarded',
    datasetKey: 'pushDataset',
  },
  {
    id: 'spread',
    column: 'spread_json',
    aggregate: 'spread',
    datasetKey: 'spreadDataset',
  },
  { id: 'perm', column: 'perm_json', aggregate: 'split' },
  { id: 'entries', column: 'entries_json', aggregate: 'entries' },
];

function emptyFingerprintRow(overrides = {}) {
  return {
    session_id: 'session',
    sig: 'volatile-signature',
    push_json: '',
    spread_json: '[]',
    perm_json: JSON.stringify({ perModeEntries: [], changes: [] }),
    entries_json: '[]',
    ...overrides,
  };
}

function fingerprintRows(rows) {
  const fingerprint = createColdIngestFingerprint(FINGERPRINT_SIGNALS);
  for (const row of rows) fingerprint.addRow(row);
  return fingerprint.finish();
}

function rowsForDataset(datasetKey, values) {
  if (datasetKey === 'pushDataset') {
    return values.map((value, index) =>
      emptyFingerprintRow({
        session_id: `session-${index}`,
        push_json: JSON.stringify(value),
      })
    );
  }
  if (datasetKey === 'spreadDataset') {
    return [emptyFingerprintRow({ spread_json: JSON.stringify(values) })];
  }
  if (datasetKey === 'permissionRows') {
    return [
      emptyFingerprintRow({
        perm_json: JSON.stringify({ perModeEntries: values, changes: [] }),
      }),
    ];
  }
  if (datasetKey === 'permissionChanges') {
    return [
      emptyFingerprintRow({
        perm_json: JSON.stringify({ perModeEntries: [], changes: values }),
      }),
    ];
  }
  if (datasetKey === 'entries') {
    return [emptyFingerprintRow({ entries_json: JSON.stringify(values) })];
  }
  throw new Error(`unknown test dataset '${datasetKey}'`);
}

/** Fixture dirs the benchmark creates; used to prove it exited before building one. */
function fixtureDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('chd-cold-ingest-'));
}

/**
 * Run the benchmark in a child process with a tiny corpus so a validation
 * regression fails in seconds rather than minutes.
 */
function runBench(env, args = [], nodeArgs = []) {
  return spawnSync(
    process.execPath,
    [...nodeArgs, '--import', REGISTER_TS, BENCH, ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHD_COLD_INGEST_TARGET_MB: '1',
        CHD_COLD_INGEST_WORKERS: '1',
        ...env,
      },
    }
  );
}

function benchSummary(stdout) {
  const marker = 'JSON summary:\n';
  const offset = stdout.indexOf(marker);
  ok(offset >= 0, `benchmark did not print a JSON summary:\n${stdout}`);
  return JSON.parse(stdout.slice(offset + marker.length));
}

describe('envNumber — fail-closed control parsing', () => {
  it('falls back only when the variable is genuinely absent', () => {
    strictEqual(envNumber('X', SPEEDUP_SPEC, {}), 2);
    strictEqual(envNumber('X', SPEEDUP_SPEC, { X: undefined }), 2);
    strictEqual(envNumber('X', SPEEDUP_SPEC, { X: '' }), 2);
    // Whitespace-only is the shell's way of saying "unset"; `Number('  ')` is
    // 0, which as a threshold would silently disable the gate.
    strictEqual(envNumber('X', SPEEDUP_SPEC, { X: '   ' }), 2);
  });

  it('rejects every threshold value that cannot fail a comparison', () => {
    // Each of these produced a passing gate at the audit baseline.
    for (const raw of ['garbage', 'NaN', '12g', '1_000', 'Infinity', '-Infinity', '1e999', '0', '-0', '-1', '-0.5']) {
      throws(
        () => envNumber('CHD_COLD_INGEST_MIN_SPEEDUP', SPEEDUP_SPEC, {
          CHD_COLD_INGEST_MIN_SPEEDUP: raw,
        }),
        EnvNumberError,
        `expected ${JSON.stringify(raw)} to be rejected`
      );
    }
  });

  it('accepts any finite positive threshold, fractional ones included', () => {
    for (const [raw, expected] of [['2', 2], ['0.5', 0.5], [' 3.75 ', 3.75], ['1e-3', 0.001]]) {
      strictEqual(
        envNumber('X', SPEEDUP_SPEC, { X: raw }),
        expected,
        `expected ${JSON.stringify(raw)} to parse`
      );
    }
  });

  it('enforces integrality and range instead of silently clamping', () => {
    const spec = { fallback: 384, integer: true, min: 1, max: 1024 };
    strictEqual(envNumber('X', spec, { X: '128' }), 128);
    // `parseInt('12g')` is 12 — a corpus 32x smaller than the one requested.
    throws(() => envNumber('X', spec, { X: '12g' }), EnvNumberError);
    throws(() => envNumber('X', spec, { X: '1.5' }), EnvNumberError);
    throws(() => envNumber('X', spec, { X: '0' }), EnvNumberError);
    throws(() => envNumber('X', spec, { X: '2048' }), EnvNumberError);
  });

  it('names the variable and the raw value in the error', () => {
    try {
      envNumber('CHD_COLD_INGEST_MIN_SPEEDUP', SPEEDUP_SPEC, {
        CHD_COLD_INGEST_MIN_SPEEDUP: 'garbage',
      });
      ok(false, 'expected a throw');
    } catch (err) {
      match(err.message, /CHD_COLD_INGEST_MIN_SPEEDUP/);
      match(err.message, /garbage/);
    }
  });
});

describe('cold-ingest streaming fingerprints — equivalence discrimination', () => {
  it('detects row value and row order changes', () => {
    const first = emptyFingerprintRow({ session_id: 'first', project: 'alpha' });
    const second = emptyFingerprintRow({ session_id: 'second', project: 'beta' });
    const baseline = fingerprintRows([first, second]);

    notStrictEqual(
      fingerprintRows([{ ...first, project: 'changed' }, second]).rowHash,
      baseline.rowHash,
      'a row value change must affect the row digest'
    );
    notStrictEqual(
      fingerprintRows([second, first]).rowHash,
      baseline.rowHash,
      'row order must affect the row digest'
    );
  });

  it('detects value and order changes in every transcript dataset', () => {
    for (const datasetKey of [
      'pushDataset',
      'spreadDataset',
      'permissionRows',
      'permissionChanges',
      'entries',
    ]) {
      const baseline = fingerprintRows(
        rowsForDataset(datasetKey, [{ id: 'first' }, { id: 'second' }])
      ).transcriptDatasetHash;
      const changed = fingerprintRows(
        rowsForDataset(datasetKey, [{ id: 'first' }, { id: 'changed' }])
      ).transcriptDatasetHash;
      const reordered = fingerprintRows(
        rowsForDataset(datasetKey, [{ id: 'second' }, { id: 'first' }])
      ).transcriptDatasetHash;

      notStrictEqual(
        changed,
        baseline,
        `${datasetKey} value changes must affect the dataset digest`
      );
      notStrictEqual(
        reordered,
        baseline,
        `${datasetKey} order changes must affect the dataset digest`
      );
    }
  });

  it('length-frames values so concatenation boundaries cannot collide', () => {
    // Without framing, the JSON values in both sequences concatenate to
    // exactly "123". The digest must still distinguish their boundaries.
    const oneThenTwentyThree = fingerprintRows(
      rowsForDataset('spreadDataset', [1, 23])
    ).transcriptDatasetHash;
    const twelveThenThree = fingerprintRows(
      rowsForDataset('spreadDataset', [12, 3])
    ).transcriptDatasetHash;

    notStrictEqual(oneThenTwentyThree, twelveThenThree);
  });
});

describe('cold-ingest benchmark — threshold is load-bearing end to end', () => {
  it('exits non-zero on a garbage threshold, before building a fixture', () => {
    const before = fixtureDirs();
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: 'garbage' });

    ok(run.status !== 0, `expected a non-zero exit, got ${run.status}`);
    match(run.stderr, /CHD_COLD_INGEST_MIN_SPEEDUP/);
    // "Corpus: N sessions" is printed only after the fixture is on disk.
    ok(
      !/^Corpus:/m.test(run.stdout),
      'benchmark built a corpus before validating its threshold'
    );
    deepStrictEqual(fixtureDirs(), before, 'benchmark left a fixture directory behind');
  });

  it('rejects a non-positive threshold rather than treating it as "do not gate"', () => {
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: '0' });
    ok(run.status !== 0, `expected a non-zero exit, got ${run.status}`);
    match(run.stderr, /CHD_COLD_INGEST_MIN_SPEEDUP/);
  });

  it('still fails a real shortfall when the threshold is valid', () => {
    // One worker on a 1 MiB corpus cannot beat the serial path by 1000x, so a
    // live comparison must reject this run. At the audit baseline the same
    // shortfall with a garbage threshold exited 0.
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: '1000' });
    ok(run.status !== 0, `expected a non-zero exit, got ${run.status}`);
    match(run.stdout, /^Speedup:/m);
    match(run.stderr, /is below required/);
  });

  it('--measure-only reports the same shortfall without gating', () => {
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: '1000' }, ['--measure-only']);
    strictEqual(run.status, 0, run.stderr);
    match(run.stdout, /not gated \(--measure-only\)/);
    match(run.stdout, /^Speedup:/m);
  });

  it('assembles the transcript dataset from the live signal descriptors', () => {
    // Regression guard for the hand-maintained key list that rotted when
    // ingest gained `valueFlow` / `secretsAtRest`: the bench died on a
    // TypeError before reaching any comparison. A completed run proves the
    // streaming fingerprint now tracks SESSION_SIGNALS.
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: '1000' });
    ok(
      !/Cannot read properties of undefined/.test(run.stderr),
      `benchmark crashed assembling the dataset:\n${run.stderr}`
    );
    match(run.stdout, /^Dataset hash:\s+[0-9a-f]{40}$/m);
  });

  it('bounds peak memory while preserving equivalence under load (#3451)', () => {
    // The pre-fix benchmark exits 134 here: serial rows, parallel rows, their
    // complete JSON strings, and both assembled datasets overlap in a 128 MiB
    // heap. A 16 MiB fixture keeps this regression deterministic and fast while
    // exercising the same process boundary as the documented 384 MiB run.
    const run = runBench(
      {
        CHD_COLD_INGEST_TARGET_MB: '16',
        CHD_COLD_INGEST_WORKERS: '2',
      },
      ['--measure-only'],
      ['--max-old-space-size=128']
    );

    strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
    match(run.stdout, /^Row hash:\s+[0-9a-f]{40}/m);
    match(run.stdout, /^Dataset hash:\s+[0-9a-f]{40}$/m);
    match(run.stdout, /^Peak RSS:\s+\d+(?:\.\d+)? MiB$/m);
    const summary = benchSummary(run.stdout);
    strictEqual(summary.parentConsumedRows, summary.corpus.sessions);
    strictEqual(summary.rowBatchSize, 32);
    match(summary.memoryPolicy, /acknowledged bounded row batch/);
    match(summary.sqliteWritePolicy, /parent consumes every parsed row/);
  });
});
