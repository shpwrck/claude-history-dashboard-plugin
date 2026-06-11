import { describe, it, expect } from 'vitest'
import { parseSessionTitles } from './parse-titles'

const line = (o: Record<string, unknown>) => JSON.stringify(o)

describe('parseSessionTitles', () => {
  it('maps ai-title lines by sessionId', () => {
    const text = line({ type: 'ai-title', aiTitle: 'Auto title', sessionId: 's1' })
    expect(parseSessionTitles(text)).toEqual({ s1: 'Auto title' })
  })

  it('prefers a custom-title over an ai-title for the same session', () => {
    const text = [
      line({ type: 'ai-title', aiTitle: 'Auto', sessionId: 's1' }),
      line({ type: 'custom-title', customTitle: 'Mine', sessionId: 's1' }),
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s1: 'Mine' })
  })

  it('lets custom win even when the ai-title appears later in the file', () => {
    const text = [
      line({ type: 'custom-title', customTitle: 'Mine', sessionId: 's1' }),
      line({ type: 'ai-title', aiTitle: 'Auto', sessionId: 's1' }),
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s1: 'Mine' })
  })

  it('keeps the last non-empty value within a kind', () => {
    const text = [
      line({ type: 'ai-title', aiTitle: 'First', sessionId: 's1' }),
      line({ type: 'ai-title', aiTitle: 'Second', sessionId: 's1' }),
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s1: 'Second' })
  })

  it('ignores empty/whitespace-only titles and trims kept ones', () => {
    const text = [
      line({ type: 'ai-title', aiTitle: '   ', sessionId: 's1' }),
      line({ type: 'ai-title', aiTitle: '  Trimmed  ', sessionId: 's2' }),
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s2: 'Trimmed' })
  })

  it('skips malformed JSON lines and lines without a sessionId', () => {
    const text = [
      'not json',
      line({ type: 'ai-title', aiTitle: 'No session' }),
      line({ type: 'ai-title', aiTitle: 'Kept', sessionId: 's1' }),
      '',
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s1: 'Kept' })
  })

  it('returns an empty map for empty input', () => {
    expect(parseSessionTitles('')).toEqual({})
  })

  it('tracks multiple sessions independently', () => {
    const text = [
      line({ type: 'ai-title', aiTitle: 'A', sessionId: 's1' }),
      line({ type: 'custom-title', customTitle: 'B', sessionId: 's2' }),
    ].join('\n')
    expect(parseSessionTitles(text)).toEqual({ s1: 'A', s2: 'B' })
  })
})
