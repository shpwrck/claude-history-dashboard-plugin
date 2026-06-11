import { describe, expect, it } from 'vitest';
import type { SessionTokenData, TokenEntry } from '../types';
import { parseRuntimeEvents } from './parse-runtime-events';
import {
  classifySteeringTurn,
  extractTaskSteeringFromTranscript,
} from './parse-steering';

const line = (value: Record<string, unknown>) => JSON.stringify(value);

function userLine(
  content: unknown,
  timestamp: string,
  extra: Record<string, unknown> = {}
): string {
  return line({
    type: 'user',
    timestamp,
    message: { role: 'user', content },
    ...extra,
  });
}

function stopLine(timestamp: string, preventedContinuation = false): string {
  return line({
    type: 'system',
    subtype: 'stop_hook_summary',
    timestamp,
    hookCount: 1,
    hookInfos: [{ command: 'notify', durationMs: 50 }],
    hookErrors: [],
    preventedContinuation,
  });
}

function tokenEntry(timestamp: string): TokenEntry {
  return {
    timestamp,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-sonnet-4',
  };
}

function tokenData(entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId: 'steer-session',
    project: '/repo/app',
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  };
}

describe('parse-steering', () => {
  it('counts corrective steering in the stop-hook-delimited span and ignores meta/tool-result turns', () => {
    const transcript = [
      userLine('implement the first version', '2026-01-01T00:00:00.000Z', {
        cwd: '/repo/app',
      }),
      userLine('no, revert that', '2026-01-01T00:00:01.000Z', {
        cwd: '/repo/app',
        isMeta: true,
      }),
      userLine(
        [{ type: 'tool_result', content: 'no, revert that' }],
        '2026-01-01T00:00:02.000Z',
        { cwd: '/repo/app' }
      ),
      stopLine('2026-01-01T00:00:03.000Z'),
      userLine('no, revert that and keep the old API', '2026-01-01T00:00:04.000Z', {
        cwd: '/repo/app',
      }),
      stopLine('2026-01-01T00:00:06.000Z', true),
    ].join('\n');
    const runtime = parseRuntimeEvents(transcript, 'steer-session.jsonl');
    const rows = extractTaskSteeringFromTranscript(
      transcript,
      'steer-session.jsonl',
      {
        fallbackProject: '/repo/app',
        runtimeEvents: runtime,
        tokenData: tokenData([tokenEntry('2026-01-01T00:00:04.500Z')]),
      }
    );

    const correctiveSpan = rows.find((row) => row.taskIndex === 1);
    expect(correctiveSpan).toBeTruthy();
    expect(correctiveSpan?.corrective).toBeGreaterThanOrEqual(1);
    expect(correctiveSpan?.humanTurns).toBe(1);
    expect(correctiveSpan?.interruptions).toBe(1);
    expect(correctiveSpan?.costUsd).toBeGreaterThan(0);
    expect(correctiveSpan?.wallClockMs).toBeGreaterThan(0);
    expect(rows.reduce((sum, row) => sum + row.humanTurns, 0)).toBe(2);
  });

  it('classifies held-out corrective and non-corrective steering fixtures precisely', () => {
    expect(classifySteeringTurn('no, revert that')).toBe('corrective');
    expect(classifySteeringTurn('actually use the beta branch')).toBe('corrective');
    expect(classifySteeringTurn('stop here')).toBe('approving');
    expect(classifySteeringTurn('happy to stop here')).toBe('approving');
    expect(classifySteeringTurn('yes, the file is src/App.tsx')).toBe(
      'clarifying-answer'
    );
    expect(
      classifySteeringTurn(
        '<system-reminder>no, revert that synthetic reminder</system-reminder>'
      )
    ).toBeNull();
  });
});
