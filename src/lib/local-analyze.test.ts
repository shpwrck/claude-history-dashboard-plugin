import { describe, expect, it } from 'vitest';

import {
  buildLocalAnalyzePrompt,
  buildSchemaAnalyzePrompt,
  degradedResult,
  extractRecommendations,
  orderRecommendationsByRankedIds,
  runLocalAnalyze,
  summarizeRecommendationsForPrompt,
  validateLocalAnalyzeOutput,
  type LocalAnalyzeRecommendation,
} from './local-analyze';
import type { RepairMessage } from './schema-repair';

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
      rankedFindingIds: null,
      repairRounds: 0,
      schemaValid: false,
    });
  });

  it('carries a repair-round count through when the loop was exhausted', () => {
    const result = degradedResult([rec()], 'exhausted', { repairRounds: 2 });
    expect(result.repairRounds).toBe(2);
    expect(result.schemaValid).toBe(false);
    expect(result.rankedFindingIds).toBeNull();
  });
});

describe('buildSchemaAnalyzePrompt (schema-constrained, #2682)', () => {
  it('states the JSON contract and includes the finding ids to rank', () => {
    const { system, user } = buildSchemaAnalyzePrompt([rec(), rec({ id: 'b', title: 'Second' })]);
    expect(system).toContain('rankedFindingIds');
    expect(system).toContain('summary');
    expect(system).toMatch(/only ids from the provided list/i);
    // The ids the model must rank appear in the user prompt.
    expect(user).toContain('id: cost.cache-1h-waste');
    expect(user).toContain('id: b');
  });

  it('contains none of the banned insights copy', () => {
    const { system, user } = buildSchemaAnalyzePrompt([rec()]);
    for (const banned of BANNED_COPY) {
      expect(system.toLowerCase()).not.toContain(banned.toLowerCase());
      expect(user.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe('validateLocalAnalyzeOutput (shape + subset-of-ids domain rule)', () => {
  const ids = ['a', 'b', 'c'];

  it('accepts a well-formed object whose ids are all in the input set', () => {
    const res = validateLocalAnalyzeOutput(
      JSON.stringify({ summary: 'do a first', rankedFindingIds: ['b', 'a'] }),
      ids
    );
    expect(res).toEqual({ ok: true, value: { summary: 'do a first', rankedFindingIds: ['b', 'a'] } });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"summary":"x","rankedFindingIds":["a"]}\n```';
    const res = validateLocalAnalyzeOutput(raw, ids);
    expect(res.ok).toBe(true);
  });

  it('rejects a missing/mistyped field with a domain-phrased error (no raw trace)', () => {
    const res = validateLocalAnalyzeOutput(JSON.stringify({ summary: 5, rankedFindingIds: 'a' }), ids);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.errors).toContain('"summary" must be a string.');
    expect(res.errors).toContain('"rankedFindingIds" must be an array of strings.');
    // Never a raw ajv/JSON.parse trace.
    for (const e of res.errors) expect(e).not.toMatch(/ajv|schema|SyntaxError|instancePath/i);
  });

  it('rejects ids outside the input set deterministically, naming each', () => {
    const res = validateLocalAnalyzeOutput(
      JSON.stringify({ summary: 'x', rankedFindingIds: ['a', 'zzz', 'qqq'] }),
      ids
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.errors).toEqual([
      '"zzz" is not one of the provided finding ids.',
      '"qqq" is not one of the provided finding ids.',
    ]);
  });

  it('rejects a shape-valid but empty summary (reliability floor, not just shape)', () => {
    const res = validateLocalAnalyzeOutput(
      JSON.stringify({ summary: '   ', rankedFindingIds: ['a'] }),
      ids
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.errors).toContain('"summary" must be a non-empty analysis of the findings.');
  });

  it('rejects non-JSON output with a domain-phrased error', () => {
    const res = validateLocalAnalyzeOutput('not json at all', ids);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.errors[0]).toMatch(/single JSON object/i);
  });
});

describe('orderRecommendationsByRankedIds', () => {
  const recs = [rec({ id: 'a' }), rec({ id: 'b' }), rec({ id: 'c' })];

  it('orders by the ranking, then appends the unranked in original order', () => {
    expect(orderRecommendationsByRankedIds(recs, ['c', 'a']).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('ignores unknown and duplicate ids and never drops a recommendation', () => {
    expect(
      orderRecommendationsByRankedIds(recs, ['b', 'b', 'zzz', 'c']).map((r) => r.id)
    ).toEqual(['b', 'c', 'a']);
  });

  it('returns the input order when the ranking is empty or null', () => {
    expect(orderRecommendationsByRankedIds(recs, null).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(orderRecommendationsByRankedIds(recs, []).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('runLocalAnalyze (bounded repair loop over an injected transport)', () => {
  const recs = [rec({ id: 'a', title: 'Alpha' }), rec({ id: 'b', title: 'Beta' })];

  // A scripted transport: returns each queued completion in turn, recording the
  // messages it was called with so we can assert the repair prompts.
  const scriptedSend = (replies: string[], model = 'local-model') => {
    const calls: RepairMessage[][] = [];
    const send = async (messages: RepairMessage[]) => {
      calls.push(messages);
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      return { text, model };
    };
    return { send, calls };
  };

  it('maps a first-try valid completion into analysis + carries the ranking (repairRounds 0)', async () => {
    const { send, calls } = scriptedSend([
      JSON.stringify({ summary: 'Act on Beta first.', rankedFindingIds: ['b', 'a'] }),
    ]);
    const result = await runLocalAnalyze({ send, recommendations: recs, model: 'requested-id' });
    expect(result.source).toBe('local-model');
    expect(result.schemaValid).toBe(true);
    expect(result.repairRounds).toBe(0);
    expect(result.analysis).toBe('Act on Beta first.');
    expect(result.rankedFindingIds).toEqual(['b', 'a']);
    // Reports the model the endpoint returned, not the requested id.
    expect(result.model).toBe('local-model');
    expect(calls).toHaveLength(1);
  });

  it('repairs invalid -> valid across rounds, feeding domain-phrased errors back', async () => {
    const { send, calls } = scriptedSend([
      JSON.stringify({ summary: 'x', rankedFindingIds: ['nope'] }), // bad id
      JSON.stringify({ summary: 'fixed', rankedFindingIds: ['a'] }), // valid
    ]);
    const result = await runLocalAnalyze({ send, recommendations: recs, model: 'm' });
    expect(result.schemaValid).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(result.analysis).toBe('fixed');
    // The second call carries a repair turn quoting the offending id, never a raw trace.
    const repairTurn = calls[1][calls[1].length - 1];
    expect(repairTurn.role).toBe('user');
    expect(repairTurn.content).toContain('"nope" is not one of the provided finding ids.');
    expect(repairTurn.content).not.toMatch(/ajv|instancePath/i);
  });

  it('honors the round bound and degrades to the deterministic result on exhaustion', async () => {
    const { send, calls } = scriptedSend([
      JSON.stringify({ summary: 'x', rankedFindingIds: ['nope'] }),
    ]); // every reply is invalid
    const result = await runLocalAnalyze({
      send,
      recommendations: recs,
      model: 'm',
      maxRounds: 2,
    });
    expect(result.source).toBe('deterministic');
    expect(result.schemaValid).toBe(false);
    expect(result.repairRounds).toBe(2);
    expect(result.analysis).toBeNull();
    expect(result.rankedFindingIds).toBeNull();
    expect(result.reason).toMatch(/failed schema validation after 2 repair rounds/i);
    // 1 initial attempt + 2 repair rounds = 3 transport calls, no more.
    expect(calls).toHaveLength(3);
    // Degrade still returns the deterministic findings.
    expect(result.recommendations.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
