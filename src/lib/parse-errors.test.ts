import { describe, it, expect } from 'vitest'
import {
  aggregateToolErrors,
  detectRetryGroups,
  parseApiErrors,
  aggregateApiErrorStatuses,
  aggregateRetryPressure,
  detectErrorRetrySequences,
  type ApiErrorEvent,
} from './parse-errors'
import type { ToolCall, ToolUsageData } from './parse-tools'

// --- fixture helpers --------------------------------------------------------

// A ToolCall with sensible defaults; override what each test cares about.
const call = (o: Partial<ToolCall> = {}): ToolCall => ({
  timestamp: o.timestamp ?? '2026-01-01T00:00:00.000Z',
  toolName: o.toolName ?? 'Bash',
  input: o.input ?? {},
  toolUseId: o.toolUseId ?? 'tu',
  isError: o.isError ?? null,
  resultBytes: o.resultBytes ?? 0,
})

const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({
  sessionId,
  calls,
})

// One JSONL transcript line (already JSON-stringified).
const line = (obj: Record<string, unknown>): string => JSON.stringify(obj)

// --- aggregateToolErrors ----------------------------------------------------

describe('aggregateToolErrors', () => {
  it('returns an empty array for no data', () => {
    expect(aggregateToolErrors([])).toEqual([])
  })

  it('counts total and error calls per tool and computes errorRate', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', isError: true }),
        call({ toolName: 'Bash', isError: false }),
        call({ toolName: 'Bash', isError: null }),
        call({ toolName: 'Read', isError: false }),
      ]),
    ]
    const out = aggregateToolErrors(data)
    const bash = out.find((s) => s.toolName === 'Bash')!
    const read = out.find((s) => s.toolName === 'Read')!
    expect(bash.totalCalls).toBe(3)
    // Only isError === true counts; null is not an error.
    expect(bash.errorCalls).toBe(1)
    expect(bash.errorRate).toBeCloseTo(1 / 3)
    expect(read.totalCalls).toBe(1)
    expect(read.errorCalls).toBe(0)
    expect(read.errorRate).toBe(0)
  })

  it('aggregates the same tool across sessions', () => {
    const data = [
      session('s1', [call({ toolName: 'Edit', isError: true })]),
      session('s2', [call({ toolName: 'Edit', isError: false })]),
    ]
    const [edit] = aggregateToolErrors(data)
    expect(edit.totalCalls).toBe(2)
    expect(edit.errorCalls).toBe(1)
    expect(edit.errorRate).toBeCloseTo(0.5)
  })

  it('sorts by errorRate desc, then by errorCalls desc as a tiebreak', () => {
    const data = [
      session('s1', [
        // Grep: rate 1.0 (1/1)
        call({ toolName: 'Grep', isError: true }),
        // Bash: rate 0.5, 2 error calls
        call({ toolName: 'Bash', isError: true }),
        call({ toolName: 'Bash', isError: true }),
        call({ toolName: 'Bash', isError: false }),
        call({ toolName: 'Bash', isError: false }),
        // Read: rate 0.5, 1 error call
        call({ toolName: 'Read', isError: true }),
        call({ toolName: 'Read', isError: false }),
      ]),
    ]
    const out = aggregateToolErrors(data)
    expect(out.map((s) => s.toolName)).toEqual(['Grep', 'Bash', 'Read'])
  })
})

// --- detectRetryGroups ------------------------------------------------------

