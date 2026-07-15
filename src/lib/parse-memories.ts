/**
 * Parser for per-project agent memories (#458).
 *
 * Agents persist one fact per file in the root `memory/*.md` or fixed-depth
 * `memory/archive/*.md` surface, with main/archive index files alongside them.
 * Facts may carry YAML-ish frontmatter (`name`, `description`, `metadata.type`)
 * followed by the body. The server (`GET /api/memories`) returns raw markdown;
 * this module owns parsing so the logic is unit-testable off plain strings.
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
  /**
   * File last-modified time in epoch ms (#2495), from the server's `fs.stat`
   * at walk time. `undefined` when the payload carried no `mtimeMs` — the SPA
   * upload path and older cached payloads — so age-derived signals (#2235/#2244)
   * can degrade cleanly rather than assume the field is present.
   */
  lastModifiedMs?: number;
}

/** Memories for one project, grouped under its on-disk slug. */
export interface ProjectMemories {
  /** The `~/.claude/projects/<slug>` directory name. */
  project: string;
  memories: AgentMemory[];
}

/**
 * One parsed pointer line from `MEMORY.md` or `archive/ARCHIVE.md`. The
 * convention is one markdown list link per memory: `- [Title](file.md) — hook`.
 * Lines that don't match are skipped, so prose/headings never become entries.
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
 * A project's full fixed-depth memory store: parsed root/archive facts plus the
 * main and archive indexes. Separating facts from both index surfaces lets the
 * memory-hygiene detector audit dangling pointers and unindexed files.
 */
export interface ProjectMemoryStore {
  /** The `~/.claude/projects/<slug>` directory name. */
  project: string;
  /** Parsed root/archive fact files, excluding both index files. */
  memories: AgentMemory[];
  /** Parsed `MEMORY.md` pointer lines; empty when no index file was present. */
  index: MemoryIndexEntry[];
  /** Raw `MEMORY.md` body text when present, else `''` (the as-written index). */
  indexRaw: string;
  /** Whether `MEMORY.md` was observed, including an empty index file. */
  indexPresent: boolean;
  /** Parsed `archive/ARCHIVE.md` pointers, canonicalized from the memory root. */
  archiveIndex: MemoryIndexEntry[];
  /** Raw `archive/ARCHIVE.md` body, or `''` when absent/empty. */
  archiveIndexRaw: string;
  /** Whether `archive/ARCHIVE.md` was observed, including an empty index file. */
  archiveIndexPresent: boolean;
  /** Which absence claims this bounded filesystem read can support. */
  readCompleteness: MemoryReadCompleteness;
}

/** Completeness of the three independently bounded memory-store surfaces. */
export interface MemoryReadCompleteness {
  /** All selected root and `archive/` fact files were enumerated and read. */
  facts: boolean;
  /** The main `MEMORY.md` index was conclusively read or observed absent. */
  mainIndex: boolean;
  /** `archive/ARCHIVE.md` was conclusively read or observed absent. */
  archiveIndex: boolean;
}

