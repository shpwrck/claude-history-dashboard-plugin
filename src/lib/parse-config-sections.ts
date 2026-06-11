/**
 * Markdown-config "explosion" parser (#888, epic #871 repo-map substrate).
 *
 * Markdown config — `AGENTS.md`, `CLAUDE.md`, project `.claude/*`, and the
 * `skills/`, `agents/`, `commands/` `.md` manifests — is read by humans but
 * never broken into addressable, section-level records. Attribution cannot say
 * "config section X governs files Y" because section X has no stable id and no
 * extracted references. This module turns each config document into a list of
 * {@link ConfigSection} records: a stable id, the heading, the governing source
 * scope, an mtime/content hash, and typed references — and NOTHING else.
 *
 * Privacy non-goal (epic #871): the section BODY is never persisted. Only the
 * heading, a structural hash of the body, and extracted references survive. A
 * unit test asserts no body text leaks into the output.
 *
 * Pure by design (matches the repo's `parse-*.ts` convention): the core
 * `parseConfigSections` takes a raw string + source metadata, does no I/O, and
 * is tolerant of any input. The server (the join slice #889) owns the
 * filesystem walk and the `repoMap` dataset wiring; this slice only owns the
 * explosion so the logic is unit-testable off plain strings.
 *
 * Stable ids: an id is `<scope>#<heading-slug>` (with a `-2`, `-3` … suffix for
 * repeated headings within a source). It is content-addressed by heading, NOT
 * by line number, so editing a section's body — or inserting a section above —
 * leaves sibling ids unchanged. That stability is what lets #889 join the same
 * section across re-ingests and what the attribution wedge (#892) keys on.
 */

// ── Reference taxonomy ───────────────────────────────────────────────────────

/**
 * The kinds of cross-reference a config section can name. Each kind has an
 * unambiguous syntactic marker so extraction is deterministic and testable:
 *
 * - `import`   — `@path` import directives (e.g. `@AGENTS.md`).
 * - `file`     — path-like tokens (a `/`-bearing or known-config filename).
 * - `command`  — `/slash-command` invocations.
 * - `skill`    — namespaced `plugin:skill` ids (the unambiguous skill form).
 * - `mcp`      — `mcp__server__tool` identifiers.
 * - `configKey`— hook/config keys (`hooks.Stop`, `permissions.allow`, the
 *                lifecycle hook-event names like `SessionStart`).
 */
export type ConfigReferenceKind =
  | 'import'
  | 'file'
  | 'command'
  | 'skill'
  | 'mcp'
  | 'configKey';

/** A single typed reference extracted from a section body. */
export interface ConfigReference {
  kind: ConfigReferenceKind;
  /** The referenced target, verbatim (e.g. `AGENTS.md`, `/burn-epic`, `hooks.Stop`). */
  target: string;
}

/** One section-level config record. Carries NO body text. */
export interface ConfigSection {
  /**
   * Stable id: `<scope>#<heading-slug>` (`-N` suffix for repeated headings).
   * Content-addressed by heading, so it survives body edits.
   */
  id: string;
  /** File/dir the section governs, e.g. `AGENTS.md` or `.claude/skills/foo/SKILL.md`. */
  sourceScope: string;
  /** Heading text (`''` for the pre-heading preamble section). */
  heading: string;
  /** Heading level: 0 for the preamble, 1-6 for `#`..`######`. */
  level: number;
  /** File mtime (ms) when the server supplies it; `null` otherwise. */
  mtime: number | null;
  /** FNV-1a hash of the section text — a change detector, NOT the body. */
  hash: string;
  /** Deduped, sorted typed references found in the section body. */
  references: ConfigReference[];
}

/** Raw input for one config document. The server provides `content` + `mtime`. */
export interface ConfigSource {
  /** The governing scope / relative path, e.g. `CLAUDE.md`. */
  scope: string;
  /** Raw markdown text. */
  content: string;
  /** File mtime in ms, when known. */
  mtime?: number | null;
}

// ── Hashing (no imports: deterministic FNV-1a, browser-safe) ─────────────────

/** FNV-1a 32-bit hash → 8-char hex. Deterministic, dependency-free. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Slugging ─────────────────────────────────────────────────────────────────

function slugify(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return slug || 'section';
}

// ── Frontmatter / fence handling ─────────────────────────────────────────────

const FRONTMATTER_RE = /^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n?/;

/** Strip a single leading YAML frontmatter block (skill/agent/command manifests). */
function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, '');
}

