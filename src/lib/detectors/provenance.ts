/**
 * Recommendation provenance contract (#1049, epic #866 keystone).
 *
 * The auditability contract says every recommendation must let a reader
 * separate what was *observed* (each fact citing its artifact), what was
 * *inferred*, and what is *proposed* (the `fix`), and must reproduce the count
 * without reverse-engineering the detector. {@link RecProvenance} carries that
 * structure; this module is its single source of validation truth so the
 * detectors, the contract test, and CI all judge it the same way.
 *
 * Deliberately dependency-light (imports only the leaf types) so it can sit
 * anywhere in the detector import graph without a cycle.
 */
import type {
  RecProvenance,
  RecObservation,
  Recommendation,
  RecommendationSavingsAttribution,
} from './types';

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
  'cost.disproportionate-thinking',
  'cost.expensive-agent-type',
  'cost.expensive-sessions',
  'cost.legacy-model-overpay',
  'cost.priority-tier-spend',
  'cost.unknown-model',
  'cost.web-search-spend',
  'reliability.hook-prevented-continuation',
  'reliability.mcp-needs-auth',
  'reliability.overload-reretry',
  'safety.allow-rule-overlaps-deny',
  'safety.prompt-friction',
  'security.model-deceit',
  'speed.model-latency',
  'speed.time-motion',
  'workflow.harmful-habit',
  'workflow.low-tool-effectiveness',
  'workflow.plan-missing-verification',
  'workflow.prompt-clarity',
  'workflow.redundant-reads',
  'workflow.repeated-commands',
  'workflow.rework-signature',
  'workflow.runaway-workflow-cost',
  'workflow.tool-undo-rate',
  'workflow.uncovered-shadow-axis',
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
];

/** ISO `YYYY-MM-DD`. Intentionally strict so a timestamp or garbage is rejected. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True when `v` is a real Gregorian calendar date written `YYYY-MM-DD` (#3204).
 *
 * The shape regex alone accepts impossible dates — `2026-99-99` and
 * `2026-02-30` are both four-two-two digits — and an `asOf` that never happened
 * cannot anchor a claim in time. Parsing is not enough on its own either:
 * `Date.parse('2026-02-30T00:00:00.000Z')` does NOT fail, it rolls over to
 * March 2. So the check is a ROUND TRIP — parse it, format it back, and require
 * the same string. A rolled-over date fails because it comes back different.
 *
 * Consequently `2026-02-29` is rejected (2026 is not a leap year) while
 * `2024-02-29` is accepted, matching the calendar rather than the digit shape.
 */
function isCalendarDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === v;
}

/**
 * A claim that states a figure must carry the scalar it was computed from.
 *
 * Any digit makes a claim quantitative — "18 of 18 assignments unread" asserts
 * a number a reader must be able to reproduce without re-deriving the detector,
 * which is the whole point of the contract. A claim with no digit is
 * qualitative and has no figure to cite.
 */
const CLAIM_STATES_A_FIGURE = /\d/;

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
  if (asOf === undefined || !isCalendarDate(asOf)) return false;
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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a single observation. Returns a list of human-readable errors
 * (empty ⇒ valid).
 *
 * An observation must state a non-empty `claim`, cite a non-empty `source`, and
 * name the `field` within that source (#3204) — a citation a reader cannot
 * follow to a specific field is not reproducible, which is the failure the
 * contract exists to prevent.
 *
 * `value` is required only when the `claim` states a figure. This boundary is
 * measured, not assumed: at the time the rule landed, all 114 observations the
 * catalog emitted already carried `field` (so requiring it cost nothing), and
 * 107 carried `value`. Of the 7 that did not, 6 are qualitative and would have
 * had to invent a scalar to satisfy a blanket "always require value" rule:
 *
 *   "a Stop hook is currently configured"                        (existence)
 *   "current settings.json could not be read"                    (absence)
 *   "only git/gh (repo-resolving) ops are counted"               (scope note)
 *
 * Forcing a number onto those would trade a real auditability gain for
 * fabricated precision, so the rule keys on whether the claim actually asserts
 * a figure. The 7th DID state figures with nothing to check them against —
 * `workflow.shadow-prompt`'s "current 0 / stale 0 / revoked 0 / unknown 6"
 * proof-status breakdown — and was the one genuine defect this rule caught; it
 * now cites the tuple. That is the whole migration cost.
 */
export function validateRecObservation(obs: RecObservation, idx = 0): string[] {
  const errs: string[] = [];
  const at = `observations[${idx}]`;
  if (!isNonEmptyString(obs?.claim)) errs.push(`${at}.claim must be a non-empty string`);
  if (!isNonEmptyString(obs?.source)) errs.push(`${at}.source must cite a non-empty artifact/parser`);
  if (!isNonEmptyString(obs?.field)) {
    errs.push(
      `${at}.field must name the field within ${JSON.stringify(obs?.source ?? '(no source)')} ` +
        `that this claim was read from — a source-only citation cannot be located`
    );
  }
  if (
    obs?.value !== undefined &&
    !(typeof obs.value === 'string' || (typeof obs.value === 'number' && Number.isFinite(obs.value)))
  ) {
    errs.push(`${at}.value, when present, must be a string or a finite number`);
  }
  if (
    obs?.value === undefined &&
    isNonEmptyString(obs?.claim) &&
    CLAIM_STATES_A_FIGURE.test(obs.claim)
  ) {
    errs.push(
      `${at}.claim states a figure (${JSON.stringify(obs.claim)}) so it must carry the ` +
        `scalar \`value\` it was computed from — otherwise the number cannot be ` +
        `reproduced without re-deriving the detector`
    );
  }
  return errs;
}

/**
 * Validate a {@link RecProvenance} block. Returns a list of human-readable
 * errors (empty ⇒ valid). Rules:
 *  - `observations` is a non-empty array, each valid per {@link validateRecObservation};
 *  - `inference`, when present, is a non-empty string (kept distinct from observations);
 *  - `asOf`, when present, is an ISO `YYYY-MM-DD` date;
 *  - `stale`, when present, is a boolean, and may only be `true` alongside an `asOf`.
 */
export function validateRecProvenance(p: RecProvenance): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== 'object') return ['provenance must be an object'];
  if (!Array.isArray(p.observations) || p.observations.length === 0) {
    errs.push('provenance.observations must be a non-empty array');
  } else {
    p.observations.forEach((o, i) => errs.push(...validateRecObservation(o, i)));
  }
  if (p.inference !== undefined && !isNonEmptyString(p.inference)) {
    errs.push('provenance.inference, when present, must be a non-empty string');
  }
  if (p.asOf !== undefined && !isCalendarDate(p.asOf)) {
    errs.push(
      `provenance.asOf, when present, must be a real ISO YYYY-MM-DD calendar date ` +
        `(got ${JSON.stringify(p.asOf)})`
    );
  }
  if (p.stale !== undefined && typeof p.stale !== 'boolean') {
    errs.push('provenance.stale, when present, must be a boolean');
  }
  if (p.stale === true && p.asOf === undefined) {
    errs.push('provenance.stale=true requires an asOf date to demote wording against');
  }
  return errs;
}

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
