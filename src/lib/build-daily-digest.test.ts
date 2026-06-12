import { describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  buildDailyDigest,
  isDailyDigestDate,
  localDigestDateKey,
} from './build-daily-digest';
import type { StatsCache } from './parse-stats-cache';
import type { TaskSuccessProxy } from './parse-task-success';
import type { ToolUsageData } from './parse-tools';

function session(overrides: Partial<Session> & Pick<Session, 'sessionId'>): Session {
  const startTime = overrides.startTime ?? Date.parse('2026-06-10T14:00:00.000Z');
  const endTime = overrides.endTime ?? startTime + 30 * 60 * 1000;
  return {
    sessionId: overrides.sessionId,
    project: overrides.project ?? '/work/app',
    projectShort: overrides.projectShort ?? 'app',
    entries:
      overrides.entries ?? [
        {
          display: overrides.title ?? 'Implement daily digest engine',
          pastedContents: {},
          timestamp: startTime,
          project: overrides.project ?? '/work/app',
          sessionId: overrides.sessionId,
          ...(overrides.title ? { title: overrides.title } : {}),
        },
      ],
    startTime,
    endTime,
    duration: endTime - startTime,
    messageCount: overrides.messageCount ?? 1,
    ...(overrides.title ? { title: overrides.title } : {}),
  };
}

function toolRow(sessionId: string, filePaths: string[]): ToolUsageData {
  return {
    sessionId,
    calls: filePaths.map((filePath, index) => ({
      timestamp: '2026-06-10T14:00:00.000Z',
      toolName: index === 0 ? 'Write' : 'Read',
      input: { file_path: filePath },
      toolUseId: `toolu_${sessionId}_${index}`,
      isError: false,
      resultBytes: 10,
    })),
  };
}

const statsCache: StatsCache = {
  version: 3,
  lastComputedDate: '2026-06-10',
  dailyActivity: [
    {
      date: '2026-06-10',
      messageCount: 42,
      sessionCount: 7,
      toolCallCount: 13,
    },
  ],
};

const acceptedTask: TaskSuccessProxy = {
  sessionId: 's-impl',
  project: '/work/app',
  taskIndex: 0,
  startTime: '2026-06-10T14:00:00.000Z',
  endTime: '2026-06-10T14:45:00.000Z',
  wallClockMs: 45 * 60 * 1000,
  verdict: 'accept',
  agentClaim: 'completed',
  confidence: 'high',
  successScore: 0.92,
  backedByMutation: true,
  mutatingToolCount: 1,
  toolCallCount: 2,
  toolResultCount: 2,
  toolErrorCount: 0,
  toolErrorRate: 0,
  errorPenalty: 0,
};

describe('buildDailyDigest', () => {
  it('builds total and per-project category groups for one server-local day', () => {
    const digest = buildDailyDigest(
      {
        sessions: [
          session({
            sessionId: 's-impl',
            title: 'Implement daily digest engine',
            project: '/work/app',
            projectShort: 'app',
            messageCount: 3,
          }),
          session({
            sessionId: 's-docs',
            title: 'Update README documentation',
            project: '/work/docs',
            projectShort: 'docs',
            messageCount: 2,
          }),
          session({
            sessionId: 's-other-day',
            startTime: Date.parse('2026-06-11T14:00:00.000Z'),
            endTime: Date.parse('2026-06-11T15:00:00.000Z'),
          }),
        ],
        toolData: [
          toolRow('s-impl', ['src/lib/build-daily-digest.ts', 'src/types.ts']),
          toolRow('s-docs', ['README.md']),
        ],
        taskSuccess: [acceptedTask],
        statsCache,
        nowMs: Date.parse('2026-06-10T18:00:00.000Z'),
      },
      '2026-06-10'
    );

    expect(digest.schemaVersion).toBe('1');
    expect(digest.date).toBe('2026-06-10');
    expect(digest.total).toMatchObject({
      sessionCount: 2,
      messageCount: 5,
      toolCallCount: 3,
      activity: {
        messageCount: 42,
        sessionCount: 7,
        toolCallCount: 13,
      },
    });
    expect(digest.total.categories.map((group) => group.category)).toEqual([
      'implementation',
      'documentation',
    ]);
    expect(digest.projects.map((project) => project.projectShort)).toEqual([
      'app',
      'docs',
    ]);
    expect(digest.projects[0].categories[0].sessions[0]).toMatchObject({
      sessionId: 's-impl',
      taskCategory: 'implementation',
      outcome: 'accepted',
      fileImpact: ['src/lib/build-daily-digest.ts', 'src/types.ts'],
    });
  });

  it('uses the requested local timezone for day-boundary bucketing', () => {
    const lateEvening = Date.parse('2026-06-11T03:30:00.000Z');

    expect(localDigestDateKey(lateEvening, 'America/New_York')).toBe(
      '2026-06-10'
    );

    const digest = buildDailyDigest(
      [session({ sessionId: 's-night', startTime: lateEvening })],
      '2026-06-10',
      'America/New_York'
    );

    expect(digest.total.sessionCount).toBe(1);
    expect(digest.timeZone).toBe('America/New_York');
  });

  it('returns an empty digest for a day with no sessions', () => {
    const digest = buildDailyDigest(
      [session({ sessionId: 's-old' })],
      '2026-06-12'
    );

    expect(digest.total).toMatchObject({
      date: '2026-06-12',
      sessionCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      categories: [],
    });
    expect(digest.projects).toEqual([]);
  });
});

describe('isDailyDigestDate', () => {
  it('accepts real YYYY-MM-DD dates only', () => {
    expect(isDailyDigestDate('2026-06-10')).toBe(true);
    expect(isDailyDigestDate('2026-02-31')).toBe(false);
    expect(isDailyDigestDate('06/10/2026')).toBe(false);
  });
});
