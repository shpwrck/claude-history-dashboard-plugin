// The engine-absent gate (#2719) must be ABLE to fail (#3478, epic #1930).
//
// Run: node --test scripts/check-engine-absent.test.mjs   (npm run test:engine-absent)
//
// Drives the real script as a subprocess via the shared gate harness and
// asserts on EXIT CODES — the only thing CI consumes. The defect this pins:
// an empty-but-present dist scanned 0 assets, printed "ok", and exited 0,
// so a build that emitted nothing (or into the wrong directory) passed the
// "engine is absent" check without inspecting a single byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'check-engine-absent.mjs');
// Kept in sync with DETECTOR_CATALOG_MARKER in src/lib/detectors/index.ts.
const MARKER = 'CHD_DETECTOR_CATALOG_v2719_PRESENT';

function withDist(build, run) {
  const dist = mkdtempSync(join(tmpdir(), 'engine-absent-gate-'));
  try {
    build(dist);
    return run(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('the sentinel in an emitted asset FAILS the gate (exit 1)', () => {
  withDist(
    (dist) => {
      mkdirSync(join(dist, 'assets'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<main></main>');
      writeFileSync(
        join(dist, 'assets', 'index-leak.js'),
        `console.log("${MARKER}");\n`
      );
    },
    (dist) => {
      const r = runGate(GATE, [dist]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /engine leaked/);
      assert.match(r.out, /index-leak\.js/);
    }
  );
});

test('an EMPTY dist is "verified nothing" — exit 2, never a green pass', () => {
  withDist(
    (dist) => {
      // Present directory, zero browser assets (a .css does not count).
      mkdirSync(join(dist, 'assets'), { recursive: true });
      writeFileSync(join(dist, 'assets', 'style.css'), '.ok{}\n');
    },
    (dist) => {
      const r = runGate(GATE, [dist]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /0 files scanned/);
      assert.match(r.out, /verified NOTHING/);
      assert.doesNotMatch(r.out, /^ok:/m);
    }
  );
});

test('a MISSING dist is exit 2', () => {
  const r = runGate(GATE, [join(tmpdir(), 'engine-absent-gate-does-not-exist')]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot read/);
});

test('a clean dist with real assets passes (exit 0) and reports the scan count', () => {
  withDist(
    (dist) => {
      mkdirSync(join(dist, 'assets'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<main></main>');
      writeFileSync(join(dist, 'assets', 'index-clean.js'), 'console.log("viewer");\n');
    },
    (dist) => {
      const r = runGate(GATE, [dist]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /ok: recommendation engine absent/);
      assert.match(r.out, /2 browser assets scanned/);
    }
  );
});
