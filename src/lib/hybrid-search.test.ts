import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../types';
import {
  getSearchIndex,
  hybridSearchEntries,
  MAX_INDEXED_TEXT_CHARS,
} from './hybrid-search';

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

describe('search index caching and bounds (#3129)', () => {
  it('caches the index per entries array and memoizes semantic vectors across queries', () => {
    const entries = [
      entry('OAuth credential refresh failed during token renewal', 'sess-1'),
      entry('Deploy the dashboard container to the cluster', 'sess-2'),
    ];
    const index = getSearchIndex(entries);
    expect(getSearchIndex(entries)).toBe(index);

    hybridSearchEntries(entries, 'login problem');
    const vectors = index.map((indexed) => indexed.vector);
    expect(vectors.every((vector) => vector !== null)).toBe(true);

    // A repeated query over the unchanged corpus must not rebuild vectors.
    hybridSearchEntries(entries, 'deploy container');
    index.forEach((indexed, i) => expect(indexed.vector).toBe(vectors[i]));

    // A different array identity is a different dataset -> fresh index.
    expect(getSearchIndex([...entries])).not.toBe(index);
  });

  it('bounds indexed text per entry so oversized pasted content cannot balloon per-query work', () => {
    const oversized = 'diagnostic output line\n'.repeat(50_000); // ~1.1M chars
    const entries = [
      entry('big paste', 'sess-1', {
        pastedContents: { '1': { id: 1, type: 'text', content: oversized } },
      }),
    ];
    const [indexed] = getSearchIndex(entries);
    expect(indexed.text.length).toBeLessThanOrEqual(MAX_INDEXED_TEXT_CHARS);
    expect(indexed.lowerText.length).toBeLessThanOrEqual(MAX_INDEXED_TEXT_CHARS);
  });

  it('keeps top-K selection identical to a full sort: best first, capped at the limit, stable ties', () => {
    const entries = Array.from({ length: 120 }, (_, i) =>
      entry(
        i === 50 ? 'deploy failure in rollout' : 'deploy the service',
        `sess-${i}`
      )
    );
    const results = hybridSearchEntries(entries, 'deploy failure');
    expect(results).toHaveLength(100);
    // The exact-phrase entry outranks the token-overlap-only matches.
    expect(results[0].entry.sessionId).toBe('sess-50');
    // Equal-score matches keep their original (index) order — the same
    // score-desc, index-asc comparator the full sort used.
    const rest = results.slice(1).map((result) => result.entry.sessionId);
    const expected = Array.from({ length: 120 }, (_, i) => `sess-${i}`)
      .filter((id) => id !== 'sess-50')
      .slice(0, 99);
    expect(rest).toEqual(expected);
  });

  it('large-corpus probe: repeated queries reuse the index within the documented budget', () => {
    const corpus = Array.from({ length: 4_000 }, (_, i) =>
      entry(
        i % 7 === 0
          ? `deploy container rollout attempt ${i}`
          : `unrelated topic number ${i}`,
        `sess-${i}`,
        {
          pastedContents: {
            '1': {
              id: 1,
              type: 'text',
              content: 'some pasted diagnostic output '.repeat(20),
            },
          },
        }
      )
    );

    // First query pays the one-time index build. Budgets are deliberately
    // generous for loaded CI runners; the point is the ORDER of magnitude —
    // repeated queries must not redo the per-entry concatenate/tokenize/embed.
    const buildStart = performance.now();
    const first = hybridSearchEntries(corpus, 'deploy failure');
    const buildMs = performance.now() - buildStart;

    const repeatStart = performance.now();
    for (let i = 0; i < 5; i += 1) hybridSearchEntries(corpus, 'deploy failure');
    const repeatMs = (performance.now() - repeatStart) / 5;

    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(100);
    expect(buildMs).toBeLessThan(5_000);
    expect(repeatMs).toBeLessThan(1_000);
  });
});
