// Producer/consumer artifact-path parity for the repo-map seam (#719/#1004).
//
// ADR 0007 names the host-generated repo-map JSON artifact as THE seam between
// the producer (scripts/repo-map-generate.mjs, writes via artifactPathFor) and
// the consumer (scripts/ingest.mjs readRepoMapArtifact, which now READS via the
// same canonical artifactPathFor instead of a duplicated local encodeRoot regex).
// A drift in either side's encoding would silently break the join. This proves
// the two stay glued to one function end-to-end:
//
//   (1) A fixture artifact WRITTEN at artifactPathFor(REPO_MAP_DIR, root) — the
//       exact path the producer emits — is still FOUND by ingest.assembleDataset
//       (surfacing as repoMap.projects[].root) after the #1004 refactor.
//   (2) sourceSignature caps repo-map artifact root discovery before statting
//       per-repository config files.
//   (3) ingest.mjs no longer defines its own encodeRoot; the only `-`-collapsing
//       regex left in the file is unrelated to repo-map path encoding.
//
// Run under the ts-resolver loader (ingest dynamically imports .ts parsers):
//   node --import ./scripts/register-ts.mjs --test scripts/repo-map-artifact-path-parity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// The canonical helper the PRODUCER (repo-map-generate.mjs) writes through and
// the CONSUMER (ingest.mjs) now reads through. Importing it here is the same
// function both scripts use — so the path this test writes to is, by construction,
// the path ingest will read from. That IS the parity guarantee.
const { artifactPathFor } = await import(
  join(REPO_ROOT, 'src/lib/repo-map/index.ts')
);

// ---------------------------------------------------------------------------
// Fixture: a throwaway ~/.claude with a history.jsonl entry for a project root
// and a repo-map artifact placed at artifactPathFor(<repo-map dir>, root).
// ---------------------------------------------------------------------------
function buildFixtureHome(projectRoot) {
  const home = join(tmpdir(), `chd-1004-home-${randomUUID()}`);
  const claude = join(home, '.claude');
  const repoMapDir = join(claude, 'usage-data', 'repo-map');
  mkdirSync(repoMapDir, { recursive: true });

  // history.jsonl: one typed user turn whose project is the repo root. This is
  // what makes `projectRoot` a project root in projectRootsFrom(), driving
  // ingest to read its repo-map artifact.
  writeFileSync(
    join(claude, 'history.jsonl'),
    JSON.stringify({
      display: 'hello',
      project: projectRoot,
      sessionId: 'sess-1004',
      timestamp: 1700000000000,
    }) + '\n'
  );

  // The repo-map artifact, written at the producer's canonical path.
  const artifactPath = artifactPathFor(repoMapDir, projectRoot);
  const artifact = {
    root: projectRoot,
    generatedAtGitSha: 'deadbeef',
    fileCount: 1,
    truncated: false,
    text: '# repo map',
    files: [{ path: 'src/app.ts', symbols: [], imports: [] }],
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));

  return { home, repoMapDir, artifactPath };
}

async function loadIngest(home) {
  process.env.HOME = home;
  process.env.CHD_DB_PATH = join(tmpdir(), `chd-1004-db-${randomUUID()}.db`);
  return import(`./ingest.mjs?fixture=${randomUUID()}`);
}

test('(1) a fixture artifact at the producer path is found by ingest after #1004', async () => {
  const projectRoot = '/tmp/proj.with_special chars';
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const { home, artifactPath } = buildFixtureHome(projectRoot);
  try {
    const ingest = await loadIngest(home);
    const dataset = ingest.assembleDataset();

    // Sanity: the artifact really lives at the producer's encoded path (dashes
    // for every non-alphanumeric), not at the raw root path.
    assert.ok(
      artifactPath.endsWith('/-tmp-proj-with-special-chars.json'),
      `unexpected artifact path: ${artifactPath}`
    );

    // The consumer (ingest) found and joined it through the same encoding.
    const roots = (dataset.repoMap?.projects ?? []).map((p) => p.root);
    assert.ok(
      roots.includes(projectRoot),
      `ingest did not surface the repo-map artifact for ${projectRoot}; got roots=${JSON.stringify(roots)}`
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
  }
});

test('(2) sourceSignature caps repo-map artifact root discovery', async () => {
  const projectRoot = '/tmp/proj-cap-a';
  const secondRoot = '/tmp/proj-cap-b';
  const origHome = process.env.HOME;
  const origDb = process.env.CHD_DB_PATH;
  const origCap = process.env.DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES;
  const origScoped = process.env.CHD_SCOPED_INGEST;
  const { home, repoMapDir } = buildFixtureHome(projectRoot);
  try {
    writeFileSync(
      artifactPathFor(repoMapDir, secondRoot),
      JSON.stringify({
        root: secondRoot,
        generatedAtGitSha: 'deadbeef',
        fileCount: 1,
        truncated: false,
        text: '# repo map',
        files: [{ path: 'src/other.ts', symbols: [], imports: [] }],
      })
    );
    process.env.DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES = '1';
    delete process.env.CHD_SCOPED_INGEST;

    const ingest = await loadIngest(home);
    assert.equal(ingest.REPO_MAP_ARTIFACT_MAX_ENTRIES, 1);
    const sig = ingest.sourceSignature();
    const repoInstructionStats = sig.match(/\/AGENTS\.md:0:0/g) ?? [];
    assert.equal(
      repoInstructionStats.length,
      1,
      `expected one repo config root under cap; sourceSignature=${sig}`
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.CHD_DB_PATH;
    else process.env.CHD_DB_PATH = origDb;
    if (origCap === undefined) delete process.env.DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES;
    else process.env.DASHBOARD_REPO_MAP_ARTIFACT_MAX_ENTRIES = origCap;
    if (origScoped === undefined) delete process.env.CHD_SCOPED_INGEST;
    else process.env.CHD_SCOPED_INGEST = origScoped;
  }
});

test('(3) ingest.mjs no longer hand-rolls a repo-map path-encoding regex', () => {
  const src = readFileSync(join(HERE, 'ingest.mjs'), 'utf8');
  // The old duplicated encoder defined its own [^a-zA-Z0-9] dash regex. The only
  // such regex that may remain must not be tied to repo-map artifact paths.
  assert.ok(
    !/function encodeRoot/.test(src),
    'ingest.mjs still defines a local encodeRoot — the duplication #1004 removed is back'
  );
  assert.ok(
    !/Same encoding as scripts\/repo-map-generate\.mjs/.test(src),
    'the stale "Same encoding as ..." duplication comment is back'
  );
  assert.ok(
    /artifactPathFor\(REPO_MAP_DIR, root\)/.test(src),
    'ingest.mjs no longer derives the repo-map artifact path from artifactPathFor'
  );
});
