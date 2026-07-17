/**
 * Repo Map types (#887, keystone of epic #871). See ADR 0007.
 *
 * The Repo Map is a bounded, privacy-aware STRUCTURAL index of a project root —
 * files, exported/top-level symbols with signatures, and import edges — rendered
 * into a token-capped text map. It carries NO source bodies (only paths, symbol
 * names + one-line signatures, and module specifiers), so the persisted artifact
 * is privacy-safe by construction.
 *
 * This module is generated HOST-SIDE (where node_modules + the WASM Tree-sitter
 * grammars exist) and the read-only container consumes the JSON artifact — the
 * runtime never parses source. See ADR 0007 for why.
 */

/** What a top-level symbol is. Mirrors the Tree-sitter declaration node kinds we
 *  surface; keep this list small — it is the map's vocabulary, not the AST's. */
export type RepoSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable';

/** One top-level symbol. `signature` is the declaration HEAD only (up to the
 *  body `{` / initializer `=` / line end), capped — never a body. */
export interface RepoSymbol {
  name: string;
  kind: RepoSymbolKind;
  exported: boolean;
  signature: string;
  line: number;
}

/** One source file's structure. `imports` are raw module specifiers
 *  (`'./foo'`, `'react'`), not resolved paths. No file body is retained. */
export interface RepoFile {
  /** Path relative to the project root, POSIX-separated. */
  path: string;
  /** Source-file mtime captured host-side with the structure. Optional for
   *  backward compatibility with older/uploaded repo-map artifacts. */
  mtimeMs?: number;
  symbols: RepoSymbol[];
  imports: string[];
}

/** The structural facts a parser extracts from one file's source text. */
export interface FileStructure {
  symbols: RepoSymbol[];
  imports: string[];
}

/** A parse function: source text + relative path -> structure. Injected into
 *  {@link generateRepoMap} so the file walk/render/ranking is testable without
 *  the WASM parser, and so other languages can plug in later. Async results
 *  support lazy parser initialization on the first cache miss. */
export type ParseFile = (
  source: string,
  path: string
) => FileStructure | Promise<FileStructure>;

/** Fatal parser-construction failure, distinct from one unparseable file. */
export class RepoMapParserInitializationError extends Error {
  constructor(cause: unknown) {
    super('repo-map parser initialization failed', { cause });
    this.name = 'RepoMapParserInitializationError';
  }
}

/** The generated map. `text` is the rendered, token-budgeted map; the structured
 *  `files` back it. `generatedAtGitSha` is the staleness stamp (ADR 0007) — the
 *  sha the map was generated against, so consumers can badge a stale map.
 *  Caching/invalidation against it is #893's job; this only records it. */
export interface RepoMap {
  /** Absolute project root the map was generated for. */
  root: string;
  /** Git sha (or other signature) the map was generated against, or null. */
  generatedAtGitSha: string | null;
  /**
   * Normalized `owner/repo` slug of the root's Git remote (#2709), derived
   * deterministically by the producer beside `generatedAtGitSha`, or null when
   * the root has no repo/remote. Together with a non-null sha it is the
   * commit-bound identity the docs-map wrapper must match before the #2489
   * detector may make absence claims. Optional for backward compatibility with
   * older/uploaded artifacts (a missing value reads as null → suppression).
   */
  repository?: string | null;
  /** Total source files discovered (before any token-budget truncation). */
  fileCount: number;
  /** Structured per-file index, ranked most-referenced-first. */
  files: RepoFile[];
  /** The compact, token-budgeted text rendering of the map. */
  text: string;
  /** True when the token budget truncated the rendered text/files. */
  truncated: boolean;
}

export interface GenerateRepoMapOptions {
  /** Approximate token ceiling for the rendered `text` map. Default 2000. */
  tokenBudget?: number;
  /** Staleness stamp to record (the caller resolves the git sha). */
  gitSha?: string | null;
  /** Normalized `owner/repo` remote identity to record (#2709); the caller
   *  derives it (see `normalizeGitRemoteUrl` in `../parse-docs-map`). */
  repository?: string | null;
  /** Parser to use. Defaults to the WASM Tree-sitter TS/JS parser; tests inject
   *  a fake so the walk/render is exercised without the grammar. */
  parseFile?: ParseFile;
  /** Hard cap on files walked, a runaway guard for huge roots. Default 4000. */
  maxFiles?: number;
  /** Hard cap on directory entries inspected while discovering source files.
   *  Default 100000. */
  maxDirEntries?: number;
}
