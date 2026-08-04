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
  'workflow.value-of-agent-handoff': [
    'workflow.value-of-agent-handoff',
    'workflow.leave-behind-candidate-verification',
  ],
};

/** Every rec id the detector catalog can emit for a given detector id. */
export function emittableIdsFor(detectorId: string): string[] {
  return DUAL_EMIT[detectorId] ?? [detectorId];
}

/**
 * For a dual-emit detector whose FIX-carrying branch emits an id other than
 * the detector id, the id that fix (and its `appliedMarkers`) is actually
 * emitted under (#2965). Adoption receipts store EMITTED finding ids, so the
 * marker catalogs must key markers by this id — keying by detector id left a
 * SURFACED-only `reliability.rate-limits` receipt unable to reach the #1785
 * "fix landed, awaiting quiet" MARKER-CONFIRMED state (marker lookup missed).
 *
 * Only detectors whose fix rides a non-detector-id branch belong here:
 * `safety.dangerous-bypass`'s branches carry no appliedMarkers, and
 * `workflow.value-of-agent-handoff`'s fix rides its detector-id emission.
 */
export const MARKER_FINDING_ID: Record<string, string> = {
  'reliability.api-errors': 'reliability.rate-limits',
};

/** The finding id a detector's `appliedMarkers` should be cataloged under. */
export function markerFindingIdFor(detectorId: string): string {
  return MARKER_FINDING_ID[detectorId] ?? detectorId;
}
