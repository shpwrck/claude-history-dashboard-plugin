import { describe, it, expect } from 'vitest'
import {
  parseAttribution,
  aggregateAttributionAgents,
  aggregateAttributionSkills,
  aggregateMcpUsage,
  aggregateAgentInvocations,
  aggregateSkillInvocations,
  parseAgentSettings,
  UNSPECIFIED_BUCKET,
} from './parse-agents'
import type { ToolCall, ToolUsageData } from './parse-tools'

const line = (o: Record<string, unknown>) => JSON.stringify(o)
const withTokens = (attr: Record<string, unknown>, outputTokens = 0) =>
  line({ type: 'assistant', timestamp: 't', message: { usage: { output_tokens: outputTokens } }, ...attr })

const call = (toolName: string, input: Record<string, unknown>): ToolCall => ({
  timestamp: 't',
  toolName,
  input,
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
})
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })

describe('parseAttribution', () => {
  it('tallies native agent/skill attribution with output-token cost', () => {
    const text = [
      withTokens({ attributionAgent: 'code-reviewer' }, 10),
      withTokens({ attributionAgent: 'code-reviewer' }, 5),
      withTokens({ attributionSkill: 'groom-backlog' }, 7),
    ].join('\n')
    const out = parseAttribution(text, 'sess.jsonl')!
    expect(out.sessionId).toBe('sess')
    expect(out.agents['code-reviewer']).toEqual({ invocations: 2, outputTokens: 15 })
    expect(out.skills['groom-backlog']).toEqual({ invocations: 1, outputTokens: 7 })
  })

  it('keys MCP tools as "server/tool" alongside the server rollup', () => {
    const text = withTokens({ attributionMcpServer: 'github', attributionMcpTool: 'create_pr' }, 4)
    const out = parseAttribution(text, 's.jsonl')!
    expect(out.mcpServers['github']).toEqual({ invocations: 1, outputTokens: 4 })
    expect(out.mcpTools['github/create_pr']).toEqual({ invocations: 1, outputTokens: 4 })
  })

  it('returns null when no attribution fields are present', () => {
    expect(parseAttribution(line({ type: 'assistant', timestamp: 't' }), 's.jsonl')).toBeNull()
  })
})

describe('aggregate attribution folds', () => {
  it('ranks agents and skills across sessions by invocations', () => {
    const a = parseAttribution([withTokens({ attributionAgent: 'x' }, 1), withTokens({ attributionAgent: 'y' }, 1)].join('\n'), 's1.jsonl')!
    const b = parseAttribution(withTokens({ attributionAgent: 'x' }, 2), 's2.jsonl')!
    const agents = aggregateAttributionAgents([a, b])
    expect(agents[0]).toEqual({ name: 'x', invocations: 2, outputTokens: 3, sessionCount: 2 })
    expect(agents.find((g) => g.name === 'y')).toMatchObject({ invocations: 1, sessionCount: 1 })

    const sk = parseAttribution(withTokens({ attributionSkill: 's' }, 9), 's1.jsonl')!
    expect(aggregateAttributionSkills([sk])[0]).toMatchObject({ name: 's', invocations: 1, outputTokens: 9 })
  })

  it('nests tools under their server and strips the server prefix from tool names', () => {
    const s = parseAttribution(
      [
        withTokens({ attributionMcpServer: 'github', attributionMcpTool: 'create_pr' }, 1),
        withTokens({ attributionMcpServer: 'github', attributionMcpTool: 'list_issues' }, 2),
      ].join('\n'),
      's1.jsonl'
    )!
    const mcp = aggregateMcpUsage([s])
    expect(mcp[0].server).toBe('github')
    expect(mcp[0].invocations).toBe(2)
    expect(mcp[0].tools.map((t) => t.name).sort()).toEqual(['create_pr', 'list_issues'])
  })
})

describe('aggregateAgentInvocations / aggregateSkillInvocations (tool-call heuristic)', () => {
  it('counts Task subagent_type, bucketing missing types as _unspecified', () => {
    const data = [
      session('s1', [
        call('Task', { subagent_type: 'Explore' }),
        call('Task', { subagent_type: 'Explore' }),
        call('Task', {}), // no subagent_type → unspecified
        call('Bash', { command: 'ls' }), // not a Task
      ]),
    ]
    const agents = aggregateAgentInvocations(data)
    expect(agents[0]).toEqual({ subagentType: 'Explore', invocations: 2, sessionCount: 1 })
    expect(agents.find((a) => a.subagentType === UNSPECIFIED_BUCKET)).toMatchObject({ invocations: 1 })
  })

  it('counts Agent tool calls (current CLI wire name) the same as Task (#452)', () => {
    // Real Claude transcripts use 'Agent', not 'Task'. Both must be counted.
    const data = [
      session('s1', [
        call('Agent', { subagent_type: 'burn-backlog' }),
        call('Agent', { subagent_type: 'burn-backlog' }),
        call('Agent', { subagent_type: 'triage' }),
        call('Bash', { command: 'ls' }), // not an agent call
      ]),
      session('s2', [
        call('Agent', { subagent_type: 'triage' }),
        // Mix with legacy 'Task' in the same dataset
        call('Task', { subagent_type: 'burn-backlog' }),
      ]),
    ]
    const agents = aggregateAgentInvocations(data)
    const burnBacklog = agents.find((a) => a.subagentType === 'burn-backlog')
    const triage = agents.find((a) => a.subagentType === 'triage')
    expect(burnBacklog).toMatchObject({ subagentType: 'burn-backlog', invocations: 3, sessionCount: 2 })
    expect(triage).toMatchObject({ subagentType: 'triage', invocations: 2, sessionCount: 2 })
    // Total agent invocations across both sessions = 5 (3 burn-backlog + 2 triage)
    const total = agents.reduce((sum, a) => sum + a.invocations, 0)
    expect(total).toBe(5)
  })

  it('counts Skill invocations by skill arg', () => {
    const data = [session('s1', [call('Skill', { skill: 'triage' }), call('Skill', { skill: 'triage' })])]
    expect(aggregateSkillInvocations(data)[0]).toEqual({ skill: 'triage', invocations: 2, sessionCount: 1 })
  })
})

describe('parseAgentSettings', () => {
  it('extracts a type:"agent-setting" line with name/value', () => {
    const text = line({ type: 'agent-setting', timestamp: 't1', name: 'model', value: 'opus' })
    expect(parseAgentSettings(text, 'sess.jsonl')).toEqual([
      { sessionId: 'sess', timestamp: 't1', name: 'model', value: 'opus' },
    ])
  })

  it('emits one event per key for an agentSetting object without a name field', () => {
    const text = line({ timestamp: 't', agentSetting: { model: 'opus', thinking: 'on' } })
    const events = parseAgentSettings(text, 's.jsonl')
    expect(events.map((e) => [e.name, e.value]).sort()).toEqual([
      ['model', 'opus'],
      ['thinking', 'on'],
    ])
  })
})
