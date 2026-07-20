import { describe, it, expect } from 'vitest';
import {
  parseShadowCalls,
  classifyExperimentSource,
  parseProofReceiptCells,
  modelEvalSourceCell,
  mergeExternalSourceCells,
  LIVE_TRUST_SOURCES,
  avgTokenDelta,
  avgCostDelta,
  shadowCheaper,
  decidedForFinding,
  adherenceClean,
  configScopingSpeedDelta,
  configScopingCostDelta,
  configScopingTokenDelta,
  configScopingEvidence,
  MAX_BUFFERED_VARIATION_RECEIPTS,
  MAX_VARIATION_CELLS,
} from './parse-shadow-calls';
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
  const ZEROED = {
    total: 0,
    counted: 0,
    synthetic: 0,
    skipped: 0,
    live: 0,
    replay: 0,
    byAxis: [],
    bySourceAxis: [],
    byVariation: [],
    variationSkipped: 0,
  };

  it('returns a zeroed aggregate for empty/null input', () => {
    expect(parseShadowCalls(null)).toEqual(ZEROED);
    expect(parseShadowCalls('')).toEqual(ZEROED);
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
    expect(agg.total).toBe(5); // every non-empty line, incl. the malformed one (#2149)
    expect(agg.counted).toBe(4); // real rows
    expect(agg.skipped).toBe(1); // the malformed line is surfaced, not dropped
    expect(agg.synthetic).toBe(0);
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
    expect(agg.counted).toBe(0); // neither is a real experiment
    expect(agg.skipped).toBe(2); // both surfaced as skipped (#2149)
    expect(agg.total).toBe(2);
    expect(agg.byAxis).toEqual([]);
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
    expect(agg.counted).toBe(1); // only the genuine row feeds byAxis
    expect(agg.synthetic).toBe(3); // the 3 seed rows are surfaced, not dropped (#2149)
    expect(agg.total).toBe(4); // every non-empty line accounted for
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    expect(model.samples).toBe(1);
    expect(model.shadowWins).toBe(1);
    expect(model.mainWins).toBe(0);
  });

  it('counts synthetic:false / absent-flag rows normally', () => {
    const agg = parseShadowCalls([
      JSON.stringify({ mode: 'live', axis: 'prompt', synthetic: false, judge: { winner: 'shadow' }, main: { tokens: 1 }, shadow: { tokens: 1 } }),
    ].join('\n'));
    expect(agg.counted).toBe(1);
    expect(agg.synthetic).toBe(0);
    expect(agg.total).toBe(1);
  });

  // #2149 — counting transparency: EVERY non-empty ledger line lands in exactly one
  // bucket, so the headline number reconciles against the raw ledger size and nothing
  // is silently dropped or merged into a lossy `total`.
  it('surfaces every bucket and reconciles counted + synthetic + skipped === total (#2149)', () => {
    const lines = [
      line('model', 'live', 'shadow', 1000, 200),   // 1) real, live
      line('model', 'replay', 'main', 900, 300),     // 2) real, replay
      JSON.stringify({ mode: 'live', axis: 'model', synthetic: true, judge: { winner: 'shadow' } }), // 3) synthetic
      JSON.stringify({ mode: 'replay-skip', axis: 'model' }),          // 4) skipped: bad mode (replay-skip)
      JSON.stringify({ mode: 'live', judge: { winner: 'shadow' } }),   // 5) skipped: no axis
      JSON.stringify({ mode: 'bogus', axis: 'skills' }),               // 6) skipped: unknown mode
      '{ not valid json',                                              // 7) skipped: malformed
    ];
    const jsonl = lines.join('\n');
    const totalLedgerLines = lines.filter((l) => l.trim()).length; // 7
    const agg = parseShadowCalls(jsonl);

    // Each bucket is explicit on the surface.
    expect(agg.counted).toBe(2);   // rows 1 + 2
    expect(agg.synthetic).toBe(1); // row 3
    expect(agg.skipped).toBe(4);   // rows 4, 5, 6, 7 (replay-skip / no-axis / bad-mode / malformed)
    expect(agg.live).toBe(1);      // row 1
    expect(agg.replay).toBe(1);    // row 2
    expect(agg.total).toBe(7);     // every non-empty line

    // Reconciliation: NOTHING is silently dropped or merged.
    expect(agg.counted + agg.synthetic + agg.skipped).toBe(agg.total);
    expect(agg.total).toBe(totalLedgerLines);
    // And the live/replay split fully partitions the counted rows.
    expect(agg.live + agg.replay).toBe(agg.counted);

    // Only the two real rows feed the per-axis aggregate (synthetic/skipped excluded).
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    expect(agg.byAxis.map((a) => a.axis)).toEqual(['model']); // 'skills' bad-mode row excluded
    expect(model.samples).toBe(2);
    expect(model.live).toBe(1);
    expect(model.replay).toBe(1);
    expect(model.shadowWins).toBe(1);
    expect(model.mainWins).toBe(1);
  });
});

