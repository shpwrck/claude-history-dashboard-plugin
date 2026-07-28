import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import type { FileStructure, ParseFile, RepoSymbol, RepoSymbolKind } from './types';
import { redactSecrets } from '../secret-redaction';
// The canonical parser-output -> cache-invalidation seam (#2075). A change to
// extractStructure semantics already requires this version to move; reuse it
// rather than creating a second manual bump point for the per-file cache.
// @ts-expect-error - plain ESM constant registry, no .d.ts (same as cache.ts).
import { REPO_MAP_OUTPUT } from '../../../scripts/lib/parser-output-versions.mjs';

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

let fileCacheSalt: string | null = null;

/** Stable grammar + engine + extraction-semantics salt for per-file caching. */
export function repoMapParserCacheSalt(): string {
  if (!fileCacheSalt) {
    const engine = readFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'));
    const grammar = readFileSync(grammarWasmPath('typescript'));
    const wasmDigest = createHash('sha256')
      .update(engine)
      .update('\0')
      .update(grammar)
      .digest('hex');
    fileCacheSalt = `repo-map-output-v${REPO_MAP_OUTPUT.version}:${wasmDigest}`;
  }
  return fileCacheSalt;
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

/** What a masked literal renders as in a signature. Plain characters only (repo
 *  convention), and deliberately not valid source so nobody mistakes a signature
 *  for a copy-pasteable declaration. */
export const REDACTED_LITERAL = '<literal>';

/** Source node types whose TEXT is author-written content rather than structure.
 *  Every one of these is masked out of a signature before serialization, because
 *  a literal is exactly where a credential hides: a default parameter value
 *  (`function f(key = 'sk-…')`), a literal type alias (`type Token = 'sk-…'`), a
 *  computed class heritage argument, a decorator argument, or a comment sitting
 *  inside the declaration head. Structure — names, parameter names, type
 *  operators, generics — is not in this set and survives. */
const LITERAL_NODE_TYPES = new Set([
  'string',
  'template_string',
  'template_literal_type',
  'number',
  'regex',
  'comment',
]);

// web-tree-sitter 0.20 exposes a loose SyntaxNode; we only touch a few members.
type TSNode = {
  type: string;
  text: string;
  childCount: number;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  child(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  namedChildren: TSNode[];
};

/** How far past a declaration's start the literal walk looks. A signature is a
 *  HEAD — cut at the body `{` and the first newline, then capped at
 *  {@link SIGNATURE_MAX} — so text far beyond the start can never reach it.
 *  Generous enough that redaction (which SHRINKS text: a 2 KiB literal becomes
 *  nine characters) still sees every literal that could land inside the cap. */
const HEAD_SCAN_LIMIT = 4096;

/** `node.text` with every literal/comment subtree replaced by
 *  {@link REDACTED_LITERAL}.
 *
 *  This is the structural half of the privacy boundary and it runs BEFORE any
 *  text slicing, so it does not depend on where the head happens to be cut. The
 *  walk is position-ordered (Tree-sitter children are), so a single forward
 *  cursor over the raw text is enough; a literal's own children (for example a
 *  template substitution) are skipped wholesale.
 *
 *  Only NAMED children are visited. That is load-bearing, not an optimisation:
 *  the anonymous keyword tokens of TypeScript's predefined types are themselves
 *  typed `string` and `number`, so an all-children walk would mask the type
 *  annotation in `const dsn: string` and destroy exactly the structure this map
 *  exists to carry.
 *
 *  The traversal is ITERATIVE and position-bounded, both for safety rather than
 *  style. A recursive walk over the whole declaration blew the JavaScript stack
 *  on deeply nested expressions — roughly 7 000 levels, reachable in a ~14 KiB
 *  file — and `generateRepoMap` catches a parse throw by dropping the file, so
 *  one pathological expression silently erased every symbol in it. The explicit
 *  stack removes the depth limit; {@link HEAD_SCAN_LIMIT} keeps the work
 *  proportional to the head instead of to a discarded body. Nothing beyond the
 *  bound is emitted, so bounding can only ever withhold text, never leak it. */
function redactLiteralNodes(node: TSNode): string {
  const base = node.startIndex;
  const raw = node.text;
  const limit = Math.min(node.endIndex, base + HEAD_SCAN_LIMIT);
  let out = '';
  let cursor = base;
  const stack: TSNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    // A child starting at/after the bound cannot contribute to the head, and
    // its raw text is never appended below either.
    if (n.startIndex >= limit) continue;
    if (LITERAL_NODE_TYPES.has(n.type)) {
      if (n.startIndex > cursor) out += raw.slice(cursor - base, n.startIndex - base);
      out += REDACTED_LITERAL;
      cursor = Math.max(cursor, n.endIndex);
      continue;
    }
    // Push reversed so children pop in document order (pre-order, as before).
    const kids = n.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  // Empty when a literal ran past the bound — the tail is dropped, not emitted.
  out += raw.slice(cursor - base, limit - base);
  return out;
}

/** Mask from the first surviving quote delimiter to the end of `head`.
 *
 *  {@link redactLiteralNodes} masks whole literal NODES, delimiters included, so
 *  a well-formed declaration head has no `'`, `"` or backtick left in it. One
 *  that does came from a source Tree-sitter could not parse — and the generator
 *  deliberately keeps going on partial parses, so those reach the map. An
 *  unterminated literal is not typed as a literal at all: in
 *  `function f(key = \`pw-secret) {}` the backtick lands under an ERROR node and
 *  `pw-secret` is salvaged as a `binary_expression` of two identifiers, so there
 *  is no literal subtree to mask and {@link redactSecrets} sees nothing
 *  secret-SHAPED. Treating a surviving delimiter as "author content starts here"
 *  catches it without widening the node walk — which would not have helped
 *  anyway, and would have re-masked predefined type keywords. */
function maskUnterminatedLiteral(head: string): string {
  const quote = head.search(/['"`]/);
  return quote < 0 ? head : head.slice(0, quote) + REDACTED_LITERAL;
}

/** The declaration HEAD only: up to the body `{`, the first newline, and — for
 *  value declarations — the initializer `=`. NEVER includes a body OR a literal
 *  value (privacy: no source bodies, no `const API_KEY = '…'` value leaking).
 *
 *  Text slicing alone is NOT sufficient (#3168). A default parameter value sits
 *  before the body brace (`function f(key = 'pw-secret') {}`) and a type alias
 *  keeps its whole RHS by design (`type Token = 'sk-secret'`), so both used to
 *  ride into the prompt-facing map as "structure". Callers therefore pass the
 *  declaration NODE: literals are masked structurally first
 *  ({@link redactLiteralNodes}), an unterminated literal that the grammar never
 *  typed as one is cut off at its delimiter
 *  ({@link maskUnterminatedLiteral}), and the surviving head is then passed
 *  through the shared {@link redactSecrets} as a second net for secret-shaped
 *  text that is not a literal node at all (an identifier, a JSX-ish attribute, a
 *  token smuggled into a type name).
 *
 *  `cutAtEquals` is set for const/let/var so the initializer is dropped whole
 *  while the type annotation (which sits BEFORE `=`, e.g. `const h: Handler`) is
 *  kept. Type aliases pass it false so their structural RHS (`type Id = string`)
 *  survives — with literals now masked, that RHS carries shape, not values. */
function signatureOf(node: TSNode, cutAtEquals = false): string {
  let head = maskUnterminatedLiteral(redactLiteralNodes(node));
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
  head = redactSecrets(head);
  return head.length > SIGNATURE_MAX ? `${head.slice(0, SIGNATURE_MAX)}…` : head;
}

function nameOf(node: TSNode): string | null {
  const n = node.childForFieldName('name');
  return n ? n.text : null;
}

function pushDeclaration(node: TSNode, exported: boolean, out: RepoSymbol[]): void {
  const kind = KIND_BY_TYPE[node.type];
  if (kind) {
    const name = nameOf(node);
    if (name) {
      out.push({ name, kind, exported, signature: signatureOf(node), line: node.startPosition.row + 1 });
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
        signature: signatureOf(node, true), // drop the initializer value
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
