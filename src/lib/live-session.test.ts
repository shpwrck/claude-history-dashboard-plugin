import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveSession, type LiveSessionInput } from './live-session'
import { IDLE_TURN_THRESHOLD_MS } from './parse-runtime-events'

// Golden coverage for the extracted Live Session compute (#627 slice 2).
// computeLiveSession in scripts/ingest.mjs is NOT exercised by the dataset
// parity suite, so this is the first end-to-end check that the file-reading +
// parser pipeline produces a sane `active` payload. liveSession() reads real
// files off disk, so the suite stands up a temp transcript dir (node env, no
// jsdom) and tears it down after each case.

// One assistant transcript line with a usage record + timestamp. Mirrors the
// fixture shape in parse-sessions.test.ts so parseSessionJsonl/parseToolUsage
// and newestEventMs all accept it.
const assistant = (
  ts: string,
  usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
  id = 'a1'
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, model: 'claude-opus-4-8', usage },
  })

// One typed user turn (real text content, so it counts as a user turn).
const userTurn = (ts: string, text = 'do the thing') =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: text },
  })

describe('liveSession', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chd-live-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Write a transcript file and return the discovery-shaped input entry.
  const seed = (sessionId: string, lines: string[]): LiveSessionInput => {
    const topPath = join(dir, `${sessionId}.jsonl`)
    writeFileSync(topPath, lines.join('\n'))
    return { sessionId, project: 'proj-x', topPath, subPaths: [] }
  }

  it('reports active for a session whose newest event is recent', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const recent = new Date(now - 60_000).toISOString() // 1 min ago
    const input = seed('sess-recent', [
      userTurn(new Date(now - 120_000).toISOString()),
      assistant(recent),
    ])

    const out = liveSession([input], now)

    expect(out.active).toBe(true)
    expect(out.sessionId).toBe('sess-recent')
    expect(out.project).toBe('proj-x')
    // input(100) + cacheRead(5) = 105 occupancy / 200K window.
    expect(out.contextTokens).toBe(105)
    expect(out.contextPercent).toBeGreaterThan(0)
    expect(out.contextPercent).toBeLessThanOrEqual(100)
    // input(100)+output(20)+cacheRead(5) burned.
    expect(out.tokensBurned).toBe(125)
    expect(out.model).toBe('claude-opus-4-8')
    expect(out.lastEventMs).toBe(Date.parse(recent))
    // Last typed user turn was 2 min ago.
    expect(out.msSinceLastUserTurn).toBe(120_000)
    expect(out.retryStorm).toBe(false)
    expect(out.rereadLoop).toBe(false)
  })

  it('reports inactive for an idle session (newest event past the idle threshold)', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const stale = new Date(now - IDLE_TURN_THRESHOLD_MS - 60_000).toISOString()
    const input = seed('sess-idle', [assistant(stale)])

    const out = liveSession([input], now)

    expect(out.active).toBe(false)
    expect(out.sessionId).toBeUndefined()
  })

  it('reports inactive for an empty session list', () => {
    const out = liveSession([], Date.now())
    expect(out.active).toBe(false)
  })

  it('reports inactive instead of throwing when the top transcript exceeds the read cap', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const recent = new Date(now - 60_000).toISOString()
    const input = seed('sess-huge-top', [assistant(recent)])
    writeFileSync(input.topPath, `${'x'.repeat(65_537)}\n`)

    const out = liveSession([input], now, { maxBytes: 65_536 })

    expect(out.active).toBe(false)
  })

  it('ignores an oversized subagent tail without hiding a recent top-level session', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0)
    const recent = new Date(now - 60_000).toISOString()
    const input = seed('sess-huge-subagent', [
      userTurn(new Date(now - 120_000).toISOString()),
      assistant(recent),
    ])
    const subagentDir = join(dir, 'sess-huge-subagent', 'subagents')
    mkdirSync(subagentDir, { recursive: true })
    const subagentPath = join(subagentDir, 'agent-1.jsonl')
    writeFileSync(subagentPath, `${'x'.repeat(65_537)}\n`)
    input.subPaths = [subagentPath]

    const out = liveSession([input], now, { maxBytes: 65_536 })

    expect(out.active).toBe(true)
    expect(out.sessionId).toBe('sess-huge-subagent')
    expect(out.contextTokens).toBe(105)
  })
})
