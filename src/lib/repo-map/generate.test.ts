import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRepoMap, renderRepoMap } from './generate';
import type { ParseFile, RepoFile } from './types';

// A deterministic fake parser: regex out `export <kind> <name>` + `from '<spec>'`.
// Lets the walk/ranking/render/budget logic be tested without the WASM grammar.
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

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repomap-'));
  // b.ts is imported by both a.ts and sub/c.ts -> highest in-degree.
  writeFileSync(join(root, 'b.ts'), `export function funcB() { const x = '${BODY_SECRET}'; return x; }\n`);
  // a.ts carries a TOP-LEVEL const secret (no braces) — the privacy topology the
  // brace-cut alone would miss; the real parser must strip the initializer value.
  writeFileSync(
    join(root, 'a.ts'),
    `import { funcB } from './b';\nexport const API_TOKEN = '${BODY_SECRET}';\nexport const funcA = () => funcB();\n`
  );
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.ts'), `import { funcB } from '../b';\nexport function funcC() {}\n`);
  // Must be ignored.
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'dep.ts'), `export const ignored = 1;\n`);
  // Non-source file ignored.
  writeFileSync(join(root, 'README.md'), `# hi\n`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('generateRepoMap', () => {
  it('walks source files, skipping node_modules and non-source files', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    const paths = map.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
    expect(map.fileCount).toBe(3);
    expect(paths).not.toContain('node_modules/dep.ts');
  });

  it('bounds directory entry discovery before parsing source files', async () => {
    const cappedRoot = mkdtempSync(join(tmpdir(), 'repomap-cap-'));
    try {
      writeFileSync(join(cappedRoot, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(cappedRoot, 'b.ts'), 'export const b = 1;\n');

      const map = await generateRepoMap(cappedRoot, {
        parseFile: fakeParse,
        maxFiles: 10,
        maxDirEntries: 1,
        tokenBudget: 5000,
      });

      expect(map.fileCount).toBeLessThanOrEqual(1);
      if (map.files[0]) {
        expect(['a.ts', 'b.ts']).toContain(map.files[0].path);
      }
    } finally {
      rmSync(cappedRoot, { recursive: true, force: true });
    }
  });

  it('ranks the most-imported file first', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    // b.ts is imported by a.ts and sub/c.ts -> ranks ahead of the others.
    expect(map.files[0].path).toBe('b.ts');
  });

  it('records the staleness stamp it is given', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse, gitSha: 'abc123' });
    expect(map.generatedAtGitSha).toBe('abc123');
  });

  it('captures each source file mtime host-side', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    const a = map.files.find((file) => file.path === 'a.ts');
    expect(a?.mtimeMs).toBe(statSync(join(root, 'a.ts')).mtimeMs);
  });

  it('never persists a source body (privacy invariant)', async () => {
    const map = await generateRepoMap(root, { parseFile: fakeParse });
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain(BODY_SECRET);
    expect(map.text).not.toContain(BODY_SECRET);
  });

  it('token-budgets the text without truncating the structured index', async () => {
    const tiny = await generateRepoMap(root, { parseFile: fakeParse, tokenBudget: 5 });
    expect(tiny.truncated).toBe(true);
    expect(tiny.files).toHaveLength(3); // full structure always retained
    const big = await generateRepoMap(root, { parseFile: fakeParse, tokenBudget: 5000 });
    expect(big.truncated).toBe(false);
    expect(big.files).toHaveLength(3);
    expect(big.text.length).toBeGreaterThan(tiny.text.length);
  });

  it('end-to-end with the real WASM parser extracts real symbols', async () => {
    const map = await generateRepoMap(root, { tokenBudget: 5000 });
    const b = map.files.find((f) => f.path === 'b.ts')!;
    expect(b.symbols.map((s) => s.name)).toContain('funcB');
    const a = map.files.find((f) => f.path === 'a.ts')!;
    expect(a.imports).toContain('./b');
    // The real parser must not leak the body either.
    expect(JSON.stringify(map)).not.toContain(BODY_SECRET);
  });

  it('counts distinct importing files, not repeated declarations in one file', async () => {
    const edgeRoot = mkdtempSync(join(tmpdir(), 'repomap-edges-'));
    try {
      writeFileSync(
        join(edgeRoot, 'one.ts'),
        [
          "import { target } from './z-target';",
          "export { target as targetAgain } from './z-target';",
          "import { target as targetTwice } from './z-target';",
          "import { target as targetWithTsExtension } from './z-target.ts';",
          "export { target as targetWithJsExtension } from './z-target.js';",
          "import { competitor } from './a-competitor';",
          'export const one = [target, targetTwice, targetWithTsExtension, competitor];',
        ].join('\n')
      );
      writeFileSync(
        join(edgeRoot, 'two.ts'),
        "import { competitor } from './a-competitor';\nexport const two = competitor;\n"
      );
      writeFileSync(
        join(edgeRoot, 'z-target.ts'),
        'export const target = 1;\n'
      );
      writeFileSync(
        join(edgeRoot, 'a-competitor.ts'),
        'export const competitor = 2;\n'
      );

      const map = await generateRepoMap(edgeRoot, { tokenBudget: 5000 });
      const one = map.files.find((file) => file.path === 'one.ts')!;

      expect(one.imports).toEqual([
        './z-target',
        './z-target.ts',
        './z-target.js',
        './a-competitor',
      ]);
      // competitor has two distinct importer files; target has one importer
      // with repeated declarations and three equivalent specifier spellings.
      // Neither form may manufacture a larger in-degree for target.
      expect(map.files[0].path).toBe('a-competitor.ts');
      expect(map.text).toContain(
        'imports: ./z-target, ./z-target.ts, ./z-target.js, ./a-competitor'
      );
    } finally {
      rmSync(edgeRoot, { recursive: true, force: true });
    }
  });
});

describe('renderRepoMap', () => {
  const files: RepoFile[] = [
    { path: 'b.ts', symbols: [{ name: 'funcB', kind: 'function', exported: true, signature: 'function funcB()', line: 1 }], imports: [] },
    { path: 'a.ts', symbols: [{ name: 'funcA', kind: 'const', exported: true, signature: 'const funcA', line: 2 }], imports: ['./b'] },
  ];

  it('renders exported symbols and imports, bounded by the budget', () => {
    const { text, included, truncated } = renderRepoMap(files, 5000);
    expect(included).toHaveLength(2);
    expect(truncated).toBe(false);
    expect(text).toContain('b.ts');
    expect(text).toContain('export function funcB');
    expect(text).toContain('imports: ./b');
  });

  it('truncates but always includes at least the first block', () => {
    const { included, truncated } = renderRepoMap(files, 1);
    expect(included).toHaveLength(1);
    expect(truncated).toBe(true);
  });
});
