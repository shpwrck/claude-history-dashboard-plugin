/**
 * Provenance contract test (#1049, epic #866 keystone).
 *
 * Enforces the auditability contract at the schema level:
 *  1. The validator accepts well-formed provenance and rejects each
 *     malformed shape (so siblings #1101–#1105 can rely on it).
 *  2. Every id on the PROVENANCE_DETECTORS allowlist is a real registered
 *     detector — the allowlist can't rot.
 *  3. The exemplar (activity.activity-trend) carries cited observations, a
 *     distinct inference, and an as-of date that reflects staleness, and the
 *     recommendation it emits passes the full contract.
 *
 * NOTE: the "triggered ⇒ compliant" guarantee is proven for the exemplar by
 * name. As siblings #1101–#1105 append ids to PROVENANCE_DETECTORS, add a
 * generic trigger-and-validate harness so the guarantee extends to each.
 */
import { describe, it, expect } from 'vitest';
import { DETECTORS } from './index';
import {
  PROVENANCE_DETECTORS,
  validateRecObservation,
  validateRecProvenance,
  validateRecommendationProvenance,
} from './provenance';
import type { RecProvenance } from './types';
import { detector as activityTrend } from './activity/activity-trend';
import type { RecommendationInput } from './types';
import type { StatsCache } from '../parse-stats-cache';

// ── Validator unit tests ─────────────────────────────────────────────────

const goodObs = { claim: '18 of 18 assignments unread', source: 'teams/', field: 'unreadCount', value: 18 };

describe('validateRecObservation', () => {
  it('accepts a fully-specified observation', () => {
    expect(validateRecObservation(goodObs)).toEqual([]);
  });
  it('accepts a claim+source-only observation (field/value optional)', () => {
    expect(validateRecObservation({ claim: 'x', source: 'parse-tools' })).toEqual([]);
  });
  it('rejects a missing/blank claim', () => {
    expect(validateRecObservation({ claim: '  ', source: 's' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a missing source (the citation is the point)', () => {
    expect(validateRecObservation({ claim: 'x' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-scalar value', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', value: {} } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-finite numeric value (NaN is not auditable)', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', value: NaN } as never).length).toBeGreaterThan(0);
  });
});

describe('validateRecProvenance', () => {
  const good: RecProvenance = {
    observations: [goodObs],
    inference: 'so the inbox is stalled',
    asOf: '2026-06-10',
    stale: false,
  };
  it('accepts a well-formed block', () => {
    expect(validateRecProvenance(good)).toEqual([]);
  });
  it('requires a non-empty observations array', () => {
    expect(validateRecProvenance({ observations: [] }).length).toBeGreaterThan(0);
  });
  it('rejects a blank inference when present', () => {
    expect(validateRecProvenance({ observations: [goodObs], inference: '' }).length).toBeGreaterThan(0);
  });
  it('rejects a non-ISO asOf (e.g. a full timestamp)', () => {
    expect(
      validateRecProvenance({ observations: [goodObs], asOf: '2026-06-10T00:00:00Z' }).length
    ).toBeGreaterThan(0);
  });
  it('rejects stale=true without an asOf to demote against', () => {
    expect(validateRecProvenance({ observations: [goodObs], stale: true }).length).toBeGreaterThan(0);
  });
});

// ── Allowlist integrity ──────────────────────────────────────────────────

describe('PROVENANCE_DETECTORS allowlist', () => {
  it('only lists ids that are actually registered detectors', () => {
    const registered = new Set(DETECTORS.map((d) => d.id));
    for (const id of PROVENANCE_DETECTORS) {
      expect(registered.has(id), `${id} is on the allowlist but not registered`).toBe(true);
    }
  });
});

// ── Exemplar: activity.activity-trend emits compliant provenance ───────────

function makeCache(
  thisWeekTc: number,
  lastWeekTc: number,
  lastComputedDate = '2026-06-03'
): StatsCache {
  const base = '2026-05-21';
  const makeDay = (offset: number, tc: number, week: 'last' | 'this') => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset + (week === 'this' ? 7 : 0));
    return { date: d.toISOString().slice(0, 10), messageCount: tc * 2, sessionCount: Math.max(1, Math.round(tc / 200)), toolCallCount: tc };
  };
  const perDayLast = Math.round(lastWeekTc / 7);
  const perDayThis = Math.round(thisWeekTc / 7);
  return {
    version: 3,
    lastComputedDate,
    dailyActivity: [
      ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayLast, 'last')),
      ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayThis, 'this')),
    ],
  };
}

function input(statsCache: StatsCache): RecommendationInput & { statsCache?: StatsCache | null } {
  return {
    tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [], statsCache,
  } as RecommendationInput & { statsCache?: StatsCache | null };
}

describe('activity.activity-trend provenance (exemplar)', () => {
  const NOW = new Date('2026-06-04T00:00:00Z').getTime();

  it('emits provenance that passes the contract when it fires', () => {
    const rec = activityTrend.rule(input(makeCache(12576, 2373)), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('cites stats-cache.json in every observation and keeps the inference separate', () => {
    const rec = activityTrend.rule(input(makeCache(12576, 2373)), NOW);
    const p = rec!.provenance!;
    expect(p.observations.length).toBeGreaterThan(0);
    for (const o of p.observations) expect(o.source).toBe('stats-cache.json');
    expect(p.inference).toMatch(/%/); // the "so what", not a raw count
  });

  it('carries the lastComputedDate as asOf and flags staleness honestly', () => {
    const fresh = activityTrend.rule(input(makeCache(12576, 2373, '2026-06-03')), NOW);
    expect(fresh!.provenance!.asOf).toBe('2026-06-03');
    expect(fresh!.provenance!.stale).toBe(false);

    const staleNow = new Date('2026-06-04T00:00:00Z').getTime();
    const stale = activityTrend.rule(input(makeCache(12576, 2373, '2026-05-01')), staleNow);
    expect(stale!.provenance!.asOf).toBe('2026-05-01');
    expect(stale!.provenance!.stale).toBe(true);
    expect(validateRecommendationProvenance(stale!)).toEqual([]);
  });
});
