// Tests for the binary-source gate (#3417).
//
// The gate's value is entirely in the failing case, so that is what these
// mostly cover. Fixtures build their NUL from `String.fromCharCode(0)` so this
// file itself stays text — a test for the NUL gate that tripped the NUL gate
// would be a poor advertisement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  nulCount,
  scanForBinarySources,
  SCANNED_ROOTS,
  TEXT_EXTENSIONS,
} from './check-no-binary-sources.mjs';
import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'check-no-binary-sources.mjs');

const NUL = String.fromCharCode(0);

function withFixtureRoot(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'binary-source-gate-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolute = join(root, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('nulCount counts NUL bytes and nothing else', () => {
  assert.equal(nulCount(Buffer.from('plain text')), 0);
  assert.equal(nulCount(Buffer.from(`a${NUL}b`)), 1);
  assert.equal(nulCount(Buffer.from(`${NUL}a${NUL}b${NUL}`)), 3);
  // High bytes and multi-byte UTF-8 are text, not binary, for this purpose.
  assert.equal(nulCount(Buffer.from('ünïcødé — em dash')), 0);
});

test('a source file with a raw NUL is reported', () => {
  withFixtureRoot(
    { 'src/lib/keys.ts': `const key = \`\${a}${NUL}\${b}\`;\n` },
    (root) => {
      const offenders = scanForBinarySources(root, ['src']);
      assert.equal(offenders.length, 1);
      assert.equal(offenders[0].file, 'src/lib/keys.ts');
      assert.equal(offenders[0].nuls, 1);
      assert.ok(offenders[0].firstByteOffset > 0);
    }
  );
});

test('the same key written with the \\u0000 ESCAPE is clean', () => {
  // The point of the gate: the idiom is fine, the raw byte is not.
  withFixtureRoot(
    { 'src/lib/keys.ts': 'const key = `${a}\\u0000${b}`;\n' },
    (root) => {
      assert.deepEqual(scanForBinarySources(root, ['src']), []);
    }
  );
});

test('counts every NUL and reports the first offset', () => {
  withFixtureRoot({ 'src/a.ts': `x${NUL}y${NUL}z` }, (root) => {
    const [offender] = scanForBinarySources(root, ['src']);
    assert.equal(offender.nuls, 2);
    assert.equal(offender.firstByteOffset, 1);
  });
});

test('scans every declared text extension', () => {
  const files = {};
  for (const ext of TEXT_EXTENSIONS) files[`src/f${ext}`] = `a${NUL}b`;
  withFixtureRoot(files, (root) => {
    const offenders = scanForBinarySources(root, ['src']);
    assert.equal(offenders.length, TEXT_EXTENSIONS.length);
  });
});

test('leaves genuine binary assets alone', () => {
  // An unlisted extension is not scanned, so a real fixture asset under src/
  // cannot fail a gate that was never meant to police it.
  withFixtureRoot(
    { 'src/fixtures/logo.png': `PNG${NUL}${NUL}data`, 'src/ok.ts': 'export const a = 1;\n' },
    (root) => {
      assert.deepEqual(scanForBinarySources(root, ['src']), []);
    }
  );
});

test('skips vendored and build output', () => {
  withFixtureRoot(
    {
      'src/node_modules/pkg/index.js': `a${NUL}b`,
      'src/dist/bundle.js': `a${NUL}b`,
    },
    (root) => {
      assert.deepEqual(scanForBinarySources(root, ['src']), []);
    }
  );
});

test('does not follow symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'binary-source-gate-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'binary-source-gate-out-'));
  try {
    writeFileSync(join(outside, 'tainted.ts'), `a${NUL}b`);
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(join(outside, 'tainted.ts'), join(root, 'src', 'linked.ts'));
    assert.deepEqual(scanForBinarySources(root, ['src']), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a MISSING configured scan root is a loud failure, never a silent green (#3478)', () => {
  // This inverts the behavior an earlier version of this suite ENSHRINED
  // ("a missing scanned root is not a failure"): if src/ were renamed or the
  // gate run from the wrong directory, it scanned zero files and passed — a
  // green NUL-gate that had verified nothing.
  withFixtureRoot({ 'src/a.ts': 'export const a = 1;\n' }, (root) => {
    assert.throws(
      () => scanForBinarySources(root, ['src', 'scripts']),
      /configured scan root "scripts" not found/
    );
  });
});

test('CLI: a fixture root containing a raw NUL must exit 1 (the gate can fail)', () => {
  withFixtureRoot(
    {
      'src/lib/keys.ts': `const key = \`\${a}${NUL}\${b}\`;\n`,
      'scripts/ok.mjs': 'export const fine = true;\n',
    },
    (root) => {
      const r = runGate(GATE, [root]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /src\/lib\/keys\.ts/);
      assert.match(r.out, /NUL byte/);
    }
  );
});

test('CLI: a missing configured root exits 2 (misconfigured, inspected nothing)', () => {
  withFixtureRoot({ 'src/a.ts': 'export const a = 1;\n' }, (root) => {
    const r = runGate(GATE, [root]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /configured scan root "scripts" not found/);
    assert.doesNotMatch(r.out, /every source file is diffable/);
  });
});

test('CLI: a clean fixture tree with both roots present exits 0', () => {
  withFixtureRoot(
    {
      'src/a.ts': 'export const a = 1;\n',
      'scripts/b.mjs': 'export const b = 2;\n',
    },
    (root) => {
      const r = runGate(GATE, [root]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /every source file is diffable/);
    }
  );
});

test('the real repository is clean', () => {
  // Three NUL-bearing files existed on master when this gate was written
  // (doc-relationship.ts, parse-config-sections.ts, parse-errors.ts); they were
  // repaired in the same change. This asserts they stay repaired.
  assert.deepEqual(scanForBinarySources(), []);
  assert.deepEqual(SCANNED_ROOTS.slice().sort(), ['scripts', 'src']);
});
