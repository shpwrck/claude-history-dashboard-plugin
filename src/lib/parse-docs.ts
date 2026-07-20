/**
 * parse-docs.ts — Build a SCIP-style graph over the repository's own Markdown
 * docs (#2257, keystone of the doc-artifact-hygiene epic #2256).
 *
 * This is the doc-graph analogue of `parse-memories.ts`: where that module owns
 * the per-project agent-memory store the #1779 memory-hygiene detector reads,
 * this one owns the per-repo DOC store the doc-hygiene detector reads
 * off `RecommendationInput.docGraph`. It mirrors parse-memories' philosophy —
 * dependency-free, hand-rolled frontmatter/link extraction (regex + string ops,
 * NO yaml/markdown/remark deps), tolerant of malformed input (a bad file is
 * skipped, never thrown) — but adds the on-disk walk itself so it is a pure
 * function over a root path.
 *
 * The graph is intentionally SCIP-shaped (nodes + typed edges) so a hygiene
 * detector can ask graph questions: which doc links dangle, which declared
 * index rows point at a file that no longer exists, which ADR ordinals are
 * missing. The three "partial indices" the repo already maintains by hand —
 * `REFERENCES.md`'s parser table, `competitive-analysis/README.md`'s tracker
 * table, and the numeric ADR sequence — are recognised as *declared index
 * nodes* (`indexKind` / `ordinal`), so the detector can diff declared-vs-derived.
 *
 * SERVER-ONLY: uses node:fs / node:path / node:child_process — never import the
 * runtime {@link buildDocGraph} into browser code. Only the TYPES flow into the
 * browser-bundled engine, via `import type` in `detectors/types.ts` (fully
 * erased under `verbatimModuleSyntax`), exactly like `parse-tasks`/`parse-teams`.
 * The walk is invoked from `scripts/ingest.mjs` (see `readDocGraph`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import {
  DOC_GIT_TIMES_EXPECTED_COMMIT_ENV,
  DOC_GIT_TIMES_MAX_FILE_BYTES,
  DOC_GIT_TIMES_RELPATH,
  parseDocGitTimesManifest,
  type DocTimeProvenance,
} from './doc-git-times';
import type { DocCategory } from './doc-contract';

export type { DocTimeProvenance } from './doc-git-times';
/**
 * Coarse doc category, derived purely from a doc's directory (never its
 * contents). The vocabulary itself now lives in the browser-safe
 * `doc-contract` module (#2472) so the bundled doc-hygiene detector can consume
 * it at runtime; re-exported here so existing `parse-docs` importers are
 * unaffected.
 */
export type { DocCategory } from './doc-contract';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Which hand-maintained partial index a node participates in, so the hygiene
 * detector can diff a declared index against what actually exists on disk:
 *  - `references`         — `REFERENCES.md`, whose parser-table rows declare
 *                           `src/lib/parse-*.ts` files (emitted as src-ref edges).
 *  - `competitive-tracker`— `competitive-analysis/README.md`, whose tracker
 *                           rows declare per-competitor `*.md` files (md-link edges).
 *  - `adr-sequence`       — an ADR file, a member of the numeric `NNNN-…`
 *                           ordering (its position is on {@link DocNode.ordinal}).
 */
export type DocIndexKind = 'references' | 'competitive-tracker' | 'adr-sequence';

/** Flat `key: value` frontmatter map (empty when a doc has no frontmatter). */
export type DocFrontmatter = Record<string, string>;

