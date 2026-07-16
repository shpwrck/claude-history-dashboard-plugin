/**
 * Recommendations engine.
 *
 * Every other `lib/` module computes a *signal* (cache hit rate, native-tool
 * bypass counts, dangerous commands, API error codes, …) and the matching view
 * renders it as a table or chart. This module is the layer on top: it runs the
 * detector catalog and emits a small set of ranked, actionable recommendations —
 * "here is what to change, why, and roughly what it's worth".
 *
 * As of #507 every detector lives one-per-file under `src/lib/detectors/`; the
 * 20 legacy in-file rules that used to live here were ported into the catalog
 * and retired. This module now holds only the engine plumbing:
 * `buildRecommendations` (run the catalog + rank), the
 * `assembleRecommendationInput` data-source seam, the per-project attribution
 * helpers, and the back-compat type/helper re-exports.
 *
 * Design notes:
 *  - Pure: `buildRecommendations` depends only on its argument. No I/O, no clock
 *    reads except where a detector is explicitly time-relative (stale projects),
 *    which takes `now` so it stays testable.
 *  - Each detector returns `Recommendation | null`; a null means "nothing worth
 *    saying", which keeps the assembled list free of zero-impact noise.
 */
import type { Session } from '../types';
import {
  projectIdentityKey,
  resolveProjectBySession,
  sameProjectIdentity,
} from './project-identity';

// ── Recommendation types ─────────────────────────────────────────────────
// Defined in ./detectors/types and re-exported here so existing importers
// (`from './recommendations'`) keep working unchanged.
import type { Recommendation, RecommendationInput } from './detectors/types';
import type { SessionTokenData } from '../types';
import {
  computeDomainCoverage,
  type DomainCoverage,
} from './coverage';
import {
  runReclaimCascade,
  rollupCascade,
  type ReclaimClaim,
  type ReclaimCascadeResult,
  type ReclaimRollupWithBill,
} from './reclaim';
export type {
  PoolId,
  CauseKey,
  CategoryCoverage,
  ReclaimClaim,
  ReclaimCounterfactual,
  BookedClaim,
  ReclaimCascadeResult,
  ReclaimRollupWithBill,
} from './reclaim';
export { runReclaimCascade, rollupCascade, scopeKeyOf, DEFAULT_CAUSE } from './reclaim';
export type {
  RecCategory,
  RecSeverity,
  FixTarget,
  FixKind,
  AppliedMarkers,
  RecFix,
  RecObservation,
  RecProvenance,
  RecommendationSavingsAttribution,
  ModelPinSavingsConfig,
  SavingsAttributionConfidence,
  SavingsAttributionPeriod,
  SavingsAttributionTier,
  SavingsAttributionWindow,
  Recommendation,
  RecommendationInput,
  Detector,
} from './detectors/types';
export type { DomainCoverage, DomainCoverageStatus } from './coverage';
export { computeDomainCoverage } from './coverage';

// ── Shared detector helpers ──────────────────────────────────────────────
// Defined in ./detectors/shared (below types, above detectors in the import
// graph, so nothing here forms a cycle). Public helpers are re-exported below.
import { SEVERITY_RANK, short } from './detectors/shared';
export {
  bumpSeverity,
  claudeMdMarksApplied,
  automationCostShare,
  DANGEROUS_DENY_RULES,
  BASH_SAFE_ALLOW_RULES,
} from './detectors/shared';