describe('detectRetryGroups', () => {
  it('returns an empty array for no data', () => {
    expect(detectRetryGroups([])).toEqual([])
  })

  it('groups consecutive same-tool calls within the gap window', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:30.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:55.000Z' }),
      ]),
    ]
    const groups = detectRetryGroups(data)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      sessionId: 's1',
      toolName: 'Bash',
      count: 3,
      startTimestamp: '2026-01-01T00:00:00.000Z',
      endTimestamp: '2026-01-01T00:00:55.000Z',
      hasErrors: false,
    })
  })

  it('does not emit a group for a single call', () => {
    const data = [session('s1', [call({ toolName: 'Bash' })])]
    expect(detectRetryGroups(data)).toEqual([])
  })

  it('breaks a run when the gap exceeds gapSec', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:30.000Z' }),
        // 2-minute gap > default 60s -> breaks the run; this call is alone.
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:02:30.000Z' }),
      ]),
    ]
    const groups = detectRetryGroups(data)
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
  })

  it('breaks a run when the tool changes', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:10.000Z' }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:20.000Z' }),
      ]),
    ]
    const groups = detectRetryGroups(data)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ toolName: 'Read', count: 2 })
  })

  it('sets hasErrors when any call in the run errored', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z', isError: false }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:10.000Z', isError: true }),
      ]),
    ]
    expect(detectRetryGroups(data)[0].hasErrors).toBe(true)
  })

  it('drops unparseable timestamps and sorts groups by count desc', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Read', timestamp: 'not-a-date' }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:10.000Z' }),
      ]),
      session('s2', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:10.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:20.000Z' }),
      ]),
    ]
    const groups = detectRetryGroups(data)
    expect(groups).toHaveLength(2)
    // s2 has 3 (sorted first), s1 has 2 after dropping the bad-timestamp row.
    expect(groups[0]).toMatchObject({ sessionId: 's2', count: 3 })
    expect(groups[1]).toMatchObject({ sessionId: 's1', count: 2 })
  })

  it('honors a custom gapSec', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z' }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:01:30.000Z' }),
      ]),
    ]
    // 90s gap: broken at default 60s, joined at 120s.
    expect(detectRetryGroups(data)).toEqual([])
    expect(detectRetryGroups(data, 120)).toHaveLength(1)
  })
})

// --- parseApiErrors ---------------------------------------------------------

