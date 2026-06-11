import { describe, it, expect } from 'vitest'
import { parseAssistantFeatures } from './parse-assistant-features'

// One assistant transcript line whose message.content is an array of blocks.
const assistant = (content: unknown[]) =>
  JSON.stringify({ type: 'assistant', timestamp: 't', message: { content } })
const text = (t: string) => ({ type: 'text', text: t })
const toolUse = (name = 'Bash') => ({ type: 'tool_use', id: 'u', name, input: {} })
const thinking = (t: string) => ({ type: 'thinking', thinking: t })

describe('parseAssistantFeatures', () => {
  it('returns null when there are no assistant turns', () => {
    expect(parseAssistantFeatures(JSON.stringify({ type: 'user', message: 'hi' }), 's.jsonl')).toBeNull()
    expect(parseAssistantFeatures('', 's.jsonl')).toBeNull()
  })

  it('derives sessionId and counts turns + text length + tool calls', () => {
    const out = parseAssistantFeatures(
      [assistant([text('hello world')]), assistant([toolUse('Read'), text('done')])].join('\n'),
      'sess-1.jsonl'
    )!
    expect(out.sessionId).toBe('sess-1')
    expect(out.assistantTurnCount).toBe(2)
    expect(out.textLength).toBe('hello world'.length + 'done'.length)
    expect(out.toolCallCount).toBe(1)
  })

  it('counts code fences as pairs (``` open/close = 1 block)', () => {
    const out = parseAssistantFeatures(assistant([text('before\n```js\ncode\n```\nafter\n```\nx\n```')]), 's.jsonl')!
    expect(out.codeBlockCount).toBe(2)
  })

  it('flags a refusal/concession turn once, regardless of how many markers it has', () => {
    const out = parseAssistantFeatures(assistant([text("You're right, I apologize — I cannot do that.")]), 's.jsonl')!
    expect(out.refusalCount).toBe(1)
  })

  it('does not flag a plain turn as refusal or hedging', () => {
    const out = parseAssistantFeatures(assistant([text('Here is the answer.')]), 's.jsonl')!
    expect(out.refusalCount).toBe(0)
    expect(out.hedgingCount).toBe(0)
  })

  it('flags hedging markers', () => {
    const out = parseAssistantFeatures(assistant([text('I think this might be the cause, perhaps.')]), 's.jsonl')!
    expect(out.hedgingCount).toBe(1)
  })

  it('flags a turn that ends with a question (trailing whitespace ignored)', () => {
    const ask = parseAssistantFeatures(assistant([text('Which file did you mean?  ')]), 's.jsonl')!
    expect(ask.endsWithQuestionCount).toBe(1)
    const noask = parseAssistantFeatures(assistant([text('It is in src/.')]), 's.jsonl')!
    expect(noask.endsWithQuestionCount).toBe(0)
  })

  it('sums thinking-block UTF-8 byte length', () => {
    // 'café' is 5 UTF-8 bytes (é = 2 bytes); 'ok' is 2 → 7 total.
    const out = parseAssistantFeatures(assistant([thinking('café'), thinking('ok'), text('reply')]), 's.jsonl')!
    expect(out.thinkingByteLen).toBe(7)
  })

  it('aggregates rates across turns (1 refusal of 3 turns)', () => {
    const out = parseAssistantFeatures(
      [assistant([text('fine')]), assistant([text("you're right")]), assistant([text('ok')])].join('\n'),
      's.jsonl'
    )!
    expect(out.assistantTurnCount).toBe(3)
    expect(out.refusalCount).toBe(1)
  })

  it('skips malformed lines and non-array message content', () => {
    const out = parseAssistantFeatures(
      ['not json', JSON.stringify({ type: 'assistant', message: { content: 'plain string' } }), assistant([text('real')])].join('\n'),
      's.jsonl'
    )!
    // only the one real array-content assistant turn counts
    expect(out.assistantTurnCount).toBe(1)
    expect(out.textLength).toBe('real'.length)
  })
})
