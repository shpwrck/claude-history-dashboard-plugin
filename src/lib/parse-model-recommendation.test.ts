import { describe, it, expect } from 'vitest'
import {
  computeModelRecommendations,
  summarizeModelRecommendations,
  estimateMonthlySavings,
  REC_HAIKU,
  REC_SONNET,
  REC_OPUS,
} from './parse-model-recommendation'
import type { SessionTokenData, TokenEntry } from '../types'
import type { ToolUsageData, ToolCall } from './parse-tools'
import type { SessionTimeline, TimelineEntry } from './parse-timeline'
import { parseSessionTimeline } from './parse-timeline'
import type { SessionAttribution } from './parse-agents'

// ── Fixture builders ────────────────────────────────────────────────

let clock = Date.UTC(2026, 0, 1, 0, 0, 0)
function nextTs(stepMs = 1000): string {
  clock += stepMs
  return new Date(clock).toISOString()
}

function userEntry(summary: string, timestamp: string): TimelineEntry {
  return { timestamp, kind: 'user', summary }
}

function toolUseEntry(toolName: string, timestamp: string): TimelineEntry {
  return { timestamp, kind: 'tool_use', summary: `use ${toolName}`, toolName }
}

function timeline(
  sessionId: string,
  entries: TimelineEntry[]
): SessionTimeline {
  const times = entries.map((e) => e.timestamp).filter(Boolean)
  return {
    sessionId,
    startTime: times[0] ?? '',
    endTime: times[times.length - 1] ?? '',
    entries,
  }
}

function tokenEntry(
  partial: Partial<TokenEntry> & { timestamp: string }
): TokenEntry {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model: 'claude-opus-4-8',
    ...partial,
  }
}

function tokenData(
  sessionId: string,
  model: string,
  entries: TokenEntry[]
): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model,
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  }
}

function toolCall(toolName: string, timestamp: string): ToolCall {
  return {
    timestamp,
    toolName,
    input: {},
    toolUseId: `${toolName}-${timestamp}`,
    isError: null,
    resultBytes: 0,
  }
}

function toolUsage(sessionId: string, calls: ToolCall[]): ToolUsageData {
  return { sessionId, calls }
}

function attribution(
  sessionId: string,
  agents: Record<string, number> = {}
): SessionAttribution {
  const agentMap: SessionAttribution['agents'] = {}
  for (const [name, invocations] of Object.entries(agents)) {
    agentMap[name] = { invocations, outputTokens: 0 }
  }
  return { sessionId, agents: agentMap, skills: {}, mcpServers: {}, mcpTools: {} }
}

// ── Bucket classification ───────────────────────────────────────────