// ── Detector catalog ─────────────────────────────────────────────────────
// Static, hand-written barrel of per-file detectors (ADR 0002). As of #507 this
// is the complete set of recommendations — there are no more in-file rules.
import {
  DETECTORS,
  hookOverheadCacheValidity,
  hookOverheadCacheValidityContains,
  skillHookIntegrityCacheValidity,
  skillHookIntegrityCacheValidityContains,
  type HookOverheadCacheValidity,
  type SkillHookIntegrityCacheValidity,
} from './detectors';
import {
  externalGuidanceCacheValidity,
  externalGuidanceCacheValidityContains,
  externalGuidanceClockTransitions,
  externalGuidanceRef,
} from './external-guidance';
import type {
  ExternalGuidance,
  ExternalGuidanceCacheValidity,
  ExternalGuidanceRef,
} from './external-guidance';
import { deriveModelPinSavingsConfig } from './model-pin-savings';
import {
  computeSuppressionTransitions as computeSuppressionTransitionsOver,
  type PriorReceipts,
  type SuppressionTransitionResult,
} from './detectors/suppression-transition';
export type {
  SuppressionTransition,
  OrganicSuppression,
  SuppressionTransitionResult,
  PriorReceipts,
} from './detectors/suppression-transition';
export type {
  ContributorAlias,
  ContributorAliasResolver,
  ContributorAliasKind,
  ContributorIdentity,
  ContributorResolution,
  OrganizationIdentityDataset,
  OrganizationIdentityTeam,
} from './organization-identity';
export {
  createContributorAliasResolver,
  normalizeContributorAlias,
  resolveContributorAlias,
} from './organization-identity';
export type {
  OrganizationReviewEventsDataset,
  PullRequestReviewRequest,
  PullRequestReviewRequestState,
  PullRequestState,
} from './organization-review-events';
export type {
  ExternalGuidance,
  ExternalGuidanceFacts,
  ExternalGuidanceFactValue,
  ExternalGuidanceRef,
  ExternalGuidanceSource,
  ExternalGuidanceTarget,
  ExternalGuidanceTrustTier,
  ParseExternalGuidanceOptions,
} from './parse-external-guidance';

// Note: `automationCostShare` is re-exported above from ./detectors/shared so
// existing `from '../lib/recommendations'` importers (AutomationView, tests)
// keep working after it moved into the detector layer (#507).

// ── Engine input assembly ────────────────────────────────────────────────
/**
 * Single seam that maps the dashboard's parsed "views" bundle to the engine's
 * {@link RecommendationInput}. BOTH callers — the server route
 * (`scripts/ingest.mjs` → `/api/recommendations.json`) and the client view
 * (`src/components/Recommendations.tsx`) — go through here, so adding a new data
 * source to the engine is a one-place change: add the optional field to
 * {@link RecommendationInput} (in ./detectors/types) and map it below.
 */
export type RecommendationViews = RecommendationInput;

/**
 * The union of every field any detector declares in its `dataDeps` (#2080),
 * computed once from the static catalog. `assembleRecommendationInput` uses it
 * to make `dataDeps` load-bearing on the mapper side: any declared dependency a
 * caller omitted is filled with an explicit `null` ("looked, nothing there")
 * rather than left `undefined` ("silently absent"). Detectors already treat
 * `null`/`undefined`/empty identically for emit purposes, so this normalisation
 * changes no emitted recommendation — it only guarantees a detector that names a
 * field can rely on the key existing, and keeps the catalog test's
 * populated-or-explicitly-null contract honest. The required base fields
 * (`tokenData`, `toolData`, …) are never nulled — they are non-optional and a
 * caller must supply them.
 */
const REQUIRED_INPUT_FIELDS: ReadonlySet<keyof RecommendationInput> = new Set([
  'tokenData',
  'toolData',
  'sessions',
  'projects',
  'permissionRows',
  'apiErrors',
]);

const DECLARED_DATA_DEP_FIELDS: ReadonlySet<keyof RecommendationInput> = (() => {
  const s = new Set<keyof RecommendationInput>();
  for (const d of DETECTORS) {
    for (const dep of d.dataDeps ?? []) {
      if (!REQUIRED_INPUT_FIELDS.has(dep)) s.add(dep);
    }
  }
  return s;
})();

/**
 * Every input field any detector consumes: the required base fields plus the
 * union of declared `dataDeps` (#2080). Exported for the #2352 parity
 * contract — the client envelope (`recommendation-view-data.ts`) is tested
 * against this list so a new detector dependency on a client-carried signal
 * cannot be silently dropped from the client surfaces.
 */
