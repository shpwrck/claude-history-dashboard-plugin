import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRepoMap, renderRepoMap } from './generate';
import { createTsParseFile } from './parser';
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

  it('enforces maxFiles inside a flat directory', async () => {
    const cappedRoot = mkdtempSync(join(tmpdir(), 'repomap-file-cap-'));
    const parsed: string[] = [];
    try {
      writeFileSync(join(cappedRoot, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(cappedRoot, 'b.ts'), 'export const b = 1;\n');
      const parse: ParseFile = (source, path) => {
        parsed.push(path);
        return fakeParse(source, path);
      };

      const map = await generateRepoMap(cappedRoot, {
        parseFile: parse,
        maxFiles: 1,
        tokenBudget: 5000,
      });

      expect(map.fileCount).toBe(1);
      expect(parsed).toHaveLength(1);
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

// #3168 acceptance: the artifact is prompt-facing, so a literal secret must not
// survive into EITHER the persisted JSON or the rendered text. Uses the REAL
// WASM parser end-to-end — the point is that the produced map, not just a
// unit-tested helper, is clean.
describe('generateRepoMap literal-secret redaction (#3168)', () => {
  it('emits neither a literal type alias nor a default parameter value', async () => {
    const secretRoot = mkdtempSync(join(tmpdir(), 'repomap-secret-'));
    try {
      writeFileSync(
        join(secretRoot, 'creds.ts'),
        `export type Token = 'sk-secret';\n` +
          `export function f(key = 'pw-secret') {}\n` +
          `export const DSN = 'postgres://user:pw-secret@host/db';\n` +
          `export function lookup(id: string, limit: number): Promise<string> {\n` +
          `  return Promise.resolve(id + limit);\n}\n`
      );

      const map = await generateRepoMap(secretRoot, {
        parseFile: await createTsParseFile(),
      });
      const json = JSON.stringify(map);

      for (const carrier of [json, map.text]) {
        expect(carrier).not.toContain('sk-secret');
        expect(carrier).not.toContain('pw-secret');
        expect(carrier).not.toContain('postgres');
      }

      // ...while the map stays useful: names, kinds, and non-literal type
      // structure all survive.
      const symbols = map.files[0].symbols;
      expect(symbols.map((s) => s.name).sort()).toEqual(['DSN', 'Token', 'f', 'lookup']);
      expect(map.text).toContain(
        'export function lookup(id: string, limit: number): Promise<string>'
      );
      expect(map.text).toContain('export const DSN');
      expect(symbols.find((s) => s.name === 'Token')!.signature).toBe('type Token = <literal>');
      expect(symbols.find((s) => s.name === 'f')!.signature).toBe('function f(key = <literal>)');
    } finally {
      rmSync(secretRoot, { recursive: true, force: true });
    }
  });

  it('scrubs signatures arriving from an injected or cached parser it did not run', async () => {
    // A per-file cache entry written by an older build, or any injected
    // `parseFile`, is never re-parsed here — so the generator scrubs signatures
    // at the seam where structure ENTERS the artifact.
    const staleRoot = mkdtempSync(join(tmpdir(), 'repomap-stale-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(join(staleRoot, 'stale.ts'), 'export const k = 1;\n');
      const staleParse: ParseFile = () => ({
        symbols: [
          {
            name: 'k',
            kind: 'const',
            exported: true,
            signature: `const k = 'sk-ant-api03-STALECACHEDSECRET0123456789'`,
            line: 1,
          },
        ],
        imports: [],
      });

      const map = await generateRepoMap(staleRoot, { parseFile: staleParse });
      for (const carrier of [JSON.stringify(map), map.text]) {
        expect(carrier).not.toContain('STALECACHEDSECRET');
        expect(carrier).toContain('[REDACTED_KEY]');
      }
      // Structural fields are left alone — ranking and joins depend on them.
      expect(map.files[0].symbols[0].name).toBe('k');
      expect(map.files[0].path).toBe('stale.ts');
      // The dev contract check fires here (this signature is unsanitized), and
      // must not echo the secret it is reporting.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0].join(' ')).not.toContain('STALECACHEDSECRET');
    } finally {
      warn.mockRestore();
      rmSync(staleRoot, { recursive: true, force: true });
    }
  });
});

// The seam scrubs secret SHAPES; masking an arbitrary literal needs an AST and a
// known language, so it is the parser's job (the ParseFile privacy contract).
// These tests pin the boundary in both directions, so the code cannot drift into
// claiming a protection it does not provide.
describe('ParseFile privacy contract at the generator seam (#3168)', () => {
  it('warns when an injected parser returns an unsanitized signature', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repomap-contract-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'a.ts'), 'export const k = 1;\n');
      // A hypothetical non-TS parser that forgot to mask literals. `pw-secret`
      // has no secret SHAPE, so `redactSecrets` cannot see it.
      const unsanitized: ParseFile = () => ({
        symbols: [
          {
            name: 'f',
            kind: 'function',
            exported: true,
            signature: `function f(key = 'pw-secret')`,
            line: 1,
          },
        ],
        imports: [],
      });

      const map = await generateRepoMap(root, { parseFile: unsanitized });

      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0].join(' ');
      expect(message).toContain('did not mask literals');
      expect(message).toContain('ParseFile privacy contract');
      // Locates the offender by symbol + file...
      expect(message).toContain('f');
      expect(message).toContain('a.ts');
      // ...but never echoes the signature: reprinting the unmasked literal would
      // leak the reported secret into logs, the same mistake in another sink.
      expect(message).not.toContain('pw-secret');
      // Honest about the consequence: the seam CANNOT remove this, and the test
      // says so rather than implying a guard that does not exist.
      expect(map.text).toContain('pw-secret');
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays silent for the real TypeScript parser, which satisfies the contract', async () => {
    // The shipped path: literals are masked structurally, so no delimiter
    // survives and the dev check has nothing to say. Guards against the warning
    // becoming background noise that everyone learns to ignore.
    const root = mkdtempSync(join(tmpdir(), 'repomap-contract-ok-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(
        join(root, 'a.ts'),
        `export type Token = 'sk-secret';\n` +
          `export function f(key = 'pw-secret') {}\n` +
          `export const dsn: string = 'postgres://user:pw@host/db';\n` +
          `export function lookup(id: string): Promise<string> {\n` +
          `  return Promise.resolve(id);\n}\n`
      );

      const map = await generateRepoMap(root, { parseFile: await createTsParseFile() });

      expect(warn).not.toHaveBeenCalled();
      expect(map.text).not.toContain("'");
    } finally {
      warn.mockRestore();
      rmSync(root, { recursive: true, force: true });
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
