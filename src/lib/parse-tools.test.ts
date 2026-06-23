import { describe, it, expect } from 'vitest'
import {
  parseToolUsage,
  aggregateTools,
  topBashCommands,
  bashSubcommandStats,
  repeatedCommands,
  nativeToolBypass,
  nativeBypassByScope,
  mineCorrections,
  aggregateCorrections,
  stripToolCommandBodies,
} from './parse-tools'
import type { ToolCall, ToolUsageData } from './parse-tools'

// --- JSONL line builders -----------------------------------------------------

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}, ts = 't') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } })

const toolResult = (id: string, opts: { isError?: boolean; content?: unknown } = {}) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: opts.isError ?? false, content: opts.content ?? '' }] },
  })

// --- ToolUsageData builders (for the aggregate functions) --------------------

const call = (over: Partial<ToolCall>): ToolCall => ({
  timestamp: 't',
  toolName: 'Bash',
  input: {},
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
  ...over,
})

const bash = (command: string): ToolCall => call({ toolName: 'Bash', input: { command } })
const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls })

describe('parseToolUsage', () => {
  it('returns null when there are no tool_use blocks', () => {
    const text = JSON.stringify({ type: 'user', message: { content: 'just text' } })
    expect(parseToolUsage(text, 's.jsonl')).toBeNull()
  })

  it('pairs a tool_use with its later tool_result (error flag + result size)', () => {
    const text = [toolUse('u1', 'Bash', { command: 'ls' }), toolResult('u1', { content: 'files' })].join('\n')
    const out = parseToolUsage(text, 'sess.jsonl')!
    expect(out.sessionId).toBe('sess')
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0]).toMatchObject({ toolName: 'Bash', isError: false, resultBytes: 5 })
    expect(out.calls[0].input.command).toBe('ls')
    expect(out.calls[0].commandFingerprint).toBeTruthy()
    expect(out.calls[0].commandPreview).toBe('ls')
    expect(out.calls[0].commandHead).toBe('ls')
  })

  it('marks isError true for an error result', () => {
    const text = [toolUse('u1', 'Bash', { command: 'bad' }), toolResult('u1', { isError: true, content: 'boom' })].join('\n')
    expect(parseToolUsage(text, 's.jsonl')!.calls[0].isError).toBe(true)
  })

  it('dedupes tool_use blocks sharing an id', () => {
    const text = [toolUse('dup', 'Read'), toolUse('dup', 'Read')].join('\n')
    expect(parseToolUsage(text, 's.jsonl')!.calls).toHaveLength(1)
  })

  it('attaches a tool_result that arrives before its tool_use (pending path)', () => {
    const text = [toolResult('u1', { isError: true, content: 'early' }), toolUse('u1', 'Bash', { command: 'x' })].join('\n')
    const c = parseToolUsage(text, 's.jsonl')!.calls[0]
    expect(c.isError).toBe(true)
    expect(c.resultBytes).toBe(5)
  })

  it('sums array-form tool_result content sizes', () => {
    const text = [
      toolUse('u1', 'Bash', { command: 'x' }),
      toolResult('u1', { content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cde' }] }),
    ].join('\n')
    expect(parseToolUsage(text, 's.jsonl')!.calls[0].resultBytes).toBe(5)
  })

  it('precomputes command signals and strips raw Bash command bodies for bulk payloads', () => {
    const text = [
      toolUse('u1', 'Bash', { command: 'grep foo src && rm -rf build' }),
      toolResult('u1', { content: 'files' }),
      toolUse('u2', 'Read', { file_path: 'README.md' }),
      toolUse('u3', 'Bash', {
        command: `${'echo setup '.repeat(30)} && git stash && git checkout master && git stash pop`,
      }),
      toolUse('u4', 'mcp__runner__run', { command: 'remote command body' }),
    ].join('\n')
    const parsed = parseToolUsage(text, 's.jsonl')!
    const stripped = stripToolCommandBodies(parsed)
    const bashCall = stripped.calls[0]

    expect(Object.prototype.hasOwnProperty.call(bashCall.input, 'command')).toBe(false)
    expect(bashCall.commandFingerprint).toBe(parsed.calls[0].commandFingerprint)
    expect(bashCall.commandPreview).toBe('grep foo src && rm -rf build')
    expect(bashCall.commandHead).toBe('grep')
    expect(bashCall.commandBypassCategories).toContain('grep')
    expect(bashCall.commandDangerousPattern).toBe('rm -rf')
    expect(stripped.calls[1].input.file_path).toBe('README.md')
    expect(stripped.calls[2].commandPreview?.length).toBe(200)
    expect(stripped.calls[2].commandGitSegments).toEqual([
      'git stash',
      'git checkout master',
      'git stash pop',
    ])
    expect(Object.prototype.hasOwnProperty.call(stripped.calls[3].input, 'command')).toBe(false)
  })
})

