import { describe, it, expect } from 'vitest'
import {
  parseRuntimeEvents,
  aggregateTurnLatency,
  aggregateStopHooks,
  collectAutomationFeed,
  IDLE_TURN_THRESHOLD_MS,
} from './parse-runtime-events'
import type { RuntimeEvents } from './parse-runtime-events'

const line = (o: Record<string, unknown>) => JSON.stringify({ type: 'system', timestamp: 't', ...o })

describe('parseRuntimeEvents', () => {
  it('returns null when no recognized system events are present', () => {
    expect(parseRuntimeEvents(JSON.stringify({ type: 'user', timestamp: 't' }), 's.jsonl')).toBeNull()
  })

  it('parses turn_duration events', () => {
    const out = parseRuntimeEvents(line({ subtype: 'turn_duration', durationMs: 1234, messageCount: 5 }), 'sess.jsonl')!
    expect(out.sessionId).toBe('sess')
    expect(out.turns[0]).toMatchObject({ durationMs: 1234, messageCount: 5 })
  })

  it('sums hook durations and flags errors/prevented-continuation for stop_hook_summary', () => {
    const out = parseRuntimeEvents(
      line({
        subtype: 'stop_hook_summary',
        hookCount: 2,
        hookInfos: [{ durationMs: 30 }, { durationMs: 70 }],
        hookErrors: ['boom'],
        preventedContinuation: true,
      }),
      's.jsonl'
    )!
    expect(out.stopHooks[0]).toMatchObject({
      hookCount: 2,
      totalDurationMs: 100,
      hadErrors: true,
      preventedContinuation: true,
    })
  })

  it('collects away_summary and scheduled_task_fire narrative events', () => {
    const text = [
      line({ subtype: 'away_summary', content: 'was away' }),
      line({ subtype: 'scheduled_task_fire', content: [{ text: 'cron' }, { text: 'fired' }] }),
    ].join('\n')
    const out = parseRuntimeEvents(text, 's.jsonl')!
    expect(out.awaySummaries[0].content).toBe('was away')
    expect(out.scheduledFires[0].content).toBe('cron fired')
  })
})

const runtime = (turns: number[]): RuntimeEvents => ({
  sessionId: 's',
  turns: turns.map((durationMs) => ({ sessionId: 's', timestamp: 't', durationMs, messageCount: 1 })),
  stopHooks: [],
  awaySummaries: [],
  scheduledFires: [],
})

describe('aggregateTurnLatency', () => {
  it('partitions active vs idle turns at the idle threshold', () => {
    const idle = IDLE_TURN_THRESHOLD_MS + 1
    const report = aggregateTurnLatency([runtime([1000, 3000, idle])])
    expect(report.active.count).toBe(2)
    expect(report.active.totalDurationMs).toBe(4000)
    expect(report.active.meanDurationMs).toBe(2000)
    expect(report.active.maxDurationMs).toBe(3000)
    expect(report.idle.count).toBe(1)
    expect(report.idle.maxDurationMs).toBe(idle)
    expect(report.idleThresholdMs).toBe(IDLE_TURN_THRESHOLD_MS)
  })

  it('computes the median (p50) of active durations', () => {
    expect(aggregateTurnLatency([runtime([100, 200, 300])]).active.p50DurationMs).toBe(200)
  })
})

describe('aggregateStopHooks', () => {
  it('rolls up hook events, durations, errors, and prevented continuations', () => {
    const data: RuntimeEvents[] = [
      {
        sessionId: 's',
        turns: [],
        stopHooks: [
          { sessionId: 's', timestamp: 't', hookCount: 1, totalDurationMs: 40, hadErrors: true, preventedContinuation: false },
          { sessionId: 's', timestamp: 't', hookCount: 1, totalDurationMs: 60, hadErrors: false, preventedContinuation: true },
        ],
        awaySummaries: [],
        scheduledFires: [],
      },
    ]
    expect(aggregateStopHooks(data)).toEqual({
      events: 2,
      hookCount: 2,
      totalDurationMs: 100,
      meanDurationMs: 50,
      maxDurationMs: 60,
      timedEvents: 2,
      meanTimedDurationMs: 50,
      errorEvents: 1,
      preventedContinuations: 1,
    })
  })

  it('meanTimedDurationMs divides only by events with a measured duration', () => {
    const data: RuntimeEvents[] = [
      {
        sessionId: 's',
        turns: [],
        stopHooks: [
          // 3 events ran hooks; only one carried a measured durationMs.
          { sessionId: 's', timestamp: 't', hookCount: 2, totalDurationMs: 0, hadErrors: false, preventedContinuation: false },
          { sessionId: 's', timestamp: 't', hookCount: 1, totalDurationMs: 0, hadErrors: false, preventedContinuation: false },
          { sessionId: 's', timestamp: 't', hookCount: 1, totalDurationMs: 6000, hadErrors: false, preventedContinuation: false },
        ],
        awaySummaries: [],
        scheduledFires: [],
      },
    ]
    const stats = aggregateStopHooks(data)
    expect(stats.events).toBe(3)
    expect(stats.hookCount).toBe(4)
    expect(stats.timedEvents).toBe(1)
    // diluted across all 3 events (6000 / 3) vs. honest over the 1 timed event.
    expect(stats.meanDurationMs).toBe(2000)
    expect(stats.meanTimedDurationMs).toBe(6000)
  })
})

describe('collectAutomationFeed', () => {
  it('merges away + scheduled events into one feed sorted newest-first with a kind tag', () => {
    const data: RuntimeEvents[] = [
      {
        sessionId: 's',
        turns: [],
        stopHooks: [],
        awaySummaries: [{ sessionId: 's', timestamp: '2026-01-01T00:00:00Z', content: 'away' }],
        scheduledFires: [{ sessionId: 's', timestamp: '2026-01-02T00:00:00Z', content: 'cron' }],
      },
    ]
    const feed = collectAutomationFeed(data)
    expect(feed.map((f) => [f.kind, f.content])).toEqual([
      ['scheduled', 'cron'], // newer first
      ['away', 'away'],
    ])
  })
})
