import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'web-tree-sitter';
import {
  loadTsParser,
  extractStructure,
  repoMapParserCacheSalt,
  REDACTED_LITERAL,
} from './parser';

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

  it('keeps a type alias RHS built from non-literal type structure', () => {
    const { symbols } = extractStructure(parser, `export type Id = string | number;\n`);
    expect(symbols.find((s) => s.name === 'Id')!.signature).toBe('type Id = string | number');
  });

  // #3168: the head cut alone is not a privacy boundary. A default parameter
  // value sits BEFORE the body brace and a type alias keeps its whole RHS by
  // design, so literal secrets used to ride into the prompt-facing map as
  // "structure". Literal nodes are now masked structurally.
  describe('literal redaction in declaration heads (#3168)', () => {
    it('masks a literal type alias RHS instead of publishing the literal', () => {
      const { symbols } = extractStructure(parser, `export type Token = 'sk-secret';\n`);
      const token = symbols.find((s) => s.name === 'Token')!;
      expect(token.signature).toBe(`type Token = ${REDACTED_LITERAL}`);
      expect(token.signature).not.toContain('sk-secret');
    });

    it('masks default parameter values, which sit before the body brace', () => {
      const { symbols } = extractStructure(
        parser,
        `export function f(key = 'pw-secret', retries = 42) {}\n`
      );
      const f = symbols.find((s) => s.name === 'f')!;
      expect(f.signature).toBe(
        `function f(key = ${REDACTED_LITERAL}, retries = ${REDACTED_LITERAL})`
      );
      expect(f.signature).not.toContain('pw-secret');
      expect(f.signature).not.toContain('42');
    });

    it('masks a default value whose literal contains a brace (no early cut)', () => {
      const { symbols } = extractStructure(
        parser,
        `export function withBrace(opts = '{"key":"brace-secret"}'): void {}\n`
      );
      const fn = symbols.find((s) => s.name === 'withBrace')!;
      expect(fn.signature).toBe(`function withBrace(opts = ${REDACTED_LITERAL}): void`);
      expect(fn.signature).not.toContain('brace-secret');
    });

    it('masks literal unions, template literal types, and numeric literal types', () => {
      const { symbols } = extractStructure(
        parser,
        `export type Mode = 'a-secret' | 'b-secret';\n` +
          'export type Dsn = `postgres://${string}:tpl-secret@host`;\n' +
          'export type Retries = 7;\n'
      );
      const byName = Object.fromEntries(symbols.map((s) => [s.name, s.signature]));
      expect(byName.Mode).toBe(`type Mode = ${REDACTED_LITERAL} | ${REDACTED_LITERAL}`);
      expect(byName.Dsn).toBe(`type Dsn = ${REDACTED_LITERAL}`);
      expect(byName.Retries).toBe(`type Retries = ${REDACTED_LITERAL}`);
      for (const sig of Object.values(byName)) {
        expect(sig).not.toContain('secret');
      }
    });

    it('masks literals in class heritage clauses and comments inside the head', () => {
      const { symbols } = extractStructure(
        parser,
        `export class Client extends make('cls-secret') {}\n` +
          `export function g(/* token: cmt-secret */ id: number): void {}\n`
      );
      const byName = Object.fromEntries(symbols.map((s) => [s.name, s.signature]));
      expect(byName.Client).toBe(`class Client extends make(${REDACTED_LITERAL})`);
      expect(byName.g).toBe(`function g(${REDACTED_LITERAL} id: number): void`);
      expect(byName.Client).not.toContain('cls-secret');
      expect(byName.g).not.toContain('cmt-secret');
    });

    it('masks an enum member value even though the brace cut usually hides it', () => {
      const { symbols } = extractStructure(
        parser,
        `export enum Env { Prod = 'env-secret' }\n`
      );
      expect(symbols.find((s) => s.name === 'Env')!.signature).not.toContain('env-secret');
    });

    it('keeps predefined type annotations, whose tokens collide with literal node types', () => {
      // `string`/`number` predefined types are ANONYMOUS tokens typed `string`
      // and `number`; a naive all-children walk masks them and destroys the
      // structure the map exists to carry.
      const { symbols } = extractStructure(
        parser,
        `export const dsn: string = 'postgres://user:pw@host/db';\n` +
          `export function sum(a: number, b: number): number { return a + b; }\n`
      );
      const byName = Object.fromEntries(symbols.map((s) => [s.name, s.signature]));
      expect(byName.dsn).toBe('const dsn: string');
      expect(byName.sum).toBe('function sum(a: number, b: number): number');
    });

    it('masks an UNTERMINATED literal, which the grammar never types as a literal', () => {
      // Mid-edit sources reach the map: `generateRepoMap` keeps going on a
      // partial parse. Tree-sitter puts the stray backtick under an ERROR node
      // and salvages `pw-secret` as a binary_expression of two identifiers, so
      // there is no literal subtree to mask and the value has no secret SHAPE
      // for `redactSecrets` to catch. The surviving delimiter is the signal.
      const { symbols } = extractStructure(
        parser,
        'export function f(key = `pw-secret) {}\n'
      );
      const f = symbols.find((s) => s.name === 'f')!;
      expect(f.signature).not.toContain('pw-secret');
      expect(f.signature).toBe(`function f(key = ${REDACTED_LITERAL}`);
    });

    it('masks an unterminated literal in a type alias RHS too', () => {
      // The type-alias path keeps its RHS by design, so it needs the same guard.
      const { symbols } = extractStructure(parser, 'export type T = `sk-secret\n');
      const t = symbols.find((s) => s.name === 'T')!;
      expect(t.signature).not.toContain('sk-secret');
      expect(t.signature).toBe(`type T = ${REDACTED_LITERAL}`);
    });

    it('survives a deeply nested expression instead of throwing (walk is iterative)', () => {
      // A recursive walk overflowed the JS stack at roughly 7 000 levels — well
      // inside a 14 KiB file — and `generateRepoMap` turns a parse throw into
      // "unparseable", silently dropping EVERY symbol in the file.
      const depth = 20_000;
      const src = `export const x = ${'('.repeat(depth)}1${')'.repeat(depth)};\n`;
      expect(src.length).toBeLessThan(512 * 1024);
      const { symbols } = extractStructure(parser, src);
      expect(symbols).toHaveLength(1);
      expect(symbols[0]).toMatchObject({ name: 'x', kind: 'const', signature: 'const x' });
    });

    it('is unchanged by the head scan bound on a declaration with a huge body', () => {
      // Behaviour guard, not a crash regression: HEAD_SCAN_LIMIT keeps the walk
      // proportional to the head rather than to a body that is discarded at the
      // brace anyway. This asserts the bound costs nothing observable — it
      // passes with and without it — and that nothing past the bound is emitted,
      // so bounding can only withhold text, never leak it.
      const body = `  const s = 'body-secret';\n`.repeat(4000);
      const { symbols } = extractStructure(
        parser,
        `export function big(a: string, b: number): void {\n${body}}\n`
      );
      const big = symbols.find((s) => s.name === 'big')!;
      expect(big.signature).toBe('function big(a: string, b: number): void');
      expect(big.signature).not.toContain('body-secret');
    });

    it('also runs the shared redactor over the head, catching non-literal secrets', () => {
      // A secret-shaped IDENTIFIER is not a literal node, so structural masking
      // cannot see it; the shared `redactSecrets` net is what catches it. This
      // is the layer that also covers text salvaged from ERROR nodes when a
      // file only partially parses.
      const { symbols } = extractStructure(
        parser,
        'export function h(seed = deadbeefdeadbeefdeadbeefdeadbeef): void {}\n' +
          'export type Alias = typeof plainHelper;\n'
      );
      const byName = Object.fromEntries(symbols.map((s) => [s.name, s.signature]));
      expect(byName.h).toBe('function h(seed = [REDACTED_HEX]): void');
      // Sanity: structure with no secret shape passes through untouched.
      expect(byName.Alias).toBe('type Alias = typeof plainHelper');
    });
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