export function engineConsumedFields(): (keyof RecommendationInput)[] {
  return [...REQUIRED_INPUT_FIELDS, ...DECLARED_DATA_DEP_FIELDS].sort();
}

/**
 * The declared detector signals a caller did NOT supply (`undefined`, as
 * opposed to an explicit "looked, nothing there" null). A surface that
 * intentionally passes a narrower envelope must label these omissions in its
 * output instead of silently disagreeing with the Recommendations page (#2352).
 */
export function listOmittedEngineSignals(v: RecommendationViews): string[] {
  const record = v as unknown as Record<string, unknown>;
  return [...DECLARED_DATA_DEP_FIELDS]
    .filter(
      (f) =>
        record[f] === undefined &&
        // Derived, never truly omitted: `assembleRecommendationInput` computes
        // modelPinSavings from tokenData when the caller doesn't supply it, so
        // detectors that depend on it DO run — reporting it as omitted would
        // be a false coverage claim (AGENTS.md: recommendations are auditable).
        f !== 'modelPinSavings'
    )
    .sort();
}

export function assembleRecommendationInput(
  v: RecommendationViews
): RecommendationInput {
  // Pass every field through, normalising only the optionals the engine treats
  // "absent" as "filter nothing" (liveConfig #166, assistantFeatures #206,
  // promptAnalysis #1275). Spreading rather than re-listing each field means a NEW
  // detector-consumed signal added to {@link RecommendationInput} and supplied
  // by the caller flows through here automatically — no edit to this mapper.
  // (#524 slice 3: the ingest caller supplies the signal-derived fields straight
  // from the signal descriptor's datasetKeys.)
  const normalized: RecommendationInput = {
    ...v,
    liveConfig: v.liveConfig ?? null,
    assistantFeatures: v.assistantFeatures ?? null,
    promptAnalysis: v.promptAnalysis ?? null,
  };

  // #2080: make dataDeps load-bearing on the mapper. Every declared dependency
  // that the caller omitted becomes an explicit `null` so detectors never read a
  // silently-undefined declared field. `modelPinSavings` is handled by its own
  // derive path below, so leave it for that step.
  const normalizedRecord = normalized as unknown as Record<string, unknown>;
  for (const field of DECLARED_DATA_DEP_FIELDS) {
    if (field === 'modelPinSavings') continue;
    if (normalizedRecord[field] === undefined) {
      normalizedRecord[field] = null;
    }
  }

  if ('modelPinSavings' in v) {
    normalized.modelPinSavings = v.modelPinSavings ?? null;
    return normalized;
  }

  const derivedModelPinSavings = deriveModelPinSavingsConfig({
    tokenData: v.tokenData,
  });
  normalized.modelPinSavings = derivedModelPinSavings ?? null;
  return normalized;
}

interface RecommendationBuildCacheEntry {
  recommendations: Recommendation[];
  guidanceCacheValidity: ExternalGuidanceCacheValidity;
  hookOverheadCacheValidity: HookOverheadCacheValidity;
  skillHookIntegrityCacheValidity: SkillHookIntegrityCacheValidity;
}

const buildCache: WeakMap<RecommendationInput, RecommendationBuildCacheEntry> =
  new WeakMap();

export interface RecommendationResult {
  recommendations: Recommendation[];
  domainCoverage: DomainCoverage[];
}

// ── External guidance attach pass (#1302, epic #656) ─────────────────────
/**
 * Attach externally-authored guidance snapshots to already-fired
 * recommendations as reference-only "Learn More" links.
 *
 * Relevance-gating is structural: a guidance document targets exactly one
 * EMITTED rec id (`target.detectorId`) or one category (`target.category`),
 * and its reference appears ONLY on recs the deterministic engine actually
 * emitted this run. Guidance never becomes a standalone recommendation, never
 * adds a category, and never affects ranking — the post-pass runs after the
 * detector loop and only decorates.
 */