describe('parseApiErrors', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(parseApiErrors('', 'abc.jsonl')).toEqual([])
    expect(parseApiErrors('   \n  ', 'abc.jsonl')).toEqual([])
  })

  it('skips malformed JSON lines and lines without a timestamp', () => {
    const text = [
      'not json',
      line({ type: 'system', subtype: 'api_error', error: { status: 529 } }), // no timestamp
    ].join('\n')
    expect(parseApiErrors(text, 'abc.jsonl')).toEqual([])
  })

  it('derives sessionId from the filename (strips .jsonl)', () => {
    const text = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: '2026-01-01T00:00:00.000Z',
      error: { status: 429 },
    })
    expect(parseApiErrors(text, 'session-xyz.jsonl')[0].sessionId).toBe('session-xyz')
  })

  it('parses a native api_error: status, cause, level, retry telemetry, and the deeply nested message', () => {
    // The real payload lives at error.error.error.{type,message} (see #73).
    const text = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'error',
      retryInMs: 2000,
      retryAttempt: 2,
      maxRetries: 5,
      error: {
        status: 529,
        cause: { code: 'ECONNRESET' },
        error: { error: { type: 'overloaded_error', message: 'Overloaded' } },
      },
    })
    const [e] = parseApiErrors(text, 'f.jsonl')
    expect(e.source).toBe('native')
    expect(e.status).toBe(529)
    expect(e.causeCode).toBe('ECONNRESET')
    expect(e.level).toBe('error')
    expect(e.retryInMs).toBe(2000)
    expect(e.retryAttempt).toBe(2)
    expect(e.maxRetries).toBe(5)
    // summary prefers the inner message, prefixed with the status code.
    expect(e.summary).toBe('529 Overloaded')
  })

  it('prefers a top-level cause.code over the nested error.cause.code', () => {
    const text = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: 't1',
      cause: { code: 'TopLevelCause' },
      error: { cause: { code: 'NestedCause' } },
    })
    expect(parseApiErrors(text, 'f.jsonl')[0].causeCode).toBe('TopLevelCause')
  })

  it('falls back through summary tiers: inner type, then cause, then HTTP status, then generic', () => {
    const innerType = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: 't',
      error: { status: 400, error: { error: { type: 'invalid_request_error' } } },
    })
    expect(parseApiErrors(innerType, 'f.jsonl')[0].summary).toBe('400 invalid_request_error')

    const causeOnly = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: 't',
      cause: { code: 'ConnectionRefused' },
    })
    expect(parseApiErrors(causeOnly, 'f.jsonl')[0].summary).toBe('ConnectionRefused')

    const statusOnly = line({
      type: 'system',
      subtype: 'api_error',
      timestamp: 't',
      error: { status: 503 },
    })
    expect(parseApiErrors(statusOnly, 'f.jsonl')[0].summary).toBe('HTTP 503')

    const bare = line({ type: 'system', subtype: 'api_error', timestamp: 't' })
    const bareEvt = parseApiErrors(bare, 'f.jsonl')[0]
    expect(bareEvt.summary).toBe('API Error')
    expect(bareEvt.status).toBeUndefined()
    expect(bareEvt.causeCode).toBeUndefined()
  })

  it('parses an isApiErrorMessage line, extracting content text', () => {
    const text = line({
      type: 'user',
      timestamp: 't',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'rate limit exceeded' }] },
    })
    const [e] = parseApiErrors(text, 'f.jsonl')
    expect(e.source).toBe('text')
    expect(e.summary).toBe('rate limit exceeded')
  })

  it('uses the "API Error" placeholder when an isApiErrorMessage line has no extractable content', () => {
    const text = line({
      type: 'user',
      timestamp: 't',
      isApiErrorMessage: true,
      message: { content: [] },
    })
    expect(parseApiErrors(text, 'f.jsonl')[0].summary).toBe('API Error')
  })

  it('parses a top-level string error field', () => {
    const text = line({ type: 'assistant', timestamp: 't', error: 'kaboom' })
    const [e] = parseApiErrors(text, 'f.jsonl')
    expect(e.source).toBe('text')
    expect(e.summary).toBe('kaboom')
  })

  it('JSON-stringifies a non-string top-level error for the summary', () => {
    const text = line({ type: 'assistant', timestamp: 't', error: { code: 42 } })
    expect(parseApiErrors(text, 'f.jsonl')[0].summary).toBe('{"code":42}')
  })

  it('matches a type=user content string starting with "API Error" or "Error:"', () => {
    const apiErr = line({
      type: 'user',
      timestamp: 't',
      message: { content: 'API Error: 500 internal' },
    })
    const errColon = line({
      type: 'user',
      timestamp: 't',
      message: { content: [{ type: 'text', text: 'Error: boom' }] },
    })
    expect(parseApiErrors(apiErr, 'f.jsonl')[0].summary).toBe('API Error: 500 internal')
    expect(parseApiErrors(errColon, 'f.jsonl')[0].summary).toBe('Error: boom')
  })

  it('ignores a normal type=user content string that is not an error', () => {
    const text = line({
      type: 'user',
      timestamp: 't',
      message: { content: 'just a normal message' },
    })
    expect(parseApiErrors(text, 'f.jsonl')).toEqual([])
  })

  it('parses a message delivered as a JSON-encoded string', () => {
    const text = line({
      type: 'user',
      timestamp: 't',
      message: JSON.stringify({ content: [{ type: 'text', text: 'Error: stringified' }] }),
    })
    expect(parseApiErrors(text, 'f.jsonl')[0].summary).toBe('Error: stringified')
  })
})

// --- aggregateApiErrorStatuses ----------------------------------------------

describe('aggregateApiErrorStatuses', () => {
  it('returns an empty array for no events', () => {
    expect(aggregateApiErrorStatuses([])).toEqual([])
  })

  it('groups by HTTP status, counting occurrences and distinct sessions', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', status: 529 },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', status: 529 },
      { sessionId: 's2', timestamp: 't', summary: '', source: 'native', status: 529 },
    ]
    const [row] = aggregateApiErrorStatuses(events)
    expect(row.code).toBe('529')
    expect(row.isHttpStatus).toBe(true)
    expect(row.count).toBe(3)
    expect(row.sessionCount).toBe(2)
  })

  it('falls back to causeCode, then "unknown" for native events without a code', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', causeCode: 'ECONNRESET' },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native' },
    ]
    const out = aggregateApiErrorStatuses(events)
    const cause = out.find((r) => r.code === 'ECONNRESET')!
    const unknown = out.find((r) => r.code === 'unknown')!
    expect(cause.isHttpStatus).toBe(false)
    expect(cause.count).toBe(1)
    expect(unknown.count).toBe(1)
    expect(unknown.isHttpStatus).toBe(false)
  })

  it('skips text-matched fallback events that carry no structured code', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: 'whatever', source: 'text' },
    ]
    expect(aggregateApiErrorStatuses(events)).toEqual([])
  })

  it('sorts rows by count desc', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', status: 429 },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', status: 529 },
      { sessionId: 's2', timestamp: 't', summary: '', source: 'native', status: 529 },
    ]
    expect(aggregateApiErrorStatuses(events).map((r) => r.code)).toEqual(['529', '429'])
  })
})

