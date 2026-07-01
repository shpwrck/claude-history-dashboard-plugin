// Coverage for the repo-map refresh driver (#1650, epic #1264).
//
// Run under register-ts:
//   node --import ./scripts/register-ts.mjs --test scripts/repo-map-refresh.test.mjs
//
// Asserts the missing trigger actually produces CONSUMABLE artifacts: discover
// roots from a fake ~/.claude.json, run the host-side producer per existing root,
// then ROUND-TRIP the produced artifact through the REAL consumer
// (`unwrapPersistedRepoMap` + `buildRepoMapDataset`) so a green test proves the
// detector would light up on real data — not merely that a file was written.
// Also covers: idempotent re-run (#893 cache), artifact-only rediscovery, missing
// roots skipped, the discovery cap, a clean no-op with no config, the unwrap unit
// contract, and the ADR 0007 boundary (the driver never pulls the WASM parser
// into its own import graph; it spawns the producer as a child — #1013/#1195).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(PROJECT_DIR, 'scripts', 'repo-map-refresh.mjs');

// The REAL consumer seam: `cache.ts` (runtime-safe — node builtins + a type only,
// NOT the parser barrel) owns the unwrap; `parse-repo-map-join.ts` is the dataset
// join ingest.mjs feeds. Importing these is exactly what proves consumability.
const { unwrapPersistedRepoMap } = await import(join(PROJECT_DIR, 'src/lib/repo-map/cache.ts'));
const { buildRepoMapDataset } = await import(join(PROJECT_DIR, 'src/lib/parse-repo-map-join.ts'));

/** Run the driver with a sandboxed HOME so the producer writes its artifacts
 *  under the temp dir (homedir() honors $HOME on Linux). Returns combined output. */
function runDriver(home, env = {}) {
  return execFileSync(process.execPath, [DRIVER], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function seedFixtureRoot(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'types.ts'),
    'export interface Thing { id: string }\nexport type Status = "on" | "off"\n'
  );
  writeFileSync(
    join(root, 'src', 'api.ts'),
    "import type { Thing } from './types'\nexport function getThing(): Thing { return { id: 'x' } }\n"
  );
}

const artifactDirOf = (home) => join(home, '.claude', 'usage-data', 'repo-map');
const onlyArtifact = (home) => {
  const dir = artifactDirOf(home);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return { files, raw: files.length ? JSON.parse(readFileSync(join(dir, files[0]), 'utf8')) : null };
};

