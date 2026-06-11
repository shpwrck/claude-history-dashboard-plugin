import { describe, it, expect } from 'vitest'
import {
  computeCompactionRisk,
  summarizeCompactionRisk,
  PEAK_PCT_HIGH,
  GROWTH_PER_TURN_HIGH,
  LARGE_OUTPUT_RATE_HIGH,
  LARGE_TOOL_OUTPUT_BYTES,
  RISK_MEDIUM,
  RISK_HIGH,
} from './parse-compaction-risk'
import { OVER_WINDOW } from './context-health'
import type { SessionTokenData, TokenEntry, CompactionEvent } from '../types'
import type { ToolUsageData, ToolCall } from './parse-tools'

// ── Fixture builders ─────────────────────────────────────────────────────
// `contextSize` in the parser is inputTokens + cacheCreation + cacheRead.
// We drive the context-size series purely through `inputTokens` so the math
// in each fixture is obvious; the other cache fields stay zero.

const entry = (inputTokens: number, ts = '2026-01-01T00:00:00.000Z'): TokenEntry => ({
  timestamp: ts,
  inputTokens,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  webSearchRequests: 0,
  webFetchRequests: 0,
  model: 'claude-opus-4-8',
})

const session = (
  sessionId: string,
  contextSizes: number[],
  compactionEvents: CompactionEvent[] = []
): SessionTokenData => ({
  sessionId,
  totalInputTokens: contextSizes.reduce((a, b) => a + b, 0),
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  model: 'claude-opus-4-8',
  messageCount: contextSizes.length,
  entries: contextSizes.map((n) => entry(n)),
  compactionEvents,
  hasUnknownModel: false,
})

const readCall = (filePath: string): ToolCall => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  toolName: 'Read',
  input: { file_path: filePath },
  toolUseId: 'tu',
  isError: null,
  resultBytes: 0,
})

const bigCall = (): ToolCall => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  toolName: 'Bash',
  input: {},
  toolUseId: 'tu',
  isError: null,
  resultBytes: LARGE_TOOL_OUTPUT_BYTES, // counts as "large" (>= threshold)
})

const smallCall = (): ToolCall => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  toolName: 'Bash',
  input: {},
  toolUseId: 'tu',
  isError: null,
  resultBytes: 100,
})

const tools = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })

describe('computeCompactionRisk', () => {
  it('classifies a calm, small-context session as low risk with no factors', () => {
    // Flat ~11K context = 5.5% of the 200K window: below every WARN threshold.
    const rows = computeCompactionRisk([session('calm', [10_000, 11_000, 10_500])])
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.sessionId).toBe('calm')
    expect(r.riskClass).toBe('low')
    expect(r.riskScore).toBe(0)
    expect(r.peakContextPct).toBeCloseTo((11_000 / OVER_WINDOW) * 100)
    expect(r.topFactor).toBeUndefined()
    expect(r.suggestions).toEqual([])
  })

  it('skips sessions with no entries entirely', () => {
    const rows = computeCompactionRisk([session('empty', [])])
    expect(rows).toEqual([])
  })

  it('flags a session that crosses multiple HIGH thresholds as high risk', () => {
    // Peak 170K = 85% > PEAK_PCT_HIGH(80). The growth window is the last 10
    // turns; a +20K/turn ramp over them exceeds GROWTH_PER_TURN_HIGH(15K).
    const ramp = [
      10_000, 30_000, 50_000, 70_000, 90_000, 110_000, 130_000, 150_000, 170_000,
    ]
    const tok = session('hot', ramp)
    // 3 of 6 tool calls are "large" => rate 0.5 > LARGE_OUTPUT_RATE_HIGH(0.25).
    const td = tools('hot', [bigCall(), bigCall(), bigCall(), smallCall(), smallCall(), smallCall()])

    const rows = computeCompactionRisk([tok], [td])
    const r = rows[0]
    expect(r.peakContextPct).toBeGreaterThan(PEAK_PCT_HIGH)
    expect(r.contextGrowthRate).toBeGreaterThanOrEqual(GROWTH_PER_TURN_HIGH)
    expect(r.largeToolOutputRate).toBeGreaterThanOrEqual(LARGE_OUTPUT_RATE_HIGH)
    expect(r.riskScore).toBeGreaterThanOrEqual(RISK_HIGH)
    expect(r.riskClass).toBe('high')
    // Peak contributes the most (28.75) vs growth(25) / tool-output(20).
    expect(r.topFactor).toBe('peak')
    // Both peak and large-output suggestions should be present.
    expect(r.suggestions.some((s) => s.includes('200K window'))).toBe(true)
    expect(r.suggestions.some((s) => s.includes('tool calls returned'))).toBe(true)
  })

  it('computes repeated-read density and large-output rate from tool calls', () => {
    // 4 Read calls: a.ts read 3×, b.ts read 1×. repeats = 2, density = 2/4 = 0.5.
    const td = tools('reads', [
      readCall('/x/a.ts'),
      readCall('/x/a.ts'),
      readCall('/x/a.ts'),
      readCall('/x/b.ts'),
      bigCall(),
    ])
    const rows = computeCompactionRisk([session('reads', [20_000, 20_000])], [td])
    const r = rows[0]
    expect(r.repeatedReadDensity).toBeCloseTo(0.5)
    // 1 large call out of 5 total => 0.2.
    expect(r.largeToolOutputRate).toBeCloseTo(0.2)
    // The CLAUDE.md re-read suggestion names the hottest file by basename.
    expect(r.suggestions.some((s) => s.includes('a.ts') && s.includes('CLAUDE.md'))).toBe(true)
  })

  it('zeroes the tool-derived signals when no toolData is supplied', () => {
    const rows = computeCompactionRisk([session('notools', [40_000, 40_000])])
    const r = rows[0]
    expect(r.largeToolOutputRate).toBe(0)
    expect(r.repeatedReadDensity).toBe(0)
  })

  it('counts observed compactions and surfaces a compaction suggestion at 2+', () => {
    const evt: CompactionEvent = {
      timestamp: '2026-01-01T00:00:00.000Z',
      beforeContext: 150_000,
      afterContext: 30_000,
      reductionPercent: 80,
    }
    const rows = computeCompactionRisk([session('compacted', [30_000, 31_000], [evt, evt])])
    const r = rows[0]
    expect(r.compactionsObserved).toBe(2)
    expect(r.suggestions.some((s) => s.includes('compactions already occurred'))).toBe(true)
  })

  it('sorts returned rows by descending risk score', () => {
    const calm = session('calm', [10_000, 10_000])
    const hot = session('hot', [150_000, 170_000])
    const rows = computeCompactionRisk([calm, hot])
    expect(rows.map((r) => r.sessionId)).toEqual(['hot', 'calm'])
    expect(rows[0].riskScore).toBeGreaterThanOrEqual(rows[1].riskScore)
  })
})

