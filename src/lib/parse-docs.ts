/**
 * parse-docs.ts — Build a SCIP-style graph over the repository's own Markdown
 * docs (#2257, keystone of the doc-artifact-hygiene epic #2256).
 *
 * This is the doc-graph analogue of `parse-memories.ts`: where that module owns
 * the per-project agent-memory store the #1779 memory-hygiene detector reads,
 * this one owns the per-repo DOC store a future doc-hygiene detector will read
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
import { join, posix } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Coarse doc category, derived purely from a doc's directory (never its
 * contents). One bucket per top-level docs subtree, plus `root` for repo-root
 * markdown and `other` for anything outside the recognised layout.
 */
export type DocCategory =
  | 'root'
  | 'doc'
  | 'adr'
  | 'audit'
  | 'competitive'
  | 'plan'
  | 'experiment'
  | 'product'
  | 'review'
  | 'backlog'
  | 'perf'
  | 'other';

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
   * Last git commit time (ISO 8601) for this file, or — when the tree is not a
   * git repo / the file is untracked — the filesystem mtime; `null` if neither
   * is available. This is the doc's "as-of" clock for staleness.
   */
  gitMtimeIso: string | null;
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

/** The SCIP-style doc graph: sorted nodes + sorted, de-duplicated edges. */
export interface DocGraph {
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
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
/** Hard cap on files walked, so a pathological tree can never hang ingest. */
const DEFAULT_MAX_FILES = 5000;

export interface BuildDocGraphOptions {
  maxFileBytes?: number;
  maxFiles?: number;
}

// ── Pure extraction helpers (unit-tested off strings) ─────────────────────────

const FRONTMATTER_RE = /^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const FRONTMATTER_LINE_RE = /^\s*([A-Za-z0-9_.$-]+):\s*(.+)$/;

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
 * Split a doc into its parsed frontmatter map and its body. Tolerant: a doc
 * with no `---` fenced frontmatter yields `{ frontmatter: {}, body: content }`.
 * Frontmatter is parsed line-by-line into a flat `key -> value` map (nested
 * keys are flattened to their leaf key, last-wins) — enough for a hygiene
 * graph without dragging in a YAML dependency.
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
    const mm = line.match(FRONTMATTER_LINE_RE);
    if (!mm) continue;
    frontmatter[mm[1].trim()] = stripQuotes(mm[2]);
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
function collectDocPaths(root: string, maxFiles: number): string[] {
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

/** Mutable per-build state for the best-effort git-mtime probe. */
interface GitProbe {
  usable: boolean;
}

/**
 * Best-effort last-commit ISO time for `relPath` under `root`. Tries git once;
 * if git is missing or the tree is not a repo, disables git for the rest of the
 * build and falls back to filesystem mtime. Untracked files (empty git output)
 * also fall back to mtime. `null` only when neither is available. No new deps —
 * `git` via node:child_process, like `scripts/ingest.mjs` already shells out.
 */
function deriveMtimeIso(
  root: string,
  relPath: string,
  probe: GitProbe
): string | null {
  if (probe.usable) {
    try {
      const out = execFileSync(
        'git',
        ['-C', root, 'log', '-1', '--format=%cI', '--', relPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
      ).trim();
      if (out) return out;
    } catch {
      probe.usable = false; // git unavailable / not a repo — stop trying
    }
  }
  try {
    return statSync(join(root, relPath)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Build the doc graph for the repository rooted at `root`. Pure over the root
 * path: reads repo-root `*.md` + `docs/**`, hand-extracts frontmatter, headings
 * and edges (md-link / issue-ref / src-ref), and recognises the declared
 * partial indices. Tolerant by design — an unreadable/oversized file is skipped,
 * never thrown — and returns an empty graph (`{ nodes: [], edges: [] }`) for a
 * missing/empty root, mirroring {@link buildMemoryStores}' empty-input contract.
 */
export function buildDocGraph(
  root: string,
  opts: BuildDocGraphOptions = {}
): DocGraph {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const relPaths = collectDocPaths(root, maxFiles);

  const nodes: DocNode[] = [];
  const edgeKeys = new Set<string>();
  const edges: DocEdge[] = [];
  const probe: GitProbe = { usable: true };

  const addEdge = (from: string, to: string, kind: DocEdgeKind): void => {
    const key = `${from} ${to} ${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };

  for (const rel of relPaths) {
    let content: string;
    try {
      const st = statSync(join(root, rel));
      if (!st.isFile() || st.size > maxFileBytes) continue;
      content = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // unreadable — skip
    }

    const slug = slugForPath(rel);
    const category = deriveCategory(rel);
    const { frontmatter, body } = parseFrontmatter(content);
    const node: DocNode = {
      slug,
      path: toPosix(rel),
      category,
      frontmatter,
      headings: extractHeadings(body),
      gitMtimeIso: deriveMtimeIso(root, rel, probe),
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
  return { nodes, edges };
}
