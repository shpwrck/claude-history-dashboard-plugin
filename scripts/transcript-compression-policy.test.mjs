import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('transcript cache uses fast lossless brotli settings', async () => {
  const ingest = await readFile(new URL('./ingest.mjs', import.meta.url), 'utf8');
  const match = ingest.match(/const TRANSCRIPT_BROTLI_QUALITY = (\d+);/);

  assert.ok(match, 'expected an explicit transcript brotli quality constant');
  assert.ok(Number(match[1]) <= 5, 'transcript writes should avoid max-quality brotli');
  assert.match(ingest, /BROTLI_PARAM_SIZE_HINT/);
  assert.doesNotMatch(ingest, /BROTLI_PARAM_QUALITY\]: 11/);
});
