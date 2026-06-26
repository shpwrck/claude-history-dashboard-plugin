import { describe, it, expect } from 'vitest';
import {
  collectSessionBfcs,
  sessionBfcMetric,
} from './conversational-availability-metric';
import type { SessionTimeline, TimelineEntry } from '../parse-timeline';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const SEC = 1000;

function timeline(sessionId: string, entries: TimelineEntry[]): SessionTimeline {
  return {
    sessionId,
    startTime: entries[0]?.timestamp ?? iso(0),
    endTime: entries[entries.length - 1]?.timestamp ?? iso(0),
    entries,
  };
}

const userE = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'user', summary: 'go' });
const assistantE = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'assistant', summary: 'ok' });
// A blocking, backgroundable-kind foreground call (e.g. a long Bash build).
const blockingE = (ms: number): TimelineEntry => ({
  timestamp: iso(ms),
  kind: 'tool_use',
  toolName: 'Bash',
  backgroundableKind: true,
});
// A quick non-backgroundable foreground read.
const readE = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'tool_use', toolName: 'Read' });

describe('sessionBfcMetric (shared with the detector)', () => {
  it('counts blocking backgroundable foreground calls and totals tool calls', () => {
    const tl = timeline('s1', [
      userE(0),
      assistantE(1 * SEC),
      blockingE(2 * SEC), // blocks 30s -> counts
      assistantE(32 * SEC),
      readE(33 * SEC), // not backgroundable -> not a BFC, but is a tool call
      assistantE(34 * SEC),
    ]);
    const m = sessionBfcMetric(tl);
    expect(m.bfcCount).toBe(1);
    expect(m.toolCallCount).toBe(2);
    expect(m.blockedMin).toBe(1); // 30s rounds to 1 min via Math.round? -> 0.5 -> 1
  });

  it('does not count sub-floor blocks', () => {
    const tl = timeline('s2', [
      userE(0),
      assistantE(1 * SEC),
      blockingE(2 * SEC), // only 5s gap -> under the 10s floor
      assistantE(7 * SEC),
    ]);
    expect(sessionBfcMetric(tl).bfcCount).toBe(0);
  });

  it('reports zero metric for a session with no tool calls', () => {
    const tl = timeline('s3', [userE(0), assistantE(1 * SEC)]);
    const m = sessionBfcMetric(tl);
    expect(m).toEqual({ bfcCount: 0, blockedMin: 0, toolCallCount: 0 });
  });

  it('collectSessionBfcs dedups a parallel batch into one window', () => {
    // Two backgroundable calls at the SAME timestamp resume at the same
    // assistant entry -> one block window.
    const tl = timeline('s4', [
      userE(0),
      assistantE(1 * SEC),
      blockingE(2 * SEC),
      blockingE(2 * SEC),
      assistantE(40 * SEC),
    ]);
    expect(collectSessionBfcs(tl)).toHaveLength(1);
  });
});