describe('parseShadowCalls — bounded per-variation receipts (#2643)', () => {
  const receipt = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      mode: 'live',
      axis: 'prompt',
      variation: 'structured',
      judge: { winner: 'shadow' },
      ...overrides,
    });

  it('keeps distinct treatments separate and preserves counts, freshness, cost, and proof status', () => {
    const newerEpoch = Date.parse('2026-07-12T12:30:00Z');
    const jsonl = [
      receipt({
        variation: '  structured  ',
        ts: '2026-07-10T08:00:00-04:00',
        revalidationStatus: 'current',
        main: { costUsd: 0.5 },
        shadow: { costUsd: 0.2 },
      }),
      receipt({
        mode: 'replay',
        variation: 'structured',
        ts: newerEpoch,
        revalidationStatus: 'stale',
        judge: { winner: 'main' },
        main: { costUsd: 0.1 },
        shadow: { costUsd: 0.25 },
      }),
      receipt({
        mode: 'replay',
        variation: 'concise',
        ts: '2026-07-11T00:00:00Z',
        revalidationStatus: 'revoked',
        judge: { winner: 'tie' },
      }),
      receipt({
        variation: 'structured',
        ts: 'not-a-date',
        revalidationStatus: 'unsupported',
        judge: {},
      }),
    ].join('\n');

    const aggregate = parseShadowCalls(jsonl);
    expect(aggregate.byVariation.map((cell) => [cell.axis, cell.variation])).toEqual([
      ['prompt', 'concise'],
      ['prompt', 'structured'],
    ]);

    const structured = aggregate.byVariation[1];
    expect(structured).toEqual({
      axis: 'prompt',
      variation: 'structured',
      samples: 3,
      live: 2,
      trustedLive: 2,
      replay: 1,
      shadowWins: 1,
      mainWins: 1,
      ties: 0,
      decided: 2,
      costDeltaSum: -0.15,
      costDeltaCount: 2,
      latestTs: '2026-07-12T12:30:00.000Z',
      untimed: 1,
      proofStatusCounts: { unknown: 1, current: 1, stale: 1, revoked: 0 },
    });
    expect(aggregate.byVariation[0]).toMatchObject({
      variation: 'concise',
      samples: 1,
      ties: 1,
      decided: 0,
      proofStatusCounts: { unknown: 0, current: 0, stale: 0, revoked: 1 },
    });
    expect(aggregate.variationSkipped).toBe(0);
    expect(
      aggregate.byVariation.reduce((sum, cell) => sum + cell.samples, 0) +
        aggregate.variationSkipped
    ).toBe(aggregate.counted);
  });

  it('counts trustedLive only for live rows from a trusted (organic/race) source (#2555)', () => {
    const jsonl = [
      receipt({ variation: 'framed' }), // organic live (unstamped) → trusted
      receipt({ variation: 'framed', raceGoal: 'ship X' }), // race-live → trusted
      receipt({ variation: 'framed', source: 'model-eval' }), // batch live → NOT trusted
      receipt({ variation: 'framed', mode: 'replay' }), // replay → neither
    ].join('\n');
    const cell = parseShadowCalls(jsonl).byVariation.find((c) => c.variation === 'framed')!;
    expect(cell.live).toBe(3); // 3 live-mode rows
    expect(cell.trustedLive).toBe(2); // organic + race only
    expect(cell.replay).toBe(1);
  });

  it('refuses missing/non-string/over-bound identities without pooling shared prefixes', () => {
    const accepted = 'x'.repeat(200);
    const sharedPrefix = 'y'.repeat(200);
    const aggregate = parseShadowCalls(
      [
        receipt({ variation: accepted, revalidationStatus: 'current' }),
        receipt({ variation: `${sharedPrefix}a` }),
        receipt({ variation: `${sharedPrefix}b` }),
        receipt({ variation: '   ' }),
        receipt({ variation: 42 }),
        receipt({ variation: undefined }),
      ].join('\n')
    );

    expect(aggregate.counted).toBe(6);
    expect(aggregate.byVariation).toHaveLength(1);
    expect(aggregate.byVariation[0].variation).toBe(accepted);
    expect(aggregate.variationSkipped).toBe(5);
  });

  it('is serialized-shape deterministic under receipt permutation, including floating sums', () => {
    const lines = [
      receipt({ ts: '2026-07-03T00:00:00Z', main: { costUsd: 0 }, shadow: { costUsd: 1_000_000 } }),
      receipt({ ts: '2026-07-01T00:00:00Z', main: { costUsd: 1_000_000 }, shadow: { costUsd: 0 } }),
      receipt({ ts: '2026-07-02T00:00:00Z', main: { costUsd: 0 }, shadow: { costUsd: 1e-12 } }),
      receipt({ mode: 'replay', variation: 'concise', judge: { winner: 'main' } }),
    ];
    const forward = parseShadowCalls(lines.join('\n'));
    const permuted = parseShadowCalls([lines[2], lines[0], lines[3], lines[1]].join('\n'));

    expect(permuted).toEqual(forward);
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(forward));
    expect(forward.byVariation.find((cell) => cell.variation === 'structured')?.costDeltaSum).toBe(1e-12);
    expect(forward.byAxis[0].costDeltaSum).toBe(1e-12);
    expect(forward.bySourceAxis[0].costDeltaSum).toBe(1e-12);
    expect(permuted.variationSkipped).toBe(forward.variationSkipped);
    expect(permuted.variationCellsTruncated).toBe(forward.variationCellsTruncated);
  });

  it('uses a strict Unicode tuple order for distinct canonically-equivalent treatments', () => {
    const composed = receipt({ variation: 'é' });
    const decomposed = receipt({ variation: 'e\u0301' });
    const forward = parseShadowCalls([composed, decomposed].join('\n'));
    const reversed = parseShadowCalls([decomposed, composed].join('\n'));

    expect(reversed.byVariation).toEqual(forward.byVariation);
    expect(forward.byVariation.map((cell) => cell.variation)).toEqual(['e\u0301', 'é']);
  });

  it('refuses negative or over-bound arm costs instead of emitting a non-finite sum', () => {
    const aggregate = parseShadowCalls(
      [
        receipt({ main: { costUsd: 0 }, shadow: { costUsd: Number.MAX_VALUE } }),
        receipt({ main: { costUsd: -1 }, shadow: { costUsd: 0 } }),
      ].join('\n')
    );
    expect(aggregate.byVariation[0].costDeltaCount).toBe(0);
    expect(aggregate.byVariation[0].costDeltaSum).toBe(0);
    expect(Number.isFinite(aggregate.byVariation[0].costDeltaSum)).toBe(true);
  });

  it('refuses overflowing legacy pooled sums instead of reporting a false zero pair', () => {
    const extreme = receipt({
      main: { tokens: 0, costUsd: 0 },
      shadow: { tokens: Number.MAX_VALUE, costUsd: Number.MAX_VALUE },
    });
    const aggregate = parseShadowCalls([extreme, extreme].join('\n'));

    expect(aggregate.byAxis[0].tokenDeltaCount).toBe(0);
    expect(aggregate.byAxis[0].costDeltaCount).toBe(0);
    expect(aggregate.bySourceAxis[0].tokenDeltaCount).toBe(0);
    expect(aggregate.bySourceAxis[0].costDeltaCount).toBe(0);
    expect(Number.isFinite(aggregate.byAxis[0].tokenDeltaSum)).toBe(true);
    expect(Number.isFinite(aggregate.bySourceAxis[0].costDeltaSum)).toBe(true);
  });

  it('chooses latestTs by instant even when an epoch formats with an extended year', () => {
    const aggregate = parseShadowCalls(
      [
        receipt({ ts: '2026-07-12T12:30:00Z' }),
        receipt({ ts: 8_640_000_000_000_000 }),
      ].join('\n')
    );
    expect(aggregate.byVariation[0].latestTs).toBe('+275760-09-13T00:00:00.000Z');
  });

  it('caps identities deterministically without an `(other)` treatment bucket', () => {
    const lines = Array.from({ length: MAX_VARIATION_CELLS + 5 }, (_, index) =>
      receipt({ variation: `variation-${String(index).padStart(3, '0')}` })
    );
    const forward = parseShadowCalls(lines.join('\n'));
    const reversed = parseShadowCalls([...lines].reverse().join('\n'));

    expect(forward.byVariation).toEqual(reversed.byVariation);
    expect(forward.byVariation).toHaveLength(MAX_VARIATION_CELLS);
    expect(forward.byVariation.at(-1)?.variation).toBe('variation-099');
    expect(forward.byVariation.some((cell) => cell.variation === '(other)')).toBe(false);
    expect(forward.variationSkipped).toBe(5);
    expect(forward.variationCellsTruncated).toBe(true);
  });

  it('keeps the bounded-buffer fallback permutation-stable and reconciled', () => {
    const lines = Array.from(
      { length: MAX_BUFFERED_VARIATION_RECEIPTS + 1 },
      (_, index) =>
        receipt({
          mode: index % 2 === 0 ? 'live' : 'replay',
          variation: index % 3 === 0 ? 'concise' : 'structured',
          judge: { winner: index % 5 === 0 ? 'main' : 'shadow' },
          main: { costUsd: 0.2 },
          shadow: { costUsd: index % 7 === 0 ? 0.1 : 0.3 },
          ts: `2026-07-${String((index % 14) + 1).padStart(2, '0')}T00:00:00Z`,
          revalidationStatus: index % 11 === 0 ? 'stale' : 'current',
        })
    );
    const forward = parseShadowCalls(lines.join('\n'));
    const reversed = parseShadowCalls([...lines].reverse().join('\n'));

    expect(JSON.stringify(reversed.byVariation)).toBe(JSON.stringify(forward.byVariation));
    expect(
      forward.byVariation.reduce((sum, cell) => sum + cell.samples, 0) +
        forward.variationSkipped
    ).toBe(forward.counted);
    expect(forward.counted).toBe(MAX_BUFFERED_VARIATION_RECEIPTS + 1);
  });

  it('does not infer proof freshness from source or judge basis', () => {
    const aggregate = parseShadowCalls(
      receipt({ source: 'proof', judge: { winner: 'shadow', basis: 'judge' } })
    );
    expect(aggregate.byVariation[0].proofStatusCounts).toEqual({
      unknown: 1,
      current: 0,
      stale: 0,
      revoked: 0,
    });
  });
});

