import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../types';
import { hybridSearchEntries } from './hybrid-search';

function entry(
  display: string,
  sessionId: string,
  overrides: Partial<HistoryEntry> = {}
): HistoryEntry {
  return {
    display,
    pastedContents: {},
    timestamp: Date.parse(`2026-01-0${sessionId.slice(-1)}T12:00:00Z`),
    project: '/repo/app',
    sessionId,
    ...overrides,
  };
}

describe('hybridSearchEntries', () => {
  it('returns semantic matches when the literal query text is absent', () => {
    const results = hybridSearchEntries(
      [
        entry('OAuth credential refresh failed during token renewal', 'sess-1'),
        entry('Improve responsive chart labels on narrow mobile screens', 'sess-2'),
      ],
      'login problem'
    );

    expect(results[0].entry.sessionId).toBe('sess-1');
    expect(results[0].matchType).toBe('semantic');
    expect(results[0].lexicalScore).toBe(0);
    expect(results[0].semanticScore).toBeGreaterThan(0);
  });

  it('keeps the free path full-text only when semantic search is disabled', () => {
    const results = hybridSearchEntries(
      [
        entry('OAuth credential refresh failed during token renewal', 'sess-1'),
        entry('Explain the webpack bundling process', 'sess-2'),
      ],
      'login problem',
      { semanticEnabled: false }
    );

    expect(results).toEqual([]);
  });

  it('filters by project and excludes init/exit entries', () => {
    const results = hybridSearchEntries(
      [
        entry('Deploy the dashboard container', 'sess-1', { project: '/repo/a' }),
        entry('Deploy the dashboard container', 'sess-2', { project: '/repo/b' }),
        entry('init', 'sess-3', { project: '/repo/a' }),
      ],
      'deploy',
      { project: '/repo/a' }
    );

    expect(results.map((result) => result.entry.sessionId)).toEqual(['sess-1']);
  });
});