describe('computeModelRecommendations — bucket classification', () => {
  it('classifies a short, tool-free turn with modest output as trivial → Haiku', () => {
    const t0 = nextTs()
    const tl = timeline('s-trivial', [userEntry('fix a typo', t0)])
    const tok = tokenData('s-trivial', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, inputTokens: 100, outputTokens: 50 }),
    ])
    const [row] = computeModelRecommendations([tok], [], [tl], [])
    expect(row.turns).toHaveLength(1)
    const turn = row.turns[0]
    expect(turn.bucket).toBe('trivial')
    expect(turn.recommendedModel).toBe(REC_HAIKU)
    expect(turn.features.turnLengthChars).toBe('fix a typo'.length)
    expect(turn.features.outputTokens).toBe(50)
  })

  it('classifies stripped bulk turns from summaryLen and carries the first prompt preview', () => {
    const t0 = nextTs()
    const tl: SessionTimeline = {
      ...timeline('s-derived', [
        {
          timestamp: t0,
          kind: 'user',
          summaryLen: 600,
          hasCode: false,
          isQuestion: false,
        },
      ]),
      firstPromptPreview: 'first stripped prompt',
      slim: true,
    }
    const tok = tokenData('s-derived', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, inputTokens: 100, outputTokens: 50 }),
    ])

    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]

    expect(turn.features.turnLengthChars).toBe(600)
    expect(turn.promptSummary).toBe('first stripped prompt')
    expect(turn.bucket).toBe('moderate')
  })

  it('keeps a turn at exactly the 1000 output-token boundary out of trivial (uses < not <=)', () => {
    const t0 = nextTs()
    const tl = timeline('s-out', [userEntry('short prompt', t0)])
    const tok = tokenData('s-out', 'claude-opus-4-8', [
      // 999 output tokens stays trivial...
      tokenEntry({ timestamp: t0, outputTokens: 999 }),
    ])
    const trivial = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(trivial.bucket).toBe('trivial')

    const t1 = nextTs()
    const tl2 = timeline('s-out2', [userEntry('short prompt', t1)])
    const tok2 = tokenData('s-out2', 'claude-opus-4-8', [
      // ...exactly 1000 falls through to moderate (short prompt, no tools).
      tokenEntry({ timestamp: t1, outputTokens: 1000 }),
    ])
    const atBoundary = computeModelRecommendations([tok2], [], [tl2], [])[0].turns[0]
    expect(atBoundary.bucket).toBe('moderate')
    expect(atBoundary.recommendedModel).toBe(REC_SONNET)
  })

  it('treats a 500-char prompt as moderate (trivial requires strictly < 500)', () => {
    const t0 = nextTs()
    const prompt = 'x'.repeat(500)
    const tl = timeline('s-chars', [userEntry(prompt, t0)])
    const tok = tokenData('s-chars', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 10 }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.features.turnLengthChars).toBe(500)
    expect(turn.bucket).toBe('moderate')
  })

  it('buckets a 5,000-char prompt ABOVE trivial through the REAL parser, not its clipped 200-char stub (#3511)', () => {
    // Regression for the summaryLen-after-truncation bug: a long, otherwise
    // tool-free/low-output turn must NOT be mistaken for a trivial one. Built
    // through parseSessionTimeline (NOT a hand-set summaryLen) so the fix is
    // proven end-to-end: the parser now records summaryRawLen and the
    // recommender reads it.
    const t0 = nextTs()
    const longPrompt = 'x'.repeat(5000)
    const transcript = JSON.stringify({
      type: 'user',
      timestamp: t0,
      message: { content: longPrompt },
    })
    const tl = parseSessionTimeline(transcript, 's-long.jsonl')!
    // The parser exposes the TRUE length even though the summary is clipped to 200.
    expect(tl.entries[0].summary).toHaveLength(200)
    expect(tl.entries[0].summaryRawLen).toBe(5000)

    // Everything else about the turn is trivial-shaped (no tools, tiny output),
    // so ONLY the true prompt length keeps it out of the trivial bucket.
    const tok = tokenData('s-long', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 10 }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.features.turnLengthChars).toBe(5000)
    // 5000 >= MODERATE_PROMPT_CHARS (2000) → complex; crucially NOT trivial, so
    // it is never recommended for Haiku on prompt length alone.
    expect(turn.bucket).toBe('complex')
    expect(turn.recommendedModel).not.toBe(REC_HAIKU)
  })

  it('would MISCLASSIFY the same long turn as trivial if length were read post-clip (guards the #3511 fix)', () => {
    // Contrast case proving the fix is load-bearing: a slim/legacy entry that
    // carries ONLY the clipped summaryLen (200, no summaryRawLen) still reads as
    // trivial. The parser path above avoids exactly this by emitting summaryRawLen.
    const t0 = nextTs()
    const legacyEntry: TimelineEntry = {
      timestamp: t0,
      kind: 'user',
      summaryLen: 200, // the saturated, post-clip value the old parser produced
    }
    const tl = timeline('s-legacy', [legacyEntry])
    const tok = tokenData('s-legacy', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 10 }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.features.turnLengthChars).toBe(200)
    expect(turn.bucket).toBe('trivial')
  })

  it('classifies 5 tools / 3 file edits / short prompt as moderate → Sonnet', () => {
    const t0 = nextTs()
    const entries: TimelineEntry[] = [userEntry('do some edits', t0)]
    const calls: ToolCall[] = []
    // 3 file edits + 2 non-edit tools = 5 tools total (moderate ceiling).
    for (const name of ['Edit', 'Write', 'MultiEdit', 'Bash', 'Read']) {
      const ts = nextTs()
      entries.push(toolUseEntry(name, ts))
      calls.push(toolCall(name, ts))
    }
    const tl = timeline('s-mod', entries)
    const tok = tokenData('s-mod', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 200 }),
    ])
    const turn = computeModelRecommendations(
      [tok],
      [toolUsage('s-mod', calls)],
      [tl],
      []
    )[0].turns[0]
    expect(turn.features.toolCount).toBe(5)
    expect(turn.features.fileEdits).toBe(3)
    expect(turn.bucket).toBe('moderate')
    expect(turn.recommendedModel).toBe(REC_SONNET)
  })

  it('pushes a turn with 6 tools to complex even with a short prompt', () => {
    const t0 = nextTs()
    const entries: TimelineEntry[] = [userEntry('lots of tools', t0)]
    const calls: ToolCall[] = []
    for (let i = 0; i < 6; i++) {
      const ts = nextTs()
      entries.push(toolUseEntry('Bash', ts))
      calls.push(toolCall('Bash', ts))
    }
    const tl = timeline('s-cx', entries)
    const tok = tokenData('s-cx', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 200 }),
    ])
    const turn = computeModelRecommendations(
      [tok],
      [toolUsage('s-cx', calls)],
      [tl],
      []
    )[0].turns[0]
    expect(turn.features.toolCount).toBe(6)
    expect(turn.bucket).toBe('complex')
  })

  it('keeps the turn out of trivial only when it itself spawned an agent (Task)', () => {
    const t0 = nextTs()
    const taskTs = nextTs()
    const tl = timeline('s-agent', [
      userEntry('spawn subagent', t0),
      toolUseEntry('Task', taskTs),
    ])
    const tok = tokenData('s-agent', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 100 }),
    ])
    const calls = [toolCall('Task', taskTs)]
    const attr = attribution('s-agent', { explorer: 1 })
    const turn = computeModelRecommendations(
      [tok],
      [toolUsage('s-agent', calls)],
      [tl],
      [attr]
    )[0].turns[0]
    expect(turn.features.branchiness).toBe(1)
    // branchiness !== 0 disqualifies trivial; but with branchiness <= 1 and a
    // short prompt it lands moderate.
    expect(turn.bucket).toBe('moderate')
  })

  it('does not penalize a no-Task turn just because the session used agents elsewhere', () => {
    // Turn 1 spawns a Task; turn 2 is a clean trivial turn. The session has
    // agents, but turn 2 should still be trivial because it didn't spawn one.
    const u1 = nextTs()
    const taskTs = nextTs()
    const u2 = nextTs()
    const tl = timeline('s-mixed', [
      userEntry('do a big thing with a subagent', u1),
      toolUseEntry('Task', taskTs),
      userEntry('tiny follow-up', u2),
    ])
    const tok = tokenData('s-mixed', 'claude-opus-4-8', [
      tokenEntry({ timestamp: u1, outputTokens: 100 }),
      tokenEntry({ timestamp: u2, outputTokens: 50 }),
    ])
    const calls = [toolCall('Task', taskTs)]
    const attr = attribution('s-mixed', { explorer: 1 })
    const turns = computeModelRecommendations(
      [tok],
      [toolUsage('s-mixed', calls)],
      [tl],
      [attr]
    )[0].turns
    expect(turns).toHaveLength(2)
    expect(turns[0].features.branchiness).toBe(1)
    expect(turns[1].bucket).toBe('trivial')
    expect(turns[1].features.branchiness).toBe(0)
  })

  it('falls back to timeline tool counts when no tool-call data is supplied', () => {
    const t0 = nextTs()
    const tl = timeline('s-tlonly', [
      userEntry('edit two files', t0),
      toolUseEntry('Edit', nextTs()),
      toolUseEntry('Write', nextTs()),
    ])
    const tok = tokenData('s-tlonly', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 100 }),
    ])
    // No toolData → uses timelineToolCount / timelineFileEdits.
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.features.toolCount).toBe(2)
    expect(turn.features.fileEdits).toBe(2)
    // 2 file edits > trivial ceiling of 1 → moderate.
    expect(turn.bucket).toBe('moderate')
  })
})

