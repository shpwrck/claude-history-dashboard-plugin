/**
 * Behavioral tests for activity.stale-projects (coverage gap #2967).
 *
 * Flags projects with real history (>= MIN_STALE_SESSIONS sessions) that have
 * had no activity for more than STALE_WEEKS weeks — unless the user has set
 * `cleanupPeriodDays` (then the rec is treated as already actioned). Fixtures
 * are shaped like the `projects` (ProjectStats) feed the engine assembles.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './stale-projects';
import { validateRecommendationProvenance } from '../provenance';
import { STALE_WEEKS, MIN_STALE_SESSIONS } from '../shared';
import type { RecommendationInput } from '../types';
import type { ProjectStats } from '../../../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00Z').getTime();
const CUTOFF = NOW - STALE_WEEKS * 7 * DAY;

function makeProject(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    project: '/home/u/proj',
    projectShort: 'proj',
    sessionCount: MIN_STALE_SESSIONS,
    messageCount: 100,
    firstSeen: NOW - 200 * DAY,
    lastSeen: CUTOFF - 5 * DAY, // stale by default
    sessions: [],
    ...overrides,
  };
}

// Only `projects` and `liveConfig.settings.cleanupPeriodDays` are read.
function input(
  projects: ProjectStats[],
  cleanupPeriodDays?: number
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects,
    permissionRows: [],
    apiErrors: [],
    liveConfig:
      cleanupPeriodDays === undefined
        ? null
        : ({ settings: { cleanupPeriodDays } } as unknown as RecommendationInput['liveConfig']),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('activity.stale-projects detector', () => {
  it('fires for a project with real history gone quiet past the cutoff', () => {
    const rec = detector.rule(
      input([makeProject({ projectShort: 'old-proj' })]),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('activity.stale-projects');
    expect(rec!.category).toBe('activity');
    expect(rec!.severity).toBe('info');
    expect(rec!.affected).toBe(1);
    expect(rec!.evidence?.[0]).toContain('old-proj');
  });

  it('sorts oldest-first and counts every stale project', () => {
    const rec = detector.rule(
      input([
        makeProject({ projectShort: 'newer', lastSeen: CUTOFF - 2 * DAY }),
        makeProject({ projectShort: 'oldest', lastSeen: CUTOFF - 40 * DAY }),
      ]),
      NOW
    );
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(2);
    expect(rec!.evidence?.[0]).toContain('oldest');
  });

  it('does not fire when cleanupPeriodDays is configured (rec is actioned)', () => {
    expect(
      detector.rule(input([makeProject()], STALE_WEEKS * 7), NOW)
    ).toBeNull();
  });

  it('does not fire when the project is still active (lastSeen after cutoff)', () => {
    expect(
      detector.rule(input([makeProject({ lastSeen: NOW - DAY })]), NOW)
    ).toBeNull();
  });

  it('does not fire for a project below the session-count floor', () => {
    expect(
      detector.rule(
        input([makeProject({ sessionCount: MIN_STALE_SESSIONS - 1 })]),
        NOW
      )
    ).toBeNull();
  });

  it('does not fire when lastSeen is unknown (<= 0)', () => {
    expect(detector.rule(input([makeProject({ lastSeen: 0 })]), NOW)).toBeNull();
  });

  it('does not fire when there are no projects', () => {
    expect(detector.rule(input([]), NOW)).toBeNull();
  });

  // ── Provenance (#3180) ───────────────────────────────────────────────────
  describe('provenance', () => {
    const fire = (projects = [makeProject({ projectShort: 'old-proj' })]) =>
      detector.rule(input(projects), NOW)!;

    it('passes the contract when it fires', () => {
      expect(validateRecommendationProvenance(fire())).toEqual([]);
    });

    it('cites the session floor against the module that declares it', () => {
      // The cited value is the CONSTANT, so the citation must point at
      // `MIN_STALE_SESSIONS` — `projects[].sessionCount` never holds it, and a
      // reader following that pointer finds a different number.
      const obs = fire().provenance!.observations.find((o) =>
        o.claim.includes('MIN_STALE_SESSIONS')
      );
      expect(obs, 'expected an observation citing the session floor').toBeDefined();
      expect(obs!.field).toBe('MIN_STALE_SESSIONS');
      expect(obs!.value).toBe(MIN_STALE_SESSIONS);
      expect(obs!.source).not.toContain('sessionCount');
    });

    it('describes the population it counted, not just "went quiet"', () => {
      // Projects below the session floor are ALSO quiet but are excluded, so a
      // bare "N of M went quiet" would misdescribe the M.
      const rec = fire([
        makeProject({ projectShort: 'counted' }),
        makeProject({ projectShort: 'too-few-sessions', sessionCount: MIN_STALE_SESSIONS - 1 }),
      ]);
      const head = rec.provenance!.observations[0];
      expect(head.value).toBe(1);
      expect(head.claim).toContain('2 known project(s)');
      expect(head.claim).toContain(`${MIN_STALE_SESSIONS}-session floor`);
    });

    it('dates the claim from the freshest observed activity, never from now', () => {
      const rec = fire([makeProject({ lastSeen: CUTOFF - 5 * DAY })]);
      expect(rec.provenance!.asOf).toBe(
        new Date(CUTOFF - 5 * DAY).toISOString().slice(0, 10)
      );
      expect(rec.provenance!.asOf).not.toBe(new Date(NOW).toISOString().slice(0, 10));
    });

    it('reproduces the count from the cited field — mutating lastSeen moves it', () => {
      const cited = (lastSeen: number) =>
        detector.rule(
          input([makeProject({ projectShort: 'a' }), makeProject({ projectShort: 'b', lastSeen })]),
          NOW
        )!.provenance!.observations[0].value;
      expect(cited(CUTOFF - 3 * DAY)).toBe(2); // both stale
      expect(cited(NOW - DAY)).toBe(1); // b is active again
    });

    it('separates the quiet measurement from the "is it finished" question', () => {
      expect(fire().provenance!.inference).toMatch(/cannot separate a completed project/i);
    });
  });
});
