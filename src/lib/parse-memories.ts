/**
 * Parser for per-project agent memories (#458).
 *
 * Agents persist one fact per file at `~/.claude/projects/<slug>/memory/*.md`
 * with YAML-ish frontmatter (`name`, `description`, `metadata.type`) followed by
 * the fact body. The server (`GET /api/memories`, in `scripts/server.mjs`) does
 * the filesystem walk and returns the RAW markdown per file; this module owns
 * the frontmatter parsing so the logic is unit-testable off a plain string,
 * matching the repo's `parse-*.ts` convention.
 *
 * Tolerant by design: a file with missing/partial frontmatter never throws —
 * `name` falls back to the filename and `type` to `'other'`.
 */

/** Allowed memory categories, plus `'other'` for missing/unknown types. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'other';

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'user',
  'feedback',
  'project',
  'reference',
]);

/** One parsed memory fact. */
export interface AgentMemory {
  /** Frontmatter `name`, or the filename (sans `.md`) when absent. */
  name: string;
  /** Frontmatter `description`; empty string when absent. */
  description: string;
  /** Frontmatter `metadata.type`, normalized; `'other'` when missing/unknown. */
  type: MemoryType;
  /** The markdown body after the frontmatter block (trimmed). */
  body: string;
  /** Source filename, e.g. `groom-means-stop-at-submit.md`. */
  file: string;
}

/** Memories for one project, grouped under its on-disk slug. */
export interface ProjectMemories {
  /** The `~/.claude/projects/<slug>` directory name. */
  project: string;
  memories: AgentMemory[];
}

/**
 * One parsed pointer line from a project's `MEMORY.md` index. The convention
 * (see the global CLAUDE.md memory contract) is one markdown list link per
 * memory: `- [Title](file.md) — hook`. Lines that don't match that shape are
 * skipped, so prose/section headings in the index never become entries.
 */
export interface MemoryIndexEntry {
  /** The link text, e.g. `Burn loop: verify CI green before finishing`. */
  title: string;
  /** The linked memory file, e.g. `burn-loop-verify-ci-green.md`. */
  file: string;
  /** The trailing hook/summary after the em-dash (or hyphen); `''` when absent. */
  hook: string;
  /** The raw index line, verbatim (trimmed). */
  raw: string;
}

/**
 * A project's full memory store: the parsed fact files (frontmatter + body)
 * PLUS the `MEMORY.md` index (#1965). Separating the store from the index is the
 * foundation the memory-hygiene detector (#1779) needs — e.g. to spot an index
 * pointer with no backing file, or a fact file the index never references.
 */
export interface ProjectMemoryStore {
  /** The `~/.claude/projects/<slug>` directory name. */
  project: string;
  /** Parsed fact files (every `*.md` except the `MEMORY.md` index). */
  memories: AgentMemory[];
  /** Parsed `MEMORY.md` pointer lines; empty when no index file was present. */
  index: MemoryIndexEntry[];
  /** Raw `MEMORY.md` body text when present, else `''` (the as-written index). */
  indexRaw: string;
}

/** Raw, unparsed shape returned by `GET /api/memories`. */
export interface RawMemoryFile {
  name: string;
  content: string;
}
export interface RawProjectMemories {
  slug: string;
  files: RawMemoryFile[];
}
export interface MemoriesResponse {
  projects: RawProjectMemories[];
}

const FRONTMATTER_RE = /^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

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

function normalizeType(raw: string | undefined): MemoryType {
  const t = (raw ?? '').trim().toLowerCase();
  return KNOWN_TYPES.has(t) ? (t as MemoryType) : 'other';
}

/** Parse a single memory file's raw text into an {@link AgentMemory}. */
export function parseMemoryFile(file: RawMemoryFile): AgentMemory {
  const fallbackName = file.name.replace(/\.md$/i, '');
  const m = file.content.match(FRONTMATTER_RE);
  if (!m) {
    // No frontmatter block — treat the whole file as body, fall back on name.
    return {
      name: fallbackName,
      description: '',
      type: 'other',
      body: file.content.trim(),
      file: file.name,
    };
  }
  const [, frontmatter, body] = m;

  let name = '';
  let description = '';
  let type: string | undefined;
  for (const line of frontmatter.split('\n')) {
    let mm: RegExpMatchArray | null;
    if ((mm = line.match(/^name:\s*(.+)$/))) name = stripQuotes(mm[1]);
    else if ((mm = line.match(/^description:\s*(.+)$/)))
      description = stripQuotes(mm[1]);
    // `type:` may be top-level or nested under `metadata:` (indented). Take the
    // first occurrence either way.
    else if (type === undefined && (mm = line.match(/^\s*type:\s*(.+)$/)))
      type = stripQuotes(mm[1]);
  }

  return {
    name: name || fallbackName,
    description,
    type: normalizeType(type),
    body: body.trim(),
    file: file.name,
  };
}

