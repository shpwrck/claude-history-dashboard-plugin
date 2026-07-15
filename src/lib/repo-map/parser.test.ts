import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'web-tree-sitter';
import { loadTsParser, extractStructure, repoMapParserCacheSalt } from './parser';

// Exercises the REAL WASM Tree-sitter grammar (web-tree-sitter@0.20.8 +
// tree-sitter-wasms@0.1.13). Confirms the pinned pair loads under vitest and
// that structure extraction surfaces the right symbols/imports.
describe('repo-map parser (WASM Tree-sitter)', () => {
  let parser: Parser;
  beforeAll(async () => {
    parser = await loadTsParser();
  });

  it('extracts top-level symbols with exported flags and kinds', () => {
    const src = `import { foo } from './foo';
import bar from 'bar';
export function hello(name: string): string { return name; }
export const PI = 3.14;
export class Widget { render() {} }
export interface Shape { sides: number }
export type Id = string;
export enum Color { Red, Green }
function privateHelper() { return 1; }
const localConst = 2;
`;
    const { symbols, imports } = extractStructure(parser, src);

    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(byName.hello).toMatchObject({ kind: 'function', exported: true });
    expect(byName.PI).toMatchObject({ kind: 'const', exported: true });
    expect(byName.Widget).toMatchObject({ kind: 'class', exported: true });
    expect(byName.Shape).toMatchObject({ kind: 'interface', exported: true });
    expect(byName.Id).toMatchObject({ kind: 'type', exported: true });
    expect(byName.Color).toMatchObject({ kind: 'enum', exported: true });
    expect(byName.privateHelper).toMatchObject({ kind: 'function', exported: false });
    expect(byName.localConst).toMatchObject({ kind: 'const', exported: false });

    expect(imports).toEqual(['./foo', 'bar']);
  });

  it('captures a declaration-head signature WITHOUT the body', () => {
    const { symbols } = extractStructure(
      parser,
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    const add = symbols.find((s) => s.name === 'add')!;
    // Signature is the declaration head; the `export` keyword lives on the
    // wrapper node and is carried by the `exported` flag instead.
    expect(add.signature).toBe('function add(a: number, b: number): number');
    expect(add.exported).toBe(true);
    // The body must never leak into the signature (privacy: no source bodies).
    expect(add.signature).not.toContain('return');
    expect(add.line).toBe(1);
  });

  it('never leaks a string-literal const value (privacy: no source content)', () => {
    const { symbols } = extractStructure(
      parser,
      `export const API_KEY = 'sk-ant-do-not-leak-this';\n` +
        `const dsn: string = 'postgres://user:pw@host/db';\n`
    );
    const apiKey = symbols.find((s) => s.name === 'API_KEY')!;
    const dsn = symbols.find((s) => s.name === 'dsn')!;
    expect(apiKey.signature).toBe('const API_KEY');
    expect(apiKey.signature).not.toContain('sk-ant');
    // The type annotation (before `=`) is kept; the value is dropped.
    expect(dsn.signature).toBe('const dsn: string');
    expect(dsn.signature).not.toContain('postgres');
  });

  it('keeps a type alias RHS (types carry no secret values)', () => {
    const { symbols } = extractStructure(parser, `export type Id = string | number;\n`);
    expect(symbols.find((s) => s.name === 'Id')!.signature).toBe('type Id = string | number');
  });

  it('records re-export sources as import edges', () => {
    const { imports } = extractStructure(parser, `export { a, b } from './shared';\n`);
    expect(imports).toContain('./shared');
  });

  it('handles JS (no type annotations) and empty input', () => {
    const { symbols } = extractStructure(parser, 'export const x = () => 1;\n');
    expect(symbols.find((s) => s.name === 'x')).toMatchObject({ kind: 'const', exported: true });
    expect(extractStructure(parser, '')).toEqual({ symbols: [], imports: [] });
  });

  it('exposes a stable cache salt fingerprinting grammar + extraction semantics', () => {
    const first = repoMapParserCacheSalt();
    expect(first).toMatch(/^repo-map-output-v\d+:[a-f0-9]{64}$/);
    expect(repoMapParserCacheSalt()).toBe(first);
  });
});
