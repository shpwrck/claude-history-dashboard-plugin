/**
 * Strict ISO-8601 instant parsing — the single definition of "is this string
 * actually a timestamp".
 *
 * Its own leaf module (no imports) because BOTH the parser layer
 * (`parse-files`, aggregating churn) and the detector layer
 * (`detectors/shared`, deriving `provenance.asOf`) need it, and detectors may
 * import parsers but not the reverse. Two hand-rolled copies of this check is
 * precisely the pair-that-drifts defect the v0.6 audit keeps finding.
 */

/**
 * ISO-8601 / RFC3339 instant shape: a `YYYY-MM-DD` date, optionally followed by
 * a time — and when a time IS present, a mandatory `Z` or explicit offset.
 *
 * The offset is not optional on purpose. `Date.parse('2026-06-09T23:30')` is
 * interpreted in HOST-LOCAL time, so the same artifact resolves to a different
 * instant — and can land on a different calendar DAY — depending on the `TZ` of
 * whatever machine ran the detector. A `provenance.asOf` that changes with the
 * server's timezone is not reproducible, which is the entire property this
 * contract exists to guarantee, so a time without a zone is refused rather than
 * silently localised. A bare `YYYY-MM-DD` stays allowed: `Date.parse` reads a
 * date-only string as UTC, so it is unambiguous.
 *
 * Deliberately narrow — see {@link parseIsoInstantMs}.
 */
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2})))?$/;

/**
 * `ts` as epoch ms if it is a REAL ISO-8601 instant, else `undefined`.
 *
 * `Date.parse` alone is not a validity test — it is a coercion. It happily
 * invents an instant for input that is not a timestamp at all, and every one of
 * those inventions then formats as a well-formed `YYYY-MM-DD` that sails
 * through the provenance calendar validator:
 *
 *   `'1'`          -> 2001-01-01     (a bare digit becomes a year)
 *   `'2026-02-30'` -> 2026-03-02     (an impossible day rolls over)
 *   `'12/25/2026'` -> 2026-12-25     (a non-ISO format is accepted)
 *
 * That is precisely the "a date that looks derived but is not" defect the audit
 * keeps finding: a recommendation would be dated from a string that never was a
 * date, and nothing downstream could tell. So the shape is checked FIRST, the
 * clock and offset fields are range-checked before parsing, the parse must
 * still succeed, and the date part is ROUND-TRIPPED so a rolled-over day is
 * rejected rather than silently moved.
 */
export function parseIsoInstantMs(ts: string | null | undefined): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const trimmed = ts.trim();
  const m = ISO_INSTANT.exec(trimmed);
  if (!m) return undefined;
  if (m[2] !== undefined) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    const second = m[4] === undefined ? 0 : Number(m[4]);
    const offsetHour = m[5] === undefined ? 0 : Number(m[5]);
    const offsetMinute = m[6] === undefined ? 0 : Number(m[6]);
    if (
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return undefined;
    }
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  const dayMs = Date.parse(`${m[1]}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs)) return undefined;
  // 2026-02-30 parses and rolls to Mar 2, so it only fails on the way back.
  if (new Date(dayMs).toISOString().slice(0, 10) !== m[1]) return undefined;
  return ms;
}

/**
 * True only for the canonical wire form produced by `Date#toISOString`.
 *
 * `parseIsoInstantMs` deliberately accepts equivalent ISO offsets and date-only
 * values for ingest. Snapshot identities and wire expiries are stricter: one
 * instant has one byte representation so receipts compare without timezone or
 * formatting ambiguity.
 */
export function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epochMs = parseIsoInstantMs(value);
  if (epochMs === undefined) return false;
  return new Date(epochMs).toISOString() === value;
}
