import { describe, it, expect } from 'vitest';
import { parseShadowCalls, avgTokenDelta, avgCostDelta, shadowCheaper, decidedForFinding } from './parse-shadow-calls';
import { buildRecommendations } from './recommendations';
import type { RecommendationInput } from './recommendations';

/** A ledger line carrying price-aware costUsd on both run blocks (#536). */
const costLine = (
  axis: string,
  winner: 'main' | 'shadow' | 'tie',
  mainTokens: number, mainUsd: number,
  shadowTokens: number, shadowUsd: number
): string =>
  JSON.stringify({
    mode: 'live', axis, judge: { winner },
    main: { tokens: mainTokens, costUsd: mainUsd },
    shadow: { tokens: shadowTokens, costUsd: shadowUsd },
  });

/** One ledger line. winner/tokens optional. */
const line = (
  axis: string,
  mode: 'live' | 'replay',
  winner: 'main' | 'shadow' | 'tie' | null,
  mainTokens?: number,
  shadowTokens?: number
): string =>
  JSON.stringify({
    mode,
    axis,
    judge: winner ? { winner } : undefined,
    main: mainTokens === undefined ? undefined : { tokens: mainTokens },
    shadow: shadowTokens === undefined ? undefined : { tokens: shadowTokens },
  });

/** Empty-but-valid engine input with an optional shadowCalls aggregate. */
const inputWith = (jsonl: string): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  shadowCalls: parseShadowCalls(jsonl),
});

describe('parseShadowCalls', () => {
  it('returns a zeroed aggregate for empty/null input', () => {
    expect(parseShadowCalls(null)).toEqual({ total: 0, byAxis: [] });
    expect(parseShadowCalls('')).toEqual({ total: 0, byAxis: [] });
  });

  it('aggregates per axis with mode + winner + token deltas, skipping malformed lines', () => {
    const jsonl = [
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'replay', 'shadow', 900, 300),
      line('model', 'live', 'main', 100, 500),
      '{ not json',
      line('skills', 'live', 'tie'),
    ].join('\n');

    const agg = parseShadowCalls(jsonl);
    expect(agg.total).toBe(4); // malformed line skipped
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    expect(model.samples).toBe(3);
    expect(model.live).toBe(2);
    expect(model.replay).toBe(1);
    expect(model.shadowWins).toBe(2);
    expect(model.liveShadowWins).toBe(1); // only the live shadow win
    expect(model.mainWins).toBe(1);
    // token deltas: (200-1000) + (300-900) + (500-100) = -1000 over 3 paired
    expect(model.tokenDeltaSum).toBe(-1000);
    expect(avgTokenDelta(model)).toBeCloseTo(-1000 / 3);

    const skills = agg.byAxis.find((a) => a.axis === 'skills')!;
    expect(skills.ties).toBe(1);
    // sorted by axis key
    expect(agg.byAxis.map((a) => a.axis)).toEqual(['model', 'skills']);
  });

  it('aggregates price-aware $ cost deltas, and shadowCheaper prefers $ over tokens (#536)', () => {
    // Shadow uses MORE tokens (1000 vs 500) but is cheaper in $ (0.05 vs 0.30) — the
    // cheaper-tier-model case. Token delta is +500 (looks pricier); $ delta is -0.25.
    const agg = parseShadowCalls(costLine('model', 'tie', 500, 0.30, 1000, 0.05));
    const a = agg.byAxis[0];
    expect(avgTokenDelta(a)).toBe(500);        // raw tokens say shadow is "more"
    expect(avgCostDelta(a)).toBeCloseTo(-0.25); // but $ says shadow is cheaper
    expect(shadowCheaper(a)).toBe(true);        // price-aware verdict wins
  });

  it('shadowCheaper falls back to tokens when no $ data', () => {
    const a = parseShadowCalls(
      JSON.stringify({ mode: 'live', axis: 'prompt', judge: { winner: 'tie' }, main: { tokens: 1000 }, shadow: { tokens: 400 } })
    ).byAxis[0];
    expect(avgCostDelta(a)).toBeNull();
    expect(shadowCheaper(a)).toBe(true); // 400 < 1000
  });

  it('ignores records missing axis or mode', () => {
    const agg = parseShadowCalls([
      JSON.stringify({ mode: 'live', judge: { winner: 'shadow' } }), // no axis
      JSON.stringify({ axis: 'model', judge: { winner: 'shadow' } }), // no mode
    ].join('\n'));
    expect(agg.total).toBe(0);
  });

  it('skips synthetic seed/demo rows so they do not inflate an axis (#570)', () => {
    const jsonl = [
      line('model', 'live', 'shadow', 1000, 200), // 1 genuine row
      // 3 hand-seeded demo rows on the same axis — must NOT be counted.
      JSON.stringify({ mode: 'replay', axis: 'model', synthetic: true, judge: { winner: 'shadow' }, main: { tokens: 9 }, shadow: { tokens: 9 } }),
      JSON.stringify({ mode: 'replay', axis: 'model', synthetic: true, judge: { winner: 'shadow' }, main: { tokens: 9 }, shadow: { tokens: 9 } }),
      JSON.stringify({ mode: 'replay', axis: 'model', synthetic: true, judge: { winner: 'main' }, main: { tokens: 9 }, shadow: { tokens: 9 } }),
    ].join('\n');
    const agg = parseShadowCalls(jsonl);
    expect(agg.total).toBe(1); // only the genuine row
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    expect(model.samples).toBe(1);
    expect(model.shadowWins).toBe(1);
    expect(model.mainWins).toBe(0);
  });

  it('counts synthetic:false / absent-flag rows normally', () => {
    const agg = parseShadowCalls([
      JSON.stringify({ mode: 'live', axis: 'prompt', synthetic: false, judge: { winner: 'shadow' }, main: { tokens: 1 }, shadow: { tokens: 1 } }),
    ].join('\n'));
    expect(agg.total).toBe(1);
  });
});

