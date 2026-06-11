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
