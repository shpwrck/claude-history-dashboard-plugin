import type { HistoryEntry } from '../types';

export type SearchMatchType = 'full-text' | 'semantic' | 'hybrid';
export type SearchMode = 'fts' | 'hybrid';

export interface HybridSearchResult {
  entry: HistoryEntry;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  matchType: SearchMatchType;
  snippet: string;
}

export interface HybridSearchResponse {
  mode: SearchMode;
  semanticAvailable: boolean;
  results: HybridSearchResult[];
}

interface SearchOptions {
  project?: string | null;
  limit?: number;
  semanticEnabled?: boolean;
}

const DEFAULT_LIMIT = 100;
const SEMANTIC_THRESHOLD = 0.12;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'with',
]);

const CONCEPTS: Record<string, string[]> = {
  auth_access: [
    'auth',
    'authentication',
    'oauth',
    'login',
    'credential',
    'token',
    'session',
    'csrf',
    'permission',
    'access',
  ],
  cost_usage: [
    'budget',
    'cap',
    'cost',
    'limit',
    'plan',
    'price',
    'quota',
    'spend',
    'token',
    'usage',
  ],
  debug_failure: [
    'bug',
    'crash',
    'error',
    'exception',
    'fail',
    'failure',
    'fix',
    'regression',
    'stack',
    'timeout',
  ],
  deploy_ops: [
    'container',
    'deploy',
    'docker',
    'image',
    'kubernetes',
    'podman',
    'publish',
    'release',
    'rollout',
    'service',
  ],
  responsive_ui: [
    'mobile',
    'narrow',
    'overflow',
    'responsive',
    'table',
    'viewport',
    'width',
  ],
  search_retrieval: [
    'embed',
    'embedding',
    'find',
    'fts',
    'lookup',
    'query',
    'retrieval',
    'search',
    'semantic',
  ],
};

const TERM_TO_CONCEPT = new Map<string, string>();
for (const [concept, terms] of Object.entries(CONCEPTS)) {
  for (const term of terms) TERM_TO_CONCEPT.set(normalizeToken(term), concept);
}

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(?:ing|ed|es|s)$/u, '');
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function entryText(entry: HistoryEntry, cap: number): string {
  // Accumulate up to `cap` chars without ever concatenating an oversized
  // piece whole — slicing each piece to the remaining room is what keeps the
  // MAX_INDEXED_TEXT_CHARS "transient allocations" promise true for
  // multi-megabyte pasted attachments.
  const parts: string[] = [];
  let len = 0;
  const push = (s: string | undefined | null) => {
    if (!s || len >= cap) return;
    const room = cap - len;
    const piece = s.length > room ? s.slice(0, room) : s;
    parts.push(piece);
    len += piece.length + 1; // +1 for the join separator
  };
  push(entry.title);
  push(entry.display);
  for (const p of Object.values(entry.pastedContents ?? {})) push(p.content);
  return parts.join('\n');
}

/**
 * Documented per-entry cap on indexed text (#3129). entryText concatenates the
 * title, display text, and every pasted attachment; pasted content can be
 * arbitrarily large, and every indexed character is scanned per query. 16 KiB
 * of text is far beyond a realistic typed prompt while bounding both the
 * per-query scan cost and the transient allocations for any single entry.
 * Matches that occur only beyond the cap inside oversized pasted content are
 * intentionally not found.
 */
export const MAX_INDEXED_TEXT_CHARS = 16_384;

/** One searchable entry with its precomputed (and lazily memoized) index data. */
export interface IndexedSearchEntry {
  entry: HistoryEntry;
  /** Original-case text capped at MAX_INDEXED_TEXT_CHARS (snippet source). */
  text: string;
  /** Lowercased capped text for the lexical scan — computed once per dataset. */
  lowerText: string;
  /**
   * Semantic vector, computed lazily on the first semantic query and memoized
   * for the lifetime of the index (the fts-only path never pays for it).
   */
  vector: Map<string, number> | null;
  /** Position in the searchable ordering — the stable ranking tie-break. */
  index: number;
}

// One search index per entries array (#3129), keyed by array identity: the
// client passes a useMemo'd array that only changes when the dataset does, and
// the server passes the entries of a dataset object cached per contentHash —
// both reuse the index across queries and rebuild only on a genuinely new
// dataset. WeakMap keeps dropped datasets collectable.
const searchIndexCache = new WeakMap<
  readonly HistoryEntry[],
  IndexedSearchEntry[]
>();

/**
 * Build — or fetch the cached — per-dataset search index. Exported so tests
 * can prove cache identity and the per-entry text bound directly.
 */