/** One doc in the graph. `slug` is the stable string node id. */
export interface DocNode {
  /** Stable string id: the repo-relative POSIX path without its `.md` suffix. */
  slug: string;
  /** Repo-relative POSIX path, e.g. `docs/adr/0001-squash-merge.md`. */
  path: string;
  /** Category derived from the directory (never from contents). */
  category: DocCategory;
  /** Parsed frontmatter, flattened to `key -> value`; `{}` when absent. */
  frontmatter: DocFrontmatter;
  /** ATX heading texts in document order (fenced-code headings excluded). */
  headings: string[];
  /**
   * Last git commit time (ISO 8601) for this file, or — when no Git history is
   * reachable (no repo, shallow checkout, untracked file, no valid packaged
   * manifest) — the filesystem mtime; `null` if neither is available. This is
   * the doc's "as-of" clock. Check {@link DocNode.gitMtimeProvenance} before
   * treating it as Git history: a `filesystem` value inside the production
   * image is just the Docker COPY time.
   */
  gitMtimeIso: string | null;
  /**
   * How `gitMtimeIso` was derived (#2707): `git` (live non-shallow history) >
   * `manifest` (valid commit-bound packaged manifest) > `filesystem` (stat
   * mtime — never authoritative) > `unavailable` (`gitMtimeIso` is null).
   * Always set by {@link buildDocGraph}; optional only so older serialized
   * graphs remain type-valid — an ABSENT provenance must be treated exactly
   * like `filesystem`/`unavailable` (never as Git history), so a stale
   * deserialized node can never pass an authoritative-freshness check.
   */
  gitMtimeProvenance?: DocTimeProvenance;
  /** Set when this doc is a declared partial index (see {@link DocIndexKind}). */
  indexKind?: DocIndexKind;
  /** Numeric ordinal for an ADR (`0007-…` -> 7); only set for `adr-sequence`. */
  ordinal?: number;
}

/** Edge kind: a resolved doc-to-doc link, a `#NNNN` issue ref, or a `src/…` ref. */
export type DocEdgeKind = 'md-link' | 'issue-ref' | 'src-ref';

/**
 * A directed edge out of a doc. `from` is always a node slug. `to` is:
 *  - `md-link`  — the resolved target doc slug (may dangle: a hygiene signal).
 *  - `issue-ref`— `issue:<n>` (a pseudo-id; issues are not doc nodes).
 *  - `src-ref`  — `src:<path>` (a pseudo-id; source files are not doc nodes).
 */
export interface DocEdge {
  from: string;
  to: string;
  kind: DocEdgeKind;
}

/** The SCIP-style doc graph: source root + sorted nodes and de-duplicated edges. */
export interface DocGraph {
  /** Resolved absolute root whose docs were walked (the repo-map join key). */
  root: string;
  nodes: DocNode[];
  edges: DocEdge[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Directory names never descended into during the walk. */
const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.worktrees',
  '.git',
]);

/** Skip a single doc larger than this (defensive; real docs are tiny). */
export const DOC_GRAPH_MAX_FILE_BYTES = 512 * 1024;
/** Hard cap on files walked, so a pathological tree can never hang ingest.
 *  Exported for the producer/consumer parity fence (doc-git-times-parity):
 *  the manifest entry cap and producer file cap must stay lock-step with it. */
export const DOC_GRAPH_DEFAULT_MAX_FILES = 5000;
const DOC_GRAPH_GIT_MAX_COMMITS = 4096;
const DOC_GRAPH_GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Exported for the parity fence: the producer must query the SAME surface. */
export const DOC_GRAPH_GIT_PATHS = [
  ':(glob)*.md',
  ':(glob)docs/**/*.md',
] as const;

export interface BuildDocGraphOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  /**
   * Packaged git-times manifest location (#2707); defaults to
   * `<root>/data/doc-git-times.json` ({@link DOC_GIT_TIMES_RELPATH}).
   */
  docGitTimesPath?: string;
  /**
   * Full commit to bind the packaged manifest against. Defaults to
   * `CHD_DOC_GIT_TIMES_EXPECTED_COMMIT` then the baked `GIT_SHA` env. Without
   * a value the manifest is rejected (fail closed), never trusted unbound.
   */
  docGitTimesExpectedCommit?: string | null;
}

// ── Pure extraction helpers (unit-tested off strings) ─────────────────────────

const FRONTMATTER_RE = /^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const FRONTMATTER_LINE_RE = /^\s*([A-Za-z0-9_.$-]+):\s*(.+)$/;
const TOP_LEVEL_CATEGORY_LINE_RE = /^category:\s*(.*)$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Remove a YAML inline comment from the tiny scalar grammar used by
 * `category:`. A `#` starts a comment only outside quotes and after whitespace
 * (or at the beginning), matching the ordinary YAML separation rule. Hashes
 * inside quoted values remain part of the value.
 */
