import { describe, it, expect } from 'vitest';
import { FINDING_MARKER_CATALOG } from './applied-markers';
import { DETECTORS, findingMarkerCatalog } from './index';

// The client-safe leaf catalog (applied-markers.ts) duplicates the marker data
// the detector modules declare, so the digest client route can resolve a
// finding's markers without bundling the recs engine (#1909). This contract test
// is the anti-drift guard: the leaf MUST be byte-for-byte equal to the catalog
// built from the detectors' own `appliedMarkers` fields, so the two can never
// silently diverge.
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

  it('every detector that declares appliedMarkers appears in the leaf', () => {
    for (const d of DETECTORS) {
      if (!d.appliedMarkers) continue;
      expect(
        FINDING_MARKER_CATALOG.get(d.id),
        `leaf is missing an entry for detector ${d.id}`
      ).toEqual(d.appliedMarkers);
    }
  });
});
