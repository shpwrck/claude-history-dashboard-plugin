/**
 * Client-safe recommendation-surface boundary (#2719, epic #2443).
 *
 * The browser is a VIEWER of server-computed recommendation analysis: it never
 * runs the detector catalog or `buildRecommendations`. This module is the
 * types/helper seam that browser surfaces import instead of the heavy
 * `./recommendations` barrel. Its runtime graph is a single `URLSearchParams`
 * call — it reaches NEITHER `./detectors/` NOR `buildRecommendations` (proven by
 * the bundle absence assertions), so importing it drags no engine code into
 * either browser build flavor.
 *
 * The types below are re-exported from their dependency-free leaves via
 * `import type`, which the TS→JS transform fully erases — no runtime edge.
 */
import type { DashboardFilter, RouteFilter } from './routing';
import type { Recommendation, RecSeverity } from './detectors/types';
import type { DomainCoverage, DomainCoverageStatus } from './coverage-types';
import type { RecommendationResult as EngineRecommendationResult } from './recommendations';
import {
  isClaimCanonicalInstant,
  isClaimProvenance,
} from './claim-provenance';
import { parseIsoInstantMs } from './iso-instant';

export type {
  Recommendation,
  RecSeverity,
  DomainCoverage,
  DomainCoverageStatus,
};

/**
 * Server recommendation envelope consumed by browser viewers.
 *
 * `validThrough` is present only when the server analysis used a bounded
 * doc-issue snapshot. It is omitted for the normal local-only result so the
 * flag-off wire response remains byte-for-byte unchanged.
 */
export type RecommendationResult = EngineRecommendationResult & {
  validThrough?: string;
};

/** The typed recommendation surfaces the server serves (#2718). */
export type RecommendationSurfaceName = 'global' | 'reclaim-compass';

/**
 * A scoped analysis request. `dashboard` carries the active masthead filter
 * (both surfaces); `route` carries the Reclaim-Compass route filter and is only
 * serialized for `reclaim-compass`.
 */
export interface RecommendationSurfaceRequest {
  surface: RecommendationSurfaceName;
  dashboard: DashboardFilter;
  route?: RouteFilter;
}

/**
 * The reader's discriminated outcome. `ready` carries the server envelope;
 * `unavailable` is the network-free viewer state the SPA twin returns without a
 * fetch. A network/parse failure is signalled by a thrown error (the hook maps
 * it to an `error` state), never by an `unavailable` — so a failed load can
 * never masquerade as "no findings".
 */
export type RecommendationSurfaceResponse =
  | { kind: 'ready'; result: RecommendationResult }
  | { kind: 'unavailable' };

/**
 * Validate the trust-bearing server envelope before any viewer can call it
 * `ready`. In particular, a legacy raw Recommendation[] response, `{}`, or a
 * partial/null envelope must become an error instead of being coerced by a
 * consumer's `?? []` fallback into a false clean result.
 */
export function parseRecommendationResult(value: unknown): RecommendationResult {
  const record = asRecord(value);
  if (
    record === null ||
    Array.isArray(value) ||
    !Array.isArray(record.recommendations) ||
    !Array.isArray(record.domainCoverage) ||
    !record.recommendations.every(isRecommendation) ||
    !record.domainCoverage.every(isDomainCoverage) ||
    ('validThrough' in record &&
      !isClaimCanonicalInstant(record.validThrough))
  ) {
    throw new Error('Invalid recommendation analysis response');
  }
  return value as RecommendationResult;
}

const RECOMMENDATION_CATEGORIES = new Set([
  'cost',
  'context',
  'workflow',
  'safety',
  'security',
  'reliability',
  'speed',
  'activity',
  'maintenance',
]);
const RECOMMENDATION_SEVERITIES = new Set(['critical', 'warning', 'info']);
const CLAIM_CLASSES = new Set(['accounting', 'causal']);
const PROOF_TIERS = new Set([
  'auditable',
  'accounting',
  'observational',
  'causal-proof',
]);
const ACTION_DOMAINS = new Set([
  'home',
  'safety',
  'cost',
  'success-rate',
  'speed',
  'context-health',
  'workflow-hygiene',
  'discovery',
  'raw',
]);
const COVERAGE_STATUSES = new Set(['PROVE', 'INFER', 'CANNOT_SEE']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalNonNegativeNumber(
  record: Record<string, unknown>,
  field: string,
  integer = false
): boolean {
  const value = record[field];
  return (
    !(field in record) ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      (!integer || Number.isInteger(value)))
  );
}

