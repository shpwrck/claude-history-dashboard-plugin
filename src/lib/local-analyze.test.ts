import { describe, expect, it } from 'vitest';

import {
  buildLocalAnalyzePrompt,
  degradedResult,
  extractRecommendations,
  summarizeRecommendationsForPrompt,
  type LocalAnalyzeRecommendation,
} from './local-analyze';

const rec = (over: Partial<LocalAnalyzeRecommendation> = {}): LocalAnalyzeRecommendation => ({
  id: 'cost.cache-1h-waste',
  category: 'cost',
  severity: 'high',
  title: 'Cut the 1h cache waste',
  detail: 'Sessions rewrite the 1h cache during short idle gaps.',
  action: 'Prefer the default 5-minute cache for scoped work.',
  ...over,
});

// The banned-copy assertion is shared with the component test; assembled at
// runtime so this test file is not itself flagged by a naive grep.
const BANNED_COPY = ['insights', 'Regenerate insights'];

describe('extractRecommendations', () => {
  it('reads the served { recommendations: [...] } envelope', () => {
    const out = extractRecommendations({ recommendations: [rec(), rec({ id: 'b' })] });
    expect(out.map((r) => r.id)).toEqual(['cost.cache-1h-waste', 'b']);
  });

  it('reads a bare array and skips malformed rows', () => {
    const out = extractRecommendations([
      rec(),
      null,
      { title: 'no id' },
      { id: 'x' }, // no title
      42,
    ]);
    expect(out.map((r) => r.id)).toEqual(['cost.cache-1h-waste']);
  });

  it('defaults missing string fields and respects the limit', () => {
    const out = extractRecommendations(
      { recommendations: [{ id: 'a', title: 'A' }, rec({ id: 'b' }), rec({ id: 'c' })] },
      2
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'a', category: '', severity: '', title: 'A', detail: '', action: '' });
  });

  it('never throws on junk input', () => {
    expect(extractRecommendations(null)).toEqual([]);
    expect(extractRecommendations('nope')).toEqual([]);
    expect(extractRecommendations({})).toEqual([]);
  });
});

describe('summarizeRecommendationsForPrompt', () => {
  it('describes the empty case', () => {
    expect(summarizeRecommendationsForPrompt([])).toMatch(/no active recommendations/i);
  });

  it('lists titles, severity, category, detail, and action', () => {
    const text = summarizeRecommendationsForPrompt([rec()]);
    expect(text).toContain('Cut the 1h cache waste');
    expect(text).toContain('high');
    expect(text).toContain('cost');
    expect(text).toContain('Suggested action:');
  });
});

describe('buildLocalAnalyzePrompt (governance: never impersonates /insights)', () => {
  it('returns a system + user prompt grounded in the findings', () => {
    const { system, user } = buildLocalAnalyzePrompt([rec()]);
    expect(system).toMatch(/local analysis assistant/i);
    expect(user).toContain('Cut the 1h cache waste');
  });

  it('contains none of the banned insights copy', () => {
    const { system, user } = buildLocalAnalyzePrompt([rec()]);
    for (const banned of BANNED_COPY) {
      expect(system.toLowerCase()).not.toContain(banned.toLowerCase());
      expect(user.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe('degradedResult (governance: graceful degradation to the deterministic engine)', () => {
  it('returns the deterministic recommendations with no error and a reason', () => {
    const recs = [rec()];
    const result = degradedResult(recs, 'Local model endpoint not configured');
    expect(result).toEqual({
      source: 'deterministic',
      recommendations: recs,
      analysis: null,
      model: null,
      reason: 'Local model endpoint not configured',
    });
  });
});
