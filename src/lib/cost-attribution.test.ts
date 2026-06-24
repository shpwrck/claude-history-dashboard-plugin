import { describe, it, expect } from 'vitest'
import { attributeCostByTool, attributeCostByToolId } from './cost-attribution'
import { parseSessionJsonl } from './parse-sessions'
import { parseToolUsage } from './parse-tools'

// --- JSONL builders ---------------------------------------------------------
// One assistant message (its own id + usage) emitting tool_use blocks, then the
// user line echoing each tool_result payload back keyed by tool_use_id.

const assistantTurn = (
  id: string,
  usage: Record<string, unknown>,
  tools: Array<{ id: string; name: string }>,
  ts: string
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model: 'claude-opus-4-8',
      content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })),
      usage,
    },
  })

const resultsTurn = (results: Array<{ id: string; content: string }>, ts: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
    },
  })

const costOf = (rows: { toolName: string; estimatedCost: number }[], tool: string) =>
  rows.find((r) => r.toolName === tool)?.estimatedCost ?? 0

describe('attributeCostByToolId (#1928 ID-based join)', () => {
  it('localizes each message\'s cost to the tools that message billed, tighter than the byte-share heuristic', () => {
    // Two assistant messages in one session:
    //  - m1 is EXPENSIVE (high output) and calls only Read, whose result is small.
    //  - m2 is CHEAP (low output) and calls only Bash, whose result is HUGE.
    // The session-wide byte-share heuristic pools ALL cost and splits by total
    // bytes, so the huge Bash payload drags most of the EXPENSIVE m1 cost onto
    // Bash — a misattribution. The ID join keeps m1's cost on Read and m2's on
    // Bash, so Read (the genuinely expensive turn) gets the larger share.
    const text = [
      assistantTurn('m1', { input_tokens: 0, output_tokens: 1_000_000 }, [{ id: 'r1', name: 'Read' }], 't1'),
      resultsTurn([{ id: 'r1', content: 'x'.repeat(10) }], 't2'),
      assistantTurn('m2', { input_tokens: 0, output_tokens: 1 }, [{ id: 'b1', name: 'Bash' }], 't3'),
      resultsTurn([{ id: 'b1', content: 'y'.repeat(100_000) }], 't4'),
    ].join('\n')

    const tok = parseSessionJsonl(text, 'sess.jsonl')!
    const tools = parseToolUsage(text, 'sess.jsonl')!
    const tokenData = [tok]
    const toolData = [tools]

    const heuristic = attributeCostByTool(tokenData, toolData)
    const idJoin = attributeCostByToolId(tokenData, toolData)

    // Sanity: the linkage actually threaded through to the token model.
    expect(tok.entries.find((e) => e.toolUseIds?.includes('r1'))).toBeTruthy()
    expect(tok.entries.find((e) => e.toolUseIds?.includes('b1'))).toBeTruthy()

    // Heuristic: ~all cost lands on Bash (it owns ~all the session bytes), even
    // though Bash's own turn was almost free — the misattribution.
    expect(costOf(heuristic, 'Bash')).toBeGreaterThan(costOf(heuristic, 'Read'))

    // ID join: Read (the expensive m1 turn) keeps the bulk of the cost; Bash's
    // near-zero turn stays near zero. This is the precision improvement.
    expect(costOf(idJoin, 'Read')).toBeGreaterThan(costOf(idJoin, 'Bash'))
    expect(costOf(idJoin, 'Read')).toBeCloseTo(25) // 1 MTok output @ $25 (Opus)
    expect(costOf(idJoin, 'Bash')).toBeLessThan(0.01)
  })

  it('conserves total spend across the tool buckets', () => {
    const text = [
      assistantTurn('m1', { input_tokens: 0, output_tokens: 1_000_000 }, [
        { id: 'r1', name: 'Read' },
        { id: 'g1', name: 'Grep' },
      ], 't1'),
      resultsTurn([
        { id: 'r1', content: 'x'.repeat(40) },
        { id: 'g1', content: 'y'.repeat(10) },
      ], 't2'),
    ].join('\n')
    const tok = parseSessionJsonl(text, 'sess2.jsonl')!
    const tools = parseToolUsage(text, 'sess2.jsonl')!
    const rows = attributeCostByToolId([tok], [tools])
    const total = rows.reduce((s, r) => s + r.estimatedCost, 0)
    expect(total).toBeCloseTo(25) // whole session cost is fully attributed
    // Split by per-call result bytes within the one turn: Read 40 / Grep 10.
    expect(costOf(rows, 'Read')).toBeCloseTo(25 * (40 / 50))
    expect(costOf(rows, 'Grep')).toBeCloseTo(25 * (10 / 50))
  })

  it('falls back to the session-wide split for entries lacking tool_use ids', () => {
    // A TokenEntry with NO toolUseIds (e.g. an older row) must not be dropped:
    // its cost falls back to the legacy session-wide byte-share split.
    const tok = {
      sessionId: 'fb',
      totalInputTokens: 0,
      totalOutputTokens: 1_000_000,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: 'claude-opus-4-8',
      messageCount: 1,
      entries: [
        {
          timestamp: 't1',
          inputTokens: 0,
          outputTokens: 1_000_000,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 0,
          webSearchRequests: 0,
          webFetchRequests: 0,
          model: 'claude-opus-4-8',
          // no toolUseIds — forces the fallback path
        },
      ],
      compactionEvents: [],
      hasUnknownModel: false,
    }
    const tools = {
      sessionId: 'fb',
      calls: [
        { timestamp: 't1', toolName: 'Read', input: {}, toolUseId: 'r1', isError: false, resultBytes: 30 },
        { timestamp: 't1', toolName: 'Bash', input: {}, toolUseId: 'b1', isError: false, resultBytes: 10 },
      ],
    }
    const rows = attributeCostByToolId([tok], [tools])
    const total = rows.reduce((s, r) => s + r.estimatedCost, 0)
    expect(total).toBeCloseTo(25)
    // Session-wide byte share: Read 30 / Bash 10.
    expect(costOf(rows, 'Read')).toBeCloseTo(25 * (30 / 40))
    expect(costOf(rows, 'Bash')).toBeCloseTo(25 * (10 / 40))
  })
})