function stripYamlInlineComment(s: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const char = s[i];
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && s[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

/**
 * Split a doc into its parsed frontmatter map and its body. Tolerant: a doc
 * with no `---` fenced frontmatter yields `{ frontmatter: {}, body: content }`.
 * Frontmatter is parsed line-by-line into a flat `key -> value` map. Nested
 * keys are flattened to their leaf key, last-wins, except for the product
 * contract's `category` field: only an unindented, top-level `category:` is
 * retained, including an explicitly empty value. That keeps nested metadata
 * from accidentally opting a document into declared-category checks without
 * dragging in a YAML dependency.
 */
export function parseFrontmatter(content: string): {
  frontmatter: DocFrontmatter;
  body: string;
} {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: content };
  const [, block, body] = m;
  const frontmatter: DocFrontmatter = {};
  for (const line of block.split('\n')) {
    const category = line.match(TOP_LEVEL_CATEGORY_LINE_RE);
    if (category) {
      frontmatter.category = stripQuotes(stripYamlInlineComment(category[1]));
      continue;
    }
    const mm = line.match(FRONTMATTER_LINE_RE);
    if (!mm) continue;
    const key = mm[1].trim();
    if (key === 'category') continue;
    frontmatter[key] = stripQuotes(mm[2]);
  }
  return { frontmatter, body };
}

/**
 * ATX heading texts in document order. Lines inside fenced code blocks
 * (``` / ~~~) are skipped so a `# comment` in a shell snippet is not a heading.
 */
export function extractHeadings(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) out.push(h[2].trim());
  }
  return out;
}

/** Raw link targets from `[text](target)` markdown links, in order. */
export function extractMarkdownLinkTargets(content: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    let target = m[1];
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    }
    out.push(target);
  }
  return out;
}

/**
 * Resolve a raw markdown link target from the doc at `fromPath` to the target
 * doc's slug, or `null` when it is not a relative `.md` link (external URL,
 * anchor-only, mailto, or a non-markdown asset). Anchors (`file.md#section`)
 * are stripped before resolution; `./`, `../`, and same-dir targets all resolve.
 */
export function resolveDocLink(fromPath: string, target: string): string | null {
  const t = target.trim();
  if (!t || t.startsWith('#')) return null; // anchor-only / empty
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) return null; // scheme / protocol-relative
  const noAnchor = t.split('#')[0].split('?')[0];
  if (!/\.md$/i.test(noAnchor)) return null; // only doc-to-doc links
  const fromDir = posix.dirname(toPosix(fromPath));
  const resolved = posix.normalize(posix.join(fromDir, noAnchor));
  if (resolved.startsWith('..')) return null; // escapes the doc root — ignore
  return slugForPath(resolved);
}

