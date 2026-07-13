// Producer/consumer parity + tolerant ingest contract for #2486.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactPathFor } from '../src/lib/repo-map/cache.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_KEY_ENV = 'CHD_DOC_HYGIENE_ARTIFACT_KEY';
const EXPECTED_COMMIT_ENV = 'CHD_DOC_HYGIENE_EXPECTED_COMMIT';

function validArtifact(root, identity = null) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-09T00:00:00.000Z',
    repo: {
      ...(identity ? { identity } : {}),
      root,
      commit: 'abcdef1234567890',
      markdownFiles: 1,
    },
    summary: { score: 10, findingCount: 0, errorCount: 0, warningCount: 0 },
    checks: [
      {
        name: 'lychee.local-links',
        tool: 'lychee',
        toolVersion: '0.24.2',
        status: 'completed',
        score: 10,
        reason: 'No broken local Markdown links found',
        findingIds: [],
      },
    ],
    findings: [],
    skipped: [
      {
        name: 'lychee.external-links',
        reason:
          'external URL checks disabled; set CHD_DOC_HYGIENE_EXTERNAL_LINKS=1',
      },
    ],
  };
}

test('ingest finds the canonical doc-hygiene path and degrades absent/malformed to null', async () => {
  const home = join(tmpdir(), `chd-2486-home-${randomUUID()}`);
  const claude = join(home, '.claude');
  const artifactDir = join(claude, 'usage-data', 'doc-hygiene');
  const root = join(tmpdir(), `chd-2486-nonrepo-${randomUUID()}`);
  const artifactPath = artifactPathFor(artifactDir, root);
  const previousHome = process.env.HOME;
  const previousDb = process.env.CHD_DB_PATH;
  const previousKey = process.env[ARTIFACT_KEY_ENV];
  const previousCommit = process.env[EXPECTED_COMMIT_ENV];
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(join(claude, 'projects'), { recursive: true });

  try {
    process.env.HOME = home;
    process.env.CHD_DB_PATH = join(home, 'dashboard.db');
    delete process.env[ARTIFACT_KEY_ENV];
    delete process.env[EXPECTED_COMMIT_ENV];
    const ingest = await import(`./ingest.mjs?doc-hygiene=${randomUUID()}`);
    const expectedCommit = validArtifact(root).repo.commit;
    const read = () =>
      ingest.readDocHygieneArtifact(root, artifactDir, { expectedCommit });

    assert.equal(read(), null, 'absent artifact');

    writeFileSync(artifactPath, '{not json');
    assert.equal(read(), null, 'malformed artifact');

    writeFileSync(artifactPath, JSON.stringify(validArtifact(root)));
    assert.equal(
      ingest.readDocHygieneArtifact(root, artifactDir),
      null,
      'a non-repo root cannot bypass the current-commit freshness bind'
    );
    assert.deepEqual(
      read(),
      validArtifact(root),
      'producer path is consumed through the same canonical encoder'
    );

    writeFileSync(
      artifactPath,
      JSON.stringify({
        ...validArtifact(root),
        repo: { ...validArtifact(root).repo, root: '/different/repo' },
      })
    );
    assert.equal(read(), null, 'cross-root artifact');
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = previousDb;
    if (previousKey === undefined) delete process.env[ARTIFACT_KEY_ENV];
    else process.env[ARTIFACT_KEY_ENV] = previousKey;
    if (previousCommit === undefined) delete process.env[EXPECTED_COMMIT_ENV];
    else process.env[EXPECTED_COMMIT_ENV] = previousCommit;
  }
});

