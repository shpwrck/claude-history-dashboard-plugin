import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRepoMap, renderRepoMap } from './generate';
import {
  computeCacheKey,
  isCacheValid,
  enforceSizeLimit,
  serializedBytes,
  assertNoBodyLeakage,
  artifactPathFor,
  PERSISTED_REPO_MAP_VERSION,
} from './cache';
import type { ParseFile, RepoMap } from './types';

// Same deterministic fake parser as generate.test.ts — exercises the cache/size
// logic without the WASM grammar.
const fakeParse: ParseFile = (source) => ({
  symbols: [...source.matchAll(/export (function|const|class) (\w+)/g)].map((m) => ({
    name: m[2],
    kind: m[1] === 'function' ? 'function' : (m[1] as 'const' | 'class'),
    exported: true,
    signature: `${m[1]} ${m[2]}`,
    line: 1,
  })),
  imports: [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]),
});

const BODY_SECRET = 'do_not_leak_this_body_token';
const CONFIG_SECRET = 'sk-live-fullconfigvalue-must-not-persist';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repomap-cache-'));
  writeFileSync(join(root, 'b.ts'), `export function funcB() { const x = '${BODY_SECRET}'; return x; }\n`);
  writeFileSync(
    join(root, 'a.ts'),
    `import { funcB } from './b';\nexport const API_TOKEN = '${CONFIG_SECRET}';\nexport const funcA = () => funcB();\n`
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const renderText = (files: RepoMap['files']) => renderRepoMap(files, 8000);

describe('computeCacheKey', () => {
  it('records the root, sha, and max source mtime', () => {
    const abs = [join(root, 'a.ts'), join(root, 'b.ts')];
    const key = computeCacheKey(
      root,
      'sha1',
      abs,
      'a'.repeat(64),
      'owner/repo'
    );
    expect(key.root).toBe(root);
    expect(key.gitSha).toBe('sha1');
    expect(key.maxMtimeMs).toBeGreaterThan(0);
    expect(key.structureSignature).toBe('a'.repeat(64));
    expect(key.repository).toBe('owner/repo');
  });

  it('changes when only the normalized remote slug changes', () => {
    const abs = [join(root, 'a.ts'), join(root, 'b.ts')];
    const first = computeCacheKey(root, 'sha1', abs, 'a'.repeat(64), 'owner/first');
    const second = computeCacheKey(root, 'sha1', abs, 'a'.repeat(64), 'owner/second');

    expect(first).not.toEqual(second);
    expect(first.repository).toBe('owner/first');
    expect(second.repository).toBe('owner/second');
  });

  it('advances the mtime watermark when a source file is touched', () => {
    const abs = [join(root, 'a.ts'), join(root, 'b.ts')];
    const before = computeCacheKey(root, null, abs);
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'a.ts'), future, future);
    const after = computeCacheKey(root, null, abs);
    expect(after.maxMtimeMs).toBeGreaterThan(before.maxMtimeMs);
    expect(before.repository).toBeNull();
    expect(after.repository).toBeNull();
  });
});

