// Drift guard for the marketing SPA's Adoption Card sample lifecycle (issue
// #578, epic #573, ADR 0005 "Demo artifact").
//
// The synthetic adoption receipts in scripts/sample-data/build-corpus.mjs must
// keep producing ONE fully-populated lifecycle card when run through the real
// Adoption Scorecard join (the same buildAdoptionScorecard() the live view uses)
// against the SPA's sample liveConfig. If the receipt shape, the join, or the
// sample CLAUDE.md hunk drifts so the card no longer traverses
// SURFACED -> ADOPTED -> SUPPRESSED, this fails instead of the SPA silently
// shipping a broken or empty Adoption Card.

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM build helper, no .d.ts
import { buildSampleAdoptionReceipts as buildRawReceipts } from '../../scripts/sample-data/build-corpus.mjs';
import {
  buildSampleAdoptionReceipts,
  buildSampleLiveConfig,
} from './sample-artifacts';
import { sanitizeAdoptionReceipt } from './adoption-receipts';
import { buildAdoptionScorecard } from './adoption-scorecard';

describe('sample adoption seed — receipts', () => {
  const receipts = buildSampleAdoptionReceipts();

  it('emits exactly one SURFACED and one SUPPRESSED receipt for one finding', () => {
    expect(receipts).toHaveLength(2);
    const surfaced = receipts.filter((r) => r.kind === 'SURFACED');
    const suppressed = receipts.filter((r) => r.kind === 'SUPPRESSED');
    expect(surfaced).toHaveLength(1);
    expect(suppressed).toHaveLength(1);
    // The lifecycle is one finding traversing the whole arc.
    expect(surfaced[0].kind === 'SURFACED' && surfaced[0].findingIds).toEqual([
      suppressed[0].kind === 'SUPPRESSED' ? suppressed[0].findingId : 'mismatch',
    ]);
  });

  it('has realistic, ordered timestamps (surfaced before suppressed)', () => {
    const surfaced = receipts.find((r) => r.kind === 'SURFACED')!;
    const suppressed = receipts.find((r) => r.kind === 'SUPPRESSED')!;
    const a = Date.parse(surfaced.ts);
    const b = Date.parse(suppressed.ts);
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeGreaterThan(a);
  });

  it('is byte-stable (deterministic, no PRNG)', () => {
    expect(JSON.stringify(buildSampleAdoptionReceipts())).toEqual(
      JSON.stringify(buildSampleAdoptionReceipts())
    );
  });

  it('every seeded receipt survives the production sanitizer unchanged', () => {
    for (const r of buildRawReceipts()) {
      const clean = sanitizeAdoptionReceipt(r);
      expect(clean).not.toBeNull();
      // The seed is already in canonical, allowlisted shape — no fields dropped.
      expect(clean).toEqual(r);
    }
  });
});

describe('sample adoption seed — scorecard shape (the Adoption Card)', () => {
  const scorecard = buildAdoptionScorecard(
    buildSampleAdoptionReceipts(),
    buildSampleLiveConfig()
  );

  it('derives exactly one finding row that traverses the full lifecycle', () => {
    expect(scorecard.rows).toHaveLength(1);
    const row = scorecard.rows[0];
    // SUPPRESSED is the terminal state once the engine goes quiet.
    expect(row.status).toBe('SUPPRESSED');
    // Both ends of the lifecycle are attributed (not "attribution pending").
    expect(row.surfaced).not.toBeNull();
    expect(row.suppressed).not.toBeNull();
    expect(row.attributionPending).toBe(false);
  });

  it('renders the matching CLAUDE.md hunk live (the ADOPTED evidence)', () => {
    const row = scorecard.rows[0];
    expect(row.liveHunk).not.toBeNull();
    // The live hunk is the section under the receipt's markerHeading, pulled
    // from the sample liveConfig — never stored on the receipt.
    expect(row.liveHunk).toContain(`## ${row.suppressed!.markerHeading}`);
  });

  it('counts the adoption and a realistic days-to-adopt', () => {
    expect(scorecard.header.surfacedCount).toBe(1);
    expect(scorecard.header.adoptedCount).toBe(1);
    expect(scorecard.rows[0].daysToAdopt).toBe(5);
    expect(scorecard.header.medianDaysToAdopt).toBe(5);
  });
});
