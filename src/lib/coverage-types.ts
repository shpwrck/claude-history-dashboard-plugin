/**
 * Leaf type module for domain coverage (#1582).
 *
 * `coverage.ts` imports a VALUE (`ACTION_DOMAINS`) from `digest.ts`, and `digest.ts`
 * imported the `DomainCoverage` / `DomainCoverageStatus` TYPES back from
 * `coverage.ts` (`import type`), closing a runtime-erased madge cycle. Hoisting the
 * two types into this dependency-free leaf (its only dependency is the
 * `ActionDomain` enum in the top-level `types` barrel, which is a leaf) lets
 * `digest.ts` import them without the cycle. `coverage.ts` and `recommendations.ts`
 * re-export them, so every existing importer is unaffected, with zero runtime
 * change (the back-edge was already `import type`).
 */
import type { ActionDomain } from '../types';

export type DomainCoverageStatus = 'PROVE' | 'INFER' | 'CANNOT_SEE';

export interface DomainCoverage {
  domain: ActionDomain;
  status: DomainCoverageStatus;
  staleNote?: string;
}