/**
 * Parse the raw `/api/memories` response into project-grouped memories.
 * Projects are sorted by slug; within each, memories are sorted by name.
 * Projects whose `memory/` dir held no parseable files are dropped.
 *
 * The `MEMORY.md` index is NOT a fact file, so it is excluded here — the server
 * read now includes it (#1990, so {@link buildMemoryStores} can light up the
 * #1779 memory-hygiene detector), but the Memories *view* still shows only
 * facts. Index hygiene is the detector's concern, not a memory card.
 */
export function parseMemories(resp: MemoriesResponse | null | undefined): ProjectMemories[] {
  const projects = resp?.projects ?? [];
  const out: ProjectMemories[] = [];
  for (const p of projects) {
    const memories = (p.files ?? [])
      .filter((f) => !isIndexFile(f.name))
      .map(parseMemoryFile)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (memories.length > 0) {
      out.push({ project: p.slug, memories });
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}

/** Total memory count across all projects (for headline KPIs). */
export function countMemories(grouped: ProjectMemories[]): number {
  return grouped.reduce((n, p) => n + p.memories.length, 0);
}

export { projectPathToSlug, memoriesMatchProject } from './project-slug';

/** Is this the per-project memory index file (case-insensitive)? */
function isIndexFile(name: string): boolean {
  return name.toLowerCase() === 'memory.md';
}

const INDEX_LINE_RE =
  /^[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/;

/**
 * Parse a `MEMORY.md` index body into its pointer lines. Only markdown
 * list-link lines (`- [Title](file.md) — hook`) become entries; headings and
 * prose are ignored. Tolerant: a malformed line is simply skipped.
 */
export function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(INDEX_LINE_RE);
    if (!m) continue;
    out.push({
      title: m[1].trim(),
      file: m[2].trim(),
      hook: (m[3] ?? '').trim(),
      raw: line,
    });
  }
  return out;
}

/**
 * Build the per-project memory STORE + INDEX (#1965) from the raw
 * `/api/memories` response — the foundation the #1779 memory-hygiene detector
 * reads off {@link RecommendationInput.memoryStores}.
 *
 * For each project it splits the `MEMORY.md` index out from the fact files,
 * parses each fact file's frontmatter+body via {@link parseMemoryFile}, and
 * parses the index body into pointer lines. Tolerant by design: a project with
 * no index yields `index: []` / `indexRaw: ''`; a project with only an index and
 * no fact files yields `memories: []`. Projects whose `memory/` dir held nothing
 * parseable at all (no facts and no index) are dropped, mirroring
 * {@link parseMemories}. Projects are sorted by slug; facts by name.
 *
 * NOTE: the live server (`readMemories` in `scripts/server.mjs`) currently
 * EXCLUDES `MEMORY.md` from `/api/memories`, so over the live response `index`
 * is empty until that read is widened — exercised here over a fixture store.
 */
export function buildMemoryStores(
  resp: MemoriesResponse | null | undefined
): ProjectMemoryStore[] {
  const projects = resp?.projects ?? [];
  const out: ProjectMemoryStore[] = [];
  for (const p of projects) {
    const files = p.files ?? [];
    const indexFile = files.find((f) => isIndexFile(f.name));
    const memories = files
      .filter((f) => !isIndexFile(f.name))
      .map(parseMemoryFile)
      .sort((a, b) => a.name.localeCompare(b.name));
    const indexRaw = indexFile ? indexFile.content.trim() : '';
    const index = indexRaw ? parseMemoryIndex(indexRaw) : [];
    if (memories.length === 0 && index.length === 0 && indexRaw === '') {
      continue;
    }
    out.push({ project: p.slug, memories, index, indexRaw });
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}
