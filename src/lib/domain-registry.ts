/**
 * Domain registry (#2079) — the single source of truth for the action-domain
 * taxonomy that organizes the whole UI.
 *
 * The six action-domains (safety, cost, success-rate, speed, context-health,
 * workflow-hygiene) plus the three structural buckets (`home`, `discovery`,
 * `raw`) used to be defined in pieces scattered across >=5 files: the order in
 * `nav-prefs.ts` (`DOMAIN_ORDER`) *and* in `digest.ts` (`ACTION_DOMAINS`), the
 * outcome-verb labels in `nav-prefs.ts` (`DOMAIN_LABEL`), the landing view in
 * `digest.ts` (`DOMAIN_LANDING`), and the rec-category → domain mapping in
 * `digest.ts` (`DOMAIN_FOR_CATEGORY`). Adding a domain or editing an
 * outcome-verb meant editing four places with no single source of truth.
 *
 * This registry — parallel to the detector Catalog — holds one entry per domain.
 * The legacy constants (`DOMAIN_ORDER`, `DOMAIN_LABEL`, `ACTION_DOMAINS`,
 * `DOMAIN_LANDING`, `DOMAIN_FOR_CATEGORY`) are now **derived** from it, so they
 * stay byte-identical to their hand-written predecessors while there is exactly
 * one place to edit. `PFLayout`/`DigestSpine`/`nav-prefs`/`canonical-evidence`
 * reference the derived constants; `PFLayout` auto-discovers each domain's views
 * from the view catalog (`NAV_ITEMS`) by their `domain` field.
 *
 * The completeness invariants (every {@link RecCategory} maps to exactly one
 * domain; every domain has a landing view; the action-domain order and labels
 * are unchanged) are guarded by `domain-registry.test.ts`.
 */
import type { ActionDomain, View } from '../types';
import type { RecCategory } from './recommendations';

/**
 * One registry entry per action-domain. `order` is the sidebar/digest sort
 * position (ascending), `outcomeVerb` is the human group label, `landing` is the
 * default raw view a domain card deep-links to, `actionDomain` marks the six
 * genuine action-domains (true) vs. the structural buckets (`home`/`discovery`/
 * `raw`, false), and `categories` lists the rec-engine categories that feed the
 * domain. The union of every entry's `categories` is exhaustive over
 * {@link RecCategory}, with no category claimed by two domains.
 */
export interface DomainEntry {
  /** The domain id (matches the {@link ActionDomain} union member). */
  name: ActionDomain;
  /** Sort position in the nav and digest (ascending; `home` first, `raw` last). */
  order: number;
  /** Human group header / outcome-verb shown in the sidebar (e.g. "Stay safe"). */
  outcomeVerb: string;
  /** Default raw view this domain's "open full view" link lands on. */
  landing: View;
  /** True for the six genuine action-domains; false for structural buckets. */
  actionDomain: boolean;
  /** Rec-engine categories that feed this domain (empty for structural buckets). */
  categories: readonly RecCategory[];
}

/**
 * The domain registry, in sort order. Safety leads the action-domains (#491) so
 * a critical safety finding can't hide behind a cost tab the user opens first.
 * The `speed` slot is honestly sparse at launch (ADR 0006). Editing a label,
 * landing, order, or category mapping happens HERE and nowhere else.
 */
