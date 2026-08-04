import { describe, it, expect } from 'vitest'
import {
  computeAgentEffectiveness,
  suggestAgentWorkflows,
  publishAgentTaskSuggestions,
} from './parse-agent-effectiveness'
import type { AgentEffectivenessRow } from './parse-agent-effectiveness'
import type { ToolCall, ToolUsageData } from './parse-tools'

const tc = (toolName: string, opts: { ts?: string; input?: Record<string, unknown>; isError?: boolean } = {}): ToolCall => ({
  timestamp: opts.ts ?? '2026-01-01T00:00:00Z',
  toolName,
  input: opts.input ?? {},
  toolUseId: 'u',
  isError: opts.isError ?? null,
  resultBytes: 0,
})
const task = (subagent_type: string, opts: { ts?: string; isError?: boolean } = {}) =>
  tc('Task', { ts: opts.ts, input: { subagent_type }, isError: opts.isError })
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })
const compute = (toolData: ToolUsageData[]) => computeAgentEffectiveness([], [], [], toolData, [])

describe('computeAgentEffectiveness', () => {
  it('treats an artifact-producing follow-up within the window as a successful run', () => {
    const data = [
      session('s', [
        task('Explore', { ts: '2026-01-01T00:00:00Z' }),
        tc('Edit', { ts: '2026-01-01T00:01:00Z', input: { file_path: '/a.ts' } }),
      ]),
    ]
    const r = compute(data).find((x) => x.agentType === 'Explore')!
    expect(r).toMatchObject({
      agentType: 'Explore',
      runs: 1,
      medianTimeToResultMs: 60_000,
      produceArtifactRate: 1,
      noOpRate: 0,
      sessionCount: 1,
    })
    expect(r.commonFollowUps).toEqual([{ toolName: 'Edit', count: 1 }])
  })

  it('counts a run as a no-op when the next non-Task call is beyond the follow-up window', () => {
    const data = [
      session('s', [
        task('Slow', { ts: '2026-01-01T00:00:00Z' }),
        tc('Edit', { ts: '2026-01-01T00:11:00Z', input: { file_path: '/a.ts' } }), // 11 min > 10 min window
      ]),
    ]
    const r = compute(data).find((x) => x.agentType === 'Slow')!
    expect(r.noOpRate).toBe(1)
    expect(r.produceArtifactRate).toBe(0)
  })

  it('records a failed Task run in failureModes', () => {
    const data = [
      session('s', [
        task('Flaky', { ts: '2026-01-01T00:00:00Z', isError: true }),
        tc('Read', { ts: '2026-01-01T00:00:30Z', input: { file_path: '/a.ts' } }),
      ]),
    ]
    expect(compute(data).find((x) => x.agentType === 'Flaky')!.failureModes).toBe(1)
  })

  it('attributes a chained parent follow-up to at most one spawn (#3138)', () => {
    // Task(Superseded), Task(Active), Edit: only the most-recent active spawn
    // can own the single Edit. The earlier spawn is superseded before the
    // parent acts, so it gets NO attributable follow-up (a no-op) — never a
    // shared artifact credit. Five chained runs each across two sessions.
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
    const seq = (base: number): ToolCall[] => [
      task('Superseded', { ts: new Date(base).toISOString() }),
      task('Active', { ts: new Date(base + 60_000).toISOString() }),
      tc('Edit', { ts: new Date(base + 120_000).toISOString(), input: { file_path: '/a.ts' } }),
    ]
    const data = [
      session('s1', [...seq(t0), ...seq(t0 + 600_000), ...seq(t0 + 1_200_000)]),
      session('s2', [...seq(t0 + 1_800_000), ...seq(t0 + 2_400_000)]),
    ]
    const rows = computeAgentEffectiveness([], [], [], data, [])
    const superseded = rows.find((x) => x.agentType === 'Superseded')!
    const active = rows.find((x) => x.agentType === 'Active')!

    expect(superseded.runs).toBe(5)
    expect(active.runs).toBe(5)
    expect(superseded.sessionCount).toBe(2)
    expect(active.sessionCount).toBe(2)

    // The Edit is credited only to the active spawn.
    expect(active.produceArtifactRate).toBe(1)
    expect(active.commonFollowUps).toEqual([{ toolName: 'Edit', count: 5 }])
    // The superseded spawn's artifact rate is NOT inflated by the shared Edit.
    expect(superseded.produceArtifactRate).toBe(0)
    expect(superseded.noOpRate).toBe(1)
    expect(superseded.commonFollowUps).toEqual([])

    // No explorer-first suggestion is published for the unsupported spawn.
    const pub = publishAgentTaskSuggestions(rows)
    expect(pub.suggestions.find((s) => s.agentType === 'Active')?.message).toContain(
      'explorer-first'
    )
    expect(
      pub.suggestions.some(
        (s) => s.agentType === 'Superseded' && s.message.includes('explorer-first')
      )
    ).toBe(false)
  })

  it('does not count same-turn parallel-sibling spawns as no-ops (#3614)', () => {
    // Three same-type agents fanned out in ONE parallel cluster (shared
    // timestamp), then a single Edit. The first two siblings are superseded by
    // the near-simultaneous next spawn, NOT no-ops; only the last owns the Edit.
    // Pre-fix this scored noOpRate 2/3 ≈ 0.67 and fired a fabricated
    // "output may not be actionable" claim against a healthy parallel pattern.
    const t0 = '2026-01-01T00:00:00.000Z'
    const data = [
      session('s', [
        task('Fan', { ts: t0 }),
        task('Fan', { ts: t0 }),
        task('Fan', { ts: t0 }),
        tc('Edit', { ts: '2026-01-01T00:01:00.000Z', input: { file_path: '/a.ts' } }),
      ]),
    ]
    const rows = computeAgentEffectiveness([], [], [], data, [])
    const fan = rows.find((x) => x.agentType === 'Fan')!
    expect(fan.runs).toBe(3)
    expect(fan.supersededRuns).toBe(2)
    // 0 no-ops over the 1 non-superseded run → noOpRate 0, below the 0.5 gate.
    expect(fan.noOpRate).toBe(0)

    // The no-op recommendation must NOT fire for the parallel fan-out.
    const suggestions = suggestAgentWorkflows(rows)
    expect(suggestions.some((s) => s.message.includes('no parent follow-up'))).toBe(false)
  })

  it('still fires the no-op recommendation for genuine single-spawn no-ops (#3614)', () => {
    // Three lone spawns across three sessions, each with no follow-up at all and
    // no parallel sibling anywhere. Every run is a true no-op; the recommendation
    // must still fire (no over-suppression from the superseded bucket).
    const data = [
      session('s1', [task('Lonely', { ts: '2026-01-01T00:00:00Z' })]),
      session('s2', [task('Lonely', { ts: '2026-01-02T00:00:00Z' })]),
      session('s3', [task('Lonely', { ts: '2026-01-03T00:00:00Z' })]),
    ]
    const rows = computeAgentEffectiveness([], [], [], data, [])
    const lonely = rows.find((x) => x.agentType === 'Lonely')!
    expect(lonely.runs).toBe(3)
    expect(lonely.supersededRuns).toBe(0)
    expect(lonely.noOpRate).toBe(1)
    const suggestions = suggestAgentWorkflows(rows)
    expect(suggestions.some((s) => s.message.includes('no parent follow-up'))).toBe(true)
  })

  it('a later, gapped spawn does not suppress a genuine no-op (#3614)', () => {
    // Two 'Seq' spawns 30s apart — well beyond the 2s parallel-cluster window —
    // with no follow-up. The first genuinely drew no action before the parent
    // spawned again, so it must stay a no-op, NOT be reclassified as a superseded
    // parallel sibling. Guards against over-suppression.
    const pair = (baseIso: string): ToolCall[] => {
      const base = Date.parse(baseIso)
      return [
        task('Seq', { ts: new Date(base).toISOString() }),
        task('Seq', { ts: new Date(base + 30_000).toISOString() }),
      ]
    }
    const data = [
      session('s1', pair('2026-01-01T00:00:00Z')),
      session('s2', pair('2026-01-02T00:00:00Z')),
    ]
    const rows = computeAgentEffectiveness([], [], [], data, [])
    const seq = rows.find((x) => x.agentType === 'Seq')!
    expect(seq.runs).toBe(4)
    expect(seq.supersededRuns).toBe(0)
    expect(seq.noOpRate).toBe(1)
    const suggestions = suggestAgentWorkflows(rows)
    expect(suggestions.some((s) => s.message.includes('no parent follow-up'))).toBe(true)
  })
})

