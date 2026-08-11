import { readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  GenerateRepoMapOptions,
  ParseFile,
  RepoFile,
  RepoMap,
  RepoSymbol,
} from './types';
import { RepoMapParserInitializationError } from './types';
import { createTsParseFile } from './parser';
import {
  classifyParserResult,
  normalizeFileStructure,
} from './parser-output';
import { readDirentsBoundedSync } from '../bounded-fs';
import { redactSecrets } from '../secret-redaction';

/**
 * Repo Map generator (#887 / ADR 0007). Walks a project root, extracts each
 * source file's structure via the injected {@link ParseFile}, ranks files by how
 * often they are imported, and renders a compact, token-budgeted text map.
 *
 * HOST-ONLY (reads the live filesystem). It carries NO source bodies and no
 * source literals — only paths, symbol names + one-line signatures with literal
 * values masked, and module specifiers — so the artifact a caller persists is
 * privacy-safe by construction.
 */

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.worktrees',
  '.next',
  '.turbo',
  'out',
  'vendor',
]);
const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_DIR_ENTRIES = 100_000;
/** A file bigger than this is almost certainly generated/minified — skip it so
 *  one bundle can't dominate the parse time or the map. */
const MAX_FILE_BYTES = 512 * 1024;

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** Recursively collect source-file absolute paths under `root`, skipping ignored
 *  directories, dotfiles, oversize files, and bailing at the configured file and
 *  directory-entry caps. */
function walkSourceFiles(
  root: string,
  maxFiles: number,
  maxDirEntries: number
): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  let inspectedDirEntries = 0;
  while (
    stack.length > 0 &&
    found.length < maxFiles &&
    inspectedDirEntries < maxDirEntries
  ) {
    const dir = stack.pop() as string;
    const entries = readDirentsBoundedSync(
      dir,
      maxDirEntries - inspectedDirEntries
    ).sort((a, b) => a.name.localeCompare(b.name));
    inspectedDirEntries += entries.length;
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const name = entry.name;
      if (name.startsWith('.')) continue; // dotfiles/dotdirs
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) stack.push(full);
      } else if (entry.isFile() && SOURCE_EXT.has(extOf(name))) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

