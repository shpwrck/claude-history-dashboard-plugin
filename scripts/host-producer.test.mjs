// Unit coverage for the host-producer seam (#2077, ADR 0007).
//
// The seam (scripts/lib/host-producer.mjs) is the ONE place producers
// (ingest.mjs, repo-map-refresh.mjs, the #280 bridge) share root discovery +
// capped artifact reads. These tests pin the contract the seam exists to
// guarantee, in particular the ROBUSTNESS GAP it closes: repo-map-refresh.mjs
// previously read `~/.claude.json` and each artifact with an UNCAPPED
// `JSON.parse(readFileSync(...))`; the shared reader now enforces the byte cap,
// so a runaway/poisoned artifact can no longer balloon memory mid-deploy.
//
// Plain node (the seam is dependency-free `.mjs`, importable without register-ts):
//   node --test scripts/host-producer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  readArtifactTextCappedSync,
  readArtifactJsonCappedSync,
  isArtifactFileTooLargeError,
  unwrapHostArtifactRoot,
  claudeJsonProjectRoots,
  repoMapArtifactRoots,
  resolveArtifactFileMaxBytes,
  resolveRepoMapArtifactMaxEntries,
} = await import('./lib/host-producer.mjs');

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chd-2077-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('capped read throws ERR_DASHBOARD_ARTIFACT_FILE_TOO_LARGE past the cap (the gap repo-map-refresh left open)', () => {
  withTmp((dir) => {
    const big = join(dir, 'big.json');
    writeFileSync(big, JSON.stringify({ blob: 'x'.repeat(4096) }));
    assert.throws(
      () => readArtifactTextCappedSync(big, 1024),
      (err) => isArtifactFileTooLargeError(err) && err.maxBytes === 1024
    );
    // Same gap on the JSON wrapper repo-map-refresh used uncapped.
    assert.throws(
      () => readArtifactJsonCappedSync(big, 1024),
      (err) => isArtifactFileTooLargeError(err)
    );
  });
});

test('capped read returns the content when within the cap', () => {
  withTmp((dir) => {
    const f = join(dir, 'ok.json');
    writeFileSync(f, JSON.stringify({ hello: 'world' }));
    assert.deepEqual(readArtifactJsonCappedSync(f, 1 << 20), { hello: 'world' });
  });
});

test('unwrapHostArtifactRoot tolerates the envelope, a flat artifact, and rejects garbage', () => {
  assert.equal(
    unwrapHostArtifactRoot({ version: 1, map: { root: '/a', files: [] } }),
    '/a'
  );
  assert.equal(unwrapHostArtifactRoot({ root: '/b', files: [] }), '/b');
  // No files array, relative root, or non-object -> null.
  assert.equal(unwrapHostArtifactRoot({ map: { root: '/c' } }), null);
  assert.equal(unwrapHostArtifactRoot({ root: 'rel', files: [] }), null);
  assert.equal(unwrapHostArtifactRoot(null), null);
  assert.equal(unwrapHostArtifactRoot('nope'), null);
});

test('claudeJsonProjectRoots returns sorted absolute roots, [] when absent/unreadable', () => {
  withTmp((dir) => {
    const cj = join(dir, '.claude.json');
    writeFileSync(
      cj,
      JSON.stringify({ projects: { '/z/proj': {}, '/a/proj': {}, 'rel': {} } })
    );
    assert.deepEqual(claudeJsonProjectRoots(cj), ['/a/proj', '/z/proj']);
    assert.deepEqual(claudeJsonProjectRoots(join(dir, 'missing.json')), []);
  });
});

test('repoMapArtifactRoots discovers + dedupes + sorts roots and honors the entry cap', () => {
  withTmp((dir) => {
    const mk = (name, root) =>
      writeFileSync(
        join(dir, name),
        JSON.stringify({ version: 1, map: { root, files: [{ path: 'a.ts' }] } })
      );
    mk('a.json', '/proj/b');
    mk('b.json', '/proj/a');
    mk('c.json', '/proj/a'); // dup root, different file
    writeFileSync(join(dir, 'not-json.json'), '{ broken');
    writeFileSync(join(dir, 'ignored.txt'), 'x');

    const all = repoMapArtifactRoots(dir);
    assert.deepEqual(all, ['/proj/a', '/proj/b']);

    // maxEntries bounds how many directory entries are scanned (runaway guard).
    const capped = repoMapArtifactRoots(dir, { maxEntries: 1 });
    assert.ok(capped.length <= 1, `expected <=1 root under cap, got ${capped.length}`);

    // Missing dir -> [].
    assert.deepEqual(repoMapArtifactRoots(join(dir, 'nope')), []);
  });
});

test('resolvers clamp env overrides', () => {
  assert.equal(resolveArtifactFileMaxBytes({ DASHBOARD_ARTIFACT_FILE_MAX_BYTES: '1024' }), 65_536); // clamped up to floor
  assert.equal(
    resolveArtifactFileMaxBytes({ DASHBOARD_ARTIFACT_FILE_MAX_BYTES: '131072' }),
    131_072
  );
  assert.equal(
    resolveRepoMapArtifactMaxEntries({ DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES: '7' }),
    7
  );
  assert.equal(resolveRepoMapArtifactMaxEntries({}), 50_000); // default
});
