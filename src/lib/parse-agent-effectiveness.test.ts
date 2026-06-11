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
})

describe('suggestAgentWorkflows', () => {
  const baseRow = (over: Partial<AgentEffectivenessRow>): AgentEffectivenessRow => ({
    agentType: 'A',
    runs: 5,
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
