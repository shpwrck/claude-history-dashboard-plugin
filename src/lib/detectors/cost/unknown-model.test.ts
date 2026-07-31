/**
 * cost.unknown-model — data-quality nudge with reproducible provenance (#3201).
 *
 * Also pins the corrected claim direction: the pricing registry zero-prices a
 * truly unknown model and EXCLUDES its spend from cost estimates
 * (`resolveModelPricing().isUnknownModel`), so affected cost figures are
 * UNDERSTATED lower bounds — not "Sonnet-tier guesses" as the pre-#3201 copy
 * asserted from the registry's long-gone fallback behaviour.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './unknown-model';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';

const session = (
  id: string,
  hasUnknownModel: boolean,
  timestamp?: string
): SessionTokenData =>
  ({
    sessionId: id,
    hasUnknownModel,
    entries: timestamp ? [{ timestamp } as never] : [],
  } as unknown as SessionTokenData);

function input(
  tokenData: SessionTokenData[],
  model?: string
): RecommendationInput {
  return {
    tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: model
      ? ({ settings: { model } } as unknown as RecommendationInput['liveConfig'])
      : null,
  };
}

describe('cost.unknown-model', () => {
  it('fires when a session carries an unrecognised model string', () => {
    const rec = detector.rule(input([session('s1', true), session('s2', false)]), 0);
    expect(rec?.id).toBe('cost.unknown-model');
    expect(rec?.affected).toBe(1);
    expect(rec?.fix?.target).toBe('settings.json');
  });

  it('stays silent when every model is recognised', () => {
    expect(detector.rule(input([session('s1', false)]), 0)).toBeNull();
  });

  it('self-suppresses once any model is pinned', () => {
    expect(detector.rule(input([session('s1', true)], 'claude-sonnet-4-6'), 0)).toBeNull();
  });

  it('states the exclusion direction, not the retired Sonnet-tier fallback (#3201)', () => {
    const rec = detector.rule(input([session('s1', true)]), 0)!;
    // Unknown models are excluded from cost, so figures are UNDERstated.
    expect(rec.detail).toMatch(/excluded/i);
    expect(rec.detail).toMatch(/understated/i);
    expect(rec.detail).not.toMatch(/Sonnet-tier/);
    expect(rec.action).toMatch(/lower bounds/i);
  });
});

describe('cost.unknown-model provenance (#3201)', () => {
  it('passes the repository provenance validator', () => {
    const rec = detector.rule(input([session('s1', true)]), 0)!;
    expect(rec.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });

  it('cites the parsed flag and the registry exclusion, and reproduces the count', () => {
    const rec = detector.rule(
      input([session('s1', true), session('s2', true), session('s3', false)]),
      0
    )!;
    const byField = new Map(rec.provenance!.observations.map((o) => [o.field, o]));
    const flag = byField.get('tokenData[].hasUnknownModel');
    expect(flag?.source).toBe('parse-sessions');
    expect(flag?.value).toBe(rec.affected);
    expect(flag?.value).toBe(2);
    const registry = byField.get('resolveModelPricing (isUnknownModel -> ZERO_PRICING)');
    expect(registry?.source).toBe('pricing.ts');
  });

  it('separates the lower-bound inference from the observations', () => {
    const rec = detector.rule(input([session('s1', true)]), 0)!;
    expect(rec.provenance!.inference).toMatch(/lower bounds/i);
  });

  it('omits asOf without readable timestamps, dates and demotes with them', () => {
    const undated = detector.rule(input([session('s1', true)]), 0)!;
    expect(undated.provenance!.asOf).toBeUndefined();
    expect(undated.provenance!.stale).toBeUndefined();

    const dated = [session('s1', true, '2026-06-09T12:00:00.000Z')];
    const fresh = detector.rule(input(dated), Date.parse('2026-06-10T00:00:00.000Z'))!;
    expect(fresh.provenance!.asOf).toBe('2026-06-09');
    expect(fresh.provenance!.stale).toBe(false);

    const stale = detector.rule(input(dated), Date.parse('2026-12-01T00:00:00.000Z'))!;
    expect(stale.provenance!.stale).toBe(true);
    expect(stale.detail).toMatch(/^As of 2026-06-09/);
    expect(validateRecommendationProvenance(stale)).toEqual([]);
  });
});
