// Unit tests for refresh-image-digests.mjs (#3503): re-resolving the pinned
// container digests Dependabot's docker updater does not cover, and rewriting
// them (including the #3340 actions-runner stamp cascade) without ever breaking
// check-action-pins.mjs.
//
// node:test, no network — the registry resolver is exercised through a mocked
// fetch and through CHD_DIGEST_FIXTURE. Run: npm run test:refresh-image-digests
//   (= node --test scripts/refresh-image-digests.test.mjs)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRunnerCascade,
  composeSummary,
  computeStamp,
  escapeRegExp,
  parseStamp,
  recipeHex,
  resolveDigest,
  rewriteSimpleDigest,
} from './refresh-image-digests.mjs';

const OLD = '08c30b0a7105f64bddfc485d2487a22aa03932a791402393352fdf674bda2c29';
const NEW = '0cfdcc701ce933c6d243c6b0b2da767366dc9f2e99961d4c3754b0b78084cdda';

function withFixture(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'digest-fixture-'));
  const path = join(dir, 'fixture.json');
  writeFileSync(path, JSON.stringify(obj));
  const prev = process.env.CHD_DIGEST_FIXTURE;
  process.env.CHD_DIGEST_FIXTURE = path;
  return Promise.resolve(fn())
    .finally(() => {
      if (prev === undefined) delete process.env.CHD_DIGEST_FIXTURE;
      else process.env.CHD_DIGEST_FIXTURE = prev;
      rmSync(dir, { recursive: true, force: true });
    });
}

test('recipeHex is the first 8 hex of the content SHA-256 (the #3340 suffix)', () => {
  // Matches `sha256sum <file> | cut -c1-8`.
  const hex = recipeHex('FROM scratch\n');
  assert.match(hex, /^[0-9a-f]{8}$/);
  assert.equal(recipeHex('FROM scratch\n'), recipeHex('FROM scratch\n'));
  assert.notEqual(recipeHex('a'), recipeHex('b'));
});

test('computeStamp joins date and content hash', () => {
  const stamp = computeStamp('FROM scratch\n', '2026-08-04');
  assert.match(stamp, /^v2026-08-04-[0-9a-f]{8}$/);
  assert.equal(stamp, `v2026-08-04-${recipeHex('FROM scratch\n')}`);
});

test('parseStamp extracts the in-force chd-ci-runner stamp', () => {
  assert.equal(parseStamp('name: chd-ci-runner:v2026-08-03-5a29159a\n'), 'v2026-08-03-5a29159a');
  assert.equal(parseStamp('nothing here'), null);
});

test('escapeRegExp neutralizes the digest-pin punctuation', () => {
  const prefix = 'caddy:2-alpine@sha256:';
  const re = new RegExp(escapeRegExp(prefix) + '([0-9a-f]{64})');
  assert.ok(re.test(`caddy:2-alpine@sha256:${OLD}`));
});

test('rewriteSimpleDigest swaps only on a real move', () => {
  const text = `image: caddy:2-alpine@sha256:${OLD}\n`;
  const moved = rewriteSimpleDigest(text, 'caddy:2-alpine@sha256:', NEW);
  assert.equal(moved.changed, true);
  assert.equal(moved.oldHex, OLD);
  assert.ok(moved.text.includes(NEW));
  assert.ok(!moved.text.includes(OLD));

  const same = rewriteSimpleDigest(text, 'caddy:2-alpine@sha256:', OLD);
  assert.equal(same.changed, false);
  assert.equal(same.text, text);
});

test('rewriteSimpleDigest fails loudly when the pin is absent', () => {
  assert.throws(() => rewriteSimpleDigest('no pin here', 'caddy:2-alpine@sha256:', NEW), /not found/);
});