/** `#NNNN` GitHub issue numbers, de-duplicated in first-seen order. */
export function extractIssueRefs(content: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const re = /(?<![\w&])#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** `src/…` source-file references (path with extension), de-duplicated. */
export function extractSrcRefs(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\bsrc\/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const p = m[0];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Repo-relative POSIX path with the `.md` suffix removed — the stable slug. */
export function slugForPath(relPath: string): string {
  return toPosix(relPath).replace(/\.md$/i, '');
}

/**
 * Derive a {@link DocCategory} from a repo-relative path, purely by directory:
 * repo-root markdown is `root`; a file directly under `docs/` is `doc`; each
 * recognised `docs/<sub>/…` subtree maps to its bucket; anything else is `other`.
 */
export function deriveCategory(relPath: string): DocCategory {
  const parts = toPosix(relPath).split('/').filter(Boolean);
  if (parts.length <= 1) return 'root';
  if (parts[0] !== 'docs') return 'other';
  if (parts.length === 2) return 'doc'; // docs/<file>.md
  switch (parts[1]) {
    case 'adr':
      return 'adr';
    case 'audits':
      return 'audit';
    case 'competitive':
    case 'competitive-analysis':
      return 'competitive';
    case 'plans':
      return 'plan';
    case 'experiments':
      return 'experiment';
    case 'product':
      return 'product';
    case 'reviews':
      return 'review';
    case 'backlog':
      return 'backlog';
    case 'perf-sprint':
      return 'perf';
    default:
      return 'doc';
  }
}

/**
 * Classify a node as a declared partial index, if it is one of the three the
 * repo maintains by hand. Returns the {@link DocIndexKind} plus an ADR ordinal
 * where applicable, or `null` for an ordinary doc.
 */
export function classifyIndex(
  slug: string,
  category: DocCategory
): { indexKind: DocIndexKind; ordinal?: number } | null {
  if (slug === 'REFERENCES') return { indexKind: 'references' };
  if (/(^|\/)competitive(-analysis)?\/README$/i.test(slug)) {
    return { indexKind: 'competitive-tracker' };
  }
  if (category === 'adr') {
    const base = slug.split('/').pop() ?? '';
    const m = base.match(/^(\d+)-/);
    if (m) return { indexKind: 'adr-sequence', ordinal: Number(m[1]) };
    return { indexKind: 'adr-sequence' };
  }
  return null;
}

// ── On-disk walk ──────────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * Collect the repo-relative POSIX paths of every doc to index under `root`:
 * repo-root `*.md` plus everything under `docs/**`, skipping {@link EXCLUDE_DIRS}
 * and capping the total. Deterministic (sorted) so the graph is stable.
 */
export function docGraphSourcePaths(
  root: string,
  opts: Pick<BuildDocGraphOptions, 'maxFiles'> = {}
): string[] {
  const maxFiles = opts.maxFiles ?? DOC_GRAPH_DEFAULT_MAX_FILES;
  const found: string[] = [];
  const walk = (absDir: string, relDir: string, isRoot: boolean): void => {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw
    }
    for (const ent of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxFiles) return;
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // Top level: only descend into docs/ (the rest of the repo is not docs).
        if (isRoot && ent.name !== 'docs') continue;
        walk(join(absDir, ent.name), rel, false);
      } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        found.push(rel);
      }
    }
  };
  walk(root, '', true);
  return found.sort();
}

/**
 * Resolve the newest commit touching each current doc path with ONE git child
 * process. `git log --name-only -z` emits commits newest-first, so the first
 * occurrence of a path owns its last-commit timestamp. A marker prefixes the
 * pretty-format record so filenames cannot be mistaken for dates. The pathspecs
 * are relative to `git -C root` (and `--relative` keeps emitted names on that
 * same surface), so an overridden root nested inside a larger repository does
 * not accidentally query the repository top level.
 *
 * Both history depth and captured stdout are capped. If a partial clone, timeout,
 * or output cap terminates the walk after Git has emitted newer commits, Node's
 * child-process error retains that partial stdout; parse it instead of dropping
 * every valid mtime and making the whole graph fall back to checkout mtimes.
 */
function partialGitStdout(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string') return stdout;
  if (stdout instanceof Uint8Array) return Buffer.from(stdout).toString('utf8');
  return '';
}

/**
 * Whether live `git log` history under `root` may be trusted as authoritative
 * (#2707). A SHALLOW checkout grafts old files onto the shallow-boundary
 * commit, so its per-path "last commit" times are fabrications — exactly the
 * failure this issue removes. Returns:
 *  - `'ok'`          — a real, non-shallow repository; history is trustworthy.
 *  - `'shallow'`     — shallow checkout; live history must NOT be used.
 *  - `'unavailable'` — not a git repo / git missing; live history cannot run.
 */
