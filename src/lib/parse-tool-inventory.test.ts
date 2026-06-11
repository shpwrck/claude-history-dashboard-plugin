import { describe, it, expect } from 'vitest'
import { parseToolInventory, aggregateInventory } from './parse-tool-inventory'
import type { ToolInventory } from './parse-tool-inventory'

const delta = (att: Record<string, unknown>) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_delta', ...att } })

const skillListing = (names: string[]) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', names } })

const toolUse = (name: string, input?: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: 't',
    message: { content: [{ type: 'tool_use', id: `u-${name}`, name, input }] },
  })

describe('parseToolInventory', () => {
  it('returns null when the transcript carries no tool manifest', () => {
    const text = toolUse('Bash')
    expect(parseToolInventory(text, 's.jsonl')).toBeNull()
  })

  it('unions added + readded names and subtracts removed ones', () => {
    const text = [
      delta({ addedNames: ['mcp__a', 'mcp__b'], removedNames: [], readdedNames: [] }),
      delta({ addedNames: ['mcp__c'], removedNames: ['mcp__b'], readdedNames: [] }),
    ].join('\n')
    const inv = parseToolInventory(text, 's.jsonl')!
    expect(inv.toolsAvailable).toEqual(['mcp__a', 'mcp__c'])
  })

  it('counts only invoked-and-available tools toward utilization', () => {
    const text = [
      delta({ addedNames: ['mcp__a', 'mcp__c'], removedNames: [], readdedNames: [] }),
      toolUse('mcp__a'), // available → used
      toolUse('Bash'), // not in manifest → ignored
    ].join('\n')
    const inv = parseToolInventory(text, 's.jsonl')!
    expect(inv.toolsUsed).toEqual(['mcp__a'])
    expect(inv.unusedTools).toEqual(['mcp__c'])
    expect(inv.utilizationPct).toBe(50)
  })

  it('folds skills into the manifest and matches them via the Skill tool arg', () => {
    const text = [
      skillListing(['groom-backlog']),
      toolUse('Skill', { skill: 'groom-backlog' }),
    ].join('\n')
    const inv = parseToolInventory(text, 's.jsonl')!
    expect(inv.toolsAvailable).toEqual(['Skill:groom-backlog'])
    expect(inv.toolsUsed).toEqual(['Skill:groom-backlog'])
    expect(inv.utilizationPct).toBe(100)
  })

  it('reports 0% utilization when a manifest exists but nothing is invoked', () => {
    const inv = parseToolInventory(delta({ addedNames: ['mcp__a'] }), 's.jsonl')!
    expect(inv.utilizationPct).toBe(0)
    expect(inv.unusedTools).toEqual(['mcp__a'])
  })
})

describe('aggregateInventory', () => {
  const inv = (over: Partial<ToolInventory>): ToolInventory => ({
    sessionId: 's',
    toolsAvailable: [],
    toolsUsed: [],
    unusedTools: [],
    utilizationPct: 0,
    ...over,
  })

  it('rolls up slot totals and overall utilization across sessions', () => {
    const agg = aggregateInventory([
      inv({ toolsAvailable: ['a', 'b'], toolsUsed: ['a'] }),
      inv({ toolsAvailable: ['a', 'c'], toolsUsed: ['a', 'c'] }),
    ])
    expect(agg.sessionsAnalyzed).toBe(2)
    expect(agg.totalAvailableSlots).toBe(4)
    expect(agg.totalUsedSlots).toBe(3)
    expect(agg.utilizationPct).toBe(75)
  })

  it('ranks never-used-most tools first in unusedByFrequency', () => {
    const agg = aggregateInventory([
      inv({ toolsAvailable: ['waste', 'b'], toolsUsed: ['b'] }),
      inv({ toolsAvailable: ['waste'], toolsUsed: [] }),
    ])
    expect(agg.unusedByFrequency[0]).toMatchObject({ toolName: 'waste', loadedIn: 2, usedIn: 0 })
    // 'b' was always used, so it is not reported as unused.
    expect(agg.unusedByFrequency.map((r) => r.toolName)).not.toContain('b')
  })

  it('returns 0% utilization for an empty inventory set', () => {
    expect(aggregateInventory([]).utilizationPct).toBe(0)
  })
})
