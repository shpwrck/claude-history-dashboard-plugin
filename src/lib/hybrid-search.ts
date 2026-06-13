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

function entryText(entry: HistoryEntry): string {
  const pasted = Object.values(entry.pastedContents ?? {})
    .map((p) => p.content ?? '')
    .join('\n');
  return [entry.title ?? '', entry.display ?? '', pasted].filter(Boolean).join('\n');
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

function lexicalScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return 0;
  const exact = lowerText.includes(lowerQuery) ? 0.75 : 0;
  const queryTokens = tokenize(lowerQuery);
  if (queryTokens.length === 0) return exact;
  const overlap = queryTokens.filter((token) => lowerText.includes(token)).length;
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

export function hybridSearchEntries(
  entries: readonly HistoryEntry[],
  query: string,
  options: SearchOptions = {}
): HybridSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const semanticEnabled = options.semanticEnabled ?? true;
  const queryVector = semanticEnabled ? embedSearchText(trimmed) : new Map<string, number>();

  return entries
    .filter((entry) => entry.display !== 'init' && entry.display !== 'exit')
    .filter((entry) => !options.project || entry.project === options.project)
    .map((entry, index) => {
      const text = entryText(entry);
      const lexical = lexicalScore(text, trimmed);
      const semantic = semanticEnabled
        ? cosineSimilarity(queryVector, embedSearchText(text))
        : 0;
      const score = lexical * 0.68 + semantic * 0.32;
      return {
        entry,
        score,
        lexicalScore: lexical,
        semanticScore: semantic,
        matchType: matchType(lexical, semantic),
        snippet: snippetFor(text, trimmed),
        index,
      };
    })
    .filter((result) =>
      semanticEnabled
        ? result.lexicalScore > 0 || result.semanticScore >= SEMANTIC_THRESHOLD
        : result.lexicalScore > 0
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((result) => ({
      entry: result.entry,
      score: result.score,
      lexicalScore: result.lexicalScore,
      semanticScore: result.semanticScore,
      matchType: result.matchType,
      snippet: result.snippet,
    }));
}
