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
    // #3229: the 24m of summed serial gaps exceed the 20m of active runtime, so
    // the attributed serial bucket is CAPPED at active runtime (20m); the 4m
    // overrun is held as diagnostic evidence, never attributed.
    expect(attribution.serialToolMs).toBe(20 * minute);
    expect(attribution.unattributedSerialMs).toBe(4 * minute);
    expect(attribution.serialPairs).toBe(3);
    expect(attribution.dominant).toBe('serial tools');

    // The attributed buckets must PARTITION the measured runtime, never exceed
    // it: model-working + idle + serial === the 36m of valid runtime turns.
    const attributedTotal =
      attribution.modelWorkingMs + attribution.idleMs + attribution.serialToolMs;
    const validRuntimeTurnMs = 12 * minute + 16 * minute + 8 * minute; // all turns valid (>0)
    expect(attributedTotal).toBe(36 * minute);
    expect(attributedTotal).toBeLessThanOrEqual(validRuntimeTurnMs);
    // Every bucket is non-negative.
    for (const ms of [
      attribution.modelWorkingMs,
      attribution.idleMs,
      attribution.serialToolMs,
    ]) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }

    const rec = detector.rule(input, 0);
    expect(rec?.id).toBe('speed.time-motion');
    expect(rec?.title).toContain('Batch serial file reads');
    expect(rec?.detail).toContain('model-working turns');
    expect(rec?.detail).toContain('idle/AFK');
    expect(rec?.detail).toContain('serial Read latency');
    // The overrun is surfaced as diagnostic-only, not folded into the total.
    expect(rec?.detail).toContain('4.0m of serial gap time overran');
    expect(rec?.detail).toContain('diagnostic evidence only');
    expect(rec?.detail).toContain('Attributed 36.0m of measured wall-clock');
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
