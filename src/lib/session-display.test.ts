import { describe, expect, it } from 'vitest';
import type { Session } from '../types';
import {
  buildSessionDisplayMap,
  sessionDisplay,
  sessionFallbackLabel,
  sessionTitle,
  shortSessionId,
} from './session-display';

function session(overrides: Partial<Session>): Session {
  return {
    sessionId: 'abcdef12-0000-0000-0000-000000000000',
    project: '/repo',
    projectShort: 'repo',
    entries: [],
    startTime: 0,
    endTime: 0,
    duration: 0,
    messageCount: 0,
    ...overrides,
  };
}

describe('session display helpers', () => {
  it('uses the session title before entry titles', () => {
    const s = session({
      title: 'Custom session name',
      entries: [
        {
          display: 'hello',
          pastedContents: {},
          timestamp: 0,
          project: '/repo',
          sessionId: 'abcdef12-0000-0000-0000-000000000000',
          title: 'Entry title',
        },
      ],
    });

    expect(sessionTitle(s)).toBe('Custom session name');
    expect(sessionDisplay(s.sessionId, [s])).toEqual({
      label: 'Custom session name',
      title: 'Custom session name',
      isFallbackId: false,
    });
  });

  it('falls back to an entry title when the grouped session has no title', () => {
    const s = session({
      entries: [
        {
          display: 'hello',
          pastedContents: {},
          timestamp: 0,
          project: '/repo',
          sessionId: 'abcdef12-0000-0000-0000-000000000000',
          title: 'Entry title',
        },
      ],
    });

    expect(sessionDisplay(s.sessionId, [s]).label).toBe('Entry title');
  });

  it('falls back to the first meaningful prompt when no title exists', () => {
    const s = session({
      entries: [
        {
          display: 'init',
          pastedContents: {},
          timestamp: 0,
          project: '/repo',
          sessionId: 'abcdef12-0000-0000-0000-000000000000',
        },
        {
          display: '  Explain why deployment failed\n\nwith logs  ',
          pastedContents: {},
          timestamp: 1,
          project: '/repo',
          sessionId: 'abcdef12-0000-0000-0000-000000000000',
        },
      ],
    });

    expect(sessionFallbackLabel(s)).toBe('Explain why deployment failed with logs');
    expect(sessionDisplay(s.sessionId, [s])).toEqual({
      label: 'Explain why deployment failed with logs',
      title: undefined,
      isFallbackId: false,
    });
  });

  it('falls back to the session hash (not a generic untitled label)', () => {
    expect(shortSessionId('abcdef12-0000')).toBe('abcdef12');
    expect(sessionDisplay('abcdef12-0000', [])).toEqual({
      label: 'abcdef12',
      title: undefined,
      isFallbackId: true,
    });
  });

  it('honors a custom truncation for the hash fallback', () => {
    expect(sessionDisplay('abcdef1234-0000', [], 10).label).toBe('abcdef1234');
  });

  it('builds a display map keyed by session id', () => {
    const s = session({ title: 'Named session' });
    const map = buildSessionDisplayMap([s]);

    expect(map.get(s.sessionId)?.label).toBe('Named session');
  });
});
