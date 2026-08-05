/**
 * Recommendation provenance contract (#1049, epic #866 keystone).
 *
 * The auditability contract says every recommendation must let a reader
 * separate what was *observed* (each fact citing its artifact), what was
 * *inferred*, and what is *proposed* (the `fix`), and must reproduce the count
 * without reverse-engineering the detector. {@link RecProvenance} carries that
 * structure; the repository-wide validator now lives in
 * `../claim-provenance` so detector and non-detector claims are judged by the
 * same contract. This module owns detector coverage/exemptions and re-exports
 * the shared validation entry points under their established names.
 *
 * Deliberately dependency-light (imports only the leaf types) so it can sit
 * anywhere in the detector import graph without a cycle.
 */
import type {
  Recommendation,
  RecommendationSavingsAttribution,
} from './types';
import {
  isClaimCalendarDate,
  validateClaimObservation,
  validateClaimProvenance,
} from '../claim-provenance';

/**
 * Rec ids that have NOT yet adopted the provenance contract — the debt
 * register, and the ONLY way to emit a recommendation without provenance
 * (#3205).
 *
 * ## Why this is a deny-list and not an allowlist
 *
 * Until #3205 the contract worked the other way round: `PROVENANCE_DETECTORS`
 * was an opt-in allowlist, and {@link validateRecommendationProvenance} treated
 * every id NOT on it as compliant. So the default for a new detector was
 * "exempt", and adoption depended on an author remembering to enlist. Measured
 * at the flip: 33 detectors were enlisted, 52 emitted nothing — and 17 more
 * emitted perfectly good provenance while sitting OUTSIDE the allowlist, which
 * means the list's own promise ("a detector can never silently regress off the
 * contract") did not hold for a third of the detectors that had adopted it.
 * That is the mechanism behind ~29 separate v0.6 audit findings, so the fix is
 * to invert the default rather than to enlist 29 more ids.
 *
 * Now: provenance is REQUIRED for every emitted recommendation, and this list
 * is the explicit, reviewed, SHRINK-ONLY set of ids still owed one. A new
 * detector is on the contract by construction — there is no line it can fail to
 * add itself to.
 *
 * ## Rules
 *
 *  - **Shrink-only.** Ids leave as they migrate; nothing may be added. The
 *    contract test pins the length, so growing it is a deliberate, visible
 *    edit rather than a silent regression. (Same standing as the tracked
 *    exception list in `scripts/check-shell-quote.mjs`.)
 *  - **Emitted ids, not detector ids.** A dual-emit detector reaches this list
 *    once per branch it can emit (see `dual-emit.ts`), because the reader of a
 *    `reliability.rate-limits` card cares whether THAT card is auditable.
 *  - Every id here must be really emittable by the catalog, so the list cannot
 *    rot past a rename.
 *
 * Removing an id is the whole of a migration: make the detector emit
 * provenance, delete its line here, and the contract test (fixture harness +
 * sample-corpus sweep) proves it.
 */
export const PROVENANCE_EXEMPT: readonly string[] = [
  'context.over-scoped-config-section',
  'cost.cache-1h-waste',
  'reliability.hook-prevented-continuation',
  'reliability.mcp-needs-auth',
  'safety.allow-rule-overlaps-deny',
  'speed.time-motion',
  'workflow.unused-installed-commands',
  'workflow.unused-installed-plugins',
  'workflow.unused-installed-skills',
  'workflow.unused-installed-subagents',
];

/**
 * Detectors proven compliant by a TRIGGER FIXTURE — the strongest tier of the
 * contract, and a strict subset of the required set.
 *
 * Since #3205 this list no longer decides WHO owes provenance (that is
 * "everything not in {@link PROVENANCE_EXEMPT}"). It records which detectors are
 * proven to emit valid provenance by actually running them: the contract test
 * fires each one through a fixture and validates what comes out. Absence from
 * this list is not an exemption — it only means the proof is weaker (the
 * sample-corpus sweep, or the detector's own suite).
 */
