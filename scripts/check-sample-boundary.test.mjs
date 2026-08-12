import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROJECT_DIR, runGate } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'check-sample-boundary.mjs');
const SAME_ORIGIN_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'">`;

function withDist(files, run) {
  const dist = mkdtempSync(join(tmpdir(), 'sample-boundary-'));
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), SAME_ORIGIN_CSP);
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dist, 'assets', name), source);
    }
    return run(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('a clean emitted sample bundle passes', () => {
  withDist({ 'index-aaaaaaaa.js': 'export const sample=true;' }, (dist) => {
    const result = runGate(GATE, ['--dist', dist]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /Sample boundary clean/);
  });
});

test('a server route in emitted bytes fails the real gate', () => {
  withDist({ 'index-aaaaaaaa.js': 'fetch("/api/dataset.json")' }, (dist) => {
    const result = runGate(GATE, ['--dist', dist]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /server-only marker/);
  });
});

test('an external source in the emitted sample CSP fails the real gate', () => {
  withDist({}, (dist) => {
    writeFileSync(
      join(dist, 'index.html'),
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://api.anthropic.com">`,
    );
    const result = runGate(GATE, ['--dist', dist]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /same-origin connect-src/);
  });
});

test('a missing emitted sample CSP fails closed', () => {
  withDist({}, (dist) => {
    writeFileSync(join(dist, 'index.html'), '<div id="root"></div>');
    const result = runGate(GATE, ['--dist', dist]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /exactly one emitted CSP meta tag/);
  });
});

test('a missing emitted bundle fails closed as a usage error', () => {
  const missing = join(tmpdir(), 'sample-boundary-does-not-exist');
  const result = runGate(GATE, ['--dist', missing]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /verified NOTHING/);
});
