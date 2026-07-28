// Unit tests for the sourcemap byte attribution in analyze-bundle.mjs (#3068).
//
// The report labels its per-group numbers "built bytes" and compares them with
// the on-disk sizes from statSync(). Attribution used to subtract sourcemap
// COLUMNS — UTF-16 code-unit offsets — so a single non-ASCII character in an
// emitted chunk made the two disagree, and the leading/uncovered regions of a
// generated line were charged to nobody at all. These tests pin the byte
// contract: every attributed span is a real UTF-8 byte count, and the spans sum
// EXACTLY to the chunk's byte length.
//
// Run: node --test scripts/analyze-bundle.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attributeChunk, attributeChunkSource } from './analyze-bundle.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 VLQ encode one signed integer (sourcemap segment field). */
function encodeVLQ(n) {
  let vlq = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += B64[digit];
  } while (vlq > 0);
  return out;
}

const seg = (fields) => fields.map(encodeVLQ).join('');

// A chunk whose first line contains a multibyte character (é = 2 UTF-8 bytes),
// split across two mapped sources, followed by a line the map does not cover.
//
//   line 0: `const a="é";`  cols  0..8  -> src/a.ts, cols 9..end -> src/b.ts
//   line 1: `const b=1;`    no mapping  -> (unmapped)
const CODE = 'const a="é";\nconst b=1;\n';
const MAP = {
  version: 3,
  sources: ['src/a.ts', 'src/b.ts'],
  mappings: `${seg([0, 0, 0, 0])},${seg([9, 1, 0, 0])};;`,
};

test('attributeChunkSource: a multibyte span is charged its exact UTF-8 byte length', () => {
  const bySource = attributeChunkSource(CODE, MAP);
  // `const a="` — 9 ASCII bytes.
  assert.equal(bySource.get('src/a.ts'), 9);
  // `é";` plus the newline byte: 2 + 1 + 1 + 1 = 5. Column subtraction reported
  // 4 here, because `é` is one UTF-16 code unit but two bytes.
  assert.equal(
    bySource.get('src/b.ts'),
    Buffer.byteLength('é";\n', 'utf8')
  );
  assert.equal(bySource.get('src/b.ts'), 5);
});

test('attributeChunkSource: attributed spans sum exactly to the chunk byte length', () => {
  const bySource = attributeChunkSource(CODE, MAP);
  const attributed = [...bySource.values()].reduce((s, n) => s + n, 0);
  assert.equal(attributed, Buffer.byteLength(CODE, 'utf8'));
  // The generated line no mapping covers is not silently dropped.
  assert.equal(bySource.get('(unmapped)'), Buffer.byteLength('const b=1;\n', 'utf8'));
});

test('attributeChunkSource: the run before the first mapping on a line is unmapped, not free', () => {
  const code = 'abécd';
  const map = {
    version: 3,
    sources: ['src/only.ts'],
    // First (and only) mapping starts at column 3, after `abé`.
    mappings: seg([3, 0, 0, 0]),
  };
  const bySource = attributeChunkSource(code, map);
  assert.equal(bySource.get('(unmapped)'), Buffer.byteLength('abé', 'utf8')); // 4
  assert.equal(bySource.get('src/only.ts'), Buffer.byteLength('cd', 'utf8')); // 2
  const attributed = [...bySource.values()].reduce((s, n) => s + n, 0);
  assert.equal(attributed, Buffer.byteLength(code, 'utf8'));
});

test('attributeChunk: reads chunk + map from disk and matches the on-disk byte size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyze-bundle-'));
  try {
    const jsPath = join(dir, 'index-abcdefgh.js');
    writeFileSync(jsPath, CODE, 'utf8');
    writeFileSync(`${jsPath}.map`, JSON.stringify(MAP), 'utf8');
    const bySource = attributeChunk(jsPath, `${jsPath}.map`);
    const attributed = [...bySource.values()].reduce((s, n) => s + n, 0);
    // statSync().size is what the report compares group totals against.
    assert.equal(attributed, Buffer.byteLength(CODE, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