export function gitHistoryAvailability(
  root: string
): 'ok' | 'shallow' | 'unavailable' {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--is-shallow-repository'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    ).trim();
    if (out === 'false') return 'ok';
    if (out === 'true') return 'shallow';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function gitMtimesByPath(
  root: string,
  relPaths: readonly string[]
): Map<string, string> {
  const mtimes = new Map<string, string>();
  if (relPaths.length === 0) return mtimes;
  let output: string;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        root,
        'log',
        `--max-count=${DOC_GRAPH_GIT_MAX_COMMITS}`,
        '--format=CHD-DATE:%cI%x00',
        '--name-only',
        '-z',
        '--relative',
        '--',
        ...DOC_GRAPH_GIT_PATHS,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000,
        maxBuffer: DOC_GRAPH_GIT_MAX_OUTPUT_BYTES,
        // This is promised as a LOCAL walk (see ingest's readDocGraph): never
        // hydrate a partial/treeless clone over the network. If git then fails,
        // the normal failure path falls through to manifest/filesystem tiers.
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      }
    );
  } catch (error) {
    output = partialGitStdout(error);
  }
  const wanted = new Set(relPaths);
  let commitTime: string | null = null;
  for (const raw of output.split('\0')) {
    if (raw.startsWith('CHD-DATE:')) {
      commitTime = raw.slice('CHD-DATE:'.length).trim();
      continue;
    }
    const path = raw.replace(/^\n+/, '');
    if (commitTime && wanted.has(path) && !mtimes.has(path)) {
      mtimes.set(path, commitTime);
    }
  }
  return mtimes;
}

/**
 * Bounded fingerprint for the Git history that supplies node `gitMtimeIso`.
 * A doc can move from untracked to committed without changing its working-tree
 * bytes or stat metadata, so dataset cache keys must cover this separately.
 */
export function docGraphGitHistorySignature(root: string): string {
  try {
    return (
      execFileSync(
        'git',
        ['-C', root, 'log', '-1', '--format=%H', '--', ...DOC_GRAPH_GIT_PATHS],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
      ).trim() || 'none'
    );
  } catch {
    return 'none';
  }
}

/**
 * Server-side bounded read + fail-closed validation of the packaged git-times
 * manifest (#2707). Returns the per-path time map, or `null` when the manifest
 * is missing, oversized, unparseable, unbound, or fails ANY strictness check in
 * {@link parseDocGitTimesManifest} — a rejected manifest contributes nothing.
 */
function readDocGitTimes(
  root: string,
  opts: Pick<BuildDocGraphOptions, 'docGitTimesPath' | 'docGitTimesExpectedCommit'>
): Map<string, string> | null {
  const path = opts.docGitTimesPath ?? join(root, DOC_GIT_TIMES_RELPATH);
  // `||` (not `??`): a SET-BUT-EMPTY env var means "unset" here — compose files
  // export empty stamps (e.g. `GIT_SHA: ${GIT_SHA:-}`), and an empty override
  // must fall through to the next source instead of silently unbinding the
  // manifest with no diagnostic.
  const expectedCommit =
    opts.docGitTimesExpectedCommit !== undefined
      ? opts.docGitTimesExpectedCommit
      : (process.env[DOC_GIT_TIMES_EXPECTED_COMMIT_ENV] ||
         process.env.GIT_SHA ||
         null);
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > DOC_GIT_TIMES_MAX_FILE_BYTES) return null;
    const parsed = parseDocGitTimesManifest(
      JSON.parse(readFileSync(path, 'utf8')),
      { expectedCommit }
    );
    return parsed.ok ? parsed.times : null;
  } catch {
    return null; // absent/unreadable/malformed JSON — fail closed
  }
}

/**
 * The provenance ladder (#2707): live non-shallow git history, then the valid
 * commit-bound manifest, then the filesystem mtime (present but NEVER
 * authoritative), then nothing.
 */
function deriveDocTime(
  root: string,
  relPath: string,
  gitMtimes: ReadonlyMap<string, string>,
  manifestTimes: ReadonlyMap<string, string> | null
): { gitMtimeIso: string | null; gitMtimeProvenance: DocTimeProvenance } {
  const gitMtime = gitMtimes.get(relPath);
  if (gitMtime) return { gitMtimeIso: gitMtime, gitMtimeProvenance: 'git' };
  const manifestTime = manifestTimes?.get(relPath);
  if (manifestTime) {
    return { gitMtimeIso: manifestTime, gitMtimeProvenance: 'manifest' };
  }
  try {
    return {
      gitMtimeIso: statSync(join(root, relPath)).mtime.toISOString(),
      gitMtimeProvenance: 'filesystem',
    };
  } catch {
    return { gitMtimeIso: null, gitMtimeProvenance: 'unavailable' };
  }
}