describe('aggregateTools', () => {
  it('counts per tool, computes error rate, and sorts by count desc', () => {
    const data = [
      session('s', [
        call({ toolName: 'Bash', isError: true }),
        call({ toolName: 'Bash', isError: false }),
        call({ toolName: 'Read', isError: null }),
      ]),
    ]
    const agg = aggregateTools(data)
    expect(agg[0]).toMatchObject({ toolName: 'Bash', count: 2, errorCount: 1, errorRate: 50 })
    expect(agg[1]).toMatchObject({ toolName: 'Read', count: 1, errorCount: 0, errorRate: 0 })
  })
})

describe('topBashCommands', () => {
  it('tallies identical Bash command strings, sorted desc, honoring the limit', () => {
    const data = [session('s', [bash('ls'), bash('ls'), bash('pwd'), call({ toolName: 'Read', input: { file_path: '/x' } })])]
    expect(topBashCommands(data)).toEqual([
      { command: 'ls', count: 2 },
      { command: 'pwd', count: 1 },
    ])
    expect(topBashCommands(data, 1)).toEqual([{ command: 'ls', count: 2 }])
  })
})

describe('bashSubcommandStats', () => {
  it('groups by the first command token and strips an env-assignment prefix', () => {
    const data = [session('s', [bash('git status'), bash('git log'), bash('FOO=bar git push'), bash('ls -la')])]
    const stats = bashSubcommandStats(data)
    expect(stats.find((s) => s.token === 'git')).toEqual({ token: 'git', count: 3 })
    expect(stats.find((s) => s.token === 'ls')).toEqual({ token: 'ls', count: 1 })
  })
})

describe('repeatedCommands', () => {
  it('flags commands run >= minPerSession times within a session', () => {
    const data = [session('s1', [bash('npm test'), bash('npm test'), bash('npm test'), bash('once')])]
    const rep = repeatedCommands(data)
    expect(rep).toHaveLength(1)
    expect(rep[0]).toMatchObject({ command: 'npm test', sessions: 1, totalCount: 3, maxPerSession: 3 })
  })

  it('aggregates a repeated command across multiple sessions', () => {
    const data = [
      session('s1', [bash('make'), bash('make'), bash('make')]),
      session('s2', [bash('make'), bash('make'), bash('make'), bash('make')]),
    ]
    expect(repeatedCommands(data)[0]).toMatchObject({ command: 'make', sessions: 2, totalCount: 7, maxPerSession: 4 })
  })

  it('uses command fingerprints after raw command bodies are stripped', () => {
    const parsed = parseToolUsage(
      [
        toolUse('u1', 'Bash', { command: 'npm test' }),
        toolUse('u2', 'Bash', { command: 'npm test' }),
        toolUse('u3', 'Bash', { command: 'npm test' }),
      ].join('\n'),
      's.jsonl'
    )!
    const rep = repeatedCommands([stripToolCommandBodies(parsed)])
    expect(rep[0]).toMatchObject({ command: 'npm test', totalCount: 3 })
  })
})

describe('nativeToolBypass', () => {
  it('classifies unpiped grep/cat/cd bypasses and counts native Grep separately', () => {
    const data = [
      session('s', [
        bash('grep foo src'),
        bash('cat README.md'),
        bash('cd /tmp'),
        call({ toolName: 'Grep', input: {} }),
      ]),
    ]
    const out = nativeToolBypass(data)
    const cats = Object.fromEntries(out.categories.map((c) => [c.category, c.count]))
    expect(cats).toMatchObject({ grep: 1, cat: 1, cd: 1 })
    expect(out.grepRatio).toEqual({ native: 1, bash: 1 })
  })

  it('does NOT count a chained `cd <dir> && <cmd>` anchor as a cd bypass (#2014)', () => {
    // The mandated cwd-anchor idiom (AGENTS.md "Worktrees & Branches" + the
    // cwd-anchor-guard hook) — a chained cd anchors the following command in the
    // SAME invocation, so it is not a wasted leading cd. Only a STANDALONE cd is.
    const data = [
      session('s', [
        bash('cd /repo && git push'), // anchored — not a bypass
        bash('cd /repo; ls'), // `;`-chained — not a bypass
        bash('cd /repo || true'), // `||`-chained — not a bypass
        bash('cd /tmp'), // standalone — IS a bypass
      ]),
    ]
    const out = nativeToolBypass(data)
    const cd = out.categories.find((c) => c.category === 'cd')
    expect(cd?.count).toBe(1)
  })

  it('does NOT count a pipe-fed grep as a bypass (native Grep cannot read stdin)', () => {
    const data = [session('s', [bash('ls | grep foo')])]
    const out = nativeToolBypass(data)
    expect(out.categories.find((c) => c.category === 'grep')).toBeUndefined()
    expect(out.totalBypass).toBe(0)
  })

  it('counts find bypasses against native Glob in findRatio', () => {
    const data = [session('s', [bash('find . -name "*.ts"'), call({ toolName: 'Glob', input: {} })])]
    const out = nativeToolBypass(data)
    expect(out.findRatio).toEqual({ native: 1, bash: 1 })
  })
})