describe('parseShadowCalls — per-finding sub-aggregate for the recs axis (#579)', () => {
  /** One recs-axis ledger line carrying the per-record `recs` block. */
  const recsLine = (
    findingId: string,
    mode: 'live' | 'replay',
    winner: 'main' | 'shadow' | 'tie' | null,
    extra: Record<string, unknown> = {}
  ): string =>
    JSON.stringify({
      mode,
      axis: 'recs',
      judge: winner ? { winner } : undefined,
      recs: { findingId, treatment: 'injected', paraphraseOverlap: 0.1, redundant: false },
      ...extra,
    });

  it('buckets recs records by findingId with winner + mode counters', () => {
    const jsonl = [
      recsLine('workflow.foo', 'live', 'shadow'),
      recsLine('workflow.foo', 'replay', 'shadow'),
      recsLine('workflow.foo', 'live', 'main'),
      recsLine('workflow.foo', 'live', 'tie'),
      recsLine('context.bar', 'replay', 'main'),
    ].join('\n');

    const recs = parseShadowCalls(jsonl).byAxis.find((a) => a.axis === 'recs')!;
    expect(recs.byFinding).toBeDefined();
    const foo = recs.byFinding!['workflow.foo'];
    expect(foo.findingId).toBe('workflow.foo');
    expect(foo.samples).toBe(4);
    expect(foo.live).toBe(3);
    expect(foo.replay).toBe(1);
    expect(foo.shadowWins).toBe(2);
    expect(foo.mainWins).toBe(1);
    expect(foo.ties).toBe(1);

    const bar = recs.byFinding!['context.bar'];
    expect(bar.samples).toBe(1);
    expect(bar.mainWins).toBe(1);
    expect(bar.replay).toBe(1);
  });

  it('decidedForFinding counts wins but excludes ties (#545 parity)', () => {
    const jsonl = [
      recsLine('workflow.foo', 'live', 'shadow'),
      recsLine('workflow.foo', 'live', 'shadow'),
      recsLine('workflow.foo', 'live', 'main'),
      recsLine('workflow.foo', 'live', 'tie'),
      recsLine('workflow.foo', 'live', 'tie'),
    ].join('\n');
    const foo = parseShadowCalls(jsonl).byAxis.find((a) => a.axis === 'recs')!.byFinding!['workflow.foo'];
    expect(foo.ties).toBe(2);
    expect(decidedForFinding(foo)).toBe(3); // 2 shadow + 1 main; ties excluded
  });

  it('skips synthetic recs rows per finding, same as per-axis totals (#570)', () => {
    const jsonl = [
      recsLine('workflow.foo', 'live', 'shadow'), // 1 genuine row
      recsLine('workflow.foo', 'replay', 'shadow', { synthetic: true }),
      recsLine('workflow.foo', 'replay', 'main', { synthetic: true }),
    ].join('\n');
    const recs = parseShadowCalls(jsonl).byAxis.find((a) => a.axis === 'recs')!;
    const foo = recs.byFinding!['workflow.foo'];
    expect(foo.samples).toBe(1); // synthetic rows excluded
    expect(foo.shadowWins).toBe(1);
    expect(foo.mainWins).toBe(0);
  });

  it('does not record a finding bucket when findingId is missing', () => {
    const jsonl = [
      JSON.stringify({ mode: 'live', axis: 'recs', judge: { winner: 'shadow' } }), // no recs block
      JSON.stringify({ mode: 'live', axis: 'recs', judge: { winner: 'main' }, recs: {} }), // no findingId
    ].join('\n');
    const recs = parseShadowCalls(jsonl).byAxis.find((a) => a.axis === 'recs')!;
    // per-axis totals still counted, but no per-finding buckets
    expect(recs.samples).toBe(2);
    expect(recs.byFinding).toBeUndefined();
  });

  it('leaves byFinding undefined for non-recs axes (recs block ignored off-axis)', () => {
    const jsonl = [
      // a stray recs block on a non-recs axis must NOT create a byFinding bucket
      JSON.stringify({ mode: 'live', axis: 'model', judge: { winner: 'shadow' }, recs: { findingId: 'workflow.foo' } }),
      recsLine('workflow.foo', 'live', 'shadow'),
    ].join('\n');
    const agg = parseShadowCalls(jsonl);
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    const recs = agg.byAxis.find((a) => a.axis === 'recs')!;
    expect(model.byFinding).toBeUndefined();
    expect(recs.byFinding!['workflow.foo'].shadowWins).toBe(1);
  });

  it('keeps per-axis totals byte-identical whether or not findings are bucketed (regression)', () => {
    // Same recs records, once WITH the recs block (new path) and once WITHOUT it (old path).
    // The per-axis counters must be identical — the byFinding sub-aggregate is purely additive.
    const withRecs = [
      recsLine('workflow.foo', 'live', 'shadow'),
      recsLine('workflow.foo', 'replay', 'main'),
      recsLine('context.bar', 'live', 'tie'),
    ].join('\n');
    const withoutRecs = [
      JSON.stringify({ mode: 'live', axis: 'recs', judge: { winner: 'shadow' } }),
      JSON.stringify({ mode: 'replay', axis: 'recs', judge: { winner: 'main' } }),
      JSON.stringify({ mode: 'live', axis: 'recs', judge: { winner: 'tie' } }),
    ].join('\n');

    const a1 = parseShadowCalls(withRecs).byAxis.find((a) => a.axis === 'recs')!;
    const a2 = parseShadowCalls(withoutRecs).byAxis.find((a) => a.axis === 'recs')!;
    const stripFindings = (a: typeof a1) => {
      const rest = { ...a };
      delete rest.byFinding;
      return rest;
    };
    expect(stripFindings(a1)).toEqual(stripFindings(a2));
  });
});