describe('isCacheValid', () => {
  const base = {
    root: '/repo',
    gitSha: 'sha1',
    maxMtimeMs: 100,
    structureSignature: 'a'.repeat(64),
    repository: 'owner/repo',
  };
  const persisted = { version: PERSISTED_REPO_MAP_VERSION, cacheKey: base };

  it('is invalid when there is no persisted artifact', () => {
    expect(isCacheValid(null, base)).toBe(false);
  });

  it('is invalid on a version mismatch', () => {
    expect(isCacheValid({ ...persisted, version: 0 }, base)).toBe(false);
  });

  it('invalidates artifacts from before the complete output contract (#2740)', () => {
    // v8 expands the forward-fence contract to the inner RepoMap / RepoFile
    // shapes, so artifacts stamped under the envelope-only v7 contract retire.
    expect(PERSISTED_REPO_MAP_VERSION).toBe(8);
    expect(isCacheValid({ ...persisted, version: 7 }, base)).toBe(false);
    // v7 binds the normalized remote slug into the cache identity. A v6
    // artifact can otherwise survive a remote-only change until HEAD moves.
    expect(isCacheValid({ ...persisted, version: 6 }, base)).toBe(false);
    // v6 also changed signature GENERATION semantics: a v5 artifact can hold a
    // signature carrying a literal secret, so it must never be reused.
    expect(isCacheValid({ ...persisted, version: 5 }, base)).toBe(false);
    // ...and the pre-remote-identity artifacts of #2709 stay invalid too.
    expect(isCacheValid({ ...persisted, version: 4 }, base)).toBe(false);
  });

  it('is valid when the clean-repo sha and repository match (mtime ignored)', () => {
    expect(isCacheValid(persisted, { ...base, maxMtimeMs: 999 })).toBe(true);
  });

  it('is invalid when only the normalized remote slug changes', () => {
    expect(
      isCacheValid(persisted, {
        ...base,
        repository: 'other/repo',
      })
    ).toBe(false);
    expect(isCacheValid(persisted, { ...base, repository: null })).toBe(false);
  });

  it('is invalid when the clean-repo sha moved', () => {
    expect(isCacheValid(persisted, { ...base, gitSha: 'sha2' })).toBe(false);
  });

  it('is invalid when the root differs', () => {
    expect(isCacheValid(persisted, { ...base, root: '/other' })).toBe(false);
  });

  it('is invalid when a concurrent parser/cohort identity differs', () => {
    expect(
      isCacheValid(persisted, {
        ...base,
        structureSignature: 'b'.repeat(64),
      })
    ).toBe(false);
  });

  it('falls back to the mtime watermark when there is no sha', () => {
    const noShaKey = { ...base, gitSha: null, maxMtimeMs: 100 };
    const noSha = { version: PERSISTED_REPO_MAP_VERSION, cacheKey: noShaKey };
    expect(isCacheValid(noSha, noShaKey)).toBe(true);
    expect(isCacheValid(noSha, { ...noShaKey, maxMtimeMs: 101 })).toBe(false);
  });

  it('invalidates when the repo flips between sha and no-sha (dirty/clean)', () => {
    const noSha = {
      version: PERSISTED_REPO_MAP_VERSION,
      cacheKey: { ...base, gitSha: null, maxMtimeMs: 100 },
    };
    expect(isCacheValid(noSha, base)).toBe(false); // was dirty, now has a sha
    expect(isCacheValid(persisted, { ...base, gitSha: null })).toBe(false); // was clean, now dirty
  });
});

describe('enforceSizeLimit', () => {
  it('passes a small map through untouched', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    const key = computeCacheKey(root, 'sha1', map.files.map((f) => join(root, f.path)));
    const persisted = enforceSizeLimit(map, key, renderText, 1024 * 1024);
    expect(persisted.sizeBounded).toBe(false);
    expect(persisted.droppedFiles).toBe(0);
    expect(persisted.map.files).toHaveLength(map.files.length);
    expect(persisted.version).toBe(PERSISTED_REPO_MAP_VERSION);
  });

  it('trims the lowest-ranked files until the serialized envelope fits', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    const key = computeCacheKey(root, 'sha1', map.files.map((f) => join(root, f.path)));
    // Cap below the full size so at least one file must be dropped, but above a
    // single file so the prefix is non-empty.
    const full = serializedBytes(enforceSizeLimit(map, key, renderText, 10 * 1024 * 1024));
    const tight = Math.floor(full * 0.7);
    const persisted = enforceSizeLimit(map, key, renderText, tight);
    expect(persisted.sizeBounded).toBe(true);
    expect(persisted.droppedFiles).toBeGreaterThan(0);
    expect(persisted.map.files.length).toBeLessThan(map.files.length);
    expect(serializedBytes(persisted)).toBeLessThanOrEqual(tight);
    // The highest-ranked file (b.ts, most imported) survives the trim.
    expect(persisted.map.files[0].path).toBe(map.files[0].path);
    // The re-rendered text never references a dropped file.
    for (const f of map.files.slice(persisted.map.files.length)) {
      expect(persisted.map.text).not.toContain(`\n${f.path}\n`);
    }
  });
});

