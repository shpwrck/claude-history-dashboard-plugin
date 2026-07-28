// Tests for the shell-quoting recurrence gate (#3379).
//
// The gate's whole value is that it FAILS on a re-typed copy, so the cases that
// matter are the failing ones. Every fixture below is inert text written to a
// temp directory; nothing here executes a generated command.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  violationIn,
  scanRepository,
  CANONICAL,
  KNOWN_EXCEPTIONS,
} from './check-shell-quote.mjs';

// Built at runtime so this file's own source does not contain the idiom it
// tests for (which would make the fixtures indistinguishable from the harness).
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(39);
/** The escape exactly as it appears in JS/TS source: `'\\''`. */
const IDIOM = QUOTE + BACKSLASH + BACKSLASH + QUOTE + QUOTE;

const COPY_VIA_TEMPLATE = `export function shellQuote(v) {\n  return \`${QUOTE}\${v.replace(/${QUOTE}/g, \`${IDIOM}\`)}${QUOTE}\`;\n}\n`;
const COPY_VIA_CONCAT = `export const shq = (s) => "${QUOTE}" + String(s).replace(/${QUOTE}/g, "${IDIOM}") + "${QUOTE}";\n`;
const ROUTED = `import { shellQuote } from './lib/shell-quote.mjs';\nexport const shq = (s) => shellQuote(String(s));\n`;

function withFixtureRoot(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'shell-quote-gate-'));
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

test('violationIn catches the escape however the replacement is spelled', () => {
  assert.ok(violationIn(COPY_VIA_TEMPLATE), 'template-literal copy must trip');
  assert.ok(violationIn(COPY_VIA_CONCAT), 'string-concatenation copy must trip');
  assert.ok(
    violationIn(`const x = "a".replaceAll("${QUOTE}", someOtherEscape);`),
    'replacing a single quote at all must trip, whatever the replacement is'
  );
});

test('violationIn does not fire on code that routes through the primitive', () => {
  assert.equal(violationIn(ROUTED), null);
  assert.equal(violationIn(`const s = "it${QUOTE}s fine";\n`), null);
  assert.equal(violationIn('export const x = 1;\n'), null);
});

test('a newly introduced private copy fails the gate', () => {
  withFixtureRoot(
    {
      'src/lib/shell-quote.ts': COPY_VIA_TEMPLATE,
      'src/lib/brand-new-detector.ts': COPY_VIA_TEMPLATE,
    },
    (root) => {
      const { offenders } = scanRepository(root, {
        canonical: ['src/lib/shell-quote.ts'],
        exceptions: {},
      });
      assert.deepEqual(
        offenders.map((o) => o.file),
        ['src/lib/brand-new-detector.ts']
      );
    }
  );
});

test('the canonical modules are allowed to spell the escape', () => {
  withFixtureRoot(
    {
      'src/lib/shell-quote.ts': COPY_VIA_TEMPLATE,
      'scripts/lib/shell-quote.mjs': COPY_VIA_TEMPLATE,
    },
    (root) => {
      const { offenders } = scanRepository(root, {
        canonical: ['src/lib/shell-quote.ts', 'scripts/lib/shell-quote.mjs'],
        exceptions: {},
      });
      assert.deepEqual(offenders, []);
    }
  );
});

test('test files may assert on escaped output without tripping the gate', () => {
  withFixtureRoot(
    {
      'src/lib/thing.test.ts': `expect(q).toBe(\`${IDIOM}\`);\n`,
      'scripts/thing.test.mjs': COPY_VIA_CONCAT,
    },
    (root) => {
      const { offenders } = scanRepository(root, { canonical: [], exceptions: {} });
      assert.deepEqual(offenders, []);
    }
  );
});

test('vendored and build output are not scanned', () => {
  withFixtureRoot(
    {
      'node_modules/pkg/index.mjs': COPY_VIA_CONCAT,
      'dist/assets/bundle.js': COPY_VIA_CONCAT,
    },
    (root) => {
      const { offenders } = scanRepository(root, { canonical: [], exceptions: {} });
      assert.deepEqual(offenders, []);
    }
  );
});

test('symlinks are skipped, not followed', () => {
  // Backs the SCOPE claim in the gate's header. A scanner that followed links
  // could wander outside the repo or loop; one that silently followed them
  // would also make the "which file tripped" report a lie.
  const root = mkdtempSync(join(tmpdir(), 'shell-quote-gate-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'shell-quote-gate-out-'));
  try {
    writeFileSync(join(outside, 'copy.mjs'), COPY_VIA_CONCAT);
    mkdirSync(join(root, 'src'), { recursive: true });
    symlinkSync(join(outside, 'copy.mjs'), join(root, 'src', 'linked.mjs'));
    symlinkSync(outside, join(root, 'src', 'linked-dir'));
    const { offenders } = scanRepository(root, { canonical: [], exceptions: {} });
    assert.deepEqual(offenders, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a tracked exception suppresses only that file', () => {
  withFixtureRoot(
    {
      'scripts/legacy.mjs': COPY_VIA_CONCAT,
      'scripts/other.mjs': COPY_VIA_CONCAT,
    },
    (root) => {
      const { offenders, staleExceptions } = scanRepository(root, {
        canonical: [],
        exceptions: { 'scripts/legacy.mjs': 'cannot import' },
      });
      assert.deepEqual(
        offenders.map((o) => o.file),
        ['scripts/other.mjs']
      );
      assert.deepEqual(staleExceptions, []);
    }
  );
});

test('the exception list is shrink-only: a repaired file must be delisted', () => {
  withFixtureRoot({ 'scripts/legacy.mjs': ROUTED }, (root) => {
    const { offenders, staleExceptions } = scanRepository(root, {
      canonical: [],
      exceptions: { 'scripts/legacy.mjs': 'cannot import' },
    });
    assert.deepEqual(offenders, []);
    assert.deepEqual(
      staleExceptions,
      ['scripts/legacy.mjs'],
      'a file that no longer holds a copy must not keep its exemption'
    );
  });
});

test('the exception list is shrink-only: a deleted file must be delisted', () => {
  withFixtureRoot({ 'scripts/kept.mjs': 'export const x = 1;\n' }, (root) => {
    const { staleExceptions } = scanRepository(root, {
      canonical: [],
      exceptions: { 'scripts/gone.mjs': 'cannot import' },
    });
    assert.deepEqual(staleExceptions, ['scripts/gone.mjs']);
  });
});

test('the real repository is clean', () => {
  const { offenders, staleExceptions } = scanRepository();
  assert.deepEqual(offenders, [], 'no file outside the canonical modules may re-type the escape');
  assert.deepEqual(staleExceptions, []);
  assert.deepEqual(CANONICAL.slice().sort(), [
    'scripts/lib/shell-quote.mjs',
    'src/lib/shell-quote.ts',
  ]);
  // Pin the exemption count so growing it is a deliberate, reviewed change.
  assert.deepEqual(Object.keys(KNOWN_EXCEPTIONS), [
    'scripts/audits/v060-audit-batch.workflow.mjs',
  ]);
});