export const PROVENANCE_DETECTORS: readonly string[] = [
  'activity.activity-trend',
  'activity.stale-projects',
  'context.bloated-claude-md',
  'context.compaction-hot-sessions',
  'context.compaction-large-tool-outputs',
  'context.low-cache-hit',
  'context.low-health',
  'context.over-window',
  'context.repeated-compactions',
  'context.repo-map-context-waste',
  'reliability.hook-errors',
  'safety.dangerous-bypass',
  'speed.hook-overhead',
  'cost.idle-mcp-tools',
  'cost.automation-share',
  'workflow.review-bottleneck',
  'workflow.native-bypass',
  'workflow.shadow-prompt',
  'cost.model-eval-routing-gap',
  'context.cross-session-reread',
  'reliability.passive-wait-stall',
  'workflow.conversational-availability',
  'workflow.reclaim-wait-windows',
  'reliability.cwd-drift-execution',
  'reliability.stale-state-assertion',
  'context.last-n-runs-audit',
  'context.reclaim-potential',
  'maintenance.memory-hygiene',
  'maintenance.doc-hygiene',
  'maintenance.skill-hook-integrity',
  'reliability.discovery-freshness',
  'reliability.ghost-session',
  'reliability.settings-json-invalid',
  'reliability.workflow-ratelimit-burst',
  'workflow.procedural-memory',
  'workflow.human-input-leverage',
  'workflow.value-of-agent-handoff',
  'workflow.session-restart-retype',
  'security.secrets-at-rest',
  'cost.edit-format-churn',
  'cost.local-downroute',
  'safety.deny-rule-never-triggered',
  'reliability.agent-report-card',
  'reliability.api-errors',
  'reliability.config-drift',
  // #3208/#3216/#3217 — the reliability provenance/freshness batch.
  'reliability.dropped-assignments',
  'reliability.retry-prefix-rewaste',
  'reliability.retry-storms',
  'reliability.self-update-health',
  'reliability.tool-errors',
  // #3232 — the workflow batch, each proven by a trigger fixture below.
  'workflow.abandoned-tasks',
  'workflow.assistant-refusal-rate',
  'workflow.blocked-task-pileup',
  'workflow.churn-geometry',
  'workflow.correction-mining',
  'workflow.failed-workflow-runs',
  'workflow.file-churn',
  // #3241 — acceptance explicitly requires a firing trigger fixture.
  'workflow.prompt-clarity',
  // #3242 — the remaining workflow provenance batch, each fixture-proven below.
  'workflow.redundant-reads',
  'workflow.repeated-commands',
  'workflow.rework-signature',
  'workflow.runaway-workflow-cost',
  // #3246 — the generic adopt-axis path; #3248 — the uncovered-axis discovery.
  'workflow.shadow-axis-wins',
  'workflow.uncovered-shadow-axis',
  // #3194/#3201/#3508 — the round-10 cost provenance batch, each fixture-proven.
  'cost.disproportionate-thinking',
  'cost.expensive-agent-type',
  'cost.expensive-sessions',
  'cost.legacy-model-overpay',
  'cost.priority-tier-spend',
  'cost.unknown-model',
  'cost.web-search-spend',
  // #3224/#3226/#3227/#3247 — round-14 structured-provenance batch.
  'safety.prompt-friction',
  'security.model-deceit',
  'speed.model-latency',
  'workflow.tool-undo-rate',
  // #3393 — the flag-gated git delivery-outcome consumer. The sample-corpus
  // sweep can never cover it (`gitOutcomes` is empty without CHD_GIT_OUTCOMES),
  // so the trigger fixture is the ONLY proof available and is mandatory here.
  'reliability.post-shipment-rework',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True when an ISO `YYYY-MM-DD` `asOf` date is older than `thresholdDays`
 * relative to `now` (ms). The generic #1102 freshness test, extracted here so
 * every detector demotes a time-derived claim against the SAME rule (the module
 * is already the single source of truth for the `asOf`/`stale` contract).
 *
 * A missing or malformed `asOf` returns `false`: we can only demote against a
 * date we can read — this mirrors the contract that `stale=true` requires an
 * `asOf`, so an undatable claim is never silently flagged stale.
 */
export function isAsOfStale(
  asOf: string | undefined,
  now: number,
  thresholdDays: number
): boolean {
  // Same readability rule the validator applies (#3204) — an impossible date is
  // no more demotable than a malformed one, and two derivations of "is this
  // date readable" would drift.
  if (asOf === undefined || !isClaimCalendarDate(asOf)) return false;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return false;
  return now - asOfMs > thresholdDays * DAY_MS;
}

/**
 * Demote a stale savings attribution (#2142, reusing the #1102 stale-input
 * demotion path). A MEASURED proof (`tier-1-before-after` / `tier-2-ablation`)
 * whose {@link RecommendationSavingsAttribution.asOf} is older than
 * `thresholdDays` can no longer be asserted as current confidence — model
 * versions have moved since it was observed — so it is demoted to a dated
 * estimate: the identity (`interventionKey`/`signatureId`), the predicted
 * figure, the sample size, and the `asOf` are kept, but the measured-confidence
 * fields (`tier` is reset to `tier-0-estimate`; `confidence`,
 * `realizedSavingsUsd`, `judgeAgreement`, and `window` are dropped) and `stale`
 * is set so a renderer shows "as of <date>" rather than a live claim.
 *
 * A `tier-0-estimate` is already honest, and an attribution with no readable
 * `asOf` cannot be judged stale — both are returned unchanged. Pure data
 * transform (leaf-type only) so server, SPA, and tests can reuse it.
 */
export function demoteStaleAttribution(
  attr: RecommendationSavingsAttribution,
  now: number,
  thresholdDays: number
): RecommendationSavingsAttribution {
  if (attr.tier === 'tier-0-estimate') return attr;
  if (!isAsOfStale(attr.asOf, now, thresholdDays)) return attr;
  const demoted: RecommendationSavingsAttribution = {
    interventionKey: attr.interventionKey,
    signatureId: attr.signatureId,
    tier: 'tier-0-estimate',
    stale: true,
  };
  if (attr.predictedSavingsUsd !== undefined) {
    demoted.predictedSavingsUsd = attr.predictedSavingsUsd;
  }
  if (attr.sampleSize !== undefined) demoted.sampleSize = attr.sampleSize;
  if (attr.asOf !== undefined) demoted.asOf = attr.asOf;
  return demoted;
}

/** Detector API aliases for the repository-wide claim-provenance validator. */
export const validateRecObservation = validateClaimObservation;
export const validateRecProvenance = validateClaimProvenance;

/**
 * Validate a recommendation against the provenance contract (#3205).
 *
 * - If the recommendation carries `provenance`, its shape must be valid.
 * - Otherwise it MUST be on {@link PROVENANCE_EXEMPT}. Provenance is required by
 *   default; the exemption is the only way out, and it is a shrink-only register.
 *
 * Returns errors (empty ⇒ compliant). The inverted default is the point: before
 * #3205 an unrecognised id passed silently, so a recommendation could make a
 * quantitative claim with nothing behind it purely by never enlisting.
 */
export function validateRecommendationProvenance(rec: Recommendation): string[] {
  const errs: string[] = [];
  if (rec.provenance) {
    errs.push(...validateRecProvenance(rec.provenance));
  } else if (!PROVENANCE_EXEMPT.includes(rec.id)) {
    errs.push(
      `${rec.id} emitted no provenance. Every recommendation must cite what was ` +
        `observed (artifact + field), what was inferred, and as of when. If this ` +
        `id genuinely cannot yet, add it to PROVENANCE_EXEMPT with a reason — ` +
        `note that the list is shrink-only and pinned by the contract test.`
    );
  }
  return errs;
}
