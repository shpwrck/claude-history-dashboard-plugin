/**
 * Tests for activity.activity-trend detector.
 *
 * The detector reads `statsCache` from RecommendationInput (optional typed
 * extension). All fixtures are shaped exactly like `~/.claude/stats-cache.json`.
 */
import { describe, it, expect } from 'vitest';
import { detector, HOT_THRESHOLD_PCT } from './activity-trend';
import type { RecommendationInput } from '../types';
import type { StatsCache } from '../../parse-stats-cache';

// ── Fixture helpers ───────────────────────────────────────────────────────

function makeCache(
  thisWeekTc: number,
  lastWeekTc: number,
  overrides: Partial<{ lastComputedDate: string; version: number }> = {}
): StatsCache {
  const base = '2026-05-21';
  const makeDay = (offset: number, tc: number, week: 'last' | 'this') => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset + (week === 'this' ? 7 : 0));
    return {
      date: d.toISOString().slice(0, 10),
      messageCount: tc * 2,
      sessionCount: Math.max(1, Math.round(tc / 200)),
      toolCallCount: tc,
    };
  };
  const perDayLast = Math.round(lastWeekTc / 7);
  const perDayThis = Math.round(thisWeekTc / 7);
  const dailyActivity = [
    ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayLast, 'last')),
    ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayThis, 'this')),
  ];
  return {
    version: overrides.version ?? 3,
    lastComputedDate: overrides.lastComputedDate ?? '2026-06-03',
    dailyActivity,
  };
}

function input(statsCache?: StatsCache | null): RecommendationInput & { statsCache?: StatsCache | null } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    statsCache,
  } as RecommendationInput & { statsCache?: StatsCache | null };
}

// Reference timestamp: one day after lastComputedDate (fresh, not stale).
const NOW = new Date('2026-06-04T00:00:00Z').getTime();

// ── Tests ─────────────────────────────────────────────────────────────────

describe(`activity.activity-trend (threshold: +${HOT_THRESHOLD_PCT}% WoW)`, () => {
  it('emits nothing when statsCache is absent (undefined)', () => {
    expect(detector.rule(input(undefined), NOW)).toBeNull();
  });

  it('emits nothing when statsCache is null', () => {
    expect(detector.rule(input(null), NOW)).toBeNull();
  });

  it('fires when toolCallCount WoW >= +50% and verdict is hotter', () => {
    // last week ~2373 (prototype), this week ~12576 (prototype) → ~430% hotter
    const cache = makeCache(12576, 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('activity.activity-trend');
    expect(rec!.category).toBe('activity');
    expect(rec!.severity).toBe('warning'); // >=200% → warning
  });

  it('uses info severity for hot-but-not-extreme (50-199%)', () => {
    // +100%: thisWeek = 2 * lastWeek
    const cache = makeCache(4746, 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.severity).toBe('info');
  });

  it('emits nothing when WoW is flat', () => {
    const cache = makeCache(2373, 2373);
    expect(detector.rule(input(cache), NOW)).toBeNull();
  });

  it('emits nothing when this week is cooler than last week', () => {
    const cache = makeCache(1000, 2373);
    expect(detector.rule(input(cache), NOW)).toBeNull();
  });

  it('emits nothing when WoW is +30% (below 50% threshold)', () => {
    const cache = makeCache(Math.round(2373 * 1.3), 2373);
    expect(detector.rule(input(cache), NOW)).toBeNull();
  });

  it('fires at exactly +50% WoW', () => {
    const cache = makeCache(Math.round(2373 * 1.5), 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('activity.activity-trend');
  });

  it('includes the pctChange in the title', () => {
    const cache = makeCache(12576, 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(rec!.title).toMatch(/\d+%/);
    expect(rec!.title).toContain('hotter');
  });

  it('includes thisWeek and lastWeek tool-call counts in the detail', () => {
    const cache = makeCache(12576, 2373);
    const rec = detector.rule(input(cache), NOW);
    // makeCache rounds per-day values, so the totals are close but may not be
    // exactly 12576/2373. Check that some large number and some small number appear.
    expect(rec!.detail).toMatch(/\d{1,3}(?:,\d{3})+ tool calls/); // formatted large number
    expect(rec!.detail).toContain('last week');
    expect(rec!.detail).toContain('tool calls');
  });

  it('includes lastComputedDate in evidence', () => {
    const cache = makeCache(12576, 2373, { lastComputedDate: '2026-06-03' });
    const rec = detector.rule(input(cache), NOW);
    const evidenceStr = rec!.evidence!.join(' ');
    expect(evidenceStr).toContain('2026-06-03');
  });

  it('notes staleness in detail when cache is stale (>2 days old)', () => {
    const cache = makeCache(12576, 2373, { lastComputedDate: '2026-05-01' });
    const staleNow = new Date('2026-06-04T00:00:00Z').getTime();
    const rec = detector.rule(input(cache), staleNow);
    expect(rec).not.toBeNull();
    expect(rec!.detail).toContain('stale');
  });

  it('does not note staleness when cache is fresh', () => {
    const cache = makeCache(12576, 2373, { lastComputedDate: '2026-06-03' });
    const rec = detector.rule(input(cache), NOW);
    expect(rec!.detail).not.toContain('stale');
  });

  it('points to the activity view', () => {
    const cache = makeCache(12576, 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(rec!.view).toBe('activity');
  });

  it('sets affected to thisWeek tool-call count', () => {
    const cache = makeCache(12576, 2373);
    const rec = detector.rule(input(cache), NOW);
    expect(typeof rec!.affected).toBe('number');
    expect(rec!.affected).toBeGreaterThan(0);
  });

  it('has the correct id and category on the detector metadata', () => {
    expect(detector.id).toBe('activity.activity-trend');
    expect(detector.category).toBe('activity');
  });

  // ── Stale-input wording demotion (#1102) ─────────────────────────────────
  describe('stale-input demotion', () => {
    const staleNow = new Date('2026-06-04T00:00:00Z').getTime();

    it('uses present-tense wording when fresh', () => {
      const rec = detector.rule(input(makeCache(12576, 2373, { lastComputedDate: '2026-06-03' })), NOW);
      expect(rec!.title).toContain('is running');
      expect(rec!.detail).toContain('This week so far');
      expect(rec!.detail).not.toContain('As of');
    });

    it('demotes to dated past-tense wording when stale', () => {
      const cache = makeCache(12576, 2373, { lastComputedDate: '2026-05-01' });
      const rec = detector.rule(input(cache), staleNow);
      expect(rec!.title).toContain('ran');
      expect(rec!.title).toContain('as of 2026-05-01');
      expect(rec!.detail).toContain('As of 2026-05-01');
      expect(rec!.detail).not.toContain('This week so far');
      expect(rec!.action).toContain('Refresh');
      // provenance still flags the staleness it demoted against
      expect(rec!.provenance!.asOf).toBe('2026-05-01');
      expect(rec!.provenance!.stale).toBe(true);
    });
  });
});
