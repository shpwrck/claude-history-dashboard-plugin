import { describe, it, expect } from 'vitest'
import { parseSessionJsonl, estimateCost } from './parse-sessions'

// Build a single assistant transcript line. `message` is left as an object
// (the wire format also allows a JSON-encoded string — see the #234 regression
// test below, which exercises that string branch directly).
const assistant = (
  usage: Record<string, unknown>,
  opts: { id?: string; model?: string | null; timestamp?: string; top?: Record<string, unknown> } = {}
) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp ?? '2026-01-01T00:00:00.000Z',
    ...opts.top,
    message: {
      id: opts.id ?? 'm1',
      ...(opts.model === null ? {} : { model: opts.model ?? 'claude-opus-4-8' }),
      usage,
    },
  })

describe('parseSessionJsonl', () => {
  it('returns null when there are no assistant/usage lines', () => {
    const text = JSON.stringify({ type: 'user', timestamp: 't', message: 'hi' })
    expect(parseSessionJsonl(text, 'abc.jsonl')).toBeNull()
  })

  it('derives sessionId from the filename and sums token usage', () => {
    const text = [
      assistant({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }, { id: 'a' }),
      assistant({ input_tokens: 200, output_tokens: 30, cache_creation_input_tokens: 7 }, { id: 'b' }),
    ].join('\n')
    const out = parseSessionJsonl(text, 'session-123.jsonl')!
    expect(out.sessionId).toBe('session-123')
    expect(out.totalInputTokens).toBe(300)
    expect(out.totalOutputTokens).toBe(50)
    expect(out.totalCacheReadTokens).toBe(5)
    expect(out.totalCacheCreationTokens).toBe(7)
    expect(out.messageCount).toBe(2)
    expect(out.model).toBe('claude-opus-4-8')
    expect(out.hasUnknownModel).toBe(false)
  })

  it('dedupes rows by message id (last write wins per id)', () => {
    const text = [
      assistant({ input_tokens: 100, output_tokens: 0 }, { id: 'dup' }),
      assistant({ input_tokens: 999, output_tokens: 0 }, { id: 'dup' }),
    ].join('\n')
    const out = parseSessionJsonl(text, 'f.jsonl')!
    expect(out.messageCount).toBe(1)
    expect(out.totalInputTokens).toBe(999)
  })

  it('captures the first-seen top-level session dimensions', () => {
    const text = [
      assistant(
        { input_tokens: 1, output_tokens: 1, service_tier: 'standard' },
        { id: 'a', top: { version: '1.2.3', gitBranch: 'main', entrypoint: 'sdk-cli' } }
      ),
      assistant(
        { input_tokens: 1, output_tokens: 1, service_tier: 'priority' },
        { id: 'b', top: { version: '9.9.9', gitBranch: 'other', entrypoint: 'cli' } }
      ),
    ].join('\n')
    const out = parseSessionJsonl(text, 'f.jsonl')!
    expect(out.version).toBe('1.2.3')
    expect(out.gitBranch).toBe('main')
    expect(out.entrypoint).toBe('sdk-cli')
    expect(out.serviceTier).toBe('standard')
  })

  it('preserves path-derived project attribution when supplied', () => {
    const text = assistant({ input_tokens: 1, output_tokens: 1 })
    const out = parseSessionJsonl(text, 'f.jsonl', '/home/user/project-alpha')!
    expect(out.project).toBe('/home/user/project-alpha')
    expect(out.projectShort).toBe('~/project-alpha')
  })

  it('detects a compaction event when context drops below 70% within the gap window', () => {
    const text = [
      assistant({ input_tokens: 1000, output_tokens: 0 }, { id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }),
      assistant({ input_tokens: 100, output_tokens: 0 }, { id: 'b', timestamp: '2026-01-01T00:01:00.000Z' }),
    ].join('\n')
    const out = parseSessionJsonl(text, 'f.jsonl')!
    expect(out.compactionEvents).toHaveLength(1)
    expect(out.compactionEvents[0].beforeContext).toBe(1000)
    expect(out.compactionEvents[0].afterContext).toBe(100)
    expect(out.compactionEvents[0].reductionPercent).toBeCloseTo(90)
  })

  it('does not flag a compaction across a gap larger than the window', () => {
    const text = [
      assistant({ input_tokens: 1000, output_tokens: 0 }, { id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }),
      assistant({ input_tokens: 100, output_tokens: 0 }, { id: 'b', timestamp: '2026-01-01T00:30:00.000Z' }),
    ].join('\n')
    expect(parseSessionJsonl(text, 'f.jsonl')!.compactionEvents).toHaveLength(0)
  })

  it('flags an unknown model', () => {
    const text = assistant({ input_tokens: 1, output_tokens: 1 }, { model: 'gpt-9' })
    expect(parseSessionJsonl(text, 'f.jsonl')!.hasUnknownModel).toBe(true)
  })

  it('prices the real Fable model id without flagging it unknown', () => {
    const text = assistant(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      { model: 'claude-fable-5' }
    )
    const out = parseSessionJsonl(text, 'f.jsonl')!
    expect(out.hasUnknownModel).toBe(false)
    expect(estimateCost(out)).toBeCloseTo(60, 9)
  })

  it('keeps missing model values in the Unknown bucket without treating them as unrecognized strings', () => {
    const text = assistant({ input_tokens: 1, output_tokens: 1 }, { model: null })
    const out = parseSessionJsonl(text, 'f.jsonl')!
    expect(out.model).toBe('unknown')
    expect(out.entries[0].model).toBe('unknown')
    expect(out.hasUnknownModel).toBe(false)
    expect(estimateCost(out)).toBe(0)
  })

  it('parses a string-encoded message containing single quotes without corruption (#234)', () => {
    // Regression: the string-message path used to JSON.parse after
    // `.replace(/'/g, '"')`, which turned any value containing a single quote
    // into invalid JSON and silently dropped the line. Here the id holds a `'`.
    const message = JSON.stringify({
      id: "m'1",
      model: 'claude-opus-4-8',
      usage: { input_tokens: 5, output_tokens: 0 },
    })
    // `message` is a JSON-encoded STRING (the wire format's other shape), so
    // this exercises the string branch, not the object branch.
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message })
    const out = parseSessionJsonl(line, 'f.jsonl')
    expect(out).not.toBeNull()
    expect(out!.totalInputTokens).toBe(5)
    expect(out!.messageCount).toBe(1)
  })
})

