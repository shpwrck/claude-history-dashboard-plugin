import { describe, it, expect } from 'vitest';
import { bucketExperimentTrends, parseShadowCallRows } from './shadow-experiments';
import { parseShadowCalls } from './parse-shadow-calls';

const counted = (
  axis: string,
  mode: 'live' | 'replay',
  extra: Record<string, unknown> = {}
): string => JSON.stringify({ mode, axis, judge: { winner: 'shadow' }, ...extra });

describe('parseShadowCallRows (#2152/#2153)', () => {
  const EMPTY = { rows: [], total: 0, dropped: 0, counted: 0, synthetic: 0, skipped: 0 };

  it('returns an empty result for empty/null input', () => {
    expect(parseShadowCallRows(null)).toEqual(EMPTY);
    expect(parseShadowCallRows('')).toEqual(EMPTY);
  });

  it('a JSON `null` line is a malformed row with source unknown, never a crash', () => {
    const { rows, total, skipped } = parseShadowCallRows('null\n' + counted('model', 'live'));
    expect(total).toBe(2);
    expect(skipped).toBe(1);
    expect(rows[0].disposition).toBe('skipped');
    expect(rows[0].skipReason).toBe('malformed');
    expect(rows[0].source).toBe('unknown');
    expect(rows[1].disposition).toBe('counted');
  });

  it('an unstamped replay-skip row gets source unknown, not a fabricated live attribution', () => {
    const { rows } = parseShadowCallRows(
      JSON.stringify({ mode: 'replay-skip', axis: 'model' })
    );
    expect(rows[0].source).toBe('unknown');
    expect(rows[0].mode).toBe('replay-skip');
  });

  it('disposition counts are WHOLE-LEDGER (pre-drop) so they reconcile to total', () => {
    const jsonl = Array.from({ length: 8 }, () => counted('model', 'live'))
      .concat([JSON.stringify({ mode: 'live', axis: 'model', synthetic: true })])
      .join('\n');
    const r = parseShadowCallRows(jsonl, { maxRows: 3 });
    expect(r.total).toBe(9);
    expect(r.dropped).toBe(6);
    expect(r.rows).toHaveLength(3);
    expect(r.counted).toBe(8);
    expect(r.synthetic).toBe(1);
    expect(r.counted + r.synthetic + r.skipped).toBe(r.total);
  });

  it('yields exactly one row per non-empty line with the #2149 disposition', () => {
    const jsonl = [
      counted('model', 'live', { ts: '2024-03-01T10:00:00Z', source: 'model-eval' }),
      JSON.stringify({ mode: 'replay', axis: 'skills', synthetic: true }),
      JSON.stringify({ mode: 'replay-skip', axis: 'model' }),
      JSON.stringify({ mode: 'live', judge: { winner: 'shadow' } }),
      '{ not json',
    ].join('\n');

    const { rows, total, dropped } = parseShadowCallRows(jsonl);
    expect(total).toBe(5);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.disposition)).toEqual([
      'counted',
      'synthetic',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(rows.map((r) => r.skipReason)).toEqual([
      null,
      null,
      'bad-mode',
      'no-axis',
      'malformed',
    ]);
    // Line numbers are 1-based and stable.
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 4, 5]);
    // The counted row carries its source stamp and normalized ISO ts.
    expect(rows[0].source).toBe('model-eval');
    expect(rows[0].ts).toBe('2024-03-01T10:00:00.000Z');
    // A replay-skip row keeps its raw mode visible so the log can show it.
    expect(rows[2].mode).toBe('replay-skip');
  });

  it('row dispositions reconcile with the parseShadowCalls aggregate buckets', () => {
    const jsonl = [
      counted('model', 'live'),
      counted('model', 'replay'),
      JSON.stringify({ mode: 'live', axis: 'model', synthetic: true }),
      JSON.stringify({ mode: 'bogus', axis: 'x' }),
      '{ nope',
    ].join('\n');
    const agg = parseShadowCalls(jsonl);
    const { rows, total } = parseShadowCallRows(jsonl);
    const by = (d: string) => rows.filter((r) => r.disposition === d).length;
    expect(total).toBe(agg.total);
    expect(by('counted')).toBe(agg.counted);
    expect(by('synthetic')).toBe(agg.synthetic);
    expect(by('skipped')).toBe(agg.skipped);
  });

  it('computes signed token/$ deltas only when both arms are known', () => {
    const jsonl = [
      counted('model', 'live', {
        main: { tokens: 1000, costUsd: 0.4 },
        shadow: { tokens: 1200, costUsd: 0.1 },
      }),
      counted('model', 'live', { main: { tokens: 1000 } }),
    ].join('\n');
    const { rows } = parseShadowCallRows(jsonl);
    expect(rows[0].tokenDelta).toBe(200);
    expect(rows[0].costDelta).toBeCloseTo(-0.3);
    expect(rows[1].tokenDelta).toBeNull();
    expect(rows[1].costDelta).toBeNull();
  });

  it('accepts epoch-ms ts and rejects garbage ts without failing the row', () => {
    const jsonl = [
      counted('model', 'live', { ts: 1709287200000 }), // 2024-03-01T10:00:00Z
      counted('model', 'live', { ts: 'not a date' }),
      counted('model', 'live', { ts: '2024-03-01T10:00:00' }), // no zone: host-dependent
      counted('model', 'live', { ts: '2024-02-30T10:00:00Z' }), // impossible date
      counted('model', 'live'),
    ].join('\n');
    const { rows } = parseShadowCallRows(jsonl);
    expect(rows[0].ts).toBe('2024-03-01T10:00:00.000Z');
    expect(rows[1].ts).toBeNull();
    expect(rows[2].ts).toBeNull();
    expect(rows[3].ts).toBeNull();
    expect(rows[4].ts).toBeNull();
    expect(rows.every((r) => r.disposition === 'counted')).toBe(true);
  });

  it('captures task, variation, and the judge basis when carried', () => {
    const { rows } = parseShadowCallRows(
      counted('model', 'live', {
        task: '  fix the flaky test  ',
        variation: 'haiku instead of opus',
        revalidationStatus: 'current',
        judge: { winner: 'shadow', rationale: 'same diff, quarter the cost' },
      })
    );
    expect(rows[0].task).toBe('fix the flaky test');
    expect(rows[0].variation).toBe('haiku instead of opus');
    expect(rows[0].proofStatus).toBe('current');
    expect(rows[0].judgeBasis).toBe('same diff, quarter the cost');
  });

  it('refuses over-bound treatment identity and unsupported proof metadata', () => {
    const { rows } = parseShadowCallRows(
      counted('prompt', 'replay', {
        variation: 'x'.repeat(201),
        revalidationStatus: 'observational',
        source: 'proof',
        judge: { winner: 'shadow', basis: 'judge' },
      })
    );
    expect(rows[0].variation).toBeNull();
    expect(rows[0].proofStatus).toBeNull();
  });

  it('trends: buckets counted rows into UTC days from a dated fixture ledger (#2154)', () => {
    const jsonl = [
      counted('model', 'live', { ts: '2024-03-01T08:00:00Z', judge: { winner: 'shadow' }, main: { tokens: 100, costUsd: 0.4 }, shadow: { tokens: 80, costUsd: 0.1 } }),
      counted('model', 'live', { ts: '2024-03-01T22:00:00Z', judge: { winner: 'main' } }),
      // 2024-03-02 is an EMPTY day — must appear as a zero bucket, not vanish.
      counted('skills', 'replay', { ts: '2024-03-03T10:00:00Z', judge: { winner: 'tie' } }),
      // untimed counted row — surfaced, not silently missing from the trend
      counted('model', 'live'),
      // synthetic/skipped rows never trend
      JSON.stringify({ mode: 'live', axis: 'model', ts: '2024-03-03T10:00:00Z', synthetic: true }),
    ].join('\n');
    const { rows } = parseShadowCallRows(jsonl);
    const { buckets, untimed, beforeWindow } = bucketExperimentTrends(rows);

    expect(untimed).toBe(1);
    expect(beforeWindow).toBe(0);
    expect(buckets.map((b) => b.day)).toEqual(['2024-03-01', '2024-03-02', '2024-03-03']);
    expect(buckets[0].total).toBe(2);
    expect(buckets[0].shadowWins).toBe(1);
    expect(buckets[0].mainWins).toBe(1);
    expect(buckets[0].costDeltaSum).toBeCloseTo(-0.3);
    expect(buckets[0].costDeltaCount).toBe(1);
    expect(buckets[1]).toMatchObject({ total: 0, shadowWins: 0, mainWins: 0 });
    expect(buckets[2].ties).toBe(1);
  });

  it('trends: bounds the window to the newest maxDays so a stray ancient ts cannot explode the fill', () => {
    const jsonl = [
      counted('model', 'live', { ts: '1970-01-05T00:00:00Z', judge: { winner: 'shadow' } }),
      counted('model', 'live', { ts: '2024-03-09T00:00:00Z', judge: { winner: 'shadow' } }),
      counted('model', 'live', { ts: '2024-03-10T00:00:00Z', judge: { winner: 'main' } }),
    ].join('\n');
    const { rows } = parseShadowCallRows(jsonl);
    const { buckets, beforeWindow } = bucketExperimentTrends(rows, { maxDays: 5 });
    expect(beforeWindow).toBe(1); // the 1970 row fell off — counted, not hidden
    expect(buckets).toHaveLength(2); // 03-09 .. 03-10, no 54-year zero fill
    expect(buckets[0].day).toBe('2024-03-09');
    expect(buckets[1].day).toBe('2024-03-10');
  });

  it('trends: empty input and all-untimed input yield no buckets', () => {
    expect(bucketExperimentTrends([])).toEqual({ buckets: [], untimed: 0, beforeWindow: 0 });
    const { rows } = parseShadowCallRows(counted('model', 'live'));
    expect(bucketExperimentTrends(rows)).toEqual({ buckets: [], untimed: 1, beforeWindow: 0 });
  });

  it('bounds volume to the NEWEST maxRows and reports the cut — never silent', () => {
    const jsonl = Array.from({ length: 10 }, (_, i) =>
      counted('model', 'live', { task: `task-${i}` })
    ).join('\n');
    const { rows, total, dropped } = parseShadowCallRows(jsonl, { maxRows: 4 });
    expect(total).toBe(10);
    expect(dropped).toBe(6);
    expect(rows).toHaveLength(4);
    // The suffix (newest lines) is kept.
    expect(rows.map((r) => r.task)).toEqual(['task-6', 'task-7', 'task-8', 'task-9']);
    expect(rows[0].line).toBe(7);
  });
});