test('applyRunnerCascade swaps the digest everywhere and re-stamps consistently', () => {
  const pinPrefix = 'ghcr.io/actions/actions-runner@sha256:';
  const dockerfileContent = `FROM ${pinPrefix}${OLD}\nRUN echo hi\n`;
  const buildconfigContent = [
    'spec:',
    '  output:',
    '    to:',
    '      name: chd-ci-runner:v2026-08-03-5a29159a',
    '  source:',
    '    dockerfile: |',
    `      FROM ${pinPrefix}${OLD}`,
    '      RUN echo hi',
    '  strategy:',
    '    dockerStrategy:',
    '      from:',
    `        name: ${pinPrefix}${OLD}`,
    '',
  ].join('\n');
  const valuesContent = 'image: .../chd-ci-runner:v2026-08-03-5a29159a\n';

  const files = {
    dockerfile: { path: 'Dockerfile', content: dockerfileContent },
    buildconfig: { path: 'buildconfig.yaml', content: buildconfigContent },
    stamp: {
      'buildconfig.yaml': { path: 'buildconfig.yaml', content: buildconfigContent },
      'values.yaml': { path: 'values.yaml', content: valuesContent },
    },
  };

  const { rewritten, oldStamp, newStamp } = applyRunnerCascade({
    files,
    pinPrefix,
    oldHex: OLD,
    newHex: NEW,
    date: '2026-08-04',
  });

  assert.equal(oldStamp, 'v2026-08-03-5a29159a');

  const newDockerfile = rewritten['Dockerfile'];
  // Digest swapped in the Dockerfile, BuildConfig inline copy, and the input.
  assert.ok(newDockerfile.includes(NEW) && !newDockerfile.includes(OLD));
  const newBuildconfig = rewritten['buildconfig.yaml'];
  assert.equal((newBuildconfig.match(new RegExp(NEW, 'g')) || []).length, 2);
  assert.ok(!newBuildconfig.includes(OLD));

  // The new stamp is derived from the NEW Dockerfile content exactly as
  // check-action-pins.mjs recomputes it from the file it reads.
  assert.equal(newStamp, computeStamp(newDockerfile, '2026-08-04'));
  assert.ok(newBuildconfig.includes(newStamp) && !newBuildconfig.includes(oldStamp));
  assert.ok(rewritten['values.yaml'].includes(newStamp));

  // Byte-parity: the BuildConfig inline recipe de-indents to the Dockerfile,
  // the property check-action-pins.mjs enforces (runnerRecipeParityOffenders).
  const inline = newBuildconfig
    .split('\n')
    .slice(6, 8)
    .map((l) => l.slice(6))
    .join('\n') + '\n';
  assert.equal(inline, newDockerfile);
});

test('resolveDigest reads a fixture and rejects a missing key', async () => {
  await withFixture({ 'registry-1.docker.io/library/caddy:2-alpine': `sha256:${NEW}` }, async () => {
    const got = await resolveDigest({
      registry: 'registry-1.docker.io',
      repository: 'library/caddy',
      tag: '2-alpine',
    });
    assert.equal(got, `sha256:${NEW}`);

    await assert.rejects(
      resolveDigest({ registry: 'ghcr.io', repository: 'actions/actions-runner', tag: 'latest' }),
      /no entry for/
    );
  });
});

test('resolveDigest reads Docker-Content-Digest from a mocked registry', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ token: 'abc' }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'docker-content-digest' ? `sha256:${NEW}` : null) },
    };
  };
  const got = await resolveDigest(
    { registry: 'registry-1.docker.io', repository: 'library/node', tag: '24-slim' },
    fetchImpl
  );
  assert.equal(got, `sha256:${NEW}`);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith('/v2/library/node/manifests/24-slim'));
});

test('resolveDigest throws on a manifest error status', async () => {
  const fetchImpl = async (url) =>
    url.includes('/token')
      ? { ok: true, status: 200, json: async () => ({ token: 'abc' }) }
      : { ok: false, status: 404, headers: { get: () => null } };
  await assert.rejects(
    resolveDigest({ registry: 'ghcr.io', repository: 'actions/actions-runner', tag: 'latest' }, fetchImpl),
    /HTTP 404/
  );
});

test('composeSummary lists only moved targets with their new digests', () => {
  const body = composeSummary([
    {
      target: {
        description: 'caddy:2-alpine',
        registry: 'registry-1.docker.io',
        repository: 'library/caddy',
        tag: '2-alpine',
      },
      plan: { changed: true, oldHex: OLD, newHex: NEW, rewrites: { 'docker-compose.tls.yml': 'x' } },
    },
    { target: { description: 'unchanged' }, plan: { changed: false, rewrites: {} } },
  ]);
  assert.ok(body.includes('caddy:2-alpine'));
  assert.ok(body.includes(NEW));
  assert.ok(!body.includes('unchanged'));
});