export function attachExternalGuidanceReferences(
  recs: Recommendation[],
  guidance: ExternalGuidance[] | null | undefined,
  now?: number
): Recommendation[] {
  if (!guidance || guidance.length === 0) return recs;
  return recs.map((rec) => {
    const seenUrls = new Set<string>();
    const references: ExternalGuidanceRef[] = [];
    for (const g of guidance) {
      const matches = g.target.detectorId
        ? g.target.detectorId === rec.id
        : g.target.category === rec.category;
      if (!matches) continue;
      const ref = externalGuidanceRef(g, now);
      if (seenUrls.has(ref.url)) continue;
      seenUrls.add(ref.url);
      references.push(ref);
    }
    return references.length > 0 ? { ...rec, references } : rec;
  });
}

/**
 * Rank recommendations by severity, dollar impact, reclaimed time, then affected
 * count. Dollar-bearing recs keep priority over time-only recs when the dollar
 * values tie, so the new time unit only orders findings that have no stronger
 * dollar signal.
 */
export function rankRecommendations(
  recs: Recommendation[]
): Recommendation[] {
  return recs.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const savings = (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0);
    if (savings !== 0) return savings;
    const aHasUsd = a.estSavingsUsd !== undefined;
    const bHasUsd = b.estSavingsUsd !== undefined;
    if (aHasUsd !== bHasUsd) return bHasUsd ? 1 : -1;
    const reclaimed =
      (b.estTimeReclaimedMin ?? 0) - (a.estTimeReclaimedMin ?? 0);
    if (reclaimed !== 0) return reclaimed;
    return (b.affected ?? 0) - (a.affected ?? 0);
  });
}

/**
 * Run every detector and return the surviving recommendations, ranked by the
 * shared severity / impact / affected-count comparator.
 *
 * This is the convergence point for the **UI-data → Recommendation actionability
 * contract** (epic #866, keystone #851): any visible UI signal that implies an
 * action MUST be projected into this output, so the recs skill, the digest /
 * Ask-Claude context, and `/api/recommendations.json` all see the same actionable
 * layer a view exposes. Every nav view's data family is either backed by >= 1
 * detector here or documented as orientation-only. The full contract + the
 * per-view audit live in `docs/recommendation-actionability-contract.md`.
 *
 * Memoized by `input` object identity via a WeakMap so repeat calls with the
 * same input (React strict-mode double-invocations, sibling consumers, test
 * loops) return the prior result without rerunning the catalog reduce. The inner
 * per-detector cost work is already deduped by the `estimateCost` WeakMap memo
 * in `parse-sessions.ts`. See issue #161.
 *
 * Skip cache when the caller pins `now` — those calls are time-keyed. Normal
 * identity-cache entries carry external-guidance, Stop-hook timing, and
 * hook-path evidence validity boundaries, so wall-clock movement cannot leave
 * a time-relative label or finding stale.
 */
/**
 * Collapse the duplicate `safety.unattended-sessions` card into the single
 * `safety.dangerous-bypass` card (#2012, epic #2009). Both detectors run the
 * same `detectDangerousCommands` + `computeSafetyScores` over bypassPermissions
 * sessions; `safety.unattended-sessions` only adds the `isUnattendedEntrypoint`
 * filter, so its command set is BY CONSTRUCTION a subset of dangerous-bypass's.
 * Emitting both shows two CRITICAL cards for one underlying set of commands,
 * which erodes the severity tier. When dangerous-bypass is present we drop the
 * standalone unattended card; its count already rides dangerous-bypass as
 * `unattendedCount` (set in the detector), and we backfill it here if absent so
 * the surviving card never loses the unattended dimension. Mutates `recs` in
 * place. When dangerous-bypass is NOT present (e.g. suppressed by an adopted
 * deny block), the unattended card is left alone — there is no duplication.
 */
