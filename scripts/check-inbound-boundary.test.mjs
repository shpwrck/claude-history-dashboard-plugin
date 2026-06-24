// Regression coverage for the inbound api-client boundary gate (#2081).
//
// Proves the gate flags a raw network call outside the owner allowlist while
// ignoring an allowlisted owner, a comment-only mention, and a test file —
// the exact false-positive classes the design has to avoid (the parsers name
// `/api/` routes in doc comments pervasively).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInboundViolations } from './check-inbound-boundary.mjs';

test('flags raw network calls outside the allowlist; ignores owners, comments, tests (#2081)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbound-boundary-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'lib'), { recursive: true });
  mkdirSync(join(src, 'components'), { recursive: true });

  // Allowlisted owner: a raw fetch here is permitted.
  writeFileSync(join(src, 'lib', 'api-client.ts'), 'export const x = () => fetch("/api/x");\n');

  // Comment-only mentions (line, JSDoc): must be ignored — these are the prose
  // patterns the real codebase uses ("over-fetch (…)", "the fetch (fetchUsage)").
  writeFileSync(
    join(src, 'lib', 'parse-foo.ts'),
    '// Flags a first-call over-fetch (whole-file Read).\n' +
      '/**\n * The browser-side fetch (`fetchUsage`) lives in api-client.\n */\nexport const y = 1;\n'
  );

  // A test file: excluded from the scan.
  writeFileSync(join(src, 'components', 'Foo.test.tsx'), 'fetch("/api/y");\n');

  // Real violations: a stray fetch in a component and an EventSource in a lib.
  writeFileSync(join(src, 'components', 'Bad.tsx'), 'export const z = () => fetch("/api/bad");\n');
  writeFileSync(join(src, 'lib', 'live.ts'), 'export const s = new EventSource("/api/live");\n');

  try {
    const violations = findInboundViolations(src, ['lib/api-client.ts']);
    const files = violations.map((v) => v.file).sort();
    assert.deepEqual(
      files,
      ['components/Bad.tsx', 'lib/live.ts'],
      `unexpected violations: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean tree (only owners + comments) yields no violations (#2081)', () => {
  const root = mkdtempSync(join(tmpdir(), 'inbound-boundary-clean-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'lib'), { recursive: true });
  writeFileSync(join(src, 'lib', 'api-client.ts'), 'fetch("/api/x");\n');
  writeFileSync(join(src, 'lib', 'usage.ts'), '// the fetch (fetchUsage) lives in api-client\nexport const u = 2;\n');
  try {
    assert.deepEqual(findInboundViolations(src, ['lib/api-client.ts']), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
