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

import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { EnvNumberError, envNumber } from './lib/env-number.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO_ROOT, 'scripts', 'cold-ingest-bench.mjs');
const REGISTER_TS = join(REPO_ROOT, 'scripts', 'register-ts.mjs');

/** Threshold spec the benchmark uses: finite and strictly positive. */
const SPEEDUP_SPEC = { fallback: 2, min: Number.MIN_VALUE };

/** Fixture dirs the benchmark creates; used to prove it exited before building one. */
function fixtureDirs() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('chd-cold-ingest-'));
}

/**
 * Run the benchmark in a child process with a tiny corpus so a validation
 * regression fails in seconds rather than minutes.
 */
function runBench(env, args = []) {
  return spawnSync(
    process.execPath,
    ['--import', REGISTER_TS, BENCH, ...args],
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
    // accumulator now tracks SESSION_SIGNALS.
    const run = runBench({ CHD_COLD_INGEST_MIN_SPEEDUP: '1000' });
    ok(
      !/Cannot read properties of undefined/.test(run.stderr),
      `benchmark crashed assembling the dataset:\n${run.stderr}`
    );
    match(run.stdout, /^Dataset hash:\s+[0-9a-f]{40}$/m);
  });
});
