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
});
