/**
 * Dependency-free provenance contract for every trust-bearing claim surface.
 *
 * Recommendation detectors were the first consumer, but report cards, review
 * queues, historical estimates, and network envelopes also emit claims that an
 * auditor must be able to reproduce. Keeping the shape and runtime validator in
 * this narrow module prevents those surfaces from inventing weaker lookalike
 * contracts.
 */
import { isCanonicalIsoInstant } from './iso-instant';

export { isCanonicalIsoInstant as isClaimCanonicalInstant };

export type ClaimScalar = string | number | boolean;

/** One directly observed value, located at an artifact record and field. */
export interface ClaimObservation {
  /** Optional stable key used by derivations and surface-specific tests. */
  id?: string;
  /** Observation only — conclusions belong in `inference`. */
  claim: string;
  /** Artifact or parser that supplied the value. */
  source: string;
  /** Row/session/record key within the source when the source has many rows. */
  record?: string;
  /** Parsed field or path within the source. */
  field?: string;
  /** Reproducible scalar behind the claim. */
  value?: ClaimScalar;
}

/**
 * A named calculation over observed operands.
 *
 * `operands` deliberately carries the actual scalars rather than opaque prose:
 * a consumer can recompute `value` from `formula` without reaching back into
 * implementation-only state.
 */
export interface ClaimDerivation {
  id: string;
  formula: string;
  operands: Record<string, ClaimScalar>;
  value: ClaimScalar;
}

/** Observation / derivation / inference split shared by all claim surfaces. */
export interface ClaimProvenance {
  observations: ClaimObservation[];
  derivations?: ClaimDerivation[];
  inference?: string;
  /** Canonical ISO instant at which an otherwise mutable source was captured. */
  capturedAt?: string;
  /** ISO `YYYY-MM-DD` date of the underlying data. */
  asOf?: string;
  /** A stale claim can only be demoted against a readable `asOf` date. */
  stale?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLAIM_STATES_A_FIGURE = /\d/;

export function isClaimCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const epochMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epochMs)) return false;
  return new Date(epochMs).toISOString().slice(0, 10) === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isClaimScalar(value: unknown): value is ClaimScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

export function validateClaimObservation(
  value: unknown,
  index = 0
): string[] {
  const observation =
    value && typeof value === 'object'
      ? (value as Partial<ClaimObservation>)
      : undefined;
  const errors: string[] = [];
  const at = `observations[${index}]`;

  if (!isNonEmptyString(observation?.claim)) {
    errors.push(`${at}.claim must be a non-empty string`);
  }
  if (!isNonEmptyString(observation?.source)) {
    errors.push(`${at}.source must cite a non-empty artifact/parser`);
  }
  if (!isNonEmptyString(observation?.field)) {
    errors.push(
      `${at}.field must name the field within ${JSON.stringify(
        observation?.source ?? '(no source)'
      )} that this claim was read from — a source-only citation cannot be located`
    );
  }
  if (
    observation?.id !== undefined &&
    !isNonEmptyString(observation.id)
  ) {
    errors.push(`${at}.id, when present, must be a non-empty string`);
  }
  if (
    observation?.record !== undefined &&
    !isNonEmptyString(observation.record)
  ) {
    errors.push(`${at}.record, when present, must be a non-empty string`);
  }
  if (
    observation?.value !== undefined &&
    !isClaimScalar(observation.value)
  ) {
    errors.push(
      `${at}.value, when present, must be a string, boolean, or finite number`
    );
  }
  if (
    observation?.value === undefined &&
    isNonEmptyString(observation?.claim) &&
    CLAIM_STATES_A_FIGURE.test(observation.claim)
  ) {
    errors.push(
      `${at}.claim states a figure (${JSON.stringify(
        observation.claim
      )}) so it must carry the scalar \`value\` it was computed from — ` +
        'otherwise the number cannot be reproduced without re-deriving the claim'
    );
  }
  return errors;
}

export function validateClaimDerivation(
  value: unknown,
  index = 0
): string[] {
  const derivation =
    value && typeof value === 'object'
      ? (value as Partial<ClaimDerivation>)
      : undefined;
  const errors: string[] = [];
  const at = `derivations[${index}]`;

  if (!isNonEmptyString(derivation?.id)) {
    errors.push(`${at}.id must be a non-empty string`);
  }
  if (!isNonEmptyString(derivation?.formula)) {
    errors.push(`${at}.formula must be a non-empty string`);
  }
  if (!isClaimScalar(derivation?.value)) {
    errors.push(`${at}.value must be a string, boolean, or finite number`);
  }
  if (
    !derivation?.operands ||
    typeof derivation.operands !== 'object' ||
    Array.isArray(derivation.operands) ||
    Object.keys(derivation.operands).length === 0
  ) {
    errors.push(`${at}.operands must be a non-empty scalar record`);
  } else {
    for (const [name, operand] of Object.entries(derivation.operands)) {
      if (!isNonEmptyString(name) || !isClaimScalar(operand)) {
        errors.push(`${at}.operands must contain named finite scalars`);
        break;
      }
    }
  }
  return errors;
}

export function validateClaimProvenance(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['provenance must be an object'];
  }
  const provenance = value as Partial<ClaimProvenance>;
  const errors: string[] = [];

  if (
    !Array.isArray(provenance.observations) ||
    provenance.observations.length === 0
  ) {
    errors.push('provenance.observations must be a non-empty array');
  } else {
    provenance.observations.forEach((observation, index) => {
      errors.push(...validateClaimObservation(observation, index));
    });
  }

  if (provenance.derivations !== undefined) {
    if (
      !Array.isArray(provenance.derivations) ||
      provenance.derivations.length === 0
    ) {
      errors.push(
        'provenance.derivations, when present, must be a non-empty array'
      );
    } else {
      provenance.derivations.forEach((derivation, index) => {
        errors.push(...validateClaimDerivation(derivation, index));
      });
      const ids = provenance.derivations
        .map((derivation) => derivation?.id)
        .filter(isNonEmptyString);
      if (new Set(ids).size !== ids.length) {
        errors.push('provenance.derivations ids must be unique');
      }
    }
  }

  if (
    provenance.inference !== undefined &&
    !isNonEmptyString(provenance.inference)
  ) {
    errors.push(
      'provenance.inference, when present, must be a non-empty string'
    );
  }
  if (
    provenance.capturedAt !== undefined &&
    !isCanonicalIsoInstant(provenance.capturedAt)
  ) {
    errors.push(
      'provenance.capturedAt, when present, must be a canonical ISO instant'
    );
  }
  if (
    provenance.asOf !== undefined &&
    (!isNonEmptyString(provenance.asOf) ||
      !isClaimCalendarDate(provenance.asOf))
  ) {
    errors.push(
      'provenance.asOf, when present, must be a real ISO YYYY-MM-DD ' +
        `calendar date (got ${JSON.stringify(provenance.asOf)})`
    );
  }
  if (
    provenance.stale !== undefined &&
    typeof provenance.stale !== 'boolean'
  ) {
    errors.push('provenance.stale, when present, must be a boolean');
  }
  if (provenance.stale === true && provenance.asOf === undefined) {
    errors.push(
      'provenance.stale=true requires an asOf date to demote wording against'
    );
  }
  return errors;
}

export function isClaimProvenance(value: unknown): value is ClaimProvenance {
  return validateClaimProvenance(value).length === 0;
}