describe('workflow.shadow-axis-wins detector', () => {
  const find = (recs: { id: string }[]) => recs.find((r) => r.id === 'workflow.shadow-axis-wins');

  it('emits nothing when there are no experiments', () => {
    expect(find(buildRecommendations(inputWith('')))).toBeUndefined();
  });

  it('emits nothing below the sample threshold', () => {
    const jsonl = [
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'live', 'shadow', 1000, 200),
    ].join('\n'); // only 2 samples < MIN_SAMPLES (5)
    expect(find(buildRecommendations(inputWith(jsonl)))).toBeUndefined();
  });

  it('recommends adopting an axis that wins ≥60% over enough samples, weighting live as warning', () => {
    // 6 samples, 5 shadow wins (4 live), cheaper -> live-confirmed warning
    const jsonl = [
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'live', 'shadow', 1000, 250),
      line('model', 'live', 'shadow', 1000, 220),
      line('model', 'live', 'shadow', 1000, 210),
      line('model', 'replay', 'shadow', 900, 300),
      line('model', 'live', 'main', 100, 600),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.category).toBe('workflow');
    expect(rec!.severity).toBe('warning'); // ≥3 live shadow wins
    expect(rec!.title).toMatch(/cheaper model/i);
    expect(rec!.fix?.target).toBe('CLAUDE.md');
  });

  it('does NOT fire on 5 samples with too few DECIDED comparisons (#545)', () => {
    // 5 samples: 2 shadow wins + 3 ties → only 2 decided (< MIN_DECIDED=3). Thin evidence.
    const jsonl = [
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'live', 'tie', 1000, 1000),
      line('model', 'live', 'tie', 1000, 1000),
      line('model', 'live', 'tie', 1000, 1000),
    ].join('\n');
    expect(find(buildRecommendations(inputWith(jsonl)))).toBeUndefined();
  });

  it('caps at info when evidence is replay-only (cold-start caveat)', () => {
    const jsonl = [
      line('skills', 'replay', 'shadow', 1000, 900),
      line('skills', 'replay', 'shadow', 1000, 900),
      line('skills', 'replay', 'shadow', 1000, 900),
      line('skills', 'replay', 'shadow', 1000, 900),
      line('skills', 'replay', 'shadow', 1000, 900),
      line('skills', 'replay', 'main', 1000, 1100),
    ].join('\n'); // 5/6 shadow wins but ZERO live -> info
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('info');
  });
});

