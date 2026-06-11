import { describe, expect, it } from 'vitest';
import { detector, attributeWallClock } from './time-motion';
import type { RecommendationInput } from '../types';

const minute = 60 * 1000;

function baseInput(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    ...over,
  };
}

function ts(min: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, min, 0)).toISOString();
}

describe('speed.time-motion (#596)', () => {
  it('attributes active, idle, and serial-tool wall-clock buckets', () => {
    const input = baseInput({
      runtimeEvents: [
        {
          sessionId: 'time-motion-session',
          turns: [
            { sessionId: 'time-motion-session', timestamp: ts(1), durationMs: 12 * minute, messageCount: 4 },
            { sessionId: 'time-motion-session', timestamp: ts(20), durationMs: 16 * minute, messageCount: 1 },
            { sessionId: 'time-motion-session', timestamp: ts(50), durationMs: 8 * minute, messageCount: 3 },
          ],
          stopHooks: [],
          awaySummaries: [
            { sessionId: 'time-motion-session', timestamp: ts(21), content: 'AFK recap: resumed after lunch.' },
          ],
          scheduledFires: [],
        },
      ],
      timelines: [
        {
          sessionId: 'time-motion-session',
          startTime: ts(0),
          endTime: ts(80),
          entries: [
            { timestamp: ts(3), kind: 'tool_use', summary: '{}', toolName: 'Read' },
            { timestamp: ts(12), kind: 'tool_result', summary: 'file contents', isError: false },
            { timestamp: ts(13), kind: 'tool_use', summary: '{}', toolName: 'Grep' },
            { timestamp: ts(21), kind: 'tool_result', summary: 'matches', isError: false },
            { timestamp: ts(22), kind: 'tool_use', summary: '{}', toolName: 'Glob' },
            { timestamp: ts(29), kind: 'tool_result', summary: 'paths', isError: false },
          ],
        },
      ],
    });

    const attribution = attributeWallClock(input);
    expect(attribution.modelWorkingMs).toBe(0);
    expect(attribution.idleMs).toBe(16 * minute);
    expect(attribution.serialToolMs).toBe(24 * minute);
    expect(attribution.serialPairs).toBe(3);
    expect(attribution.dominant).toBe('serial tools');

    const rec = detector.rule(input, 0);
    expect(rec?.id).toBe('speed.time-motion');
    expect(rec?.title).toContain('Batch serial file reads');
    expect(rec?.detail).toContain('model-working turns');
    expect(rec?.detail).toContain('idle/AFK');
    expect(rec?.detail).toContain('serial Read latency');
    expect(rec?.detail).toContain('TTFT and read-time-vs-AFK are out of scope');
    expect(rec?.detail).toContain('15.0m idle split is a heuristic boundary');
    expect(rec?.action).toContain('Batch independent Read/Grep/Glob/LS');
    expect(rec?.evidence?.[0]).toContain('serial tools');
  });

  it('stays dark when measured waits are below the meaningful thresholds', () => {
    const input = baseInput({
      runtimeEvents: [
        {
          sessionId: 'fast',
          turns: [
            { sessionId: 'fast', timestamp: ts(1), durationMs: 90 * 1000, messageCount: 2 },
          ],
          stopHooks: [],
          awaySummaries: [],
          scheduledFires: [],
        },
      ],
      timelines: [
        {
          sessionId: 'fast',
          startTime: ts(0),
          endTime: ts(2),
          entries: [
            { timestamp: ts(0), kind: 'tool_use', summary: '{}', toolName: 'Read' },
            { timestamp: ts(1), kind: 'tool_result', summary: 'ok', isError: false },
          ],
        },
      ],
    });

    expect(detector.rule(input, 0)).toBeNull();
  });
});
