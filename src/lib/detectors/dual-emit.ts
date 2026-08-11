/**
 * Detectors whose single rule body legitimately emits a DIFFERENT rec id than
 * the registry `id` because it has multiple branches (#507 dual-emit). Every
 * other detector MUST emit `rec.id === detector.id`.
 *
 * Single source of truth for both the registry self-test
 * (recommendations.test.ts) and the guidance target-resolution test
 * (external-guidance-registry.test.ts) — a hand-copied map in either test can
 * silently drift and either re-open the #1401 dangling-target hole or fail a
 * valid guidance target. Each dual emitter also declares exactly which emitted
 * ids carry its detector-level `appliedMarkers`, so adoption receipts cannot be
 * stranded under the registry id when the fix is emitted under another id
 * (#2965/#2996). A branch with `carriesMarkers: false` is the explicit
 * markerless declaration.
 */
export interface DualEmitBranch {
  readonly id: string;
  readonly carriesMarkers: boolean;
}

export interface DualEmitContract {
  readonly branches: readonly DualEmitBranch[];
}

export const DUAL_EMIT: Readonly<Record<string, DualEmitContract>> = {
  'safety.dangerous-bypass': {
    branches: [
      { id: 'safety.dangerous-bypass', carriesMarkers: false },
      { id: 'safety.dangerous-commands', carriesMarkers: false },
    ],
  },
  'reliability.api-errors': {
    branches: [
      { id: 'reliability.api-errors', carriesMarkers: false },
      { id: 'reliability.rate-limits', carriesMarkers: true },
    ],
  },
  'workflow.value-of-agent-handoff': {
    branches: [
      { id: 'workflow.value-of-agent-handoff', carriesMarkers: true },
      {
        id: 'workflow.leave-behind-candidate-verification',
        carriesMarkers: false,
      },
    ],
  },
};

/** Every rec id the detector catalog can emit for a given detector id. */
export function emittableIdsFor(detectorId: string): readonly string[] {
  return DUAL_EMIT[detectorId]?.branches.map((branch) => branch.id) ?? [detectorId];
}

/**
 * Every emitted id under which a detector's `appliedMarkers` can ride. Normal
 * detectors use their own id. Dual emitters must declare the marker-bearing
 * branch ids in `DUAL_EMIT`, including the detector id when that is the branch
 * carrying the fix. This explicit declaration is what makes adding a new dual
 * emitter fail the marker contract until adoption resolution is considered.
 */
export function markerFindingIdsFor(detectorId: string): readonly string[] {
  return DUAL_EMIT[detectorId]?.branches
    .filter((branch) => branch.carriesMarkers)
    .map((branch) => branch.id) ?? [detectorId];
}
