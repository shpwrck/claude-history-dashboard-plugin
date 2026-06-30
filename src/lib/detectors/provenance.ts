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
import type { RecProvenance, RecObservation, Recommendation } from './types';

/**
 * Detectors that have adopted the provenance contract and MUST emit a
 * well-formed {@link RecProvenance} whenever they fire. The provenance contract
 * test enforces this allowlist, and the sibling slices (#1101–#1105) append
 * their detector ids here as they migrate. Keeping it explicit means a detector
 * can never silently regress off the contract, and an id that leaves the
 * registry trips the test rather than rotting unnoticed.
 */
export const PROVENANCE_DETECTORS: readonly string[] = [
  'activity.activity-trend',
  'reliability.hook-errors',
  'cost.idle-mcp-tools',
  'workflow.review-bottleneck',
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
];

/** ISO `YYYY-MM-DD`. Intentionally strict so a timestamp or garbage is rejected. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a single observation. Returns a list of human-readable errors
 * (empty ⇒ valid). An observation must state a non-empty `claim` and cite a
 * non-empty `source`; `field` and `value` are optional but, when present, must
 * be the right shape.
 */
export function validateRecObservation(obs: RecObservation, idx = 0): string[] {
  const errs: string[] = [];
  const at = `observations[${idx}]`;
  if (!isNonEmptyString(obs?.claim)) errs.push(`${at}.claim must be a non-empty string`);
  if (!isNonEmptyString(obs?.source)) errs.push(`${at}.source must cite a non-empty artifact/parser`);
  if (obs?.field !== undefined && !isNonEmptyString(obs.field)) {
    errs.push(`${at}.field, when present, must be a non-empty string`);
  }
  if (
    obs?.value !== undefined &&
    !(typeof obs.value === 'string' || (typeof obs.value === 'number' && Number.isFinite(obs.value)))
  ) {
    errs.push(`${at}.value, when present, must be a string or a finite number`);
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
  if (p.asOf !== undefined && !ISO_DATE.test(p.asOf)) {
    errs.push(`provenance.asOf, when present, must be an ISO YYYY-MM-DD date (got ${JSON.stringify(p.asOf)})`);
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
 * Validate a recommendation against the provenance contract.
 *
 * - If the recommendation carries `provenance`, its shape must be valid.
 * - If the recommendation's id is on {@link PROVENANCE_DETECTORS}, it MUST
 *   carry provenance (a migrated detector that fired without it is a regression).
 *
 * Returns errors (empty ⇒ compliant). Recommendations not on the allowlist and
 * without provenance are compliant — adoption is incremental by design.
 */
export function validateRecommendationProvenance(rec: Recommendation): string[] {
  const errs: string[] = [];
  if (rec.provenance) errs.push(...validateRecProvenance(rec.provenance));
  if (PROVENANCE_DETECTORS.includes(rec.id) && !rec.provenance) {
    errs.push(`${rec.id} is on the provenance allowlist but emitted no provenance`);
  }
  return errs;
}
