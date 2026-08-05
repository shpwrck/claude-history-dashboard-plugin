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
import type { Session, SessionTokenData } from '../../../types';

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

function input(
  statsCache?: StatsCache | null,
  ran: SessionRun[] = []
): RecommendationInput & { statsCache?: StatsCache | null } {
  return {
    tokenData: ran.map((r) => r.token),
    toolData: [],
    sessions: ran.map((r) => r.session),
    projects: [],
    permissionRows: [],
    apiErrors: [],
    statsCache,
  } as RecommendationInput & { statsCache?: StatsCache | null };
}

/** A session paired with the token row that carries its Claude Code version. */
interface SessionRun {
  session: Session;
  token: SessionTokenData;
}

let sessionSeq = 0;

/**
 * A session that ran on `day` (YYYY-MM-DD) under Claude Code `version`.
 *
 * The version goes on the TOKEN row, not the Session: `Session` objects reach
 * detectors via `groupBySessions`, which cannot populate `version` because
 * `HistoryEntry` has no such field. Putting it on `Session` here would make the
 * fixture pass while production never could (#3405 review blocker).
 *
 * `makeCache` records days 2026-05-21..2026-06-03, so a day in that set lands
 * in the window the detector segments by.
 */
function sessionOn(day: string, version?: string): SessionRun {
  const sessionId = `s-${day}-${sessionSeq++}`;
  const startTime = new Date(`${day}T12:00:00Z`).getTime();
  return {
    session: {
      sessionId,
      project: '/repo',
      projectShort: 'repo',
      entries: [],
      startTime,
      endTime: startTime + 60_000,
      duration: 60_000,
      messageCount: 1,
    },
    token: {
      sessionId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: 'claude-opus-4-8',
      messageCount: 1,
      entries: [],
      compactionEvents: [],
      hasUnknownModel: false,
      ...(version ? { version } : {}),
    } as unknown as SessionTokenData,
  };
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


// ── Prompt-regime segmentation (#3405) ────────────────────────────────────
//
// `makeCache` records days 2026-05-21..2026-06-03 (every day has activity).
// Fixture versions are real corpus values: 2.1.212/2.1.214 pre-cut, 2.1.220
// post-cut, 2.1.218 straddles the announcement and is unplaceable.
describe('activity.activity-trend prompt-regime awareness (#3405)', () => {
  // >=200% WoW, which would be `warning` were the window not confounded.
  const HOT = () => makeCache(12576, 2373);

  it('does not annotate when the whole window ran on one prompt regime', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.214')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.title).not.toContain('confounded');
    expect(rec!.severity).toBe('warning');
    expect(rec!.evidence!.join(' ')).not.toContain('prompt regime');
  });

  it('annotates and demotes when the comparison window crosses the cut', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.220')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    // Demoted: a >=200% jump that would otherwise be `warning` is not escalated.
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('confounded');
    expect(rec!.title).toContain('prompt-regime change');
    expect(rec!.detail).toContain('indicative only');
    expect(rec!.action).toContain('same Claude Code prompt regime');
  });

  // The blocker this file previously missed: version lives on the token row,
  // never on Session (groupBySessions cannot populate it). A fixture that sets
  // Session.version would pass while production could never fire.
  it('reads version from tokenData, not from Session', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.220')];
    for (const r of ran) {
      expect((r.session as { version?: string }).version).toBeUndefined();
    }
    expect(detector.rule(input(HOT(), ran), NOW)!.title).toContain('confounded');
  });

  it('is unconfounded when tokenData is absent even though sessions exist', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.220')];
    const withoutTokens = {
      ...input(HOT(), ran),
      tokenData: [],
    } as RecommendationInput & { statsCache?: StatsCache | null };
    const rec = detector.rule(withoutTokens, NOW);
    expect(rec!.title).not.toContain('confounded');
    expect(rec!.severity).toBe('warning');
  });

  it('cites the regime span in evidence and provenance when confounded', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.220')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.evidence!.join(' ')).toContain('prompt regime');
    const obs = rec!.provenance!.observations!;
    const regimeObs = obs.find((o) => o.claim.includes('prompt-regime change'));
    expect(regimeObs).toBeDefined();
    expect(regimeObs!.field).toContain('version');
    expect(regimeObs!.value).toBe('pre-claude-5,claude-5-short');
  });

  it('demotes when a session sits inside the unresolved bracket', () => {
    const ran = [sessionOn('2026-05-23', '2.1.218'), sessionOn('2026-06-01', '2.1.218')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('too close to a prompt-regime change');
    const obs = rec!.provenance!.observations!.find((o) => o.claim.includes('too close'));
    expect(obs!.value).toBe('indeterminate');
  });

  // Mixed case: one resolved regime AND an unplaceable session. Reporting only
  // the resolved id would contradict the "too close to place" claim beside it.
  it('names both the resolved regime and indeterminate in a mixed window', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.218')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toContain('too close to a prompt-regime change');
    const obs = rec!.provenance!.observations!.find((o) => o.claim.includes('too close'));
    expect(obs!.value).toBe('pre-claude-5,indeterminate');
  });

  // The 14 rows are the last 14 RECORDED days, which can span far more calendar
  // time. A session on a gap day contributed to neither week's totals.
  it('ignores sessions on gap days inside the recorded range', () => {
    const cache = HOT();
    // Punch a hole: drop 2026-05-28 from the recorded days, keeping the range.
    cache.dailyActivity = cache.dailyActivity.filter((d) => d.date !== '2026-05-28');
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-05-28', '2.1.220')];
    const rec = detector.rule(input(cache, ran), NOW);
    expect(rec!.title).not.toContain('confounded');
    expect(rec!.severity).toBe('warning');
  });

  it('ignores sessions outside the recorded window entirely', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-07-28', '2.1.220')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.title).not.toContain('confounded');
    expect(rec!.severity).toBe('warning');
  });

  it('does not confound a window whose sessions carry no version', () => {
    const ran = [sessionOn('2026-05-23'), sessionOn('2026-06-01')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.title).not.toContain('confounded');
    expect(rec!.severity).toBe('warning');
  });

  it('behaves exactly as before when no sessions are supplied', () => {
    const withNone = detector.rule(input(HOT()), NOW);
    expect(withNone!.severity).toBe('warning');
    expect(withNone!.title).not.toContain('confounded');
  });

  it('hedges rather than asserting the harness caused the change', () => {
    const ran = [sessionOn('2026-05-23', '2.1.212'), sessionOn('2026-06-01', '2.1.220')];
    const rec = detector.rule(input(HOT(), ran), NOW);
    expect(rec!.detail).toContain('cannot be separated from');
    expect(rec!.detail).toContain('last 14 recorded days');
    expect(rec!.detail).not.toMatch(/changes tool-call volume on its own/);
    expect(rec!.provenance!.inference).toContain('cannot be separated from');
  });
});
