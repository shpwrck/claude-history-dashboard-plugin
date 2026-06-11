import { readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  GenerateRepoMapOptions,
  ParseFile,
  RepoFile,
  RepoMap,
} from './types';
import { createTsParseFile } from './parser';
import { readDirentsBoundedSync } from '../bounded-fs';

/**
 * Repo Map generator (#887 / ADR 0007). Walks a project root, extracts each
 * source file's structure via the injected {@link ParseFile}, ranks files by how
 * often they are imported, and renders a compact, token-budgeted text map.
 *
 * HOST-ONLY (reads the live filesystem). It carries NO source bodies — only
 * paths, symbol names + one-line signatures, and module specifiers — so the
 * artifact a caller persists is privacy-safe by construction.
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
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    for (const spec of f.imports) {
      if (!spec.startsWith('.')) continue; // only intra-repo edges count
      // Resolve the relative spec against the importer's dir, loosely.
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const joined = normalizeRel(dir, spec);
      for (const cand of [joined, `${joined}/index`]) {
        if (byStem.has(cand)) {
          byStem.set(cand, (byStem.get(cand) as number) + 1);
          break;
        }
      }
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

/** Render one file's block: path, then its exported symbols (signatures) first,
 *  then a compact import list. Bodies never appear. */
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
  const blocks: string[] = [];
  const included: RepoFile[] = [];
  let truncated = false;
  for (const f of rankedFiles) {
    const block = renderFile(f);
    const next = blocks.length === 0 ? block : `${blocks.join('\n\n')}\n\n${block}`;
    if (estimateTokens(next) > tokenBudget && included.length > 0) {
      truncated = true;
      break;
    }
    blocks.push(block);
    included.push(f);
  }
  return { text: blocks.join('\n\n'), included, truncated };
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
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let structure;
    try {
      structure = parseFile(source, relPosix(root, abs));
    } catch {
      continue; // a single unparseable file must not sink the whole map
    }
    files.push({
      path: relPosix(root, abs),
      symbols: structure.symbols,
      imports: structure.imports,
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
    fileCount: files.length,
    files: ranked,
    text,
    truncated,
  };
}