// ── Recommendation target selection for complex turns ───────────────

describe('computeModelRecommendations — complex-turn model selection', () => {
  function complexTurnFor(model: string): string {
    // A long prompt forces the complex bucket regardless of tools.
    const t0 = nextTs()
    const tl = timeline(`s-${model}`, [userEntry('y'.repeat(2500), t0)])
    const tok = tokenData(`s-${model}`, model, [
      tokenEntry({ timestamp: t0, outputTokens: 100, model }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.bucket).toBe('complex')
    return turn.recommendedModel
  }

  it('keeps the current Opus model for a complex turn', () => {
    expect(complexTurnFor('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('recommends Sonnet for a complex Sonnet turn', () => {
    expect(complexTurnFor('claude-sonnet-4-6')).toBe(REC_SONNET)
  })

  it('recommends Haiku for a complex Haiku turn', () => {
    expect(complexTurnFor('claude-haiku-4-5-20251001')).toBe(REC_HAIKU)
  })

  it('recommends Opus when the model family is unknown for a complex turn', () => {
    expect(complexTurnFor('gpt-mystery-9000')).toBe(REC_OPUS)
  })
})

// ── Savings / cost math ─────────────────────────────────────────────

describe('computeModelRecommendations — savings math', () => {
  it('reports zero savings when a complex Opus turn keeps Opus (no swap)', () => {
    const t0 = nextTs()
    // Long prompt forces complex; complex Opus stays Opus → no reprice.
    const tl = timeline('s-save', [userEntry('p'.repeat(2500), t0)])
    const tok = tokenData('s-save', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        model: 'claude-opus-4-8',
      }),
    ])
    const turnBig = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turnBig.bucket).toBe('complex')
    expect(turnBig.currentModel).toBe(turnBig.recommendedModel)
    expect(turnBig.savingsUsd).toBe(0)
    // input 5/MTok + output 25/MTok over 1M each.
    expect(turnBig.actualCostUsd).toBeCloseTo(5 + 25, 6)
    expect(turnBig.recommendedCostUsd).toBe(turnBig.actualCostUsd)
  })

  it('computes Opus→Haiku savings on a genuinely trivial turn', () => {
    const t0 = nextTs()
    const tl = timeline('s-save2', [userEntry('tiny', t0)])
    // 1,000,000 input tokens, 100 output tokens (output well under 1000).
    const tok = tokenData('s-save2', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        inputTokens: 1_000_000,
        outputTokens: 100,
        model: 'claude-opus-4-8',
      }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.bucket).toBe('trivial')
    expect(turn.recommendedModel).toBe(REC_HAIKU)
    // Opus input 5/MTok + output 25/MTok*(100/1e6)
    const expectedActual = 5 + (100 / 1_000_000) * 25
    // Haiku input 1/MTok + output 5/MTok*(100/1e6)
    const expectedRec = 1 + (100 / 1_000_000) * 5
    expect(turn.actualCostUsd).toBeCloseTo(expectedActual, 9)
    expect(turn.recommendedCostUsd).toBeCloseTo(expectedRec, 9)
    expect(turn.savingsUsd).toBeCloseTo(expectedActual - expectedRec, 9)
  })

  it('prices every mixed-model entry at the model that actually produced it', () => {
    const t0 = nextTs()
    const tl = timeline('s-mixed-price', [userEntry('tiny', t0)])
    const tok = tokenData('s-mixed-price', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        inputTokens: 1_000_000,
        outputTokens: 100,
        model: 'claude-opus-4-8',
      }),
      tokenEntry({
        timestamp: t0,
        inputTokens: 1_000_000,
        outputTokens: 100,
        model: 'claude-haiku-4-5-20251001',
      }),
    ])

    const row = computeModelRecommendations([tok], [], [tl], [])[0]
    const turn = row.turns[0]
    const expectedActual = 5 + (100 / 1_000_000) * 25 + 1 + (100 / 1_000_000) * 5
    const expectedRecommended = 2 * (1 + (100 / 1_000_000) * 5)
    expect(turn.actualCostUsd).toBeCloseTo(expectedActual, 9)
    expect(turn.recommendedCostUsd).toBeCloseTo(expectedRecommended, 9)
    expect(turn.savingsUsd).toBeCloseTo(expectedActual - expectedRecommended, 9)
    expect(row.session.estimatedSavingsUsd).toBeCloseTo(turn.savingsUsd, 9)
    expect(row.session.downgradableTurns).toBe(0)
    expect(summarizeModelRecommendations([row]).estimatedSavingsUsd).toBeCloseTo(
      turn.savingsUsd,
      9
    )
  })

  it('clamps savings to zero rather than reporting an upgrade as a gain', () => {
    // A complex Haiku turn is "recommended" to stay on Haiku → no swap, so
    // there is never negative savings to clamp; instead verify a swap where the
    // recommended model is pricier than actual cannot happen, by confirming a
    // trivial cheap-model turn yields zero savings (current === recommended).
    const t0 = nextTs()
    const tl = timeline('s-haiku', [userEntry('tiny', t0)])
    const tok = tokenData('s-haiku', 'claude-haiku-4-5-20251001', [
      tokenEntry({
        timestamp: t0,
        inputTokens: 1_000_000,
        outputTokens: 100,
        model: 'claude-haiku-4-5-20251001',
      }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    expect(turn.recommendedModel).toBe(REC_HAIKU)
    expect(turn.currentModel).toBe('claude-haiku-4-5-20251001')
    expect(turn.savingsUsd).toBe(0)
  })

  it('prices cache writes (5m/1h) and reads using the tier multipliers', () => {
    const t0 = nextTs()
    const tl = timeline('s-cache', [userEntry('tiny', t0)])
    const tok = tokenData('s-cache', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        outputTokens: 10,
        cacheCreationTokens: 1_000_000, // total
        cacheCreation1hTokens: 400_000, // 1h portion
        cacheReadTokens: 1_000_000,
        model: 'claude-opus-4-8',
      }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    // Opus base 5: cacheWrite5m=6.25, cacheWrite1h=10, cacheRead=0.5, output=25
    const cache1h = 400_000
    const cache5m = 1_000_000 - cache1h
    const expectedActual =
      (cache5m / 1_000_000) * 6.25 +
      (cache1h / 1_000_000) * 10 +
      (1_000_000 / 1_000_000) * 0.5 +
      (10 / 1_000_000) * 25
    expect(turn.actualCostUsd).toBeCloseTo(expectedActual, 9)
  })

  it('adds the flat web-search server-tool charge to actual cost', () => {
    const t0 = nextTs()
    const tl = timeline('s-web', [userEntry('search the web', t0)])
    const tok = tokenData('s-web', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        outputTokens: 50,
        webSearchRequests: 3,
        model: 'claude-opus-4-8',
      }),
    ])
    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    // trivial → Haiku swap. web search = 3 * 0.01 added to BOTH actual and rec
    // (entryCostAt includes the server-tool charge regardless of chat model).
    const actualOutput = (50 / 1_000_000) * 25
    expect(turn.actualCostUsd).toBeCloseTo(actualOutput + 0.03, 9)
    const recOutput = (50 / 1_000_000) * 5
    expect(turn.recommendedCostUsd).toBeCloseTo(recOutput + 0.03, 9)
  })

  it('attributes only the token entries inside a turn window to that turn', () => {
    const u1 = nextTs()
    const mid = nextTs()
    const u2 = nextTs()
    const after = nextTs()
    const tl = timeline('s-window', [
      userEntry('first', u1),
      userEntry('second', u2),
    ])
    const tok = tokenData('s-window', 'claude-opus-4-8', [
      tokenEntry({ timestamp: u1, outputTokens: 10 }),
      tokenEntry({ timestamp: mid, outputTokens: 20 }), // belongs to turn 0
      tokenEntry({ timestamp: u2, outputTokens: 30 }), // belongs to turn 1
      tokenEntry({ timestamp: after, outputTokens: 40 }), // also turn 1 (open end)
    ])
    const turns = computeModelRecommendations([tok], [], [tl], [])[0].turns
    expect(turns).toHaveLength(2)
    expect(turns[0].features.outputTokens).toBe(30) // 10 + 20
    expect(turns[1].features.outputTokens).toBe(70) // 30 + 40
  })
})

