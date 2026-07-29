import { describe, it, expect } from 'vitest'
import { computeToolEffectiveness } from './parse-tool-effectiveness'
import type { ToolCall, ToolUsageData } from './parse-tools'
import type { ApiErrorEvent } from './parse-errors'
import type { SessionTimeline } from './parse-timeline'

const T0 = '2026-01-01T00:00:00Z'
const at = (sec: number) => `2026-01-01T00:00:${String(sec).padStart(2, '0')}Z`

const tc = (toolName: string, opts: { ts?: string; input?: Record<string, unknown>; isError?: boolean } = {}): ToolCall => ({
  timestamp: opts.ts ?? T0,
  toolName,
  input: opts.input ?? {},
  toolUseId: 'u',
  isError: opts.isError ?? null,
  resultBytes: 0,
})
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })
const row = (rows: ReturnType<typeof computeToolEffectiveness>, tool: string) => rows.find((r) => r.tool === tool)!

describe('computeToolEffectiveness', () => {
  it('scores a same-target retry as a negative signal', () => {
    // Two identical Bash commands → the first is "immediately followed by retry".
    const data = [session('s', [tc('Bash', { ts: at(0), input: { command: 'ls' } }), tc('Bash', { ts: at(1), input: { command: 'ls' } })])]
    const r = row(computeToolEffectiveness(data, [], []), 'Bash')
    expect(r.invocations).toBe(2)
    expect(r.immediatelyFollowedByRetry).toBe(1)
    expect(r.immediatelyFollowedByProgress).toBe(0)
    // (good 0 + 1) / (good 0 + bad 1 + 2) = 1/3
    expect(r.effectivenessScore).toBeCloseTo(1 / 3)
  })

  it('scores a different-target next call as forward progress', () => {
    const data = [session('s', [tc('Bash', { ts: at(0), input: { command: 'ls' } }), tc('Bash', { ts: at(1), input: { command: 'pwd' } })])]
    const r = row(computeToolEffectiveness(data, [], []), 'Bash')
    expect(r.immediatelyFollowedByProgress).toBe(1)
    expect(r.immediatelyFollowedByRetry).toBe(0)
    // (1 + 1) / (1 + 0 + 2) = 2/3
    expect(r.effectivenessScore).toBeCloseTo(2 / 3)
  })

  it("counts a tool call's own error result", () => {
    const data = [session('s', [tc('Bash', { input: { command: 'boom' }, isError: true })])]
    const r = row(computeToolEffectiveness(data, [], []), 'Bash')
    expect(r.immediatelyFollowedByError).toBe(1)
    expect(r.effectivenessScore).toBeCloseTo(1 / 3)
  })

  it('counts a native api_error landing within the window after the call', () => {
    const data = [session('s', [tc('Bash', { ts: at(0), input: { command: 'x' } })])]
    const apiErrors = [{ sessionId: 's', timestamp: at(10) } as ApiErrorEvent]
    const r = row(computeToolEffectiveness(data, apiErrors, []), 'Bash')
    expect(r.immediatelyFollowedByError).toBe(1)
  })

  it('flags an undo when a file edit is shortly followed by git checkout/restore', () => {
    const data = [
      session('s', [
        tc('Edit', { ts: at(0), input: { file_path: '/a.ts' } }),
        tc('Bash', { ts: at(1), input: { command: 'git checkout /a.ts' } }),
      ]),
    ]
    const r = row(computeToolEffectiveness(data, [], []), 'Edit')
    expect(r.immediatelyFollowedByUndo).toBe(1)
    expect(r.immediatelyFollowedByProgress).toBe(1) // the bash call is also a different target
    // good 1, bad (undo) 1 → (1+1)/(1+1+2) = 0.5
    expect(r.effectivenessScore).toBeCloseTo(0.5)
  })

  it('treats a fresh user message before the next tool call as progress', () => {
    const data = [session('s', [tc('Bash', { ts: at(0), input: { command: 'x' } })])]
    const timeline = {
      sessionId: 's',
      startTime: at(0),
      endTime: at(5),
      entries: [{ timestamp: at(5), kind: 'user', summary: 'thanks, next thing' }],
    } as unknown as SessionTimeline
    const r = row(computeToolEffectiveness(data, [], [timeline]), 'Bash')
    expect(r.immediatelyFollowedByProgress).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// #3161 — API errors were rescanned and resorted for every session.
//
// `sessionApiErrorTimes(sessionId, apiErrors)` walked the WHOLE apiErrors array
// and sorted the matching subset, and `computeToolEffectiveness` called it once
// per tool-data session: O(S x E) visits plus S sorts during ingest, to compute
// a partition that does not depend on which session is asking.
//
// The probe counts INDEXED READS of the apiErrors array (a Proxy `get` trap on
// numeric keys) rather than timing anything, so it is deterministic and immune
// to host contention:
//
//   old: E visits per session          -> S x E   (100x100 -> 10,000)
//   new: one bucketing pass            -> E       (100x100 ->    100)
// ---------------------------------------------------------------------------

/** Wrap an apiErrors array so every indexed element read is counted. */
const countingErrors = (errors: ApiErrorEvent[], counter: { visits: number }): ApiErrorEvent[] =>
  new Proxy(errors, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) counter.visits += 1
      return Reflect.get(target, prop, receiver)
    },
  })

describe('computeToolEffectiveness indexes API errors once (#3161)', () => {
  const measure = (n: number) => {
    const counter = { visits: 0 }
    const toolData = Array.from({ length: n }, (_, i) =>
      session(`s${i}`, [tc('Bash', { ts: at(0), input: { command: `c${i}` } })])
    )
    const errors = Array.from(
      { length: n },
      (_, i) => ({ sessionId: `s${i}`, timestamp: at(10), summary: 'x' }) as ApiErrorEvent
    )
    const rows = computeToolEffectiveness(toolData, countingErrors(errors, counter), [])
    return { visits: counter.visits, errorsCounted: row(rows, 'Bash').immediatelyFollowedByError }
  }

  it('visits each API error exactly once regardless of session count', () => {
    const small = measure(100)
    const large = measure(200)

    // The acceptance contract, literally: indexed ONCE, not once per session.
    // The old scan visited 10,000 / 40,000 times for these same fixtures.
    expect(small.visits).toBe(100)
    expect(large.visits).toBe(200)

    // Every session's call is still matched to its own session's error, so the
    // speedup did not come from doing less of the actual work.
    expect(small.errorsCounted).toBe(100)
    expect(large.errorsCounted).toBe(200)
  })

  it('sorts each session bucket, which hasApiErrorWithin depends on', () => {
    // hasApiErrorWithin stops at the FIRST error at or after the call, so an
    // unsorted bucket silently loses in-window errors. Errors arrive newest
    // first here: sorted -> the 10s error is found inside the 30s window;
    // unsorted -> the 50s error is seen first and the scan gives up.
    const data = [session('s', [tc('Bash', { ts: at(0), input: { command: 'x' } })])]
    const errors = [
      { sessionId: 's', timestamp: at(50), summary: 'late' },
      { sessionId: 's', timestamp: at(10), summary: 'in-window' },
    ] as ApiErrorEvent[]
    expect(row(computeToolEffectiveness(data, errors, []), 'Bash').immediatelyFollowedByError).toBe(1)
  })

  // Codex review on PR #3467 caught the first cut of this index being eager over
  // the WHOLE apiErrors collection. Callers pass a route-filtered toolData next
  // to an UNSCOPED apiErrors (ToolUsage.tsx:174 does exactly that), so a filter
  // matching few or no sessions would have parsed, bucketed and sorted the
  // entire error history just to render an empty state — relocating the cost
  // instead of removing it.
  it('does no API-error work at all when there are no sessions to score', () => {
    const counter = { visits: 0 }
    const errors = Array.from(
      { length: 500 },
      (_, i) => ({ sessionId: `s${i}`, timestamp: at(10), summary: 'x' }) as ApiErrorEvent
    )
    const rows = computeToolEffectiveness([], countingErrors(errors, counter), [])
    expect(rows).toEqual([])
    // The pre-index code touched zero errors here; so must the index.
    expect(counter.visits).toBe(0)
  })

  it('parses only the errors belonging to the sessions it was asked about', () => {
    // One scoped session against a large unrelated error history. The old
    // per-session helper only ever PARSED its own session's timestamps; the
    // index must not start parsing everybody's. A getter on `timestamp` records
    // each parse, so this is deterministic rather than timed.
    const parsed: string[] = []
    const errors = Array.from({ length: 200 }, (_, i) => {
      const id = i === 7 ? 'wanted' : `other${i}`
      return {
        sessionId: id,
        summary: 'x',
        get timestamp() {
          parsed.push(id)
          return at(10)
        },
      } as unknown as ApiErrorEvent
    })

    const data = [session('wanted', [tc('Bash', { ts: at(0), input: { command: 'x' } })])]
    const r = row(computeToolEffectiveness(data, errors, []), 'Bash')

    expect(r.immediatelyFollowedByError).toBe(1)
    // Exactly one timestamp parsed: the scoped session's.
    expect(parsed).toEqual(['wanted'])
  })

  it('buckets interleaved sessions independently and drops unparseable timestamps', () => {
    const data = [
      session('a', [tc('Bash', { ts: at(0), input: { command: 'a' } })]),
      session('b', [tc('Bash', { ts: at(0), input: { command: 'b' } })]),
      // 'z' has no errors at all — it must see an empty bucket, not another
      // session's, and must not be polluted by the shared empty-bucket constant.
      session('z', [tc('Bash', { ts: at(0), input: { command: 'z' } })]),
    ]
    const errors = [
      { sessionId: 'a', timestamp: at(10), summary: 'a-in' },
      { sessionId: 'b', timestamp: at(59), summary: 'b-out-of-window' },
      { sessionId: 'a', timestamp: 'not-a-timestamp', summary: 'unparseable' },
      { sessionId: 'ghost', timestamp: at(5), summary: 'session not in toolData' },
    ] as ApiErrorEvent[]

    const r = row(computeToolEffectiveness(data, errors, []), 'Bash')
    // Only 'a' has an error inside its 30s window. 'b' is at 59s (outside),
    // 'z' has none, the unparseable one is dropped, and 'ghost' matches no session.
    expect(r.invocations).toBe(3)
    expect(r.immediatelyFollowedByError).toBe(1)
  })
})
