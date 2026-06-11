import { describe, it, expect } from 'vitest'
import { parseMessage, summarize, MAX_SUMMARY } from './parse-utils'

describe('parseMessage', () => {
  it('returns null for null/undefined', () => {
    expect(parseMessage(null)).toBeNull()
    expect(parseMessage(undefined)).toBeNull()
  })

  it('returns an object value as-is', () => {
    const obj = { content: 'hi' }
    expect(parseMessage(obj)).toBe(obj)
  })

  it('parses a JSON-encoded string', () => {
    expect(parseMessage('{"content":"hi"}')).toEqual({ content: 'hi' })
  })

  it('returns null on invalid JSON string', () => {
    expect(parseMessage('not json')).toBeNull()
  })

  it('does not corrupt single-quoted content (no quote rewriting)', () => {
    // Regression: an earlier version replaced ' with " before parsing,
    // which broke Bash commands containing single quotes.
    const raw = JSON.stringify({ content: "echo 'hello world'" })
    expect(parseMessage(raw)).toEqual({ content: "echo 'hello world'" })
  })

  it('returns null for non-object, non-string values', () => {
    expect(parseMessage(42)).toBeNull()
    expect(parseMessage(true)).toBeNull()
  })
})

describe('summarize', () => {
  it('collapses newlines to single spaces and trims', () => {
    expect(summarize('  a\nb\r\nc  ')).toBe('a b c')
  })

  it('returns short strings unchanged', () => {
    expect(summarize('short')).toBe('short')
  })

  it('truncates to MAX_SUMMARY by default', () => {
    const long = 'x'.repeat(MAX_SUMMARY + 50)
    expect(summarize(long)).toHaveLength(MAX_SUMMARY)
  })

  it('honors a custom max', () => {
    expect(summarize('abcdef', 3)).toBe('abc')
  })

  it('trims before measuring against max', () => {
    expect(summarize('   abc   ', 3)).toBe('abc')
  })
})