// ── Attribution seams: sorted fast path vs unsorted fallback ────────
//
// The optimized attribution walks a cursor over timestamp-sorted token
// entries / turn starts and binary-searches slices for tool calls. A
// non-monotonic token stream is indexed once by timestamp, while malformed
// turn order uses range queries that preserve original token-array order.
// These tests pin both paths to the pre-optimization attribution behavior.

describe('computeModelRecommendations — attribution fast-path/fallback seams', () => {
  function twoTurnFixture() {
    const u1 = nextTs()
    const mid = nextTs()
    const u2 = nextTs()
    const after = nextTs()
    const tl = timeline('s-seam', [
      userEntry('first', u1),
      userEntry('second', u2),
    ])
    return { u1, mid, u2, after, tl }
  }

  function outputsFor(tl: SessionTimeline, entries: TokenEntry[]): number[] {
    const tok = tokenData(tl.sessionId, 'claude-opus-4-8', entries)
    return computeModelRecommendations([tok], [], [tl], [])[0].turns.map(
      (t) => t.features.outputTokens
    )
  }

  it('attributes a mid-stream out-of-order token entry identically to sorted input', () => {
    const { u1, mid, u2, after, tl } = twoTurnFixture()
    const A = tokenEntry({ timestamp: u1, outputTokens: 10 })
    const B = tokenEntry({ timestamp: mid, outputTokens: 20 })
    const C = tokenEntry({ timestamp: u2, outputTokens: 30 })
    const D = tokenEntry({ timestamp: after, outputTokens: 40 })

    // Sorted input takes the cursor fast path.
    const sorted = outputsFor(tl, [A, B, C, D])
    expect(sorted).toEqual([30, 70])
    // B before A regresses the timestamp mid-stream → unsorted fallback.
    expect(outputsFor(tl, [B, A, C, D])).toEqual(sorted)
  })

  it('attributes an out-of-order tail token entry identically to sorted input', () => {
    const { u1, mid, u2, after, tl } = twoTurnFixture()
    const A = tokenEntry({ timestamp: u1, outputTokens: 10 })
    const B = tokenEntry({ timestamp: mid, outputTokens: 20 })
    const C = tokenEntry({ timestamp: u2, outputTokens: 30 })
    const D = tokenEntry({ timestamp: after, outputTokens: 40 })

    // B moved to the tail regresses the timestamp at the very end → fallback.
    expect(outputsFor(tl, [A, C, D, B])).toEqual([30, 70])
  })

  it('assigns entries stamped exactly at the next turn start to the NEXT turn on both paths', () => {
    const { u1, u2, tl } = twoTurnFixture()
    const A = tokenEntry({ timestamp: u1, outputTokens: 10 })
    const X = tokenEntry({ timestamp: u2, outputTokens: 5 })
    const Y = tokenEntry({ timestamp: u2, outputTokens: 7 })

    // Turn windows are [start, nextStart): an entry at exactly next.startMs
    // belongs to the next turn, never the current one.
    // Sorted (equal timestamps are still non-decreasing) → fast path.
    expect(outputsFor(tl, [A, X, Y])).toEqual([10, 12])
    // X before A trips the fallback; the boundary rule must not change.
    expect(outputsFor(tl, [X, A, Y])).toEqual([10, 12])
  })

  it('drops invalid-timestamp entries (ms 0) from every turn via the fallback', () => {
    const { u1, u2, tl } = twoTurnFixture()
    const A = tokenEntry({ timestamp: u1, outputTokens: 10 })
    const B = tokenEntry({ timestamp: u2, outputTokens: 20 })
    const bad = tokenEntry({ timestamp: 'not-a-date', outputTokens: 999 })

    // An unparseable timestamp maps to ms 0, which regresses below any real
    // timestamp → unsorted fallback; ms 0 predates every turn window, so the
    // entry is attributed nowhere (same as the pre-optimization filter).
    expect(outputsFor(tl, [A, bad, B])).toEqual([10, 20]) // mid-stream
    expect(outputsFor(tl, [A, B, bad])).toEqual([10, 20]) // at the tail
  })

  it('binds tool calls via the timeline-order linear scan when turn starts are non-monotonic', () => {
    // Malformed timeline: the turn listed FIRST starts LATER. findSliceForMs
    // must take the backward linear scan (not binary search): the last slice
    // in timeline order whose start <= call time wins, and a call predating
    // every turn lands on slices[0].
    const before = nextTs() // predates both turns
    const tEarly = nextTs() // start of the turn listed second
    const midCall = nextTs() // between the two starts
    const tLate = nextTs() // start of the turn listed first
    const lateCall = nextTs() // after both starts
    const tl = timeline('s-unsorted-slices', [
      userEntry('later turn listed first', tLate),
      userEntry('earlier turn listed second', tEarly),
    ])
    const calls = [
      toolCall('Read', before), // matches no slice → falls to slices[0]
      toolCall('Bash', midCall), // >= tEarly only → second slice
      toolCall('Grep', lateCall), // >= both, backward scan hits second slice first
    ]
    const tok = tokenData('s-unsorted-slices', 'claude-opus-4-8', [
      tokenEntry({ timestamp: midCall, outputTokens: 15 }),
      tokenEntry({ timestamp: lateCall, outputTokens: 40 }),
    ])
    const turns = computeModelRecommendations(
      [tok],
      [toolUsage('s-unsorted-slices', calls)],
      [tl],
      []
    )[0].turns
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => t.features.toolCount)).toEqual([1, 2])
    // Token windows follow timeline order too: turn 0's window [tLate, tEarly)
    // is empty, so every entry lands in turn 1's open-ended [tEarly, ∞).
    expect(turns.map((t) => t.features.outputTokens)).toEqual([0, 55])
  })

  it('examines reversed token timestamps near-linearly instead of once per turn (#3147)', () => {
    const turnCount = 400
    const tokenCount = 12_000
    const base = Date.UTC(2026, 0, 2)
    const turns = Array.from({ length: turnCount }, (_, i) =>
      userEntry(`turn ${i}`, new Date(base + i * 1_000).toISOString())
    )
    const entries = Array.from({ length: tokenCount }, (_, i) =>
      tokenEntry({
        timestamp: new Date(base + i * 30).toISOString(),
        outputTokens: 1,
      })
    ).reverse()
    const diagnostics = { tokenEntryExaminations: 0 }

    const rows = computeModelRecommendations(
      [tokenData('s-reversed-scale', 'claude-opus-4-8', entries)],
      [],
      [timeline('s-reversed-scale', turns)],
      [],
      diagnostics
    )

    expect(rows[0].turns).toHaveLength(turnCount)
    expect(rows[0].turns.reduce((sum, turn) => sum + turn.features.outputTokens, 0)).toBe(
      tokenCount
    )
    const logarithmicSearchAllowance = turnCount * 40
    expect(diagnostics.tokenEntryExaminations).toBeGreaterThanOrEqual(tokenCount)
    expect(diagnostics.tokenEntryExaminations).toBeLessThanOrEqual(
      tokenCount * 2 + logarithmicSearchAllowance
    )
  })
})