describe('assertNoBodyLeakage (privacy invariant)', () => {
  it('passes for a real persisted map: paths/signatures/imports only, no bodies', async () => {
    const map = await generateRepoMap(root, { tokenBudget: 5000 });
    const key = computeCacheKey(root, 'sha1', map.files.map((f) => join(root, f.path)));
    const persisted = enforceSizeLimit(map, key, (files) => renderRepoMap(files, 5000));
    const report = assertNoBodyLeakage(persisted, [BODY_SECRET, CONFIG_SECRET]);
    expect(report.ok).toBe(true);
    expect(report.leaked).toEqual([]);
    // Structural facts ARE present — the map is not empty.
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain('a.ts');
    expect(serialized).toContain('funcA');
    expect(serialized).toContain('./b'); // an import reference
  });

  it('reports a leak when a body sentinel survives into the artifact', () => {
    const leaky = {
      version: PERSISTED_REPO_MAP_VERSION,
      cacheKey: {
        root,
        gitSha: null,
        maxMtimeMs: 1,
        structureSignature: null,
        repository: null,
      },
      sizeBounded: false,
      droppedFiles: 0,
      map: {
        root,
        generatedAtGitSha: null,
        fileCount: 1,
        files: [{ path: 'a.ts', symbols: [], imports: [] }],
        // Simulate a regression that smuggled a body into the text.
        text: `a.ts\n  // ${BODY_SECRET}`,
        truncated: false,
      },
    };
    const report = assertNoBodyLeakage(leaky, [BODY_SECRET]);
    expect(report.ok).toBe(false);
    expect(report.leaked).toContain(BODY_SECRET);
  });
});

describe('artifactPathFor', () => {
  it('keeps a readable, dash-sanitized prefix of the root', () => {
    const p = artifactPathFor('/out', '/home/u/proj');
    expect(p.startsWith('/out/-home-u-proj-')).toBe(true);
    expect(p.endsWith('.json')).toBe(true);
  });

  // #1935: the encoding MUST be injective. The old `replace(/[^a-zA-Z0-9]/g,'-')`
  // mapped every separator to `-`, so proj-a / proj.a / proj_a / proj/a all
  // collided to ONE filename and the multi-root refresh driver silently
  // overwrote one root's artifact with another's (data loss, falsely-reassuring
  // "written" count). A sha256 suffix over the FULL root guarantees distinct
  // files; identity is recovered from the artifact's stored `root`, not the name.
  it('produces DISTINCT paths for roots that differ only in punctuation', () => {
    const dir = '/out';
    const colliding = [
      '/home/u/proj-a',
      '/home/u/proj.a',
      '/home/u/proj_a',
      '/home/u/proj/a',
    ];
    const paths = colliding.map((r) => artifactPathFor(dir, r));
    expect(new Set(paths).size).toBe(colliding.length);
  });

  // #719/#1004: ADR 0007 names the artifact path as THE producer/consumer seam.
  // scripts/repo-map-generate.mjs WRITES via artifactPathFor and scripts/ingest.mjs
  // READS via the same function, so both MUST derive the same file for a root.
  it('derives the producer and consumer path from one function (round-trip)', () => {
    // Stand-in for the producer write (repo-map-generate.mjs L77) and the
    // consumer read (ingest.mjs readRepoMapArtifact): both call artifactPathFor
    // with the same artifact dir + root, so they MUST resolve to the same file.
    const dir = '/usage-data/repo-map';
    const roots = [
      '/home/user/project/claude-history-dashboard',
      '/tmp/proj-with-dash',
      'C:\\Users\\dev\\repo',
    ];
    for (const root of roots) {
      const producerPath = artifactPathFor(dir, root);
      const consumerPath = artifactPathFor(dir, root);
      expect(consumerPath).toBe(producerPath);
      expect(producerPath.startsWith(`${dir}/`)).toBe(true);
      expect(producerPath.endsWith('.json')).toBe(true);
      // No raw separators survive the encoding — the basename is dash-only.
      const basename = producerPath.slice(dir.length + 1, -'.json'.length);
      expect(/[^a-zA-Z0-9-]/.test(basename)).toBe(false);
    }
  });
});