test('produces an artifact the REAL consumer can read, then is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'rmr-home-'));
  const project = mkdtempSync(join(tmpdir(), 'rmr-proj-'));
  try {
    seedFixtureRoot(project);
    // Fake ~/.claude.json with the fixture root + a root that does not exist.
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ projects: { [project]: {}, '/no/such/root/here': {} } })
    );

    const out1 = runDriver(home);
    assert.ok(existsSync(artifactDirOf(home)), 'artifact dir created');
    const { files, raw } = onlyArtifact(home);
    assert.equal(files.length, 1, 'exactly one artifact (the missing root is skipped)');
    assert.match(out1, /1 roots: 1 regenerated/);

    // ROUND-TRIP through the real consumer: unwrap the persisted envelope, then
    // build the dataset join ingest.mjs serves. A bug in the persisted shape or
    // the unwrap would leave `repoMap.projects` empty here — the exact failure
    // that kept the detector dark before #1650.
    const map = unwrapPersistedRepoMap(raw);
    assert.ok(map, 'unwrap yields a RepoMap from the persisted envelope');
    assert.equal(map.root, project, 'unwrapped root matches the ingested root');
    assert.ok(Array.isArray(map.files) && map.files.length > 0, 'indexed files');

    const repoMap = buildRepoMapDataset({ maps: [map] });
    assert.equal(repoMap.projects.length, 1, 'dataset.repoMap has the project');
    assert.equal(repoMap.projects[0].root, project);
    assert.ok(repoMap.projects[0].files.length > 0, 'join carries the files the detector reads');

    // Second run with no source change is a cache hit, not a rewrite (#893).
    const out2 = runDriver(home);
    assert.match(out2, /1 up to date/);
    assert.doesNotMatch(out2, /[1-9]\d* failed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('rediscovers an existing-artifact root even when it left ~/.claude.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'rmr-rd-'));
  const project = mkdtempSync(join(tmpdir(), 'rmr-rdp-'));
  try {
    seedFixtureRoot(project);
    // First pass: the root is in ~/.claude.json, so an artifact is produced.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: {} } }));
    runDriver(home);
    assert.equal(onlyArtifact(home).files.length, 1, 'artifact produced');

    // The project drops out of ~/.claude.json (user stopped opening it). The
    // driver must still find it via the existing artifact and refresh it — the
    // branch that was a silent no-op when it read the wrong (top-level) shape.
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }));
    const out = runDriver(home);
    assert.match(out, /1 roots: (1 regenerated|0 regenerated, 1 up to date)/);
    assert.doesNotMatch(out, /no project roots discovered/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('no project roots → clean no-op (exit 0)', () => {
  const home = mkdtempSync(join(tmpdir(), 'rmr-empty-'));
  try {
    const out = runDriver(home); // no ~/.claude.json, no artifacts
    assert.match(out, /no project roots discovered/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('respects REPO_MAP_REFRESH_MAX_ROOTS and reports the cap', () => {
  const home = mkdtempSync(join(tmpdir(), 'rmr-cap-'));
  const a = mkdtempSync(join(tmpdir(), 'rmr-a-'));
  const b = mkdtempSync(join(tmpdir(), 'rmr-b-'));
  try {
    seedFixtureRoot(a);
    seedFixtureRoot(b);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [a]: {}, [b]: {} } }));
    const out = runDriver(home, { REPO_MAP_REFRESH_MAX_ROOTS: '1' });
    assert.match(out, /2 roots discovered, capping at 1/);
    assert.match(out, /1 roots: 1 regenerated/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('unwrapPersistedRepoMap: envelope, flat, and garbage', () => {
  const inner = { root: '/r', files: [{ path: 'a.ts', symbols: [], imports: [] }], text: '', fileCount: 1, truncated: false, generatedAtGitSha: null };
  assert.deepEqual(unwrapPersistedRepoMap({ version: 1, cacheKey: {}, map: inner }), inner);
  assert.deepEqual(unwrapPersistedRepoMap(inner), inner); // tolerate a flat artifact
  assert.equal(unwrapPersistedRepoMap({ version: 1, cacheKey: {} }), null); // no map
  assert.equal(unwrapPersistedRepoMap(null), null);
  assert.equal(unwrapPersistedRepoMap('nope'), null);
});

test('driver keeps the WASM parser off its own import graph (ADR 0007 / #1013)', () => {
  const src = readFileSync(DRIVER, 'utf8');
  // The driver must spawn the producer as a child, never statically import the
  // tree-sitter parser or the repo-map generator into its own module graph.
  assert.doesNotMatch(src, /from ['"].*repo-map\/(parser|generate|index)/);
  assert.doesNotMatch(src, /web-tree-sitter|tree-sitter/);
  assert.match(src, /execFileSync/, 'spawns the producer as a child process');
});

test('meaningfulStderrLine surfaces the real error, not the Node banner (#2291)', async () => {
  // Importing the driver must NOT run main() (guarded on argv[1]); it just
  // exposes the pure helper.
  const { meaningfulStderrLine } = await import(DRIVER);

  // A real ERR_MODULE_NOT_FOUND crash. The old `.slice(-1)[0]` reported the
  // trailing "Node.js vX" banner; the helper must surface the Error line.
  const crash = [
    '',
    'node:internal/modules/run_main:107',
    '    triggerUncaughtException(',
    '    ^',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'web-tree-sitter' imported from /x/src/lib/repo-map/parser.ts",
    '    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)',
    '    at packageResolve (node:internal/modules/esm/resolve:764:81)',
    '  code: "ERR_MODULE_NOT_FOUND"',
    '}',
    '',
    'Node.js v24.15.0',
  ].join('\n');
  const line = meaningfulStderrLine(crash);
  assert.match(line, /ERR_MODULE_NOT_FOUND/, 'reports the real cause');
  assert.doesNotMatch(line, /^Node\.js v/, 'not the version banner');

  // Degrade gracefully: empty in → empty out; a banner-only crash falls back to
  // the banner rather than throwing; a plain one-line message passes through.
  assert.equal(meaningfulStderrLine(''), '');
  assert.equal(meaningfulStderrLine(null), '');
  assert.equal(meaningfulStderrLine('Node.js v24.15.0'), 'Node.js v24.15.0');
  assert.match(meaningfulStderrLine('Command failed: node … timed out'), /timed out/);
});
