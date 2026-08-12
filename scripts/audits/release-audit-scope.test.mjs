import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildReleaseAuditManifest,
  parseReleaseScopeArgs,
} from './release-audit-scope.mjs';

function write(root, path, contents) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents, 'utf8');
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=Scope Fixture',
    '-c',
    'user.email=scope@example.invalid',
    'commit',
    '-m',
    message
  );
  return git(root, 'rev-parse', 'HEAD');
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'release-audit-scope-'));
  git(root, 'init', '-b', 'master');
  write(root, 'src/core.ts', 'export const core = 1;\n');
  write(root, 'src/added-target.ts', '// added later\n');
  write(root, 'src/deleted.ts', 'export const deleted = true;\n');
  write(root, 'src/old-name.ts', 'export const renamed = true;\n');
  write(
    root,
    'src/base-importer.ts',
    "import { deleted } from './deleted';\nexport { renamed } from './old-name';\n"
  );
  write(root, 'src/base-requirer.cjs', "require('./deleted');\n");
  write(root, 'src/head-importer.ts', "import { core } from './core';\nvoid core;\n");
  write(
    root,
    'src/dynamic.ts',
    "const target = './deleted';\nvoid import('./deleted');\nrequire(target);\n"
  );
  write(root, 'src/unrelated.ts', 'export const unrelated = true;\n');
  write(
    root,
    'docs/stable.md',
    'Claims: src/core.ts, src/deleted.ts, and src/new-name.ts.\n'
  );
  write(root, 'docs/symbol-only.md', 'The deleted and renamed symbols exist.\n');
  write(root, 'docs/manual.md', 'Reviewer-selected adjacent contract.\n');
  const baseSha = commit(root, 'base');
  git(root, 'update-ref', 'refs/tags/v0.6.0', baseSha);

  write(root, 'src/core.ts', 'export const core = 2;\n');
  write(root, 'src/added.ts', 'export const added = true;\n');
  unlinkSync(join(root, 'src/added-target.ts'));
  unlinkSync(join(root, 'src/deleted.ts'));
  renameSync(join(root, 'src/old-name.ts'), join(root, 'src/new-name.ts'));
  const headSha = commit(root, 'candidate');
  return { root, baseSha, headSha };
}

