/**
 * Dependency-free leaf enums shared by the detector-types graph and the parsers
 * that feed it (#1582).
 *
 * `detectors/types.ts` is the leaf of the recommendations graph, yet it imports
 * (type-only) from `reclaim`, `parse-external-guidance`, and `parse-repo-map-join`
 * to assemble `RecommendationInput`. Those modules (and `parse-config-attribution`,
 * reached via `parse-repo-map-join`) in turn needed only one small enum from
 * `detectors/types` — `RecCategory` or `SavingsAttributionTier` — and imported it
 * with `import type`, closing a runtime-erased madge cycle apiece.
 *
 * Hoisting just those two enums here lets those modules import the enum from a
 * non-cyclic path, so madge no longer reports the cycle — with zero runtime
 * change (the back-edges were already `import type`). `detectors/types.ts`
 * re-exports both, and `recommendations.ts` re-exports them transitively, so every
 * existing `from './detectors/types'` / `from './recommendations'` importer is
 * unaffected. This file imports nothing, so it stays a true leaf.
 */

/** The recommendation category vocabulary every detector and consumer shares. */
export type RecCategory =
  | 'cost'
  | 'context'
  | 'workflow'
  | 'safety'
  | 'security'
  | 'reliability'
  | 'speed'
  | 'activity'
  // Upkeep of the agent's own durable state. Maintenance is live: registered
  // detectors include maintenance.memory-hygiene, maintenance.doc-hygiene, and
  // maintenance.skill-hook-integrity. The canonical domain registry maps it to
  // the Clean workflow ActionDomain (#1965).
  | 'maintenance';

export type SavingsAttributionTier =
  | 'tier-0-estimate'
  | 'tier-1-before-after'
  | 'tier-2-ablation';