describe('workflow.uncovered-shadow-axis detector (#530 — discovery)', () => {
  const find = (recs: { id: string }[]) => recs.find((r) => r.id === 'workflow.uncovered-shadow-axis');
  const win = (axis: string) =>
    [win1(axis), win1(axis), win1(axis), win1(axis), win1(axis), line(axis, 'live', 'main', 100, 500)].join('\n');
  function win1(axis: string) { return line(axis, 'live', 'shadow', 1000, 200); }

  it('proposes a new class when an UNCOVERED axis wins (skills)', () => {
    const rec = find(buildRecommendations(inputWith(win('skills'))));
    expect(rec).toBeDefined();
    expect(rec!.category).toBe('workflow');
    expect(rec!.title).toMatch(/skills/);
    expect(rec!.fix?.target).toBe('command');
    expect(rec!.fix?.snippet).toMatch(/gh issue create/);
    expect(rec!.fix?.snippet).toMatch(/shadow-discovery/);
  });

  it('stays silent for a COVERED axis (model is already handled by cost rules)', () => {
    expect(find(buildRecommendations(inputWith(win('model'))))).toBeUndefined();
  });

  it('stays silent below the sample threshold', () => {
    const jsonl = [win1('skills'), win1('skills')].join('\n');
    expect(find(buildRecommendations(inputWith(jsonl)))).toBeUndefined();
  });
});