describe('nativeBypassByScope (#951)', () => {
  it('sums bypass count and result bytes per session, omitting non-bypass sessions', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', input: { command: 'grep foo src' }, resultBytes: 300 }),
        call({ toolName: 'Bash', input: { command: 'cat README.md' }, resultBytes: 200 }),
        call({ toolName: 'Bash', input: { command: 'ls' }, resultBytes: 999 }), // not a bypass
      ]),
      session('s2', [call({ toolName: 'Bash', input: { command: 'echo hi' }, resultBytes: 10 })]),
    ]
    const out = nativeBypassByScope(data)
    expect(out).toEqual([{ sessionId: 's1', count: 2, resultBytes: 500 }])
  })

  it('counts a command matching multiple bypass categories exactly once', () => {
    // `find … && grep …` matches both find and grep defs, but is one command.
    const data = [
      session('s', [
        call({ toolName: 'Bash', input: { command: 'find . -name x && grep y .' }, resultBytes: 80 }),
      ]),
    ]
    const out = nativeBypassByScope(data)
    expect(out).toEqual([{ sessionId: 's', count: 1, resultBytes: 80 }])
  })

  it('does not count a pipe-fed grep (consistent with nativeToolBypass)', () => {
    const data = [session('s', [call({ toolName: 'Bash', input: { command: 'ls | grep foo' }, resultBytes: 50 })])]
    expect(nativeBypassByScope(data)).toEqual([])
  })
})

// --- correction mining (#1040) -----------------------------------------------

const readCall = (file_path: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Read', input: { file_path }, isError })
const bashCall = (command: string, isError: boolean | null): ToolCall =>
  call({ toolName: 'Bash', input: { command }, isError })

describe('mineCorrections', () => {
  it('mines a file-path correction (same distinctive stem, different dir/ext)', () => {
    const data = [session('s1', [
      readCall('axion-formats/src/FirstClassEntity.java', true),
      readCall('axion-scala-common/src/FirstClassEntity.scala', false),
    ])]
    expect(mineCorrections(data)).toEqual([
      {
        category: 'file-path',
        toolName: 'Read',
        failed: 'axion-formats/src/FirstClassEntity.java',
        succeeded: 'axion-scala-common/src/FirstClassEntity.scala',
        sessionId: 's1',
      },
    ])
  })

  it('does NOT mine commands (command-variant category is deferred)', () => {
    expect(mineCorrections([session('s', [
      bashCall('python3 run.py', true),
      bashCall('uv run python run.py', false),
    ])])).toEqual([])
  })

  it('does NOT pair distinct files that merely share a GENERIC stem', () => {
    // pkgA/index.ts (fail) → pkgB/index.ts (success): different files, not a fix.
    expect(mineCorrections([session('s', [
      readCall('pkgA/index.ts', true),
      readCall('pkgB/index.ts', false),
    ])])).toEqual([])
  })

  it('does NOT pair dotfiles (stem starts with a dot)', () => {
    expect(mineCorrections([session('s', [
      readCall('a/.gitignore', true),
      readCall('b/.gitignore', false),
    ])])).toEqual([])
  })

  it('does NOT pair when stems differ', () => {
    expect(mineCorrections([session('s', [readCall('Widget.ts', true), readCall('Gadget.ts', false)])])).toEqual([])
  })

  it('does not pair across different tools', () => {
    const data = [session('s', [readCall('src/Widget.ts', true), bashCall('cat src/Widget.ts', false)])]
    expect(mineCorrections(data)).toEqual([])
  })

  it('treats null isError (no result seen) as neither failure nor success', () => {
    expect(mineCorrections([session('s', [readCall('src/Widget.ts', null), readCall('lib/Widget.ts', false)])])).toEqual([])
    expect(mineCorrections([session('s', [readCall('src/Widget.ts', true), readCall('lib/Widget.ts', null)])])).toEqual([])
  })

  it('respects the look-ahead window', () => {
    const filler = Array.from({ length: 7 }, () => bashCall('echo hi', false))
    const data = [session('s', [readCall('src/Widget.ts', true), ...filler, readCall('lib/Widget.ts', false)])]
    expect(mineCorrections(data, 6)).toEqual([]) // success is 8 calls later, beyond window 6
  })

  it('ignores a fix that does not actually change the path', () => {
    expect(mineCorrections([session('s', [readCall('src/Widget.ts', true), readCall('src/Widget.ts', false)])])).toEqual([])
  })
})

describe('aggregateCorrections', () => {
  it('counts identical corrections and ranks by occurrences', () => {
    const facts = mineCorrections([
      session('s1', [readCall('a/Entity.java', true), readCall('b/Entity.scala', false)]),
      session('s2', [readCall('a/Entity.java', true), readCall('b/Entity.scala', false)]),
      session('s3', [readCall('x/Gadget.ts', true), readCall('y/Gadget.ts', false)]),
    ])
    const agg = aggregateCorrections(facts)
    expect(agg[0].occurrences).toBe(2) // Entity, seen twice, ranks first
    expect(agg[0].failed).toBe('a/Entity.java')
    expect(agg.find((a) => a.failed === 'x/Gadget.ts')?.occurrences).toBe(1)
  })
})