function collapseUnattendedIntoDangerousBypass(recs: Recommendation[]): void {
  const bypass = recs.find((r) => r.id === 'safety.dangerous-bypass');
  if (!bypass) return;
  const unattendedIdx = recs.findIndex((r) => r.id === 'safety.unattended-sessions');
  if (unattendedIdx === -1) return;
  const unattended = recs[unattendedIdx];
  if (bypass.unattendedCount == null) {
    bypass.unattendedCount = unattended.affected;
  }
  recs.splice(unattendedIdx, 1);
}

/**
 * Drop every recommendation the user has explicitly rejected (#2206, epic #1298).
 * `rejectedFindingIds` is the set of `Recommendation.id`s carrying an active
 * `REJECTED` adoption receipt (see `adoption-receipts.ts`
 * `readRejectedFindingIds`): a rejected finding is suppressed from output. The
 * suppression is reversible — un-rejecting a finding drops its id from the set,
 * so it reappears on the next build. Pure and non-mutating: returns a NEW array
 * when any finding is filtered, and the input reference unchanged on the
 * empty-set fast path (no receipts → no copy), so the browser/SPA path — which
 * has no receipts — is byte-identical.
 */
export function suppressRejectedRecommendations(
  recs: Recommendation[],
  rejectedFindingIds: ReadonlySet<string>
): Recommendation[] {
  if (rejectedFindingIds.size === 0) return recs;
  return recs.filter((rec) => !rejectedFindingIds.has(rec.id));
}

export function buildRecommendations(
  input: RecommendationInput,
  now?: number
): Recommendation[] {
  const useCache = now === undefined;
  const t = now ?? Date.now();
  if (useCache) {
    const cached = buildCache.get(input);
    if (
      cached &&
      externalGuidanceCacheValidityContains(cached.guidanceCacheValidity, t) &&
      hookOverheadCacheValidityContains(cached.hookOverheadCacheValidity, t) &&
      skillHookIntegrityCacheValidityContains(
        cached.skillHookIntegrityCacheValidity,
        t
      )
    ) {
      return cached.recommendations;
    }
  }
  const recs: Recommendation[] = [];
  for (const d of DETECTORS) {
    if (d.emitAll) {
      recs.push(...d.emitAll(input, t));
      continue;
    }
    const r = d.rule(input, t);
    if (r) recs.push(r);
  }
  collapseUnattendedIntoDangerousBypass(recs);
  const sorted = rankRecommendations(
    attachExternalGuidanceReferences(recs, input.externalGuidance, t)
  );
  if (useCache) {
    const guidanceTransitions = externalGuidanceClockTransitions(
      input.externalGuidance
    );
    buildCache.set(input, {
      recommendations: sorted,
      guidanceCacheValidity: externalGuidanceCacheValidity(
        guidanceTransitions,
        t
      ),
      hookOverheadCacheValidity: hookOverheadCacheValidity(input, t),
      skillHookIntegrityCacheValidity: skillHookIntegrityCacheValidity(input, t),
    });
  }
  return sorted;
}

export function buildRecommendationResult(
  input: RecommendationInput,
  now?: number
): RecommendationResult {
  return {
    recommendations: buildRecommendations(input, now),
    domainCoverage: computeDomainCoverage(input),
  };
}

/**
 * Compute the FIRING→SUPPRESSED adoption transitions for one engine run over the
 * full detector catalog (#576, epic #573; ADR 0005 "Emit once in the engine run
 * loop"). Thin catalog binding around
 * {@link computeSuppressionTransitionsOver}: diffs the real run against a
 * CLAUDE.md-blanked counterfactual run to find findings now suppressed by their
 * markers, gates each on a prior hook-stamped `SURFACED` receipt, and returns
 * one `SUPPRESSED` record per finding's first attributed flip (organic, never-
 * surfaced suppressions are returned separately and excluded). Pure — the
 * caller (server route) writes the records through #575's allowlist-drop,
 * killswitch-aware writer.
 */
export function computeSuppressionTransitions(
  input: RecommendationInput,
  prior: PriorReceipts,
  now?: number
): Promise<SuppressionTransitionResult> {
  return computeSuppressionTransitionsOver(
    input,
    prior,
    DETECTORS,
    now ?? Date.now()
  );
}

