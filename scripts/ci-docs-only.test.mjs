// The docs-only classifier — the master switch whose docs_only output guards
// every job in five workflows — must keep its fail-closed contract (#3478).
//
// Run: node --test scripts/ci-docs-only.test.mjs   (npm run test:ci-docs-only)
//
// The behavior is ALREADY fail-closed; these tests pin it so it cannot regress
// silently: an empty diff is NOT docs-only (`files.length > 0 && …`), and no
// resolvable diff strategy is a hard error, never a shrugged docs_only=false…
// or worse, =true, which would skip lint/build/test on every PR.
//
// Each case spawns the real script (via the shared gate harness) inside a
// throwaway git repo. The GITHUB_* vars the script reads are explicitly
// overridden per spawn — set to '' where unset behavior is wanted — so a CI
// runner's own pull_request env can't leak into the fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { runGate, PROJECT_DIR } from './lib/gate-harness.mjs';

const SCRIPT = join(PROJECT_DIR, 'scripts', 'ci-docs-only.mjs');

// Neutralize the runner's own PR context; individual tests override on top.
const CLEAN_ENV = {
  GITHUB_BASE_REF: '',
  GITHUB_EVENT_PULL_REQUEST_BASE_SHA: '',
  GITHUB_EVENT_PULL_REQUEST_HEAD_SHA: '',
  GITHUB_OUTPUT: '',
};

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function commitFiles(repo, message, files) {
  for (const [relPath, contents] of Object.entries(files)) {
    const absolute = join(repo, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  git(repo, ['add', '-A']);
  git(repo, [
    '-c', 'user.name=fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-q', '-m', message,
  ]);
}

function withRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), 'ci-docs-only-'));
  try {
    git(repo, ['init', '-q']);
    commitFiles(repo, 'base', { 'src/app.ts': 'export const a = 1;\n' });
    return run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function classify(repo, env = {}) {
  return runGate(SCRIPT, [], { cwd: repo, env: { ...CLEAN_ENV, ...env } });
}

test('an EMPTY diff is NOT docs-only (nothing changed proves nothing)', () => {
  withRepo((repo) => {
    commitFiles(repo, 'empty head commit', {});
    const r = classify(repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /docs_only=false/);
    assert.doesNotMatch(r.out, /docs_only=true/);
  });
});

test('no resolvable diff strategy is a HARD nonzero exit, never a silent verdict', () => {
  withRepo((repo) => {
    commitFiles(repo, 'head', { 'docs/a.md': '# doc\n' });
    // A PR context (base ref set) whose base cannot be diffed: origin/nope
    // does not exist, and no event SHAs are provided.
    const r = classify(repo, { GITHUB_BASE_REF: 'nope' });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /could not determine pull request changed files/);
    assert.doesNotMatch(r.out, /docs_only=/);
  });
});

test('a MIXED diff (docs + code) is not docs-only', () => {
  withRepo((repo) => {
    commitFiles(repo, 'mixed', {
      'docs/guide.md': '# guide\n',
      'src/lib/thing.ts': 'export const b = 2;\n',
    });
    const r = classify(repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /docs_only=false/);
  });
});

test('a pure-docs diff IS docs-only', () => {
  withRepo((repo) => {
    commitFiles(repo, 'docs', {
      'docs/guide.md': '# guide\n',
      'README.md': '# readme\n',
    });
    const r = classify(repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /docs_only=true/);
  });
});