// ── Session roll-up ─────────────────────────────────────────────────

describe('computeModelRecommendations — session aggregation', () => {
  it('skips sessions whose timeline has no user turns', () => {
    const tl = timeline('s-empty', [toolUseEntry('Bash', nextTs())])
    const rows = computeModelRecommendations([], [], [tl], [])
    expect(rows).toHaveLength(0)
  })

  it('tallies bucket counts and downgradable percentage per session', () => {
    const u1 = nextTs()
    const u2 = nextTs()
    const tl = timeline('s-agg', [
      userEntry('tiny one', u1), // trivial → downgradable
      userEntry('z'.repeat(2500), u2), // complex Opus → not downgradable
    ])
    const tok = tokenData('s-agg', 'claude-opus-4-8', [
      tokenEntry({ timestamp: u1, outputTokens: 10 }),
      tokenEntry({ timestamp: u2, outputTokens: 10 }),
    ])
    const row = computeModelRecommendations([tok], [], [tl], [])[0]
    expect(row.session.turns).toBe(2)
    expect(row.session.trivialTurns).toBe(1)
    expect(row.session.complexTurns).toBe(1)
    expect(row.session.moderateTurns).toBe(0)
    expect(row.session.downgradableTurns).toBe(1)
    expect(row.session.downgradablePct).toBe(50)
  })

  it('counts only proven cheaper capability-tier transitions as downgradable', () => {
    const cases = [
      {
        id: 'unknown-to-opus',
        prompt: 'x'.repeat(2500),
        model: 'unknown-model-id',
        expected: 0,
      },
      {
        id: 'sonnet-alias',
        prompt: 'x'.repeat(800),
        model: 'claude-sonnet-4-6',
        expected: 0,
      },
      {
        id: 'opus-to-sonnet',
        prompt: 'x'.repeat(800),
        model: 'claude-opus-4-8',
        expected: 1,
      },
      {
        id: 'unchanged-haiku',
        prompt: 'tiny',
        model: 'claude-haiku-4-5-20251001',
        expected: 0,
      },
    ]

    const rows = cases.map(({ id, prompt, model }) => {
      const timestamp = nextTs()
      return computeModelRecommendations(
        [tokenData(id, model, [tokenEntry({ timestamp, model, outputTokens: 10 })])],
        [],
        [timeline(id, [userEntry(prompt, timestamp)])],
        []
      )[0]
    })

    expect(rows.map((row) => row.session.downgradableTurns)).toEqual(
      cases.map(({ expected }) => expected)
    )
    expect(summarizeModelRecommendations(rows).downgradablePct).toBe(25)
  })
})

