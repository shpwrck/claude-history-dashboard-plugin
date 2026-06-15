/**
 * Digest spine logic (epic #490, #491) — the pure ranking behind the home
 * landing. Kept separate from `DigestSpine.tsx` so the safety-first ordering and
 * verdict are unit-testable without rendering PatternFly.
 *
 * The home page is a single ranked answer-sequence — *verdict → where did it go
 * → what to fix* — that ranks findings **across all six action-domains at once**,
 * with **safety leading**. Leading with safety (rather than the engine's raw
 * severity sort) is deliberate: it stops a critical safety finding from hiding
 * behind a more-legible cost finding the user would otherwise read first
 * (S1-Priya's siloing failure-mode; see `docs/reviews/nav-redesign-funnel.md`).
 */
import type { Recommendation, RecCategory } from './recommendations';
import type { ActionDomain, View } from '../types';

/** Map a rec engine `category` onto the action-domain taxonomy (#490). */
export const DOMAIN_FOR_CATEGORY: Record<RecCategory, ActionDomain> = {
  cost: 'cost',
  reliability: 'success-rate',
  safety: 'safety',
  // Agent-trustworthiness findings (model-deceit, #686) ride the safety-first
  // lane: an unverified completion claim is a safety concern, not config hygiene.
  security: 'safety',
  context: 'context-health',
  workflow: 'workflow-hygiene',
  // Speed findings (the clock — wall-clock/latency levers, e.g. slow stop-hooks)
  // own their own action-domain; see ADR 0006.
  speed: 'speed',
  activity: 'workflow-hygiene',
};

/**
 * The six action-domains in digest order — safety first. The `speed` slot stays
 * empty until a clock-lever detector fires (ADR 0006 — honestly sparse at launch).
 */
export const ACTION_DOMAINS: readonly ActionDomain[] = [
  'safety',
  'cost',
  'success-rate',
  'speed',
  'context-health',
  'workflow-hygiene',
];

/** The default raw view to deep-link to for a domain's "open full view" link. */
export const DOMAIN_LANDING: Record<ActionDomain, View> = {
  home: 'home',
  safety: 'permissions',
  cost: 'cost',
  'success-rate': 'errors',
  speed: 'evaluator',
  'context-health': 'context',
  'workflow-hygiene': 'tools',
  discovery: 'search',
  raw: 'stats',
};

/** The action-domain a recommendation belongs to. */
export function domainForRec(rec: Recommendation): ActionDomain {
  return DOMAIN_FOR_CATEGORY[rec.category];
}

/**
 * Re-rank the engine's already-sorted recommendations for the digest: all
 * safety-domain findings first (regardless of severity), then everything else
 * in the engine's existing severity → savings → affected order. Stable —
 * relative order within each partition is preserved.
 */
export function rankForDigest(recs: Recommendation[]): Recommendation[] {
  const safety = recs.filter((r) => domainForRec(r) === 'safety');
  const rest = recs.filter((r) => domainForRec(r) !== 'safety');
  return [...safety, ...rest];
}

/** Top warning/critical safety-domain finding for the dedicated digest lead. */
export function safetyLeadForDigest(recs: Recommendation[]): Recommendation | null {
  return (
    rankForDigest(recs).find(
      (r) => domainForRec(r) === 'safety' && r.severity !== 'info'
    ) ?? null
  );
}

export interface DomainFinding {
  domain: ActionDomain;
  /** The top finding for the domain, or null when the domain is quiet. */
  rec: Recommendation | null;
}

/**
 * The "where did it go" beat: the single top finding per action-domain, in
 * digest order (safety first). Domains with no finding are still listed (with
 * `rec: null`) so the spine shows the full action surface, including the
 * intentionally-sparse `speed` slot.
 */
export function topPerDomain(recs: Recommendation[]): DomainFinding[] {
  const ranked = rankForDigest(recs);
  return ACTION_DOMAINS.map((domain) => ({
    domain,
    rec: ranked.find((r) => domainForRec(r) === domain) ?? null,
  }));
}

export type VerdictTone = 'ok' | 'attention' | 'critical';

export interface DigestVerdict {
  tone: VerdictTone;
  text: string;
}

/**
 * The one-sentence "am I okay" verdict. Critical when any safety finding is
 * critical; attention when there are findings; ok when there are none.
 */
export function digestVerdict(recs: Recommendation[]): DigestVerdict {
  if (recs.length === 0) {
    return {
      tone: 'ok',
      text: 'No findings — your recent agent activity looks healthy.',
    };
  }
  const criticalSafety = recs.find(
    (r) => r.category === 'safety' && r.severity === 'critical'
  );
  if (criticalSafety) {
    return {
      tone: 'critical',
      text: `Safety needs attention first: ${criticalSafety.title}`,
    };
  }
  const critical = recs.filter((r) => r.severity === 'critical').length;
  const total = recs.length;
  if (critical > 0) {
    return {
      tone: 'attention',
      text: `${critical} critical ${
        critical === 1 ? 'finding' : 'findings'
      } across ${total} total — start at the top.`,
    };
  }
  return {
    tone: 'attention',
    text: `${total} ${
      total === 1 ? 'finding' : 'findings'
    } worth a look — nothing critical.`,
  };
}
