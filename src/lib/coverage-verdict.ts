/**
 * Coverage verdict vocabulary for the CoverageState component (epic #1480,
 * slice #1619). Kept in its own module (not the .tsx) so the presentational
 * component file only exports components — react-refresh requires that.
 *
 * Empty domains used to render as blank space, so "no findings" read as a clean
 * bill of health when it actually meant "not yet instrumented". This three-way
 * verdict makes the difference explicit:
 *
 *   - `proven`        — we measured this directly; the absence is a real result.
 *   - `inferred`      — we have partial signal and are extrapolating; treat with
 *                       caution.
 *   - `cannot-see-yet`— this domain isn't instrumented on the current dataset,
 *                       so absence says nothing. The most important state: it
 *                       stops a blind spot from masquerading as a green light.
 */
export type CoverageVerdict = 'proven' | 'inferred' | 'cannot-see-yet';

export interface CoverageVerdictMeta {
  /** Short label text shown in the status chip. */
  label: string;
  /** Symbol-character glyph (house convention — plain chars, not emoji). */
  glyph: string;
  /** PatternFly Label palette color. */
  color: 'green' | 'yellow' | 'grey';
}

/** Per-verdict presentation. */
export const COVERAGE_VERDICT_META: Record<CoverageVerdict, CoverageVerdictMeta> = {
  proven: { label: 'Proven', glyph: '✓', color: 'green' },
  inferred: { label: 'Inferred', glyph: '◑', color: 'yellow' },
  'cannot-see-yet': { label: 'Cannot see yet', glyph: '○', color: 'grey' },
};
