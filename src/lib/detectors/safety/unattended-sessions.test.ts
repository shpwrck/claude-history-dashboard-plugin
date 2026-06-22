import { describe, expect, it } from 'vitest';

import { detector, unattendedRiskSessions } from './unattended-sessions';
import type { RecommendationInput } from '../types';
import type { ToolUsageData } from '../../parse-tools';
import type { SessionTimeline } from '../../parse-timeline';
import type { SessionTokenData } from '../../../types';

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function token(sessionId: string, entrypoint: string): SessionTokenData {
  return {
    sessionId,
    entrypoint,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'unknown',
    messageCount: 1,
    entries: [],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

function dangerousTool(sessionId: string, command = 'rm -rf /tmp/build'): ToolUsageData {
  return {
    sessionId,
    calls: [
      {
        timestamp: '2026-06-22T12:00:00Z',
        toolName: 'Bash',
        input: { command },
        toolUseId: `${sessionId}-tool-1`,
        isError: false,
        resultBytes: 0,
      },
    ],
  };
}

function bypass(sessionId: string) {
  return { sessionId, mode: 'bypassPermissions' };
}

describe('safety.unattended-sessions (#1798)', () => {
  it('fires when an unattended session used bypassPermissions for dangerous commands', () => {
    const rec = detector.rule(
      input({
        tokenData: [token('sdk-risky-session', 'sdk-cli')],
        toolData: [dangerousTool('sdk-risky-session')],
        permissionRows: [bypass('sdk-risky-session')],
      }),
      0
    );

    expect(rec?.id).toBe('safety.unattended-sessions');
    expect(rec?.category).toBe('safety');
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBe(true);
    expect(rec?.view).toBe('permissions');
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence?.[0]).toContain('sdk-cli');
    expect(rec?.evidence?.[0]).toContain('rm -rf');
  });

  it('stays quiet when the dangerous bypassed session is interactive', () => {
    const rec = detector.rule(
      input({
        tokenData: [token('interactive-risky-session', 'cli')],
        toolData: [dangerousTool('interactive-risky-session')],
        permissionRows: [bypass('interactive-risky-session')],
      }),
      0
    );

    expect(rec).toBeNull();
  });

  it('stays quiet unless unattended, bypass mode, and dangerous commands overlap', () => {
    expect(
      detector.rule(
        input({
          tokenData: [token('sdk-no-bypass', 'sdk-py')],
          toolData: [dangerousTool('sdk-no-bypass')],
        }),
        0
      )
    ).toBeNull();

    expect(
      detector.rule(
        input({
          tokenData: [token('sdk-no-danger', 'sdk-cli')],
          permissionRows: [bypass('sdk-no-danger')],
        }),
        0
      )
    ).toBeNull();
  });

  it('can use timeline entrypoints when token entrypoints are absent', () => {
    const timeline = {
      sessionId: 'timeline-risk',
      entrypoint: 'sdk-cli',
      startTime: '2026-06-22T12:00:00Z',
      endTime: '2026-06-22T12:05:00Z',
      entries: [],
    } as unknown as SessionTimeline;

    expect(
      unattendedRiskSessions(
        input({
          timelines: [timeline],
          toolData: [dangerousTool('timeline-risk')],
          permissionRows: [bypass('timeline-risk')],
        })
      )
    ).toMatchObject([
      {
        sessionId: 'timeline-risk',
        entrypoint: 'sdk-cli',
        dangerousCount: 1,
      },
    ]);
  });
});
