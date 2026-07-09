import { describe, it, expect } from 'vitest'
import {
  parseSessionTimeline,
  slimSessionTimeline,
  isBackgroundableBashCommand,
  type SessionTimeline,
} from './parse-timeline'

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

  it('classifies the wait class on a passive-wait turn-end (#1880)', () => {
    const text = [
      line({ type: 'assistant', timestamp: '2026-01-01', message: { content: [{ type: 'text', text: "I'll wait for CI to go green and report back." }] } }),
      line({ type: 'assistant', timestamp: '2026-01-02', message: { content: [{ type: 'text', text: "I'll wait for the deploy to finish and let you know." }] } }),
      line({ type: 'assistant', timestamp: '2026-01-03', message: { content: [{ type: 'text', text: "I'll wait and report back." }] } }),
      line({ type: 'assistant', timestamp: '2026-01-04', message: { content: [{ type: 'text', text: 'Done — here is the result.' }] } }),
    ].join('\n')
    const entries = parseSessionTimeline(text, 's.jsonl')!.entries
    expect(entries[0].waitClass).toBe('ci')
    expect(entries[1].waitClass).toBe('deploy')
    // Wait language with no class-specific signal → the 'generic' floor.
    expect(entries[2].waitClass).toBe('generic')
    // A non-wait ending carries no class at all (it is only set alongside waitLanguage).
    expect(entries[3].waitClass).toBeUndefined()
  })

  it('preserves waitClass through slimSessionTimeline (survives summary stripping)', () => {
    const text = line({ type: 'assistant', timestamp: '2026-01-01', message: { content: [{ type: 'text', text: "I'll wait for the rollout to complete and circle back." }] } })
    const slim = slimSessionTimeline(parseSessionTimeline(text, 's.jsonl')!)
    expect(slim.entries[0].summary).toBeUndefined()
    expect(slim.entries[0].waitClass).toBe('deploy')
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

  it('flags backgroundableKind for long Bash invocations and Agent/Workflow, orthogonal to backgrounded (#2238)', () => {
    const text = line({
      type: 'assistant',
      timestamp: '2026-01-01',
      message: {
        content: [
          // Long-running foreground Bash toolchain invocations -> backgroundableKind, NOT backgrounded.
          { type: 'tool_use', id: 'build', name: 'Bash', input: { command: 'cd /repo && npm run build' } },
          { type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npx vitest run' } },
          // Backgrounded build: backgroundableKind AND backgrounded both true.
          { type: 'tool_use', id: 'bgbuild', name: 'Bash', input: { command: 'npm run build', run_in_background: true } },
          // Innocuous Bash -> neither flag.
          { type: 'tool_use', id: 'status', name: 'Bash', input: { command: 'git status' } },
          { type: 'tool_use', id: 'lsbuild', name: 'Bash', input: { command: 'ls build/' } },
          // Foreground Agent -> backgroundableKind without backgrounded (the new countable cost).
          // (Agent/Task/Workflow are in BOTH the self-resuming and backgroundable-kind sets, so the
          // parser marks them backgrounded too; the foreground/blocking case is exercised by the
          // detector test where backgrounded is explicitly absent.)
          { type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'fan out' } },
        ],
      },
    })
    const byId = new Map(parseSessionTimeline(text, 's.jsonl')!.entries.map((e) => [e.toolUseId, e]))
    expect(byId.get('build')!.backgroundableKind).toBe(true)
    expect(byId.get('build')!.backgrounded).toBeUndefined() // foreground long Bash
    expect(byId.get('test')!.backgroundableKind).toBe(true)
    expect(byId.get('bgbuild')!.backgroundableKind).toBe(true)
    expect(byId.get('bgbuild')!.backgrounded).toBe(true)
    expect(byId.get('status')!.backgroundableKind).toBeUndefined() // git status is not backgroundable
    expect(byId.get('lsbuild')!.backgroundableKind).toBeUndefined() // `build` is an argument, not the command
    expect(byId.get('agent')!.backgroundableKind).toBe(true) // Agent is a backgroundable kind
  })

  it('isBackgroundableBashCommand matches invocations, not bare-word arguments', () => {
    for (const cmd of ['npm run build', 'cd /r && pnpm install', 'npx vitest', 'sudo podman compose up', 'CI=1 tsc -b', 'make']) {
      expect(isBackgroundableBashCommand(cmd)).toBe(true)
    }
    for (const cmd of ['ls deploy/', 'cat build.log', 'find . -name "*.test.ts"', 'grep -n test src/foo.ts', 'git status', '']) {
      expect(isBackgroundableBashCommand(cmd)).toBe(false)
    }
    expect(isBackgroundableBashCommand(undefined)).toBe(false)
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

  it('flags rediscovery-of-durable-state turns and survives slimming (#2312)', () => {
    const filler = 'A long preamble describing the investigation in some detail. '.repeat(6) // > 200 chars
    const text = [
      // User asking where durable state lives — a rediscovery hit.
      line({ type: 'user', timestamp: '2026-01-01', message: { content: 'where is the remote config for this service?' } }),
      // Assistant rediscovery language past the ~200-char summary cutoff.
      line({ type: 'assistant', timestamp: '2026-01-02', message: { content: [{ type: 'text', text: `${filler}which template created the deployed config?` }] } }),
      // Ordinary chatter with no durable-state noun — NOT a rediscovery hit.
      line({ type: 'user', timestamp: '2026-01-03', message: { content: 'where is the bug in this function?' } }),
    ].join('\n')
    const entries = parseSessionTimeline(text, 's.jsonl')!.entries
    expect(entries[0].rediscovery).toBe(true)
    expect(entries[1].rediscovery).toBe(true) // detected on full text past the summary cutoff
    expect(entries[1].summary).not.toContain('template')
    expect(entries[2].rediscovery).toBeUndefined() // no durable-state noun

    // The flag survives slimSessionTimeline (which strips summary) — the only
    // signal the server-side detector has on the bulk dataset.
    const slim = slimSessionTimeline(parseSessionTimeline(text, 's.jsonl')!)
    expect(slim.entries[0].summary).toBeUndefined()
    expect(slim.entries[0].rediscovery).toBe(true)
    expect(slim.entries[1].rediscovery).toBe(true)
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

  it('strips every entry summary, prunes derived fields to user entries, and flags the timeline slim', () => {
    const slim = slimSessionTimeline(base)
    expect(slim.slim).toBe(true)
    expect(slim.firstPromptPreview).toBe('fix the bug please')
    expect(slim.entries.every((e) => !('summary' in e))).toBe(true)
    // #2106: summaryLen survives only on the `user` entry (its only bulk reader);
    // non-user entries drop it (read back as 0 via the `?? 0` fallback).
    expect(slim.entries.map((e) => e.summaryLen)).toEqual([18, undefined, undefined, undefined, undefined])
    // #2106: hasCode/isQuestion are sparse-true on user entries and dropped on
    // every non-user entry — none are true here, so all read undefined.
    expect(slim.entries.map((e) => e.hasCode)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(slim.entries.map((e) => e.isQuestion)).toEqual([undefined, undefined, undefined, undefined, undefined])
    // Everything except summary + pruned derived signals survives untouched.
    expect(slim.entries.map((e) => e.kind)).toEqual(base.entries.map((e) => e.kind))
    expect(slim.entries[2].toolName).toBe('Read')
    expect(slim.entries[2].toolUseId).toBe('read-1')
    expect(slim.entries[3].toolUseId).toBe('read-1')
    expect(slim.entries[3].isError).toBe(false)
    expect(slim.sessionId).toBe('s1')
  })

  it('keeps hasCode/isQuestion on user entries only when true (#2106 sparse-true)', () => {
    const withSignals: SessionTimeline = {
      ...base,
      entries: [
        { timestamp: '2026-01-01', kind: 'user', summary: '```diff``` is this right?' },
        // a non-user entry whose summary would set the flags — pruned in bulk
        { timestamp: '2026-01-01', kind: 'assistant', summary: '```code``` here?' },
      ],
    }
    const out = slimSessionTimeline(withSignals)
    expect(out.entries[0].hasCode).toBe(true)
    expect(out.entries[0].isQuestion).toBe(true)
    expect(out.entries[0].summaryLen).toBe('```diff``` is this right?'.length)
    // non-user entry: every derived signal dropped regardless of its summary.
    expect('hasCode' in out.entries[1]).toBe(false)
    expect('isQuestion' in out.entries[1]).toBe(false)
    expect('summaryLen' in out.entries[1]).toBe(false)
  })

  it('preserves backgroundableKind through slimming (modelled on waitLanguage, #2238)', () => {
    const withKind: SessionTimeline = {
      ...base,
      entries: [
        { timestamp: '2026-01-01', kind: 'user', summary: 'build it' },
        { timestamp: '2026-01-01', kind: 'tool_use', summary: '{"command":"npm run build"}', toolName: 'Bash', toolUseId: 'b1', backgroundableKind: true },
        // a backgrounded Agent: both flags survive
        { timestamp: '2026-01-01', kind: 'tool_use', summary: '{}', toolName: 'Agent', toolUseId: 'a1', backgroundableKind: true, backgrounded: true },
      ],
    }
    const out = slimSessionTimeline(withKind)
    // command summary is gone...
    expect('summary' in out.entries[1]).toBe(false)
    // ...but backgroundableKind survives so the detector fires on the bulk path.
    expect(out.entries[1].backgroundableKind).toBe(true)
    expect(out.entries[2].backgroundableKind).toBe(true)
    expect(out.entries[2].backgrounded).toBe(true)
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
    // #2106: user keeps summaryLen; its false booleans are dropped (sparse-true).
    // The non-user entry drops all three derived signals.
    expect(out.entries).toEqual([
      {
        timestamp: '2026-01-01',
        kind: 'user',
        summaryLen: 5,
      },
      {
        timestamp: '2026-01-01',
        kind: 'assistant',
      },
    ])
  })
})