/** POSIX-relative path, stable across platforms for the artifact. */
function relPosix(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** ~4 chars per token — the same coarse estimate the rest of the dashboard uses
 *  for budgeting; exact tokenisation is not worth the dependency here. */
function estimateTokensFromCharacters(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

/** Rank files most-referenced-first: a file imported by many others is more
 *  load-bearing, so it should survive token-budget truncation. In-degree is
 *  approximated by matching each file's import specifiers against the basenames
 *  of the known files (the map is structural, not a module resolver). */
function rankByInDegree(files: RepoFile[]): RepoFile[] {
  const byStem = new Map<string, number>();
  const stemOf = (p: string): string => p.replace(/\.[^./]+$/, '');
  for (const f of files) byStem.set(stemOf(f.path), 0);

  for (const f of files) {
    const importedTargets = new Set<string>();
    for (const spec of f.imports) {
      if (!spec.startsWith('.')) continue; // only intra-repo edges count
      // Resolve the relative spec against the importer's dir, loosely.
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const joined = normalizeRel(dir, spec);
      for (const cand of [joined, `${joined}/index`]) {
        if (byStem.has(cand)) {
          // Different specifier spellings (for example `./target` and
          // `./target.ts`) can resolve to the same file. In-degree measures
          // distinct importing files, so one importer contributes at most one
          // edge to a resolved target.
          importedTargets.add(cand);
          break;
        }
      }
    }
    for (const target of importedTargets) {
      byStem.set(target, (byStem.get(target) as number) + 1);
    }
  }

  return [...files].sort((a, b) => {
    const da = byStem.get(stemOf(a.path)) ?? 0;
    const db = byStem.get(stemOf(b.path)) ?? 0;
    if (db !== da) return db - da;
    return a.path.localeCompare(b.path);
  });
}

/** Minimal POSIX `dir` + `./rel` join with `.`/`..` resolution, no fs. */
function normalizeRel(dir: string, spec: string): string {
  const parts = (dir ? dir.split('/') : []).concat(spec.replace(/\.[^./]+$/, '').split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** SHAPE-based scrub of the ONE field that carries author-written source text
 *  into the artifact (#3168). A second net, NOT the literal mask.
 *
 *  Be precise about what this does and does not cover, because the difference is
 *  a privacy boundary. {@link redactSecrets} matches secret SHAPES — an API key,
 *  a JWT, a bearer token, a home path, a long hex run. It catches those wherever
 *  a signature came from, including a per-file cache entry or an injected
 *  `parseFile`, neither of which is re-parsed here, and it covers the persisted
 *  JSON and the rendered text in one pass. What it CANNOT do is remove an
 *  arbitrary literal: `function f(key = 'pw-secret')` has no secret shape, and
 *  recovering it would need an AST and a known language — both gone by here.
 *
 *  Literal masking is therefore the PARSER's job, stated as a contract on
 *  {@link ParseFile}. TypeScript's parser satisfies it structurally, and no
 *  shipped configuration depends on this function for literal safety: both
 *  callers (`scripts/repo-map-generate.mjs`, `scripts/repo-map-gate.mjs`) use
 *  `createTsParseFile`, the former behind a cache whose reuse is salted with
 *  `REPO_MAP_OUTPUT.version`. {@link assertSanitizedSignature} surfaces a
 *  violation in dev so a future non-TS parser fails loudly rather than quietly.
 *
 *  Only `signature` is scrubbed: `name` and `imports` are structural identifiers
 *  the map's ranking and joins depend on, and a repo-relative path such as
 *  `src/home/index.ts` would trip the redactor's home-path pattern. */
function redactSymbols(symbols: RepoSymbol[], path: string): RepoSymbol[] {
  return symbols.map((s) => {
    if (!s.signature) return s;
    assertSanitizedSignature(s.signature, s.name, path);
    return { ...s, signature: redactSecrets(s.signature) };
  });
}

const warnedContractViolations = new Set<string>();

/** Dev-only check that a signature honoured the {@link ParseFile} privacy
 *  contract, warning once per distinct offending signature.
 *
 *  The testable proxy for "literals were masked" is that no literal DELIMITER
 *  survives: masking a literal removes its quotes along with its node, and the
 *  TS path additionally cuts the head at any delimiter left by an unterminated
 *  literal, so `signatureOf` provably never emits `'`, `"` or a backtick — nor
 *  does {@link redactSecrets}, whose replacements are all bracketed words. A
 *  surviving delimiter therefore means an upstream parser skipped literal
 *  masking.
 *
 *  It WARNS rather than masks, deliberately. Quote-stripping an unknown
 *  language's signature would corrupt structure where quotes are structural and
 *  would still miss unquoted literals, leaving the seam asserting a completeness
 *  it cannot deliver — the failure mode this whole change exists to remove. The
 *  repairable defect is in the parser, so that is where the message points.
 *
 *  The message names the symbol and file but NEVER echoes the signature: the
 *  unmasked literal is the thing being reported, and reprinting it would leak it
 *  into logs — the same mistake in a different sink. */
function assertSanitizedSignature(signature: string, name: string, path: string): void {
  if (process.env.NODE_ENV === 'production') return;
  if (!/['"`]/.test(signature)) return;
  const key = `${path}:${name}`;
  if (warnedContractViolations.has(key)) return;
  warnedContractViolations.add(key);
  console.warn(
    `repo-map: signature for ${name} in ${path} retains a literal delimiter, so its ` +
      'parser did not mask literals (ParseFile privacy contract, #3168). An arbitrary ' +
      'literal cannot be removed at the generator seam; fix the parser.'
  );
}

/** Render one file's block: path, then its exported symbols (signatures) first,
 *  then a compact import list. Bodies never appear, and signatures reaching here
 *  have already been through {@link redactSymbols}. */
function renderFile(f: RepoFile): string {
  const lines: string[] = [f.path];
  const exported = f.symbols.filter((s) => s.exported);
  const local = f.symbols.filter((s) => !s.exported);
  // The signature is the declaration head (e.g. `function add(...): number`),
  // so prefixing `export` reproduces the source line — no redundant kind/name.
  for (const s of exported) lines.push(`  export ${s.signature}`);
  // Local symbols are listed by name only — they orient without bloating the map.
  if (local.length > 0) lines.push(`  local: ${local.map((s) => s.name).join(', ')}`);
  if (f.imports.length > 0) lines.push(`  imports: ${f.imports.join(', ')}`);
  return lines.join('\n');
}

/** Render the ranked files into a text map bounded by `tokenBudget`. Stops
 *  adding files once the budget is exceeded and reports truncation. */
export function renderRepoMap(
  rankedFiles: RepoFile[],
  tokenBudget: number
): { text: string; included: RepoFile[]; truncated: boolean } {
  const blockSeparator = '\n\n';
  const blocks: string[] = [];
  const included: RepoFile[] = [];
  let renderedLength = 0;
  let truncated = false;
  for (const f of rankedFiles) {
    const block = renderFile(f);
    const nextLength =
      renderedLength + (blocks.length === 0 ? 0 : blockSeparator.length) + block.length;
    if (estimateTokensFromCharacters(nextLength) > tokenBudget && included.length > 0) {
      truncated = true;
      break;
    }
    blocks.push(block);
    included.push(f);
    renderedLength = nextLength;
  }
  return { text: blocks.join(blockSeparator), included, truncated };
}

/**
 * Generate the Repo Map for a project root. `opts.parseFile` defaults to the
 * WASM Tree-sitter TS/JS parser; tests inject a fake to exercise the walk,
 * ranking, and render without the grammar.
 */
export async function generateRepoMap(
  root: string,
  opts: GenerateRepoMapOptions = {}
): Promise<RepoMap> {
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxFiles = normalizeNonNegativeInt(opts.maxFiles, DEFAULT_MAX_FILES);
  const maxDirEntries = normalizeNonNegativeInt(
    opts.maxDirEntries,
    DEFAULT_MAX_DIR_ENTRIES
  );
  const parseFile: ParseFile = opts.parseFile ?? (await createTsParseFile());

  const absFiles = walkSourceFiles(root, maxFiles, maxDirEntries);
  const files: RepoFile[] = [];
  for (const abs of absFiles) {
    let source: string;
    let mtimeMs: number;
    try {
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      mtimeMs = stat.mtimeMs;
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let structure;
    try {
      const parserResult = parseFile(source, relPosix(root, abs));
      const classified = classifyParserResult(parserResult);
      if (classified.kind === 'invalid-promise') {
        throw new RepoMapParserInitializationError(classified.cause);
      }
      let parsed: unknown;
      if (classified.kind === 'promise') {
        const settlement = await classified.promise;
        if (!settlement.fulfilled) throw settlement.cause;
        parsed = settlement.value;
      } else {
        parsed = classified.value;
      }
      structure = normalizeFileStructure(parsed);
      // Runtime parser values are untrusted even though ParseFile describes the
      // compile-time contract. Treat a malformed return exactly like a parser
      // throw: skip only this file and keep the rest of the map.
      if (!structure) continue;
    } catch (error) {
      // Missing/incompatible WASM is a producer failure, not an unparseable
      // source file. Preserve the fail-loud behavior the eager parser had so a
      // refresh can never replace a valid artifact with a successful empty map.
      if (error instanceof RepoMapParserInitializationError) throw error;
      continue; // a single unparseable file must not sink the whole map
    }
    files.push({
      path: relPosix(root, abs),
      mtimeMs,
      symbols: redactSymbols(structure.symbols, relPosix(root, abs)),
      // A source file contributes one graph edge per target, not one edge per
      // import/re-export declaration. Parser output intentionally preserves the
      // declarations it sees; normalize at this generator seam so ranking,
      // persisted structure, and rendered maps all share the same distinct,
      // first-seen import list.
      imports: [...new Set(structure.imports)],
    });
  }

  const ranked = rankByInDegree(files);
  // `files` is the FULL structured index (ranked) — downstream joins (#889) need
  // every file's structure. Only the rendered `text` is token-budgeted; a small
  // budget truncates the prompt fragment, never the persisted structure.
  const { text, truncated } = renderRepoMap(ranked, tokenBudget);

  return {
    root,
    generatedAtGitSha: opts.gitSha ?? null,
    repository: opts.repository ?? null,
    fileCount: files.length,
    files: ranked,
    text,
    truncated,
  };
}
