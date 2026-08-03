// Tests for the portable-host-path publish gate (#3448).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  findPersonalPathsInText,
  scanTrackedFiles,
} from './check-personal-paths.mjs';
import { PROJECT_DIR, runGate } from './lib/gate-harness.mjs';

const GATE = join(PROJECT_DIR, 'scripts', 'check-personal-paths.mjs');
const unixHome = (user, ...rest) => ['', 'home', user, ...rest].join('/');
const windowsHome = (user, ...rest) => ['C:', 'Users', user, ...rest].join('\\');

function withGitFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'personal-path-gate-'));
  try {
    const init = spawnSync('git', ['init', '--quiet'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stderr);
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolute = join(root, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    const add = spawnSync('git', ['add', '--', ...Object.keys(files)], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// perf-index-contract: personal-path-portable-users non-querying
test('does no allowlist work when source contains no host-home candidate', () => {
  let allowlistReads = 0;
  const allowedUsers = {
    has() {
      allowlistReads += 1;
      return false;
    },
  };
  assert.deepEqual(
    findPersonalPathsInText('The module is src/home/index.ts.', 'fixture.txt', {
      allowedUsers,
    }),
    []
  );
  assert.equal(allowlistReads, 0);
});

test('rejects unknown Unix and Windows home-directory identities', () => {
  const source = [
    `unix=${unixHome('someuser', 'project')}`,
    `windows=${windowsHome('someuser', 'project')}`,
  ].join('\n');
  const offenders = findPersonalPathsInText(source, 'fixture.txt');
  assert.deepEqual(
    offenders.map(({ style, user, line }) => ({ style, user, line })),
    [
      { style: 'unix', user: 'someuser', line: 1 },
      { style: 'windows', user: 'someuser', line: 2 },
    ]
  );
});

test('allows the mandatory generic container and CI identities', () => {
  const source = [
    unixHome('node', '.claude'),
    unixHome('runner', '_work'),
    unixHome('user', 'project'),
    windowsHome('user', 'project'),
  ].join('\n');
  assert.deepEqual(findPersonalPathsInText(source, 'fixture.txt'), []);
});

test('detects a file-URL path without mistaking a relative src/home path for a home directory', () => {
  const source = [
    `file://${unixHome('privateuser', '.claude', 'report.html')}`,
    'The module is src/home/index.ts.',
  ].join('\n');
  const offenders = findPersonalPathsInText(source, 'fixture.md');
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].user, 'privateuser');
  assert.equal(offenders[0].line, 1);
});

test('CLI rejects a tracked personal path but ignores an untracked one', () => {
  withGitFixture({
    'docs/bad.md': `host path: ${unixHome('someuser', 'private')}\n`,
    'docs/clean.md': `container path: ${unixHome('node', '.claude')}\n`,
  }, (root) => {
    writeFileSync(
      join(root, 'docs', 'untracked.md'),
      `untracked: ${unixHome('anotheruser', 'private')}\n`
    );
    const result = runGate(GATE, [root]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /docs\/bad\.md:1/);
    assert.match(result.out, /someuser/);
    assert.doesNotMatch(result.out, /anotheruser/);
  });
});

test('CLI fails closed when a tracked file cannot be inspected', () => {
  withGitFixture({ 'docs/gone.md': 'tracked first\n' }, (root) => {
    unlinkSync(join(root, 'docs', 'gone.md'));
    const result = runGate(GATE, [root]);
    assert.equal(result.code, 2, result.out);
    assert.match(result.out, /could not inspect tracked file docs\/gone\.md/);
    assert.doesNotMatch(result.out, /portable-host-path gate passed/);
  });
});

test('the real repository contains no unapproved personal host paths', () => {
  assert.deepEqual(scanTrackedFiles(), []);
});
