import { describe, it, expect } from 'vitest'
import {
  parseRuntimeEvents,
  aggregateTurnLatency,
  aggregateStopHooks,
  aggregatePerTaskCost,
  collectAutomationFeed,
  IDLE_TURN_THRESHOLD_MS,
} from './parse-runtime-events'
import type { RuntimeEvents } from './parse-runtime-events'
import { entryCostAtModel } from './pricing'
import type { SessionTokenData, TokenEntry } from '../types'

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

const taskTimestamp = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()

const tokenEntry = (
  seconds: number,
  inputTokens = 1,
  outputTokens = 1
): TokenEntry => ({
  timestamp: taskTimestamp(seconds),
  inputTokens,
  outputTokens,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model: 'claude-sonnet-4-20250514',
})

function runtimeWithStops(sessionId: string, stopSeconds: number[]): RuntimeEvents {
  return {
    sessionId,
    turns: [],
    stopHooks: stopSeconds.map((seconds) => ({
      sessionId,
      timestamp: taskTimestamp(seconds),
      hookCount: 1,
      totalDurationMs: 0,
      hadErrors: false,
      preventedContinuation: false,
    })),
    awaySummaries: [],
    scheduledFires: [],
  }
}

function tokenSession(sessionId: string, entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
    totalOutputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-sonnet-4-20250514',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }
}

function referencePerTaskCost(
  runtimeData: RuntimeEvents[],
  tokenData: SessionTokenData[]
) {
  const stopsBySession = new Map<string, number[]>()
  for (const session of runtimeData) {
    const stops = session.stopHooks
      .map((hook) => Date.parse(hook.timestamp))
      .filter((timestamp) => isFinite(timestamp))
      .sort((left, right) => left - right)
    if (stops.length > 0) stopsBySession.set(session.sessionId, stops)
  }

  const taskCosts: number[] = []
  let sessions = 0
  for (const session of tokenData) {
    const stops = stopsBySession.get(session.sessionId)
    if (!stops || session.entries.length === 0) continue
    const buckets = new Map<number, number>()
    for (const entry of session.entries) {
      const timestamp = Date.parse(entry.timestamp)
      if (!isFinite(timestamp)) continue
      const cost = entryCostAtModel(entry, entry.model)
      let index = stops.findIndex((stop) => stop >= timestamp)
      if (index === -1) index = stops.length
      buckets.set(index, (buckets.get(index) ?? 0) + cost)
    }
    if (buckets.size === 0) continue
    sessions += 1
    for (const cost of buckets.values()) taskCosts.push(cost)
  }

  const sorted = taskCosts.slice().sort((left, right) => left - right)
  const quantile = (q: number) => {
    if (sorted.length === 0) return 0
    const position = (sorted.length - 1) * q
    const low = Math.floor(position)
    const high = Math.ceil(position)
    if (low === high) return sorted[low]
    return (
      sorted[low] +
      (sorted[high] - sorted[low]) * (position - low)
    )
  }
  const totalCost = sorted.reduce((sum, cost) => sum + cost, 0)
  return {
    taskCount: sorted.length,
    totalCost,
    meanCost: sorted.length === 0 ? 0 : totalCost / sorted.length,
    medianCost: quantile(0.5),
    p95Cost: quantile(0.95),
    sessions,
  }
}

describe('aggregatePerTaskCost stop attribution (#3150)', () => {
  it('matches the former linear reference byte-for-byte on awkward ordering', () => {
    const runtimeData: RuntimeEvents[] = [
      runtimeWithStops('a', [30, 10, 20, 20]),
      runtimeWithStops('no-token-rows', [10]),
      runtimeWithStops('invalid-stop-only', []),
    ]
    runtimeData[2].stopHooks.push({
      sessionId: 'invalid-stop-only',
      timestamp: 'not-a-date',
      hookCount: 1,
      totalDurationMs: 0,
      hadErrors: false,
      preventedContinuation: false,
    })
    const tokenData = [
      tokenSession('a', [
        tokenEntry(31, 5, 1),
        tokenEntry(20, 4, 2),
        { ...tokenEntry(5, 3, 3), timestamp: 'not-a-date' },
        tokenEntry(5, 2, 4),
        tokenEntry(20, 1, 5),
      ]),
      tokenSession('no-stops', [tokenEntry(1)]),
      tokenSession('invalid-stop-only', [tokenEntry(1)]),
    ]

    const reference = referencePerTaskCost(runtimeData, tokenData)
    const actual = aggregatePerTaskCost(runtimeData, tokenData)
    expect(JSON.stringify(actual)).toBe(JSON.stringify(reference))
  })

  it('uses logarithmic stop comparisons as entries and stops double', () => {
    const measure = (size: number) => {
      const runtimeData = [runtimeWithStops('scale', Array.from(
        { length: size },
        (_, index) => index
      ))]
      // Put every entry after the final stop: the old restarted scan performed
      // exactly size comparisons per entry, its worst case.
      const tokenData = [
        tokenSession(
          'scale',
          Array.from({ length: size }, () => tokenEntry(size + 1))
        ),
      ]
      const probe = { stopComparisons: 0 }
      const result = aggregatePerTaskCost(runtimeData, tokenData, probe)
      return { comparisons: probe.stopComparisons, result }
    }

    const small = measure(512)
    const large = measure(1_024)

    expect(small.result.taskCount).toBe(1)
    expect(large.result.taskCount).toBe(1)
    expect(small.comparisons).toBeGreaterThanOrEqual(512)
    expect(large.comparisons).toBeGreaterThanOrEqual(1_024)
    expect(small.comparisons).toBeLessThanOrEqual(512 * 10)
    expect(large.comparisons).toBeLessThanOrEqual(1_024 * 11)
    expect(large.comparisons / small.comparisons).toBeLessThan(3)
    // The old linear scan performed 262,144 / 1,048,576 comparisons.
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
