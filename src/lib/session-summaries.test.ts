import { describe, expect, it } from 'vitest';
import type { Session, SessionTokenData, TokenEntry } from '../types';
import type { ToolUsageData } from './parse-tools';
import {
  composeSessionSummary,
  computeActivityRollups,
  ROLLUP_WINDOWS,
} from './session-summaries';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function session(
  overrides: Partial<Session> & Pick<Session, 'sessionId'>
): Session {
  const startTime = overrides.startTime ?? NOW - 30 * 60 * 1000;
  const endTime = overrides.endTime ?? startTime + 42 * 60 * 1000;
  return {
    project: '/work/app',
    projectShort: 'app',
    entries: [
      {
        display: 'Implement the session summary module',
        pastedContents: {},
        timestamp: startTime,
        project: overrides.project ?? '/work/app',
        sessionId: overrides.sessionId,
      },
    ],
    startTime,
    endTime,
    duration: endTime - startTime,
    messageCount: 3,
    ...overrides,
  };
}

function tokenEntry(overrides: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: '2026-06-12T11:30:00.000Z',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    // claude-sonnet-4-6 input is $3/MTok, so 1M input tokens = $3.00 exactly.
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

function tokenRow(
  sessionId: string,
  entries: TokenEntry[] = [tokenEntry()]
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((s, e) => s + e.inputTokens, 0),
    totalOutputTokens: entries.reduce((s, e) => s + e.outputTokens, 0),
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4-6',
    messageCount: 3,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

function toolRow(
  sessionId: string,
  calls: Array<{ toolName: string; filePath?: string }>
): ToolUsageData {
  return {
    sessionId,
    calls: calls.map((c, i) => ({
      timestamp: '2026-06-12T11:30:00.000Z',
      toolName: c.toolName,
      input: c.filePath ? { file_path: c.filePath } : {},
      toolUseId: `toolu_${sessionId}_${i}`,
      isError: false,
      resultBytes: 10,
    })),
  };
}

describe('composeSessionSummary', () => {
  it('composes title, duration, messages, tool mix, file impact and cost', () => {
    const s = session({
      sessionId: 's-full',
      title: 'Add session summaries',
      messageCount: 12,
    });
    const summary = composeSessionSummary({
      session: s,
      tokenData: tokenRow('s-full'),
      toolData: toolRow('s-full', [
        { toolName: 'Bash' },
        { toolName: 'Bash' },
        { toolName: 'Bash' },
        { toolName: 'Edit', filePath: '/work/app/src/a.ts' },
        { toolName: 'Edit', filePath: '/work/app/src/b.ts' },
        { toolName: 'Read', filePath: '/work/app/src/a.ts' },
      ]),
    });

    expect(summary.sessionType).toBe('single_task');
    expect(summary.toolCallCount).toBe(6);
    expect(summary.estimatedCost).toBeCloseTo(3, 6);
    expect(summary.text).toContain('Focused task in app');
    expect(summary.text).toContain('“Add session summaries”');
    expect(summary.text).toContain('42m');
    expect(summary.text).toContain('12 messages');
    expect(summary.text).toContain('6 tool calls (top: Bash, Edit, Read)');
    expect(summary.text).toContain('edited 2 files, read 1 file');
    expect(summary.text).toContain('~$3.00 est.');
  });

  it('falls back to the lead clause without a title and without token/tool data', () => {
    const s = session({ sessionId: 's-bare', messageCount: 1 });
    const summary = composeSessionSummary({ session: s });

    expect(summary.toolCallCount).toBe(0);
    expect(summary.estimatedCost).toBe(0);
    // No title quote, no cost/tool clauses — but never empty.
    expect(summary.text).not.toContain('“');
    expect(summary.text).not.toContain('$');
    expect(summary.text).toContain('in app');
    expect(summary.text).toContain('1 message');
  });

  it('handles a fully sparse session deterministically', () => {
    const s: Session = {
      sessionId: 's-sparse',
      project: '',
      projectShort: '',
      entries: [],
      startTime: 0,
      endTime: 0,
      duration: 0,
      messageCount: 0,
    };
    const summary = composeSessionSummary({ session: s });
    expect(summary.text).toBe('Quick question: no recorded activity.');
  });

  it('is deterministic — identical inputs produce identical output', () => {
    const make = () =>
      composeSessionSummary({
        session: session({ sessionId: 's-det', title: 'Fix flaky test' }),
        tokenData: tokenRow('s-det'),
        toolData: toolRow('s-det', [
          { toolName: 'Read', filePath: '/work/app/x.ts' },
          { toolName: 'Bash' },
        ]),
      });
    expect(make()).toEqual(make());
  });

  it('prefers an entry-carried title when the session has none', () => {
    const s = session({ sessionId: 's-entry-title' });
    s.entries = [
      {
        display: 'do the thing',
        pastedContents: {},
        timestamp: s.startTime,
        project: s.project,
        sessionId: s.sessionId,
        title: 'Entry-level title',
      },
    ];
    const summary = composeSessionSummary({ session: s });
    expect(summary.text).toContain('“Entry-level title”');
  });
});

describe('computeActivityRollups', () => {
  it('returns all four trailing windows anchored at nowMs', () => {
    const rollups = computeActivityRollups({ sessions: [], nowMs: NOW });
    expect(rollups.map((r) => r.window)).toEqual([
      'hour',
      'day',
      'week',
      'month',
    ]);
    for (const [i, rollup] of rollups.entries()) {
      expect(rollup.endMs).toBe(NOW);
      expect(rollup.startMs).toBe(NOW - ROLLUP_WINDOWS[i].ms);
      expect(rollup.sessionCount).toBe(0);
      expect(rollup.text).toBe(`${rollup.label}: no recorded sessions.`);
    }
  });

  it('buckets sessions by start time with inclusive window edges', () => {
    const atEdge = session({ sessionId: 's-edge', startTime: NOW - HOUR });
    const justOutside = session({
      sessionId: 's-out',
      startTime: NOW - HOUR - 1,
    });
    const atNow = session({ sessionId: 's-now', startTime: NOW });
    const future = session({ sessionId: 's-future', startTime: NOW + 1 });

    const rollups = computeActivityRollups({
      sessions: [atEdge, justOutside, atNow, future],
      nowMs: NOW,
    });
    const hour = rollups.find((r) => r.window === 'hour');
    const ids = hour?.notableSessions.map((s) => s.sessionId).sort();
    expect(hour?.sessionCount).toBe(2);
    expect(ids).toEqual(['s-edge', 's-now']);

    // The just-outside-the-hour session still lands in the 24-hour window;
    // the future-dated one never does.
    const day = rollups.find((r) => r.window === 'day');
    expect(day?.sessionCount).toBe(3);
  });

  it('rolls up totals and per-project rows across a window', () => {
    const sessions = [
      session({
        sessionId: 's-app-1',
        startTime: NOW - 2 * HOUR,
        messageCount: 4,
      }),
      session({
        sessionId: 's-app-2',
        startTime: NOW - 3 * HOUR,
        messageCount: 2,
      }),
      session({
        sessionId: 's-docs',
        startTime: NOW - 4 * HOUR,
        project: '/work/docs',
        projectShort: 'docs',
        messageCount: 5,
      }),
    ];
    const rollups = computeActivityRollups({
      sessions,
      tokenData: [tokenRow('s-app-1'), tokenRow('s-docs')],
      toolData: [
        toolRow('s-app-1', [{ toolName: 'Bash' }, { toolName: 'Bash' }]),
        toolRow('s-docs', [{ toolName: 'Edit', filePath: '/work/docs/r.md' }]),
      ],
      nowMs: NOW,
    });
    const day = rollups.find((r) => r.window === 'day');
    expect(day?.sessionCount).toBe(3);
    expect(day?.messageCount).toBe(11);
    expect(day?.toolCallCount).toBe(3);
    expect(day?.estimatedCost).toBeCloseTo(6, 6);

    // Per-project: app (2 sessions) sorts before docs (1 session).
    expect(day?.projects.map((p) => p.projectShort)).toEqual(['app', 'docs']);
    expect(day?.projects[0]).toMatchObject({
      project: '/work/app',
      sessionCount: 2,
      toolCallCount: 2,
    });
    expect(day?.projects[1]).toMatchObject({
      project: '/work/docs',
      sessionCount: 1,
      toolCallCount: 1,
    });

    // The hour window holds none of them, the week/month windows all three.
    expect(rollups.find((r) => r.window === 'hour')?.sessionCount).toBe(0);
    expect(rollups.find((r) => r.window === 'week')?.sessionCount).toBe(3);
    expect(rollups.find((r) => r.window === 'month')?.sessionCount).toBe(3);
  });

  it('ranks notable sessions by cost, then duration, and caps at three', () => {
    const cheapLong = session({
      sessionId: 's-cheap-long',
      startTime: NOW - 5 * HOUR,
      endTime: NOW - 1 * HOUR,
      duration: 4 * HOUR,
    });
    const pricey = session({ sessionId: 's-pricey', startTime: NOW - 6 * HOUR });
    const cheapShort1 = session({
      sessionId: 's-a',
      startTime: NOW - 7 * HOUR,
      duration: 60_000,
      endTime: NOW - 7 * HOUR + 60_000,
    });
    const cheapShort2 = session({
      sessionId: 's-b',
      startTime: NOW - 8 * HOUR,
      duration: 60_000,
      endTime: NOW - 8 * HOUR + 60_000,
    });
    const rollups = computeActivityRollups({
      sessions: [cheapLong, pricey, cheapShort1, cheapShort2],
      tokenData: [tokenRow('s-pricey')],
      nowMs: NOW,
    });
    const day = rollups.find((r) => r.window === 'day');
    expect(day?.notableSessions).toHaveLength(3);
    expect(day?.notableSessions.map((s) => s.sessionId)).toEqual([
      's-pricey',
      's-cheap-long',
      's-a',
    ]);
  });

  it('writes a deterministic window narrative with projects, categories and tools', () => {
    const sessions = [
      session({ sessionId: 's-1', startTime: NOW - 2 * HOUR, messageCount: 4 }),
      session({
        sessionId: 's-2',
        startTime: NOW - 26 * HOUR,
        project: '/work/docs',
        projectShort: 'docs',
      }),
    ];
    const run = () =>
      computeActivityRollups({
        sessions,
        tokenData: [tokenRow('s-1')],
        toolData: [toolRow('s-1', [{ toolName: 'Bash' }])],
        nowMs: NOW,
      });
    const week = run().find((r) => r.window === 'week');
    expect(week?.text).toBe(
      'Last 7 days: 2 sessions across 2 projects (top: app), 7 messages, ' +
        '1 tool call, ~$3.00 est.; mostly focused tasks; top tools Bash.'
    );
    // Determinism: a second run yields a deep-equal result.
    expect(run()).toEqual(run());
  });

  it('ignores sessions with non-finite start times', () => {
    const bad = session({ sessionId: 's-nan', startTime: Number.NaN });
    const rollups = computeActivityRollups({ sessions: [bad], nowMs: NOW });
    expect(rollups.every((r) => r.sessionCount === 0)).toBe(true);
  });

  it('keeps month-window membership stable across a 30-day edge', () => {
    const inside = session({
      sessionId: 's-29d',
      startTime: NOW - 30 * DAY,
    });
    const outside = session({
      sessionId: 's-31d',
      startTime: NOW - 30 * DAY - 1,
    });
    const month = computeActivityRollups({
      sessions: [inside, outside],
      nowMs: NOW,
    }).find((r) => r.window === 'month');
    expect(month?.sessionCount).toBe(1);
    expect(month?.notableSessions[0]?.sessionId).toBe('s-29d');
  });
});
