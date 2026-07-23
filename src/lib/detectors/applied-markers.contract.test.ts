import { describe, it, expect } from 'vitest';
import { FINDING_MARKER_CATALOG } from './applied-markers';
import { DETECTORS, findingMarkerCatalog } from './index';
import { markerFindingIdFor } from './dual-emit';

// The client-safe leaf catalog (applied-markers.ts) duplicates the marker data
// the detector modules declare, so the digest client route can resolve a
// finding's markers without bundling the recs engine (#1909). This contract test
// is the anti-drift guard: the leaf MUST be byte-for-byte equal to the catalog
// built from the detectors' own `appliedMarkers` fields, so the two can never
// silently diverge. Both catalogs key by EMITTED finding id (#2965): receipts
// store the id a recommendation was emitted under, so a dual-emit detector
// whose fix rides a non-detector-id branch catalogs its markers under that
// branch's id (`markerFindingIdFor`).
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
      expect(
        FINDING_MARKER_CATALOG.get(markerFindingIdFor(d.id)),
        `leaf is missing an entry for detector ${d.id} (emitted fix id ${markerFindingIdFor(d.id)})`
      ).toEqual(d.appliedMarkers);
    }
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
