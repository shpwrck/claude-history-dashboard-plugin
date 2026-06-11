import { describe, it, expect } from 'vitest'
import { selectAutomationRuns } from './automation-runs'
import type { SessionTimeline } from './parse-timeline'

const tl = (over: Partial<SessionTimeline>): SessionTimeline => ({
  sessionId: 's',
  startTime: '2026-01-01T00:00:00Z',
  endTime: '2026-01-01T01:00:00Z',
  entries: [],
  ...over,
})

describe('selectAutomationRuns', () => {
  it('excludes interactive cli runs and keeps sdk-* runs', () => {
    const out = selectAutomationRuns([
      tl({ sessionId: 'a', entrypoint: 'cli' }),
      tl({ sessionId: 'b', entrypoint: 'sdk-cli' }),
      tl({ sessionId: 'c', entrypoint: undefined }),
      tl({ sessionId: 'd', entrypoint: 'sdk-cron' }),
    ])
    expect(out.runs.map((r) => r.sessionId)).toEqual(['b', 'd'])
  })

  it('returns an empty timeline with a zero window when nothing is unattended', () => {
    const out = selectAutomationRuns([tl({ entrypoint: 'cli' })])
    expect(out.runs).toEqual([])
    expect(out.windowStartMs).toBe(0)
    expect(out.windowEndMs).toBe(0)
  })

  it('sorts by start time and spans the window from earliest start to latest end', () => {
    const out = selectAutomationRuns([
      tl({ sessionId: 'late', entrypoint: 'sdk-cli', startTime: '2026-01-03T00:00:00Z', endTime: '2026-01-03T02:00:00Z' }),
      tl({ sessionId: 'early', entrypoint: 'sdk-cli', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T01:00:00Z' }),
    ])
    expect(out.runs.map((r) => r.sessionId)).toEqual(['early', 'late'])
    expect(out.windowStartMs).toBe(new Date('2026-01-01T00:00:00Z').getTime())
    expect(out.windowEndMs).toBe(new Date('2026-01-03T02:00:00Z').getTime())
    // First run sits at the left edge; last run's left is positive.
    expect(out.runs[0].leftPct).toBe(0)
    expect(out.runs[1].leftPct).toBeGreaterThan(0)
  })

  it('positions a run proportionally within the window', () => {
    const out = selectAutomationRuns([
      tl({ sessionId: 'a', entrypoint: 'sdk-cli', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:00Z' }),
      tl({ sessionId: 'b', entrypoint: 'sdk-cli', startTime: '2026-01-01T12:00:00Z', endTime: '2026-01-02T00:00:00Z' }),
    ])
    // window is 24h; b starts at 12h => 50%.
    const b = out.runs.find((r) => r.sessionId === 'b')!
    expect(b.leftPct).toBeCloseTo(50, 5)
    expect(b.widthPct).toBeCloseTo(50, 5)
  })

  it('does not floor width — a zero-duration run is 0% wide (visibility is a CSS min-width concern, see #370)', () => {
    const out = selectAutomationRuns([
      tl({ sessionId: 'a', entrypoint: 'sdk-cli', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:00Z' }),
      tl({ sessionId: 'b', entrypoint: 'sdk-cli', startTime: '2026-01-02T00:00:00Z', endTime: '2026-01-02T00:00:00Z' }),
    ])
    // #370 removed the 0.5% data-layer floor so bar length equals true duration;
    // short runs stay visible via the strip's CSS min-width: 2px, not by lying here.
    expect(out.runs[0].widthPct).toBe(0)
  })

  it('drops runs with unparseable timestamps', () => {
    const out = selectAutomationRuns([
      tl({ sessionId: 'bad', entrypoint: 'sdk-cli', startTime: 'not-a-date', endTime: 'nope' }),
      tl({ sessionId: 'ok', entrypoint: 'sdk-cli' }),
    ])
    expect(out.runs.map((r) => r.sessionId)).toEqual(['ok'])
  })
})
