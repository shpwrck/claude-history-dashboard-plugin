/**
 * Detectors whose single rule body legitimately emits a DIFFERENT rec id than
 * the registry `id` because it has multiple branches (#507 dual-emit). Every
 * other detector MUST emit `rec.id === detector.id`.
 *
 * Single source of truth for both the registry self-test
 * (recommendations.test.ts) and the guidance target-resolution test
 * (external-guidance-registry.test.ts) — a hand-copied map in either test can
 * silently drift and either re-open the #1401 dangling-target hole or fail a
 * valid guidance target.
 */
export const DUAL_EMIT: Record<string, string[]> = {
  'safety.dangerous-bypass': ['safety.dangerous-bypass', 'safety.dangerous-commands'],
  'reliability.api-errors': ['reliability.api-errors', 'reliability.rate-limits'],
};

/** Every rec id the detector catalog can emit for a given detector id. */
export function emittableIdsFor(detectorId: string): string[] {
  return DUAL_EMIT[detectorId] ?? [detectorId];
}