/** Raw, unparsed shape returned by `GET /api/memories`. */
export interface RawMemoryFile {
  name: string;
  content: string;
  /**
   * File last-modified time in epoch ms (#2495), set by the server walk's
   * `fs.stat`. Optional: absent on the SPA upload path and in older cached
   * payloads, so consumers must tolerate its absence.
   */
  mtimeMs?: number;
}
export interface RawProjectMemories {
  slug: string;
  files: RawMemoryFile[];
  /** Optional for older API/upload fixtures; omission cannot prove absence. */
  readCompleteness?: MemoryReadCompleteness;
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
  const fallbackName = (file.name.split('/').pop() ?? file.name).replace(/\.md$/i, '');
  const m = file.content.match(FRONTMATTER_RE);
  if (!m) {
    // No frontmatter block — treat the whole file as body, fall back on name.
    return {
      name: fallbackName,
      description: '',
      type: 'other',
      body: file.content.trim(),
      file: file.name,
      lastModifiedMs: file.mtimeMs,
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
    lastModifiedMs: file.mtimeMs,
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
  const normalized = name.replace(/\\/g, '/').toLowerCase();
  return normalized === 'memory.md' || normalized === 'archive/archive.md';
}

const INDEX_LINE_RE =
  /^[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/;

/**
 * Parse a `MEMORY.md` index body into its pointer lines. Only markdown
 * list-link lines (`- [Title](file.md) — hook`) become entries; headings and
 * prose are ignored. Tolerant: a malformed line is simply skipped.
 */
function canonicalIndexTarget(target: string, indexPath: string): string {
  const trimmed = target.trim();
  // External/absolute/traversing targets are not local facts. Preserve them as
  // written so completeness-aware dangling checks can report them without ever
  // laundering them into a valid memory-root path.
  if (
    /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(trimmed) ||
    trimmed.split(/[\\/]/).includes('..')
  ) {
    return trimmed;
  }
  const local = trimmed.replace(/^\.\//, '');
  if (local.replace(/\\/g, '/').toLowerCase() === 'archive/archive.md') {
    return 'archive/ARCHIVE.md';
  }
  if (indexPath.toLowerCase() !== 'archive/archive.md') return local;
  if (local.startsWith('archive/')) return local;
  // Only direct archive children are in the fixed-depth reader. A nested path
  // remains unmatched instead of being rewritten under archive/.
  if (local.includes('/')) return trimmed;
  return `archive/${local}`;
}

export function parseMemoryIndex(
  content: string,
  indexPath = 'MEMORY.md'
): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(INDEX_LINE_RE);
    if (!m) continue;
    out.push({
      title: m[1].trim(),
      file: canonicalIndexTarget(m[2], indexPath),
      hook: (m[3] ?? '').trim(),
      raw: line,
    });
  }
  return out;
}

/**
 * Build the per-project memory store + indexes (#1965/#2558) from the raw
 * `/api/memories` response — the foundation the #1779 memory-hygiene detector
 * reads off {@link RecommendationInput.memoryStores}.
 *
 * For each project it splits `MEMORY.md` and `archive/ARCHIVE.md` from the fact
 * files, parses fact frontmatter/bodies, and canonicalizes pointer paths from
 * both index bodies. Missing indexes yield empty arrays/raw strings; index-only
 * projects retain `memories: []`. Completely empty projects are dropped.
 * Projects are sorted by slug; facts by name.
 *
 * The live server and ingest readers supply canonical root-relative paths for
 * the main index, direct fact files, and the fixed-depth `archive/` tier.
 */
export function buildMemoryStores(
  resp: MemoriesResponse | null | undefined
): ProjectMemoryStore[] {
  const projects = resp?.projects ?? [];
  const out: ProjectMemoryStore[] = [];
  for (const p of projects) {
    const files = p.files ?? [];
    const indexFile = files.find((f) => f.name.toLowerCase() === 'memory.md');
    const archiveIndexFile = files.find(
      (f) => f.name.replace(/\\/g, '/').toLowerCase() === 'archive/archive.md'
    );
    const memories = files
      .filter((f) => !isIndexFile(f.name))
      .map(parseMemoryFile)
      .sort((a, b) => a.name.localeCompare(b.name));
    const indexRaw = indexFile ? indexFile.content.trim() : '';
    const index = indexRaw ? parseMemoryIndex(indexRaw) : [];
    const archiveIndexRaw = archiveIndexFile
      ? archiveIndexFile.content.trim()
      : '';
    const archiveIndex = archiveIndexRaw
      ? parseMemoryIndex(archiveIndexRaw, 'archive/ARCHIVE.md')
      : [];
    if (
      memories.length === 0 &&
      !indexFile &&
      !archiveIndexFile
    ) {
      continue;
    }
    out.push({
      project: p.slug,
      memories,
      index,
      indexRaw,
      indexPresent: Boolean(indexFile),
      archiveIndex,
      archiveIndexRaw,
      archiveIndexPresent: Boolean(archiveIndexFile),
      readCompleteness: p.readCompleteness ?? {
        facts: false,
        mainIndex: false,
        archiveIndex: false,
      },
    });
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}