// --- aggregateRetryPressure -------------------------------------------------

describe('aggregateRetryPressure', () => {
  it('returns zeroed stats (no maxRetries) for no events', () => {
    expect(aggregateRetryPressure([])).toEqual({
      retryEvents: 0,
      totalBackoffMs: 0,
      maxAttempt: 0,
      maxRetries: undefined,
    })
  })

  it('sums backoff, tracks the deepest attempt, and the configured cap', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', retryInMs: 1000, retryAttempt: 1, maxRetries: 5 },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', retryInMs: 2000, retryAttempt: 3, maxRetries: 5 },
    ]
    expect(aggregateRetryPressure(events)).toEqual({
      retryEvents: 2,
      totalBackoffMs: 3000,
      maxAttempt: 3,
      maxRetries: 5,
    })
  })

  it('counts an event with only one of retryInMs / retryAttempt present', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', retryAttempt: 2 },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', retryInMs: 500 },
    ]
    const out = aggregateRetryPressure(events)
    expect(out.retryEvents).toBe(2)
    expect(out.totalBackoffMs).toBe(500)
    expect(out.maxAttempt).toBe(2)
    expect(out.maxRetries).toBeUndefined()
  })

  it('ignores events carrying neither retry field (e.g. text fallbacks)', () => {
    const events: ApiErrorEvent[] = [
      { sessionId: 's1', timestamp: 't', summary: 'x', source: 'text' },
      { sessionId: 's1', timestamp: 't', summary: '', source: 'native', status: 529 },
    ]
    expect(aggregateRetryPressure(events)).toEqual({
      retryEvents: 0,
      totalBackoffMs: 0,
      maxAttempt: 0,
      maxRetries: undefined,
    })
  })
})

// --- detectErrorRetrySequences ----------------------------------------------

describe('detectErrorRetrySequences', () => {
  it('returns an empty array for no data', () => {
    expect(detectErrorRetrySequences([])).toEqual([])
  })

  it('detects an errored call immediately followed by a same-tool call', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:00.000Z', isError: true }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:05.000Z', isError: false }),
      ]),
    ]
    const out = detectErrorRetrySequences(data)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ label: 'Read', toolName: 'Read', count: 1 })
  })

  it('does not fire when the errored call is followed by a different tool', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:00.000Z', isError: true }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:05.000Z' }),
      ]),
    ]
    expect(detectErrorRetrySequences(data)).toEqual([])
  })

  it('does not fire when the first call did not error', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:00.000Z', isError: false }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:05.000Z', isError: false }),
      ]),
    ]
    expect(detectErrorRetrySequences(data)).toEqual([])
  })

  it('keys Bash retries on the first line of the command so identical commands roll up', () => {
    const data = [
      session('s1', [
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:00.000Z', isError: true, input: { command: 'npm test\n# comment' } }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:05.000Z', isError: true, input: { command: 'npm test\n# comment' } }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:00:10.000Z', isError: false, input: { command: 'npm test\n# comment' } }),
      ]),
    ]
    const out = detectErrorRetrySequences(data)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ label: 'npm test', toolName: 'Bash', count: 2 })
  })

  it('sorts results by count descending', () => {
    const data = [
      session('s1', [
        // Read retried once
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:00.000Z', isError: true }),
        call({ toolName: 'Read', timestamp: '2026-01-01T00:00:05.000Z', isError: false }),
        // Bash `ls` retried twice
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:01:00.000Z', isError: true, input: { command: 'ls' } }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:01:05.000Z', isError: true, input: { command: 'ls' } }),
        call({ toolName: 'Bash', timestamp: '2026-01-01T00:01:10.000Z', isError: false, input: { command: 'ls' } }),
      ]),
    ]
    const out = detectErrorRetrySequences(data)
    expect(out.map((s) => [s.label, s.count])).toEqual([
      ['ls', 2],
      ['Read', 1],
    ])
  })
})