// ── Reclaim rollup (#946, epic #944) ─────────────────────────────────────
// `totalEstimatedSavings` used to be a blind reduce over every cost rec's
// `estSavingsUsd`. That double- (in practice quadruple-) counts a single priced
// pool — e.g. the ~$5,449 cache-read pool — whenever more than one detector
// claims it. `rollupReclaim` replaces that with a deduped, per-category rollup
// so each priced pool is counted at most once.

/** A deduped, per-category rollup of recoverable spend across recommendations. */
export interface ReclaimRollup {
  /** Total recoverable USD across every counted claim, after dedup. */
  total: number;
  /** Per-category recoverable USD, after dedup. Sparse: only categories that
   *  contributed a non-zero claim appear. */
  byCategory: Partial<Record<RecCategoryT, number>>;
  // Forward-compat seam (#944): the repriced `totalBill` denominator that lets a
  // downstream consumer compute coverage = total / totalBill is intentionally
  // NOT set here — it is not derivable from `recs` alone (it comes from the
  // token-cost side, not the recommendation list). The PR1 `ReclaimClaim`
  // cascade will supply it through this same rollup without changing `total`/
  // `byCategory`. Kept off the interface until that data source is wired so we
  // don't ship a field that is always 0.
}

// Local alias so the rollup can name the category type without forcing every
// importer of this module to also import RecCategory from ./detectors/types.
type RecCategoryT = Recommendation['category'];

/**
 * Canonical dedup key for a recommendation's reclaim claim.
 *
 * Two detectors that price the *same* recoverable pool must collapse to one
 * claim, or the pool is summed twice. We key on the claim's pool identity, most
 * specific signal first:
 *  1. `savingsAttribution.signatureId` — the explicit "machine-observable
 *     behaviour signature" id (see RecommendationSavingsAttribution). When two
 *     detectors describe the same underlying pool they share this id, so it is
 *     the precise pool key.
 *  2. `savingsAttribution.interventionKey` — the stable intervention id, when a
 *     signature is absent but an intervention key is present.
 *  3. the rule `id` — the fallback for the common case of a detector with no
 *     attribution metadata, where one rule == one independent pool.
 * The key is namespaced by source so a bare rule id can never accidentally
 * collide with a signatureId/interventionKey that happens to share its string.
 */
function reclaimKey(rec: Recommendation): string {
  const sig = rec.savingsAttribution?.signatureId;
  if (sig) return `sig:${sig}`;
  const intervention = rec.savingsAttribution?.interventionKey;
  if (intervention) return `int:${intervention}`;
  return `id:${rec.id}`;
}

/** Recs that carry a recoverable-spend claim we roll up. Mirrors the historical
 *  `totalEstimatedSavings` scope: cost-category, excluding descriptive audit
 *  findings that surface spend, not an independently additive reclaim pool. */
function carriesReclaim(rec: Recommendation): boolean {
  return (
    rec.category === 'cost' &&
    rec.id !== 'cost.expensive-sessions' &&
    rec.id !== 'cost.cache-economics'
  );
}

/**
 * Deduped, per-category rollup of recoverable spend.
 *
 * Claims are grouped by {@link reclaimKey}; within a group only the largest
 * `estSavingsUsd` is kept (the others are taken to be re-views of the same
 * priced pool, not additive). Each surviving claim contributes once to `total`
 * and once to its category bucket in `byCategory`.
 *
 * This is the seam the v0.x `ReclaimClaim` cascade repoints onto: it stays
 * intentionally minimal (no new fields on `Recommendation`, no I/O) and
 * forward-compatible — a richer claim contract can replace the `{ key, usd,
 * category }` tuple below without changing this function's shape.
 */