describe('parseSessionJsonl opener extraction (#743)', () => {
  // A user line + a token-bearing assistant line so the session is non-null.
  const user = (content: unknown) =>
    JSON.stringify({ type: 'user', timestamp: 't', message: { role: 'user', content } })

  it('captures the first user message as the opener', () => {
    const text = [
      user('Refactor the auth module'),
      user('a later follow-up that must NOT overwrite the opener'),
      assistant({ input_tokens: 10, output_tokens: 2 }),
    ].join('\n')
    expect(parseSessionJsonl(text, 'f.jsonl')!.opener).toBe('Refactor the auth module')
  })

  it('flattens newlines and truncates the opener to ~200 chars', () => {
    const long = 'x'.repeat(500)
    const text = [
      user(`line one\nline two ${long}`),
      assistant({ input_tokens: 10, output_tokens: 2 }),
    ].join('\n')
    const opener = parseSessionJsonl(text, 'f.jsonl')!.opener!
    expect(opener.length).toBe(200)
    expect(opener).not.toContain('\n')
    expect(opener.startsWith('line one line two ')).toBe(true)
  })

  it('extracts text from an array-content user message', () => {
    const text = [
      user([
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'second block' },
      ]),
      assistant({ input_tokens: 10, output_tokens: 2 }),
    ].join('\n')
    expect(parseSessionJsonl(text, 'f.jsonl')!.opener).toBe('first block second block')
  })

  it('skips tool_result-only user lines and uses the first prose line', () => {
    const text = [
      user([{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]),
      user('the real opener'),
      assistant({ input_tokens: 10, output_tokens: 2 }),
    ].join('\n')
    expect(parseSessionJsonl(text, 'f.jsonl')!.opener).toBe('the real opener')
  })

  it('leaves opener undefined when there is no user message', () => {
    const text = assistant({ input_tokens: 10, output_tokens: 2 })
    expect(parseSessionJsonl(text, 'f.jsonl')!.opener).toBeUndefined()
  })
})

describe('estimateCost', () => {
  it('applies official per-MTok rates (Opus: $5 input / $25 output)', () => {
    const text = assistant({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, { model: 'claude-opus-4-8' })
    const data = parseSessionJsonl(text, 'f.jsonl')!
    // 1 MTok input @ $5 + 1 MTok output @ $25 = $30.
    expect(estimateCost(data)).toBeCloseTo(30)
  })

  it('charges nothing for synthetic (non-billable) turns', () => {
    const text = assistant({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, { model: '<synthetic>' })
    const data = parseSessionJsonl(text, 'f.jsonl')!
    expect(estimateCost(data)).toBe(0)
  })

  it('memoizes by object identity (cached result survives later entry mutation)', () => {
    const text = assistant({ input_tokens: 1_000_000, output_tokens: 0 }, { model: 'claude-opus-4-8' })
    const data = parseSessionJsonl(text, 'f.jsonl')!
    const first = estimateCost(data)
    expect(first).toBeCloseTo(5)
    // Mutate the entries after the first call. Without the WeakMap cache the
    // recomputed cost would double; the cache (keyed by `data` identity)
    // returns the memoized value, proving the cached path is taken.
    data.entries.push({ ...data.entries[0] })
    expect(estimateCost(data)).toBe(first)
  })
})
