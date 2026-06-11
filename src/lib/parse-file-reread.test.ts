import { describe, it, expect } from 'vitest'
import { parseFileReread, aggregateRereadByPath } from './parse-file-reread'
import type { ToolCall, ToolUsageData } from './parse-tools'
import type { SessionTokenData } from '../types'

const read = (filePath: string, resultBytes = 0, timestamp = 't'): ToolCall => ({
  timestamp,
  toolName: 'Read',
  input: { file_path: filePath },
  toolUseId: 'u',
  isError: null,
  resultBytes,
})
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })

describe('parseFileReread', () => {
  it('summarizes a file re-read >= threshold with a direct byte-based waste estimate', () => {
    const data = [
      session('s1', [
        read('/big.md', 400, '2026-01-01T00:00:00Z'),
        read('/big.md', 400, '2026-01-01T00:05:00Z'),
        read('/big.md', 400, '2026-01-01T00:10:00Z'),
      ]),
    ]
    const out = parseFileReread(data)
    expect(out.repeats).toHaveLength(1)
    const r = out.repeats[0]
    expect(r).toMatchObject({
      path: '/big.md',
      readCount: 3,
      totalBytes: 1200,
      avgBytesPerRead: 400,
      tokenEstimateSource: 'direct',
      firstRead: '2026-01-01T00:00:00Z',
      lastRead: '2026-01-01T00:10:00Z',
    })
    // (3-1) * 400 / 4 = 200
    expect(r.estimatedTokenWaste).toBe(200)
    expect(out.totalEstimatedTokenWaste).toBe(200)
    expect(out.sessionsAffected).toBe(1)
    expect(out.filesAffected).toBe(1)
    expect(out.noByteData).toBe(false)
  })

  it('does not flag files read fewer than the threshold', () => {
    const data = [session('s1', [read('/a.ts', 100), read('/a.ts', 100)])]
    expect(parseFileReread(data).repeats).toHaveLength(0)
  })

  it('falls back to the session mean when a re-read path carries no bytes', () => {
    const data = [
      session('s1', [
        // /no-bytes.md: 3 reads, none with resultBytes
        read('/no-bytes.md', 0),
        read('/no-bytes.md', 0),
        read('/no-bytes.md', 0),
        // another read in the same session that DOES carry bytes → session mean = 800
        read('/other.ts', 800),
      ]),
    ]
    const r = parseFileReread(data).repeats.find((x) => x.path === '/no-bytes.md')!
    expect(r.tokenEstimateSource).toBe('session-mean')
    expect(r.avgBytesPerRead).toBe(800)
    expect(r.estimatedTokenWaste).toBe(Math.round((2 * 800) / 4))
  })

  it('reports noByteData when no read anywhere carried bytes', () => {
    const data = [session('s1', [read('/a.ts'), read('/a.ts'), read('/a.ts')])]
    const out = parseFileReread(data)
    expect(out.noByteData).toBe(true)
    expect(out.repeats[0].tokenEstimateSource).toBe('unknown')
    expect(out.repeats[0].estimatedTokenWaste).toBe(0)
  })

  it('cross-links compaction counts from token data', () => {
    const data = [session('s1', [read('/a.ts', 100), read('/a.ts', 100), read('/a.ts', 100)])]
    const tokenData = [{ sessionId: 's1', compactionEvents: [{}, {}, {}] } as unknown as SessionTokenData]
    expect(parseFileReread(data, tokenData).repeats[0].compactions).toBe(3)
  })
})

describe('parseFileReread memoization (#718)', () => {
  it('invokes the compute once per (toolData, tokenData) pair — repeat calls hit the cache', () => {
    const toolData = [
      session('s1', [read('/big.md', 400), read('/big.md', 400), read('/big.md', 400)]),
    ]
    const tokenData: SessionTokenData[] = []

    const first = parseFileReread(toolData, tokenData)
    // Same array references ⇒ same memoized object instance (compute ran once).
    const second = parseFileReread(toolData, tokenData)
    expect(second).toBe(first)

    // Counter-proof: mutating an input array AFTER the first call must NOT change
    // the cached result. If the compute re-ran it would now see two repeated
    // files; the cache returns the pre-mutation summary, proving a single run.
    toolData.push(
      session('s2', [read('/other.md', 400), read('/other.md', 400), read('/other.md', 400)])
    )
    const third = parseFileReread(toolData, tokenData)
    expect(third).toBe(first)
    expect(third.repeats).toHaveLength(1)
    expect(third.repeats[0].path).toBe('/big.md')
  })

  it('recomputes for a different array identity or threshold (distinct cache keys)', () => {
    const callsA = [
      session('s1', [read('/big.md', 400), read('/big.md', 400), read('/big.md', 400)]),
    ]
    // A fresh array with equal contents is a distinct key ⇒ a fresh compute.
    const callsB = [
      session('s1', [read('/big.md', 400), read('/big.md', 400), read('/big.md', 400)]),
    ]
    const a = parseFileReread(callsA)
    const b = parseFileReread(callsB)
    expect(b).not.toBe(a)
    expect(b).toEqual(a)

    // Same toolData AND tokenData refs, different threshold ⇒ separate cache
    // entries. (tokenData must be a shared ref — a fresh [] is an uncacheable key.)
    const tokens: SessionTokenData[] = []
    const t3 = parseFileReread(callsA, tokens, 3)
    const t4 = parseFileReread(callsA, tokens, 4)
    expect(t3).toBe(parseFileReread(callsA, tokens, 3)) // threshold-3 memoized
    expect(t4).toBe(parseFileReread(callsA, tokens, 4)) // threshold-4 memoized
    expect(t4).not.toBe(t3) // distinct threshold ⇒ distinct entry
    expect(t4.repeats).toHaveLength(0) // 3 reads < threshold 4
  })

  it('keys tokenData identity too — same toolData with distinct tokenData arrays cache separately', () => {
    const toolData = [
      session('s1', [read('/a.ts', 100), read('/a.ts', 100), read('/a.ts', 100)]),
    ]
    const tokensX = [
      { sessionId: 's1', compactionEvents: [{}, {}] } as unknown as SessionTokenData,
    ]
    const tokensY = [
      { sessionId: 's1', compactionEvents: [{}, {}, {}, {}] } as unknown as SessionTokenData,
    ]
    const x = parseFileReread(toolData, tokensX)
    const y = parseFileReread(toolData, tokensY)
    expect(x).not.toBe(y)
    expect(x.repeats[0].compactions).toBe(2)
    expect(y.repeats[0].compactions).toBe(4)
    // Each pair is independently memoized.
    expect(parseFileReread(toolData, tokensX)).toBe(x)
    expect(parseFileReread(toolData, tokensY)).toBe(y)
  })
})

describe('aggregateRereadByPath', () => {
  it('rolls per-session repeats up by path, summing reads and waste', () => {
    const data = [
      session('s1', [read('/shared.md', 400), read('/shared.md', 400), read('/shared.md', 400)]),
      session('s2', [read('/shared.md', 400), read('/shared.md', 400), read('/shared.md', 400), read('/shared.md', 400)]),
    ]
    const summary = parseFileReread(data)
    const global = aggregateRereadByPath(summary)
    expect(global[0]).toMatchObject({ path: '/shared.md', sessions: 2, totalReads: 7, maxPerSession: 4 })
  })
})