test('stable repo key bridges a host checkout artifact into the /app runtime namespace', async () => {
  const home = join(tmpdir(), `chd-2486-keyed-home-${randomUUID()}`);
  const claude = join(home, '.claude');
  const artifactDir = join(claude, 'usage-data', 'doc-hygiene');
  const hostRoot = join(tmpdir(), `host-claude-history-dashboard-${randomUUID()}`);
  const runtimeRoot = '/app';
  const key = 'claude-history-dashboard';
  const expected = validArtifact(hostRoot, key);
  const previousHome = process.env.HOME;
  const previousDb = process.env.CHD_DB_PATH;
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(join(claude, 'projects'), { recursive: true });

  try {
    process.env.HOME = home;
    process.env.CHD_DB_PATH = join(home, 'dashboard.db');
    const ingest = await import(`./ingest.mjs?doc-hygiene-keyed=${randomUUID()}`);
    writeFileSync(join(artifactDir, `${key}.json`), JSON.stringify(expected));

    assert.deepEqual(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: key,
        expectedCommit: expected.repo.commit,
        runtimeCommit: expected.repo.commit,
      }),
      expected,
      'runtime locates host artifact without equating /app to the host root'
    );
    assert.equal(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: key,
        expectedCommit: '1234567ffff',
        runtimeCommit: '1234567ffff',
      }),
      null,
      'host commit freshness remains load-bearing'
    );
    assert.equal(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: key,
        expectedCommit: '',
        runtimeCommit: expected.repo.commit,
      }),
      null,
      'a keyed cross-namespace read never runs without a commit bind'
    );
    assert.equal(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: '../escape',
        expectedCommit: expected.repo.commit,
        runtimeCommit: expected.repo.commit,
      }),
      null,
      'host-controlled key cannot escape the artifact directory'
    );
    assert.equal(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: key,
        expectedCommit: expected.repo.commit,
      }),
      null,
      'a keyed artifact requires the running image commit'
    );
    assert.equal(
      ingest.readDocHygieneArtifact(runtimeRoot, artifactDir, {
        artifactKey: key,
        expectedCommit: expected.repo.commit,
        runtimeCommit: '1234567ffff',
      }),
      null,
      'a host artifact from another commit is never merged with the runtime graph'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = previousDb;
  }
});

test('canonical deploy refreshes doc hygiene and forwards its keyed freshness bind', () => {
  const deploy = readFileSync(join(REPO_ROOT, 'scripts', 'deploy.sh'), 'utf8');
  const compose = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  assert.match(deploy, /doc-hygiene-run\.mjs/);
  assert.match(deploy, /--root "\$DIR"/);
  assert.match(
    deploy,
    /--artifact-key "\$CHD_DOC_HYGIENE_ARTIFACT_KEY"/
  );
  assert.match(
    compose,
    /CHD_DOC_HYGIENE_ARTIFACT_KEY: \$\{CHD_DOC_HYGIENE_ARTIFACT_KEY:-\}/
  );
  assert.match(
    compose,
    /CHD_DOC_HYGIENE_EXPECTED_COMMIT: \$\{CHD_DOC_HYGIENE_EXPECTED_COMMIT:-\}/
  );
});

test('rendered local compose keeps a custom CLAUDE_DIR as the read-only source', (t) => {
  const engine = ['podman', 'docker'].find((candidate) => {
    const probe = spawnSync(candidate, ['compose', 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return probe.status === 0;
  });
  if (!engine) {
    t.skip('no Docker/Podman Compose renderer is installed');
    return;
  }

  const root = join(tmpdir(), `chd-2486-compose-${randomUUID()}`);
  const home = join(root, 'home');
  const customClaude = join(root, 'custom-claude');
  try {
    mkdirSync(join(home, '.claude', '.cache', 'chd'), { recursive: true });
    mkdirSync(customClaude, { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{}\n');
    const rendered = spawnSync(
      engine,
      [
        'compose',
        '-f',
        join(REPO_ROOT, 'docker-compose.yml'),
        '-f',
        join(REPO_ROOT, 'docker-compose.local.yml'),
        'config',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home, CLAUDE_DIR: customClaude },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    assert.equal(rendered.status, 0, rendered.stderr);

    const lines = rendered.stdout.split(/\r?\n/);
    const targetLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        /\/home\/node\/\.claude(?::ro)?\s*$/.test(line.trim())
      );
    assert.equal(targetLines.length, 1, rendered.stdout);
    const { index } = targetLines[0];
    const mountBlock = lines
      .slice(Math.max(0, index - 4), index + 2)
      .join('\n');
    assert.ok(
      mountBlock.includes(customClaude),
      `custom CLAUDE_DIR missing from rendered mount:\n${mountBlock}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