/** True for a ```` ``` ```` / `~~~` code-fence toggle line. */
function fenceToggle(line: string): string | null {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  return m ? m[1][0] : null;
}

// ── Reference extraction ─────────────────────────────────────────────────────

/** Known config roots whose dotted keys count as `configKey` references. */
const CONFIG_KEY_ROOTS = [
  'hooks',
  'permissions',
  'settings',
  'env',
  'mcpServers',
  'enabledPlugins',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
];

/**
 * Lifecycle hook-event names that are `configKey` references on their own.
 * Only the camelCase-distinctive events are listed — the bare common words
 * `Stop` and `Notification` are deliberately excluded so ordinary prose
 * ("please Stop", "send a Notification") never becomes a reference. Those two
 * are still captured in their precise dotted form (`hooks.Stop`) by
 * {@link RE_CONFIG_KEY}.
 */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PreCompact',
];

/** Filenames that are config references even without a directory component. */
const BARE_CONFIG_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'REFERENCES.md',
  'settings.json',
  'settings.local.json',
];

const RE_IMPORT = /(?:^|[\s(])@([\w./-]+\.[\w]+|[\w./-]*\/[\w./-]+)/g;
// A slash-command is a single `/name` token NOT followed by another `/`, so an
// absolute path like `/etc/passwd` is not mistaken for the command `/etc`.
const RE_COMMAND = /(?:^|[\s(`])\/([a-z][\w-]*)(?!\/)/g;
// Namespaced `plugin:skill` form. The plugin (left) side must itself be
// hyphenated (`compound-engineering`, `feature-dev`) — every plugin id in this
// ecosystem is — which keeps ordinary `word:word` prose (`also:see`, `foo:bar`)
// out of the skill reference set.
const RE_SKILL = /(?:^|[\s(`])([a-z][\w-]*-[\w-]*:[a-z][\w-]+)/g;
const RE_MCP = /\bmcp__[a-z0-9_]+(?:__[a-z0-9_]+)*/gi;
// Path-like token: at least one `/` and a file extension, e.g. `src/lib/x.ts`.
const RE_PATH = /(?:^|[\s(`'"])([\w@.-]+(?:\/[\w@.-]+)+\.[\w]+)/g;
const RE_CONFIG_KEY = new RegExp(
  `\\b(?:${CONFIG_KEY_ROOTS.join('|')})(?:\\.[\\w*]+)+`,
  'g',
);
const RE_HOOK_EVENT = new RegExp(`\\b(?:${HOOK_EVENTS.join('|')})\\b`, 'g');

/**
 * Extract typed references from already-fence-stripped section text. Fenced
 * code blocks are removed by the caller so example shell/code doesn't pollute
 * the reference set. Results are deduped (by kind+target) and sorted.
 */
function extractReferences(text: string): ConfigReference[] {
  const seen = new Set<string>();
  const out: ConfigReference[] = [];
  const add = (kind: ConfigReferenceKind, target: string) => {
    const key = `${kind} ${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, target });
  };

  for (const m of text.matchAll(RE_IMPORT)) add('import', m[1]);
  for (const m of text.matchAll(RE_SKILL)) add('skill', m[1]);
  for (const m of text.matchAll(RE_COMMAND)) add('command', `/${m[1]}`);
  for (const m of text.matchAll(RE_MCP)) add('mcp', m[0]);
  for (const m of text.matchAll(RE_PATH)) add('file', m[1]);
  for (const f of BARE_CONFIG_FILES) {
    if (new RegExp(`(?:^|[\\s(\`'"])${f.replace('.', '\\.')}\\b`).test(text)) {
      add('file', f);
    }
  }
  for (const m of text.matchAll(RE_CONFIG_KEY)) add('configKey', m[0]);
  for (const m of text.matchAll(RE_HOOK_EVENT)) add('configKey', m[0]);

  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target),
  );
}

// ── Core explosion ───────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  level: number;
  lines: string[];
}