describe('parseShadowCalls — first-class experiment source taxonomy (#2150)', () => {
  it('classifyExperimentSource: explicit stamp wins, config-scoping axis falls back, else mode', () => {
    expect(classifyExperimentSource({ source: 'model-eval', axis: 'model', mode: 'replay' })).toBe('model-eval');
    expect(classifyExperimentSource({ source: '  race-live ', mode: 'live' })).toBe('race-live');
    expect(classifyExperimentSource({ source: '', axis: 'model', mode: 'replay' })).toBe('replay');
    expect(classifyExperimentSource({ axis: 'config-scoping', mode: 'live' })).toBe('config-scoping');
    expect(classifyExperimentSource({ axis: 'model', mode: 'replay' })).toBe('replay');
    expect(classifyExperimentSource({ axis: 'model', mode: 'live' })).toBe('live');
  });

  it('aggregates uniformly per (source, axis) cell — no per-source bespoke field', () => {
    const jsonl = [
      // organic engine rows (unstamped): source falls back to the mode
      line('model', 'live', 'shadow', 1000, 200),
      line('model', 'replay', 'main', 900, 300),
      // model-eval batch stamps its source explicitly (same axis as the organic rows)
      JSON.stringify({ mode: 'replay', axis: 'model', source: 'model-eval', judge: { winner: 'shadow' }, main: { tokens: 500, costUsd: 0.3 }, shadow: { tokens: 400, costUsd: 0.1 } }),
      // a proof-batch row on another axis
      JSON.stringify({ mode: 'live', axis: 'skills', source: 'proof', judge: { winner: 'tie' } }),
      // config-scoping rows classify as their own source without a stamp
      JSON.stringify({ mode: 'live', axis: 'config-scoping', judge: { winner: 'shadow' } }),
    ].join('\n');
    const agg = parseShadowCalls(jsonl);

    // Cells are sorted by (source, axis) and every counted row lands in exactly one.
    expect(agg.bySourceAxis.map((c) => [c.source, c.axis])).toEqual([
      ['config-scoping', 'config-scoping'],
      ['live', 'model'],
      ['model-eval', 'model'],
      ['proof', 'skills'],
      ['replay', 'model'],
    ]);
    expect(agg.bySourceAxis.reduce((sum, c) => sum + c.samples, 0)).toBe(agg.counted);

    const evalCell = agg.bySourceAxis.find((c) => c.source === 'model-eval')!;
    expect(evalCell.samples).toBe(1);
    expect(evalCell.replay).toBe(1);
    expect(evalCell.shadowWins).toBe(1);
    expect(evalCell.tokenDeltaSum).toBe(-100);
    expect(evalCell.costDeltaSum).toBeCloseTo(-0.2);

    // The per-axis aggregate still folds ALL sources of an axis together (unchanged).
    const model = agg.byAxis.find((a) => a.axis === 'model')!;
    expect(model.samples).toBe(3);
  });

  it('an unknown future source stamp flows through with no parser change', () => {
    const agg = parseShadowCalls(
      JSON.stringify({ mode: 'live', axis: 'prompt', source: 'window-replay-v2', judge: { winner: 'shadow' } })
    );
    expect(agg.bySourceAxis).toHaveLength(1);
    expect(agg.bySourceAxis[0].source).toBe('window-replay-v2');
    expect(agg.bySourceAxis[0].samples).toBe(1);
  });

  it('synthetic and skipped rows never reach a source cell (consistent with #2149)', () => {
    const agg = parseShadowCalls([
      JSON.stringify({ mode: 'live', axis: 'model', source: 'proof', synthetic: true, judge: { winner: 'shadow' } }),
      JSON.stringify({ mode: 'replay-skip', axis: 'model', source: 'proof' }),
    ].join('\n'));
    expect(agg.synthetic).toBe(1);
    expect(agg.skipped).toBe(1);
    expect(agg.bySourceAxis).toEqual([]);
  });

  it('a JSON `null` line counts as skipped and never crashes the parse', () => {
    const agg = parseShadowCalls(['null', line('model', 'live', 'shadow', 100, 50)].join('\n'));
    expect(agg.total).toBe(2);
    expect(agg.skipped).toBe(1);
    expect(agg.counted).toBe(1);
  });

  it('caps source cells with permutation-stable selection and an (other) fold', () => {
    const lines = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({ mode: 'live', axis: 'model', source: `uuid-${i}`, judge: { winner: 'shadow' } })
    );
    const agg = parseShadowCalls(lines.join('\n'));
    const reversed = parseShadowCalls([...lines].reverse().join('\n'));
    expect(reversed).toEqual(agg);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(agg));
    expect(agg.bySourceAxis.length).toBeLessThanOrEqual(101); // cap + the (other) fold
    const other = agg.bySourceAxis.find((c) => c.source === '(other)')!;
    expect(other.samples).toBe(20);
    const expectedSelected = Array.from({ length: 120 }, (_, i) => `uuid-${i}`)
      .sort()
      .slice(0, 100);
    expect(
      agg.bySourceAxis
        .filter((cell) => cell.source !== '(other)')
        .map((cell) => cell.source)
    ).toEqual(expectedSelected);
    expect(agg.bySourceAxis.reduce((sum, c) => sum + c.samples, 0)).toBe(agg.counted);
  });

  it('stably sums adherence and config-scoping numeric aggregates', () => {
    const record = (value: number): string =>
      JSON.stringify({
        mode: 'live',
        axis: 'config-scoping',
        judge: { winner: 'tie', adherenceRegressions: value },
        configScoping: {
          speed: { monolithWallMs: value, atomizedWallMs: value },
          cost: {
            monolithTokens: value,
            atomizedTokens: value,
            monolithCostUsd: value,
            atomizedCostUsd: value,
          },
          accuracy: {
            monolithAdherence: value,
            atomizedAdherence: value,
          },
        },
      });
    const lines = [record(1e16), record(1), record(1)];
    const forward = parseShadowCalls(lines.join('\n'));
    const reversed = parseShadowCalls([...lines].reverse().join('\n'));

    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(forward.byAxis[0].adherenceRegressionSum).toBe(
      10_000_000_000_000_002
    );
    expect(forward.byAxis[0].configScoping?.speed.monolithSum).toBe(
      10_000_000_000_000_002
    );

    const overflow = parseShadowCalls(
      [record(Number.MAX_VALUE), record(Number.MAX_VALUE)].join('\n')
    ).byAxis[0];
    expect(overflow.adherenceRegressionCount).toBe(0);
    expect(overflow.configScoping?.speed.pairedCount).toBe(0);
    expect(overflow.configScoping?.cost.tokenPairedCount).toBe(0);
    expect(overflow.configScoping?.cost.costPairedCount).toBe(0);
    expect(overflow.configScoping?.accuracy.adherencePairedCount).toBe(0);
  });

  it('a truthy non-object configScoping value attaches no verdict aggregate', () => {
    const agg = parseShadowCalls(
      JSON.stringify({ mode: 'live', axis: 'model', judge: { winner: 'shadow' }, configScoping: true })
    );
    expect(agg.byAxis[0].configScoping).toBeUndefined();
  });

  it('config-scoping parity: the verdict triple aggregates exactly as before (block-gated, not axis-gated)', () => {
    // Same triple-carrying record as the #1663 fixtures — the de-special-cased
    // parser (gate on the block, not the axis name) must produce identical output.
    const rec = JSON.stringify({
      mode: 'live',
      axis: 'config-scoping',
      judge: { winner: 'shadow' },
      configScoping: {
        speed: { monolithWallMs: 1000, atomizedWallMs: 600, winner: 'atomized' },
        cost: { monolithTokens: 500, atomizedTokens: 400, monolithCostUsd: 0.3, atomizedCostUsd: 0.2, winner: 'atomized' },
        accuracy: { gateWinner: 'tie', monolithAdherence: 10, atomizedAdherence: 9 },
      },
    });
    const a = parseShadowCalls(rec).byAxis.find((x) => x.axis === 'config-scoping')!;
    expect(a.configScoping).toBeDefined();
    expect(a.configScoping!.speed.pairedCount).toBe(1);
    expect(a.configScoping!.speed.atomizedWins).toBe(1);
    expect(a.configScoping!.cost.costPairedCount).toBe(1);
    expect(a.configScoping!.accuracy.gate.ties).toBe(1);
    // And it reports through the uniform source path too — one config-scoping cell.
    expect(parseShadowCalls(rec).bySourceAxis.map((c) => c.source)).toEqual(['config-scoping']);
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

  it('serializes finding keys in strict order independent of receipt order', () => {
    const lines = [
      recsLine('workflow.zeta', 'live', 'shadow'),
      recsLine('context.alpha', 'replay', 'main'),
    ];
    const forward = parseShadowCalls(lines.join('\n'));
    const reversed = parseShadowCalls([...lines].reverse().join('\n'));

    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(Object.keys(forward.byAxis[0].byFinding!)).toEqual([
      'context.alpha',
      'workflow.zeta',
    ]);
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

  it('surfaces a meaningful adopt string for the config-scoping axis (#1270)', () => {
    // 6 samples, 5 shadow wins (live) — clears the bar, so the adopt-axis rec fires
    // with the AXIS_META['config-scoping'] label + adopt string, not the generic fallback.
    const jsonl = [
      line('config-scoping', 'live', 'shadow', 1000, 400),
      line('config-scoping', 'live', 'shadow', 1000, 420),
      line('config-scoping', 'live', 'shadow', 1000, 380),
      line('config-scoping', 'live', 'shadow', 1000, 410),
      line('config-scoping', 'replay', 'shadow', 900, 350),
      line('config-scoping', 'live', 'main', 800, 900),
    ].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    expect(rec!.title).toMatch(/path-scoped \(atomized\) config/);
    // Not the generic `adopt the "config-scoping" variation` fallback — a concrete action.
    expect(rec!.action).toMatch(/path-scoped \.claude\/rules/);
    expect(rec!.action).toMatch(/CLAUDE\.md\/AGENTS\.md/);
    expect(rec!.action).not.toMatch(/adopt the "config-scoping" variation/);
  });
});

describe('parseShadowCalls — config-scoping adherence-regression dimension (#1270)', () => {
  /** A config-scoping ledger line; `adherence` omitted ⇒ the judge carried no dimension. */
  const scopingLine = (
    winner: 'main' | 'shadow' | 'tie',
    adherence?: number,
    mode: 'live' | 'replay' = 'live'
  ): string =>
    JSON.stringify({
      mode,
      axis: 'config-scoping',
      judge: { winner, ...(adherence === undefined ? {} : { adherenceRegressions: adherence }) },
    });
  const axisOf = (jsonl: string) =>
    parseShadowCalls(jsonl).byAxis.find((a) => a.axis === 'config-scoping')!;

  it('aggregates the adherence-regression sum + coverage count', () => {
    const a = axisOf([
      scopingLine('shadow', 0),
      scopingLine('shadow', 0),
      scopingLine('main', 2),
      scopingLine('tie'), // no adherence dimension on this record
    ].join('\n'));
    expect(a.samples).toBe(4);
    expect(a.adherenceRegressionSum).toBe(2);
    expect(a.adherenceRegressionCount).toBe(3); // only records carrying the dimension
  });

  it('ignores non-numeric and negative adherence values', () => {
    const a = axisOf([
      JSON.stringify({ mode: 'live', axis: 'config-scoping', judge: { winner: 'shadow', adherenceRegressions: 'none' } }),
      JSON.stringify({ mode: 'live', axis: 'config-scoping', judge: { winner: 'shadow', adherenceRegressions: -1 } }),
      scopingLine('shadow', 0),
    ].join('\n'));
    expect(a.adherenceRegressionSum).toBe(0);
    expect(a.adherenceRegressionCount).toBe(1);
  });

  it('adherenceClean certifies zero regression only at FULL coverage', () => {
    // Full coverage, all zero -> true.
    expect(adherenceClean(axisOf([
      scopingLine('shadow', 0), scopingLine('shadow', 0), scopingLine('main', 0),
    ].join('\n')))).toBe(true);
    // Any nonzero regression -> false.
    expect(adherenceClean(axisOf([
      scopingLine('shadow', 0), scopingLine('shadow', 1), scopingLine('shadow', 0),
    ].join('\n')))).toBe(false);
    // No adherence data at all -> null (fail closed).
    expect(adherenceClean(axisOf([
      scopingLine('shadow'), scopingLine('shadow'),
    ].join('\n')))).toBeNull();
    // PARTIAL coverage (one record missing the dimension) -> null (fail closed).
    expect(adherenceClean(axisOf([
      scopingLine('shadow', 0), scopingLine('shadow', 0), scopingLine('main'),
    ].join('\n')))).toBeNull();
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

describe('config-scoping atomic-vs-monolith verdict triple (#1663)', () => {
  /**
   * One config-scoping ledger line carrying the #1662 verdict triple (monolith = MAIN arm,
   * atomized = SHADOW arm). `winner` is 'shadow' so a run of these clears the adopt-this-axis
   * thresholds and the detector surfaces the breakdown.
   */
  const csLine = (
    opts: {
      winner?: 'main' | 'shadow' | 'tie';
      monoWall?: number; atomWall?: number; speedWinner?: string;
      monoTok?: number; atomTok?: number;
      monoUsd?: number; atomUsd?: number; costWinner?: string;
      gateWinner?: string; monoAdh?: number; atomAdh?: number;
    } = {}
  ): string =>
    JSON.stringify({
      mode: 'live',
      axis: 'config-scoping',
      judge: { winner: opts.winner ?? 'shadow' },
      configScoping: {
        speed: {
          monolithWallMs: opts.monoWall,
          atomizedWallMs: opts.atomWall,
          winner: opts.speedWinner,
        },
        cost: {
          monolithTokens: opts.monoTok,
          atomizedTokens: opts.atomTok,
          monolithCostUsd: opts.monoUsd,
          atomizedCostUsd: opts.atomUsd,
          winner: opts.costWinner,
        },
        accuracy: {
          gateWinner: opts.gateWinner,
          monolithAdherence: opts.monoAdh,
          atomizedAdherence: opts.atomAdh,
        },
      },
    });

  const find = (recs: { id: string }[]) => recs.find((r) => r.id === 'workflow.shadow-axis-wins');

  it('aggregates the per-run speed/cost/accuracy triple from config-scoping records', () => {
    const jsonl = [
      csLine({ monoWall: 1000, atomWall: 600, speedWinner: 'atomized', monoTok: 500, atomTok: 400, monoUsd: 0.3, atomUsd: 0.2, costWinner: 'atomized', gateWinner: 'tie', monoAdh: 10, atomAdh: 9 }),
      csLine({ monoWall: 800, atomWall: 700, speedWinner: 'atomized', monoTok: 600, atomTok: 500, monoUsd: 0.4, atomUsd: 0.3, costWinner: 'atomized', gateWinner: 'atomized', monoAdh: 10, atomAdh: 10 }),
    ].join('\n');
    const a = parseShadowCalls(jsonl).byAxis.find((x) => x.axis === 'config-scoping')!;
    const c = a.configScoping!;
    expect(c.speed.pairedCount).toBe(2);
    expect(c.speed.atomizedWins).toBe(2);
    // mean wall delta (atomized − monolith) = ((600-1000)+(700-800))/2 = -250
    expect(configScopingSpeedDelta(a)).toBeCloseTo(-250);
    // mean $ delta = ((0.2-0.3)+(0.3-0.4))/2 = -0.10
    expect(configScopingCostDelta(a)).toBeCloseTo(-0.1);
    // mean token delta = ((400-500)+(500-600))/2 = -100
    expect(configScopingTokenDelta(a)).toBeCloseTo(-100);
    expect(c.cost.atomizedWins).toBe(2);
    expect(c.accuracy.gate.atomizedWins).toBe(1);
    expect(c.accuracy.gate.ties).toBe(1);
    expect(c.accuracy.adherencePairedCount).toBe(2);
  });

  it('renders the speed/cost/accuracy delta in the shadow-axis evidence', () => {
    // 6 config-scoping records, atomized (shadow) wins 5/6 — clears the adopt-axis thresholds.
    const win = () => csLine({ winner: 'shadow', monoWall: 1000, atomWall: 600, speedWinner: 'atomized', monoTok: 500, atomTok: 400, monoUsd: 0.30, atomUsd: 0.20, costWinner: 'atomized', gateWinner: 'tie', monoAdh: 10, atomAdh: 10 });
    const jsonl = [win(), win(), win(), win(), win(), csLine({ winner: 'main', monoWall: 500, atomWall: 900, speedWinner: 'monolith', monoTok: 400, atomTok: 700, monoUsd: 0.2, atomUsd: 0.5, costWinner: 'monolith', gateWinner: 'monolith', monoAdh: 10, atomAdh: 7 })].join('\n');
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined();
    const ev = rec!.evidence ?? [];
    expect(ev.some((e) => /config-scoping speed:/.test(e))).toBe(true);
    expect(ev.some((e) => /config-scoping cost:.*cheaper|config-scoping cost:.*pricier/.test(e))).toBe(true);
    expect(ev.some((e) => /config-scoping accuracy:/.test(e))).toBe(true);
    // The delta is signed: the cost row feeds the #726 realized-savings path.
    expect(ev.some((e) => /config-scoping cost: atomized \$/.test(e))).toBe(true);
  });

  it('configScopingEvidence falls back to a token delta when no $ data is present', () => {
    const a = parseShadowCalls(csLine({ monoTok: 500, atomTok: 300, costWinner: 'atomized' })).byAxis[0];
    expect(configScopingCostDelta(a)).toBeNull(); // no $ pair
    expect(configScopingTokenDelta(a)).toBeCloseTo(-200);
    const rows = configScopingEvidence(a);
    expect(rows.some((r) => /config-scoping cost: atomized 200 fewer tokens/.test(r))).toBe(true);
  });

  it('configScopingEvidence renders a tie (not "0ms faster"/"$0.00 cheaper") for zero/sub-cent deltas, matching the verdict view (#2002)', () => {
    // Equal wall-time and equal $ → exact-zero deltas; equal tokens with no $ → zero token delta.
    const a = parseShadowCalls(csLine({ monoWall: 600, atomWall: 600, monoUsd: 0.2, atomUsd: 0.2 })).byAxis[0];
    expect(configScopingSpeedDelta(a)).toBe(0);
    expect(configScopingCostDelta(a)).toBe(0);
    const rows = configScopingEvidence(a);
    expect(rows.some((r) => /config-scoping speed: atomized and monolith tied on wall-time/.test(r))).toBe(true);
    expect(rows.some((r) => /config-scoping cost: atomized and monolith tied on \$/.test(r))).toBe(true);
    // No misleading "faster"/"cheaper" phrasing for a zero delta.
    expect(rows.some((r) => /faster|slower|cheaper|pricier/.test(r))).toBe(false);

    // Token-only tie (no $ pair).
    const t = parseShadowCalls(csLine({ monoTok: 400, atomTok: 400 })).byAxis[0];
    expect(configScopingTokenDelta(t)).toBe(0);
    expect(configScopingEvidence(t).some((r) => /config-scoping cost: atomized and monolith tied on tokens/.test(r))).toBe(true);
  });

  it('degrades gracefully: config-scoping records WITHOUT a triple add no delta rows and do not error', () => {
    // Plain config-scoping records (no `configScoping` block) — like slice-2-not-yet-emitting.
    const plain = (w: 'main' | 'shadow') =>
      JSON.stringify({ mode: 'live', axis: 'config-scoping', judge: { winner: w }, main: { tokens: 100, costUsd: 0.2 }, shadow: { tokens: 90, costUsd: 0.1 } });
    const jsonl = [plain('shadow'), plain('shadow'), plain('shadow'), plain('shadow'), plain('shadow'), plain('main')].join('\n');
    const agg = parseShadowCalls(jsonl);
    const a = agg.byAxis.find((x) => x.axis === 'config-scoping')!;
    expect(a.configScoping).toBeUndefined();
    expect(configScopingEvidence(a)).toEqual([]);
    const rec = find(buildRecommendations(inputWith(jsonl)));
    expect(rec).toBeDefined(); // still fires on the win rate
    expect((rec!.evidence ?? []).some((e) => /config-scoping speed:|config-scoping cost:|config-scoping accuracy:/.test(e))).toBe(false);
  });

  it('emits no config-scoping rows for other axes (model lead unaffected)', () => {
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
    expect(rec!.title).toMatch(/cheaper model/i);
    expect((rec!.evidence ?? []).some((e) => /config-scoping/.test(e))).toBe(false);
  });

  it('returns [] for an axis with no triple and is a no-op for null aggregate fields', () => {
    const a = parseShadowCalls(line('model', 'live', 'shadow', 1000, 200)).byAxis[0];
    expect(a.configScoping).toBeUndefined();
    expect(configScopingEvidence(a)).toEqual([]);
    expect(configScopingSpeedDelta(a)).toBeNull();
    expect(configScopingCostDelta(a)).toBeNull();
    expect(configScopingTokenDelta(a)).toBeNull();
  });
});

describe('experiment-source ingest wiring (#2151)', () => {
  /** An unstamped ledger line as `finalizeRace` writes it: mode live + raceGoal, no source. */
  const raceLine = (axis: string, winner: 'main' | 'shadow' | 'tie'): string =>
    JSON.stringify({
      mode: 'live', axis, raceGoal: 'GOAL: refactor the parser',
      judge: { winner }, main: { tokens: 900 }, shadow: { tokens: 700 },
    });

  it('classifies unstamped race records race-live via the raceGoal signature', () => {
    expect(classifyExperimentSource({ mode: 'live', axis: 'skills', raceGoal: 'GOAL: x' })).toBe('race-live');
    // Explicit stamp still wins; blank raceGoal falls through to the mode rule.
    expect(classifyExperimentSource({ mode: 'live', source: 'replay', raceGoal: 'GOAL: x' })).toBe('replay');
    expect(classifyExperimentSource({ mode: 'live', axis: 'skills', raceGoal: '  ' })).toBe('live');
  });

  it('race records land in a race-live cell and KEEP live trust (a /race is in-the-loop)', () => {
    const agg = parseShadowCalls([raceLine('skills', 'shadow'), line('skills', 'live', 'shadow')].join('\n'));
    expect(agg.bySourceAxis.map((c) => [c.source, c.axis, c.samples])).toEqual([
      ['live', 'skills', 1],
      ['race-live', 'skills', 1],
    ]);
    const a = agg.byAxis[0];
    expect(a.liveShadowWins).toBe(2); // both sources are live-trust
    expect(LIVE_TRUST_SOURCES.has('race-live')).toBe(true);
  });

  it('benchmark-tier sources never buy live trust by stamping mode:live (weighting)', () => {
    const agg = parseShadowCalls(
      [
        JSON.stringify({ mode: 'live', axis: 'model', source: 'model-eval', judge: { winner: 'shadow' } }),
        JSON.stringify({ mode: 'live', axis: 'model', source: 'proof', judge: { winner: 'shadow' } }),
      ].join('\n')
    );
    const a = agg.byAxis[0];
    expect(a.shadowWins).toBe(2); // wins still count…
    expect(a.live).toBe(2); // …and the mode mix stays honest…
    expect(a.liveShadowWins).toBe(0); // …but detector trust stays replay-tier
  });

  it('parseProofReceiptCells: one sample per receipt, verdict→winner, costUsd→delta, junk→skipped', () => {
    const receipt = (wastePattern: string, verdict: 'proven' | 'refuted' | 'null', costUsd?: number): string =>
      JSON.stringify({
        kind: 'PROOF',
        observed: { wastePattern },
        result: { verdict, perDimensionDeltas: costUsd === undefined ? {} : { costUsd } },
      });
    const { cells, receipts, skipped } = parseProofReceiptCells(
      [
        receipt('repo-map-context-waste', 'proven', -0.4),
        receipt('repo-map-context-waste', 'null'),
        receipt('another-pattern', 'refuted', 0.1),
        JSON.stringify({ kind: 'DRAFT' }), // wrong kind
        '{not json',
      ].join('\n')
    );
    expect(receipts).toBe(3);
    expect(skipped).toBe(2);
    expect(cells.map((c) => [c.source, c.axis, c.samples])).toEqual([
      ['proof', 'another-pattern', 1],
      ['proof', 'repo-map-context-waste', 2],
    ]);
    const rm = cells[1];
    expect([rm.shadowWins, rm.mainWins, rm.ties]).toEqual([1, 0, 1]); // proven→shadow, null→tie
    expect([rm.costDeltaSum, rm.costDeltaCount]).toEqual([-0.4, 1]);
    expect([rm.live, rm.replay]).toEqual([0, 0]); // a batch proof run is neither
    expect(cells[0].mainWins).toBe(1); // refuted→main
  });

  it('parseProofReceiptCells is permutation-stable for floating cost deltas', () => {
    const receipt = (costUsd: number): string =>
      JSON.stringify({
        kind: 'PROOF',
        observed: { wastePattern: 'floating-proof' },
        result: { verdict: 'proven', perDimensionDeltas: { costUsd } },
      });
    const lines = [receipt(1_000_000), receipt(-1_000_000), receipt(1e-12)];
    const forward = parseProofReceiptCells(lines.join('\n'));
    const reversed = parseProofReceiptCells([...lines].reverse().join('\n'));

    expect(reversed).toEqual(forward);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(forward.cells[0].costDeltaSum).toBe(1e-12);

    const overflow = parseProofReceiptCells(
      [receipt(Number.MAX_VALUE), receipt(Number.MAX_VALUE)].join('\n')
    );
    expect(overflow.cells[0].costDeltaCount).toBe(0);
    expect(Number.isFinite(overflow.cells[0].costDeltaSum)).toBe(true);
  });

  it('modelEvalSourceCell: volume-only provenance cell; absent pipeline adds nothing', () => {
    expect(modelEvalSourceCell(null)).toBeNull();
    expect(modelEvalSourceCell({ runCount: 0 })).toBeNull();
    const cell = modelEvalSourceCell({ runCount: 7 })!;
    expect([cell.source, cell.axis, cell.samples]).toEqual(['model-eval', 'model', 7]);
    expect(cell.shadowWins + cell.mainWins + cell.ties).toBe(0); // verdicts stay in the eval surface
  });

  it('mergeExternalSourceCells: cells re-sort, external reconciles, ledger invariants untouched', () => {
    const agg = parseShadowCalls([line('skills', 'live', 'shadow'), line('model', 'replay', 'main')].join('\n'));
    const { cells } = parseProofReceiptCells(
      JSON.stringify({ kind: 'PROOF', observed: { wastePattern: 'w' }, result: { verdict: 'proven' } })
    );
    const evalCell = modelEvalSourceCell({ runCount: 3 })!;
    const merged = mergeExternalSourceCells(agg, [...cells, evalCell]);
    expect(merged.external).toBe(4);
    expect(merged.counted).toBe(2); // ledger counting untouched (#2149)
    const cellSum = merged.bySourceAxis.reduce((s, c) => s + c.samples, 0);
    expect(cellSum).toBe(merged.counted + merged.external!); // documented reconciliation
    // Sorted by (source, axis) including the merged-in cells.
    expect(merged.bySourceAxis.map((c) => c.source)).toEqual(['live', 'model-eval', 'proof', 'replay']);
    // External PROOF receipts do not name a concrete shadow treatment. Their
    // experimentRef/wastePattern must never be fabricated into byVariation.
    expect(merged.byVariation).toEqual(agg.byVariation);
    expect(merged.byVariation).toEqual([]);
    // Empty merge is a strict no-op (same reference), so unchanged ledgers keep their ETag path.
    expect(mergeExternalSourceCells(agg, [])).toBe(agg);
  });
});