export const DOMAIN_REGISTRY: readonly DomainEntry[] = [
  {
    name: 'home',
    order: 0,
    outcomeVerb: 'Overview',
    landing: 'home',
    actionDomain: false,
    categories: [],
  },
  {
    name: 'safety',
    order: 1,
    outcomeVerb: 'Stay safe',
    landing: 'permissions',
    actionDomain: true,
    // Agent-trustworthiness findings (model-deceit, #686) ride the safety-first
    // lane: an unverified completion claim is a safety concern, not config hygiene.
    categories: ['safety', 'security'],
  },
  {
    name: 'cost',
    order: 2,
    outcomeVerb: 'Cut cost',
    landing: 'cost',
    actionDomain: true,
    categories: ['cost'],
  },
  {
    name: 'success-rate',
    order: 3,
    outcomeVerb: 'Fail less',
    landing: 'errors',
    actionDomain: true,
    categories: ['reliability'],
  },
  {
    name: 'speed',
    order: 4,
    outcomeVerb: 'Go faster',
    landing: 'evaluator',
    actionDomain: true,
    // Speed findings (the clock — wall-clock/latency levers, e.g. slow stop-hooks)
    // own their own action-domain; see ADR 0006.
    categories: ['speed'],
  },
  {
    name: 'context-health',
    order: 5,
    outcomeVerb: 'Tame context',
    landing: 'context',
    actionDomain: true,
    categories: ['context'],
  },
  {
    name: 'workflow-hygiene',
    order: 6,
    outcomeVerb: 'Clean workflow',
    landing: 'tools',
    actionDomain: true,
    // Memory-store / config upkeep (#1965, `maintenance`) is workflow hygiene:
    // keeping the agent's own durable state clean is part of keeping the
    // workflow honest.
    categories: ['workflow', 'activity', 'maintenance'],
  },
  {
    name: 'discovery',
    order: 7,
    outcomeVerb: 'Find',
    landing: 'search',
    actionDomain: false,
    categories: [],
  },
  {
    name: 'raw',
    order: 8,
    outcomeVerb: 'Raw data',
    landing: 'stats',
    actionDomain: false,
    categories: [],
  },
] as const;

/** Index the registry by domain name for O(1) lookup. */
const REGISTRY_BY_NAME = new Map<ActionDomain, DomainEntry>(
  DOMAIN_REGISTRY.map((d) => [d.name, d])
);

/** Look up a single registry entry by domain name. */
export function domainEntry(domain: ActionDomain): DomainEntry {
  const entry = REGISTRY_BY_NAME.get(domain);
  if (!entry) {
    throw new Error(`Unknown action-domain: ${domain}`);
  }
  return entry;
}

/**
 * Every domain id in sort order — the full nav group order: `home` first, the
 * six action-domains with safety leading, the `discovery` Find group, then the
 * demoted `raw` drawer. Derives {@link nav-prefs.DOMAIN_ORDER}.
 */
export const ALL_DOMAINS: readonly ActionDomain[] = DOMAIN_REGISTRY.map(
  (d) => d.name
);

/**
 * The six genuine action-domains in digest order — safety first. Derives
 * {@link digest.ACTION_DOMAINS}; excludes the `home`/`discovery`/`raw` buckets.
 */
export const ACTION_DOMAIN_NAMES: readonly ActionDomain[] = DOMAIN_REGISTRY
  .filter((d) => d.actionDomain)
  .map((d) => d.name);

/** Outcome-verb (sidebar group label) per domain. Derives `DOMAIN_LABEL`. */
export const DOMAIN_OUTCOME_VERB = Object.fromEntries(
  DOMAIN_REGISTRY.map((d) => [d.name, d.outcomeVerb])
) as Record<ActionDomain, string>;

/** Landing view per domain. Derives `DOMAIN_LANDING`. */
export const DOMAIN_LANDING_VIEW = Object.fromEntries(
  DOMAIN_REGISTRY.map((d) => [d.name, d.landing])
) as Record<ActionDomain, View>;

/**
 * Rec-category → action-domain mapping. Built by inverting each entry's
 * `categories`. Derives `DOMAIN_FOR_CATEGORY`; the completeness test asserts it
 * is exhaustive over {@link RecCategory} with no category double-claimed.
 */
export const CATEGORY_TO_DOMAIN = Object.fromEntries(
  DOMAIN_REGISTRY.flatMap((d) => d.categories.map((c) => [c, d.name]))
) as Record<RecCategory, ActionDomain>;