export function getSearchIndex(
  entries: readonly HistoryEntry[]
): IndexedSearchEntry[] {
  const cached = searchIndexCache.get(entries);
  if (cached) return cached;
  const built: IndexedSearchEntry[] = [];
  for (const entry of entries) {
    if (entry.display === 'init' || entry.display === 'exit') continue;
    const text = entryText(entry, MAX_INDEXED_TEXT_CHARS);
    built.push({
      entry,
      text,
      lowerText: text.toLowerCase(),
      vector: null,
      index: built.length,
    });
  }
  searchIndexCache.set(entries, built);
  return built;
}

function addWeight(vector: Map<string, number>, key: string, weight: number) {
  vector.set(key, (vector.get(key) ?? 0) + weight);
}

export function embedSearchText(text: string): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokenize(text)) {
    addWeight(vector, `tok:${token}`, 1);
    const concept = TERM_TO_CONCEPT.get(token);
    if (concept) addWeight(vector, `concept:${concept}`, 2.25);
  }
  return vector;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of a.values()) aNorm += value * value;
  for (const value of b.values()) bNorm += value * value;
  for (const [key, value] of a) dot += value * (b.get(key) ?? 0);
  if (aNorm <= 0 || bNorm <= 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}

function lexicalScore(
  lowerText: string,
  lowerQuery: string,
  queryTokens: readonly string[]
): number {
  if (!lowerQuery) return 0;
  const exact = lowerText.includes(lowerQuery) ? 0.75 : 0;
  if (queryTokens.length === 0) return exact;
  let overlap = 0;
  for (const token of queryTokens) {
    if (lowerText.includes(token)) overlap += 1;
  }
  return Math.min(1, exact + overlap / queryTokens.length);
}

function snippetFor(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  const q = query.trim().toLowerCase();
  const idx = q ? lower.indexOf(q) : -1;
  const start = idx >= 0 ? Math.max(0, idx - 80) : 0;
  const end = Math.min(clean.length, start + 220);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < clean.length ? '...' : '';
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

function matchType(lexical: number, semantic: number): SearchMatchType {
  const hasLexical = lexical > 0;
  const hasSemantic = semantic >= SEMANTIC_THRESHOLD;
  if (hasLexical && hasSemantic) return 'hybrid';
  if (hasSemantic) return 'semantic';
  return 'full-text';
}

interface ScoredMatch {
  indexed: IndexedSearchEntry;
  score: number;
  lexicalScore: number;
  semanticScore: number;
}

/** Score-descending, then index-ascending — the original sort's comparator. */
function ranksBefore(a: ScoredMatch, b: ScoredMatch): boolean {
  if (a.score !== b.score) return a.score > b.score;
  return a.indexed.index < b.indexed.index;
}

/**
 * Insert a match into a bounded top-K list (#3129). Keeps at most `k` matches
 * ordered by {@link ranksBefore}, so the full match set is never materialized
 * or sorted; a match that cannot rank is rejected with one comparison.
 */
function insertTopK(top: ScoredMatch[], match: ScoredMatch, k: number): void {
  if (top.length >= k && !ranksBefore(match, top[top.length - 1])) return;
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranksBefore(match, top[mid])) hi = mid;
    else lo = mid + 1;
  }
  top.splice(lo, 0, match);
  if (top.length > k) top.pop();
}

export function hybridSearchEntries(
  entries: readonly HistoryEntry[],
  query: string,
  options: SearchOptions = {}
): HybridSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const semanticEnabled = options.semanticEnabled ?? true;
  const queryVector = semanticEnabled ? embedSearchText(trimmed) : null;
  const lowerQuery = trimmed.toLowerCase();
  const queryTokens = tokenize(lowerQuery);

  // #3129: per-query work is one pass over the cached index — no per-query
  // text concatenation, lowercasing, tokenizing, or full-result sort.
  const index = getSearchIndex(entries);
  const top: ScoredMatch[] = [];
  for (const indexed of index) {
    if (options.project && indexed.entry.project !== options.project) continue;
    const lexical = lexicalScore(indexed.lowerText, lowerQuery, queryTokens);
    let semantic = 0;
    if (queryVector) {
      indexed.vector ??= embedSearchText(indexed.text);
      semantic = cosineSimilarity(queryVector, indexed.vector);
    }
    const matched = queryVector
      ? lexical > 0 || semantic >= SEMANTIC_THRESHOLD
      : lexical > 0;
    if (!matched) continue;
    insertTopK(
      top,
      {
        indexed,
        score: lexical * 0.68 + semantic * 0.32,
        lexicalScore: lexical,
        semanticScore: semantic,
      },
      limit
    );
  }

  // Snippets are built only for the returned top K, not for every match.
  return top.map((match) => ({
    entry: match.indexed.entry,
    score: match.score,
    lexicalScore: match.lexicalScore,
    semanticScore: match.semanticScore,
    matchType: matchType(match.lexicalScore, match.semanticScore),
    snippet: snippetFor(match.indexed.text, trimmed),
  }));
}