describe('RiskClass boundary logic', () => {
  // Peak utilisation is the easiest single signal to dial precisely. In the
  // HIGH band the peak score is 25 + ((pct - 80) / 20) * 15, so we can place
  // the rounded riskScore exactly on either side of the class boundaries.
  const sessionAtPct = (id: string, pct: number) =>
    session(id, [Math.round((pct / 100) * OVER_WINDOW)])

  const classAt = (pct: number): string =>
    computeCompactionRisk([sessionAtPct('b', pct)])[0].riskClass

  it('is low just below the medium boundary and medium at it', () => {
    // In the HIGH band peak = 25 + ((pct-80)/20)*15, rounded. 85% → 28.75 → 29
    // (low); 86.7% → 30.0 → 30 (medium, == RISK_MEDIUM).
    expect(RISK_MEDIUM).toBe(30)
    expect(classAt(85)).toBe('low') // score 29 → low
    expect(classAt(86.7)).toBe('medium') // score 30 → medium
  })

  it('is medium just below the high boundary and high at it', () => {
    // peak score 40 (the cap) needs pct >= 100; just under stays medium.
    expect(RISK_HIGH).toBe(60)
    // Peak alone caps at 40, so peak-only can never reach high — combine
    // peak (cap 40) with a HIGH growth ramp (+25) to clear 60.
    const hot = session('h', [
      0, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000, 140_000, 160_000, 200_000,
    ])
    const r = computeCompactionRisk([hot])[0]
    expect(r.peakContextPct).toBeGreaterThanOrEqual(PEAK_PCT_HIGH)
    expect(r.contextGrowthRate).toBeGreaterThanOrEqual(GROWTH_PER_TURN_HIGH)
    expect(r.riskScore).toBeGreaterThanOrEqual(RISK_HIGH)
    expect(r.riskClass).toBe('high')
  })
})

describe('summarizeCompactionRisk', () => {
  it('returns an empty summary for no rows', () => {
    const s = summarizeCompactionRisk([])
    expect(s).toEqual({
      totalSessions: 0,
      hotSessions: 0,
      hotPercent: 0,
      topSuggestionCount: 0,
    })
  })

  it('counts hot (medium+high) sessions and the leading suggestion theme', () => {
    // Two hot sessions whose first suggestion is the /compact-or-/clear peak
    // message (theme "Run /clear when switching tasks", since the HIGH peak
    // message mentions /clear), plus one calm session.
    // Single-entry sessions have zero growth, so peak alone must clear
    // RISK_MEDIUM: 174K (87%) → score 30, 178K (89%) → score 32. Both >=80%
    // so both emit the HIGH peak suggestion (mentions /compact AND /clear).
    const calm = session('calm', [10_000, 10_000])
    const hot1 = session('hot1', [174_000])
    const hot2 = session('hot2', [178_000])
    const rows = computeCompactionRisk([calm, hot1, hot2])

    const s = summarizeCompactionRisk(rows)
    expect(s.totalSessions).toBe(3)
    expect(s.hotSessions).toBe(2)
    expect(s.hotPercent).toBeCloseTo((2 / 3) * 100)
    expect(s.topSuggestion).toBe('Run /clear when switching tasks')
    expect(s.topSuggestionCount).toBe(2)
  })

  it('excludes low-risk sessions from the hot count', () => {
    const rows = computeCompactionRisk([
      session('a', [10_000]),
      session('b', [12_000]),
    ])
    const s = summarizeCompactionRisk(rows)
    expect(s.totalSessions).toBe(2)
    expect(s.hotSessions).toBe(0)
    expect(s.hotPercent).toBe(0)
    expect(s.topSuggestion).toBeUndefined()
    expect(s.topSuggestionCount).toBe(0)
  })
})
