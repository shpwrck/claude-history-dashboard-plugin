// npm package-surface and packed-CLI contract (#3448).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8')
).version;

function npmPack(args, cwd = PROJECT_DIR) {
  const result = spawnSync('npm', ['pack', '--json', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout)[0];
}

test('npm pack dry-run exposes only the reviewed runtime surface', () => {
  const packed = npmPack(['--dry-run']);
  const files = packed.files.map(({ path }) => path).sort();

  assert.ok(files.includes('bin/coding-agent-dashboard.mjs'));
  assert.ok(files.includes('scripts/recommendations-statusline.mjs'));
  assert.ok(files.includes('dist/index.html'), 'build dist/index.html before testing the package');
  assert.ok(files.some((path) => path.startsWith('dist/assets/')));

  const unexpected = files.filter(
    (path) =>
      path !== 'package.json' &&
      !/^(?:README|LICENSE|LICENCE|COPYING)(?:\.[^/]*)?$/i.test(path) &&
      !path.startsWith('bin/') &&
      !path.startsWith('dist/') &&
      path !== 'scripts/recommendations-statusline.mjs'
  );
  assert.deepEqual(unexpected, []);

  assert.equal(files.some((path) => path.startsWith('docs/')), false);
  assert.equal(files.some((path) => /^[^/]+\.png$/i.test(path)), false);
  assert.equal(files.includes('HANDOFF.md'), false);
  assert.equal(files.some((path) => /(^|\/)\.groom-/.test(path)), false);
  assert.deepEqual(
    files.filter((path) => path.startsWith('scripts/')),
    ['scripts/recommendations-statusline.mjs']
  );
});

test('the CLI runs from the actual packed tarball, including its lazy recs import', () => {
  const temp = mkdtempSync(join(tmpdir(), 'package-surface-'));
  try {
    const packed = npmPack(['--pack-destination', temp]);
    const tarball = join(temp, packed.filename);
    const extract = spawnSync('tar', ['-xzf', tarball, '-C', temp], {
      encoding: 'utf8',
    });
    assert.equal(extract.status, 0, extract.stderr);

    const packageRoot = join(temp, 'package');
    const cli = join(packageRoot, 'bin', 'coding-agent-dashboard.mjs');
    const version = spawnSync(process.execPath, [cli, '--version'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), PACKAGE_VERSION);

    const input = join(temp, 'recommendations.json');
    writeFileSync(
      input,
      JSON.stringify([{ id: 'privacy', severity: 'warning', title: 'Keep paths portable' }])
    );
    const recs = spawnSync(process.execPath, [cli, 'recs', '--input', input, '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(recs.status, 0, recs.stderr);
    assert.equal(JSON.parse(recs.stdout).id, 'privacy');

    // The lazy runtime dependency must have come from the tarball, not this
    // checkout. Removing it would make the `recs` invocation above fail.
    assert.match(
      readFileSync(join(packageRoot, 'scripts', 'recommendations-statusline.mjs'), 'utf8'),
      /export async function main/
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