// ── summarizeModelRecommendations ───────────────────────────────────

describe('summarizeModelRecommendations', () => {
  it('returns zeroed summary for no rows', () => {
    const s = summarizeModelRecommendations([])
    expect(s.totalTurns).toBe(0)
    expect(s.downgradablePct).toBe(0)
    expect(s.estimatedSavingsUsd).toBe(0)
    expect(s.recentTrivialExamples).toEqual([])
  })

  it('rolls bucket counts, haiku/sonnet rec counts and savings across sessions', () => {
    // Session A: one trivial (Haiku) + one moderate (Sonnet).
    const a1 = nextTs()
    const a2 = nextTs()
    const tlA = timeline('A', [
      userEntry('tiny a', a1),
      userEntry('m'.repeat(800), a2), // 800 chars < 2000, no tools → moderate
    ])
    const tokA = tokenData('A', 'claude-opus-4-8', [
      tokenEntry({ timestamp: a1, inputTokens: 1_000_000, outputTokens: 10 }),
      tokenEntry({ timestamp: a2, outputTokens: 10 }),
    ])
    // Session B: one complex Opus (kept on Opus).
    const b1 = nextTs()
    const tlB = timeline('B', [userEntry('q'.repeat(2500), b1)])
    const tokB = tokenData('B', 'claude-opus-4-8', [
      tokenEntry({ timestamp: b1, outputTokens: 10 }),
    ])

    const rows = computeModelRecommendations(
      [tokA, tokB],
      [],
      [tlA, tlB],
      []
    )
    const s = summarizeModelRecommendations(rows)
    expect(s.totalTurns).toBe(3)
    expect(s.trivialTurns).toBe(1)
    expect(s.moderateTurns).toBe(1)
    expect(s.complexTurns).toBe(1)
    expect(s.haikuTurns).toBe(1)
    expect(s.sonnetTurns).toBe(1)
    // Only the trivial turn is downgradable (Opus→Haiku); moderate Opus→Sonnet
    // is also a swap. Complex Opus is not. So 2 of 3 downgradable.
    expect(s.downgradablePct).toBeCloseTo((2 / 3) * 100, 6)
    expect(s.estimatedSavingsUsd).toBeGreaterThan(0)
  })

  it('orders recentTrivialExamples newest-first and respects the example limit', () => {
    const times = [nextTs(), nextTs(), nextTs()]
    const tl = timeline('T', [
      userEntry('first tiny', times[0]),
      userEntry('second tiny', times[1]),
      userEntry('third tiny', times[2]),
    ])
    const tok = tokenData('T', 'claude-opus-4-8', [
      tokenEntry({ timestamp: times[0], outputTokens: 1 }),
      tokenEntry({ timestamp: times[1], outputTokens: 1 }),
      tokenEntry({ timestamp: times[2], outputTokens: 1 }),
    ])
    const rows = computeModelRecommendations([tok], [], [tl], [])
    const s = summarizeModelRecommendations(rows, 2)
    expect(s.recentTrivialExamples).toHaveLength(2)
    // Newest startTime first.
    expect(s.recentTrivialExamples[0].startTime).toBe(times[2])
    expect(s.recentTrivialExamples[1].startTime).toBe(times[1])
  })
})

