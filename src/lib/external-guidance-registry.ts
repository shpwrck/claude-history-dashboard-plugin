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

/**
 * Structured brevity / token-efficiency tactics from the prompt-brevity guide
 * (#1589). Pure regex over the snapshot text, keyed on the article's distinctive
 * load-bearing phrasing so the inline-fixture unit tests pin behaviour without
 * coupling CI to the scraped prose (which, being a personal blog, drifts more
 * freely than first-party docs). Each fact is an actionable brevity heuristic
 * that maps onto the output-verbosity recommendation.
 */
export function extractBrevityFacts(text: string): ExternalGuidanceFacts {
  const normalized = String(text ?? '').toLowerCase();
  const facts: ExternalGuidanceFacts = {};
  // "structured rather than conversational prompts"
  if (/structured rather than conversational/.test(normalized)) {
    facts.preferStructuredPrompts = true;
  }
  // The four dimensions every effective prompt addresses.
  if (
    /four dimensions/.test(normalized) &&
    normalized.includes('context') &&
    normalized.includes('constraint') &&
    normalized.includes('output format')
  ) {
    facts.promptDimensions = 'context, task, constraint, output-format';
  }
  // "Every token of social nicety is a token stolen from actual reasoning."
  if (
    /social nicety is a token stolen/.test(normalized) ||
    /avoid pleasantries/.test(normalized)
  ) {
    facts.dropSocialNiceties = true;
  }
  // Telegram style: omit articles, conjunctions, filler.
  if (/omit articles, conjunctions, filler/.test(normalized)) {
    facts.telegramStyle = true;
  }
  // "Request minimal output" / "Code only. No explanation."
  if (
    /request minimal output/.test(normalized) ||
    /code only\. no explanation/.test(normalized)
  ) {
    facts.requestMinimalOutput = true;
  }
  // The catalog of filler words/phrases to delete.
  if (/words and phrases to eliminate/.test(normalized)) {
    facts.eliminateFillerPhrases = true;
  }
  // "Sacrifice grammar before sacrificing precision."
  if (/sacrifice grammar before sacrificing precision/.test(normalized)) {
    facts.precisionOverGrammar = true;
  }
  return facts;
}

/** First-party meta-patterns summarized by the Claude Code prompt library. */
export function extractPromptLibraryFacts(text: string): ExternalGuidanceFacts {
  const normalized = String(text ?? '').toLowerCase();
  const facts: ExternalGuidanceFacts = {};
  if (normalized.includes('describe the outcome, not the steps')) {
    facts.describeOutcome = true;
  }
  if (normalized.includes('give it a way to check its own work')) {
    facts.includeVerification = true;
  }
  if (normalized.includes('point at a reference')) {
    facts.pointAtReference = true;
  }
  if (normalized.includes('state the measurable target')) {
    facts.stateMeasurableTarget = true;
  }
  if (normalized.includes('give it the artifact')) {
    facts.provideArtifact = true;
  }
  if (normalized.includes('say how you want the answer')) {
    facts.requestAnswerFormat = true;
  }
  return facts;
}

export const GUIDANCE_ARTICLES: readonly GuidanceArticle[] = [
  {
    id: 'anthropic-claude-code-prompt-library',
    source: 'anthropic-claude-code-docs',
    url: 'https://code.claude.com/docs/en/prompt-library',
    target: { detectorId: 'workflow.prompt-clarity' },
    suggestion:
      'Adapt first-party prompt patterns: state the outcome, verification, references, measurable target, source artifact, and desired answer format.',
    extractFacts: extractPromptLibraryFacts,
  },
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
  {
    // A community (personal-blog) prompt-brevity guide (#1589). Attaches to the
    // output-verbosity recommendation as lower-trust "Learn More" backing —
    // never a standalone rec. The `community` trust tier (from its source) is
    // surfaced distinctly at render time.
    id: 'prompt-brevity-language-efficiency',
    source: 'prahlad-yeri-guides',
    url: 'https://prahladyeri.github.io/guides/applying-brevity-and-language-efficiency-to-prompt-engineering.html',
    target: { detectorId: 'cost.output-verbosity' },
    suggestion:
      'Tighten prompts: drop social niceties, prefer structured over conversational phrasing, and request minimal output.',
    extractFacts: extractBrevityFacts,
  },
];

export function guidanceArticleById(id: string): GuidanceArticle | undefined {
  return GUIDANCE_ARTICLES.find((article) => article.id === id);
}
