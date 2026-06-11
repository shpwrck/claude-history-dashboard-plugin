import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import type { FileStructure, ParseFile, RepoSymbol, RepoSymbolKind } from './types';

/**
 * WASM Tree-sitter TS/JS structure extractor (#887 / ADR 0007).
 *
 * SERVER/HOST-ONLY and never imported by `scripts/server.mjs` or the SPA: it
 * loads `web-tree-sitter` (WASM) plus a prebuilt grammar from `tree-sitter-wasms`
 * — both devDependencies present only where the Repo Map is GENERATED (the host /
 * CI). The runtime container reads the JSON artifact, so the zero-node_modules
 * runtime invariant is untouched.
 *
 * Pinned pair: `web-tree-sitter@0.20.8` + `tree-sitter-wasms@0.1.13`. The grammar
 * `.wasm` is built against tree-sitter 0.20's dylink format; newer
 * web-tree-sitter (0.25+) changed that format and will not load these grammars.
 * Adding a language later = loading its sibling `tree-sitter-<lang>.wasm`.
 */

const require = createRequire(import.meta.url);

/** Resolve a grammar `.wasm` as a sibling of web-tree-sitter in node_modules.
 *  `web-tree-sitter/tree-sitter.wasm` is a resolvable file in 0.20.x (no exports
 *  restriction), giving us a stable anchor to the node_modules root. */
function grammarWasmPath(lang: string): string {
  const core = require.resolve('web-tree-sitter/tree-sitter.wasm');
  return join(dirname(core), '..', 'tree-sitter-wasms', 'out', `tree-sitter-${lang}.wasm`);
}

let parserPromise: Promise<Parser> | null = null;

/** Load (once) a Tree-sitter parser with the TypeScript grammar set. The TS
 *  grammar also parses JS/JSX/TSX structurally for our purposes (imports +
 *  top-level decls), so one grammar covers the v0.3 TS/JS-first scope. */
export async function loadTsParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init({
        locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm'),
      });
      const lang = await Parser.Language.load(
        readFileSync(grammarWasmPath('typescript'))
      );
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    })();
  }
  return parserPromise;
}

/** Map a Tree-sitter declaration node type to our small symbol vocabulary. */
const KIND_BY_TYPE: Record<string, RepoSymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

const SIGNATURE_MAX = 140;

/** The declaration HEAD only: up to the body `{`, the first newline, and — for
 *  value declarations — the initializer `=`. NEVER includes a body OR a literal
 *  value (privacy: no source bodies, no `const API_KEY = '…'` value leaking).
 *
 *  `cutAtEquals` is set for const/let/var so the literal value is dropped while
 *  the type annotation (which sits BEFORE `=`, e.g. `const h: Handler`) is kept.
 *  Type aliases pass it false so their structural RHS (`type Id = string`)
 *  survives — a type carries no secret values. */
function signatureOf(text: string, cutAtEquals = false): string {
  let head = text;
  const brace = head.indexOf('{');
  if (brace >= 0) head = head.slice(0, brace);
  if (cutAtEquals) {
    const eq = head.indexOf('=');
    if (eq >= 0) head = head.slice(0, eq);
  }
  const nl = head.indexOf('\n');
  if (nl >= 0) head = head.slice(0, nl);
  head = head.replace(/\s+/g, ' ').trim();
  // Drop a dangling `=`/`(` left by the cut, and a trailing `;`/`,`, so the
  // signature reads cleanly.
  head = head.replace(/[=(]\s*$/, '').replace(/[;,]\s*$/, '').trim();
  return head.length > SIGNATURE_MAX ? `${head.slice(0, SIGNATURE_MAX)}…` : head;
}

// web-tree-sitter 0.20 exposes a loose SyntaxNode; we only touch a few members.
type TSNode = {
  type: string;
  text: string;
  childCount: number;
  startPosition: { row: number };
  child(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  namedChildren: TSNode[];
};

function nameOf(node: TSNode): string | null {
  const n = node.childForFieldName('name');
  return n ? n.text : null;
}

function pushDeclaration(node: TSNode, exported: boolean, out: RepoSymbol[]): void {
  const kind = KIND_BY_TYPE[node.type];
  if (kind) {
    const name = nameOf(node);
    if (name) {
      out.push({ name, kind, exported, signature: signatureOf(node.text), line: node.startPosition.row + 1 });
    }
    return;
  }
  // const/let/var: one symbol per declarator (skip destructuring patterns).
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const isConst = node.type === 'lexical_declaration' && /^const\b/.test(node.text);
    for (const child of node.namedChildren) {
      if (child.type !== 'variable_declarator') continue;
      const name = child.childForFieldName('name');
      if (!name || name.type !== 'identifier') continue;
      out.push({
        name: name.text,
        kind: isConst ? 'const' : 'variable',
        exported,
        signature: signatureOf(node.text, true), // drop the initializer value
        line: node.startPosition.row + 1,
      });
    }
  }
}

/** Extract imports + top-level symbols from one parsed program node. */
export function extractStructure(parser: Parser, source: string): FileStructure {
  const tree = (parser as unknown as { parse(s: string): { rootNode: TSNode } }).parse(source);
  const root = tree.rootNode;
  const symbols: RepoSymbol[] = [];
  const imports: string[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node) continue;
    if (node.type === 'import_statement') {
      const spec = node.namedChildren.find((c) => c.type === 'string');
      if (spec) imports.push(spec.text.replace(/^['"`]|['"`]$/g, ''));
      continue;
    }
    if (node.type === 'export_statement') {
      // `export <decl>` / `export default <decl>` — recurse into the declaration.
      let handled = false;
      for (const child of node.namedChildren) {
        if (KIND_BY_TYPE[child.type] || child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
          pushDeclaration(child, true, symbols);
          handled = true;
        }
      }
      // `export { a, b } from '...'` re-exports carry a source string too.
      if (!handled) {
        const spec = node.namedChildren.find((c) => c.type === 'string');
        if (spec) imports.push(spec.text.replace(/^['"`]|['"`]$/g, ''));
      }
      continue;
    }
    pushDeclaration(node, false, symbols);
  }

  return { symbols, imports };
}

/** Build a ready-to-use {@link ParseFile} backed by the loaded WASM parser. The
 *  default parser for {@link generateRepoMap} on the host path. */
export async function createTsParseFile(): Promise<ParseFile> {
  const parser = await loadTsParser();
  return (source: string) => extractStructure(parser, source);
}