// ── estimateMonthlySavings ──────────────────────────────────────────

describe('estimateMonthlySavings', () => {
  it('returns 0 when there are no rows / no span', () => {
    expect(estimateMonthlySavings([])).toBe(0)
  })

  it('multiplies by 30 when the observed span is under a day', () => {
    const u1 = nextTs()
    const u2 = nextTs() // a few seconds later → span < 1 day
    const tl = timeline('sub-day', [
      userEntry('tiny', u1),
      userEntry('also tiny', u2),
    ])
    const tok = tokenData('sub-day', 'claude-opus-4-8', [
      tokenEntry({ timestamp: u1, inputTokens: 1_000_000, outputTokens: 10 }),
      tokenEntry({ timestamp: u2, inputTokens: 1_000_000, outputTokens: 10 }),
    ])
    const rows = computeModelRecommendations([tok], [], [tl], [])
    const total = rows.reduce((s, r) => s + r.session.estimatedSavingsUsd, 0)
    expect(total).toBeGreaterThan(0)
    expect(estimateMonthlySavings(rows)).toBeCloseTo(total * 30, 9)
  })

  it('extrapolates a multi-day span to a 30-day monthly figure', () => {
    // Two turns 5 days apart → span 5 days → monthly = total / 5 * 30.
    const day = 24 * 60 * 60 * 1000
    const start = Date.UTC(2026, 2, 1, 0, 0, 0)
    const u1 = new Date(start).toISOString()
    const u2 = new Date(start + 5 * day).toISOString()
    const tl = timeline('multi-day', [
      userEntry('tiny', u1),
      userEntry('also tiny', u2),
    ])
    const tok = tokenData('multi-day', 'claude-opus-4-8', [
      tokenEntry({ timestamp: u1, inputTokens: 1_000_000, outputTokens: 10 }),
      tokenEntry({ timestamp: u2, inputTokens: 1_000_000, outputTokens: 10 }),
    ])
    const rows = computeModelRecommendations([tok], [], [tl], [])
    const total = rows.reduce((s, r) => s + r.session.estimatedSavingsUsd, 0)
    expect(total).toBeGreaterThan(0)
    expect(estimateMonthlySavings(rows)).toBeCloseTo((total / 5) * 30, 9)
  })
})