/**
 * Split a markdown document into heading-bounded sections, fence-aware so a
 * `#`-prefixed line inside a code fence is never mistaken for a heading.
 *
 * Known limitation: an UNBALANCED fence (a stray ```` ``` ```` with no closer)
 * runs to EOF, folding every later heading into the open fence — those sections
 * are not split out. This is the deliberate trade for the common, correct case
 * (a `#` comment line inside a legitimate code block). Tracked config files
 * (`AGENTS.md`/`CLAUDE.md`/`SKILL.md`) carry balanced fences; malformed input
 * degrades to fewer records, never a body-text leak (unsplit prose only feeds
 * the hash).
 */
function splitSections(text: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection = { heading: '', level: 0, lines: [] };
  let pushedAny = false;
  let fence: string | null = null;

  for (const line of text.split('\n')) {
    const toggle = fenceToggle(line);
    if (toggle) {
      if (fence === null) fence = toggle;
      else if (fence === toggle) fence = null;
      current.lines.push(line);
      continue;
    }

    const headingMatch = fence === null ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (headingMatch) {
      // Close the previous section. Keep the preamble only if it had content.
      if (pushedAny || current.lines.some((l) => l.trim() !== '')) {
        sections.push(current);
      }
      current = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        lines: [line],
      };
      pushedAny = true;
    } else {
      current.lines.push(line);
    }
  }
  if (pushedAny || current.lines.some((l) => l.trim() !== '')) {
    sections.push(current);
  }
  return sections;
}

/** Remove fenced code blocks from a section's lines before reference scanning. */
function stripFences(lines: string[]): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const toggle = fenceToggle(line);
    if (toggle) {
      if (fence === null) fence = toggle;
      else if (fence === toggle) fence = null;
      continue;
    }
    if (fence === null) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Explode one config document into section-level records. Pure: no I/O, no
 * side effects, tolerant of any input. The body is never returned.
 */
export function parseConfigSections(source: ConfigSource): ConfigSection[] {
  const mtime = source.mtime ?? null;
  const body = stripFrontmatter(source.content ?? '');
  const raw = splitSections(body);

  const baseOf = (sec: RawSection) =>
    sec.level === 0 ? '__preamble__' : slugify(sec.heading);

  // Pass 1: find which base slugs are claimed by more than one DISTINCT heading
  // (e.g. `Hooks!` and `Hooks?` both slug to `hooks`).
  const distinctByBase = new Map<string, Set<string>>();
  for (const sec of raw) {
    const base = baseOf(sec);
    const set = distinctByBase.get(base) ?? new Set<string>();
    set.add(sec.heading);
    distinctByBase.set(base, set);
  }

  // Pass 2: colliding distinct headings disambiguate by a stable hash of the
  // heading TEXT (never by position), so inserting a section above never
  // reassigns a sibling's id. Genuinely identical heading texts still take a
  // positional `-N` suffix (they are otherwise indistinguishable).
  const usedCounts = new Map<string, number>();
  const out: ConfigSection[] = [];

  for (const sec of raw) {
    const sectionText = sec.lines.join('\n');
    const base = baseOf(sec);
    const collides = (distinctByBase.get(base)?.size ?? 0) > 1;
    const candidate = collides ? `${base}-${fnv1a(sec.heading).slice(0, 4)}` : base;
    const n = (usedCounts.get(candidate) ?? 0) + 1;
    usedCounts.set(candidate, n);
    const slug = n === 1 ? candidate : `${candidate}-${n}`;

    out.push({
      id: `${source.scope}#${slug}`,
      sourceScope: source.scope,
      heading: sec.heading,
      level: sec.level,
      mtime,
      hash: fnv1a(sectionText),
      references: extractReferences(stripFences(sec.lines)),
    });
  }
  return out;
}

/**
 * Explode a set of config documents and return all section records, sorted by
 * source scope then id for a stable, join-friendly ordering.
 */
export function parseConfigSet(sources: ConfigSource[]): ConfigSection[] {
  const all = (sources ?? []).flatMap(parseConfigSections);
  return all.sort(
    (a, b) =>
      a.sourceScope.localeCompare(b.sourceScope) || a.id.localeCompare(b.id),
  );
}

/** Total reference count across a set of sections (for headline KPIs / #889). */
export function countConfigReferences(sections: ConfigSection[]): number {
  return sections.reduce((n, s) => n + s.references.length, 0);
}