export function rollupReclaim(recs: Recommendation[]): ReclaimRollup {
  // Collapse all claims sharing a key to a single max-valued claim.
  const byKey = new Map<string, { usd: number; category: RecCategoryT }>();
  for (const rec of recs) {
    if (!carriesReclaim(rec)) continue;
    const usd = rec.estSavingsUsd ?? 0;
    if (usd <= 0) continue;
    const key = reclaimKey(rec);
    const prior = byKey.get(key);
    // Keep the larger estimate for the pool; categories agree within a key
    // here (all `cost`), but we retain the kept claim's own category so a
    // future multi-category scope stays correct.
    if (!prior || usd > prior.usd) byKey.set(key, { usd, category: rec.category });
  }

  let total = 0;
  const byCategory: Partial<Record<RecCategoryT, number>> = {};
  for (const { usd, category } of byKey.values()) {
    total += usd;
    byCategory[category] = (byCategory[category] ?? 0) + usd;
  }
  return { total, byCategory };
}

/**
 * Total quantified, recoverable spend across all cost recommendations.
 *
 * Back-compat shim retained for legacy callers (`Recommendations.tsx`): it now
 * derives from {@link rollupReclaim} so the same pool is never counted twice.
 * Where the old blind reduce over-counted overlapping detectors, this returns
 * the deduped figure; for non-overlapping inputs (one claim per pool) it equals
 * the old sum.
 */
export function totalEstimatedSavings(recs: Recommendation[]): number {
  return rollupReclaim(recs).total;
}

// ── Guarded-marginal cascade rollup (#947, epic #944) ────────────────────
// The #946 `rollupReclaim` above is a dedup *heuristic* over each rec's flat
// `estSavingsUsd`. PR1 repoints onto the real accounting model from
// `docs/v0.3-efficiency-accounting.md` §4: detectors emit a structured
// {@link ReclaimClaim} (on `rec.reclaim`), and the cascade books each claim's
// marginal against the actual per-`(scopeKey,pool)` token residual matrix so the
// identity `sum(marginal) ≡ billOriginal − billFinal` holds and overflow is
// structurally impossible. This carries the repriced `totalBill` denominator the
// coverage gauge needs — something `rollupReclaim(recs)` cannot derive from the
// rec list alone.

/** The claims a rec list carries, in stable rec order. */
function reclaimClaims(recs: Recommendation[]): ReclaimClaim[] {
  const claims: ReclaimClaim[] = [];
  for (const rec of recs) if (rec.reclaim) claims.push(rec.reclaim);
  return claims;
}

/**
 * Run the guarded-marginal cascade over the claims a rec list carries, against
 * the actual token usage. Returns the full cascade result (`billOriginal`,
 * `billFinal`, `total`, per-category split, and the per-claim bookings) so a
 * caller can both roll up dollars and back-fill each rec's `estSavingsUsd`.
 */
export function reclaimCascade(
  recs: Recommendation[],
  tokenData: SessionTokenData[],
  onReject?: (msg: string) => void
): ReclaimCascadeResult {
  return runReclaimCascade(reclaimClaims(recs), tokenData, onReject);
}

/**
 * Deduped, overflow-proof reclaim rollup with the repriced `totalBill`
 * denominator — the cascade replacement for {@link rollupReclaim}. Use this when
 * the actual `tokenData` is available (the engine input always has it).
 */
export function rollupReclaimCascade(
  recs: Recommendation[],
  tokenData: SessionTokenData[]
): ReclaimRollupWithBill {
  return rollupCascade(reclaimCascade(recs, tokenData));
}

/**
 * Back-fill each rec's `estSavingsUsd` from its booked cascade marginal so the
 * per-card dollar figure equals the lever's disjoint slice (not its raw,
 * possibly-overlapping estimate). Recs without a claim, or whose claim was
 * rejected, are returned unchanged. Returns a NEW array; inputs are not mutated.
 */