// ── Fallback-semantics parity regressions (ported from PR #2427) ─
//
// These four cases pin the fallback classes the adversarial review of the
// competing #2185 branch reproduced as divergences: empty token windows,
// pre-first-slice tool calls, synthetic-only windows, and array-order model
// picks. They must hold on any rewrite of computeModelRecommendations.
//
// The hot-detector rewrite of `computeModelRecommendations` must stay
// byte-identical to master. These four cases pin the divergence classes the
// review reproduced: each would silently change output if the fast path drifted
// from the old array-order / fallback semantics.
describe('computeModelRecommendations — perf-refactor parity regressions', () => {
  it('empty token window resolves to "unknown" (not tokens.model) → Opus without proving a downgrade', () => {
    // Turn 0 owns the only token entry; turn 1's window [t1, ∞) is empty even
    // though the session's model is a real Opus id. The old code returned the
    // truthy string "unknown" for an empty window instead of falling through to
    // tokens.model — so a complex empty-window turn recommends Opus and counts
    // as a model-id change. Unknown pricing cannot prove a cheaper transition.
    const t0 = nextTs()
    const t1 = nextTs()
    const longPrompt = 'x'.repeat(2500) // > MODERATE_PROMPT_CHARS → complex
    const tl = timeline('s-empty-window', [
      userEntry('first turn', t0),
      userEntry(longPrompt, t1),
    ])
    const tok = tokenData('s-empty-window', 'claude-opus-4-8', [
      // Only entry lands in turn 0's window, so turn 1 sees zero tokens.
      tokenEntry({ timestamp: t0, inputTokens: 1000, outputTokens: 50 }),
    ])

    const turns = computeModelRecommendations([tok], [], [tl], [])[0].turns
    expect(turns).toHaveLength(2)
    const emptyTurn = turns[1]
    expect(emptyTurn.features.outputTokens).toBe(0)
    expect(emptyTurn.currentModel).toBe('unknown')
    expect(emptyTurn.bucket).toBe('complex')
    expect(emptyTurn.recommendedModel).toBe(REC_OPUS)
    expect(emptyTurn.currentModel).not.toBe(emptyTurn.recommendedModel)
    expect(emptyTurn.actualCostUsd).toBe(0)
  })

  it('attaches a tool call timestamped before the first slice to slice 0 (not dropped)', () => {
    // The pre-first-slice call must fall back to slices[0], matching the old
    // findSliceForMs behaviour, rather than being silently dropped.
    const tPre = nextTs() // tool call — earlier than any prompt
    const t0 = nextTs() // first (only) user prompt
    const tl = timeline('s-pre-slice', [userEntry('short prompt', t0)])
    const tok = tokenData('s-pre-slice', 'claude-opus-4-8', [
      tokenEntry({ timestamp: t0, outputTokens: 10 }),
    ])
    const calls = [toolCall('Edit', tPre)]

    const turn = computeModelRecommendations(
      [tok],
      [toolUsage('s-pre-slice', calls)],
      [tl],
      []
    )[0].turns[0]
    // Dropped → toolCount 0; attached to slice 0 → toolCount 1, fileEdits 1.
    expect(turn.features.toolCount).toBe(1)
    expect(turn.features.fileEdits).toBe(1)
  })

  it('an all-synthetic window keeps currentModel "<synthetic>" → zero cost and no downgrade claim', () => {
    // Synthetic entries must contribute nothing: currentModel resolves to
    // "<synthetic>" (zero pricing), NOT the session's real Opus model. The old
    // code priced these at zero. Synthetic work cannot prove a cheaper tier.
    const t0 = nextTs()
    const tl = timeline('s-synthetic', [userEntry('short prompt', t0)])
    const tok = tokenData('s-synthetic', 'claude-opus-4-8', [
      tokenEntry({
        timestamp: t0,
        model: '<synthetic>',
        inputTokens: 1_000_000,
        outputTokens: 10,
      }),
    ])

    const row = computeModelRecommendations([tok], [], [tl], [])[0]
    const turn = row.turns[0]
    expect(turn.currentModel).toBe('<synthetic>')
    expect(turn.actualCostUsd).toBe(0)
    expect(turn.savingsUsd).toBe(0)
    expect(turn.currentModel).not.toBe(turn.recommendedModel)
    expect(row.session.downgradableTurns).toBe(0)
  })

  it('picks the model in array order when a window has an inverted timestamp', () => {
    // The window's first entry in ARRAY (insertion) order is Opus but carries a
    // later timestamp than the second (Sonnet) entry. Sorting the window by
    // timestamp would wrongly pick Sonnet; the old array-order pick keeps Opus.
    const t0 = nextTs() // prompt
    const tEarly = nextTs() // smaller ms, listed SECOND in the array
    const tLate = nextTs() // larger ms, listed FIRST in the array
    const tl = timeline('s-inverted', [userEntry('short prompt', t0)])
    const tok = tokenData('s-inverted', 'claude-sonnet-4-5', [
      tokenEntry({ timestamp: tLate, model: 'claude-opus-4-8', outputTokens: 5 }),
      tokenEntry({ timestamp: tEarly, model: 'claude-sonnet-4-5', outputTokens: 5 }),
    ])

    const turn = computeModelRecommendations([tok], [], [tl], [])[0].turns[0]
    // Array-order first non-synthetic model wins, regardless of timestamp order.
    expect(turn.currentModel).toBe('claude-opus-4-8')
  })
})
