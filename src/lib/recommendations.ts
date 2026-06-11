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

// ── Recommendation types ─────────────────────────────────────────────────
// Defined in ./detectors/types and re-exported here so existing importers
// (`from './recommendations'`) keep working unchanged.
import type { Recommendation, RecommendationInput } from './detectors/types';
import type { SessionTokenData } from '../types';
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
import { DETECTORS } from './detectors';
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
export function assembleRecommendationInput(
  v: RecommendationViews
): RecommendationInput {
  // Pass every field through, normalising only the two optionals the engine
  // treats "absent" as "filter nothing" (liveConfig #166, assistantFeatures
  // #206). Spreading rather than re-listing each field means a NEW
  // detector-consumed signal added to {@link RecommendationInput} and supplied
  // by the caller flows through here automatically — no edit to this mapper.
  // (#524 slice 3: the ingest caller supplies the signal-derived fields straight
  // from the signal descriptor's datasetKeys.)
  const normalized: RecommendationInput = {
    ...v,
    liveConfig: v.liveConfig ?? null,
    assistantFeatures: v.assistantFeatures ?? null,
  };
  if ('modelPinSavings' in v) return normalized;

  const derivedModelPinSavings = deriveModelPinSavingsConfig({
    tokenData: v.tokenData,
  });
  return derivedModelPinSavings
    ? { ...normalized, modelPinSavings: derivedModelPinSavings }
    : normalized;
}

const buildCache: WeakMap<RecommendationInput, Recommendation[]> = new WeakMap();

/**
 * Run every detector and return the surviving recommendations, ranked by
 * severity, then by estimated dollar impact, then by affected count.
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
 * Skip cache when the caller pins `now` — those calls are time-keyed.
 */
export function buildRecommendations(
  input: RecommendationInput,
  now?: number
): Recommendation[] {
  const useCache = now === undefined;
  if (useCache) {
    const cached = buildCache.get(input);
    if (cached) return cached;
  }
  const t = now ?? Date.now();
  const recs: Recommendation[] = [];
  for (const d of DETECTORS) {
    const r = d.rule(input, t);
    if (r) recs.push(r);
  }
  const sorted = recs.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const savings = (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0);
    if (savings !== 0) return savings;
    return (b.affected ?? 0) - (a.affected ?? 0);
  });
  if (useCache) buildCache.set(input, sorted);
  return sorted;
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

/** Index `short(sessionId)` (8-char prefix) → project path for every session. */
export function buildSessionProjectIndex(
  sessions: Pick<Session, 'sessionId' | 'project'>[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const s of sessions) index.set(short(s.sessionId), s.project);
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
  sessions: Pick<Session, 'sessionId' | 'project'>[]
): Recommendation[] {
  const index = buildSessionProjectIndex(sessions);
  const out: Recommendation[] = [];
  for (const rec of recs) {
    const projects = recommendationProjects(rec, index);
    if (projects.includes(project)) out.push({ ...rec, projects });
  }
  return out;
}