describe('suggestAgentWorkflows', () => {
  const baseRow = (over: Partial<AgentEffectivenessRow>): AgentEffectivenessRow => ({
    agentType: 'A',
    runs: 5,
    supersededRuns: 0,
    medianTimeToResultMs: 0,
    produceArtifactRate: 0,
    noOpRate: 0,
    meanCostUsd: 0,
    commonFollowUps: [],
    failureModes: 0,
    sessionCount: 1,
    ...over,
  })

  it('skips agents with fewer than 3 runs', () => {
    const rows = [baseRow({ agentType: 'Rare', runs: 2, produceArtifactRate: 1, commonFollowUps: [{ toolName: 'Edit', count: 2 }] })]
    expect(suggestAgentWorkflows(rows)).toEqual([])
  })

  it('suggests an explorer-first workflow for high artifact rate with a top follow-up', () => {
    const rows = [baseRow({ agentType: 'Explore', runs: 5, produceArtifactRate: 0.8, commonFollowUps: [{ toolName: 'Edit', count: 4 }] })]
    const out = suggestAgentWorkflows(rows)
    expect(out).toHaveLength(1)
    expect(out[0].agentType).toBe('Explore')
    expect(out[0].weight).toBeCloseTo(4) // runs * artifactRate = 5 * 0.8
  })

  it('flags no-op-heavy and failure-prone agents, sorted by weight desc', () => {
    const rows = [
      baseRow({ agentType: 'NoOp', runs: 4, noOpRate: 0.75, failureModes: 1 }), // noOp (weight 3) + failure (1/4>=0.25, weight 1)
    ]
    const out = suggestAgentWorkflows(rows)
    expect(out.map((s) => s.message.includes('no parent follow-up'))).toContain(true)
    expect(out.map((s) => s.message.includes('reported errors'))).toContain(true)
    // sorted by weight desc: no-op (3) before failure (1)
    expect(out[0].weight).toBeGreaterThan(out[1].weight)
  })
})

