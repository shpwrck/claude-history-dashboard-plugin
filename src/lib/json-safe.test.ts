/**
 * JSON export validity tests (#1104, epic #866).
 *
 * Proves the served-JSON helper produces output that strict (non-JS) parsers
 * accept: no lone-surrogate `\udXXX` escapes survive, paired emoji are kept, and
 * the payload still round-trips through JSON.parse.
 */
import { describe, it, expect } from 'vitest';
import { scrubLoneSurrogates, safeJsonStringify } from './json-safe';

const LONE_HIGH = '\uD800';
const LONE_LOW = '\uDC00';
const GRINNING = '😀'; // 😀 — a correctly paired surrogate

describe('scrubLoneSurrogates', () => {
  it('replaces a lone high surrogate with U+FFFD', () => {
    expect(scrubLoneSurrogates(`a${LONE_HIGH}b`)).toBe('a�b');
  });
  it('replaces a lone low surrogate with U+FFFD', () => {
    expect(scrubLoneSurrogates(`a${LONE_LOW}b`)).toBe('a�b');
  });
  it('preserves a correctly paired surrogate (emoji)', () => {
    expect(scrubLoneSurrogates(`hi ${GRINNING}`)).toBe(`hi ${GRINNING}`);
  });
  it('leaves plain text untouched', () => {
    expect(scrubLoneSurrogates('normal text 123')).toBe('normal text 123');
  });
  it('scrubs a high surrogate immediately followed by a non-low char', () => {
    expect(scrubLoneSurrogates(`${LONE_HIGH}x`)).toBe('�x');
  });
});

describe('safeJsonStringify', () => {
  it('produces output with no lone-surrogate escape (strict-parser-safe)', () => {
    const out = safeJsonStringify({ note: `truncated emoji ${LONE_HIGH} here`, ok: GRINNING });
    // JSON.stringify well-forms lone surrogates into \udXXX; after scrubbing
    // none remain, and paired emoji serialize as the literal char, not an escape.
    expect(/\\ud[0-9a-f]{3}/i.test(out)).toBe(false);
  });

  it('round-trips through JSON.parse with the lone surrogate replaced', () => {
    const out = safeJsonStringify({ a: `x${LONE_LOW}y`, nested: { b: [LONE_HIGH] } });
    const parsed = JSON.parse(out);
    expect(parsed.a).toBe('x�y');
    expect(parsed.nested.b[0]).toBe('�');
  });

  it('scrubs data-derived object keys as well as values', () => {
    const out = safeJsonStringify({ [`agent${LONE_HIGH}`]: `skill${LONE_LOW}` });
    expect(/\\ud[0-9a-f]{3}/i.test(out)).toBe(false);
    expect(JSON.parse(out)).toEqual({ 'agent�': 'skill�' });
  });

  it('preserves paired emoji through a round trip', () => {
    const parsed = JSON.parse(safeJsonStringify({ msg: `done ${GRINNING}` }));
    expect(parsed.msg).toBe(`done ${GRINNING}`);
  });

  it('matches JSON.stringify for surrogate-free input', () => {
    const value = { n: 1, s: 'clean', arr: [true, null, 'x'], obj: { k: 'v' } };
    expect(safeJsonStringify(value)).toBe(JSON.stringify(value));
  });

  it('preserves normal toJSON behavior for surrogate-free objects', () => {
    const value = { date: new Date('2026-06-10T00:00:00.000Z') };
    expect(safeJsonStringify(value)).toBe(JSON.stringify(value));
  });

  it('keeps a dataset-shaped payload parseable even with lone surrogates in nested string leaves', () => {
    const dataset = {
      generatedAt: '2026-06-10',
      sessions: [{ id: 's1', title: `weird ${LONE_HIGH}${LONE_LOW} title` }],
      recommendations: [{ id: 'r1', detail: `note ${LONE_LOW}` }],
    };
    expect(() => JSON.parse(safeJsonStringify(dataset))).not.toThrow();
    expect(/\\ud[0-9a-f]{3}/i.test(safeJsonStringify(dataset))).toBe(false);
  });
});