function isOptionalStringArray(
  record: Record<string, unknown>,
  field: string
): boolean {
  return (
    !(field in record) ||
    (Array.isArray(record[field]) &&
      (record[field] as unknown[]).every(isNonEmptyString))
  );
}

function isEvidenceRef(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== null &&
    isNonEmptyString(record.sessionId) &&
    typeof record.entryIndex === 'number' &&
    Number.isInteger(record.entryIndex) &&
    record.entryIndex >= 0 &&
    isNonEmptyString(record.timestamp) &&
    parseIsoInstantMs(record.timestamp) !== undefined &&
    (!('toolUseId' in record) || isNonEmptyString(record.toolUseId)) &&
    (!('entryId' in record) || isNonEmptyString(record.entryId))
  );
}

function isOptionalEvidenceRefs(record: Record<string, unknown>): boolean {
  return (
    !('evidenceRefs' in record) ||
    (Array.isArray(record.evidenceRefs) &&
      record.evidenceRefs.every(isEvidenceRef))
  );
}

function isRecommendation(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null) return false;
  return (
    isNonEmptyString(record.id) &&
    typeof record.category === 'string' &&
    RECOMMENDATION_CATEGORIES.has(record.category) &&
    typeof record.severity === 'string' &&
    RECOMMENDATION_SEVERITIES.has(record.severity) &&
    isNonEmptyString(record.title) &&
    isNonEmptyString(record.detail) &&
    isNonEmptyString(record.action) &&
    isOptionalNonNegativeNumber(record, 'affected', true) &&
    isOptionalNonNegativeNumber(record, 'estSavingsUsd') &&
    isOptionalNonNegativeNumber(record, 'estTimeReclaimedMin') &&
    isOptionalNonNegativeNumber(record, 'premiseUsdPerMo') &&
    isOptionalStringArray(record, 'evidence') &&
    isOptionalEvidenceRefs(record) &&
    ('claimClass' in record
      ? typeof record.claimClass === 'string' &&
        CLAIM_CLASSES.has(record.claimClass)
      : true) &&
    ('proofTier' in record
      ? typeof record.proofTier === 'string' &&
        PROOF_TIERS.has(record.proofTier)
      : true) &&
    isClaimProvenance(record.provenance)
  );
}

function isDomainCoverage(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null) return false;
  return (
    typeof record.domain === 'string' &&
    ACTION_DOMAINS.has(record.domain) &&
    typeof record.status === 'string' &&
    COVERAGE_STATUSES.has(record.status) &&
    (!('staleNote' in record) || isNonEmptyString(record.staleNote))
  );
}

// Only these four RouteFilter keys are valid params on the `reclaim-compass`
// surface; the server 400s on any other parameter (e.g. `rec`, `family`), so we
// select exactly this subset and never forward the full RouteFilter.
const RECLAIM_ROUTE_PARAM_BY_KEY = {
  project: 'routeProject',
  date: 'routeDate',
  mode: 'routeMode',
  entrypoint: 'routeEntrypoint',
} as const;

/**
 * Serialize a request to the exact `/api/recommendations.json` query the #2718
 * surface contract accepts: `surface` + the masthead `dashboardTime`/
 * `dashboardProject`, plus (reclaim only) the truthy `route*` filters. The
 * output is deterministic, so it doubles as the stable scope key the loader
 * hook keys its effect on.
 */
export function recommendationSurfaceQuery(
  request: RecommendationSurfaceRequest
): string {
  const params = new URLSearchParams();
  params.set('surface', request.surface);
  params.set('dashboardTime', request.dashboard.time);
  params.set('dashboardProject', request.dashboard.project);
  if (request.surface === 'reclaim-compass' && request.route) {
    for (const [key, param] of Object.entries(RECLAIM_ROUTE_PARAM_BY_KEY)) {
      const value = request.route[key as keyof typeof RECLAIM_ROUTE_PARAM_BY_KEY];
      if (value) params.set(param, value);
    }
  }
  return params.toString();
}
