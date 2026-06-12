/**
 * External guidance article registry (#1407, epic #656) — the single source of
 * truth for WHICH external documents are ingested and how each one maps onto
 * the recommendation engine.
 *
 * `scripts/ingest-guidance.mjs` imports this registry (via register-ts) to
 * drive its fetches, and the registry<->snapshot coverage test cross-validates
 * every committed snapshot under `data/external-guidance/` against it — so a
 * hand-edit to either side that diverges from the other fails tests instead of
 * being silently reverted by the next ingest run.
 *
 * Fact extraction is per-article (#1407): an article opts into an extractor
 * over its own snapshot content; there is no unconditional global extractor,
 * so a future non-usage-limits article cannot get spurious usage-limit facts
 * stamped from nav/related-article boilerplate.
 */
import type {
  ExternalGuidanceFacts,
  ExternalGuidanceTarget,
} from './external-guidance';

export interface GuidanceArticle {
  /** Snapshot id; also the snapshot's filename stem under data/external-guidance/. */
  id: string;
  /** A source id registered in {@link SOURCE_REGISTRY}. */
  source: string;
  /** The primary (cited) article URL. */
  url: string;
  /**
   * Supporting pages whose content carries the load-bearing facts when the
   * primary article defers to them. Snapshotted as additional `pages[]`
   * entries with their own provenance.
   */
  factUrls?: string[];
  /**
   * The built-in recommendation this guidance attaches to, by EMITTED rec id
   * or category. Reference-only: guidance surfaces solely as a "Learn More"
   * link on this rec once it fires (#1302) — never as a standalone rec.
   */
  target: ExternalGuidanceTarget;
  suggestion: string;
  /** Optional per-article fact extractor over the combined snapshot content. */
  extractFacts?: (text: string) => ExternalGuidanceFacts;
}

/**
 * Structured facts from Anthropic's usage/length-limits support articles.
 * Pure regex extraction over the snapshot text; the inline-fixture unit tests
 * in external-guidance-registry.test.ts pin its behaviour without coupling CI
 * to the committed scraped prose.
 */
export function extractUsageLimitFacts(text: string): ExternalGuidanceFacts {
  const normalized = String(text ?? '').toLowerCase();
  const facts: ExternalGuidanceFacts = {};
  if (
    /\b(?:five-hour|5-hour)\b/.test(normalized) ||
    /every five hours/.test(normalized)
  ) {
    facts.rollingWindowHours = 5;
  }
  if (
    /\bweekly usage limit\b/.test(normalized) ||
    /\bweekly limits\b/.test(normalized)
  ) {
    facts.hasWeeklyLimit = true;
  }
  if (
    normalized.includes('claude.ai') &&
    normalized.includes('claude code') &&
    normalized.includes('claude desktop') &&
    normalized.includes('same usage limit')
  ) {
    facts.sharedAcrossSurfaces = true;
  }
  if (
    /\b200k tokens\b/.test(normalized) ||
    /\b200,000 tokens\b/.test(normalized)
  ) {
    facts.contextWindowTokens = 200000;
  }
  return facts;
}

export const GUIDANCE_ARTICLES: readonly GuidanceArticle[] = [
  {
    id: 'anthropic-usage-limits',
    source: 'anthropic-support',
    url: 'https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work',
    // The primary article links to this best-practices page for usage-limit
    // strategy; Anthropic currently states the concrete five-hour/weekly facts
    // there, so the snapshot records it as a supporting page for fact
    // extraction, with its own per-page provenance (#1407).
    factUrls: [
      'https://support.claude.com/en/articles/9797557-usage-limit-best-practices',
    ],
    // `reliability.rate-limits` is the emitted id of the api-errors detector's
    // rate-limited branch — the built-in rec that fires when the user is
    // actually hitting 429/529 limits. (#1302 re-point: the previous target,
    // `cost.session-usage-limits`, matched no detector on master, so the
    // guidance could never attach. The registry-resolution test now guards
    // this.)
    target: { detectorId: 'reliability.rate-limits' },
    suggestion: 'Review first-party Claude usage and length limit guidance.',
    extractFacts: extractUsageLimitFacts,
  },
];

export function guidanceArticleById(id: string): GuidanceArticle | undefined {
  return GUIDANCE_ARTICLES.find((article) => article.id === id);
}