describe('publishAgentTaskSuggestions', () => {
  const baseRow = (over: Partial<AgentEffectivenessRow>): AgentEffectivenessRow => ({
    agentType: 'A',
    runs: 5,
    supersededRuns: 0,
    medianTimeToResultMs: 0,
    produceArtifactRate: 0,
    noOpRate: 0,
    meanCostUsd: 0,
    commonFollowUps: [],
    failureModes: 0,
    sessionCount: 2,
    ...over,
  })

  // A row that fires the artifact rule, parameterised by sample size.
  const artifactRow = (over: Partial<AgentEffectivenessRow>) =>
    baseRow({ produceArtifactRate: 0.8, commonFollowUps: [{ toolName: 'Edit', count: 4 }], ...over })

  it('withholds and reports insufficient-evidence when no agent clears the session floor', () => {
    // 6 runs but all in a single session -> below the 2-session floor.
    const pub = publishAgentTaskSuggestions([artifactRow({ runs: 6, sessionCount: 1 })])
    expect(pub.status).toBe('insufficient-evidence')
    expect(pub.suggestions).toEqual([])
    expect(pub.withheld).toBe(1)
  })

  it('withholds when an agent clears the session floor but not the run floor', () => {
    const pub = publishAgentTaskSuggestions([artifactRow({ runs: 4, sessionCount: 2 })])
    expect(pub.status).toBe('insufficient-evidence')
    expect(pub.withheld).toBe(1)
  })

  it('publishes a medium-confidence suggestion at the floor', () => {
    const pub = publishAgentTaskSuggestions([artifactRow({ agentType: 'Explore', runs: 5, sessionCount: 2 })])
    expect(pub.status).toBe('ok')
    expect(pub.suggestions).toHaveLength(1)
    expect(pub.suggestions[0]).toMatchObject({ agentType: 'Explore', confidence: 'medium', runs: 5, sessionCount: 2 })
  })

  it('promotes to high confidence with a large multi-session sample', () => {
    const pub = publishAgentTaskSuggestions([artifactRow({ agentType: 'Explore', runs: 12, sessionCount: 3 })])
    expect(pub.status).toBe('ok')
    expect(pub.suggestions[0].confidence).toBe('high')
  })

  it('reports no-signal when an agent clears the floor but no rule fires', () => {
    // Enough evidence, but a flat row: no artifact, no no-op, no failures.
    const pub = publishAgentTaskSuggestions([baseRow({ runs: 8, sessionCount: 2 })])
    expect(pub.status).toBe('no-signal')
    expect(pub.suggestions).toEqual([])
    expect(pub.withheld).toBe(0)
  })

  it('counts only sub-floor agents as withheld while publishing the eligible ones', () => {
    const pub = publishAgentTaskSuggestions([
      artifactRow({ agentType: 'Good', runs: 6, sessionCount: 2 }),
      artifactRow({ agentType: 'Thin', runs: 6, sessionCount: 1 }),
    ])
    expect(pub.status).toBe('ok')
    expect(pub.withheld).toBe(1)
    expect(pub.suggestions.map((s) => s.agentType)).toEqual(['Good'])
  })
})
