import { describe, it, expect } from 'vitest';
import { detector } from './priority-tier-spend';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const session = (id: string, serviceTier?: string, timestamp?: string): SessionTokenData =>
  ({
    sessionId: id,
    serviceTier,
    entries: timestamp ? [{ timestamp } as never] : [],
  } as unknown as SessionTokenData);

function input(tokenData: SessionTokenData[]): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  };
}

describe('cost.priority-tier-spend (#426)', () => {
  it('fires (no fix, count-only) once enough sessions used the priority tier', () => {
    const rec = detector.rule(
      input([
        session('s1', 'priority'),
        session('s2', 'priority'),
        session('s3', 'priority'),
        session('s4', 'standard'),
      ]),
      0
    );
    expect(rec?.id).toBe('cost.priority-tier-spend');
    expect(rec?.affected).toBe(3);
    expect(rec?.fix).toBeUndefined();
    expect(rec?.estSavingsUsd).toBeUndefined();
  });

  it('stays silent below the session floor', () => {
    expect(detector.rule(input([session('s1', 'priority'), session('s2', 'priority')]), 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #3201 — structured provenance: the count claim is reproducible.
// ---------------------------------------------------------------------------

describe('cost.priority-tier-spend provenance (#3201)', () => {
  const undated = [
    session('s1', 'priority'),
    session('s2', 'priority'),
    session('s3', 'priority'),
    session('s4', 'standard'),
  ];

  it('passes the repository provenance validator', () => {
    const rec = detector.rule(input(undated), 0)!;
    expect(rec.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('cites the exact serviceTier field and reproduces the affected count', () => {
    const rec = detector.rule(input(undated), 0)!;
    const obs = rec.provenance!.observations[0];
    expect(obs.source).toBe('parse-sessions');
    expect(obs.field).toBe('tokenData[].serviceTier');
    expect(obs.value).toBe(rec.affected);
    expect(obs.value).toBe(3);
  });

  it('keeps the unpriceable-premium reasoning in the inference, not the observations', () => {
    const rec = detector.rule(input(undated), 0)!;
    expect(rec.provenance!.inference).toMatch(/cannot be priced/);
  });

  it('omits asOf when no entry carries a readable timestamp (honest absence)', () => {
    const rec = detector.rule(input(undated), 0)!;
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(rec.provenance!.stale).toBeUndefined();
  });

  it('dates from the newest observed entry and demotes when stale', () => {
    const dated = [
      session('s1', 'priority', '2026-06-01T00:00:00.000Z'),
      session('s2', 'priority', '2026-06-09T00:00:00.000Z'),
      session('s3', 'priority', '2026-06-05T00:00:00.000Z'),
    ];
    const fresh = detector.rule(input(dated), Date.parse('2026-06-10T00:00:00.000Z'))!;
    expect(fresh.provenance!.asOf).toBe('2026-06-09');
    expect(fresh.provenance!.stale).toBe(false);
    expect(fresh.detail).not.toMatch(/^As of/);

    const stale = detector.rule(input(dated), Date.parse('2026-12-01T00:00:00.000Z'))!;
    expect(stale.provenance!.stale).toBe(true);
    expect(stale.detail).toMatch(/^As of 2026-06-09/);
    expect(validateRecommendationProvenance(stale)).toEqual([]);
  });
});
