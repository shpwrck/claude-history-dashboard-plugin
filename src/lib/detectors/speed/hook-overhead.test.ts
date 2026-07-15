import { describe, expect, it } from 'vitest';
import type { RuntimeEvents } from '../../parse-runtime-events';
import {
  aggregateDatedStopHooks,
  runtimeEventTimestampMs,
} from './hook-overhead';

const runtime = (
  stopHooks: RuntimeEvents['stopHooks']
): RuntimeEvents => ({
  sessionId: 's',
  turns: [],
  stopHooks,
  awaySummaries: [],
  scheduledFires: [],
});

const stop = (timestamp: string, totalDurationMs = 3000) => ({
  sessionId: 's',
  timestamp,
  hookCount: 1,
  totalDurationMs,
  hadErrors: false,
  preventedContinuation: false,
});

describe('aggregateDatedStopHooks', () => {
  it('filters an inclusive window and dates only measured timing evidence', () => {
    const now = Date.parse('2026-07-14T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const data = runtime([
      stop(new Date(now - 28 * day).toISOString(), 2000),
      stop(new Date(now - 2 * day).toISOString(), 4000),
      stop(new Date(now - day).toISOString(), 0),
      stop(new Date(now + 1).toISOString(), 8000),
      stop('undated', 6000),
    ]);

    expect(
      aggregateDatedStopHooks([data], now - 28 * day, now)
    ).toMatchObject({
      events: 3,
      timedEvents: 2,
      totalDurationMs: 6000,
      meanTimedDurationMs: 3000,
      maxDurationMs: 4000,
      latestTimedTimestampMs: now - 2 * day,
    });
  });

  it('returns an empty aggregate for invalid bounds', () => {
    expect(
      aggregateDatedStopHooks([runtime([])], Number.NaN, 0)
    ).toMatchObject({
      events: 0,
      timedEvents: 0,
      latestTimedTimestampMs: null,
    });
  });

  it('rejects incomplete, impossible, and out-of-range RFC3339 datetimes', () => {
    const from = Date.parse('2026-07-01T00:00:00Z');
    const through = Date.parse('2026-08-01T00:00:00Z');
    const data = runtime([
      stop('2026-07-15T08:00:00-04:00'),
      stop('2026-07-15T08:00:00'),
      stop('2026-07-15'),
      stop('2026-07-15T24:00:00Z'),
      stop('2026-07-15T08:00:00+14:01'),
      stop('2026-07-15T08:00:00+23:59'),
      stop('2026-02-30T08:00:00Z'),
      stop('2026-07-16T08:00:00Z', -500),
    ]);

    expect(aggregateDatedStopHooks([data], from, through)).toMatchObject({
      events: 2,
      timedEvents: 1,
      totalDurationMs: 3000,
      meanTimedDurationMs: 3000,
      maxDurationMs: 3000,
      latestTimedTimestampMs: Date.parse('2026-07-15T12:00:00Z'),
    });
    expect(runtimeEventTimestampMs('2026-07-15T08:00:00-04:00')).toBe(
      Date.parse('2026-07-15T12:00:00Z')
    );
  });
});
