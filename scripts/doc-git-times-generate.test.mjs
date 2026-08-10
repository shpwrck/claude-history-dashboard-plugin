// Producer tests for the per-document Git-time manifest (#2707, epic #2256).
//
// Black-box over real fixture repositories: full history yields distinct,
// deterministic per-file last-commit times; shallow clones, non-repos, and
// over-cap doc sets fail closed WITHOUT writing (or clobbering) the output.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { DOC_GIT_STATUS_ARGS, main } from './doc-git-times-generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'doc-git-times-generate.mjs');

const D1 = '2026-01-05T10:00:00+00:00';
const D2 = '2026-02-10T12:30:00+00:00';

function git(root, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root, message, dateIso) {
  git(
    root,
    [
      '-c', 'user.name=Doc Git Times Test',
      '-c', 'user.email=doc-git-times@example.invalid',
      'commit', '--quiet', '-m', message,
    ],
    { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
  );
}

function runProducer(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Fixture: commit A (D1) adds README.md, docs/a.md, docs/dirty.md; commit B
 * (D2) rewrites docs/a.md and adds docs/b.md. Then docs/dirty.md is modified
 * in the working tree and docs/untracked.md is created but never added.
 */
function fullHistoryRepo() {
  const root = mkdtempSync(join(tmpdir(), 'doc-git-times-full-'));
  git(root, ['init', '--quiet']);
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# readme\n');
  writeFileSync(join(root, 'docs', 'a.md'), '# a v1\n');
  writeFileSync(join(root, 'docs', 'dirty.md'), '# dirty v1\n');
  // Outside the doc pathspecs — must never appear in the manifest.
  writeFileSync(join(root, 'src', 'notes.md'), '# not a doc\n');
  git(root, ['add', '.']);
  commit(root, 'first', D1);
  writeFileSync(join(root, 'docs', 'a.md'), '# a v2\n');
  writeFileSync(join(root, 'docs', 'b.md'), '# b\n');
  git(root, ['add', '.']);
  commit(root, 'second', D2);
  writeFileSync(join(root, 'docs', 'dirty.md'), '# dirty v2 (uncommitted)\n');
  // Porcelain hides this file once assume-unchanged is set. The producer must
  // still omit it based on the bounded ls-files index-state probe.
  git(root, ['update-index', '--assume-unchanged', 'docs/dirty.md']);
  writeFileSync(join(root, 'docs', 'untracked.md'), '# never added\n');
  return root;
}

describe('doc-git-times producer (#2707)', () => {
  test('uses a tracked-only status query instead of enumerating untracked files', () => {
    assert.equal(DOC_GIT_STATUS_ARGS.includes('-uno'), true);
  });

  test('writes distinct per-file last-commit times from full history, deterministically', () => {
    const root = fullHistoryRepo();
    try {
      const first = runProducer(['--root', root]);
      assert.equal(first.status, 0, first.stderr);

      const outFile = join(root, 'data', 'doc-git-times.json');
      const bytes = readFileSync(outFile, 'utf8');
      const manifest = JSON.parse(bytes);

      assert.equal(manifest.schemaVersion, 2);
      assert.equal(Object.hasOwn(manifest, 'complete'), false);
      assert.equal(manifest.sourceCommit, git(root, ['rev-parse', 'HEAD']));
      // Exactly the clean tracked docs — dirty/untracked/off-surface omitted.
      assert.deepEqual(Object.keys(manifest.files).sort(), [
        'README.md',
        'docs/a.md',
        'docs/b.md',
      ]);
      // Distinct, commit-accurate times: README from commit A, a/b from commit B.
      assert.equal(Date.parse(manifest.files['README.md']), Date.parse(D1));
      assert.equal(Date.parse(manifest.files['docs/a.md']), Date.parse(D2));
      assert.equal(Date.parse(manifest.files['docs/b.md']), Date.parse(D2));
      assert.notEqual(
        Date.parse(manifest.files['README.md']),
        Date.parse(manifest.files['docs/a.md'])
      );

      // Deterministic: a second run over the same state is byte-identical.
      const second = runProducer(['--root', root]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(outFile, 'utf8'), bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed on a shallow clone without writing the manifest', () => {
    const src = fullHistoryRepo();
    const parent = mkdtempSync(join(tmpdir(), 'doc-git-times-shallow-'));
    const shallow = join(parent, 'clone');
    try {
      git(parent, [
        'clone', '--quiet', '--depth', '1',
        pathToFileURL(src).href, shallow,
      ]);
      assert.equal(
        git(shallow, ['rev-parse', '--is-shallow-repository']),
        'true',
        'fixture must actually be shallow'
      );
      const result = runProducer(['--root', shallow]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /shallow/);
      assert.equal(existsSync(join(shallow, 'data', 'doc-git-times.json')), false);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('fails closed outside a git repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-git-times-norepo-'));
    try {
      const result = runProducer(['--root', root]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^doc-git-times: cannot verify repository depth:/);
      assert.doesNotMatch(result.stderr, /unexpected failure/);
      assert.equal(existsSync(join(root, 'data', 'doc-git-times.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the tracked doc set exceeds the entry cap, preserving prior output', () => {
    const root = fullHistoryRepo();
    try {
      // Seed a valid manifest first, then prove an over-cap run cannot clobber it.
      const seeded = runProducer(['--root', root]);
      assert.equal(seeded.status, 0, seeded.stderr);
      const outFile = join(root, 'data', 'doc-git-times.json');
      const before = readFileSync(outFile, 'utf8');

      const result = runProducer(['--root', root, '--max-files', '1']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cap/);
      assert.equal(readFileSync(outFile, 'utf8'), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed arguments', () => {
    assert.equal(runProducer(['--bogus']).status, 2);
    assert.equal(runProducer(['--max-files', '0']).status, 2);
    const removedOut = runProducer(['--out', 'elsewhere.json']);
    assert.equal(removedOut.status, 2);
    assert.match(removedOut.stderr, /unknown argument: --out/);
    assert.equal(runProducer(['--root']).status, 2);
  });

  test('fails closed when --root is a subdirectory below the repository toplevel', () => {
    const root = fullHistoryRepo();
    try {
      const result = runProducer(['--root', join(root, 'docs')]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /toplevel/);
      assert.equal(existsSync(join(root, 'docs', 'data', 'doc-git-times.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('still runs when invoked through a symlinked script path (guard must not fail open)', () => {
    const root = fullHistoryRepo();
    const linkDir = mkdtempSync(join(tmpdir(), 'doc-git-times-link-'));
    const link = join(linkDir, 'generate-link.mjs');
    try {
      symlinkSync(SCRIPT, link);
      const result = spawnSync(process.execPath, [link, '--root', root], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Node realpaths the ESM main module while argv[1] stays the symlink; a
      // lexical guard comparison would exit 0 here WITHOUT writing anything.
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(root, 'data', 'doc-git-times.json')), true);
      assert.match(result.stdout, /wrote \d+ doc time/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Output containment + symlink/temp hardening (#3079)
// ---------------------------------------------------------------------------
//
// main() is exercised in-process so the predictable temp name `<out>.tmp-<pid>`
// resolves to THIS process's pid and can be pre-seeded as a symlink. Each
// containment failure must return a nonzero exit code and leave every external
// target byte-identical, while a normal in-repo output still succeeds.
describe('doc-git-times output containment (#3079)', () => {
  test('rejects a symlinked default output parent (data -> outside) and leaves it untouched', () => {
    const root = fullHistoryRepo();
    const outside = mkdtempSync(join(tmpdir(), 'doc-git-times-out-'));
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'original');
    symlinkSync(outside, join(root, 'data'));
    try {
      const status = main(['--root', root]);
      assert.notEqual(status, 0);
      // Nothing written into the external dir, and the sentinel is intact.
      assert.equal(existsSync(join(outside, 'doc-git-times.json')), false);
      assert.equal(readFileSync(sentinel, 'utf8'), 'original');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('refuses a symlink pre-seeded at the predictable temp path (no follow, no publish)', () => {
    const root = fullHistoryRepo();
    const outside = mkdtempSync(join(tmpdir(), 'doc-git-times-tmp-'));
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'original');
    const outFile = join(root, 'data', 'doc-git-times.json');
    mkdirSync(dirname(outFile), { recursive: true });
    symlinkSync(sentinel, `${outFile}.tmp-${process.pid}`);
    try {
      const status = main(['--root', root]);
      assert.notEqual(status, 0);
      assert.equal(readFileSync(sentinel, 'utf8'), 'original');
      assert.equal(existsSync(outFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a normal in-repo output still succeeds', () => {
    const root = fullHistoryRepo();
    try {
      const status = main(['--root', root]);
      assert.equal(status, 0);
      const outFile = join(root, 'data', 'doc-git-times.json');
      assert.equal(existsSync(outFile), true);
      const manifest = JSON.parse(readFileSync(outFile, 'utf8'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(Object.hasOwn(manifest, 'complete'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
