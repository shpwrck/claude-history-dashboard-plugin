/**
 * Parser for `~/.claude/.last-update-result.json` — CLI self-update outcomes (#566).
 *
 * The live artifact holds ONE record (the CLI overwrites it on every update), so the
 * dashboard's value-add is to capture each snapshot over time and pass the resulting array
 * to {@link analyzeUpdateHealth}. A single-element array is valid; the analyzer works on
 * 1..N results.
 *
 * NOTE: Snapshot history (append-on-change ingest) is a FUTURE ENHANCEMENT. Today, ingest
 * reads the file once and wraps the single result in a 1-element array before calling
 * analyzeUpdateHealth. When snapshot history is implemented, the array will grow and the
 * analysis will improve accordingly — no API change is required.
 *
 * Real artifact shape (redacted sample from the prototype):
 *   {"timestamp":"…","path":"npm-global","outcome":"success","status":"success",
 *    "version_from":"2.1.160","version_to":"2.1.161","error_code":null}
 */

/** The outcome recorded by the CLI after a self-update attempt. */
export type UpdateOutcome = 'success' | 'failure' | 'blocked' | string;

/**
 * One self-update attempt as written by the CLI to `.last-update-result.json`.
 * Fields mirror the real artifact; all optional so partial/future shapes survive.
 */
export interface UpdateResult {
  /** ISO 8601 timestamp of the attempt. */
  timestamp?: string;
  /** Install path context, e.g. "npm-global". */
  path?: string;
  /**
   * Primary outcome signal. The CLI writes both `outcome` and `status` with the
   * same value; we prefer `outcome` and fall back to `status`.
   */
  outcome?: UpdateOutcome;
  /** Redundant copy of `outcome` written by older CLI versions. */
  status?: UpdateOutcome;
  /** Semver string of the version before the update attempt. */
  version_from?: string;
  /** Semver string of the version after the update attempt (even if it failed). */
  version_to?: string;
  /** OS/npm error code on failure, e.g. "EACCES", "ENETUNREACH". Null on success. */
  error_code?: string | null;
}

// ---- helpers ---------------------------------------------------------------

const semverParts = (v: string | undefined): [number, number, number] => {
  const [maj = 0, min = 0, pat = 0] = (v ?? '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  return [maj, min, pat];
};

/** Crude "patch-equivalent bump count" between two semver strings. */
function patchBumpCount(from: string | undefined, to: string | undefined): number {
  const a = semverParts(from);
  const b = semverParts(to);
  let n = 0;
  for (let i = 0; i < 3; i++) n += Math.max(0, b[i] - a[i]);
  return n;
}

const effectiveOutcome = (r: UpdateResult): string =>
  (r.outcome ?? r.status ?? 'unknown').toLowerCase();

const isSuccess = (r: UpdateResult): boolean => effectiveOutcome(r) === 'success';

const MS_PER_DAY = 86_400_000;

// ---- public API ------------------------------------------------------------

/**
 * Parse a single `.last-update-result.json` file (as a raw string).
 * Returns `null` on empty/malformed input.
 */
export function parseLastUpdate(text: string): UpdateResult | null {
  if (!text || !text.trim()) return null;
  try {
    const obj: unknown = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as UpdateResult;
  } catch {
    return null;
  }
}

/** Grade letter derived from the update success rate. */
export type UpdateGrade = 'A' | 'B' | 'C' | 'D';

export interface UpdateHealthReport {
  /** Report-card grade (A/B/C/D). */
  grade: UpdateGrade;
  /** Fraction 0..1 of attempts that succeeded. */
  successRate: number;
  /** Total number of update records in the series. */
  total: number;
  /** Number of successful attempts. */
  successCount: number;
  /** Number of failed or blocked attempts. */
  failedCount: number;
  /**
   * Mean days between consecutive updates, or `null` when the series has fewer
   * than two records (no interval to measure).
   */
  cadenceDays: number | null;
  /**
   * Semver drift summary string, e.g. "2.1.140 -> 2.1.161 (21 patch bumps over 15d)".
   * `null` when the series is empty.
   */
  versionDrift: string | null;
  /**
   * Number of consecutive update pairs where the gap was under 1 hour — a
   * failed attempt retried immediately.
   */
  immediateRetries: number;
  /**
   * Distinct error codes from failed/blocked attempts, e.g. ["EACCES", "ENETUNREACH"].
   */
  errorCodes: string[];
}

/**
 * Derive a health report from a series of {@link UpdateResult} records.
 *
 * Works correctly on a 1-element array (the common case today, where ingest
 * reads the single live file). Richer analysis emerges once snapshot history
 * is implemented and the series grows.
 *
 * Returns a zeroed/`null`-cadence report for an empty array; callers (detectors)
 * should bail out early when `total === 0`.
 */
export function analyzeUpdateHealth(results: UpdateResult[]): UpdateHealthReport {
  if (results.length === 0) {
    return {
      grade: 'A',
      successRate: 1,
      total: 0,
      successCount: 0,
      failedCount: 0,
      cadenceDays: null,
      versionDrift: null,
      immediateRetries: 0,
      errorCodes: [],
    };
  }

  const sorted = [...results].sort((a, b) => {
    return Date.parse(a.timestamp ?? '0') - Date.parse(b.timestamp ?? '0');
  });

  const total = sorted.length;
  const successes = sorted.filter(isSuccess);
  const failures = sorted.filter((r) => !isSuccess(r));
  const successRate = total > 0 ? successes.length / total : 1;

  // cadence
  let cadenceDays: number | null = null;
  if (total > 1) {
    const first = Date.parse(sorted[0].timestamp ?? '0');
    const last = Date.parse(sorted[total - 1].timestamp ?? '0');
    const spanDays = (last - first) / MS_PER_DAY;
    cadenceDays = spanDays / (total - 1);
  }

  // version drift
  let versionDrift: string | null;
  {
    const fromVer = sorted[0].version_from;
    const toVer = sorted[total - 1].version_to;
    const bumps = patchBumpCount(fromVer, toVer);
    const spanDays =
      total > 1
        ? Math.round(
            (Date.parse(sorted[total - 1].timestamp ?? '0') -
              Date.parse(sorted[0].timestamp ?? '0')) /
              MS_PER_DAY
          )
        : 0;
    versionDrift = `${fromVer ?? '?'} -> ${toVer ?? '?'} (${bumps} patch bumps over ${spanDays}d)`;
  }

  // immediate retries: two consecutive attempts within 1 hour
  let immediateRetries = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt =
      Date.parse(sorted[i].timestamp ?? '0') - Date.parse(sorted[i - 1].timestamp ?? '0');
    if (dt < MS_PER_DAY / 24) immediateRetries++;
  }

  // error codes from failures
  const errorCodes = [
    ...new Set(failures.map((r) => r.error_code).filter((c): c is string => !!c)),
  ];

  // grade
  const grade: UpdateGrade =
    successRate >= 0.95 ? 'A' : successRate >= 0.85 ? 'B' : successRate >= 0.7 ? 'C' : 'D';

  return {
    grade,
    successRate,
    total,
    successCount: successes.length,
    failedCount: failures.length,
    cadenceDays,
    versionDrift,
    immediateRetries,
    errorCodes,
  };
}
