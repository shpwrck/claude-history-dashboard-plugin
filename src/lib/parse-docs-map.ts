/**
 * parse-docs-map.ts — the versioned docs-map contract (#2709, epic #2256).
 *
 * `docs/docs-map.json` is a source-bound declaration: each opted-in repository
 * document names the source files (and the exported symbols inside each file)
 * it claims to cover. A later detector (#2489) may raise "the doc claims a
 * symbol that no longer exists" style absence claims from this map — but only
 * when the map's checkout identity matches exactly one non-truncated repo-map
 * project, so the declaration must be strictly validated and identity-bound
 * before anything trusts it.
 *
 * STRICTNESS CONTRACT: `parseDocsMap` rejects the WHOLE map to `null` on an
 * unknown version or ANY malformed/partial entry. Partial acceptance could
 * fabricate reverse drift (a silently dropped source would read as "the doc
 * never claimed it"), so there is no partially trusted map. An absent map is
 * likewise `null`.
 *
 * This module is PURE and browser-safe (no `node:*` imports), mirroring the
 * `external-guidance.ts` / `parse-external-guidance.ts` split: the bounded
 * on-disk read + Git identity wrap live server-side in `scripts/ingest.mjs`
 * (`readDocsMap`); browser code only ever imports types and pure validators
 * from here.
 */

/** The one docs-map version this parser accepts. */
export const DOCS_MAP_VERSION = 1;

/** Repo-relative location of the declaration — the producer/consumer seam
 *  constant (the `DOC_GIT_TIMES_RELPATH` sibling). Importers (ingest, the
 *  Docker packaging test) derive their paths from THIS value; the parity
 *  fence (`scripts/docs-map-parity.test.mjs`) fails CI on a re-hardcoded
 *  literal so the seam cannot silently drift. */
export const DOCS_MAP_RELPATH = 'docs/docs-map.json';

/** Reader-side cap on `docs/docs-map.json` bytes (enforced by the bounded
 *  server-side read; an over-cap file rejects the whole map). */
export const DOCS_MAP_MAX_FILE_BYTES = 256 * 1024;
/** Maximum opted-in documents per map. */
export const DOCS_MAP_MAX_DOCUMENTS = 128;
/** Maximum source bindings per document. */
export const DOCS_MAP_MAX_SOURCES_PER_DOCUMENT = 32;
/** Maximum symbols bound to one source path. */
export const DOCS_MAP_MAX_SYMBOLS_PER_SOURCE = 64;
/** Maximum characters in a document or source path. */
export const DOCS_MAP_MAX_PATH_CHARS = 512;
/** Maximum characters in a symbol name. */
export const DOCS_MAP_MAX_SYMBOL_CHARS = 256;
/** Maximum characters in the `owner/repo` slug (GitHub: 39 + 1 + 100). */
export const DOCS_MAP_MAX_REPOSITORY_CHARS = 140;

/** One source binding: symbols are ALWAYS bound to one source path. An empty
 *  `symbols` array is a file-level binding (the doc describes the file as a
 *  whole without naming symbols). */
export interface DocsMapSource {
  /** Repo-relative normalized POSIX path of the described source file. */
  path: string;
  /** Exported symbol names the document claims to describe in `path`. */
  symbols: string[];
}

/** One opted-in document's declared coverage. */
export interface DocsMapDocument {
  sources: DocsMapSource[];
}

/** The validated v1 docs-map declaration. Never partial: every entry passed
 *  the full strict validation or the map as a whole was rejected. */
export interface DocsMap {
  version: typeof DOCS_MAP_VERSION;
  /** Declared `owner/repo` slug the map belongs to. */
  repository: string;
  /** Document path -> declared source bindings. Keys are unique, normalized
   *  repo-relative POSIX paths. */
  documents: Record<string, DocsMapDocument>;
}

/**
 * The ingest-produced wrapper carried on the dataset key `docsMap`: the parsed
 * map plus the identity of the checkout that actually supplied the JSON. The
 * #2489 detector may make absence claims only against exactly one
 * non-truncated repo-map project whose `repository` identity and commit BOTH
 * match this wrapper; missing (`null`) identity fields suppress absence
 * claims. Matching never depends on whether a declared source path exists.
 */
export interface DocsMapArtifact {
  map: DocsMap;
  /** Normalized lowercase `owner/repo` slug of the supplying checkout's Git
   *  remote, or `null` when underivable (no repo / no remote / gitless
   *  runtime without a configured locator). Always matches the declared
   *  `map.repository` case-folded — a mismatch rejects the whole wrapper. */
  repository: string | null;
  /** Clean full-length lowercase HEAD commit of the supplying checkout (or
   *  the runtime image's full-sha build stamp when the runtime has no Git);
   *  `null` when the tree's docs-map file is dirty or the commit is unknown —
   *  both suppress later absence claims. */
  commit: string | null;
}

const REPOSITORY_SLUG_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Zero-width, word-joiner, bidi-embedding/override, and BOM format characters:
// invisible in review yet identity-changing for a path or symbol - reject.
const INVISIBLE_CHARS_RE = /[\u200b-\u200d\u2060\u202a-\u202e\ufeff]/;
const WHITESPACE_RE = /\s/;
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;

/** Whether `value` is a valid `owner/repo` slug (the memory-lifecycle-schema
 *  issue-close grammar's repo shape, bounded). `.`/`..` repo names and a
 *  `.git` suffix are rejected — the derived side (normalizeGitRemoteUrl)
 *  can never produce them, so accepting them declared-side would create
 *  slugs that structurally cannot match any checkout identity. Validation is
 *  case-tolerant; COMPARISONS between declared and derived identity always
 *  case-fold (GitHub slugs are case-insensitive). */
