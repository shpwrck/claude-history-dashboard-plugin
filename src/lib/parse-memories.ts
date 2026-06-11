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
 */
export function parseMemories(resp: MemoriesResponse | null | undefined): ProjectMemories[] {
  const projects = resp?.projects ?? [];
  const out: ProjectMemories[] = [];
  for (const p of projects) {
    const memories = (p.files ?? [])
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