describe('workflow.shadow-axis-wins — recs per-finding efficacy verdict (#579, ADR 0005 Tier 2)', () => {
  const find = (recs: { id: string }[]) => recs.find((r) => r.id === 'workflow.shadow-axis-wins');
  /** A recs-axis ledger line (Main = finding injected, Shadow = finding withheld). */
  const recsLine = (
    findingId: string,
    mode: 'live' | 'replay',
    winner: 'main' | 'shadow' | 'tie' | null
  ): string =>
    JSON.stringify({
      mode,
      axis: 'recs',
      judge: winner ? { winner } : undefined,
      recs: { findingId, treatment: 'injected' },
    });
  /** A plain non-recs adoption line (mirrors the `line` helper above for the `model` axis). */
  const modelWin = (winner: 'main' | 'shadow' | 'tie', mode: 'live' | 'replay' = 'live') =>
    line('model', mode, winner, 1000, 200);

  it('below the #545 decided threshold: reports adoption only, withholds any causal verdict', () => {
    // 5 injected, but only 2 decided (1 main + 1 shadow) + 3 ties → below MIN_DECIDED (3).
    const jsonl = [
      recsLine('reliability.rate-limits', 'live', 'main'),
      recsLine('reliability.rate-limits', 'live', 'shadow'),
      recsLine('reliability.rate-limits', 'live', 'tie'),
      recsLine('reliability.rate-limits', 'replay', 'tie'),
      recsLine('reliability.rate-limits', 'replay', 'tie'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toMatch(/gathering efficacy evidence/i);
    expect(rec!.detail).toMatch(/injected 5 time/i);
    expect(rec!.detail).toMatch(/withheld/i); // explains the verdict is withheld
    // Strictly NO win/loss claim below threshold.
    expect(rec!.title).not.toMatch(/improving|not improving/i);
    expect(rec!.detail).not.toMatch(/beat (injecting|withholding)/i);
  });

  it('at/above threshold + injecting wins: a bounded directional verdict WITH the decided count', () => {
    // 4 injected-wins + 1 withheld-win = 5 decided, 80% main-win → "improving outcomes".
    const jsonl = [
      recsLine('context.fresh-start', 'live', 'main'),
      recsLine('context.fresh-start', 'live', 'main'),
      recsLine('context.fresh-start', 'replay', 'main'),
      recsLine('context.fresh-start', 'replay', 'main'),
      recsLine('context.fresh-start', 'live', 'shadow'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('info');
    expect(rec!.title).toMatch(/improving outcomes/i);
    expect(rec!.detail).toMatch(/4\/5 decided/); // matched-pair (decided) count published
    expect(rec!.provenance?.observations?.[0]?.source).toBe('parse-shadow-calls (recs.byFinding)');
  });

  it('at/above threshold + withholding wins: warns the recommendation is not helping', () => {
    // 1 injected-win + 4 withheld-wins = 5 decided, 20% main-win → "not improving" warning.
    const jsonl = [
      recsLine('workflow.noisy-rec', 'live', 'shadow'),
      recsLine('workflow.noisy-rec', 'live', 'shadow'),
      recsLine('workflow.noisy-rec', 'replay', 'shadow'),
      recsLine('workflow.noisy-rec', 'replay', 'shadow'),
      recsLine('workflow.noisy-rec', 'live', 'main'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.severity).toBe('warning');
    expect(rec!.title).toMatch(/not improving outcomes/i);
    expect(rec!.detail).toMatch(/4\/5 decided/);
  });

  it('surfaces the strongest-evidence finding (most decided comparisons) when several exist', () => {
    const jsonl = [
      // weak finding: 2 decided
      recsLine('weak.one', 'replay', 'main'),
      recsLine('weak.one', 'replay', 'shadow'),
      // strong finding: 5 decided, injecting wins
      recsLine('strong.two', 'live', 'main'),
      recsLine('strong.two', 'live', 'main'),
      recsLine('strong.two', 'live', 'main'),
      recsLine('strong.two', 'replay', 'main'),
      recsLine('strong.two', 'live', 'shadow'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.title).toMatch(/strong\.two/);
    expect(rec!.title).not.toMatch(/weak\.one/);
  });

  it('a decided recs verdict headlines over a non-recs adoption lead', () => {
    const jsonl = [
      // model axis would otherwise fire as an adopt-cheaper-model lead
      modelWin('shadow'), modelWin('shadow'), modelWin('shadow'),
      modelWin('shadow'), modelWin('shadow'), modelWin('main'),
      // recs finding clears the decided gate
      recsLine('context.fresh-start', 'live', 'main'),
      recsLine('context.fresh-start', 'live', 'main'),
      recsLine('context.fresh-start', 'live', 'main'),
      recsLine('context.fresh-start', 'replay', 'main'),
      recsLine('context.fresh-start', 'live', 'shadow'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.title).toMatch(/improving outcomes/i); // recs verdict, not the model lead
    expect(rec!.title).not.toMatch(/cheaper model/i);
  });

  it('a below-threshold recs note does NOT bury a real non-recs adoption lead', () => {
    const jsonl = [
      // model axis is a genuine adopt-cheaper-model lead (live-confirmed warning)
      modelWin('shadow'), modelWin('shadow'), modelWin('shadow'),
      modelWin('shadow'), modelWin('shadow'), modelWin('main'),
      // recs finding is below the decided gate (only 2 decided)
      recsLine('reliability.rate-limits', 'replay', 'main'),
      recsLine('reliability.rate-limits', 'replay', 'shadow'),
      recsLine('reliability.rate-limits', 'replay', 'tie'),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.title).toMatch(/cheaper model/i); // the model adoption lead wins
  });
});