test('incremental scope is deterministic across modify, add, delete, rename, importers, references, and manual additions', () => {
  const { root, baseSha, headSha } = fixtureRepo();
  try {
    const options = {
      repoDir: root,
      previousTag: 'v0.6.0',
      head: headSha,
      manualAdditions: [
        {
          path: 'docs/manual.md',
          reason: 'The changed API contract is quoted here without a literal path.',
        },
      ],
    };
    const first = buildReleaseAuditManifest(options);
    const second = buildReleaseAuditManifest(options);

    assert.deepEqual(first, second, 'the same immutable refs must emit identical bytes');
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.policyVersion, 2);
    assert.equal(first.mode, 'incremental');
    assert.equal(first.previousTag, 'v0.6.0');
    assert.equal(first.baseSha, baseSha);
    assert.equal(first.headSha, headSha);
    assert.deepEqual(
      first.changes.map(({ status, oldPath, newPath }) => ({
        status,
        oldPath,
        newPath,
      })),
      [
        { status: 'D', oldPath: 'src/added-target.ts', newPath: null },
        { status: 'A', oldPath: null, newPath: 'src/added.ts' },
        { status: 'M', oldPath: 'src/core.ts', newPath: 'src/core.ts' },
        { status: 'D', oldPath: 'src/deleted.ts', newPath: null },
        { status: 'R100', oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts' },
      ]
    );
    assert.deepEqual(first.evidence.importers, [
      {
        path: 'src/base-importer.ts',
        revisions: ['base'],
        targets: ['src/deleted.ts', 'src/old-name.ts'],
      },
      {
        path: 'src/base-requirer.cjs',
        revisions: ['base'],
        targets: ['src/deleted.ts'],
      },
      {
        path: 'src/head-importer.ts',
        revisions: ['base', 'head'],
        targets: ['src/core.ts'],
      },
    ]);
    assert.deepEqual(first.evidence.references, [
      {
        path: 'docs/stable.md',
        revisions: ['base', 'head'],
        targets: ['src/core.ts', 'src/deleted.ts', 'src/new-name.ts'],
      },
    ]);
    assert.deepEqual(first.manualAdditions, options.manualAdditions);
    assert.deepEqual(first.exclusions, [
      { path: 'src/added-target.ts', reason: 'absent-at-head' },
      { path: 'src/deleted.ts', reason: 'absent-at-head' },
      { path: 'src/old-name.ts', reason: 'absent-at-head' },
    ]);
    assert.deepEqual(first.finalPaths, [
      'docs/manual.md',
      'docs/stable.md',
      'src/added.ts',
      'src/base-importer.ts',
      'src/base-requirer.cjs',
      'src/core.ts',
      'src/head-importer.ts',
      'src/new-name.ts',
    ]);
    assert.equal(first.finalPaths.includes('src/dynamic.ts'), false);
    assert.equal(first.finalPaths.includes('docs/symbol-only.md'), false);
    assert.deepEqual(first.equation, {
      automatic: 10,
      manual: 1,
      exclusions: 3,
      final: 8,
      statement: 'unique(automatic + manual) = final + exclusions',
    });
    assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full audit is explicit and reproduces the complete head tree instead of the incremental subset', () => {
  const { root, headSha } = fixtureRepo();
  try {
    const incremental = buildReleaseAuditManifest({
      repoDir: root,
      previousTag: 'v0.6.0',
      head: headSha,
    });
    const full = buildReleaseAuditManifest({
      repoDir: root,
      previousTag: 'v0.6.0',
      head: headSha,
      fullAudit: true,
    });

    assert.equal(incremental.finalPaths.includes('src/unrelated.ts'), false);
    assert.equal(full.mode, 'full');
    assert.equal(full.fullAudit, true);
    assert.equal(full.finalPaths.includes('src/unrelated.ts'), true);
    assert.equal(full.finalPaths.includes('src/dynamic.ts'), true);
    assert.equal(full.equation.exclusions, 0);
    assert.equal(full.equation.final, full.equation.automatic);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual scope additions require a reason, a head path, and new coverage', () => {
  const { root, headSha } = fixtureRepo();
  try {
    assert.throws(
      () =>
        buildReleaseAuditManifest({
          repoDir: root,
          previousTag: 'v0.6.0',
          head: headSha,
          manualAdditions: [{ path: 'docs/manual.md', reason: '  ' }],
        }),
      /nonempty reason/
    );
    assert.throws(
      () =>
        buildReleaseAuditManifest({
          repoDir: root,
          previousTag: 'v0.6.0',
          head: headSha,
          manualAdditions: [{ path: 'docs/missing.md', reason: 'Adjacent claim' }],
        }),
      /absent from the head tree/
    );
    assert.throws(
      () =>
        buildReleaseAuditManifest({
          repoDir: root,
          previousTag: 'v0.6.0',
          head: headSha,
          manualAdditions: [
            { path: 'src/core.ts', reason: 'Already selected by the diff' },
          ],
        }),
      /already in automatic scope/
    );
    assert.throws(
      () =>
        buildReleaseAuditManifest({
          repoDir: root,
          previousTag: 'v0.6.0',
          head: headSha,
          fullAudit: true,
          manualAdditions: [
            { path: 'docs/manual.md', reason: 'Full mode already selects it' },
          ],
        }),
      /already in automatic scope/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI parsing makes base/head explicit and pairs each manual path with its reason', () => {
  assert.deepEqual(
    parseReleaseScopeArgs([
      '--previous-tag',
      'v0.6.0',
      '--head',
      'HEAD',
      '--repo-dir',
      '/repo',
      '--add',
      'docs/a.md',
      '--reason',
      'Changed claim',
      '--full-audit',
    ]),
    {
      previousTag: 'v0.6.0',
      head: 'HEAD',
      repoDir: '/repo',
      output: null,
      fullAudit: true,
      manualAdditions: [{ path: 'docs/a.md', reason: 'Changed claim' }],
    }
  );
  assert.throws(
    () => parseReleaseScopeArgs(['--previous-tag', 'v0.6.0']),
    /--head is required/
  );
  assert.throws(
    () =>
      parseReleaseScopeArgs([
        '--previous-tag',
        'v0.6.0',
        '--head',
        'HEAD',
        '--add',
        'docs/a.md',
      ]),
    /--reason/
  );
});