export function isRepositorySlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DOCS_MAP_MAX_REPOSITORY_CHARS &&
    REPOSITORY_SLUG_RE.test(value) &&
    !/\/\.{1,2}$/.test(value) &&
    !/\.git$/i.test(value)
  );
}

/**
 * Whether `value` is a normalized repo-relative POSIX path: non-empty, capped,
 * forward slashes only, no absolute/drive/tilde prefix, and no empty, `.`,
 * `..`, or `__proto__` segments. Traversal and absolute paths are rejected
 * outright rather than normalized — the map declares paths exactly as the
 * repo-map artifact records them, so normalization here would hide drift.
 */
export function isNormalizedRepoRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > DOCS_MAP_MAX_PATH_CHARS) return false;
  if (CONTROL_CHARS_RE.test(value) || INVISIBLE_CHARS_RE.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith('/') || value.startsWith('~') || DRIVE_PREFIX_RE.test(value)) {
    return false;
  }
  for (const segment of value.split('/')) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment === '__proto__'
    ) {
      return false;
    }
  }
  return true;
}

function isSymbolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DOCS_MAP_MAX_SYMBOL_CHARS &&
    !CONTROL_CHARS_RE.test(value) &&
    !INVISIBLE_CHARS_RE.test(value) &&
    !WHITESPACE_RE.test(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Exact own-key match — unknown keys reject (v2 additions go through a
 *  version bump, never through silently ignored extras). */
function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

/**
 * Strictly parse an unknown JSON value into a {@link DocsMap}. Returns `null`
 * for an absent value, an unknown version, or ANY malformed/partial entry —
 * the whole map is rejected, never a filtered subset. The result is built
 * from fresh objects so callers can serialize it without aliasing the input.
 */
export function parseDocsMap(value: unknown): DocsMap | null {
  const root = asRecord(value);
  if (!root || !hasExactKeys(root, ['version', 'repository', 'documents'])) {
    return null;
  }
  if (root.version !== DOCS_MAP_VERSION) return null;
  if (!isRepositorySlug(root.repository)) return null;
  const documentsRaw = asRecord(root.documents);
  if (!documentsRaw) return null;
  const documentPaths = Object.keys(documentsRaw);
  if (documentPaths.length > DOCS_MAP_MAX_DOCUMENTS) return null;

  const documents: [string, DocsMapDocument][] = [];
  for (const documentPath of documentPaths) {
    if (!isNormalizedRepoRelativePath(documentPath)) return null;
    const documentRaw = asRecord(documentsRaw[documentPath]);
    if (!documentRaw || !hasExactKeys(documentRaw, ['sources'])) return null;
    const sourcesRaw = documentRaw.sources;
    if (
      !Array.isArray(sourcesRaw) ||
      sourcesRaw.length === 0 ||
      sourcesRaw.length > DOCS_MAP_MAX_SOURCES_PER_DOCUMENT
    ) {
      return null;
    }
    const seenSourcePaths = new Set<string>();
    const sources: DocsMapSource[] = [];
    for (const sourceValue of sourcesRaw) {
      const sourceRaw = asRecord(sourceValue);
      if (!sourceRaw || !hasExactKeys(sourceRaw, ['path', 'symbols'])) {
        return null;
      }
      const sourcePath = sourceRaw.path;
      if (!isNormalizedRepoRelativePath(sourcePath)) return null;
      if (seenSourcePaths.has(sourcePath)) return null;
      seenSourcePaths.add(sourcePath);
      const symbolsRaw = sourceRaw.symbols;
      if (
        !Array.isArray(symbolsRaw) ||
        symbolsRaw.length > DOCS_MAP_MAX_SYMBOLS_PER_SOURCE
      ) {
        return null;
      }
      const seenSymbols = new Set<string>();
      const symbols: string[] = [];
      for (const symbolValue of symbolsRaw) {
        if (!isSymbolName(symbolValue)) return null;
        if (seenSymbols.has(symbolValue)) return null;
        seenSymbols.add(symbolValue);
        symbols.push(symbolValue);
      }
      sources.push({ path: sourcePath, symbols });
    }
    documents.push([documentPath, { sources }]);
  }

  return {
    version: DOCS_MAP_VERSION,
    repository: root.repository,
    // Null-prototype output record: fromEntries alone defines own data
    // properties (so "__proto__" cannot mutate a prototype — path validation
    // also rejects that literal segment), but a normal object would still let
    // inherited names like "constructor"/"toString" answer membership lookups
    // from Object.prototype. A null prototype makes every lookup own-key-only.
    documents: Object.assign(
      Object.create(null) as Record<string, DocsMapDocument>,
      Object.fromEntries(documents)
    ),
  };
}

/**
 * Normalize a Git remote URL to its lowercase `owner/repo` slug, or `null`
 * when the URL does not resolve to exactly one two-segment slug. Handles
 * scheme URLs (`https://`, `ssh://`, with optional userinfo) and scp-like
 * remotes (`git@host:owner/repo.git`), matching Git's own reading of a
 * scheme-less `host:path` remote; the scp host token must be at least two
 * characters so a Windows drive prefix (`C:...`) never reads as a remote.
 * The result is CASE-FOLDED to lowercase — GitHub slugs are case-insensitive,
 * so every derived identity compares canonically. Pure string logic — usable
 * by the repo-map producer and the ingest identity wrap alike, so both sides
 * derive the SAME identity.
 */
export function normalizeGitRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || CONTROL_CHARS_RE.test(url) || INVISIBLE_CHARS_RE.test(url)) {
    return null;
  }
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@\s/:]+@)?[^@\s/:]{2,}:(.*)$/.exec(url);
    if (!scp) return null;
    path = scp[1];
  }
  const slug = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  return isRepositorySlug(slug) ? slug : null;
}
