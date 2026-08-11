import { describe, it, expect } from 'vitest';
import { FINDING_MARKER_CATALOG } from './applied-markers';
import { DETECTORS, findingMarkerCatalog } from './index';
import { DUAL_EMIT, markerFindingIdsFor } from './dual-emit';

interface MarkerContract {
  branches: readonly {
    id: string;
    carriesMarkers: boolean;
  }[];
}

interface MarkerDetector {
  id: string;
  appliedMarkers?: unknown;
}

function markerContractProblems(
  contracts: Readonly<Record<string, MarkerContract>>,
  detectors: readonly MarkerDetector[],
  catalog: ReadonlyMap<string, unknown>
): string[] {
  const detectorById = new Map(
    detectors.map((detector) => [detector.id, detector])
  );
  const problems: string[] = [];

  for (const [detectorId, contract] of Object.entries(contracts)) {
    const detector = detectorById.get(detectorId);
    if (!detector) {
      problems.push(`${detectorId}: dual-emit contract has no registered detector`);
      continue;
    }

    const emittedIds = new Set(contract.branches.map((branch) => branch.id));
    const markerBranches = contract.branches.filter(
      (branch) => branch.carriesMarkers
    );
    if (emittedIds.size !== contract.branches.length) {
      problems.push(`${detectorId}: emitted ids contain duplicates`);
    }
    if (!emittedIds.has(detectorId)) {
      problems.push(`${detectorId}: emitted ids omit the detector id`);
    }
    for (const branch of contract.branches) {
      if (branch.carriesMarkers && !catalog.has(branch.id)) {
        problems.push(`${detectorId}: marker finding id ${branch.id} has no catalog resolution`);
      }
      if (!branch.carriesMarkers && catalog.has(branch.id)) {
        problems.push(`${detectorId}: markerless emitted id ${branch.id} unexpectedly resolves markers`);
      }
    }
    if (detector.appliedMarkers && markerBranches.length === 0) {
      problems.push(`${detectorId}: marker-bearing detector declares no fix-carrying emitted id`);
    }
    if (!detector.appliedMarkers && markerBranches.length > 0) {
      problems.push(`${detectorId}: markerless detector declares fix-carrying emitted ids`);
    }
  }

  return problems;
}

// The client-safe leaf catalog (applied-markers.ts) duplicates the marker data
// the detector modules declare, so the digest client route can resolve a
// finding's markers without bundling the recs engine (#1909). This contract test
// is the anti-drift guard: the leaf MUST be byte-for-byte equal to the catalog
// built from the detectors' own `appliedMarkers` fields, so the two can never
// silently diverge. Both catalogs key by EMITTED finding id (#2965): receipts
// store the id a recommendation was emitted under, so a dual-emit detector
// whose fix rides a non-detector-id branch catalogs its markers under that
// branch id(s) (`markerFindingIdsFor`).
describe('applied-markers leaf is in sync with the detector catalog', () => {
  it('covers exactly the detectors that declare appliedMarkers', () => {
    const fromDetectors = [...findingMarkerCatalog().keys()].sort();
    const fromLeaf = [...FINDING_MARKER_CATALOG.keys()].sort();
    expect(fromLeaf).toEqual(fromDetectors);
  });

  it('every leaf entry deep-equals the detector-declared markers (headings + bodyPhrases)', () => {
    const catalog = findingMarkerCatalog();
    for (const [id, markers] of FINDING_MARKER_CATALOG) {
      expect(catalog.get(id), `missing detector markers for ${id}`).toBeDefined();
      expect(markers, `leaf markers drifted from detector for ${id}`).toEqual(
        catalog.get(id)
      );
    }
  });

  it('every detector that declares appliedMarkers appears in the leaf under its EMITTED fix id', () => {
    for (const d of DETECTORS) {
      if (!d.appliedMarkers) continue;
      const markerFindingIds = markerFindingIdsFor(d.id);
      expect(
        markerFindingIds,
        `${d.id} declares markers but no emitted fix id`
      ).not.toHaveLength(0);
      for (const findingId of markerFindingIds) {
        expect(
          FINDING_MARKER_CATALOG.get(findingId),
          `leaf is missing an entry for detector ${d.id} (emitted fix id ${findingId})`
        ).toEqual(d.appliedMarkers);
      }
    }
  });

  it('every dual emitter explicitly resolves each fix-carrying emitted id', () => {
    expect(
      markerContractProblems(DUAL_EMIT, DETECTORS, FINDING_MARKER_CATALOG)
    ).toEqual([]);
  });

  it('rejects a future dual emitter whose fix-carrying id lacks catalog resolution', () => {
    const problems = markerContractProblems(
      {
        'future.detector': {
          branches: [
            { id: 'future.detector', carriesMarkers: false },
            { id: 'future.fix-branch', carriesMarkers: true },
          ],
        },
      },
      [
        {
          id: 'future.detector',
          appliedMarkers: {
            headings: [/^## Future/],
            bodyPhrases: ['future fix marker'],
          },
        },
      ],
      new Map()
    );

    expect(problems).toContain(
      'future.detector: marker finding id future.fix-branch has no catalog resolution'
    );
  });

  it('rejects a markerless branch that could falsely look adopted', () => {
    const problems = markerContractProblems(
      {
        'future.detector': {
          branches: [
            { id: 'future.detector', carriesMarkers: true },
            { id: 'future.info-branch', carriesMarkers: false },
          ],
        },
      },
      [{ id: 'future.detector', appliedMarkers: {} }],
      new Map([
        ['future.detector', {}],
        ['future.info-branch', {}],
      ])
    );

    expect(problems).toContain(
      'future.detector: markerless emitted id future.info-branch unexpectedly resolves markers'
    );
  });

  it('dual-emit aliasing cannot strand markers under the detector id (#2965)', () => {
    // The api-errors detector's fix-carrying branch emits reliability.rate-limits;
    // that is the id receipts store, so that is the key the catalogs carry.
    expect(FINDING_MARKER_CATALOG.get('reliability.rate-limits')).toBeDefined();
    // The detector id maps only to the markerless info branch — it must NOT
    // resolve markers in the live catalog (a SURFACED info finding carrying no
    // fix must never look adopted; historical suppressed receipts resolve via
    // RETIRED_SUPPRESSION_MARKER_CATALOG instead).
    expect(FINDING_MARKER_CATALOG.get('reliability.api-errors')).toBeUndefined();
  });
});
