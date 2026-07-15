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
  deriveBashCommandSignals,
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
    expect(out.calls[0].commandHeadIsPermissionPrefix).toBe(true)
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
    expect(bashCall.commandHeadIsPermissionPrefix).toBe(true)
    expect(bashCall.commandBypassCategories).toContain('grep')
    expect(bashCall.commandBypassAliases).toEqual({ grep: ['grep'] })
    expect(bashCall.commandDangerousPattern).toBe('rm -rf')
    expect(bashCall.commandDangerousRuleMatches).toEqual([])
    // #2036: target-aware certainty + fragment are precomputed from the full
    // command before the body is stripped. `rm -rf build` is a scoped subpath.
    expect(bashCall.commandDangerousCertainty).toBe('medium')
    expect(bashCall.commandDangerousFragment).toBe('rm -rf build')
    expect(stripped.calls[1].input.file_path).toBe('README.md')
    expect(stripped.calls[2].commandPreview?.length).toBe(200)
    expect(stripped.calls[2].commandGitSegments).toEqual([
      'git stash',
      'git checkout master',
      'git stash pop',
    ])
    expect(Object.prototype.hasOwnProperty.call(stripped.calls[3].input, 'command')).toBe(false)
  })

  it.each([
    ['rm -rf ~', ['Bash(rm -rf:*)']],
    ['rm -fr ~', ['Bash(rm -fr:*)']],
    ['rm -rfv ~', []],
    ['rm -Rfv ~', []],
    ['cd /tmp && rm -rf ~', []],
    ['rm -rf\n~', []],
  ])(
    'precomputes exact dangerous permission-prefix coverage for %j',
    (command, expected) => {
      expect(deriveBashCommandSignals(command).commandDangerousRuleMatches).toEqual(
        expected
      )
    }
  )

  it('persists exact bypass aliases through wrappers and shell chains', () => {
    const text = [
      toolUse('u1', 'Bash', { command: 'env FOO=1 rg foo src' }),
      toolUse('u2', 'Bash', { command: 'true && rg bar src' }),
      toolUse('u3', 'Bash', { command: 'find src -name "*.ts" && rg baz src' }),
      toolUse('u4', 'Bash', { command: 'printf x | rg x' }),
    ].join('\n')
    const stripped = stripToolCommandBodies(parseToolUsage(text, 'aliases.jsonl')!)

    expect(stripped.calls[0].commandBypassAliases).toEqual({ grep: ['rg'] })
    expect(stripped.calls[1].commandBypassAliases).toEqual({ grep: ['rg'] })
    expect(stripped.calls[2].commandBypassAliases).toEqual({
      grep: ['rg'],
      find: ['find'],
    })
    expect(stripped.calls[3].commandBypassCategories).toBeUndefined()
    expect(stripped.calls[3].commandBypassAliases).toBeUndefined()
    for (const parsedCall of stripped.calls) {
      expect(parsedCall.input.command).toBeUndefined()
    }
  })

  it('precomputes correct rm -rf certainty even when the target is buried past the preview (#2036)', () => {
    // Real burn-loop shape: a long `cd <worktree> && mkdir … && <padding> &&
    // rm -rf <worktree>` chain where the rm -rf sits well past the 200-char
    // preview. Certainty must come from the FULL command, not the truncated body.
    const padding = 'echo step '.repeat(40) // > 200 chars before the rm -rf
    const scoped = `cd /home/u/project/.worktrees/feature-x && mkdir -p tmp && ${padding} && rm -rf ./.worktrees/feature-x`
    const catastrophic = `cd /home/u/project && ${padding} && rm -rf ~`
    const text = [
      toolUse('u1', 'Bash', { command: scoped }),
      toolUse('u2', 'Bash', { command: catastrophic }),
    ].join('\n')
    const stripped = stripToolCommandBodies(parseToolUsage(text, 's.jsonl')!)

    // Body dropped; preview is the leading cd prefix with no rm -rf visible.
    expect(Object.prototype.hasOwnProperty.call(stripped.calls[0].input, 'command')).toBe(false)
    expect(stripped.calls[0].commandPreview).not.toContain('rm -rf')
    // …but the precomputed signal carries the truth.
    expect(stripped.calls[0].commandDangerousCertainty).toBe('medium')
    expect(stripped.calls[0].commandDangerousFragment).toBe('rm -rf ./.worktrees/feature-x')
    expect(stripped.calls[1].commandDangerousCertainty).toBe('high')
    expect(stripped.calls[1].commandDangerousFragment).toBe('rm -rf ~')
  })

  it('does not precompute a dangerous pattern for rm -rf inside a heredoc/script body (#2039)', () => {
    const text = [
      // heredoc writing a deny rule that contains the text rm -rf
      toolUse('u1', 'Bash', { command: `cat > s.json <<'EOF'\n{ "deny": ["Bash(rm -rf:*)"] }\nEOF` }),
      // node -e JS source mentioning rm -rf
      toolUse('u2', 'Bash', { command: `node -e "const c='rm -rf '+p"` }),
      // a real top-level deletion — must still be flagged
      toolUse('u3', 'Bash', { command: 'cd /repo && rm -rf ~' }),
    ].join('\n')
    const stripped = stripToolCommandBodies(parseToolUsage(text, 's.jsonl')!)
    expect(stripped.calls[0].commandDangerousPattern).toBeUndefined()
    expect(stripped.calls[1].commandDangerousPattern).toBeUndefined()
    expect(stripped.calls[2].commandDangerousPattern).toBe('rm -rf')
    expect(stripped.calls[2].commandDangerousFragment).toBe('rm -rf ~')
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
  it('separates distinct contributing calls from overlapping category matches', () => {
    const out = nativeToolBypass([
      session('s', [
        bash('find src -name "*.ts" && grep TODO src/index.ts'),
      ]),
    ])

    expect(out.distinctBypassCalls).toBe(1)
    expect(out.totalBypass).toBe(2)
    expect(
      Object.fromEntries(
        out.categories.map((category) => [category.category, category.count])
      )
    ).toMatchObject({ find: 1, grep: 1 })
  })

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
    expect(out.categories.find((c) => c.category === 'grep')?.observedCommandHeads).toEqual(['grep'])
    expect(out.categories.find((c) => c.category === 'grep')?.observedCommandAliases).toEqual(['grep'])
    expect(out.categories.find((c) => c.category === 'cat')?.observedCommandHeads).toEqual(['cat'])
    expect(out.categories.find((c) => c.category === 'cat')?.observedCommandAliases).toEqual(['cat'])
    expect(out.categories.find((c) => c.category === 'cd')?.observedCommandHeads).toBeNull()
    expect(out.categories.find((c) => c.category === 'cd')?.observedCommandAliases).toEqual([])
    expect(out.distinctBypassCalls).toBe(3)
    expect(out.totalBypass).toBe(3)
    expect(out.grepRatio).toEqual({ native: 1, bash: 1 })
  })

  it('preserves observed aliases for exact permission-policy coverage', () => {
    const out = nativeToolBypass([
      session('s', [bash('rg foo src'), bash('grep bar src'), bash('head README.md')]),
    ])

    expect(out.categories.find((c) => c.category === 'grep')?.observedCommandHeads).toEqual([
      'grep',
      'rg',
    ])
    expect(out.categories.find((c) => c.category === 'cat')?.observedCommandHeads).toEqual([
      'head',
    ])
  })

  it('keeps env-prefixed and unknown persisted categories unmappable', () => {
    const envPrefixed = nativeToolBypass([
      session('s', [bash('FOO=1 rg foo src')]),
    ])
    expect(
      envPrefixed.categories.find((c) => c.category === 'grep')
        ?.observedCommandHeads
    ).toBeNull()
    expect(
      envPrefixed.categories.find((c) => c.category === 'grep')
        ?.observedCommandAliases
    ).toEqual(['rg'])

    const malformed = call({
      toolName: 'Bash',
      input: {},
      commandHead: 'grep',
      commandPreview: 'grep foo src',
      commandBypassCategories: [
        'future-category',
      ] as unknown as ToolCall['commandBypassCategories'],
    })
    expect(() => nativeToolBypass([session('old', [malformed])])).not.toThrow()
    expect(nativeToolBypass([session('old', [malformed])]).categories).toEqual([])
  })

  it('keeps wrapper and chain aliases after raw commands are stripped', () => {
    const text = [
      toolUse('u1', 'Bash', { command: 'env FOO=1 rg foo src' }),
      toolUse('u2', 'Bash', { command: 'true && rg bar src' }),
      toolUse('u3', 'Bash', { command: 'find src -name "*.ts" && rg baz src' }),
    ].join('\n')
    const raw = parseToolUsage(text, 'aliases.jsonl')!

    for (const data of [raw, stripToolCommandBodies(raw)]) {
      const categories = nativeToolBypass([data]).categories
      expect(
        categories.find((category) => category.category === 'grep')
          ?.observedCommandAliases
      ).toEqual(['rg'])
      expect(
        categories.find((category) => category.category === 'find')
          ?.observedCommandAliases
      ).toEqual(['find'])
    }
  })

  it('does not invent aliases for old or malformed stripped rows', () => {
    const old = call({
      toolName: 'Bash',
      input: {},
      commandHead: 'true',
      commandBypassCategories: ['grep'],
    })
    const malformed = call({
      ...old,
      commandBypassAliases: {
        grep: ['future-alias', 7],
      } as unknown as ToolCall['commandBypassAliases'],
    })

    for (const persisted of [old, malformed]) {
      expect(
        nativeToolBypass([session('old', [persisted])]).categories[0]
          .observedCommandAliases
      ).toEqual([])
    }
  })

  it('keeps lossy newline previews from proving permission-prefix coverage', () => {
    const parsed = parseToolUsage(
      toolUse('u1', 'Bash', { command: 'grep\nfoo src' }),
      'newline.jsonl'
    )!
    expect(parsed.calls[0].commandHead).toBe('grep')
    expect(parsed.calls[0].commandPreview).toBe('grep foo src')
    expect(parsed.calls[0].commandHeadIsPermissionPrefix).toBeUndefined()

    const stripped = stripToolCommandBodies(parsed)
    expect(
      nativeToolBypass([stripped]).categories.find(
        (c) => c.category === 'grep'
      )?.observedCommandHeads
    ).toBeNull()
  })

  it('carries the newest valid contributing timestamp as point-in-time evidence', () => {
    const data = [
      session('s', [
        call({
          timestamp: '2026-05-01T10:00:00Z',
          toolName: 'Bash',
          input: { command: 'grep foo src' },
        }),
        call({
          timestamp: 'not-a-date',
          toolName: 'Bash',
          input: { command: 'cat README.md' },
        }),
        call({
          timestamp: '2026-02-30T00:00:00Z',
          toolName: 'Bash',
          input: { command: 'grep impossible-date src' },
        }),
        call({
          timestamp: '0',
          toolName: 'Bash',
          input: { command: 'cat locale-like-date.txt' },
        }),
        call({
          timestamp: '2026-05-03T12:30:00-04:00',
          toolName: 'Bash',
          input: { command: 'find . -name "*.ts"' },
        }),
        call({
          timestamp: '2026-06-01T00:00:00Z',
          toolName: 'Bash',
          input: { command: 'echo not-a-bypass' },
        }),
      ]),
    ]

    const out = nativeToolBypass(data)
    expect(out.latestTimestamp).toBe(
      '2026-05-03T16:30:00.000Z'
    )
    expect(out.datedBypassMatches).toBe(2)
    expect(out.undatedBypassMatches).toBe(3)
    expect(
      nativeToolBypass([session('s', [bash('grep foo src')])]).latestTimestamp
    ).toBeNull()
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
    expect(out).toEqual([
      { sessionId: 's1', count: 2, resultBearingCalls: 2, resultBytes: 500 },
    ])
  })

  it('counts a command matching multiple bypass categories exactly once', () => {
    // `find … && grep …` matches both find and grep defs, but is one command.
    const data = [
      session('s', [
        call({ toolName: 'Bash', input: { command: 'find . -name x && grep y .' }, resultBytes: 80 }),
      ]),
    ]
    const out = nativeBypassByScope(data)
    expect(out).toEqual([
      { sessionId: 's', count: 1, resultBearingCalls: 1, resultBytes: 80 },
    ])
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
        succeededTimestamp: 't',
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