export function backfillReclaimSavings(
  recs: Recommendation[],
  tokenData: SessionTokenData[]
): Recommendation[] {
  const result = reclaimCascade(recs, tokenData);
  const booked = new Map(result.booked.map((b) => [b.leverId, b]));
  return recs.map((rec) => {
    if (!rec.reclaim) return rec;
    const b = booked.get(rec.reclaim.leverId);
    if (!b || b.rejected) return rec;
    return { ...rec, estSavingsUsd: b.marginalUsd };
  });
}

// ── Per-project attribution (#330) ──────────────────────────────────────
// Recommendations are computed globally; their `evidence` rows lead with a
// `short(sessionId)` (the first 8 chars — see `short` below). We attribute a
// rec to the project(s) of the sessions behind its evidence by indexing those
// 8-char prefixes back to `session.project`. Evidence rows that aren't
// session-ids (permission patterns, tool categories, …) simply don't resolve
// and contribute no project. This keeps the global engine untouched: attribution
// happens only when a caller asks for a project-scoped slice, so the unfiltered
// output is byte-identical to pre-#330.

/** Index `short(sessionId)` (8-char prefix) → one proven project identity.
 * Session metadata and token rows share the detector's arbitration contract:
 * invalid spellings yield to a valid fallback, valid conflicts fail closed,
 * and conflicting 8-character prefixes are omitted rather than overwritten. */
export function buildSessionProjectIndex(
  sessions: Pick<Session, 'sessionId' | 'project'>[],
  tokenData: Pick<SessionTokenData, 'sessionId' | 'project'>[] = []
): Map<string, string> {
  const index = new Map<string, string>();
  const observations = [...sessions, ...tokenData];
  const sessionIdsByPrefix = new Map<string, Set<string>>();
  for (const { sessionId } of observations) {
    if (!sessionId) continue;
    const prefix = short(sessionId);
    const sessionIds = sessionIdsByPrefix.get(prefix) ?? new Set<string>();
    sessionIds.add(sessionId);
    sessionIdsByPrefix.set(prefix, sessionIds);
  }
  const resolved = resolveProjectBySession(observations);
  for (const [prefix, sessionIds] of sessionIdsByPrefix) {
    const projects = [...sessionIds].map((sessionId) =>
      resolved.get(sessionId)
    );
    // Evidence carries only the eight-character prefix. Every observed full id
    // under it must resolve, and every resolved identity must agree; otherwise
    // the evidence token cannot prove which project owns the finding.
    if (projects.some((project) => project == null)) continue;
    const identities = new Set(
      projects.map((project) => projectIdentityKey(project!))
    );
    if (identities.size !== 1 || identities.has(null)) continue;
    index.set(prefix, projects[0]!);
  }
  return index;
}

/**
 * Projects a rec is attributable to, from the short session-ids leading its
 * evidence rows. Each row's first whitespace/comma-delimited token is matched
 * against the index; non-session-id leads resolve to nothing. Deduped, order
 * of first appearance.
 */
export function recommendationProjects(
  rec: Recommendation,
  index: Map<string, string>
): string[] {
  const out = new Set<string>();
  for (const row of rec.evidence ?? []) {
    const token = row.split(/[\s,]/, 1)[0]?.trim();
    if (token) {
      const project = index.get(token);
      if (project) out.add(project);
    }
  }
  return [...out];
}

/**
 * Filter recs to those attributable to `project`. Recs whose evidence maps to
 * no project (or a different one) are dropped. The returned recs carry a
 * populated `projects` field so the consumer sees the attribution; callers that
 * want the global list simply skip this function (see #330 back-compat).
 */
export function filterRecommendationsByProject(
  recs: Recommendation[],
  project: string,
  sessions: Pick<Session, 'sessionId' | 'project'>[],
  tokenData: Pick<SessionTokenData, 'sessionId' | 'project'>[] = []
): Recommendation[] {
  const index = buildSessionProjectIndex(sessions, tokenData);
  const out: Recommendation[] = [];
  for (const rec of recs) {
    const projects = recommendationProjects(rec, index);
    if (projects.some((candidate) => sameProjectIdentity(candidate, project))) {
      out.push({ ...rec, projects });
    }
  }
  return out;
}