/**
 * Build the doc graph for the repository rooted at `root`. Pure over the root
 * path: reads repo-root `*.md` + `docs/**`, hand-extracts frontmatter, headings
 * and edges (md-link / issue-ref / src-ref), and recognises the declared
 * partial indices. Tolerant by design — an unreadable/oversized file is skipped,
 * never thrown — and returns a root-tagged empty graph for a missing/empty
 * root, mirroring {@link buildMemoryStores}' empty-input contract.
 */
export function buildDocGraph(
  root: string,
  opts: BuildDocGraphOptions = {}
): DocGraph {
  const resolvedRoot = resolve(root);
  const maxFileBytes = opts.maxFileBytes ?? DOC_GRAPH_MAX_FILE_BYTES;
  const maxFiles = opts.maxFiles ?? DOC_GRAPH_DEFAULT_MAX_FILES;
  const relPaths = docGraphSourcePaths(resolvedRoot, { maxFiles });
  // #2707: a shallow checkout's per-path history is fabricated (files graft
  // onto the boundary commit), so live git times are used only when the repo
  // provably has full history; otherwise fall through to the packaged manifest.
  const gitMtimes =
    gitHistoryAvailability(resolvedRoot) === 'ok'
      ? gitMtimesByPath(resolvedRoot, relPaths)
      : new Map<string, string>();
  const manifestTimes = readDocGitTimes(resolvedRoot, opts);

  const nodes: DocNode[] = [];
  const edgeKeys = new Set<string>();
  const edges: DocEdge[] = [];

  const addEdge = (from: string, to: string, kind: DocEdgeKind): void => {
    const key = `${from} ${to} ${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };

  for (const rel of relPaths) {
    let content: string;
    try {
      const st = statSync(join(resolvedRoot, rel));
      if (!st.isFile() || st.size > maxFileBytes) continue;
      content = readFileSync(join(resolvedRoot, rel), 'utf8');
    } catch {
      continue; // unreadable — skip
    }

    const slug = slugForPath(rel);
    const category = deriveCategory(rel);
    const { frontmatter, body } = parseFrontmatter(content);
    const { gitMtimeIso, gitMtimeProvenance } = deriveDocTime(
      resolvedRoot,
      rel,
      gitMtimes,
      manifestTimes
    );
    const node: DocNode = {
      slug,
      path: toPosix(rel),
      category,
      frontmatter,
      headings: extractHeadings(body),
      gitMtimeIso,
      gitMtimeProvenance,
    };
    const idx = classifyIndex(slug, category);
    if (idx) {
      node.indexKind = idx.indexKind;
      if (idx.ordinal !== undefined) node.ordinal = idx.ordinal;
    }
    nodes.push(node);

    // Edges. md-links resolve against the whole file (links can appear in
    // tables, so this also captures the competitive-tracker rows); issue/src
    // refs are scanned over the whole file too (REFERENCES.md's parser table
    // rows become src-ref declarations this way).
    for (const target of extractMarkdownLinkTargets(content)) {
      const to = resolveDocLink(rel, target);
      if (to) addEdge(slug, to, 'md-link');
    }
    for (const n of extractIssueRefs(content)) {
      addEdge(slug, `issue:${n}`, 'issue-ref');
    }
    for (const p of extractSrcRefs(content)) {
      addEdge(slug, `src:${p}`, 'src-ref');
    }
  }

  nodes.sort((a, b) => a.slug.localeCompare(b.slug));
  edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.kind.localeCompare(b.kind) ||
      a.to.localeCompare(b.to)
  );
  return { root: resolvedRoot, nodes, edges };
}
