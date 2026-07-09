/**
 * Leaf type module for domain coverage (#1582).
 *
 * `digest.ts` imports the `DomainCoverage` / `DomainCoverageStatus` TYPES used
 * by the digest helpers. Hoisting the two types into this dependency-free leaf
 * (its only dependency is the `ActionDomain` enum in the top-level `types`
 * barrel, which is a leaf) lets `digest.ts`, `coverage.ts`, and
 * `recommendations.ts` share them without a coverage <-> digest runtime edge.
 * `coverage.ts` and `recommendations.ts` re-export them, so every existing
 * importer is unaffected.
 */
import type { ActionDomain } from '../types';

export type DomainCoverageStatus = 'PROVE' | 'INFER' | 'CANNOT_SEE';

export interface DomainCoverage {
  domain: ActionDomain;
  status: DomainCoverageStatus;
  staleNote?: string;
}
