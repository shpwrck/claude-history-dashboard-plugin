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
  classifyDurableCommand,
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

  it('persists only a sparse marker for a structurally conformant leave-behind Write', () => {
    const content = `---
leave-behind: v1
state-scope: app-production
status: current
---
# App production
## Operability
### State and access
References live in the team password manager.
### Template map
source.tmpl -> /etc/app/config
### Re-run
Run the idempotent installer.
### Verify and recover
Run the health check and rollback script.
## Decision log
### Decisions
Keep generated state outside the checkout.
### How to drive it
Edit the source, install, verify, and record the decision.`
    const text = [
      toolUse('runbook', 'Write', {
        file_path: '/workspace/repo/docs/runbooks/app-production/README.md',
        content,
      }),
      toolResult('runbook'),
      toolUse('half', 'Write', {
        file_path: 'docs/runbooks/half/README.md',
        content: '# Half\n\n## Operability\n\nOnly half exists.',
      }),
      toolResult('half'),
      toolUse('edit', 'Edit', {
        file_path: 'docs/runbooks/app-production/README.md',
        old_string: 'old',
        new_string: content,
      }),
      toolResult('edit'),
    ].join('\n')

    const calls = parseToolUsage(text, 'leave-behind.jsonl')!.calls

    expect(calls[0].leaveBehindStructure).toBe('v1')
    expect(calls[0].input).toEqual({
      file_path: '/workspace/repo/docs/runbooks/app-production/README.md',
    })
    expect(calls[1].leaveBehindStructure).toBeUndefined()
    expect(calls[2].leaveBehindStructure).toBeUndefined()
  })

  // ── Edit/MultiEdit format-churn metrics (#2507) ───────────────────────────

  it('classifies a pure reindent Edit as formatting-only without retaining source text', () => {
    const oldBody = 'function f() {\nreturn 1;\n}\n'
    const newBody = 'function f() {\n  return 1;\n}\n'
    const text = [
      toolUse('e1', 'Edit', { file_path: '/repo/a.ts', old_string: oldBody, new_string: newBody }),
      toolResult('e1'),
    ].join('\n')
    const c = parseToolUsage(text, 's.jsonl')!.calls[0]
    expect(c.editFormatChurn).toEqual({
      hunks: 1,
      formattingOnlyHunks: 1,
      lines: 4,
      formattingOnlyLines: 4,
      chars: oldBody.length + newBody.length,
      formattingOnlyChars: oldBody.length + newBody.length,
    })
    // No raw-content leakage: the edited source never survives into the call.
    const serialized = JSON.stringify(c)
    expect(serialized).not.toContain('return 1;')
    expect(serialized).not.toContain('function f()')
  })

  it('aggregates MultiEdit hunks: reindent + blank-line churn count, content changes do not', () => {
    const text = [
      toolUse('m1', 'MultiEdit', {
        file_path: '/repo/b.ts',
        edits: [
          { old_string: 'a();\nb();', new_string: '  a();\n  b();' }, // reindent → formatting-only
          { old_string: 'const x = 1;', new_string: 'const x = 2;' }, // content change
          { old_string: 'one();\ntwo();', new_string: 'one();\n\n\ntwo();' }, // blank-line churn → formatting-only
        ],
      }),
      toolResult('m1'),
    ].join('\n')
    const c = parseToolUsage(text, 's.jsonl')!.calls[0]
    expect(c.editFormatChurn).toMatchObject({
      hunks: 3,
      formattingOnlyHunks: 2,
    })
    expect(c.editFormatChurn!.formattingOnlyLines).toBe(2 + 4)
    // Per-hunk char truth: only the two formatting-only hunks' bytes count, so
    // a mixed call can never attribute the semantic hunk's bytes to formatting.
    expect(c.editFormatChurn!.formattingOnlyChars).toBe(
      'a();\nb();'.length + '  a();\n  b();'.length +
      'one();\ntwo();'.length + 'one();\n\n\ntwo();'.length
    )
    expect(c.editFormatChurn!.formattingOnlyChars).toBeLessThan(c.editFormatChurn!.chars)
    expect(c.editFormatChurn!.truncated).toBeUndefined()
  })

  it('never classifies a hunk touching a potential multiline literal as formatting-only', () => {
    const text = [
      // Reindent around a template literal: the indentation may be part of the
      // runtime string, so trim-identical lines do not prove a semantic no-op.
      toolUse('lit1', 'Edit', {
        file_path: '/repo/f.ts',
        old_string: 'const s = `\nhello\n`;',
        new_string: '  const s = `\n  hello\n  `;',
      }),
      toolResult('lit1'),
      toolUse('lit2', 'Edit', {
        file_path: '/repo/g.sh',
        old_string: 'cat <<EOF\nbody\nEOF',
        new_string: '  cat <<EOF\n  body\n  EOF',
      }),
      toolResult('lit2'),
      // The common spaced heredoc form must be recognized too.
      toolUse('lit3', 'Edit', {
        file_path: '/repo/h.sh',
        old_string: 'cat << EOF\nbody\nEOF',
        new_string: '  cat << EOF\n  body\n  EOF',
      }),
      toolResult('lit3'),
      // Rust-style raw string spanning lines: indentation is the value.
      toolUse('lit4', 'Edit', {
        file_path: '/repo/i.rs',
        old_string: 'let s = r#"\nx\n"#;',
        new_string: '  let s = r#"\n  x\n  "#;',
      }),
      toolResult('lit4'),
      // Escaped line continuation (a C string/macro spanning lines).
      toolUse('lit5', 'Edit', {
        file_path: '/repo/j.c',
        old_string: 'char* s = "a\\\nb";',
        new_string: '  char* s = "a\\\n  b";',
      }),
      toolResult('lit5'),
    ].join('\n')
    const calls = parseToolUsage(text, 's.jsonl')!.calls
    for (let i = 0; i < 5; i++) {
      expect(calls[i].editFormatChurn, `call ${i}`).toMatchObject({
        hunks: 1,
        formattingOnlyHunks: 0,
      })
    }
  })

  it('skips churn derivation when the caller opts out (live-session polls)', () => {
    const text = [
      toolUse('e9', 'Edit', { file_path: '/repo/a.ts', old_string: 'a();', new_string: '  a();' }),
      toolResult('e9'),
    ].join('\n')
    const c = parseToolUsage(text, 's.jsonl', { editFormatChurn: false })!.calls[0]
    expect(c.editFormatChurn).toBeUndefined()
  })

  it('enforces the per-transcript churn budget with an explicit truncated barrier', () => {
    // 8 calls of exactly 1,000,000 analyzed chars each spend the 8 MiB
    // transcript budget down to its tail; the 9th exceeds it mid-call and every
    // later call hits the top-of-call barrier. No zero-hunk call is ever a
    // silent "no churn" claim — each carries `truncated`.
    const half = 'x'.repeat(500_000)
    const halfB = 'y'.repeat(500_000)
    const lines: string[] = []
    for (let i = 0; i < 8; i++) {
      lines.push(
        toolUse(`big${i}`, 'Edit', { file_path: '/repo/big.ts', old_string: half, new_string: halfB }),
        toolResult(`big${i}`)
      )
    }
    lines.push(
      toolUse('over', 'Edit', {
        file_path: '/repo/big.ts',
        old_string: 'z'.repeat(200_000),
        new_string: 'w'.repeat(200_000),
      }),
      toolResult('over'),
      toolUse('after', 'Edit', { file_path: '/repo/small.ts', old_string: 'a();', new_string: '  a();' }),
      toolResult('after')
    )
    const calls = parseToolUsage(lines.join('\n'), 's.jsonl')!.calls
    for (let i = 0; i < 8; i++) {
      expect(calls[i].editFormatChurn).toMatchObject({ hunks: 1 })
      expect(calls[i].editFormatChurn!.truncated).toBeUndefined()
    }
    expect(calls[8].editFormatChurn).toMatchObject({ hunks: 0, truncated: true })
    expect(calls[9].editFormatChurn).toMatchObject({ hunks: 0, truncated: true })
  })

  it('excludes semantic-space changes: internal whitespace and line splits are NOT formatting-only', () => {
    const text = [
      toolUse('e2', 'Edit', { file_path: '/repo/c.ts', old_string: 'const  x = 1;', new_string: 'const x = 1;' }),
      toolResult('e2'),
      toolUse('e3', 'Edit', { file_path: '/repo/c.ts', old_string: 'a(); b();', new_string: 'a();\nb();' }),
      toolResult('e3'),
      toolUse('e4', 'Edit', { file_path: '/repo/c.ts', old_string: 'same', new_string: 'same' }),
      toolResult('e4'),
    ].join('\n')
    const calls = parseToolUsage(text, 's.jsonl')!.calls
    expect(calls[0].editFormatChurn).toMatchObject({ hunks: 1, formattingOnlyHunks: 0 }) // internal space is semantic
    expect(calls[1].editFormatChurn).toMatchObject({ hunks: 1, formattingOnlyHunks: 0 }) // line split changes the sequence
    expect(calls[2].editFormatChurn).toMatchObject({ hunks: 1, formattingOnlyHunks: 0 }) // a no-op is not churn
  })

  it('hardens edge lines: single-line hunks and quote-adjacent edge changes are never formatting-only', () => {
    const text = [
      // Single-line hunk: old_string can start mid-line, so edge whitespace
      // is not provably indentation (e.g. a CSS descendant combinator).
      toolUse('edge1', 'Edit', { file_path: '/repo/a.ts', old_string: 'foo()', new_string: ' foo()' }),
      toolResult('edge1'),
      // First line carries a quote and changed: the slice could cut through a
      // string literal whose leading whitespace is runtime value.
      toolUse('edge2', 'Edit', {
        file_path: '/repo/b.ts',
        old_string: 'world";\nnext();',
        new_string: '  world";\n  next();',
      }),
      toolResult('edge2'),
    ].join('\n')
    const calls = parseToolUsage(text, 's.jsonl')!.calls
    expect(calls[0].editFormatChurn).toMatchObject({ hunks: 1, formattingOnlyHunks: 0 })
    expect(calls[1].editFormatChurn).toMatchObject({ hunks: 1, formattingOnlyHunks: 0 })
  })

  it('suppresses the whole metric on malformed input and excludes Write (fail-closed)', () => {
    const text = [
      toolUse('bad1', 'MultiEdit', {
        file_path: '/repo/d.ts',
        edits: [
          { old_string: 'x', new_string: '  x' },
          { old_string: 'y' }, // missing new_string → whole call suppressed
        ],
      }),
      toolResult('bad1'),
      toolUse('bad2', 'Edit', { file_path: '/repo/d.ts', old_string: 42, new_string: 'x' }),
      toolResult('bad2'),
      toolUse('bad3', 'MultiEdit', { file_path: '/repo/d.ts', edits: [] }),
      toolResult('bad3'),
      toolUse('w1', 'Write', { file_path: '/repo/d.ts', content: 'formatted\n' }),
      toolResult('w1'),
    ].join('\n')
    const calls = parseToolUsage(text, 's.jsonl')!.calls
    for (const c of calls) expect(c.editFormatChurn).toBeUndefined()
  })

  it('stops at the per-call resource boundary and marks the analysis truncated', () => {
    const big = 'x'.repeat(600_000)
    const text = [
      toolUse('t1', 'MultiEdit', {
        file_path: '/repo/e.ts',
        edits: [
          { old_string: 'a();\nb();', new_string: '  a();\n  b();' },
          { old_string: big, new_string: `${big} ` }, // pushes past the char budget
          { old_string: 'c();', new_string: '  c();' }, // never analyzed
        ],
      }),
      toolResult('t1'),
    ].join('\n')
    const c = parseToolUsage(text, 's.jsonl')!.calls[0]
    expect(c.editFormatChurn).toMatchObject({
      hunks: 1,
      formattingOnlyHunks: 1,
      truncated: true,
    })
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
        command: `${'echo setup '.repeat(30)}; git stash; git checkout master; git stash pop`,
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

  it('persists exact git undo pathspecs before stripping raw Bash commands', () => {
    expect(
      deriveBashCommandSignals('git restore /repo/src/a.ts').commandUndoFilePaths
    ).toEqual(['/repo/src/a.ts'])
    expect(
      deriveBashCommandSignals('git checkout /repo/src/a.ts').commandUndoFilePaths
    ).toEqual(['/repo/src/a.ts'])
    expect(
      deriveBashCommandSignals('git checkout HEAD -- src/a.ts src/b.ts')
        .commandUndoFilePaths
    ).toEqual(['src/a.ts', 'src/b.ts'])
    expect(
      deriveBashCommandSignals('git restore --staged --worktree -- src/a.ts')
        .commandUndoFilePaths
    ).toEqual(['src/a.ts'])
    expect(
      deriveBashCommandSignals('git restore -S -W -- src/a.ts')
        .commandUndoFilePaths
    ).toEqual(['src/a.ts'])
    for (const command of [
      'git checkout main',
      'git revert deadbeef',
      'git reset --hard',
      'git reset HEAD -- src/a.ts',
      'git restore --staged -- src/a.ts',
      'git restore -S -- src/a.ts',
      'git restore "$TARGET"',
      'printf %s "git restore /repo/src/a.ts"',
      'true || git restore /repo/src/a.ts',
    ]) {
      expect(
        deriveBashCommandSignals(command).commandUndoFilePaths,
        command
      ).toBeUndefined()
    }

    const text = [
      toolUse('undo', 'Bash', { command: 'git restore -- src/a.ts' }),
      toolResult('undo', { content: 'restored' }),
    ].join('\n')
    const stripped = stripToolCommandBodies(parseToolUsage(text, 'undo.jsonl')!)
    expect(stripped.calls[0].input.command).toBeUndefined()
    expect(stripped.calls[0].commandUndoFilePaths).toEqual(['src/a.ts'])
  })

  it('persists workflow git evidence only from parser-proven command words', () => {
    for (const command of [
      'printf %s "git stash"',
      'printf %s "git checkout main"',
      'printf %s "git stash pop"',
      'printf %s git stash',
      'printf %s git checkout main',
      'printf %s git stash pop',
      'git commit -m git stash',
      'ssh host git stash',
      'git stash --help',
      'git stash list',
      'git stash create',
      'git checkout --help',
      'git switch --help',
      'git checkout HEAD -- src/foo.ts',
      'git checkout HEAD src/foo.ts',
      'git checkout main src/foo.ts',
      'git checkout ./src/foo.ts',
      'git checkout ../src/foo.ts',
      'git checkout /tmp/foo.ts',
      'git checkout :/src/foo.ts',
      "git checkout ':(top)src/foo.ts'",
      'git checkout .gitignore',
      'git checkout docs/.hidden',
      'git checkout foo.lock',
      'git checkout docs/foo.lock',
      'git checkout foo..bar',
      'git checkout feature.',
      'git checkout feature//foo',
      'git checkout feature:foo',
      'git checkout @',
      "git checkout 'feature@{upstream}'",
      "git checkout 'src/*.ts'",
      "git checkout 'src/?.ts'",
      "git checkout 'src/[ab].ts'",
      "git checkout 'src/foo bar.ts'",
      "git checkout 'src\\foo.ts'",
      'git checkout src/',
      'git checkout -q -- src/foo.ts',
      'git checkout -q .',
      'echo "${x:-$(git stash)}"',
      'echo "$((0 && $(git stash)))"',
      'true || git stash',
      'exit 0; git stash',
      'exec true; git stash',
      'git stash && git checkout main && git stash pop',
      'git reflog expire --expire=now --all',
      'git reflog delete HEAD@{0}',
      'git reflog exists refs/heads/main',
      'git reflog --date=iso',
      'git cherry-pick --abort',
      'git cherry-pick --continue',
      'git cherry-pick --quit',
      'git cherry-pick --skip',
      'git merge --ff-only',
      'git merge --ff-only --abort',
    ]) {
      expect(
        deriveBashCommandSignals(command).commandGitSegments,
        command
      ).toBeUndefined()
    }

    expect(deriveBashCommandSignals('git stash').commandGitSegments).toEqual([
      'git stash',
    ])
    expect(
      deriveBashCommandSignals(
        'env SCOPE=review /usr/bin/git checkout main'
      ).commandGitSegments
    ).toEqual(['git checkout main'])
    expect(
      deriveBashCommandSignals('echo "$(git stash)"').commandGitSegments
    ).toEqual(['git stash'])
    expect(
      deriveBashCommandSignals(
        'printf %s "git stash"; git checkout main'
      ).commandGitSegments
    ).toEqual(['git checkout main'])
    expect(
      deriveBashCommandSignals(
        'env NOTE="git stash" git checkout main'
      ).commandGitSegments
    ).toEqual(['git checkout main'])
    expect(
      deriveBashCommandSignals('git checkout -q main').commandGitSegments
    ).toEqual(['git checkout main'])
    expect(
      deriveBashCommandSignals('git checkout feature/foo').commandGitSegments
    ).toEqual(['git checkout feature/foo'])
    for (const target of ['HEAD~1', 'HEAD^', '@{-1}', '-']) {
      expect(
        deriveBashCommandSignals(`git checkout ${target}`).commandGitSegments,
        target
      ).toBeDefined()
    }
    expect(
      deriveBashCommandSignals(
        'git stash; git checkout main; git stash pop'
      ).commandGitSegments
    ).toEqual(['git stash', 'git checkout main', 'git stash pop'])
    expect(
      deriveBashCommandSignals('git reflog show').commandGitSegments
    ).toEqual(['git reflog show'])
    expect(
      deriveBashCommandSignals('git cherry-pick deadbeef').commandGitSegments
    ).toEqual(['git cherry-pick deadbeef'])
    expect(
      deriveBashCommandSignals(
        'git merge --ff-only origin/main'
      ).commandGitSegments
    ).toEqual(['git merge --ff-only origin/main'])
  })

  it('bounds adversarially large shell analysis and persists an analyzed-negative barrier', () => {
    const command = `rm -rf /; grep secret file; ${"'>'".repeat(500_000)}`
    const started = performance.now()
    const signals = deriveBashCommandSignals(command)
    const elapsedMs = performance.now() - started

    expect(elapsedMs).toBeLessThan(2_000)
    expect(signals).toMatchObject({
      commandAnalysisComplete: true,
      commandAnalysisTruncated: true,
    })
    expect(signals.commandDangerousPattern).toBeUndefined()
    expect(signals.commandBypassCategories).toBeUndefined()
    const parsedCall = call({ input: { command }, ...signals })
    const parsed = session('large', [parsedCall])
    const stripped = stripToolCommandBodies(parsed)
    expect(nativeToolBypass([parsed])).toEqual(nativeToolBypass([stripped]))
    expect(nativeToolBypass([parsed]).categories).toEqual([])
    expect(topBashCommands([parsed])[0].command.length).toBeLessThanOrEqual(200)
    expect(repeatedCommands([parsed], 1)[0].command.length).toBeLessThanOrEqual(
      200
    )
    expect(bashSubcommandStats([parsed])).toEqual([])

    const dense = 'a;'.repeat(30_000)
    const denseStarted = performance.now()
    expect(deriveBashCommandSignals(dense).commandAnalysisTruncated).toBe(true)
    expect(performance.now() - denseStarted).toBeLessThan(250)

    const compoundBomb = '{ '.repeat(12_000) + ']] '.repeat(12_000)
    const compoundStarted = performance.now()
    expect(
      deriveBashCommandSignals(compoundBomb).commandAnalysisTruncated
    ).toBe(true)
    expect(performance.now() - compoundStarted).toBeLessThan(250)
  })

  it('bounds aggregate shell analysis across one transcript and keeps the barrier sticky', () => {
    const nearLimit = 'x'.repeat(60 * 1024)
    const overflow = `rm -rf /; grep secret file; ${'x'.repeat(30 * 1024)}`
    const text = [
      ...Array.from({ length: 2 }, (_, index) =>
        toolUse(`large-${index}`, 'Bash', { command: nearLimit })
      ),
      toolUse('overflow', 'Bash', { command: overflow }),
      toolUse('after-overflow', 'Bash', { command: 'kubectl apply -f x' }),
    ].join('\n')
    const started = performance.now()
    const parsed = parseToolUsage(text, 'aggregate-budget.jsonl')!

    expect(performance.now() - started).toBeLessThan(5_000)
    expect(parsed.calls.slice(0, 2).every((entry) =>
      entry.commandAnalysisTruncated == null
    )).toBe(true)
    for (const entry of parsed.calls.slice(2)) {
      expect(entry.commandAnalysisComplete).toBe(true)
      expect(entry.commandAnalysisTruncated).toBe(true)
      expect(entry.commandDangerousPattern).toBeUndefined()
      expect(entry.commandRiskyActionPattern).toBeUndefined()
    }

    const manyCalls = parseToolUsage(
      Array.from({ length: 1025 }, (_, index) =>
        toolUse(`small-${index}`, 'Bash', { command: 'true' })
      ).join('\n'),
      'call-budget.jsonl'
    )!
    expect(manyCalls.calls[1023].commandAnalysisTruncated).toBeUndefined()
    expect(manyCalls.calls[1024].commandAnalysisTruncated).toBe(true)

    const smallList = 'a;'.repeat(64)
    const manyListsStarted = performance.now()
    const manyLists = parseToolUsage(
      Array.from({ length: 130 }, (_, index) =>
        toolUse(`list-${index}`, 'Bash', { command: smallList })
      ).join('\n'),
      'syntax-budget.jsonl'
    )!
    expect(performance.now() - manyListsStarted).toBeLessThan(3_000)
    expect(manyLists.calls[127].commandAnalysisTruncated).toBeUndefined()
    expect(manyLists.calls[128].commandAnalysisTruncated).toBe(true)
    expect(manyLists.calls[129].commandAnalysisTruncated).toBe(true)
  })

  it('bounds the exported durable-command fallback', () => {
    const started = performance.now()
    expect(classifyDurableCommand("'>'".repeat(100_000))).toBeNull()
    expect(performance.now() - started).toBeLessThan(250)
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

  it('keeps durable-state truth when the mutation is past the stripped preview', () => {
    const padding = `CHD_STATIC_PADDING=${'x'.repeat(240)}`
    const command = `${padding} kubectl apply -f deploy.yaml`
    const stripped = stripToolCommandBodies(
      parseToolUsage(
        [toolUse('u1', 'Bash', { command }), toolResult('u1', { content: 'ok' })].join('\n'),
        'durable.jsonl'
      )!
    )
    const call = stripped.calls[0]

    expect(call.input.command).toBeUndefined()
    expect(call.commandPreview).toHaveLength(200)
    expect(call.commandPreview).not.toContain('kubectl apply')
    expect(call.commandDurableKind).toBe('remote-state')
  })

  it('keeps only parser-proved Bash leave-behind mutations after stripping', () => {
    const path = 'docs/runbooks/app-production/README.md'
    const commands = [
      `rm ${path}`,
      `cat <<'EOF' > notes.txt\nrm ${path}\nEOF`,
      `false && rm ${path}`,
      `rm --help ${path}`,
      `git rm --dry-run ${path}`,
      `rm ${path} <<EOF\n\${ exit 0; }\nEOF`,
      `rm "$(printf -- --help)" ${path}`,
      `rm $MAYBE_OPTION ${path}`,
      `rm * ${path}`,
      `rm {--help,unused} ${path}`,
      `rm $"${path}"`,
      `LANG=fr_FR.UTF-8 rm $"${path}"`,
      `env LANG=fr_FR.UTF-8 rm $"${path}"`,
    ]
    const parsed = parseToolUsage(
      commands
        .flatMap((command, index) => [
          toolUse(`u${index}`, 'Bash', { command }),
          toolResult(`u${index}`, { content: 'ok' }),
        ])
        .join('\n'),
      'leave-behind.jsonl'
    )!
    const stripped = stripToolCommandBodies(parsed)

    expect(stripped.calls[0].leaveBehindMutationPath).toBe(path)
    expect(stripped.calls[0].input.command).toBeUndefined()
    for (const call of stripped.calls.slice(1)) {
      expect(call.leaveBehindMutationPath).toBeUndefined()
    }
  })

  it('persists only byte-producing static append invalidations', () => {
    const path = 'docs/runbooks/app-production/README.md'
    const commands = [
      `printf replacement >> ${path}`,
      `echo replacement >> ${path}`,
      `true >> ${path}`,
      `printf '%s' >> ${path}`,
    ]
    const stripped = stripToolCommandBodies(
      parseToolUsage(
        commands
          .map((command, index) =>
            toolUse(`append-${index}`, 'Bash', { command })
          )
          .join('\n'),
        'leave-behind-append.jsonl'
      )!
    )

    expect(stripped.calls.map((call) => call.leaveBehindMutationPath)).toEqual([
      path,
      path,
      undefined,
      undefined,
    ])
    expect(stripped.calls.every((call) => call.input.command == null)).toBe(true)
  })

  it('persists target-directory moves and trailing command terminators', () => {
    const path = 'docs/runbooks/app-production/README.md'
    const commands = [
      `mv -t /tmp ${path}`,
      `mv --target-directory=/tmp ${path}`,
      `rm ${path};`,
      `rm ${path}\n`,
      `rm ${path} &`,
      `rm ${path};;`,
      `rm ${path}; ;`,
      `rm ${path}\n;`,
    ]
    const stripped = stripToolCommandBodies(
      parseToolUsage(
        commands
          .map((command, index) =>
            toolUse(`terminator-${index}`, 'Bash', { command })
          )
          .join('\n'),
        'leave-behind-terminators.jsonl'
      )!
    )

    expect(stripped.calls.map((call) => call.leaveBehindMutationPath)).toEqual([
      path,
      path,
      path,
      path,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('ignores expansions only in quoted heredoc bodies for leave-behind proof', () => {
    const path = 'docs/runbooks/app-production/README.md'
    const quoted = deriveBashCommandSignals(
      `printf replacement > ${path} <<'EOF'\n$HOME [literal] {text} *\nEOF`
    )
    const unquoted = deriveBashCommandSignals(
      `printf replacement > ${path} <<EOF\n\${ exit 0; }\nEOF`
    )
    const ordinaryExpansion = deriveBashCommandSignals(
      `printf replacement > ${path} <<EOF\n$HOME $(printf body)\nEOF`
    )

    expect(quoted.leaveBehindMutationPath).toBe(path)
    expect(unquoted.leaveBehindMutationPath).toBeUndefined()
    expect(ordinaryExpansion.leaveBehindMutationPath).toBe(path)
  })

  it('classifies only executable durable commands, not quoted prose, comments, or heredoc bodies', () => {
    const nonMutations = [
      `echo '# kubectl apply -f deploy.yaml'`,
      `printf '%s' 'terraform apply'`,
      `echo ready # terraform apply; kubectl apply -f ignored.yaml`,
      String.raw`echo ready # $'ignored\nkubectl apply -f x'`,
      `cat > notes.md <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      String.raw`cat <<'EOF'
$'text\nEOF
kubectl apply -f fake'
EOF`,
      String.raw`cat $'prose\' $(ssh prod bash)' <<'EOF'
kubectl apply -f x
EOF`,
      String.raw`cat <<'EOF' $'prose\' | bash'
kubectl apply -f x
EOF`,
      `cat > notes.md <<'EOF'\ntext\nEOF-not-a-delimiter\nkubectl apply -f fake.yaml\nEOF`,
      `cat > notes.md <<'EOF'\nEOF;still-body\nkubectl apply -f fake.yaml\nEOF`,
      `cat > notes.md <<'EOF'\n  EOF\nkubectl apply -f fake.yaml\nEOF`,
      `cat > notes.md <<'END-OF-FILE'\nkubectl apply -f fake.yaml\nEND-OF-FILE`,
      `cat > notes.md <<'123END'\nkubectl apply -f fake.yaml\n123END`,
      `cat > notes.md <<'END.DOC'\nkubectl apply -f fake.yaml\nEND.DOC`,
      `cat > notes.md <<'END-MARKER'\nkubectl apply -f deploy.yaml\nEND-MARKER`,
      `cat > notes.md <<E'OF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<$'\\c?'\nbody\n\x1f\nkubectl apply -f prod.yaml`,
      String.raw`cat <<$'\0X'
body
X
kubectl apply -f prod.yaml`,
      String.raw`cat <<$'\x00X'
body
X
kubectl apply -f prod.yaml`,
      String.raw`cat <<$'\u0000X'
body
X
kubectl apply -f prod.yaml`,
      `cat > notes.md <<'123EOF'\nterraform apply\n123EOF`,
      `cat > notes.md <<'EOF.DONE'\nhelm upgrade app chart\nEOF.DONE`,
      `cat > notes.md <<'EOF'\n$(kubectl apply -f deploy.yaml)\nEOF`,
      String.raw`cat <<EOF
\$(kubectl apply -f ignored.yaml)
EOF`,
      'cat > notes.md <<\'EOF\'\n`terraform apply`\nEOF',
      `cat foo\\ #bar <<'EOF'\nrm -rf /\nkubectl apply -f deploy.yaml\nEOF`,
      `cat foo\\\n#bar <<'EOF'\nrm -rf /\nkubectl apply -f deploy.yaml\nEOF`,
      "x=`cat <<'EOF'\nkubectl apply -f deploy.yaml\nEOF\n`",
      `curl https://example.invalid/installer; bash local-script.sh`,
      `curl https://example.invalid/installer | bash -c 'echo inspected'`,
      `kubectl apply -f deploy.yaml --dry-run=client`,
      `helm upgrade app chart --dry-run`,
      `ansible-playbook site.yml --check`,
      `ansible-playbook site.yml --syntax-check`,
      `ansible-playbook site.yml --list-hosts`,
      `ansible-playbook site.yml --list-tasks`,
      `ansible-playbook --version`,
      `kubectl rollout status deploy/app`,
      `kubectl set image deploy/app app=image:v2 --local`,
      `kubectl label pods foo --list`,
      `kubectl annotate pods foo --list`,
      `kubectl set env deployment/app --list`,
      `docker compose up --dry-run`,
      `crontab -l`,
      `crontab -T cron.txt`,
      `apt-get install --download-only nginx`,
      `apt help install`,
      `apt-get help install`,
      `brew help install`,
      `apt show install`,
      `apt list install`,
      `apt download install`,
      `apt-get download install`,
      `apt-get source install`,
      `curl https://example.invalid/installer | bash -n`,
      `vercel env ls`,
      `scp prod:/var/log/app.log ./app.log`,
      `rsync prod:/etc/app.conf ./app.conf`,
      `rsync --dry-run ./app.conf prod:/etc/app.conf`,
      `rsync -avn ./app.conf prod:/etc/app.conf`,
      `rsync -n ./app.conf prod:/etc/app.conf`,
      `rsync -avzn ./app.conf prod:/etc/app.conf`,
      `terraform apply -help`,
      `cp config.template config.yaml --help`,
      `cat config.template | tee --help /etc/app/config.yaml`,
      `cat config.template | tee /etc/app/config.yaml --version`,
      `cat config.template | sudo tee --help /etc/app/config.yaml`,
      `node -e 'console.log(1)' '>settings.json'`,
      `envsubst '$HOME' '>config.yaml'`,
      `node -e 'console.log(1)' '>/etc/app/settings.json'`,
      `envsubst '$HOME' '>/etc/app/config.yaml'`,
      `node -e 'console.log(1)' '>' /etc/app/settings.json`,
      `envsubst '>' /etc/app/config.yaml`,
      `node -e 'console.log(1)' \\> /etc/app/settings.json`,
      `envsubst \\> /etc/app/config.yaml`,
      `python -c 'import sys; print(sys.argv)' '2>' /etc/app/config.yaml`,
      `envsubst > '$HOME/.config/app/config.yaml'`,
      `echo ready # $(kubectl apply -f ignored.yaml)`,
      `ssh prod 'sudo systemctl status app'`,
      `ssh prod 'kubectl get pods'`,
      `ssh prod 'helm list'`,
      `ssh prod 'terraform plan'`,
      `ssh prod 'echo sudo'`,
      `ssh prod 'echo ">"'`,
      `ssh prod 'printf "%s\\n" ">"'`,
      `ssh prod 'grep ">" config.txt'`,
      `ssh prod 'echo ready >/dev/null'`,
      `ssh prod 'journalctl -u app | tee /dev/null'`,
      `ssh prod 'journalctl -u app | tee /dev/stdin'`,
      `ssh prod 'journalctl -u app | tee /dev/stdout'`,
      `ssh prod 'journalctl -u app | tee /dev/stderr'`,
      `ssh prod 'journalctl -u app | tee /dev/fd/9'`,
      `ssh prod 'journalctl -u app | tee /proc/self/fd/1'`,
      `ssh prod 'journalctl -u app | tee'`,
      `ssh prod 'echo ok 2>&1'`,
      `ssh prod 'echo \\> /etc/app/config.yaml'`,
      `ssh prod 'touch --version'`,
      `sudo -l kubectl apply -f deploy.yaml`,
      `sudo -ll kubectl apply -f deploy.yaml`,
      `sudo -ln kubectl apply -f deploy.yaml`,
      `sudo -nv kubectl apply -f deploy.yaml`,
      `sudo -lU root kubectl apply -f deploy.yaml`,
      `sudo -U root kubectl apply -f deploy.yaml`,
      `sudo -Uroot kubectl apply -f deploy.yaml`,
      `sudo --other-user root kubectl apply -f deploy.yaml`,
      `sudo --other-user=root kubectl apply -f deploy.yaml`,
      `sudo -vU root kubectl apply -f deploy.yaml`,
      `sudo -e kubectl apply -f deploy.yaml`,
      `sudo --edit kubectl apply -f deploy.yaml`,
      `sudo -b kubectl apply -f deploy.yaml`,
      `sudo -nb kubectl apply -f deploy.yaml`,
      `sudo --background kubectl apply -f deploy.yaml`,
      `command -v ansible-playbook`,
      `command -V kubectl`,
      `command --help kubectl apply -f deploy.yaml`,
      `env --help kubectl apply -f deploy.yaml`,
      `env --version kubectl apply -f deploy.yaml`,
      `cp config.template config.yaml`,
      `cp config.template /workspace/repo/generated.yaml`,
      `envsubst < config.template > /home/me/project/config.yaml`,
      `helm template app chart > /tmp/rendered.yaml`,
      `bash -n -c 'kubectl apply -f deploy.yaml'`,
      `bash -nc 'kubectl apply -f deploy.yaml'`,
      `bash --help -c 'kubectl apply -f deploy.yaml'`,
      `bash --version -c 'kubectl apply -f deploy.yaml'`,
      `bash --rpm-requires -c 'kubectl apply -f deploy.yaml'`,
      `bash -D -c 'kubectl apply -f deploy.yaml'`,
      `bash -lD -c 'kubectl apply -f deploy.yaml'`,
      `bash --dump-strings -c 'kubectl apply -f deploy.yaml'`,
      `bash --dump-po-strings -c 'kubectl apply -f deploy.yaml'`,
      `bash script.sh -c 'kubectl apply -f deploy.yaml'`,
      `bash -- -c 'kubectl apply -f deploy.yaml'`,
      `bash -c $"kubectl apply -f deploy.yaml"`,
      `kubectl apply $"--dry-run=client" -f deploy.yaml`,
      `kubectl apply $"--help" -f deploy.yaml`,
      `helm upgrade app chart $"--dry-run"`,
      `sh -n -c 'terraform apply'`,
      `ssh prod $"kubectl apply -f deploy.yaml"`,
      `ssh prod 'bash -n -c "kubectl apply -f deploy.yaml"'`,
      `bash -n <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `bash script.sh <<EOF\nkubectl apply -f deploy.yaml\nEOF`,
      `echo '$(kubectl apply -f quoted-literal.yaml)'`,
      `echo "foo\\"; kubectl apply -f quoted-literal.yaml"`,
      `ssh -N prod 'touch /etc/app/x'`,
      `ssh -vN prod 'touch /etc/app/x'`,
      `ssh -W target:22 prod 'touch /etc/app/x'`,
      `ssh -Wtarget:22 prod 'touch /etc/app/x'`,
      `ssh -s prod 'touch /etc/app/x'`,
      `ssh -n prod <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh -f prod <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh -f prod 'touch /etc/app/x'`,
      `ssh -fn prod 'touch /etc/app/x'`,
      `ssh -o ForkAfterAuthentication=yes prod 'touch /etc/app/x'`,
      `ssh -oForkAfterAuthentication=yes prod 'touch /etc/app/x'`,
      `ssh -o 'ForkAfterAuthentication yes' prod 'touch /etc/app/x'`,
      `ssh -o SessionType=none prod 'touch /etc/app/x'`,
      `ssh -oSessionType=none prod 'touch /etc/app/x'`,
      `ssh -o 'SessionType none' prod 'touch /etc/app/x'`,
      `ssh -o StdinNull=yes prod <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh -oStdinNull=yes prod <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh -o 'StdinNull yes' prod <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh -F /tmp/ssh_config prod 'kubectl apply -f deploy.yaml'`,
      `ssh -o Include=/tmp/ssh_config prod 'kubectl apply -f deploy.yaml'`,
      `bash -o noexec -c 'kubectl apply -f deploy.yaml'`,
      `sh -onoexec -c 'kubectl apply -f deploy.yaml'`,
      `bash +o noexec -o noexec -c 'kubectl apply -f deploy.yaml'`,
      `printf 'password\\n' | sudo -S tee -a /etc/app.conf`,
      `printf 'password\\n' | sudo --stdin tee -a /etc/app.conf`,
      `printf 'password\\n' | sudo -nS tee -a /etc/app.conf`,
      `sudo -e /etc/app/config.yaml`,
      `sudoedit /etc/app/config.yaml`,
      `kubectl edit deployment/app`,
      `systemctl edit app`,
      `crontab -e`,
      `false && kubectl apply -f prod.yaml`,
      `false && echo $(kubectl apply -f prod.yaml)`,
      `true || echo $(kubectl apply -f prod.yaml)`,
      `if false; then echo $(kubectl apply -f prod.yaml); fi`,
      `case x in y) echo $(kubectl apply -f prod.yaml);; esac`,
      `x=set; echo \${x:-$(kubectl apply -f prod.yaml)}`,
      `ssh prod 'systemctl --message restart status app'`,
      `ssh prod 'systemctl -qhH nested restart app'`,
    ]

    for (const command of nonMutations) {
      expect(classifyDurableCommand(command), command).toBeNull()
      const stripped = stripToolCommandBodies(
        parseToolUsage(toolUse('durable-negative', 'Bash', { command }), 'negative.jsonl')!
      )
      expect(stripped.calls[0].commandDurableKind).toBeUndefined()
    }

    const remoteMutations = [
      `ssh deploy@app 'sudo tee /etc/app/config.yaml >/dev/null'`,
      `ssh deploy@app 'printf "%s" value > /etc/app/config.yaml'`,
      `printf x >> /etc/app.conf`,
      `printf x >/dev/null >> /etc/app.conf`,
      `echo x >> /etc/app.conf`,
      `printf x | tee -a /etc/app.conf`,
      `tee /etc/app.conf </dev/null`,
      `true 2> /etc/app.log`,
      `true 3> /etc/app.log`,
      `echo x &> /etc/app.log`,
      `echo x >& /etc/app.log`,
      `echo x &>> /etc/app.log`,
      `ssh prod 'printf x >> /etc/app.conf'`,
      `ssh prod 'printf x | tee -a /etc/app.conf'`,
      `ssh prod 'tee /etc/app.conf </dev/null'`,
      `sudo -u deploy kubectl apply -f deploy.yaml`,
      `ssh -oStdinNull=yes prod 'touch /etc/app/x'`,
      `bash +o noexec -c 'kubectl apply -f deploy.yaml'`,
      `bash -o noexec +o noexec -c 'kubectl apply -f deploy.yaml'`,
      `/usr/bin/kubectl apply -f deploy.yaml`,
      `/usr/local/bin/kubectl apply -f deploy.yaml`,
      `(kubectl apply -f deploy.yaml)`,
      `kubectl --context prod apply -f deploy.yaml`,
      `kubectl --as-uid 1000 apply -f deploy.yaml`,
      `kubectl --password secret apply -f deploy.yaml`,
      `kubectl --profile cpu apply -f deploy.yaml`,
      `kubectl --profile-output /tmp/profile apply -f deploy.yaml`,
      `kubectl --kuberc /tmp/kuberc apply -f deploy.yaml`,
      `kubectl --tls-server-name prod apply -f deploy.yaml`,
      `kubectl --username alice apply -f deploy.yaml`,
      `kubectl -v 4 apply -f deploy.yaml`,
      `kubectl --vmodule request=4 apply -f deploy.yaml`,
      `helm --namespace prod upgrade app chart`,
      `helm --burst-limit 10 upgrade app chart`,
      `helm --color auto upgrade app chart`,
      `helm --content-cache /tmp/cache upgrade app chart`,
      `helm --kube-as-group operators upgrade app chart`,
      `helm --kube-as-user alice upgrade app chart`,
      `helm --kube-ca-file ca.pem upgrade app chart`,
      `helm --kube-tls-server-name prod upgrade app chart`,
      `helm --qps 10 upgrade app chart`,
      `terraform -chdir=infra apply -auto-approve`,
      `tofu -chdir=infra apply -auto-approve`,
      `terraform taint aws_instance.app`,
      `pulumi import aws:s3/bucket:Bucket app bucket-id`,
      `cdk deploy AppStack`,
      `aws cloudformation deploy --stack-name app`,
      `aws ecs update-service --cluster prod --service app --force-new-deployment`,
      `aws ssm put-parameter --name /app/url --value value --type String`,
      `CHD_STATIC_PADDING=value kubectl apply -f deploy.yaml`,
      `KUBECONFIG=/tmp/prod kubectl apply -f deploy.yaml`,
      `AWS_PROFILE=prod aws cloudformation deploy --stack-name app`,
      `TF_VAR_region=us-east-1 terraform apply -auto-approve`,
      `ansible-playbook site.yml`,
      `scp ./app.conf prod:/etc/app.conf`,
      `rsync ./app.conf prod:/etc/app.conf`,
      `scp ./app.conf prod:`,
      `scp ./app.conf deploy@prod:`,
      `rsync ./app.conf prod:`,
      `ssh -P prod-tag prod 'kubectl apply -f deploy.yaml'`,
      `ssh -2 prod 'kubectl apply -f deploy.yaml'`,
      `ssh 'ssh://user@host:22' 'kubectl apply -f deploy.yaml'`,
      `ssh 'ssh://user@[2001:db8::1]:22' 'kubectl apply -f deploy.yaml'`,
      `ssh 'ssh://[1:2:3:4:5:6:7:8]:22' 'kubectl apply -f deploy.yaml'`,
      `ssh 'user@@host' 'kubectl apply -f deploy.yaml'`,
      `scp ./app.conf 'scp://user@host:22/etc/app.conf'`,
      `scp ./app.conf 'scp://user@[2001:db8::1]:22/etc/app.conf'`,
      `rsync ./app.conf 'rsync://user@host:873/app/app.conf'`,
      `ssh -vp 2222 prod 'kubectl apply -f deploy.yaml'`,
      `ssh -vo StrictHostKeyChecking=no prod 'kubectl apply -f deploy.yaml'`,
      `ssh -vP prod-tag prod 'kubectl apply -f deploy.yaml'`,
      `ssh -vp2222 prod 'kubectl apply -f deploy.yaml'`,
      `ssh -n prod 'kubectl apply -f deploy.yaml'`,
      `ssh -oGlobalKnownHostsFile=/tmp/known prod 'touch /etc/app/x'`,
      `sudo -iu deploy kubectl apply -f deploy.yaml`,
      `sudo -Eiu deploy kubectl apply -f deploy.yaml`,
      `sudo -k kubectl apply -f deploy.yaml`,
      `kubectl create configmap help --from-literal=key=value`,
      `bash -O extglob -c 'kubectl apply -f deploy.yaml'`,
      `bash -o nounset -c 'kubectl apply -f deploy.yaml'`,
      `bash -euo pipefail -c 'kubectl apply -f deploy.yaml'`,
      `bash -euoc pipefail 'kubectl apply -f deploy.yaml'`,
      `bash -xO extglob -c 'kubectl apply -f deploy.yaml'`,
      `bash -xo errexit -c 'kubectl apply -f deploy.yaml'`,
      `bash -xOc extglob 'kubectl apply -f deploy.yaml'`,
      `bash -xOoc extglob errexit 'kubectl apply -f deploy.yaml'`,
      `bash -xOooc extglob nounset errexit 'kubectl apply -f deploy.yaml'`,
      `bash -c $'kubectl apply -f deploy.yaml'`,
      `ssh prod "bash -xO extglob -c 'kubectl apply -f deploy.yaml'"`,
      `ssh prod "bash -xo errexit -c 'kubectl apply -f deploy.yaml'"`,
      `ssh prod "bash -xOc extglob 'kubectl apply -f deploy.yaml'"`,
      `ssh prod "bash -xOoc extglob errexit 'kubectl apply -f deploy.yaml'"`,
      `ssh prod $'kubectl apply -f deploy.yaml'`,
      `fly deploy`,
      `vercel env add API_URL production`,
      `docker compose -f docker-compose.yml up -d`,
      `podman compose -f docker-compose.yml -f docker-compose.local.yml up --build -d`,
      `bash -lc 'kubectl apply -f deploy.yaml'`,
      `sh -c 'terraform apply -auto-approve'`,
      `ssh prod 'bash -lc "kubectl apply -f deploy.yaml"'`,
      `ssh prod 'bash -lc "systemctl restart app"'`,
      `ssh prod 'sh -c "touch /etc/app/enabled"'`,
      `ssh -oHostKeyAlias=prod prod 'touch /etc/app/enabled'`,
      `ssh prod 'bash -s' <<'EOF'\nsystemctl restart app\nEOF`,
      `ssh prod bash -s <<'EOF'\nsystemctl restart app\nEOF`,
      `cat <<'EOF' | ssh prod bash -s\nsystemctl restart app\nEOF`,
      `rsync -h ./config prod:/etc/config`,
      `rsync -- -n prod:/etc/config`,
      `ssh prod 'touch help'`,
      `ssh prod 'touch -- --version'`,
      `ssh prod 'touch -- --dry-run'`,
      `ssh prod 'systemctl --user restart app'`,
      `ssh prod 'systemctl -qH nested restart app'`,
      `ssh prod 'systemctl mask app'`,
      `ssh prod 'systemctl unmask app'`,
      `ssh prod 'systemctl preset app'`,
      `ssh prod 'systemctl reenable app'`,
      `bash <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `bash << 'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `bash <<- 'EOF'\n\tkubectl apply -f deploy.yaml\nEOF`,
      `bash >/tmp/install.log <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash\nkubectl apply -f deploy.yaml\nEOF`,
      `bash -c 'kubectl apply -f deploy.yaml' ignored -n`,
    ]
    for (const command of remoteMutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
    expect(classifyDurableCommand('/opt/homebrew/bin/brew install jq')).toBe(
      'multi-step-install'
    )
    expect(
      deriveBashCommandSignals(`(echo hi; kubectl apply -f x)`)
        .commandRiskyActionPattern
    ).toBeUndefined()

    const aggregateStatusDoesNotProveMutation = [
      `if true; then kubectl apply -f deploy.yaml; fi`,
      `false && kubectl apply -f deploy.yaml`,
      `true || kubectl apply -f deploy.yaml`,
      `exit 0; kubectl apply -f deploy.yaml`,
      `kubectl apply -f missing.yaml | cat >/dev/null`,
      `echo started & kubectl apply -f deploy.yaml`,
      `(echo hi; kubectl apply -f deploy.yaml)`,
      `mask=$((1 << 4))\nkubectl apply -f deploy.yaml`,
      `cat <<EOF\n$(kubectl apply -f deploy.yaml)\nEOF`,
      `result=$(kubectl apply -f deploy.yaml)`,
      `echo "$(kubectl apply -f deploy.yaml)"`,
      'echo `kubectl apply -f deploy.yaml`',
      `cat <(kubectl apply -f deploy.yaml) >/dev/null`,
      `printf x > >(kubectl apply -f deploy.yaml)`,
      `! printf manifest | kubectl apply -f -`,
      `time ! printf manifest | kubectl apply -f -`,
      `! cat config.template | tee /etc/app/config.yaml`,
      `! curl -fsSL https://example.invalid/install | bash`,
      `curl -fsSL https://unreachable.invalid/install | bash`,
      `curl -fsSL https://unreachable.invalid/install | tee /dev/stderr | bash`,
      `wget -qO- https://unreachable.invalid/install | sh`,
    ]
    for (const command of aggregateStatusDoesNotProveMutation) {
      expect(classifyDurableCommand(command), command).toBeNull()
    }

    const dynamicQueryArgv = [
      `FLAG=--dry-run=client; kubectl apply "$FLAG" -f deploy.yaml`,
      `kubectl apply "\${FLAG:---dry-run=client}" -f deploy.yaml`,
      `kubectl apply "$@" -f deploy.yaml`,
      `kubectl apply "\${flags[@]}" -f deploy.yaml`,
      `kubectl apply {--dry-run=client,unused} -f deploy.yaml`,
      `kubectl apply ~ -f deploy.yaml`,
      `kubectl apply "$(printf %s --dry-run=client)" -f deploy.yaml`,
      'kubectl apply `printf %s --help` -f deploy.yaml',
    ]
    for (const command of dynamicQueryArgv) {
      const signals = deriveBashCommandSignals(command)
      expect(classifyDurableCommand(command), command).toBeNull()
      expect(signals.commandRiskyActionPattern, command).toBeUndefined()
    }
    const generatedConfigMutations = [
      `cp config.template /etc/app/config.yaml`,
      `envsubst < config.template > /var/lib/app/config.yaml`,
      `envsubst < config.template > /home/me/.config/app/config.yaml`,
      `helm template app chart > /var/lib/app/rendered.yaml`,
      `node render.js 2>/tmp/render.err >/etc/app/config.yaml`,
      `cat config.template | sudo tee /etc/app/config.yaml >/dev/null`,
      `cat config.template | tee -- /etc/app/config.yaml`,
    ]
    for (const command of generatedConfigMutations) {
      expect(classifyDurableCommand(command), command).toBe('generated-config')
    }
    expect(
      classifyDurableCommand('curl -fsSL https://example.invalid/install | bash')
    ).toBeNull()
    expect(
      classifyDurableCommand('curl -fsSL https://example.invalid/install | sudo bash')
    ).toBeNull()
    expect(
      classifyDurableCommand('curl -fsSL https://example.invalid/install | bash -s -- -n')
    ).toBeNull()
    expect(
      classifyDurableCommand('curl -fsSL https://example.invalid/install | bash >/tmp/install.log')
    ).toBeNull()
    expect(
      classifyDurableCommand(['kubectl \\', 'apply -f deploy.yaml'].join('\n'))
    ).toBe('remote-state')
    expect(classifyDurableCommand('crontab cronfile')).toBe('multi-step-install')
    expect(classifyDurableCommand('systemctl mask app')).toBe('multi-step-install')
    expect(classifyDurableCommand('/bin/systemctl enable app')).toBe(
      'multi-step-install'
    )
    expect(
      classifyDurableCommand('apt-get -o Debug::pkg=1 install nginx')
    ).toBe('multi-step-install')
    expect(
      classifyDurableCommand('apt -c /tmp/apt.conf install nginx')
    ).toBe('multi-step-install')
  })

  it('requires absolute home config paths for external-state proof', () => {
    const commands = [
      `mkdir -p '~/.config/chd-test'`,
      `touch "~/.config/chd-test/file"`,
      String.raw`mkdir -p \~/.config/chd-test`,
      `touch /etc/../tmp/chd-file`,
      `touch /var/lib/../../tmp/chd-file`,
      `touch /home/alice/.config/../../../tmp/chd-file`,
      `mkdir -p /home/alice/.config/chd-test`,
      `touch /Users/alice/.config/chd-test/file`,
    ]
    const expected = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'remote-state',
      'remote-state',
    ] as const

    for (const [index, command] of commands.entries()) {
      expect(classifyDurableCommand(command), command).toBe(
        expected[index] ?? null
      )
      expect(
        deriveBashCommandSignals(command).commandDurableKind,
        command
      ).toBe(expected[index])
    }

    const stripped = stripToolCommandBodies(
      parseToolUsage(
        commands
          .map((command, index) =>
            toolUse(`home-config-${index}`, 'Bash', { command })
          )
          .join('\n'),
        'home-config.jsonl'
      )!
    )
    expect(stripped.calls.map((call) => call.commandDurableKind)).toEqual(
      expected
    )
  })

  it('bounds parser-owned leave-behind mutation paths before stripping input', () => {
    const path = `/${'a'.repeat(5000)}/docs/runbooks/app/README.md`
    const command = `true > ${path}`
    expect(deriveBashCommandSignals(command).leaveBehindMutationPath).toBeUndefined()

    const parsed = parseToolUsage(
      toolUse('oversized-path', 'Bash', { command }),
      'oversized.jsonl'
    )!
    const stripped = stripToolCommandBodies(parsed)
    expect(stripped.calls[0].leaveBehindMutationPath).toBeUndefined()
    expect(stripped.calls[0].input).toEqual({})
  })

  it('persists every bounded leave-behind mutation path before stripping input', () => {
    const command =
      'rm docs/runbooks/scope-a/README.md docs/runbooks/scope-b/README.md'
    const parsed = parseToolUsage(
      toolUse('multi-path-mutation', 'Bash', { command }),
      'multi-path.jsonl'
    )!
    const stripped = stripToolCommandBodies(parsed)

    expect(stripped.calls[0].leaveBehindMutationPaths).toEqual([
      'docs/runbooks/scope-a/README.md',
      'docs/runbooks/scope-b/README.md',
    ])
    expect(stripped.calls[0].leaveBehindMutationPath).toBeUndefined()
    expect(stripped.calls[0].input).toEqual({})
  })

  it('scopes dynamic argv to its unconditional risky shell stage', () => {
    const positives: Array<[string, string]> = [
      [`echo "$TOKEN"; kubectl apply -f deploy.yaml`, 'kubectl mutation'],
      [`kubectl apply -f deploy.yaml\necho "$TOKEN"`, 'kubectl mutation'],
      [`printf '%s' "$VALUE"; terraform apply -auto-approve`, 'terraform mutation'],
      [`echo {a,b}; kubectl apply -f deploy.yaml`, 'kubectl mutation'],
      [`echo \${VALUE}; kubectl apply -f deploy.yaml`, 'kubectl mutation'],
      [`FOO=1 echo ok; kubectl apply -f deploy.yaml`, 'kubectl mutation'],
      [`FOO=1 kubectl apply -f deploy.yaml; echo done`, 'kubectl mutation'],
      [
        `echo "$(false && kubectl apply -f dead.yaml)"; terraform apply -auto-approve`,
        'terraform mutation',
      ],
      [
        `echo "\${x:-$(kubectl apply -f dead.yaml)}"; kubectl apply -f live.yaml`,
        'kubectl mutation',
      ],
      [`\n\nkubectl apply -f deploy.yaml`, 'kubectl mutation'],
      [`printf manifest |\n kubectl apply -f -`, 'kubectl mutation'],
      [`bash +e -c 'false; kubectl apply -f deploy.yaml'`, 'kubectl mutation'],
      [`bash --noprofile +e -c 'kubectl apply -f deploy.yaml'`, 'kubectl mutation'],
      [`bash -e +e -c 'false; kubectl apply -f deploy.yaml'`, 'kubectl mutation'],
      [
        `bash -o errexit +o errexit -c 'false; kubectl apply -f deploy.yaml'`,
        'kubectl mutation',
      ],
      [
        `bash -u +u <<'EOF'\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `bash -t +t <<'EOF'\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `bash -e <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `cat <<'EOF' | bash +e\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `ssh prod 'bash +e -s' <<'EOF'\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `ssh prod bash +e -s </dev/null <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `ssh prod bash +e -s <<'FIRST' <<'SECOND'\necho safe\nFIRST\nkubectl apply -f deploy.yaml\nSECOND`,
        'kubectl mutation',
      ],
      [
        `bash +e <<'FIRST' <<'SECOND'\necho safe\nFIRST\nkubectl apply -f deploy.yaml\nSECOND`,
        'kubectl mutation',
      ],
      [
        `cat <<'FIRST' <<'SECOND' | bash +e\necho safe\nFIRST\nkubectl apply -f deploy.yaml\nSECOND`,
        'kubectl mutation',
      ],
      [
        `cat <<<x <<'EOF' | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [`bash<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`, 'kubectl mutation'],
      [`bash -s '3'<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`, 'kubectl mutation'],
      [`bash 00<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`, 'kubectl mutation'],
      [
        `cat 000<<'EOF' | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `ssh prod bash -s 00<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `cat<<'EOF' | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `bash +e <<'EOF' <<'EOF'\necho safe\nEOF\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `cat <<'EOF' <<'EOF' | bash +e\necho safe\nEOF\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `cat <<'EOF' | tee /tmp/audit | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `bash +e -s </dev/null <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
      [
        `bash </dev/null <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
        'kubectl mutation',
      ],
    ]
    for (const [command, expected] of positives) {
      expect(
        deriveBashCommandSignals(command).commandRiskyActionPattern,
        command
      ).toBe(expected)
    }

    const negatives = [
      `printf '%s' "$VALUE"; kubectl apply "$FLAG" -f deploy.yaml`,
      `false && kubectl apply -f deploy.yaml`,
      `true || kubectl apply -f deploy.yaml`,
      `if false; then kubectl apply -f deploy.yaml; fi`,
      `case x in y) kubectl apply -f deploy.yaml;; esac`,
      `exit 0; kubectl apply -f deploy.yaml`,
      `false && echo $(kubectl apply -f deploy.yaml)`,
      `x=set; echo \${x:-$(kubectl apply -f deploy.yaml)}`,
      `; kubectl apply -f deploy.yaml`,
      `false ;| kubectl apply -f deploy.yaml`,
      `false | | kubectl apply -f deploy.yaml`,
      `kubectl apply -f deploy.yaml |`,
      `kubectl apply -f deploy.yaml "`,
      `(kubectl apply -f deploy.yaml`,
      `kubectl apply -f deploy.yaml)`,
      String.raw`PATH=/nonexistent\ dir; kubectl apply -f deploy.yaml`,
      `PATH=/nonexistent > /tmp/chd-proof; kubectl apply -f deploy.yaml`,
      `hash -p /bin/true kubectl; kubectl apply -f deploy.yaml`,
      `$COMMAND; kubectl apply -f deploy.yaml`,
      `bash -e -c 'false; kubectl apply -f deploy.yaml'`,
      `bash -ec 'false; kubectl apply -f deploy.yaml'`,
      `bash -o errexit -c 'false; kubectl apply -f deploy.yaml'`,
      `bash -oerrexit -c 'false; kubectl apply -f deploy.yaml'`,
      `bash +onounset -c 'kubectl apply -f deploy.yaml'`,
      `bash +e -e -c 'false; kubectl apply -f deploy.yaml'`,
      `bash -e <<'EOF'\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `bash -u <<'EOF'\nprintf x "$CHD_DEFINITELY_UNSET_2717"\nkubectl apply -f deploy.yaml\nEOF`,
      `bash -o nounset <<'EOF'\nprintf x "$CHD_DEFINITELY_UNSET_2717"\nkubectl apply -f deploy.yaml\nEOF`,
      `bash -t <<'EOF'\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
      `bash -o onecmd <<'EOF'\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash -e\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash -u\nprintf x "$CHD_DEFINITELY_UNSET_2717"\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash -t\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'bash -e -s' <<'EOF'\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'bash -u -s' <<'EOF'\nprintf x "$CHD_DEFINITELY_UNSET_2717"\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'bash -t -s' <<'EOF'\ntrue\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | ssh prod 'bash -e -s'\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `(ssh prod bash -e -s) <<'EOF'\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | (ssh prod bash -e -s)\nfalse\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'exit 0; bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | ssh prod 'exit 0; bash +e -s'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'false && bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'true || bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'if false; then bash +e -s; fi' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'set -e; false; bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'printf x | bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | ssh prod 'printf x | bash +e -s'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'cat >/dev/null; bash +e -s' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `bash +e -s <<'EOF' </dev/null\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | bash +e -s </dev/null\nkubectl apply -f deploy.yaml\nEOF`,
      `bash +e -s <<'EOF' 0<&-\nkubectl apply -f deploy.yaml\nEOF`,
      `bash +e -s <<'EOF' <<< :\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod 'bash +e -s </dev/null' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
      `cat <<'EOF' | ssh prod 'bash +e -s </dev/null'\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod <<'EOF' <<<x\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod <<'EOF' </dev/null\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod <<'EOF' 0<&-\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod <<'FIRST' <<'SECOND'\nkubectl apply -f dead.yaml\nFIRST\necho safe\nSECOND`,
      `bash +e <<'FIRST' <<'SECOND'\nkubectl apply -f dead.yaml\nFIRST\necho safe\nSECOND`,
      `cat <<'FIRST' <<'SECOND' | bash +e\nkubectl apply -f dead.yaml\nFIRST\necho safe\nSECOND`,
      `cat 3<<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' <<<x | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `bash +e <<'EOF' <<'EOF'\nkubectl apply -f dead.yaml\nEOF\necho safe\nEOF`,
      `cat <<'EOF' <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF\necho safe\nEOF`,
      `true <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `grep nomatch <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `head -n0 <<'EOF' | ssh prod bash +e -s\nkubectl apply -f dead.yaml\nEOF`,
      `cat -n <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat --bad <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat -- -- <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee --bad | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee >/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee </dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' 1<>/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee 1<&- | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' 1<<'OUT' | bash +e\nkubectl apply -f dead.yaml\nEOF\nignored\nOUT`,
      `cat <<'EOF' 00</dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `bash <<'EOF' 000<&-\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' 01<>/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee 001<&- | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' 3<&999999 | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' 999999<&0 | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' | tee 9</definitely/missing | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `cat <<'EOF' >/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
      `bash --command='kubectl apply -f dead.yaml'`,
      `bash --errexit -c 'kubectl apply -f dead.yaml'`,
      `bash --stdin <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `bash --noexec -c 'kubectl apply -f dead.yaml'`,
      `bash -e --noprofile -c 'kubectl apply -f dead.yaml'`,
      `bash -D +D -c 'kubectl apply -f dead.yaml'`,
      `bash +D -c 'kubectl apply -f dead.yaml'`,
      `bash +D <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `bash +e +D +n -c 'kubectl apply -f dead.yaml'`,
      `bash --help +n -c 'kubectl apply -f dead.yaml'`,
      `bash --definitely-invalid -c 'kubectl apply -f dead.yaml'`,
      `bash -Z -c 'kubectl apply -f dead.yaml'`,
      `bash <(printf safe) <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -F /tmp/ssh_config prod <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -o Include=/tmp/ssh_config prod <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -Z prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -1 prod 'kubectl apply -f dead.yaml'`,
      `ssh --definitely-invalid prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -o DefinitelyInvalid=yes prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -oDefinitelyInvalid=yes prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -o StdinNull=maybe prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -oInclude prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s '<' /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s \\< /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s '<&-' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s x'<' /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s x\\< /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh prod bash -s arg'0<&-' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -o 'HostKeyAlias bad value' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `ssh -oHostKeyAlias='bad value' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
      `bash -c 'kubectl apply -f dead.yaml' >`,
      `bash -c 'kubectl apply -f dead.yaml' <`,
      `bash -c 'kubectl apply -f dead.yaml' 2>`,
      `bash -c 'kubectl apply -f dead.yaml' 0<&`,
      `bash <<`,
      `true >\nkubectl apply -f dead.yaml`,
      `true >; kubectl apply -f dead.yaml`,
      `bash <<\nkubectl apply -f dead.yaml`,
    ]
    for (const command of negatives) {
      expect(
        deriveBashCommandSignals(command).commandRiskyActionPattern,
        command
      ).toBeUndefined()
    }
  })

  it.each([
    `cat -- -- <<'EOF' | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' 1<>/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' | tee 1<&- | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `bash --command='kubectl apply -f dead.yaml'`,
    `bash --errexit -c 'kubectl apply -f dead.yaml'`,
    `bash --stdin <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `bash -e --noprofile -c 'kubectl apply -f dead.yaml'`,
    `ssh -Z prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh --definitely-invalid prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o DefinitelyInvalid=yes prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o StdinNull=maybe prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh prod bash -s '<' /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `bash -c 'kubectl apply -f dead.yaml' >`,
    `bash -c 'kubectl apply -f dead.yaml' <`,
    `bash -c 'kubectl apply -f dead.yaml' 2>`,
    `bash -c 'kubectl apply -f dead.yaml' 0<&`,
    `cat <<'EOF' 00</dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `bash <<'EOF' 000<&-\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' 01<>/dev/null | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' | tee 001<&- | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' 3<&999999 | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' 999999<&0 | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `cat <<'EOF' | tee 9</definitely/missing | bash +e\nkubectl apply -f dead.yaml\nEOF`,
    `bash +D -c 'kubectl apply -f dead.yaml'`,
    `bash +D <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `bash +e +D +n -c 'kubectl apply -f dead.yaml'`,
    `ssh prod bash -s x'<' /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh prod bash -s x\\< /dev/null <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh prod bash -s arg'0<&-' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'HostKeyAlias bad value' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -oHostKeyAlias='bad value' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `true >\nkubectl apply -f dead.yaml`,
    `true >; kubectl apply -f dead.yaml`,
    `bash <<\nkubectl apply -f dead.yaml`,
  ])('fails invalid shell transport closed across command signals: %s', (command) => {
    const signals = deriveBashCommandSignals(command)
    expect(signals.commandRiskyActionPattern).toBeUndefined()
    expect(signals.commandDurableKind).toBeUndefined()
  })

  it.each([
    `ssh prod bash -s x'>' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    String.raw`ssh prod bash -s x\> <<'EOF'
kubectl apply -f dead.yaml
EOF`,
    `ssh prod bash -s '1>&999999' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh prod bash -s x'>|' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'HostKeyAlias=""' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'HostKeyAlias=#' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'HostKeyAlias="unterminated' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'GlobalKnownHostsFile=""' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh -o 'GlobalKnownHostsFile=#' prod bash -s <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `true > < /dev/null; kubectl apply -f dead.yaml`,
    `true > 2>/dev/null; kubectl apply -f dead.yaml`,
    `true < > /dev/null; kubectl apply -f dead.yaml`,
    `true > <> /dev/null; kubectl apply -f dead.yaml`,
    `true <<< << X; kubectl apply -f dead.yaml`,
    `true > (echo x); kubectl apply -f dead.yaml`,
    `true > >| file; kubectl apply -f dead.yaml`,
    `true > &> file; kubectl apply -f dead.yaml`,
    `true\0; kubectl apply -f dead.yaml`,
    `bash -c 'kubectl apply -f dead.yaml' 2>&foo`,
    `bash -c 'kubectl apply -f dead.yaml' 2>&1foo`,
    `bash -c 'kubectl apply -f dead.yaml' 0<&foo`,
    `ssh prod bash -s '1>&foo' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `ssh prod bash -s arg'1>&999999' <<'EOF'\nkubectl apply -f dead.yaml\nEOF`,
    `bash -c 'kubectl apply -f dead.yaml' 2147483647>&1`,
    `bash -c 'kubectl apply -f dead.yaml' 2147483647>/dev/null`,
    `bash -c 'kubectl apply -f dead.yaml' 2147483647</dev/null`,
    `bash -c 'kubectl apply -f dead.yaml' 2>&$fd`,
    `bash -c 'kubectl apply -f dead.yaml' 2>&$(printf 1)`,
  ])('rejects malformed SSH reconstruction, config, and redirect pairs: %s', (command) => {
    const signals = deriveBashCommandSignals(command)
    expect(signals.commandRiskyActionPattern).toBeUndefined()
    expect(signals.commandDurableKind).toBeUndefined()
  })

  it.each([
    `bash 00<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `cat 000<<'EOF' | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
    `ssh prod bash -s 00<<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `bash -n +n -c 'kubectl apply -f deploy.yaml'`,
    `bash --noprofile +e -c 'kubectl apply -f deploy.yaml'`,
    `ssh -oHostKeyAlias=prod prod bash -s <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `ssh -o GlobalKnownHostsFile=/tmp/known prod bash -s <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `ssh prod bash -s x'>' /dev/null <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    String.raw`ssh prod bash -s 'x\>' <<'EOF'
kubectl apply -f deploy.yaml
EOF`,
    `ssh prod bash -s arg'1>&2' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `ssh prod bash -s arg'1>&foo' <<'EOF'\nkubectl apply -f deploy.yaml\nEOF`,
    `cat <<'EOF' 2>&1 | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
    `cat <<'EOF' | tee /tmp/audit 2>&1 | bash +e\nkubectl apply -f deploy.yaml\nEOF`,
  ])('preserves proven shell and SSH transport while hardening syntax: %s', (command) => {
    const signals = deriveBashCommandSignals(command)
    expect(signals.commandRiskyActionPattern).toBe('kubectl mutation')
    expect(signals.commandDurableKind).toBe('remote-state')
  })

  it('requires the signal-owning invocation to survive its runtime redirections', () => {
    const path = 'docs/runbooks/app-production/README.md'
    const rejected = [
      [`kubectl apply -f x 2>&foo; true`, 'commandRiskyActionPattern'],
      [`rm -rf / 0<&foo; true`, 'commandDangerousPattern'],
      [`cat /tmp/x 2>&1foo; true`, 'commandBypassCategories'],
      [`git stash 2147483647>/dev/null; true`, 'commandGitSegments'],
      [`rm ${path} 2>&foo; true`, 'leaveBehindMutationPaths'],
      [`false 2>&foo && grep x file`, 'commandBypassCategories'],
      [`false 2>&foo && git stash`, 'commandGitSegments'],
      [`false 2>&foo && rm -rf /`, 'commandDangerousPattern'],
      [`false 2>&foo && rm ${path}`, 'leaveBehindMutationPaths'],
      [
        `(true 3>&4) 4>/tmp/x || rm ${path}`,
        'leaveBehindMutationPaths',
      ],
      [`{ rm -rf /; } 2>&foo`, 'commandDangerousPattern'],
      [`{ grep x file; } 2>&foo`, 'commandBypassCategories'],
      [`{ git stash; } 2>&foo`, 'commandGitSegments'],
      [`if true; then rm -rf /; fi 2>&foo`, 'commandDangerousPattern'],
      [`while true; do rm -rf /; done 2>&foo`, 'commandDangerousPattern'],
      [`if false; then rm -rf /; fi`, 'commandDangerousPattern'],
      [`if false; then grep x file; fi`, 'commandBypassCategories'],
      [`if false; then git stash; fi`, 'commandGitSegments'],
      [`f(){ rm -rf /; }; true`, 'commandDangerousPattern'],
      [`f(){ grep x file; }; true`, 'commandBypassCategories'],
      [`f(){ git stash; }; true`, 'commandGitSegments'],
      [`f() ( rm -rf / )`, 'commandDangerousPattern'],
      [`function f ( grep x file )`, 'commandBypassCategories'],
      [`function f() ( git stash )`, 'commandGitSegments'],
      [`f() ( rm ${path} )`, 'leaveBehindMutationPaths'],
      [
        `if true; then false; fi && grep x file`,
        'commandBypassCategories',
      ],
      [
        `if true; then false; fi && git stash`,
        'commandGitSegments',
      ],
      [
        `if true; then false; fi && rm -rf /`,
        'commandDangerousPattern',
      ],
      [
        `if true; then false; fi && rm ${path}`,
        'leaveBehindMutationPaths',
      ],
      [
        `if false; then true; fi || grep x file`,
        'commandBypassCategories',
      ],
      [
        `if false; then true; fi || git stash`,
        'commandGitSegments',
      ],
      [
        `if false; then true; fi || rm -rf /`,
        'commandDangerousPattern',
      ],
      [
        `if false; then true; fi || rm ${path}`,
        'leaveBehindMutationPaths',
      ],
      [`X=; grep x file >"$X"`, 'commandBypassCategories'],
      [`X=; git stash >"$X"`, 'commandGitSegments'],
      [`X=; rm -rf / >"$X"`, 'commandDangerousPattern'],
      [`grep x file >$(false)`, 'commandBypassCategories'],
      [`git stash >$(false)`, 'commandGitSegments'],
      [`rm -rf / >$(false)`, 'commandDangerousPattern'],
      [`touch a1 a2; grep x file >a*`, 'commandBypassCategories'],
      [`printf x | true 3>&4 | tee -a ${path}`, 'leaveBehindMutationPaths'],
      [`rm -rf /; {`, 'commandDangerousPattern'],
      [`cat /tmp/x; {`, 'commandBypassCategories'],
      [`git stash; {`, 'commandGitSegments'],
      [`rm ${path}; {`, 'leaveBehindMutationPaths'],
      [`rm -rf /; }`, 'commandDangerousPattern'],
      [`rm -rf /; if true`, 'commandDangerousPattern'],
      [`rm -rf /; [[ x`, 'commandDangerousPattern'],
      [`rm -rf /;;`, 'commandDangerousPattern'],
      [`rm -rf /; if true; fi`, 'commandDangerousPattern'],
      [`rm -rf /; while true; done`, 'commandDangerousPattern'],
      [`rm -rf /; case x; esac`, 'commandDangerousPattern'],
      [`rm -rf /; { true }`, 'commandDangerousPattern'],
      [`rm -rf /; function f`, 'commandDangerousPattern'],
      [`rm -rf /; function f echo hi`, 'commandDangerousPattern'],
      [`rm -rf /; f()`, 'commandDangerousPattern'],
      [`rm -rf /; f() { true }`, 'commandDangerousPattern'],
      [`rm -rf /; coproc`, 'commandDangerousPattern'],
      [`rm -rf /; in true`, 'commandDangerousPattern'],
    ] as const
    for (const [command, field] of rejected) {
      expect(deriveBashCommandSignals(command)[field], command).toBeUndefined()
    }

    const later = deriveBashCommandSignals(
      `true 2>&foo; kubectl apply -f x; rm -rf /; cat /tmp/x; git stash; rm ${path}`
    )
    expect(later.commandRiskyActionPattern).toBe('kubectl mutation')
    expect(later.commandDangerousPattern).toBe('rm -rf')
    expect(later.commandBypassCategories).toContain('cat')
    expect(later.commandGitSegments).toEqual(['git stash'])
    expect(
      deriveBashCommandSignals(`true 2>&foo; rm ${path}`)
        .leaveBehindMutationPaths
    ).toEqual([path])
    expect(
      deriveBashCommandSignals(
        `true 2>&foo && grep x f; echo y | grep x f`
      ).commandBypassCategories
    ).toBeUndefined()
    expect(
      deriveBashCommandSignals(`rm -rf /\n{`).commandDangerousPattern
    ).toBe('rm -rf')
    expect(
      deriveBashCommandSignals(`rm -rf /\nfunction f`).commandDangerousPattern
    ).toBe('rm -rf')
    expect(
      deriveBashCommandSignals(`f() ( true ); rm -rf /`)
        .commandDangerousPattern
    ).toBe('rm -rf')
    const afterControl = deriveBashCommandSignals(
      `if false; then true; fi; grep x f; git stash; rm -rf /; rm ${path}`
    )
    expect(afterControl.commandBypassCategories).toContain('grep')
    expect(afterControl.commandGitSegments).toEqual(['git stash'])
    expect(afterControl.commandDangerousPattern).toBe('rm -rf')
    expect(
      deriveBashCommandSignals(
        `if false; then true; fi; rm ${path}`
      ).leaveBehindMutationPaths
    ).toEqual([path])
  })

  it.each([
    `true > '('; kubectl apply -f x`,
    `true > '&'; kubectl apply -f x`,
    String.raw`true > \&; kubectl apply -f x`,
    `true >''; kubectl apply -f x`,
    `true <<<''; kubectl apply -f x`,
  ])('keeps valid literal redirect targets from poisoning later stages: %s', (command) => {
    expect(deriveBashCommandSignals(command).commandRiskyActionPattern).toBe(
      'kubectl mutation'
    )
  })

  it('reparses locally quoted SSH metacharacters only after remote argv reconstruction', () => {
    const dead = `ssh prod bash -s '&>' '>' <<'EOF'\nkubectl apply -f x\nEOF`
    const live = `ssh prod echo '&>' /etc/app/config.yaml`
    expect(deriveBashCommandSignals(dead).commandRiskyActionPattern).toBeUndefined()
    expect(classifyDurableCommand(dead)).toBeNull()
    expect(classifyDurableCommand(live)).toBe('remote-state')
  })

  it.each([
    `ssh '' 'touch /etc/app/config.yaml'`,
    `ssh 'bad host' 'touch /etc/app/config.yaml'`,
    `ssh $'bad\\nhost' 'touch /etc/app/config.yaml'`,
    `ssh -- - 'touch /etc/app/config.yaml'`,
    `ssh 'host;rm' 'touch /etc/app/config.yaml'`,
    `ssh 'host|x' 'touch /etc/app/config.yaml'`,
    `ssh 'host>x' 'touch /etc/app/config.yaml'`,
    `ssh 'host&x' 'touch /etc/app/config.yaml'`,
    `ssh 'host(x)' 'touch /etc/app/config.yaml'`,
    String.raw`ssh 'host\x' 'touch /etc/app/config.yaml'`,
    `ssh 'host{x}' 'touch /etc/app/config.yaml'`,
    `ssh '@host' 'touch /etc/app/config.yaml'`,
    `ssh 'user@' 'touch /etc/app/config.yaml'`,
    `ssh 'user@-host' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://@host' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://user@-host' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://user@@host' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host:bad' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host:0' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host:65536' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host/path' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host?query' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://host#fragment' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://2001:db8::1' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://[:::]' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://[1:2:3:4:5:6:7:8:9]' 'touch /etc/app/config.yaml'`,
    `ssh 'ssh://[1..2:3]' 'touch /etc/app/config.yaml'`,
  ])('rejects an SSH destination that cannot name a remote host: %s', (command) => {
    expect(classifyDurableCommand(command)).toBeNull()
    expect(deriveBashCommandSignals(command).commandDurableKind).toBeUndefined()
  })

  it.each([
    `scp file 'host;rm:/etc/app/config.yaml'`,
    `rsync file 'host|x:/etc/app/config.yaml'`,
    `scp file '@host:/etc/app/config.yaml'`,
    `scp file 'user@-host:/etc/app/config.yaml'`,
    `rsync file 'rsync://@host/etc/app/config.yaml'`,
    `scp file 'scp://user@@host/etc/app/config.yaml'`,
    `scp file 'scp://host:bad/etc/app/config.yaml'`,
    `scp file 'scp://host:0/etc/app/config.yaml'`,
    `scp file 'scp://host:65536/etc/app/config.yaml'`,
    `rsync file 'rsync://user@@host/app/config.yaml'`,
    `rsync file 'rsync://host:bad/app/config.yaml'`,
    `rsync file 'rsync://host:0/app/config.yaml'`,
    `rsync file 'rsync://host:65536/app/config.yaml'`,
  ])('rejects an invalid scp/rsync remote authority: %s', (command) => {
    expect(classifyDurableCommand(command)).toBeNull()
  })

  it('requires a validated source and destination for remote transfers', () => {
    const nonMutations = [
      `rsync prod:/etc/app/config.yaml`,
      `rsync -av prod:/etc/app/config.yaml`,
      `rsync rsync://prod/module/config.yaml`,
      `scp prod:/etc/app/config.yaml`,
      `scp -P prod:/etc/app/config.yaml`,
      `scp -P 22 prod:/etc/app/config.yaml`,
      `rsync -e prod:/etc/app/config.yaml`,
      `rsync -e ssh prod:/etc/app/config.yaml`,
      `rsync prod:/var/spool/result.json ./result.json`,
      `rsync /etc/app.conf ./app.conf`,
      `rsync --remove-source-files ./result.json ./result-copy.json`,
      `rsync -- --remove-source-files prod:/var/spool/result.json ./result.json`,
      `scp ./app.conf prod:/dev/null`,
      `scp ./app.conf scp://prod/dev/null`,
      `rsync ./app.conf prod:/dev/null`,
      `scp ./app.conf prod:/dev/zero`,
      `scp ./app.conf prod:/dev/./null`,
      `scp ./app.conf prod:/dev//null`,
    ]
    for (const command of nonMutations) {
      expect(classifyDurableCommand(command), command).toBeNull()
      expect(
        deriveBashCommandSignals(command).commandDurableKind,
        command
      ).toBeUndefined()
    }

    const mutations = [
      `scp -P 22 ./app.conf prod:/etc/app/config.yaml`,
      `scp -vP22 ./app.conf prod:/etc/app/config.yaml`,
      `rsync -e ssh ./app.conf prod:/etc/app/config.yaml`,
      `rsync --rsh=ssh ./app.conf prod:/etc/app/config.yaml`,
      `rsync -- -n prod:/etc/app/config.yaml`,
      `rsync --remove-source-files prod:/var/spool/result.json ./result.json`,
      `rsync --remove-source-files rsync://prod/results/result.json ./result.json`,
      `rsync --remove-source-files /etc/app.conf ./app.conf`,
    ]
    for (const command of mutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
  })

  it('normalizes proven discard-device paths without resolving parent segments', () => {
    const discardCommands = [
      `printf x > /dev/zero`,
      `printf x > /dev/./null`,
      `printf x > /dev//null`,
      `ssh prod 'printf x > /dev/zero'`,
      `ssh prod 'printf x > /dev/./null'`,
      `ssh prod 'printf x > /dev//null'`,
      `scp ./app.conf prod:/dev/zero`,
      `scp ./app.conf prod:/dev/./null`,
      `scp ./app.conf prod:/dev//null`,
    ]
    for (const command of discardCommands) {
      expect(classifyDurableCommand(command), command).toBeNull()
    }

    const durableCommands = [
      `ssh prod 'printf x > /etc/app/dev-zero'`,
      `scp ./app.conf prod:/etc/app/dev-zero`,
      `ssh prod 'printf x > /dev/../etc/app/config.yaml'`,
      `scp ./app.conf prod:/dev/../etc/app/config.yaml`,
    ]
    for (const command of durableCommands) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
  })

  it.each([
    `true > '>'; kubectl apply -f deploy.yaml`,
    `true > 2; kubectl apply -f deploy.yaml`,
    `true 2>&1; kubectl apply -f deploy.yaml`,
    `true 2>&foo; kubectl apply -f deploy.yaml`,
  ])('keeps valid redirect targets eligible for later risky evidence: %s', (command) => {
    const signals = deriveBashCommandSignals(command)
    expect(signals.commandRiskyActionPattern).toBe('kubectl mutation')
  })

  it('fails locale-translated durable and risky command claims closed', () => {
    const commands = [
      `bash -c $"kubectl apply -f deploy.yaml"`,
      `ssh prod $"kubectl apply -f deploy.yaml"`,
      `kubectl apply $"--dry-run=client" -f deploy.yaml`,
      `kubectl apply $"--help" -f deploy.yaml`,
      `helm upgrade app chart $"--dry-run"`,
      `kubectl apply "$(printf $"--dry-run=client")" -f deploy.yaml`,
      `helm upgrade app chart "$(printf $"--dry-run")"`,
      `kubectl apply "\${x:-$"--dry-run=client"}" -f deploy.yaml`,
      `helm upgrade app chart "\${x:-$"--dry-run"}"`,
      `kubectl apply "\${#x}" $"--dry-run=client" -f deploy.yaml`,
      `helm upgrade app chart \${#x} $"--dry-run"`,
      `kubectl apply $\\
"--dry-run=client" -f deploy.yaml`,
      `kubectl apply $\\\r\n"--dry-run=client" -f deploy.yaml`,
      `helm upgrade app chart $\\
"--dry-run"`,
      `ssh prod <<'EOF'\nkubectl apply $"--dry-run=client" -f deploy.yaml\nEOF`,
      `bash -O extglob -c 'kubectl apply @(#foo) $"--dry-run=client" -f deploy.yaml'`,
      `bash -O extglob -c 'helm upgrade app chart !(#foo) $"--dry-run"'`,
      `kubectl apply @(foo|#bar) $"--dry-run=client" -f deploy.yaml`,
      `helm upgrade app chart @(foo)#bar $"--dry-run"`,
      `kubectl apply $(true; printf $"--dry-run=client") -f deploy.yaml`,
      `helm upgrade app chart $(true | printf $"--dry-run")`,
      `kubectl apply $(if true; then printf $"--dry-run=client"; fi) -f deploy.yaml`,
      `kubectl apply <(printf foo | cat $"--dry-run=client") -f deploy.yaml`,
      `bash -O extglob -c 'kubectl apply @(foo|#bar) $"--dry-run=client" -f deploy.yaml'`,
      `kubectl apply <(printf foo)#bar $"--dry-run=client" -f deploy.yaml`,
      `cat <<$"EOF"\nprose\nEOF\nkubectl apply -f deploy.yaml`,
      `bash <<$"EOF"\nkubectl apply -f deploy.yaml\nEOF`,
      `ssh prod <<$"EOF"\nkubectl apply -f deploy.yaml\nEOF`,
      `kubectl apply $(case x in x) true;; esac; printf $"--dry-run=client") -f deploy.yaml`,
      `helm upgrade app chart $(case x in x) true;; esac; printf $"--dry-run")`,
      `kubectl apply $(case x in x) true;; esac)#suffix $"--dry-run=client" -f deploy.yaml`,
      `helm upgrade app chart $(case x in x) true;; esac)#suffix $"--dry-run"`,
      `kubectl apply $(case case in case) true && printf $"--dry-run=client";; esac) -f deploy.yaml`,
      `kubectl apply $(case "$x" in x) true;; esac; printf $"--dry-run=client") -f deploy.yaml`,
      `kubectl apply $(case "x" in x) true;; esac)#suffix $"--dry-run=client" -f deploy.yaml`,
      `kubectl apply $(case / in /) true;; esac; printf $"--dry-run=client") -f deploy.yaml`,
      `kubectl apply $(case $? in 0) true;; esac; printf $"--dry-run=client") -f deploy.yaml`,
      `kubectl apply $(case \\x in x) true;; esac; printf $"--dry-run=client") -f deploy.yaml`,
      `kubectl apply $(echo case foo in)#suffix $"--dry-run=client" -f deploy.yaml`,
      `kubectl apply $(if true; then case "$x" in x) true;; esac; fi; printf $"--dry-run=client") -f deploy.yaml`,
      `kubectl apply "$(true # comment "\nprintf %s $"--dry-run=client"\n)" -f deploy.yaml`,
      `flag=$"--dry-run=client"; kubectl apply "$flag" -f deploy.yaml`,
      `flag=$"--help"; kubectl apply "$flag" -f deploy.yaml`,
      `export FLAG=$"--dry-run"; helm upgrade app chart "$FLAG"`,
      `flags=($"--dry-run=client"); kubectl apply "\${flags[@]}" -f deploy.yaml`,
      `dry_flag() { printf %s $"--dry-run=client"; }; kubectl apply "$(dry_flag)" -f deploy.yaml`,
      `: $"localized"; kubectl apply -f deploy.yaml`,
      `kubectl apply -f deploy.yaml; printf %s $"localized"`,
      `printf %s $"localized"; terraform apply -auto-approve`,
    ]

    for (const command of commands) {
      expect(classifyDurableCommand(command), command).toBeNull()
      expect(
        deriveBashCommandSignals(command).commandRiskyActionPattern,
        command
      ).toBeUndefined()
    }

    const staticCommands: Array<[string, string]> = [
      [`kubectl apply -f '$"manifest.yaml"'`, 'remote-state'],
      [`kubectl apply -f \\$"manifest.yaml"`, 'remote-state'],
      [`kubectl apply -f "prefix $"inner" suffix"`, 'remote-state'],
      [`kubectl apply '~' -f deploy.yaml`, 'remote-state'],
      [`kubectl apply -f deploy.yaml # $"comment only"`, 'remote-state'],
      [`# $"comment only"\nkubectl apply -f deploy.yaml`, 'remote-state'],
    ]
    for (const [command, kind] of staticCommands) {
      expect(classifyDurableCommand(command), command).toBe(kind)
      expect(
        deriveBashCommandSignals(command).commandRiskyActionPattern,
        command
      ).toBeDefined()
    }

    for (const command of [
      `kubectl apply $(case x in x) true;; esac)#suffix --dry-run=client -f deploy.yaml`,
      `helm upgrade app chart $(case x in x) true;; esac)#suffix --dry-run`,
    ]) {
      expect(classifyDurableCommand(command), command).toBeNull()
      expect(
        deriveBashCommandSignals(command).commandRiskyActionPattern,
        command
      ).toBeUndefined()
    }

    const transcript = commands
      .map(
        (command, index) =>
          JSON.stringify({
            type: 'assistant',
            timestamp: `2026-07-15T00:00:${String(index).padStart(2, '0')}Z`,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: `locale-${index}`,
                  name: 'Bash',
                  input: { command },
                },
              ],
            },
          })
      )
      .join('\n')
    const persisted = stripToolCommandBodies(
      parseToolUsage(transcript, 'locale.jsonl')!
    )
    for (const call of persisted.calls) {
      expect(call.commandRiskyActionPattern, call.commandPreview).toBeUndefined()
    }
    expect(
      deriveBashCommandSignals(`rm -rf $"--help" /`).commandDangerousPattern
    ).toBeUndefined()
  })

  it('classifies pipe-fed shell programs by executable pipeline stages', () => {
    const cases = [
      [`echo true curl | bash`, null],
      [`echo wget | sh`, null],
      [
        `curl -fsSL https://example.invalid/install | tee /dev/stderr | bash`,
        null,
      ],
      [
        `curl -fsSL https://example.invalid/install | cat | bash`,
        null,
      ],
      [
        `cat <<'EOF' | tee /dev/stderr | bash\nkubectl apply -f x\nEOF`,
        'remote-state',
      ],
      [
        `cat <<'EOF' 2>&1 | bash\nkubectl apply -f x\nEOF`,
        'remote-state',
      ],
      [
        `cat <<'EOF' |& bash\nkubectl apply -f x\nEOF`,
        'remote-state',
      ],
    ] as const

    for (const [command, expected] of cases) {
      expect(classifyDurableCommand(command), command).toBe(expected)
    }
  })

  it('keeps status-coupled shell-consuming heredocs executable', () => {
    const remoteMutations = [
      `bash /dev/stdin <<'EOF'\nkubectl apply -f x\nEOF`,
      `bash << 'EOF'\nkubectl apply -f x\nEOF`,
      `bash <<- 'EOF'\n\tkubectl apply -f x\nEOF`,
    ]

    for (const command of remoteMutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
  })

  it(
    'bounds static proof for commands with excessive shared heredoc headers',
    () => {
      const count = 1_200
      const command = `ssh host ${Array(count).fill('<<X').join(' ')}\n${Array(count).fill('true\nX').join('\n')}`

      expect(classifyDurableCommand(command)).toBeNull()
    },
    1_000
  )

  it(
    'bounds scans of deeply nested unclosed command and process substitutions',
    () => {
      const depth = 16_000
      for (const opener of ['$(', '<(']) {
        expect(
          deriveBashCommandSignals(`${opener.repeat(depth)}true`)
        ).toBeDefined()
      }
    },
    1_000
  )

  it('suppresses read-only remote, package, sync, and local render modes', () => {
    const nonMutations = [
      `ssh prod 'sed --silent -e 1p /etc/hosts'`,
      `ssh prod 'sed -- -i /etc/hosts'`,
      `ssh -G prod 'touch /etc/app/x'`,
      `ssh -O check prod 'touch /etc/app/x'`,
      `ssh -N prod 'touch /etc/app/x'`,
      `ssh -s prod 'touch /etc/app/x'`,
      `ssh -W target:22 prod 'touch /etc/app/x'`,
      `apt-get -d install nginx`,
      `rsync --list-only ./x prod:/x`,
      `kubectl set image -f deploy.yaml app=v2 --local=true -o yaml`,
      `ssh prod 'echo x > /proc/self/fd/1'`,
      `tofu plan`,
      `cdk synth`,
      `aws cloudformation describe-stacks`,
      `aws cloudformation deploy --stack-name app --generate-cli-skeleton`,
      `aws ecs update-service --cluster prod --service app --generate-cli-skeleton output`,
      `aws ssm put-parameter --name /app/url --value value --generate-cli-skeleton=output`,
      `true >> /etc/app.conf`,
      `printf x >> /etc/app.conf >/dev/null`,
      `echo -n >> /etc/app.conf`,
      `printf -v output x >> /etc/app.conf`,
      `tee -a /etc/app.conf </dev/null`,
      `true | tee -a /etc/app.conf`,
      `printf x </definitely/missing | tee -a /etc/app.conf`,
      `printf x 2>/definitely/missing/out | tee -a /etc/app.conf`,
      `sudo printf x | tee -a /etc/app.conf`,
      `env printf x | tee -a /etc/app.conf`,
      `true &>> /etc/app.conf`,
      `echo x 2>& /etc/app.log`,
      `ssh prod 'true >> /etc/app.conf'`,
      `ssh prod 'echo -n >> /etc/app.conf'`,
      `ssh prod 'tee -a /etc/app.conf </dev/null'`,
      `ssh prod 'true | tee -a /etc/app.conf'`,
      `[[ a > /etc/app.conf ]]`,
      `cp -t /tmp config.template /etc/app/config.yaml`,
      `cp --target-directory /tmp config.template /etc/app/config.yaml`,
      `cp --target-directory=/tmp config.template /etc/app/config.yaml`,
      `ln -s /etc/app.conf`,
      `install -t /tmp config.template /etc/app/config.yaml`,
      `install --target-directory /tmp config.template /etc/app/config.yaml`,
      `install --target-directory=/tmp config.template /etc/app/config.yaml`,
      `PATH=/tmp systemctl enable app`,
      `env PATH=/tmp systemctl enable app`,
      `sudo PATH=/tmp systemctl enable app`,
      `sudo --chroot /tmp /bin/systemctl enable app`,
      `sudo --chroot=/tmp /bin/systemctl enable app`,
      `sudo -R /tmp /bin/systemctl enable app`,
      `sudo -R/tmp /bin/systemctl enable app`,
      `sudo -nR /tmp /bin/systemctl enable app`,
      `sudo -nR/tmp /bin/systemctl enable app`,
      `env -S 'PATH=/tmp systemctl enable app'`,
      `LD_PRELOAD=/tmp/fake.so systemctl enable app`,
      `DYLD_INSERT_LIBRARIES=/tmp/fake.dylib systemctl enable app`,
      `BASH_ENV=/tmp/exit bash -c 'kubectl apply -f x'`,
      `/tmp/systemctl enable app`,
      `./kubectl apply -f x`,
      `/usr/bin/../tmp/kubectl apply -f x`,
      `systemctl status app`,
      `time --help kubectl apply -f x`,
      `time --version kubectl apply -f x`,
      `time -V kubectl apply -f x`,
    ]

    for (const command of nonMutations) {
      expect(classifyDurableCommand(command), command).toBeNull()
    }
    expect(classifyDurableCommand(`apt-get install -- -d`)).toBe(
      'multi-step-install'
    )
    expect(
      classifyDurableCommand(`rsync -- --list-only ./x prod:/x`)
    ).toBe('remote-state')
  })

  it('normalizes common execution wrappers and global CLI options', () => {
    const remoteMutations = [
      `timeout 30 kubectl apply -f x`,
      `nohup kubectl apply -f x`,
      `env -S 'kubectl apply -f x'`,
      `env -S'kubectl apply -f x'`,
      `bash +n -c 'kubectl apply -f x'`,
      `bash +x -c 'kubectl apply -f x'`,
      `vercel --token secret deploy`,
      `vercel -t secret deploy`,
      `docker --log-level debug compose up -d`,
      `docker --config /tmp/docker compose up -d`,
      `docker -l debug compose up -d`,
    ]

    for (const command of remoteMutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
  })

  it('covers durable core verbs, decoded shell payloads, and remote file edits', () => {
    const remoteMutations = [
      String.raw`bash -c $'kubectl\x20apply\x20-f\x20x'`,
      `exec kubectl apply -f x`,
      `ssh prod 'exec kubectl apply -f x'`,
      `ssh -o RemoteCommand='touch /etc/app/x' prod`,
      `kubectl expose deployment/app --port 80`,
      `kubectl autoscale deployment/app --min 2`,
      `kubectl run app --image example.invalid/app`,
      `kubectl certificate approve worker`,
      `kubectl certificate deny worker`,
      `kubectl auth reconcile -f rbac.yaml`,
      `kubectl exec pod/app -- touch /etc/app/enabled`,
      `kubectl exec pod/app -- sh -c 'kubectl apply -f x'`,
      `kubectl cp ./config pod/app:/etc/app/config`,
      `kubectl cp ./config pod/app:/etc/app/config -c app`,
      `kubectl cp -n prod ./config pod/app:/etc/app/config`,
      `helm delete app`,
      `ssh prod 'tee -- -config'`,
      `ssh prod echo '>' /etc/app/config.yaml`,
      String.raw`ssh prod echo \> /etc/app/config.yaml`,
      `ssh prod 'tee --help >/etc/app/config.yaml'`,
      `ssh prod '>/etc/app/config.yaml true'`,
      `ssh prod '>/etc/app/config.yaml tee --help'`,
      `ssh prod 'exec >/etc/app/config.yaml'`,
      `ssh prod 'exec 9>/etc/app/config.yaml'`,
      `printf x | sudo tee /etc/app/config.yaml`,
      `>/etc/app/config.yaml true`,
      `sudo cp -t /etc/app app.conf`,
      `sudo install -m 644 -t /etc/app config.template`,
      `sudo mv --target-directory /etc/app app.conf`,
      `mv /etc/app/config.yaml ./config.backup`,
      `mv -t ./backup /etc/app/config.yaml`,
      `sudo ln -s --target-directory=/etc/app app.conf`,
      `ln -s /tmp/app.conf /etc/app/app.conf`,
      `sudo sed -i -e's/x/y/' /etc/app/config`,
      `sudo sed -i -fscript.sed /etc/app/config`,
    ]

    for (const command of remoteMutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }

    for (const command of [
      `apt-get -t stable install nginx`,
      `apt --target-release stable install nginx`,
      `systemctl disable app`,
      `systemctl reenable app`,
      `systemctl mask app`,
      `systemctl unmask app`,
      `systemctl preset app`,
      `systemctl preset-all`,
      `systemctl link /etc/systemd/system/app.service`,
      `systemctl revert app`,
      `systemctl add-wants multi-user.target app.service`,
      `systemctl add-requires multi-user.target app.service`,
      `systemctl set-default multi-user.target`,
      `systemctl set-property app MemoryMax=1G`,
    ]) {
      expect(classifyDurableCommand(command), command).toBe('multi-step-install')
      expect(classifyDurableCommand(`ssh prod '${command}'`), command).toBe(
        'remote-state'
      )
    }

    const nonMutations = [
      String.raw`printf %s $'prose\'; kubectl apply -f fake'`,
      `kubectl exec pod/app -- cat /etc/app/config`,
      `kubectl exec pod/app -- sh -c 'echo kubectl apply -f x'`,
      `kubectl cp pod/app:/etc/app/config ./config`,
      `kubectl cp pod/app:/etc/app/config ./config -c app`,
      `kubectl cp -n prod pod/app:/etc/app/config ./config`,
      `ssh prod sh -c 'kubectl apply -f x'`,
      `ssh prod sh -c 'echo kubectl apply -f x'`,
      String.raw`ssh prod 'echo \> /etc/app/config.yaml'`,
      `sudo -luroot kubectl apply -f x`,
      `sudo -vuroot kubectl apply -f x`,
      `touch -r /etc/reference local.txt`,
      `chmod --reference /etc/reference local.txt`,
      `chown --reference /etc/reference local.txt`,
      `truncate --reference /etc/reference local.txt`,
      `mv -S /etc/fake local-source local-dest`,
      `mv --suffix /etc/fake local-source local-dest`,
      `sed -i -e /etc/d local.txt`,
      `systemctl --runtime mask app`,
      `systemctl edit app`,
      `ssh prod 'systemctl edit app'`,
      `sudo -e /etc/app/config.yaml`,
      `sudo -euroot /etc/app/config.yaml`,
      `sudo -ehprod /etc/app/config.yaml`,
      `sudoedit /etc/app/config.yaml`,
      `ssh prod 'sudo -e /etc/app/config.yaml'`,
      `ssh prod 'sudoedit /etc/app/config.yaml'`,
      `kubectl edit deployment/app`,
      `crontab -e`,
      `ssh -o RemoteCommand=none prod`,
    ]
    for (const command of nonMutations) {
      expect(classifyDurableCommand(command), command).toBeNull()
    }
  })

  it('fails durable filesystem proof closed for interactive coreutils options', () => {
    const interactiveCommands = [
      `rm -i /etc/app/config.yaml </dev/null`,
      `rm -fi /etc/app/config.yaml </dev/null`,
      `rm -if /etc/app/config.yaml </dev/null`,
      `rm -I /etc/app/config.yaml </dev/null`,
      `rm -fI /etc/app/config.yaml </dev/null`,
      `rm -If /etc/app/config.yaml </dev/null`,
      `rm --interactive /etc/app/config.yaml </dev/null`,
      `rm --interactive=always /etc/app/config.yaml </dev/null`,
      `rm --interactive=never /etc/app/config.yaml`,
      `rm --force --interactive=always /etc/app/config.yaml </dev/null`,
      `rm --interactive=always --force /etc/app/config.yaml </dev/null`,
      `cp -i /tmp/source /etc/app/config.yaml </dev/null`,
      `cp -fi /tmp/source /etc/app/config.yaml </dev/null`,
      `cp -if /tmp/source /etc/app/config.yaml </dev/null`,
      `cp --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `cp --force --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `cp --interactive --force /tmp/source /etc/app/config.yaml </dev/null`,
      `mv -i /tmp/source /etc/app/config.yaml </dev/null`,
      `mv -fi /tmp/source /etc/app/config.yaml </dev/null`,
      `mv -if /tmp/source /etc/app/config.yaml </dev/null`,
      `mv --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `mv --force --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `mv --interactive --force /tmp/source /etc/app/config.yaml </dev/null`,
      `ln -i /tmp/source /etc/app/config.yaml </dev/null`,
      `ln -fi /tmp/source /etc/app/config.yaml </dev/null`,
      `ln -if /tmp/source /etc/app/config.yaml </dev/null`,
      `ln --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `ln --force --interactive /tmp/source /etc/app/config.yaml </dev/null`,
      `ln --interactive --force /tmp/source /etc/app/config.yaml </dev/null`,
      `sudo rm -i /etc/app/config.yaml </dev/null`,
      `bash -c 'rm -i /etc/app/config.yaml </dev/null'`,
      `ssh prod 'rm -i /etc/app/config.yaml </dev/null'`,
      `ssh prod 'cp -i /tmp/source /etc/app/config.yaml </dev/null'`,
      `ssh prod 'mv -i /tmp/source /etc/app/config.yaml </dev/null'`,
      `ssh prod 'ln -i /tmp/source /etc/app/config.yaml </dev/null'`,
    ]

    for (const command of interactiveCommands) {
      expect(classifyDurableCommand(command), command).toBeNull()
      expect(
        deriveBashCommandSignals(command).commandDurableKind,
        command
      ).toBeUndefined()
    }

    for (const command of [
      `rm -- -i /etc/app/config.yaml`,
      `cp -- -i /etc/app/config.yaml`,
      `mv -- -i /etc/app/config.yaml`,
      `ln -- -i /etc/app/config.yaml`,
    ]) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
  })

  it('does not treat help/version pipeline output as an install script', () => {
    const nonInstalls = [
      `curl --help | bash`,
      `curl -V | bash`,
      `curl https://example.invalid | tee --help | bash`,
      `curl https://example.invalid | cat --help | bash`,
      `curl https://example.invalid | bash --help`,
      `wget --version | sh`,
    ]

    for (const command of nonInstalls) {
      expect(classifyDurableCommand(command), command).toBeNull()
    }
    expect(classifyDurableCommand(`apt-get -sd install nginx`)).toBeNull()
  })

  it('traverses executable shell grouping, redirections, and process substitutions', () => {
    const remoteMutations = [
      `ssh prod 'echo x >| /etc/app/config.yaml'`,
      `(terraform apply)`,
      `(echo hi | kubectl apply -f x)`,
    ]

    for (const command of remoteMutations) {
      expect(classifyDurableCommand(command), command).toBe('remote-state')
    }
    expect(
      classifyDurableCommand(`echo "<(kubectl apply -f quoted-literal.yaml)"`)
    ).toBeNull()
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

  it('keeps parser-owned malformed-shell bypass negatives identical before and after stripping', () => {
    const command = 'true > ; grep foo src'
    const parsed = parseToolUsage(
      [
        toolUse('u1', 'Bash', { command }),
        toolResult('u1', { isError: true }),
      ].join('\n'),
      'malformed-bypass.jsonl'
    )!

    expect(parsed.calls[0].commandAnalysisComplete).toBe(true)
    expect(parsed.calls[0].commandBypassCategories).toBeUndefined()
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(nativeToolBypass([data]).totalBypass).toBe(0)
    }

    // Marker-less legacy rows retain their raw-command fallback until their
    // parser cache is turned over.
    expect(
      nativeToolBypass([
        session('legacy', [bash(command)]),
      ]).totalBypass
    ).toBe(1)
  })

  it('does not resurrect a boolean-dependent bypass after an unproven redirect', () => {
    const skipped = [
      'true 2>&foo && grep foo src',
      'if false; then grep foo src; fi',
      'if true; then false; fi && grep foo src',
      'if false; then true; fi || grep foo src',
      'f(){ grep foo src; }; true',
    ]
    const independent = 'true 2>&foo; grep foo src'
    const parsed = parseToolUsage(
      [
        ...skipped.map((command, index) =>
          toolUse(`skipped-${index}`, 'Bash', { command })
        ),
        toolUse('independent', 'Bash', { command: independent }),
      ].join('\n'),
      'redirect-reachability-bypass.jsonl'
    )!

    expect(
      parsed.calls.slice(0, skipped.length).every(
        (parsedCall) => parsedCall.commandBypassCategories === undefined
      )
    ).toBe(true)
    expect(parsed.calls.at(-1)?.commandBypassCategories).toEqual(['grep'])
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      const skippedCalls = data.calls.slice(0, skipped.length)
      const independentCall = data.calls.at(-1)!
      expect(
        nativeToolBypass([session('skipped', skippedCalls)]).totalBypass
      ).toBe(0)
      expect(
        nativeToolBypass([
          session('independent', [independentCall]),
        ]).totalBypass
      ).toBe(1)
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
