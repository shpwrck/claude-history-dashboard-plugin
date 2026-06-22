import { describe, it, expect } from 'vitest'
import { parseSessionTimeline, slimSessionTimeline, type SessionTimeline } from './parse-timeline'

const line = (o: Record<string, unknown>) => JSON.stringify(o)

describe('parseSessionTimeline', () => {
  it('returns null when no usable entries are present', () => {
    expect(parseSessionTimeline('', 's.jsonl')).toBeNull()
    // A line with no timestamp is skipped.
    expect(parseSessionTimeline(line({ type: 'user', message: 'hi' }), 's.jsonl')).toBeNull()
  })

  it('derives sessionId from the filename', () => {
    const text = line({ type: 'user', timestamp: '2026-01-01', message: { content: 'hello' } })
    expect(parseSessionTimeline(text, 'my-session.jsonl')!.sessionId).toBe('my-session')
  })

  it('emits a user entry with a summarized string message', () => {
    const text = line({ type: 'user', timestamp: '2026-01-01', message: { content: 'a\nb' } })
    const tl = parseSessionTimeline(text, 's.jsonl')!
    expect(tl.entries[0]).toMatchObject({
      kind: 'user',
      summary: 'a b',
      summaryLen: 3,
      hasCode: false,
      isQuestion: false,
    })
    expect(tl.firstPromptPreview).toBe('a b')
  })

  it('derives code and question signals from each summarized entry', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-01-01', message: { content: 'Can you inspect this?  ' } }),
      line({ type: 'user', timestamp: '2026-01-02', message: { content: '```ts\nconst x = 1\n```' } }),
    ].join('\n')
    const tl = parseSessionTimeline(text, 's.jsonl')!

    expect(tl.entries[0]).toMatchObject({
      summaryLen: 'Can you inspect this?'.length,
      hasCode: false,
      isQuestion: true,
    })
    expect(tl.entries[1]).toMatchObject({
      hasCode: true,
      isQuestion: false,
    })
  })

  it('emits assistant text, thinking, and tool_use entries', () => {
    const text = line({
      type: 'assistant',
      timestamp: '2026-01-01',
      message: {
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    })
    const kinds = parseSessionTimeline(text, 's.jsonl')!.entries.map((e) => e.kind)
    expect(kinds).toEqual(['assistant', 'thinking', 'tool_use'])
    const toolUse = parseSessionTimeline(text, 's.jsonl')!.entries.find((e) => e.kind === 'tool_use')!
    expect(toolUse.toolName).toBe('Bash')
    expect(toolUse.toolUseId).toBe('toolu_bash_1')
  })

  it('emits a tool_result entry from a user message, carrying the error flag', () => {
    const text = line({
      type: 'user',
      timestamp: '2026-01-01',
      message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'failed' }] },
    })
    const entry = parseSessionTimeline(text, 's.jsonl')!.entries[0]
    expect(entry).toMatchObject({ kind: 'tool_result', toolUseId: 'u1', isError: true })
  })

  it('flags assistant turn-ends on passive wait language (#1873), even past the summary cutoff', () => {
    const filler = 'Here is a long status update about the work in progress. '.repeat(6) // > 200 chars
    const text = [
      line({ type: 'assistant', timestamp: '2026-01-01', message: { content: [{ type: 'text', text: `${filler}I'll wait for it to finish and report back.` }] } }),
      line({ type: 'assistant', timestamp: '2026-01-02', message: { content: [{ type: 'text', text: 'Done — here is the result.' }] } }),
    ].join('\n')
    const entries = parseSessionTimeline(text, 's.jsonl')!.entries
    // Detected on the full untruncated text — the phrase is past the ~200-char summary cutoff.
    expect(entries[0].waitLanguage).toBe(true)
    expect(entries[0].summary).not.toContain("I'll wait")
    // A plain (non-wait) ending carries no flag (omitted, not false).
    expect(entries[1].waitLanguage).toBeUndefined()
  })

  it('flags harness-backed tool calls as backgrounded (#1873)', () => {
    const text = line({
      type: 'assistant',
      timestamp: '2026-01-01',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'c', name: 'Workflow', input: {} },
          { type: 'tool_use', id: 'd', name: 'Task', input: {} },
        ],
      },
    })
    const byId = new Map(parseSessionTimeline(text, 's.jsonl')!.entries.map((e) => [e.toolUseId, e]))
    expect(byId.get('a')!.backgrounded).toBe(true) // run_in_background Bash
    expect(byId.get('b')!.backgrounded).toBeUndefined() // foreground Bash
    expect(byId.get('c')!.backgrounded).toBe(true) // Workflow self-resumes
    expect(byId.get('d')!.backgrounded).toBe(true) // Task self-resumes
  })

  it('flags the user interrupt sentinel and only it (#1754)', () => {
    const text = [
      // Real prompt that merely quotes the phrase — NOT an interrupt.
      line({ type: 'user', timestamp: '2026-01-01', message: { content: 'fix the [Request interrupted by user] handling' } }),
      // Genuine interrupt sentinel, as a user text block.
      line({ type: 'user', timestamp: '2026-01-02', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      // The "for tool use" variant as a bare string.
      line({ type: 'user', timestamp: '2026-01-03', message: { content: '[Request interrupted by user for tool use]' } }),
      // An assistant turn discussing it — never flagged (it is kind assistant).
      line({ type: 'assistant', timestamp: '2026-01-04', message: { content: [{ type: 'text', text: 'The [Request interrupted by user] sentinel marks a steer.' }] } }),
    ].join('\n')
    const entries = parseSessionTimeline(text, 's.jsonl')!.entries
    expect(entries[0]).toMatchObject({ kind: 'user' })
    expect(entries[0].interrupted).toBeUndefined() // quoted, not a real interrupt
    expect(entries[1].interrupted).toBe(true)
    expect(entries[2].interrupted).toBe(true)
    expect(entries[3]).toMatchObject({ kind: 'assistant' })
    expect(entries[3].interrupted).toBeUndefined()
  })

  it('records an unknown line type as an "other" entry summarized by its type', () => {
    const text = line({ type: 'system', timestamp: '2026-01-01' })
    expect(parseSessionTimeline(text, 's.jsonl')!.entries[0]).toMatchObject({ kind: 'other', summary: 'system' })
  })

  it('captures first-seen session dimensions and service_tier from message.usage', () => {
    const text = [
      line({ type: 'system', timestamp: '2026-01-01', version: '1.0', gitBranch: 'main', entrypoint: 'cli' }),
      line({ type: 'assistant', timestamp: '2026-01-02', version: '2.0', message: { content: [{ type: 'text', text: 'x' }], usage: { service_tier: 'standard' } } }),
    ].join('\n')
    const tl = parseSessionTimeline(text, 's.jsonl')!
    expect(tl.version).toBe('1.0') // first-seen wins
    expect(tl.gitBranch).toBe('main')
    expect(tl.entrypoint).toBe('cli')
    expect(tl.serviceTier).toBe('standard')
  })

  it('sorts entries by timestamp and sets start/end accordingly', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-01-03', message: { content: 'late' } }),
      line({ type: 'user', timestamp: '2026-01-01', message: { content: 'early' } }),
      line({ type: 'user', timestamp: '2026-01-02', message: { content: 'mid' } }),
    ].join('\n')
    const tl = parseSessionTimeline(text, 's.jsonl')!
    expect(tl.entries.map((e) => e.summary)).toEqual(['early', 'mid', 'late'])
    expect(tl.startTime).toBe('2026-01-01')
    expect(tl.endTime).toBe('2026-01-03')
  })
})

describe('slimSessionTimeline (#1035)', () => {
  const base: SessionTimeline = {
    sessionId: 's1',
    startTime: '2026-01-01',
    endTime: '2026-01-02',
    entries: [
      { timestamp: '2026-01-01', kind: 'user', summary: 'fix the bug please' },
      { timestamp: '2026-01-01', kind: 'assistant', summary: 'Looking at the file now' },
      { timestamp: '2026-01-01', kind: 'tool_use', summary: '{"file_path":"/a/b.ts"}', toolName: 'Read', toolUseId: 'read-1' },
      { timestamp: '2026-01-01', kind: 'tool_result', summary: 'export const x = 1', toolUseId: 'read-1', isError: false },
      { timestamp: '2026-01-02', kind: 'thinking', summary: '' },
    ],
  }

  it('strips every entry summary, carries derived fields, and flags the timeline slim', () => {
    const slim = slimSessionTimeline(base)
    expect(slim.slim).toBe(true)
    expect(slim.firstPromptPreview).toBe('fix the bug please')
    expect(slim.entries.every((e) => !('summary' in e))).toBe(true)
    expect(slim.entries.map((e) => e.summaryLen)).toEqual([18, 23, 23, 18, 0])
    expect(slim.entries.map((e) => e.hasCode)).toEqual([false, false, false, false, false])
    expect(slim.entries.map((e) => e.isQuestion)).toEqual([false, false, false, false, false])
    // Everything except summary survives untouched.
    expect(slim.entries.map((e) => e.kind)).toEqual(base.entries.map((e) => e.kind))
    expect(slim.entries[2].toolName).toBe('Read')
    expect(slim.entries[2].toolUseId).toBe('read-1')
    expect(slim.entries[3].toolUseId).toBe('read-1')
    expect(slim.entries[3].isError).toBe(false)
    expect(slim.sessionId).toBe('s1')
  })

  it('does not mutate the input timeline', () => {
    const before = JSON.stringify(base)
    slimSessionTimeline(base)
    expect(JSON.stringify(base)).toBe(before)
  })

  it('strips user summaries too so bulk entries carry no summary key', () => {
    const allUser: SessionTimeline = {
      ...base,
      entries: [
        { timestamp: '2026-01-01', kind: 'user', summary: 'hello' },
        { timestamp: '2026-01-01', kind: 'assistant', summary: '' },
      ],
    }
    const out = slimSessionTimeline(allUser)
    expect(out).not.toBe(allUser)
    expect(out.slim).toBe(true)
    expect(out.entries).toEqual([
      {
        timestamp: '2026-01-01',
        kind: 'user',
        summaryLen: 5,
        hasCode: false,
        isQuestion: false,
      },
      {
        timestamp: '2026-01-01',
        kind: 'assistant',
        summaryLen: 0,
        hasCode: false,
        isQuestion: false,
      },
    ])
  })
})
